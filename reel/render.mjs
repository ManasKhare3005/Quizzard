// Renders reel.html frame by frame (1080x1920 @30fps) and mixes narration + message pops.
// Usage: node render.mjs preview <t1,t2,...>   |   node render.mjs full
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const [mode, arg] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
// scene lengths follow the narration: hand the measured durations to the page before it runs
const DURS = JSON.parse(fs.readFileSync(path.join(HERE, 'vo', 'durs.json'), 'utf8'));
await page.addInitScript((d) => { window.DURS = d; }, DURS);
await page.goto(pathToFileURL(path.join(HERE, 'reel.html')).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);

if (mode === 'preview') {
  fs.mkdirSync(path.join(HERE, 'preview'), { recursive: true });
  for (const t of arg.split(',').map(Number)) {
    await page.evaluate((x) => window.seek(x), t);
    await page.screenshot({ path: path.join(HERE, 'preview', `t${String(t).padStart(5, '0')}.png`) });
  }
} else {
  const dir = path.join(HERE, 'frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const { DURATION, VO, POPS } = await page.evaluate(() => ({ DURATION: window.DURATION, VO: window.VO, POPS: window.POPS }));
  const n = Math.round(DURATION * FPS);
  for (let f = 0; f < n; f++) {
    await page.evaluate((x) => window.seek(x), f / FPS);
    await page.screenshot({ path: path.join(dir, `${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 93 });
    if (f % 150 === 0) console.log(`frame ${f}/${n}`);
  }
  // audio: narration lines at their start times + a soft pop per message
  const vo = path.join(HERE, 'vo');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1150:duration=0.07', '-af', 'afade=t=out:st=0:d=0.07,volume=0.18', path.join(vo, 'pop.wav')]);
  const inputs = [], filters = [];
  VO.forEach((v, i) => { inputs.push('-i', path.join(vo, `${v[1]}.wav`)); filters.push(`[${i}]adelay=${Math.round(v[0] * 1000)}:all=1[a${i}]`); });
  POPS.forEach((t, j) => { const k = VO.length + j; inputs.push('-i', path.join(vo, 'pop.wav')); filters.push(`[${k}]adelay=${Math.round(t * 1000)}:all=1[a${k}]`); });
  const total = VO.length + POPS.length;
  const mix = Array.from({ length: total }, (_, i) => `[a${i}]`).join('') + `amix=inputs=${total}:normalize=0,apad,atrim=0:${DURATION},loudnorm=I=-14:TP=-1.5:LRA=11[out]`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';') + ';' + mix, '-map', '[out]', '-ar', '48000', path.join(HERE, 'audio.wav')]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%05d.jpg'), '-i', path.join(HERE, 'audio.wav'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', path.join(HERE, 'quizzard-reel.mp4')]);
  console.log('wrote quizzard-reel.mp4');
}
await browser.close();
