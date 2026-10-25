# Architecture

## Two content scripts, two worlds

| File | World | Why |
|---|---|---|
| `inject.js` | `MAIN` (the page itself) | Must replace `getUserMedia` before Meet calls it, and needs to click Meet's DOM buttons |
| `panel.js` | Isolated | Can use `chrome.storage`; draws the UI in a Shadow DOM so Meet's CSS can't touch it |

They communicate with `window.postMessage`, tagged `__snapToDust`, with `dir: "ext"` (panel → page) or `dir: "page"` (page → panel).

## State machine

```
live ──snap──► vanishing ──3 s──► gone ──snap──► returning ──3 s──► live
```

- Transitions finish on a 50 ms timer so state can never get stuck if rendering stalls.
- A lock (`animation + 500 ms`) ignores snaps while an animation runs, which also swallows echoes.
- Entering `vanishing` mutes the mic; entering `returning` unmutes it.

## Camera pipeline

1. `getUserMedia` is wrapped. Audio tracks pass through untouched; each video track is replaced with a `canvas.captureStream(30)` track.
2. The output track's `stop`, `clone`, `label` and `getSettings` are patched so Meet's camera switching and device UI keep working, and the real camera is released when every output track has stopped.
3. A 30 fps timer renders: live video, or the dust effect, or the empty-room plate.

## Dust renderer

- Frame → grid of ~120 columns of square cells; each cell is a particle with fixed random values.
- **Mask:** colour distance between the live frame and the saved empty-room image (brightness-compensated using the frame border), then hysteresis grow → hole fill → largest-component filter → 1-cell dilation.
- **Timeline:** `delay = sweep(left→right)*0.4 + random*0.15`, `life = 0.25..0.45`, so everything finishes within the duration.
- **Look:** progress `u` goes 0→1: own colour (`u<0.1`) → additive-blended ember with halo (`u<0.38`; ~18% of particles keep glowing to `u<0.85` and flicker) → grey ash.
- **Return:** same functions with `u = 1 − progress` and a reversed sweep. Cells landed so far show the *live* video through a mask canvas, so you reappear seamlessly.
- **Plate refresh:** once per second, cells outside the person mask blend 12% toward the live frame so lighting drift doesn't break the mask.

## Snap detector

- Own `getUserMedia({audio})` with echo cancellation, noise suppression and auto gain off.
- `highpass(2 kHz) → ScriptProcessor(512)`. Per buffer: peak and RMS.
- Candidate = `peak > threshold` and `rms > 6× running background`. After ~30–60 ms the tail energy must be below 45% of the peak buffer, otherwise it was speech, a clap or music.
- Sensitivity maps to `threshold = 0.25 · 0.75^(s−1)`.

## Mic control

Finds `button[data-is-muted]` whose `aria-label` mentions the microphone or ends with `(ctrl + d)`, reads `data-is-muted`, and clicks only if the state needs to change.
