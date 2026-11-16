import { useEffect, useRef, useState } from "react";
import { exportImage, versionOf, type ExportOptions, type Exported, type ImageEntry } from "../lib/api";
import { load, save } from "../lib/storage";
import { useImageInfo } from "../lib/useImageInfo";
import type { EditOp, Size } from "../edit/types";

type SizeChoice = "original" | "3840" | "2048" | "1080" | "custom";

/** Remembered between exports (localStorage "exportOptions"). */
type Prefs = {
  size: SizeChoice;
  custom: number;
  format: ExportOptions["format"];
  quality: number;
  metadata: ExportOptions["metadata"];
};

const DEFAULTS: Prefs = { size: "2048", custom: 1600, format: "jpeg", quality: 85, metadata: "noLocation" };

const SIZES: { id: SizeChoice; label: string; title?: string }[] = [
  { id: "original", label: "Original" },
  { id: "3840", label: "3840", title: "4K screens" },
  { id: "2048", label: "2048", title: "Sharing and messaging apps" },
  { id: "1080", label: "1080", title: "Social media, email" },
  { id: "custom", label: "Custom" },
];

const METADATA: { id: ExportOptions["metadata"]; label: string; hint: string }[] = [
  { id: "keep", label: "Keep all", hint: "Camera, lens, date and location stay in the file." },
  { id: "noLocation", label: "Remove location", hint: "Camera, lens and date stay. Where the photo was taken is removed." },
  { id: "none", label: "Remove all", hint: "No camera details, date or location. Colours are kept." },
];

const MIN_EDGE = 16;
const MAX_EDGE = 30000;

/** Same rounding as Rust's `resize` (image crate), so the preview matches the file. */
function fitInside(s: Size, maxEdge: number | null): Size {
  const long = Math.max(s.width, s.height);
  if (maxEdge === null || long <= maxEdge) return s;
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(s.width * k)), height: Math.max(1, Math.round(s.height * k)) };
}

type Props = {
  entry: ImageEntry;
  /** The editor's operations ([] from the viewer / grid). */
  ops: EditOp[];
  /** Size after `ops`; looked up from the file when not given. */
  size?: Size | null;
  /** Opened from the editor with changes: say that they're included. */
  withEdits?: boolean;
  onClose: () => void;
  onExported: (result: Exported) => void;
};

/**
 * Resize / convert / strip metadata, then Rust shows the native Save panel.
 * Cancelling that panel leaves this dialog open, so a setting can be changed.
 */
export function ExportDialog({ entry, ops, size, withEdits, onClose, onExported }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(() => ({ ...DEFAULTS, ...load<Partial<Prefs>>("exportOptions", {}) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => save("exportOptions", prefs), [prefs]);
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));

  const info = useImageInfo(size ? null : entry.path, 0, versionOf(entry));
  const source = size ?? (info?.width && info.height ? { width: info.width, height: info.height } : null);

  const customOk = Number.isInteger(prefs.custom) && prefs.custom >= MIN_EDGE && prefs.custom <= MAX_EDGE;
  const maxEdge = prefs.size === "original" ? null : prefs.size === "custom" ? prefs.custom : Number(prefs.size);
  const valid = prefs.size !== "custom" || customOk;
  const out = source && valid ? fitInside(source, maxEdge) : null;
  const shrinks = !!(source && out && out.width !== source.width);

  async function run() {
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await exportImage(entry.path, ops, {
        format: prefs.format,
        quality: prefs.quality,
        maxEdge,
        metadata: prefs.metadata,
      });
      if (r) onExported(r);
      else setBusy(false); // Save panel cancelled
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  // Esc closes. The editor / app ignore keys while this is open.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (e.key === "Escape" && !busy) {
      e.preventDefault();
      onClose();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const hint = METADATA.find((m) => m.id === prefs.metadata)!.hint;

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="export-title" className="ellipsis">
            Export “{entry.name}”
          </h2>
        </div>
        {withEdits && <p className="muted small export-note">Includes your edits. The original isn’t changed.</p>}

        <div className="export-field">
          <span className="export-label" id="export-size">
            Long edge
          </span>
          <div className="export-control">
            <div className="segmented" role="group" aria-labelledby="export-size">
              {SIZES.map((s) => (
                <button
                  key={s.id}
                  aria-pressed={prefs.size === s.id}
                  onClick={() => set("size", s.id)}
                  title={s.title}
                  disabled={busy}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {prefs.size === "custom" && (
              <label className="export-custom">
                <input
                  type="number"
                  min={MIN_EDGE}
                  max={MAX_EDGE}
                  step={1}
                  value={Number.isFinite(prefs.custom) ? prefs.custom : ""}
                  onChange={(e) => set("custom", e.currentTarget.valueAsNumber)}
                  onKeyDown={(e) => e.key === "Enter" && run()}
                  aria-label="Long edge in pixels"
                  aria-invalid={!customOk}
                  disabled={busy}
                  autoFocus
                />
                px
              </label>
            )}
            <span className={"small tabular " + (valid ? "muted" : "error-text")} aria-live="polite">
              {!valid
                ? `Enter ${MIN_EDGE}–${MAX_EDGE} px`
                : source && out
                  ? shrinks
                    ? `${source.width} × ${source.height} → ${out.width} × ${out.height} px`
                    : `${out.width} × ${out.height} px${maxEdge !== null ? " (already smaller, not enlarged)" : ""}`
                  : " "}
            </span>
          </div>
        </div>

        <div className="export-field">
          <span className="export-label" id="export-format">
            Format
          </span>
          <div className="export-control">
            <div className="segmented" role="group" aria-labelledby="export-format">
              <button aria-pressed={prefs.format === "jpeg"} onClick={() => set("format", "jpeg")} disabled={busy}>
                JPEG
              </button>
              <button aria-pressed={prefs.format === "png"} onClick={() => set("format", "png")} disabled={busy}>
                PNG
              </button>
            </div>
            <span className="muted small">
              {prefs.format === "jpeg" ? "Small files, best for photos." : "Lossless and keeps transparency; much larger files."}
            </span>
          </div>
        </div>

        {prefs.format === "jpeg" && (
          <div className="export-field">
            <label className="export-label" htmlFor="export-quality">
              Quality
            </label>
            <div className="export-control export-quality">
              <input
                id="export-quality"
                type="range"
                min={50}
                max={100}
                step={1}
                value={prefs.quality}
                onChange={(e) => set("quality", e.currentTarget.valueAsNumber)}
                disabled={busy}
              />
              <output htmlFor="export-quality" className="tabular">
                {prefs.quality}
              </output>
            </div>
          </div>
        )}

        <div className="export-field">
          <span className="export-label" id="export-meta">
            Metadata
          </span>
          <div className="export-control">
            <div className="segmented" role="group" aria-labelledby="export-meta">
              {METADATA.map((m) => (
                <button
                  key={m.id}
                  aria-pressed={prefs.metadata === m.id}
                  onClick={() => set("metadata", m.id)}
                  disabled={busy}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="muted small">{hint}</span>
          </div>
        </div>

        {error && (
          <p className="small error-text" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={run} disabled={busy || !valid} autoFocus={prefs.size !== "custom"}>
            {busy ? "Exporting…" : "Export…"}
          </button>
        </div>
      </div>
    </div>
  );
}
