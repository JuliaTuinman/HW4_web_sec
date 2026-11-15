# Tabnabbing Detector 

## Quickstart

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Navigate to this folder in terminal (the one with manifest.json)
4. run `python3 -m http.server 8000`
5. Navigate to `http://localhost:8000/tabnab.html` on Chrome  for a couple seconds, switch to another tab for 3+ seconds, then switch back. Extension should show **red** badge (and warning banner) and red squares over changed content on page. 
6. Naviage to `http://localhost:8000/benign.html` which should give **green** badge 
7. Navigate to `http://localhost:8000/clock.html` and then switch to another tab for 3+ seconds, then come back. Extension should display a **yellow** badge (and warning banner) with yellow squares over just the area on the clock (what changed on the page).

### Comparison algorithm (`diff.js`)

My own implementation of the "split the page into squares" approach:

1. Decode both screenshots and scale them to at most 1024 px wide.
2. Split the image into 32×32 cells.
3. A pixel is *different* if `|delta R| + |detla G| + |delta B| > 48`. This tolerance ignores JPEG noise and tiny shifts in colour.
4. A cell is *changed* if more than 2% of its pixels are different.
5. Cells are returned as fractions of the image (0..1), so the content script can map them onto the viewport whatever the device pixel ratio. Highlights are placed in document coordinates, so they stay on the changed content when you scroll.

### Badge color code

* green, `OK`: nothing changed while user navigated away
* yellow `n%`: up to 10% of visible page changed (clock page)
* red `n%`: more than 10% of page changed (possilbe tabnabbing)
* grey `?`: the wind was resized so screenshots can't be compared

## Permissions (minimal)

* `host_permissions:["<all_urls>"]`
  - `chrome.tabs.captureVisibleTab` needs `<all_urls>` or `activeTab`
  - `activeTab` only lasts until a user gesture on the extension, and here screenshots must be taken without any click
  - Chrome checks for the literal `<all_urls>` patter, so `http://*/*` and `https://*/*` are not enough
* `storage`
  - `chrome.storage.session` keeps the last screenshot of each tab when the MV3 service worker is shut down while you are on another tab
  - Only trusted extension contexts can read it, never the page

## Claude Disclaimer
I only used Claude to help me create the icons to use for the extension display and gathering the color codes to use.