/**
 * Automatic placement over a whole project.
 *
 * The geometry lives in `packer.ts`; this is the layer that decides WHAT gets
 * packed and writes the answer back onto assets.
 *
 * The governing rule, and the reason there is no repack-everything-always
 * button: a placer that relocates something the user positioned by hand is
 * worse than no placer. So every run has an explicit scope, and two separate
 * per-asset flags can hold an asset still:
 *
 *   - `locked`         - the user's own edits. Nothing moves it, ever.
 *   - `excludeFromPacking` - the placer specifically leaves it alone, while it
 *                        stays draggable by hand.
 *
 * They are independent toggles. Locking implies the placer will not move it,
 * because a lock the placer could override would not be a lock; exclusion does
 * not imply locking.
 */

import {
  Packer,
  FlipMode,
  packObjects,
  packerOverFreeSpace,
  type Placeable,
  type Rect,
} from './packer.js';
import {
  CLUT_X_ALIGN,
  measureSpace,
  type Placement as VramPlacement,
} from './vram.js';
import { TimType } from './tim.js';
import {
  clutRect,
  pixelRect,
  projectPlacements,
  vramHeight,
  type Asset,
  type Project,
} from './project.js';
import { VRAM_WIDTH } from './vram.js';

/**
 * Default X alignment for packed textures, in halfwords.
 *
 * One 32-bit word. Halfword alignment is already guaranteed by the units, so
 * this is the conservative margin, not the requirement.
 */
export const DEFAULT_TEXTURE_ALIGN_X = 2;

/** Raw texels per VRAM halfword at each depth. The packer's width divider. */
export function texelsPerHalfword(type: TimType): number {
  switch (type) {
    case TimType.Bpp4:
      return 4;
    case TimType.Bpp8:
      return 2;
    default:
      return 1;
  }
}

/** True when the automatic placer must leave this asset where it is. */
export function isPinned(a: Asset): boolean {
  return !!a.locked || !!a.excludeFromPacking;
}

export interface PackScope {
  /**
   * Asset ids to place. Omit for "everything not pinned", which is the
   * pack-all case; pass a set for "repack this selection".
   */
  ids?: string[];
  /**
   * Place CLUTs too. On by default - leaving them behind while their textures
   * move produces a layout the user has to finish by hand.
   */
  includeCluts?: boolean;
  /**
   * X alignment for textures, in halfwords. 2 by default.
   *
   * Every position this packer emits is halfword-aligned by construction,
   * because the whole module counts in halfwords and a texture's width is
   * rounded up to whole ones. So the 16-bit boundary an individual VRAM
   * upload needs is satisfied at any value here.
   *
   * The default is 2 rather than 1 on spicyjpeg's advice that a conservative
   * setting is worth having when each image is uploaded to VRAM separately:
   * it keeps two textures out of the same 32-bit word for at most one
   * halfword of padding each. Raise it to 64 to put every texture on a page
   * origin.
   */
  textureAlignX?: number;
  /** Refuse positions straddling the Y=256 page boundary. On by default. */
  avoidRowStraddle?: boolean;
}

export interface PackReport {
  /** Assets whose texture or CLUT position changed. */
  moved: string[];
  /** Assets that did not fit. They keep their previous position. */
  unplaced: string[];
  /** Assets held still by `locked` or `excludeFromPacking`. */
  pinned: string[];
  /** Which sort order won. Diagnostic only. */
  order: string;
  usedHalfwordsBefore: number;
  usedHalfwordsAfter: number;
}

function placeablesFor(a: Asset, scope: PackScope): Placeable[] {
  const out: Placeable[] = [];
  const depth = a.settings.depth;

  out.push({
    key: `tex:${a.id}`,
    width: a.width,
    height: a.height,
    widthDivider: texelsPerHalfword(depth),
    alignX: scope.textureAlignX ?? DEFAULT_TEXTURE_ALIGN_X,
    flipMode: FlipMode.None,
    avoidRowStraddle: scope.avoidRowStraddle ?? true,
  });

  if ((scope.includeCluts ?? true) && depth !== TimType.Bpp16) {
    out.push({
      key: `clut:${a.id}`,
      width: depth === TimType.Bpp4 ? 16 : 256,
      height: 1,
      alignX: CLUT_X_ALIGN,
      flipMode: FlipMode.None,
    });
  }
  return out;
}

const toRect = (p: VramPlacement): Rect => ({ ...p.rect });

/**
 * Place the scoped assets and write the result back onto the project.
 *
 * Assets that do not fit keep their previous coordinates, which can leave them
 * overlapping something the placer has just put down. That is deliberate:
 * dropping them at 0,0 or refusing the whole run are both worse, and
 * `validate()` reports the overlap. The report names them so the caller can
 * say so out loud.
 */
export function packProject(project: Project, scope: PackScope = {}): PackReport {
  const height = vramHeight(project);
  const usedBefore = measureSpace(projectPlacements(project), height).usedHalfwords;

  const selected = scope.ids ? new Set(scope.ids) : undefined;
  const movable: Asset[] = [];
  const pinned: Asset[] = [];

  for (const a of project.assets) {
    const inScope = selected ? selected.has(a.id) : true;
    if (!inScope || isPinned(a)) pinned.push(a);
    else movable.push(a);
  }

  // Everything not being placed is an obstacle: keepouts, pinned assets, and
  // anything outside the selection. Keepouts come from projectPlacements so a
  // future reserved kind is picked up without touching this.
  const obstacles: Rect[] = [];
  for (const p of projectPlacements(project)) {
    if (p.kind === 'keepout') obstacles.push(toRect(p));
  }
  for (const a of pinned) {
    obstacles.push({ ...pixelRect(a) });
    const c = clutRect(a);
    if (c) obstacles.push({ ...c });
  }
  // A CLUT we are not placing has to survive its texture moving.
  if (!(scope.includeCluts ?? true)) {
    for (const a of movable) {
      const c = clutRect(a);
      if (c) obstacles.push({ ...c });
    }
  }

  const packer: Packer = packerOverFreeSpace(obstacles, VRAM_WIDTH, height);

  const objects: Placeable[] = [];
  for (const a of movable) objects.push(...placeablesFor(a, scope));

  const result = packObjects(packer, objects);

  const byId = new Map(project.assets.map((a) => [a.id, a]));
  const moved = new Set<string>();

  for (const p of result.placements) {
    const [kind, id] = p.obj.key.split(':');
    const asset = byId.get(id);
    if (!asset) continue;
    if (kind === 'tex') {
      if (asset.x !== p.x || asset.y !== p.y) moved.add(asset.name);
      asset.x = p.x;
      asset.y = p.y;
    } else {
      if (asset.clutX !== p.x || asset.clutY !== p.y) moved.add(asset.name);
      asset.clutX = p.x;
      asset.clutY = p.y;
    }
  }

  const unplaced = new Set<string>();
  for (const o of result.unplaced) {
    const asset = byId.get(o.key.split(':')[1]);
    if (asset) unplaced.add(asset.name);
  }

  return {
    moved: [...moved],
    unplaced: [...unplaced],
    pinned: pinned.map((a) => a.name),
    order: result.order,
    usedHalfwordsBefore: usedBefore,
    usedHalfwordsAfter: measureSpace(projectPlacements(project), height).usedHalfwords,
  };
}
