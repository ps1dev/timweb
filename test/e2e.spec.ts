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

  it('loads from file:// with no console or page errors', async () => {
    // Positive control first. An empty array is the one result that carries
    // no information about whether the instrument works, and there are four
    // assertions in this file whose entire pass condition is an empty array.
    // Prove the listener is live, then take the canary back out.
    await page.evaluate(() => console.error('e2e-canary'));
    await page.waitForFunction(() => true);
    const canary = consoleErrors.indexOf('e2e-canary');
    expect(canary, 'console listener is not wired - every empty-array assertion below is blind').toBeGreaterThanOrEqual(0);
    consoleErrors.splice(canary, 1);

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

    // Import auto-selects, so clicking the list entry is a no-op unless we
    // clear the selection first - and every readout below was already
    // populated. Deselect through the canvas so the click is the thing that
    // brings the inspector back, which is the only coverage the list click
    // handler gets anywhere in this suite.
    // Viewport (4,4) is chrome, not canvas - no pointerdown reaches the
    // handler and the selection survives. Go through the canvas box.
    const cbox = (await page.locator('#canvas').boundingBox())!;
    await page.mouse.click(cbox.x + 8, cbox.y + cbox.height - 8);
    await page.waitForTimeout(120);
    expect(await page.locator('#inspector').isVisible(), 'selection did not clear').toBe(false);
    await page.click('#assets li');
    await page.waitForTimeout(120);
    expect(await page.locator('#inspector').isVisible()).toBe(true);

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
    // should say so rather than quietly reporting a small mean. Pin the
    // pre-state first: if auto-depth already chose 4bpp then selectOption
    // changes nothing and every assertion below is satisfied before the act.
    // Measured, not assumed: auto-depth puts this gradient at 16bpp, so the
    // pre-state readouts are 'direct colour' / '<= 7' and every assertion
    // below genuinely discriminates. Pinned so an auto-depth regression that
    // pre-satisfies them fails here instead of silently.
    expect(await page.inputValue('#a-depth')).toBe(String(TimType.Bpp16));
    await page.selectOption('#a-depth', String(TimType.Bpp4));
    // Wait for the value we actually want. The old predicate was
    // `!== 'exact (no loss)'`, which was already true at 16bpp ('direct
    // colour') and so returned on its first poll, synchronising nothing.
    await page.waitForFunction(() => document.getElementById('q-method')?.textContent === 'median-cut');
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
    // BOTH ends, because the claim is that the slider MOVED it. Asserting
    // only the 16bpp end passes just as well on an asset pinned to 16bpp,
    // and Bpp16 is the largest enum value so `dear >= cheap` cannot fail
    // once that first assertion holds - it looked like the direction check
    // and was not one.
    expect(cheap).toBe(String(TimType.Bpp4));
    expect(dear).toBe(String(TimType.Bpp16));
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
      return (window as unknown as { __timweb?: unknown }).__timweb === undefined;
    });
    // The shipped build exposes no test hook, by design. Asserted, rather than
    // assumed: the previous version of this returned null down both branches.
    expect(b64).toBe(true);

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

describe('automatic placement through the UI', () => {
  // Two assets driven on top of each other, then packed apart. The overlap is
  // established first so the pass has something to undo - a packer that did
  // nothing would leave the issue standing.
  it('imports a second asset and stacks it on the first', async () => {
    const png = await makePng(64, 48, 'for (let i=0;i<w*h;i++){data[i*4]=(i*7)&255;data[i*4+1]=(i*13)&255;data[i*4+2]=90;data[i*4+3]=255;}');
    await importPng('packme.png', png);

    // Put both at the same spot by hand.
    await page.click('#assets li:first-child');
    await page.fill('#a-x', '600');
    await page.dispatchEvent('#a-x', 'change');
    await page.fill('#a-y', '300');
    await page.dispatchEvent('#a-y', 'change');

    await page.click('#assets li:nth-child(2)');
    await page.fill('#a-x', '600');
    await page.dispatchEvent('#a-x', 'change');
    await page.fill('#a-y', '300');
    await page.dispatchEvent('#a-y', 'change');

    await page.waitForFunction(
      () => (document.getElementById('vram-overlap')?.textContent ?? '0 hw') !== '0 hw',
      undefined,
      { timeout: 15_000 },
    );
  });

  it('separates them and clears the overlap', async () => {
    await page.click('#btn-pack');
    await page.waitForFunction(
      () => document.getElementById('vram-overlap')?.textContent === '0 hw',
      undefined,
      { timeout: 15_000 },
    );
    expect(await page.textContent('#s-issues')).toBe('0 issues');
  });

  it('holds an excluded asset in place while moving the rest', async () => {
    // Park the second asset somewhere known, exclude it, drive the first one
    // on top of it, then pack. The excluded one must not have budged.
    await page.click('#assets li:nth-child(2)');
    await page.fill('#a-x', '700');
    await page.dispatchEvent('#a-x', 'change');
    await page.fill('#a-y', '320');
    await page.dispatchEvent('#a-y', 'change');
    await page.check('#a-nopack');

    const before = await page.evaluate(() => ({
      x: (document.getElementById('a-x') as HTMLInputElement).value,
      y: (document.getElementById('a-y') as HTMLInputElement).value,
    }));

    await page.click('#assets li:first-child');
    await page.fill('#a-x', '700');
    await page.dispatchEvent('#a-x', 'change');
    await page.fill('#a-y', '320');
    await page.dispatchEvent('#a-y', 'change');

    await page.click('#btn-pack');
    await page.waitForFunction(
      () => document.getElementById('vram-overlap')?.textContent === '0 hw',
      undefined,
      { timeout: 15_000 },
    );

    await page.click('#assets li:nth-child(2)');
    const after = await page.evaluate(() => ({
      x: (document.getElementById('a-x') as HTMLInputElement).value,
      y: (document.getElementById('a-y') as HTMLInputElement).value,
      excluded: (document.getElementById('a-nopack') as HTMLInputElement).checked,
      locked: (document.getElementById('a-locked') as HTMLInputElement).checked,
    }));
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    // The exclusion did its work WITHOUT the lock, which is the whole point of
    // the two being separate toggles.
    expect(after.excluded).toBe(true);
    expect(after.locked).toBe(false);

    // Discriminator: the other asset really was moved off the shared spot.
    await page.click('#assets li:first-child');
    const moved = await page.evaluate(() => ({
      x: (document.getElementById('a-x') as HTMLInputElement).value,
      y: (document.getElementById('a-y') as HTMLInputElement).value,
    }));
    expect([moved.x, moved.y]).not.toEqual(['700', '320']);

    await page.click('#assets li:nth-child(2)');
    await page.uncheck('#a-nopack');
  });
});

describe('no errors accumulated during the whole session', () => {
  it('logged nothing to the console and threw nothing', () => {
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pointer/render agreement at a non-unit device pixel ratio
// ---------------------------------------------------------------------------

/**
 * Everything above runs at Playwright's default deviceScaleFactor of 1, and at
 * dpr 1 a whole class of transform bug is invisible: if drawing and
 * hit-testing disagree by a factor of dpr, the two agree exactly when dpr is 1.
 *
 * That is not hypothetical. `render()` opened with a setTransform that threw
 * away the caller's dpr scale, so on any HiDPI display every object drew at
 * half the position the pointer maths expected - reported by the repo owner
 * after the tool had shipped a green suite for a week. The suite could not
 * have caught it, and one screenshot script pinned deviceScaleFactor to 1
 * explicitly.
 *
 * So: a second browser at dpr 2, asserting that clicking where the app's own
 * screen mapping says a thing is actually selects that thing. That inverse
 * consistency has to hold at every dpr.
 */
describe('pointer and render agree at dpr 2', () => {
  let hi: Browser;
  let hp: Page;
  const hiErrors: string[] = [];

  beforeAll(async () => {
    hi = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    hp = await hi.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
    hp.on('pageerror', (e) => hiErrors.push(e.message));
    await hp.goto(`file://${DIST}`);
    await hp.waitForSelector('#canvas');
  }, 120_000);

  afterAll(async () => {
    await hi?.close();
  });

  it('confirms the browser really is at dpr 2', async () => {
    // A control: if this drops to 1 the rest of the block proves nothing.
    expect(await hp.evaluate(() => window.devicePixelRatio)).toBe(2);
  });

  it('selects the asset under the pointer, not one scaled away from it', async () => {
    const png = await hp.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const cx = c.getContext('2d')!;
      const img = cx.createImageData(64, 64);
      for (let i = 0; i < 64 * 64; i++) {
        img.data[i * 4] = (i % 6) * 40;
        img.data[i * 4 + 1] = 180;
        img.data[i * 4 + 2] = 70;
        img.data[i * 4 + 3] = 255;
      }
      cx.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    });
    await hp.setInputFiles('#file-images', {
      name: 'target.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png.split(',')[1], 'base64'),
    });
    await hp.waitForFunction(() => document.querySelectorAll('#assets li').length === 1);

    // 16bpp so it is 64 halfwords wide rather than 16 - a bigger target, and
    // the depth does not matter to the transform under test.
    await hp.click('#assets li');
    await hp.uncheck('#a-auto');
    await hp.selectOption('#a-depth', String(TimType.Bpp16));
    await hp.fill('#a-x', '700');
    await hp.dispatchEvent('#a-x', 'change');
    await hp.fill('#a-y', '300');
    await hp.dispatchEvent('#a-y', 'change');
    await hp.click('#btn-fit');
    await hp.waitForTimeout(200);

    const box = (await hp.locator('#canvas').boundingBox())!;

    // Derive the screen<->VRAM mapping from the app's OWN pointer path, by
    // probing two positions and reading the coordinate it reports. The test
    // must not reimplement the maths it is checking.
    const probe = async (sx: number, sy: number) => {
      await hp.mouse.move(box.x + sx, box.y + sy);
      await hp.waitForTimeout(40);
      const raw = (await hp.textContent('#s-hover')) ?? '';
      // An EMPTY readout means the pointer was outside the VRAM field, which
      // is what the first version of this probe hit: at fit, VRAM is centred
      // vertically, so a point 120px down the canvas is above it. An empty
      // string parses to [0] and NaN, and only the NaN showed up - 200 lines
      // later, as an unexplained failure.
      expect(raw, `no readout at ${sx},${sy} - probe is outside the VRAM field`).toMatch(/^\d+,\d+$/);
      const [x, y] = raw.split(',').map(Number);
      return { x, y };
    };
    // Probe from the centre outward, where VRAM certainly is at fit.
    const cx = box.width / 2;
    const cy = box.height / 2;
    const p0 = await probe(cx - 100, cy - 100);
    const p1 = await probe(cx + 100, cy + 100);
    const scaleX = (p1.x - p0.x) / 200;
    const scaleY = (p1.y - p0.y) / 200;
    expect(scaleX, 'degenerate mapping').toBeGreaterThan(0);
    expect(scaleY).toBeGreaterThan(0);

    // Aim at the middle of the texture: VRAM 700..764 x 300..364.
    const sx = cx - 100 + (732 - p0.x) / scaleX;
    const sy = cy - 100 + (332 - p0.y) / scaleY;

    // Positive control. If the target is off-canvas the click lands nowhere,
    // getImageData reads out of bounds and returns zeros, and every assertion
    // below becomes vacuous. That is exactly how the first version of this
    // test reported a pass it had not earned.
    expect(sx, 'target off canvas').toBeGreaterThan(0);
    expect(sx).toBeLessThan(box.width);
    expect(sy).toBeGreaterThan(0);
    expect(sy).toBeLessThan(box.height);

    // Clear the selection first, or "the inspector is visible" is already true
    // and the assertion has no power.
    await hp.mouse.click(box.x + 8, box.y + box.height - 8);
    await hp.waitForTimeout(120);
    expect(await hp.locator('#inspector').isVisible(), 'selection did not clear').toBe(false);

    await hp.mouse.click(box.x + sx, box.y + sy);
    await hp.waitForTimeout(150);
    expect(await hp.locator('#inspector').isVisible()).toBe(true);
    // The visibility flip above is the discriminator, because the corner
    // click cleared it. `#a-x` deliberately is NOT checked here: renderInspector
    // returns before touching any input when nothing is selected, so the field
    // still reads 700 through the hidden panel - and with one asset in the
    // project it could not tell "selected the right one" from "selected the
    // only one" even if it did clear.

    // And the drawn pixels are where the pointer says they are.
    const hit = await hp.evaluate(
      ([px, py]) => {
        const c = document.getElementById('canvas') as HTMLCanvasElement;
        const dpr = window.devicePixelRatio || 1;
        const d = c
          .getContext('2d')!
          .getImageData(Math.round((px as number) * dpr), Math.round((py as number) * dpr), 1, 1).data;
        return [d[0], d[1], d[2]];
      },
      [sx, sy] as const,
    );
    expect(hit[1], `sampled rgb(${hit}) at ${Math.round(sx)},${Math.round(sy)}`).toBeGreaterThan(120);
  });

  it('threw nothing along the way', () => {
    expect(hiErrors).toEqual([]);
  });
});
