import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ExportDialog } from "../components/ExportDialog";
import { applyEdits, fullSrc, isHeic, modKey, type Exported, type ImageEntry } from "../lib/api";
import { compose, IDENTITY, isIdentity, toSvgValues, type ColorMatrix } from "./colorMatrix";
import {
  after,
  cssTransform,
  inverse,
  isUpright,
  rotateBox,
  rotatedSize,
  sameRotation,
  swapsSides,
  UPRIGHT,
  type Rotation,
} from "./orientation";
import type { ToolProps } from "./tool";
import { tools } from "./tools";
import type { EditResult, SaveMode, Size } from "./types";

const PAD = 40; // space around the image inside the stage
const MAX_SCALE = 4; // tiny images are enlarged, but not absurdly
const PREVIEW_FILTER = "edit-preview"; // id of the SVG filter below; one editor at a time

/** Starting states for some tools, by tool id, e.g. the viewer's rotation. */
export type EditPreset = Record<string, unknown>;

type Props = {
  entry: ImageEntry;
  /** Tool to start with, e.g. "adjust" when opened with A. Defaults to the first. */
  initialTool?: string;
  preset?: EditPreset;
  onCancel: () => void;
  onSaved: (result: EditResult) => void;
  onExported: (result: Exported) => void;
};

/** The combined rotation of every tool that rotates (just the rotate tool today). */
const rotationOf = (states: Record<string, unknown>): Rotation =>
  tools.reduce<Rotation>((r, t) => (t.rotation && t.id in states ? after(t.rotation(states[t.id]), r) : r), UPRIGHT);

/**
 * Full-window editor. Generic over tools: it lays out the image, renders the
 * active tool's controls and overlay, and on save sends every tool's
 * operations to Rust in registry order.
 */
export function EditMode({ entry, initialTool, preset, onCancel, onSaved, onExported }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  /** The photo as loaded (EXIF rotation applied), before the rotate tool. */
  const [natural, setNatural] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeId, setActiveId] = useState(() =>
    tools.some((t) => t.id === initialTool) ? initialTool! : tools[0].id,
  );
  const [states, setStates] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<SaveMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [exporting, setExporting] = useState(false);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Rotating tools start first, so the others start in the rotated space.
  const initAll = (size: Size, start?: EditPreset) => {
    const all: Record<string, unknown> = {};
    for (const t of tools) if (t.rotation) all[t.id] = start?.[t.id] ?? t.init(size);
    const turned = rotatedSize(size, rotationOf(all));
    for (const t of tools) if (!t.rotation) all[t.id] = start?.[t.id] ?? t.init(turned);
    return all;
  };

  // What every tool sees as "the image": the photo after the rotate tool.
  const rotation = rotationOf(states);
  const image = natural && rotatedSize(natural, rotation);

  const scale = image
    ? Math.max(0.01, Math.min((stage.w - 2 * PAD) / image.width, (stage.h - 2 * PAD) / image.height, MAX_SCALE))
    : 1;

  const propsFor = (id: string): ToolProps<unknown> => ({
    state: states[id],
    setState: (next) =>
      setStates((all) => {
        const updated = {
          ...all,
          [id]: typeof next === "function" ? (next as (prev: unknown) => unknown)(all[id]) : next,
        };
        return natural ? followRotation(all, updated, natural) : updated;
      }),
    image: image!,
    scale,
  });

  /** When the rotation changes, carry position-based state (the crop box) along with the photo. */
  function followRotation(before: Record<string, unknown>, now: Record<string, unknown>, size: Size) {
    const [from, to] = [rotationOf(before), rotationOf(now)];
    if (sameRotation(from, to)) return now;
    const step = after(to, inverse(from)); // the turn just made
    const old = rotatedSize(size, from);
    const move = (b: Parameters<typeof rotateBox>[0]) => rotateBox(b, step, old);
    for (const t of tools) if (t.reorient) now[t.id] = t.reorient(now[t.id], move, swapsSides(step));
    return now;
  }

  const ready = image !== null && tools.every((t) => t.id in states);
  const changedTools = ready ? tools.filter((t) => !t.isNoop(states[t.id], image)) : [];
  const changed = changedTools.length > 0;
  // HEIC can be read but not written, so edits always become a JPEG copy.
  const copyOnly = isHeic(entry);
  const active = tools.find((t) => t.id === activeId)!;

  // Live colour preview: every tool's matrix, composed in registry order (the
  // same order Rust applies the operations). The webview draws it with an SVG
  // filter at screen size, so sliders stay fast; the file is only touched on save.
  const preview = ready
    ? tools.reduce<ColorMatrix>((m, t) => (t.colorMatrix ? compose(t.colorMatrix(states[t.id]), m) : m), IDENTITY)
    : IDENTITY;
  const previewOn = !isIdentity(preview);

  // Everything the editor would save, in order. Empty when nothing changed.
  const ops = ready ? changedTools.flatMap((t) => t.toOps(states[t.id], image)) : [];
  // Final size after every change, shown in the Export dialog.
  const resultSize = ready
    ? changedTools.reduce<Size>((size, t) => (t.resultSize ? t.resultSize(states[t.id], size) : size), natural!)
    : null;

  async function save(mode: SaveMode) {
    if (!ready || !changed || busy) return;
    setBusy(mode);
    setError(null);
    try {
      onSaved(await applyEdits(entry.path, ops, mode));
    } catch (e) {
      setError(String(e));
      setBusy(null);
      setConfirmReplace(false);
    }
  }

  // ---- keyboard: one listener, always calling this render's handler ----
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (busy || exporting) return; // the Export dialog handles its own keys
    if (confirmReplace) {
      if (e.key === "Escape") {
        e.preventDefault();
        setConfirmReplace(false);
      }
      return; // let Tab / Enter work on the dialog's buttons
    }
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save("newFile");
      return;
    }
    if (mod || e.altKey || !ready) return;
    if (e.key.toLowerCase() === "e") {
      e.preventDefault();
      setExporting(true);
      return;
    }
    const tool = tools.find((t) => t.shortcut === e.key.toLowerCase());
    if (tool) {
      setActiveId(tool.id);
      e.preventDefault();
      return;
    }
    if (active.onKeyDown?.(e, propsFor(active.id))) e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const canvas = image
    ? {
        width: image.width * scale,
        height: image.height * scale,
        left: (stage.w - image.width * scale) / 2,
        top: (stage.h - image.height * scale) / 2,
      }
    : null;
  // The <img> keeps its unrotated size and is turned with CSS around the
  // canvas centre, so it exactly fills the (rotated) canvas.
  const imgStyle: CSSProperties = {};
  if (previewOn) imgStyle.filter = `url(#${PREVIEW_FILTER})`;
  if (natural && canvas && !isUpright(rotation)) {
    Object.assign(imgStyle, {
      position: "absolute",
      width: natural.width * scale,
      height: natural.height * scale,
      left: (canvas.width - natural.width * scale) / 2,
      top: (canvas.height - natural.height * scale) / 2,
      transform: cssTransform(rotation),
    });
  }
  const { Controls, Overlay, Panel } = active;

  return (
    <div className="editor">
      <div className="toolbar editor-bar">
        <button className="btn compact" onClick={onCancel} disabled={!!busy}>
          Cancel <kbd className="ghost">Esc</kbd>
        </button>
        <div className="segmented tools" role="tablist" aria-label="Edit tools">
          {tools.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              onClick={() => setActiveId(t.id)}
              title={`${t.label} (${t.shortcut.toUpperCase()})`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
        <span className="muted small ellipsis editor-name">{entry.name}</span>
        <div className="spacer" />
        {ready && Controls && <Controls {...propsFor(active.id)} />}
      </div>

      {/* The preview filter. color-interpolation-filters="sRGB" makes it work on
          the stored values, like Rust does (the SVG default is linear light). */}
      <svg className="svg-defs" width="0" height="0" aria-hidden="true">
        <filter id={PREVIEW_FILTER} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={toSvgValues(preview)} />
        </filter>
      </svg>

      <div className="editor-body">
        <div ref={stageRef} className="editor-stage">
          <div className="editor-canvas" style={canvas ?? { visibility: "hidden" }}>
            <img
              src={fullSrc(entry)}
              alt={entry.name}
              draggable={false}
              style={imgStyle}
              onLoad={(e) => {
                const size = { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight };
                setNatural(size);
                setStates(initAll(size, preset));
              }}
              onError={() => setFailed(true)}
            />
            {ready && Overlay && <Overlay {...propsFor(active.id)} />}
          </div>
          {!image && !failed && <span className="spinner big" aria-label="Loading" />}
          {failed && <p className="muted stage-msg">Can’t load this image.</p>}
        </div>
        {ready && Panel && <Panel {...propsFor(active.id)} />}
      </div>

      <div className="editor-footer">
        <span className="small tabular">{ready && active.describe ? active.describe(states[active.id], image) : ""}</span>
        {error && (
          <span className="small error-text ellipsis" role="alert">
            {error}
          </span>
        )}
        <div className="spacer" />
        <button className="btn" onClick={() => natural && setStates(initAll(natural))} disabled={!changed || !!busy}>
          Reset
        </button>
        <button
          className="btn"
          onClick={() => setExporting(true)}
          disabled={!ready || !!busy}
          title="Export a resized or converted copy, with these edits (E)"
        >
          Export…
        </button>
        <button
          className="btn"
          onClick={() => setConfirmReplace(true)}
          disabled={!changed || !!busy || copyOnly}
          title={copyOnly ? "HEIC photos are saved as a JPEG copy" : undefined}
        >
          Replace original…
        </button>
        <button className="btn primary" onClick={() => save("newFile")} disabled={!changed || !!busy}>
          {busy === "newFile" ? "Saving…" : copyOnly ? "Save as JPEG copy" : "Save as copy"}{" "}
          <kbd className="on-accent">{modKey}S</kbd>
        </button>
      </div>

      {exporting && ready && (
        <ExportDialog
          entry={entry}
          ops={ops}
          size={resultSize}
          withEdits={changed}
          onClose={() => setExporting(false)}
          onExported={(r) => {
            setExporting(false);
            onExported(r);
          }}
        />
      )}

      {confirmReplace && (
        <div className="modal-backdrop" onClick={() => !busy && setConfirmReplace(false)}>
          <div
            className="modal confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="replace-title"
            aria-describedby="replace-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="replace-title">Replace “{entry.name}”?</h2>
            <p id="replace-desc" className="muted">
              The edited image will be saved in its place. The original is moved to the Trash, so you can still
              restore it from there.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmReplace(false)} disabled={!!busy} autoFocus>
                Cancel
              </button>
              <button className="btn danger-solid" onClick={() => save("replace")} disabled={!!busy}>
                {busy === "replace" ? "Replacing…" : "Replace"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
