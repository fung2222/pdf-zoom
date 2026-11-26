import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const stage = document.getElementById('stage');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { alpha: true });
const emptyEl = document.getElementById('empty');
const spinner = document.getElementById('spinner');
const badge = document.getElementById('badge');
const dropEl = document.getElementById('drop');
const topEl = document.getElementById('top');
const bottomEl = document.getElementById('bottom');
const pgLabel = document.getElementById('pgLabel');
const zoomLabel = document.getElementById('zoomLabel');
const fitBtn = document.getElementById('fitBtn');
const fileInput = document.getElementById('file');

const MAX_SCALE = 30;          // 30 CSS px per PDF point ≈ 3000% print — plenty for site drawings
const DPR = () => Math.min(window.devicePixelRatio || 1, 3);

let pdf = null;
let documentGeneration = 0;
let pageRequestId = 0;
let renderGeneration = 0;
let pageNum = 1;
let pageCount = 0;
let page = null;

let s = 1, tx = 0, ty = 0;              // s = CSS px per pt; tx/ty = page offset of viewport (CSS px)
let rendered = { s: 1, tx: 0, ty: 0, page: 0 };
let cw = 0, ch = 0;
let fitScale = 1;

let renderTask = null;
let rafPending = false;
let gestureActive = false;
let lastFile = null;

/* ---------------- sizing ---------------- */

function resize() {
  cw = stage.clientWidth || window.innerWidth;
  ch = stage.clientHeight || window.innerHeight;
  const dpr = DPR();
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  if (page) { clampView(); render(); }
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 220));

/* ---------------- view maths ---------------- */

function pageSize() {
  const v = page.view;               // [x0,y0,x1,y1]
  return { w: v[2] - v[0], h: v[3] - v[1] };
}

function clampView() {
  const { w, h } = pageSize();
  const contentW = w * s, contentH = h * s;
  const loX = Math.min(0, contentW - cw), hiX = Math.max(0, contentW - cw);
  const loY = Math.min(0, contentH - ch), hiY = Math.max(0, contentH - ch);
  tx = Math.min(hiX, Math.max(loX, tx));
  ty = Math.min(hiY, Math.max(loY, ty));
}

function fitWidth(keepY = false) {
  const { w } = pageSize();
  fitScale = cw / w;
  s = fitScale;
  tx = 0;
  if (!keepY) {
    const { h } = pageSize();
    ty = Math.min(0, Math.max(0, (h * s - ch) / 2));
  }
  clampView();
}

function zoomAt(clientX, clientY, factor) {
  const ns = Math.min(MAX_SCALE, Math.max(fitScale * 0.8, s * factor));
  const k = ns / s;
  tx = (tx + clientX) * k - clientX;
  ty = (ty + clientY) * k - clientY;
  s = ns;
  clampView();
}

function zoomTo(nextS, clientX = cw / 2, clientY = ch / 2) {
  zoomAt(clientX, clientY, nextS / s);
}

/* ---------------- rendering: overscan frames + atomic swap ---------------- */

const MAX_PIXELS = 6.2e6;   // device-pixel budget for one rendered frame
const RATIO_CAP = 2;        // above 2x device pixels extra work is invisible
const OVERSCAN = 1.7;       // render this much bigger than the viewport so panning needs no reload
const CACHE_MAX = 3;
const PREVIEW_MAX = 3;
const MAX_PREVIEW_PIXELS = 1.2e6;

// frame = { cv, s, dpr, page, x0, y0, w, h }   (x0/y0/w/h in PDF points)
const frameCache = new Map();
const previewCache = new Map();
let stageCv = null, stageCtx = null;

function releaseFrame(frame) {
  if (!frame || !frame.cv) return;
  try { frame.cv.width = 0; frame.cv.height = 0; } catch {}
}

function clearRenderCaches() {
  for (const frame of frameCache.values()) releaseFrame(frame);
  for (const frame of previewCache.values()) releaseFrame(frame);
  frameCache.clear();
  previewCache.clear();
  if (stageCv) { stageCv.width = 0; stageCv.height = 0; }
  if (canvas) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.transform = 'none';
  }
}

function cancelHiRender() {
  clearTimeout(hiTimer);
  renderGeneration++;
  if (renderTask) {
    try { renderTask.cancel(); } catch {}
    renderTask = null;
  }
}
let hiTimer = null;
let lastRenderMs = 0;

function hiDpr() {
  let d = Math.min(DPR(), RATIO_CAP);
  if (cw * ch * d * d > MAX_PIXELS) d = Math.sqrt(MAX_PIXELS / (cw * ch));
  return Math.max(1, d);
}

function viewPts() {
  return { x0: tx / s, y0: ty / s, w: cw / s, h: ch / s };
}

function covers(f, v, tol = 1) {
  return v.x0 >= f.x0 - tol && v.y0 >= f.y0 - tol &&
         v.x0 + v.w <= f.x0 + f.w + tol && v.y0 + v.h <= f.y0 + f.h + tol;
}

function applyTransient() {
  // last-resort gesture feedback when no cached frame covers the view
  const k = s / rendered.s;
  const dx = rendered.tx * k - tx;
  const dy = rendered.ty * k - ty;
  canvas.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
}

function ensureCanvas(dpr) {
  const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
}

function ensureStage(w, h) {
  if (!stageCv) {
    stageCv = document.createElement('canvas');
    stageCtx = stageCv.getContext('2d', { alpha: true });
  }
  if (stageCv.width !== w || stageCv.height !== h) { stageCv.width = w; stageCv.height = h; }
  return stageCtx;
}

function cachePut(map, key, frame, max) {
  const previous = map.get(key);
  if (previous && previous !== frame) releaseFrame(previous);
  map.delete(key);
  map.set(key, frame);
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    const oldest = map.get(oldestKey);
    map.delete(oldestKey);
    releaseFrame(oldest);
  }
}

/* --- paint whatever is cached for this view (instant, no re-render) --- */

function bestFrame() {
  const v = viewPts();
  let best = null, bestScore = -1;
  for (const f of frameCache.values()) {
    if (f.page !== pageNum || !covers(f, v)) continue;
    const sharp = Math.min(f.s / s, 1);
    const score = sharp * 1000 - Math.abs(Math.log(f.s / s)) * 20;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  if (best) return best;
  const p = previewCache.get(pageNum);
  if (p && covers(p, v)) return p;
  return null;
}

function blitFrame(f) {
  const v = viewPts();
  const sx = (v.x0 - f.x0) * f.s * f.dpr;
  const sy = (v.y0 - f.y0) * f.s * f.dpr;
  const sw = v.w * f.s * f.dpr;
  const sh = v.h * f.s * f.dpr;
  ensureCanvas(f.dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(f.cv, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  rendered = { s, tx, ty, page: pageNum };
  canvas.style.transform = 'none';
}

/* --- low-res whole-page preview (page flips, far pans) --- */

async function ensurePreview(n) {
  if (previewCache.has(n)) return previewCache.get(n);
  const doc = pdf;
  const generation = documentGeneration;
  const wasCurrentPage = n === pageNum;
  const currentPageRef = wasCurrentPage ? page : null;
  let p;
  try { p = wasCurrentPage ? currentPageRef : await doc.getPage(n); } catch { return null; }
  if (!doc || doc !== pdf || generation !== documentGeneration ||
      (wasCurrentPage && (pageNum !== n || page !== currentPageRef))) return null;
  const pw = p.view[2] - p.view[0], ph = p.view[3] - p.view[1];
  const targetWidth = Math.min(1000, Math.max(640, cw * 1.2));
  const ps = Math.min(targetWidth / pw, Math.sqrt(MAX_PREVIEW_PIXELS / (pw * ph)));
  const vp = p.getViewport({ scale: ps });
  const off = document.createElement('canvas');
  off.width = Math.round(vp.width);
  off.height = Math.round(vp.height);
  try {
    await p.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
  } catch (err) {
    off.width = 0; off.height = 0;
    throw err;
  }
  if (doc !== pdf || generation !== documentGeneration ||
      (wasCurrentPage && (pageNum !== n || page !== currentPageRef))) {
    off.width = 0; off.height = 0;
    return null;
  }
  const frame = { cv: off, s: ps, dpr: 1, page: n, x0: 0, y0: 0, w: pw, h: ph };
  cachePut(previewCache, n, frame, PREVIEW_MAX);
  return frame;
}

let primeGeneration = 0;
function primeNeighbours() {
  if (gestureActive || !pdf) return;
  const jobs = [pageNum + 1, pageNum - 1, pageNum + 2]
    .filter((n) => n >= 1 && n <= pageCount && !previewCache.has(n));
  if (!jobs.length) return;
  const generation = documentGeneration;
  const primeId = ++primeGeneration;
  const run = async () => {
    for (const n of jobs) {
      if (generation !== documentGeneration || primeId !== primeGeneration || gestureActive) return;
      try { await ensurePreview(n); } catch {}
    }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 }); else setTimeout(run, 300);
}

/* --- hi-res render of an overscanned region, swapped in atomically --- */

async function renderHi() {
  if (!page || gestureActive) return;
  if (renderTask) { try { renderTask.cancel(); } catch {} }
  renderTask = null;
  const generation = documentGeneration;
  const renderId = ++renderGeneration;
  const pageRef = page;

  const dpr = hiDpr();
  const pw = page.view[2] - page.view[0], ph = page.view[3] - page.view[1];
  const v = viewPts();
  const sWant = s, txWant = tx, tyWant = ty, pageWant = pageNum;

  // region to render: overscan around the viewport, clamped to the page and to the pixel budget
  let fw = Math.min(pw, v.w * OVERSCAN);
  let fh = Math.min(ph, v.h * OVERSCAN);
  const maxAreaPt = MAX_PIXELS / (sWant * sWant * dpr * dpr);
  if (fw * fh > maxAreaPt) {
    const k = Math.sqrt(maxAreaPt / (fw * fh));
    fw = Math.max(v.w, fw * k);
    fh = Math.max(v.h, fh * k);
  }
  let fx0 = v.x0 - (fw - v.w) / 2;
  let fy0 = v.y0 - (fh - v.h) / 2;
  fx0 = Math.max(0, Math.min(pw - fw, fx0));
  fy0 = Math.max(0, Math.min(ph - fh, fy0));
  if (fx0 > v.x0) { fx0 = v.x0; fw = Math.min(pw, fw + (v.x0 - fx0)); }
  if (fy0 > v.y0) { fy0 = v.y0; fh = Math.min(ph, fh + (v.y0 - fy0)); }

  const wPx = Math.max(1, Math.round(fw * sWant * dpr));
  const hPx = Math.max(1, Math.round(fh * sWant * dpr));
  const sc = ensureStage(wPx, hPx);
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.clearRect(0, 0, wPx, hPx);

  const viewport = page.getViewport({ scale: sWant * dpr });
  const task = page.render({
    canvasContext: sc,
    viewport,
    transform: [1, 0, 0, 1, -fx0 * sWant * dpr, -fy0 * sWant * dpr],
    intent: 'display',
  });
  renderTask = task;
  const t0 = performance.now();
  try {
    await task.promise;
    if (generation !== documentGeneration || renderId !== renderGeneration ||
        pageRef !== page || pageWant !== pageNum || gestureActive) return;
    lastRenderMs = performance.now() - t0;

    // atomic swap: the on-screen canvas is never cleared while painting
    ensureCanvas(dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sx = (v.x0 - fx0) * sWant * dpr;
    const sy = (v.y0 - fy0) * sWant * dpr;
    ctx.drawImage(stageCv, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    rendered = { s: sWant, tx: txWant, ty: tyWant, page: pageWant };
    canvas.style.transform = 'none';

    const off = document.createElement('canvas');
    off.width = wPx; off.height = hPx;
    off.getContext('2d').drawImage(stageCv, 0, 0);
    cachePut(frameCache, `${pageWant}@${sWant.toFixed(3)}@${Math.round(fx0)},${Math.round(fy0)}`,
      { cv: off, s: sWant, dpr, page: pageWant, x0: fx0, y0: fy0, w: fw, h: fh }, CACHE_MAX);

    updateHud();
    primeNeighbours();
    scheduleSnap();
    saveLastPos(pageWant);
  } catch (err) {
    if (err && err.name !== 'RenderingCancelledException') console.warn(err);
  } finally {
    if (renderTask === task) renderTask = null;
  }
}

/* --- public render: paint from cache; only re-render when truly needed --- */

let panRaf = false;
function schedulePaint() {
  // During a gesture, let the browser compositor transform the last painted
  // canvas. Avoid repeated drawImage/clearRect work on every pointer frame.
  if (panRaf) return;
  panRaf = true;
  requestAnimationFrame(() => {
    panRaf = false;
    applyTransient();
  });
}

async function render({ immediate = false } = {}) {
  if (!page) return;
  rafPending = false;
  if (gestureActive) {
    schedulePaint();
    return;
  }

  const generation = documentGeneration;
  const pageWant = pageNum;
  const f = bestFrame();
  if (f) {
    const sharpEnough = Math.abs(f.s - s) < 1e-9 && f.dpr >= hiDpr() * 0.98;
    blitFrame(f);
    updateHud();
    if (sharpEnough) { primeNeighbours(); return; }   // panning inside an overscan frame: zero work
  }

  clearTimeout(hiTimer);
  // A short idle window coalesces several quick pinch/pan adjustments
  // into one raster pass instead of repeatedly starting expensive renders.
  hiTimer = setTimeout(() => {
    if (!gestureActive && generation === documentGeneration && pageWant === pageNum) renderHi();
  }, f ? 110 : 70);
}

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

/* ---------------- hud ---------------- */

let hudTimer = null, chromeTimer = null, lastFlash = 0, zoomTimer = null;
function updateHud() {
  if (!pdf) return;
  pgLabel.textContent = `${pageNum} / ${pageCount}`;
  const pct = Math.round((s / fitScale) * 100);
  zoomLabel.textContent = pct + '%';
  badge.hidden = true;
}

function flashZoom() {
  const now = performance.now();
  if (now - lastFlash < 90) { debouncedZoomLabel(); return; }   // don't thrash the DOM mid-pinch
  lastFlash = now;
  const pct = Math.round((s / fitScale) * 100);
  badge.textContent = pct + '%';
  badge.hidden = false;
  zoomLabel.textContent = pct + '%';
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { badge.hidden = true; }, 900);
}

function debouncedZoomLabel() {
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    zoomLabel.textContent = Math.round((s / fitScale) * 100) + '%';
  }, 120);
}

function showChrome() {
  document.body.classList.remove('hide-chrome');
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => {
    if (pdf && !gestureActive) document.body.classList.add('hide-chrome');
  }, 3200);
}

/* ---------------- gestures ---------------- */

const pointers = new Map();
let dragStart = null, pinchStart = null;
let tapInfo = { t: 0, x: 0, y: 0 };
let moved = 0;

stage.addEventListener('pointerdown', (e) => {
  if (!pdf) return;
  if (pointers.size === 0) cancelHiRender();
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gestureActive = true;
  moved = 0;
  document.body.classList.remove('hide-chrome');

  if (pointers.size === 1) {
    dragStart = { x: e.clientX, y: e.clientY, tx, ty };
    pinchStart = null;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      s, tx, ty,
    };
    dragStart = null;
  }
});

stage.addEventListener('pointermove', (e) => {
  if (!pdf || !pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1 && dragStart) {
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    moved = Math.max(moved, Math.hypot(dx, dy));
    tx = dragStart.tx - dx;
    ty = dragStart.ty - dy;
    clampView();
    schedulePaint();
  } else if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    moved = 99;
    const factor = dist / Math.max(12, pinchStart.dist);
    // rebuild from gesture start so pinch feels stable
    tx = pinchStart.tx; ty = pinchStart.ty; s = pinchStart.s;
    const ns = Math.min(MAX_SCALE, Math.max(fitScale * 0.8, pinchStart.s * factor));
    const k = ns / s;
    tx = (tx + pinchStart.cx) * k - cx;
    ty = (ty + pinchStart.cy) * k - cy;
    s = ns;
    clampView();
    schedulePaint();
    flashZoom();
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);

  if (pointers.size === 1) {
    const [p] = [...pointers.values()];
    dragStart = { x: p.x, y: p.y, tx, ty };
    pinchStart = null;
  }
  if (pointers.size === 0) {
    gestureActive = false;
    dragStart = null;
    pinchStart = null;
    const isTap = moved < 7 && lastFile !== null;
    if (isTap) {
      const now = Date.now();
      const dbl = now - tapInfo.t < 320 && Math.hypot(e.clientX - tapInfo.x, e.clientY - tapInfo.y) < 40;
      if (dbl) {
        tapInfo.t = 0;
        const zoomedIn = s > fitScale * 1.9;
        if (zoomedIn) { fitWidth(); render(); } else { zoomAt(e.clientX, e.clientY, 2.6); render(); }
        flashZoom();
        return;
      }
      tapInfo = { t: now, x: e.clientX, y: e.clientY };
      // single tap toggles chrome
      document.body.classList.toggle('hide-chrome');
      showChrome();
    }
    render();
    showChrome();
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

stage.addEventListener('wheel', (e) => {
  if (!pdf) return;
  e.preventDefault();
  if (e.ctrlKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0035));
    flashZoom();
  } else {
    tx += e.deltaX; ty += e.deltaY; clampView();
  }
  scheduleRender();
}, { passive: false });

/* ---------------- open pdf ---------------- */

async function openPdf(data, name) {
  const openId = ++documentGeneration;
  pageRequestId++;
  primeGeneration++;
  cancelHiRender();
  spinner.hidden = false;
  emptyEl.hidden = true;
  // pdf.js TRANSFERS the buffer to its worker, so keep a copy for IndexedDB first
  const keep = data.slice(0);
  try {
    const doc = await pdfjsLib.getDocument({
      data,
      cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
    }).promise;
    if (openId !== documentGeneration) {
      try { await doc.destroy(); } catch {}
      return;
    }
    const oldPdf = pdf;
    pdf = doc;
    page = null;
    clearRenderCaches();
    if (oldPdf && oldPdf !== doc) { try { await oldPdf.destroy(); } catch {} }
    pageCount = doc.numPages;
    pageNum = 1;
    await loadPage(1, { keepView: false });
    topEl.hidden = false; bottomEl.hidden = false;
    pgLabel.hidden = false; fitBtn.hidden = false;
    lastFile = { name: name || 'document.pdf' };
    if (typeof refreshInstallUI === 'function') refreshInstallUI();
    await saveLast(keep, lastFile.name);
    showChrome();
  } catch (err) {
    if (openId === documentGeneration) {
      console.error(err);
      alert('開唔到呢個 PDF：' + (err && err.message ? err.message : err));
      emptyEl.hidden = false;
    }
  } finally {
    if (openId === documentGeneration) spinner.hidden = true;
  }
}

async function loadPage(n, { keepView = true } = {}) {
  if (!pdf || n < 1 || n > pageCount) return;
  const doc = pdf;
  const generation = documentGeneration;
  const requestId = ++pageRequestId;
  primeGeneration++;
  cancelHiRender();
  let nextPage;
  try { nextPage = await doc.getPage(n); } catch (err) {
    if (requestId === pageRequestId) console.warn('page load failed', err);
    return;
  }
  if (doc !== pdf || generation !== documentGeneration || requestId !== pageRequestId) return;
  page = nextPage;
  pageNum = n;
  if (!keepView) { fitWidth(); }
  else { fitWidth(true); }
  let prev = previewCache.get(n);
  if (!prev) {
    // Paint a lightweight whole-page preview first; refine it to full quality
    // after the page is already visible.
    try { prev = await ensurePreview(n); } catch {}
    if (doc !== pdf || generation !== documentGeneration || requestId !== pageRequestId) return;
  }
  if (prev) { blitFrame(prev); updateHud(); }
  await render({ immediate: !prev });
  saveLastPos(n);
}

function nextPage() {
  if (!pdf || pageNum >= pageCount) return;
  loadPage(pageNum + 1);
}
function prevPage() {
  if (!pdf || pageNum <= 1) return;
  loadPage(pageNum - 1);
}

/* ---------------- files ---------------- */

async function handleFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.name || '') && file.type !== 'application/pdf') {
    alert('只支援 PDF 檔案');
    return;
  }
  const buf = await file.arrayBuffer();
  await openPdf(new Uint8Array(buf), file.name);
}

fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  fileInput.value = '';
  handleFile(f);
});

document.getElementById('openBtn').addEventListener('click', () => fileInput.click());
document.getElementById('pick').addEventListener('click', () => fileInput.click());
document.getElementById('next').addEventListener('click', nextPage);
document.getElementById('prev').addEventListener('click', prevPage);
document.getElementById('zoomIn').addEventListener('click', () => { zoomAt(cw / 2, ch / 2, 1.5); render(); flashZoom(); });
document.getElementById('zoomOut').addEventListener('click', () => { zoomAt(cw / 2, ch / 2, 1 / 1.5); render(); flashZoom(); });
fitBtn.addEventListener('click', () => { fitWidth(); render(); flashZoom(); });

window.addEventListener('keydown', (e) => {
  if (!pdf) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') nextPage();
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') prevPage();
  if (e.key === '+' || e.key === '=') { zoomAt(cw / 2, ch / 2, 1.4); render(); }
  if (e.key === '-') { zoomAt(cw / 2, ch / 2, 1 / 1.4); render(); }
  if (e.key === '0') { fitWidth(); render(); }
});

/* ---------------- install to home screen ---------------- */

const installFab = document.getElementById('installFab');
const sheet = document.getElementById('sheet');
const sheetTitle = document.getElementById('sheetTitle');
const sheetSteps = document.getElementById('sheetSteps');
const sheetClose = document.getElementById('sheetClose');

let deferredPrompt = null;

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches ||
  window.navigator.standalone === true;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const installInline = document.getElementById('installInline');

function refreshInstallUI() {
  const standalone = isStandalone();
  const emptyShown = !emptyEl.hidden;
  installFab.hidden = standalone || emptyShown;      // floating pill only while reading
  installInline.hidden = standalone || !emptyShown;  // inline link on the empty screen
}

function showInstallPill() {
  refreshInstallUI();
}

function manualSteps() {
  if (isIOS()) {
    return { title: '加到主畫面（iPhone）', steps: [
      '撳下面 Safari 個「分享」圖示（正方框＋向上箭頭）',
      '揀「加入主畫面」',
      '右上撳「加入」',
      '主畫面就會出現 PDF 圖示',
    ] };
  }
  return { title: '加到主畫面（Android）', steps: [
    '要喺 Chrome 開呢個網頁（唔好用 Telegram／IG 內建瀏覽器）',
    '撳 Chrome 右上 ⋮',
    '揀「安裝應用程式」（舊版叫「加到主畫面」）',
    '再撳「安裝」',
  ] };
}

function openSheet() {
  const m = manualSteps();
  sheetTitle.textContent = m.title;
  sheetSteps.innerHTML = m.steps.map((s) => `<li>${s}</li>`).join('');
  sheet.hidden = false;
}
sheetClose.addEventListener('click', () => { sheet.hidden = true; showChrome(); });
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallPill();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  installFab.hidden = true;
  sheet.hidden = true;
});

async function handleInstallClick() {
  if (deferredPrompt) {
    try {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (choice && choice.outcome === 'accepted') { installFab.hidden = true; installInline.hidden = true; }
      refreshInstallUI();
      return;
    } catch (err) { /* fall through to instructions */ }
  }
  openSheet();
}

installFab.addEventListener('click', handleInstallClick);
installInline.addEventListener('click', handleInstallClick);

/* debug/automation hook (harmless in production) */
window.__pz = {
  state: () => ({ s, tx, ty, fitScale, pageNum, pageCount, cw, ch }),
  pan: (dx, dy) => { tx -= dx; ty -= dy; clampView(); render(); },
  zoomAt, fit: () => { fitWidth(); render(); }, nextPage, prevPage,
  install: { hasPrompt: () => !!deferredPrompt, fab: () => !installFab.hidden, standalone: isStandalone, sheet: () => openSheet() },
  perf: () => ({ lastRenderMs: Math.round(lastRenderMs), frames: frameCache.size, previews: previewCache.size, hiDpr: +hiDpr().toFixed(2) }),
  zoom: (f) => { zoomAt(cw / 2, ch / 2, f); render(); },
  zoomTo: (target) => { zoomTo(target); render(); },

  prime: () => primeNeighbours(),
  dbg: { renderHi, render, bestFrame, page: () => page, previews: () => [...previewCache.keys()], frames: () => [...frameCache.keys()] },
};

/* drag & drop (desktop) */
['dragenter', 'dragover'].forEach((ev) =>
  stage.addEventListener(ev, (e) => { e.preventDefault(); dropEl.hidden = false; }));
['dragleave', 'drop'].forEach((ev) =>
  stage.addEventListener(ev, (e) => { e.preventDefault(); dropEl.hidden = true; }));
stage.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

/* ---------------- tiny idb ---------------- */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pdf-zoom', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveLast(data, name) {
  try {
    const db = await idb();
    const tx2 = db.transaction('kv', 'readwrite');
    tx2.objectStore('kv').put({ name, blob: new Blob([data], { type: 'application/pdf' }), page: 1 }, 'last');
  } catch (e) { /* private mode etc. */ }
}

let posTimer = null;
function saveLastPos(n) {
  clearTimeout(posTimer);
  posTimer = setTimeout(async () => {
    try {
      const db = await idb();
      const tx2 = db.transaction('kv', 'readwrite');
      const store = tx2.objectStore('kv');
      const req = store.get('last');
      req.onsuccess = () => {
        const v = req.result;
        if (!v) return;
        const { w, h } = pageSize();
        v.page = n;
        v.view = {
          z: fitScale ? s / fitScale : 1,
          fx: w * s ? (tx + cw / 2) / (w * s) : 0.5,
          fy: h * s ? (ty + ch / 2) / (h * s) : 0.5,
        };
        store.put(v, 'last');
      };
    } catch (e) { /* ignore */ }
  }, 350);
}

function applySavedView(view) {
  if (!view || !view.z) return;
  const { w, h } = pageSize();
  s = Math.min(MAX_SCALE, Math.max(fitScale, fitScale * view.z));
  tx = (view.fx || 0.5) * w * s - cw / 2;
  ty = (view.fy || 0.5) * h * s - ch / 2;
  clampView();
}

async function restoreLast() {
  try {
    const db = await idb();
    const req = db.transaction('kv', 'readonly').objectStore('kv').get('last');
    const val = await new Promise((res) => { req.onsuccess = () => res(req.result); req.onerror = () => res(null); });
    if (!val || !val.blob || !val.blob.size) return false;
    const buf = await val.blob.arrayBuffer();
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
    }).promise;
    pdf = doc; pageCount = doc.numPages; pageNum = Math.min(val.page || 1, pageCount);
    page = await pdf.getPage(pageNum);
    cw = stage.clientWidth; ch = stage.clientHeight;
    const dpr = DPR();
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    fitWidth();
    applySavedView(val.view);
    topEl.hidden = false; bottomEl.hidden = false; pgLabel.hidden = false; fitBtn.hidden = false;
    emptyEl.hidden = true;
    lastFile = { name: val.name };
    await render();
    if (typeof refreshInstallUI === 'function') refreshInstallUI();
    showChrome();
    return true;
  } catch (e) {
    console.warn('restore failed', e);
    return false;
  }
}

/* ---------------- instant first paint (snapshot) ---------------- */

async function idbGet(key) {
  try {
    const db = await idb();
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    return await new Promise((res) => { req.onsuccess = () => res(req.result || null); req.onerror = () => res(null); });
  } catch { return null; }
}

async function idbPut(key, value) {
  try {
    const db = await idb();
    db.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
  } catch { /* ignore */ }
}

let snapTimer = null;
function scheduleSnap() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(saveSnap, 700);
}

async function saveSnap() {
  if (!pdf || !page) return;
  try {
    const w = 660, h = Math.max(1, Math.round(w * ch / cw));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(canvas, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.72));
    if (!blob) return;
    await idbPut('snap', { blob, page: pageNum, s, tx, ty, ratio: s / fitScale });
  } catch { /* ignore */ }
}

async function showSnapFirst() {
  const rec = await idbGet('snap');
  if (!rec || !rec.blob) return false;
  try {
    const bmp = await createImageBitmap(rec.blob);
    const dpr = hiDpr();
    ensureCanvas(dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    canvas.style.transform = 'none';
    rendered = { s: rec.s || 1, tx: rec.tx || 0, ty: rec.ty || 0, page: rec.page || 1 };
    emptyEl.hidden = true;
    topEl.hidden = false; bottomEl.hidden = false;
    pgLabel.hidden = false; fitBtn.hidden = false;
    pgLabel.textContent = `${rec.page || 1} / …`;
    return true;
  } catch { return false; }
}

/* ---------------- share target ---------------- */

async function tryShared() {
  if (!new URLSearchParams(location.search).has('shared')) return false;
  try {
    if (!('caches' in window)) return false;
    const cache = await caches.open('pdf-zoom-shared');
    const res = await cache.match('/__shared__');
    if (!res) return false;
    const blob = await res.blob();
    const name = res.headers.get('x-filename') || 'shared.pdf';
    await cache.delete('/__shared__');
    const buf = await blob.arrayBuffer();
    await openPdf(new Uint8Array(buf), name);
    return true;
  } catch (e) {
    console.warn('share failed', e);
    return false;
  }
}

/* ---------------- boot ---------------- */

(async function boot() {
  resize();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || refreshing) return;   // don't reload on first install
      refreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js')
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  }
  const shared = await tryShared();
  if (shared) return;
  const qs = new URLSearchParams(location.search);
  const urlFile = qs.get('file');
  if (urlFile) {
    try {
      const r = await fetch(urlFile);
      if (r.ok) {
        const buf = await r.arrayBuffer();
        await openPdf(new Uint8Array(buf), decodeURIComponent(urlFile.split('/').pop()));
        return;
      }
    } catch (e) { console.warn('url open failed', e); }
  }
  await showSnapFirst();          // instant picture while the file is read
  const ok = await restoreLast();
  if (!ok && emptyEl.hidden === false) emptyEl.hidden = false;
  // always give an install entry point (native prompt when available, steps otherwise)
  setTimeout(() => { showInstallPill(); }, 700);
})();
