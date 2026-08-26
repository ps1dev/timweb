# Not built, worth building

Recorded so they are not lost, not as commitments. All three came from
spicyjpeg, who explicitly did not push for them.

## Automatic packing

**Feasibility read done 2026-08-23 against the real source**
(`live2d-research/pylive2d/repack/{packer,vram,image,remap}.py`). Verdict:
port it, do not invent one, and take LESS than half of it.

### What it is

`packer.py` is 517 lines, ~260 of them actual algorithm, and imports **nothing
outside the standard library** - no numpy, no PIL, nothing vectorised. It is a
free-rectangle list with a disjoint four-way split (the rectpack2D family),
modified for per-object alignment requirements and orientation-dependent size
dividers. Selection is best-fit by leftover area after alignment padding.
It transliterates to TypeScript almost line for line.

Two pieces must be COPIED rather than re-derived, both flagged as such by the
author: the four-way split geometry, and the triple-XOR that chooses which
split orientation wastes least (`((right != bottom) != vertical) !=
nonIdealSplit`, commented "some doodling and boolean algebra").

`vram.py` is another ~280 lines of PS1 logic. numpy appears only in pixel
blitting (a `Uint16Array` and a row loop) and PIL only in an SVG debug view
(`canvas.toDataURL`, or drop it). Packing is fully separable from the
quantizer and the blitter: `Placeable` carries integers only.

### Most of vram.py does not apply here

The Live2D packer builds a RELOCATABLE atlas - groups of 4/2/1 columns whose
members must stay contiguous because the loader places each group at an
arbitrary VRAM address. Hence page groups, the split cascade, `bake()`, and
`packObjectsAdaptive`'s binary search for an atlas size.

timweb places into ABSOLUTE VRAM at a fixed 1024x512 or 1024x1024, with the
framebuffers already reserved. So the size search is irrelevant, and the group
machinery mostly is too. What is wanted is the placer itself, seeded with the
existing placements as occupied space:

- `Rect`, `Placeable`, `Placement`, `placeObject`, `tryPlaceObjects` (~260 lines)
- the alignment fields, which already map onto what this tool enforces: CLUT
  `alignX = 16`, textures `alignX = 2` for the even-U requirement
- the width-divider contract - hand the packer the RAW TEXEL width and let it
  divide (4 texels/word at 4bpp, 2 at 8bpp), applied AFTER any rotation swap
- the 64-word column-boundary constraint, which this tool already checks in
  `vram.ts` and would need to ENFORCE rather than merely report

Skip: `packObjectsAdaptive`, page groups, `bake()`, the atlas binary, the SVG
view. Estimate ~300 lines with no dependencies.

### Defaults to carry over

`sizeReduction` stays 0.0. Measured in that project: 0.15 gave 22 columns at
75.8% fill, 0.0 gave 19 at 87.8%. The shrink chases a per-page ratio that is
blind to which column an overflow spills into. **The objective is columns, not
fill.** That lesson survives the port even though the mechanism does not.

Sideways placement (`FlipMode`) is worth keeping - the UV remap swaps axes to
match - but only if this tool grows a rotated-texture concept, which it has
not.

### Two defects measured in the upstream packer

Both reproduced with synthetic inputs on 2026-08-23. Neither is documented in
the source. A port has to decide whether to reproduce or fix them; fix.

1. **`_sortByNumColumns` mislabels bins, order-dependently.** The
   `while binIndex >= len(bins): bins.append((numColumns, []))` padding stamps
   the TRIGGERING object's column span onto every bin it backfills. Same
   objects, opposite iteration order, different labels - wide-first gives
   `[(4,[256]),(4,[128]),(4,[64,64])]`, narrow-first gives
   `[(4,[256]),(2,[128]),(1,[64,64])]`. The consequence is a real straddle: one
   256-entry CLUT plus six 50-word 4bpp textures places one at x=50 with width
   50, crossing the 64-word column boundary. The pipeline catches this
   downstream rather than in the packer, and the error text says "Adjust
   packing ... before shipping", so the author knows the packer does not
   guarantee it.

2. **A non-power-of-two column span hangs `buildVRAMPages` forever.**
   `binIndex = ceil(log2(numColumns))` collapses spans 3 and 4 into one bin. A
   3-column object landing there first labels the bin 3, and a 4-column object
   (a 256-word CLUT) is then asked to fit a 192-word page. `while unplaced:`
   never terminates. Two objects reproduce it. The width guard that would catch
   it runs AFTER the loop. **A port should add a `placed == 0` guard: two
   lines, turns a hang into an error.**

Scope limit on both: synthetic inputs, constructed to hit the path. Neither was
observed on a real model run, so how often they fire in practice is unknown.

Also dead: the `straddles` check at the top of the category loop in
`buildVRAMPages`. `bake()` clears `placements` on every page at the end of every
iteration, so the check is `any([])` forever - instrumented over a 27-object
run, `split()` never once saw a live placement.

### Prerequisites, now built

spicyjpeg named two, both of which stand on their own and are done:

- **Keepouts.** Arbitrary reserved rectangles. Framebuffers ARE keepouts - a
  preset menu inserts one at a standard size and there is no second mechanism.
  Auto-placement routes around them, they drag, and they are in the project
  file, the VRAM map and the template. A packer consumes them as occupied space
  with no further work.
- **Locked assets.** Cannot be dragged, and "Find free space" refuses to move
  them.

**Locked is NOT "exclude from packing", and that distinction is his.** They are
different flags: one is about the user's own edits and is meaningful today; the
other is a promise about a packer that does not exist, and implementing it now
would put a checkbox in the UI that nothing honours. When the packer lands it
gets its own flag, and the sensible default is probably that locked implies
excluded while excluded does not imply locked.

### The design question the port does not answer

Packing is only useful if the result stays editable, and a packer that
relocates something the user placed by hand is worse than no packer. With
keepouts and locking in place the natural shape is "pack the unplaced" or
"repack this selection" - not a repack-everything button.

## Multiple palettes with a colour-cycling editor

The format already supports it - a CLUT section with height > 1 is N palettes
stacked, and `VP-hack/main-menu/00007.tim` is a real 16x2 specimen. The parser
handles it; nothing in the UI exposes it.

CLUT cycling is the cheap PS1 way to do gradient sweeps, glows and pulses:
rewrite 16 or 256 entries per frame, every indexed pixel shifts at once, no
extra layers, tiny upload. An editor wants a cycle spec (range, direction,
period) plus optional keyframed entries, and the preview has to animate or the
whole point is invisible.

The real gap is not the editor, it is that a cycling palette needs a main-RAM
master copy and a VRAM destination, i.e. a palette that is a resource rather
than a static page. Worth reading the sdvx-anim notes before starting.

## Multi-palette TIM export

Falls out of the above: emit a CLUT section with height N. Cheap once the
project model can hold more than one palette per asset, which it currently
cannot - `Asset.converted` is a single `QuantizeResult`.

TIMedit does not support multi-image TIMs at all, so this is a place where
being newer could actually mean being better.
