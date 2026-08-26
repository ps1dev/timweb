/**
 * Colour quantization targeting PlayStation CLUTs.
 *
 * The measured lessons this is built around, from prior PS1 texture work in
 * this codebase's sibling projects:
 *
 * 1. QUANTIZE AT FULL PRECISION, TRUNCATE AFTERWARDS. Pre-rounding the source
 *    to RGB555 before quantizing rescues a weak quantizer and HANDICAPS a good
 *    one - a good quantizer places palette entries using full-precision
 *    distances, and 5-bit input throws away exactly what it was using.
 *    Measured: pngquant went from 11.5% to 11.8% of pixels past the error
 *    floor when fed pre-truncated input, while PIL's median cut improved from
 *    17.0% to 9.7%. So: choose the palette in 888, truncate the PALETTE at the
 *    end, then remap against the truncated palette so the error you report is
 *    the error the hardware will show.
 *
 * 2. RGB555 COLLISIONS ARE REAL BUT SMALL. Truncation can collapse two chosen
 *    entries onto one value. We dedupe after truncating and remap indices, so
 *    a 256-entry request can legitimately come back with fewer.
 *
 * 3. DITHERING OFF BY DEFAULT. Rejected twice by eye on real PS1 assets - it
 *    speckles flat fills, and PS1 textures are magnified and affine-mapped,
 *    which makes the speckle worse rather than better.
 *
 * 4. THE LOSSLESS PATH IS COMMON AND MUST BE TAKEN. Four of five real
 *    backgrounds in one project had under 256 distinct RGB555 colours and
 *    needed no quantizer at all. Running one anyway is pure loss.
 */

import {
  packRGB555,
  STP_BIT,
  STP_BLACK,
  NEAR_BLACK,
  scoreAgainstSource,
  type ErrorReport,
} from './color.js';

export type BlackMode = 'gray' | 'stp';

export interface QuantizeOptions {
  /** Palette size cap. 16 for 4bpp, 256 for 8bpp. */
  maxColors: number;

  /**
   * How to represent OPAQUE BLACK, which cannot be stored as 0x0000 because
   * the GPU always reads that as fully transparent.
   *
   *   'gray' - substitute `blackReplacement` (default 0x0421, R=G=B=1).
   *            Unconditionally opaque. THE DEFAULT.
   *   'stp'  - use 0x8000, semi-transparent black. Renders as true solid
   *            black, but ONLY while the primitive is drawn with
   *            semi-transparency disabled at the command level. Turn ABE on
   *            and it blends instead.
   */
  blackMode?: BlackMode;
  /** Substitute colour for opaque black under 'gray'. Default 0x0421. */
  blackReplacement?: number;

  /**
   * Set the STP bit on EVERY non-transparent pixel, and imply blackMode 'stp'.
   *
   * There is no other way to make a whole texture blend, so this is what you
   * want for additive or subtractive blending: the GPU's per-primitive ABR
   * chooses the equation, but each texel still needs its own STP bit set to
   * take part.
   */
  forceSTP?: boolean;

  /**
   * Alpha bands. Source alpha is not storable - the PS1 has three states, not
   * 256 - so it is bucketed:
   *
   *   alpha <  alphaTransparent  -> 0x0000, a hole
   *   alpha >= alphaSolid        -> opaque
   *   in between                 -> STP set, blends per the primitive's ABR
   */
  alphaTransparent?: number;
  alphaSolid?: number;

  /**
   * Per-pixel override forcing a pixel into the semi-transparent band,
   * regardless of its alpha. Non-zero means "set STP on this texel".
   */
  stpMask?: Uint8Array;

  /** Floyd-Steinberg error diffusion during remap. Off by default, on purpose. */
  dither?: boolean;
}

export const DEFAULT_ALPHA_TRANSPARENT = 32;
export const DEFAULT_ALPHA_SOLID = 224;

/** Which of the PS1's three per-texel states a source pixel maps to. */
export const enum Band {
  Transparent = 0,
  Semi = 1,
  Solid = 2,
}

export interface QuantizeResult {
  /** RGB555 palette entries, STP bit included where set. */
  palette: Uint16Array;
  /** One index per pixel, row-major. */
  indices: Uint8Array;
  /** Index reserved for fully transparent pixels, or -1 if none was needed. */
  transparentIndex: number;
  /** Error of the reconstruction against the source. */
  report: ErrorReport;
  /** True when the image fitted the palette exactly and nothing was discarded. */
  lossless: boolean;
  /** How many entries the palette lost to RGB555 collisions after truncation. */
  collisions: number;
  /** Which implementation produced this. */
  method: string;
  /** Pixel counts per band, so the UI can show what the alpha cuts did. */
  bands: { transparent: number; semi: number; solid: number };
  /** How many palette entries carry the STP bit. */
  stpEntries: number;
  /** How black was represented, for display. */
  blackMode: BlackMode;
}

/** A pluggable palette generator working in full-precision RGB. */
export interface PaletteGenerator {
  readonly name: string;
  /**
   * Choose up to `maxColors` representative colours.
   * `pixels` is packed RGB888, three bytes per entry, opaque pixels only.
   * Returns a flat RGB888 palette.
   */
  generate(pixels: Uint8Array, count: number, maxColors: number): Uint8Array;
}

// ---------------------------------------------------------------------------
// Built-in median cut with Lloyd refinement
// ---------------------------------------------------------------------------

interface Box {
  /** Indices into the pixel array. */
  members: Int32Array;
  min: [number, number, number];
  max: [number, number, number];
}

function boundsOf(pixels: Uint8Array, members: Int32Array): Pick<Box, 'min' | 'max'> {
  const min: [number, number, number] = [255, 255, 255];
  const max: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < members.length; i++) {
    const p = members[i] * 3;
    for (let c = 0; c < 3; c++) {
      const v = pixels[p + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

/**
 * Median cut. Splits the box with the largest weighted extent along its widest
 * axis, at the median, until the palette is full or no box can split.
 *
 * Axis extent is weighted for luminance sensitivity (the eye resolves green
 * best, blue worst), which is a cheap stand-in for a perceptual metric. Note
 * that this is exactly the kind of proxy that should never be used to gate a
 * quality decision - it decides where to CUT, not whether the result is good.
 */
export const medianCut: PaletteGenerator = {
  name: 'median-cut',
  generate(pixels, count, maxColors) {
    if (count === 0) return new Uint8Array(0);

    const all = new Int32Array(count);
    for (let i = 0; i < count; i++) all[i] = i;

    const boxes: Box[] = [{ members: all, ...boundsOf(pixels, all) }];
    const weight = [0.9, 1.0, 0.7];

    while (boxes.length < maxColors) {
      let target = -1;
      let bestScore = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.members.length < 2) continue;
        const extent = Math.max(
          (b.max[0] - b.min[0]) * weight[0],
          (b.max[1] - b.min[1]) * weight[1],
          (b.max[2] - b.min[2]) * weight[2],
        );
        const score = extent * Math.log2(b.members.length + 1);
        if (score > bestScore) {
          bestScore = score;
          target = i;
        }
      }
      if (target < 0) break;

      const box = boxes[target];
      let axis = 0;
      let widest = -1;
      for (let c = 0; c < 3; c++) {
        const e = (box.max[c] - box.min[c]) * weight[c];
        if (e > widest) {
          widest = e;
          axis = c;
        }
      }

      const sorted = Array.from(box.members).sort(
        (a, b) => pixels[a * 3 + axis] - pixels[b * 3 + axis],
      );
      const mid = sorted.length >> 1;
      const left = Int32Array.from(sorted.slice(0, mid));
      const right = Int32Array.from(sorted.slice(mid));
      if (left.length === 0 || right.length === 0) break;

      boxes[target] = { members: left, ...boundsOf(pixels, left) };
      boxes.push({ members: right, ...boundsOf(pixels, right) });
    }

    // Box means, then Lloyd refinement so entries settle on cluster centroids
    // rather than sitting wherever the cuts happened to land.
    const palette = new Uint8Array(boxes.length * 3);
    for (let i = 0; i < boxes.length; i++) {
      const m = boxes[i].members;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < m.length; j++) {
        r += pixels[m[j] * 3];
        g += pixels[m[j] * 3 + 1];
        b += pixels[m[j] * 3 + 2];
      }
      palette[i * 3] = Math.round(r / m.length);
      palette[i * 3 + 1] = Math.round(g / m.length);
      palette[i * 3 + 2] = Math.round(b / m.length);
    }

    return lloydRefine(pixels, count, palette, 6);
  },
};

function lloydRefine(
  pixels: Uint8Array,
  count: number,
  palette: Uint8Array,
  iterations: number,
): Uint8Array {
  const k = palette.length / 3;
  if (k <= 1) return palette;

  const sums = new Float64Array(k * 3);
  const counts = new Uint32Array(k);
  const current = new Uint8Array(palette);

  for (let iter = 0; iter < iterations; iter++) {
    sums.fill(0);
    counts.fill(0);

    for (let i = 0; i < count; i++) {
      const p = i * 3;
      const nearest = nearestIn888(current, pixels[p], pixels[p + 1], pixels[p + 2]);
      counts[nearest]++;
      sums[nearest * 3] += pixels[p];
      sums[nearest * 3 + 1] += pixels[p + 1];
      sums[nearest * 3 + 2] += pixels[p + 2];
    }

    let moved = 0;
    for (let j = 0; j < k; j++) {
      if (counts[j] === 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = Math.round(sums[j * 3 + c] / counts[j]);
        if (v !== current[j * 3 + c]) moved++;
        current[j * 3 + c] = v;
      }
    }
    if (moved === 0) break;
  }

  return current;
}

function nearestIn888(palette: Uint8Array, r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0, j = 0; j < palette.length; i++, j += 3) {
    const dr = palette[j] - r;
    const dg = palette[j + 1] - g;
    const db = palette[j + 2] - b;
    const d = dr * dr * 0.9 + dg * dg * 1.0 + db * db * 0.7;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The quantize pipeline
// ---------------------------------------------------------------------------

/** Distinct RGB555 values in the opaque part of an image, capped for cost. */
export function distinctRGB555(
  rgba: Uint8Array | Uint8ClampedArray,
  alphaThreshold = 1,
  cap = 1 << 16,
): Set<number> {
  const seen = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < alphaThreshold) continue;
    seen.add(packRGB555(rgba[i], rgba[i + 1], rgba[i + 2]));
    if (seen.size > cap) break;
  }
  return seen;
}

/** Which of the three PS1 texel states a source pixel belongs in. */
export function classifyBands(
  rgba: Uint8Array | Uint8ClampedArray,
  pixelCount: number,
  opts: {
    alphaTransparent: number;
    alphaSolid: number;
    forceSTP: boolean;
    stpMask?: Uint8Array;
  },
): Uint8Array {
  const out = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const a = rgba[i * 4 + 3];
    if (a < opts.alphaTransparent) {
      out[i] = Band.Transparent;
    } else if (opts.forceSTP || opts.stpMask?.[i]) {
      out[i] = Band.Semi;
    } else {
      out[i] = a >= opts.alphaSolid ? Band.Solid : Band.Semi;
    }
  }
  return out;
}

/**
 * Turn a truncated RGB555 colour plus a band into the CLUT entry that stores it.
 *
 * This is the whole semi-transparency contract in one function, and everything
 * else defers to it:
 *
 *   Semi band  - STP set. Black becomes 0x8000, which IS semi-transparent
 *                black; no substitution needed or wanted.
 *   Solid band - STP clear, EXCEPT under blackMode 'stp' where black becomes
 *                0x8000. Black otherwise becomes `blackReplacement`, because
 *                0x0000 is a hole.
 */
export function entryFor(
  v555: number,
  band: Band,
  blackMode: BlackMode,
  blackReplacement: number,
): number {
  const rgb = v555 & 0x7fff;
  if (band === Band.Semi) return rgb === 0 ? STP_BLACK : rgb | STP_BIT;
  if (rgb === 0) return blackMode === 'stp' ? STP_BLACK : blackReplacement;
  return rgb;
}

/**
 * Quantize an RGBA image to a PS1 CLUT.
 *
 * Pixels are split into three bands first (see classifyBands) and the palette
 * is built PER BAND, because the STP bit lives in the CLUT entry rather than in
 * the texel. A colour appearing both solid and semi-transparent therefore needs
 * two entries. Setting the bit on a shared entry after the fact - which is what
 * this code used to do - silently flips every other pixel using that entry.
 *
 * Takes the lossless path automatically when the image already fits, which is
 * not a rare case: hand-authored PS1-era art is frequently already indexed.
 */
export function quantize(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: QuantizeOptions,
  generator: PaletteGenerator = medianCut,
): QuantizeResult {
  const {
    maxColors,
    forceSTP = false,
    blackMode = forceSTP ? 'stp' : 'gray',
    blackReplacement = NEAR_BLACK,
    alphaTransparent = DEFAULT_ALPHA_TRANSPARENT,
    alphaSolid = DEFAULT_ALPHA_SOLID,
    stpMask,
    dither = false,
  } = options;

  const pixelCount = width * height;
  const indices = new Uint8Array(pixelCount);
  const band = classifyBands(rgba, pixelCount, {
    alphaTransparent,
    alphaSolid,
    forceSTP,
    stpMask,
  });

  const bands = { transparent: 0, semi: 0, solid: 0 };
  for (let i = 0; i < pixelCount; i++) {
    if (band[i] === Band.Transparent) bands.transparent++;
    else if (band[i] === Band.Semi) bands.semi++;
    else bands.solid++;
  }

  const needsTransparent = bands.transparent > 0;
  const transparentIndex = needsTransparent ? 0 : -1;
  const base = needsTransparent ? 1 : 0;
  const budget = maxColors - base;
  if (budget < 1) {
    throw new Error(`maxColors=${maxColors} leaves no room for colours after the transparent slot`);
  }

  const entry = (v: number, b: Band) => entryFor(v, b, blackMode, blackReplacement);

  // Distinct ENTRIES, not distinct colours: one colour in two bands is two
  // entries, and the lossless test has to know that.
  const distinctEntries = new Set<number>();
  for (let i = 0; i < pixelCount && distinctEntries.size <= budget; i++) {
    if (band[i] === Band.Transparent) continue;
    const p = i * 4;
    distinctEntries.add(entry(packRGB555(rgba[p], rgba[p + 1], rgba[p + 2]), band[i] as Band));
  }
  const lossless = distinctEntries.size <= budget;

  const palette555 = new Uint16Array(maxColors);
  let method: string;
  let collisions = 0;

  if (lossless) {
    method = 'exact';
    const lookup = new Map<number, number>();
    let next = base;
    for (const e of Array.from(distinctEntries).sort((a, b) => a - b)) {
      palette555[next] = e;
      lookup.set(e, next);
      next++;
    }
    for (let i = 0; i < pixelCount; i++) {
      if (band[i] === Band.Transparent) {
        indices[i] = transparentIndex;
        continue;
      }
      const p = i * 4;
      indices[i] = lookup.get(
        entry(packRGB555(rgba[p], rgba[p + 1], rgba[p + 2]), band[i] as Band),
      )!;
    }
  } else {
    method = generator.name;

    // Split the budget between the two visible bands by pixel share, with at
    // least one entry each so neither can be starved out entirely.
    const visible = bands.solid + bands.semi;
    const shares = new Map<Band, number>();
    if (bands.solid && bands.semi) {
      let solidShare = Math.round((budget * bands.solid) / visible);
      solidShare = Math.max(1, Math.min(budget - 1, solidShare));
      shares.set(Band.Solid, solidShare);
      shares.set(Band.Semi, budget - solidShare);
    } else if (bands.solid) {
      shares.set(Band.Solid, budget);
    } else if (bands.semi) {
      shares.set(Band.Semi, budget);
    }

    const seen = new Map<number, number>();
    let next = base;

    for (const [b, share] of shares) {
      const members: number[] = [];
      for (let i = 0; i < pixelCount; i++) if (band[i] === b) members.push(i);
      if (!members.length) continue;

      const packed = new Uint8Array(members.length * 3);
      for (let j = 0; j < members.length; j++) {
        const p = members[j] * 4;
        packed[j * 3] = rgba[p];
        packed[j * 3 + 1] = rgba[p + 1];
        packed[j * 3 + 2] = rgba[p + 2];
      }

      // Palette chosen at FULL precision, truncated afterwards.
      const rgb888 = generator.generate(packed, members.length, share);

      const bandEntries: number[] = [];
      const bandIndices: number[] = [];
      for (let k = 0; k < rgb888.length; k += 3) {
        const e = entry(packRGB555(rgb888[k], rgb888[k + 1], rgb888[k + 2]), b);
        const already = seen.get(e);
        if (already !== undefined) {
          collisions++;
          // Reuse rather than duplicate: an identical entry is identical.
          if (!bandIndices.includes(already)) {
            bandEntries.push(e);
            bandIndices.push(already);
          }
          continue;
        }
        seen.set(e, next);
        palette555[next] = e;
        bandEntries.push(e);
        bandIndices.push(next);
        next++;
      }
      if (!bandEntries.length) continue;

      remapBand(
        rgba,
        width,
        members,
        bandEntries,
        bandIndices,
        indices,
        dither,
      );
    }

    for (let i = 0; i < pixelCount; i++) {
      if (band[i] === Band.Transparent) indices[i] = transparentIndex < 0 ? 0 : transparentIndex;
    }
  }

  let stpEntries = 0;
  for (let i = base; i < palette555.length; i++) {
    if (palette555[i] & STP_BIT) stpEntries++;
  }

  // Pixels whose only error is the deliberate black substitution. Under
  // blackMode 'stp' there is no error at all - 0x8000 IS black - so nothing is
  // excused there.
  let excused: Uint8Array | undefined;
  if (blackMode === 'gray') {
    excused = new Uint8Array(pixelCount);
    let any = false;
    for (let i = 0; i < pixelCount; i++) {
      if (band[i] === Band.Transparent) continue;
      const p = i * 4;
      if (rgba[p] > 7 || rgba[p + 1] > 7 || rgba[p + 2] > 7) continue;
      if ((palette555[indices[i]] & 0x7fff) !== (blackReplacement & 0x7fff)) continue;
      excused[i] = 1;
      any = true;
    }
    if (!any) excused = undefined;
  }

  const report = scoreAgainstSource(
    rgba,
    reconstruct(indices, palette555, transparentIndex, pixelCount),
    excused,
  );

  return {
    palette: palette555,
    indices,
    transparentIndex,
    report,
    lossless,
    collisions,
    method,
    bands,
    stpEntries,
    blackMode,
  };
}

/**
 * Remap one band's pixels against that band's own sub-palette.
 *
 * Comparison happens on the TRUNCATED entries expanded back to 8 bits, so the
 * error reported is the error the hardware will show. The STP bit is masked out
 * for the distance calculation - it is not a colour channel.
 */
function remapBand(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  members: number[],
  entries: number[],
  entryIndices: number[],
  out: Uint8Array,
  dither: boolean,
): void {
  const pal888 = new Uint8Array(entries.length * 3);
  for (let i = 0; i < entries.length; i++) {
    const v = entries[i] & 0x7fff;
    const r5 = v & 0x1f;
    const g5 = (v >> 5) & 0x1f;
    const b5 = (v >> 10) & 0x1f;
    pal888[i * 3] = (r5 << 3) | (r5 >> 2);
    pal888[i * 3 + 1] = (g5 << 3) | (g5 >> 2);
    pal888[i * 3 + 2] = (b5 << 3) | (b5 >> 2);
  }

  // Error diffusion is keyed by pixel id so it only ever spreads within this
  // band - pushing a solid pixel's error into a semi-transparent neighbour
  // would be diffusing across a discontinuity the hardware treats as a wall.
  const err = dither ? new Map<number, [number, number, number]>() : undefined;
  const inBand = dither ? new Set(members) : undefined;

  for (const i of members) {
    const p = i * 4;
    let r = rgba[p];
    let g = rgba[p + 1];
    let b = rgba[p + 2];
    if (err) {
      const e = err.get(i);
      if (e) {
        r = clamp8(r + e[0]);
        g = clamp8(g + e[1]);
        b = clamp8(b + e[2]);
      }
    }

    const nearest = nearestIn888(pal888, r, g, b);
    out[i] = entryIndices[nearest];

    if (err && inBand) {
      const dr = r - pal888[nearest * 3];
      const dg = g - pal888[nearest * 3 + 1];
      const db = b - pal888[nearest * 3 + 2];
      const spread = (target: number, f: number) => {
        if (!inBand.has(target)) return;
        const cur = err.get(target) ?? [0, 0, 0];
        cur[0] += dr * f;
        cur[1] += dg * f;
        cur[2] += db * f;
        err.set(target, cur);
      };
      const x = i % width;
      if (x + 1 < width) spread(i + 1, 7 / 16);
      if (x > 0) spread(i + width - 1, 3 / 16);
      spread(i + width, 5 / 16);
      if (x + 1 < width) spread(i + width + 1, 1 / 16);
    }
  }
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function reconstruct(
  indices: Uint8Array,
  palette555: Uint16Array,
  transparentIndex: number,
  pixelCount: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const idx = indices[i];
    if (idx === transparentIndex) continue;
    const v = palette555[idx] & 0x7fff;
    const r5 = v & 0x1f;
    const g5 = (v >> 5) & 0x1f;
    const b5 = (v >> 10) & 0x1f;
    out[i * 4] = (r5 << 3) | (r5 >> 2);
    out[i * 4 + 1] = (g5 << 3) | (g5 >> 2);
    out[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
    out[i * 4 + 3] = 255;
  }
  return out;
}
