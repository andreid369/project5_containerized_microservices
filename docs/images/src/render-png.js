// Render an SVG file to PNG at 2x with the preinstalled Chromium.
// Usage: node render.js <in.svg> <out.png> <width> <height>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const [, , input, output, w, h] = process.argv;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.resolve(input));
  await page.waitForTimeout(300);
  await page.screenshot({ path: output, clip: { x: 0, y: 0, width: +w, height: +h } });
  await browser.close();
  console.log('wrote', output, fs.statSync(output).size, 'bytes');
})();
