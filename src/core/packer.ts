/**
 * Automatic VRAM placement.
 *
 * A port of the free-rectangle placer from the PS1 Live2D pipeline
 * (`pylive2d/repack/packer.py`, spicyjpeg), itself loosely based on
 * rectpack2D but modified for per-object alignment requirements and
 * orientation-dependent size dividers. Two pieces are COPIED rather than
 * re-derived, both flagged as such by their author: the disjoint four-way
 * split geometry, and the triple-XOR that picks which split orientation
 * wastes least.
 *
 * What is deliberately NOT ported: the relocatable-atlas machinery in
 * `vram.py` - page groups, the split cascade, `bake()`, and the adaptive
 * size search. That exists because the Live2D loader drops each column group
 * at an arbitrary VRAM address. This tool places into absolute VRAM at a
 * fixed canvas with the occupied regions already known, so the size search
 * has nothing to search and the groups have nothing to relocate.
 *
 * The three defects measured in that pipeline on 2026-08-23 all live in
 * `vram.py` (`_sortByNumColumns` bin labelling, the `ceil(log2)` bin
 * collapse that hangs `buildVRAMPages`, and the dead `straddles` check).
 * None of them is on this port's surface.
 *
 * Units are VRAM HALFWORDS throughout, matching `vram.ts`. Object sizes go in
 * as RAW TEXELS with a divider, and the divider is applied AFTER any
 * orientation swap - that ordering is the whole point of the contract, and
 * getting it backwards silently mis-sizes every non-16bpp object.
 */

import {
  VRAM_WIDTH,
  VRAM_HEIGHT,
  PAGE_HEIGHT,
  type VramRect,
} from './vram.js';

// ---------------------------------------------------------------------------
// Rectangles
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const right = (r: Rect): number => r.x + r.w;
export const bottom = (r: Rect): number => r.y + r.h;
export const area = (r: Rect): number => r.w * r.h;

/** A rect from two corners, or undefined when it would be empty or negative. */
export function fromVertices(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Rect | undefined {
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
}

/** Split `space` around `hole`, yielding up to four disjoint leftovers. */
export function subtract(space: Rect, hole: Rect): Rect[] {
  if (!overlaps(space, hole)) return [space];

  const cut: Rect = {
    x: Math.max(space.x, hole.x),
    y: Math.max(space.y, hole.y),
    w: 0,
    h: 0,
  };
  cut.w = Math.min(right(space), right(hole)) - cut.x;
  cut.h = Math.min(bottom(space), bottom(hole)) - cut.y;

  const out: Rect[] = [];
  const push = (r: Rect | undefined) => {
    if (r) out.push(r);
  };
  // Left and right full-height strips, then top and bottom between them, so
  // the four pieces stay disjoint.
  push(fromVertices(space.x, space.y, cut.x, bottom(space)));
  push(fromVertices(right(cut), space.y, right(space), bottom(space)));
  push(fromVertices(cut.x, space.y, right(cut), cut.y));
  push(fromVertices(cut.x, bottom(cut), right(cut), bottom(space)));
  return out;
}

/**
 * Remove every occupied rect from a starting space list.
 *
 * Used to seed the packer with what is actually free: the canvas minus
 * keepouts, minus locked assets, minus anything excluded from packing.
 */
export function carve(spaces: Rect[], holes: Iterable<Rect>): Rect[] {
  let out = spaces;
  for (const hole of holes) {
    const next: Rect[] = [];
    for (const space of out) next.push(...subtract(space, hole));
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Placeable objects
// ---------------------------------------------------------------------------

export enum FlipMode {
  None = 0,
  AllowSideways = 1,
  PreferSideways = 2,
}

export interface Placeable {
  /** Caller's handle. The packer never interprets it. */
  key: string;
  /** RAW size before the divider. Texels for a texture, entries for a CLUT. */
  width: number;
  height: number;
  /** Raw units per halfword. 4 at 4bpp, 2 at 8bpp, 1 at 16bpp and for CLUTs. */
  widthDivider?: number;
  heightDivider?: number;
  alignX?: number;
  alignY?: number;
  flipMode?: FlipMode;
  /**
   * Refuse any position where the object would cross a Y=256 texture-page
   * boundary. Legal in the file format, unusable as a single texture page.
   */
  avoidRowStraddle?: boolean;
}

const divX = (o: Placeable): number => o.widthDivider ?? 1;
const divY = (o: Placeable): number => o.heightDivider ?? 1;
const alX = (o: Placeable): number => o.alignX ?? 1;
const alY = (o: Placeable): number => o.alignY ?? 1;

export function validOrientations(o: Placeable): boolean[] {
  switch (o.flipMode ?? FlipMode.None) {
    case FlipMode.AllowSideways:
      return [false, true];
    case FlipMode.PreferSideways:
      return [true, false];
    default:
      return [false];
  }
}

/** Size in halfwords. The divider is applied AFTER the orientation swap. */
export function packedSize(
  o: Placeable,
  sideways = false,
): { w: number; h: number } {
  const rawW = sideways ? o.height : o.width;
  const rawH = sideways ? o.width : o.height;
  return {
    w: Math.ceil(rawW / divX(o)),
    h: Math.ceil(rawH / divY(o)),
  };
}

// ---------------------------------------------------------------------------
// Placement into a single free rect
// ---------------------------------------------------------------------------

export interface Placement {
  obj: Placeable;
  x: number;
  y: number;
  sideways: boolean;
}

export function placementRect(p: Placement): Rect {
  const { w, h } = packedSize(p.obj, p.sideways);
  return { x: p.x, y: p.y, w, h };
}

interface Position {
  x: number;
  y: number;
  /** Which of the four-way splits wastes least, per the triple-XOR below. */
  altSplit: boolean;
}

/**
 * Where in `space` this object lands, or undefined when it does not fit.
 *
 * Chooses the left or right edge depending on which needs less alignment
 * padding, and likewise top or bottom. COPIED from the upstream author, whose
 * comment reads: "Some doodling and boolean algebra reveals that the alternate
 * split is most efficient (i.e. minimizes the area of all splits but one) when
 * either one or all of the following conditions are met: the placeable was
 * placed on the right side; the placeable was placed on the bottom side; the
 * placeable's aspect ratio is vertical."
 */
export function positionIn(
  o: Placeable,
  space: Rect,
  sideways = false,
  nonIdealSplit = false,
): Position | undefined {
  const { w, h } = packedSize(o, sideways);
  const rightX = right(space) - w;
  const bottomY = bottom(space) - h;
  if (rightX < space.x || bottomY < space.y) return undefined;

  const modLeft = space.x % alX(o);
  const padLeft = modLeft ? alX(o) - modLeft : 0;
  const padRight = rightX % alX(o);

  const modTop = space.y % alY(o);
  const padTop = modTop ? alY(o) - modTop : 0;
  const padBottom = bottomY % alY(o);

  const onRight = padRight < padLeft;
  const onBottom = padBottom < padTop;
  const vertical = h > w;

  const x = onRight ? rightX - padRight : space.x + padLeft;
  const y = onBottom ? bottomY - padBottom : space.y + padTop;

  if (x < space.x || y < space.y || x + w > right(space) || y + h > bottom(space)) {
    return undefined;
  }
  if (x < 0 || y < 0) return undefined;
  if (o.avoidRowStraddle) {
    if (Math.floor(y / PAGE_HEIGHT) !== Math.floor((y + h - 1) / PAGE_HEIGHT)) {
      return undefined;
    }
  }

  const altSplit = ((onRight !== onBottom) !== vertical) !== nonIdealSplit;
  return { x, y, altSplit };
}

/** The up-to-four leftovers of `space` once the object sits at (x, y). */
export function paddingRects(
  o: Placeable,
  space: Rect,
  pos: Position,
  sideways = false,
  minPadSize = 1,
): Rect[] {
  const { w, h } = packedSize(o, sideways);

  const x0 = space.x;
  const y0 = space.y;
  const x1 = pos.x;
  const y1 = pos.y;
  const x2 = x1 + w;
  const y2 = y1 + h;
  const x3 = right(space);
  const y3 = bottom(space);

  const padLeft = x1 - x0;
  const padTop = y1 - y0;
  const padRight = x3 - x2;
  const padBottom = y3 - y2;

  const out: Rect[] = [];
  const push = (r: Rect | undefined) => {
    if (r) out.push(r);
  };

  //  +-------------------+    +-------------------+
  //  |       T       |   |    |   |       T       |
  //  |---+-----------+   |    |   +-----------+---|
  //  |   | Placeable | R |    | L | Placeable |   |
  //  | L |           |   |    |   |           | R |
  //  |   +-----------+---|    |---+-----------+   |
  //  |   |       B       |    |       B       |   |
  //  +-------------------+    +-------------------+
  //     altSplit = false          altSplit = true
  if (pos.altSplit) {
    if (padLeft >= minPadSize) push(fromVertices(x0, y0, x1, y2));
    if (padTop >= minPadSize) push(fromVertices(x1, y0, x3, y1));
    if (padRight >= minPadSize) push(fromVertices(x2, y1, x3, y3));
    if (padBottom >= minPadSize) push(fromVertices(x0, y2, x2, y3));
  } else {
    if (padLeft >= minPadSize) push(fromVertices(x0, y1, x1, y3));
    if (padTop >= minPadSize) push(fromVertices(x0, y0, x2, y1));
    if (padRight >= minPadSize) push(fromVertices(x2, y0, x3, y2));
    if (padBottom >= minPadSize) push(fromVertices(x1, y2, x3, y3));
  }
  return out;
}

/** Space wasted by alignment padding if this object goes in this rect. */
function paddedArea(o: Placeable, space: Rect, pos: Position, sideways: boolean): number {
  const { w, h } = packedSize(o, sideways);
  return (pos.x - space.x + w) * (pos.y - space.y + h);
}

// ---------------------------------------------------------------------------
// Packer
// ---------------------------------------------------------------------------

export interface PackerOptions {
  nonIdealSplit?: boolean;
  /** Leftovers narrower than this are dropped rather than tracked. */
  minPadSize?: number;
}

export class Packer {
  placements: Placement[] = [];
  emptySpaces: Rect[];
  /** Area consumed, counting alignment padding. Not the same as object area. */
  usedArea = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    spaces?: Rect[],
  ) {
    this.emptySpaces = spaces ? spaces.map((r) => ({ ...r })) : [{ x: 0, y: 0, w: width, h: height }];
  }

  clone(): Packer {
    const p = new Packer(this.width, this.height, this.emptySpaces);
    p.placements = this.placements.slice();
    p.usedArea = this.usedArea;
    return p;
  }

  get packingRatio(): number {
    return this.usedArea / (this.width * this.height);
  }

  /**
   * Place one object in the smallest space that fits it.
   *
   * Unlike upstream, the candidate position is computed and validated BEFORE
   * scoring rather than after selection. Upstream can afford the shortcut
   * because a relocatable atlas has no absolute constraints; here an object
   * can be rejected for straddling a page row, so a space that scores best on
   * area may be unusable and the search has to know that while searching.
   */
  place(obj: Placeable, options: PackerOptions = {}): Placement | undefined {
    const { nonIdealSplit = false, minPadSize = 1 } = options;

    let bestArea = Infinity;
    let bestIndex: number | undefined;
    let bestSideways = false;
    let bestPos: Position | undefined;

    for (let i = 0; i < this.emptySpaces.length; i++) {
      const space = this.emptySpaces[i];
      for (const sideways of validOrientations(obj)) {
        const pos = positionIn(obj, space, sideways, nonIdealSplit);
        if (!pos) continue;
        const cost = paddedArea(obj, space, pos, sideways);
        if (cost < bestArea) {
          bestArea = cost;
          bestIndex = i;
          bestSideways = sideways;
          bestPos = pos;
        }
      }
    }

    if (bestIndex === undefined || !bestPos) return undefined;

    const space = this.emptySpaces.splice(bestIndex, 1)[0];
    const placement: Placement = {
      obj,
      x: bestPos.x,
      y: bestPos.y,
      sideways: bestSideways,
    };
    this.placements.push(placement);

    this.usedArea += area(space);
    for (const rect of paddingRects(obj, space, bestPos, bestSideways, minPadSize)) {
      this.emptySpaces.push(rect);
      this.usedArea -= area(rect);
    }
    return placement;
  }
}

/** Sort keys tried against each other. Best result by consumed area wins. */
export const SORT_ORDERS: Record<string, (o: Placeable) => number> = {
  area: (o) => o.width * o.height,
  perim: (o) => (o.width + o.height) * 2,
  side: (o) => Math.max(o.width, o.height),
  width: (o) => o.width,
  height: (o) => o.height,
};

export interface PackResult {
  placements: Placement[];
  unplaced: Placeable[];
  usedArea: number;
  /** Which sort order won, for the report. */
  order: string;
}

/**
 * Pack a set of objects into the free space of a packer.
 *
 * Tries every sort order and keeps whichever consumed the most area, which is
 * upstream's heuristic and the reason a single-pass sort is not good enough.
 */
export function packObjects(
  base: Packer,
  objects: Placeable[],
  options: PackerOptions = {},
): PackResult {
  let best: PackResult | undefined;
  let bestPacker: Packer | undefined;

  for (const [name, key] of Object.entries(SORT_ORDERS)) {
    const packer = base.clone();
    const sorted = objects.slice().sort((a, b) => key(b) - key(a));
    const unplaced: Placeable[] = [];

    for (const obj of sorted) {
      if (!packer.place(obj, options)) unplaced.push(obj);
    }

    // Placing MORE objects beats consuming more area. Upstream scores on area
    // alone because it can grow the atlas; here the canvas is fixed and an
    // unplaced object is a failure the user has to resolve by hand.
    const better =
      !best ||
      packer.placements.length > best.placements.length ||
      (packer.placements.length === best.placements.length &&
        packer.usedArea > best.usedArea);

    if (better) {
      best = {
        placements: packer.placements.slice(),
        unplaced,
        usedArea: packer.usedArea,
        order: name,
      };
      bestPacker = packer;
    }
  }

  if (best && bestPacker) {
    base.placements = bestPacker.placements;
    base.emptySpaces = bestPacker.emptySpaces;
    base.usedArea = bestPacker.usedArea;
    return best;
  }
  return { placements: [], unplaced: objects.slice(), usedArea: 0, order: 'area' };
}

/** A packer over `width` x `height` with the given regions already taken. */
export function packerOverFreeSpace(
  occupied: Iterable<Rect>,
  width = VRAM_WIDTH,
  height = VRAM_HEIGHT,
): Packer {
  const spaces = carve([{ x: 0, y: 0, w: width, h: height }], occupied);
  const packer = new Packer(width, height, spaces);
  // Everything carved out is consumed by definition, so the ratio reported
  // afterwards describes the whole canvas rather than only the packed part.
  packer.usedArea = width * height - spaces.reduce((n, r) => n + area(r), 0);
  return packer;
}

export const toVramRect = (r: Rect): VramRect => ({ x: r.x, y: r.y, w: r.w, h: r.h });
