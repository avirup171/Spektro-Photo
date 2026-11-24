import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type MouseEvent } from "react";
import { fullSrc, thumbSrc, versionOf, type ImageEntry } from "../lib/api";
import { useImageInfo } from "../lib/useImageInfo";
import type { EditPreset } from "../edit/EditMode";
import { InfoPanel } from "./InfoPanel";
import {
  AdjustIcon,
  ChevronLeftIcon,
  CropIcon,
  ExportIcon,
  ChevronRightIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
  GridIcon,
  InfoIcon,
  RotateIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./Icons";

const MAX_ZOOM = 8;
const STEP = 1.25;
const FIT_PAD = 24;
/** Longest edge of thumb:// images (THUMB_MAX in thumbs.rs). Thumbnails never upscale. */
const THUMB_MAX = 560;
/** A full image that's ready this soon replaces the placeholder at once; later, it fades in. */
const INSTANT_MS = 120;
let hintShown = false; // show the zoom hint once per app session

type Props = {
  images: ImageEntry[];
  index: number;
  dir: string;
  onIndex: (i: number) => void;
  onClose: () => void;
  infoOpen: boolean;
  onToggleInfo: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onTrash: (entry: ImageEntry) => void;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  /**
   * Open the editor on a tool ("crop", "adjust", "rotate"), optionally with
   * starting states; undefined when the image can't be edited (e.g. GIF).
   */
  onEdit?: (tool: string, preset?: EditPreset) => void;
  onExport: () => void;
  keysDisabled: boolean;
};

type Point = { x: number; y: number };

type Size = { w: number; h: number };

/**
 * Per-image view state. `zoom: null` means "fit to window".
 *
 * Loading a large photo goes: thumbnail placeholder (`thumb`, usually cached
 * by the grid, so it's instant) → full image's size known from its header
 * (`natural`) → full image decoded (`ready`, fades in over the placeholder) →
 * placeholder removed (`settled`).
 */
type ViewState = {
  key: string; // path + version: a file replaced by an edit gets fresh state
  born: number; // performance.now() when this image was shown
  natural: Size | null; // full-size dimensions
  thumb: Size | null; // the placeholder's dimensions, once it has loaded
  ready: boolean; // full image decoded and visible
  fadeIn: boolean; // it took long enough that a crossfade beats a jump
  settled: boolean; // crossfade finished: the placeholder can go
  failed: boolean;
  zoom: number | null;
  offset: Point; // image centre relative to stage centre, in screen px
  rotation: number; // degrees, multiple of 90 (not normalised, so the turn animates the short way)
  anim: boolean; // animate the next size/position change: on for buttons/keys, off for wheel and drag
};

const fresh = (key: string): ViewState => ({
  key,
  born: performance.now(),
  natural: null,
  thumb: null,
  ready: false,
  fadeIn: false,
  settled: false,
  failed: false,
  zoom: null,
  offset: { x: 0, y: 0 },
  rotation: 0,
  anim: false,
});

/**
 * Size to lay the placeholder out at before the full image's size is known. A
 * thumbnail smaller than THUMB_MAX *is* the original size; a bigger one only
 * tells us the aspect ratio, so assume "large" (fit to the window).
 */
function placeholderSize(t: Size | null): Size | null {
  if (!t) return null;
  return Math.max(t.w, t.h) < THUMB_MAX ? t : { w: t.w * 100, h: t.h * 100 };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function Viewer(p: Props) {
  const entry = p.images[p.index];
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [hint, setHint] = useState(!hintShown);

  // Reset zoom/rotation when the image changes. Adjusting state during render
  // (instead of in an effect) avoids one frame drawn with the old image's size.
  const viewKey = `${entry.path}|${versionOf(entry)}`;
  const [vs, setVs] = useState(() => fresh(viewKey));
  if (vs.key !== viewKey) setVs(fresh(viewKey));
  const v = vs.key === viewKey ? vs : fresh(viewKey);

  const info = useImageInfo(p.infoOpen ? entry.path : null, 0, versionOf(entry));

  // Track the stage size (it changes with the window and the info panel).
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- geometry ----------------------------------------------------------
  const rot = ((v.rotation % 360) + 360) % 360;
  const sideways = rot === 90 || rot === 270;
  const dims = v.natural ?? placeholderSize(v.thumb);
  const nw = dims?.w ?? 0;
  const nh = dims?.h ?? 0;
  const boxW = sideways ? nh : nw; // bounding box after rotation
  const boxH = sideways ? nw : nh;
  // "Fit" leaves a FIT_PAD margin so the photo doesn't touch the chrome, and
  // never upscales small images past 100%.
  const fit =
    dims && stage.w > 0
      ? Math.max(0.01, Math.min((stage.w - 2 * FIT_PAD) / boxW, (stage.h - 2 * FIT_PAD) / boxH, 1))
      : 1;
  const scale = v.zoom ?? fit;
  const off = v.zoom === null ? { x: 0, y: 0 } : v.offset;

  /**
   * Zoom to `target` (or a function of the current zoom), keeping the image
   * point under `at` fixed on screen. Computed from the *latest* state, so
   * several calls before React re-renders (fast wheel, held key) all count.
   * `anim`: glide there (buttons, keys) or jump (wheel, pinch).
   */
  function zoomTo(target: number | ((current: number) => number), at: Point = { x: 0, y: 0 }, anim = true) {
    if (!v.natural) return; // zooming needs the real size
    setVs((s) => {
      if (s.key !== viewKey) return s;
      const cur = s.zoom ?? fit;
      const curOff = s.zoom === null ? { x: 0, y: 0 } : s.offset;
      const next = Math.min(Math.max(typeof target === "function" ? target(cur) : target, fit), MAX_ZOOM);
      if (next <= fit + 1e-6) return { ...s, zoom: null, offset: { x: 0, y: 0 }, anim };
      const k = next / cur;
      return { ...s, zoom: next, offset: { x: at.x - (at.x - curOff.x) * k, y: at.y - (at.y - curOff.y) * k }, anim };
    });
  }
  const fitOr100 = () => (v.zoom === null ? zoomTo(fit < 1 ? 1 : 2) : zoomTo(0));
  const rotate = (deg: number) =>
    setVs((s) => ({ ...s, rotation: s.rotation + deg, zoom: null, offset: { x: 0, y: 0 }, anim: true }));

  function stagePoint(clientX: number, clientY: number): Point {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  }

  // ---- wheel zoom (native listener: React's onWheel is passive, so it can't
  //      preventDefault). The ref always points at this render's handler.
  //      A trackpad sends several wheel events per frame; they're added up and
  //      applied once per animation frame, so each frame renders once. ----
  const wheel = useRef({ amount: 0, at: { x: 0, y: 0 } as Point, frame: 0 });
  const applyWheel = useRef<() => void>(() => {});
  applyWheel.current = () => {
    const w = wheel.current;
    const amount = w.amount;
    w.frame = 0;
    w.amount = 0;
    zoomTo((cur) => cur * Math.exp(amount), w.at, false);
  };
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e) => {
    e.preventDefault();
    // Trackpad pinch arrives as wheel + ctrlKey with small deltas.
    const speed = e.ctrlKey ? 0.01 : 0.002;
    const w = wheel.current;
    w.amount -= e.deltaY * speed;
    w.at = stagePoint(e.clientX, e.clientY);
    if (!w.frame) w.frame = requestAnimationFrame(() => applyWheel.current());
  };
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const w = wheel.current;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => {
      el.removeEventListener("wheel", h);
      cancelAnimationFrame(w.frame);
    };
  }, []);

  // ---- drag to pan (at most one state update per frame, like the wheel) ---
  type Drag = { x: number; y: number; ox: number; oy: number; cx: number; cy: number; frame: number };
  const drag = useRef<Drag | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (v.zoom === null || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y, cx: e.clientX, cy: e.clientY, frame: 0 };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.cx = e.clientX;
    d.cy = e.clientY;
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      setVs((s) =>
        s.key === viewKey ? { ...s, offset: { x: d.ox + d.cx - d.x, y: d.oy + d.cy - d.y }, anim: false } : s,
      );
    });
  };
  const endDrag = () => (drag.current = null);
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const at = stagePoint(e.clientX, e.clientY);
    if (v.zoom === null) zoomTo(fit < 1 ? 1 : 2, at);
    else zoomTo(0);
  };

  // ---- viewer-only keys (App handles navigation, Esc, I, F, ⌫) -------------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (p.keysDisabled || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    switch (e.key) {
      case "+":
      case "=":
        zoomTo((cur) => cur * STEP);
        break;
      case "-":
      case "_":
        zoomTo((cur) => cur / STEP);
        break;
      case "0":
        zoomTo(0);
        break;
      case "1":
        zoomTo(1);
        break;
      case "r":
        rotate(90);
        break;
      case "R":
        rotate(-90);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---- small effects --------------------------------------------------------
  useEffect(() => {
    if (!hint) return;
    hintShown = true;
    const t = window.setTimeout(() => setHint(false), 3500);
    return () => window.clearTimeout(t);
  }, [hint]);

  // ---- loading ----------------------------------------------------------------
  // The full image's size is in its header, which arrives long before a big
  // photo has finished loading and decoding. Poll for it once per frame so the
  // layout (and zoom) is right while the placeholder is still showing.
  const fullRef = useRef<HTMLImageElement>(null);
  const needSize = !v.natural && !v.failed;
  useEffect(() => {
    if (!needSize) return;
    let frame = 0;
    const tick = () => {
      const img = fullRef.current;
      if (img && img.naturalWidth > 0) {
        const size = { w: img.naturalWidth, h: img.naturalHeight };
        // anim: glide if the placeholder was laid out at a guessed size
        setVs((s) => (s.key === viewKey && !s.natural ? { ...s, natural: size, anim: s.thumb !== null } : s));
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [viewKey, needSize]);

  const onFullLoad = (img: HTMLImageElement) => {
    const size = { w: img.naturalWidth, h: img.naturalHeight };
    // decode() decodes off the main thread and resolves when the image can be
    // painted without a stall. Without it, a 50 MP JPEG is decoded on its first
    // paint, which freezes the window for a moment, worst when flicking through.
    const decoded = typeof img.decode === "function" ? img.decode().catch(() => {}) : Promise.resolve();
    void decoded.then(() =>
      setVs((s) =>
        s.key === viewKey
          ? { ...s, natural: size, ready: true, fadeIn: s.thumb !== null && performance.now() - s.born > INSTANT_MS }
          : s,
      ),
    );
  };

  // Drop the placeholder once the full image has faded in over it.
  useEffect(() => {
    if (!v.ready || v.settled) return;
    const t = window.setTimeout(() => setVs((s) => (s.key === viewKey ? { ...s, settled: true } : s)), v.fadeIn ? 260 : 0);
    return () => window.clearTimeout(t);
  }, [viewKey, v.ready, v.settled, v.fadeIn]);

  // Warm the cache for neighbours so ← / → feel instant. Waits until you pause,
  // so holding an arrow key doesn't start loading every photo it passes.
  // decode() prepares them for painting too; the refs keep them alive.
  const warm = useRef<HTMLImageElement[]>([]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      warm.current = [1, -1].flatMap((d) => {
        const n = p.images[p.index + d];
        if (!n) return [];
        const img = new Image();
        img.decoding = "async";
        img.src = fullSrc(n);
        img.decode?.().catch(() => {});
        return [img];
      });
    }, 200);
    return () => window.clearTimeout(t);
  }, [p.index, p.images]);

  // ---- navigator (only when zoomed in past the window, unrotated) ----------
  let navigator: { w: number; h: number; x0: number; y0: number; x1: number; y1: number } | null = null;
  if (v.zoom !== null && v.natural && rot === 0) {
    const dw = nw * scale;
    const dh = nh * scale;
    const left = off.x - dw / 2;
    const top = off.y - dh / 2;
    const x0 = clamp01((-stage.w / 2 - left) / dw);
    const x1 = clamp01((stage.w / 2 - left) / dw);
    const y0 = clamp01((-stage.h / 2 - top) / dh);
    const y1 = clamp01((stage.h / 2 - top) / dh);
    if (x1 - x0 < 0.999 || y1 - y0 < 0.999) {
      const k = Math.min(160 / nw, 110 / nh);
      navigator = { w: nw * k, h: nh * k, x0, y0, x1, y1 };
    }
  }

  // Filmstrip window around the current image.
  const start = Math.max(0, p.index - 7);
  const end = Math.min(p.images.length, p.index + 8);
  const zoomLabel = v.zoom === null ? "Fit" : `${Math.round(scale * 100)}%`;

  // Same box for the placeholder and the full image, so one swaps for the other in place.
  const box = dims
    ? {
        width: nw * scale,
        height: nh * scale,
        transform: `translate(-50%, -50%) translate(${off.x}px, ${off.y}px) rotate(${v.rotation}deg)`,
      }
    : null;
  const showPlaceholder = !v.settled && !v.failed;
  const placeholderVisible = showPlaceholder && v.thumb !== null && box !== null;

  return (
    <div className="viewer">
      <div className="toolbar viewer-bar">
        <button className="btn compact" onClick={p.onClose} title="Back to grid (Esc)">
          <GridIcon size={16} /> Grid <kbd className="ghost">Esc</kbd>
        </button>
        <div className="viewer-title">
          <span className="strong ellipsis">{entry.name}</span>
          <span className="muted small">
            {p.index + 1} of {p.images.length}
            {v.zoom !== null && ` · ${zoomLabel}`}
          </span>
        </div>
        <div className="row-tight">
          <button className="icon-btn" onClick={() => zoomTo((cur) => cur / STEP)} aria-label="Zoom out" title="Zoom out (−)">
            <ZoomOutIcon />
          </button>
          <button
            className="zoom-label"
            onClick={fitOr100}
            aria-label={`Zoom: ${zoomLabel}. Toggle fit and 100%`}
            title="Toggle fit / 100% (0 / 1)"
          >
            {zoomLabel}
          </button>
          <button className="icon-btn" onClick={() => zoomTo((cur) => cur * STEP)} aria-label="Zoom in" title="Zoom in (+)">
            <ZoomInIcon />
          </button>
          <span className="divider" aria-hidden="true" />
          <button
            className="icon-btn"
            onClick={() => p.onEdit?.("crop")}
            disabled={!p.onEdit}
            aria-label="Crop"
            title={p.onEdit ? "Crop (C)" : "This format can’t be edited"}
          >
            <CropIcon />
          </button>
          <button
            className="icon-btn"
            onClick={() => p.onEdit?.("adjust")}
            disabled={!p.onEdit}
            aria-label="Adjust colours"
            title={p.onEdit ? "Adjust brightness, contrast, colour (A)" : "This format can’t be edited"}
          >
            <AdjustIcon />
          </button>
          <button className="icon-btn" onClick={() => rotate(90)} aria-label="Rotate 90°" title="Rotate view (R)">
            <RotateIcon />
          </button>
          {/* The view rotation is temporary; this keeps it (losslessly for JPEG) via the editor. */}
          {rot !== 0 && p.onEdit && (
            <button
              className="btn small-btn"
              onClick={() => p.onEdit!("rotate", { rotate: { quarterTurns: rot / 90, flip: false } })}
              title="Open the editor with this rotation, to save it"
            >
              Save rotation…
            </button>
          )}
          <button className="icon-btn" onClick={p.onExport} aria-label="Export" title="Export a resized copy (E)">
            <ExportIcon />
          </button>
          <button
            className={"icon-btn" + (p.infoOpen ? " on" : "")}
            onClick={p.onToggleInfo}
            aria-pressed={p.infoOpen}
            aria-label="Info"
            title="Info (I)"
          >
            <InfoIcon />
          </button>
          <button
            className="icon-btn"
            onClick={p.onToggleFullscreen}
            aria-label={p.isFullscreen ? "Exit full screen" : "Full screen"}
            title="Full screen (F)"
          >
            {p.isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
        </div>
      </div>

      <div className="viewer-body">
        <div
          ref={stageRef}
          className={"stage" + (v.zoom !== null ? " pannable" : "") + (v.anim ? " smooth" : "")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onDoubleClick}
        >
          {/* The grid's thumbnail, stretched to the final size, while the full image loads. */}
          {showPlaceholder && (
            <img
              key={`${viewKey}|thumb`}
              className="stage-img placeholder"
              src={thumbSrc(entry)}
              alt=""
              aria-hidden="true"
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                const size = { w: img.naturalWidth, h: img.naturalHeight };
                setVs((s) => (s.key === viewKey && !s.thumb ? { ...s, thumb: size } : s));
              }}
              style={placeholderVisible ? box : { visibility: "hidden" }}
            />
          )}
          {/* key: a new <img> per file, so a slow load never shows the old one.
              It stays transparent until decoded, then fades in over the placeholder. */}
          <img
            key={viewKey}
            ref={fullRef}
            className={"stage-img full" + (v.ready ? " ready" : "") + (v.fadeIn ? " fade" : "")}
            src={fullSrc(entry)}
            alt={entry.name}
            draggable={false}
            decoding="async"
            onLoad={(e) => onFullLoad(e.currentTarget)}
            onError={() => setVs((s) => (s.key === viewKey ? { ...s, failed: true } : s))}
            style={box ? { ...box, imageRendering: scale >= 3 ? "pixelated" : "auto" } : { visibility: "hidden" }}
          />
          {!v.ready && !v.failed &&
            (placeholderVisible ? (
              <div className="stage-loading" role="status">
                <span className="spinner small" aria-hidden="true" /> Loading full size…
              </div>
            ) : (
              <span className="spinner big" role="status" aria-label="Loading" />
            ))}
          {v.failed && <p className="muted stage-msg">Can’t display this image.</p>}

          {p.index > 0 && (
            <button className="nav-btn left" onClick={() => p.onIndex(p.index - 1)} aria-label="Previous image">
              <ChevronLeftIcon size={22} />
            </button>
          )}
          {p.index < p.images.length - 1 && (
            <button className="nav-btn right" onClick={() => p.onIndex(p.index + 1)} aria-label="Next image">
              <ChevronRightIcon size={22} />
            </button>
          )}

          {hint && <div className="hint-pill">Scroll to zoom · drag to pan · double-click for 100%</div>}

          {navigator && (
            <div className="navigator" style={{ width: navigator.w, height: navigator.h }} aria-hidden="true">
              <img src={thumbSrc(entry)} alt="" draggable={false} />
              <div
                className="navigator-rect"
                style={{
                  left: `${navigator.x0 * 100}%`,
                  top: `${navigator.y0 * 100}%`,
                  width: `${(navigator.x1 - navigator.x0) * 100}%`,
                  height: `${(navigator.y1 - navigator.y0) * 100}%`,
                }}
              />
            </div>
          )}
        </div>

        {p.infoOpen && (
          <InfoPanel
            entry={entry}
            dir={p.dir}
            info={info}
            onReveal={() => p.onReveal(entry.path)}
            onCopyPath={() => p.onCopyPath(entry.path)}
            onTrash={() => p.onTrash(entry)}
          />
        )}
      </div>

      {!p.isFullscreen && (
        <div className="filmstrip" aria-label="Nearby images">
          {p.images.slice(start, end).map((img, k) => {
            const i = start + k;
            return (
              <button
                key={img.path}
                className={"film" + (i === p.index ? " current" : "")}
                onClick={() => p.onIndex(i)}
                aria-label={img.name}
                aria-current={i === p.index || undefined}
              >
                <img src={thumbSrc(img)} alt="" draggable={false} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
