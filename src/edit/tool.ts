// The contract every edit tool implements. EditMode knows nothing about
// cropping specifically; it renders whichever tools are in the registry
// (tools/index.ts) and collects their operations when saving.
//
// Adding a tool (e.g. "straighten"):
//   1. src/edit/tools/<tool>/ with a `defineTool({...})` export
//   2. add it to `tools` in tools/index.ts
//   3. add its op to `EditOp` in types.ts and to the Rust `EditOp` enum
import type { ComponentType, ReactNode } from "react";
import type { ColorMatrix } from "./colorMatrix";
import type { Box, Rotation } from "./orientation";
import type { EditOp, Size } from "./types";

export type ToolProps<S> = {
  state: S;
  setState: (next: S | ((prev: S) => S)) => void;
  /** The image's displayed size in pixels: after EXIF rotation and the rotate tool. */
  image: Size;
  /** Screen pixels per image pixel at the current fit. */
  scale: number;
};

export interface EditTool<S> {
  id: string;
  label: string;
  /** Single-letter shortcut that switches to this tool inside the editor. */
  shortcut: string;
  icon: ReactNode;
  /** Initial (no-change) state for an image. */
  init(image: Size): S;
  /** True when the state wouldn't change the image, so there's nothing to save. */
  isNoop(state: S, image: Size): boolean;
  /** Operations to send to Rust, in order. */
  toOps(state: S, image: Size): EditOp[];
  /** Short status text for the footer, e.g. "1920 × 1080 px". */
  describe?(state: S, image: Size): string;
  /** Controls shown in the editor toolbar while this tool is active. */
  Controls?: ComponentType<ToolProps<S>>;
  /** Drawn on top of the image while this tool is active. */
  Overlay?: ComponentType<ToolProps<S>>;
  /** A side panel beside the image while this tool is active (e.g. sliders). */
  Panel?: ComponentType<ToolProps<S>>;
  /**
   * Live preview for colour changes, as a matrix (see colorMatrix.ts). It's
   * applied to the image whichever tool is active, so cropping shows the
   * adjusted colours. Must match what the Rust operation does.
   */
  colorMatrix?(state: S): ColorMatrix;
  /**
   * Geometry preview (the rotate tool). EditMode draws the image turned this way,
   * and every tool gets the rotated size as `image`. Rust applies it first too.
   */
  rotation?(state: S): Rotation;
  /**
   * The rotation changed: move state that's in image pixels (the crop box) along.
   * `move` takes a box in the old space to where the same pixels are now.
   */
  reorient?(state: S, move: (b: Box) => Box, swapped: boolean): S;
  /** Size of the result when this change is applied to an image of `image` size (for Export). */
  resultSize?(state: S, image: Size): Size;
  /** Keyboard handling while active. Return true if the key was used. */
  onKeyDown?(e: KeyboardEvent, props: ToolProps<S>): boolean;
}

/** Identity helper that keeps the state type `S` checked inside one tool. */
export function defineTool<S>(tool: EditTool<S>): EditTool<S> {
  return tool;
}

// The registry holds tools with different state types.
export type AnyTool = EditTool<any>;
