import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { thumbSrc, formatBytes, modKey, versionOf, type Folder, type ImageEntry } from "../lib/api";
import type { Recent } from "../lib/storage";
import { useImageInfo } from "../lib/useImageInfo";
import { ChevronRightIcon, CloseIcon, FolderIcon, PlusIcon, SearchIcon } from "./Icons";
import { removeOnDelete } from "./recentKeys";

export type SortKey = "name" | "date" | "size";
export const THUMB_MIN = 96;
export const THUMB_MAX = 280;
/** Matches `.grid`'s column gap in App.css. */
const COL_GAP = 10;
/** A tile asks for its thumbnail only after it has been near the screen this long. */
const DWELL_MS = 90;
/** Thumbnails this session has already shown: they skip the wait and the fade. */
const loadedThumbs = new Set<string>();

type Props = {
  folder: Folder;
  visible: ImageEntry[];
  total: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  filter: string;
  onFilter: (q: string) => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  thumbSize: number;
  onThumbSize: (n: number) => void;
  recents: Recent[];
  onOpenRecent: (dir: string) => void;
  /** Takes a folder off the recent list (the folder itself isn't touched). */
  onRemoveRecent: (dir: string) => void;
  onOpenFolder: () => void;
  filterRef: RefObject<HTMLInputElement | null>;
  gridRef: RefObject<HTMLDivElement | null>;
};

export function Library(p: Props) {
  const selected = p.visible.find((i) => i.path === p.selectedPath) ?? null;
  // Debounced so holding an arrow key doesn't fire a request per tile.
  const info = useImageInfo(selected?.path, 150, selected ? versionOf(selected) : "");

  // Keep the selected tile on screen when moving with the keyboard: glide to
  // it, except on the first render (e.g. back from the viewer), where it jumps
  // straight there and centres it.
  const firstScroll = useRef(true);
  useEffect(() => {
    const first = firstScroll.current;
    firstScroll.current = false;
    if (!p.selectedPath || !p.gridRef.current) return;
    const el = p.gridRef.current.querySelector(`[data-path="${CSS.escape(p.selectedPath)}"]`);
    const glide = !first && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView(first ? { block: "center" } : { block: "nearest", behavior: glide ? "smooth" : "auto" });
  }, [p.selectedPath, p.gridRef]);

  // Tile height, for `content-visibility: auto` (App.css): tiles far off screen
  // aren't laid out or painted, and this is the size they reserve meanwhile.
  // Mirrors the grid's `repeat(auto-fill, minmax(thumbSize, 1fr))` columns.
  const scrollRef = useRef<HTMLElement>(null);
  const [scrollW, setScrollW] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScrollW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = Math.max(1, Math.floor((scrollW + COL_GAP) / (p.thumbSize + COL_GAP)));
  const tileW = scrollW > 0 ? (scrollW - COL_GAP * (cols - 1)) / cols : p.thumbSize;
  const tileH = Math.round(tileW + 6 + 15); // square image, 6px gap, one line of 12px text

  const watch = useNearViewport(scrollRef);

  return (
    <div className="library">
      <div className="toolbar">
        <nav className="crumbs" aria-label="Current folder">
          {p.folder.parent_name && (
            <>
              <span className="muted">{p.folder.parent_name}</span>
              <ChevronRightIcon size={14} />
            </>
          )}
          <span className="strong">{p.folder.name}</span>
        </nav>
        <div className="spacer" />
        <label className="search">
          <SearchIcon size={14} />
          <input
            ref={p.filterRef}
            type="search"
            value={p.filter}
            onChange={(e) => p.onFilter(e.target.value)}
            placeholder={`Filter by name   ${modKey}F`}
            aria-label="Filter images by name"
            spellCheck={false}
          />
        </label>
        <label className="muted small row-tight">
          Sort
          <select value={p.sort} onChange={(e) => p.onSort(e.target.value as SortKey)} aria-label="Sort images by">
            <option value="name">Name</option>
            <option value="date">Date modified</option>
            <option value="size">Size</option>
          </select>
        </label>
        <label className="size-slider row-tight" title="Thumbnail size (+ / −)">
          <span className="sq small-sq" aria-hidden="true" />
          <input
            type="range"
            min={THUMB_MIN}
            max={THUMB_MAX}
            step={8}
            value={p.thumbSize}
            onChange={(e) => p.onThumbSize(Number(e.target.value))}
            aria-label="Thumbnail size"
          />
          <span className="sq" aria-hidden="true" />
        </label>
      </div>

      <div className="library-body">
        <aside className="sidebar">
          <h2 className="eyebrow">Recent folders</h2>
          {p.recents.map((r) => (
            // Two sibling buttons (a button can't contain another one); the
            // × shows on hover or keyboard focus.
            <div key={r.dir} className="side-row" onKeyDown={removeOnDelete(() => p.onRemoveRecent(r.dir))}>
              <button
                className={"side-item" + (r.dir === p.folder.dir ? " active" : "")}
                onClick={() => p.onOpenRecent(r.dir)}
                title={r.dir}
              >
                <FolderIcon size={16} />
                <span className="ellipsis">{r.name}</span>
              </button>
              <button
                className="remove-x"
                onClick={() => p.onRemoveRecent(r.dir)}
                aria-label={`Remove ${r.name} from recent folders`}
                title="Remove from recent folders (⌫). The folder itself isn’t touched."
              >
                <CloseIcon size={14} />
              </button>
            </div>
          ))}
          <div className="spacer" />
          <button className="side-item dashed" onClick={p.onOpenFolder}>
            <PlusIcon size={16} /> Open folder…
          </button>
        </aside>

        <main className="grid-scroll" ref={scrollRef}>
          {p.total === 0 ? (
            <EmptyState title="No images in this folder" hint="Supported: JPEG, PNG, GIF, WebP, BMP" />
          ) : p.visible.length === 0 ? (
            <EmptyState title={`No images match “${p.filter}”`} hint="Press Esc to clear the filter" />
          ) : (
            <div
              ref={p.gridRef}
              className="grid"
              style={
                {
                  gridTemplateColumns: `repeat(auto-fill, minmax(${p.thumbSize}px, 1fr))`,
                  "--tile-h": `${tileH}px`,
                } as CSSProperties
              }
            >
              {p.visible.map((img) => (
                <Tile
                  // includes the version so an edited file reloads its thumbnail
                  key={`${img.path}|${versionOf(img)}`}
                  entry={img}
                  selected={img.path === p.selectedPath}
                  onSelect={p.onSelect}
                  onOpen={p.onOpen}
                  watch={watch}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      <footer className="statusbar">
        <span>
          {p.visible.length === p.total ? p.total : `${p.visible.length} of ${p.total}`}{" "}
          {p.total === 1 ? "image" : "images"}
        </span>
        {selected && (
          <>
            <span aria-hidden="true">·</span>
            <span className="strong ellipsis">{selected.name}</span>
            <span>
              {info?.width && info.height ? `${info.width} × ${info.height} · ` : ""}
              {formatBytes(selected.size)}
            </span>
          </>
        )}
        <div className="spacer" />
        <span className="hide-narrow">Double-click or ↵ to open · C to crop · ⌫ to trash</span>
      </footer>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty">
      <p className="strong">{title}</p>
      <p className="muted small">{hint}</p>
    </div>
  );
}

/** Calls `onNear` once `el` has stayed near the visible area for DWELL_MS; returns a cleanup. */
type Watch = (el: Element, onNear: () => void) => () => void;

/**
 * One IntersectionObserver shared by every tile. Thumbnails are made in Rust
 * and a request can't be cancelled once it's queued, so with plain
 * `loading="lazy"` a fast scroll through 2,000 photos queued a decode for every
 * tile it passed, and the ones you stopped on waited at the back. Now a tile
 * only asks once it has been near the screen for a moment.
 */
function useNearViewport(rootRef: RefObject<HTMLElement | null>): Watch {
  const observer = useRef<IntersectionObserver | null>(null);
  const waiting = useRef(new Map<Element, { onNear: () => void; timer: number }>());

  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
      for (const w of waiting.current.values()) window.clearTimeout(w.timer);
    },
    [],
  );

  return useCallback(
    (el, onNear) => {
      const pending = waiting.current;
      // Created on first use: tiles' effects run before this component's, but
      // the scroll container's ref is already set by then.
      if (!observer.current) {
        observer.current = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              const w = pending.get(e.target);
              if (!w) continue;
              window.clearTimeout(w.timer);
              if (!e.isIntersecting) continue;
              w.timer = window.setTimeout(() => {
                pending.delete(e.target);
                observer.current?.unobserve(e.target);
                w.onNear();
              }, DWELL_MS);
            }
          },
          // "Near" = on screen or within ~2 rows below/above, so thumbnails are
          // usually ready by the time a slow scroll reaches them.
          { root: rootRef.current, rootMargin: "400px 0px" },
        );
      }
      pending.set(el, { onNear, timer: 0 });
      observer.current.observe(el);
      return () => {
        const w = pending.get(el);
        if (w) window.clearTimeout(w.timer);
        pending.delete(el);
        observer.current?.unobserve(el);
      };
    },
    [rootRef],
  );
}

type TileProps = {
  entry: ImageEntry;
  selected: boolean;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  watch: Watch;
};

// memo: with hundreds of tiles, only the two whose `selected` changed re-render
// when you press an arrow key (needs stable onSelect/onOpen from App).
const Tile = memo(function Tile({ entry, selected, onSelect, onOpen, watch }: TileProps) {
  const src = thumbSrc(entry);
  const seen = loadedThumbs.has(src);
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(seen);
  const [state, setState] = useState<"loading" | "ok" | "error">(seen ? "ok" : "loading");

  useEffect(() => {
    if (near || !ref.current) return;
    return watch(ref.current, () => setNear(true));
  }, [near, watch]);

  return (
    <button
      ref={ref}
      className={"tile" + (selected ? " selected" : "")}
      data-path={entry.path}
      // Roving tabindex: Tab lands on the selected tile, not on every tile.
      tabIndex={selected ? 0 : -1}
      aria-label={entry.name}
      aria-current={selected || undefined}
      onClick={() => onSelect(entry.path)}
      onDoubleClick={() => onOpen(entry.path)}
    >
      <span className="tile-img" data-state={state}>
        {/* Only tiles that stayed near the screen request a thumbnail (useNearViewport). */}
        {near && (
          <img
            src={src}
            alt=""
            decoding="async"
            draggable={false}
            onLoad={() => {
              loadedThumbs.add(src);
              setState("ok");
            }}
            onError={() => setState("error")}
          />
        )}
        {state === "loading" && <span className="spinner" aria-hidden="true" />}
        {state === "error" && <span className="tile-broken">Can’t preview</span>}
      </span>
      <span className="tile-name">{entry.name}</span>
    </button>
  );
});
