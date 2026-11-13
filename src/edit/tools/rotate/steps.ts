import { FLIP_HORIZONTAL, FLIP_VERTICAL, TURN_LEFT, TURN_RIGHT, type Rotation } from "../../orientation";

/** The four buttons, as steps applied on top of the current rotation (see `after`). */
export const STEPS: Record<"left" | "right" | "flipH" | "flipV", Rotation> = {
  left: TURN_LEFT,
  right: TURN_RIGHT,
  flipH: FLIP_HORIZONTAL,
  flipV: FLIP_VERTICAL,
};
