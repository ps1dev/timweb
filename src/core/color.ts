/**
 * RGB555 conversion and quality metrics for PlayStation TIM assets.
 *
 * Colour layout of a 16-bit texel or CLUT entry (psx-spx, "Texture Colors"):
 *
 *   bit  0-4   Red   (0..31)
 *   bit  5-9   Green (0..31)
 *   bit 10-14  Blue  (0..31)
 *   bit 15     STP (semi-transparency flag)
 *
 * Value semantics, which are NOT the same as the bit layout:
 *
 *   0x0000            fully transparent
 *   0x0001..0x7FFF    opaque
 *   0x8000..0xFFFF    semi-transparent under a semi-transparent draw command,
 *                     opaque under an opaque one
 *
 * The consequence that bites everyone: black is unusable as a drawn colour,
 * because RGB(0,0,0) with STP clear encodes to 0x0000 and the hardware treats
 * that as a hole. See nudgeBlack().
 */

/** Bit position of the STP flag in a 16-bit texel or CLUT entry. */
export const STP_BIT = 0x8000;

/** The value the GPU treats as fully transparent. */
export const TRANSPARENT = 0x0000;

/**
 * Semi-transparent black: STP set, RGB all zero.
 *
 * The OTHER way to make black drawable. It renders as true solid black, but
 * only while the primitive is drawn with semi-transparency disabled at the
 * command level - turn ABE on and it becomes a blended black instead. That
 * conditionality is why dark grey is the safer default.
 */
export const STP_BLACK = 0x8000;

/**
 * Near-black stand-in for opaque black: R=1, G=1, B=1.
 *
 * Two ways to make black drawable: set its STP bit, or move it off zero. The
 * first collides with SetSemiTrans() (the same bit then means semi-transparent
 * black), so moving it off zero is the safe default.
 */
export const NEAR_BLACK = 0x0421;

/** Truncate an 8-bit channel to 5 bits. Matches the PS1's own 8->5 behaviour. */
export function ch8to5(v: number): number {
  return (v & 0xff) >> 3;
}

/** Expand a 5-bit channel back to 8 bits by bit replication (0..31 -> 0..255). */
export function ch5to8(v: number): number {
  const c = v & 0x1f;
  return (c << 3) | (c >> 2);
}

/** Pack 8-bit RGB into a 16-bit RGB555 value. `stp` sets bit 15. */
export function packRGB555(r: number, g: number, b: number, stp = false): number {
  return (
    (ch8to5(r) << 0) | (ch8to5(g) << 5) | (ch8to5(b) << 10) | (stp ? STP_BIT : 0)
  );
}

/** Unpack a 16-bit RGB555 value into 8-bit RGB plus the STP flag. */
export function unpackRGB555(v: number): {
  r: number;
  g: number;
  b: number;
  stp: boolean;
} {
  return {
    r: ch5to8(v >> 0),
    g: ch5to8(v >> 5),
    b: ch5to8(v >> 10),
    stp: (v & STP_BIT) !== 0,
  };
}

/** The raw 5-bit channel triple, without expanding back to 8 bits. */
export function channels555(v: number): [number, number, number] {
  return [v & 0x1f, (v >> 5) & 0x1f, (v >> 10) & 0x1f];
}

/**
 * Make a colour safe to draw as opaque.
 *
 * Returns NEAR_BLACK for anything that would encode to 0x0000, and the value
 * unchanged otherwise. Only apply this to colours the user wants OPAQUE -
 * genuinely transparent entries must stay 0x0000.
 */
export function nudgeBlack(v: number): number {
  return (v & 0x7fff) === 0 ? NEAR_BLACK : v;
}

// ---------------------------------------------------------------------------
// Quality metrics
// ---------------------------------------------------------------------------

/**
 * Per-image error report, scored against the 5-bit truncation floor.
 *
 * The key idea, and the reason mean error is not reported as the headline:
 * truncating an 8-bit channel to 5 bits can never miss by more than 7. So any
 * pixel whose channel error exceeds 7 is the QUANTIZER's fault, not the
 * format's, and `pastFloorFraction` isolates exactly that. A mean-delta score
 * hides it - measured on the pcsx-redux Tetris backgrounds, an asset with 17%
 * of pixels past the floor and a max channel error of 47 had a mean delta
 * indistinguishable from four clean assets.
 *
 * Caveat worth surfacing in any UI that shows this: a low score is not the same
 * as looking good. An MSE-optimal palette can be perceptually worse than a
 * higher-scoring one at 4bpp. Show the number, do not gate on it.
 */
export interface ErrorReport {
  /** Largest single-channel absolute error, in 8-bit units. <=7 means clean. */
  maxChannelError: number;
  /** Mean absolute per-channel error, in 8-bit units. Reported, not trusted. */
  meanChannelError: number;
  /** Fraction of pixels with any channel error past the 5-bit floor of 7. */
  pastFloorFraction: number;
  /** Number of pixels compared (fully transparent source pixels are skipped). */
  pixelsCompared: number;
  /**
   * Fraction of pixels excluded from `pastFloorFraction` because their error is
   * a deliberate format workaround rather than quantizer failure - currently
   * only the opaque-black nudge, which costs a fixed 8 units per channel and
   * which no palette choice can avoid. Reported separately so it stays VISIBLE
   * without derailing a decision about quantizer quality.
   */
  excusedFraction: number;
}

/** The most an 8->5 bit truncation can miss a channel by. */
export const TRUNCATION_FLOOR = 7;

/**
 * Compare a reconstructed RGBA image against its source.
 *
 * Both buffers are 8-bit RGBA, same dimensions. Pixels whose SOURCE alpha is 0
 * are skipped: they are holes, and whatever colour sits underneath them is not
 * a quantization error.
 */
export function scoreAgainstSource(
  source: Uint8Array | Uint8ClampedArray,
  reconstructed: Uint8Array | Uint8ClampedArray,
  /**
   * One byte per pixel, non-zero meaning "this pixel's error is a deliberate
   * format workaround, not quantizer failure". Excluded from
   * `pastFloorFraction`, counted in `excusedFraction`, and still included in
   * `maxChannelError` and the mean so it cannot hide.
   */
  excused?: Uint8Array,
): ErrorReport {
  if (source.length !== reconstructed.length) {
    throw new Error(
      `size mismatch: source ${source.length} vs reconstructed ${reconstructed.length}`,
    );
  }

  let maxChannelError = 0;
  let errorSum = 0;
  let pastFloor = 0;
  let compared = 0;
  let excusedCount = 0;

  for (let i = 0, px = 0; i < source.length; i += 4, px++) {
    if (source[i + 3] === 0) continue;
    compared++;

    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(source[i + c] - reconstructed[i + c]);
      errorSum += d;
      if (d > worst) worst = d;
    }
    if (worst > maxChannelError) maxChannelError = worst;

    if (excused && excused[px]) {
      excusedCount++;
      continue;
    }
    if (worst > TRUNCATION_FLOOR) pastFloor++;
  }

  const gradable = compared - excusedCount;
  return {
    maxChannelError,
    meanChannelError: compared === 0 ? 0 : errorSum / (compared * 3),
    pastFloorFraction: gradable <= 0 ? 0 : pastFloor / gradable,
    pixelsCompared: compared,
    excusedFraction: compared === 0 ? 0 : excusedCount / compared,
  };
}

/**
 * Count how many distinct colours survive the trip to RGB555.
 *
 * Useful before choosing a bit depth: if an image has 200 distinct RGB555
 * colours it fits an 8bpp CLUT losslessly and quantization is unnecessary.
 * Collisions here are real but usually small - measured on one truecolour
 * asset, 7552 distinct RGB888 collapsed to 778 distinct RGB555.
 */
export function countDistinct(source: Uint8Array | Uint8ClampedArray): {
  rgb888: number;
  rgb555: number;
} {
  const seen888 = new Set<number>();
  const seen555 = new Set<number>();
  for (let i = 0; i < source.length; i += 4) {
    if (source[i + 3] === 0) continue;
    seen888.add((source[i] << 16) | (source[i + 1] << 8) | source[i + 2]);
    seen555.add(packRGB555(source[i], source[i + 1], source[i + 2]));
  }
  return { rgb888: seen888.size, rgb555: seen555.size };
}
