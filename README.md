# timweb

A browser-based PlayStation TIM converter and VRAM layout editor. Builds to a
single self-contained `.html` you can copy anywhere and open offline. No server,
no install, no network.

Spiritual successor to Psy-Q's TIMTOOL (SCEE, 1998) and Lameguy64's TIMedit.

```
npm install
npm run dev      # dev server
npm run build    # -> dist/index.html, one file, ~50 KB
npm test         # typecheck + unit + browser end-to-end
```

## What it does

- **Import** PNG, JPEG, GIF, WebP, BMP (anything the browser decodes), or an
  existing `.tim`, which is placed at the coordinates it already carries.
- **Convert** to 4/8/16bpp TIM, with the palette chosen at full RGB888 precision
  and truncated to RGB555 afterwards.
- **Place** in a 1024x512 halfword VRAM canvas with zoom, pan, snapping,
  overlap detection, free-space view and a live hover readout.
- **Switch to 2MB VRAM** (1024x1024) when the target has the second bank
  populated. Width is invariant; only the Y axis widens 9-bit to 10-bit.
- **Reserve VRAM with keepouts** - arbitrary rectangles that auto-placement
  routes around. Framebuffers ARE keepouts, not a parallel mechanism: a menu
  inserts one at a standard size and from then on it drags, resizes and behaves
  like any other reserved region. Side-by-side, stacked, padded, or anywhere at
  all falls out of that rather than needing layout presets.
- **Check** against the constraints the file format does not enforce: CLUT X
  alignment, texture-page boundaries, the 8-bit U range, the display region.
- **Export** any combination of three formats - `.tim`, headerless `.dat` image
  + palette, and split `.pxl` + `.clt` - plus a project file and a text VRAM map.
  All three are independent checkboxes; all suffixes are configurable.

### Raw export

The `raw .dat` toggle emits what ps1-bare-metal's `convertImage.py` produces:
two headerless files per asset, defaulting to `<asset>_image.dat` and
`<asset>_palette.dat`. Both suffixes are configurable per project and stored in
the project file, so they can be bent to whatever a given build system expects
(`Data.dat` / `PaletteData.dat` drops straight into ps1-bare-metal's
`addBinaryFile()`). An empty suffix, or two that collide, is refused rather than
silently producing one file where two were meant.

4bpp packs two indices per byte low-nibble-first, 8bpp is one byte per index,
16bpp is little-endian RGB555 with STP in bit 15, and the palette is padded to
16 or 256 entries.

This is byte-for-byte the TIM's own section payloads with the file header and
section preambles removed, and it is generated from the same TIM rather than by
a second packing routine - there is a test pinning that equality at all three
depths. Since the `.dat` files carry no dimensions, the VRAM map records them.

### Keepouts and locking

A keepout is a named rectangle that reserves VRAM. Framebuffers are keepouts
with a preset size, which is the whole of the difference. Assets can be
**locked**, which prevents dragging and makes Find free space refuse to move
them - deliberately NOT the same flag as "exclude from packing", which will
arrive with a packer if one ever does.

Two reserved regions overlapping each other is not an issue. A keepout may
quite reasonably cover a framebuffer, and flagging it would be the tool arguing
with the user about their own layout.

### Placement templates

Raw `.dat` files carry no coordinates, so on their own they are half an export.
The `template` toggle renders a user-supplied text file - a C array, a series of
`sendVRAMData()` calls, JSON, a Makefile fragment, whatever the consumer needs.
No templates are shipped beyond one example, on purpose.

```
{{#assets}}    { "{{name}}", {{x}}, {{y}}, {{w}}, {{h}} },
{{/assets}}
```

There is a `{{#keepouts}}` block too, with `{{name}} {{x}} {{y}} {{w}} {{h}}`.

`{{#clut}}...{{/clut}}` and `{{^clut}}` gate on whether an asset has a palette,
`:hex` / `:hex4` format numbers, and **unknown placeholders are left verbatim**
rather than emptied, so a typo shows up in the output instead of silently
producing a struct with a missing field.

Both halfword (`x y w h`) and texel (`width height`) dimensions are exposed
separately, because conflating them is the classic way to get a VRAM upload
wrong.

### PXL / CLT

Split TIMs: a TIM header carrying only the pixel section, and only the CLUT
section, in separate files. Rare but real - Granstream Saga and both Bloody
Roars ship them. Import pairs them by base name; an indexed `.pxl` without its
`.clt` is refused rather than decoded against a guessed palette.

**The ID bytes are contested.** Sony's documentation says `11h=PXL, 12h=CLT`.
Shipped games do the opposite, psx-spx records the conflict explicitly, and
spicyjpeg's converter follows the games. So does this, with a test pinning the
values so a later tidy-up cannot quietly flip them back.

## Things it does that TIMTOOL and TIMedit do not

- **Auto depth.** A per-image cost model minimises
  `textureWords + clutPenalty * clutWords` over {4bpp, 8bpp, 16bpp raw} against
  a quality floor, with `clutPenalty` on a slider. At penalty 1 the 16bpp/8bpp
  crossover falls at 512 texels. Turning the penalty up reclaims CLUT strips by
  pushing marginal images to 16bpp.
- **A quality metric that discriminates.** Max channel error scored against the
  5-bit truncation floor: an 8-to-5 truncation can never miss by more than 7, so
  anything past 7 is the quantizer rather than the format. Mean error is shown
  but is not the headline, because it hides exactly this.
- **Multi-palette CLUTs** (TIMedit drops them) and **round-tripping** existing
  TIMs.
- **Semi-transparency done properly**, which is the part most PS1 encoders get
  wrong. Three-state alpha (hole / STP / opaque) with both cuts exposed,
  `forceSTP` for additive and subtractive blending, and a choice between dark
  grey and semi-transparent black for opaque black. The palette is built per
  band, because the STP bit lives in the CLUT entry rather than the texel: a
  colour appearing both solid and semi-transparent needs two entries, and
  setting the bit on a shared entry flips every other pixel using it.
- **The black trap handled automatically.** RGB(0,0,0) with STP clear encodes to
  `0x0000`, which the hardware reads as a hole, so opaque black is nudged to
  `0x0421`. Setting STP instead would collide with `SetSemiTrans()`. The nudge
  costs a fixed 8 units per channel and is reported separately from quantizer
  error, because no palette choice can avoid it.

## Things it deliberately does not do

- **Dithering is off by default.** It is available, and it is tested to actually
  change bytes, but it speckles flat fills and PS1 textures get magnified and
  affine-mapped, which makes the speckle worse.
- **Project files store layout, not art.** Round-tripping megabytes of source
  through JSON would make the file unusable. On load, assets come back as
  placeholders and re-attach by name when you re-import - the same mechanism as
  inherit-on-reimport.
- **No pre-rounding to RGB555 before quantizing.** It rescues a weak quantizer
  and handicaps a good one.

## Format notes

The TIM spec is in psx-spx, `docs/cdromfileformats.md`. Two things that bite:

- **`W` and `X` are in 16-bit halfwords, not texels.** A 256-texel-wide 8bpp
  image is 128 halfwords across. Everything in `src/core/vram.ts` counts in
  halfwords for this reason.
- **Shipped files are not clean.** Flags bits 4-31 carry junk in real files, and
  psn00bsdk itself ships two TIMs with wrong section length fields. The parser
  masks flags, trusts dimensions over the length field, advances by
  `max(declared, implied)` so a too-small length cannot land the cursor inside
  its own payload, and reports each as a diagnostic rather than dying.

## Testing

`npm test` runs three things: `tsc --noEmit`, unit tests, and a real browser
driving the built single file off `file://`.

Unit tests are graded against **real shipped `.tim` files found on this
machine**, not fixtures this project generated - a fixture built by our own
serializer only proves the serializer agrees with itself. `TIM4.tim` and
`TIM8.tim` round-trip byte-exactly. The suite fails loudly if fewer than four
specimens resolve, because a `runIf` suite that resolves nothing reports green.

The end-to-end test exists because a clean `vite build` is a claim about the
pipeline with no power over whether the page runs.

## Not built

See `ROADMAP.md`: automatic packing, multi-palette CLUTs with a colour-cycling
editor, and multi-palette TIM export. Recorded rather than committed to.

## On the quantizer

The built-in one is median cut with Lloyd refinement, working in RGB888.

`@panda-ai/imagequant`, the obvious wasm libimagequant port, was evaluated and
**rejected**: it accepts `max_colors`, range-validates it, and then discards it
(their `lib.rs` builds an `Attributes`, sets max colors on it, then constructs a
second one and uses that), so the palette is always `min(distinct, 256)` and
4bpp is unreachable. It also hard-panics with `RuntimeError: unreachable` and no
message on any image libimagequant cannot hit 70% quality on, which includes
ordinary photographic content. Its README documents an API the shipped package
does not contain.

If a better wasm quantizer turns up, `PaletteGenerator` in
`src/core/quantize.ts` is the seam: implement `generate(pixels, count,
maxColors) -> RGB888 palette` and the rest of the pipeline is unchanged.
