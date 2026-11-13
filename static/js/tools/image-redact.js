/* ==========================================================================
   图片打码（image-redact）

   在图上框出几块，把这几块盖住 —— 马赛克、模糊、纯色都行。
   图片一个字节都不出浏览器。

   三套坐标，别弄混：
     - 源图像素：解码出来的原图。**打码区域一律用它存**。
     - 画布像素：预览画布（缩小了）与导出画布（原尺寸）。
     - 屏幕像素：鼠标点的位置。

   **区域存源图像素**是这套工具的关键：预览和导出用的是同一份区域数据，
   只是画的时候乘了不同的缩放系数。这样「预览里框住的那块」和
   「导出图里盖住的那块」一定是同一块，不会各算各的。

   三种盖法：
     - 马赛克：每块的颜色是自己算的**严格盒式平均**（浏览器的缩放滤波会串色），
       块的大小用**源像素**。
     - 模糊：把区域连同外面一圈上下文取下来，手写三趟盒式模糊，再贴回去。
     - 纯色：直接涂。

   模糊为什么不用 ctx.filter：仓库里没有这个 API（image-filters 也是手写的）。
   也不用 image-filters 的引擎 —— 那是**整图**处理器，拿不到「只处理某个矩形」的概念；
   而且 ItTools.logic 里别的工具在 jsdom 的 harness 里是 undefined，跨文件调用会炸。
   自己写的那份见下面 blurPixels 的注释。

   选框**不进导出**：打码只有一条入口 applyRedactions，预览和导出共用它；
   画选框的 drawFrames 只有预览调用。靠调用图保证，不靠「记得关掉某个开关」。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-redact');

  /** 预览画布的最长边 —— 预览只是给人看的，没必要按原图像素开画布。 */
  var PREVIEW_MAX = 900;

  /** 浏览器画布的上限：每边 32767、总面积 268435456（约 2.68 亿像素）。 */
  var MAX_CANVAS_SIDE = 32767;
  var MAX_CANVAS_AREA = 268435456;

  /** 手柄在屏幕上多大（屏幕像素）。命中判定也是按这个尺寸换算成源图像素。 */
  var HANDLE_PX = 8;

  /** 模糊跑几趟。三趟盒式模糊叠起来接近高斯，单趟会看出方块状的台阶。 */
  var BLUR_PASSES = 3;

  /**
   * 模糊缓冲区最多多少像素。
   *
   * 浮点缓冲是 RGBA 四个通道各一个 float，1 M 像素就是 16 MB，
   * 两份（乒乓用）就是 32 MB。给个上限，超了先把那块缩小再糊。
   */
  var BLUR_BUDGET = 1000000;

  /**
   * 拖动时的模糊预算 —— 只有静止下来才用完整的预算。
   *
   * 拖框的时候每帧都要重画，模糊块也得跟着重算；
   * 先用小一点的预算跟上手，停下来再算清楚的那份。
   */
  var BLUR_BUDGET_DRAG = 250000;

  /**
   * 马赛克取色时一次最多读多少像素。
   *
   * 每块的颜色要**严格盒式平均**（自己算，不用浏览器的缩放），
   * 所以得把区域的像素读出来 —— 4 M 像素就是 16 MB。
   * 超了先把区域缩到这个上限以内再读（那种情况下块的颜色是缩过之后的平均，
   * 肉眼看不出来，块的大小也还是用户设的那个）。
   */
  var MOSAIC_MAX_PIXELS = 4 * 1024 * 1024;

  /** 马赛克块的默认值（源图像素）。 */
  var DEFAULT_BLOCK = 12;

  /** 模糊半径的默认值（源图像素）。 */
  var DEFAULT_RADIUS = 14;

  /** 区域小于这么多个源像素就当误触，丢掉。 */
  var MIN_REGION = 4;

  var S = {
    title: t('title', 'Cover parts of a picture with a mosaic, a blur or a solid colour'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The picture is processed in your browser, nothing is uploaded.'),
    status_reading: t('status_reading', 'Reading the file…'),
    regions_title: t('regions_title', 'Redacted areas'),
    hint_regions: t('hint_regions', 'Drag on the picture to mark an area. Each area can be a mosaic, a blur or a solid colour.'),
    no_regions: t('no_regions', 'No area marked yet. Drag on the picture to mark one.'),
    label_mode: t('label_mode', 'Mode'),
    mode_mosaic: t('mode_mosaic', 'Mosaic'),
    mode_blur: t('mode_blur', 'Blur'),
    mode_fill: t('mode_fill', 'Solid colour'),
    btn_delete: t('btn_delete', 'Delete'),
    btn_clear: t('btn_clear', 'Remove all the areas'),
    settings_title: t('settings_title', 'Settings'),
    label_block: t('label_block', 'Block size'),
    hint_block: t('hint_block', 'How big one mosaic block is, in pixels of the original picture.'),
    label_radius: t('label_radius', 'Blur radius'),
    hint_radius: t('hint_radius', 'How far the blur spreads, in pixels of the original picture.'),
    label_colour: t('label_colour', 'Colour'),
    hint_colour: t('hint_colour', 'The colour the solid areas are painted with.'),
    label_frames: t('label_frames', 'Show the frames'),
    preview_title: t('preview_title', 'Picture'),
    hint_preview: t('hint_preview', 'The picture is scaled down, but the areas are measured on the original picture.'),
    label_format: t('label_format', 'Output format'),
    label_quality: t('label_quality', 'Quality'),
    hint_quality: t('hint_quality', 'PNG is lossless — the quality setting does not change it.'),
    result_title: t('result_title', 'Result'),
    label_source_size: t('label_source_size', 'Original size'),
    label_count: t('label_count', 'Areas'),
    label_output_size: t('label_output_size', 'Output size'),
    label_file_size: t('label_file_size', 'File size'),
    label_output_format: t('label_output_format', 'Saved as'),
    no_result: t('no_result', 'Nothing exported yet. Use the button below to make a copy.'),
    btn_export: t('btn_export', 'Create the redacted copy'),
    btn_download: t('btn_download', 'Download the redacted picture'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    err_canvas_limit: t('err_canvas_limit', 'A browser canvas cannot hold {width} × {height} pixels (the limit is {max} pixels per side and {area} megapixels in total), so nothing was encoded.'),
    err_no_picture: t('err_no_picture', 'There is no picture yet. Choose one first.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.')
  };

  /* ---------- 纯逻辑（给 harness 用，也在下面被界面用） ---------- */

  /**
   * 把区域夹进图里。
   *
   * 越界往里挪，超出图的尺寸砍掉 —— 区域永远得在图里面。
   *
   * @param {object} rect {x, y, width, height}
   * @param {{width: number, height: number}} bounds 原图尺寸
   * @param {number} minSize 最小边长
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  function clampRect(rect, bounds, minSize) {
    var limitW = Math.max(1, Math.round(Number(bounds && bounds.width) || 1));
    var limitH = Math.max(1, Math.round(Number(bounds && bounds.height) || 1));
    var min = Math.max(1, Math.round(Number(minSize) || 1));

    var width = Math.round(Number(rect && rect.width) || 0);
    var height = Math.round(Number(rect && rect.height) || 0);
    if (width < min) width = min;
    if (height < min) height = min;
    if (width > limitW) width = limitW;
    if (height > limitH) height = limitH;

    var x = Math.round(Number(rect && rect.x) || 0);
    var y = Math.round(Number(rect && rect.y) || 0);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + width > limitW) x = limitW - width;
    if (y + height > limitH) y = limitH - height;
    return { x: x, y: y, width: width, height: height };
  }

  /**
   * 点在不在这个区域里（严格在内部，边界不算）。
   *
   * @param {object} rect
   * @param {number} px
   * @param {number} py
   * @returns {boolean}
   */
  function insideRect(rect, px, py) {
    if (!rect) return false;
    return px > rect.x && px < rect.x + rect.width &&
      py > rect.y && py < rect.y + rect.height;
  }

  /**
   * 命中测试：点在区域里还是在线上？该用哪个手柄拖？
   *
   * 角优先于边，边优先于框里 —— 角上的点总是想拖角。
   *
   * @param {object} rect {x, y, width, height}
   * @param {number} px 源图横坐标
   * @param {number} py 源图纵坐标
   * @param {number} tolX 横向容差（源图像素）
   * @param {number} tolY 纵向容差（源图像素）
   * @returns {string|null} 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'move'|null
   */
  function hitTest(rect, px, py, tolX, tolY) {
    if (!rect) return null;
    var tx = Math.max(0, Number(tolX) || 0);
    var ty = Math.max(0, Number(tolY) || 0);
    var x0 = rect.x;
    var y0 = rect.y;
    var x2 = rect.x + rect.width;
    var y2 = rect.y + rect.height;

    // 四个角
    if (Math.abs(px - x0) <= tx && Math.abs(py - y0) <= ty) return 'nw';
    if (Math.abs(px - x2) <= tx && Math.abs(py - y0) <= ty) return 'ne';
    if (Math.abs(px - x2) <= tx && Math.abs(py - y2) <= ty) return 'se';
    if (Math.abs(px - x0) <= tx && Math.abs(py - y2) <= ty) return 'sw';
    // 四条边（边中段，别跟角抢）
    if (Math.abs(py - y0) <= ty && px > x0 && px < x2) return 'n';
    if (Math.abs(px - x2) <= tx && py > y0 && py < y2) return 'e';
    if (Math.abs(py - y2) <= ty && px > x0 && px < x2) return 's';
    if (Math.abs(px - x0) <= tx && py > y0 && py < y2) return 'w';
    // 框里 —— 移动
    if (px > x0 && px < x2 && py > y0 && py < y2) return 'move';
    return null;
  }

  /**
   * 命中的到底是什么。
   *
   * 先看当前选中的区域：它的角和边优先，它里面是「移动」。
   * 再看别的区域：里面就是「移动这个区域」。
   * 都没有 —— 那就是「画一个新区域」。
   *
   * @param {Array} rects 区域列表
   * @param {number} activeIndex 当前选中的区域（-1 表示没有）
   * @param {number} px 源图横坐标
   * @param {number} py 源图纵坐标
   * @param {number} tolX 横向容差（源图像素）
   * @param {number} tolY 纵向容差（源图像素）
   * @returns {{kind: string, index: number, handle: string}} kind: 'handle'|'move'|'new'
   */
  function pickTarget(rects, activeIndex, px, py, tolX, tolY) {
    var list = rects || [];
    var i;
    if (activeIndex >= 0 && activeIndex < list.length) {
      var h = hitTest(list[activeIndex], px, py, tolX, tolY);
      if (h === 'move') return { kind: 'move', index: activeIndex, handle: '' };
      if (h) return { kind: 'handle', index: activeIndex, handle: h };
    }
    // 列表里靠后的画在上面，所以从后往前找
    for (i = list.length - 1; i >= 0; i--) {
      if (i === activeIndex) continue;
      if (insideRect(list[i], px, py)) return { kind: 'move', index: i, handle: '' };
    }
    return { kind: 'new', index: -1, handle: '' };
  }

  /**
   * 拖动之后区域变成什么样。
   *
   * 锚点是「不动的那条边或那个角」：
   * 角 → 对角不动；边 → 对边不动；整体移动 → 尺寸不变，只挪位置。
   *
   * @param {object} rect 拖动前的区域
   * @param {string} handle 手柄（'move' 或某个角/边的名字）
   * @param {number} dx 横向拖了多少（源图像素）
   * @param {number} dy 纵向拖了多少（源图像素）
   * @param {{width: number, height: number}} bounds 原图尺寸
   * @returns {object} 新的区域
   */
  function resizeRect(rect, handle, dx, dy, bounds) {
    if (!rect) return null;
    var limitW = Math.max(1, Math.round(Number(bounds && bounds.width) || 1));
    var limitH = Math.max(1, Math.round(Number(bounds && bounds.height) || 1));
    var x0 = rect.x;
    var y0 = rect.y;
    var x2 = x0 + rect.width;
    var y2 = y0 + rect.height;
    var mx = Number(dx) || 0;
    var my = Number(dy) || 0;

    if (handle === 'move') {
      return clampRect({ x: x0 + mx, y: y0 + my, width: rect.width, height: rect.height }, bounds, 1);
    }

    var nx0 = x0;
    var ny0 = y0;
    var nx1 = x2;
    var ny1 = y2;
    if (handle.indexOf('w') >= 0) nx0 = Math.min(x2 - 1, x0 + mx);
    if (handle.indexOf('e') >= 0) nx1 = Math.max(x0 + 1, x2 + mx);
    if (handle.indexOf('n') >= 0) ny0 = Math.min(y2 - 1, y0 + my);
    if (handle.indexOf('s') >= 0) ny1 = Math.max(y0 + 1, y2 + my);

    // 夹进图里：先夹住起点，再保证边长至少 1
    nx0 = Math.max(0, Math.min(nx0, limitW - 1));
    ny0 = Math.max(0, Math.min(ny0, limitH - 1));
    nx1 = Math.max(nx0 + 1, Math.min(nx1, limitW));
    ny1 = Math.max(ny0 + 1, Math.min(ny1, limitH));
    return {
      x: Math.round(nx0),
      y: Math.round(ny0),
      width: Math.round(nx1 - nx0),
      height: Math.round(ny1 - ny0)
    };
  }

  /**
   * 马赛克的网格。
   *
   * 块边长是**源像素**，不是预览像素，也不是输出画布像素 ——
   * 导出图永远是原分辨率，块多大必须按原图算。
   *
   * cols 用 ceil 而不是 round：保证块**不超过** B（用户要 8 像素的块，
   * 别给成 12 像素）。代价是实际块边长落在 (B/2, B] 之间。
   *
   * @param {object} rect 区域（源图像素）
   * @param {number} block 块边长（源图像素）
   * @returns {{cols: number, rows: number, cellW: number, cellH: number}}
   */
  function mosaicPlan(rect, block) {
    var B = Math.max(1, Math.round(Number(block) || 1));
    var w = Math.max(1, Math.round(Number(rect && rect.width) || 1));
    var h = Math.max(1, Math.round(Number(rect && rect.height) || 1));
    var cols = Math.max(1, Math.ceil(w / B));
    var rows = Math.max(1, Math.ceil(h / B));
    return { cols: cols, rows: rows, cellW: w / cols, cellH: h / rows };
  }

  /**
   * 模糊要用的上下文半径。
   *
   * 一维半径 q 的盒式模糊支撑是 ±q；竖着糊一遍、横着糊一遍算一趟，
   * 三趟之后支撑是 ±3q。所以取这块的时候要多留 3q 像素在外面 ——
   * 没有它们，区域边上算出来的是「把边缘像素无限延拓」的结果，
   * 看上去是一圈生硬的边。
   *
   * @param {number} radius 半径（源图像素）
   * @returns {number}
   */
  function blurHalo(radius) {
    var q = Math.max(0, Math.round(Number(radius) || 0));
    return BLUR_PASSES * q;
  }

  /**
   * 把下标夹进 [0, n-1]。
   *
   * @param {number} i
   * @param {number} n
   * @returns {number}
   */
  function clampIdx(i, n) {
    if (i < 0) return 0;
    if (i >= n) return n - 1;
    return i;
  }

  /**
   * 一维盒式模糊（滑窗）。
   *
   * 越界的下标取数组边缘那个像素 —— 这就是「把图按边缘像素无限延拓」。
   *
   * 为什么每一趟都重新夹下标而不是先把数组延拓好：
   * 一趟（先横后竖）等价于「两个方向各自延拓一次再卷积」——
   * 横向那一趟夹下标 = 横向延拓，纵向那一趟夹下标 = 纵向延拓，
   * 两者合起来正好是二维延拓。所以每一趟各自夹，结果就是对的。
   *
   * 滑窗：每前进一步减掉左边那个、加上右边那个，所以是 O(n)，
   * 跟半径多大没关系。
   *
   * @param {Float32Array} src
   * @param {number} n 元素个数
   * @param {number} q 半径
   * @param {Float32Array} dst 写进哪个数组
   */
  function boxBlur1d(src, n, q, dst) {
    var i, k, sum;
    if (q <= 0) {
      for (i = 0; i < n; i++) dst[i] = src[i];
      return;
    }
    var win = 2 * q + 1;
    sum = 0;
    for (k = -q; k <= q; k++) sum += src[clampIdx(k, n)];
    for (i = 0; i < n; i++) {
      dst[i] = sum / win;
      sum -= src[clampIdx(i - q, n)];
      sum += src[clampIdx(i + q + 1, n)];
    }
  }

  /**
   * 竖着糊一遍（每一列独立）。
   *
   * **四个通道各自糊。**
   * 曾经这里只累加红通道、再把同一个值写进四个通道 —— 看着像糊了，
   * 其实是把 alpha 也变成了「红色的模糊值」：黑的地方 alpha 变 0，
   * 糊完盖上去是**透明**的，原图又从底下露了出来，看着「好像没糊」。
   *
   * @param {Float32Array} src
   * @param {Float32Array} dst
   * @param {number} w
   * @param {number} h
   * @param {number} q 半径
   */
  function blurRows(src, dst, w, h, q) {
    var win = 2 * q + 1;
    var x, y, k, c, o, sIn, sOut;
    // 用双精度累加：滑窗要减很多次，单精度会攒出可见的误差
    var sums = new Float64Array(4);
    for (x = 0; x < w; x++) {
      sums[0] = 0; sums[1] = 0; sums[2] = 0; sums[3] = 0;
      for (k = -q; k <= q; k++) {
        var s = (clampIdx(k, h) * w + x) * 4;
        sums[0] += src[s];
        sums[1] += src[s + 1];
        sums[2] += src[s + 2];
        sums[3] += src[s + 3];
      }
      for (y = 0; y < h; y++) {
        o = (y * w + x) * 4;
        dst[o] = sums[0] / win;
        dst[o + 1] = sums[1] / win;
        dst[o + 2] = sums[2] / win;
        dst[o + 3] = sums[3] / win;
        sIn = (clampIdx(y - q, h) * w + x) * 4;
        sOut = (clampIdx(y + q + 1, h) * w + x) * 4;
        sums[0] += src[sOut] - src[sIn];
        sums[1] += src[sOut + 1] - src[sIn + 1];
        sums[2] += src[sOut + 2] - src[sIn + 2];
        sums[3] += src[sOut + 3] - src[sIn + 3];
      }
    }
  }

  /**
   * 横着糊一遍（每一行独立）。
   *
   * @param {Float32Array} src
   * @param {Float32Array} dst
   * @param {number} w
   * @param {number} h
   * @param {number} q 半径
   */
  function blurCols(src, dst, w, h, q) {
    var win = 2 * q + 1;
    var y, x, k, c, base, o, sIn, sOut;
    var sums = new Float64Array(4);
    for (y = 0; y < h; y++) {
      base = y * w;
      sums[0] = 0; sums[1] = 0; sums[2] = 0; sums[3] = 0;
      for (k = -q; k <= q; k++) {
        var s = (base + clampIdx(k, w)) * 4;
        sums[0] += src[s];
        sums[1] += src[s + 1];
        sums[2] += src[s + 2];
        sums[3] += src[s + 3];
      }
      for (x = 0; x < w; x++) {
        o = (base + x) * 4;
        dst[o] = sums[0] / win;
        dst[o + 1] = sums[1] / win;
        dst[o + 2] = sums[2] / win;
        dst[o + 3] = sums[3] / win;
        sIn = (base + clampIdx(x - q, w)) * 4;
        sOut = (base + clampIdx(x + q + 1, w)) * 4;
        sums[0] += src[sOut] - src[sIn];
        sums[1] += src[sOut + 1] - src[sIn + 1];
        sums[2] += src[sOut + 2] - src[sIn + 2];
        sums[3] += src[sOut + 3] - src[sIn + 3];
      }
    }
  }

  /**
   * 三趟盒式模糊，跑在一份 RGBA 像素上（就地改）。
   *
   * 预乘：画布的内部存储是**预乘**的，全透明的像素里 RGB 其实是 0。
   * 直接平均四通道，透明处的黑色会渗到旁边，边缘发黑。
   * 所以先预乘（颜色乘上 alpha），模糊完再还原。
   *
   * @param {ImageData} imageData 要糊的像素（会被就地改写）
   * @param {number} radius 半径（这块的像素）
   * @returns {ImageData} 同一个对象
   */
  function blurPixels(imageData, radius) {
    var q = Math.max(0, Math.round(Number(radius) || 0));
    if (q <= 0) return imageData;
    var w = imageData.width;
    var h = imageData.height;
    var px = imageData.data;
    var n = w * h;
    var i, a;

    var buf = new Float32Array(n * 4);
    for (i = 0; i < n; i++) {
      a = px[i * 4 + 3];
      buf[i * 4] = px[i * 4] * a / 255;
      buf[i * 4 + 1] = px[i * 4 + 1] * a / 255;
      buf[i * 4 + 2] = px[i * 4 + 2] * a / 255;
      buf[i * 4 + 3] = a;
    }
    var tmp = new Float32Array(n * 4);
    for (var pass = 0; pass < BLUR_PASSES; pass++) {
      blurRows(buf, tmp, w, h, q);
      blurCols(tmp, buf, w, h, q);
    }
    for (i = 0; i < n; i++) {
      a = buf[i * 4 + 3];
      if (a <= 0) {
        px[i * 4] = 0;
        px[i * 4 + 1] = 0;
        px[i * 4 + 2] = 0;
        px[i * 4 + 3] = 0;
        continue;
      }
      px[i * 4] = buf[i * 4] * 255 / a;
      px[i * 4 + 1] = buf[i * 4 + 1] * 255 / a;
      px[i * 4 + 2] = buf[i * 4 + 2] * 255 / a;
      px[i * 4 + 3] = a;
    }
    return imageData;
  }

  /**
   * 目标尺寸是不是浏览器画布吃得下的。
   *
   * @param {number} w
   * @param {number} h
   * @returns {{ok: boolean, reason: string}} reason: '' | 'size' | 'side' | 'area'
   */
  function canvasLimit(w, h) {
    var width = Math.round(Number(w) || 0);
    var height = Math.round(Number(h) || 0);
    if (width <= 0 || height <= 0) return { ok: false, reason: 'size' };
    if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) return { ok: false, reason: 'side' };
    if (width * height > MAX_CANVAS_AREA) return { ok: false, reason: 'area' };
    return { ok: true, reason: '' };
  }

  /**
   * 把数字夹进 [min, max]。
   *
   * @param {*} value
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   */
  function clampInt(value, min, max, fallback) {
    var v = Math.round(Number(value));
    if (!isFinite(v)) v = fallback;
    if (v < min) v = min;
    if (v > max) v = max;
    return v;
  }

  /**
   * 十六进制颜色 → rgb。
   *
   * @param {string} hex
   * @returns {{r: number, g: number, b: number}}
   */
  function parseHex(hex) {
    var s = String(hex || '').trim().replace(/^#/, '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return { r: 0, g: 0, b: 0 };
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16)
    };
  }

  /**
   * 一个区域的模糊补丁。
   *
   * 补丁的分辨率跟着**区域**走，不是跟着整张图走：
   * 框一个小脸，就在原分辨率上糊；框整张图，才降到预算以内糊。
   *
   * @param {HTMLCanvasElement} src 源图画布（整张图的分辨率）
   * @param {number} srcW 源图宽
   * @param {number} srcH 源图高
   * @param {object} rect 区域（源图像素）
   * @param {number} radius 半径（源图像素）
   * @param {number} budget 缓冲区最多多少像素
   * @returns {{canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number}|null}
   *          canvas 里是糊过的那块，位置是 (x, y)（源图像素）
   */
  function buildBlurPatch(src, srcW, srcH, rect, radius, budget) {
    var q = Math.max(0, Math.round(Number(radius) || 0));
    if (q <= 0 || !src) return null;
    var halo = blurHalo(q);
    var px0 = Math.max(0, Math.floor(rect.x - halo));
    var py0 = Math.max(0, Math.floor(rect.y - halo));
    var px1 = Math.min(srcW, Math.ceil(rect.x + rect.width + halo));
    var py1 = Math.min(srcH, Math.ceil(rect.y + rect.height + halo));
    var pw = px1 - px0;
    var ph = py1 - py0;
    if (pw <= 0 || ph <= 0) return null;

    var cap = Math.max(1, Math.round(Number(budget) || BLUR_BUDGET));
    var f = 1;
    if (pw * ph > cap) f = Math.sqrt(cap / (pw * ph));
    var tw = Math.max(1, Math.round(pw * f));
    var th = Math.max(1, Math.round(ph * f));

    var tmp = document.createElement('canvas');
    tmp.width = tw;
    tmp.height = th;
    var tctx = tmp.getContext('2d');
    if (!tctx) return null;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    try {
      tctx.drawImage(src, px0, py0, pw, ph, 0, 0, tw, th);
    } catch (e) {
      return null;
    }
    var data;
    try {
      data = tctx.getImageData(0, 0, tw, th);
    } catch (e) {
      return null;
    }
    blurPixels(data, Math.max(1, Math.round(q * f)));
    tctx.putImageData(data, 0, 0);
    return { canvas: tmp, x: px0, y: py0, w: pw, h: ph };
  }

  /**
   * 每个块的颜色 = 严格盒式平均。
   *
   * 为什么不用浏览器的缩放来求平均：`drawImage` 的缩放滤波**不保证**是盒式平均。
   * 实测（headless Chrome）：`'high'` 是带负瓣的锐化滤波，一块的颜色会被
   * **左右相邻块的颜色渗进来**（6 列灰阶降成 6 格，第 6 格红得不够红）；
   * `'low'` 在缩放比是整数倍的时候碰巧等于盒式平均，比值一歪（比如 60→7）
   * 就退化成**取最近的一个像素**，一条细高亮线就能占满一整块。
   * 两种都不适合当打码 —— 前者会漏出区域外的颜色，后者会漏出区域内的细节。
   *
   * 所以自己算：块与块之间严格不重不漏（边界用 floor，所以相邻块共享一条边界，
   * 中间不留缝），一块里所有像素求和除以个数。
   *
   * 纯函数，不碰 canvas —— 可以直接单测。
   *
   * @param {{data: Uint8ClampedArray, w: number, h: number}} img 区域像素
   * @param {number} cols 块列数
   * @param {number} rows 块行数
   * @returns {Uint8ClampedArray} RGBA，每块 4 字节
   */
  function averageBlocks(img, cols, rows) {
    var data = img.data;
    var w = img.w;
    var h = img.h;
    var out = new Uint8ClampedArray(cols * rows * 4);
    var bx0 = new Int32Array(cols);
    var bx1 = new Int32Array(cols);
    var bx, by, x, y;

    // 每一列块的横向边界。相邻块首尾相接：一个像素只属于一块，不重不漏。
    for (bx = 0; bx < cols; bx++) {
      var x0 = Math.floor(bx * w / cols);
      var x1 = Math.floor((bx + 1) * w / cols);
      if (x0 > w - 1) x0 = Math.max(0, w - 1);
      if (x1 <= x0) x1 = Math.min(w, x0 + 1);
      bx0[bx] = x0;
      bx1[bx] = Math.min(w, x1);
    }

    for (by = 0; by < rows; by++) {
      var y0 = Math.floor(by * h / rows);
      var y1 = Math.floor((by + 1) * h / rows);
      if (y0 > h - 1) y0 = Math.max(0, h - 1);
      if (y1 <= y0) y1 = Math.min(h, y0 + 1);
      y1 = Math.min(h, y1);

      var base = by * cols * 4;
      for (bx = 0; bx < cols; bx++) {
        var sx = bx0[bx];
        var ex = bx1[bx];
        var r = 0;
        var g = 0;
        var b = 0;
        var n = 0;
        for (y = y0; y < y1; y++) {
          var o = (y * w + sx) * 4;
          for (x = sx; x < ex; x++) {
            r += data[o];
            g += data[o + 1];
            b += data[o + 2];
            o += 4;
          }
          n += ex - sx;
        }
        var p = base + bx * 4;
        out[p] = n ? Math.round(r / n) : 0;
        out[p + 1] = n ? Math.round(g / n) : 0;
        out[p + 2] = n ? Math.round(b / n) : 0;
        out[p + 3] = 255;
      }
    }
    return out;
  }

  /**
   * 取一个区域的像素。区域太大就先缩到上限以内。
   *
   * @param {HTMLCanvasElement} src 源图画布
   * @param {object} rect 区域（源图像素）
   * @returns {{data: Uint8ClampedArray, w: number, h: number}|null}
   */
  function sampleRegion(src, rect) {
    if (!src) return null;
    var sctx = src.getContext('2d');
    if (!sctx) return null;
    var w = Math.max(1, Math.round(Number(rect.width) || 1));
    var h = Math.max(1, Math.round(Number(rect.height) || 1));
    try {
      if (w * h <= MOSAIC_MAX_PIXELS) {
        var data = sctx.getImageData(rect.x, rect.y, w, h);
        return { data: data.data, w: w, h: h };
      }
      // 太大了：先缩到上限以内。这条路上块的颜色是缩过之后的平均，
      // 但块的**大小**还是用户设的那个（网格是按源像素算的）。
      var f = Math.sqrt(MOSAIC_MAX_PIXELS / (w * h));
      var sw = Math.max(1, Math.round(w * f));
      var sh = Math.max(1, Math.round(h * f));
      var tmp = document.createElement('canvas');
      tmp.width = sw;
      tmp.height = sh;
      var tctx = tmp.getContext('2d');
      if (!tctx) return null;
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'low';
      tctx.drawImage(src, rect.x, rect.y, w, h, 0, 0, sw, sh);
      var small = tctx.getImageData(0, 0, sw, sh);
      return { data: small.data, w: sw, h: sh };
    } catch (e) {
      return null;
    }
  }

  /**
   * 一个区域的马赛克补丁。
   *
   * @param {HTMLCanvasElement} src 源图画布
   * @param {object} rect 区域（源图像素）
   * @param {number} block 块边长（源图像素）
   * @returns {{canvas: HTMLCanvasElement, cols: number, rows: number}|null}
   */
  function buildMosaicPatch(src, rect, block) {
    if (!src) return null;
    var plan = mosaicPlan(rect, block);
    var shot = sampleRegion(src, rect);
    if (!shot) return null;
    var cells = averageBlocks(shot, plan.cols, plan.rows);
    var tmp = document.createElement('canvas');
    tmp.width = plan.cols;
    tmp.height = plan.rows;
    var tctx = tmp.getContext('2d');
    if (!tctx) return null;
    var img = tctx.createImageData(plan.cols, plan.rows);
    img.data.set(cells);
    tctx.putImageData(img, 0, 0);
    return { canvas: tmp, cols: plan.cols, rows: plan.rows };
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('image-redact', function (root) {
    var disposed = false;
    var state = {
      decoded: null,
      /** 原分辨率的源画布 —— 打码和导出都从这儿取像素。 */
      fullCanvas: null,
      name: '',
      width: 0,
      height: 0,
      regions: [],
      selected: -1,
      blockSize: DEFAULT_BLOCK,
      blurRadius: DEFAULT_RADIUS,
      fillColour: '#000000',
      showFrames: true,
      formatId: 'png',
      quality: 90,
      result: null
    };
    var previewScale = 1;
    var drag = null;
    /** 补丁缓存：区域序号 → {sig, patch}。 */
    var mosaicCache = {};
    var blurCache = {};

    /* ---------- 上传 ---------- */

    var upload = C.uploadCard({
      accept: 'image/*',
      label: S.choose_file,
      hint: S.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);

    var regionsCard = D.h('div.card', { hidden: true });
    var previewCard = D.h('div.card', { hidden: true });
    var settingsCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(regionsCard);
    root.appendChild(previewCard);
    root.appendChild(settingsCard);
    root.appendChild(resultCard);

    /* ---------- 区域列表 ---------- */

    var regionList = D.h('div.redact-list');
    var regionHint = D.h('p.field-hint', { text: S.hint_regions });
    var clearBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: S.btn_clear
    });
    regionsCard.appendChild(D.h('h3', { text: S.regions_title }));
    regionsCard.appendChild(regionList);
    regionsCard.appendChild(regionHint);
    regionsCard.appendChild(D.h('div.form-actions', null, clearBtn));

    /* ---------- 预览 ---------- */

    var previewCanvas = D.h('canvas.redact-canvas');
    previewCard.appendChild(D.h('h3', { text: S.preview_title }));
    previewCard.appendChild(D.h('div.preview-box', null, previewCanvas));
    previewCard.appendChild(D.h('p.field-hint', { text: S.hint_preview }));

    /* ---------- 设置 ---------- */

    var blockInput = D.h('input.layui-input.redact-block', {
      type: 'number', min: 1, max: 200, step: 1, value: state.blockSize
    });
    var radiusInput = D.h('input.layui-input.redact-radius', {
      type: 'number', min: 0, max: 100, step: 1, value: state.blurRadius
    });
    var colourInput = D.h('input', { type: 'color', value: state.fillColour });
    var framesInput = D.h('input', { type: 'checkbox', checked: true });
    var formatSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'png', text: 'PNG' }),
      D.h('option', { value: 'jpeg', text: 'JPEG' }),
      D.h('option', { value: 'webp', text: 'WebP' })
    );
    var qualityInput = D.h('input.slider', { type: 'range', min: 1, max: 100, step: 1, value: state.quality });
    var qualityHint = D.h('p.field-hint');
    var statusLine = D.h('p.form-status');
    var exportBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: S.btn_export
    });

    settingsCard.appendChild(D.h('h3', { text: S.settings_title }));
    settingsCard.appendChild(U.field(S.label_block, blockInput, { hint: S.hint_block }));
    settingsCard.appendChild(U.field(S.label_radius, radiusInput, { hint: S.hint_radius }));
    settingsCard.appendChild(U.field(S.label_colour, colourInput, { hint: S.hint_colour }));
    settingsCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, framesInput, D.h('span', { text: S.label_frames }))
    ));
    settingsCard.appendChild(U.field(S.label_format, formatSelect));
    settingsCard.appendChild(U.field(S.label_quality, qualityInput));
    settingsCard.appendChild(qualityHint);
    settingsCard.appendChild(D.h('div.form-actions', null, exportBtn));
    settingsCard.appendChild(statusLine);

    /* ---------- 结果 ---------- */

    var resultBody = D.h('div');
    resultCard.appendChild(D.h('h3', { text: S.result_title }));
    resultCard.appendChild(resultBody);

    /* ---------- 小工具 ---------- */

    /** 状态行。传 true 表示这是条错误。 */
    function setStatus(message, isError) {
      statusLine.textContent = message || '';
      statusLine.classList.toggle('is-error', !!isError);
    }

    /**
     * 把状态里的数字回写到输入框。
     *
     * 值一样就**不写** —— 正在输入的时候被改掉，光标会跳。
     */
    function setInputValue(input, value) {
      var v = String(value);
      if (input.value !== v) input.value = v;
    }

    /** 原图尺寸。区域活动的范围。 */
    function imageBounds() {
      return { width: state.width, height: state.height };
    }

    /** 键值对照表。 */
    function kvTable(rows) {
      var table = D.h('table.kv-table');
      table.appendChild(D.h('thead', null, D.h('tr', null,
        D.h('th', { text: S.label_source_size }),
        D.h('th', { text: S.label_output_size })
      )));
      var body = D.h('tbody');
      rows.forEach(function (row) {
        body.appendChild(D.h('tr', null,
          D.h('td', { text: row.label }),
          D.h('td.val', { text: row.value })
        ));
      });
      table.appendChild(body);
      return table;
    }

    /* ---------- 补丁 ---------- */

    /**
     * 取某个区域的马赛克补丁（带缓存）。
     *
     * @param {number} index 区域序号
     * @param {object} rect 区域
     * @param {number} block 块边长
     * @returns {object|null}
     */
    function mosaicPatch(index, rect, block) {
      var sig = [rect.x, rect.y, rect.width, rect.height, block].join(',');
      var hit = mosaicCache[index];
      if (hit && hit.sig === sig) return hit.patch;
      var patch = buildMosaicPatch(state.fullCanvas, rect, block);
      mosaicCache[index] = { sig: sig, patch: patch };
      return patch;
    }

    /**
     * 取某个区域的模糊补丁（带缓存）。
     *
     * @param {number} index 区域序号
     * @param {object} rect 区域
     * @param {number} radius 半径
     * @param {number} budget 缓冲区上限
     * @returns {object|null}
     */
    function blurPatch(index, rect, radius, budget) {
      var sig = [rect.x, rect.y, rect.width, rect.height, radius, budget].join(',');
      var hit = blurCache[index];
      if (hit && hit.sig === sig) return hit.patch;
      var patch = buildBlurPatch(state.fullCanvas, state.width, state.height, rect, radius, budget);
      blurCache[index] = { sig: sig, patch: patch };
      return patch;
    }

    /** 区域变了就把缓存扔掉 —— 缓存按参数寻址，参数变了自然重算，但删掉的区域要清掉。 */
    function trimCaches() {
      var i;
      for (i in mosaicCache) {
        if (Number(i) >= state.regions.length) delete mosaicCache[i];
      }
      for (i in blurCache) {
        if (Number(i) >= state.regions.length) delete blurCache[i];
      }
    }

    /* ---------- 画 ---------- */

    /**
     * 把所有区域施加到画布上。
     *
     * **坐标全是源图像素** —— 调用方把画布的变换设好了，
     * 这里不用管预览还是导出。
     *
     * 打码只有这一条入口：预览和导出都调它，所以两边一定一致。
     * 画选框的 drawFrames 只有预览调用 —— 选框不进导出就是靠这条调用图。
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} budget 模糊缓冲区的上限
     */
    function applyRedactions(ctx, budget) {
      for (var i = 0; i < state.regions.length; i++) {
        var r = state.regions[i];
        if (!r || r.width <= 0 || r.height <= 0) continue;
        if (r.mode === 'fill') {
          ctx.fillStyle = state.fillColour;
          ctx.fillRect(r.x, r.y, r.width, r.height);
          continue;
        }
        if (r.mode === 'mosaic') {
          var mp = mosaicPatch(i, r, state.blockSize);
          if (!mp) continue;
          var prev = ctx.imageSmoothingEnabled;
          // 关掉平滑：放大的时候用最近邻，一个中间像素铺成整块。
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(mp.canvas, 0, 0, mp.cols, mp.rows, r.x, r.y, r.width, r.height);
          ctx.imageSmoothingEnabled = prev;
          continue;
        }
        if (r.mode === 'blur') {
          var bp = blurPatch(i, r, state.blurRadius, budget);
          if (!bp) continue;
          ctx.save();
          ctx.beginPath();
          ctx.rect(r.x, r.y, r.width, r.height);
          ctx.clip();
          ctx.drawImage(bp.canvas, 0, 0, bp.canvas.width, bp.canvas.height, bp.x, bp.y, bp.w, bp.h);
          ctx.restore();
        }
      }
    }

    /**
     * 一个屏幕像素等于多少画布像素。
     *
     * 画布的 CSS 宽度不一定等于它的 width 属性（`max-width:100%` 会把它缩小），
     * 所以手柄画多大得按**显示出来的大小**算，不然点得准却看不见。
     * 还没布局好（jsdom 里就是）就按 1 算。
     */
    function uiScale() {
      var box = canvasBox();
      if (!box || !previewCanvas.width) return 1;
      return previewCanvas.width / box.width;
    }

    /**
     * 画选框。
     *
     * 只有预览调用 —— 导出图里没有选框。
     */
    function drawFrames(ctx) {
      if (!state.showFrames) return;
      var scale = previewScale;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = 2;
      for (var i = 0; i < state.regions.length; i++) {
        var r = state.regions[i];
        if (!r) continue;
        ctx.strokeRect(r.x * scale, r.y * scale, r.width * scale, r.height * scale);
      }
      // 当前选中的那个画手柄
      if (state.selected >= 0 && state.selected < state.regions.length) {
        var s = state.regions[state.selected];
        var half = Math.max(2, HANDLE_PX * uiScale() / 2);
        var pts = [
          [s.x * scale, s.y * scale],
          [(s.x + s.width) * scale, s.y * scale],
          [(s.x + s.width) * scale, (s.y + s.height) * scale],
          [s.x * scale, (s.y + s.height) * scale]
        ];
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        for (var p = 0; p < pts.length; p++) {
          ctx.fillRect(pts[p][0] - half, pts[p][1] - half, half * 2, half * 2);
        }
      }
      ctx.restore();
    }

    /** 重画预览。 */
    function redraw() {
      if (!state.fullCanvas) return;
      var ctx = previewCanvas.getContext('2d');
      // jsdom 里没有 2d 上下文，画不了就算了 —— 不能因此抛异常。
      if (!ctx) return;
      var pw = previewCanvas.width;
      var ph = previewCanvas.height;
      if (!pw || !ph) return;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pw, ph);
      ctx.drawImage(state.fullCanvas, 0, 0, pw, ph);

      // 打码用源图像素算，画布变换负责缩放
      ctx.setTransform(previewScale, 0, 0, previewScale, 0, 0);
      applyRedactions(ctx, drag ? BLUR_BUDGET_DRAG : BLUR_BUDGET);
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      drawFrames(ctx);
    }

    /** 调整预览画布的大小。 */
    function resizePreview() {
      if (!state.width || !state.height) return;
      var k = Math.min(1, PREVIEW_MAX / Math.max(state.width, state.height));
      var pw = Math.max(1, Math.round(state.width * k));
      // 缩放系数按**取整之后**的宽度重算 —— 画框和打码都得用同一个系数，
      // 差半个像素还行，差得多了框就套不住打码的那一块。
      previewScale = pw / state.width;
      var ph = Math.max(1, Math.round(state.height * previewScale));
      if (previewCanvas.width !== pw || previewCanvas.height !== ph) {
        previewCanvas.width = pw;
        previewCanvas.height = ph;
      }
    }

    /* ---------- 区域列表 ---------- */

    /** 重画区域列表。 */
    function renderRegions() {
      D.clear(regionList);
      if (!state.regions.length) {
        regionList.appendChild(D.h('p.field-hint', { text: S.no_regions }));
        return;
      }
      state.regions.forEach(function (r, index) {
        var modeSelect = D.h('select.layui-select.redact-mode', { 'aria-label': S.label_mode },
          D.h('option', { value: 'mosaic', text: S.mode_mosaic }),
          D.h('option', { value: 'blur', text: S.mode_blur }),
          D.h('option', { value: 'fill', text: S.mode_fill })
        );
        modeSelect.value = r.mode;
        modeSelect.addEventListener('change', function () {
          var next = modeSelect.value;
          if (next !== 'mosaic' && next !== 'blur' && next !== 'fill') next = 'mosaic';
          r.mode = next;
          redraw();
        });

        var delBtn = D.h('button.redact-item-del', {
          type: 'button', text: '×', title: S.btn_delete, 'aria-label': S.btn_delete
        });
        delBtn.addEventListener('click', function () {
          removeRegion(index);
        });

        var item = D.h('div.redact-item' + (index === state.selected ? '.is-selected' : ''), null,
          D.h('span.redact-item-index', { text: String(index + 1) }),
          modeSelect,
          D.h('span.redact-item-info', {
            text: r.x + ', ' + r.y + ' · ' + r.width + ' × ' + r.height
          }),
          delBtn
        );
        item.addEventListener('click', function () {
          state.selected = index;
          renderRegions();
          redraw();
        });
        regionList.appendChild(item);
      });
    }

    /** 删掉一个区域。 */
    function removeRegion(index) {
      if (index < 0 || index >= state.regions.length) return;
      state.regions.splice(index, 1);
      if (state.selected >= state.regions.length) state.selected = state.regions.length - 1;
      trimCaches();
      renderRegions();
      redraw();
    }

    /* ---------- 拖拽 ---------- */

    /**
     * 预览画布在屏幕上的位置与大小。
     *
     * 画布的显示尺寸**不等于**它的 width/height 属性 —— css 里写着
     * max-width:100%，所以要问浏览器要实际显示出来的矩形。
     *
     * @returns {object|null} null 表示还没布局好（或者在 jsdom 里）
     */
    function canvasBox() {
      var rect = previewCanvas.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return null;
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }

    /** 屏幕坐标 → 源图像素。 */
    function clientToSource(clientX, clientY) {
      var box = canvasBox();
      if (!box || !state.width || !state.height) return null;
      return {
        x: (clientX - box.left) / box.width * state.width,
        y: (clientY - box.top) / box.height * state.height
      };
    }

    /**
     * 手柄的命中容差，换算成源图像素。
     *
     * 屏幕上是 8 个像素 —— 源图越大，一个屏幕像素对应的源图像素越多，
     * 容差跟着换算，手柄在屏幕上看着多大，点起来就多好使。
     */
    function hitTolerance() {
      var box = canvasBox();
      if (!box || !state.width || !state.height) return { x: 0, y: 0 };
      return {
        x: HANDLE_PX / box.width * state.width,
        y: HANDLE_PX / box.height * state.height
      };
    }

    function onDown(e) {
      if (disposed || !state.fullCanvas) return;
      var pt = clientToSource(e.clientX, e.clientY);
      if (!pt) return;
      var tol = hitTolerance();
      var target = pickTarget(state.regions, state.selected, pt.x, pt.y, tol.x, tol.y);

      if (target.kind === 'handle') {
        var r = state.regions[target.index];
        drag = {
          kind: 'resize',
          index: target.index,
          handle: target.handle,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          startX: pt.x,
          startY: pt.y
        };
      } else if (target.kind === 'move') {
        state.selected = target.index;
        var m = state.regions[target.index];
        drag = {
          kind: 'move',
          index: target.index,
          rect: { x: m.x, y: m.y, width: m.width, height: m.height },
          startX: pt.x,
          startY: pt.y
        };
        renderRegions();
      } else {
        drag = {
          kind: 'create',
          index: -1,
          rect: { x: pt.x, y: pt.y, width: 0, height: 0 },
          startX: pt.x,
          startY: pt.y
        };
      }
      if (e.preventDefault) e.preventDefault();
      // 抓住之后指针移出画布也要跟手 —— 把事件抓到画布上。
      if (previewCanvas.setPointerCapture && e.pointerId !== undefined) {
        try {
          previewCanvas.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 抓不到就算了，document 上的监听照样跟手 */
        }
      }
    }

    function onMove(e) {
      if (disposed || !drag) return;
      var pt = clientToSource(e.clientX, e.clientY);
      if (!pt) return;
      if (drag.kind === 'create') {
        var x0 = Math.min(drag.startX, pt.x);
        var y0 = Math.min(drag.startY, pt.y);
        var x1 = Math.max(drag.startX, pt.x);
        var y1 = Math.max(drag.startY, pt.y);
        drag.rect = clampRect(
          { x: x0, y: y0, width: Math.round(x1 - x0), height: Math.round(y1 - y0) },
          imageBounds(),
          1
        );
        // 画的时候把新框显示出来
        var previewRect = drag.rect;
        state.regions.push({
          x: previewRect.x, y: previewRect.y,
          width: previewRect.width, height: previewRect.height,
          mode: 'mosaic'
        });
        drag.index = state.regions.length - 1;
        drag.kind = 'createLive';
        renderRegions();
        redraw();
        return;
      }
      if (drag.kind === 'createLive') {
        var x0b = Math.min(drag.startX, pt.x);
        var y0b = Math.min(drag.startY, pt.y);
        var x1b = Math.max(drag.startX, pt.x);
        var y1b = Math.max(drag.startY, pt.y);
        drag.rect = clampRect(
          { x: x0b, y: y0b, width: Math.round(x1b - x0b), height: Math.round(y1b - y0b) },
          imageBounds(),
          1
        );
        var live = state.regions[drag.index];
        if (live) {
          live.x = drag.rect.x;
          live.y = drag.rect.y;
          live.width = drag.rect.width;
          live.height = drag.rect.height;
        }
        renderRegions();
        redraw();
        return;
      }
      var next = resizeRect(
        drag.rect, drag.handle,
        pt.x - drag.startX, pt.y - drag.startY,
        imageBounds()
      );
      if (!next) return;
      var target = state.regions[drag.index];
      if (!target) return;
      target.x = next.x;
      target.y = next.y;
      target.width = next.width;
      target.height = next.height;
      renderRegions();
      redraw();
    }

    function onUp() {
      if (drag && drag.kind === 'createLive') {
        var live = state.regions[drag.index];
        // 误触（点了一下没拖）不算一个区域
        if (!live || live.width < MIN_REGION || live.height < MIN_REGION) {
          if (live) state.regions.splice(drag.index, 1);
          state.selected = -1;
          trimCaches();
        } else {
          state.selected = drag.index;
        }
      }
      drag = null;
      renderRegions();
      redraw();
    }

    /* ---------- 导出 ---------- */

    /** 画结果卡片。 */
    function renderResult() {
      D.clear(resultBody);
      var r = state.result;
      if (!r) {
        resultBody.appendChild(D.h('p.field-hint', { text: S.no_result }));
        return;
      }
      var format = C.formatById(r.formatId) || C.FORMATS[0];
      resultBody.appendChild(kvTable([
        { label: S.label_source_size, value: state.width + ' × ' + state.height },
        { label: S.label_count, value: String(state.regions.length) },
        { label: S.label_output_size, value: r.width + ' × ' + r.height },
        { label: S.label_file_size, value: C.formatBytes(r.bytes) },
        { label: S.label_output_format, value: format.label }
      ]));

      var downloadBtn = D.h('button.layui-btn.layui-btn-primary.redact-download', {
        type: 'button', text: S.btn_download
      });
      downloadBtn.addEventListener('click', function () {
        if (disposed || !state.result) return;
        window.ItTools.download(
          C.outputName(state.name, format.ext, 'redacted'),
          state.result.blob,
          format.mime
        );
      });
      resultBody.appendChild(D.h('div.form-actions', null, downloadBtn));
    }

    /** 导出一张。 */
    function exportImage() {
      if (!state.fullCanvas) {
        setStatus(S.err_no_picture, true);
        return;
      }
      var format = C.formatById(state.formatId) || C.FORMATS[0];
      var w = state.width;
      var h = state.height;
      var limit = canvasLimit(w, h);
      if (!limit.ok) {
        state.result = null;
        renderResult();
        setStatus(S.err_canvas_limit
          .replace('{width}', String(w))
          .replace('{height}', String(h))
          .replace('{max}', String(MAX_CANVAS_SIDE))
          .replace('{area}', String(Math.round(MAX_CANVAS_AREA / 1000000))), true);
        return;
      }

      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      if (!ctx) {
        state.result = null;
        renderResult();
        setStatus(S.err_encode.replace('{reason}', 'canvas'), true);
        return;
      }
      try {
        // JPEG 没有 alpha：透明的地方会变成黑的，先铺一层白底。
        if (!format.alpha) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(state.fullCanvas, 0, 0, w, h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        applyRedactions(ctx, BLUR_BUDGET);
      } catch (e) {
        state.result = null;
        renderResult();
        setStatus(S.err_encode.replace('{reason}', function () {
          return String(e && e.message ? e.message : e);
        }), true);
        return;
      }

      if (typeof canvas.toBlob !== 'function') {
        state.result = null;
        renderResult();
        setStatus(S.err_encode.replace('{reason}', 'toBlob'), true);
        return;
      }
      try {
        canvas.toBlob(function (blob) {
          if (disposed) return;
          if (!blob) {
            state.result = null;
            renderResult();
            setStatus(S.err_encode.replace('{reason}', 'encode'), true);
            return;
          }
          state.result = {
            blob: blob,
            bytes: blob.size,
            width: w,
            height: h,
            formatId: state.formatId
          };
          setStatus('');
          renderResult();
        }, format.mime, format.lossy ? state.quality / 100 : undefined);
      } catch (e) {
        state.result = null;
        renderResult();
        setStatus(S.err_encode.replace('{reason}', function () {
          return String(e && e.message ? e.message : e);
        }), true);
      }
    }

    /* ---------- 处理文件 ---------- */

    function handleFile(file) {
      if (!file) return;
      upload.setStatus(S.status_reading);

      var reader = new FileReader();
      reader.onload = function () {
        if (disposed) return;
        var bytes;
        try {
          bytes = new Uint8Array(reader.result);
        } catch (e) {
          upload.setStatus(S.err_read, true);
          return;
        }
        var animation = C.animationInfo(bytes);

        C.decode(file).then(function (decoded) {
          if (disposed) {
            if (decoded && decoded.close) decoded.close();
            return;
          }
          // 换图的时候先把上一张的位图放掉 —— 只在销毁时关的话，
          // 中途换图会一直留着上一张。
          if (state.decoded && state.decoded.close) state.decoded.close();

          // 原分辨率的源画布 —— 打码、导出都从这儿取像素。
          var full = document.createElement('canvas');
          full.width = decoded.width;
          full.height = decoded.height;
          var fctx = full.getContext('2d');
          if (!fctx) {
            if (decoded.close) decoded.close();
            upload.setStatus(S.err_decode, true);
            return;
          }
          fctx.drawImage(decoded.source, 0, 0);

          state.decoded = decoded;
          state.fullCanvas = full;
          state.name = file.name || 'image';
          state.width = decoded.width;
          state.height = decoded.height;
          state.regions = [];
          state.selected = -1;
          state.result = null;
          mosaicCache = {};
          blurCache = {};

          upload.setStatus('');
          regionsCard.hidden = false;
          previewCard.hidden = false;
          settingsCard.hidden = false;
          resultCard.hidden = false;
          resizePreview();
          renderRegions();
          redraw();
          renderResult();

          // 动图只剩第一帧 —— canvas 画不出后面的帧，不说清楚就成了骗人
          if (animation && animation.animated) {
            settingsCard.appendChild(D.h('div.alert.alert-warning', null,
              D.h('div', { text: S.warn_animation.replace('{n}', String(animation.frames)) })
            ));
          }
        }, function () {
          if (disposed) return;
          upload.setStatus(S.err_decode, true);
        });
      };
      reader.onerror = function () {
        if (disposed) return;
        upload.setStatus(S.err_read, true);
      };
      reader.readAsArrayBuffer(file);
    }

    /* ---------- 事件 ---------- */

    blockInput.addEventListener('input', function () {
      state.blockSize = clampInt(blockInput.value, 1, 200, DEFAULT_BLOCK);
      setInputValue(blockInput, state.blockSize);
      redraw();
    });

    radiusInput.addEventListener('input', function () {
      state.blurRadius = clampInt(radiusInput.value, 0, 100, DEFAULT_RADIUS);
      setInputValue(radiusInput, state.blurRadius);
      redraw();
    });

    colourInput.addEventListener('input', function () {
      state.fillColour = colourInput.value || '#000000';
      redraw();
    });

    framesInput.addEventListener('change', function () {
      state.showFrames = framesInput.checked;
      redraw();
    });

    formatSelect.addEventListener('change', function () {
      state.formatId = formatSelect.value;
      // PNG 是无损的，画质对它没有意义 —— 滑块禁掉
      var lossless = state.formatId === 'png';
      qualityInput.disabled = lossless;
      qualityHint.textContent = lossless ? S.hint_quality : '';
    });

    qualityInput.addEventListener('input', function () {
      state.quality = Number(qualityInput.value) || 90;
    });

    clearBtn.addEventListener('click', function () {
      if (!state.regions.length) return;
      state.regions = [];
      state.selected = -1;
      mosaicCache = {};
      blurCache = {};
      renderRegions();
      redraw();
    });

    exportBtn.addEventListener('click', function () {
      if (disposed) return;
      exportImage();
    });

    // 指针事件优先（能拖出画布），老浏览器退回鼠标事件。
    var hasPointer = typeof window.PointerEvent === 'function';
    var downEvent = hasPointer ? 'pointerdown' : 'mousedown';
    var moveEvent = hasPointer ? 'pointermove' : 'mousemove';
    var upEvent = hasPointer ? 'pointerup' : 'mouseup';
    var offs = [
      D.on(previewCanvas, downEvent, onDown),
      D.on(document, moveEvent, onMove),
      D.on(document, upEvent, onUp)
    ];

    return {
      destroy: function () {
        disposed = true;
        offs.forEach(function (off) { off(); });
        if (state.decoded && state.decoded.close) state.decoded.close();
        state.fullCanvas = null;
        state.decoded = null;
        state.regions = [];
        mosaicCache = {};
        blurCache = {};
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['image-redact'] = {
    PREVIEW_MAX: PREVIEW_MAX,
    MAX_CANVAS_SIDE: MAX_CANVAS_SIDE,
    MAX_CANVAS_AREA: MAX_CANVAS_AREA,
    BLUR_PASSES: BLUR_PASSES,
    BLUR_BUDGET: BLUR_BUDGET,
    HANDLE_PX: HANDLE_PX,
    clampRect: clampRect,
    insideRect: insideRect,
    hitTest: hitTest,
    pickTarget: pickTarget,
    resizeRect: resizeRect,
    mosaicPlan: mosaicPlan,
    averageBlocks: averageBlocks,
    blurHalo: blurHalo,
    clampIdx: clampIdx,
    boxBlur1d: boxBlur1d,
    blurPixels: blurPixels,
    canvasLimit: canvasLimit,
    clampInt: clampInt,
    parseHex: parseHex,

    __cases: function (assert) {
      var bounds = { width: 1000, height: 800 };
      var rect = { x: 100, y: 100, width: 400, height: 300 };

      /* ---- 夹进图里 ---- */

      assert.eq(clampRect({ x: -50, y: -50, width: 400, height: 300 }, bounds, 1),
        { x: 0, y: 0, width: 400, height: 300 }, '往里挪');
      assert.eq(clampRect({ x: 900, y: 700, width: 400, height: 300 }, bounds, 1),
        { x: 600, y: 500, width: 400, height: 300 }, '超出右边就往左挪');
      assert.eq(clampRect({ x: 0, y: 0, width: 5000, height: 300 }, bounds, 1),
        { x: 0, y: 0, width: 1000, height: 300 }, '比原图还宽就砍到原图宽');
      assert.eq(clampRect({ x: 0, y: 0, width: 0, height: 0 }, bounds, 10),
        { x: 0, y: 0, width: 10, height: 10 }, '太小就抬到最小值');

      /* ---- 命中测试 ---- */

      assert.eq(hitTest(rect, 100, 100, 10, 10), 'nw', '左上角');
      assert.eq(hitTest(rect, 500, 100, 10, 10), 'ne', '右上角');
      assert.eq(hitTest(rect, 500, 400, 10, 10), 'se', '右下角');
      assert.eq(hitTest(rect, 100, 400, 10, 10), 'sw', '左下角');
      assert.eq(hitTest(rect, 300, 100, 10, 10), 'n', '上边');
      assert.eq(hitTest(rect, 500, 250, 10, 10), 'e', '右边');
      assert.eq(hitTest(rect, 300, 400, 10, 10), 's', '下边');
      assert.eq(hitTest(rect, 100, 250, 10, 10), 'w', '左边');
      assert.eq(hitTest(rect, 300, 250, 10, 10), 'move', '框里是移动');
      assert.eq(hitTest(rect, 900, 700, 10, 10), null, '框外不算命中');

      /* ---- 点到了什么 ---- */

      var rects = [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 200, y: 200, width: 100, height: 100 }
      ];
      assert.eq(pickTarget(rects, 0, 5, 5, 6, 6),
        { kind: 'handle', index: 0, handle: 'nw' }, '选中区域的角是手柄');
      assert.eq(pickTarget(rects, 0, 50, 50, 6, 6),
        { kind: 'move', index: 0, handle: '' }, '选中区域里面是移动');
      assert.eq(pickTarget(rects, 0, 250, 250, 6, 6),
        { kind: 'move', index: 1, handle: '' }, '别的区域里面是移动那个');
      assert.eq(pickTarget(rects, 0, 800, 800, 6, 6),
        { kind: 'new', index: -1, handle: '' }, '空地上是画新的');
      assert.eq(pickTarget(rects, -1, 50, 50, 6, 6),
        { kind: 'move', index: 0, handle: '' }, '没有选中时区域里面是移动');

      /* ---- 拖动 ---- */

      assert.eq(resizeRect(rect, 'move', 50, 20, bounds),
        { x: 150, y: 120, width: 400, height: 300 }, '整体移动');
      assert.eq(resizeRect(rect, 'move', -500, -500, bounds),
        { x: 0, y: 0, width: 400, height: 300 }, '移出去会被夹回来');
      assert.eq(resizeRect(rect, 'se', 100, 100, bounds),
        { x: 100, y: 100, width: 500, height: 400 }, '拖右下角变大');
      assert.eq(resizeRect(rect, 'nw', 50, 50, bounds),
        { x: 150, y: 150, width: 350, height: 250 }, '拖左上角：右下角不动');
      assert.eq(resizeRect(rect, 'e', 100, 0, bounds),
        { x: 100, y: 100, width: 500, height: 300 }, '拖右边只改宽');
      assert.eq(resizeRect(rect, 'n', 0, 50, bounds),
        { x: 100, y: 150, width: 400, height: 250 }, '拖上边只改高');
      assert.eq(resizeRect({ x: 0, y: 0, width: 100, height: 100 }, 'w', -50, 0, bounds),
        { x: 0, y: 0, width: 100, height: 100 }, '已经在边上还往外拖，尺寸不变');
      assert.eq(resizeRect(rect, 'se', -1000, -1000, bounds),
        { x: 100, y: 100, width: 1, height: 1 }, '缩到最小还是有一个像素');

      /* ---- 马赛克网格 ---- */

      assert.eq(mosaicPlan({ x: 0, y: 0, width: 100, height: 60 }, 8),
        { cols: 13, rows: 8, cellW: 100 / 13, cellH: 60 / 8 },
        '100×60 按 8 像素分成 13×8 块');
      assert(mosaicPlan({ x: 0, y: 0, width: 100, height: 60 }, 8).cellW <= 8,
        '块宽不超过设定值');
      assert.eq(mosaicPlan({ x: 0, y: 0, width: 3, height: 3 }, 8),
        { cols: 1, rows: 1, cellW: 3, cellH: 3 }, '比一块还小就一块');
      assert.eq(mosaicPlan({ x: 0, y: 0, width: 100, height: 60 }, 0),
        { cols: 100, rows: 60, cellW: 1, cellH: 1 }, '块大小为 0 就按 1 算');

      /* ---- 马赛克取色（严格盒式平均） ---- */

      // 造一张小图：左半红、右半绿
      function makeImg(w, h, painter) {
        var data = new Uint8ClampedArray(w * h * 4);
        for (var y = 0; y < h; y++) {
          for (var x = 0; x < w; x++) {
            var c = painter(x, y);
            var o = (y * w + x) * 4;
            data[o] = c[0];
            data[o + 1] = c[1];
            data[o + 2] = c[2];
            data[o + 3] = 255;
          }
        }
        return { data: data, w: w, h: h };
      }

      var half = makeImg(4, 2, function (x) {
        return x < 2 ? [255, 0, 0] : [0, 255, 0];
      });
      var cells = averageBlocks(half, 2, 1);
      assert.eq([cells[0], cells[1], cells[2]], [255, 0, 0], '第一块是纯红（不跟邻块串色）');
      assert.eq([cells[4], cells[5], cells[6]], [0, 255, 0], '第二块是纯绿（不跟邻块串色）');

      // 合成一块就是两边的平均
      var one = averageBlocks(half, 1, 1);
      assert.eq([one[0], one[1], one[2]], [128, 128, 0], '合成一块就是两边的平均色');

      // 4×4 分成 2×2，每块 2×2 —— 黑与白各占一半，不能串
      var quad = makeImg(4, 4, function (x, y) {
        return (x < 2 && y < 2) ? [0, 0, 0] : [255, 255, 255];
      });
      var quadCells = averageBlocks(quad, 2, 2);
      assert.eq([quadCells[0], quadCells[1], quadCells[2]], [0, 0, 0], '左上块是黑的');
      assert.eq([quadCells[4], quadCells[5], quadCells[6]], [255, 255, 255], '右上块是白的');
      assert.eq([quadCells[12], quadCells[13], quadCells[14]], [255, 255, 255], '右下块是白的');

      // 3 个像素分成 3 块 —— 每块正好一个像素，不重不漏
      var three = makeImg(3, 1, function (x) {
        return [[10, 20, 30], [40, 50, 60], [70, 80, 90]][x];
      });
      var threeCells = averageBlocks(three, 3, 1);
      assert.eq([threeCells[0], threeCells[1], threeCells[2]], [10, 20, 30], '第一块取第一个像素');
      assert.eq([threeCells[8], threeCells[9], threeCells[10]], [70, 80, 90], '第三块取第三个像素');

      /* ---- 模糊 ---- */

      assert.eq(blurHalo(0), 0, '半径 0 没有上下文');
      assert.eq(blurHalo(10), 30, '三趟模糊要 ±30 像素的上下文');

      // 一维滑窗：常数序列模糊之后还是常数
      var flat = new Float32Array(9);
      var out = new Float32Array(9);
      for (var i = 0; i < 9; i++) flat[i] = 5;
      boxBlur1d(flat, 9, 2, out);
      assert.eq(out[4], 5, '常数序列模糊之后还是常数');
      assert.eq(out[0], 5, '边缘也是常数（延拓）');

      // 边缘延拓：只有中间一个亮点的序列，模糊之后边缘不该变成 0
      var spike = new Float32Array(9);
      spike[4] = 100;
      boxBlur1d(spike, 9, 1, out);
      assert(out[3] > 0 && out[5] > 0, '亮点的两侧都有值');
      assert(out[0] === 0, '离得远的还是 0');

      // 预乘 alpha：全透明的像素不该把黑色渗进旁边
      var img = { width: 3, height: 1, data: new Uint8ClampedArray(3 * 4) };
      // (0,0) 透明黑 (1,0) 不透明白 (2,0) 不透明白
      img.data[0] = 0; img.data[1] = 0; img.data[2] = 0; img.data[3] = 0;
      img.data[4] = 255; img.data[5] = 255; img.data[6] = 255; img.data[7] = 255;
      img.data[8] = 255; img.data[9] = 255; img.data[10] = 255; img.data[11] = 255;
      blurPixels(img, 1);
      // 不做预乘的话，透明处的黑色会被平均进来，白像素被拉成灰的。
      // 做了预乘再还原，白色还原回白色（只是 alpha 变小了）。
      assert(img.data[4] > 200, '不透明的白像素没被透明处的黑色拉暗');
      assert(img.data[8] > 200, '另一个不透明的白像素也没被拉暗');
      assert(img.data[7] > 100, '白像素的 alpha 只是变淡，没有塌掉');

      // 四个通道要**各自**糊。
      // 曾经只累加了红通道再写进四个通道，alpha 也被写成了红色的模糊值 ——
      // 黑色那一块 alpha 直接变 0，盖上去是透明的，等于没糊。
      var rgba = { width: 5, height: 1, data: new Uint8ClampedArray(5 * 4) };
      for (var j = 0; j < 5; j++) {
        rgba.data[j * 4] = 10 * (j + 1);   // 红通道逐格不同
        rgba.data[j * 4 + 1] = 200;        // 绿通道固定
        rgba.data[j * 4 + 2] = 50;         // 蓝通道固定
        rgba.data[j * 4 + 3] = 255;        // alpha 固定
      }
      blurPixels(rgba, 1);
      assert(rgba.data[4] > 10 && rgba.data[4] < 50, '红通道是邻居的平均');
      assert.eq(rgba.data[5], 200, '绿通道没有被红通道串味');
      assert.eq(rgba.data[6], 50, '蓝通道没有被红通道串味');
      assert.eq(rgba.data[7], 255, 'alpha 没有被当成颜色通道');

      /* ---- 画布上限 ---- */

      assert.eq(canvasLimit(1920, 1080).ok, true, '常见尺寸没问题');
      assert.eq(canvasLimit(32768, 100).reason, 'side', '单边超过上限不行');
      assert.eq(canvasLimit(20000, 20000).reason, 'area', '面积超了不行');
      assert.eq(canvasLimit(0, 100).reason, 'size', '尺寸是 0 不行');

      /* ---- 数字夹取 ---- */

      assert.eq(clampInt('123', 1, 200, 12), 123, '范围内的照收');
      assert.eq(clampInt('999', 1, 200, 12), 200, '太大就夹到上限');
      assert.eq(clampInt('-5', 1, 200, 12), 1, '太小就夹到下限');
      assert.eq(clampInt('abc', 1, 200, 12), 12, '不是数字退回默认值');

      /* ---- 颜色 ---- */

      assert.eq(parseHex('#ff8000'), { r: 255, g: 128, b: 0 }, '六位十六进制');
      assert.eq(parseHex('#f80'), { r: 255, g: 136, b: 0 }, '三位十六进制');
      assert.eq(parseHex('nope'), { r: 0, g: 0, b: 0 }, '认不出来的就是黑的');
    }
  };
}());
