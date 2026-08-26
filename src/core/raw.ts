/**
 * Headerless image + palette export, matching ps1-bare-metal's convertImage.py.
 *
 * Two files, no headers, nothing to parse:
 *
 *   image data   4bpp  - two indices per byte, low nibble is the LEFT texel
 *                8bpp  - one index per byte
 *                16bpp - little-endian RGB555 halfwords, STP in bit 15
 *   palette data       - little-endian RGB555 halfwords, padded to 16 or 256
 *                        entries, absent at 16bpp
 *
 * The useful invariant: this is byte-for-byte the TIM's own section payloads
 * with the 8-byte file header and the two 12-byte section preambles removed.
 * A TIM is a headerless blob wearing a hat, so both exports are generated from
 * the same TIM rather than by a second, separately-wrong packing routine.
 * There is a test pinning that equality.
 */

import { TimType, serializeTim, FILE_HEADER_SIZE, SECTION_HEADER_SIZE, type Tim } from './tim.js';

export interface RawExport {
  /** Packed texel data. */
  image: Uint8Array;
  /** Palette bytes, or undefined at 16bpp. */
  palette?: Uint8Array;
  /** Texel dimensions, since a headerless file carries none. */
  width: number;
  height: number;
  /** Bits per texel: 4, 8 or 16. */
  bpp: number;
  /** Palette entry count, or 0 at 16bpp. */
  paletteEntries: number;
}

function sectionBytes(section: { w: number; h: number; data: Uint16Array }): Uint8Array {
  const out = new Uint8Array(section.data.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < section.data.length; i++) {
    view.setUint16(i * 2, section.data[i], true);
  }
  return out;
}

/** Split a TIM into its raw payloads. */
export function toRaw(tim: Tim, texelWidth: number): RawExport {
  const bpp =
    tim.type === TimType.Bpp4 ? 4 : tim.type === TimType.Bpp8 ? 8 : 16;
  if (tim.type !== TimType.Bpp4 && tim.type !== TimType.Bpp8 && tim.type !== TimType.Bpp16) {
    throw new Error(`raw export does not support type ${tim.type}`);
  }
  return {
    image: sectionBytes(tim.pixels),
    palette: tim.clut ? sectionBytes(tim.clut) : undefined,
    width: texelWidth,
    height: tim.pixels.h,
    bpp,
    paletteEntries: tim.clut ? tim.clut.w * tim.clut.h : 0,
  };
}

/**
 * Prove the raw payloads are exactly the TIM's, by slicing them back out of a
 * serialized TIM. Used by the test suite; cheap enough to be worth having.
 */
export function rawFromSerializedTim(tim: Tim): { image: Uint8Array; palette?: Uint8Array } {
  const bytes = serializeTim(tim);
  let cursor = FILE_HEADER_SIZE;
  let palette: Uint8Array | undefined;
  if (tim.clut) {
    const len = tim.clut.w * 2 * tim.clut.h;
    palette = bytes.subarray(cursor + SECTION_HEADER_SIZE, cursor + SECTION_HEADER_SIZE + len);
    cursor += SECTION_HEADER_SIZE + len;
  }
  const len = tim.pixels.w * 2 * tim.pixels.h;
  const image = bytes.subarray(cursor + SECTION_HEADER_SIZE, cursor + SECTION_HEADER_SIZE + len);
  return { image, palette };
}
