import { FlipHorizontalIcon, FlipVerticalIcon, RotateIcon, RotateLeftIcon } from "../../../components/Icons";
import { after, type Rotation } from "../../orientation";
import type { ToolProps } from "../../tool";
import { STEPS } from "./steps";

export function RotateControls({ setState }: ToolProps<Rotation>) {
  const buttons = [
    { step: STEPS.left, label: "Rotate left", key: "←", icon: <RotateLeftIcon /> },
    { step: STEPS.right, label: "Rotate right", key: "→", icon: <RotateIcon /> },
    { step: STEPS.flipH, label: "Flip horizontal", key: "H", icon: <FlipHorizontalIcon /> },
    { step: STEPS.flipV, label: "Flip vertical", key: "V", icon: <FlipVerticalIcon /> },
  ];
  return (
    <div className="row-tight rotate-controls">
      {buttons.map((b) => (
        <button
          key={b.label}
          className="icon-btn"
          onClick={() => setState((s) => after(b.step, s))}
          aria-label={b.label}
          title={`${b.label} (${b.key})`}
        >
          {b.icon}
        </button>
      ))}
    </div>
  );
}
