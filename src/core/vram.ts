/**
 * PlayStation VRAM model: placement, constraints, overlap and free space.
 *
 * VRAM is 1024 x 512 sixteen-bit halfwords. Everything in this module counts
 * in HALFWORDS, matching the units a TIM section header uses, because mixing
 * texel and halfword units is the classic way to get a layout subtly wrong.
 *
 * Placement constraints, from psx-spx (graphicsprocessingunitgpu.md):
 *   - A texture page sits at X in multiples of 64 halfwords and Y in multiples
 *     of 256 lines. So there are 16 x 2 = 32 pages.
 *   - A CLUT sits at X in multiples of 16 halfwords, at any Y in 0..511.
 *
 * Neither is enforced by the file format - both are consumer constraints, so a
 * TIM can perfectly well store an illegal position. Flagging that is a large
 * part of what this tool is for.
 */

import { TimType, bitsPerTexel } from './tim.js';

export const VRAM_WIDTH = 1024;

/**
 * VRAM height in lines.
 *
 * Width is INVARIANT at 1024 either way; only the Y axis changes, 9-bit to
 * 10-bit. This is NOT an arcade or System 573 feature: 2MB addressing is built
 * into all 208-pin retail silicon, and retail boards simply never populated the
 * second bank, so the 10-bit Y path was there all along with nothing to reach.
 * People mod retail consoles with a second chip. Call it 2MB VRAM, never
 * "573 support".
 */
export const VRAM_HEIGHT_1MB = 512;
export const VRAM_HEIGHT_2MB = 1024;

/** Retail default. Functions here take an explicit height where it matters. */
export const VRAM_HEIGHT = VRAM_HEIGHT_1MB;

/** A texture page is 64 halfwords wide and 256 lines tall. */
export const PAGE_WIDTH = 64;
export const PAGE_HEIGHT = 256;
export const PAGES_ACROSS = VRAM_WIDTH / PAGE_WIDTH; // 16

/** Page rows: 2 with 1MB, 4 with 2MB. */
export function pagesDown(height = VRAM_HEIGHT): number {
  return height / PAGE_HEIGHT;
}

/** CLUTs must start at an X that is a multiple of 16 halfwords. */
export const CLUT_X_ALIGN = 16;

/** Texture coordinates are 8-bit, so no single page can address past 256. */
export const MAX_UV = 256;

/** A rectangle in VRAM halfword coordinates. */
export interface VramRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What kind of thing occupies a rectangle. Affects which rules apply. */
export type PlacementKind = 'texture' | 'clut' | 'keepout';

/** Kinds that reserve space rather than occupy it with data. */
export function isReserved(kind: PlacementKind): boolean {
  return kind === 'keepout';
}

export interface Placement {
  id: string;
  kind: PlacementKind;
  rect: VramRect;
  /** Depth, for textures. Governs texel width and page-span rules. */
  type?: TimType;
  label?: string;
}

// ---------------------------------------------------------------------------
// Rect helpers
// ---------------------------------------------------------------------------

export function rectsOverlap(a: VramRect, b: VramRect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/** The overlapping region of two rects, or undefined if they are disjoint. */
export function intersection(a: VramRect, b: VramRect): VramRect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, w: right - x, h: bottom - y };
}

export function rectArea(r: VramRect): number {
  return r.w * r.h;
}

export function contains(outer: VramRect, inner: VramRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function vramRect(height = VRAM_HEIGHT): VramRect {
  return { x: 0, y: 0, w: VRAM_WIDTH, h: height };
}

// ---------------------------------------------------------------------------
// Texture page geometry
// ---------------------------------------------------------------------------

/** Texel width of one texture page at the given depth. */
export function pageTexelWidth(type: TimType): number {
  const bpp = bitsPerTexel(type);
  if (bpp === 0) return PAGE_WIDTH;
  return (PAGE_WIDTH * 16) / bpp; // 4bpp:256, 8bpp:128, 16bpp:64, 24bpp:~42
}

/** Page index (0..31) containing a halfword coordinate, or -1 if out of range. */
export function pageIndexAt(x: number, y: number, height = VRAM_HEIGHT): number {
  if (x < 0 || y < 0 || x >= VRAM_WIDTH || y >= height) return -1;
  return Math.floor(y / PAGE_HEIGHT) * PAGES_ACROSS + Math.floor(x / PAGE_WIDTH);
}

/** How many texture pages a rectangle touches horizontally. */
export function pagesSpanned(rect: VramRect): number {
  const first = Math.floor(rect.x / PAGE_WIDTH);
  const last = Math.floor((rect.x + rect.w - 1) / PAGE_WIDTH);
  return last - first + 1;
}

/** True when a rect starts exactly on a texture page origin. */
export function isPageAligned(rect: VramRect): boolean {
  return rect.x % PAGE_WIDTH === 0 && rect.y % PAGE_HEIGHT === 0;
}

// ---------------------------------------------------------------------------
// Constraint checking
// ---------------------------------------------------------------------------

export type IssueCode =
  | 'out-of-bounds'
  | 'overlap'
  | 'clut-misaligned'
  | 'crosses-page-row'
  | 'exceeds-uv-range'
  | 'in-keepout';

export interface Issue {
  code: IssueCode;
  severity: 'error' | 'warn';
  /** Placement ids involved. One for a rule violation, two for an overlap. */
  ids: string[];
  message: string;
  /** The offending region, where one exists. */
  rect?: VramRect;
}

/**
 * Check one placement against the rules that apply to it alone.
 * Pairwise rules (overlap) are handled by checkLayout.
 */
export function checkPlacement(p: Placement, height = VRAM_HEIGHT): Issue[] {
  const issues: Issue[] = [];
  const { rect } = p;

  if (!contains(vramRect(height), rect)) {
    issues.push({
      code: 'out-of-bounds',
      severity: 'error',
      ids: [p.id],
      message: `${p.label ?? p.id} extends outside VRAM (${rect.x},${rect.y} ${rect.w}x${rect.h} halfwords)`,
      rect,
    });
  }

  if (p.kind === 'clut' && rect.x % CLUT_X_ALIGN !== 0) {
    issues.push({
      code: 'clut-misaligned',
      severity: 'error',
      ids: [p.id],
      message: `CLUT ${p.label ?? p.id} starts at X=${rect.x}; CLUTs must start at a multiple of ${CLUT_X_ALIGN} halfwords`,
      rect,
    });
  }

  if (p.kind === 'texture') {
    // A texture page is 256 lines tall. Straddling that boundary means no
    // single tpage register value addresses the whole texture.
    const firstRow = Math.floor(rect.y / PAGE_HEIGHT);
    const lastRow = Math.floor((rect.y + rect.h - 1) / PAGE_HEIGHT);
    if (lastRow > firstRow) {
      issues.push({
        code: 'crosses-page-row',
        severity: 'warn',
        ids: [p.id],
        message: `${p.label ?? p.id} crosses the Y=${PAGE_HEIGHT} page boundary; no single texture page covers it`,
        rect,
      });
    }

    if (p.type !== undefined) {
      const texels = texelsWide(rect.w, p.type);
      if (texels > MAX_UV) {
        issues.push({
          code: 'exceeds-uv-range',
          severity: 'warn',
          ids: [p.id],
          message: `${p.label ?? p.id} is ${texels} texels wide; U is 8-bit so a single page cannot address past ${MAX_UV}`,
          rect,
        });
      }
    }
  }

  return issues;
}

function texelsWide(halfwords: number, type: TimType): number {
  const bpp = bitsPerTexel(type);
  if (bpp === 0) return halfwords;
  return Math.floor((halfwords * 16) / bpp);
}

/** Check a whole layout: per-placement rules plus every pairwise overlap. */
export function checkLayout(placements: Placement[], height = VRAM_HEIGHT): Issue[] {
  const issues: Issue[] = [];
  for (const p of placements) issues.push(...checkPlacement(p, height));

  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i];
      const b = placements[j];
      const hit = intersection(a.rect, b.rect);
      if (!hit) continue;

      // Two reserved regions overlapping each other is the user's business,
      // not a defect - a keepout may deliberately cover a framebuffer.
      if (isReserved(a.kind) && isReserved(b.kind)) continue;

      const reserved = isReserved(a.kind) ? a : isReserved(b.kind) ? b : undefined;
      const other = reserved === a ? b : a;
      issues.push({
        code: reserved ? 'in-keepout' : 'overlap',
        severity: 'error',
        ids: [a.id, b.id],
        message: reserved
          ? `${other.label ?? 'placement'} sits inside ${reserved.label ?? 'a reserved region'}`
          : `${a.label ?? a.id} overlaps ${b.label ?? b.id} over ${hit.w}x${hit.h} halfwords`,
        rect: hit,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Occupancy and free space
// ---------------------------------------------------------------------------

/**
 * Occupancy map over the whole of VRAM, one byte per halfword.
 *
 * 0 = free, 1 = occupied by exactly one placement, 2 = two or more overlap.
 * A full 512KB buffer, which is fine: it is allocated per query, not held.
 */
export function occupancyMap(placements: Placement[], height = VRAM_HEIGHT): Uint8Array {
  const map = new Uint8Array(VRAM_WIDTH * height);
  for (const p of placements) {
    const { x, y, w, h } = p.rect;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(VRAM_WIDTH, x + w);
    const y1 = Math.min(height, y + h);
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * VRAM_WIDTH;
      for (let xx = x0; xx < x1; xx++) {
        if (map[row + xx] < 2) map[row + xx]++;
      }
    }
  }
  return map;
}

export interface SpaceReport {
  totalHalfwords: number;
  usedHalfwords: number;
  overlappingHalfwords: number;
  freeHalfwords: number;
  /** Free fraction, 0..1. */
  freeFraction: number;
}

export function measureSpace(placements: Placement[], height = VRAM_HEIGHT): SpaceReport {
  const map = occupancyMap(placements, height);
  let used = 0;
  let overlapping = 0;
  for (let i = 0; i < map.length; i++) {
    if (map[i] > 0) used++;
    if (map[i] > 1) overlapping++;
  }
  const total = VRAM_WIDTH * height;
  return {
    totalHalfwords: total,
    usedHalfwords: used,
    overlappingHalfwords: overlapping,
    freeHalfwords: total - used,
    freeFraction: (total - used) / total,
  };
}

/**
 * Find the first free position for a rect of the given size, scanning in
 * reading order. `align` constrains the X step, so pass CLUT_X_ALIGN for a
 * CLUT and PAGE_WIDTH when a texture should land on a page origin.
 *
 * Returns undefined when nothing fits, which is a real answer and must not be
 * confused with an error.
 */
export function findFreeSpot(
  placements: Placement[],
  w: number,
  h: number,
  options: {
    alignX?: number;
    alignY?: number;
    fromBottom?: boolean;
    /**
     * Skip any Y where the rect would straddle the Y=256 texture-page
     * boundary. A straddling texture is legal but unusable as a single
     * texture page, so the auto-placer should not choose one when a clean
     * position exists.
     */
    avoidRowStraddle?: boolean;
    /** VRAM height to search within. 512 retail, 1024 with 2MB. */
    height?: number;
  } = {},
): { x: number; y: number } | undefined {
  const {
    alignX = 1,
    alignY = 1,
    fromBottom = false,
    avoidRowStraddle = false,
    height = VRAM_HEIGHT,
  } = options;
  const map = occupancyMap(placements, height);

  // Scanning up from the bottom is the right default for CLUTs: convention on
  // real PS1 projects parks them in the strip below the framebuffers, and a
  // reading-order scan instead drops them at y=0, squatting in prime texture
  // page space.
  const ys: number[] = [];
  for (let y = 0; y + h <= height; y += alignY) {
    if (
      avoidRowStraddle &&
      Math.floor(y / PAGE_HEIGHT) !== Math.floor((y + h - 1) / PAGE_HEIGHT)
    ) {
      continue;
    }
    ys.push(y);
  }
  if (fromBottom) ys.reverse();

  for (const y of ys) {
    scan: for (let x = 0; x + w <= VRAM_WIDTH; x += alignX) {
      for (let yy = y; yy < y + h; yy++) {
        const row = yy * VRAM_WIDTH;
        for (let xx = x; xx < x + w; xx++) {
          if (map[row + xx] !== 0) continue scan;
        }
      }
      return { x, y };
    }
  }
  return undefined;
}
