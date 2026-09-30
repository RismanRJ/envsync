import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DURATION = 30;
const TOTAL_FRAMES = FPS * DURATION;

const filmPath = resolve(__dirname, 'film.html');
const outDir = resolve(__dirname, '..', 'deliverables');
const framesDir = resolve(__dirname, 'frames');
const outFile = join(outDir, 'p2p-envsync-vertical.mp4');

if (!existsSync(framesDir)) mkdirSync(framesDir, { recursive: true });
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Rendering ${TOTAL_FRAMES} frames at ${WIDTH}x${HEIGHT} ${FPS}fps...`);

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [`--window-size=${WIDTH},${HEIGHT}`, '--no-sandbox', '--disable-gpu'],
});

const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
await page.goto(`file://${filmPath}`, { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction('typeof window.seek === "function"', { timeout: 10000 });

for (let i = 0; i < TOTAL_FRAMES; i++) {
  const t = i / FPS;
  await page.evaluate((time) => window.seek(time), t);
  await new Promise(r => setTimeout(r, 16));
  const pad = String(i).padStart(5, '0');
  await page.screenshot({ path: join(framesDir, `frame_${pad}.jpg`), type: 'jpeg', quality: 95 });
  if (i % 30 === 0) process.stdout.write(`\rFrame ${i}/${TOTAL_FRAMES} (${(t).toFixed(1)}s)`);
}

console.log('\nFrames done. Encoding with ffmpeg...');
await browser.close();

execSync([
  'ffmpeg', '-y',
  '-framerate', String(FPS),
  '-i', `"${join(framesDir, 'frame_%05d.jpg')}"`,
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '18',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  `"${outFile}"`,
].join(' '), { stdio: 'inherit' });

console.log(`Video saved: ${outFile}`);
