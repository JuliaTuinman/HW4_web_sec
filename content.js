// runs in each top-level http(s) page.
//
// Page visible + focused -> ask service worker for a screenshot
//    every TICK_MS
//    shortly after scroll/resize stops
//    so stored screenshot = what user last saw
// Draw changed cells (from service worker) + warning banner
//    all in a closed shadow root -> page can't easily style/read it

(() => {
  if (window.top !== window) return;

  const TICK_MS = 2000;
  const SETTLE_MS = 400;
  const Z = '2147483647';

  let overlay = null; // { cellsHost, bannerHost }
  let settleTimer = null;

  function alive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function canCapture() {
    return document.visibilityState === 'visible' && document.hasFocus() && !overlay;
  }

  function tick() {
    if (!alive()) return;
    if (canCapture()) chrome.runtime.sendMessage({ type: 'tick' }).catch(() => {});
  }

  function tickSoon() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(tick, SETTLE_MS);
  }

  setInterval(tick, TICK_MS);
  addEventListener('scroll', tickSoon, { passive: true });
  addEventListener('resize', tickSoon, { passive: true });
  tick();

  // overlay

  function removeOverlay() {
    if (!overlay) return;
    overlay.cellsHost.remove();
    overlay.bannerHost.remove();
    overlay = null;
    removeEventListener('keydown', onKey, true);
    tickSoon();
  }

  function onKey(e) {
    if (e.key === 'Escape') removeOverlay();
  }

  function makeHost(style) {
    const host = document.createElement('div');
    host.setAttribute('data-tabnab-detector', '');
    host.style.cssText = style;
    const root = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    return { host, root };
  }

  function showOverlay({ cells, changedRatio, major }) {
    removeOverlay();
    if (!cells || cells.length === 0) return;

    const vw = window.innerWidth, vh = window.innerHeight;
    const sx = window.scrollX, sy = window.scrollY;

    const cellsPart = makeHost(
      `all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; ` +
      `overflow: visible; pointer-events: none; z-index: ${Z};`);
    const color = major ? '220, 30, 30' : '240, 170, 0';
    const frag = document.createDocumentFragment();
    for (const c of cells) {
      const d = document.createElement('div');
      d.style.cssText =
        `position: absolute; box-sizing: border-box; pointer-events: none; ` +
        `left: ${sx + c.x * vw}px; top: ${sy + c.y * vh}px; ` +
        `width: ${c.w * vw}px; height: ${c.h * vh}px; ` +
        `background: rgba(${color}, 0.28); outline: 1px solid rgba(${color}, 0.85);`;
      frag.appendChild(d);
    }
    cellsPart.root.appendChild(frag);

    const bannerPart = makeHost(
      `all: initial; position: fixed; top: 12px; right: 12px; z-index: ${Z};`);
    const pct = Math.max(1, Math.round(changedRatio * 100));
    bannerPart.root.innerHTML = `
      <style>
        .box { font: 14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; max-width: 360px;
               background: ${major ? '#b71c1c' : '#f57f17'}; color: #fff; padding: 12px 14px;
               border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
        .title { font-weight: 700; margin-bottom: 4px; }
        .host { font-family: ui-monospace, monospace; background: rgba(0,0,0,.25);
                padding: 1px 4px; border-radius: 3px; word-break: break-all; }
        button { margin-top: 8px; font: inherit; font-weight: 600; cursor: pointer; border: 0;
                 border-radius: 4px; padding: 4px 12px; background: #fff; color: #222; }
      </style>
      <div class="box" role="alert">
        <div class="title">${major ? '⚠ Possible tabnabbing' : 'This page changed'}</div>
        <div>About ${pct}% of this page changed while you were on another tab.
          The changed areas are highlighted.
          ${major ? 'If it now asks you to log in, check that you are really on the site you expect.' : ''}
          You are on: <span class="host"></span></div>
        <button type="button">Dismiss</button>
      </div>`;
    bannerPart.root.querySelector('.host').textContent = location.hostname || location.href;
    bannerPart.root.querySelector('button').addEventListener('click', removeOverlay);

    overlay = { cellsHost: cellsPart.host, bannerHost: bannerPart.host };
    addEventListener('keydown', onKey, true);
  }

  // messages from the service worker

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return;
    if (msg.type === 'prepare') {
      // Remove overlay and wait for a repaint -> not in the screenshot
      removeOverlay();
      let done = false;
      const finish = () => { if (!done) { done = true; sendResponse({ ok: true }); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 150);
      return true;
    }
    if (msg.type === 'result') showOverlay(msg);
  });
})();
