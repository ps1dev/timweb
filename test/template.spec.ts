import { describe, it, expect } from 'vitest';
import { renderTemplate, EXAMPLE_TEMPLATE, assetScope } from '../src/core/template.js';
import {
  emptyProject,
  createAsset,
  convertAsset,
  exportProject,
  vramHeight,
  validate,
  type Project,
} from '../src/core/project.js';
import { TimType } from '../src/core/tim.js';
import { VRAM_HEIGHT_1MB, VRAM_HEIGHT_2MB } from '../src/core/vram.js';

function withAssets(): Project {
  const p = emptyProject();
  p.name = 'demo';
  for (const [name, depth] of [['sky', TimType.Bpp8], ['hud', TimType.Bpp16]] as const) {
    const rgba = new Uint8ClampedArray(32 * 8 * 4);
    for (let i = 0; i < 32 * 8; i++) {
      rgba[i * 4] = (i % 7) * 30;
      rgba[i * 4 + 3] = 255;
    }
    const a = createAsset(name, 32, 8, rgba, p);
    a.settings.depthAuto = false;
    a.settings.depth = depth;
    convertAsset(a);
    p.assets.push(a);
  }
  p.assets[0].x = 640;
  p.assets[0].y = 0;
  p.assets[0].clutX = 32;
  p.assets[0].clutY = 500;
  return p;
}

const render = (t: string, p = withAssets()) =>
  renderTemplate(t, {
    project: p,
    vramHeight: vramHeight(p),
    files: p.assets.map((a) => ({
      image: `${a.name}_image.dat`,
      palette: `${a.name}_palette.dat`,
      tim: `${a.name}.tim`,
      pxl: `${a.name}.pxl`,
      clt: `${a.name}.clt`,
    })),
  });

describe('template rendering', () => {
  it('substitutes project-level values', () => {
    expect(render('{{project}} has {{assetCount}} in {{vramWidth}}x{{vramHeight}}'))
      .toBe('demo has 2 in 1024x512');
  });

  it('repeats a block per asset', () => {
    expect(render('{{#assets}}{{name}}@{{x}},{{y}};{{/assets}}')).toBe('sky@640,0;hud@704,0;');
  });

  it('exposes halfword and texel dimensions separately', () => {
    // sky is 8bpp: 32 texels wide is 16 halfwords. Conflating these is the
    // classic way to get a VRAM upload wrong.
    expect(render('{{#assets}}{{name}} w={{w}} width={{width}}\n{{/assets}}'))
      .toBe('sky w=16 width=32\nhud w=32 width=32\n');
  });

  it('formats numbers as hex on request', () => {
    // Both assets, so the second one also proves :HEX actually upper-cases -
    // 640 has no hex letters to show it, 704 does.
    expect(render('{{#assets}}{{x:hex}} {{x:hex4}} {{x:HEX4}};{{/assets}}'))
      .toBe('0x280 0x0280 0x0280;0x2c0 0x02c0 0x02C0;');
  });

  it('emits a clut block only for assets that have one', () => {
    expect(render('{{#assets}}{{name}}{{#clut}}:clut@{{clutX}},{{clutY}}{{/clut}};{{/assets}}'))
      .toBe('sky:clut@32,500;hud;');
  });

  it('supports the inverse clut block', () => {
    expect(render('{{#assets}}{{name}}{{^clut}}(direct){{/clut}};{{/assets}}'))
      .toBe('sky;hud(direct);');
  });

  it('leaves an unknown placeholder alone rather than emptying it', () => {
    // A typo that silently vanishes produces a struct with a missing field.
    expect(render('{{nosuchthing}}|{{#assets}}{{alsoNot}}{{/assets}}'))
      .toBe('{{nosuchthing}}|{{alsoNot}}{{alsoNot}}');
  });

  it('exposes the output filenames the template will reference', () => {
    expect(render('{{#assets}}{{imageFile}}+{{paletteFile}} {{timFile}};{{/assets}}'))
      .toBe('sky_image.dat+sky_palette.dat sky.tim;hud_image.dat+hud_palette.dat hud.tim;');
  });

  it('exposes the texture page and in-page UV', () => {
    // sky sits at x=640 halfwords = page column 10, and 640 is a page origin,
    // so u is 0.
    expect(render('{{#assets}}{{name}} page={{page}} u={{u}} v={{v}};{{/assets}}'))
      .toBe('sky page=10 u=0 v=0;hud page=11 u=0 v=0;');
  });

  it('renders the shipped example without leaving stray tags', () => {
    const out = render(EXAMPLE_TEMPLATE);
    expect(out).toMatch(/TextureInfo textures\[\]/);
    expect(out).toContain('{ "sky", 640, 0, 16, 8, 32, 8, 8, 32, 500 },');
    expect(out).toContain('{ "hud", 704, 0, 32, 8, 32, 8, 16, 0, 0 },');
    expect(out).not.toMatch(/\{\{|\}\}/);
  });

  it('handles a project with no assets', () => {
    const p = emptyProject();
    expect(renderTemplate('{{assetCount}}[{{#assets}}x{{/assets}}]', {
      project: p, vramHeight: 512, files: [],
    })).toBe('0[]');
  });

  it('reports the taller VRAM when 2MB is on', () => {
    const p = withAssets();
    p.vram2MB = true;
    expect(render('{{vramHeight}} {{vram2MB}}', p)).toBe('1024 true');
  });
});

describe('template in the export bundle', () => {
  it('writes to the configured filename, only when asked', () => {
    const p = withAssets();
    p.templateFile = 'textures.h';
    const names = (o: Parameters<typeof exportProject>[1]) =>
      exportProject(p, o).entries.map((e) => e.name);
    expect(names({ tim: false, template: true })).toContain('textures.h');
    expect(names({ tim: false })).not.toContain('textures.h');
  });

  it('renders against the same suffixes the raw export uses', () => {
    const p = withAssets();
    p.imageSuffix = 'Data.dat';
    p.template = '{{#assets}}{{imageFile}}\n{{/assets}}';
    const entry = exportProject(p, { tim: false, raw: true, template: true }).entries;
    const rendered = new TextDecoder().decode(entry.find((e) => e.name === 'placements.h')!.data);
    expect(rendered).toBe('skyData.dat\nhudData.dat\n');
    expect(entry.map((e) => e.name)).toContain('skyData.dat');
  });
});

describe('2MB VRAM', () => {
  it('doubles the height and nothing else', () => {
    expect(VRAM_HEIGHT_1MB).toBe(512);
    expect(VRAM_HEIGHT_2MB).toBe(1024);
    const p = emptyProject();
    expect(vramHeight(p)).toBe(512);
    p.vram2MB = true;
    expect(vramHeight(p)).toBe(1024);
  });

  it('lets a placement live in the upper bank only when enabled', () => {
    const p = withAssets();
    p.assets[0].y = 700;
    expect(validate(p).map((i) => i.code)).toContain('out-of-bounds');
    p.vram2MB = true;
    expect(validate(p).map((i) => i.code)).not.toContain('out-of-bounds');
  });
});

describe('asset scope', () => {
  it('reports zeroed CLUT fields for a 16bpp asset rather than stale ones', () => {
    const p = withAssets();
    p.assets[1].clutX = 999;
    p.assets[1].clutY = 999;
    const s = assetScope(p.assets[1], 1, p, {
      image: 'a', palette: 'b', tim: 'c', pxl: 'd', clt: 'e',
    });
    expect(s.hasClut).toBe(false);
    expect(s.clutX).toBe(0);
    expect(s.clutY).toBe(0);
  });
});

describe('keepouts in templates', () => {
  it('repeats a block per keepout', () => {
    const p = withAssets();
    expect(render('{{keepoutCount}}|{{#keepouts}}{{name}}@{{x}},{{y}} {{w}}x{{h}};{{/keepouts}}', p))
      .toBe('2|framebuffer 0@0,0 320x240;framebuffer 1@320,0 320x240;');
  });
});
