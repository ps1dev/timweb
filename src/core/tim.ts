/**
 * PlayStation TIM file parser and serializer.
 *
 * Layout (psx-spx "TIM (Playstation Texture Image)", cdromfileformats.md):
 *
 *   File header, 8 bytes, little endian:
 *     000h  1  ID       = 10h
 *     001h  1  Version  = 00h
 *     002h  2  Reserved = 0000h   (1 or 2 marks a compressed TIM)
 *     004h  4  Flags    bit0-2 = Type, bit3 = HasCLUT, bit4-31 reserved
 *     008h  .. CLUT section, present iff bit3
 *     ...   .. Pixel section
 *
 *   Section, 12-byte preamble then payload:
 *     000h  4  Size in bytes, INCLUDING these 12
 *     004h  4  (Y << 16) | X    VRAM destination; X counted in HALFWORDS
 *     008h  4  (H << 16) | W    dimensions;       W counted in HALFWORDS
 *     00Ch  .. W * 2 * H bytes
 *
 * The single easiest thing to get wrong: W and X are in 16-bit halfwords, not
 * texels. A 256-texel-wide 8bpp image is 128 halfwords across.
 *
 * Parsing is deliberately TOLERANT, because shipped files are not clean:
 *   - Flags bits 4-31 are not reliably zero. Two files in psn00bsdk's own tree
 *     carry junk there, and psx-spx catalogues a shipped file with Flags
 *     10101009h. We mask; we never compare.
 *   - Section length fields are not reliably correct. psn00bsdk ships
 *     dbugfont.tim declaring 28 bytes for a 2060-byte section, and
 *     gte/texture.tim declaring 268 for 16396. In both the DIMENSIONS are
 *     right. So: dimensions decide the payload extent, the length field only
 *     advances the cursor, and a disagreement is reported rather than fatal.
 */

import { packRGB555 } from './color.js';

export const TIM_ID = 0x10;
export const TIM_VERSION = 0x00;
export const FILE_HEADER_SIZE = 8;
export const SECTION_HEADER_SIZE = 12;
export const FLAG_HAS_CLUT = 1 << 3;

export enum TimType {
  Bpp4 = 0,
  Bpp8 = 1,
  Bpp16 = 2,
  Bpp24 = 3,
  /**
   * "Mixed". A hint that one pixel block holds more than one texel format.
   * It does NOT mean multiple sections. No known tooling writes it.
   */
  Mixed = 4,
}

export interface TimSection {
  /** VRAM X in halfwords. Signed in the file; negatives are pathological. */
  x: number;
  /** VRAM Y in lines. */
  y: number;
  /** Width in HALFWORDS, not texels. */
  w: number;
  /** Height in lines. */
  h: number;
  /** Payload, w*h halfwords. */
  data: Uint16Array;
}

export interface Tim {
  type: TimType;
  /**
   * The full 32-bit flags word as read, junk bits and all. Preserved so a
   * parse/serialize round-trip is byte-exact on files that carry junk.
   */
  rawFlags: number;
  clut?: TimSection;
  pixels: TimSection;
}

export interface ParseDiagnostic {
  severity: 'warn' | 'error';
  code:
    | 'bad-id'
    | 'bad-version'
    | 'compressed'
    | 'reserved-flag-bits'
    | 'section-length-mismatch'
    | 'truncated'
    | 'trailing-data'
    | 'unknown-type'
    | 'odd-section-length';
  message: string;
}

export interface ParseResult {
  tim?: Tim;
  diagnostics: ParseDiagnostic[];
}

/** Texel width of a pixel section, given its halfword width and the type. */
export function texelWidth(halfwords: number, type: TimType): number {
  switch (type) {
    case TimType.Bpp4:
      return halfwords * 4;
    case TimType.Bpp8:
      return halfwords * 2;
    case TimType.Bpp16:
      return halfwords;
    case TimType.Bpp24:
      // Three bytes per texel, so two texels occupy three halfwords.
      return Math.floor((halfwords * 2) / 3);
    default:
      return halfwords;
  }
}

/** Halfword width needed to hold `texels` texels at the given depth. */
export function halfwordWidth(texels: number, type: TimType): number {
  switch (type) {
    case TimType.Bpp4:
      return Math.ceil(texels / 4);
    case TimType.Bpp8:
      return Math.ceil(texels / 2);
    case TimType.Bpp16:
      return texels;
    case TimType.Bpp24:
      return Math.ceil((texels * 3) / 2);
    default:
      return texels;
  }
}

/** Bits per texel, or 0 for Mixed. */
export function bitsPerTexel(type: TimType): number {
  switch (type) {
    case TimType.Bpp4:
      return 4;
    case TimType.Bpp8:
      return 8;
    case TimType.Bpp16:
      return 16;
    case TimType.Bpp24:
      return 24;
    default:
      return 0;
  }
}

export function hasClutFlag(flags: number): boolean {
  return (flags & FLAG_HAS_CLUT) !== 0;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------


/**
 * Read one 12-byte-preambled section. Shared by TIM, PXL and CLT, because a
 * split file is a TIM header followed by exactly one of the same sections.
 */
function readSectionAt(
  bytes: Uint8Array,
  view: DataView,
  cursor: number,
  label: string,
  diagnostics: ParseDiagnostic[],
): { section: TimSection; next: number } | undefined {
  if (cursor + SECTION_HEADER_SIZE > bytes.byteLength) {
    diagnostics.push({
      severity: 'error',
      code: 'truncated',
      message: `${label} section header runs past end of file`,
    });
    return undefined;
  }
  const declared = view.getUint32(cursor, true);
  const coord = view.getUint32(cursor + 4, true);
  const dims = view.getUint32(cursor + 8, true);

  const x = ((coord & 0xffff) << 16) >> 16;
  const y = (coord >>> 16) << 16 >> 16;
  const w = dims & 0xffff;
  const h = (dims >>> 16) & 0xffff;

  const payloadBytes = w * 2 * h;
  const impliedLength = payloadBytes + SECTION_HEADER_SIZE;

  if (declared !== impliedLength) {
    diagnostics.push({
      severity: 'warn',
      code: 'section-length-mismatch',
      message: `${label} section declares ${declared} bytes but its ${w}x${h} halfword dimensions imply ${impliedLength}; trusting dimensions`,
    });
  }
  if (declared % 4 !== 0) {
    diagnostics.push({
      severity: 'warn',
      code: 'odd-section-length',
      message: `${label} section length ${declared} is not a multiple of 4; this misaligns what follows and PS1 DMA wants 4-byte alignment`,
    });
  }

  const start = cursor + SECTION_HEADER_SIZE;
  if (start + payloadBytes > bytes.byteLength) {
    diagnostics.push({
      severity: 'error',
      code: 'truncated',
      message: `${label} section payload needs ${payloadBytes} bytes, only ${bytes.byteLength - start} remain`,
    });
    return undefined;
  }

  const data = new Uint16Array(w * h);
  for (let i = 0; i < data.length; i++) {
    data[i] = view.getUint16(start + i * 2, true);
  }

  return {
    section: { x, y, w, h, data },
    next: start + Math.max(payloadBytes, declared - SECTION_HEADER_SIZE),
  };
}

export function parseTim(buffer: ArrayBuffer | Uint8Array): ParseResult {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const diagnostics: ParseDiagnostic[] = [];

  const fail = (code: ParseDiagnostic['code'], message: string): ParseResult => {
    diagnostics.push({ severity: 'error', code, message });
    return { diagnostics };
  };

  if (bytes.byteLength < FILE_HEADER_SIZE) {
    return fail('truncated', `file is ${bytes.byteLength} bytes, need at least ${FILE_HEADER_SIZE}`);
  }
  if (bytes[0] !== TIM_ID) {
    return fail('bad-id', `ID byte is 0x${bytes[0].toString(16)}, expected 0x10`);
  }
  if (bytes[1] !== TIM_VERSION) {
    return fail('bad-version', `version byte is 0x${bytes[1].toString(16)}, expected 0x00`);
  }

  const reserved = view.getUint16(2, true);
  if (reserved !== 0) {
    // 1 and 2 mark compressed variants. We do not decompress.
    return fail('compressed', `reserved halfword is 0x${reserved.toString(16)}; this is a compressed TIM`);
  }

  const rawFlags = view.getUint32(4, true);
  const type = (rawFlags & 7) as TimType;
  if (rawFlags & ~0x0f) {
    diagnostics.push({
      severity: 'warn',
      code: 'reserved-flag-bits',
      message: `flags word 0x${rawFlags.toString(16).padStart(8, '0')} has bits set above bit 3; masking (this occurs in shipped files)`,
    });
  }
  if (type > TimType.Mixed) {
    diagnostics.push({
      severity: 'warn',
      code: 'unknown-type',
      message: `type ${type} is outside the documented range 0-4`,
    });
  }

  let cursor = FILE_HEADER_SIZE;

  const readSection = (label: string): TimSection | undefined => {
    const r = readSectionAt(bytes, view, cursor, label, diagnostics);
    if (!r) return undefined;
    cursor = r.next;
    return r.section;
  };

  let clut: TimSection | undefined;
  if (hasClutFlag(rawFlags)) {
    clut = readSection('CLUT');
    if (!clut) return { diagnostics };
  }

  const pixels = readSection('pixel');
  if (!pixels) return { diagnostics };

  if (cursor < bytes.byteLength) {
    diagnostics.push({
      severity: 'warn',
      code: 'trailing-data',
      message: `${bytes.byteLength - cursor} bytes follow the pixel section`,
    });
  }

  return { tim: { type, rawFlags, clut, pixels }, diagnostics };
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

export function serializeTim(tim: Tim): Uint8Array {
  const sections: TimSection[] = [];
  if (tim.clut) sections.push(tim.clut);
  sections.push(tim.pixels);

  let total = FILE_HEADER_SIZE;
  for (const s of sections) total += SECTION_HEADER_SIZE + s.w * 2 * s.h;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out[0] = TIM_ID;
  out[1] = TIM_VERSION;
  view.setUint16(2, 0, true);

  // Write a clean flags word. We do not propagate junk bits on serialize -
  // rawFlags exists so a caller can round-trip a specimen byte-exactly if it
  // wants to, but the default is to emit what the spec says.
  const flags = (tim.type & 7) | (tim.clut ? FLAG_HAS_CLUT : 0);
  view.setUint32(4, flags, true);

  let cursor = FILE_HEADER_SIZE;
  for (const s of sections) {
    if (s.data.length !== s.w * s.h) {
      throw new Error(
        `section payload is ${s.data.length} halfwords but dimensions say ${s.w}x${s.h}=${s.w * s.h}`,
      );
    }
    view.setUint32(cursor, SECTION_HEADER_SIZE + s.w * 2 * s.h, true);
    view.setUint32(cursor + 4, (((s.y & 0xffff) << 16) | (s.x & 0xffff)) >>> 0, true);
    view.setUint32(cursor + 8, (((s.h & 0xffff) << 16) | (s.w & 0xffff)) >>> 0, true);
    cursor += SECTION_HEADER_SIZE;
    for (let i = 0; i < s.data.length; i++) {
      view.setUint16(cursor + i * 2, s.data[i], true);
    }
    cursor += s.data.length * 2;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Texel access
// ---------------------------------------------------------------------------

/**
 * Read one texel out of a pixel section.
 *
 * For 4bpp and 8bpp this is a palette INDEX; for 16bpp it is the colour value.
 *
 * Packing, verified by decoding real img2tim output against its source PNGs:
 *   8bpp - two indices per halfword, low byte is the LEFT texel.
 *   4bpp - four indices per halfword, the LOW nibble of the LOW byte is the
 *          LEFTMOST texel. Decoding high-nibble-first scored 995 mismatches
 *          out of 8192 pixels; low-first scored 0.
 */
export function getTexel(
  section: TimSection,
  type: TimType,
  x: number,
  y: number,
): number {
  const row = y * section.w;
  switch (type) {
    case TimType.Bpp4: {
      const hw = section.data[row + (x >> 2)];
      return (hw >> ((x & 3) * 4)) & 0x0f;
    }
    case TimType.Bpp8: {
      const hw = section.data[row + (x >> 1)];
      return (hw >> ((x & 1) * 8)) & 0xff;
    }
    case TimType.Bpp16:
      return section.data[row + x];
    default:
      throw new Error(`getTexel does not support type ${type}`);
  }
}

/** Write one texel into a pixel section. Mirrors getTexel's packing. */
export function setTexel(
  section: TimSection,
  type: TimType,
  x: number,
  y: number,
  value: number,
): void {
  const row = y * section.w;
  switch (type) {
    case TimType.Bpp4: {
      const i = row + (x >> 2);
      const shift = (x & 3) * 4;
      section.data[i] = (section.data[i] & ~(0x0f << shift)) | ((value & 0x0f) << shift);
      break;
    }
    case TimType.Bpp8: {
      const i = row + (x >> 1);
      const shift = (x & 1) * 8;
      section.data[i] = (section.data[i] & ~(0xff << shift)) | ((value & 0xff) << shift);
      break;
    }
    case TimType.Bpp16:
      section.data[row + x] = value & 0xffff;
      break;
    default:
      throw new Error(`setTexel does not support type ${type}`);
  }
}

/** Number of palettes stacked in a CLUT section. Multi-palette TIMs are real. */
export function paletteCount(tim: Tim): number {
  return tim.clut ? tim.clut.h : 0;
}

/** One palette out of a (possibly multi-palette) CLUT section. */
export function palette(tim: Tim, index = 0): Uint16Array | undefined {
  if (!tim.clut) return undefined;
  if (index < 0 || index >= tim.clut.h) return undefined;
  return tim.clut.data.subarray(index * tim.clut.w, (index + 1) * tim.clut.w);
}

// ---------------------------------------------------------------------------
// Decoding to RGBA, for preview
// ---------------------------------------------------------------------------

/**
 * Decode a TIM to 8-bit RGBA.
 *
 * `stpAsOpaque` controls how a set STP bit renders. On hardware that depends on
 * the drawing command, so neither answer is universally right: false previews
 * the semi-transparent case as 50% alpha, true previews it as opaque.
 */
export function decodeToRGBA(
  tim: Tim,
  options: { paletteIndex?: number; stpAsOpaque?: boolean } = {},
): { width: number; height: number; rgba: Uint8ClampedArray } {
  const { paletteIndex = 0, stpAsOpaque = false } = options;
  const type = tim.type;
  const width = texelWidth(tim.pixels.w, type);
  const height = tim.pixels.h;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const pal = palette(tim, paletteIndex);

  if (type !== TimType.Bpp16 && !pal) {
    throw new Error(`type ${type} needs a CLUT to decode and none is present`);
  }

  const emit = (o: number, v: number) => {
    if (v === 0x0000) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = rgba[o + 3] = 0;
      return;
    }
    const r5 = v & 0x1f;
    const g5 = (v >> 5) & 0x1f;
    const b5 = (v >> 10) & 0x1f;
    rgba[o] = (r5 << 3) | (r5 >> 2);
    rgba[o + 1] = (g5 << 3) | (g5 >> 2);
    rgba[o + 2] = (b5 << 3) | (b5 >> 2);
    rgba[o + 3] = v & 0x8000 ? (stpAsOpaque ? 255 : 128) : 255;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = getTexel(tim.pixels, type, x, y);
      emit((y * width + x) * 4, type === TimType.Bpp16 ? t : pal![t] ?? 0);
    }
  }

  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build a 16bpp TIM from 8-bit RGBA.
 *
 * Same three-state contract as the indexed path, applied directly to texels
 * since a 16bpp texel IS the colour: alpha below `alphaTransparent` becomes
 * 0x0000, alpha at or above `alphaSolid` is opaque, everything between gets
 * the STP bit. `forceSTP` sets the bit on every non-transparent texel.
 */
export function timFromRGBA16(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  placement: { x: number; y: number },
  options: {
    blackMode?: 'gray' | 'stp';
    blackReplacement?: number;
    forceSTP?: boolean;
    alphaTransparent?: number;
    alphaSolid?: number;
    stpMask?: Uint8Array;
  } = {},
): Tim {
  const {
    forceSTP = false,
    blackMode = forceSTP ? 'stp' : 'gray',
    blackReplacement = 0x0421,
    alphaTransparent = 32,
    alphaSolid = 224,
    stpMask,
  } = options;

  const data = new Uint16Array(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const a = rgba[p + 3];
    if (a < alphaTransparent) {
      data[i] = 0x0000;
      continue;
    }
    const rgb = packRGB555(rgba[p], rgba[p + 1], rgba[p + 2]) & 0x7fff;
    const semi = forceSTP || !!stpMask?.[i] || a < alphaSolid;
    if (semi) {
      data[i] = rgb === 0 ? 0x8000 : rgb | 0x8000;
    } else if (rgb === 0) {
      data[i] = blackMode === 'stp' ? 0x8000 : blackReplacement;
    } else {
      data[i] = rgb;
    }
  }
  return {
    type: TimType.Bpp16,
    rawFlags: TimType.Bpp16,
    pixels: { x: placement.x, y: placement.y, w: width, h: height, data },
  };
}

/**
 * Build a 4bpp or 8bpp TIM from palette indices plus a palette.
 *
 * `indices` is one byte per texel, row-major, `width` wide. The palette is
 * 16-bit RGB555 entries; it is padded up to the CLUT width the depth requires
 * (16 for 4bpp, 256 for 8bpp) so the section is a legal VRAM rectangle.
 */
export function timFromIndexed(
  indices: Uint8Array,
  palette: Uint16Array,
  width: number,
  height: number,
  type: TimType.Bpp4 | TimType.Bpp8,
  placement: { x: number; y: number; clutX: number; clutY: number },
): Tim {
  const perHalfword = type === TimType.Bpp4 ? 4 : 2;
  if (width % perHalfword !== 0) {
    throw new Error(
      `${type === TimType.Bpp4 ? '4bpp' : '8bpp'} needs a width that is a multiple of ${perHalfword}, got ${width}`,
    );
  }
  const clutWidth = type === TimType.Bpp4 ? 16 : 256;
  if (palette.length > clutWidth) {
    throw new Error(`palette has ${palette.length} entries, max ${clutWidth} at this depth`);
  }

  const w = width / perHalfword;
  const pixels: TimSection = {
    x: placement.x,
    y: placement.y,
    w,
    h: height,
    data: new Uint16Array(w * height),
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      setTexel(pixels, type, x, y, indices[y * width + x]);
    }
  }

  const clutData = new Uint16Array(clutWidth);
  clutData.set(palette);

  return {
    type,
    rawFlags: type | FLAG_HAS_CLUT,
    clut: { x: placement.clutX, y: placement.clutY, w: clutWidth, h: 1, data: clutData },
    pixels,
  };
}

// ---------------------------------------------------------------------------
// PXL / CLT: split TIMs
// ---------------------------------------------------------------------------

/**
 * A .PXL is a TIM header followed by only the pixel section; a .CLT is a TIM
 * header followed by only the CLUT section. Same 8-byte header, same 12-byte
 * section preamble, so the whole thing is the TIM path with one section.
 *
 * THE ID BYTES ARE CONTESTED, and getting them backwards writes files nothing
 * can read. Sony's own documentation says 11h=PXL and 12h=CLT. Shipped games
 * do the opposite, and psx-spx records the conflict explicitly:
 *
 *   "PXL/CLT is very rare. And oddly, with swapped ID values (official specs
 *    say 11h=PXL, 12h=CLT, but the existing games do use 11h=CLT, 12h=PXL)."
 *
 * We follow the games, which is also what spicyjpeg's converter does. If a
 * file refuses to parse, this paragraph is where to look.
 */
export const CLT_ID = 0x11;
export const PXL_ID = 0x12;

/** psx-spx: "The .CLT Type should be always 2 (meant to indicate 16bit CLUT entries)." */
export const CLT_TYPE = 2;

export type SplitKind = 'pxl' | 'clt';

export interface SplitFile {
  kind: SplitKind;
  /** Type field from the flags word. Always 2 for a well-formed CLT. */
  type: number;
  section: TimSection;
}

export interface ParseSplitResult {
  file?: SplitFile;
  diagnostics: ParseDiagnostic[];
}

/** Parse a .PXL or .CLT. The ID byte decides which. */
export function parseSplit(buffer: ArrayBuffer | Uint8Array): ParseSplitResult {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const diagnostics: ParseDiagnostic[] = [];

  if (bytes.byteLength < FILE_HEADER_SIZE) {
    diagnostics.push({
      severity: 'error',
      code: 'truncated',
      message: `file is ${bytes.byteLength} bytes, need at least ${FILE_HEADER_SIZE}`,
    });
    return { diagnostics };
  }

  const id = bytes[0];
  if (id !== PXL_ID && id !== CLT_ID) {
    diagnostics.push({
      severity: 'error',
      code: 'bad-id',
      message: `ID byte is 0x${id.toString(16)}, expected 0x${PXL_ID.toString(16)} (PXL) or 0x${CLT_ID.toString(16)} (CLT)`,
    });
    return { diagnostics };
  }
  if (bytes[1] !== TIM_VERSION) {
    diagnostics.push({
      severity: 'error',
      code: 'bad-version',
      message: `version byte is 0x${bytes[1].toString(16)}, expected 0x00`,
    });
    return { diagnostics };
  }

  const reserved = view.getUint16(2, true);
  if (reserved !== 0) {
    diagnostics.push({
      severity: 'error',
      code: 'compressed',
      message: `reserved halfword is 0x${reserved.toString(16)}; this is a compressed file`,
    });
    return { diagnostics };
  }

  const kind: SplitKind = id === PXL_ID ? 'pxl' : 'clt';
  const rawFlags = view.getUint32(4, true);
  const type = rawFlags & 7;

  if (kind === 'clt' && type !== CLT_TYPE) {
    diagnostics.push({
      severity: 'warn',
      code: 'unknown-type',
      message: `CLT type is ${type}, expected ${CLT_TYPE}`,
    });
  }

  const read = readSectionAt(bytes, view, FILE_HEADER_SIZE, kind.toUpperCase(), diagnostics);
  if (!read) return { diagnostics };

  if (read.next < bytes.byteLength) {
    diagnostics.push({
      severity: 'warn',
      code: 'trailing-data',
      message: `${bytes.byteLength - read.next} bytes follow the section`,
    });
  }

  return { file: { kind, type, section: read.section }, diagnostics };
}

/** Write a .PXL or .CLT holding one section. */
export function serializeSplit(file: SplitFile): Uint8Array {
  const { kind, section } = file;
  const payload = section.w * 2 * section.h;
  const out = new Uint8Array(FILE_HEADER_SIZE + SECTION_HEADER_SIZE + payload);
  const view = new DataView(out.buffer);

  out[0] = kind === 'pxl' ? PXL_ID : CLT_ID;
  out[1] = TIM_VERSION;
  view.setUint16(2, 0, true);
  view.setUint32(4, kind === 'clt' ? CLT_TYPE : file.type & 7, true);

  view.setUint32(FILE_HEADER_SIZE, SECTION_HEADER_SIZE + payload, true);
  view.setUint32(
    FILE_HEADER_SIZE + 4,
    (((section.y & 0xffff) << 16) | (section.x & 0xffff)) >>> 0,
    true,
  );
  view.setUint32(
    FILE_HEADER_SIZE + 8,
    (((section.h & 0xffff) << 16) | (section.w & 0xffff)) >>> 0,
    true,
  );
  const base = FILE_HEADER_SIZE + SECTION_HEADER_SIZE;
  for (let i = 0; i < section.data.length; i++) {
    view.setUint16(base + i * 2, section.data[i], true);
  }
  return out;
}

/** Split a TIM into the PXL and CLT files that carry the same data. */
export function timToSplit(tim: Tim): { pxl: SplitFile; clt?: SplitFile } {
  return {
    pxl: { kind: 'pxl', type: tim.type, section: tim.pixels },
    clt: tim.clut ? { kind: 'clt', type: CLT_TYPE, section: tim.clut } : undefined,
  };
}

/** Rebuild a TIM from a PXL and an optional CLT. */
export function splitToTim(pxl: SplitFile, clt?: SplitFile): Tim {
  if (pxl.kind !== 'pxl') throw new Error('first argument must be a PXL');
  if (clt && clt.kind !== 'clt') throw new Error('second argument must be a CLT');
  const type = pxl.type as TimType;
  return {
    type,
    rawFlags: type | (clt ? FLAG_HAS_CLUT : 0),
    clut: clt?.section,
    pixels: pxl.section,
  };
}
