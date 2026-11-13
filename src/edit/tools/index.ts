// The editor's tools, in toolbar order. Operations are also applied in this
// order when saving, so geometry-changing tools come before tools that work on
// pixel values (brightness, filters). Rotate must come before crop: the crop
// box is measured on the rotated image.
import type { AnyTool } from "../tool";
import { adjustTool } from "./adjust";
import { cropTool } from "./crop";
import { rotateTool } from "./rotate";

export const tools: AnyTool[] = [rotateTool, cropTool, adjustTool];
