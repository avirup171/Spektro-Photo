//! Non-destructive-until-saved image editing.
//!
//! The frontend sends a list of operations (`EditOp`) describing what the user
//! did, e.g. `[{ "type": "crop", "x": 10, "y": 20, "width": 640, "height": 480 }]`.
//! Rust loads the original, runs the operations in order, and saves the result
//! either as a new file next to it or in place of it (see `output.rs`).
//!
//! ## Adding a new edit (e.g. rotate, resize, brightness)
//! 1. Create `edit/<name>.rs` with a struct holding its parameters and
//!    `impl Operation for <Name>`.
//! 2. Add a variant to `EditOp` and an arm to `EditOp::operation`.
//! 3. Add the matching TypeScript type in `src/edit/types.ts` and a tool in
//!    `src/edit/tools/`.
//!
//! Nothing else (loading, metadata, saving, the command) needs to change.
//! Colour adjustments share `color.rs`; see `adjust.rs` for adding a slider.
//!
//! One special case: a JPEG that is only rotated / flipped isn't re-encoded at
//! all. Its EXIF orientation flag is changed instead (`lossless.rs`).

mod adjust;
mod color;
mod crop;
mod lossless;
pub(crate) mod output;
mod rotate;

use std::path::PathBuf;

use image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    error::{AppError, AppResult},
    heic, imaging,
    library::{self, ImageEntry},
    state::AppState,
};

pub use adjust::Adjust;
pub use crop::Crop;
pub use output::SaveMode;
pub use rotate::Rotate;

/// One step of an edit. Every operation takes an image and returns a new one.
pub trait Operation {
    fn apply(&self, image: DynamicImage) -> AppResult<DynamicImage>;
}

/// The operations the frontend can request. `tag = "type"` means the JSON
/// looks like `{ "type": "crop", ...fields }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EditOp {
    Rotate(Rotate),
    Crop(Crop),
    Adjust(Adjust),
}

impl EditOp {
    fn operation(&self) -> &dyn Operation {
        match self {
            EditOp::Rotate(op) => op,
            EditOp::Crop(op) => op,
            EditOp::Adjust(op) => op,
        }
    }
}

/// When every operation is a rotation, their combined effect (else None).
fn only_rotation(ops: &[EditOp]) -> Option<Rotate> {
    ops.iter().try_fold(Rotate::NONE, |acc, op| match op {
        EditOp::Rotate(r) if r.validate().is_ok() => Some(r.after(acc)),
        _ => None,
    })
}

/// Runs every operation in order.
pub fn apply_ops(image: DynamicImage, ops: &[EditOp]) -> AppResult<DynamicImage> {
    ops.iter().try_fold(image, |img, op| op.operation().apply(img))
}

pub(crate) const HEIC_REPLACE: &str =
    "HEIC photos are saved as a JPEG copy. Replacing the original isn't supported";

/// Formats we can decode *and* write back without losing anything important.
/// GIF is excluded: re-encoding would drop every frame after the first.
pub fn is_editable(format: ImageFormat) -> bool {
    matches!(format, ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Bmp)
}

#[derive(Debug, Serialize)]
pub struct EditResult {
    /// The file that now holds the edited image (new file, or the original path).
    entry: ImageEntry,
    replaced: bool,
}

/// Load → apply operations → save. Runs on a blocking thread.
pub fn run_edit(path: PathBuf, ops: &[EditOp], mode: SaveMode) -> AppResult<EditResult> {
    if ops.is_empty() {
        return Err(AppError::InvalidEdit("There are no changes to save".into()));
    }
    // We can read HEIC (macOS) but not write it, so its edits are always a
    // JPEG copy. Checked before the (slow) decode.
    if heic::is_heic(&path) && matches!(mode, SaveMode::Replace) {
        return Err(AppError::InvalidEdit(HEIC_REPLACE.into()));
    }
    // Rotating a JPEG: change its orientation flag, keep the compressed pixels.
    let rotated = match only_rotation(ops).filter(|r| !r.is_none() && !heic::is_heic(&path)) {
        Some(rotate) => lossless::reorient_jpeg(&std::fs::read(&path)?, rotate),
        None => None,
    };
    if let Some(bytes) = rotated {
        let dest = output::save_bytes(&bytes, &path, mode)?;
        return Ok(EditResult { entry: library::entry_for(&dest)?, replaced: matches!(mode, SaveMode::Replace) });
    }
    let loaded = imaging::open_oriented(&path)?;
    if !is_editable(loaded.format) {
        return Err(AppError::UnsupportedFormat(format!("{:?}", loaded.format).to_uppercase()));
    }

    let edited = apply_ops(loaded.image.clone(), ops)?;
    let dest = output::save(&edited, &loaded, &path, mode)?;

    Ok(EditResult {
        entry: library::entry_for(&dest)?,
        replaced: matches!(mode, SaveMode::Replace),
    })
}

#[tauri::command]
pub async fn apply_edits(
    state: State<'_, AppState>,
    path: String,
    ops: Vec<EditOp>,
    mode: SaveMode,
) -> AppResult<EditResult> {
    let path = PathBuf::from(path);
    if !state.is_allowed(&path) || !library::has_image_ext(&path) {
        return Err(AppError::Forbidden(path.to_string_lossy().into_owned()));
    }
    tauri::async_runtime::spawn_blocking(move || run_edit(path, &ops, mode))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imaging::test_support::*;

    #[test]
    fn ops_deserialize_from_frontend_json() {
        let ops: Vec<EditOp> = serde_json::from_str(
            r#"[{ "type": "crop", "x": 1, "y": 2, "width": 3, "height": 4 }]"#,
        )
        .unwrap();
        assert!(matches!(&ops[0], EditOp::Crop(c) if *c == Crop { x: 1, y: 2, width: 3, height: 4 }));

        // Missing sliders default to 0.
        let ops: Vec<EditOp> =
            serde_json::from_str(r#"[{ "type": "adjust", "brightness": 10, "saturation": -5 }]"#).unwrap();
        let want = Adjust { brightness: 10, saturation: -5, ..Default::default() };
        assert!(matches!(&ops[0], EditOp::Adjust(a) if *a == want));

        let ops: Vec<EditOp> =
            serde_json::from_str(r#"[{ "type": "rotate", "quarterTurns": 3, "flip": true }]"#).unwrap();
        assert!(matches!(&ops[0], EditOp::Rotate(r) if *r == Rotate { quarter_turns: 3, flip: true }));

        let mode: SaveMode = serde_json::from_str(r#""newFile""#).unwrap();
        assert!(matches!(mode, SaveMode::NewFile));
        let mode: SaveMode = serde_json::from_str(r#""replace""#).unwrap();
        assert!(matches!(mode, SaveMode::Replace));
    }

    #[test]
    fn pipeline_applies_in_order() {
        let img = DynamicImage::new_rgb8(100, 80);
        let ops = vec![
            EditOp::Crop(Crop { x: 10, y: 10, width: 60, height: 50 }),
            EditOp::Crop(Crop { x: 0, y: 0, width: 30, height: 20 }),
        ];
        let out = apply_ops(img, &ops).unwrap();
        assert_eq!((out.width(), out.height()), (30, 20));
    }

    #[test]
    fn save_as_new_file_keeps_original_and_metadata() {
        let dir = temp_dir("edit-new");
        let src = dir.join("IMG_1.jpg");
        write_jpeg(&src, 400, 300, "TestCam X1", 6); // displays as 300x400
        let before = std::fs::read(&src).unwrap();

        let ops = [EditOp::Crop(Crop { x: 50, y: 100, width: 200, height: 150 })];
        let result = run_edit(src.clone(), &ops, SaveMode::NewFile).unwrap();

        assert!(!result.replaced);
        let dest = dir.join("IMG_1 (edited).jpg");
        assert_eq!(result.entry.path, dest.to_string_lossy());
        assert_eq!(std::fs::read(&src).unwrap(), before, "original untouched");

        assert_eq!(image::image_dimensions(&dest).unwrap(), (200, 150));
        // Camera info survives; orientation is now "normal" because the pixels
        // were rotated before cropping.
        assert_eq!(read_exif(&dest), (Some(1), Some("TestCam X1".into())));

        // A second save doesn't overwrite the first copy.
        let again = run_edit(src.clone(), &ops, SaveMode::NewFile).unwrap();
        assert_eq!(again.entry.path, dir.join("IMG_1 (edited 2).jpg").to_string_lossy());
    }

    #[test]
    fn crop_then_adjust_saves_one_file_with_metadata() {
        let dir = temp_dir("edit-adjust");
        let src = dir.join("IMG_2.jpg");
        write_jpeg(&src, 400, 300, "TestCam X1", 6);

        let ops = [
            EditOp::Crop(Crop { x: 0, y: 0, width: 100, height: 120 }),
            EditOp::Adjust(Adjust { brightness: -100, saturation: -100, ..Default::default() }),
        ];
        let result = run_edit(src.clone(), &ops, SaveMode::NewFile).unwrap();
        let out = image::open(&result.entry.path).unwrap().to_rgb8();
        assert_eq!(out.dimensions(), (100, 120));
        // Black and white: every pixel's channels are (nearly; JPEG) equal.
        let p = out.get_pixel(50, 60).0;
        assert!(p.iter().all(|&c| c.abs_diff(p[1]) <= 3), "{p:?}");
        assert_eq!(read_exif(std::path::Path::new(&result.entry.path)), (Some(1), Some("TestCam X1".into())));
    }

    #[test]
    fn heic_replace_is_refused_before_decoding() {
        // Works on every platform: the check happens before the macOS-only decoder.
        let src = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-data/rotated.heic");
        let ops = [EditOp::Crop(Crop { x: 0, y: 0, width: 10, height: 10 })];
        assert!(matches!(run_edit(src, &ops, SaveMode::Replace), Err(AppError::InvalidEdit(m)) if m == HEIC_REPLACE));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn heic_edit_saves_a_jpeg_copy_with_metadata() {
        let dir = temp_dir("edit-heic");
        let src = dir.join("IMG_7.HEIC");
        std::fs::copy(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-data/rotated.heic"), &src).unwrap();
        let before = std::fs::read(&src).unwrap();

        // Displayed 40×60 (red on top): keep the top 40×30, i.e. the red half.
        let ops = [
            EditOp::Crop(Crop { x: 0, y: 0, width: 40, height: 30 }),
            EditOp::Adjust(Adjust { brightness: 10, ..Default::default() }),
        ];
        let result = run_edit(src.clone(), &ops, SaveMode::NewFile).unwrap();
        let dest = dir.join("IMG_7 (edited).jpg");
        assert_eq!(result.entry.path, dest.to_string_lossy());
        assert_eq!(std::fs::read(&src).unwrap(), before, "original untouched");

        let out = image::open(&dest).unwrap().to_rgb8();
        assert_eq!(out.dimensions(), (40, 30));
        let p = out.get_pixel(20, 15).0;
        assert!(p[0] > 150 && p[2] < 120, "red half kept: {p:?}");
        assert_eq!(read_exif(&dest), (Some(1), Some("TestCam HEIC".into())));
    }

    #[test]
    fn rotating_a_jpeg_is_lossless() {
        let dir = temp_dir("edit-rotate");
        let src = dir.join("IMG_3.jpg");
        write_jpeg(&src, 400, 300, "TestCam X1", 1);
        let before = std::fs::read(&src).unwrap();

        // Two ops (left, then flip) are combined into one orientation change.
        let ops = [
            EditOp::Rotate(Rotate { quarter_turns: 3, flip: false }),
            EditOp::Rotate(Rotate { quarter_turns: 0, flip: true }),
        ];
        let result = run_edit(src.clone(), &ops, SaveMode::NewFile).unwrap();
        let dest = std::path::PathBuf::from(&result.entry.path);
        assert_eq!(dest, dir.join("IMG_3 (edited).jpg"));
        let after = std::fs::read(&dest).unwrap();
        assert_eq!(after.len(), before.len(), "same file apart from the flag");
        assert!(before.iter().zip(&after).filter(|(a, b)| a != b).count() <= 2);
        // Rotate left, then mirror = EXIF 7 ("rotate 270° clockwise, then flip").
        assert_eq!(lossless::tests::orientation_of(&after), 7);
        assert_eq!(imaging::open_oriented(&dest).unwrap().image.width(), 300);
    }

    #[test]
    fn rotate_with_other_edits_re_encodes() {
        let dir = temp_dir("edit-rotate-crop");
        let src = dir.join("IMG_4.jpg");
        write_jpeg(&src, 400, 300, "TestCam X1", 6); // displays 300×400

        // Rotating right makes it 400×300 again; the crop is in that space.
        let ops = [
            EditOp::Rotate(Rotate { quarter_turns: 1, flip: false }),
            EditOp::Crop(Crop { x: 0, y: 0, width: 350, height: 300 }),
        ];
        let result = run_edit(src, &ops, SaveMode::NewFile).unwrap();
        let dest = std::path::Path::new(&result.entry.path);
        assert_eq!(image::image_dimensions(dest).unwrap(), (350, 300));
        assert_eq!(read_exif(dest), (Some(1), Some("TestCam X1".into())));
    }

    #[test]
    fn rotating_a_png_re_encodes() {
        let dir = temp_dir("edit-rotate-png");
        let src = dir.join("shot.png");
        image::DynamicImage::new_rgba8(64, 32).save(&src).unwrap();
        let ops = [EditOp::Rotate(Rotate { quarter_turns: 1, flip: false })];
        let r = run_edit(src, &ops, SaveMode::NewFile).unwrap();
        assert_eq!(image::image_dimensions(&r.entry.path).unwrap(), (32, 64));
    }

    #[test]
    fn rejects_bad_crops_and_gifs() {
        let dir = temp_dir("edit-bad");
        let src = dir.join("a.jpg");
        write_jpeg(&src, 100, 100, "Cam", 1);

        let outside = [EditOp::Crop(Crop { x: 90, y: 0, width: 20, height: 10 })];
        assert!(matches!(run_edit(src.clone(), &outside, SaveMode::NewFile), Err(AppError::InvalidEdit(_))));
        assert!(matches!(run_edit(src.clone(), &[], SaveMode::NewFile), Err(AppError::InvalidEdit(_))));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "nothing written on failure");

        let gif = dir.join("anim.gif");
        image::DynamicImage::new_rgb8(10, 10).save(&gif).unwrap();
        let ok_crop = [EditOp::Crop(Crop { x: 0, y: 0, width: 5, height: 5 })];
        assert!(matches!(run_edit(gif, &ok_crop, SaveMode::Replace), Err(AppError::UnsupportedFormat(_))));
    }
}
