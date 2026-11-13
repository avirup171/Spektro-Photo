//! Lossless rotation for JPEGs.
//!
//! When a JPEG is only rotated or flipped, we don't touch its pixels: we change
//! its EXIF orientation flag instead, which every current viewer, browser and
//! phone honours. The compressed image data stays byte-for-byte the same, so
//! nothing is lost and rotating back and forth is harmless.
//!
//! A JPEG is a list of segments (`FF xx` marker + length + data) up to the
//! start of the image data (`FF DA`). EXIF lives in an APP1 segment starting
//! with "Exif\0\0".

use image::metadata::Orientation;

use super::Rotate;
use crate::tiff;

const SOI: [u8; 2] = [0xFF, 0xD8];
const APP0: u8 = 0xE0;
const APP1: u8 = 0xE1;
const SOS: u8 = 0xDA;
const EOI: u8 = 0xD9;
const EXIF_ID: &[u8] = b"Exif\0\0";
const XMP_ID: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

struct Segment {
    marker: u8,
    /// The segment's data, after the 2-byte length.
    data: std::ops::Range<usize>,
}

/// The segments before the image data, or None if this isn't a JPEG we understand.
fn segments(jpeg: &[u8]) -> Option<Vec<Segment>> {
    if !jpeg.starts_with(&SOI) {
        return None;
    }
    let mut out = Vec::new();
    let mut pos = 2;
    loop {
        if *jpeg.get(pos)? != 0xFF {
            return None;
        }
        let mut m = pos + 1;
        while *jpeg.get(m)? == 0xFF {
            m += 1; // fill bytes
        }
        let marker = jpeg[m];
        if marker == SOS || marker == EOI {
            return Some(out);
        }
        // Markers without a length (RSTn, TEM) don't belong before the image data.
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            return None;
        }
        let len = usize::from(u16::from_be_bytes([*jpeg.get(m + 1)?, *jpeg.get(m + 2)?]));
        let end = (m + 1).checked_add(len)?;
        if len < 2 || end > jpeg.len() {
            return None;
        }
        out.push(Segment { marker, data: m + 3..end });
        pos = end;
    }
}

/// The JPEG with its orientation changed so that it *displays* with `rotate`
/// applied. None when a simple patch isn't safe; the caller then re-encodes.
pub fn reorient_jpeg(jpeg: &[u8], rotate: Rotate) -> Option<Vec<u8>> {
    rotate.validate().ok()?;
    let segs = segments(jpeg)?;

    // Lightroom & co. can repeat the orientation in XMP; patching only EXIF
    // would leave the two disagreeing.
    let xmp_orientation = segs.iter().any(|s| {
        let d = &jpeg[s.data.clone()];
        s.marker == APP1 && d.starts_with(XMP_ID) && d.windows(16).any(|w| w == b"tiff:Orientation")
    });
    if xmp_orientation {
        return None;
    }

    match segs.iter().find(|s| s.marker == APP1 && jpeg[s.data.clone()].starts_with(EXIF_ID)) {
        Some(exif) => {
            let tiff_range = exif.data.start + EXIF_ID.len()..exif.data.end;
            // No orientation tag means "upright"; adding one would mean
            // rewriting the block, so that (rare) case is re-encoded instead.
            let old = tiff::orientation(&jpeg[tiff_range.clone()])?;
            let old = Orientation::from_exif(old.try_into().unwrap_or(1)).unwrap_or(Orientation::NoTransforms);
            let new = rotate.after(Rotate::from_orientation(old)).to_orientation().to_exif();

            let mut out = jpeg.to_vec();
            tiff::set_orientation(&mut out[tiff_range], u16::from(new)).then_some(out)
        }
        None => {
            // No EXIF at all (screenshots, web images): add a minimal block.
            // It goes after a leading JFIF (APP0) segment, as cameras do.
            let at = match segs.first() {
                Some(s) if s.marker == APP0 => s.data.end,
                _ => 2,
            };
            let mut data = EXIF_ID.to_vec();
            data.extend(tiff::with_orientation(u16::from(rotate.to_orientation().to_exif())));
            let len = u16::try_from(data.len() + 2).ok()?;

            let mut out = Vec::with_capacity(jpeg.len() + data.len() + 4);
            out.extend_from_slice(&jpeg[..at]);
            out.extend_from_slice(&[0xFF, APP1]);
            out.extend_from_slice(&len.to_be_bytes());
            out.extend(data);
            out.extend_from_slice(&jpeg[at..]);
            Some(out)
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::imaging::{self, test_support::*};
    use image::GenericImageView;

    const CW: Rotate = Rotate { quarter_turns: 1, flip: false };
    const CCW: Rotate = Rotate { quarter_turns: 3, flip: false };

    fn jpeg_bytes(orientation: u16) -> Vec<u8> {
        let dir = temp_dir("lossless-src");
        let p = dir.join(format!("o{orientation}.jpg"));
        write_jpeg(&p, 40, 30, "Cam", orientation);
        std::fs::read(p).unwrap()
    }

    /// Read with the image crate (as the app does). kamadak-exif would reject
    /// the test fixture's deliberately dangling thumbnail pointer, which the
    /// lossless path rightly leaves alone.
    pub fn orientation_of(jpeg: &[u8]) -> u16 {
        use image::ImageDecoder;
        let mut dec = image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(jpeg)).unwrap();
        u16::from(dec.orientation().unwrap().to_exif())
    }

    #[test]
    fn patches_only_the_orientation_bytes() {
        let src = jpeg_bytes(1);
        let out = reorient_jpeg(&src, CW).unwrap();
        assert_eq!(out.len(), src.len());
        assert!(src.iter().zip(&out).filter(|(a, b)| a != b).count() <= 2);
        assert_eq!(orientation_of(&out), 6);
    }

    #[test]
    fn composes_with_the_existing_orientation() {
        assert_eq!(orientation_of(&reorient_jpeg(&jpeg_bytes(6), CW).unwrap()), 3); // 90 + 90 = 180
        assert_eq!(orientation_of(&reorient_jpeg(&jpeg_bytes(6), CCW).unwrap()), 1); // back upright
        let flip = Rotate { quarter_turns: 0, flip: true };
        assert_eq!(orientation_of(&reorient_jpeg(&jpeg_bytes(1), flip).unwrap()), 2);
    }

    #[test]
    fn adds_exif_to_a_jpeg_without_any() {
        let dir = temp_dir("lossless-plain");
        let p = dir.join("plain.jpg");
        image::DynamicImage::new_rgb8(40, 30).save(&p).unwrap();
        let src = std::fs::read(&p).unwrap();

        let out = reorient_jpeg(&src, CCW).unwrap();
        assert!(out.ends_with(&src[src.len() - 100..]), "image data unchanged");
        std::fs::write(&p, &out).unwrap();
        assert_eq!(read_exif(&p).0, Some(8), "kamadak-exif reads the new block too");
        let loaded = imaging::open_oriented(&p).unwrap();
        assert_eq!(loaded.image.dimensions(), (30, 40));
    }

    #[test]
    fn displayed_pixels_match_a_real_rotation() {
        let dir = temp_dir("lossless-pixels");
        let p = dir.join("a.jpg");
        std::fs::write(&p, jpeg_bytes(1)).unwrap();
        let before = imaging::open_oriented(&p).unwrap().image;

        let r = Rotate { quarter_turns: 1, flip: true };
        std::fs::write(&p, reorient_jpeg(&std::fs::read(&p).unwrap(), r).unwrap()).unwrap();
        let after = imaging::open_oriented(&p).unwrap().image;

        use super::super::Operation;
        let want = r.apply(before).unwrap();
        assert_eq!(after.dimensions(), want.dimensions());
        assert_eq!(after.to_rgb8().as_raw(), want.to_rgb8().as_raw(), "same decoded pixels");
    }

    #[test]
    fn refuses_what_it_cant_patch_safely() {
        assert!(reorient_jpeg(b"\x89PNG\r\n\x1a\n", CW).is_none());

        // XMP that also stores an orientation.
        let src = jpeg_bytes(1);
        let mut xmp = XMP_ID.to_vec();
        xmp.extend_from_slice(b"<x:xmpmeta><rdf:Description tiff:Orientation=\"1\"/></x:xmpmeta>");
        let mut with_xmp = src[..2].to_vec();
        with_xmp.extend_from_slice(&[0xFF, APP1]);
        with_xmp.extend_from_slice(&((xmp.len() + 2) as u16).to_be_bytes());
        with_xmp.extend(xmp);
        with_xmp.extend_from_slice(&src[2..]);
        assert!(reorient_jpeg(&with_xmp, CW).is_none());

        // Truncated file.
        assert!(reorient_jpeg(&src[..20], CW).is_none());
    }
}
