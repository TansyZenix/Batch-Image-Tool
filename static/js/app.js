'use strict';

/* ==========================================================================
   批量图片处理 —— 前端逻辑

   每张图片各自保存一套参数（旋转 / 翻转 / 裁剪框 / 比例锁），默认全部相同。
   改动只作用于当前图片，通过「应用到全部图片」下发；
   与下发快照不一致的图片会在胶片条上打一个点，提示它被单独调整过。
   ========================================================================== */

/* 比例预设，free 表示不锁定 */
const RATIOS = { free: null, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16 };

const MIN_SIZE = 24;         // 裁剪框最小边长（舞台像素）
const DEFAULT_INSET = 0.1;   // 新建裁剪框时四周留白
const DRAG_THRESHOLD = 4;    // 在空白处按下后，移动超过这么多像素才算拉框
const THUMB_W = 120;         // 缩略图逻辑尺寸
const THUMB_H = 80;

const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  images: [],        // { name, url, width, height, el, shot, canvas }
  current: -1,
  ops: {},           // name -> 参数
  applied: null,     // 「应用到全部」时的快照，用于标记被单独调整过的图片
  view: { dw: 0, dh: 0 },
  drag: null,
  rafPending: false,
};

/* -------------------------------------------------------------- 参数工具 */

function defaultOps() {
  return {
    crop: { x: DEFAULT_INSET, y: DEFAULT_INSET, w: 1 - DEFAULT_INSET * 2, h: 1 - DEFAULT_INSET * 2 },
    rotate: 0,
    flipH: false,
    flipV: false,
    ratio: 'free',
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 只保留后端需要的字段，顺便抹掉浮点噪声 */
function serializeOps(ops) {
  const c = ops.crop;
  return {
    crop: c && {
      x: +c.x.toFixed(6), y: +c.y.toFixed(6),
      w: +c.w.toFixed(6), h: +c.h.toFixed(6),
    },
    rotate: ((ops.rotate % 360) + 360) % 360,
    flipH: !!ops.flipH,
    flipV: !!ops.flipV,
  };
}

const opsKey = (ops) => JSON.stringify(serializeOps(ops));

/** 画面旋转 90/270 后，宽高互换 */
const isQuarterTurn = (ops) => ops.rotate % 180 !== 0;

function viewSizeOf(image, ops) {
  return isQuarterTurn(ops)
    ? { w: image.height, h: image.width }
    : { w: image.width, h: image.height };
}

/** 把裁剪框调到符合目标宽高比，尽量保持面积与中心点 */
function fitRatio(crop, ratio, viewW, viewH) {
  if (!ratio) return crop;

  const pxW = crop.w * viewW;
  const pxH = crop.h * viewH;
  const area = Math.max(1, pxW * pxH);

  let w = Math.sqrt(area * ratio);
  let h = w / ratio;

  const k = Math.min(1, viewW / w, viewH / h);
  w *= k;
  h *= k;

  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  return {
    x: clamp(cx - w / viewW / 2, 0, 1 - w / viewW),
    y: clamp(cy - h / viewH / 2, 0, 1 - h / viewH),
    w: w / viewW,
    h: h / viewH,
  };
}

/** 旋转时让裁剪框跟着画面一起转，保持它框住的还是同一块内容 */
function rotateCrop(crop, clockwise) {
  if (!crop) return crop;
  return clockwise
    ? { x: 1 - (crop.y + crop.h), y: crop.x, w: crop.h, h: crop.w }
    : { x: crop.y, y: 1 - (crop.x + crop.w), w: crop.h, h: crop.w };
}

/* --------------------------------------------------------- 当前图片状态 */

const currentImage = () => state.images[state.current] || null;
const currentOps = () => {
  const img = currentImage();
  return img ? state.ops[img.name] : null;
};

/* ------------------------------------------------------------ 载入图片 */

async function upload(files) {
  if (!files || !files.length) return;

  const form = new FormData();
  for (const file of files) form.append('files', file);

  setStatus('busy', '正在读取图片…');

  let data;
  try {
    const response = await fetch('/api/upload', { method: 'POST', body: form });
    data = await response.json();
    if (!response.ok) throw new Error(data.error || '上传失败');
  } catch (error) {
    setStatus('error', '图片读取失败', String(error.message || error));
    return;
  }

  await resetSession({ silent: true });

  state.session = data.session;
  state.images = data.images.map((item) => ({ ...item, el: null, shot: null, canvas: null }));
  state.ops = {};
  state.current = -1;

  // 先取出每张图的像素，再把第一张的参数下发成全体默认值
  await Promise.all(state.images.map(async (image) => {
    const el = new Image();
    el.decoding = 'async';
    el.src = image.url;
    image.el = el;
    try { await el.decode(); } catch { /* 解码失败时退回后端返回的尺寸 */ }
    if (el.naturalWidth) {
      image.width = el.naturalWidth;
      image.height = el.naturalHeight;
    }
    state.ops[image.name] = defaultOps();
  }));

  state.applied = opsKey(defaultOps());

  buildFilmstrip();
  selectImage(0);

  const skipped = data.skipped || [];
  if (skipped.length) {
    setStatus(
      'info',
      `已载入 ${state.images.length} 张，跳过 ${skipped.length} 个不支持的文件`,
      skipped.join('\n'),
    );
  } else {
    hideStatus();
  }
}

async function resetSession({ silent = false } = {}) {
  if (state.session) {
    try { await fetch(`/api/reset/${state.session}`, { method: 'POST' }); } catch { /* 清理失败不影响使用 */ }
  }
  state.session = null;
  state.images = [];
  state.ops = {};
  state.applied = null;
  state.current = -1;
  state.drag = null;
  $('filmstrip').replaceChildren();
  $('stage-canvas').hidden = true;
  $('stage-hint').hidden = false;
  if (!silent) hideStatus();
  updateChrome();
}

/* -------------------------------------------------------------- 胶片条 */

function buildFilmstrip() {
  const strip = $('filmstrip');
  strip.replaceChildren();

  state.images.forEach((image, index) => {
    const shot = document.createElement('button');
    shot.type = 'button';
    shot.className = 'shot';
    shot.title = image.name;
    shot.setAttribute('aria-label', `第 ${index + 1} 张：${image.name}`);

    const canvas = document.createElement('canvas');
    const index$ = document.createElement('span');
    index$.className = 'shot-index';
    index$.textContent = String(index + 1);

    shot.append(canvas, index$);
    shot.addEventListener('click', () => selectImage(index));
    strip.appendChild(shot);

    image.shot = shot;
    image.canvas = canvas;
  });
}

function selectImage(index) {
  if (index < 0 || index >= state.images.length) return;
  state.current = index;

  $('stage-canvas').hidden = false;
  $('stage-hint').hidden = true;

  drawStage();
  paintShots();
  updateChrome();
}

/* ---------------------------------------------------------- 裁剪台绘制 */

function drawStage() {
  const image = currentImage();
  const ops = currentOps();
  if (!image || !ops) return;

  const stage = $('stage');
  const availW = Math.max(80, stage.clientWidth - 48);
  const availH = Math.max(80, stage.clientHeight - 48);

  const natW = image.width;
  const natH = image.height;
  const turned = isQuarterTurn(ops);

  // 旋转 90/270 时，可用空间相当于把宽高对调
  const scale = turned
    ? Math.min(availH / natW, availW / natH)
    : Math.min(availW / natW, availH / natH);

  const uw = Math.max(1, Math.round(natW * scale));   // 未旋转的显示尺寸
  const uh = Math.max(1, Math.round(natH * scale));
  const dw = turned ? uh : uw;                        // 旋转后的显示尺寸
  const dh = turned ? uw : uh;

  state.view = { dw, dh, uw, uh };

  const canvas = $('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(dw * dpr);
  canvas.height = Math.round(dh * dpr);
  canvas.style.width = `${dw}px`;
  canvas.style.height = `${dh}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, dw, dh);
  placeCropBox();

  if (!image.el || !image.el.naturalWidth) return;   // 解码失败时只留空画布

  ctx.save();
  ctx.translate(dw / 2, dh / 2);
  ctx.rotate((ops.rotate * Math.PI) / 180);
  ctx.scale(ops.flipH ? -1 : 1, ops.flipV ? -1 : 1);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image.el, -uw / 2, -uh / 2, uw, uh);
  ctx.restore();
}

const toPx = (crop) => ({
  x: crop.x * state.view.dw,
  y: crop.y * state.view.dh,
  w: crop.w * state.view.dw,
  h: crop.h * state.view.dh,
});

const toNorm = (rect) => ({
  x: rect.x / state.view.dw,
  y: rect.y / state.view.dh,
  w: rect.w / state.view.dw,
  h: rect.h / state.view.dh,
});

function placeCropBox() {
  const ops = currentOps();
  const box = $('crop-box');
  const { dw, dh } = state.view;

  if (!ops || !ops.crop || !dw || !dh) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const rect = toPx(ops.crop);
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.w}px`;
  box.style.height = `${rect.h}px`;
}

/** 拖动期间只更新遮挡框和读数，不重绘整张画面 */
function renderLight() {
  placeCropBox();
  updateChrome();
  const now = performance.now();
  if (now - state.lastPaint > 90) {
    state.lastPaint = now;
    paintShots();
  }
}

function scheduleRender() {
  if (state.rafPending) return;
  state.rafPending = true;
  requestAnimationFrame(() => {
    state.rafPending = false;
    if (state.drag) renderLight();
    else { drawStage(); paintShots(); updateChrome(); }
  });
}

/* -------------------------------------------------------- 缩略图绘制 */

function paintShots() {
  for (const image of state.images) {
    if (image.canvas && state.ops[image.name]) paintShot(image);
  }
}

function paintShot(image) {
  const canvas = image.canvas;
  if (!canvas) return;

  const ops = state.ops[image.name];
  const dpr = window.devicePixelRatio || 1;
  const k = ((canvas.clientWidth || THUMB_W * 1.3) / THUMB_W) * dpr;

  const bw = Math.round(THUMB_W * k);
  const bh = Math.round(THUMB_H * k);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  ctx.fillStyle = '#0B0A08';
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);

  if (!image.el || !image.el.naturalWidth) return;

  const view = viewSizeOf(image, ops);
  const scale = Math.min(THUMB_W / view.w, THUMB_H / view.h);
  const dw = view.w * scale;
  const dh = view.h * scale;
  const ox = (THUMB_W - dw) / 2;
  const oy = (THUMB_H - dh) / 2;

  const uw = image.width * scale;
  const uh = image.height * scale;

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, dw, dh);
  ctx.clip();
  ctx.translate(ox + dw / 2, oy + dh / 2);
  ctx.rotate((ops.rotate * Math.PI) / 180);
  ctx.scale(ops.flipH ? -1 : 1, ops.flipV ? -1 : 1);
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(image.el, -uw / 2, -uh / 2, uw, uh);
  ctx.restore();

  const crop = ops.crop;
  if (!crop) return;

  const x = ox + crop.x * dw;
  const y = oy + crop.y * dh;
  const w = crop.w * dw;
  const h = crop.h * dh;

  ctx.fillStyle = 'rgba(8, 7, 5, .68)';
  ctx.fillRect(ox, oy, dw, y - oy);
  ctx.fillRect(ox, y + h, dw, oy + dh - (y + h));
  ctx.fillRect(ox, y, x - ox, h);
  ctx.fillRect(x + w, y, ox + dw - (x + w), h);

  ctx.strokeStyle = '#E8A33D';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(x + 0.7, y + 0.7, Math.max(1, w - 1.4), Math.max(1, h - 1.4));
}

/* ------------------------------------------------------------ 界面同步 */

function updateChrome() {
  const image = currentImage();
  const ops = currentOps();
  const ready = !!image && !!ops;

  $('btn-export').disabled = !ready;
  $('count').textContent = state.images.length
    ? `共 ${state.images.length} 张 · 第 ${state.current + 1} 张`
    : '还没有选择图片';

  for (const [index, item] of state.images.entries()) {
    item.shot.classList.toggle('is-active', index === state.current);
    const tweaked = state.applied !== null && opsKey(state.ops[item.name]) !== state.applied;
    let dot = item.shot.querySelector('.shot-tweaked');
    if (tweaked && !dot) {
      dot = document.createElement('span');
      dot.className = 'shot-tweaked';
      dot.title = '这张图被单独调整过';
      item.shot.appendChild(dot);
    } else if (!tweaked && dot) {
      dot.remove();
    }
  }

  for (const chip of $('ratios').children) {
    chip.classList.toggle('is-active', ready && chip.dataset.ratio === ops.ratio);
  }

  const tweakedCount = state.applied === null
    ? 0
    : state.images.filter((item) => opsKey(state.ops[item.name]) !== state.applied).length;
  $('scope-note').textContent = tweakedCount
    ? `改动只作用于当前这张图。已有 ${tweakedCount} 张被单独调整过。`
    : '改动只作用于当前这张图。';

  updateReadouts();
}

function updateReadouts() {
  const image = currentImage();
  const ops = currentOps();
  if (!image || !ops) {
    $('readout-crop').textContent = '—';
    $('readout-size').textContent = '—';
    return;
  }

  const view = viewSizeOf(image, ops);
  const crop = ops.crop || { x: 0, y: 0, w: 1, h: 1 };

  // 与后端一致：先取整四条边再相减，读数才能和实际导出对上
  const left = clamp(Math.round(crop.x * view.w), 0, view.w - 1);
  const top = clamp(Math.round(crop.y * view.h), 0, view.h - 1);
  const right = clamp(Math.round((crop.x + crop.w) * view.w), left + 1, view.w);
  const bottom = clamp(Math.round((crop.y + crop.h) * view.h), top + 1, view.h);
  let w = right - left;
  let h = bottom - top;

  const resize = currentOutput().resize;
  if (resize.mode === 'long_edge' && resize.value > 0) {
    const scale = resize.value / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  } else if (resize.mode === 'exact') {
    w = resize.width;
    h = resize.height;
  }

  $('readout-crop').textContent = `${Math.round(crop.w * 100)}% × ${Math.round(crop.h * 100)}%`;
  $('readout-size').textContent = `${w} × ${h} px`;
}

function currentOutput() {
  const format = $('out-format').value;
  const quality = Number($('out-quality').value) || 92;
  const mode = $('out-resize-mode').value;
  const resize = {
    mode,
    value: Number($('out-long-edge').value) || 0,
    width: Number($('out-width').value) || 0,
    height: Number($('out-height').value) || 0,
  };
  return { format, quality, resize };
}

/* -------------------------------------------------------------- 拖动 */

function onPointerDown(event) {
  const ops = currentOps();
  if (!ops) return;

  const layer = $('crop-layer');
  const rect = layer.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;

  const handle = event.target.dataset && event.target.dataset.handle;
  const onBox = !handle && (event.target === $('crop-box') || event.target.classList.contains('grid'));

  event.preventDefault();
  try { layer.setPointerCapture(event.pointerId); } catch { /* 指针已失效时忽略 */ }

  if (handle) {
    state.drag = { mode: 'resize', handle, start: toPx(ops.crop), originX: px, originY: py };
  } else if (onBox) {
    state.drag = { mode: 'move', start: toPx(ops.crop), originX: px, originY: py };
  } else {
    state.drag = { mode: 'create', originX: px, originY: py, previous: { ...ops.crop }, moved: false };
  }

  $('crop-box').classList.add('is-dragging');
}

function onPointerMove(event) {
  const drag = state.drag;
  if (!drag) return;

  const layer = $('crop-layer');
  const rect = layer.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const dx = px - drag.originX;
  const dy = py - drag.originY;

  const ops = currentOps();
  const { dw, dh } = state.view;
  const ratio = RATIOS[ops.ratio] || null;

  let next;
  if (drag.mode === 'move') {
    next = {
      x: clamp(drag.start.x + dx, 0, dw - drag.start.w),
      y: clamp(drag.start.y + dy, 0, dh - drag.start.h),
      w: drag.start.w,
      h: drag.start.h,
    };
  } else if (drag.mode === 'resize') {
    next = resizeRect(drag.start, dx, dy, drag.handle, ratio, dw, dh);
  } else {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    next = createRect(drag.originX, drag.originY, px, py, ratio, dw, dh);
  }

  ops.crop = toNorm(next);
  scheduleRender();
}

function onPointerUp(event) {
  const drag = state.drag;
  if (!drag) return;

  const ops = currentOps();
  if (drag.mode === 'create' && !drag.moved && ops) {
    ops.crop = drag.previous;   // 只是点了一下，不算重新框选
  }

  state.drag = null;
  $('crop-box').classList.remove('is-dragging');
  if ($('crop-layer').hasPointerCapture(event.pointerId)) {
    $('crop-layer').releasePointerCapture(event.pointerId);
  }

  drawStage();
  paintShots();
  updateChrome();
}

function resizeRect(start, dx, dy, handle, ratio, dw, dh) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;

  if (handle.includes('w')) left = clamp(start.x + dx, 0, right - MIN_SIZE);
  if (handle.includes('e')) right = clamp(start.x + start.w + dx, left + MIN_SIZE, dw);
  if (handle.includes('n')) top = clamp(start.y + dy, 0, bottom - MIN_SIZE);
  if (handle.includes('s')) bottom = clamp(start.y + start.h + dy, top + MIN_SIZE, dh);

  if (ratio) {
    let w = right - left;
    let h = bottom - top;

    if (handle.length === 2) {          // 四角：按较大的那个方向定比例
      if (w / h > ratio) w = h * ratio;
      else h = w / ratio;
    } else if (handle === 'n' || handle === 's') {
      w = h * ratio;
    } else {
      h = w / ratio;
    }

    // 以被拖动边的对角为锚点回推
    const anchorRight = handle.includes('w');
    const anchorBottom = handle.includes('n');
    left = anchorRight ? right - w : left;
    top = anchorBottom ? bottom - h : top;
    right = left + w;
    bottom = top + h;

    if (left < 0 || top < 0 || right > dw || bottom > dh) {
      const k = Math.min(1, dw / w, dh / h);
      w *= k;
      h *= k;
      left = anchorRight ? right - w : left;
      top = anchorBottom ? bottom - h : top;
      right = left + w;
      bottom = top + h;
      left = clamp(left, 0, dw);
      top = clamp(top, 0, dh);
      right = clamp(right, 0, dw);
      bottom = clamp(bottom, 0, dh);
    }
  }

  return {
    x: left,
    y: top,
    w: Math.max(MIN_SIZE, right - left),
    h: Math.max(MIN_SIZE, bottom - top),
  };
}

function createRect(x0, y0, x1, y1, ratio, dw, dh) {
  let left = clamp(Math.min(x0, x1), 0, dw);
  let right = clamp(Math.max(x0, x1), 0, dw);
  let top = clamp(Math.min(y0, y1), 0, dh);
  let bottom = clamp(Math.max(y0, y1), 0, dh);

  let w = Math.max(MIN_SIZE, right - left);
  let h = Math.max(MIN_SIZE, bottom - top);

  if (ratio) {
    h = w / ratio;
    if (h > dh) { h = dh; w = h * ratio; }
    if (w > dw) { w = dw; h = w / ratio; }
  }

  return {
    x: clamp(left, 0, Math.max(0, dw - w)),
    y: clamp(top, 0, Math.max(0, dh - h)),
    w,
    h,
  };
}

/* ---------------------------------------------------------- 面板操作 */

function setRatio(key) {
  const image = currentImage();
  const ops = currentOps();
  if (!image || !ops) return;

  ops.ratio = key;
  const view = viewSizeOf(image, ops);
  ops.crop = fitRatio(ops.crop, RATIOS[key], view.w, view.h);

  drawStage();
  paintShots();
  updateChrome();
}

function rotate(clockwise) {
  const image = currentImage();
  const ops = currentOps();
  if (!image || !ops) return;

  ops.rotate = ((ops.rotate + (clockwise ? 90 : 270)) % 360 + 360) % 360;
  ops.crop = rotateCrop(ops.crop, clockwise);

  drawStage();
  paintShots();
  updateChrome();
}

function flip(axis) {
  const ops = currentOps();
  if (!ops) return;

  if (axis === 'h') {
    ops.flipH = !ops.flipH;
    ops.crop.x = 1 - (ops.crop.x + ops.crop.w);
  } else {
    ops.flipV = !ops.flipV;
    ops.crop.y = 1 - (ops.crop.y + ops.crop.h);
  }

  drawStage();
  paintShots();
  updateChrome();
}

function applyToAll() {
  const ops = currentOps();
  if (!ops) return;

  const snapshot = serializeOps(ops);
  const template = JSON.parse(JSON.stringify(ops));
  for (const image of state.images) state.ops[image.name] = JSON.parse(JSON.stringify(template));

  state.applied = JSON.stringify(snapshot);

  paintShots();
  updateChrome();
  setStatus('ok', `已把当前参数应用到全部 ${state.images.length} 张图片。`);
}

function resetCurrent() {
  const image = currentImage();
  if (!image) return;

  state.ops[image.name] = defaultOps();
  drawStage();
  paintShots();
  updateChrome();
}

/* -------------------------------------------------------------- 导出 */

async function exportAll() {
  const image = currentImage();
  if (!image) return;

  const ops = {};
  for (const item of state.images) ops[item.name] = serializeOps(state.ops[item.name]);

  const button = $('btn-export');
  button.disabled = true;
  setStatus('busy', `正在处理 ${state.images.length} 张图片…`);

  try {
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: state.session, ops, output: currentOutput() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.description || '处理失败');

    const failed = (data.results || []).filter((item) => item.status !== 'ok');

    if (!data.ok) {
      setStatus('error', '全部图片都处理失败了', failed.map((f) => `${f.name}：${f.error}`).join('\n'));
    } else if (failed.length) {
      setStatus(
        'error',
        `处理完成：成功 ${data.ok} 张，失败 ${failed.length} 张，耗时 ${data.elapsed} 秒。`,
        failed.map((f) => `${f.name}：${f.error}`).join('\n'),
        { label: '下载结果 ZIP', href: data.download },
      );
    } else {
      setStatus(
        'ok',
        `处理完成：${data.ok} 张全部成功，耗时 ${data.elapsed} 秒。`,
        null,
        { label: '下载结果 ZIP', href: data.download },
      );
    }
  } catch (error) {
    setStatus('error', '处理失败', String(error.message || error));
  } finally {
    button.disabled = false;
  }
}

/* -------------------------------------------------------------- 状态条 */

function setStatus(kind, title, detail, action) {
  const box = $('status');
  box.hidden = false;
  box.className = `status status-${kind}`;
  box.replaceChildren();

  const heading = document.createElement('p');
  heading.className = 'status-title';
  heading.textContent = title;
  box.appendChild(heading);

  if (detail) {
    const list = document.createElement('ul');
    for (const line of String(detail).split('\n').filter(Boolean).slice(0, 8)) {
      const item = document.createElement('li');
      item.textContent = line;
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  if (action) {
    const link = document.createElement('a');
    link.className = 'btn btn-primary';
    link.href = action.href;
    link.textContent = action.label;
    box.appendChild(link);
  }
}

function hideStatus() {
  $('status').hidden = true;
}

/* -------------------------------------------------------------- 绑定 */

function bind() {
  $('file-input').addEventListener('change', (event) => {
    upload(event.target.files);
    event.target.value = '';
  });

  $('ratios').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip) setRatio(chip.dataset.ratio);
  });

  $('btn-rot-cw').addEventListener('click', () => rotate(true));
  $('btn-rot-ccw').addEventListener('click', () => rotate(false));
  $('btn-flip-h').addEventListener('click', () => flip('h'));
  $('btn-flip-v').addEventListener('click', () => flip('v'));
  $('btn-apply-all').addEventListener('click', applyToAll);
  $('btn-reset-one').addEventListener('click', resetCurrent);
  $('btn-export').addEventListener('click', exportAll);

  const layer = $('crop-layer');
  layer.addEventListener('pointerdown', onPointerDown);
  layer.addEventListener('pointermove', onPointerMove);
  layer.addEventListener('pointerup', onPointerUp);
  layer.addEventListener('pointercancel', onPointerUp);

  $('out-quality').addEventListener('input', () => {
    $('quality-value').textContent = $('out-quality').value;
  });

  const syncOutputFields = () => {
    const mode = $('out-resize-mode').value;
    $('field-long-edge').hidden = mode !== 'long_edge';
    $('field-exact').hidden = mode !== 'exact';
    $('field-quality').hidden = $('out-format').value === 'png';
    updateReadouts();
  };

  $('out-format').addEventListener('change', syncOutputFields);
  $('out-resize-mode').addEventListener('change', syncOutputFields);
  for (const id of ['out-long-edge', 'out-width', 'out-height']) {
    $(id).addEventListener('input', updateReadouts);
  }

  // 拖拽文件到窗口任意位置
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer && event.dataTransfer.files.length) upload(event.dataTransfer.files);
  });

  window.addEventListener('resize', () => {
    if (currentImage()) drawStage();
    paintShots();
  });

  syncOutputFields();
}

bind();
