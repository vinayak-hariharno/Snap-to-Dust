// Snap to Dust — small floating control panel (isolated content-script world).
(() => {
  'use strict';
  if (window.top !== window) return;

  const TAG = '__snapToDust';
  const send = (type, data) =>
    window.postMessage(Object.assign({ [TAG]: true, dir: 'ext', type }, data), window.location.origin);

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;top:12px;left:12px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #e8e8f0; }
      * { box-sizing: border-box; }
      #pill { width: 36px; height: 36px; border-radius: 50%; background: #1d1b2e; border: 1px solid #4b3f8f;
              display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 18px;
              box-shadow: 0 2px 10px rgba(0,0,0,.4); user-select: none; position: relative; }
      #dot { position: absolute; right: 2px; bottom: 2px; width: 9px; height: 9px; border-radius: 50%; background: #4ade80; border: 1px solid #1d1b2e; }
      #panel { width: 250px; background: #1d1b2e; border: 1px solid #4b3f8f; border-radius: 12px; padding: 12px;
               box-shadow: 0 6px 24px rgba(0,0,0,.5); }
      #panel[hidden] { display: none; }
      #pill[hidden] { display: none; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; }
      h1 { margin: 0; font-size: 14px; font-weight: 600; }
      #close { background: none; border: 0; color: #aaa; font-size: 16px; cursor: pointer; }
      #status { margin-top: 6px; color: #b9b2ff; }
      #meter { position: relative; height: 8px; border-radius: 4px; background: #2d2a45; overflow: hidden; margin-top: 10px; }
      #bar { height: 100%; width: 0; background: #7c6cff; transition: width .08s; }
      #bar.hot { background: #f472b6; }
      #mark { position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; background: #fff; opacity: .7; }
      input[type=range] { width: 100%; accent-color: #7c6cff; }
      button.b { flex: 1; background: #3a3470; color: #fff; border: 0; border-radius: 8px; padding: 7px 8px; cursor: pointer; font: inherit; }
      button.b:hover { background: #4b43a0; }
      button.b.alt { background: #2d2a45; }
      button.b.go { background: #7c6cff; }
      small { color: #9a96b5; display: block; margin-top: 8px; }
      label { display: flex; align-items: center; gap: 6px; }
    </style>
    <div id="pill" title="Snap to Dust">🫰<span id="dot"></span></div>
    <div id="panel" hidden>
      <div class="row" style="margin-top:0"><h1>🫰 Snap to Dust</h1><button id="close" title="Minimise">–</button></div>
      <div id="status">Live — snap to vanish</div>
      <div id="meter"><div id="bar"></div><div id="mark"></div></div>
      <small>Snap level (cross the white line to trigger)</small>
      <div class="row"><span>Sensitivity</span><span id="sensVal">6</span></div>
      <input id="sens" type="range" min="1" max="10" step="1" value="6" />
      <div class="row">
        <label><input id="enabled" type="checkbox" checked /> Enabled</label>
        <button class="b" id="test" style="flex:0 0 auto">Test snap</button>
      </div>
      <div class="row">
        <button class="b go" id="cap">Capture background</button>
        <button class="b alt" id="clr" style="flex:0 0 auto">Clear</button>
      </div>
      <small id="bgnote">Step 1: capture the empty room so only YOU turn to dust (Alt+Shift+B).</small>
      <small>Hotkey: Alt + Shift + S</small>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById(id);
  const pill = $('pill'), panel = $('panel'), dot = $('dot');
  const status = $('status'), bar = $('bar'), sens = $('sens'), sensVal = $('sensVal');
  const enabled = $('enabled'), bgnote = $('bgnote');

  const setOpen = (open) => { panel.hidden = !open; pill.hidden = open; };
  pill.addEventListener('click', () => setOpen(true));
  $('close').addEventListener('click', () => setOpen(false));

  const settings = { sensitivity: 6, enabled: true };
  function pushCfg() {
    send('cfg', { cfg: { sensitivity: settings.sensitivity, enabled: settings.enabled } });
    try { chrome.storage.local.set(settings); } catch (e) {}
    dot.style.background = settings.enabled ? '#4ade80' : '#888';
  }

  sens.addEventListener('input', () => {
    settings.sensitivity = +sens.value;
    sensVal.textContent = sens.value;
    pushCfg();
  });
  enabled.addEventListener('change', () => { settings.enabled = enabled.checked; pushCfg(); });
  $('test').addEventListener('click', () => send('test'));
  $('cap').addEventListener('click', () => send('captureBg', { seconds: 5 }));
  $('clr').addEventListener('click', () => send('clearBg'));

  const STATUS = {
    live: 'Live — snap to vanish',
    vanishing: 'Turning to dust… (mic muted)',
    gone: 'Gone — snap to return',
    returning: 'Reassembling… (mic on)',
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d[TAG] || d.dir !== 'page') return;
    switch (d.type) {
      case 'state': status.textContent = STATUS[d.mode] || d.mode; break;
      case 'level':
        bar.style.width = Math.round(d.value * 100) + '%';
        bar.classList.toggle('hot', d.value >= 0.5);
        break;
      case 'snap': status.textContent = '🫰 Snap! (' + d.source + ')'; break;
      case 'countdown':
        if (d.n > 0) status.textContent = 'Step out of frame… ' + d.n;
        break;
      case 'bg':
        bgnote.textContent = d.error
          ? d.error
          : d.has
          ? '✓ Background saved: only you turn to dust.'
          : 'Step 1: capture the empty room so only YOU turn to dust (Alt+Shift+B).';
        $('cap').classList.toggle('go', !d.has);
        $('cap').classList.toggle('alt', !!d.has);
        if (d.has) status.textContent = STATUS.live;
        break;
      case 'warn': status.textContent = '⚠ ' + d.message; break;
    }
  });

  try {
    chrome.storage.local.get({ sensitivity: 6, enabled: true }, (s) => {
      settings.sensitivity = s.sensitivity;
      settings.enabled = s.enabled;
      sens.value = s.sensitivity;
      sensVal.textContent = s.sensitivity;
      enabled.checked = s.enabled;
      pushCfg();
    });
  } catch (e) {
    pushCfg();
  }
})();
