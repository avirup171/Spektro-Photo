//! In-place edits of a raw EXIF block (a little TIFF file: header, then
//! "IFDs", which are lists of 12-byte tag entries).
//!
//! kamadak-exif can read EXIF but not write it, and rebuilding the whole block
//! would risk dropping fields we don't understand. These helpers change only
//! the bytes they must and never change the block's length, so every offset
//! inside it stays valid. Each one checks everything before writing anything:
//! on a block it doesn't understand it leaves the bytes untouched.

const ORIENTATION: u16 = 0x0112;
const GPS_IFD: u16 = 0x8825;
const SHORT: u16 = 3;

#[derive(Clone, Copy)]
struct Endian {
    little: bool,
}

impl Endian {
    fn of(tiff: &[u8]) -> Option<Endian> {
        match tiff.get(0..4)? {
            [0x49, 0x49, 42, 0] => Some(Endian { little: true }),  // "II*\0"
            [0x4d, 0x4d, 0, 42] => Some(Endian { little: false }), // "MM\0*"
            _ => None,
        }
    }
    fn u16(self, b: &[u8], at: usize) -> Option<u16> {
        let s: [u8; 2] = b.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if self.little { u16::from_le_bytes(s) } else { u16::from_be_bytes(s) })
    }
    fn u32(self, b: &[u8], at: usize) -> Option<u32> {
        let s: [u8; 4] = b.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if self.little { u32::from_le_bytes(s) } else { u32::from_be_bytes(s) })
    }
    fn u16_bytes(self, v: u16) -> [u8; 2] {
        if self.little { v.to_le_bytes() } else { v.to_be_bytes() }
    }
}

/// An IFD's entries: where they start and how many there are.
struct Ifd {
    start: usize,
    count: usize,
}

impl Ifd {
    fn at(tiff: &[u8], e: Endian, offset: usize) -> Option<Ifd> {
        let count = usize::from(e.u16(tiff, offset)?);
        let start = offset + 2;
        // The entries plus the 4-byte "next IFD" offset must fit.
        tiff.get(start..start.checked_add(count * 12 + 4)?)?;
        Some(Ifd { start, count })
    }
    fn first(tiff: &[u8], e: Endian) -> Option<Ifd> {
        Ifd::at(tiff, e, e.u32(tiff, 4)? as usize)
    }
    fn entry(&self, i: usize) -> usize {
        self.start + i * 12
    }
    /// Byte offset of the entry with `tag`, if present.
    fn find(&self, tiff: &[u8], e: Endian, tag: u16) -> Option<usize> {
        (0..self.count).map(|i| self.entry(i)).find(|&at| e.u16(tiff, at) == Some(tag))
    }
}

/// Where the Orientation value is stored, if it's the usual single SHORT.
fn orientation_slot(tiff: &[u8]) -> Option<(Endian, usize)> {
    let e = Endian::of(tiff)?;
    let at = Ifd::first(tiff, e)?.find(tiff, e, ORIENTATION)?;
    let ok = e.u16(tiff, at + 2)? == SHORT && e.u32(tiff, at + 4)? == 1;
    ok.then_some((e, at + 8)) // values of 4 bytes or less sit inside the entry
}

/// The EXIF orientation (1–8 when valid), or None if there's no such tag.
pub fn orientation(tiff: &[u8]) -> Option<u16> {
    let (e, at) = orientation_slot(tiff)?;
    e.u16(tiff, at)
}

/// Changes the existing Orientation tag. Returns false (and changes nothing)
/// when the block has none; adding a tag would mean moving data around.
pub fn set_orientation(tiff: &mut [u8], value: u16) -> bool {
    let Some((e, at)) = orientation_slot(tiff) else { return false };
    tiff[at..at + 2].copy_from_slice(&e.u16_bytes(value));
    true
}

/// A minimal big-endian EXIF block holding only an Orientation tag.
pub fn with_orientation(value: u16) -> Vec<u8> {
    let mut b = b"MM\0\x2a\0\0\0\x08".to_vec(); // header; IFD0 starts at byte 8
    b.extend_from_slice(&1u16.to_be_bytes()); // one entry
    b.extend_from_slice(&ORIENTATION.to_be_bytes());
    b.extend_from_slice(&SHORT.to_be_bytes());
    b.extend_from_slice(&1u32.to_be_bytes()); // count
    b.extend_from_slice(&value.to_be_bytes());
    b.extend_from_slice(&[0, 0]); // padding to 4 bytes
    b.extend_from_slice(&[0, 0, 0, 0]); // no next IFD
    b
}

#[derive(Debug, PartialEq, Eq)]
pub enum GpsStrip {
    /// Location removed.
    Removed,
    /// There was no location to remove.
    NonePresent,
    /// The block didn't parse; the caller should drop all EXIF to be safe.
    Unreadable,
}

/// Removes the photo's location (the GPS IFD).
///
/// The GPS entry is taken out of IFD0 (later entries shift up and the freed
/// 12 bytes at the end are zeroed), and the GPS data itself is overwritten
/// with zeros, so the coordinates aren't left behind as unreferenced bytes.
pub fn strip_gps(tiff: &mut [u8]) -> GpsStrip {
    let Some(e) = Endian::of(tiff) else { return GpsStrip::Unreadable };
    let Some(ifd0) = Ifd::first(tiff, e) else { return GpsStrip::Unreadable };
    let Some(pointer) = ifd0.find(tiff, e, GPS_IFD) else { return GpsStrip::NonePresent };

    // Work out every byte range to zero before touching anything.
    let Some(mut wipe) = gps_ranges(tiff, e, &ifd0, pointer) else { return GpsStrip::Unreadable };

    // Remove the pointer entry from IFD0: shift the later entries and the
    // "next IFD" offset up by 12 bytes, then zero the 12 bytes freed at the end.
    let end = ifd0.entry(ifd0.count) + 4;
    tiff.copy_within(pointer + 12..end, pointer);
    wipe.push((end - 12, end));
    let count = e.u16_bytes((ifd0.count - 1) as u16);
    tiff[ifd0.start - 2..ifd0.start].copy_from_slice(&count);

    for (from, to) in wipe {
        tiff[from..to].fill(0);
    }
    GpsStrip::Removed
}

/// The GPS IFD itself plus any values stored outside it (coordinates are
/// RATIONALs: 8 bytes each, so always outside).
fn gps_ranges(tiff: &[u8], e: Endian, ifd0: &Ifd, pointer: usize) -> Option<Vec<(usize, usize)>> {
    debug_assert!(pointer >= ifd0.start);
    let gps = Ifd::at(tiff, e, e.u32(tiff, pointer + 8)? as usize)?;
    let mut ranges = vec![(gps.start - 2, gps.entry(gps.count) + 4)];
    for i in 0..gps.count {
        let at = gps.entry(i);
        let size = type_size(e.u16(tiff, at + 2)?)?.checked_mul(e.u32(tiff, at + 4)? as usize)?;
        if size > 4 {
            let from = e.u32(tiff, at + 8)? as usize;
            let to = from.checked_add(size)?;
            tiff.get(from..to)?;
            ranges.push((from, to));
        }
    }
    Some(ranges)
}

fn type_size(t: u16) -> Option<usize> {
    match t {
        1 | 2 | 6 | 7 => Some(1), // BYTE, ASCII, SBYTE, UNDEFINED
        3 | 8 => Some(2),         // SHORT, SSHORT
        4 | 9 | 11 => Some(4),    // LONG, SLONG, FLOAT
        5 | 10 | 12 => Some(8),   // RATIONAL, SRATIONAL, DOUBLE
        _ => None,
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Little-endian block: Model, Orientation 6, and a GPS IFD with a
    /// latitude (3 RATIONALs, stored outside the IFD).
    pub fn exif_with_gps(model: &str) -> Vec<u8> {
        let mut model = model.as_bytes().to_vec();
        model.push(0);
        // Layout: header 8 | IFD0 (3 entries) 2+36+4=42 → 50 | model | GPS IFD 2+24+4=30 | latitude 24
        let model_at = 50u32;
        let gps_at = model_at + model.len() as u32;
        let lat_at = gps_at + 30;

        let entry = |tag: u16, typ: u16, count: u32, value: [u8; 4]| {
            let mut v = Vec::new();
            v.extend_from_slice(&tag.to_le_bytes());
            v.extend_from_slice(&typ.to_le_bytes());
            v.extend_from_slice(&count.to_le_bytes());
            v.extend_from_slice(&value);
            v
        };
        let mut b = b"II\x2a\0\x08\0\0\0".to_vec();
        b.extend_from_slice(&3u16.to_le_bytes());
        b.extend(entry(0x0110, 2, model.len() as u32, model_at.to_le_bytes())); // Model
        b.extend(entry(ORIENTATION, SHORT, 1, [6, 0, 0, 0]));
        b.extend(entry(GPS_IFD, 4, 1, gps_at.to_le_bytes()));
        b.extend_from_slice(&[0, 0, 0, 0]);
        b.extend_from_slice(&model);
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend(entry(0x0001, 2, 2, *b"N\0\0\0")); // GPSLatitudeRef "N"
        b.extend(entry(0x0002, 5, 3, lat_at.to_le_bytes())); // GPSLatitude
        b.extend_from_slice(&[0, 0, 0, 0]);
        for (num, den) in [(26u32, 1u32), (42, 1), (1234, 100)] {
            b.extend_from_slice(&num.to_le_bytes());
            b.extend_from_slice(&den.to_le_bytes());
        }
        b
    }

    fn parse(tiff: &[u8]) -> exif::Exif {
        exif::Reader::new().read_raw(tiff.to_vec()).unwrap()
    }

    #[test]
    fn reads_and_patches_orientation() {
        let mut b = exif_with_gps("Cam");
        assert_eq!(orientation(&b), Some(6));
        let len = b.len();
        assert!(set_orientation(&mut b, 3));
        assert_eq!(orientation(&b), Some(3));
        assert_eq!(b.len(), len);
        let ex = parse(&b);
        assert_eq!(ex.get_field(exif::Tag::Orientation, exif::In::PRIMARY).unwrap().value.get_uint(0), Some(3));
    }

    #[test]
    fn minimal_block_parses() {
        let b = with_orientation(8);
        assert_eq!(orientation(&b), Some(8));
        let ex = parse(&b);
        assert_eq!(ex.get_field(exif::Tag::Orientation, exif::In::PRIMARY).unwrap().value.get_uint(0), Some(8));
    }

    #[test]
    fn strips_gps_and_wipes_the_coordinates() {
        let mut b = exif_with_gps("TestCam");
        let len = b.len();
        assert!(parse(&b).get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY).is_some());

        assert_eq!(strip_gps(&mut b), GpsStrip::Removed);
        assert_eq!(b.len(), len);
        let ex = parse(&b);
        assert!(ex.fields().all(|f| f.ifd_num == exif::In::PRIMARY && f.tag != exif::Tag::GPSInfoIFDPointer));
        assert!(ex.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY).is_none());
        // Camera and orientation are kept.
        let model = ex.get_field(exif::Tag::Model, exif::In::PRIMARY).unwrap();
        assert_eq!(model.display_value().to_string(), "\"TestCam\"");
        assert_eq!(orientation(&b), Some(6));
        // The coordinate bytes (26/1, 42/1, 1234/100) are gone, not just unlinked.
        let lat = 1234u32.to_le_bytes();
        assert!(!b.windows(4).any(|w| w == lat), "latitude still in the block");

        // Nothing left to remove the second time.
        assert_eq!(strip_gps(&mut b), GpsStrip::NonePresent);
    }

    #[test]
    fn leaves_unreadable_blocks_alone() {
        let mut junk = b"not a tiff at all".to_vec();
        let before = junk.clone();
        assert_eq!(strip_gps(&mut junk), GpsStrip::Unreadable);
        assert!(!set_orientation(&mut junk, 1));
        assert_eq!(junk, before);

        // A GPS pointer to nowhere: unreadable, and IFD0 untouched.
        let mut b = exif_with_gps("Cam");
        let gps_ptr_value = 8 + 2 + 2 * 12 + 8; // third entry's value field
        b[gps_ptr_value..gps_ptr_value + 4].copy_from_slice(&9999u32.to_le_bytes());
        let before = b.clone();
        assert_eq!(strip_gps(&mut b), GpsStrip::Unreadable);
        assert_eq!(b, before);
    }
}
