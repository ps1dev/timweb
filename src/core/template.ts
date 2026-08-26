/**
 * Placement export through a user-supplied text template.
 *
 * Raw .dat files carry no coordinates, so on their own they are half an
 * export - something still has to tell the program where each one goes. Rather
 * than pick a language and a struct layout, this renders whatever the user
 * writes: a C array, a series of sendVRAMData() calls, a Makefile fragment,
 * JSON, anything.
 *
 * Syntax, deliberately tiny:
 *
 *   {{name}}              substitute a value
 *   {{x:hex}}             ... as 0x1f
 *   {{x:hex4}}            ... as 0x001f, zero-padded to 4 digits
 *   {{#assets}}...{{/assets}}   repeat per asset
 *   {{#clut}}...{{/clut}}       only when this asset has a CLUT
 *   {{^clut}}...{{/clut}}       only when it does not
 *
 * An unknown placeholder is left alone rather than silently emptied, so a
 * typo shows up in the output instead of quietly producing a struct with a
 * missing field.
 */

import { TimType, texelWidth, halfwordWidth } from './tim.js';
import { PAGE_WIDTH, PAGE_HEIGHT, PAGES_ACROSS } from './vram.js';
import type { Asset, Project } from './project.js';

export type Scalar = string | number | boolean;
export type Scope = Record<string, Scalar>;

/** Values available inside an {{#assets}} block. */
export function assetScope(
  asset: Asset,
  index: number,
  project: Project,
  files: { image: string; palette: string; tim: string; pxl: string; clt: string },
): Scope {
  const depth = asset.settings.depth;
  const bpp = depth === TimType.Bpp4 ? 4 : depth === TimType.Bpp8 ? 8 : 16;
  const w = halfwordWidth(asset.width, depth);
  const hasClut = depth !== TimType.Bpp16;
  const clutEntries = depth === TimType.Bpp4 ? 16 : depth === TimType.Bpp8 ? 256 : 0;

  return {
    index,
    name: asset.name,
    // VRAM, in halfwords - the units a GPU transfer command takes.
    x: asset.x,
    y: asset.y,
    w,
    h: asset.height,
    // Texels, which is what the artist sees and what UVs are in.
    width: asset.width,
    height: asset.height,
    bpp,
    depth: `${bpp}bpp`,
    // Texture page containing the top-left corner.
    pageX: Math.floor(asset.x / PAGE_WIDTH) * PAGE_WIDTH,
    pageY: Math.floor(asset.y / PAGE_HEIGHT) * PAGE_HEIGHT,
    page: Math.floor(asset.y / PAGE_HEIGHT) * PAGES_ACROSS + Math.floor(asset.x / PAGE_WIDTH),
    // U/V of the top-left corner within its page, which is what a texture
    // primitive actually wants.
    u: texelWidth(asset.x % PAGE_WIDTH, depth),
    v: asset.y % PAGE_HEIGHT,
    hasClut,
    clutX: hasClut ? asset.clutX : 0,
    clutY: hasClut ? asset.clutY : 0,
    clutW: hasClut ? clutEntries : 0,
    clutEntries,
    imageFile: files.image,
    paletteFile: files.palette,
    timFile: files.tim,
    pxlFile: files.pxl,
    cltFile: files.clt,
  };
}

export function projectScope(project: Project, vramHeight: number): Scope {
  return {
    project: project.name,
    assetCount: project.assets.length,
    vramWidth: 1024,
    vramHeight,
    vram2MB: project.vram2MB,
    keepoutCount: project.keepouts.length,
  };
}

function format(value: Scalar, spec?: string): string {
  if (!spec) return String(value);
  const m = /^hex(\d*)$/i.exec(spec);
  if (m && typeof value === 'number') {
    const digits = m[1] ? Number(m[1]) : 0;
    const body = Math.abs(value).toString(16).padStart(digits, '0');
    const cased = spec.startsWith('HEX') ? body.toUpperCase() : body;
    return `${value < 0 ? '-' : ''}0x${cased}`;
  }
  return String(value);
}

const TOKEN = /\{\{\s*([#^/]?)([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z0-9]+))?\s*\}\}/g;

/** Substitute {{var}} in one scope. Unknown names are left verbatim. */
function substitute(text: string, scope: Scope): string {
  return text.replace(TOKEN, (whole, sigil: string, key: string, spec?: string) => {
    if (sigil) return whole;
    return key in scope ? format(scope[key], spec) : whole;
  });
}

/** Extract `{{#name}}body{{/name}}` (or `{{^name}}`) starting at `from`. */
function findBlock(
  text: string,
  name: string,
  from = 0,
): { start: number; end: number; body: string; inverted: boolean } | undefined {
  const open = new RegExp(`\\{\\{\\s*([#^])\\s*${name}\\s*\\}\\}`, 'g');
  open.lastIndex = from;
  const m = open.exec(text);
  if (!m) return undefined;
  const closeTag = new RegExp(`\\{\\{\\s*/\\s*${name}\\s*\\}\\}`, 'g');
  closeTag.lastIndex = open.lastIndex;
  const c = closeTag.exec(text);
  if (!c) return undefined;
  return {
    start: m.index,
    end: c.index + c[0].length,
    body: text.slice(open.lastIndex, c.index),
    inverted: m[1] === '^',
  };
}

export interface RenderInput {
  project: Project;
  vramHeight: number;
  /** Resolved output filenames per asset, in project asset order. */
  files: { image: string; palette: string; tim: string; pxl: string; clt: string }[];
}

/** Render a template. Throws only on a malformed block, never on a bad name. */
export function renderTemplate(template: string, input: RenderInput): string {
  const top = projectScope(input.project, input.vramHeight);
  let out = template;

  // {{#keepouts}} ... {{/keepouts}}
  for (;;) {
    const block = findBlock(out, 'keepouts');
    if (!block) break;
    const rendered = input.project.keepouts
      .map((k, i) =>
        substitute(block.body, {
          ...top,
          index: i,
          name: k.name,
          x: k.x,
          y: k.y,
          w: k.w,
          h: k.h,
        }),
      )
      .join('');
    out = out.slice(0, block.start) + rendered + out.slice(block.end);
  }

  // {{#assets}} ... {{/assets}}
  for (;;) {
    const block = findBlock(out, 'assets');
    if (!block) break;
    const rendered = input.project.assets
      .map((asset, i) => {
        const scope = { ...top, ...assetScope(asset, i, input.project, input.files[i]) };
        let body = block.body;
        // Nested conditional on whether this asset has a CLUT.
        for (;;) {
          const cond = findBlock(body, 'clut');
          if (!cond) break;
          const keep = cond.inverted ? !scope.hasClut : !!scope.hasClut;
          body = body.slice(0, cond.start) + (keep ? cond.body : '') + body.slice(cond.end);
        }
        return substitute(body, scope);
      })
      .join('');
    out = out.slice(0, block.start) + rendered + out.slice(block.end);
  }

  return substitute(out, top);
}

/**
 * A starting template, shown in the UI so the syntax is discoverable.
 * Deliberately generic - the point is that consumers bring their own.
 */
export const EXAMPLE_TEMPLATE = `// {{project}}: {{assetCount}} textures, VRAM {{vramWidth}}x{{vramHeight}}

typedef struct {
    const char *name;
    uint16_t    x, y, w, h;      // VRAM, in halfwords
    uint16_t    width, height;   // texels
    uint8_t     bpp;
    uint16_t    clutX, clutY;
} TextureInfo;

static const TextureInfo textures[] = {
{{#assets}}    { "{{name}}", {{x}}, {{y}}, {{w}}, {{h}}, {{width}}, {{height}}, {{bpp}}{{#clut}}, {{clutX}}, {{clutY}}{{/clut}}{{^clut}}, 0, 0{{/clut}} },
{{/assets}}};
`;
