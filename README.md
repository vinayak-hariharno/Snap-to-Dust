# 🫰 Snap to Dust — Thanos snap for Google Meet

[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/manifest.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-experimental-orange)

A Chrome extension for Google Meet. **Snap your fingers** and you crumble into glowing embers and ash, just like in *Infinity War*, and your **mic mutes**. **Snap again** and the dust flies back, re-forms you, and **unmutes** you.

Everyone in the call sees the effect, not just you.

<!-- Add a demo GIF here: docs/demo.gif -->
<!-- ![Demo](docs/demo.gif) -->

## Features

- 🫰 **Snap detection:** recognises the sound of a finger snap, with an adjustable sensitivity slider and a live level meter
- 💨 **Dust disintegration:** your colours ignite into embers at the burning edge, cool into grey ash and drift away; played in reverse when you return
- 🧍 **Person-only effect:** save a picture of the empty room once, and only *you* dissolve while the room stays
- 🎙️ **Auto mic mute / unmute:** uses Meet's own mic button, so Meet's UI always stays in sync
- ⌨️ **Hotkeys:** `Alt+Shift+S` snaps without any sound, `Alt+Shift+B` captures the background
- 🔒 **Private:** all processing happens locally in your browser (see [Privacy](#privacy))

## Install

No build step. It's plain JavaScript.

1. Download or clone this repo
   ```bash
   git clone https://github.com/<your-username>/snap-to-dust.git
   ```
2. Open `chrome://extensions` and turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the **`extension/`** folder
4. Open or reload a Google Meet tab and allow camera and mic

Works in Chrome and other Chromium browsers (Edge, Brave, Arc) on `meet.google.com`.

## Usage

A small 🫰 button appears at the top-left of Meet. Click it to open the control panel.

| Action | How |
|---|---|
| Vanish / return | Snap your fingers near the mic |
| Test without sound | **Test snap** button or `Alt+Shift+S` |
| Person-only effect | **Capture background**, then step out of frame for 5 seconds (or `Alt+Shift+B`) |
| Tune detection | **Sensitivity** slider (1–10); the snap must push the meter past the white line |
| Turn off | Untick **Enabled** |

**Tip:** wear headphones. Voices coming out of your speakers can sound like snaps to the detector.

## How it works

```
 camera ──► wrapped getUserMedia ──► canvas (dust renderer) ──► Meet ──► other people
 mic ─────► separate local tap ──► snap detector ──┐
                                                   ├─► state: live → vanishing → gone → returning
 Alt+Shift+S / Test button ────────────────────────┘        │
                                                            └─► clicks Meet's mic button
```

1. `inject.js` runs inside the Meet page (`"world": "MAIN"`) and wraps `navigator.mediaDevices.getUserMedia`. Meet receives a canvas stream we draw ourselves, which is why others see the effect.
2. The frame is split into a grid of particles. A mask (difference from the saved empty-room image, cleaned with hysteresis, hole-filling and connected-component filtering) picks which cells belong to you.
3. Each particle follows a deterministic path based on time, so the "return" animation is simply the same maths run backwards.
4. A separate mic tap with noise suppression **off** (suppression removes snaps) feeds a high-pass filter and a transient detector: a sharp bright spike that dies out within ~30 ms.
5. `panel.js` (isolated content script) draws the control panel and talks to the page via `window.postMessage`.

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project structure

```
snap-to-dust/
├── extension/
│   ├── manifest.json      # MV3 manifest, content-script registration
│   ├── inject.js          # camera wrapper, dust renderer, snap detector, mic control
│   └── panel.js           # floating control panel UI
├── docs/
│   └── ARCHITECTURE.md    # design notes
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## Privacy

- No servers, no analytics, no network requests.
- Microphone audio is analysed in memory for snap detection and is **never recorded, stored or transmitted**. Meet's own audio path is untouched.
- The only data saved is your two settings (sensitivity and enabled), in `chrome.storage.local`.
- The empty-room image lives in memory for the current tab only.

## Known limitations

- Detection is by **sound**, not by watching your fingers, so a sharp clap or desk tap can also trigger it.
- The person-only mask is a simple difference from the saved background. It works best with a fixed camera and steady lighting; re-capture if you move the camera. Without a saved background, the whole frame dissolves.
- Meet's page markup can change. If the mic doesn't toggle, the panel shows a warning (the extension looks for the mic button by its `data-is-muted` attribute).
- Effect runs on the CPU/canvas; very old machines may see lower frame rates.

## Troubleshooting

| Problem | Try |
|---|---|
| Snap doesn't trigger | Raise sensitivity; snap closer to the mic; check the meter moves |
| Triggers by itself | Lower sensitivity; use headphones; move away from noisy keyboards |
| Whole screen dissolves | Capture the background (step fully out of frame) |
| Parts of the room dissolve | Re-capture the background; keep lighting steady |
| Mic doesn't mute | Look for the ⚠ message in the panel; reload the Meet tab |
| Nothing happens | Reload the extension on `chrome://extensions`, then reload Meet |

## Roadmap

- [ ] Whoosh / crumble sound effect
- [ ] Adjustable speed and dust direction
- [ ] Hand-gesture snap detection on camera (MediaPipe)
- [ ] ML person segmentation (no empty-room step)
- [ ] Smarter snap classifier to reduce false triggers

## Contributing

Issues and pull requests are welcome. Please test on a real Meet call and describe your browser and OS. There's no build system, so edit the files in `extension/` and reload the extension to try changes.

## Disclaimer

This is an unofficial fan project. It is not affiliated with or endorsed by Google, Marvel or Disney. "Google Meet" is a trademark of Google LLC.

## License

[MIT](LICENSE)
