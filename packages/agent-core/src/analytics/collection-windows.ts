/**
 * Bounded collection schedule.
 *
 * Post performance keeps moving after publication, so one snapshot is not
 * enough — but polling forever would burn API quota for nothing. These windows
 * are a finite ladder: once the last one is captured the post stops being
 * collected, which is what makes an API storm structurally impossible rather
 * than merely discouraged.
 *
 * Offsets are configurable; the defaults are ~1h, ~6h, ~24h, ~72h.
 */

export interface CollectionWindow {
  name: string;
  offsetMinutes: number;
}

export const DEFAULT_COLLECTION_WINDOWS: CollectionWindow[] = [
  { name: "initial", offsetMinutes: 60 },
  { name: "early", offsetMinutes: 6 * 60 },
  { name: "daily", offsetMinutes: 24 * 60 },
  { name: "extended", offsetMinutes: 72 * 60 },
];

/** Parses "60,360,1440,4320" from configuration into named windows. */
export function parseCollectionWindows(spec: string | undefined): CollectionWindow[] {
  if (!spec?.trim()) return DEFAULT_COLLECTION_WINDOWS;

  const offsets = spec
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (offsets.length === 0) return DEFAULT_COLLECTION_WINDOWS;

  const names = DEFAULT_COLLECTION_WINDOWS.map((w) => w.name);
  return offsets.map((offsetMinutes, index) => ({
    name: names[index] ?? `window_${index + 1}`,
    offsetMinutes,
  }));
}

/**
 * The next window that has not been captured yet, given when the post was
 * published. Returns undefined once the ladder is exhausted — the signal to
 * stop collecting this post entirely.
 */
export function nextWindow(
  publishedAt: Date,
  completedWindows: string[],
  windows: CollectionWindow[] = DEFAULT_COLLECTION_WINDOWS,
): { window: CollectionWindow; dueAt: Date } | undefined {
  const done = new Set(completedWindows);
  for (const window of windows) {
    if (done.has(window.name)) continue;
    return { window, dueAt: new Date(publishedAt.getTime() + window.offsetMinutes * 60_000) };
  }
  return undefined;
}

/**
 * Which window a collection running *now* satisfies. A worker that runs late
 * (or a post published while the stack was down) should record the furthest
 * window actually reached rather than replaying every earlier one — the
 * platform only reports current totals, so backfilling old windows would
 * store the same numbers under different labels.
 */
export function windowDueNow(
  publishedAt: Date,
  completedWindows: string[],
  now: Date,
  windows: CollectionWindow[] = DEFAULT_COLLECTION_WINDOWS,
): CollectionWindow | undefined {
  const done = new Set(completedWindows);
  const elapsedMinutes = (now.getTime() - publishedAt.getTime()) / 60_000;

  let due: CollectionWindow | undefined;
  for (const window of windows) {
    if (done.has(window.name)) continue;
    if (elapsedMinutes >= window.offsetMinutes) due = window;
  }
  return due;
}
