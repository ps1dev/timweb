/**
 * Automatic bit-depth selection.
 *
 * Ported from the cost model used in the pylive2d PS1 texture pipeline, where
 * it was validated against real assets. Per image, minimise
 *
 *     cost = textureWords + clutPenalty * clutWords
 *
 * over {4bpp with its own 16-entry CLUT, 8bpp with its own 256-entry CLUT,
 * 16bpp raw}, subject to a quality floor that indexed candidates must clear.
 *
 * The interesting behaviour falls out rather than being programmed in: for
 * small images 16bpp raw wins, because a 256-halfword CLUT is not worth paying
 * for. At clutPenalty = 1 the 8bpp/16bpp crossover sits at 512 texels, which
 * matches what the Live2D pipeline measured.
 *
 * `clutPenalty` is the knob worth exposing. 1.0 minimises true VRAM. Raising it
 * pushes marginal images to 16bpp and reclaims CLUT space, which matters
 * because CLUTs are awkwardly shaped: a 256-entry CLUT is 256 halfwords wide
 * and one line tall, so it eats a strip four texture pages across.
 *
 * The quality figure is NOT computed here. It has to come from the quantizer
 * that will actually be used, because a merge or depth gate validated against a
 * proxy metric accepts choices the real remap rejects. Pass in what the
 * quantizer reports; if you have nothing, pass nothing and only the VRAM cost
 * decides.
 */

import { TimType, halfwordWidth } from './tim.js';

export type IndexedDepth = TimType.Bpp4 | TimType.Bpp8;
export type SelectableDepth = IndexedDepth | TimType.Bpp16;

export const CLUT_WORDS: Record<SelectableDepth, number> = {
  [TimType.Bpp4]: 16,
  [TimType.Bpp8]: 256,
  [TimType.Bpp16]: 0,
};

export const PALETTE_SIZE: Record<IndexedDepth, number> = {
  [TimType.Bpp4]: 16,
  [TimType.Bpp8]: 256,
};

export interface DepthCandidate {
  type: SelectableDepth;
  /** VRAM halfwords the texture itself occupies. */
  textureWords: number;
  /** VRAM halfwords its CLUT occupies. Zero for 16bpp. */
  clutWords: number;
  /** textureWords + clutPenalty * clutWords. */
  cost: number;
  /**
   * Quality this depth achieves, 0..100, as reported by the quantizer.
   * Undefined when unknown; 16bpp is always 100 (it stores colour directly).
   */
  quality?: number;
  /** False when a quality floor was supplied and this candidate misses it. */
  admissible: boolean;
  /** Why it was rejected, for the UI to explain itself. */
  rejection?: string;
}

export interface ChooseDepthOptions {
  /**
   * How hard to punish CLUT VRAM relative to texture VRAM. 1.0 minimises true
   * total VRAM. Higher values reclaim CLUT space by pushing images to 16bpp.
   */
  clutPenalty?: number;
  /** Minimum quality, 0..100, an indexed candidate must reach. */
  qualityFloor?: number;
  /**
   * Achievable quality per indexed depth, from the real quantizer.
   * Depths absent from this map are treated as quality-unknown: they stay
   * admissible on cost alone, and the caller is told so.
   */
  quality?: Partial<Record<IndexedDepth, number>>;
  /**
   * Distinct RGB555 colours in the source. When a count fits a palette exactly,
   * that depth is lossless and scores quality 100 regardless of the quantizer.
   */
  distinctColors?: number;
  /** Restrict the candidate set. Defaults to all three. */
  allow?: SelectableDepth[];
}

export interface DepthChoice {
  best: DepthCandidate;
  candidates: DepthCandidate[];
  /** True when the winner was decided without any quality information. */
  costOnly: boolean;
}

const ALL_DEPTHS: SelectableDepth[] = [TimType.Bpp4, TimType.Bpp8, TimType.Bpp16];

export function depthCandidates(
  width: number,
  height: number,
  options: ChooseDepthOptions = {},
): DepthCandidate[] {
  const {
    clutPenalty = 1,
    qualityFloor,
    quality = {},
    distinctColors,
    allow = ALL_DEPTHS,
  } = options;

  return allow.map((type) => {
    const textureWords = halfwordWidth(width, type) * height;
    const clutWords = CLUT_WORDS[type];
    const cost = textureWords + clutPenalty * clutWords;

    let q: number | undefined;
    let admissible = true;
    let rejection: string | undefined;

    if (type === TimType.Bpp16) {
      q = 100;
    } else {
      const palette = PALETTE_SIZE[type];
      if (distinctColors !== undefined && distinctColors <= palette) {
        // Fits without discarding anything. No quantizer needed.
        q = 100;
      } else {
        q = quality[type];
      }
      if (qualityFloor !== undefined) {
        if (q === undefined) {
          // A floor is a request for a guarantee, and an ungraded candidate
          // cannot supply one. Letting it through picks 4bpp for a
          // 200-colour image on cost alone, which is the cheapest possible
          // way to produce a massacre.
          admissible = false;
          rejection = `quality at this depth is unmeasured, so it cannot be graded against the floor of ${qualityFloor}; run the quantizer or drop the floor`;
        } else if (q < qualityFloor) {
          admissible = false;
          rejection = `quality ${q} is below the floor of ${qualityFloor}`;
        }
      }
    }

    return { type, textureWords, clutWords, cost, quality: q, admissible, rejection };
  });
}

export function chooseDepth(
  width: number,
  height: number,
  options: ChooseDepthOptions = {},
): DepthChoice {
  const candidates = depthCandidates(width, height, options);
  const viable = candidates.filter((c) => c.admissible);

  // 16bpp is the floor of last resort: it cannot fail a quality gate, so if
  // everything else is inadmissible there is still an answer.
  const pool = viable.length > 0 ? viable : candidates;

  const best = pool.reduce((a, b) => {
    if (b.cost !== a.cost) return b.cost < a.cost ? b : a;
    // Tie on cost: prefer the higher quality, then the deeper format.
    const qa = a.quality ?? -1;
    const qb = b.quality ?? -1;
    if (qa !== qb) return qb > qa ? b : a;
    return b.type > a.type ? b : a;
  });

  const costOnly = candidates.every(
    (c) => c.type === TimType.Bpp16 || c.quality === undefined,
  );

  return { best, candidates, costOnly };
}

/**
 * Texel count at which 16bpp becomes cheaper than 8bpp, for a given penalty.
 *
 * 8bpp costs `texels/2 + clutPenalty*256`, 16bpp costs `texels`. They meet at
 * `texels = clutPenalty * 512`. Below that, paying for a 256-entry CLUT costs
 * more VRAM than just storing the colours.
 */
export function crossover16vs8(clutPenalty = 1): number {
  return clutPenalty * 512;
}

/**
 * Texel count at which 8bpp becomes cheaper than 4bpp.
 *
 * 4bpp costs `texels/4 + clutPenalty*16`, 8bpp costs `texels/2 +
 * clutPenalty*256`. 4bpp is cheaper for every positive size - the 240-halfword
 * CLUT difference never pays for itself on VRAM alone. So the choice between
 * them is always a QUALITY call, never a cost one, and a UI that presents it as
 * a cost trade-off is lying.
 */
export function fourBitIsAlwaysCheaper(): true {
  return true;
}
