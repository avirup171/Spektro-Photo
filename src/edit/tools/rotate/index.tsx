import { RotateIcon } from "../../../components/Icons";
import { after, describeRotation, isUpright, rotatedSize, UPRIGHT, type Rotation } from "../../orientation";
import { defineTool } from "../../tool";
import { RotateControls } from "./RotateControls";
import { STEPS } from "./steps";

export const rotateTool = defineTool<Rotation>({
  id: "rotate",
  label: "Rotate",
  shortcut: "r",
  icon: <RotateIcon size={16} />,

  init: () => UPRIGHT,
  isNoop: isUpright,
  // Rust: edit/rotate.rs. A JPEG that's only rotated is saved losslessly there.
  toOps: (s) => [{ type: "rotate", quarterTurns: s.quarterTurns, flip: s.flip }],
  describe: describeRotation,
  // EditMode draws the image with this and hands other tools the rotated size.
  rotation: (s) => s,
  resultSize: (s, image) => rotatedSize(image, s),

  Controls: RotateControls,

  // ← → rotate, H / V flip.
  onKeyDown: (e, { setState }) => {
    const step = { ArrowLeft: STEPS.left, ArrowRight: STEPS.right, h: STEPS.flipH, v: STEPS.flipV }[
      e.key.length === 1 ? e.key.toLowerCase() : e.key
    ];
    if (!step) return false;
    setState((s) => after(step, s));
    return true;
  },
});
