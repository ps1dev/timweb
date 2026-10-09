// The tour shot by shoot.mjs. Each shot() call writes public/manual/<name>.png.

const W = 1440, H = 900;

export async function run({ page, png, importPngs, twoPaletteTim, shot, select, reveal }) {
  // Sample art. Deterministic, so a re-run only changes pixels when the app did.
  const hero = await png(64, 64, `
    cx.fillStyle='#e8a33c'; cx.beginPath(); cx.arc(32,34,24,0,7); cx.fill();
    cx.fillStyle='#7a3b12'; cx.fillRect(18,26,8,8); cx.fillRect(38,26,8,8);
    cx.fillStyle='#fff3c4'; cx.fillRect(20,28,3,3); cx.fillRect(40,28,3,3);
    cx.fillStyle='#000'; cx.fillRect(22,44,20,4);`);
  const sky = await png(256, 128, `
    const g=cx.createLinearGradient(0,0,0,h); g.addColorStop(0,'#1d2b6b'); g.addColorStop(.6,'#c76b4a'); g.addColorStop(1,'#f5d38a');
    cx.fillStyle=g; cx.fillRect(0,0,w,h);
    let s=7; const rnd=()=>((s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff);
    for(let i=0;i<40;i++){cx.fillStyle='rgba(255,255,255,'+(rnd()*.6)+')';cx.fillRect(rnd()*w,rnd()*h*.5,1,1);}
    cx.fillStyle='#14121c'; cx.beginPath(); cx.moveTo(0,h); for(let x=0;x<=w;x+=16)cx.lineTo(x,h-20-Math.abs(Math.sin(x*.05))*30); cx.lineTo(w,h); cx.fill();`);
  const font = await png(128, 64, `
    cx.fillStyle='#000'; cx.fillRect(0,0,w,h);
    cx.fillStyle='#fff'; cx.font='bold 14px monospace';
    const s='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?.,:-+';
    for(let i=0;i<s.length;i++) cx.fillText(s[i], (i%16)*8, 13+Math.floor(i/16)*16);`);
  const glow = await png(64, 64, `
    const g=cx.createRadialGradient(32,32,2,32,32,30); g.addColorStop(0,'rgba(255,240,180,1)'); g.addColorStop(.5,'rgba(255,140,40,.5)'); g.addColorStop(1,'rgba(255,60,0,0)');
    cx.fillStyle=g; cx.fillRect(0,0,w,h);`);

  // ---- 1. empty window -------------------------------------------------------
  await shot('01-empty', [
    { sel: '#btn-import', text: 'Import images (PNG, JPEG, GIF, WebP, BMP)', at: [470, 150] },
    { sel: '#btn-import-tim', text: 'Import existing .tim, or a .pxl + .clt pair', at: [560, 210] },
    { sel: '#canvas-wrap', text: 'Or drop any of those files on the canvas', at: [665, 780], pad: -4 },
    { sel: '#assets-empty', text: 'Imported assets are listed here', at: [430, 330] },
    { sel: '#right', text: 'With nothing selected, the right panel\nholds the project-wide settings', at: [900, 120], pad: -2 },
  ]);

  await importPngs([
    { name: 'hero.png', buffer: hero },
    { name: 'sky.png', buffer: sky },
    { name: 'font.png', buffer: font },
    { name: 'glow.png', buffer: glow },
  ]);
  await page.click('#btn-pack');
  await select('hero');

  // ---- 2. overview ------------------------------------------------------------
  await shot('02-overview', [
    { sel: '#toolbar', text: 'Toolbar', at: [720, 115], pad: -1 },
    { sel: '#assets', text: 'Asset list', at: [330, 160] },
    { sel: '#keepouts', text: 'Keepouts (framebuffers etc.)', at: [390, 330] },
    { sel: '#vram-used', text: 'VRAM totals', at: [330, 470], pad: 2 },
    { sel: '#canvas-wrap', text: 'VRAM canvas, measured in halfwords', at: [665, 790], pad: -4 },
    { sel: '#right', text: 'Inspector for the selection,\nthen project settings below it', at: [940, 700], pad: -2 },
    { sel: '#status', text: 'Status bar', at: [660, 845], pad: -1 },
    { sel: '#btn-manual', text: 'This manual', at: [980, 160], pad: 3 },
  ]);

  // ---- 3. canvas --------------------------------------------------------------
  const box = await page.locator('#canvas').boundingBox();
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(box.x + 600, box.y + 230);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(50);
  }
  await page.mouse.move(box.x + 640, box.y + 300);
  await page.waitForTimeout(100);
  await shot('03-canvas', [
    { sel: '#view-mode', text: 'Normal / Overlap / Free space', at: [960, 100] },
    { rect: [1272, 4, 164, 30], text: 'Zoom (or the mouse wheel); Fit shows all of VRAM', at: [880, 150] },
    { rect: [22, 37, 196, 28], text: 'Snap to a grid (halfwords) and to edges', at: [440, 110] },
    { rect: [234, 36, 306, 30], text: 'Auto-place everything, or only the selection', at: [440, 175] },
    { sel: '#readout', text: 'Hover readout: VRAM x,y, texture page,\nwhat is under the cursor', at: [620, 690] },
    { sel: '#s-hover', text: 'Cursor position', at: [560, 820], pad: 3 },
  ]);
  await page.mouse.move(5, 5);
  await page.click('#btn-fit');

  // ---- 4. keepouts ------------------------------------------------------------
  await page.locator('#keepouts li').first().click();
  await page.waitForSelector('#k-inspector:not(.hidden)');
  await shot('04-keepouts', [
    { sel: '#k-preset', text: 'Insert a framebuffer at a standard size', at: [470, 140] },
    { sel: '#k-add', text: 'Add a blank keepout', at: [450, 200] },
    { sel: '#keepouts', text: 'Click one to select it', at: [430, 560] },
    { sel: '#k-inspector', text: 'Name, position and size, in halfwords.\nArrow keys nudge, Shift moves by 16.', at: [880, 420] },
  ]);

  // ---- 5. depth -----------------------------------------------------------------
  await select('sky');
  await reveal('#inspector');
  await shot('05-depth', [
    { sel: '#a-locked', text: 'Locked: cannot be dragged\nand auto-place leaves it alone', at: [880, 110] },
    { sel: '#a-nopack', text: 'Excluded: auto-place leaves it alone,\nbut it still drags', at: [880, 190], pad: 2 },
    { sel: '#a-auto', text: 'Let the cost model pick the depth', at: [900, 520], pad: 2 },
    { sel: '#a-depth', text: 'Or pick 4, 8 or 16bpp yourself', at: [920, 580] },
    { rect: [1115, 296, 322, 36], text: 'VRAM the texture and its CLUT will take', at: [880, 640] },
    { sel: '#assets', text: 'A * after the depth means auto picked it', at: [420, 820] },
  ]);

  // ---- 6. conversion ------------------------------------------------------------
  await select('glow');
  await page.selectOption('#a-depth', '1');
  await reveal('#a-dither');
  await shot('06-conversion', [
    { sel: '#a-dither', text: 'Floyd-Steinberg dithering', at: [870, 140], pad: 2 },
    { sel: '#a-blackmode', text: 'What opaque black becomes', at: [870, 210] },
    { sel: '#a-blackrepl', text: 'The colour used in its place', at: [870, 280] },
    { sel: '#a-forcestp', text: 'Set STP on every texel\n(for additive/subtractive blending)', at: [850, 380], pad: 2 },
    { sel: '#a-atrans', text: 'Alpha below this: transparent hole', at: [860, 470] },
    { sel: '#a-asolid', text: 'Alpha at or above this: solid.\nIn between: semi-transparent (STP)', at: [870, 560] },
  ]);

  // ---- 7. quality ---------------------------------------------------------------
  await select('sky');
  await page.selectOption('#a-depth', '0');
  await reveal('#q-method');
  await shot('07-quality', [
    { sel: '#q-method', text: 'How the palette was made', at: [860, 100], pad: 2 },
    { sel: '#q-max', text: 'Worst error on any channel (0-255)', at: [860, 160], pad: 2 },
    { sel: '#q-past', text: 'Share of texels worse than 5-bit truncation', at: [860, 220], pad: 2 },
    { sel: '#q-collisions', text: 'Palette entries merged by 5-bit truncation', at: [860, 280], pad: 2 },
    { sel: '#q-bands', text: 'Texels opaque / semi-transparent / transparent', at: [860, 340], pad: 2 },
    { sel: '#q-swatches', text: 'The palette itself', at: [900, 520] },
  ]);
  await page.check('#a-auto');

  // ---- 8. palettes ------------------------------------------------------------
  await page.setInputFiles('#file-tims', { name: 'orb.tim', mimeType: 'application/octet-stream', buffer: twoPaletteTim() });
  await page.waitForFunction(() => [...document.querySelectorAll('#assets li .name')].some((e) => e.textContent === 'orb'), null, { timeout: 15_000 });
  await select('orb');
  await page.fill('#a-palrow', '1');
  await page.dispatchEvent('#a-palrow', 'input');
  await page.dispatchEvent('#a-palrow', 'change');
  await reveal('#a-depth');
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(768, 476);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(30);
  }
  await page.mouse.move(5, 5);
  await shot('08-palettes', [
    { sel: '#a-palrow-row', text: 'Which CLUT row the preview uses.\nExport always writes every row.', at: [940, 260], pad: 2 },
    { sel: '#a-clutwords', text: 'Two rows: 2 x 16 halfwords', at: [940, 130], pad: 3 },
    { sel: '#q-swatches', text: 'The row being previewed', at: [960, 760], pad: 3 },
    { rect: [755, 408, 47, 175], text: 'Drawn with row 1. A 4bpp texture is\n32 texels but 8 halfwords wide.', at: [480, 700] },
    { sel: '#assets', text: 'A .tim keeps the position and every\npalette row it was saved with', at: [420, 470] },
  ]);

  // ---- 9. placement -------------------------------------------------------------
  await page.click('#btn-fit');
  await select('hero');
  await reveal('#a-x');
  await shot('09-placement', [
    { rect: [1115, 82, 322, 30], text: 'Texture position, in halfwords', at: [900, 120] },
    { sel: '#clut-pos', text: 'CLUT position. X steps by 16.', at: [900, 200], pad: 2 },
    { sel: '#a-autoplace', text: 'Move this asset to the first free spot', at: [860, 520], pad: 2 },
    { sel: '#a-delete', text: 'Remove it (or press Delete)', at: [960, 600], pad: 2 },
    { sel: '#canvas-wrap', text: 'Or drag it on the canvas. Arrow keys nudge,\nShift+arrow moves 16. Middle-drag or\nShift+drag pans, the wheel zooms.', at: [560, 780], pad: -4 },
  ]);

  // ---- 10. project settings -------------------------------------------------------
  await reveal('#p-penalty');
  await page.check('#p-floor-on');
  await shot('10-project', [
    { sel: '#p-penalty', text: 'CLUT penalty: 1 minimises VRAM, higher\nfavours 16bpp and saves CLUT strips', at: [800, 520], pad: 3 },
    { sel: '#p-floor', text: 'Quality floor: auto-depth only accepts a\ndepth where this % of texels stay within\n5-bit truncation error', at: [800, 610], pad: 3 },
    { sel: '#p-reauto', text: 'Put every asset back on auto and re-run', at: [800, 700], pad: 2 },
    { sel: '#p-2mb', text: '2MB VRAM: 1024 lines instead of 512', at: [820, 150], pad: 3 },
  ]);
}

export async function tail({ page, shot, select, reveal }) {
  // ---- 11. checks -----------------------------------------------------------------
  await select('sky');
  const skyX = Number(await page.inputValue('#a-x'));
  const skyY = Number(await page.inputValue('#a-y'));
  await select('hero');
  await page.fill('#a-x', String(skyX + 40));
  await page.press('#a-x', 'Enter');
  await page.fill('#a-y', String(skyY + 60));
  await page.press('#a-y', 'Enter');
  await select('font');
  await page.fill('#a-y', '220');
  await page.press('#a-y', 'Enter');
  await page.selectOption('#view-mode', 'overlap');
  await reveal('#issues');
  await shot('11-checks', [
    { sel: '#issues', text: 'Every layout problem, in words.\nClick one to select the asset.', at: [900, 740], pad: 3 },
    { sel: '#vram-overlap', text: 'Halfwords claimed twice', at: [420, 560], pad: 3 },
    { sel: '#s-issues', text: 'Issue count', at: [420, 820], pad: 3 },
    { sel: '#view-mode', text: 'Overlap view paints the collisions', at: [900, 120] },
  ]);
  await page.selectOption('#view-mode', 'free');
  await shot('12-free-space', [
    { sel: '#view-mode', text: 'Free space view: what is still unclaimed', at: [900, 120] },
    { sel: '#vram-free', text: 'Same figure as a percentage', at: [420, 560], pad: 3 },
  ]);
  await page.selectOption('#view-mode', 'normal');
  await page.click('#btn-pack');

  // ---- 13. export -----------------------------------------------------------------
  await reveal('#p-imgsuffix');
  await shot('13-export', [
    { sel: '#btn-save', text: 'Save / open the project as JSON', drop: 110, pad: 2 },
    { sel: '#btn-export', text: 'Export a .zip with every format ticked', drop: 170, pad: 2 },
    { sel: 'label:has(#x-tim)', text: '.tim: the standard file', drop: 230, pad: 2 },
    { sel: 'label:has(#x-raw)', text: 'raw .dat: headerless image + palette', drop: 290, pad: 2 },
    { sel: 'label:has(#x-pxl)', text: '.pxl/.clt: pixel and CLUT sections split', drop: 350, pad: 2 },
    { sel: 'label:has(#x-tpl)', text: 'template: render the text file below', drop: 410, pad: 2 },
    { sel: '#p-suffix-preview', text: 'File names the suffixes produce', at: [860, 760], pad: 3 },
  ]);

  // ---- 14. template -----------------------------------------------------------------
  await page.click('#p-tplpreview');
  await reveal('#p-tplfile');
  await shot('14-template', [
    { sel: '#p-tplfile', text: 'Name of the generated file', at: [860, 120], pad: 2 },
    { sel: '#p-template', text: 'The template: one block repeated per asset', at: [760, 190], pad: 2 },
    { sel: '#p-tplpreview', text: 'Render it now', at: [900, 560], pad: 2 },
    { sel: '#p-tplout', text: 'The result, as it lands in the .zip', at: [860, 680], pad: 2 },
  ]);
}
