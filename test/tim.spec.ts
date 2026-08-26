/**
 * TIM parser tests, graded against REAL shipped .tim files rather than
 * fixtures this project generated. A fixture built by our own serializer would
 * only prove the serializer agrees with itself.
 *
 * The corpus is on-disk specimens from psn00bsdk, nolibgs_hello_worlds, n00brom
 * and a game hack. Their expected values were measured independently (hexdump +
 * a standalone Python walker) before this parser existed.
 *
 * Note the corpus guard at the bottom of the describe block: if none of these
 * paths resolve, an "all tests passed" run would be vacuous. The guard fails
 * loudly instead.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  parseTim,
  serializeTim,
  texelWidth,
  halfwordWidth,
  getTexel,
  setTexel,
  palette,
  paletteCount,
  timFromRGBA16,
  timFromIndexed,
  parseSplit,
  serializeSplit,
  timToSplit,
  splitToTim,
  PXL_ID,
  CLT_ID,
  TimType,
} from '../src/core/tim.js';
import {
  packRGB555,
  unpackRGB555,
  nudgeBlack,
  scoreAgainstSource,
  countDistinct,
  NEAR_BLACK,
} from '../src/core/color.js';

const SPECIMENS = {
  tim4: '/home/pixel/sources/nolibgs_hello_worlds/TIM/TIM4.tim',
  tim8: '/home/pixel/sources/nolibgs_hello_worlds/TIM/TIM8.tim',
  tim16: '/home/pixel/sources/nolibgs_hello_worlds/TIM/TIM16.tim',
  dbugfont: '/home/pixel/sources/psn00bsdk/libpsn00b/psxgpu/dbugfont.tim',
  gteTexture: '/home/pixel/sources/psn00bsdk/examples/graphics/gte/texture.tim',
  bunpattern: '/home/pixel/sources/psn00bsdk/examples/graphics/rgb24/bunpattern.tim',
  n00bromFont: '/home/pixel/sources/n00brom/trunk/font.tim',
  multiPalette: '/home/pixel/sources/VP-hack/main-menu/00007.tim',
} as const;

const found = Object.entries(SPECIMENS).filter(([, p]) => existsSync(p));
const has = (k: keyof typeof SPECIMENS) => existsSync(SPECIMENS[k]);
const load = (k: keyof typeof SPECIMENS) => new Uint8Array(readFileSync(SPECIMENS[k]));

describe('corpus', () => {
  it('resolves enough on-disk specimens to be meaningful', () => {
    // Positive control. An empty corpus makes every specimen test below skip,
    // and a suite of skipped tests reports green.
    expect(found.length, `only found: ${found.map(([k]) => k).join(', ') || '(none)'}`).toBeGreaterThanOrEqual(4);
  });
});

describe('halfword <-> texel width', () => {
  it('converts each depth the way the format does', () => {
    expect(texelWidth(16, TimType.Bpp4)).toBe(64);
    expect(texelWidth(32, TimType.Bpp8)).toBe(64);
    expect(texelWidth(64, TimType.Bpp16)).toBe(64);
    expect(texelWidth(960, TimType.Bpp24)).toBe(640);
  });

  it('round-trips back to halfwords', () => {
    expect(halfwordWidth(64, TimType.Bpp4)).toBe(16);
    expect(halfwordWidth(64, TimType.Bpp8)).toBe(32);
    expect(halfwordWidth(64, TimType.Bpp16)).toBe(64);
    expect(halfwordWidth(640, TimType.Bpp24)).toBe(960);
  });

  it('a 256-texel 8bpp image is 128 halfwords, not 256', () => {
    expect(halfwordWidth(256, TimType.Bpp8)).toBe(128);
  });
});

describe('RGB555', () => {
  it('places red low and blue high', () => {
    expect(packRGB555(255, 0, 0)).toBe(0x001f);
    expect(packRGB555(0, 255, 0)).toBe(0x03e0);
    expect(packRGB555(0, 0, 255)).toBe(0x7c00);
    expect(packRGB555(255, 255, 255)).toBe(0x7fff);
  });

  it('sets bit 15 for STP', () => {
    expect(packRGB555(0, 0, 0, true)).toBe(0x8000);
  });

  it('round-trips through bit replication without drift', () => {
    for (const v of [0x0000, 0x7fff, 0x001f, 0x3def, 0x4210]) {
      const { r, g, b } = unpackRGB555(v);
      expect(packRGB555(r, g, b)).toBe(v & 0x7fff);
    }
  });

  it('nudges opaque black off the transparent value', () => {
    expect(nudgeBlack(0x0000)).toBe(NEAR_BLACK);
    expect(nudgeBlack(0x8000)).toBe(NEAR_BLACK); // still black, STP set
    expect(nudgeBlack(0x0421)).toBe(0x0421);
    expect(nudgeBlack(0x0001)).toBe(0x0001);
  });
});

describe('error metric', () => {
  it('reports a clean truncation as at or under the 5-bit floor', () => {
    const src = new Uint8Array([200, 100, 50, 255]);
    const v = packRGB555(200, 100, 50);
    const { r, g, b } = unpackRGB555(v);
    const recon = new Uint8Array([r, g, b, 255]);
    const report = scoreAgainstSource(src, recon);
    expect(report.maxChannelError).toBeLessThanOrEqual(7);
    expect(report.pastFloorFraction).toBe(0);
  });

  it('flags error past the floor as the quantizer, not the format', () => {
    const src = new Uint8Array([200, 100, 50, 255]);
    const recon = new Uint8Array([200, 140, 50, 255]); // 40 off on green
    const report = scoreAgainstSource(src, recon);
    expect(report.maxChannelError).toBe(40);
    expect(report.pastFloorFraction).toBe(1);
  });

  it('skips fully transparent source pixels', () => {
    const src = new Uint8Array([200, 100, 50, 0]);
    const recon = new Uint8Array([0, 0, 0, 0]);
    expect(scoreAgainstSource(src, recon).pixelsCompared).toBe(0);
  });

  it('counts RGB555 collisions', () => {
    // Two RGB888 colours one unit apart collapse to one RGB555 value.
    const src = new Uint8Array([8, 0, 0, 255, 9, 0, 0, 255]);
    expect(countDistinct(src)).toEqual({ rgb888: 2, rgb555: 1 });
  });
});

describe.runIf(has('tim4'))('TIM4.tim - 4bpp with CLUT', () => {
  it('parses to the measured header values', () => {
    const { tim, diagnostics } = parseTim(load('tim4'));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(tim!.type).toBe(TimType.Bpp4);
    expect(tim!.clut).toBeDefined();
    expect(tim!.clut!.w).toBe(16);
    expect(tim!.clut!.h).toBe(1);
    expect(tim!.clut!.x).toBe(0);
    expect(tim!.clut!.y).toBe(481);
    expect(texelWidth(tim!.pixels.w, tim!.type)).toBe(64);
    expect(tim!.pixels.h).toBe(128);
  });

  it('round-trips byte-exactly', () => {
    const original = load('tim4');
    const { tim } = parseTim(original);
    expect(Array.from(serializeTim(tim!))).toEqual(Array.from(original));
  });
});

describe.runIf(has('tim8'))('TIM8.tim - 8bpp with CLUT', () => {
  it('parses to the measured header values', () => {
    const { tim, diagnostics } = parseTim(load('tim8'));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(tim!.type).toBe(TimType.Bpp8);
    expect(tim!.clut!.w).toBe(256);
    expect(tim!.clut!.y).toBe(480);
    expect(texelWidth(tim!.pixels.w, tim!.type)).toBe(64);
  });

  it('round-trips byte-exactly', () => {
    const original = load('tim8');
    const { tim } = parseTim(original);
    expect(Array.from(serializeTim(tim!))).toEqual(Array.from(original));
  });
});

describe.runIf(has('tim16'))('TIM16.tim - 16bpp, no CLUT', () => {
  it('has no CLUT and a 1:1 halfword-to-texel width', () => {
    const { tim } = parseTim(load('tim16'));
    expect(tim!.type).toBe(TimType.Bpp16);
    expect(tim!.clut).toBeUndefined();
    expect(texelWidth(tim!.pixels.w, tim!.type)).toBe(tim!.pixels.w);
  });
});

describe.runIf(has('dbugfont'))('dbugfont.tim - a shipped file with a WRONG length field', () => {
  it('parses anyway, warns, and trusts the dimensions', () => {
    const { tim, diagnostics } = parseTim(load('dbugfont'));
    expect(tim, 'should not be fatal').toBeDefined();
    expect(diagnostics.some((d) => d.code === 'section-length-mismatch')).toBe(true);
    expect(tim!.pixels.w).toBe(32);
    expect(tim!.pixels.h).toBe(32);
    expect(tim!.pixels.data.length).toBe(32 * 32);
  });
});

describe.runIf(has('gteTexture'))('gte/texture.tim - the other wrong length field', () => {
  it('recovers the full 64x128 halfword payload', () => {
    const { tim, diagnostics } = parseTim(load('gteTexture'));
    expect(diagnostics.some((d) => d.code === 'section-length-mismatch')).toBe(true);
    expect(tim!.pixels.w).toBe(64);
    expect(tim!.pixels.h).toBe(128);
    expect(tim!.pixels.data.length).toBe(64 * 128);
  });
});

describe.runIf(has('n00bromFont'))('n00brom/font.tim - junk in the reserved flag bits', () => {
  it('masks rather than rejecting, and says so', () => {
    const { tim, diagnostics } = parseTim(load('n00bromFont'));
    expect(tim).toBeDefined();
    expect(tim!.type).toBe(TimType.Bpp4);
    expect(tim!.clut).toBeDefined();
    expect(tim!.rawFlags & ~0x0f, 'specimen should actually have junk bits').not.toBe(0);
    expect(diagnostics.some((d) => d.code === 'reserved-flag-bits')).toBe(true);
  });
});

describe.runIf(has('multiPalette'))('VP-hack 00007.tim - two palettes in one CLUT', () => {
  it('exposes both palettes', () => {
    const { tim } = parseTim(load('multiPalette'));
    expect(tim!.clut!.w).toBe(16);
    expect(tim!.clut!.h).toBe(2);
    expect(paletteCount(tim!)).toBe(2);
    expect(palette(tim!, 0)!.length).toBe(16);
    expect(palette(tim!, 1)!.length).toBe(16);
    expect(palette(tim!, 2)).toBeUndefined();
  });

  it('is wider than the 256-texel limit png2tim.py imposes', () => {
    const { tim } = parseTim(load('multiPalette'));
    expect(texelWidth(tim!.pixels.w, tim!.type)).toBeGreaterThan(256);
  });
});

describe.runIf(has('bunpattern'))('bunpattern.tim - 24bpp', () => {
  it('derives 640 texels from 960 halfwords', () => {
    const { tim } = parseTim(load('bunpattern'));
    expect(tim!.type).toBe(TimType.Bpp24);
    expect(tim!.clut).toBeUndefined();
    expect(tim!.pixels.w).toBe(960);
    expect(texelWidth(tim!.pixels.w, tim!.type)).toBe(640);
    expect(tim!.pixels.h).toBe(480);
  });
});

describe('rejections', () => {
  it('rejects a bad ID byte', () => {
    const bad = new Uint8Array(20);
    bad[0] = 0x11;
    const { tim, diagnostics } = parseTim(bad);
    expect(tim).toBeUndefined();
    expect(diagnostics[0].code).toBe('bad-id');
  });

  it('rejects a compressed TIM rather than mis-parsing it', () => {
    const bad = new Uint8Array(20);
    bad[0] = 0x10;
    bad[2] = 0x01; // reserved halfword set
    const { tim, diagnostics } = parseTim(bad);
    expect(tim).toBeUndefined();
    expect(diagnostics[0].code).toBe('compressed');
  });

  it('reports truncation instead of reading past the buffer', () => {
    const short = new Uint8Array([0x10, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0xff]);
    const { tim, diagnostics } = parseTim(short);
    expect(tim).toBeUndefined();
    expect(diagnostics.some((d) => d.code === 'truncated')).toBe(true);
  });
});

describe('texel packing', () => {
  it('packs 4bpp low-nibble-first within a halfword', () => {
    const s = { x: 0, y: 0, w: 1, h: 1, data: new Uint16Array([0x4321]) };
    expect(getTexel(s, TimType.Bpp4, 0, 0)).toBe(0x1);
    expect(getTexel(s, TimType.Bpp4, 1, 0)).toBe(0x2);
    expect(getTexel(s, TimType.Bpp4, 2, 0)).toBe(0x3);
    expect(getTexel(s, TimType.Bpp4, 3, 0)).toBe(0x4);
  });

  it('packs 8bpp low-byte-first within a halfword', () => {
    const s = { x: 0, y: 0, w: 1, h: 1, data: new Uint16Array([0xbeef]) };
    expect(getTexel(s, TimType.Bpp8, 0, 0)).toBe(0xef);
    expect(getTexel(s, TimType.Bpp8, 1, 0)).toBe(0xbe);
  });

  it('set/get are inverses at every depth', () => {
    for (const [type, max] of [
      [TimType.Bpp4, 0x0f],
      [TimType.Bpp8, 0xff],
      [TimType.Bpp16, 0xffff],
    ] as const) {
      const s = { x: 0, y: 0, w: 4, h: 2, data: new Uint16Array(8) };
      const width = texelWidth(4, type);
      for (let i = 0; i < width; i++) setTexel(s, type, i, 1, i % (max + 1));
      for (let i = 0; i < width; i++) expect(getTexel(s, type, i, 1)).toBe(i % (max + 1));
    }
  });
});

describe('construction', () => {
  it('builds a 16bpp TIM that survives a serialize/parse round-trip', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      rgba[i * 4] = i * 16;
      rgba[i * 4 + 1] = 255 - i * 16;
      rgba[i * 4 + 2] = 128;
      rgba[i * 4 + 3] = 255;
    }
    const tim = timFromRGBA16(rgba, 4, 4, { x: 320, y: 0 });
    const { tim: back, diagnostics } = parseTim(serializeTim(tim));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(back!.type).toBe(TimType.Bpp16);
    expect(back!.pixels.x).toBe(320);
    expect(Array.from(back!.pixels.data)).toEqual(Array.from(tim.pixels.data));
  });

  it('maps zero alpha to the transparent value and nudges opaque black', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255]);
    const tim = timFromRGBA16(rgba, 4, 1, { x: 0, y: 0 });
    expect(tim.pixels.data[0]).toBe(0x0000);
    expect(tim.pixels.data[1]).toBe(NEAR_BLACK);
  });

  it('pads a short palette up to the CLUT width the depth requires', () => {
    const tim = timFromIndexed(
      new Uint8Array(8),
      new Uint16Array([0x7fff, 0x001f]),
      8,
      1,
      TimType.Bpp4,
      { x: 0, y: 0, clutX: 0, clutY: 480 },
    );
    expect(tim.clut!.w).toBe(16);
    expect(tim.clut!.data[0]).toBe(0x7fff);
    expect(tim.clut!.data[2]).toBe(0);
    expect(tim.pixels.w).toBe(2); // 8 texels at 4bpp = 2 halfwords
  });

  it('refuses a width that cannot pack into whole halfwords', () => {
    expect(() =>
      timFromIndexed(new Uint8Array(7), new Uint16Array(16), 7, 1, TimType.Bpp8, {
        x: 0,
        y: 0,
        clutX: 0,
        clutY: 0,
      }),
    ).toThrow(/multiple of 2/);
  });
});

// ---------------------------------------------------------------------------
// PXL / CLT
// ---------------------------------------------------------------------------

describe('PXL and CLT', () => {
  const sample = () =>
    timFromIndexed(
      new Uint8Array([0, 1, 2, 3, 3, 2, 1, 0]),
      new Uint16Array([0x0421, 0x001f, 0x03e0, 0x7c00]),
      8,
      1,
      TimType.Bpp4,
      { x: 640, y: 32, clutX: 16, clutY: 500 },
    );

  it('uses the ID bytes shipped games use, not the ones Sony documented', () => {
    // Sony's docs say 11h=PXL, 12h=CLT. Games do the opposite, psx-spx records
    // the conflict, and spicyjpeg's converter follows the games. So do we -
    // and this test is here so a future tidy-up cannot quietly flip it back.
    expect(PXL_ID).toBe(0x12);
    expect(CLT_ID).toBe(0x11);
  });

  it('splits a TIM into a PXL and a CLT carrying the same sections', () => {
    const tim = sample();
    const { pxl, clt } = timToSplit(tim);
    expect(pxl.kind).toBe('pxl');
    expect(clt!.kind).toBe('clt');
    expect(pxl.section).toBe(tim.pixels);
    expect(clt!.section).toBe(tim.clut);
  });

  it('writes headers with the right ID and a CLT type of 2', () => {
    const { pxl, clt } = timToSplit(sample());
    const pb = serializeSplit(pxl);
    const cb = serializeSplit(clt!);
    expect(pb[0]).toBe(0x12);
    expect(cb[0]).toBe(0x11);
    expect(new DataView(cb.buffer).getUint32(4, true) & 7).toBe(2);
    expect(new DataView(pb.buffer).getUint32(4, true) & 7).toBe(TimType.Bpp4);
  });

  it('round-trips a TIM through PXL + CLT byte-exactly', () => {
    const tim = sample();
    const { pxl, clt } = timToSplit(tim);
    const back = splitToTim(
      parseSplit(serializeSplit(pxl)).file!,
      parseSplit(serializeSplit(clt!)).file!,
    );
    expect(Array.from(serializeTim(back))).toEqual(Array.from(serializeTim(tim)));
  });

  it('preserves the VRAM coordinates each section carries', () => {
    const { pxl, clt } = timToSplit(sample());
    const p = parseSplit(serializeSplit(pxl)).file!;
    const c = parseSplit(serializeSplit(clt!)).file!;
    expect([p.section.x, p.section.y]).toEqual([640, 32]);
    expect([c.section.x, c.section.y]).toEqual([16, 500]);
  });

  it('rejects a TIM handed to the split parser, and vice versa', () => {
    const tim = sample();
    expect(parseSplit(serializeTim(tim)).file).toBeUndefined();
    expect(parseSplit(serializeTim(tim)).diagnostics[0].code).toBe('bad-id');

    const { pxl } = timToSplit(tim);
    expect(parseTim(serializeSplit(pxl)).tim).toBeUndefined();
  });

  it('warns when a CLT carries an unexpected type', () => {
    const { clt } = timToSplit(sample());
    const bytes = serializeSplit(clt!);
    bytes[4] = 1; // type 1 instead of 2
    const r = parseSplit(bytes);
    expect(r.file).toBeDefined();
    expect(r.diagnostics.some((d) => d.code === 'unknown-type')).toBe(true);
  });

  it('handles a PXL with no CLT at all, as 16bpp needs', () => {
    const tim = timFromRGBA16(
      new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
      2,
      1,
      { x: 0, y: 0 },
    );
    const { pxl, clt } = timToSplit(tim);
    expect(clt).toBeUndefined();
    const back = splitToTim(parseSplit(serializeSplit(pxl)).file!);
    expect(back.clut).toBeUndefined();
    expect(back.type).toBe(TimType.Bpp16);
  });

  it('reports truncation rather than reading past the buffer', () => {
    const { pxl } = timToSplit(sample());
    const short = serializeSplit(pxl).subarray(0, 14);
    expect(parseSplit(short).file).toBeUndefined();
  });
});
