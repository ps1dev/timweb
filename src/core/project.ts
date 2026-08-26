/**
 * Project model: a set of assets placed in VRAM, plus their conversion
 * settings, serializable to JSON.
 *
 * The one behaviour worth stealing from TIMTOOL is INHERIT-ON-REIMPORT: when
 * you re-export art and bring it back in, the VRAM placement, CLUT placement
 * and bit depth survive. That is what keeps a layout usable across an art
 * pipeline instead of being redone every time. Here that falls out of keeping
 * placement on the asset and matching by name on re-import.
 */

import {
  TimType,
  halfwordWidth,
  timFromIndexed,
  timFromRGBA16,
  serializeTim,
  parseTim,
  decodeToRGBA,
  texelWidth,
  timToSplit,
  serializeSplit,
  parseSplit,
  splitToTim,
  type Tim,
  type SplitFile,
} from './tim.js';
import {
  quantize,
  DEFAULT_ALPHA_TRANSPARENT,
  DEFAULT_ALPHA_SOLID,
  type QuantizeResult,
  type BlackMode,
} from './quantize.js';
import { NEAR_BLACK } from './color.js';
import {
  CLUT_X_ALIGN,
  PAGE_WIDTH,
  VRAM_WIDTH,
  VRAM_HEIGHT,
  VRAM_HEIGHT_1MB,
  VRAM_HEIGHT_2MB,
  checkLayout,
  findFreeSpot,
  type Issue,
  type Placement,
  type VramRect,
} from './vram.js';
import { chooseDepth, type SelectableDepth } from './depth.js';
import { buildZip, type ZipEntry } from './zip.js';
import { toRaw } from './raw.js';
import { renderTemplate, EXAMPLE_TEMPLATE } from './template.js';

export const PROJECT_FORMAT_VERSION = 1;

export interface AssetSettings {
  depth: SelectableDepth;
  /** True when the depth was picked by the cost model rather than by hand. */
  depthAuto: boolean;
  dither: boolean;
  /**
   * How opaque black is stored. 'gray' substitutes blackReplacement and is
   * unconditionally opaque; 'stp' uses 0x8000, which is true black only while
   * the primitive is drawn with semi-transparency disabled.
   */
  blackMode: BlackMode;
  blackReplacement: number;
  /** Set STP on every non-transparent texel. Implies blackMode 'stp'. */
  forceSTP: boolean;
  /** Alpha below this is a hole; at or above alphaSolid is opaque; between is STP. */
  alphaTransparent: number;
  alphaSolid: number;
}

export interface Asset {
  id: string;
  /** Base name, no extension. Drives the output filename and re-import matching. */
  name: string;
  width: number;
  height: number;
  /** Source pixels, RGBA. Not serialized into the project JSON. */
  rgba: Uint8ClampedArray;
  settings: AssetSettings;
  /**
   * Locked in place: cannot be dragged, and "Find free space" refuses to move
   * it. A layout tool that relocates something the user positioned by hand is
   * worse than one that does not try.
   *
   * DELIBERATELY NOT the same thing as "exclude from packing". That is a
   * separate flag for a packer that does not exist yet, and conflating them
   * would make this checkbox a promise about behaviour nothing implements.
   */
  locked?: boolean;
  /** VRAM position in halfwords. */
  x: number;
  y: number;
  /** CLUT position in halfwords. Ignored at 16bpp. */
  clutX: number;
  clutY: number;
  /** Result of the last conversion, if it has been run. */
  converted?: QuantizeResult;
}

export const DEFAULT_IMAGE_SUFFIX = '_image.dat';
export const DEFAULT_PALETTE_SUFFIX = '_palette.dat';
export const DEFAULT_PXL_SUFFIX = '.pxl';
export const DEFAULT_CLT_SUFFIX = '.clt';

/**
 * An arbitrary reserved region the packer and auto-placement must avoid.
 *
 * Generalises the framebuffer reservation: a project may need to keep the
 * packer out of scratch space, a region another subsystem owns, or anywhere
 * else that is spoken for. Framebuffers stay a separate kind because they have
 * a resolution and layout presets; keepouts are just rectangles.
 */
export interface Keepout {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Common framebuffer sizes, offered as one-click keepout inserts.
 *
 * A framebuffer IS a keepout - same behaviour, same drag, same avoidance - so
 * it is one, rather than a parallel mechanism that happens to look the same.
 * These are just sizes worth not typing.
 */
export const FRAMEBUFFER_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '320x240', w: 320, h: 240 },
  { label: '320x256', w: 320, h: 256 },
  { label: '368x240', w: 368, h: 240 },
  { label: '512x240', w: 512, h: 240 },
  { label: '640x480', w: 640, h: 480 },
];

export interface Project {
  formatVersion: number;
  name: string;
  clutPenalty: number;
  qualityFloor?: number;
  /** Appended to the asset name for the raw image file. */
  imageSuffix: string;
  /** Appended to the asset name for the raw palette file. */
  paletteSuffix: string;
  /** Appended to the asset name for split PXL/CLT files. */
  pxlSuffix: string;
  cltSuffix: string;
  /**
   * 2MB VRAM: 1024x1024 instead of 1024x512. Not an arcade feature - the
   * 10-bit Y path exists in all 208-pin retail silicon; retail boards just
   * never populated the second bank.
   */
  vram2MB: boolean;
  /** Template for the placement text export, and the filename it writes to. */
  template: string;
  templateFile: string;
  keepouts: Keepout[];
  assets: Asset[];
}

export function emptyProject(): Project {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    name: 'untitled',
    clutPenalty: 1,
    // ON by default, and this is load-bearing. With no floor the cost model
    // decides on VRAM alone, and 4bpp is cheapest for every image at every
    // size - so auto-depth hands a 4000-colour texture sixteen entries and
    // reports 99% of pixels past the error floor. Measured by looking at the
    // running tool, not by a test: every unit test passed while it did this.
    qualityFloor: 90,
    imageSuffix: DEFAULT_IMAGE_SUFFIX,
    paletteSuffix: DEFAULT_PALETTE_SUFFIX,
    pxlSuffix: DEFAULT_PXL_SUFFIX,
    cltSuffix: DEFAULT_CLT_SUFFIX,
    vram2MB: false,
    template: EXAMPLE_TEMPLATE,
    templateFile: 'placements.h',
    // Two 320x240 framebuffers side by side: the conventional starting layout,
    // and nothing more special than any other pair of keepouts.
    keepouts: [
      { id: 'fb0', name: 'framebuffer 0', x: 0, y: 0, w: 320, h: 240 },
      { id: 'fb1', name: 'framebuffer 1', x: 320, y: 0, w: 320, h: 240 },
    ],
    assets: [],
  };
}

export function defaultSettings(): AssetSettings {
  return {
    depth: TimType.Bpp8,
    depthAuto: true,
    dither: false,
    blackMode: 'gray',
    blackReplacement: NEAR_BLACK,
    forceSTP: false,
    alphaTransparent: DEFAULT_ALPHA_TRANSPARENT,
    alphaSolid: DEFAULT_ALPHA_SOLID,
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** VRAM rect a converted asset's pixel data occupies, in halfwords. */
export function pixelRect(asset: Asset): VramRect {
  return {
    x: asset.x,
    y: asset.y,
    w: halfwordWidth(asset.width, asset.settings.depth),
    h: asset.height,
  };
}

/** VRAM rect the asset's CLUT occupies, or undefined at 16bpp. */
export function clutRect(asset: Asset): VramRect | undefined {
  if (asset.settings.depth === TimType.Bpp16) return undefined;
  return {
    x: asset.clutX,
    y: asset.clutY,
    w: asset.settings.depth === TimType.Bpp4 ? 16 : 256,
    h: 1,
  };
}

/** Every placement in the project, including the display region. */
export function projectPlacements(project: Project): Placement[] {
  const out: Placement[] = [];

  for (const k of project.keepouts) {
    out.push({
      id: `keepout:${k.id}`,
      kind: 'keepout',
      rect: { x: k.x, y: k.y, w: k.w, h: k.h },
      label: k.name || 'keepout',
    });
  }

  for (const a of project.assets) {
    out.push({
      id: `tex:${a.id}`,
      kind: 'texture',
      rect: pixelRect(a),
      type: a.settings.depth,
      label: a.name,
    });
    const c = clutRect(a);
    if (c) {
      out.push({ id: `clut:${a.id}`, kind: 'clut', rect: c, label: `${a.name} CLUT` });
    }
  }

  return out;
}

/** VRAM height this project is laid out against. */
export function vramHeight(project: Project): number {
  return project.vram2MB ? VRAM_HEIGHT_2MB : VRAM_HEIGHT_1MB;
}

export function validate(project: Project): Issue[] {
  return checkLayout(projectPlacements(project), vramHeight(project));
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** The conversion half of an asset's settings, shared by every code path that
 *  converts one - so a new option cannot be wired into some of them. */
export function quantizeOptionsFor(s: AssetSettings) {
  return {
    blackMode: s.blackMode,
    blackReplacement: s.blackReplacement,
    forceSTP: s.forceSTP,
    alphaTransparent: s.alphaTransparent,
    alphaSolid: s.alphaSolid,
    dither: s.dither,
  };
}

export function paletteSizeFor(depth: SelectableDepth): number {
  return depth === TimType.Bpp4 ? 16 : depth === TimType.Bpp8 ? 256 : 0;
}

/** Run the quantizer for one asset and cache the result on it. */
export function convertAsset(asset: Asset): QuantizeResult | undefined {
  if (asset.settings.depth === TimType.Bpp16) {
    asset.converted = undefined;
    return undefined;
  }
  const result = quantize(asset.rgba, asset.width, asset.height, {
    maxColors: paletteSizeFor(asset.settings.depth),
    ...quantizeOptionsFor(asset.settings),
  });
  asset.converted = result;
  return result;
}

/**
 * Pick a depth for an asset using the cost model, measuring real quality at
 * each indexed depth rather than guessing at it.
 *
 * Measuring costs two quantizer runs. That is the price of the quality floor
 * meaning anything: the model refuses to certify an ungraded depth, so without
 * these runs everything falls back to 16bpp.
 */
export function autoDepth(asset: Asset, project: Project): SelectableDepth {
  const quality: Partial<Record<TimType.Bpp4 | TimType.Bpp8, number>> = {};

  if (project.qualityFloor !== undefined) {
    for (const depth of [TimType.Bpp4, TimType.Bpp8] as const) {
      try {
        const r = quantize(asset.rgba, asset.width, asset.height, {
          maxColors: paletteSizeFor(depth),
          ...quantizeOptionsFor(asset.settings),
        });
        // Map "fraction of pixels past the truncation floor" onto a 0-100
        // quality figure. This is a LOCAL proxy, not libimagequant's Q, and it
        // is MSE-flavoured - so it is fit for gating on gross failure and unfit
        // for deciding which of two decent options looks better. That call
        // belongs to eyes.
        quality[depth] = Math.round((1 - r.report.pastFloorFraction) * 100);
      } catch {
        // A palette too small to hold even the transparent slot: not viable.
      }
    }
  }

  const choice = chooseDepth(asset.width, asset.height, {
    clutPenalty: project.clutPenalty,
    qualityFloor: project.qualityFloor,
    quality,
  });
  return choice.best.type;
}

/**
 * Pull an asset back inside VRAM if a depth change grew it past the edge.
 *
 * Deliberately a clamp and not a re-place: moving something the user
 * positioned by hand is worse than nudging it, and an out-of-bounds placement
 * is reported as an issue either way.
 */
export function clampIntoVram(asset: Asset, height = VRAM_HEIGHT): void {
  const p = pixelRect(asset);
  asset.x = Math.max(0, Math.min(VRAM_WIDTH - p.w, asset.x));
  asset.y = Math.max(0, Math.min(height - p.h, asset.y));
  const c = clutRect(asset);
  if (c) {
    asset.clutX = Math.max(0, Math.min(VRAM_WIDTH - c.w, asset.clutX));
    asset.clutX = Math.round(asset.clutX / CLUT_X_ALIGN) * CLUT_X_ALIGN;
    asset.clutY = Math.max(0, Math.min(height - 1, asset.clutY));
  }
}

/** Build the TIM for an asset, converting first if needed. */
export function buildTim(asset: Asset): Tim {
  const { depth } = asset.settings;

  if (depth === TimType.Bpp16) {
    return timFromRGBA16(
      asset.rgba,
      asset.width,
      asset.height,
      { x: asset.x, y: asset.y },
      quantizeOptionsFor(asset.settings),
    );
  }

  const result = asset.converted ?? convertAsset(asset)!;
  return timFromIndexed(
    result.indices,
    result.palette,
    asset.width,
    asset.height,
    depth,
    { x: asset.x, y: asset.y, clutX: asset.clutX, clutY: asset.clutY },
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

let nextKeepout = 1;

/** A keepout in the first free space large enough to hold it. */
export function createKeepout(project: Project, w = 64, h = 64): Keepout {
  const spot = findFreeSpot(projectPlacements(project), w, h, {
    height: vramHeight(project),
  }) ?? { x: 0, y: 0 };
  return { id: `k${nextKeepout++}`, name: `keepout ${nextKeepout - 1}`, ...spot, w, h };
}

let nextId = 1;
export function makeId(): string {
  return `a${nextId++}`;
}

/**
 * Create an asset, inheriting placement and depth from an existing asset of
 * the same name when one is present. This is TIMTOOL's inherit-on-reimport.
 */
export function createAsset(
  name: string,
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  project: Project,
): Asset {
  const prior = project.assets.find((a) => a.name === name);
  if (prior) {
    return {
      ...prior,
      id: prior.id,
      width,
      height,
      rgba,
      converted: undefined,
    };
  }

  const settings = defaultSettings();

  // Choose the depth BEFORE placing. Placing first and then letting auto-depth
  // change the depth silently changes the width - a 256-texel image placed as
  // 8bpp (128 halfwords) becomes 16bpp (256 halfwords) and runs off the end of
  // VRAM with nothing re-checking it. Found by looking at the running tool.
  if (settings.depthAuto) {
    settings.depth = autoDepth(
      { id: '', name, width, height, rgba, settings, x: 0, y: 0, clutX: 0, clutY: 0 },
      project,
    );
  }

  const w = halfwordWidth(width, settings.depth);
  const existing = projectPlacements(project);

  const spot =
    findFreeSpot(existing, w, height, {
      alignX: PAGE_WIDTH,
      avoidRowStraddle: true,
      height: vramHeight(project),
    }) ??
    findFreeSpot(existing, w, height, { alignX: PAGE_WIDTH, height: vramHeight(project) }) ??
    { x: 0, y: 0 };

  // The CLUT search must see the texture we just placed, or the two land on
  // the same free spot and overlap on arrival.
  const withTexture: Placement[] = [
    ...existing,
    { id: 'pending', kind: 'texture', rect: { ...spot, w, h: height } },
  ];
  const clutWidth = settings.depth === TimType.Bpp4 ? 16 : 256;
  const clutSpot =
    findFreeSpot(withTexture, clutWidth, 1, {
      alignX: CLUT_X_ALIGN,
      fromBottom: true,
      height: vramHeight(project),
    }) ?? { x: 0, y: vramHeight(project) - 1 };

  return {
    id: makeId(),
    name,
    width,
    height,
    rgba,
    settings,
    x: spot.x,
    y: spot.y,
    clutX: clutSpot.x,
    clutY: clutSpot.y,
  };
}

/**
 * Import an existing .tim, placing it at the coordinates it already carries.
 *
 * TIM is self-describing about where it wants to live, so a tool that can only
 * write them is doing half the job.
 */
export function assetFromTim(
  name: string,
  bytes: Uint8Array,
): { asset: Omit<Asset, 'id'>; warnings: string[] } | { error: string } {
  const { tim, diagnostics } = parseTim(bytes);
  if (!tim) {
    return { error: diagnostics.map((d) => d.message).join('; ') || 'not a TIM' };
  }
  if (tim.type === TimType.Bpp24 || tim.type === TimType.Mixed) {
    return { error: `type ${tim.type} is not editable here` };
  }

  const { width, height, rgba } = decodeToRGBA(tim);
  const settings = defaultSettings();
  settings.depth = tim.type as SelectableDepth;
  settings.depthAuto = false;

  return {
    asset: {
      name,
      width,
      height,
      rgba,
      settings,
      x: tim.pixels.x,
      y: tim.pixels.y,
      clutX: tim.clut?.x ?? 0,
      clutY: tim.clut?.y ?? 511,
    },
    warnings: diagnostics.map((d) => d.message),
  };
}

/**
 * Build an asset from a .pxl plus an optional .clt.
 *
 * A 4bpp or 8bpp PXL on its own carries indices with nothing to look them up
 * in, so it cannot be decoded. That is a real answer, not a failure of the
 * parser, and it is reported as such rather than guessed at with a ramp.
 */
export function assetFromSplit(
  name: string,
  pxlBytes: Uint8Array,
  cltBytes?: Uint8Array,
): { asset: Omit<Asset, 'id'>; warnings: string[] } | { error: string } {
  const p = parseSplit(pxlBytes);
  if (!p.file) {
    return { error: p.diagnostics.map((d) => d.message).join('; ') || 'not a PXL' };
  }
  if (p.file.kind !== 'pxl') {
    return { error: 'that is a CLT, not a PXL' };
  }

  let clt: SplitFile | undefined;
  const warnings = p.diagnostics.map((d) => d.message);
  if (cltBytes) {
    const c = parseSplit(cltBytes);
    if (!c.file) {
      return { error: `palette: ${c.diagnostics.map((d) => d.message).join('; ')}` };
    }
    if (c.file.kind !== 'clt') return { error: 'expected a CLT for the palette' };
    clt = c.file;
    warnings.push(...c.diagnostics.map((d) => d.message));
  }

  const type = p.file.type;
  if ((type === TimType.Bpp4 || type === TimType.Bpp8) && !clt) {
    return {
      error: `${name}: a ${type === TimType.Bpp4 ? '4bpp' : '8bpp'} PXL needs its CLT to be decodable - import both together`,
    };
  }

  const tim = splitToTim(p.file, clt);
  const { width, height, rgba } = decodeToRGBA(tim);
  const settings = defaultSettings();
  settings.depth = tim.type as SelectableDepth;
  settings.depthAuto = false;

  return {
    asset: {
      name,
      width,
      height,
      rgba,
      settings,
      x: tim.pixels.x,
      y: tim.pixels.y,
      clutX: tim.clut?.x ?? 0,
      clutY: tim.clut?.y ?? 511,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

interface SerializedAsset {
  id: string;
  name: string;
  width: number;
  height: number;
  settings: AssetSettings;
  x: number;
  y: number;
  clutX: number;
  clutY: number;
  locked?: boolean;
}

export interface SerializedProject {
  formatVersion: number;
  name: string;
  clutPenalty: number;
  qualityFloor?: number;
  imageSuffix?: string;
  paletteSuffix?: string;
  pxlSuffix?: string;
  cltSuffix?: string;
  vram2MB?: boolean;
  template?: string;
  templateFile?: string;
  keepouts?: Keepout[];
  assets: SerializedAsset[];
}

/**
 * Serialize a project WITHOUT its source pixels.
 *
 * Deliberate: a project file is a layout, not an asset bundle. Round-tripping
 * megabytes of source art through JSON would make the file unusable, and the
 * art lives in the user's own pipeline where it belongs. On load, assets come
 * back as placeholders until their source images are re-supplied - matched by
 * name, which is the same mechanism as inherit-on-reimport.
 */
export function serializeProject(project: Project): string {
  const out: SerializedProject = {
    formatVersion: PROJECT_FORMAT_VERSION,
    name: project.name,
    clutPenalty: project.clutPenalty,
    qualityFloor: project.qualityFloor,
    imageSuffix: project.imageSuffix,
    paletteSuffix: project.paletteSuffix,
    pxlSuffix: project.pxlSuffix,
    cltSuffix: project.cltSuffix,
    vram2MB: project.vram2MB,
    template: project.template,
    templateFile: project.templateFile,
    keepouts: project.keepouts,
    assets: project.assets.map((a) => ({
      id: a.id,
      name: a.name,
      width: a.width,
      height: a.height,
      settings: a.settings,
      x: a.x,
      y: a.y,
      clutX: a.clutX,
      clutY: a.clutY,
      locked: a.locked,
    })),
  };
  return JSON.stringify(out, null, 2);
}

export interface LoadedProject {
  project: Project;
  /** Names whose pixels were not supplied and are therefore placeholders. */
  missing: string[];
}

export function deserializeProject(
  json: string,
  pixelSource: (name: string) => Uint8ClampedArray | undefined = () => undefined,
): LoadedProject {
  const parsed = JSON.parse(json) as SerializedProject;
  if (typeof parsed?.formatVersion !== 'number') {
    throw new Error('not a timweb project file');
  }
  if (parsed.formatVersion > PROJECT_FORMAT_VERSION) {
    throw new Error(
      `project format version ${parsed.formatVersion} is newer than this build understands (${PROJECT_FORMAT_VERSION})`,
    );
  }

  const missing: string[] = [];
  const assets: Asset[] = parsed.assets.map((s) => {
    const rgba = pixelSource(s.name);
    if (!rgba) missing.push(s.name);
    return {
      ...s,
      settings: { ...defaultSettings(), ...s.settings },
      rgba: rgba ?? new Uint8ClampedArray(s.width * s.height * 4),
    };
  });

  // Keep generated ids from colliding with loaded ones.
  for (const a of assets) {
    const n = Number(a.id.replace(/^a/, ''));
    if (Number.isFinite(n) && n >= nextId) nextId = n + 1;
  }

  return {
    project: {
      formatVersion: PROJECT_FORMAT_VERSION,
      name: parsed.name ?? 'untitled',

      clutPenalty: parsed.clutPenalty ?? 1,
      qualityFloor: parsed.qualityFloor,
      imageSuffix: parsed.imageSuffix ?? DEFAULT_IMAGE_SUFFIX,
      paletteSuffix: parsed.paletteSuffix ?? DEFAULT_PALETTE_SUFFIX,
      pxlSuffix: parsed.pxlSuffix ?? DEFAULT_PXL_SUFFIX,
      cltSuffix: parsed.cltSuffix ?? DEFAULT_CLT_SUFFIX,
      vram2MB: parsed.vram2MB ?? false,
      template: parsed.template ?? EXAMPLE_TEMPLATE,
      templateFile: parsed.templateFile ?? 'placements.h',
      keepouts: (parsed.keepouts ?? []).map((k) => ({ ...k })),
      assets,
    },
    missing,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * A VRAM map, in the spirit of TIMTOOL's MAP output: a plain-text record of
 * what ended up where. Not a Sony format - nothing local documents one well
 * enough to claim compatibility, and a wrong binary would be worse than an
 * honest text file.
 */
export function buildMap(project: Project): string {
  const lines: string[] = [
    `# timweb VRAM map for ${project.name}`,
    `# all coordinates in 16-bit halfwords`,

    `# raw .dat files carry no header: width, height and depth are only here`,
    `# VRAM 1024x${project.vram2MB ? 1024 : 512} halfwords${project.vram2MB ? ' (2MB)' : ''}`,
    '',
    '# name\tdepth\tx\ty\tw\th\ttexels\tclutX\tclutY\tclutW',
  ];
  for (const k of project.keepouts) {
    lines.push(`# keepout ${k.name || k.id}\t${k.x},${k.y}\t${k.w}x${k.h}`);
  }
  for (const a of project.assets) {
    const p = pixelRect(a);
    const c = clutRect(a);
    const bpp = a.settings.depth === TimType.Bpp4 ? 4 : a.settings.depth === TimType.Bpp8 ? 8 : 16;
    lines.push(
      [
        a.name,
        `${bpp}bpp`,
        p.x,
        p.y,
        p.w,
        p.h,
        `${texelWidth(p.w, a.settings.depth)}x${a.height}`,
        c ? c.x : '-',
        c ? c.y : '-',
        c ? c.w : '-',
      ].join('\t'),
    );
  }
  return lines.join('\n') + '\n';
}

export interface ExportBundle {
  entries: ZipEntry[];
  zip: Uint8Array;
}

export interface ExportOptions {
  /**
   * Emit a .tim per asset. Defaults TRUE and stays true even when `raw` is
   * requested - asking for raw does not implicitly turn TIMs off. Say
   * `{ tim: false, raw: true }` for raw only. Deliberately not clever: a flag
   * whose default depends on another flag is where surprises live.
   */
  tim?: boolean;
  /**
   * Emit headerless image + palette files per asset, the shape
   * ps1-bare-metal's convertImage.py produces.
   */
  raw?: boolean;
  /**
   * Emit split .pxl + .clt files: a TIM header carrying only the pixel section
   * and only the CLUT section respectively. Rare, but real - Granstream Saga,
   * both Bloody Roars.
   */
  pxl?: boolean;
  /** Render the project's placement template to a text file. */
  template?: boolean;
  /** Override the project's filename suffixes for this export. */
  imageSuffix?: string;
  paletteSuffix?: string;
  pxlSuffix?: string;
  cltSuffix?: string;
}

export function exportProject(
  project: Project,
  options: ExportOptions = { tim: true },
): ExportBundle {
  const {
    tim = true,
    raw = false,
    pxl: wantSplit = false,
    template: wantTemplate = false,
    imageSuffix = project.imageSuffix ?? DEFAULT_IMAGE_SUFFIX,
    paletteSuffix = project.paletteSuffix ?? DEFAULT_PALETTE_SUFFIX,
    pxlSuffix = project.pxlSuffix ?? DEFAULT_PXL_SUFFIX,
    cltSuffix = project.cltSuffix ?? DEFAULT_CLT_SUFFIX,
  } = options;
  const entries: ZipEntry[] = [];

  for (const asset of project.assets) {
    const built = buildTim(asset);
    if (tim) {
      entries.push({ name: `${asset.name}.tim`, data: serializeTim(built) });
    }
    if (raw) {
      const r = toRaw(built, asset.width);
      entries.push({ name: `${asset.name}${imageSuffix}`, data: r.image });
      if (r.palette) {
        entries.push({ name: `${asset.name}${paletteSuffix}`, data: r.palette });
      }
    }
    if (wantSplit) {
      const { pxl, clt } = timToSplit(built);
      entries.push({ name: `${asset.name}${pxlSuffix}`, data: serializeSplit(pxl) });
      if (clt) {
        entries.push({ name: `${asset.name}${cltSuffix}`, data: serializeSplit(clt) });
      }
    }
  }

  if (wantTemplate && project.template) {
    const files = project.assets.map((a) => ({
      image: `${a.name}${imageSuffix}`,
      palette: `${a.name}${paletteSuffix}`,
      tim: `${a.name}.tim`,
      pxl: `${a.name}${pxlSuffix}`,
      clt: `${a.name}${cltSuffix}`,
    }));
    entries.push({
      name: project.templateFile || 'placements.txt',
      data: new TextEncoder().encode(
        renderTemplate(project.template, {
          project,
          vramHeight: vramHeight(project),
          files,
        }),
      ),
    });
  }

  entries.push({
    name: `${project.name}.timweb.json`,
    data: new TextEncoder().encode(serializeProject(project)),
  });
  entries.push({
    name: `${project.name}.map.txt`,
    data: new TextEncoder().encode(buildMap(project)),
  });
  return { entries, zip: buildZip(entries) };
}
