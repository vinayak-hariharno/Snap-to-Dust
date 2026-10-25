// Snap to Dust for Google Meet
// Runs inside the page (MAIN world) so it can wrap getUserMedia.
//
//  1. Wraps the camera: Meet receives a canvas stream we draw ourselves,
//     so everyone in the call sees the dust effect, not just you.
//  2. Listens (locally, never transmitted) for the sound of a finger snap.
//  3. Snap #1 -> dust away + click Meet's mic button to mute.
//     Snap #2 -> dust flies back in + unmute.
(() => {
  'use strict';
  if (window.__snapToDust) return;
  window.__snapToDust = true;

  const TAG = '__snapToDust';
  const post = (type, data) =>
    window.postMessage(Object.assign({ [TAG]: true, dir: 'page', type }, data), window.location.origin);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const cfg = { enabled: true, sensitivity: 6 };

  // ---------------------------------------------------------------- state
  const FX = {
    mode: 'live', // live | vanishing | gone | returning
    epoch: 0,
    startedAt: 0,
    lockUntil: 0,
    DURATION: 3000,
    plate: null, // optional empty-room background (canvas)
    pipes: new Set(),
  };

  function setMode(mode) {
    FX.mode = mode;
    FX.epoch++;
    FX.startedAt = performance.now();
    post('state', { mode });
  }

  // Finish animations on a timer so state never gets stuck if rendering stalls.
  setInterval(() => {
    const el = performance.now() - FX.startedAt;
    if (FX.mode === 'vanishing' && el >= FX.DURATION) setMode('gone');
    else if (FX.mode === 'returning' && el >= FX.DURATION) setMode('live');
  }, 50);

  // ------------------------------------------------------------ mic button
  function findMicButton() {
    const btns = Array.from(document.querySelectorAll('button[data-is-muted]'));
    const label = (b) => b.getAttribute('aria-label') || '';
    return (
      btns.find((b) => /microphone|\bmic\b/i.test(label(b))) ||
      btns.find((b) => /[+]\s*d\)?\s*$/i.test(label(b))) || // "(ctrl + d)" works in any UI language
      null
    );
  }

  function setMicMuted(wantMuted) {
    const btn = findMicButton();
    if (!btn) {
      post('warn', { message: "Couldn't find Meet's mic button — mute manually." });
      return;
    }
    const isMuted = btn.getAttribute('data-is-muted') === 'true';
    if (isMuted !== wantMuted) btn.click();
  }

  // ------------------------------------------------------------ the snap
  function triggerSnap(source) {
    if (!cfg.enabled) return;
    const now = performance.now();
    if (now < FX.lockUntil) return;
    if (FX.mode === 'live') {
      FX.lockUntil = now + FX.DURATION + 500;
      if (!FX.plate) post('warn', { message: 'No background saved: whole frame dissolves. Press Capture background.' });
      setMode('vanishing');
      setMicMuted(true);
    } else if (FX.mode === 'gone') {
      FX.lockUntil = now + FX.DURATION + 500;
      setMode('returning');
      setMicMuted(false);
    } else {
      return;
    }
    post('snap', { source });
  }

  // ----------------------------------------------------- grid helpers
  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // Average colours of `src` on a cols x rows grid (two-step for a cleaner average).
  function downsample(src, cols, rows) {
    const k = 4;
    const a = mkCanvas(cols * k, rows * k);
    const actx = a.getContext('2d');
    actx.imageSmoothingQuality = 'high';
    actx.drawImage(src, 0, 0, a.width, a.height);
    const b = mkCanvas(cols, rows);
    const bctx = b.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(a, 0, 0, cols, rows);
    return bctx.getImageData(0, 0, cols, rows).data;
  }

  // 3x3 neighbourhood filter: output = 1 when at least `min` of 9 cells are set.
  // min=5 -> majority (denoise), min=1 -> dilate.
  function neighbourhood(m, cols, rows, min) {
    const out = new Uint8Array(m.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            n += m[rr * cols + cc];
          }
        }
        out[r * cols + c] = n >= min ? 1 : 0;
      }
    }
    return out;
  }

  // Grow confident "person" cells into weaker neighbours (edge-preserving, like Canny hysteresis).
  function growHysteresis(strong, weak, cols, rows) {
    const out = new Uint8Array(strong);
    const stack = [];
    for (let i = 0; i < out.length; i++) if (out[i]) stack.push(i);
    while (stack.length) {
      const i = stack.pop();
      const r = (i / cols) | 0, c = i % cols;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (!out[j] && weak[j]) { out[j] = 1; stack.push(j); }
        }
      }
    }
    return out;
  }

  // Fill holes inside the silhouette (e.g. a shirt the same colour as the wall).
  function fillHoles(m, cols, rows) {
    const N = m.length;
    const outside = new Uint8Array(N);
    const stack = [];
    const seed = (i) => { if (!m[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
    for (let c = 0; c < cols; c++) { seed(c); seed((rows - 1) * cols + c); }
    for (let r = 0; r < rows; r++) { seed(r * cols); seed(r * cols + cols - 1); }
    while (stack.length) {
      const i = stack.pop();
      const r = (i / cols) | 0, c = i % cols;
      if (r > 0) seed(i - cols);
      if (r < rows - 1) seed(i + cols);
      if (c > 0) seed(i - 1);
      if (c < cols - 1) seed(i + 1);
    }
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) out[i] = m[i] || !outside[i] ? 1 : 0;
    return out;
  }

  // Drop specks and stray blobs; keep the main body (and any big part such as a raised arm).
  function keepMain(m, cols, rows) {
    const N = m.length;
    const label = new Int32Array(N);
    const sizes = [0];
    let next = 0;
    for (let s0 = 0; s0 < N; s0++) {
      if (!m[s0] || label[s0]) continue;
      next++;
      let size = 0;
      const stack = [s0];
      label[s0] = next;
      while (stack.length) {
        const i = stack.pop();
        size++;
        const r = (i / cols) | 0, c = i % cols;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            const j = rr * cols + cc;
            if (m[j] && !label[j]) { label[j] = next; stack.push(j); }
          }
        }
      }
      sizes.push(size);
    }
    let max = 0;
    for (let k = 1; k < sizes.length; k++) if (sizes[k] > max) max = sizes[k];
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (label[i] && sizes[label[i]] >= max * 0.15) out[i] = 1;
    return out;
  }

  // ------------------------------------------------------------ pipeline
  async function createPipeline(rawTrack) {
    const rawSettings = rawTrack.getSettings ? rawTrack.getSettings() : {};

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.cssText =
      'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1';
    video.srcObject = new MediaStream([rawTrack]);
    document.documentElement.appendChild(video);
    try {
      await video.play();
    } catch (e) {
      /* autoplay muted should be fine */
    }
    if (!video.videoWidth) {
      await new Promise((res) => {
        video.addEventListener('loadedmetadata', res, { once: true });
        setTimeout(res, 2000);
      });
    }

    const W = video.videoWidth || rawSettings.width || 1280;
    const H = video.videoHeight || rawSettings.height || 720;
    const canvas = mkCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });

    // particle grid
    const cell = Math.max(4, Math.ceil(W / 120));
    const cols = Math.ceil(W / cell);
    const rows = Math.ceil(H / cell);
    const N = cols * rows;
    const sx = W / 1280;
    const sy = H / 720;

    const rA = new Float32Array(N);
    const rB = new Float32Array(N);
    const rC = new Float32Array(N);
    const rD = new Float32Array(N);
    const rE = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      rA[i] = Math.random();
      rB[i] = Math.random();
      rC[i] = Math.random();
      rD[i] = Math.random();
      rE[i] = Math.random();
    }

    const snap = mkCanvas(W, H);
    const snapCtx = snap.getContext('2d');
    const remain = mkCanvas(W, H); // what's still "solid" during vanish
    const remainCtx = remain.getContext('2d');
    const landed = mkCanvas(W, H); // which cells have re-formed during return
    const landedCtx = landed.getContext('2d');
    landedCtx.fillStyle = '#000';
    const tmp = mkCanvas(W, H);
    const tmpCtx = tmp.getContext('2d');

    let idx = new Int32Array(0); // cells that take part in the effect
    let colors = [];
    const delay = new Float32Array(N);
    const erased = new Uint8Array(N);
    const landedFlag = new Uint8Array(N);
    let seen = -1;
    let dead = false;

    const MASK_THRESHOLD = 60; // confident "this is you" (colour distance 0..765 vs. empty-room plate)
    const MASK_WEAK = 35; // accepted only when touching a confident cell

    function computeMask(px) {
      const mask = new Uint8Array(N);
      if (!FX.plate) {
        mask.fill(1); // no background captured: the whole frame turns to dust
        return mask;
      }
      const pp = downsample(FX.plate, cols, rows);
      // compensate global brightness drift using the frame border
      let o0 = 0, o1 = 0, o2 = 0, n = 0;
      for (let r = 0; r < rows - 2; r++) {
        for (let c = 0; c < cols; c++) {
          if (r >= 2 && c >= 2 && c < cols - 2) continue;
          const i = (r * cols + c) * 4;
          o0 += px[i] - pp[i];
          o1 += px[i + 1] - pp[i + 1];
          o2 += px[i + 2] - pp[i + 2];
          n++;
        }
      }
      if (n) { o0 /= n; o1 /= n; o2 /= n; }
      const weak = new Uint8Array(N);
      for (let k = 0; k < N; k++) {
        const i = k * 4;
        const d =
          Math.abs(px[i] - pp[i] - o0) +
          Math.abs(px[i + 1] - pp[i + 1] - o1) +
          Math.abs(px[i + 2] - pp[i + 2] - o2);
        mask[k] = d > MASK_THRESHOLD ? 1 : 0;
        weak[k] = d > MASK_WEAK ? 1 : 0;
      }
      let m = neighbourhood(mask, cols, rows, 3); // remove isolated noise
      m = growHysteresis(m, weak, cols, rows);
      m = fillHoles(m, cols, rows);
      m = keepMain(m, cols, rows);
      return neighbourhood(m, cols, rows, 1); // 1-cell margin for hair / fast motion
    }

    // Keep the saved background in step with lighting changes, only where you are NOT standing.
    let lastRefresh = 0;
    function refreshPlate() {
      const pl = FX.plate;
      if (!pl || pl.width !== W || pl.height !== H) return;
      const m = neighbourhood(neighbourhood(computeMask(downsample(video, cols, rows)), cols, rows, 1), cols, rows, 1);
      const pctx = pl.getContext('2d');
      pctx.save();
      pctx.beginPath();
      for (let i = 0; i < N; i++) {
        if (!m[i]) pctx.rect((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
      }
      pctx.clip();
      pctx.globalAlpha = 0.12;
      pctx.drawImage(video, 0, 0, W, H);
      pctx.restore();
    }

    function prepareParticles(reverse) {
      snapCtx.drawImage(video, 0, 0, W, H);
      const px = downsample(video, cols, rows);
      const mask = computeMask(px);
      const list = [];
      let minC = cols, maxC = 0;
      for (let i = 0; i < N; i++) {
        if (!mask[i]) continue;
        list.push(i);
        const c = i % cols;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
      idx = Int32Array.from(list);
      const span = Math.max(1, maxC - minC);
      colors = new Array(N);
      for (const i of list) {
        let norm = ((i % cols) - minC) / span; // sweep left -> right
        if (reverse) norm = 1 - norm;
        delay[i] = norm * 0.4 + rA[i] * 0.15; // max 0.55
        colors[i] = 'rgb(' + px[i * 4] + ',' + px[i * 4 + 1] + ',' + px[i * 4 + 2] + ')';
      }
      erased.fill(0);
      landedFlag.fill(0);
    }

    function enter(mode) {
      if (mode === 'vanishing') {
        prepareParticles(false);
        remainCtx.save();
        remainCtx.clearRect(0, 0, W, H);
        remainCtx.beginPath();
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k];
          remainCtx.rect((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
        }
        remainCtx.clip();
        remainCtx.drawImage(snap, 0, 0);
        remainCtx.restore();
      } else if (mode === 'returning') {
        prepareParticles(true);
        landedCtx.clearRect(0, 0, W, H);
      }
    }

    function drawPlate() {
      setOp('source-over');
      ctx.globalAlpha = 1;
      if (FX.plate) ctx.drawImage(FX.plate, 0, 0, W, H);
      else {
        ctx.fillStyle = '#050507';
        ctx.fillRect(0, 0, W, H);
      }
    }

    // u: 0 = in place, 1 = fully blown away
    // Life of a particle: your own colour -> glowing ember at the burning edge -> grey ash.
    // ~18% are long-lived embers that flicker and keep glowing as they drift away.
    const EMBER = ['rgb(255,222,140)', 'rgb(255,176,64)', 'rgb(255,122,32)', 'rgb(236,78,22)'];
    const ASH = ['rgb(38,36,38)', 'rgb(68,64,66)', 'rgb(104,99,101)', 'rgb(150,145,146)'];
    let curOp = 'source-over';
    function setOp(op) {
      if (curOp !== op) {
        curOp = op;
        ctx.globalCompositeOperation = op;
      }
    }

    function drawParticle(i, u) {
      const isEmber = rB[i] > 0.82;
      let a = Math.pow(1 - u, 1.1);
      if (isEmber) a = Math.min(1, a * 1.6 * (0.75 + 0.25 * Math.sin(performance.now() * 0.02 + rC[i] * 20)));
      if (a < 0.03) return;
      const e = Math.pow(u, 1.5);
      const ph = rC[i] * 6.2832;
      const x = (i % cols) * cell + (80 + rB[i] * 420) * sx * e + Math.sin(ph + u * 5) * 18 * sx * u;
      const y = Math.floor(i / cols) * cell + (-300 + rD[i] * 340) * sy * e + Math.cos(ph + u * 4) * 18 * sy * u;
      const s = cell * (1 - 0.55 * u);
      const h = s * (0.55 + 0.45 * rE[i]); // flakes, not perfect squares

      if (u < 0.1) {
        setOp('source-over');
        ctx.globalAlpha = a;
        ctx.fillStyle = colors[i];
        ctx.fillRect(x, y, s, h);
      } else if (u < 0.38 || (isEmber && u < 0.85)) {
        const col = EMBER[(rC[i] * 4) | 0];
        setOp('lighter'); // additive blending = glow
        if (u < 0.3) {
          ctx.globalAlpha = a * 0.22; // soft halo around the burning front
          ctx.fillStyle = col;
          ctx.fillRect(x - s * 0.6, y - s * 0.6, s * 2.2, s * 2.2);
        }
        ctx.globalAlpha = a;
        ctx.fillStyle = col;
        ctx.fillRect(x, y, s, h);
      } else {
        setOp('source-over');
        ctx.globalAlpha = a;
        ctx.fillStyle = ASH[(rD[i] * 4) | 0];
        ctx.fillRect(x, y, s, h);
      }
    }

    const lifeOf = (i) => 0.25 + rE[i] * 0.2; // delay (<=0.55) + life (<=0.45) <= 1

    function renderVanish(tn) {
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        if (!erased[i] && tn > delay[i]) {
          erased[i] = 1;
          remainCtx.clearRect((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
        }
      }
      drawPlate();
      ctx.drawImage(remain, 0, 0);
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const pr = (tn - delay[i]) / lifeOf(i);
        if (pr <= 0 || pr >= 1) continue;
        drawParticle(i, pr);
      }
      setOp('source-over');
      ctx.globalAlpha = 1;
    }

    function renderReturn(tn) {
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        if (!landedFlag[i] && (tn - delay[i]) / lifeOf(i) >= 1) {
          landedFlag[i] = 1;
          landedCtx.fillRect((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
        }
      }
      tmpCtx.globalCompositeOperation = 'source-over';
      tmpCtx.clearRect(0, 0, W, H);
      tmpCtx.drawImage(video, 0, 0, W, H);
      tmpCtx.globalCompositeOperation = 'destination-in';
      tmpCtx.drawImage(landed, 0, 0);
      drawPlate();
      ctx.drawImage(tmp, 0, 0);
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const pr = (tn - delay[i]) / lifeOf(i);
        if (pr <= 0 || pr >= 1) continue;
        drawParticle(i, 1 - pr);
      }
      setOp('source-over');
      ctx.globalAlpha = 1;
    }

    function render() {
      if (dead || video.readyState < 2) return;
      if (seen !== FX.epoch) {
        seen = FX.epoch;
        enter(FX.mode);
      }
      const tn = clamp((performance.now() - FX.startedAt) / FX.DURATION, 0, 1);
      if (FX.mode === 'vanishing') renderVanish(tn);
      else if (FX.mode === 'returning') renderReturn(tn);
      else if (FX.mode === 'gone') drawPlate();
      else {
        const nowMs = performance.now();
        if (FX.plate && nowMs - lastRefresh > 1000) {
          lastRefresh = nowMs;
          try { refreshPlate(); } catch (e) {}
        }
        setOp('source-over');
        ctx.globalAlpha = 1;
        ctx.drawImage(video, 0, 0, W, H);
      }
    }

    // first frame so the stream never starts black
    ctx.drawImage(video, 0, 0, W, H);
    const timer = setInterval(render, 1000 / 30);

    const outStream = canvas.captureStream(30);
    const outTrack = outStream.getVideoTracks()[0];

    const api = {
      captureFrame() {
        const c = mkCanvas(W, H);
        c.getContext('2d').drawImage(video, 0, 0, W, H);
        return c;
      },
    };
    FX.pipes.add(api);

    // ---- lifetime: raw camera is released when every output track is stopped
    let refs = 0;
    const outs = new Set();

    function destroy() {
      if (dead) return;
      dead = true;
      clearInterval(timer);
      FX.pipes.delete(api);
      try { rawTrack.stop(); } catch (e) {}
      video.srcObject = null;
      video.remove();
    }

    function hook(track) {
      refs++;
      outs.add(track);
      const origStop = track.stop.bind(track);
      const origClone = track.clone.bind(track);
      let stopped = false;
      track.__origStop = origStop;
      track.stop = () => {
        origStop();
        if (stopped) return;
        stopped = true;
        outs.delete(track);
        if (--refs <= 0) destroy();
      };
      track.clone = () => {
        const c = origClone();
        hook(c);
        return c;
      };
      // look like the real camera to Meet's device UI
      try {
        Object.defineProperty(track, 'label', { get: () => rawTrack.label });
        const origGet = track.getSettings.bind(track);
        track.getSettings = () => Object.assign({}, rawSettings, origGet());
      } catch (e) {}
    }
    hook(outTrack);

    rawTrack.addEventListener('ended', () => {
      for (const t of Array.from(outs)) {
        try { t.__origStop(); t.dispatchEvent(new Event('ended')); } catch (e) {}
      }
      destroy();
    });

    return outTrack;
  }

  // -------------------------------------------------- getUserMedia wrapper
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const origGUM = md.getUserMedia.bind(md);

  md.getUserMedia = async function (constraints) {
    const stream = await origGUM(constraints);
    try {
      if (stream.getAudioTracks().length) startDetector();
      const vts = stream.getVideoTracks();
      if (!constraints || !constraints.video || !vts.length) return stream;
      const out = new MediaStream(stream.getAudioTracks()); // audio passes through untouched
      for (const t of vts) out.addTrack(await createPipeline(t));
      return out;
    } catch (err) {
      console.warn('[Snap to Dust] falling back to the plain camera:', err);
      return stream;
    }
  };

  // ------------------------------------------------------- snap detector
  let detectorStarted = false;

  async function startDetector() {
    if (detectorStarted) return;
    detectorStarted = true;
    try {
      // Our own mic capture with all processing OFF: noise suppression would eat the snap.
      // It stays inside this tab, is only analysed locally, and is never sent anywhere.
      const stream = await origGUM({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        video: false,
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC({ latencyHint: 'interactive' });
      const resume = () => { if (ac.state !== 'running') ac.resume().catch(() => {}); };
      ['pointerdown', 'keydown', 'click'].forEach((ev) =>
        document.addEventListener(ev, resume, { capture: true })
      );
      resume();

      const src = ac.createMediaStreamSource(stream);
      const hp = ac.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2000; // snaps are bright; voices and thumps are not
      hp.Q.value = 0.8;
      const proc = ac.createScriptProcessor(512, 1, 1);

      let bg = 0.002; // running background level
      let pending = null; // candidate waiting for its decay check
      let blockUntil = 0;
      let peakHold = 0;
      let lastPost = 0;

      proc.onaudioprocess = (e) => {
        const x = e.inputBuffer.getChannelData(0);
        let peak = 0, sum = 0;
        for (let i = 0; i < x.length; i++) {
          const a = Math.abs(x[i]);
          if (a > peak) peak = a;
          sum += a * a;
        }
        const rms = Math.sqrt(sum / x.length);
        const now = performance.now();
        const minPeak = 0.25 * Math.pow(0.75, clamp(cfg.sensitivity, 1, 10) - 1);

        peakHold = Math.max(peak, peakHold * 0.9);
        if (now - lastPost > 100) {
          lastPost = now;
          post('level', { value: clamp(peakHold / (minPeak * 2), 0, 1) }); // marker at 50% = threshold
        }
        if (!cfg.enabled) return;

        if (pending) {
          pending.n++;
          if (pending.n >= 3) pending.tail = Math.max(pending.tail, rms);
          if (pending.n >= 6) {
            // a real snap is over within ~30 ms; speech / clapping / music keep ringing
            if (pending.tail < pending.rms * 0.45) triggerSnap('audio');
            pending = null;
            blockUntil = now + 300;
          }
          return;
        }
        if (now < blockUntil) return;
        if (peak > minPeak && rms > bg * 6 && rms > 0.004) {
          pending = { rms, tail: 0, n: 0 };
        } else {
          bg = bg * 0.98 + rms * 0.02;
        }
      };

      src.connect(hp);
      hp.connect(proc);
      proc.connect(ac.destination); // outputs silence; needed so the node keeps running
    } catch (err) {
      detectorStarted = false;
      post('warn', { message: 'Snap listener could not start: ' + (err && err.message) });
    }
  }

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions
      .query({ name: 'microphone' })
      .then((p) => { if (p.state === 'granted') startDetector(); })
      .catch(() => {});
  }

  // ------------------------------------------------------ background plate
  let capTimer = null;
  function activePipe() {
    return Array.from(FX.pipes).pop();
  }

  function captureBackground(seconds) {
    clearInterval(capTimer);
    if (!activePipe()) {
      post('bg', { has: false, error: 'Turn your camera on first.' });
      return;
    }
    let n = seconds;
    post('countdown', { n });
    capTimer = setInterval(() => {
      n--;
      if (n > 0) return post('countdown', { n });
      clearInterval(capTimer);
      const p = activePipe();
      if (!p || FX.mode !== 'live') {
        post('countdown', { n: 0 });
        return post('bg', { has: !!FX.plate, error: 'Capture cancelled.' });
      }
      FX.plate = p.captureFrame();
      post('countdown', { n: 0 });
      post('bg', { has: true });
    }, 1000);
  }

  // ---------------------------------------------------- messages / hotkey
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d[TAG] || d.dir !== 'ext') return;
    switch (d.type) {
      case 'cfg': Object.assign(cfg, d.cfg); break;
      case 'test': triggerSnap('button'); break;
      case 'captureBg': captureBackground(d.seconds || 5); break;
      case 'clearBg': FX.plate = null; post('bg', { has: false }); break;
    }
  });

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyS') {
        e.preventDefault();
        triggerSnap('hotkey');
      } else if (e.altKey && e.shiftKey && e.code === 'KeyB') {
        e.preventDefault();
        captureBackground(5);
      }
    },
    true
  );
})();
