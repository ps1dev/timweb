import { describe, it, expect } from 'vitest';
import { TimType, parseTim, serializeTim, texelWidth } from '../src/core/tim.js';
import { crc32, buildZip } from '../src/core/zip.js';
import { toRaw, rawFromSerializedTim } from '../src/core/raw.js';
import {
  emptyProject,
  createAsset,
  createKeepout,
  assetFromTim,
  assetFromSplit,
  convertAsset,
  autoDepth,
  buildTim,
  pixelRect,
  clutRect,
  validate,
  serializeProject,
  deserializeProject,
  buildMap,
  exportProject,
  makeId,
  clampIntoVram,
  type Asset,
  type Project,
} from '../src/core/project.js';

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

describe('zip', () => {
  it('computes the standard CRC32', () => {
    // Known vector: CRC32("123456789") = 0xCBF43926.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('produces an archive with the right magic and entry count', () => {
    const zip = buildZip([
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'b.bin', data: new Uint8Array([1, 2, 3]) },
    ]);
    const dv = new DataView(zip.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50); // local file header
    // End-of-central-directory is the last 22 bytes for a comment-less archive.
    const eocd = zip.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
  });

  it('is byte-reproducible for identical input', () => {
    const make = () => buildZip([{ name: 'x', data: new Uint8Array([9, 9]) }]);
    expect(Array.from(make())).toEqual(Array.from(make()));
  });
});

describe('placement geometry', () => {
  it('sizes the pixel rect in halfwords, not texels', () => {
    const p = emptyProject();
    const a = addAsset(p, 'tex', 256, 64);
    a.settings.depth = TimType.Bpp8;
    expect(pixelRect(a).w).toBe(128);
    expect(texelWidth(pixelRect(a).w, TimType.Bpp8)).toBe(256);

    a.settings.depth = TimType.Bpp4;
    expect(pixelRect(a).w).toBe(64);

    a.settings.depth = TimType.Bpp16;
    expect(pixelRect(a).w).toBe(256);
  });

  it('sizes the CLUT rect by depth and drops it at 16bpp', () => {
    const p = emptyProject();
    const a = addAsset(p, 'tex');
    a.settings.depth = TimType.Bpp4;
    expect(clutRect(a)!.w).toBe(16);
    a.settings.depth = TimType.Bpp8;
    expect(clutRect(a)!.w).toBe(256);
    a.settings.depth = TimType.Bpp16;
    expect(clutRect(a)).toBeUndefined();
  });

  it('places a new asset clear of the display region', () => {
    const p = emptyProject();
    const a = addAsset(p, 'tex');
    const issues = validate(p);
    expect(issues.filter((i) => i.code === 'in-keepout')).toEqual([]);
    expect(a.x).toBeGreaterThanOrEqual(0);
  });

  it('does not stack two new assets on top of each other', () => {
    const p = emptyProject();
    addAsset(p, 'one');
    addAsset(p, 'two');
    expect(validate(p).filter((i) => i.code === 'overlap')).toEqual([]);
  });

  it('gives CLUTs a legal X alignment', () => {
    const p = emptyProject();
    addAsset(p, 'one');
    expect(validate(p).filter((i) => i.code === 'clut-misaligned')).toEqual([]);
  });
});

describe('inherit on reimport', () => {
  it('keeps placement and depth when an asset of the same name comes back', () => {
    const p = emptyProject();
    const first = addAsset(p, 'hero');
    first.x = 640;
    first.y = 256;
    first.clutX = 512;
    first.clutY = 500;
    first.settings.depth = TimType.Bpp4;
    first.settings.depthAuto = false;

    const again = createAsset('hero', 64, 64, rgbaBlocks(64, 64, 4), p);
    expect(again.x).toBe(640);
    expect(again.y).toBe(256);
    expect(again.clutX).toBe(512);
    expect(again.clutY).toBe(500);
    expect(again.settings.depth).toBe(TimType.Bpp4);
    expect(again.id).toBe(first.id);
  });

  it('picks up new dimensions while keeping the placement', () => {
    const p = emptyProject();
    const first = addAsset(p, 'hero', 32, 32);
    first.x = 704;
    const again = createAsset('hero', 128, 64, rgbaBlocks(128, 64, 4), p);
    expect(again.width).toBe(128);
    expect(again.height).toBe(64);
    expect(again.x).toBe(704);
  });

  it('drops the cached conversion so stale pixels cannot survive', () => {
    const p = emptyProject();
    const first = addAsset(p, 'hero');
    convertAsset(first);
    expect(first.converted).toBeDefined();
    const again = createAsset('hero', 64, 64, rgbaBlocks(64, 64, 4), p);
    expect(again.converted).toBeUndefined();
  });
});

describe('automatic depth', () => {
  it('defaults to having a quality floor at all', () => {
    // Without one the cost model always picks 4bpp, because 4bpp is cheapest
    // at every size. That ships a tool whose auto mode ruins complex art.
    expect(emptyProject().qualityFloor).toBeGreaterThan(0);
  });

  it('with no quality floor, picks on VRAM cost alone', () => {
    const p = emptyProject();
    p.qualityFloor = undefined;
    const a = addAsset(p, 'tex', 128, 128);
    expect(autoDepth(a, p)).toBe(TimType.Bpp4);
  });

  it('does not hand a many-coloured image to 4bpp under the default floor', () => {
    const p = emptyProject();
    const w = 64, h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * y) & 255; rgba[i+1] = (x ^ y) & 255; rgba[i+2] = (x + y) & 255; rgba[i+3] = 255;
    }
    const a = createAsset('busy', w, h, rgba, p);
    p.assets.push(a);
    expect(autoDepth(a, p)).not.toBe(TimType.Bpp4);
  });

  it('with a floor, actually measures each depth instead of guessing', () => {
    const p = emptyProject();
    p.qualityFloor = 95;
    // 8 flat colours: 4bpp holds them exactly, so it should clear any floor.
    const easy = addAsset(p, 'easy', 128, 128, 8);
    expect(autoDepth(easy, p)).toBe(TimType.Bpp4);
  });

  it('rejects a depth that genuinely cannot hold the image', () => {
    const p = emptyProject();
    p.qualityFloor = 99;
    // A smooth gradient: hundreds of colours, hopeless at 16 entries.
    const w = 128;
    const h = 128;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = x * 2;
        rgba[i + 1] = y * 2;
        rgba[i + 2] = 255 - x;
        rgba[i + 3] = 255;
      }
    }
    const hard = createAsset('hard', w, h, rgba, p);
    p.assets.push(hard);
    expect(autoDepth(hard, p)).not.toBe(TimType.Bpp4);
  });

  it('raising clutPenalty moves marginal assets toward 16bpp', () => {
    const p = emptyProject();
    p.qualityFloor = undefined;
    const small = addAsset(p, 'small', 16, 16, 4);
    p.clutPenalty = 1;
    const cheap = autoDepth(small, p);
    p.clutPenalty = 64;
    const dear = autoDepth(small, p);
    expect(dear).toBe(TimType.Bpp16);
    expect(cheap).not.toBe(TimType.Bpp16);
  });
});

describe('building TIMs', () => {
  it('produces a parseable 8bpp TIM at the asset placement', () => {
    const p = emptyProject();
    const a = addAsset(p, 'tex', 64, 32, 200);
    a.settings.depth = TimType.Bpp8;
    a.x = 640;
    a.y = 0;
    a.clutX = 0;
    a.clutY = 500;

    const bytes = serializeTim(buildTim(a));
    const { tim, diagnostics } = parseTim(bytes);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(tim!.type).toBe(TimType.Bpp8);
    expect(tim!.pixels.x).toBe(640);
    expect(tim!.clut!.y).toBe(500);
    expect(texelWidth(tim!.pixels.w, TimType.Bpp8)).toBe(64);
  });

  it('produces a CLUT-less TIM at 16bpp', () => {
    const p = emptyProject();
    const a = addAsset(p, 'tex', 32, 32);
    a.settings.depth = TimType.Bpp16;
    const tim = buildTim(a);
    expect(tim.clut).toBeUndefined();
    expect(tim.type).toBe(TimType.Bpp16);
  });
});

describe('project round trip', () => {
  it('restores layout and settings, reporting assets whose pixels are missing', () => {
    const p = emptyProject();
    p.name = 'demo';
    p.clutPenalty = 4;
    p.qualityFloor = 60;
    const a = addAsset(p, 'hero', 64, 64);
    a.x = 704;
    a.clutY = 505;
    a.settings.depth = TimType.Bpp4;
    a.settings.dither = true;

    const { project: back, missing } = deserializeProject(serializeProject(p));
    expect(back.name).toBe('demo');
    expect(back.clutPenalty).toBe(4);
    expect(back.qualityFloor).toBe(60);
    expect(back.assets[0].x).toBe(704);
    expect(back.assets[0].clutY).toBe(505);
    expect(back.assets[0].settings.depth).toBe(TimType.Bpp4);
    expect(back.assets[0].settings.dither).toBe(true);
    expect(missing).toEqual(['hero']);
  });

  it('re-attaches pixels through the supplied source', () => {
    const p = emptyProject();
    addAsset(p, 'hero', 8, 8);
    const pixels = rgbaBlocks(8, 8, 4);
    const { missing, project: back } = deserializeProject(
      serializeProject(p),
      (name) => (name === 'hero' ? pixels : undefined),
    );
    expect(missing).toEqual([]);
    expect(back.assets[0].rgba).toBe(pixels);
  });

  it('refuses a project file from a newer format version', () => {
    const json = JSON.stringify({ formatVersion: 99, name: 'x', assets: [] });
    expect(() => deserializeProject(json)).toThrow(/newer than this build/);
  });

  it('refuses something that is not a project file', () => {
    expect(() => deserializeProject('{"hello":1}')).toThrow(/not a timweb project/);
  });

  it('does not reuse ids after a load', () => {
    const p = emptyProject();
    addAsset(p, 'hero');
    const { project: back } = deserializeProject(serializeProject(p));
    expect(makeId()).not.toBe(back.assets[0].id);
  });
});

describe('export', () => {
  it('bundles a .tim per asset plus a project file and a map', () => {
    const p = emptyProject();
    p.name = 'demo';
    addAsset(p, 'one', 32, 32, 8);
    addAsset(p, 'two', 32, 32, 8);
    const { entries } = exportProject(p);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['demo.map.txt', 'demo.timweb.json', 'one.tim', 'two.tim']);
  });

  it('writes a map naming halfword units explicitly', () => {
    const p = emptyProject();
    const a = addAsset(p, 'one', 64, 32, 8);
    a.settings.depth = TimType.Bpp8;
    const map = buildMap(p);
    expect(map).toMatch(/halfwords/);
    expect(map).toMatch(/one\t8bpp/);
    expect(map).toMatch(/64x32/);
  });

  it('every exported .tim parses back cleanly', () => {
    const p = emptyProject();
    addAsset(p, 'one', 64, 32, 8);
    addAsset(p, 'two', 32, 32, 200);
    p.assets[1].settings.depth = TimType.Bpp8;
    for (const e of exportProject(p).entries) {
      if (!e.name.endsWith('.tim')) continue;
      const { tim, diagnostics } = parseTim(e.data);
      expect(tim, `${e.name} should parse`).toBeDefined();
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    }
  });
});

describe('importing an existing TIM', () => {
  it('places it at the coordinates it already carries', () => {
    const p = emptyProject();
    const a = addAsset(p, 'src', 64, 32, 8);
    a.settings.depth = TimType.Bpp8;
    a.x = 704;
    a.y = 256;
    a.clutX = 16;
    a.clutY = 490;
    const bytes = serializeTim(buildTim(a));

    const result = assetFromTim('src', bytes);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.asset.x).toBe(704);
    expect(result.asset.y).toBe(256);
    expect(result.asset.clutX).toBe(16);
    expect(result.asset.clutY).toBe(490);
    expect(result.asset.settings.depth).toBe(TimType.Bpp8);
    expect(result.asset.settings.depthAuto).toBe(false);
    expect(result.asset.width).toBe(64);
  });

  it('reports an error rather than throwing on junk', () => {
    const result = assetFromTim('junk', new Uint8Array([1, 2, 3, 4]));
    expect('error' in result).toBe(true);
  });
});

describe('depth is chosen before placement', () => {
  it('never places a new asset past the edge of VRAM', () => {
    const p = emptyProject();
    // Fill the left half so the search is pushed rightward, then add a wide
    // many-coloured image that auto-depth will promote to 16bpp.
    for (let i = 0; i < 6; i++) addAsset(p, `filler${i}`, 128, 256, 8);

    const w = 256, h = 128;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * y) & 255; rgba[i+1] = (x ^ y) & 255; rgba[i+2] = (x + y) & 255; rgba[i+3] = 255;
    }
    const wide = createAsset('wide', w, h, rgba, p);
    p.assets.push(wide);

    const r = pixelRect(wide);
    expect(r.x + r.w, 'texture must end inside VRAM').toBeLessThanOrEqual(1024);
    expect(r.y + r.h).toBeLessThanOrEqual(512);
    expect(validate(p).filter((i) => i.code === 'out-of-bounds')).toEqual([]);
  });

  it('clamps an asset back inside when a depth change grows it', () => {
    const p = emptyProject();
    const a = addAsset(p, 'grow', 256, 64, 8);
    a.settings.depthAuto = false;
    a.settings.depth = TimType.Bpp4;   // 64 halfwords
    a.x = 1000;
    clampIntoVram(a);
    expect(a.x).toBe(1024 - 64);

    a.settings.depth = TimType.Bpp16;  // now 256 halfwords
    clampIntoVram(a);
    expect(a.x).toBe(1024 - 256);
    expect(validate(p).filter((i) => i.code === 'out-of-bounds')).toEqual([]);
  });
});

describe('raw headerless export', () => {
  it('emits image and palette .dat files alongside or instead of TIMs', () => {
    const p = emptyProject();
    p.name = 'demo';
    const a = addAsset(p, 'texture', 64, 32, 8);
    a.settings.depthAuto = false;
    a.settings.depth = TimType.Bpp8;

    const names = (o: Parameters<typeof exportProject>[1]) =>
      exportProject(p, o).entries.map((e) => e.name).sort();

    expect(names({ tim: true })).toEqual(['demo.map.txt', 'demo.timweb.json', 'texture.tim']);
    expect(names({ tim: false, raw: true })).toEqual([
      'demo.map.txt', 'demo.timweb.json', 'texture_palette.dat', 'texture_image.dat',
    ].sort());
    expect(names({ tim: true, raw: true })).toHaveLength(5);
    // Asking for raw does NOT silently turn TIMs off.
    expect(names({ raw: true })).toContain('texture.tim');
  });

  it('omits the palette file at 16bpp, where there is no CLUT', () => {
    const p = emptyProject();
    const a = addAsset(p, 'direct', 32, 32, 8);
    a.settings.depthAuto = false;
    a.settings.depth = TimType.Bpp16;
    const names = exportProject(p, { tim: false, raw: true }).entries.map((e) => e.name);
    expect(names).toContain('direct_image.dat');
    expect(names).not.toContain('direct_palette.dat');
  });

  it('is byte-identical to the TIM section payloads', () => {
    // The claim in raw.ts is that a TIM is these files wearing a hat. If a
    // second packing routine ever creeps in, this catches it.
    for (const depth of [TimType.Bpp4, TimType.Bpp8, TimType.Bpp16] as const) {
      const p = emptyProject();
      const a = addAsset(p, 'x', 64, 8, 12);
      a.settings.depthAuto = false;
      a.settings.depth = depth;

      const built = buildTim(a);
      const direct = toRaw(built, a.width);
      const sliced = rawFromSerializedTim(built);

      expect(Array.from(direct.image), `image at ${depth}`).toEqual(Array.from(sliced.image));
      expect(direct.palette === undefined).toBe(sliced.palette === undefined);
      if (direct.palette && sliced.palette) {
        expect(Array.from(direct.palette), `palette at ${depth}`).toEqual(Array.from(sliced.palette));
      }
    }
  });

  it('sizes the palette to the depth, padded like convertImage.py', () => {
    const p = emptyProject();
    for (const [depth, bytes] of [[TimType.Bpp4, 32], [TimType.Bpp8, 512]] as const) {
      const a = addAsset(p, `pal${depth}`, 32, 8, 5);
      a.settings.depthAuto = false;
      a.settings.depth = depth;
      const r = toRaw(buildTim(a), a.width);
      expect(r.palette!.length, `${depth}`).toBe(bytes);
      expect(r.paletteEntries).toBe(bytes / 2);
    }
  });

  it('packs 4bpp two texels per byte, low nibble first', () => {
    const p = emptyProject();
    const a = addAsset(p, 'nib', 4, 1, 4);
    a.settings.depthAuto = false;
    a.settings.depth = TimType.Bpp4;
    const r = toRaw(buildTim(a), a.width);
    // 4 texels at 4bpp = 2 bytes, and the first byte's low nibble is texel 0.
    expect(r.image.length).toBe(2);
    expect(r.image[0] & 0x0f).toBe(a.converted!.indices[0]);
    expect(r.image[0] >> 4).toBe(a.converted!.indices[1]);
  });

  it('reports dimensions the headerless files cannot carry', () => {
    const p = emptyProject();
    const a = addAsset(p, 'dims', 64, 32, 8);
    a.settings.depthAuto = false;
    a.settings.depth = TimType.Bpp8;
    const r = toRaw(buildTim(a), a.width);
    expect(r).toMatchObject({ width: 64, height: 32, bpp: 8 });
    expect(r.image.length).toBe(64 * 32); // one byte per texel at 8bpp
  });
});

describe('configurable raw suffixes', () => {
  it('defaults to _image.dat and _palette.dat', () => {
    const p = emptyProject();
    expect(p.imageSuffix).toBe('_image.dat');
    expect(p.paletteSuffix).toBe('_palette.dat');
  });

  it('honours per-project suffixes', () => {
    const p = emptyProject();
    p.imageSuffix = 'Data.dat';
    p.paletteSuffix = 'PaletteData.dat';
    const a = addAsset(p, 'texture', 32, 8, 8);
    a.settings.depthAuto = false;
    a.settings.depth = TimType.Bpp8;
    const names = exportProject(p, { tim: false, raw: true }).entries.map((e) => e.name);
    expect(names).toContain('textureData.dat');
    expect(names).toContain('texturePaletteData.dat');
  });

  it('lets a single export override them', () => {
    const p = emptyProject();
    const a = addAsset(p, 'tex', 32, 8, 8);
    a.settings.depthAuto = false;
    a.settings.depth = TimType.Bpp8;
    const names = exportProject(p, {
      tim: false,
      raw: true,
      imageSuffix: '.img',
      paletteSuffix: '.clut',
    }).entries.map((e) => e.name);
    expect(names).toContain('tex.img');
    expect(names).toContain('tex.clut');
  });

  it('round-trips them through the project file', () => {
    const p = emptyProject();
    p.imageSuffix = '.bin';
    p.paletteSuffix = '.pal';
    const { project: back } = deserializeProject(serializeProject(p));
    expect(back.imageSuffix).toBe('.bin');
    expect(back.paletteSuffix).toBe('.pal');
  });

  it('supplies defaults when loading a project file that predates them', () => {
    const json = JSON.stringify({ formatVersion: 1, name: 'old', assets: [] });
    const { project } = deserializeProject(json);
    expect(project.imageSuffix).toBe('_image.dat');
    expect(project.paletteSuffix).toBe('_palette.dat');
  });
});

describe('PXL/CLT export and import', () => {
  const make = (depth: TimType.Bpp4 | TimType.Bpp8 | TimType.Bpp16) => {
    const p = emptyProject();
    p.name = 'demo';
    const a = addAsset(p, 'sprite', 32, 8, 8);
    a.settings.depthAuto = false;
    a.settings.depth = depth;
    convertAsset(a);
    return { p, a };
  };

  it('is a third independent toggle, combinable with the other two', () => {
    const { p } = make(TimType.Bpp8);
    const names = (o: Parameters<typeof exportProject>[1]) =>
      exportProject(p, o).entries.map((e) => e.name).filter((n) => !/\.(json|txt)$/.test(n)).sort();

    expect(names({ tim: false, pxl: true })).toEqual(['sprite.clt', 'sprite.pxl']);
    expect(names({ tim: true, pxl: true })).toEqual(['sprite.clt', 'sprite.pxl', 'sprite.tim']);
    expect(names({ tim: true, raw: true, pxl: true })).toEqual(
      ['sprite.clt', 'sprite.pxl', 'sprite.tim', 'sprite_image.dat', 'sprite_palette.dat'].sort(),
    );
  });

  it('omits the .clt at 16bpp, where there is no CLUT', () => {
    const { p } = make(TimType.Bpp16);
    const names = exportProject(p, { tim: false, pxl: true }).entries.map((e) => e.name);
    expect(names).toContain('sprite.pxl');
    expect(names).not.toContain('sprite.clt');
  });

  it('honours configurable pxl/clt suffixes', () => {
    const { p } = make(TimType.Bpp8);
    p.pxlSuffix = '.PXL';
    p.cltSuffix = '.CLT';
    const names = exportProject(p, { tim: false, pxl: true }).entries.map((e) => e.name);
    expect(names).toContain('sprite.PXL');
    expect(names).toContain('sprite.CLT');
  });

  it('round-trips an asset out to PXL+CLT and back in', () => {
    const { p, a } = make(TimType.Bpp4);
    a.x = 704;
    a.y = 256;
    a.clutX = 32;
    a.clutY = 502;
    const entries = exportProject(p, { tim: false, pxl: true }).entries;
    const pxl = entries.find((e) => e.name === 'sprite.pxl')!.data;
    const clt = entries.find((e) => e.name === 'sprite.clt')!.data;

    const result = assetFromSplit('sprite', pxl, clt);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.asset.width).toBe(32);
    expect(result.asset.height).toBe(8);
    expect(result.asset.settings.depth).toBe(TimType.Bpp4);
    expect([result.asset.x, result.asset.y]).toEqual([704, 256]);
    expect([result.asset.clutX, result.asset.clutY]).toEqual([32, 502]);
  });

  it('refuses an indexed PXL with no CLT instead of guessing a palette', () => {
    const { p } = make(TimType.Bpp8);
    const pxl = exportProject(p, { tim: false, pxl: true }).entries
      .find((e) => e.name === 'sprite.pxl')!.data;
    const result = assetFromSplit('sprite', pxl);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/needs its CLT/);
  });

  it('accepts a 16bpp PXL alone, which needs no CLT', () => {
    const { p } = make(TimType.Bpp16);
    const pxl = exportProject(p, { tim: false, pxl: true }).entries
      .find((e) => e.name === 'sprite.pxl')!.data;
    const result = assetFromSplit('sprite', pxl);
    expect('error' in result).toBe(false);
  });

  it('rejects the two files swapped', () => {
    const { p } = make(TimType.Bpp8);
    const entries = exportProject(p, { tim: false, pxl: true }).entries;
    const pxl = entries.find((e) => e.name === 'sprite.pxl')!.data;
    const clt = entries.find((e) => e.name === 'sprite.clt')!.data;
    const result = assetFromSplit('sprite', clt, pxl);
    expect('error' in result).toBe(true);
  });

  it('round-trips the pxl/clt suffixes through the project file', () => {
    const p = emptyProject();
    p.pxlSuffix = '.p';
    p.cltSuffix = '.c';
    const { project: back } = deserializeProject(serializeProject(p));
    expect([back.pxlSuffix, back.cltSuffix]).toEqual(['.p', '.c']);
  });
});

describe('keepouts', () => {
  it('reserves VRAM that auto-placement avoids', () => {
    const p = emptyProject();
    // Wall off everything except a narrow strip on the right.
    p.keepouts = [{ id: 'k1', name: 'reserved', x: 0, y: 0, w: 900, h: 512 }];  // replaces the default framebuffers
    const a = addAsset(p, 'tex', 64, 64, 8);
    expect(a.x).toBeGreaterThanOrEqual(900);
    expect(validate(p).filter((i) => i.code === 'in-keepout')).toEqual([]);
  });

  it('flags a texture driven into one', () => {
    const p = emptyProject();
    const a = addAsset(p, 'tex', 64, 64, 8);
    p.keepouts = [{ id: 'k1', name: 'reserved', x: a.x, y: a.y, w: 64, h: 64 }];
    const issues = validate(p);
    expect(issues.map((i) => i.code)).toContain('in-keepout');
    expect(issues.find((i) => i.code === 'in-keepout')!.message).toMatch(/reserved/);
  });

  it('does not complain about a keepout covering a framebuffer', () => {
    // Two reserved regions overlapping is the user's business, not a defect.
    const p = emptyProject();
    p.keepouts.push({ id: 'k1', name: 'over fb', x: 0, y: 0, w: 320, h: 240 });
    expect(validate(p)).toEqual([]);
  });

  it('places new keepouts in free space', () => {
    const p = emptyProject();
    const k = createKeepout(p, 64, 64);
    p.keepouts.push(k);
    expect(validate(p)).toEqual([]);
    const k2 = createKeepout(p, 64, 64);
    expect(k2.x !== k.x || k2.y !== k.y).toBe(true);
  });

  it('round-trips through the project file', () => {
    const p = emptyProject();
    p.keepouts = [{ id: 'k1', name: 'scratch', x: 512, y: 256, w: 128, h: 64 }];
    const { project: back } = deserializeProject(serializeProject(p));
    expect(back.keepouts).toEqual(p.keepouts);
  });

  it('loads none when a project file has none', () => {
    const json = JSON.stringify({ formatVersion: 1, name: 'x', assets: [] });
    expect(deserializeProject(json).project.keepouts).toEqual([]);
  });

  it('starts a new project with two framebuffers, which are just keepouts', () => {
    const p = emptyProject();
    expect(p.keepouts.map((k) => k.name)).toEqual(['framebuffer 0', 'framebuffer 1']);
    expect(p.keepouts.map((k) => [k.x, k.y, k.w, k.h])).toEqual([
      [0, 0, 320, 240], [320, 0, 320, 240],
    ]);
  });

  it('appears in the VRAM map', () => {
    const p = emptyProject();
    p.keepouts = [{ id: 'k1', name: 'scratch', x: 512, y: 256, w: 128, h: 64 }];
    expect(buildMap(p)).toMatch(/# keepout scratch\t512,256\t128x64/);
  });
});

describe('locked assets', () => {
  it('round-trips the flag', () => {
    const p = emptyProject();
    const a = addAsset(p, 'tex', 32, 32, 8);
    a.locked = true;
    const { project: back } = deserializeProject(serializeProject(p));
    expect(back.assets[0].locked).toBe(true);
  });

  it('is absent by default rather than false-y noise', () => {
    const p = emptyProject();
    expect(addAsset(p, 'tex', 32, 32, 8).locked).toBeUndefined();
  });

  it('still reserves space, so nothing is placed on top of it', () => {
    const p = emptyProject();
    const a = addAsset(p, 'locked', 64, 64, 8);
    a.locked = true;
    addAsset(p, 'other', 64, 64, 8);
    expect(validate(p).filter((i) => i.code === 'overlap')).toEqual([]);
  });
});
