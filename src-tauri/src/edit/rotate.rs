//! Rotate by quarter turns and/or mirror.
//!
//! Every combination of the editor's four buttons (rotate left / right, flip
//! horizontal / vertical) collapses to "rotate clockwise N quarter turns, then
//! maybe mirror left↔right". Those 8 results are exactly the 8 EXIF
//! orientations, which is what makes lossless JPEG rotation possible
//! (`lossless.rs`): we can describe any rotate/flip as an orientation flag.
//!
//! The frontend has the same maths in `src/edit/orientation.ts`.

use image::{DynamicImage, metadata::Orientation};
use serde::Deserialize;

use super::Operation;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rotate {
    /// Clockwise quarter turns, 0–3.
    pub quarter_turns: u8,
    /// Mirror left↔right, after rotating.
    #[serde(default)]
    pub flip: bool,
}

impl Rotate {
    pub const NONE: Rotate = Rotate { quarter_turns: 0, flip: false };

    pub fn is_none(self) -> bool {
        self == Self::NONE
    }

    pub fn validate(self) -> AppResult<()> {
        if self.quarter_turns > 3 {
            return Err(AppError::InvalidEdit(format!("Can't rotate by {} quarter turns", self.quarter_turns)));
        }
        Ok(())
    }

    /// `self` applied to an image that `before` was already applied to.
    ///
    /// Mirroring reverses the direction of later rotations (turning a mirrored
    /// photo clockwise turns the original anticlockwise), hence the `if`.
    pub fn after(self, before: Rotate) -> Rotate {
        let turns = if before.flip {
            before.quarter_turns + 4 - self.quarter_turns
        } else {
            before.quarter_turns + self.quarter_turns
        };
        Rotate { quarter_turns: turns % 4, flip: self.flip != before.flip }
    }

    /// The EXIF orientation that displays a photo the way this rotation would.
    pub fn to_orientation(self) -> Orientation {
        match (self.quarter_turns % 4, self.flip) {
            (0, false) => Orientation::NoTransforms,
            (1, false) => Orientation::Rotate90,
            (2, false) => Orientation::Rotate180,
            (3, false) => Orientation::Rotate270,
            (0, true) => Orientation::FlipHorizontal,
            (1, true) => Orientation::Rotate90FlipH,
            (2, true) => Orientation::FlipVertical, // 180° + mirror = upside down
            _ => Orientation::Rotate270FlipH,
        }
    }

    pub fn from_orientation(o: Orientation) -> Rotate {
        let (quarter_turns, flip) = match o {
            Orientation::NoTransforms => (0, false),
            Orientation::Rotate90 => (1, false),
            Orientation::Rotate180 => (2, false),
            Orientation::Rotate270 => (3, false),
            Orientation::FlipHorizontal => (0, true),
            Orientation::Rotate90FlipH => (1, true),
            Orientation::FlipVertical => (2, true),
            Orientation::Rotate270FlipH => (3, true),
        };
        Rotate { quarter_turns, flip }
    }
}

impl Operation for Rotate {
    fn apply(&self, image: DynamicImage) -> AppResult<DynamicImage> {
        self.validate()?;
        let image = match self.quarter_turns {
            1 => image.rotate90(),
            2 => image.rotate180(),
            3 => image.rotate270(),
            _ => image,
        };
        Ok(if self.flip { image.fliph() } else { image })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage};

    const ALL: [Orientation; 8] = [
        Orientation::NoTransforms,
        Orientation::Rotate90,
        Orientation::Rotate180,
        Orientation::Rotate270,
        Orientation::FlipHorizontal,
        Orientation::FlipVertical,
        Orientation::Rotate90FlipH,
        Orientation::Rotate270FlipH,
    ];

    /// 3×2 with every pixel different, so any wrong rotation or flip shows.
    fn sample() -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(3, 2, |x, y| Rgb([x as u8 * 50, y as u8 * 50, 7])))
    }

    fn same(a: &DynamicImage, b: &DynamicImage) -> bool {
        a.dimensions() == b.dimensions() && a.to_rgb8().as_raw() == b.to_rgb8().as_raw()
    }

    #[test]
    fn matches_the_image_crates_exif_orientations() {
        for o in ALL {
            let mut want = sample();
            want.apply_orientation(o);
            let r = Rotate::from_orientation(o);
            assert!(same(&r.apply(sample()).unwrap(), &want), "{o:?}");
            assert_eq!(r.to_orientation(), o);
        }
    }

    #[test]
    fn composition_matches_applying_twice() {
        for a in ALL.map(Rotate::from_orientation) {
            for b in ALL.map(Rotate::from_orientation) {
                let twice = b.apply(a.apply(sample()).unwrap()).unwrap();
                assert!(same(&twice, &b.after(a).apply(sample()).unwrap()), "{b:?} after {a:?}");
            }
        }
    }

    #[test]
    fn right_turn_is_clockwise() {
        // Top-left pixel (0,0) ends up top-right after a clockwise turn.
        let out = Rotate { quarter_turns: 1, flip: false }.apply(sample()).unwrap();
        assert_eq!(out.dimensions(), (2, 3));
        assert_eq!(out.get_pixel(1, 0).0[..2], [0, 0]);
    }

    #[test]
    fn rejects_too_many_turns() {
        assert!(Rotate { quarter_turns: 4, flip: false }.apply(sample()).is_err());
    }
}
