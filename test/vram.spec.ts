import { describe, it, expect } from 'vitest';
import { TimType } from '../src/core/tim.js';
import {
  VRAM_WIDTH,
  VRAM_HEIGHT,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  CLUT_X_ALIGN,
  rectsOverlap,
  intersection,
  pageTexelWidth,
  pageIndexAt,
  pagesSpanned,
  isPageAligned,
  checkPlacement,
  checkLayout,
  measureSpace,
  findFreeSpot,
  type Placement,
} from '../src/core/vram.js';
import {
  chooseDepth,
  depthCandidates,
  crossover16vs8,
  CLUT_WORDS,
} from '../src/core/depth.js';

const tex = (id: string, x: number, y: number, w: number, h: number, type = TimType.Bpp8): Placement => ({
  id,
  kind: 'texture',
  rect: { x, y, w, h },
  type,
  label: id,
});
const clut = (id: string, x: number, y: number, w = 16): Placement => ({
  id,
  kind: 'clut',
  rect: { x, y, w, h: 1 },
  label: id,
});

describe('VRAM geometry', () => {
  it('is 1024x512 halfwords, 16x2 texture pages', () => {
    expect(VRAM_WIDTH).toBe(1024);
    expect(VRAM_HEIGHT).toBe(512);
    expect(VRAM_WIDTH / PAGE_WIDTH).toBe(16);
    expect(VRAM_HEIGHT / PAGE_HEIGHT).toBe(2);
  });

  it('a page holds 256 texels at 4bpp, 128 at 8bpp, 64 at 16bpp', () => {
    expect(pageTexelWidth(TimType.Bpp4)).toBe(256);
    expect(pageTexelWidth(TimType.Bpp8)).toBe(128);
    expect(pageTexelWidth(TimType.Bpp16)).toBe(64);
  });

  it('locates a coordinate in the 32-page grid', () => {
    expect(pageIndexAt(0, 0)).toBe(0);
    expect(pageIndexAt(63, 255)).toBe(0);
    expect(pageIndexAt(64, 0)).toBe(1);
    expect(pageIndexAt(0, 256)).toBe(16);
    expect(pageIndexAt(1023, 511)).toBe(31);
    expect(pageIndexAt(1024, 0)).toBe(-1);
  });

  it('counts pages spanned horizontally', () => {
    expect(pagesSpanned({ x: 0, y: 0, w: 64, h: 1 })).toBe(1);
    expect(pagesSpanned({ x: 0, y: 0, w: 65, h: 1 })).toBe(2);
    expect(pagesSpanned({ x: 63, y: 0, w: 2, h: 1 })).toBe(2);
    // A 256-entry CLUT is 256 halfwords wide: four pages.
    expect(pagesSpanned({ x: 0, y: 0, w: 256, h: 1 })).toBe(4);
  });

  it('recognises page-origin alignment', () => {
    expect(isPageAligned({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(isPageAligned({ x: 64, y: 256, w: 1, h: 1 })).toBe(true);
    expect(isPageAligned({ x: 32, y: 0, w: 1, h: 1 })).toBe(false);
    expect(isPageAligned({ x: 0, y: 128, w: 1, h: 1 })).toBe(false);
  });
});

describe('rect maths', () => {
  it('detects overlap and computes the intersection', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 5, y: 5, w: 10, h: 10 };
    expect(rectsOverlap(a, b)).toBe(true);
    expect(intersection(a, b)).toEqual({ x: 5, y: 5, w: 5, h: 5 });
  });

  it('treats edge-touching as disjoint, not overlapping', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 10, y: 0, w: 10, h: 10 };
    expect(rectsOverlap(a, b)).toBe(false);
    expect(intersection(a, b)).toBeUndefined();
  });
});

describe('placement constraints', () => {
  it('accepts a legal CLUT and rejects a misaligned one', () => {
    expect(checkPlacement(clut('ok', 16, 480))).toEqual([]);
    const issues = checkPlacement(clut('bad', 20, 480));
    expect(issues.map((i) => i.code)).toContain('clut-misaligned');
  });

  it('accepts every multiple of 16 as a CLUT X', () => {
    for (let x = 0; x < 1024; x += CLUT_X_ALIGN) {
      expect(checkPlacement(clut(`c${x}`, x, 500))).toEqual([]);
    }
  });

  it('flags a texture straddling the Y=256 page boundary', () => {
    const issues = checkPlacement(tex('t', 0, 200, 64, 100));
    expect(issues.map((i) => i.code)).toContain('crosses-page-row');
  });

  it('does not flag a texture that sits inside one page row', () => {
    expect(checkPlacement(tex('t', 0, 0, 64, 256))).toEqual([]);
    expect(checkPlacement(tex('t', 0, 256, 64, 256))).toEqual([]);
  });

  it('flags a texture wider than the 8-bit U range', () => {
    // 8bpp: 129 halfwords = 258 texels, past 256.
    const issues = checkPlacement(tex('wide', 0, 0, 129, 4, TimType.Bpp8));
    expect(issues.map((i) => i.code)).toContain('exceeds-uv-range');
    // 128 halfwords = exactly 256 texels, which is fine.
    expect(
      checkPlacement(tex('ok', 0, 0, 128, 4, TimType.Bpp8)).map((i) => i.code),
    ).not.toContain('exceeds-uv-range');
  });

  it('flags anything outside VRAM', () => {
    const issues = checkPlacement(tex('oob', 1000, 0, 64, 4));
    expect(issues.map((i) => i.code)).toContain('out-of-bounds');
  });
});

describe('layout checking', () => {
  it('reports an overlap once, with the overlapping region', () => {
    const issues = checkLayout([tex('a', 0, 0, 64, 64), tex('b', 32, 32, 64, 64)]);
    const overlaps = issues.filter((i) => i.code === 'overlap');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].ids.sort()).toEqual(['a', 'b']);
    expect(overlaps[0].rect).toEqual({ x: 32, y: 32, w: 32, h: 32 });
  });

  it('diagnoses a collision with a reserved region specifically', () => {
    const keepout: Placement = {
      id: 'keepout:fb0',
      kind: 'keepout',
      rect: { x: 0, y: 0, w: 320, h: 240 },
      label: 'framebuffer 0',
    };
    const issues = checkLayout([keepout, tex('t', 100, 100, 64, 64)]);
    expect(issues.map((i) => i.code)).toContain('in-keepout');
    expect(issues.map((i) => i.code)).not.toContain('overlap');
    expect(issues[0].message).toMatch(/framebuffer 0/);
  });

  it('finds nothing wrong with a clean layout', () => {
    // Textures in page 8 onward, CLUTs in the strip below a 320x240 double buffer.
    expect(
      checkLayout([
        { id: 'keepout:fb0', kind: 'keepout' as const, rect: { x: 0, y: 0, w: 320, h: 240 } },
        { id: 'keepout:fb1', kind: 'keepout' as const, rect: { x: 320, y: 0, w: 320, h: 240 } },
        tex('t0', 640, 0, 64, 256),
        tex('t1', 704, 0, 64, 256),
        clut('c0', 0, 480),
        clut('c1', 16, 480),
      ]),
    ).toEqual([]);
  });
});

describe('space accounting', () => {
  it('counts used, free and doubly-occupied halfwords', () => {
    const report = measureSpace([tex('a', 0, 0, 10, 10), tex('b', 5, 5, 10, 10)]);
    expect(report.totalHalfwords).toBe(1024 * 512);
    expect(report.overlappingHalfwords).toBe(25);
    expect(report.usedHalfwords).toBe(100 + 100 - 25);
    expect(report.freeHalfwords).toBe(report.totalHalfwords - report.usedHalfwords);
  });

  it('reports an empty layout as entirely free', () => {
    expect(measureSpace([]).freeFraction).toBe(1);
  });
});

describe('free space search', () => {
  it('finds the origin when VRAM is empty', () => {
    expect(findFreeSpot([], 64, 64)).toEqual({ x: 0, y: 0 });
  });

  it('honours an X alignment', () => {
    const spot = findFreeSpot([tex('a', 0, 0, 20, 1024 > 0 ? 512 : 1)], 16, 1, {
      alignX: CLUT_X_ALIGN,
    });
    expect(spot!.x % CLUT_X_ALIGN).toBe(0);
    expect(spot!.x).toBeGreaterThanOrEqual(20);
  });

  it('returns undefined when nothing fits, which is a result and not an error', () => {
    const full: Placement = {
      id: 'all',
      kind: 'texture',
      rect: { x: 0, y: 0, w: VRAM_WIDTH, h: VRAM_HEIGHT },
    };
    expect(findFreeSpot([full], 1, 1)).toBeUndefined();
  });
});

describe('depth cost model', () => {
  it('prices each depth as texture words plus penalised CLUT words', () => {
    const c = depthCandidates(64, 64, { clutPenalty: 1 });
    const by = Object.fromEntries(c.map((x) => [x.type, x]));
    expect(by[TimType.Bpp4].textureWords).toBe(16 * 64);
    expect(by[TimType.Bpp8].textureWords).toBe(32 * 64);
    expect(by[TimType.Bpp16].textureWords).toBe(64 * 64);
    expect(by[TimType.Bpp16].clutWords).toBe(0);
    expect(by[TimType.Bpp8].clutWords).toBe(CLUT_WORDS[TimType.Bpp8]);
  });

  it('puts the 16bpp/8bpp crossover at 512 texels, as the Live2D pipeline measured', () => {
    expect(crossover16vs8(1)).toBe(512);
    // Just under: 16bpp wins because the 256-word CLUT is not worth it.
    const small = chooseDepth(16, 16, { clutPenalty: 1, allow: [TimType.Bpp8, TimType.Bpp16] });
    expect(small.best.type).toBe(TimType.Bpp16);
    // Well over: 8bpp wins.
    const big = chooseDepth(64, 64, { clutPenalty: 1, allow: [TimType.Bpp8, TimType.Bpp16] });
    expect(big.best.type).toBe(TimType.Bpp8);
  });

  it('raising clutPenalty pushes marginal images to 16bpp', () => {
    const opts = { allow: [TimType.Bpp8, TimType.Bpp16] as const };
    const at1 = chooseDepth(32, 32, { ...opts, allow: [...opts.allow], clutPenalty: 1 });
    const at8 = chooseDepth(32, 32, { ...opts, allow: [...opts.allow], clutPenalty: 8 });
    expect(at1.best.type).toBe(TimType.Bpp8);
    expect(at8.best.type).toBe(TimType.Bpp16);
  });

  it('rejects an indexed depth that misses the quality floor', () => {
    const choice = chooseDepth(128, 128, {
      qualityFloor: 50,
      quality: { [TimType.Bpp4]: 30, [TimType.Bpp8]: 80 },
    });
    expect(choice.best.type).toBe(TimType.Bpp8);
    const four = choice.candidates.find((c) => c.type === TimType.Bpp4)!;
    expect(four.admissible).toBe(false);
    expect(four.rejection).toMatch(/below the floor/);
  });

  it('falls back to 16bpp when every indexed depth fails the floor', () => {
    const choice = chooseDepth(128, 128, {
      qualityFloor: 90,
      quality: { [TimType.Bpp4]: 10, [TimType.Bpp8]: 20 },
    });
    expect(choice.best.type).toBe(TimType.Bpp16);
  });

  it('treats a palette-sized colour count as lossless without asking the quantizer', () => {
    const choice = chooseDepth(128, 128, { qualityFloor: 99, distinctColors: 200 });
    expect(choice.best.type).toBe(TimType.Bpp8);
    const eight = choice.candidates.find((c) => c.type === TimType.Bpp8)!;
    expect(eight.quality).toBe(100);
  });

  it('says so when it decided on cost alone', () => {
    expect(chooseDepth(128, 128, {}).costOnly).toBe(true);
    expect(
      chooseDepth(128, 128, { quality: { [TimType.Bpp8]: 70 } }).costOnly,
    ).toBe(false);
  });

  it('refuses to certify an unmeasured depth against a floor', () => {
    // Without this, cost alone hands a 200-colour image to 4bpp because nobody
    // graded it. A floor asks for a guarantee; unmeasured cannot give one.
    const choice = chooseDepth(128, 128, { qualityFloor: 50 });
    const eight = choice.candidates.find((c) => c.type === TimType.Bpp8)!;
    expect(eight.admissible).toBe(false);
    expect(eight.rejection).toMatch(/unmeasured/);
    expect(choice.best.type).toBe(TimType.Bpp16);
  });

  it('with no floor at all, cost alone decides and nothing is rejected', () => {
    const choice = chooseDepth(128, 128, {});
    expect(choice.candidates.every((c) => c.admissible)).toBe(true);
    expect(choice.best.type).toBe(TimType.Bpp4);
  });
});

describe('page-row-aware placement', () => {
  it('skips positions where a rect would straddle the Y=256 boundary', () => {
    // Occupy y=0..255 across the whole width so the only free space is the
    // lower page row. A 256-tall rect must land at exactly 256, not at 1.
    const blocker: Placement = {
      id: 'top', kind: 'texture', rect: { x: 0, y: 0, w: VRAM_WIDTH, h: 1 },
    };
    const spot = findFreeSpot([blocker], 64, 256, { avoidRowStraddle: true });
    expect(spot).toEqual({ x: 0, y: 256 });

    // Without the flag it settles for the first fit, which straddles.
    const sloppy = findFreeSpot([blocker], 64, 256, {});
    expect(sloppy).toEqual({ x: 0, y: 1 });
    expect(Math.floor(sloppy!.y / PAGE_HEIGHT)).not.toBe(
      Math.floor((sloppy!.y + 256 - 1) / PAGE_HEIGHT),
    );
  });

  it('returns undefined rather than straddling when no clean spot exists', () => {
    const blockers: Placement[] = [
      { id: 'a', kind: 'texture', rect: { x: 0, y: 0, w: VRAM_WIDTH, h: 1 } },
      { id: 'b', kind: 'texture', rect: { x: 0, y: 256, w: VRAM_WIDTH, h: 1 } },
    ];
    expect(findFreeSpot(blockers, 64, 256, { avoidRowStraddle: true })).toBeUndefined();
  });
});
