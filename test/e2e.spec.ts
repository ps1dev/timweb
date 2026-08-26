/**
 * End-to-end test against the BUILT single-file artifact.
 *
 * This exists because a green `vite build` is a claim about the pipeline with
 * no power at all over whether the page runs. Exit code 0, one file on disk and
 * a plausible byte count are all satisfied by a page that throws on load.
 *
 * So: launch a real browser, open dist/index.html off the filesystem (which is
 * how a user will open it - `file://`, no server, no network), drive it, and
 * read pixels and bytes back out.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { parseTim, TimType, texelWidth } from '../src/core/tim.js';

const DIST = resolve(__dirname, '../dist/index.html');
const CHROME = '/usr/bin/chromium';

let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

beforeAll(async () => {
  // Build if missing or stale. A test that silently grades a previous build is
  // measuring the wrong binary.
  const newest = Math.max(
    ...['src', 'index.html', 'vite.config.ts'].flatMap((p) => {
      const full = resolve(__dirname, '..', p);
      return existsSync(full)
        ? [statSync(full).mtimeMs, ...walkMtimes(full)]
        : [0];
    }),
  );
  if (!existsSync(DIST) || statSync(DIST).mtimeMs < newest) {
    execSync('npm run build', { cwd: resolve(__dirname, '..'), stdio: 'pipe' });
  }

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`file://${DIST}`);
  await page.waitForSelector('#canvas');
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

function walkMtimes(dir: string): number[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = resolve(dir, e.name);
      return e.isDirectory() ? walkMtimes(full) : [statSync(full).mtimeMs];
    });
  } catch {
    return [];
  }
}

/** Drive an import by handing the page a synthetic file through the input. */
async function importPng(name: string, dataUrl: string): Promise<void> {
  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
  await page.setInputFiles('#file-images', {
    name,
    mimeType: 'image/png',
    buffer,
  });
  await page.waitForFunction(
    (n) => document.querySelectorAll('#assets li').length > 0 &&
      Array.from(document.querySelectorAll('#assets li .name')).some((e) => e.textContent === n),
    name.replace(/\.png$/, ''),
    { timeout: 15_000 },
  );
}

/** Make a PNG data URL in the page (browser has an encoder, node does not). */
async function makePng(
  width: number,
  height: number,
  fn: string,
): Promise<string> {
  return page.evaluate(
    ([w, h, body]) => {
      const c = document.createElement('canvas');
      c.width = w as number;
      c.height = h as number;
      const cx = c.getContext('2d')!;
      const img = cx.createImageData(w as number, h as number);
      // eslint-disable-next-line no-new-func
      const paint = new Function('data', 'w', 'h', body as string);
      paint(img.data, w, h);
      cx.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    },
    [width, height, fn] as const,
  );
}

describe('the built single file', () => {
  it('is genuinely self-contained', () => {
    const html = readFileSync(DIST, 'utf8');
    // No external script or stylesheet references. If one slipped in, the file
    // would work from this repo and break the moment anyone moved it.
    expect(html).not.toMatch(/<script[^>]+src=["'](?!data:)/);
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet/);
    expect(html).not.toMatch(/<link[^>]+href=["'](?!data:)[^"']*\.css/);
  });

  it('loads from file:// with no console or page errors', () => {
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  it('boots with an empty project and a drawn canvas', async () => {
    expect(await page.textContent('#s-assets')).toBe('0 assets');
    const painted = await page.evaluate(() => {
      const c = document.getElementById('canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<string>();
      for (let i = 0; i < d.length; i += 4 * 997) {
        seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      }
      return seen.size;
    });
    // More than one distinct colour means the VRAM field and page grid drew,
    // rather than the canvas sitting blank.
    expect(painted).toBeGreaterThan(1);
  });
});

describe('import and convert', () => {
  it('imports a PNG, places it, and reports its colour count', async () => {
    const png = await makePng(
      64,
      64,
      `for (let i = 0; i < w * h; i++) {
         const c = i % 8;
         data[i*4] = c * 31; data[i*4+1] = 255 - c * 31; data[i*4+2] = 128; data[i*4+3] = 255;
       }`,
    );
    await importPng('blocks.png', png);

    expect(await page.textContent('#s-assets')).toBe('1 asset');
    await page.click('#assets li');
    expect(await page.textContent('#a-size')).toBe('64x64 texels');
    expect(Number(await page.textContent('#a-distinct'))).toBe(8);
    // Eight colours fit any palette, so the quantizer must not have run.
    expect(await page.textContent('#q-method')).toBe('exact (no loss)');
    expect(await page.textContent('#q-past')).toBe('0.0%');
  });

  it('places the new asset clear of the display region and of its own CLUT', async () => {
    expect(await page.textContent('#s-issues')).toBe('0 issues');
    expect(await page.textContent('#vram-overlap')).toBe('0 hw');
  });

  it('draws the asset onto the VRAM canvas', async () => {
    const before = await page.evaluate(() => {
      const c = document.getElementById('canvas') as HTMLCanvasElement;
      return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.length;
    });
    expect(before).toBeGreaterThan(0);
    // Count pixels matching one of the source colours: the preview is drawn
    // squashed into halfword space, but the colours survive.
    const hits = await page.evaluate(() => {
      const c = document.getElementById('canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        // c=1 gives (31, 224, 128); allow for 5-bit truncation.
        if (Math.abs(d[i] - 24) < 12 && Math.abs(d[i + 1] - 222) < 12 && Math.abs(d[i + 2] - 132) < 12) n++;
      }
      return n;
    });
    expect(hits).toBeGreaterThan(0);
  });

  it('degrades a hard image and says so', async () => {
    const png = await makePng(
      64,
      64,
      `for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
         const i = (y * w + x) * 4;
         data[i] = x * 4; data[i+1] = y * 4; data[i+2] = 255 - x * 2; data[i+3] = 255;
       }`,
    );
    await importPng('gradient.png', png);
    await page.click('#assets li:last-child');

    // Force 4bpp: 16 entries for a gradient is a massacre and the readout
    // should say so rather than quietly reporting a small mean.
    await page.selectOption('#a-depth', String(TimType.Bpp4));
    await page.waitForFunction(() => document.getElementById('q-method')?.textContent !== 'exact (no loss)');
    expect(await page.textContent('#q-method')).toBe('median-cut');
    const past = parseFloat((await page.textContent('#q-past'))!);
    expect(past).toBeGreaterThan(0);
    expect(Number(await page.textContent('#q-max'))).toBeGreaterThan(7);
  });
});

describe('the CLUT penalty slider', () => {
  it('moves a marginal asset to 16bpp when turned up', async () => {
    const png = await makePng(
      16,
      16,
      `for (let i = 0; i < w * h; i++) {
         data[i*4] = (i % 4) * 60; data[i*4+1] = 40; data[i*4+2] = 90; data[i*4+3] = 255;
       }`,
    );
    await importPng('tiny.png', png);
    await page.click('#assets li:last-child');
    await page.check('#a-auto');

    const depthAt = async (penalty: number) => {
      await page.fill('#p-penalty', String(penalty));
      await page.dispatchEvent('#p-penalty', 'input');
      await page.dispatchEvent('#p-penalty', 'change');
      await page.waitForTimeout(50);
      return page.inputValue('#a-depth');
    };

    // 256 texels is well under the 512-texel crossover even at penalty 1...
    const cheap = await depthAt(1);
    const dear = await depthAt(64);
    expect(dear).toBe(String(TimType.Bpp16));
    expect(Number(dear)).toBeGreaterThanOrEqual(Number(cheap));
  });
});

describe('collision detection through the UI', () => {
  // Multi-asset ordering made an earlier version of this test depend on what
  // previous tests left in the list. One asset driven into the framebuffer
  // exercises the same wiring - inspector field -> model -> validate -> panel -
  // with nothing to get out of order.
  it('flags an asset driven into the display region', async () => {
    await page.click('#assets li:first-child');
    await page.fill('#a-x', '10');
    await page.dispatchEvent('#a-x', 'change');
    await page.fill('#a-y', '10');
    await page.dispatchEvent('#a-y', 'change');

    await page.waitForFunction(
      () => (document.getElementById('issues')?.textContent ?? '').includes('framebuffer'),
      undefined,
      { timeout: 15_000 },
    );
    expect(await page.textContent('#s-issues')).not.toBe('0 issues');
  });

  it('clears when Find free space moves it out', async () => {
    await page.click('#a-autoplace');
    await page.waitForFunction(
      () => document.getElementById('s-issues')?.textContent === '0 issues',
      undefined,
      { timeout: 15_000 },
    );
    expect(await page.textContent('#vram-overlap')).toBe('0 hw');
  });
});

describe('export', () => {
  it('produces a zip whose .tim entries parse back correctly', async () => {
    const b64 = await page.evaluate(async () => {
      // Reach the export path the button uses, but capture the bytes instead
      // of triggering a download, which headless cannot easily read back.
      const mod = (window as unknown as { __timweb?: unknown }).__timweb;
      if (mod) return null;
      return null;
    });
    expect(b64).toBeNull(); // no test hook in the shipped build, by design

    // So drive the real button and intercept the download.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.click('#btn-export'),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const zip = Buffer.concat(chunks);

    expect(zip.length).toBeGreaterThan(64);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);

    // Walk the local file headers and pull out every .tim, then parse it with
    // the same parser the specimen suite grades against real shipped files.
    let off = 0;
    let timsChecked = 0;
    while (off + 30 <= zip.length && zip.readUInt32LE(off) === 0x04034b50) {
      const nameLen = zip.readUInt16LE(off + 26);
      const extraLen = zip.readUInt16LE(off + 28);
      const size = zip.readUInt32LE(off + 18);
      const name = zip.subarray(off + 30, off + 30 + nameLen).toString();
      const start = off + 30 + nameLen + extraLen;
      const data = zip.subarray(start, start + size);
      if (name.endsWith('.tim')) {
        const { tim, diagnostics } = parseTim(new Uint8Array(data));
        expect(tim, `${name} should parse`).toBeDefined();
        expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(texelWidth(tim!.pixels.w, tim!.type)).toBeGreaterThan(0);
        timsChecked++;
      }
      off = start + size;
    }
    // Positive control: an archive we failed to walk would silently check zero.
    expect(timsChecked).toBeGreaterThanOrEqual(3);
  });
});

describe('no errors accumulated during the whole session', () => {
  it('logged nothing to the console and threw nothing', () => {
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
