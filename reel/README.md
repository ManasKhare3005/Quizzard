# Quizzard reel

Vertical 1080x1920 promo reel (simulated chat, labeled as such). `reel.html` is a deterministic
page driven by `window.seek(t)`; `render.mjs` screenshots it frame by frame and mixes narration.

## Render

Needs Node 18+ and `ffmpeg` on PATH.

```bash
cd reel
npm install
npx playwright install chromium
npm run render          # writes quizzard-reel.mp4
npm run preview -- 1,10,30   # stills at those seconds into preview/
```

## Edit the story

- On-screen chat + captions: the `STORY` array in `reel.html`.
- Narration text: `vo/lines.txt` (one `key|line` per scene).
- Voice: Kokoro `af_heart` via Hyperframes. Regenerate a line, then update its length in `vo/durs.json`
  (scenes re-time from it):

```bash
npx -y hyperframes@0.8.196 tts "Midterm next week..." --voice af_heart --speed 1.0 -o vo/hook.wav
ffprobe -v error -show_entries format=duration -of csv=p=0 vo/hook.wav
```
