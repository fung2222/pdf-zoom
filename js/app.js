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
let primeGeneration = 0;
let lastRenderMs = 0;
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

/* ---------------- rendering: cached PDF tiles ---------------- */

const TILE_SIZE = 512;                 // CSS pixels per tile at its render scale
const TILE_CACHE_BYTES = 64 * 1024 * 1024;
const TILE_CONCURRENCY = 2;
const MAX_PREVIEW_PIXELS = 1.2e6;
const previewCache = new Map();
const tileCache = new Map();
let tileBytes = 0;
let tileLayer = document.createElement('div');
tileLayer.id = 'tileLayer';
tileLayer.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none;transform-origin:0 0;will-change:transform;z-index:1;';
stage.insertBefore(tileLayer, canvas.nextSibling);

let activeTileTasks = new Set();
let activeTileKeys = new Set();
let tileQueue = [];
let tileWorkers = 0;
let wantedTileKeys = new Set();
let currentTileBucket = 0;
let currentTileDpr = 1;
let tileEpoch = 0;

function releaseFrame(frame) {
  if (!frame || !frame.cv) return;
  try { frame.cv.width = 0; frame.cv.height = 0; } catch {}
}

function clearRenderCaches() {
  for (const frame of previewCache.values()) releaseFrame(frame);
  previewCache.clear();
  for (const tile of tileCache.values()) releaseTile(tile);
  tileCache.clear();
  tileBytes = 0;
  tileQueue = [];
  wantedTileKeys.clear();
  tileEpoch++;
  tileLayer.replaceChildren();
  if (canvas) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.transform = 'none';
  }
}

function releaseTile(tile) {
  if (!tile || !tile.cv) return;
  tileBytes = Math.max(0, tileBytes - (tile.bytes || 0));
  try { tile.cv.width = 0; tile.cv.height = 0; } catch {}
}

function cancelHiRender() {
  clearTimeout(hiTimer);
  renderGeneration++;
  tileEpoch++;
  for (const task of activeTileTasks) {
    try { task.cancel(); } catch {}
  }
  activeTileTasks.clear();
  tileQueue = [];
}
let hiTimer = null;

function tileScale() {
  // Quantized scale avoids rerendering for tiny pinch fluctuations.
  return Math.pow(2, Math.round(Math.log2(Math.max(s, 0.001)) * 8) / 8);
}

function hiDpr() { return tileDpr(); }

function tileDpr() {
  return Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
}

function viewPts() {
  return { x0: tx / s, y0: ty / s, w: cw / s, h: ch / s };
}

function applyTransient() {
  const k = s / rendered.s;
  const dx = rendered.tx * k - tx;
  const dy = rendered.ty * k - ty;
  canvas.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
  tileLayer.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
}

function ensureCanvas(dpr) {
  const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
}

function cachePreview(n, frame) {
  const old = previewCache.get(n);
  if (old && old !== frame) releaseFrame(old);
  previewCache.delete(n);
  previewCache.set(n, frame);
  while (previewCache.size > 3) {
    const key = previewCache.keys().next().value;
    releaseFrame(previewCache.get(key));
    previewCache.delete(key);
  }
}

function cacheTile(key, tile) {
  const old = tileCache.get(key);
  if (old) releaseTile(old);
  tileCache.delete(key);
  tileCache.set(key, tile);
  tileBytes += tile.bytes;
  while (tileBytes > TILE_CACHE_BYTES && tileCache.size > 1) {
    const oldestKey = tileCache.keys().next().value;
    const oldest = tileCache.get(oldestKey);
    tileCache.delete(oldestKey);
    if (oldest.cv.parentNode) oldest.cv.remove();
    releaseTile(oldest);
  }
}

function touchTile(key, tile) {
  tileCache.delete(key);
  tileCache.set(key, tile);
}

function tileKey(pageNo, bucket, dpr, ix, iy) {
  return `${documentGeneration}:${pageNo}:${bucket.toFixed(4)}:${dpr}:${ix}:${iy}`;
}

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
  const vp1 = p.getViewport({ scale: 1 });
  const pw = vp1.width, ph = vp1.height;
  const targetWidth = Math.min(1000, Math.max(640, cw * 1.2));
  const ps = Math.min(targetWidth / pw, Math.sqrt(MAX_PREVIEW_PIXELS / (pw * ph)));
  const vp = p.getViewport({ scale: ps });
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(vp.width));
  off.height = Math.max(1, Math.round(vp.height));
  try {
    await p.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
  } catch (err) {
    off.width = 0; off.height = 0;
    if (err && err.name !== 'RenderingCancelledException') throw err;
    return null;
  }
  if (doc !== pdf || generation !== documentGeneration ||
      (wasCurrentPage && (pageNum !== n || page !== currentPageRef))) {
    off.width = 0; off.height = 0;
    return null;
  }
  const frame = { cv: off, s: ps, dpr: 1, page: n, x0: 0, y0: 0, w: pw, h: ph };
  cachePreview(n, frame);
  return frame;
}

function blitFrame(f) {
  ensureCanvas(1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const v = viewPts();
  const sx = v.x0 * f.s, sy = v.y0 * f.s;
  const sw = v.w * f.s, sh = v.h * f.s;
  ctx.drawImage(f.cv, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  rendered = { s, tx, ty, page: pageNum };
  canvas.style.transform = 'none';
}

function trimTileCache() {
  while (tileBytes > TILE_CACHE_BYTES && tileCache.size > 1) {
    const key = tileCache.keys().next().value;
    const tile = tileCache.get(key);
    tileCache.delete(key);
    if (tile.cv.parentNode) tile.cv.remove();
    releaseTile(tile);
  }
}

function paintWantedTiles() {
  const v = viewPts();
  const bucket = currentTileBucket;
  const dpr = currentTileDpr;
  const tilePageSize = TILE_SIZE / bucket;
  const maxX = Math.max(0, Math.ceil((page.getViewport({scale:1}).width * bucket) / TILE_SIZE) - 1);
  const maxY = Math.max(0, Math.ceil((page.getViewport({scale:1}).height * bucket) / TILE_SIZE) - 1);
  const x0 = Math.max(0, Math.floor(v.x0 / tilePageSize) - 1);
  const y0 = Math.max(0, Math.floor(v.y0 / tilePageSize) - 1);
  const x1 = Math.min(maxX, Math.floor((v.x0 + v.w) / tilePageSize) + 1);
  const y1 = Math.min(maxY, Math.floor((v.y0 + v.h) / tilePageSize) + 1);
  const desired = [];
  for (let iy=y0; iy<=y1; iy++) {
    for (let ix=x0; ix<=x1; ix++) {
      const key = tileKey(pageNum, bucket, dpr, ix, iy);
      desired.push({key, ix, iy, distance: Math.hypot((ix+.5)*tilePageSize-(v.x0+v.w/2), (iy+.5)*tilePageSize-(v.y0+v.h/2))});
    }
  }
  desired.sort((a,b)=>a.distance-b.distance);
  wantedTileKeys = new Set(desired.map(t=>t.key));
  tileLayer.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  const keep = new Set();
  for (const item of desired) {
    let tile = tileCache.get(item.key);
    if (tile) {
      touchTile(item.key, tile);
      tile.cv.style.display = '';
      if (tile.cv.parentNode !== tileLayer) tileLayer.appendChild(tile.cv);
      keep.add(item.key);
    } else {
      enqueueTile(item);
    }
  }
  for (const child of [...tileLayer.children]) {
    if (![...keep].some(key => tileCache.get(key)?.cv === child)) child.remove();
  }
  pumpTileQueue();
}

function enqueueTile(item) {
  if (tileQueue.some(job => job.key === item.key) || activeTileKeys.has(item.key) || tileCache.has(item.key)) return;
  tileQueue.push({...item, epoch: tileEpoch, generation: documentGeneration, pageNo: pageNum, bucket: currentTileBucket, dpr: currentTileDpr});
  tileQueue.sort((a,b)=>a.distance-b.distance);
}

function pumpTileQueue() {
  while (tileWorkers < TILE_CONCURRENCY && tileQueue.length) {
    const job = tileQueue.shift();
    if (job.generation !== documentGeneration || job.pageNo !== pageNum || job.epoch !== tileEpoch || !wantedTileKeys.has(job.key)) continue;
    tileWorkers++;
    renderTile(job).finally(() => {
      tileWorkers--;
      pumpTileQueue();
    });
  }
}

async function renderTile(job) {
  const doc = pdf, pageRef = page;
  if (!doc || !pageRef || job.generation !== documentGeneration) return;
  const viewport1 = pageRef.getViewport({scale:1});
  const tilePageSize = TILE_SIZE / job.bucket;
  const x0 = job.ix * tilePageSize, y0 = job.iy * tilePageSize;
  const w = Math.min(tilePageSize, viewport1.width - x0);
  const h = Math.min(tilePageSize, viewport1.height - y0);
  if (w <= 0 || h <= 0) return;
  const pixelW = Math.max(1, Math.ceil(w * job.bucket * job.dpr));
  const pixelH = Math.max(1, Math.ceil(h * job.bucket * job.dpr));
  const cv = document.createElement('canvas');
  cv.width = pixelW; cv.height = pixelH;
  cv.style.cssText = `position:absolute;left:${x0}px;top:${y0}px;width:${w}px;height:${h}px;max-width:none;max-height:none;`;
  const viewport = pageRef.getViewport({scale:job.bucket * job.dpr});
  activeTileKeys.add(job.key);
  const task = pageRef.render({
    canvasContext: cv.getContext('2d', {alpha:false}),
    viewport,
    transform: [1,0,0,1,-x0*job.bucket*job.dpr,-y0*job.bucket*job.dpr],
    intent: 'display',
  });
  activeTileTasks.add(task);
  try {
    await task.promise;
    if (doc !== pdf || pageRef !== page || job.generation !== documentGeneration || job.pageNo !== pageNum) {
      cv.width=0; cv.height=0; return;
    }
    const tile = {cv, bytes: pixelW*pixelH*4, key:job.key};
    cacheTile(job.key, tile);
    if (wantedTileKeys.has(job.key) && job.bucket === currentTileBucket && job.dpr === currentTileDpr) {
      tileLayer.appendChild(cv);
    }
  } catch (err) {
    cv.width=0; cv.height=0;
    if (err && err.name !== 'RenderingCancelledException') console.warn('Tile render failed', err);
  } finally {
    activeTileTasks.delete(task);
    activeTileKeys.delete(job.key);
  }
}

function schedulePaint() {
  if (panRaf) return;
  panRaf = true;
  requestAnimationFrame(() => {
    panRaf = false;
    applyTransient();
  });
}

async function render() {
  if (!page) return;
  rafPending = false;
  if (gestureActive) { schedulePaint(); return; }
  currentTileBucket = tileScale();
  currentTileDpr = tileDpr();
  paintWantedTiles();
  updateHud();
  saveLastPos(pageNum);
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

/* debug/automation hook (harmless in production) */
window.__pz = {
  state: () => ({ s, tx, ty, fitScale, pageNum, pageCount, cw, ch }),
  pan: (dx, dy) => { tx -= dx; ty -= dy; clampView(); render(); },
  zoomAt, fit: () => { fitWidth(); render(); }, nextPage, prevPage,
  install: { hasPrompt: () => !!deferredPrompt, fab: () => !installFab.hidden, standalone: isStandalone, sheet: () => openSheet() },
  perf: () => ({ tileCacheMB: +(tileBytes / 1048576).toFixed(1), tiles: tileCache.size, previews: previewCache.size, tileScale: +currentTileBucket.toFixed(3), dpr: +hiDpr().toFixed(2) }),
  zoom: (f) => { zoomAt(cw / 2, ch / 2, f); render(); },
  zoomTo: (target) => { zoomTo(target); render(); },

  prime: () => render(),
  dbg: { render, page: () => page, previews: () => [...previewCache.keys()], tiles: () => [...tileCache.keys()] },
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
