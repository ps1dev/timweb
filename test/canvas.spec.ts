/**
 * Canvas interaction logic. Pure functions only - the rendering is verified by
 * the browser end-to-end test, but hit-test ordering is exact logic and
 * deserves a test that does not depend on replicating the app's own view
 * transform in the harness.
 */

import { describe, it, expect } from 'vitest';
import { hitTest, snapPosition, defaultGridFor, toVram, toScreen, fitView } from '../src/ui/canvas.js';
import { CLUT_X_ALIGN, VRAM_WIDTH, VRAM_HEIGHT, type Placement } from '../src/core/vram.js';
import { TimType } from '../src/core/tim.js';

const fb: Placement = {
  id: 'keepout:fb0', kind: 'keepout', rect: { x: 0, y: 0, w: 320, h: 240 }, label: 'framebuffer 0',
};
const tex: Placement = {
  id: 'tex:a', kind: 'texture', rect: { x: 100, y: 100, w: 64, h: 64 }, type: TimType.Bpp8, label: 'tex',
};
const clut: Placement = {
  id: 'clut:a', kind: 'clut', rect: { x: 112, y: 120, w: 16, h: 1 }, label: 'clut',
};

describe('hit testing', () => {
  it('finds a reserved region, which used to be unclickable', () => {
    expect(hitTest([fb], 10, 10, 1)?.id).toBe('keepout:fb0');
  });

  it('prefers a texture drawn over a reserved region', () => {
    // A framebuffer-sized keepout is large; on equal terms it would swallow
    // every click aimed at something sitting on top of it.
    expect(hitTest([fb, tex], 120, 120, 1)?.id).toBe('tex:a');
    expect(hitTest([tex, fb], 120, 120, 1)?.id).toBe('tex:a');
  });

  it('prefers a CLUT over a texture it sits on', () => {
    expect(hitTest([fb, tex, clut], 120, 120, 1)?.id).toBe('clut:a');
  });

  it('still returns the reserved region where nothing else is', () => {
    expect(hitTest([fb, tex, clut], 20, 200, 1)?.id).toBe('keepout:fb0');
  });

  it('returns nothing on empty VRAM', () => {
    expect(hitTest([fb, tex], 900, 400, 1)).toBeUndefined();
  });

  it('gives a one-line-tall CLUT a grab margin when zoomed out', () => {
    // At 0.25x a CLUT is a quarter of a screen pixel tall. Without a margin it
    // is unclickable, which is the reverse of the problem TIMTOOL 3 fixed.
    // The CLUT occupies y in [120, 121). A point 1.4 lines below it is only
    // reachable with the zoomed-out margin.
    expect(hitTest([clut], 120, 122.4, 0.25)?.id).toBe('clut:a');
    expect(hitTest([clut], 120, 122.4, 4)).toBeUndefined();
  });
});

describe('snapping', () => {
  it('forces CLUT X onto a multiple of 16 regardless of preference', () => {
    const s = snapPosition('clut', { x: 21, y: 300 }, { w: 16, h: 1 }, [], {
      grid: 1, toGrid: false, toEdges: false,
    });
    expect(s.x % CLUT_X_ALIGN).toBe(0);
  });

  it('keeps anything inside VRAM', () => {
    const s = snapPosition('texture', { x: 2000, y: 2000 }, { w: 64, h: 64 }, [], {
      grid: 1, toGrid: false, toEdges: false,
    });
    expect(s.x).toBe(VRAM_WIDTH - 64);
    expect(s.y).toBe(VRAM_HEIGHT - 64);
  });

  it('snaps to a grid when asked', () => {
    const s = snapPosition('texture', { x: 37, y: 41 }, { w: 8, h: 8 }, [], {
      grid: 16, toGrid: true, toEdges: false,
    });
    expect(s).toEqual({ x: 32, y: 48 });
  });

  it('snaps to a neighbour edge when close enough', () => {
    // tex spans x 100..164, so its edges are 100, 164, and 100-w for butting
    // up against its left side.
    const near = snapPosition('texture', { x: 102, y: 2 }, { w: 8, h: 8 }, [tex], {
      grid: 1, toGrid: false, toEdges: true,
    });
    expect(near.x).toBe(100);
  });

  it('leaves a position alone when no edge is within reach', () => {
    const far = snapPosition('texture', { x: 66, y: 2 }, { w: 8, h: 8 }, [tex], {
      grid: 1, toGrid: false, toEdges: true,
    });
    expect(far.x).toBe(66);
  });

  it('uses a per-depth default grid', () => {
    expect(defaultGridFor(TimType.Bpp4)).toBe(4);
    expect(defaultGridFor(TimType.Bpp8)).toBe(2);
    expect(defaultGridFor(TimType.Bpp16)).toBe(1);
  });
});

describe('view transform', () => {
  it('round-trips a coordinate through screen space', () => {
    const view = { zoom: 2.5, panX: 137, panY: 42, mode: 'normal' as const, height: 512 };
    const s = toScreen(view, 300, 200);
    const v = toVram(view, s.x, s.y);
    expect(v.x).toBeCloseTo(300, 6);
    expect(v.y).toBeCloseTo(200, 6);
  });

  it('fits all of VRAM into a viewport', () => {
    const view = fitView(1000, 500);
    const topLeft = toScreen(view, 0, 0);
    const bottomRight = toScreen(view, VRAM_WIDTH, VRAM_HEIGHT);
    expect(topLeft.x).toBeGreaterThanOrEqual(-0.001);
    expect(topLeft.y).toBeGreaterThanOrEqual(-0.001);
    expect(bottomRight.x).toBeLessThanOrEqual(1000.001);
    expect(bottomRight.y).toBeLessThanOrEqual(500.001);
  });
});
