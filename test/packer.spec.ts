import { describe, it, expect } from 'vitest';
import {
  Packer,
  FlipMode,
  subtract,
  carve,
  area,
  overlaps,
  packedSize,
  positionIn,
  paddingRects,
  packObjects,
  packerOverFreeSpace,
  type Placeable,
  type Rect,
} from '../src/core/packer.js';
import {
  packProject,
  texelsPerHalfword,
  isPinned,
} from '../src/core/autopack.js';
import {
  emptyProject,
  createAsset,
  pixelRect,
  clutRect,
  validate,
  serializeProject,
  deserializeProject,
  projectPlacements,
  type Asset,
  type Project,
} from '../src/core/project.js';
import { TimType } from '../src/core/tim.js';
import { CLUT_X_ALIGN, PAGE_HEIGHT, VRAM_WIDTH } from '../src/core/vram.js';

function rgbaBlocks(w: number, h: number, colors: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = i % colors;
    out[i * 4] = (c * 37) & 0xff;
    out[i * 4 + 1] = (c * 91) & 0xff;
    out[i * 4 + 2] = (c * 143) & 0xff;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function addAsset(project: Project, name: string, w = 64, h = 64, colors = 8): Asset {
  const asset = createAsset(name, w, h, rgbaBlocks(w, h, colors), project);
  project.assets.push(asset);
  return asset;
}

const box = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** Every pair of rects in a list is disjoint. */
function allDisjoint(rects: Rect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (overlaps(rects[i], rects[j])) return false;
    }
  }
  return true;
}

describe('rect subtraction', () => {
  it('returns the space untouched when the hole misses it', () => {
    expect(subtract(box(0, 0, 10, 10), box(20, 20, 5, 5))).toEqual([box(0, 0, 10, 10)]);
  });

  it('returns nothing when the hole covers the space', () => {
    expect(subtract(box(2, 2, 4, 4), box(0, 0, 10, 10))).toEqual([]);
  });

  it('splits into disjoint pieces that conserve area', () => {
    const space = box(0, 0, 100, 50);
    const hole = box(20, 10, 30, 20);
    const parts = subtract(space, hole);
    expect(allDisjoint(parts)).toBe(true);
    const total = parts.reduce((n, r) => n + area(r), 0);
    expect(total).toBe(area(space) - area(hole));
    for (const p of parts) expect(overlaps(p, hole)).toBe(false);
  });

  it('carves several holes and leaves free space disjoint from all of them', () => {
    // Mutually disjoint on purpose - the area identity below only holds then,
    // and an overlapping trio double-counts the shared region.
    const holes = [box(0, 0, 64, 64), box(200, 100, 100, 100), box(64, 60, 20, 400)];
    expect(allDisjoint(holes)).toBe(true);
    const free = carve([box(0, 0, 1024, 512)], holes);
    expect(allDisjoint(free)).toBe(true);
    for (const f of free) for (const h of holes) expect(overlaps(f, h)).toBe(false);
    const covered = holes.reduce((n, r) => n + area(r), 0);
    // The holes here are mutually disjoint, so free area is exactly the rest.
    expect(free.reduce((n, r) => n + area(r), 0)).toBe(1024 * 512 - covered);
  });
});

describe('placeable sizing', () => {
  it('applies the width divider after the orientation swap, not before', () => {
    // 64 texels x 100 lines at 4bpp. Upright: 16 x 100 halfwords.
    // Sideways the RAW axes swap first, so it is 100 texels wide -> 25
    // halfwords, by 64 lines. Dividing before swapping would give 16x100
    // rotated to 100x16, which is a different and wrong rectangle.
    const o: Placeable = { key: 'a', width: 64, height: 100, widthDivider: 4 };
    expect(packedSize(o, false)).toEqual({ w: 16, h: 100 });
    expect(packedSize(o, true)).toEqual({ w: 25, h: 64 });
  });

  it('rounds a partial halfword up', () => {
    const o: Placeable = { key: 'a', width: 5, height: 1, widthDivider: 4 };
    expect(packedSize(o).w).toBe(2);
  });
});

describe('positioning inside a free rect', () => {
  it('refuses an object larger than the space', () => {
    expect(positionIn({ key: 'a', width: 20, height: 4 }, box(0, 0, 10, 10))).toBeUndefined();
  });

  it('honours alignment by padding from whichever edge costs less', () => {
    const clut: Placeable = { key: 'c', width: 16, height: 1, alignX: CLUT_X_ALIGN };
    const pos = positionIn(clut, box(5, 0, 60, 1));
    expect(pos).toBeDefined();
    expect(pos!.x % CLUT_X_ALIGN).toBe(0);
    expect(pos!.x).toBeGreaterThanOrEqual(5);
    expect(pos!.x + 16).toBeLessThanOrEqual(65);
  });

  it('refuses a straddling position when avoidRowStraddle is set, and allows it otherwise', () => {
    const space = box(0, PAGE_HEIGHT - 4, 64, 64);
    const straddler: Placeable = { key: 't', width: 64, height: 16, avoidRowStraddle: true };
    expect(positionIn(straddler, space)).toBeUndefined();
    // Same object, same space, flag off: this is the discriminator. Without
    // it the test would also pass if the object simply did not fit.
    expect(positionIn({ ...straddler, avoidRowStraddle: false }, space)).toBeDefined();
  });

  it('produces padding rects that are disjoint and exclude the object', () => {
    const o: Placeable = { key: 'a', width: 20, height: 10 };
    const space = box(0, 0, 100, 50);
    const pos = positionIn(o, space)!;
    const pads = paddingRects(o, space, pos);
    const occupied = box(pos.x, pos.y, 20, 10);
    expect(allDisjoint(pads)).toBe(true);
    for (const p of pads) expect(overlaps(p, occupied)).toBe(false);
    expect(pads.reduce((n, r) => n + area(r), 0)).toBe(area(space) - area(occupied));
  });
});

describe('packer', () => {
  const objs = (n: number, w: number, h: number): Placeable[] =>
    Array.from({ length: n }, (_, i) => ({ key: `o${i}`, width: w, height: h }));

  it('places everything that fits, without overlaps', () => {
    const p = new Packer(256, 256);
    const r = packObjects(p, objs(16, 64, 64));
    expect(r.unplaced).toHaveLength(0);
    expect(r.placements).toHaveLength(16);
    const rects = r.placements.map((pl) => box(pl.x, pl.y, 64, 64));
    expect(allDisjoint(rects)).toBe(true);
    for (const rc of rects) {
      expect(rc.x).toBeGreaterThanOrEqual(0);
      expect(rc.y).toBeGreaterThanOrEqual(0);
      expect(rc.x + rc.w).toBeLessThanOrEqual(256);
      expect(rc.y + rc.h).toBeLessThanOrEqual(256);
    }
  });

  it('reports what does not fit instead of dropping or overlapping it', () => {
    const p = new Packer(128, 128);
    const r = packObjects(p, objs(5, 64, 64));
    expect(r.placements).toHaveLength(4);
    expect(r.unplaced).toHaveLength(1);
    expect(allDisjoint(r.placements.map((pl) => box(pl.x, pl.y, 64, 64)))).toBe(true);
  });

  it('two objects do not hang it - the upstream bin-collapse case', () => {
    // The upstream hang lives in vram.py's buildVRAMPages, which is not
    // ported. This is the shape that triggered it: a 3-unit span placed
    // first, then a 4-unit one that cannot fit what is left.
    const p = new Packer(4, 4);
    const r = packObjects(p, [
      { key: 'three', width: 3, height: 4 },
      { key: 'four', width: 4, height: 4 },
    ]);
    expect(r.placements.length + r.unplaced.length).toBe(2);
    expect(r.unplaced.map((o) => o.key)).toEqual(['three']);
  });

  it('respects space already carved out', () => {
    const p = packerOverFreeSpace([box(0, 0, 64, 512)], 128, 512);
    const r = packObjects(p, objs(1, 64, 64));
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0].x).toBeGreaterThanOrEqual(64);
  });

  it('uses sideways placement only when the flip mode allows it', () => {
    const tall: Placeable = { key: 't', width: 10, height: 40 };
    const wideSpace = new Packer(40, 10);
    expect(packObjects(wideSpace, [tall]).unplaced).toHaveLength(1);

    const flip = new Packer(40, 10);
    const r = packObjects(flip, [{ ...tall, flipMode: FlipMode.AllowSideways }]);
    expect(r.unplaced).toHaveLength(0);
    expect(r.placements[0].sideways).toBe(true);
  });
});

describe('packProject', () => {
  it('leaves a locked asset where it is while moving an unlocked one', () => {
    const p = emptyProject();
    const locked = addAsset(p, 'locked', 64, 64);
    const free = addAsset(p, 'free', 64, 64);
    locked.locked = true;
    locked.x = 512;
    locked.y = 300;
    free.x = 900;
    free.y = 400;

    const report = packProject(p);
    expect(locked.x).toBe(512);
    expect(locked.y).toBe(300);
    expect(report.pinned).toContain('locked');
    // Discriminator: a packer that moved nothing would also leave the locked
    // one alone, so assert the other asset actually went somewhere else.
    expect([free.x, free.y]).not.toEqual([900, 400]);
  });

  it('leaves an excluded asset where it is even though it is not locked', () => {
    const p = emptyProject();
    const excluded = addAsset(p, 'excluded', 64, 64);
    const free = addAsset(p, 'free', 64, 64);
    excluded.excludeFromPacking = true;
    expect(excluded.locked).toBeUndefined();
    excluded.x = 512;
    excluded.y = 300;
    free.x = 900;
    free.y = 400;

    packProject(p);
    expect(excluded.x).toBe(512);
    expect(excluded.y).toBe(300);
    expect([free.x, free.y]).not.toEqual([900, 400]);
  });

  it('treats the two flags as independent', () => {
    const a = { locked: true } as Asset;
    const b = { excludeFromPacking: true } as Asset;
    const c = {} as Asset;
    expect(isPinned(a)).toBe(true);
    expect(isPinned(b)).toBe(true);
    expect(isPinned(c)).toBe(false);
  });

  it('round-trips excludeFromPacking through the project file, separately from locked', () => {
    const p = emptyProject();
    const a = addAsset(p, 'tex', 32, 32);
    a.excludeFromPacking = true;
    const back = deserializeProject(serializeProject(p)).project;
    expect(back.assets[0].excludeFromPacking).toBe(true);
    expect(back.assets[0].locked).toBeUndefined();
  });

  it('only moves the selection when one is given', () => {
    const p = emptyProject();
    const a = addAsset(p, 'a', 64, 64);
    const b = addAsset(p, 'b', 64, 64);
    b.x = 900;
    b.y = 400;
    const before = { x: b.x, y: b.y };

    packProject(p, { ids: [a.id] });
    expect(b.x).toBe(before.x);
    expect(b.y).toBe(before.y);
  });

  it('produces a layout with no overlap or alignment errors', () => {
    const p = emptyProject();
    for (let i = 0; i < 12; i++) addAsset(p, `t${i}`, 64 + i * 8, 48 + i * 4, 8);
    packProject(p);
    const errors = validate(p).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('keeps CLUTs on a 16-halfword boundary', () => {
    const p = emptyProject();
    for (let i = 0; i < 6; i++) addAsset(p, `t${i}`, 64, 64, 8);
    packProject(p);
    for (const a of p.assets) {
      const c = clutRect(a);
      if (c) expect(c.x % CLUT_X_ALIGN).toBe(0);
    }
  });

  it('keeps textures out of a keepout', () => {
    const p = emptyProject();
    p.keepouts.push({ id: 'fb', name: 'framebuffer', x: 0, y: 0, w: 320, h: 240 });
    for (let i = 0; i < 8; i++) addAsset(p, `t${i}`, 64, 64, 8);
    packProject(p);
    for (const a of p.assets) {
      const r = pixelRect(a);
      expect(r.x + r.w <= 0 || r.x >= 320 || r.y + r.h <= 0 || r.y >= 240).toBe(true);
    }
  });

  it('does not straddle the Y=256 page boundary', () => {
    const p = emptyProject();
    for (let i = 0; i < 10; i++) addAsset(p, `t${i}`, 128, 100, 8);
    packProject(p);
    for (const a of p.assets) {
      const r = pixelRect(a);
      expect(Math.floor(r.y / PAGE_HEIGHT)).toBe(Math.floor((r.y + r.h - 1) / PAGE_HEIGHT));
    }
  });

  it('reports assets that did not fit rather than stacking them at the origin', () => {
    const p = emptyProject();
    // Fill the canvas with keepouts so nothing can be placed.
    p.keepouts.push({ id: 'k', name: 'all', x: 0, y: 0, w: VRAM_WIDTH, h: 512 });
    const a = addAsset(p, 'homeless', 64, 64);
    a.x = 700;
    a.y = 300;
    const report = packProject(p);
    expect(report.unplaced).toContain('homeless');
    expect(a.x).toBe(700);
    expect(a.y).toBe(300);
  });

  it('counts halfwords the same before and after when nothing can move', () => {
    const p = emptyProject();
    const a = addAsset(p, 'pinned', 64, 64);
    a.locked = true;
    const report = packProject(p);
    expect(report.usedHalfwordsAfter).toBe(report.usedHalfwordsBefore);
  });

  it('maps depth to the right texel divider', () => {
    expect(texelsPerHalfword(TimType.Bpp4)).toBe(4);
    expect(texelsPerHalfword(TimType.Bpp8)).toBe(2);
    expect(texelsPerHalfword(TimType.Bpp16)).toBe(1);
  });

  it('sizes a packed texture the same way pixelRect does', () => {
    const p = emptyProject();
    const a = addAsset(p, 'odd', 130, 33, 8);
    packProject(p);
    const r = pixelRect(a);
    const placements = projectPlacements(p).filter((pl) => pl.id === `tex:${a.id}`);
    expect(placements).toHaveLength(1);
    expect(placements[0].rect).toEqual(r);
  });
});
