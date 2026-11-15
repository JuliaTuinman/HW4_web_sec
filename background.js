// service worker.
//
// 1. Tab visible + focused -> content script sends "tick"s
//      each tick: screenshot the tab
//      keep only the latest one per tab (chrome.storage.session)
// 2. tabs.onActivated / windows.onFocusChanged -> tab lost focus
//      mark it "away", freeze its last screenshot
// 3. "Away" tab seen again -> take fresh screenshot
//      compare w/ frozen one (diff.js, all local)
// 4. Show result
//      coloured badge on toolbar icon
//      send changed cells to content script to highlight

import { compareScreenshots } from './diff.js';

const MIN_CAPTURE_GAP_MS = 600; // captureVisibleTab allows >= 2 calls per second
const RETURN_SETTLE_MS = 400; // let the page repaint after the tab comes back
const NONE = chrome.windows.WINDOW_ID_NONE;

const LEVELS = {
  same:    { color: '#2e7d32', text: 'OK' },
  minor:   { color: '#f9a825' },
  major:   { color: '#c62828' },
  unknown: { color: '#757575', text: '?' }
};
const MAJOR_RATIO = 0.10;

// small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = {
  shot: (tabId) => `shot:${tabId}`,
  away: (tabId) => `away:${tabId}`,
  active: (windowId) => `active:${windowId}`
};

async function sget(k) { return (await chrome.storage.session.get(k))[k]; }
async function sset(obj) { await chrome.storage.session.set(obj); }
async function sdel(keys) { await chrome.storage.session.remove(keys); }

// Run work for one tab in order, so a tick can never race a comparison.
const queues = new Map();
function enqueue(tabId, fn) {
  const next = (queues.get(tabId) || Promise.resolve())
    .then(fn)
    .catch((e) => console.warn('[tabnab]', e && e.message ? e.message : e));
  queues.set(tabId, next);
  return next;
}

// Returns the tab if it is the active tab of the focused window, else null.
async function visibleTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return null;
    const win = await chrome.windows.get(tab.windowId);
    return win.focused ? tab : null;
  } catch {
    return null;
  }
}

let lastCaptureAt = 0;
async function capture(windowId) {
  const wait = lastCaptureAt + MIN_CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
}

async function storeShot(tabId, dataUrl) {
  const entry = { [key.shot(tabId)]: { dataUrl, time: Date.now() } };
  try {
    await sset(entry);
  } catch {
    // storage.session is capped at about 10 MB -> drop the oldest screenshots and retry.
    const all = await chrome.storage.session.get(null);
    const shots = Object.entries(all)
      .filter(([k]) => k.startsWith('shot:') && k !== key.shot(tabId))
      .sort((x, y) => x[1].time - y[1].time);
    await sdel(shots.slice(0, Math.ceil(shots.length / 2) || 1).map(([k]) => k));
    await sset(entry);
  }
}

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
}

async function setBadge(tabId, level, text, title) {
  const l = LEVELS[level];
  await chrome.action.setBadgeBackgroundColor({ tabId, color: l.color });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
  }
  await chrome.action.setBadgeText({ tabId, text: text ?? l.text });
  await chrome.action.setTitle({ tabId, title: `Tabnabbing Detector\n${title}` });
}

// focus tracking

async function markAway(tabId) {
  if (tabId == null) return;
  await sset({ [key.away(tabId)]: true });
}

async function activeTabOf(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  return tab;
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const prev = await sget(key.active(windowId));
  await sset({ [key.active(windowId)]: tabId });
  if (prev != null && prev !== tabId) await markAway(prev);
  checkOnReturn(tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const prev = await sget('focusedWindow');
  await sset({ focusedWindow: windowId });
  if (prev != null && prev !== NONE && prev !== windowId) {
    const tab = await activeTabOf(prev);
    if (tab) await markAway(tab.id);
  }
  if (windowId !== NONE) {
    const tab = await activeTabOf(windowId);
    if (tab) {
      await sset({ [key.active(windowId)]: tab.id });
      checkOnReturn(tab.id);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queues.delete(tabId);
  sdel([key.shot(tabId), key.away(tabId)]);
});

async function init() {
  try {
    const win = await chrome.windows.getLastFocused();
    if ((await sget('focusedWindow')) == null) {
      await sset({ focusedWindow: win.focused ? win.id : NONE });
    }
    for (const tab of await chrome.tabs.query({ active: true })) {
      if ((await sget(key.active(tab.windowId))) == null) {
        await sset({ [key.active(tab.windowId)]: tab.id });
      }
    }
  } catch { /* no windows yet */ }
}
init();

// step 1: periodic screenshots

function onTick(tabId) {
  return enqueue(tabId, async () => {
    if (await sget(key.away(tabId))) return; // keep the screenshot from before the user left
    const tab = await visibleTab(tabId);
    if (!tab) return;
    const dataUrl = await capture(tab.windowId);
    // The user may have switched away while captured (check again before storing)
    if (!(await visibleTab(tabId)) || (await sget(key.away(tabId)))) return;
    await storeShot(tabId, dataUrl);
    // A successful capture proves this is the window's active tab
    // Record it to mark it "away" when the user switches to another tab
    await sset({ [key.active(tab.windowId)]: tabId });
  });
}

// steps 3 and 4: compare when the user comes back

function checkOnReturn(tabId) {
  return enqueue(tabId, async () => {
    if (!(await sget(key.away(tabId)))) return;
    await sleep(RETURN_SETTLE_MS);
    const tab = await visibleTab(tabId);
    if (!tab) return; // still not looking at it

    const before = await sget(key.shot(tabId));
    if (!before) { await sdel(key.away(tabId)); return; }

    await sendToTab(tabId, { type: 'prepare' }); // remove the overlay before capturing
    const after = await capture(tab.windowId);
    if (!(await visibleTab(tabId))) return;
    await sdel(key.away(tabId));

    const result = await compareScreenshots(before.dataUrl, after);
    await storeShot(tabId, after); // the new view becomes the baseline

    if (!result.comparable) {
      await setBadge(tabId, 'unknown', null, 'Window size changed, so the tab could not be compared.');
      return;
    }

    const pct = Math.round(result.changedRatio * 100);
    const away = Math.round((Date.now() - before.time) / 1000);
    if (result.cells.length === 0) {
      await setBadge(tabId, 'same', null, `No changes since you left (${away}s ago).`);
    } else {
      const level = result.changedRatio > MAJOR_RATIO ? 'major' : 'minor';
      const text = pct < 1 ? '<1%' : `${pct}%`;
      await setBadge(tabId, level, text,
        `${text} of the visible page changed while you were away. ` +
        (level === 'major' ? 'Possible tabnabbing: check the address bar before logging in.' : ''));
    }
    await sendToTab(tabId, {
      type: 'result',
      cells: result.cells,
      changedRatio: result.changedRatio,
      major: result.changedRatio > MAJOR_RATIO
    });
  });
}

// messages from content scripts

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || sender.frameId !== 0) return;
  if (msg && msg.type === 'tick') onTick(tabId);
});
