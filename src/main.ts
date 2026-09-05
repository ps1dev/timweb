/**
 * timweb application wiring.
 *
 * Deliberately plain: state is one object, every mutation ends in render(),
 * and render() rebuilds the panels from state. A VRAM canvas is a canvas and a
 * hit-test, not a component tree.
 */

import { TimType, halfwordWidth } from './core/tim.js';
import { distinctRGB555 } from './core/quantize.js';
import { NEAR_BLACK } from './core/color.js';
import {
  CLUT_X_ALIGN,
  PAGE_WIDTH,
  VRAM_WIDTH,
  VRAM_HEIGHT_1MB,
  measureSpace,
  findFreeSpot,
} from './core/vram.js';
import { CLUT_WORDS, type SelectableDepth } from './core/depth.js';
import { packProject } from './core/autopack.js';
import {
  emptyProject,
  vramHeight,
  createAsset,
  createKeepout,
  FRAMEBUFFER_PRESETS,
  assetFromTim,
  assetFromSplit,
  convertAsset,
  autoDepth,
  clampIntoVram,
  pixelRect,
  clutRect,
  projectPlacements,
  validate,
  serializeProject,
  deserializeProject,
  exportProject,
  type Asset,
  type Keepout,
  type Project,
} from './core/project.js';
import {
  render,
  toVram,
  hitTest,
  snapPosition,
  previewFromRGBA,
  previewFromPalette,
  fitView,
  defaultGridFor,
  type CanvasView,
  type ViewMode,
} from './ui/canvas.js';
import { renderTemplate } from './core/template.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

interface AppState {
  project: Project;
  view: CanvasView;
  selected?: string;
  hover?: { x: number; y: number };
  message: string;
  distinctCache: Map<string, number>;
}

const state: AppState = {
  project: emptyProject(),
  view: { zoom: 1, panX: 0, panY: 0, mode: 'normal', height: VRAM_HEIGHT_1MB },
  message: '',
  distinctCache: new Map(),
};

const previews = new Map<string, HTMLCanvasElement>();
const canvas = $<HTMLCanvasElement>('canvas');
const wrap = $('canvas-wrap');
const ctx = canvas.getContext('2d')!;

// ---------------------------------------------------------------------------
// Asset helpers
// ---------------------------------------------------------------------------

function selectedAsset(): Asset | undefined {
  if (!state.selected) return undefined;
  const id = state.selected.replace(/^(tex|clut):/, '');
  return state.project.assets.find((a) => a.id === id);
}

function refreshAsset(a: Asset): void {
  if (a.settings.depthAuto) {
    a.settings.depth = autoDepth(a, state.project);
  }
  a.converted = undefined;
  if (a.settings.depth !== TimType.Bpp16) convertAsset(a);
  clampIntoVram(a, vramHeight(state.project));
  rebuildPreview(a);
  state.distinctCache.delete(a.id);
}

function rebuildPreview(a: Asset): void {
  if (a.settings.depth === TimType.Bpp16 || !a.converted) {
    previews.set(`tex:${a.id}`, previewFromRGBA(a.rgba, a.width, a.height));
    previews.delete(`clut:${a.id}`);
    return;
  }
  const { indices, palette, transparentIndex } = a.converted;
  const rgba = new Uint8ClampedArray(a.width * a.height * 4);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx === transparentIndex) continue;
    const v = palette[idx];
    const r5 = v & 0x1f;
    const g5 = (v >> 5) & 0x1f;
    const b5 = (v >> 10) & 0x1f;
    rgba[i * 4] = (r5 << 3) | (r5 >> 2);
    rgba[i * 4 + 1] = (g5 << 3) | (g5 >> 2);
    rgba[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
    rgba[i * 4 + 3] = 255;
  }
  previews.set(`tex:${a.id}`, previewFromRGBA(rgba, a.width, a.height));
  previews.set(`clut:${a.id}`, previewFromPalette(palette));
}

const DISTINCT_CAP = 4096;

/** Distinct RGB555 count, capped for cost. Over the cap the exact number is
 *  not known, so it is reported as such rather than as a precise-looking
 *  cap-plus-one. */
function distinctFor(a: Asset): number {
  let n = state.distinctCache.get(a.id);
  if (n === undefined) {
    n = distinctRGB555(a.rgba, a.settings.alphaTransparent, DISTINCT_CAP).size;
    state.distinctCache.set(a.id, n);
  }
  return n;
}

function distinctLabel(a: Asset): string {
  const n = distinctFor(a);
  return n > DISTINCT_CAP ? `${DISTINCT_CAP}+` : String(n);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function importImageFile(file: File): Promise<string | undefined> {
  const bitmap = await createImageBitmap(file);
  const off = document.createElement('canvas');
  off.width = bitmap.width;
  off.height = bitmap.height;
  const octx = off.getContext('2d')!;
  octx.drawImage(bitmap, 0, 0);
  const rgba = octx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();

  const name = file.name.replace(/\.[^.]+$/, '');
  const asset = createAsset(name, off.width, off.height, rgba, state.project);
  const existing = state.project.assets.findIndex((a) => a.id === asset.id);
  if (existing >= 0) state.project.assets[existing] = asset;
  else state.project.assets.push(asset);
  refreshAsset(asset);
  state.selected = `tex:${asset.id}`;
  return undefined;
}

/** Returns an error string, or undefined on success. */
async function importTimFile(file: File): Promise<string | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.replace(/\.[^.]+$/i, '');
  const result = assetFromTim(name, bytes);
  if ('error' in result) return `${file.name}: ${result.error}`;
  const prior = state.project.assets.find((a) => a.name === name);
  const asset: Asset = { ...result.asset, id: prior?.id ?? crypto.randomUUID().slice(0, 8) };
  if (prior) {
    state.project.assets[state.project.assets.indexOf(prior)] = asset;
  } else {
    state.project.assets.push(asset);
  }
  refreshAsset(asset);
  state.selected = `tex:${asset.id}`;
  return result.warnings.length ? `${file.name}: ${result.warnings.join('; ')}` : undefined;
}

const baseName = (n: string) => n.replace(/\.[^.]+$/, '');

/** Returns an error string, or undefined on success. */
async function importSplitPair(
  name: string,
  pxl: File,
  clt?: File,
): Promise<string | undefined> {
  const result = assetFromSplit(
    name,
    new Uint8Array(await pxl.arrayBuffer()),
    clt ? new Uint8Array(await clt.arrayBuffer()) : undefined,
  );
  if ('error' in result) return result.error;
  const prior = state.project.assets.find((a) => a.name === name);
  const asset: Asset = { ...result.asset, id: prior?.id ?? crypto.randomUUID().slice(0, 8) };
  if (prior) state.project.assets[state.project.assets.indexOf(prior)] = asset;
  else state.project.assets.push(asset);
  refreshAsset(asset);
  state.selected = `tex:${asset.id}`;
  return result.warnings.length ? `${name}: ${result.warnings.join('; ')}` : undefined;
}

async function importFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);

  // Messages are ACCUMULATED and composed at the end. The first cut set a
  // specific warning ("no .pxl found for X") and then overwrote it with a
  // generic "imported 1 file" - a warning clobbered by a success line, which
  // is worse than no warning at all. Caught in the browser, not by a test.
  const problems: string[] = [];
  let imported = 0;

  const baseName = (n: string) => n.replace(/\.[^.]+$/, '');
  const pxls = new Map<string, File>();
  const clts = new Map<string, File>();
  const rest: File[] = [];
  for (const f of list) {
    if (/\.pxl$/i.test(f.name)) pxls.set(baseName(f.name), f);
    else if (/\.clt$/i.test(f.name)) clts.set(baseName(f.name), f);
    else rest.push(f);
  }

  for (const [name, pxl] of pxls) {
    try {
      const err = await importSplitPair(name, pxl, clts.get(name));
      if (err) problems.push(err);
      else imported++;
      clts.delete(name);
    } catch (e) {
      problems.push(`${name}: ${(e as Error).message}`);
    }
  }
  for (const orphan of clts.keys()) {
    problems.push(`${orphan}${state.project.cltSuffix} has no matching PXL - import the pair together`);
  }

  for (const f of rest) {
    try {
      const err = /\.tim$/i.test(f.name) ? await importTimFile(f) : await importImageFile(f);
      if (err) problems.push(err);
      else imported++;
    } catch (e) {
      problems.push(`${f.name}: ${(e as Error).message}`);
    }
  }

  state.message = problems.length
    ? problems.join(' | ')
    : imported
      ? `imported ${imported} file${imported > 1 ? 's' : ''}`
      : '';
  update();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function download(name: string, data: Uint8Array | string, mime: string): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw(): void {
  // The view's height must follow the project, or the canvas draws a 512-line
  // field while the model places things below it.
  state.view.height = vramHeight(state.project);
  const dpr = window.devicePixelRatio || 1;

  // Clear in DEVICE pixels, then hand render() a CSS-pixel base transform.
  // Everything downstream - drawing, hit-testing, snapping - works in CSS
  // pixels, so this is the single place the two coordinate systems meet.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d1013';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  render(ctx, {
    placements: projectPlacements(state.project),
    previews: previews as Map<string, CanvasImageSource>,
    selection: new Set(state.selected ? [state.selected] : []),
    view: state.view,
    hover: state.hover,
  });
}

function update(): void {
  draw();
  renderSuffixPreview();
  renderAssetList();
  renderKeepouts();
  renderInspector();
  renderIssues();
  renderStatus();
}

/**
 * Refresh a list IN PLACE, reusing the existing `<li>` nodes.
 *
 * Deliberately not `innerHTML = ''` and rebuild. Type into a coordinate field
 * and then click another row: the click's own mousedown blurs the field, the
 * blur fires `change`, the handler calls `update()`, and the row the click
 * started on is removed from the document before the click completes - so the
 * click is silently swallowed and the selection does not move. Found by
 * driving the built page, not by any unit test, because the bug lives
 * entirely in event ordering the DOM supplies.
 *
 * Selection-on-mousedown would also "fix" it and is worse: it moves the
 * selection before the blur, so the edit the user just typed gets applied to
 * whichever row they clicked instead. Keeping the node alive keeps both
 * events, in the right order.
 */
function syncList<T>(
  ul: HTMLElement,
  items: T[],
  render: (item: T, li: HTMLLIElement) => void,
): void {
  while (ul.children.length > items.length) ul.lastElementChild!.remove();
  while (ul.children.length < items.length) ul.appendChild(document.createElement('li'));
  items.forEach((item, i) => render(item, ul.children[i] as HTMLLIElement));
}

function renderAssetList(): void {
  syncList($('assets'), state.project.assets, (a, li) => {
    li.className = state.selected?.endsWith(`:${a.id}`) ? 'sel' : '';
    const bpp = a.settings.depth === TimType.Bpp4 ? '4' : a.settings.depth === TimType.Bpp8 ? '8' : '16';
    const html =
      `<span class="name">${escapeHtml(a.name)}</span>` +
      `<span class="meta">${a.width}x${a.height} ${bpp}bpp${a.settings.depthAuto ? '*' : ''}</span>`;
    if (li.innerHTML !== html) li.innerHTML = html;
    li.onclick = () => {
      state.selected = `tex:${a.id}`;
      update();
    };
  });
  $('assets-empty').classList.toggle('hidden', state.project.assets.length > 0);
}

function renderInspector(): void {
  const a = selectedAsset();
  $('inspector').classList.toggle('hidden', !a);
  $('inspector-empty').classList.toggle('hidden', !!a || !!selectedKeepout());
  if (!a) return;

  $<HTMLInputElement>('a-name').value = a.name;
  $('a-size').textContent = `${a.width}x${a.height} texels`;
  $('a-distinct').textContent = distinctLabel(a);

  $<HTMLInputElement>('a-locked').checked = !!a.locked;
  $<HTMLInputElement>('a-nopack').checked = !!a.excludeFromPacking;
  $<HTMLInputElement>('a-auto').checked = a.settings.depthAuto;
  $<HTMLSelectElement>('a-depth').value = String(a.settings.depth);
  // Deliberately NOT disabled while auto is on: picking a depth by hand is
  // how you turn auto off, and disabling the control makes that impossible.

  const texWords = halfwordWidth(a.width, a.settings.depth) * a.height;
  $('a-texwords').textContent = `${texWords} hw`;
  $('a-clutwords').textContent = `${CLUT_WORDS[a.settings.depth]} hw`;

  $<HTMLInputElement>('a-dither').checked = a.settings.dither;
  $<HTMLSelectElement>('a-blackmode').value = a.settings.blackMode;
  $<HTMLSelectElement>('a-blackmode').disabled = a.settings.forceSTP;
  $<HTMLInputElement>('a-blackrepl').value =
    '0x' + a.settings.blackReplacement.toString(16).padStart(4, '0');
  $('a-blackrepl-row').classList.toggle('hidden', a.settings.blackMode !== 'gray');
  $('a-blackmode-note').textContent =
    a.settings.blackMode === 'gray'
      ? 'Unconditionally opaque. Costs a fixed 8 units per channel on true black.'
      : 'True solid black ONLY while the primitive is drawn with semi-transparency disabled. Turn ABE on and it blends.';
  $<HTMLInputElement>('a-forcestp').checked = a.settings.forceSTP;
  $<HTMLInputElement>('a-atrans').value = String(a.settings.alphaTransparent);
  $<HTMLInputElement>('a-asolid').value = String(a.settings.alphaSolid);

  const r = a.converted?.report;
  const set = (id: string, text: string, cls = '') => {
    const el = $(id);
    el.textContent = text;
    el.className = `v ${cls}`;
  };
  if (a.settings.depth === TimType.Bpp16) {
    set('q-method', 'direct colour');
    set('q-max', '<= 7', 'good');
    set('q-past', '0%', 'good');
    set('q-mean', '-');
    set('q-excused', '-');
    set('q-collisions', '-');
    set('q-bands', '-');
    set('q-stp', a.settings.forceSTP ? 'all texels' : '-');
    $('q-note').textContent = 'No palette. Only the format’s own 8-to-5 truncation applies.';
    $('q-swatches').innerHTML = '';
  } else if (r && a.converted) {
    set('q-method', a.converted.lossless ? 'exact (no loss)' : a.converted.method);
    set('q-max', String(r.maxChannelError), r.maxChannelError <= 7 ? 'good' : r.maxChannelError > 24 ? 'bad' : 'warn');
    set('q-past', `${(r.pastFloorFraction * 100).toFixed(1)}%`,
      r.pastFloorFraction === 0 ? 'good' : r.pastFloorFraction > 0.1 ? 'bad' : 'warn');
    set('q-mean', r.meanChannelError.toFixed(2));
    set('q-excused', `${(r.excusedFraction * 100).toFixed(1)}%`);
    set('q-collisions', String(a.converted.collisions));
    const b = a.converted.bands;
    set('q-bands', `${b.solid} / ${b.semi} / ${b.transparent}`);
    set('q-stp', String(a.converted.stpEntries), a.converted.stpEntries > 0 ? 'good' : '');
    $('q-note').textContent = a.converted.lossless
      ? 'Image fitted the palette exactly; the quantizer did not run.'
      : 'Anything past the 5-bit floor of 7 is the quantizer, not the format. This is an error metric, not a verdict - judge it with your eyes.';
    renderSwatches(a.converted.palette);
  }

  $<HTMLInputElement>('a-x').value = String(a.x);
  $<HTMLInputElement>('a-y').value = String(a.y);
  $<HTMLInputElement>('a-cx').value = String(a.clutX);
  $<HTMLInputElement>('a-cy').value = String(a.clutY);
  $('clut-pos').classList.toggle('hidden', a.settings.depth === TimType.Bpp16);
}

function renderSwatches(palette: Uint16Array): void {
  const host = $('q-swatches');
  host.innerHTML = '';
  for (let i = 0; i < palette.length; i++) {
    const v = palette[i];
    const i5 = (c: number) => ((c << 3) | (c >> 2)).toString();
    const el = document.createElement('i');
    if (v === 0) {
      el.style.background =
        'repeating-conic-gradient(#333 0% 25%, #111 0% 50%) 50%/6px 6px';
      el.title = `${i}: transparent`;
    } else {
      const r = i5(v & 0x1f);
      const g = i5((v >> 5) & 0x1f);
      const b = i5((v >> 10) & 0x1f);
      el.style.background = `rgb(${r},${g},${b})`;
      el.title = `${i}: 0x${v.toString(16).padStart(4, '0')}${v & 0x8000 ? ' STP' : ''}`;
      if (v & 0x8000) el.style.outline = '1px solid #4ade80';
    }
    host.appendChild(el);
  }
}

function renderIssues(): void {
  const issues = validate(state.project);
  const ul = $('issues');
  ul.innerHTML = '';
  for (const i of issues.slice(0, 60)) {
    const li = document.createElement('li');
    li.className = i.severity;
    li.textContent = i.message;
    ul.appendChild(li);
  }
  $('issues-none').classList.toggle('hidden', issues.length > 0);

  const space = measureSpace(projectPlacements(state.project), vramHeight(state.project));
  $('vram-used').textContent = `${((1 - space.freeFraction) * 100).toFixed(1)}%`;
  $('vram-free').textContent = `${(space.freeFraction * 100).toFixed(1)}%`;
  const ov = $('vram-overlap');
  ov.textContent = `${space.overlappingHalfwords} hw`;
  ov.className = `v ${space.overlappingHalfwords > 0 ? 'bad' : 'good'}`;
  $('s-issues').textContent = `${issues.length} issue${issues.length === 1 ? '' : 's'}`;
}

function renderStatus(): void {
  $('s-assets').textContent = `${state.project.assets.length} asset${state.project.assets.length === 1 ? '' : 's'}`;
  $('s-msg').textContent = state.message;
  $('zoom-label').textContent = `${Math.round(state.view.zoom * 100)}%`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

let drag:
  | {
      id: string;
      kind: 'texture' | 'clut' | 'keepout';
      assetId: string;
      offX: number;
      offY: number;
    }
  | undefined;
let panning: { x: number; y: number; panX: number; panY: number } | undefined;

canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const v = toVram(state.view, e.clientX - rect.left, e.clientY - rect.top);

  if (e.button === 1 || e.shiftKey) {
    panning = { x: e.clientX, y: e.clientY, panX: state.view.panX, panY: state.view.panY };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  const hit = hitTest(projectPlacements(state.project), v.x, v.y, state.view.zoom);
  if (!hit) {
    state.selected = undefined;
    update();
    return;
  }
  state.selected = hit.id;
  const assetId = hit.id.replace(/^(tex|clut|keepout):/, '');
  drag = {
    id: hit.id,
    kind: hit.kind === 'clut' ? 'clut' : hit.kind === 'keepout' ? 'keepout' : 'texture',
    assetId,
    offX: v.x - hit.rect.x,
    offY: v.y - hit.rect.y,
  };
  canvas.setPointerCapture(e.pointerId);
  update();
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const v = toVram(state.view, e.clientX - rect.left, e.clientY - rect.top);
  state.hover = { x: Math.floor(v.x), y: Math.floor(v.y) };
  updateReadout();

  if (panning) {
    state.view.panX = panning.panX - (e.clientX - panning.x);
    state.view.panY = panning.panY - (e.clientY - panning.y);
    draw();
    return;
  }

  if (!drag) return;

  if (drag.kind === 'keepout') {
    const k = state.project.keepouts.find((x) => x.id === drag!.assetId);
    if (!k) return;
    const others = projectPlacements(state.project).filter((p) => p.id !== drag!.id);
    const snapped = snapPosition(
      'keepout',
      { x: v.x - drag.offX, y: v.y - drag.offY },
      { w: k.w, h: k.h },
      others,
      {
        grid: Number($<HTMLInputElement>('snap-size').value) || 1,
        toGrid: $<HTMLInputElement>('snap-grid').checked,
        toEdges: $<HTMLInputElement>('snap-edges').checked,
      },
      vramHeight(state.project),
    );
    k.x = snapped.x;
    k.y = snapped.y;
    draw();
    renderIssues();
    renderKeepouts();
    return;
  }

  const a = state.project.assets.find((x) => x.id === drag!.assetId);
  if (!a) return;
  if (a.locked) return;

  const isClut = drag.kind === 'clut';
  const size = isClut ? clutRect(a)! : pixelRect(a);
  const others = projectPlacements(state.project).filter((p) => p.id !== drag!.id);
  const snapped = snapPosition(
    isClut ? 'clut' : 'texture',
    { x: v.x - drag.offX, y: v.y - drag.offY },
    size,
    others,
    {
      grid: Number($<HTMLInputElement>('snap-size').value) || defaultGridFor(a.settings.depth),
      toGrid: $<HTMLInputElement>('snap-grid').checked,
      toEdges: $<HTMLInputElement>('snap-edges').checked,
    },
    vramHeight(state.project),
  );

  if (isClut) {
    a.clutX = snapped.x;
    a.clutY = snapped.y;
  } else {
    a.x = snapped.x;
    a.y = snapped.y;
  }
  draw();
  renderIssues();
});

const endDrag = () => {
  if (drag || panning) {
    drag = undefined;
    panning = undefined;
    update();
  }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const before = toVram(state.view, e.clientX - rect.left, e.clientY - rect.top);
  const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
  state.view.zoom = Math.max(0.25, Math.min(32, state.view.zoom * factor));
  // Keep the point under the cursor fixed. Zooming about the centre makes
  // precise placement miserable, which is the failure TIMTOOL 3 shipped a fix
  // for in 1998.
  state.view.panX = before.x * state.view.zoom - (e.clientX - rect.left);
  state.view.panY = before.y * state.view.zoom - (e.clientY - rect.top);
  draw();
  renderStatus();
}, { passive: false });

function updateReadout(): void {
  const el = $('readout');
  const blank = () => {
    el.textContent = '';
    el.style.display = 'none';
    $('s-hover').textContent = '';
  };
  if (!state.hover) {
    blank();
    return;
  }
  const { x, y } = state.hover;
  if (x < 0 || y < 0 || x >= VRAM_WIDTH || y >= vramHeight(state.project)) {
    blank();
    return;
  }
  el.style.display = 'block';
  const under = projectPlacements(state.project).filter(
    (p) => x >= p.rect.x && x < p.rect.x + p.rect.w && y >= p.rect.y && y < p.rect.y + Math.max(p.rect.h, 1),
  );
  const nonDisplay = under.filter((p) => p.kind !== 'keepout');
  const label =
    nonDisplay.length > 1
      ? '-OVERLAP- ' + nonDisplay.map((p) => p.label ?? p.id).join(' / ')
      : nonDisplay.length === 1
        ? (nonDisplay[0].label ?? nonDisplay[0].id)
        : under.length
          ? 'reserved'
          : 'free';
  const page = Math.floor(y / 256) * 16 + Math.floor(x / 64);
  el.textContent = `${x},${y} hw   page ${page}\n${label}`;
  $('s-hover').textContent = `${x},${y}`;
}

canvas.addEventListener('pointerleave', () => {
  state.hover = undefined;
  updateReadout();
});

// ---------------------------------------------------------------------------
// Toolbar and inspector wiring
// ---------------------------------------------------------------------------

$('btn-import').onclick = () => $<HTMLInputElement>('file-images').click();
$('btn-import-tim').onclick = () => $<HTMLInputElement>('file-tims').click();
$('btn-open').onclick = () => $<HTMLInputElement>('file-project').click();

$<HTMLInputElement>('file-images').onchange = (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (files) void importFiles(files);
  (e.target as HTMLInputElement).value = '';
};
$<HTMLInputElement>('file-tims').onchange = (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (files) void importFiles(files);
  (e.target as HTMLInputElement).value = '';
};
$<HTMLInputElement>('file-project').onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!file) return;
  try {
    const text = await file.text();
    // Keep any already-loaded pixels: a project file stores layout, not art,
    // so re-attaching by name is how a saved layout comes back to life.
    const existing = new Map(state.project.assets.map((a) => [a.name, a.rgba]));
    const { project, missing } = deserializeProject(text, (n) => existing.get(n));
    state.project = project;
    previews.clear();
    state.distinctCache.clear();
    for (const a of project.assets) refreshAsset(a);
    state.selected = undefined;
    state.message = missing.length
      ? `loaded; ${missing.length} asset${missing.length > 1 ? 's' : ''} need re-importing: ${missing.join(', ')}`
      : 'project loaded';
  } catch (err) {
    state.message = `open failed: ${(err as Error).message}`;
  }
  syncProjectControls();
  update();
};

$('btn-save').onclick = () => {
  download(
    `${state.project.name}.timweb.json`,
    serializeProject(state.project),
    'application/json',
  );
  state.message = 'project saved';
  renderStatus();
};

$('btn-export').onclick = () => {
  if (!state.project.assets.length) {
    state.message = 'nothing to export';
    renderStatus();
    return;
  }
  try {
    const tim = $<HTMLInputElement>('x-tim').checked;
    const raw = $<HTMLInputElement>('x-raw').checked;
    const pxl = $<HTMLInputElement>('x-pxl').checked;
    const template = $<HTMLInputElement>('x-tpl').checked;
    if (!tim && !raw && !pxl && !template) {
      state.message = 'pick at least one export format';
      renderStatus();
      return;
    }
    const { zip, entries } = exportProject(state.project, { tim, raw, pxl, template });
    download(`${state.project.name}.zip`, zip, 'application/zip');
    state.message = `exported ${entries.length} files`;
  } catch (err) {
    state.message = `export failed: ${(err as Error).message}`;
  }
  renderStatus();
};

$<HTMLSelectElement>('view-mode').onchange = (e) => {
  state.view.mode = (e.target as HTMLSelectElement).value as ViewMode;
  draw();
};

$('btn-zoom-in').onclick = () => {
  state.view.zoom = Math.min(32, state.view.zoom * 1.5);
  draw();
  renderStatus();
};
$('btn-zoom-out').onclick = () => {
  state.view.zoom = Math.max(0.25, state.view.zoom / 1.5);
  draw();
  renderStatus();
};
$('btn-fit').onclick = () => {
  const rect = wrap.getBoundingClientRect();
  const mode = state.view.mode;
  state.view = fitView(rect.width - 16, rect.height - 16, vramHeight(state.project));
  state.view.mode = mode;
  draw();
  renderStatus();
};


function selectedKeepout(): Keepout | undefined {
  if (!state.selected?.startsWith('keepout:')) return undefined;
  const id = state.selected.slice('keepout:'.length);
  return state.project.keepouts.find((k) => k.id === id);
}

function renderKeepouts(): void {
  syncList($('keepouts'), state.project.keepouts, (k, li) => {
    li.className = state.selected === `keepout:${k.id}` ? 'sel' : '';
    const html =
      `<span class="name">${escapeHtml(k.name || k.id)}</span>` +
      `<span class="meta">${k.w}x${k.h} @${k.x},${k.y}</span>`;
    if (li.innerHTML !== html) li.innerHTML = html;
    li.onclick = () => {
      state.selected = `keepout:${k.id}`;
      update();
    };
  });
  $('keepouts-empty').classList.toggle('hidden', state.project.keepouts.length > 0);

  const k = selectedKeepout();
  $('k-inspector').classList.toggle('hidden', !k);
  if (!k) return;
  $<HTMLInputElement>('k-name').value = k.name;
  for (const [id, key] of [['k-x', 'x'], ['k-y', 'y'], ['k-w', 'w'], ['k-h', 'h']] as const) {
    $<HTMLInputElement>(id).value = String(k[key]);
  }
}

$<HTMLSelectElement>('k-preset').onchange = () => {
  const sel = $<HTMLSelectElement>('k-preset');
  const preset = FRAMEBUFFER_PRESETS.find((f) => f.label === sel.value);
  sel.value = '';
  if (!preset) return;
  // A framebuffer IS a keepout. The preset is a size worth not typing, not a
  // second mechanism that behaves identically.
  const n = state.project.keepouts.filter((x) => /^framebuffer /.test(x.name)).length;
  const k = createKeepout(state.project, preset.w, preset.h);
  k.name = `framebuffer ${n}`;
  state.project.keepouts.push(k);
  state.selected = `keepout:${k.id}`;
  update();
};

$('k-add').onclick = () => {
  const k = createKeepout(state.project);
  state.project.keepouts.push(k);
  state.selected = `keepout:${k.id}`;
  update();
};
$('k-del').onclick = () => {
  const k = selectedKeepout();
  if (!k) return;
  state.project.keepouts = state.project.keepouts.filter((x) => x.id !== k.id);
  state.selected = undefined;
  update();
};
$<HTMLInputElement>('k-name').onchange = () => {
  const k = selectedKeepout();
  if (k) k.name = $<HTMLInputElement>('k-name').value.trim() || k.name;
  update();
};
for (const [id, key] of [['k-x', 'x'], ['k-y', 'y'], ['k-w', 'w'], ['k-h', 'h']] as const) {
  $<HTMLInputElement>(id).onchange = () => {
    const k = selectedKeepout();
    if (!k) return;
    const v = Math.max(key === 'w' || key === 'h' ? 1 : 0, Number($<HTMLInputElement>(id).value) || 0);
    k[key] = v;
    // Keep it inside VRAM rather than letting it silently hang off the edge.
    const H = vramHeight(state.project);
    k.w = Math.min(k.w, VRAM_WIDTH);
    k.h = Math.min(k.h, H);
    k.x = Math.min(k.x, VRAM_WIDTH - k.w);
    k.y = Math.min(k.y, H - k.h);
    update();
  };
}

// Inspector
const onAssetChange = (mutate: (a: Asset) => void, reconvert = true) => () => {
  const a = selectedAsset();
  if (!a) return;
  mutate(a);
  if (reconvert) refreshAsset(a);
  update();
};

$<HTMLInputElement>('a-name').onchange = onAssetChange((a) => {
  a.name = $<HTMLInputElement>('a-name').value.trim() || a.name;
}, false);

$<HTMLInputElement>('a-locked').onchange = onAssetChange((a) => {
  a.locked = $<HTMLInputElement>('a-locked').checked;
}, false);

// Separate from the lock on purpose. Locking is about the user's own edits and
// stops a drag; this stops the automatic placer and nothing else.
$<HTMLInputElement>('a-nopack').onchange = onAssetChange((a) => {
  a.excludeFromPacking = $<HTMLInputElement>('a-nopack').checked;
}, false);

function runPack(ids?: string[]): void {
  const report = packProject(state.project, ids ? { ids } : {});
  const parts: string[] = [];
  parts.push(report.moved.length === 1 ? 'moved 1 asset' : `moved ${report.moved.length} assets`);
  if (report.pinned.length) parts.push(`${report.pinned.length} held`);
  if (report.unplaced.length) {
    // Named rather than counted: an unplaced asset keeps its old position and
    // may now sit under something, so the user has to know which one.
    parts.push(`NO ROOM for ${report.unplaced.join(', ')}`);
  }
  state.message = parts.join(', ');
  update();
}

$('btn-pack').onclick = () => runPack();

$('btn-pack-sel').onclick = () => {
  const a = selectedAsset();
  if (!a) {
    state.message = 'select an asset first';
    renderStatus();
    return;
  }
  if (a.locked || a.excludeFromPacking) {
    state.message = `${a.name} is ${a.locked ? 'locked' : 'excluded from auto-placement'}`;
    renderStatus();
    return;
  }
  runPack([a.id]);
};

$<HTMLInputElement>('a-auto').onchange = onAssetChange((a) => {
  a.settings.depthAuto = $<HTMLInputElement>('a-auto').checked;
});

$<HTMLSelectElement>('a-depth').onchange = onAssetChange((a) => {
  a.settings.depth = Number($<HTMLSelectElement>('a-depth').value) as SelectableDepth;
  a.settings.depthAuto = false;
});

$<HTMLInputElement>('a-dither').onchange = onAssetChange((a) => {
  a.settings.dither = $<HTMLInputElement>('a-dither').checked;
});
$<HTMLSelectElement>('a-blackmode').onchange = onAssetChange((a) => {
  a.settings.blackMode = $<HTMLSelectElement>('a-blackmode').value as 'gray' | 'stp';
});
$<HTMLInputElement>('a-blackrepl').onchange = onAssetChange((a) => {
  const raw = $<HTMLInputElement>('a-blackrepl').value.trim().replace(/^#/, '');
  const v = Number.parseInt(raw, 16);
  if (Number.isFinite(v)) {
    // Masked to 15 bits: the STP bit is not the caller's to set here, and a
    // replacement of 0x0000 would put the hole straight back.
    a.settings.blackReplacement = (v & 0x7fff) || NEAR_BLACK;
  }
});
$<HTMLInputElement>('a-forcestp').onchange = onAssetChange((a) => {
  a.settings.forceSTP = $<HTMLInputElement>('a-forcestp').checked;
  if (a.settings.forceSTP) a.settings.blackMode = 'stp';
});
$<HTMLInputElement>('a-atrans').onchange = onAssetChange((a) => {
  a.settings.alphaTransparent = Math.max(1, Math.min(255, Number($<HTMLInputElement>('a-atrans').value) || 1));
  if (a.settings.alphaSolid < a.settings.alphaTransparent) {
    a.settings.alphaSolid = a.settings.alphaTransparent;
  }
});
$<HTMLInputElement>('a-asolid').onchange = onAssetChange((a) => {
  a.settings.alphaSolid = Math.max(1, Math.min(256, Number($<HTMLInputElement>('a-asolid').value) || 1));
  if (a.settings.alphaTransparent > a.settings.alphaSolid) {
    a.settings.alphaTransparent = a.settings.alphaSolid;
  }
});

for (const [id, key] of [['a-x', 'x'], ['a-y', 'y'], ['a-cx', 'clutX'], ['a-cy', 'clutY']] as const) {
  $<HTMLInputElement>(id).onchange = onAssetChange((a) => {
    let v = Number($<HTMLInputElement>(id).value) || 0;
    if (key === 'clutX') v = Math.round(v / CLUT_X_ALIGN) * CLUT_X_ALIGN;
    (a[key] as number) = Math.max(0, v);
  }, false);
}

$('a-autoplace').onclick = onAssetChange((a) => {
  if (a.locked) {
    state.message = `${a.name} is locked - unlock it to move it`;
    return;
  }
  const others = projectPlacements(state.project).filter((p) => !p.id.endsWith(`:${a.id}`));
  const pr = pixelRect(a);
  const H = vramHeight(state.project);
  const spot =
    findFreeSpot(others, pr.w, pr.h, { alignX: PAGE_WIDTH, avoidRowStraddle: true, height: H }) ??
    findFreeSpot(others, pr.w, pr.h, { alignX: PAGE_WIDTH, height: H });
  if (spot) {
    a.x = spot.x;
    a.y = spot.y;
  } else {
    state.message = 'no free space for this texture';
    return;
  }
  const cr = clutRect(a);
  if (cr) {
    const withTex = [
      ...others,
      { id: 'pending', kind: 'texture' as const, rect: { ...spot, w: pr.w, h: pr.h } },
    ];
    const cspot = findFreeSpot(withTex, cr.w, 1, { alignX: CLUT_X_ALIGN, fromBottom: true, height: H });
    if (cspot) {
      a.clutX = cspot.x;
      a.clutY = cspot.y;
    } else {
      state.message = 'texture placed, but no free space for its CLUT';
    }
  }
}, false);

$('a-delete').onclick = () => {
  const a = selectedAsset();
  if (!a) return;
  state.project.assets = state.project.assets.filter((x) => x.id !== a.id);
  previews.delete(`tex:${a.id}`);
  previews.delete(`clut:${a.id}`);
  state.selected = undefined;
  update();
};

// Project controls
$<HTMLInputElement>('p-penalty').oninput = () => {
  state.project.clutPenalty = Number($<HTMLInputElement>('p-penalty').value);
  $('p-penalty-val').textContent = String(state.project.clutPenalty);
};
$<HTMLInputElement>('p-penalty').onchange = () => reAuto();

$<HTMLInputElement>('p-floor-on').onchange = () => {
  const on = $<HTMLInputElement>('p-floor-on').checked;
  $<HTMLInputElement>('p-floor').disabled = !on;
  state.project.qualityFloor = on ? Number($<HTMLInputElement>('p-floor').value) : undefined;
  reAuto();
};
$<HTMLInputElement>('p-floor').onchange = () => {
  if (!$<HTMLInputElement>('p-floor-on').checked) return;
  state.project.qualityFloor = Number($<HTMLInputElement>('p-floor').value);
  reAuto();
};
$('p-reauto').onclick = () => reAuto(true);

$<HTMLInputElement>('p-2mb').onchange = () => {
  state.project.vram2MB = $<HTMLInputElement>('p-2mb').checked;
  // Shrinking back to 1MB would strand anything placed in the upper bank, so
  // pull it back in rather than leaving it silently out of bounds.
  if (!state.project.vram2MB) {
    const H = vramHeight(state.project);
    for (const a of state.project.assets) clampIntoVram(a, H);
    for (const k of state.project.keepouts) {
      k.h = Math.min(k.h, H);
      k.y = Math.max(0, Math.min(H - k.h, k.y));
    }
  }
  const rect = wrap.getBoundingClientRect();
  const mode = state.view.mode;
  state.view = fitView(rect.width - 16, rect.height - 16, vramHeight(state.project));
  state.view.mode = mode;
  update();
};

$<HTMLTextAreaElement>('p-template').onchange = () => {
  state.project.template = $<HTMLTextAreaElement>('p-template').value;
};
$<HTMLInputElement>('p-tplfile').onchange = () => {
  state.project.templateFile =
    $<HTMLInputElement>('p-tplfile').value.trim() || 'placements.txt';
  $<HTMLInputElement>('p-tplfile').value = state.project.templateFile;
};
$('p-tplpreview').onclick = () => {
  state.project.template = $<HTMLTextAreaElement>('p-template').value;
  const out = $('p-tplout');
  out.classList.remove('hidden');
  try {
    out.textContent = renderTemplate(state.project.template, {
      project: state.project,
      vramHeight: vramHeight(state.project),
      files: state.project.assets.map((a) => ({
        image: `${a.name}${state.project.imageSuffix}`,
        palette: `${a.name}${state.project.paletteSuffix}`,
        tim: `${a.name}.tim`,
        pxl: `${a.name}${state.project.pxlSuffix}`,
        clt: `${a.name}${state.project.cltSuffix}`,
      })),
    }) || '(template produced nothing)';
  } catch (e) {
    out.textContent = `template error: ${(e as Error).message}`;
  }
};

const SUFFIX_PAIRS = {
  imageSuffix: 'paletteSuffix',
  paletteSuffix: 'imageSuffix',
  pxlSuffix: 'cltSuffix',
  cltSuffix: 'pxlSuffix',
} as const;

for (const [id, key] of [
  ['p-imgsuffix', 'imageSuffix'],
  ['p-palsuffix', 'paletteSuffix'],
  ['p-pxlsuffix', 'pxlSuffix'],
  ['p-cltsuffix', 'cltSuffix'],
] as const) {
  $<HTMLInputElement>(id).onchange = () => {
    // A suffix that is empty, or that collides with the other one, would
    // silently produce one file where two were meant. Refuse rather than
    // overwrite.
    const v = $<HTMLInputElement>(id).value.trim();
    const other = state.project[SUFFIX_PAIRS[key]];
    if (!v || v === other) {
      state.message = !v ? 'suffix cannot be empty' : 'image and palette suffixes must differ';
      $<HTMLInputElement>(id).value = state.project[key];
    } else {
      state.project[key] = v;
      state.message = '';
    }
    renderSuffixPreview();
    renderStatus();
  };
}

function reAuto(force = false): void {
  for (const a of state.project.assets) {
    if (force) a.settings.depthAuto = true;
    if (a.settings.depthAuto) refreshAsset(a);
  }
  state.message = 'auto depth re-run';
  update();
}

function renderSuffixPreview(): void {
  const sample = state.project.assets[0]?.name ?? 'texture';
  $('p-suffix-preview').textContent =
    `${sample}${state.project.imageSuffix}, ${sample}${state.project.paletteSuffix}\n` +
    `${sample}${state.project.pxlSuffix}, ${sample}${state.project.cltSuffix}`;
}

function syncProjectControls(): void {
  $<HTMLInputElement>('p-imgsuffix').value = state.project.imageSuffix;
  $<HTMLInputElement>('p-palsuffix').value = state.project.paletteSuffix;
  $<HTMLInputElement>('p-pxlsuffix').value = state.project.pxlSuffix;
  $<HTMLInputElement>('p-cltsuffix').value = state.project.cltSuffix;
  $<HTMLInputElement>('p-2mb').checked = state.project.vram2MB;
  $<HTMLTextAreaElement>('p-template').value = state.project.template;
  $<HTMLInputElement>('p-tplfile').value = state.project.templateFile;
  renderSuffixPreview();
  $<HTMLInputElement>('p-penalty').value = String(state.project.clutPenalty);
  $('p-penalty-val').textContent = String(state.project.clutPenalty);
  const on = state.project.qualityFloor !== undefined;
  $<HTMLInputElement>('p-floor-on').checked = on;
  $<HTMLInputElement>('p-floor').disabled = !on;
  if (on) $<HTMLInputElement>('p-floor').value = String(state.project.qualityFloor);
}

// Drag and drop
for (const type of ['dragenter', 'dragover']) {
  wrap.addEventListener(type, (e) => {
    e.preventDefault();
    wrap.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  wrap.addEventListener(type, (e) => {
    e.preventDefault();
    wrap.classList.remove('dragover');
  });
}
wrap.addEventListener('drop', (e) => {
  const files = (e as DragEvent).dataTransfer?.files;
  if (files?.length) void importFiles(files);
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  const k = selectedKeepout();
  if (k) {
    const H = vramHeight(state.project);
    const kstep = e.shiftKey ? 16 : 1;
    const nudge = (dx: number, dy: number) => {
      e.preventDefault();
      k.x = Math.max(0, Math.min(VRAM_WIDTH - k.w, k.x + dx * kstep));
      k.y = Math.max(0, Math.min(H - k.h, k.y + dy * kstep));
      update();
    };
    if (e.key === 'ArrowLeft') nudge(-1, 0);
    else if (e.key === 'ArrowRight') nudge(1, 0);
    else if (e.key === 'ArrowUp') nudge(0, -1);
    else if (e.key === 'ArrowDown') nudge(0, 1);
    else if (e.key === 'Delete' || e.key === 'Backspace') $('k-del').click();
    return;
  }

  const a = selectedAsset();
  if (!a) return;
  const step = e.shiftKey ? 16 : 1;
  const isClut = state.selected?.startsWith('clut:');
  const move = (dx: number, dy: number) => {
    e.preventDefault();
    if (isClut) {
      a.clutX = Math.max(0, a.clutX + dx * (dx ? CLUT_X_ALIGN : 1));
      a.clutY = Math.max(0, a.clutY + dy);
    } else {
      a.x = Math.max(0, a.x + dx * step);
      a.y = Math.max(0, a.y + dy * step);
    }
    update();
  };
  if (e.key === 'ArrowLeft') move(-1, 0);
  else if (e.key === 'ArrowRight') move(1, 0);
  else if (e.key === 'ArrowUp') move(0, -1);
  else if (e.key === 'ArrowDown') move(0, 1);
  else if (e.key === 'Delete' || e.key === 'Backspace') $('a-delete').click();
});

window.addEventListener('resize', () => {
  resizeCanvas();
  draw();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

resizeCanvas();
const startRect = wrap.getBoundingClientRect();
state.view = fitView(startRect.width - 16, startRect.height - 16, vramHeight(state.project));
syncProjectControls();
update();
