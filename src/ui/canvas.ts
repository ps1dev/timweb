/**
 * The VRAM canvas.
 *
 * Everything is drawn in HALFWORD space, which is what makes this a VRAM view
 * rather than an image gallery: a 256-texel-wide 4bpp texture occupies 64
 * halfwords, so it is drawn a quarter as wide as its texel dimensions. That
 * squash is not a bug, it is the entire point - it is what lets you see that
 * four 4bpp textures fit where one 16bpp texture does.
 *
 * TIMTOOL 3's release notes record adding zoom because at 50% scale, dragging
 * jumped two pixels at a time and users could not place things. So this is
 * pixel-exact at every zoom level by construction: all hit-testing and
 * dragging happen in halfword coordinates, and zoom only affects rendering.
 */

import {
  VRAM_WIDTH,
  VRAM_HEIGHT,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  CLUT_X_ALIGN,
  occupancyMap,
  isReserved,
  type Placement,
  type VramRect,
} from '../core/vram.js';
import { TimType } from '../core/tim.js';

export type ViewMode = 'normal' | 'overlap' | 'free';

export interface SnapOptions {
  grid: number;
  toGrid: boolean;
  toEdges: boolean;
}

export interface CanvasView {
  zoom: number;
  panX: number;
  panY: number;
  mode: ViewMode;
  /** VRAM height being drawn: 512 retail, 1024 with 2MB. */
  height: number;
}

export interface RenderInput {
  placements: Placement[];
  /** Decoded previews, keyed by placement id. */
  previews: Map<string, CanvasImageSource>;
  selection: Set<string>;
  view: CanvasView;
  /** Halfword coordinate under the pointer, if any. */
  hover?: { x: number; y: number };
}

const COLORS = {
  background: '#0d1013',
  grid: '#1c2128',
  pageLine: '#2d353f',
  keepout: '#3a2a1a',
  keepoutEdge: '#7a5a2a',
  clut: '#c9a227',
  clutSelected: '#ffd84d',
  texture: '#2a4a5a',
  selected: '#4ade80',
  overlap: '#ef4444',
  free: '#16a34a',
  text: '#c9d1d9',
};

export function render(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { view } = input;
  const canvas = ctx.canvas;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(-view.panX, -view.panY);
  ctx.scale(view.zoom, view.zoom);
  ctx.imageSmoothingEnabled = false;

  // VRAM field
  ctx.fillStyle = COLORS.grid;
  ctx.fillRect(0, 0, VRAM_WIDTH, view.height);

  if (view.mode === 'free' || view.mode === 'overlap') {
    drawOccupancy(ctx, input);
  } else {
    drawPlacements(ctx, input);
  }

  drawPageGrid(ctx, view.zoom, view.height);
  drawSelection(ctx, input);

  ctx.restore();
}

function drawPageGrid(ctx: CanvasRenderingContext2D, zoom: number, height: number): void {
  ctx.save();
  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = COLORS.pageLine;
  ctx.beginPath();
  for (let x = 0; x <= VRAM_WIDTH; x += PAGE_WIDTH) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += PAGE_HEIGHT) {
    ctx.moveTo(0, y);
    ctx.lineTo(VRAM_WIDTH, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPlacements(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  // Reserved regions first so textures draw over them and the collision is
  // visible rather than hidden underneath.
  for (const p of input.placements) {
    if (!isReserved(p.kind)) continue;
    ctx.fillStyle = COLORS.keepout;
    ctx.fillRect(p.rect.x, p.rect.y, p.rect.w, p.rect.h);
    ctx.save();
    ctx.lineWidth = 1 / input.view.zoom;
    ctx.strokeStyle = COLORS.keepoutEdge;
    ctx.setLineDash([4 / input.view.zoom, 3 / input.view.zoom]);
    ctx.strokeRect(p.rect.x, p.rect.y, p.rect.w, p.rect.h);
    ctx.restore();
  }

  for (const p of input.placements) {
    if (isReserved(p.kind)) continue;
    const preview = input.previews.get(p.id);
    if (preview) {
      // Squashed into halfword space on purpose. See the file header.
      ctx.drawImage(preview, p.rect.x, p.rect.y, p.rect.w, p.rect.h);
    } else {
      ctx.fillStyle = p.kind === 'clut' ? COLORS.clut : COLORS.texture;
      ctx.fillRect(p.rect.x, p.rect.y, p.rect.w, Math.max(p.rect.h, 1));
    }
  }
}

function drawOccupancy(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const free = input.view.mode === 'free';
  // Free-space view must count reserved regions as occupied - they are exactly
  // the space you cannot put a texture in. Overlap view must NOT, since a
  // texture inside one is diagnosed separately and would otherwise drown the
  // real texture-on-texture collisions in red.
  const h = input.view.height;
  const map = occupancyMap(
    free ? input.placements : input.placements.filter((p) => !isReserved(p.kind)),
    h,
  );
  const img = ctx.createImageData(VRAM_WIDTH, h);

  for (let i = 0; i < map.length; i++) {
    const o = i * 4;
    const v = map[i];
    if (free) {
      if (v === 0) {
        img.data[o] = 0x16;
        img.data[o + 1] = 0xa3;
        img.data[o + 2] = 0x4a;
        img.data[o + 3] = 255;
      } else {
        img.data[o + 3] = 0;
      }
    } else {
      if (v > 1) {
        img.data[o] = 0xef;
        img.data[o + 1] = 0x44;
        img.data[o + 2] = 0x44;
        img.data[o + 3] = 255;
      } else if (v === 1) {
        img.data[o] = 0x30;
        img.data[o + 1] = 0x3a;
        img.data[o + 2] = 0x45;
        img.data[o + 3] = 255;
      } else {
        img.data[o + 3] = 0;
      }
    }
  }

  // createImageData/putImageData ignore the transform, so stage it through an
  // offscreen canvas to get it scaled and panned like everything else.
  const off = document.createElement('canvas');
  off.width = VRAM_WIDTH;
  off.height = h;
  off.getContext('2d')!.putImageData(img, 0, 0);
  ctx.drawImage(off, 0, 0);

  // Display region outline stays visible in both analysis modes.
  ctx.save();
  ctx.lineWidth = 1 / input.view.zoom;
  for (const p of input.placements) {
    if (!isReserved(p.kind)) continue;
    ctx.strokeStyle = COLORS.keepoutEdge;
    ctx.strokeRect(p.rect.x, p.rect.y, p.rect.w, p.rect.h);
  }
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  ctx.save();
  ctx.lineWidth = 2 / input.view.zoom;
  for (const p of input.placements) {
    if (!input.selection.has(p.id)) continue;
    ctx.strokeStyle = p.kind === 'clut' ? COLORS.clutSelected : COLORS.selected;
    ctx.strokeRect(
      p.rect.x - 0.5 / input.view.zoom,
      p.rect.y - 0.5 / input.view.zoom,
      p.rect.w + 1 / input.view.zoom,
      Math.max(p.rect.h, 1) + 1 / input.view.zoom,
    );
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Coordinate mapping and hit testing
// ---------------------------------------------------------------------------

/** Screen pixel -> VRAM halfword coordinate. Fractional; floor to use. */
export function toVram(
  view: CanvasView,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return {
    x: (screenX + view.panX) / view.zoom,
    y: (screenY + view.panY) / view.zoom,
  };
}

/** VRAM halfword coordinate -> screen pixel. */
export function toScreen(
  view: CanvasView,
  vramX: number,
  vramY: number,
): { x: number; y: number } {
  return { x: vramX * view.zoom - view.panX, y: vramY * view.zoom - view.panY };
}

/**
 * Topmost placement under a halfword coordinate.
 *
 * Framebuffers are hittable but sort LAST, so a texture sitting on top of one
 * wins the click - otherwise the framebuffer, being large, would swallow every
 * attempt to grab what is drawn over it.
 *
 * CLUTs are one line tall, which at low zoom is a sub-pixel target, so they get
 * a small vertical grab margin in halfword units scaled by zoom. Without it a
 * CLUT is effectively unclickable zoomed out - the exact class of problem
 * TIMTOOL 3 added zoom to solve, met from the other direction.
 */
export function hitTest(
  placements: Placement[],
  x: number,
  y: number,
  zoom: number,
): Placement | undefined {
  const margin = zoom >= 1 ? 0 : (1 / zoom - 1) / 2;
  // Iteration is BACKWARDS (topmost-drawn wins), so framebuffers go FIRST in
  // this list to be reached LAST. Building it the other way round inverts the
  // priority and makes a framebuffer swallow every click aimed at a texture on
  // top of it - which is exactly what the first version of this did.
  const order = [
    ...placements.filter((p) => isReserved(p.kind)),
    ...placements.filter((p) => !isReserved(p.kind)),
  ];
  for (let i = order.length - 1; i >= 0; i--) {
    const p = order[i];
    const r = p.rect;
    const grow = p.kind === 'clut' ? margin : 0;
    void i;
    if (
      x >= r.x &&
      x < r.x + r.w &&
      y >= r.y - grow &&
      y < r.y + Math.max(r.h, 1) + grow
    ) {
      return p;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/**
 * Snap a proposed position.
 *
 * Alignment that the hardware REQUIRES is applied unconditionally: a CLUT must
 * sit at a multiple of 16 halfwords, so the tool does not offer to place one
 * illegally. Everything else is a preference.
 */
export function snapPosition(
  kind: Placement['kind'],
  proposed: { x: number; y: number },
  size: { w: number; h: number },
  others: Placement[],
  snap: SnapOptions,
  height = VRAM_HEIGHT,
): { x: number; y: number } {
  let { x, y } = proposed;

  if (snap.toGrid && snap.grid > 1) {
    x = Math.round(x / snap.grid) * snap.grid;
    y = Math.round(y / snap.grid) * snap.grid;
  }

  if (snap.toEdges) {
    const threshold = 4;
    let bestDx = threshold + 1;
    let bestX = x;
    let bestDy = threshold + 1;
    let bestY = y;
    for (const o of others) {
      for (const candidate of [o.rect.x, o.rect.x + o.rect.w, o.rect.x - size.w]) {
        const d = Math.abs(candidate - x);
        if (d < bestDx) {
          bestDx = d;
          bestX = candidate;
        }
      }
      for (const candidate of [o.rect.y, o.rect.y + o.rect.h, o.rect.y - size.h]) {
        const d = Math.abs(candidate - y);
        if (d < bestDy) {
          bestDy = d;
          bestY = candidate;
        }
      }
    }
    if (bestDx <= threshold) x = bestX;
    if (bestDy <= threshold) y = bestY;
  }

  // Hardware alignment wins over any preference above.
  if (kind === 'clut') {
    x = Math.round(x / CLUT_X_ALIGN) * CLUT_X_ALIGN;
  }

  x = Math.max(0, Math.min(VRAM_WIDTH - size.w, Math.round(x)));
  y = Math.max(0, Math.min(height - Math.max(size.h, 1), Math.round(y)));
  return { x, y };
}

/** Default snap grid for a depth, in halfwords: one texture page column. */
export function defaultGridFor(type: TimType | undefined): number {
  switch (type) {
    case TimType.Bpp4:
      return 4;
    case TimType.Bpp8:
      return 2;
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

/** Build an offscreen canvas holding an RGBA buffer, for use as a preview. */
export function previewFromRGBA(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(width, 1);
  c.height = Math.max(height, 1);
  const cx = c.getContext('2d')!;
  if (width > 0 && height > 0) {
    cx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  }
  return c;
}

/** Render a palette as a 1-pixel-tall strip, for drawing a CLUT in place. */
export function previewFromPalette(palette: Uint16Array): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = palette.length;
  c.height = 1;
  const img = new ImageData(palette.length, 1);
  for (let i = 0; i < palette.length; i++) {
    const v = palette[i];
    const o = i * 4;
    if (v === 0) {
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
      img.data[o + 3] = 255;
      continue;
    }
    const r5 = v & 0x1f;
    const g5 = (v >> 5) & 0x1f;
    const b5 = (v >> 10) & 0x1f;
    img.data[o] = (r5 << 3) | (r5 >> 2);
    img.data[o + 1] = (g5 << 3) | (g5 >> 2);
    img.data[o + 2] = (b5 << 3) | (b5 >> 2);
    img.data[o + 3] = 255;
  }
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

/** Fit a rect into a viewport, returning the zoom and pan that centre it. */
export function fitView(
  viewportW: number,
  viewportH: number,
  height = VRAM_HEIGHT,
  rect: VramRect = { x: 0, y: 0, w: VRAM_WIDTH, h: height },
): CanvasView {
  const zoom = Math.min(viewportW / rect.w, viewportH / rect.h);
  return {
    zoom,
    panX: rect.x * zoom - (viewportW - rect.w * zoom) / 2,
    panY: rect.y * zoom - (viewportH - rect.h * zoom) / 2,
    mode: 'normal',
    height,
  };
}
