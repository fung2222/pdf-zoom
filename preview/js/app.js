import * as pdfjsLib from '../../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;

const stage = document.getElementById('stage');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { alpha: true });
const emptyEl = document.getElementById('empty');
const badge = document.getElementById('badge');
const dropEl = document.getElementById('drop');
const topEl = document.getElementById('top');
const bottomEl = document.getElementById('bottom');
const pgLabel = document.getElementById('pgLabel');
const zoomLabel = document.getElementById('zoomLabel');
const fitBtn = document.getElementById('fitBtn');
const fileInput = document.getElementById('file');
const homeEl = document.getElementById('home');
const homeList = document.getElementById('homeList');
const homeTitle = document.getElementById('homeTitle');
const currentFavoriteBtn = document.getElementById('favoriteBtn');
let homeMode = 'recent';
let currentFileId = null;
const loadingIndicator = document.getElementById('loadingIndicator');
const loadingText = document.getElementById('loadingText');
let loadingCount = 0;
function beginLoading(label = '載入中…') {
  loadingCount++;
  if (loadingText) loadingText.textContent = label;
  if (loadingIndicator) loadingIndicator.hidden = false;
}
function endLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (!loadingCount && loadingIndicator) loadingIndicator.hidden = true;
}

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('pdf-zoom-theme', next); } catch {}
  const label = next === 'dark' ? '☀ 明亮' : '☾ 黑暗';
  const homeButton = document.getElementById('themeToggle');
  const readerButton = document.getElementById('themeToggleReader');
  if (homeButton) homeButton.textContent = label;
  if (readerButton) readerButton.textContent = next === 'dark' ? '☀' : '☾';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = next === 'dark' ? '#0b0b0c' : '#f4f5f7';
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}
try { applyTheme(localStorage.getItem('pdf-zoom-theme') || 'dark'); } catch { applyTheme('dark'); }

const MAX_ZOOM_RATIO = 60;     // 6000% relative to fit-to-width
function maxScale() { return fitScale * MAX_ZOOM_RATIO; }
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
let lastVisibleRenderMs = 0;
let lastRefineRenderMs = 0;
let rafPending = false;
let panRaf = false;
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
  if (contentW <= cw) tx = (cw - contentW) / 2;
  else tx = Math.min(0, Math.max(cw - contentW, tx));
  if (contentH <= ch) ty = (ch - contentH) / 2;
  else ty = Math.min(0, Math.max(ch - contentH, ty));
}

function fitWidth(keepY = false) {
  const { w } = pageSize();
  fitScale = cw / w;
  s = fitScale;
  tx = (cw - w * s) / 2;
  if (!keepY) {
    const { h } = pageSize();
    ty = (ch - h * s) / 2;
  }
  clampView();
}

function stagePoint(clientX, clientY) {
  const rect = stage.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function zoomAt(clientX, clientY, factor) {
  const p = stagePoint(clientX, clientY);
  const ns = Math.min(maxScale(), Math.max(fitScale * 0.8, s * factor));
  const k = ns / s;
  // Keep the PDF point beneath the fingers anchored beneath the same point.
  tx = p.x - (p.x - tx) * k;
  ty = p.y - (p.y - ty) * k;
  s = ns;
  clampView();
}

function zoomTo(nextS, clientX = cw / 2, clientY = ch / 2) {
  zoomAt(clientX, clientY, nextS / s);
}

/* ---------------- rendering: full-page preview + one detail canvas ---------------- */

const MAX_DETAIL_PIXELS = 8 * 1024 * 1024;
const MAX_DETAIL_DIMENSION = 8192;
const MAX_PREVIEW_PIXELS = 8e5;
const MAX_BUFFER_RATIO = 1.6;   // pan buffer: tile ≤ 1.6× visible per axis (stays inside pixel budget)
const stats = { cancels: 0, gestureEndAt: 0, sharpAt: 0, sharpLatencyMs: 0, longTaskMax: 0, cacheHits: 0 };
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      stats.longTaskMax = Math.max(stats.longTaskMax, Math.round(entry.duration));
    }
  }).observe({ entryTypes: ['longtask'] });
} catch {}
const previewCache = new Map();
const previewLayer = document.createElement('canvas');
previewLayer.id = 'previewLayer';
previewLayer.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;transform-origin:0 0;will-change:transform;z-index:1;';
stage.insertBefore(previewLayer, canvas.nextSibling);
const previewCtx = previewLayer.getContext('2d', { alpha: false });
const detailLayer = document.createElement('div');
detailLayer.id = 'detailLayer';
detailLayer.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none;transform-origin:0 0;will-change:transform;z-index:2;';
stage.insertBefore(detailLayer, previewLayer.nextSibling);

let detailState = null;
let placeholderState = null;
let detailTask = null;
let detailTimer = null;
let detailRefineTimer = null;
let detailGeneration = 0;

function releaseFrame(frame) {
  if (!frame || !frame.cv) return;
  try { frame.cv.width = 0; frame.cv.height = 0; } catch {}
}

function clearRenderCaches() {
  cancelHiRender();
  clearTileCache();
  if (placeholderState) releaseFrame({ cv: placeholderState.canvas });
  placeholderState = null;
  for (const frame of previewCache.values()) releaseFrame(frame);
  previewCache.clear();
  detailLayer.replaceChildren();
  detailState = null;
  previewLayer.width = 1;
  previewLayer.height = 1;
  previewLayer.style.display = 'none';
  if (canvas) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.transform = 'none';
  }
}

function cancelHiRender() {
  clearTimeout(detailTimer);
  clearTimeout(detailRefineTimer);
  detailRefineTimer = null;
  detailGeneration++;
  if (detailTask) {
    try { detailTask.cancel(); stats.cancels++; } catch {}
    detailTask = null;
  }
}

function quantizedScale() {
  return Math.pow(2, Math.round(Math.log2(Math.max(s, 0.001)) * 8) / 8);
}

/* -------- detail tile cache: pan back into a seen area without re-rendering -------- */

const MAX_TILE_CACHE_PIXELS = 16 * 1024 * 1024;   // ≈ 4–5 sharp viewport tiles (~64MB)
let tileCache = [];
let tileCachePixels = 0;
let tileBucket = 0;

function clearTileCache() {
  for (const tile of tileCache) releaseFrame({ cv: tile.canvas });
  tileCache = [];
  tileCachePixels = 0;
}

function cacheDetailTile(state) {
  if (!state || !state.canvas) return;
  // Only keep viewport-sized sharp tiles: a padded pan-buffer tile costs ~2.6×
  // the pixels and would evict the small tiles that make pan-back instant.
  if (state.buffered) return;
  const needed = state.scale * DPR();
  if (state.pxPerPt && needed && state.pxPerPt < needed * 0.9) return;   // skip coarse passes
  const pixels = state.canvas.width * state.canvas.height;
  if (!pixels || pixels > MAX_TILE_CACHE_PIXELS) return;
  for (let i = tileCache.length - 1; i >= 0; i--) {
    if (tileCache[i].canvas === state.canvas) {
      tileCachePixels -= tileCache[i].canvas.width * tileCache[i].canvas.height;
      tileCache.splice(i, 1);
    }
  }
  tileCache.push({
    canvas: state.canvas, x: state.x, y: state.y, w: state.w, h: state.h,
    scale: state.scale, pxPerPt: state.pxPerPt || 0,
  });
  tileCachePixels += pixels;
  while (tileCachePixels > MAX_TILE_CACHE_PIXELS && tileCache.length > 1) {
    const old = tileCache.shift();
    tileCachePixels -= old.canvas.width * old.canvas.height;
    releaseFrame({ cv: old.canvas });
  }
}

function takeCachedTile(visible, bucket) {
  const needed = bucket * DPR();
  for (let i = tileCache.length - 1; i >= 0; i--) {
    const tile = tileCache[i];
    if (Math.abs(tile.scale - bucket) > 0.0001) continue;
    if (tile.pxPerPt && tile.pxPerPt < needed * 0.95) continue;
    if (visible.x0 < tile.x - 0.01 || visible.y0 < tile.y - 0.01 ||
        visible.x0 + visible.w > tile.x + tile.w + 0.01 ||
        visible.y0 + visible.h > tile.y + tile.h + 0.01) continue;
    tileCache.splice(i, 1);
    tileCachePixels -= tile.canvas.width * tile.canvas.height;
    return tile;
  }
  return null;
}

// A cached tile that only overlaps part of the view is still worth showing as a
// stand-in while the exact tile renders: the user sees sharp content at once.
function takeOverlappingTile(visible, bucket) {
  const needed = bucket * DPR();
  let best = null, bestCover = 0;
  for (const tile of tileCache) {
    if (Math.abs(tile.scale - bucket) > 0.0001) continue;
    if (tile.pxPerPt && tile.pxPerPt < needed * 0.95) continue;
    const ox = Math.min(visible.x0 + visible.w, tile.x + tile.w) - Math.max(visible.x0, tile.x);
    const oy = Math.min(visible.y0 + visible.h, tile.y + tile.h) - Math.max(visible.y0, tile.y);
    if (ox <= 0 || oy <= 0) continue;
    const cover = (ox * oy) / Math.max(1, visible.w * visible.h);
    if (cover > bestCover) { bestCover = cover; best = tile; }
  }
  if (!best || bestCover < 0.25) return null;
  const index = tileCache.indexOf(best);
  tileCache.splice(index, 1);
  tileCachePixels -= best.canvas.width * best.canvas.height;
  return best;
}

function viewPts() {
  return { x0: -tx / s, y0: -ty / s, w: cw / s, h: ch / s };
}

function applyTransient() {
  const transform = `translate3d(${tx}px, ${ty}px, 0) scale(${s})`;
  previewLayer.style.transform = transform;
  detailLayer.style.transform = transform;
}

function cachePreview(n, frame) {
  const old = previewCache.get(n);
  if (old && old !== frame) releaseFrame(old);
  previewCache.delete(n);
  previewCache.set(n, frame);
  while (previewCache.size > 2) {
    const key = previewCache.keys().next().value;
    releaseFrame(previewCache.get(key));
    previewCache.delete(key);
  }
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
  const targetWidth = Math.min(760, Math.max(480, cw * 0.9));
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
  const frame = { cv: off, s: ps, page: n, w: pw, h: ph };
  cachePreview(n, frame);
  return frame;
}

function blitFrame(frame) {
  if (!page || !frame || !frame.cv) return;
  const vp = page.getViewport({ scale: 1 });
  previewLayer.width = frame.cv.width;
  previewLayer.height = frame.cv.height;
  previewLayer.style.width = vp.width + 'px';
  previewLayer.style.height = vp.height + 'px';
  previewCtx.setTransform(1, 0, 0, 1, 0, 0);
  previewCtx.clearRect(0, 0, previewLayer.width, previewLayer.height);
  previewCtx.imageSmoothingEnabled = true;
  previewCtx.imageSmoothingQuality = 'high';
  previewCtx.drawImage(frame.cv, 0, 0);
  previewLayer.style.display = 'block';
  canvas.style.display = 'none';
  applyTransient();
}

function detailAreaCovers(visible, bucket) {
  if (!detailState || Math.abs(detailState.scale - bucket) > 0.0001) return false;
  const d = detailState;
  const pageViewport = page.getViewport({ scale: 1 });
  const right = d.x + d.w, bottom = d.y + d.h;
  if (visible.x0 < d.x || visible.y0 < d.y ||
      visible.x0 + visible.w > right || visible.y0 + visible.h > bottom) return false;
  const leftPad = visible.x0 - d.x;
  const rightPad = right - (visible.x0 + visible.w);
  const topPad = visible.y0 - d.y;
  const bottomPad = bottom - (visible.y0 + visible.h);
  // At a physical page edge no extra margin is needed on that side.
  const leftReady = d.x <= 0 || leftPad > visible.w * 0.5;
  const rightReady = right >= pageViewport.width || rightPad > visible.w * 0.5;
  const topReady = d.y <= 0 || topPad > visible.h * 0.5;
  const bottomReady = bottom >= pageViewport.height || bottomPad > visible.h * 0.5;
  return leftReady && rightReady && topReady && bottomReady;
}

function detailContainsVisible(visible, bucket) {
  if (!detailState || Math.abs(detailState.scale - bucket) > 0.0001) return false;
  const d = detailState;
  return visible.x0 >= d.x && visible.y0 >= d.y &&
    visible.x0 + visible.w <= d.x + d.w &&
    visible.y0 + visible.h <= d.y + d.h;
}

function scheduleDetailRefine() {
  clearTimeout(detailRefineTimer);
  detailRefineTimer = setTimeout(() => {
    detailRefineTimer = null;
    if (!gestureActive) renderDetail({ buffered: true, showLoading: false }).catch(err => console.warn(err));
  }, 80);
}

async function renderDetail({ buffered = false, showLoading = true } = {}) {
  if (!pdf || !page || gestureActive) return;
  const doc = pdf;
  const pageRef = page;
  const pageNo = pageNum;
  const generation = documentGeneration;
  const pageViewport = pageRef.getViewport({ scale: 1 });
  const pageW = pageViewport.width, pageH = pageViewport.height;
  const bucket = quantizedScale();
  if (Math.abs(bucket - tileBucket) > 0.0001) { clearTileCache(); tileBucket = bucket; }
  const rawVisible = viewPts();
  const visible = {
    x0: Math.max(0, Math.min(pageW, rawVisible.x0)),
    y0: Math.max(0, Math.min(pageH, rawVisible.y0)),
    w: Math.max(1, Math.min(pageW, rawVisible.x0 + rawVisible.w) - Math.max(0, rawVisible.x0)),
    h: Math.max(1, Math.min(pageH, rawVisible.y0 + rawVisible.h) - Math.max(0, rawVisible.y0)),
  };

  const alreadyVisible = detailContainsVisible(visible, bucket);
  if (buffered ? detailAreaCovers(visible, bucket) : alreadyVisible) {
    if (!buffered && !detailAreaCovers(visible, bucket)) scheduleDetailRefine();
    return;
  }

  // Panning back into an area that was already rendered: put the cached tile on
  // screen immediately instead of paying for another render.
  if (!buffered) {
    const cached = takeCachedTile(visible, bucket);
    if (cached) {
      stats.cacheHits++;
      const previous = detailState;
      detailLayer.replaceChildren(cached.canvas);
      if (previous && previous.canvas && previous.canvas !== cached.canvas) cacheDetailTile(previous);
      detailState = {
        canvas: cached.canvas, x: cached.x, y: cached.y, w: cached.w, h: cached.h,
        scale: cached.scale, pxPerPt: cached.pxPerPt, buffered: false,
      };
      lastRenderMs = 0;
      lastVisibleRenderMs = 0;
      lastRefineRenderMs = 0;
      stats.sharpAt = performance.now();
      if (stats.gestureEndAt) {
        stats.sharpLatencyMs = Math.round(stats.sharpAt - stats.gestureEndAt);
        stats.gestureEndAt = 0;
      }
      applyTransient();
      return;
    }

    // Otherwise, if part of the view was rendered before, put that tile behind
    // the current one so the overlap is sharp while the exact tile is drawn.
    const overlap = takeOverlappingTile(visible, bucket);
    if (overlap) {
      if (placeholderState) cacheDetailTile(placeholderState);
      detailLayer.insertBefore(overlap.canvas, detailLayer.firstChild);
      placeholderState = { ...overlap, buffered: false };
      applyTransient();
    }
  }

  // First paint only the visible viewport for a fast sharp result.
  // Then grow the pan buffer, but never past what the pixel budget can hold at
  // full screen resolution: padding further used to render below s*DPR and
  // replace a sharp canvas with a blurrier one.
  const dpr = DPR();
  const visiblePx = Math.max(1, visible.w * visible.h * bucket * bucket * dpr * dpr);
  const bufferRatio = buffered
    ? Math.min(MAX_BUFFER_RATIO, Math.max(1, Math.sqrt(MAX_DETAIL_PIXELS / visiblePx)))
    : 1;
  const padX = visible.w * (bufferRatio - 1) / 2;
  const padY = visible.h * (bufferRatio - 1) / 2;
  const x0 = Math.max(0, visible.x0 - padX);
  const y0 = Math.max(0, visible.y0 - padY);
  const x1 = Math.min(pageW, visible.x0 + visible.w + padX);
  const y1 = Math.min(pageH, visible.y0 + visible.h + padY);
  const tileW = Math.max(1, x1 - x0);
  const tileH = Math.max(1, y1 - y0);

  const token = ++detailGeneration;
  if (detailTask) {
    try { detailTask.cancel(); } catch {}
    detailTask = null;
  }
  if (showLoading) beginLoading('正在載入高清畫面');

  const started = performance.now();
  const neededPx = Math.max(1, cw * ch * dpr * dpr);
  // Progressive first paint: a full-resolution viewport tile is ~3.4MP on a
  // phone and that is what makes a new position feel slow. Paint a coarse pass
  // first (~1/3 of the pixels), then the exact tile on top.
  const qualities = buffered ? [1] : (neededPx > 1.2e6 ? [0.6, 1] : [1]);
  let renderedOk = false;
  let firstShownAt = 0;

  const paintAt = async (quality) => {
    let nextCanvas = null;
    try {
      const baseScale = bucket * dpr * quality;
      let outputScale = Math.min(1,
        Math.sqrt(MAX_DETAIL_PIXELS / Math.max(1, tileW * tileH * baseScale * baseScale)),
        MAX_DETAIL_DIMENSION / Math.max(1, tileW * baseScale),
        MAX_DETAIL_DIMENSION / Math.max(1, tileH * baseScale));
      outputScale = Math.max(0.001, outputScale);
      const renderScale = baseScale * outputScale;

      const pixelW = Math.max(1, Math.ceil(tileW * renderScale));
      const pixelH = Math.max(1, Math.ceil(tileH * renderScale));
      nextCanvas = document.createElement('canvas');
      nextCanvas.className = 'detail-canvas';
      nextCanvas.width = pixelW;
      nextCanvas.height = pixelH;
      nextCanvas.style.cssText =
        `position:absolute;left:${x0}px;top:${y0}px;width:${tileW}px;height:${tileH}px;max-width:none;max-height:none;`;

      const viewport = pageRef.getViewport({ scale: renderScale });
      const task = pageRef.render({
        canvasContext: nextCanvas.getContext('2d', { alpha: false }),
        viewport,
        transform: [1, 0, 0, 1, -x0 * renderScale, -y0 * renderScale],
        intent: 'display',
      });
      detailTask = task;
      await task.promise;

      if (token !== detailGeneration || doc !== pdf || pageRef !== page || pageNo !== pageNum ||
          generation !== documentGeneration || gestureActive) {
        nextCanvas.width = 0;
        nextCanvas.height = 0;
        return false;
      }

      const previousState = detailState;
      const previousCanvas = previousState && previousState.canvas;
      const newPxPerPt = pixelW / tileW;
      const oldPxPerPt = previousState && previousState.pxPerPt ? previousState.pxPerPt : 0;
      if (previousState && Math.abs(previousState.scale - bucket) < 0.0001 &&
          oldPxPerPt > newPxPerPt * 1.01 && detailContainsVisible(visible, bucket)) {
        // What is already on screen is sharper than this pass: keep it.
        nextCanvas.width = 0;
        nextCanvas.height = 0;
        return false;
      }
      if (placeholderState) { cacheDetailTile(placeholderState); placeholderState = null; }
      detailLayer.replaceChildren(nextCanvas);
      if (previousCanvas && previousCanvas !== nextCanvas) cacheDetailTile(previousState);
      detailState = { canvas: nextCanvas, x: x0, y: y0, w: tileW, h: tileH, scale: bucket, pxPerPt: newPxPerPt, buffered };
      const doneAt = performance.now();
      lastRenderMs = Math.round(doneAt - started);
      if (buffered) {
        lastRefineRenderMs = lastRenderMs;
      } else {
        lastVisibleRenderMs = Math.round(doneAt - started);
        lastRefineRenderMs = 0;
        if (!firstShownAt) {
          firstShownAt = doneAt;
          stats.sharpAt = doneAt;
          if (stats.gestureEndAt) {
            stats.sharpLatencyMs = Math.round(doneAt - stats.gestureEndAt);
            stats.gestureEndAt = 0;
          }
        }
      }
      applyTransient();
      return true;
    } catch (err) {
      if (nextCanvas) { nextCanvas.width = 0; nextCanvas.height = 0; }
      if (err && err.name !== 'RenderingCancelledException') {
        console.warn('Tiled detail render failed', err);
      }
      return false;
    }
  };

  try {
    for (const quality of qualities) {
      if (!await paintAt(quality)) break;
      renderedOk = true;
      if (token !== detailGeneration || gestureActive) break;
    }
  } finally {
    if (detailTask && token === detailGeneration) detailTask = null;
    if (showLoading) endLoading();
    if (!buffered && renderedOk && token === detailGeneration &&
        doc === pdf && pageRef === page && pageNo === pageNum && !gestureActive) {
      scheduleDetailRefine();
    }
  }
}

function scheduleDetailRender(immediate = false) {
  clearTimeout(detailTimer);
  clearTimeout(detailRefineTimer);
  detailRefineTimer = null;
  if (gestureActive) return;
  const delay = immediate ? 0 : 120;
  detailTimer = setTimeout(() => renderDetail().catch(err => console.warn(err)), delay);
}

function schedulePaint() {
  if (panRaf) return;
  panRaf = true;
  requestAnimationFrame(() => {
    panRaf = false;
    applyTransient();
  });
}

async function render(options = {}) {
  if (!page) return;
  rafPending = false;
  if (gestureActive) { schedulePaint(); return; }
  applyTransient();
  updateHud();
  saveLastPos(pageNum);
  scheduleDetailRender(!!options.immediate);
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
    const rect = stage.getBoundingClientRect();
    pinchStart = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2 - rect.left,
      cy: (a.y + b.y) / 2 - rect.top,
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
    // The drawing must follow the finger.
    tx = dragStart.tx + dx;
    ty = dragStart.ty + dy;
    clampView();
    schedulePaint();
  } else if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const rect = stage.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - rect.left;
    const cy = (a.y + b.y) / 2 - rect.top;
    moved = 99;
    const factor = dist / Math.max(12, pinchStart.dist);
    // Keep the PDF point under the initial pinch midpoint under the moving midpoint.
    const ns = Math.min(maxScale(), Math.max(fitScale * 0.8, pinchStart.s * factor));
    const k = ns / pinchStart.s;
    tx = cx - (pinchStart.cx - pinchStart.tx) * k;
    ty = cy - (pinchStart.cy - pinchStart.ty) * k;
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
    stats.gestureEndAt = performance.now();
    stats.sharpLatencyMs = 0;
    dragStart = null;
    pinchStart = null;
    const isTap = moved < 7 && lastFile !== null;
    if (isTap) {
      const now = Date.now();
      const dbl = now - tapInfo.t < 320 && Math.hypot(e.clientX - tapInfo.x, e.clientY - tapInfo.y) < 40;
      if (dbl) {
        tapInfo.t = 0;
        const zoomedIn = s > fitScale * 1.9;
        if (zoomedIn) { fitWidth(); render({ immediate: true }); } else { zoomAt(e.clientX, e.clientY, 2.6); render({ immediate: true }); }
        flashZoom();
        return;
      }
      tapInfo = { t: now, x: e.clientX, y: e.clientY };
      // single tap toggles chrome
      document.body.classList.toggle('hide-chrome');
      showChrome();
    }
    render({ immediate: true });
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

async function openPdf(data, name, existingFileId = null) {
  const openId = ++documentGeneration;
  currentFileId = null;
  pageRequestId++;
  primeGeneration++;
  cancelHiRender();
  homeEl.hidden = true;
  stage.hidden = false;
  topEl.hidden = false;
  beginLoading('正在開啟 PDF');
  emptyEl.hidden = true;
  // pdf.js TRANSFERS the buffer to its worker, so keep a copy for IndexedDB first
  const keep = data.slice(0);
  try {
    const doc = await pdfjsLib.getDocument({
      data,
      cMapUrl: new URL('../../vendor/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('../../vendor/standard_fonts/', import.meta.url).href,
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
    homeEl.hidden = true;
    stage.hidden = false;
    topEl.hidden = false; bottomEl.hidden = false;
    pgLabel.hidden = false; fitBtn.hidden = false;
    showChrome();
    // Do not hold the first visible page behind IndexedDB writes.
    void (async () => {
      const savedId = await saveRecentFile(keep, lastFile.name, existingFileId);
      if (openId !== documentGeneration) return;
      currentFileId = savedId;
      lastFile.id = savedId;
      await saveLast(keep, lastFile.name);
      if (openId === documentGeneration) updateFavoriteButton();
    })();
  } catch (err) {
    if (openId === documentGeneration) {
      console.error(err);
      alert('開唔到呢個 PDF：' + (err && err.message ? err.message : err));
      emptyEl.hidden = false;
    }
  } finally {
    endLoading();
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
  if (detailState && detailState.canvas) {
    detailState.canvas.width = 0;
    detailState.canvas.height = 0;
  }
  clearTileCache();
  if (placeholderState) releaseFrame({ cv: placeholderState.canvas });
  placeholderState = null;
  detailLayer.replaceChildren();
  detailState = null;
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
  beginLoading('正在讀取 PDF 檔案');
  try {
    const buf = await file.arrayBuffer();
    await openPdf(new Uint8Array(buf), file.name);
  } finally { endLoading(); }
}

fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  fileInput.value = '';
  handleFile(f);
});

document.getElementById('openBtn').addEventListener('click', () => fileInput.click());
document.getElementById('homeOpen').addEventListener('click', () => fileInput.click());
document.getElementById('homeRecent').addEventListener('click', () => { homeMode='recent'; renderHome(); });
document.getElementById('homeFavorites').addEventListener('click', () => { homeMode='favorites'; renderHome(); });
document.getElementById('themeToggle').addEventListener('click', toggleTheme);
document.getElementById('themeToggleReader').addEventListener('click', toggleTheme);
document.getElementById('backHome').addEventListener('click', closeReaderToHome);
currentFavoriteBtn.addEventListener('click', toggleCurrentFavorite);
document.getElementById('pick').addEventListener('click', () => fileInput.click());
document.getElementById('next').addEventListener('click', nextPage);
document.getElementById('prev').addEventListener('click', prevPage);
document.getElementById('zoomIn').addEventListener('click', () => { zoomAt(cw / 2, ch / 2, 1.5); render({ immediate: true }); flashZoom(); });
document.getElementById('zoomOut').addEventListener('click', () => { zoomAt(cw / 2, ch / 2, 1 / 1.5); render({ immediate: true }); flashZoom(); });
fitBtn.addEventListener('click', () => { fitWidth(); render({ immediate: true }); flashZoom(); });

window.addEventListener('keydown', (e) => {
  if (!pdf) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') nextPage();
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') prevPage();
  if (e.key === '+' || e.key === '=') { zoomAt(cw / 2, ch / 2, 1.4); render({ immediate: true }); }
  if (e.key === '-' || e.key === '_') { zoomAt(cw / 2, ch / 2, 1 / 1.4); render({ immediate: true }); }
  if (e.key === '0') { fitWidth(); render({ immediate: true }); }
});

/* debug/automation hook (harmless in production) */
window.__pz = {
  state: () => ({ s, tx, ty, fitScale, pageNum, pageCount, cw, ch }),
  pan: (dx, dy) => { tx -= dx; ty -= dy; clampView(); render(); },
  zoomAt, fit: () => { fitWidth(); render(); }, nextPage, prevPage,
  perf: () => {
    const canvases = detailLayer.querySelectorAll('canvas');
    let mpx = 0;
    canvases.forEach((c) => { mpx += (c.width * c.height) / 1e6; });
    const needed = detailState ? detailState.scale * DPR() : 0;
    return {
      detailReady: !!detailState,
      detailScale: detailState ? +detailState.scale.toFixed(3) : 0,
      previews: previewCache.size,
      lastRenderMs, lastVisibleRenderMs, lastRefineRenderMs,
      canvasPx: detailState ? detailState.canvas.width + 'x' + detailState.canvas.height : null,
      detailMpx: +mpx.toFixed(2),
      detailCanvases: canvases.length,
      sharpness: detailState && needed ? +((detailState.pxPerPt || 0) / needed).toFixed(2) : 0,
      sharpLatencyMs: stats.sharpLatencyMs,
      cancels: stats.cancels,
      longTaskMaxMs: stats.longTaskMax,
      tileCacheCount: tileCache.length,
      tileCacheMpx: +(tileCachePixels / 1e6).toFixed(2),
      cacheHits: stats.cacheHits,
    };
  },
  benchReset: () => {
    stats.cancels = 0; stats.longTaskMax = 0; stats.sharpLatencyMs = 0;
    stats.gestureEndAt = 0; stats.sharpAt = 0;
  },
  buttonZoom: (f) => { zoomAt(cw / 2, ch / 2, f); render({ immediate: true }); },
  gestureEnd: () => { stats.gestureEndAt = performance.now(); stats.sharpLatencyMs = 0; render({ immediate: true }); },
  zoom: (f) => { zoomAt(cw / 2, ch / 2, f); render(); },
  zoomTo: (target) => { zoomTo(target); render(); },

  prime: () => render(),
  dbg: { render, page: () => page, previews: () => [...previewCache.keys()],
    tiles: () => tileCache.map((t) => ({ x: +t.x.toFixed(1), y: +t.y.toFixed(1), w: +t.w.toFixed(1), h: +t.h.toFixed(1), scale: +t.scale.toFixed(3), mpx: +(t.canvas.width * t.canvas.height / 1e6).toFixed(2) })),
    visible: () => { const v = viewPts(); return { x0: +v.x0.toFixed(1), y0: +v.y0.toFixed(1), w: +v.w.toFixed(1), h: +v.h.toFixed(1) }; },
  },
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


/* ---------------- home library ---------------- */

function makeFileId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'f-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

async function saveRecentFile(data, name, existingId = null) {
  try {
    const db = await idb();
    const id = existingId || makeFileId();
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const previous = await new Promise(resolve => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    store.put({
      id, name, blob: new Blob([data], {type:'application/pdf'}),
      favorite: !!(previous && previous.favorite),
      openedAt: Date.now(), page: pageNum || 1
    });
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const recent = (allReq.result || [])
        .filter(item => !item.favorite)
        .sort((a,b)=>(b.openedAt||0)-(a.openedAt||0));
      for (const stale of recent.slice(20)) store.delete(stale.id);
    };
    return id;
  } catch (err) {
    console.warn('library save failed', err);
    return existingId;
  }
}

async function getLibraryFiles() {
  const db = await idb();
  const tx = db.transaction('files', 'readonly');
  const req = tx.objectStore('files').getAll();
  return await new Promise(resolve => {
    req.onsuccess = () => resolve((req.result || []).sort((a,b)=>(b.openedAt||0)-(a.openedAt||0)));
    req.onerror = () => resolve([]);
  });
}

async function renderHome() {
  if (!homeList) return;
  homeTitle.textContent = homeMode === 'favorites' ? '收藏' : '最近開啟';
  document.getElementById('homeRecent').classList.toggle('active', homeMode === 'recent');
  document.getElementById('homeFavorites').classList.toggle('active', homeMode === 'favorites');
  homeList.replaceChildren();
  const files = await getLibraryFiles();
  const shown = homeMode === 'favorites' ? files.filter(f=>f.favorite) : files;
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'home-empty';
    empty.textContent = homeMode === 'favorites' ? '未有收藏的 PDF' : '尚未開啟 PDF。可以選擇檔案，或從 WhatsApp 分享進來。';
    homeList.appendChild(empty);
    return;
  }
  for (const file of shown.slice(0, 30)) {
    const item = document.createElement('article');
    item.className = 'file-row';
    const open = document.createElement('button');
    open.className = 'file-open';
    open.type = 'button';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = 'PDF';
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    const title = document.createElement('strong');
    title.textContent = file.name || 'document.pdf';
    const sub = document.createElement('small');
    sub.textContent = new Date(file.openedAt || Date.now()).toLocaleString();
    meta.append(title, sub);
    open.append(icon, meta);
    open.addEventListener('click', async () => {
      if (!file.blob) return;
      beginLoading('正在開啟文件');
      try {
        const buf = await file.blob.arrayBuffer();
        await openPdf(new Uint8Array(buf), file.name, file.id);
      } finally { endLoading(); }
    });
    const fav = document.createElement('button');
    fav.className = 'file-favorite' + (file.favorite ? ' selected' : '');
    fav.type = 'button';
    fav.setAttribute('aria-label', file.favorite ? '取消收藏' : '加入收藏');
    fav.textContent = file.favorite ? '★' : '☆';
    fav.addEventListener('click', async () => {
      const db = await idb();
      const tx = db.transaction('files','readwrite');
      const store = tx.objectStore('files');
      const req = store.get(file.id);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec) { rec.favorite = !rec.favorite; store.put(rec); }
      };
      tx.oncomplete = renderHome;
    });
    item.append(open, fav);
    homeList.appendChild(item);
  }
}

function updateFavoriteButton() {
  if (!currentFavoriteBtn) return;
  currentFavoriteBtn.hidden = !pdf;
  currentFavoriteBtn.textContent = '☆';
  if (!currentFileId) return;
  getLibraryFiles().then(files => {
    const rec = files.find(f=>f.id===currentFileId);
    currentFavoriteBtn.textContent = rec && rec.favorite ? '★' : '☆';
    currentFavoriteBtn.classList.toggle('selected', !!(rec && rec.favorite));
  });
}

async function toggleCurrentFavorite() {
  if (!currentFileId) return;
  const db = await idb();
  const tx = db.transaction('files','readwrite');
  const store = tx.objectStore('files');
  const req = store.get(currentFileId);
  req.onsuccess = () => {
    const rec = req.result;
    if (rec) { rec.favorite = !rec.favorite; store.put(rec); }
  };
  tx.oncomplete = updateFavoriteButton;
}

function closeReaderToHome() {
  document.body.classList.remove('hide-chrome');
  cancelHiRender();
  stage.hidden = true;
  topEl.hidden = true;
  bottomEl.hidden = true;
  homeEl.hidden = false;
  renderHome();
}

/* ---------------- tiny idb ---------------- */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pdf-zoom', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
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
  s = Math.min(maxScale(), Math.max(fitScale, fitScale * view.z));
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
      cMapUrl: new URL('../../vendor/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('../../vendor/standard_fonts/', import.meta.url).href,
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
    const preview = await ensurePreview(pageNum);
    if (preview) blitFrame(preview);
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
  // A normal app launch always starts on the library home screen.
  stage.hidden = true;
  topEl.hidden = true; bottomEl.hidden = true;
  homeEl.hidden = false;
  await renderHome();
})();
