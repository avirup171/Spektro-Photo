// Rotate / flip maths for the editor. Mirrors src-tauri/src/edit/rotate.rs.
//
// Any mix of rotate-left / rotate-right / flip-horizontal / flip-vertical comes
// down to "turn clockwise N quarter turns, then maybe mirror left↔right".
// The editor keeps that as the rotate tool's state, draws the <img> with a CSS
// transform, and gives every other tool the *rotated* size, so the crop box
// lives in the same space Rust crops in (it rotates first, then crops).
import type { Size } from "./types";

export type Rotation = { quarterTurns: number; flip: boolean };

export const UPRIGHT: Rotation = { quarterTurns: 0, flip: false };
export const TURN_RIGHT: Rotation = { quarterTurns: 1, flip: false };
export const TURN_LEFT: Rotation = { quarterTurns: 3, flip: false };
export const FLIP_HORIZONTAL: Rotation = { quarterTurns: 0, flip: true };
/** Upside-down mirror: 180° plus a left↔right flip. */
export const FLIP_VERTICAL: Rotation = { quarterTurns: 2, flip: true };

export const isUpright = (r: Rotation) => r.quarterTurns % 4 === 0 && !r.flip;
export const sameRotation = (a: Rotation, b: Rotation) => a.quarterTurns % 4 === b.quarterTurns % 4 && a.flip === b.flip;

/**
 * `next` applied to an image that `before` was already applied to.
 * Mirroring reverses later turns, hence the branch. Same as `Rotate::after`.
 */
export function after(next: Rotation, before: Rotation): Rotation {
  const turns = before.flip ? before.quarterTurns + 4 - next.quarterTurns : before.quarterTurns + next.quarterTurns;
  return { quarterTurns: ((turns % 4) + 4) % 4, flip: next.flip !== before.flip };
}

/** Undoes `r`. A mirrored result is its own inverse. */
export const inverse = (r: Rotation): Rotation =>
  r.flip ? r : { quarterTurns: (4 - (r.quarterTurns % 4)) % 4, flip: false };

/** Odd numbers of quarter turns swap width and height. */
export const swapsSides = (r: Rotation) => r.quarterTurns % 2 === 1;

export const rotatedSize = (s: Size, r: Rotation): Size =>
  swapsSides(r) ? { width: s.height, height: s.width } : s;

export type Box = { x: number; y: number; w: number; h: number };

/** Where box `b` (in an image of `size`) ends up after rotating the image by `r`. */
export function rotateBox(b: Box, r: Rotation, size: Size): Box {
  let { x, y, w, h } = b;
  let [W, H] = [size.width, size.height];
  for (let i = 0; i < r.quarterTurns % 4; i++) {
    // One clockwise turn: the left edge becomes the top, the bottom becomes the left.
    [x, y, w, h] = [H - y - h, x, h, w];
    [W, H] = [H, W];
  }
  if (r.flip) x = W - x - w;
  return { x, y, w, h };
}

/** CSS draws the rightmost function first: rotate, then mirror. Positive = clockwise. */
export const cssTransform = (r: Rotation) => `${r.flip ? "scaleX(-1) " : ""}rotate(${(r.quarterTurns % 4) * 90}deg)`;

export function describeRotation(r: Rotation): string {
  const t = r.quarterTurns % 4;
  if (!r.flip) return ["", "Rotated right", "Rotated 180°", "Rotated left"][t];
  return ["Flipped horizontally", "Rotated right and flipped", "Flipped vertically", "Rotated left and flipped"][t];
}
