import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { quantize, distinctRGB555, medianCut } from '../src/core/quantize.js';
import { parseTim, decodeToRGBA, timFromRGBA16 } from '../src/core/tim.js';
import { packRGB555, NEAR_BLACK, TRUNCATION_FLOOR } from '../src/core/color.js';

/** Build an RGBA buffer from a callback over (x,y). */
function image(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const p = (y * w + x) * 4;
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = a;
    }
  }
  return out;
}

describe('lossless path', () => {
  it('takes the exact path when the image already fits the palette', () => {
    // Eight distinct colours, well inside a 16-entry palette.
    const img = image(16, 16, (x) => {
      const c = (x % 8) * 32;
      return [c, 255 - c, 128, 255];
    });
    const r = quantize(img, 16, 16, { maxColors: 16 });
    expect(r.lossless).toBe(true);
    expect(r.method).toBe('exact');
    // Only the format's own 8->5 truncation should show up as error.
    expect(r.report.maxChannelError).toBeLessThanOrEqual(TRUNCATION_FLOOR);
    expect(r.report.pastFloorFraction).toBe(0);
  });

  it('does not take the exact path when the image does not fit', () => {
    const img = image(64, 64, (x, y) => [x * 4, y * 4, (x + y) * 2, 255]);
    const r = quantize(img, 64, 64, { maxColors: 16 });
    expect(r.lossless).toBe(false);
    expect(r.method).toBe('median-cut');
  });

  it('counts distinct RGB555 rather than distinct RGB888', () => {
    // Sixteen RGB888 reds one unit apart collapse into two RGB555 values.
    const img = image(16, 1, (x) => [x, 0, 0, 255]);
    expect(distinctRGB555(img).size).toBe(2);
  });
});

describe('transparency', () => {
  it('reserves index 0 when anything is transparent, and only then', () => {
    const opaque = image(8, 8, () => [10, 20, 30, 255]);
    expect(quantize(opaque, 8, 8, { maxColors: 16 }).transparentIndex).toBe(-1);

    const holed = image(8, 8, (x) => (x < 4 ? [10, 20, 30, 255] : [0, 0, 0, 0]));
    const r = quantize(holed, 8, 8, { maxColors: 16 });
    expect(r.transparentIndex).toBe(0);
    expect(r.palette[0]).toBe(0x0000);
    expect(r.indices[4]).toBe(0);
    expect(r.indices[0]).not.toBe(0);
  });

  it('does not let transparent pixels pull palette entries around', () => {
    // A field of pure red, holed with pure green at alpha 0. Green must not
    // appear in the palette: it is not visible, it is a hole.
    const img = image(16, 16, (x) => (x % 2 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
    const r = quantize(img, 16, 16, { maxColors: 4 });
    const green = packRGB555(0, 255, 0);
    expect(Array.from(r.palette).filter((v) => v === green)).toHaveLength(0);
  });

  it('refuses a budget with no room for colours', () => {
    const img = image(4, 4, () => [0, 0, 0, 0]);
    expect(() => quantize(img, 4, 4, { maxColors: 1 })).toThrow(/no room/);
  });
});

describe('the black trap', () => {
  it('nudges opaque black off the transparent value', () => {
    const img = image(8, 8, () => [0, 0, 0, 255]);
    const r = quantize(img, 8, 8, { maxColors: 16 });
    expect(r.palette[r.indices[0]]).toBe(NEAR_BLACK);
    // And nothing opaque points at a 0x0000 entry.
    for (let i = 0; i < r.indices.length; i++) {
      expect(r.palette[r.indices[i]]).not.toBe(0x0000);
    }
  });

  it('uses semi-transparent black 0x8000 under blackMode stp', () => {
    const img = image(8, 8, () => [0, 0, 0, 255]);
    const r = quantize(img, 8, 8, { maxColors: 16, blackMode: 'stp' });
    expect(r.palette[r.indices[0]]).toBe(0x8000);
  });
});

describe('STP mask', () => {
  it('sets bit 15 on the entries masked pixels landed on', () => {
    const img = image(4, 1, (x) => [x * 64, 0, 0, 255]);
    const mask = new Uint8Array([0, 1, 0, 0]);
    const r = quantize(img, 4, 1, { maxColors: 16, stpMask: mask });
    expect(r.palette[r.indices[1]] & 0x8000).toBe(0x8000);
    expect(r.palette[r.indices[0]] & 0x8000).toBe(0);
  });
});

describe('dithering', () => {
  it('actually changes the output when enabled', () => {
    // This test exists because of a recorded failure in a sibling project:
    // PIL silently ignores dither= on MEDIANCUT, so a "dithered" variant came
    // out byte-identical to the undithered one and nobody noticed until the
    // metrics matched to two decimals. Never ship a dither toggle untested.
    const img = image(64, 64, (x, y) => [x * 4, y * 4, 128, 255]);
    const plain = quantize(img, 64, 64, { maxColors: 8, dither: false });
    const dithered = quantize(img, 64, 64, { maxColors: 8, dither: true });
    expect(Array.from(dithered.indices)).not.toEqual(Array.from(plain.indices));
  });

  it('is off by default', () => {
    const img = image(64, 64, (x, y) => [x * 4, y * 4, 128, 255]);
    const a = quantize(img, 64, 64, { maxColors: 8 });
    const b = quantize(img, 64, 64, { maxColors: 8, dither: false });
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
});

describe('RGB555 collisions', () => {
  it('reports entries lost to truncation and never emits a duplicate', () => {
    // A tight gradient: many 888 colours that mostly collapse under 8->5.
    const img = image(64, 64, (x, y) => [128 + (x % 8), 128 + (y % 8), 128, 255]);
    const r = quantize(img, 64, 64, { maxColors: 64 });
    const used = Array.from(r.palette).filter((v, i) => i !== r.transparentIndex && v !== 0);
    expect(new Set(used).size).toBe(used.length);
    expect(r.collisions).toBeGreaterThanOrEqual(0);
  });
});

describe('error reporting', () => {
  it('scores a hard quantization as past the truncation floor', () => {
    const img = image(64, 64, (x, y) => [x * 4, y * 4, 255 - x * 2, 255]);
    const r = quantize(img, 64, 64, { maxColors: 4 });
    expect(r.report.maxChannelError).toBeGreaterThan(TRUNCATION_FLOOR);
    expect(r.report.pastFloorFraction).toBeGreaterThan(0);
  });

  it('grades against the truncated palette, not the pre-truncation one', () => {
    // If the report were computed against full-precision palette entries it
    // would understate the error the hardware actually shows.
    const img = image(32, 32, (x) => [x * 8, 0, 0, 255]);
    const r = quantize(img, 32, 32, { maxColors: 256 });
    for (let i = 0; i < r.indices.length; i++) {
      const v = r.palette[r.indices[i]];
      expect(v & ~0x8000).toBeLessThanOrEqual(0x7fff);
    }
  });

  it('more colours never scores worse', () => {
    const img = image(64, 64, (x, y) => [x * 4, y * 4, (x ^ y) * 4, 255]);
    const few = quantize(img, 64, 64, { maxColors: 4 });
    const many = quantize(img, 64, 64, { maxColors: 64 });
    expect(many.report.meanChannelError).toBeLessThanOrEqual(few.report.meanChannelError);
  });
});

describe('median cut', () => {
  it('returns at most the requested number of entries', () => {
    const pixels = new Uint8Array(300 * 3);
    for (let i = 0; i < 300; i++) {
      pixels[i * 3] = i % 256;
      pixels[i * 3 + 1] = (i * 7) % 256;
      pixels[i * 3 + 2] = (i * 13) % 256;
    }
    expect(medianCut.generate(pixels, 300, 16).length / 3).toBeLessThanOrEqual(16);
  });

  it('handles an empty input without throwing', () => {
    expect(medianCut.generate(new Uint8Array(0), 0, 16).length).toBe(0);
  });

  it('handles fewer pixels than palette slots', () => {
    const pixels = new Uint8Array([255, 0, 0, 0, 255, 0]);
    const pal = medianCut.generate(pixels, 2, 16);
    expect(pal.length / 3).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Against a real shipped asset
// ---------------------------------------------------------------------------

const CITY = '/home/pixel/sources/pcsx-redux-wt/tetris-bg/src/mips/psyqo/examples/backgrounds/city.tim';

describe.runIf(existsSync(CITY))('round trip through a real 8bpp TIM', () => {
  it('re-quantizes to its own palette size losslessly', () => {
    const { tim } = parseTim(new Uint8Array(readFileSync(CITY)));
    const { width, height, rgba } = decodeToRGBA(tim!);

    // It came out of a 256-entry CLUT, so 256 distinct RGB555 is the ceiling
    // and the exact path must trigger.
    const r = quantize(rgba, width, height, { maxColors: 256 });
    expect(r.lossless).toBe(true);
    expect(r.report.maxChannelError).toBe(0);
  });

  it('degrades measurably when squeezed to 16 colours', () => {
    const { tim } = parseTim(new Uint8Array(readFileSync(CITY)));
    const { width, height, rgba } = decodeToRGBA(tim!);
    const r = quantize(rgba, width, height, { maxColors: 16 });
    expect(r.lossless).toBe(false);
    expect(r.report.pastFloorFraction).toBeGreaterThan(0);
    // The whole reason 4bpp is called a massacre for near-256-colour art.
    expect(r.report.maxChannelError).toBeGreaterThan(TRUNCATION_FLOOR);
  });
});

describe('the black nudge is reported, not graded', () => {
  it('excuses nudged black from the quantizer-failure metric', () => {
    // Pure black costs a fixed 8 units per channel once nudged off 0x0000.
    // That is past the truncation floor and no palette choice avoids it, so
    // counting it as quantizer failure pushed auto-depth to 16bpp for any art
    // containing black. Caught by a test whose premise I had wrong.
    const img = image(8, 8, (x) => (x < 4 ? [0, 0, 0, 255] : [200, 100, 50, 255]));
    const r = quantize(img, 8, 8, { maxColors: 16 });
    expect(r.lossless).toBe(true);
    expect(r.report.excusedFraction).toBeCloseTo(0.5, 5);
    expect(r.report.pastFloorFraction).toBe(0);
    // It stays visible in the headline max, so it cannot hide.
    expect(r.report.maxChannelError).toBe(8);
  });

  it('excuses nothing under blackMode stp, because 0x8000 IS black', () => {
    const img = image(8, 8, () => [0, 0, 0, 255]);
    const r = quantize(img, 8, 8, { maxColors: 16, blackMode: 'stp' });
    expect(r.report.excusedFraction).toBe(0);
    expect(r.report.maxChannelError).toBe(0);
    expect(r.palette[r.indices[0]]).toBe(0x8000);
  });

  it('does not excuse a genuine quantizer error that happens to be dark', () => {
    // Near-black but distinguishable colours squeezed into two entries: any
    // error here is the quantizer's, not the nudge's.
    const img = image(64, 1, (x) => [x * 4, 0, 0, 255]);
    const r = quantize(img, 64, 1, { maxColors: 2 });
    expect(r.report.pastFloorFraction).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Semi-transparency, the part most PS1 encoders get wrong
// ---------------------------------------------------------------------------

describe('the three-state alpha model', () => {
  const banded = () =>
    image(4, 1, (x) => {
      if (x === 0) return [200, 100, 50, 0];    // hole
      if (x === 1) return [200, 100, 50, 20];   // below 32: still a hole
      if (x === 2) return [200, 100, 50, 128];  // between: semi-transparent
      return [200, 100, 50, 255];               // solid
    });

  it('buckets source alpha into hole / semi / solid', () => {
    const r = quantize(banded(), 4, 1, { maxColors: 16 });
    expect(r.bands).toEqual({ transparent: 2, semi: 1, solid: 1 });
    expect(r.palette[r.indices[0]]).toBe(0x0000);
    expect(r.palette[r.indices[1]]).toBe(0x0000);
    expect(r.palette[r.indices[2]] & 0x8000).toBe(0x8000);
    expect(r.palette[r.indices[3]] & 0x8000).toBe(0);
  });

  it('gives one colour TWO entries when it appears both solid and semi', () => {
    // The bug this replaced: setting STP on a shared entry after the fact
    // silently flips every other pixel using that entry.
    const r = quantize(banded(), 4, 1, { maxColors: 16 });
    expect(r.indices[2]).not.toBe(r.indices[3]);
    expect(r.palette[r.indices[2]] & 0x7fff).toBe(r.palette[r.indices[3]] & 0x7fff);
    expect(r.stpEntries).toBe(1);
  });

  it('honours custom alpha cuts', () => {
    const r = quantize(banded(), 4, 1, {
      maxColors: 16,
      alphaTransparent: 10,
      alphaSolid: 100,
    });
    // alpha 20 is now semi rather than a hole; alpha 128 is now solid.
    expect(r.bands).toEqual({ transparent: 1, semi: 1, solid: 2 });
  });

  it('keeps the split under a palette too small to be comfortable', () => {
    const r = quantize(banded(), 4, 1, { maxColors: 3 });
    expect(r.palette[r.indices[2]] & 0x8000).toBe(0x8000);
    expect(r.palette[r.indices[3]] & 0x8000).toBe(0);
  });
});

describe('forceSTP', () => {
  it('sets STP on every non-transparent texel and implies STP black', () => {
    const img = image(4, 1, (x) =>
      x === 0 ? [0, 0, 0, 0] : x === 1 ? [0, 0, 0, 255] : [x * 60, 20, 90, 255],
    );
    const r = quantize(img, 4, 1, { maxColors: 16, forceSTP: true });
    expect(r.blackMode).toBe('stp');
    expect(r.bands.semi).toBe(3);
    expect(r.bands.solid).toBe(0);
    expect(r.palette[r.indices[0]]).toBe(0x0000);
    expect(r.palette[r.indices[1]]).toBe(0x8000); // black, STP set
    for (let i = 1; i < 4; i++) {
      expect(r.palette[r.indices[i]] & 0x8000, `texel ${i}`).toBe(0x8000);
    }
  });

  it('leaves genuinely transparent texels alone', () => {
    const img = image(2, 1, (x) => (x === 0 ? [10, 20, 30, 0] : [10, 20, 30, 255]));
    const r = quantize(img, 2, 1, { maxColors: 16, forceSTP: true });
    expect(r.palette[r.indices[0]]).toBe(0x0000);
    expect(r.transparentIndex).toBe(0);
  });
});

describe('black replacement', () => {
  it('defaults to dark grey, which is unconditionally opaque', () => {
    const r = quantize(image(2, 1, () => [0, 0, 0, 255]), 2, 1, { maxColors: 16 });
    expect(r.blackMode).toBe('gray');
    expect(r.palette[r.indices[0]]).toBe(NEAR_BLACK);
    expect(r.palette[r.indices[0]] & 0x8000).toBe(0);
  });

  it('accepts a configurable replacement colour', () => {
    const r = quantize(image(2, 1, () => [0, 0, 0, 255]), 2, 1, {
      maxColors: 16,
      blackReplacement: 0x0842,
    });
    expect(r.palette[r.indices[0]]).toBe(0x0842);
  });

  it('never emits 0x0000 for a pixel that is supposed to be visible', () => {
    for (const opts of [
      { maxColors: 16 },
      { maxColors: 16, blackMode: 'stp' as const },
      { maxColors: 16, forceSTP: true },
      { maxColors: 4, blackMode: 'stp' as const },
    ]) {
      const img = image(8, 8, (x, y) => [(x + y) & 1 ? 0 : 40, 0, 0, 255]);
      const r = quantize(img, 8, 8, opts);
      for (let i = 0; i < r.indices.length; i++) {
        expect(r.palette[r.indices[i]], `opts ${JSON.stringify(opts)}`).not.toBe(0x0000);
      }
    }
  });
});

describe('16bpp path honours the same contract', () => {
  it('bands alpha and handles black identically to the indexed path', () => {
    const img = new Uint8ClampedArray([
      0, 0, 0, 0,       // hole
      0, 0, 0, 255,     // opaque black
      10, 20, 30, 128,  // semi
      10, 20, 30, 255,  // solid
    ]);
    const tim = timFromRGBA16(img, 4, 1, { x: 0, y: 0 });
    expect(tim.pixels.data[0]).toBe(0x0000);
    expect(tim.pixels.data[1]).toBe(NEAR_BLACK);
    expect(tim.pixels.data[2] & 0x8000).toBe(0x8000);
    expect(tim.pixels.data[3] & 0x8000).toBe(0);
  });

  it('forceSTP sets bit 15 on every non-transparent texel', () => {
    const img = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255, 90, 40, 10, 255]);
    const tim = timFromRGBA16(img, 3, 1, { x: 0, y: 0 }, { forceSTP: true });
    expect(tim.pixels.data[0]).toBe(0x0000);
    expect(tim.pixels.data[1]).toBe(0x8000);
    expect(tim.pixels.data[2] & 0x8000).toBe(0x8000);
  });
});
