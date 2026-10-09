// Regenerates the screenshots in public/manual/.
//
//   node manual/shoot.mjs [url]
//
// url defaults to the local build (dist/index.html). Point it at
// https://tools.psx.dev/timweb/ to shoot the deployed site instead.
// The sample art is drawn procedurally in the page, so nothing here depends
// on files outside the repository. Arrows and labels are an SVG layer added
// on top of the live page just before each capture; the app underneath is
// untouched.

import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'public', 'manual');
const URL = process.argv[2] ?? pathToFileURL(resolve(here, '..', 'dist', 'index.html')).href;
const CHROME = process.env.CHROME ?? '/usr/bin/chromium';
const ONLY = process.env.ONLY;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL);
await page.waitForSelector('#canvas');

// ---- sample art, drawn in the page ----------------------------------------

async function png(width, height, body) {
  const url = await page.evaluate(([w, h, b]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    new Function('cx', 'w', 'h', b)(cx, w, h);
    return c.toDataURL('image/png');
  }, [width, height, body]);
  return Buffer.from(url.split(',')[1], 'base64');
}

async function importPngs(files) {
  await page.setInputFiles('#file-images', files.map((f) => ({ name: f.name, mimeType: 'image/png', buffer: f.buffer })));
  const names = files.map((f) => f.name.replace(/\.png$/, ''));
  await page.waitForFunction((ns) => {
    const have = Array.from(document.querySelectorAll('#assets li .name')).map((e) => e.textContent);
    return ns.every((n) => have.includes(n));
  }, names, { timeout: 30_000 });
}

// A 4bpp TIM carrying two CLUT rows, written by hand so the palette-row
// control has something to show.
function twoPaletteTim() {
  const w = 32, h = 32;
  const clut = [];
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const [r, g, b] = row === 0 ? [t, t * 0.6, 0.2] : [0.2, t * 0.7, t];
      const c = (Math.round(r * 31)) | (Math.round(g * 31) << 5) | (Math.round(b * 31) << 10);
      clut.push(i === 0 ? 0 : c || 0x0421);
    }
  }
  const pix = new Uint8Array((w * h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5);
      const v = d > 15 ? 0 : Math.min(15, 1 + Math.floor((15 - d) * ((x + y) % 7 === 0 ? 0.6 : 1)));
      const idx = y * w + x;
      pix[idx >> 1] |= (idx & 1) ? v << 4 : v;
    }
  }
  const clutBytes = 12 + clut.length * 2;
  const pixBytes = 12 + pix.length;
  const buf = Buffer.alloc(8 + clutBytes + pixBytes);
  let o = 0;
  buf.writeUInt32LE(0x10, o); o += 4;
  buf.writeUInt32LE(0x08, o); o += 4;
  buf.writeUInt32LE(clutBytes, o); o += 4;
  buf.writeUInt16LE(0, o); buf.writeUInt16LE(490, o + 2); buf.writeUInt16LE(16, o + 4); buf.writeUInt16LE(2, o + 6); o += 8;
  for (const c of clut) { buf.writeUInt16LE(c, o); o += 2; }
  buf.writeUInt32LE(pixBytes, o); o += 4;
  buf.writeUInt16LE(640, o); buf.writeUInt16LE(256, o + 2); buf.writeUInt16LE(w / 4, o + 4); buf.writeUInt16LE(h, o + 6); o += 8;
  Buffer.from(pix).copy(buf, o);
  return buf;
}

// ---- annotation layer -------------------------------------------------------

// notes: [{ sel, text, dx, dy, pad? }]. The label is placed at the target's
// centre plus (dx, dy); the arrow runs from the label to the target's edge.
async function annotate(notes) {
  await page.evaluate((ns) => {
    document.getElementById('__manual')?.remove();
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.id = '__manual';
    Object.assign(svg.style, { position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 99999 });
    svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ffcc33"/></marker></defs>';
    document.body.appendChild(svg);
    const add = (tag, attrs) => {
      const e = document.createElementNS(svgNS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.appendChild(e);
      return e;
    };
    const labels = [];
    ns.forEach((n, i) => {
      let r;
      if (n.rect) {
        r = { left: n.rect[0], top: n.rect[1], width: n.rect[2], height: n.rect[3] };
      } else {
        const el = document.querySelector(n.sel);
        if (!el) throw new Error('annotate: no element for ' + n.sel);
        r = el.getBoundingClientRect();
      }
      const pad = n.pad ?? 3;
      const box = { x: r.left - pad, y: r.top - pad, w: r.width + 2 * pad, h: r.height + 2 * pad };
      add('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 4, fill: 'none', stroke: '#ffcc33', 'stroke-width': 2.5 });
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const label = `${i + 1}. ${n.text}`;
      const lines = label.split('\n');
      const meas = document.createElement('canvas').getContext('2d');
      meas.font = '13px ui-monospace, monospace';
      const lw = Math.max(...lines.map((l) => meas.measureText(l).width)) + 18;
      const lh = lines.length * 17 + 10;
      // `drop: y` hangs the label below its target with its right edge just
      // past the target's centre and a vertical arrow, so a row of targets
      // dropped at increasing depth, left to right, never crosses arrows.
      let lx = n.drop !== undefined ? cx + 14 - lw / 2 : n.at ? n.at[0] : cx + n.dx;
      let ly = n.drop !== undefined ? n.drop : n.at ? n.at[1] : cy + n.dy;
      lx = Math.max(lw / 2 + 4, Math.min(innerWidth - lw / 2 - 4, lx));
      ly = Math.max(lh / 2 + 4, Math.min(innerHeight - lh / 2 - 4, ly));
      // Arrow end: where the segment label->centre crosses the box edge.
      const vx = cx - lx, vy = cy - ly;
      const tx = vx === 0 ? Infinity : Math.abs((box.w / 2) / vx);
      const ty = vy === 0 ? Infinity : Math.abs((box.h / 2) / vy);
      const t = Math.min(tx, ty);
      const ex = cx - vx * t, ey = cy - vy * t;
      const inside = lx > box.x && lx < box.x + box.w && ly > box.y && ly < box.y + box.h;
      if (n.drop !== undefined) add('line', { x1: cx, y1: ly - lh / 2, x2: cx, y2: box.y + box.h, stroke: '#ffcc33', 'stroke-width': 2.5, 'marker-end': 'url(#ah)' });
      else if (!inside) add('line', { x1: lx, y1: ly, x2: ex, y2: ey, stroke: '#ffcc33', 'stroke-width': 2.5, 'marker-end': 'url(#ah)' });
      labels.push(() => {
      add('rect', { x: lx - lw / 2, y: ly - lh / 2, width: lw, height: lh, rx: 5, fill: '#1b1b1f', stroke: '#ffcc33', 'stroke-width': 1.5 });
      lines.forEach((l, j) => {
        const tEl = add('text', { x: lx, y: ly - lh / 2 + 19 + j * 17, fill: '#ffe9a8', 'text-anchor': 'middle', 'font-family': 'ui-monospace, monospace', 'font-size': 13 });
        tEl.textContent = l;
      });
      });
    });
    labels.forEach((f) => f());
  }, notes);
}

async function shot(name, notes, clip) {
  if (ONLY && ONLY !== name) return;
  await annotate(notes);
  await page.screenshot({ path: resolve(OUT, name + '.png'), clip });
  await page.evaluate(() => document.getElementById('__manual')?.remove());
  console.log('wrote', name);
}

async function reveal(sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    const panel = el.closest('.panel');
    panel.scrollTop = 0;
    panel.scrollTop = el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8;
  }, sel);
}

async function select(name) {
  await page.locator('#assets li', { hasText: name }).first().click();
  await page.waitForSelector('#inspector:not(.hidden)');
}

// ---- the tour ----------------------------------------------------------------

const scene = await import('./scenes.mjs');
const ctx = { page, png, importPngs, twoPaletteTim, annotate, shot, select, reveal };
await scene.run(ctx);
await scene.tail(ctx);

await browser.close();
if (errors.length) {
  console.error('page errors:\n' + errors.join('\n'));
  process.exit(1);
}
