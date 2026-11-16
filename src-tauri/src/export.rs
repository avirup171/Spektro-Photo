//! Export: a resized / converted copy for sharing, saved wherever the user
//! picks in the native Save panel.
//!
//! Unlike "Save as copy", export may change the format (always JPEG or PNG),
//! the size, and how much metadata travels with the file. The original is
//! never touched. The editor passes its current operations, so an export from
//! there includes the crop / rotation / colours on screen.
//!
//! The Save panel is opened from Rust, not the webview: the destination path
//! then comes from the OS, never from the frontend, which keeps the rule that
//! the webview can only ever name files inside folders the user opened.

use std::{
    fs,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

use image::{
    DynamicImage, GenericImageView, Rgb, RgbImage,
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    imageops::FilterType,
};
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    edit::{self, EditOp, output},
    error::{AppError, AppResult},
    imaging,
    library::{self, ImageEntry},
    state::AppState,
    tiff::{self, GpsStrip},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Jpeg,
    Png,
}

impl ExportFormat {
    fn extensions(self) -> &'static [&'static str] {
        match self {
            ExportFormat::Jpeg => &["jpg", "jpeg"],
            ExportFormat::Png => &["png"],
        }
    }
    fn label(self) -> &'static str {
        match self {
            ExportFormat::Jpeg => "JPEG image",
            ExportFormat::Png => "PNG image",
        }
    }
}

/// How much of the original's EXIF goes into the export. The colour profile
/// is always kept: it isn't personal, and dropping it shifts colours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Metadata {
    Keep,
    /// Everything except the GPS location.
    NoLocation,
    None,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub format: ExportFormat,
    /// JPEG quality (ignored for PNG).
    #[serde(default = "default_quality")]
    pub quality: u8,
    /// Longest side in pixels; `None` keeps the size. Never enlarges.
    #[serde(default)]
    pub max_edge: Option<u32>,
    pub metadata: Metadata,
}

fn default_quality() -> u8 {
    85
}

impl ExportOptions {
    fn validate(&self) -> AppResult<()> {
        if !(30..=100).contains(&self.quality) {
            return Err(AppError::InvalidEdit(format!("JPEG quality must be 30–100, not {}", self.quality)));
        }
        if let Some(edge) = self.max_edge.filter(|e| !(16..=30_000).contains(e)) {
            return Err(AppError::InvalidEdit(format!("The size must be 16–30000 px, not {edge}")));
        }
        Ok(())
    }
}

/// The image to write, before choosing where.
pub struct Rendered {
    pub image: DynamicImage,
    pub resized: bool,
    icc_profile: Option<Vec<u8>>,
    exif: Option<Vec<u8>>,
}

/// Load → edits → resize → metadata. Runs before the Save panel opens, so a
/// file that can't be read fails right away and the suggested name can say
/// the real size.
pub fn render(src: &Path, ops: &[EditOp], o: &ExportOptions) -> AppResult<Rendered> {
    o.validate()?;
    let loaded = imaging::open_oriented(src)?;
    let mut image = edit::apply_ops(loaded.image, ops)?;

    let mut resized = false;
    if let Some(max) = o.max_edge.filter(|&m| image.width().max(image.height()) > m) {
        // Lanczos3: the sharpest of the image crate's filters for shrinking.
        image = image.resize(max, max, FilterType::Lanczos3);
        resized = true;
    }
    // JPEG has no transparency; without this, transparent areas turn black.
    if o.format == ExportFormat::Jpeg && image.color().has_alpha() {
        image = flatten_on_white(&image);
    }

    let exif = match o.metadata {
        Metadata::Keep => loaded.exif,
        Metadata::None => None,
        // If the block can't be parsed we can't be sure the location is gone,
        // so all EXIF is dropped instead.
        Metadata::NoLocation => loaded.exif.and_then(|mut e| match tiff::strip_gps(&mut e) {
            GpsStrip::Removed | GpsStrip::NonePresent => Some(e),
            GpsStrip::Unreadable => None,
        }),
    };
    Ok(Rendered { image, resized, icc_profile: loaded.icc_profile, exif })
}

fn flatten_on_white(image: &DynamicImage) -> DynamicImage {
    let rgba = image.to_rgba8();
    DynamicImage::ImageRgb8(RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let over = |c: u8| ((u16::from(c) * u16::from(a) + 255 * (255 - u16::from(a)) + 127) / 255) as u8;
        Rgb([over(r), over(g), over(b)])
    }))
}

pub fn write(r: &Rendered, dest: &Path, o: &ExportOptions) -> AppResult<()> {
    output::write_atomically(dest, |tmp| {
        let mut out = BufWriter::new(fs::File::create(tmp)?);
        let (icc, exif) = (r.icc_profile.as_deref(), r.exif.as_deref());
        match o.format {
            ExportFormat::Jpeg => {
                output::encode_with(&r.image, icc, exif, JpegEncoder::new_with_quality(&mut out, o.quality))?
            }
            ExportFormat::Png => output::encode_with(&r.image, icc, exif, PngEncoder::new(&mut out))?,
        }
        out.flush()?;
        out.get_ref().sync_all()?;
        Ok(())
    })
}

/// "IMG_1.HEIC" → "IMG_1 (2048px).jpg" when resized, "IMG_1.jpg" when only the
/// format changes, "IMG_1 (export).jpg" otherwise.
pub fn suggested_name(src: &Path, r: &Rendered, format: ExportFormat) -> String {
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    let ext = format.extensions()[0];
    let same_format = src
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| format.extensions().contains(&e.to_ascii_lowercase().as_str()));
    let (w, h) = r.image.dimensions();
    if r.resized {
        format!("{stem} ({}px).{ext}", w.max(h))
    } else if same_format {
        format!("{stem} (export).{ext}")
    } else {
        format!("{stem}.{ext}")
    }
}

/// Makes sure the file ends in an extension that matches its content.
fn with_matching_extension(dest: PathBuf, format: ExportFormat) -> PathBuf {
    let ok = dest
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| format.extensions().contains(&e.to_ascii_lowercase().as_str()));
    if ok {
        return dest;
    }
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(format.extensions()[0]);
    dest.with_file_name(name)
}

#[derive(Debug, Serialize)]
pub struct Exported {
    path: String,
    name: String,
    width: u32,
    height: u32,
    bytes: u64,
    /// Set when the file landed in a folder that's open in the app, so the
    /// grid can show it without a rescan.
    entry: Option<ImageEntry>,
}

/// `Ok(None)` means the user cancelled the Save panel.
#[tauri::command]
pub async fn export_image(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
    ops: Vec<EditOp>,
    options: ExportOptions,
) -> AppResult<Option<Exported>> {
    let src = PathBuf::from(path);
    if !state.is_allowed(&src) || !library::has_image_ext(&src) {
        return Err(AppError::Forbidden(src.to_string_lossy().into_owned()));
    }

    let saved = tauri::async_runtime::spawn_blocking(move || -> AppResult<Option<(PathBuf, (u32, u32))>> {
        let rendered = render(&src, &ops, &options)?;
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Export")
            .set_file_name(suggested_name(&src, &rendered, options.format))
            .add_filter(options.format.label(), options.format.extensions());
        if let Some(dir) = src.parent() {
            dialog = dialog.set_directory(dir);
        }
        // Blocking is fine: we're on a worker thread, not the main thread.
        let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
        let dest = picked.into_path().map_err(|e| AppError::Other(e.to_string()))?;
        let dest = with_matching_extension(dest, options.format);
        if dest == src {
            return Err(AppError::InvalidEdit("Export can't overwrite the original. Choose another name".into()));
        }
        write(&rendered, &dest, &options)?;
        Ok(Some((dest, rendered.image.dimensions())))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    let Some((dest, (width, height))) = saved else { return Ok(None) };
    let entry = (state.is_allowed(&dest) && library::has_image_ext(&dest))
        .then(|| library::entry_for(&dest).ok())
        .flatten();
    Ok(Some(Exported {
        name: dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        bytes: fs::metadata(&dest).map(|m| m.len()).unwrap_or(0),
        path: dest.to_string_lossy().into_owned(),
        width,
        height,
        entry,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        edit::{Crop, Rotate},
        imaging::test_support::*,
    };

    fn opts(format: ExportFormat, max_edge: Option<u32>, metadata: Metadata) -> ExportOptions {
        ExportOptions { format, quality: 85, max_edge, metadata }
    }

    /// A JPEG whose EXIF has a camera model and a GPS location.
    fn photo_with_gps(dir: &Path) -> PathBuf {
        let p = dir.join("IMG_5.jpg");
        let mut enc_out = Vec::new();
        let mut enc = JpegEncoder::new_with_quality(&mut enc_out, 90);
        use image::ImageEncoder;
        enc.set_exif_metadata(tiff::tests::exif_with_gps("TestCam GPS")).unwrap();
        let img = RgbImage::from_fn(400, 300, |x, _| Rgb([(x % 256) as u8, 80, 160]));
        enc.write_image(img.as_raw(), 400, 300, image::ExtendedColorType::Rgb8).unwrap();
        fs::write(&p, enc_out).unwrap();
        p // stored 400×300 with orientation 6 → displays 300×400
    }

    fn gps_of(path: &Path) -> bool {
        let file = fs::File::open(path).unwrap();
        exif::Reader::new()
            .read_from_container(&mut std::io::BufReader::new(file))
            .map(|e| e.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY).is_some())
            .unwrap_or(false)
    }

    #[test]
    fn resizes_the_long_edge_and_never_enlarges() {
        let dir = temp_dir("export-size");
        let src = photo_with_gps(&dir);

        let o = opts(ExportFormat::Jpeg, Some(200), Metadata::Keep);
        let r = render(&src, &[], &o).unwrap();
        assert!(r.resized);
        assert_eq!(r.image.dimensions(), (150, 200), "upright, aspect kept");
        assert_eq!(suggested_name(&src, &r, o.format), "IMG_5 (200px).jpg");

        let o = opts(ExportFormat::Jpeg, Some(4000), Metadata::Keep);
        let r = render(&src, &[], &o).unwrap();
        assert!(!r.resized);
        assert_eq!(r.image.dimensions(), (300, 400));
        assert_eq!(suggested_name(&src, &r, o.format), "IMG_5 (export).jpg");
        assert_eq!(suggested_name(&src, &r, ExportFormat::Png), "IMG_5.png");
    }

    #[test]
    fn applies_editor_ops_before_resizing() {
        let dir = temp_dir("export-ops");
        let src = photo_with_gps(&dir);
        let ops = [
            EditOp::Rotate(Rotate { quarter_turns: 1, flip: false }), // 300×400 → 400×300
            EditOp::Crop(Crop { x: 0, y: 0, width: 400, height: 100 }),
        ];
        let r = render(&src, &ops, &opts(ExportFormat::Png, Some(200), Metadata::None)).unwrap();
        assert_eq!(r.image.dimensions(), (200, 50));
    }

    #[test]
    fn metadata_choices() {
        let dir = temp_dir("export-meta");
        let src = photo_with_gps(&dir);
        assert!(gps_of(&src));

        for (meta, gps, camera) in [
            (Metadata::Keep, true, true),
            (Metadata::NoLocation, false, true),
            (Metadata::None, false, false),
        ] {
            let o = opts(ExportFormat::Jpeg, Some(100), meta);
            let dest = dir.join(format!("out-{meta:?}.jpg"));
            write(&render(&src, &[], &o).unwrap(), &dest, &o).unwrap();
            assert_eq!(gps_of(&dest), gps, "{meta:?} GPS");
            let (orientation, model) = read_exif(&dest);
            assert_eq!(model.is_some(), camera, "{meta:?} camera");
            if camera {
                assert_eq!(orientation, Some(1), "pixels are upright, so the flag is reset");
            }
        }
    }

    #[test]
    fn png_alpha_becomes_white_in_jpeg_and_stays_in_png() {
        let dir = temp_dir("export-alpha");
        let src = dir.join("shot.png");
        DynamicImage::new_rgba8(20, 10).save(&src).unwrap(); // fully transparent

        let o = opts(ExportFormat::Jpeg, None, Metadata::Keep);
        let dest = dir.join("shot.jpg");
        write(&render(&src, &[], &o).unwrap(), &dest, &o).unwrap();
        let p = image::open(&dest).unwrap().to_rgb8().get_pixel(5, 5).0;
        assert!(p.iter().all(|&c| c > 245), "white, not black: {p:?}");

        let o = opts(ExportFormat::Png, None, Metadata::Keep);
        let dest = dir.join("shot (export).png");
        write(&render(&src, &[], &o).unwrap(), &dest, &o).unwrap();
        assert!(image::open(&dest).unwrap().color().has_alpha());
    }

    #[test]
    fn write_replaces_an_existing_file_cleanly() {
        let dir = temp_dir("export-overwrite");
        let src = photo_with_gps(&dir);
        let dest = dir.join("out.jpg");
        fs::write(&dest, b"old").unwrap();
        let o = opts(ExportFormat::Jpeg, Some(64), Metadata::None);
        write(&render(&src, &[], &o).unwrap(), &dest, &o).unwrap();
        assert_eq!(image::image_dimensions(&dest).unwrap(), (48, 64));
        let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "no temp file left behind: {names:?}");
    }

    #[test]
    fn extension_follows_the_format() {
        let f = |p: &str, fmt| with_matching_extension(PathBuf::from(p), fmt);
        assert_eq!(f("/x/a.jpg", ExportFormat::Jpeg), PathBuf::from("/x/a.jpg"));
        assert_eq!(f("/x/a.JPEG", ExportFormat::Jpeg), PathBuf::from("/x/a.JPEG"));
        assert_eq!(f("/x/a.png", ExportFormat::Jpeg), PathBuf::from("/x/a.png.jpg"));
        assert_eq!(f("/x/holiday", ExportFormat::Png), PathBuf::from("/x/holiday.png"));
    }

    #[test]
    fn options_are_checked() {
        let mut o = opts(ExportFormat::Jpeg, Some(8), Metadata::Keep);
        assert!(o.validate().is_err());
        o.max_edge = Some(2048);
        o.quality = 101;
        assert!(o.validate().is_err());
        let json: ExportOptions =
            serde_json::from_str(r#"{ "format": "jpeg", "maxEdge": 2048, "metadata": "noLocation" }"#).unwrap();
        assert_eq!((json.quality, json.max_edge, json.metadata), (85, Some(2048), Metadata::NoLocation));
    }
}
