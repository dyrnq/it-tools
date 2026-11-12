/* ==========================================================================
   图片拼贴（image-collage）

   把几张图合成一张：网格排版、竖向长图、横向长条。

   底下是三件事，界面上看不出来，做错了整张图就废了：

   - **位置靠累加游标，不靠乘法**。相邻格子的位置要是写成
     「外边距 + 第几格 × (格宽 + 间距)」，浮点误差会让本该挨着的两格之间
     裂开一条 1 像素的缝 —— 格子尺寸是奇数的时候尤其明显。
     所以位置是从上一格的位置加上格宽再加上间距，一格一格累加出来的。

   - **尺寸先取整再画**。画布宽高、格子宽高都是整数，只有那个缩放比是浮点。
     取整早了缝就没了，取整晚了边就毛了。相邻两格的边界因此永远是整数，
     画出来的缝就是严丝合缝的 gap 像素。

   - **超限要缩参数，不是缩结果**。浏览器的画布有上限（每边 32767、
     总面积 268435456），超了不会报错，只是 `toBlob` 返回 null，整张图就废了。
     所以先把参数（格宽、格高、间距、外边距、圆角）按比例缩小，重排一次版面，
     然后**只画一次** —— 画完再缩小等于让整张图糊一层。

   图片一个字节都不出浏览器：解码、排版、绘制、导出全在本地完成。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-collage');

  /* ---------- 常量 ---------- */

  /** 排版方式。 */
  var MODE_GRID = 'grid';
  var MODE_VERTICAL = 'vertical';
  var MODE_HORIZONTAL = 'horizontal';

  /** 图在格子里怎么放。 */
  var FIT_COVER = 'cover';
  var FIT_CONTAIN = 'contain';

  /** 最多放多少张图。再多画布必然爆掉。 */
  var MAX_IMAGES = 50;

  /** 列数（只有网格排版用得上）。 */
  var MIN_COLS = 1;
  var MAX_COLS = 12;
  var DEFAULT_COLS = 3;

  /** 格子的宽高。网格排版里是格子大小，纵向拼接里是拼出来的宽度，
      横向拼接里是拼出来的高度。 */
  var MIN_CELL = 16;
  var MAX_CELL = 2000;
  var DEFAULT_CELL = 320;

  /** 图与图之间的缝。 */
  var MIN_GAP = 0;
  var MAX_GAP = 200;
  var DEFAULT_GAP = 12;

  /** 画布四周留白。 */
  var MIN_MARGIN = 0;
  var MAX_MARGIN = 400;
  var DEFAULT_MARGIN = 24;

  /** 圆角半径。 */
  var MIN_RADIUS = 0;
  var MAX_RADIUS = 200;
  var DEFAULT_RADIUS = 0;

  /** 预览图的长边上限 —— 屏幕上看不清更大的，多余的像素只是浪费。 */
  var PREVIEW_MAX = 1200;

  /** 浏览器画布的上限：每边 32767、总面积 268435456（约 2.68 亿像素）。 */
  var MAX_CANVAS_SIDE = 32767;
  var MAX_CANVAS_AREA = 268435456;

  /** 缩略图的尺寸。 */
  var THUMB_W = 72;
  var THUMB_H = 54;

  /* ---------- 纯逻辑 ---------- */

  /**
   * 把一个值夹到整数区间里。夹不动就返回默认值。
   *
   * @param {*} v
   * @param {number} min
   * @param {number} max
   * @param {number} dflt
   * @returns {number}
   */
  function clampInt(v, min, max, dflt) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /**
   * 按用户选中的顺序，给每个文件占一个位置。
   *
   * 解码是异步的，谁先解完不一定。要是等解码好了再往列表里塞，
   * 图在拼贴里的顺序就变成「谁先解完谁在前」了 ——
   * 用户明明按 A、B、C 选的，拼出来却是 B、C、A。
   * 所以先按选择顺序占好位，解码好了再往对应的位上填。
   *
   * @param {Array<{name?:string}>} files
   * @returns {Array<object>} 占位：宽高先填 0，解码好了再填
   */
  function makeSlots(files) {
    var out = [];
    for (var i = 0; i < (files || []).length; i++) {
      var f = files[i];
      out.push({
        name: (f && f.name) || ('image-' + (i + 1)),
        width: 0,
        height: 0,
        source: null,
        close: null,
        failed: false
      });
    }
    return out;
  }

  /**
   * 把参数收拾成一份干净的、能直接拿去算版面的值。
   *
   * 界面上每个输入框都要单独夹一次（用户可以打出「abc」），
   * 但版面计算是最后一道关 —— 这里的夹取保证算出来的东西一定是合法的。
   *
   * @param {object} raw
   * @returns {object}
   */
  function normalizeParams(raw) {
    var p = raw || {};
    var mode = p.mode;
    if (mode !== MODE_GRID && mode !== MODE_VERTICAL && mode !== MODE_HORIZONTAL) {
      mode = MODE_GRID;
    }
    var fit = p.fit === FIT_CONTAIN ? FIT_CONTAIN : FIT_COVER;
    return {
      mode: mode,
      cols: clampInt(p.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS),
      cellW: clampInt(p.cellW, MIN_CELL, MAX_CELL, DEFAULT_CELL),
      cellH: clampInt(p.cellH, MIN_CELL, MAX_CELL, DEFAULT_CELL),
      gap: clampInt(p.gap, MIN_GAP, MAX_GAP, DEFAULT_GAP),
      margin: clampInt(p.margin, MIN_MARGIN, MAX_MARGIN, DEFAULT_MARGIN),
      radius: clampInt(p.radius, MIN_RADIUS, MAX_RADIUS, DEFAULT_RADIUS),
      fit: fit
    };
  }

  /**
   * 圆角半径不能超过格子短边的一半 —— 超过���画出来的不是圆角，是怪东西。
   *
   * @param {number} r
   * @param {number} w
   * @param {number} h
   * @returns {number}
   */
  function clampRadius(r, w, h) {
    var n = Number(r);
    if (!isFinite(n) || n <= 0) return 0;
    var half = Math.min(w, h) / 2;
    return Math.floor(Math.min(n, half));
  }

  /**
   * 「填满格子」：算出该从原图上裁哪一块。
   *
   * 缩放比取两个方向里更大的那个（宁可裁掉一点，也不能露白），
   * 裁下来的那块按原图的比例居中 —— 居中的偏移用 floor，
   * 跟 contain 的居中口径保持一致，两种模式切���来画面才不会跳。
   *
   * @param {number} iw 原图宽
   * @param {number} ih 原图高
   * @param {number} w 格子宽
   * @param {number} h 格子高
   * @returns {{sx:number, sy:number, sw:number, sh:number}}
   */
  function coverSource(iw, ih, w, h) {
    var scale = Math.max(w / iw, h / ih);
    var sw = Math.min(iw, Math.max(1, Math.round(w / scale)));
    var sh = Math.min(ih, Math.max(1, Math.round(h / scale)));
    return {
      sx: Math.floor((iw - sw) / 2),
      sy: Math.floor((ih - sh) / 2),
      sw: sw,
      sh: sh
    };
  }

  /**
   * 「放进格子」：算出图该画在格子的哪个位置、多大。
   *
   * 缩放比取两个方向里更小的那个（整张图都看得见），
   * 居中的偏移同样用 floor。
   *
   * @param {number} iw 原图宽
   * @param {number} ih 原图高
   * @param {number} x 格子左边
   * @param {number} y 格子顶边
   * @param {number} w 格子宽
   * @param {number} h 格子高
   * @returns {{dx:number, dy:number, dw:number, dh:number}}
   */
  function containRect(iw, ih, x, y, w, h) {
    var scale = Math.min(w / iw, h / ih);
    var dw = Math.max(1, Math.round(iw * scale));
    var dh = Math.max(1, Math.round(ih * scale));
    return {
      dx: x + Math.floor((w - dw) / 2),
      dy: y + Math.floor((h - dh) / 2),
      dw: dw,
      dh: dh
    };
  }

  /**
   * 造一个格子：位置、大小，以及图该从原图哪里取、画到哪里。
   *
   * @param {number} index 第几张图
   * @param {{width:number, height:number}} image 原图尺寸
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {string} fit
   * @returns {object}
   */
  function makeCell(index, image, x, y, w, h, fit) {
    var iw = image.width;
    var ih = image.height;
    var cell = {
      index: index,
      x: x, y: y, w: w, h: h,
      sx: 0, sy: 0, sw: iw, sh: ih,
      dx: x, dy: y, dw: w, dh: h
    };
    if (iw <= 0 || ih <= 0) return cell;
    if (fit === FIT_CONTAIN) {
      var r = containRect(iw, ih, x, y, w, h);
      cell.dx = r.dx;
      cell.dy = r.dy;
      cell.dw = r.dw;
      cell.dh = r.dh;
    } else {
      var s = coverSource(iw, ih, w, h);
      cell.sx = s.sx;
      cell.sy = s.sy;
      cell.sw = s.sw;
      cell.sh = s.sh;
    }
    return cell;
  }

  /**
   * 排版。
   *
   * 三种排版共用一套格子描述，区别只在格子怎么排：
   *   网格   —— 固定尺寸的格子按行列铺开，最后一行填不满就空着（露背景）
   *   竖向   —— 所有图缩到同一个宽度，上下排成一长条
   *   横向   —— 所有图缩到同一个高度，左右排成一条
   *
   * @param {string} mode
   * @param {object} rawParams
   * @param {Array<{width:number, height:number}>} images
   * @returns {object} 版面
   */
  function computeLayout(mode, rawParams, images) {
    var p = normalizeParams(rawParams);
    if (mode !== MODE_VERTICAL && mode !== MODE_HORIZONTAL) mode = p.mode;
    p.mode = mode;
    var items = (images || []).filter(function (im) {
      return im && im.width > 0 && im.height > 0;
    });
    var cells = [];
    var width = 0;
    var height = 0;

    if (mode === MODE_VERTICAL) {
      // 所有图缩到同一个宽度。宽度是参数说了算，不是「第一张图多宽」——
      // 否则用户把图一换，输出尺寸就悄悄变了。
      var vy = p.margin;
      var vTotal = 0;
      for (var vi = 0; vi < items.length; vi++) {
        var vh = Math.max(1, Math.round(items[vi].height * (p.cellW / items[vi].width)));
        cells.push(makeCell(vi, items[vi], p.margin, vy, p.cellW, vh, p.fit));
        vy += vh + p.gap;
        vTotal += vh;
      }
      width = p.margin * 2 + p.cellW;
      height = p.margin * 2 + vTotal + p.gap * Math.max(0, items.length - 1);
    } else if (mode === MODE_HORIZONTAL) {
      var hx = p.margin;
      var hTotal = 0;
      for (var hi = 0; hi < items.length; hi++) {
        var hw = Math.max(1, Math.round(items[hi].width * (p.cellH / items[hi].height)));
        cells.push(makeCell(hi, items[hi], hx, p.margin, hw, p.cellH, p.fit));
        hx += hw + p.gap;
        hTotal += hw;
      }
      width = p.margin * 2 + hTotal + p.gap * Math.max(0, items.length - 1);
      height = p.margin * 2 + p.cellH;
    } else {
      var cols = p.cols;
      var rows = Math.ceil(items.length / cols);
      var gx = p.margin;
      var gy = p.margin;
      for (var gi = 0; gi < items.length; gi++) {
        var col = gi % cols;
        if (col === 0 && gi > 0) {
          // 换行：横向游标回到外边距，纵向游标往下挪一格
          gx = p.margin;
          gy += p.cellH + p.gap;
        }
        cells.push(makeCell(gi, items[gi], gx, gy, p.cellW, p.cellH, p.fit));
        gx += p.cellW + p.gap;
      }
      width = p.margin * 2 + cols * p.cellW + p.gap * Math.max(0, cols - 1);
      height = p.margin * 2 + rows * p.cellH + p.gap * Math.max(0, rows - 1);
    }

    return {
      mode: mode,
      params: p,
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      cells: cells,
      count: items.length,
      rows: mode === MODE_GRID ? Math.ceil(items.length / p.cols) : 0,
      cols: mode === MODE_GRID ? p.cols : 0
    };
  }

  /**
   * 画布放不放得下。
   *
   * @param {number} w
   * @param {number} h
   * @returns {{ok: boolean, reason: string}} reason 是 'side' 或 'area'，放得下时是空串
   */
  function canvasLimit(w, h) {
    if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE) return { ok: false, reason: 'side' };
    if (w * h > MAX_CANVAS_AREA) return { ok: false, reason: 'area' };
    return { ok: true, reason: '' };
  }

  /**
   * 要缩到多小才放得下。
   *
   * 每边超了按长边算，面积超了按面积开方算 —— 面积那一项是**开方**，
   * 因为长宽各缩 f 倍，面积就缩 f² 倍。
   *
   * @param {number} w
   * @param {number} h
   * @returns {number} 不大于 1 的系数
   */
  function shrinkFactor(w, h) {
    var f = 1;
    var longest = Math.max(w, h);
    if (longest > MAX_CANVAS_SIDE) f = Math.min(f, MAX_CANVAS_SIDE / longest);
    var area = w * h;
    if (area > MAX_CANVAS_AREA) f = Math.min(f, Math.sqrt(MAX_CANVAS_AREA / area));
    return f;
  }

  /**
   * 把参数按系数缩小。
   *
   * 间距、外边距、圆角一起缩 —— 只缩格子大小的话，缝会显得越来越宽，
   * 缩出来的图跟用户调的完全不是一回事。
   *
   * @param {object} params
   * @param {number} factor
   * @returns {object}
   */
  function shrinkParams(params, factor) {
    var p = normalizeParams(params);
    return {
      mode: p.mode,
      cols: p.cols,
      cellW: Math.max(MIN_CELL, Math.round(p.cellW * factor)),
      cellH: Math.max(MIN_CELL, Math.round(p.cellH * factor)),
      gap: Math.max(0, Math.round(p.gap * factor)),
      margin: Math.max(0, Math.round(p.margin * factor)),
      radius: Math.max(0, Math.round(p.radius * factor)),
      fit: p.fit
    };
  }

  /**
   * 排版，并且保证结果画得出来。
   *
   * 放得下就原样返回。放不下就**缩参数重排一次** ——
   * 重排出来的版面是按新尺寸算的，画出来是清晰的，不是把大图缩小来的。
   *
   * @param {string} mode
   * @param {object} params
   * @param {Array<{width:number, height:number}>} images
   * @returns {{params:object, layout:object, shrunk:boolean, factor:number}}
   */
  function fitLayout(mode, params, images) {
    var p = normalizeParams(params);
    if (mode !== MODE_VERTICAL && mode !== MODE_HORIZONTAL) mode = p.mode;
    p.mode = mode;
    var layout = computeLayout(mode, p, images);
    var original = { width: layout.width, height: layout.height };
    if (canvasLimit(layout.width, layout.height).ok) {
      return {
        params: p,
        layout: layout,
        original: original,
        shrunk: false,
        factor: 1
      };
    }
    var factor = shrinkFactor(layout.width, layout.height) * 0.99;
    for (var i = 0; i < 6; i++) {
      if (factor <= 0.02) break;
      p = shrinkParams(p, factor);
      layout = computeLayout(mode, p, images);
      if (canvasLimit(layout.width, layout.height).ok) {
        return {
          params: p,
          layout: layout,
          original: original,
          shrunk: true,
          factor: factor
        };
      }
      factor = shrinkFactor(layout.width, layout.height) * 0.99;
    }
    return {
      params: p,
      layout: layout,
      original: original,
      shrunk: true,
      factor: factor
    };
  }

  /**
   * 点在哪个格子里。点外面返回 -1。
   *
   * @param {object} layout
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  function cellAtPoint(layout, x, y) {
    if (!layout) return -1;
    for (var i = 0; i < layout.cells.length; i++) {
      var c = layout.cells[i];
      if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return c.index;
    }
    return -1;
  }

  /**
   * 画一个圆角矩形路径。
   *
   * `ctx.roundRect` 是较新的 API，老浏览器没有 —— 有就用它，
   * 没有就用四段 `arcTo` 拼一个出来。两条路画出来的东西一样。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} r
   */
  function roundRectPath(ctx, x, y, w, h, r) {
    var radius = clampRadius(r, w, h);
    ctx.beginPath();
    if (radius <= 0) {
      ctx.rect(x, y, w, h);
      return;
    }
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
      return;
    }
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /**
   * 按版面把图画到画布上。
   *
   * 预览和导出走的是**同一段代码**：预览多传一个缩放系数，
   * 画的是同一套版面坐标（ctx.setTransform 缩放），所以预览里
   * 看到的缝和导出的缝一模一样。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} layout
   * @param {Array} sources 原图（ImageBitmap 或 HTMLImageElement）
   * @param {object} opts
   */
  function drawLayout(ctx, layout, sources, opts) {
    if (!ctx || !layout) return;
    opts = opts || {};
    var scale = opts.scale || 1;
    var cw = opts.canvasWidth || layout.width;
    var ch = opts.canvasHeight || layout.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!opts.transparent) {
      ctx.fillStyle = opts.background || '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (var i = 0; i < layout.cells.length; i++) {
      var c = layout.cells[i];
      var src = sources[c.index];
      if (!src) continue;
      ctx.save();
      if (layout.params.radius > 0) {
        roundRectPath(ctx, c.x, c.y, c.w, c.h, layout.params.radius);
        ctx.clip();
      }
      try {
        ctx.drawImage(src, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
      } catch (e) {
        // 画不上就跳过这一格 —— 一张坏图不该让整张拼贴出不来
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /* ---------- 文案 ---------- */

  var S = {
    title: t('title', 'Put several pictures into one'),
    choose_file: t('choose_file', 'Choose image files'),
    drop_hint: t('drop_hint', 'You can drop several files into this box. The pictures are processed in your browser, nothing is uploaded.'),
    list_title: t('list_title', 'Pictures'),
    params_title: t('params_title', 'Parameters'),
    label_mode: t('label_mode', 'Layout'),
    mode_grid: t('mode_grid', 'Grid'),
    mode_vertical: t('mode_vertical', 'Vertical strip'),
    mode_horizontal: t('mode_horizontal', 'Horizontal strip'),
    hint_mode: t('hint_mode', 'A grid puts the pictures into equal cells. A vertical strip puts them one below another, all scaled to the same width. A horizontal strip puts them next to each other, all scaled to the same height.'),
    label_cols: t('label_cols', 'Columns'),
    hint_cols: t('hint_cols', 'How many pictures fit in one row. The last row stays empty when the pictures do not fill it up.'),
    label_width: t('label_width', 'Width'),
    hint_width: t('hint_width', 'The width of one cell in a grid, and the width every picture is scaled to in a vertical strip.'),
    label_height: t('label_height', 'Height'),
    hint_height: t('hint_height', 'The height of one cell in a grid, and the height every picture is scaled to in a horizontal strip.'),
    label_gap: t('label_gap', 'Gap'),
    hint_gap: t('hint_gap', 'The empty space between two pictures. Set it to zero to glue them together.'),
    label_margin: t('label_margin', 'Margin'),
    hint_margin: t('hint_margin', 'The empty space around the whole collage.'),
    label_radius: t('label_radius', 'Corner radius'),
    hint_radius: t('hint_radius', 'How much the corners are rounded. The background shows through the rounded corners.'),
    label_fit: t('label_fit', 'Fitting'),
    fit_cover: t('fit_cover', 'Fill the cell'),
    fit_contain: t('fit_contain', 'Fit inside the cell'),
    hint_fit: t('hint_fit', 'Filling crops the picture so it covers the whole cell. Fitting keeps the whole picture visible and leaves the rest empty.'),
    label_background: t('label_background', 'Background colour'),
    hint_background: t('hint_background', 'The colour behind the pictures and in the gaps.'),
    label_transparent: t('label_transparent', 'Transparent background'),
    hint_transparent: t('hint_transparent', 'The background stays see-through. The PNG will keep an alpha channel.'),
    btn_up: t('btn_up', 'Move up'),
    btn_down: t('btn_down', 'Move down'),
    btn_remove: t('btn_remove', 'Remove'),
    btn_clear: t('btn_clear', 'Remove all'),
    preview_title: t('preview_title', 'Preview'),
    hint_preview: t('hint_preview', 'The preview is scaled down to fit the page. The exported PNG has the real size.'),
    output_title: t('output_title', 'Output'),
    btn_download: t('btn_download', 'Download the collage (PNG)'),
    hint_png: t('hint_png', 'The collage is exported at the size shown in the result. Pictures are never uploaded.'),
    result_title: t('result_title', 'Result'),
    label_size: t('label_size', 'Size'),
    label_pictures: t('label_pictures', 'Pictures'),
    label_layout: t('label_layout', 'Layout'),
    err_read: t('err_read', 'The file could not be read.'),
    err_decode: t('err_decode', 'This picture could not be decoded.'),
    err_no_pictures: t('err_no_pictures', 'There are no pictures yet. Add some first.'),
    err_too_many: t('err_too_many', 'At most {n} pictures can be put into one collage.'),
    status_removed: t('status_removed', 'The picture was removed.'),
    status_moved: t('status_moved', 'The picture was moved.'),
    status_cleared: t('status_cleared', 'All pictures were removed.'),
    warn_shrunk: t('warn_shrunk', 'The collage was scaled down to {w} × {h}, because a canvas that big would not fit.')
  };

  /* ---------- 工具 ---------- */

  window.ItTools.register('image-collage', function (root) {
    var disposed = false;
    var nextId = 1;

    var state = {
      /** 每一项：{id, name, width, height, source, close} */
      items: [],
      params: {
        mode: MODE_GRID,
        cols: DEFAULT_COLS,
        cellW: DEFAULT_CELL,
        cellH: DEFAULT_CELL,
        gap: DEFAULT_GAP,
        margin: DEFAULT_MARGIN,
        radius: DEFAULT_RADIUS,
        fit: FIT_COVER
      },
      background: '#ffffff',
      transparent: false,
      layout: null,
      fit: null
    };

    /* ---------- 卡片 ---------- */

    // 不传 onFile —— 共用的上传卡只认 files[0]，多图得自己接管。
    var upload = C.uploadCard({
      accept: 'image/*',
      label: S.choose_file,
      hint: S.drop_hint
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);
    upload.input.multiple = true;

    var paramsCard = D.h('div.card', { hidden: true });
    var listCard = D.h('div.card', { hidden: true });
    var previewCard = D.h('div.card', { hidden: true });
    var outputCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(paramsCard);
    root.appendChild(listCard);
    root.appendChild(previewCard);
    root.appendChild(outputCard);
    root.appendChild(resultCard);

    /* ---------- 控件 ---------- */

    var modeSelect = D.h('select.layui-select', { id: 'ic-mode' },
      D.h('option', { value: MODE_GRID, text: S.mode_grid }),
      D.h('option', { value: MODE_VERTICAL, text: S.mode_vertical }),
      D.h('option', { value: MODE_HORIZONTAL, text: S.mode_horizontal })
    );
    modeSelect.value = state.params.mode;

    var colsInput = D.h('input.layui-input', {
      type: 'number', id: 'ic-cols', min: MIN_COLS, max: MAX_COLS, step: 1,
      value: DEFAULT_COLS, style: { width: '96px' }
    });
    var widthInput = D.h('input.layui-input', {
      type: 'number', id: 'ic-width', min: MIN_CELL, max: MAX_CELL, step: 1,
      value: DEFAULT_CELL, style: { width: '96px' }
    });
    var heightInput = D.h('input.layui-input', {
      type: 'number', id: 'ic-height', min: MIN_CELL, max: MAX_CELL, step: 1,
      value: DEFAULT_CELL, style: { width: '96px' }
    });
    var gapInput = D.h('input.layui-input', {
      type: 'number', id: 'ic-gap', min: MIN_GAP, max: MAX_GAP, step: 1,
      value: DEFAULT_GAP, style: { width: '96px' }
    });
    var marginInput = D.h('input.layui-input', {
      type: 'number', id: 'ic-margin', min: MIN_MARGIN, max: MAX_MARGIN, step: 1,
      value: DEFAULT_MARGIN, style: { width: '96px' }
    });
    var radiusInput = D.h('input.layui-input', {
      type: 'number', id: 'ic-radius', min: MIN_RADIUS, max: MAX_RADIUS, step: 1,
      value: DEFAULT_RADIUS, style: { width: '96px' }
    });
    var fitSelect = D.h('select.layui-select', { id: 'ic-fit' },
      D.h('option', { value: FIT_COVER, text: S.fit_cover }),
      D.h('option', { value: FIT_CONTAIN, text: S.fit_contain })
    );
    fitSelect.value = state.params.fit;

    var backgroundInput = D.h('input', { type: 'color', id: 'ic-background', value: state.background });
    var transparentInput = D.h('input', { type: 'checkbox', id: 'ic-transparent' });

    paramsCard.appendChild(D.h('h3', { text: S.params_title }));
    paramsCard.appendChild(U.field(S.label_mode, modeSelect, { hint: S.hint_mode }));
    paramsCard.appendChild(U.field(S.label_cols, colsInput, { hint: S.hint_cols }));
    paramsCard.appendChild(U.field(S.label_width, widthInput, { hint: S.hint_width }));
    paramsCard.appendChild(U.field(S.label_height, heightInput, { hint: S.hint_height }));
    paramsCard.appendChild(U.field(S.label_gap, gapInput, { hint: S.hint_gap }));
    paramsCard.appendChild(U.field(S.label_margin, marginInput, { hint: S.hint_margin }));
    paramsCard.appendChild(U.field(S.label_radius, radiusInput, { hint: S.hint_radius }));
    paramsCard.appendChild(U.field(S.label_fit, fitSelect, { hint: S.hint_fit }));
    paramsCard.appendChild(U.field(S.label_background, backgroundInput, { hint: S.hint_background }));
    paramsCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, transparentInput, D.h('span', { text: S.label_transparent }))
    ));
    paramsCard.appendChild(D.h('p.field-hint', { text: S.hint_transparent }));

    /* ---------- 图片列表 ---------- */

    var listBox = D.h('div.collage-list');
    var clearBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: S.btn_clear });
    listCard.appendChild(D.h('h3', { text: S.list_title }));
    listCard.appendChild(listBox);
    listCard.appendChild(D.h('div.form-actions', null, clearBtn));

    /* ---------- 预览 ---------- */

    var previewCanvas = D.h('canvas.collage-canvas');
    var previewHint = D.h('p.field-hint', { text: S.hint_preview });
    var cellHint = D.h('p.field-hint');
    previewCard.appendChild(D.h('h3', { text: S.preview_title }));
    previewCard.appendChild(D.h('div.preview-box', null, previewCanvas));
    previewCard.appendChild(previewHint);
    previewCard.appendChild(cellHint);

    /* ---------- 输出 ---------- */

    var downloadBtn = D.h('button.layui-btn', { type: 'button', text: S.btn_download });
    var statusLine = D.h('p.form-status', { id: 'ic-status' });
    outputCard.appendChild(D.h('h3', { text: S.output_title }));
    outputCard.appendChild(D.h('div.form-actions', null, downloadBtn));
    outputCard.appendChild(D.h('p.field-hint', { text: S.hint_png }));
    outputCard.appendChild(statusLine);

    /* ---------- 结果 ---------- */

    var resultBody = D.h('div');
    resultCard.appendChild(D.h('h3', { text: S.result_title }));
    resultCard.appendChild(resultBody);

    /**
     * 状态行。
     *
     * @param {string} message
     * @param {string} kind 'error' | 'warn' | 空
     */
    function setStatus(message, kind) {
      statusLine.textContent = message || '';
      statusLine.classList.toggle('is-error', kind === 'error');
      statusLine.classList.toggle('is-warn', kind === 'warn');
    }

    /* ---------- 参数 ---------- */

    /**
     * 把输入框里的值收进 state.params，然后重排。
     */
    function readParams() {
      state.params.mode = modeSelect.value === MODE_VERTICAL ? MODE_VERTICAL
        : modeSelect.value === MODE_HORIZONTAL ? MODE_HORIZONTAL : MODE_GRID;
      state.params.cols = clampInt(colsInput.value, MIN_COLS, MAX_COLS, DEFAULT_COLS);
      state.params.cellW = clampInt(widthInput.value, MIN_CELL, MAX_CELL, DEFAULT_CELL);
      state.params.cellH = clampInt(heightInput.value, MIN_CELL, MAX_CELL, DEFAULT_CELL);
      state.params.gap = clampInt(gapInput.value, MIN_GAP, MAX_GAP, DEFAULT_GAP);
      state.params.margin = clampInt(marginInput.value, MIN_MARGIN, MAX_MARGIN, DEFAULT_MARGIN);
      state.params.radius = clampInt(radiusInput.value, MIN_RADIUS, MAX_RADIUS, DEFAULT_RADIUS);
      state.params.fit = fitSelect.value === FIT_CONTAIN ? FIT_CONTAIN : FIT_COVER;
      state.background = backgroundInput.value || '#ffffff';
      state.transparent = !!transparentInput.checked;
    }

    /**
     * 某个参数在当前排版下有没有用。
     *
     * 竖向拼接只用宽度，横向拼接只用高度，网格两个都要 ——
     * 用不上的那个得藏起来，不然用户会以为改它有用。
     *
     * @param {string} name
     * @returns {boolean}
     */
    function paramUsed(name) {
      if (state.params.mode === MODE_VERTICAL) return name !== 'cols' && name !== 'height';
      if (state.params.mode === MODE_HORIZONTAL) return name !== 'cols' && name !== 'width';
      return true;
    }

    /**
     * 藏掉当前排版用不上的输入框。
     */
    function syncVisibleParams() {
      // U.field 把控件包在 div.field 里，藏的是那个包装层
      colsInput.parentNode.hidden = !paramUsed('cols');
      widthInput.parentNode.hidden = !paramUsed('width');
      heightInput.parentNode.hidden = !paramUsed('height');
    }

    [modeSelect, colsInput, widthInput, heightInput, gapInput, marginInput, radiusInput,
      fitSelect, backgroundInput, transparentInput].forEach(function (el) {
      el.addEventListener('change', function () {
        readParams();
        syncVisibleParams();
        render();
      });
      el.addEventListener('input', function () {
        readParams();
        syncVisibleParams();
        render();
      });
    });

    /* ---------- 图片 ---------- */

    /**
     * 画一张缩略图。
     *
     * @param {number} index
     * @returns {HTMLElement}
     */
    function makeThumb(index) {
      var item = state.items[index];
      var canvas = D.h('canvas.collage-thumb');
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
      var ctx = canvas.getContext('2d');
      if (ctx && item) {
        try {
          var scale = Math.max(THUMB_W / item.width, THUMB_H / item.height);
          var dw = Math.round(item.width * scale);
          var dh = Math.round(item.height * scale);
          ctx.drawImage(item.source, Math.floor((THUMB_W - dw) / 2), Math.floor((THUMB_H - dh) / 2), dw, dh);
        } catch (e) {
          // 缩略图画不上就空着，不影响拼贴
        }
      }
      return canvas;
    }

    /**
     * 重画图片列表。
     */
    function renderList() {
      D.clear(listBox);
      for (var i = 0; i < state.items.length; i++) {
        (function (index) {
          var item = state.items[index];
          var up = D.h('button.layui-btn.layui-btn-sm', { type: 'button', text: '↑', title: S.btn_up, 'aria-label': S.btn_up });
          var down = D.h('button.layui-btn.layui-btn-sm', { type: 'button', text: '↓', title: S.btn_down, 'aria-label': S.btn_down });
          var del = D.h('button.layui-btn.layui-btn-sm.layui-btn-danger', { type: 'button', text: '✕', title: S.btn_remove, 'aria-label': S.btn_remove });
          up.addEventListener('click', function () { moveItem(index, -1); });
          down.addEventListener('click', function () { moveItem(index, 1); });
          del.addEventListener('click', function () { removeItem(index); });
          var name = D.h('span.collage-item-name', { text: item.name });
          var row = D.h('div.collage-item', null,
            makeThumb(index),
            D.h('div.collage-item-info', null,
              name,
              D.h('span.collage-item-size', { text: item.width + ' × ' + item.height })
            ),
            D.h('div.collage-item-actions', null, up, down, del)
          );
          listBox.appendChild(row);
        })(i);
      }
      listBox.hidden = state.items.length === 0;
    }

    /**
     * 挪一张图。
     *
     * @param {number} index
     * @param {number} delta
     */
    function moveItem(index, delta) {
      var target = index + delta;
      if (index < 0 || index >= state.items.length) return;
      if (target < 0 || target >= state.items.length) return;
      var moved = state.items.splice(index, 1)[0];
      state.items.splice(target, 0, moved);
      setStatus(S.status_moved, '');
      render();
    }

    /**
     * 删掉一张图。
     *
     * @param {number} index
     */
    function removeItem(index) {
      if (index < 0 || index >= state.items.length) return;
      var item = state.items.splice(index, 1)[0];
      if (item && item.close) item.close();
      setStatus(S.status_removed, '');
      render();
    }

    /**
     * 全删。
     */
    function clearItems() {
      if (!state.items.length) return;
      state.items.forEach(function (item) {
        if (item && item.close) item.close();
      });
      state.items = [];
      setStatus(S.status_cleared, '');
      render();
    }

    clearBtn.addEventListener('click', clearItems);

    /**
     * 把选到的文件收进来。
     *
     * @param {FileList|Array} files
     */
    function addFiles(files) {
      var list = [];
      for (var i = 0; i < files.length; i++) list.push(files[i]);
      if (!list.length) return;
      var room = MAX_IMAGES - state.items.length;
      if (list.length > room) {
        upload.setStatus(S.err_too_many.replace('{n}', String(MAX_IMAGES)), true);
        list = list.slice(0, Math.max(0, room));
      } else {
        upload.setStatus('');
      }
      if (!list.length) return;
      var pending = list.length;
      // 先按选中的顺序占好位，再去解码 —— 见 makeSlots 的说明
      var slots = makeSlots(list);
      slots.forEach(function (slot) { slot.id = nextId++; });
      state.items = state.items.concat(slots);
      list.forEach(function (file, index) {
        var slot = slots[index];
        C.decode(file).then(function (decoded) {
          pending--;
          // 用户可能在解码还没回来之前就把这张图删了，或者整个工具已经卸载了
          if (disposed || state.items.indexOf(slot) < 0) {
            if (decoded && decoded.close) decoded.close();
            if (pending <= 0) finishBatch();
            return;
          }
          slot.width = decoded.width;
          slot.height = decoded.height;
          slot.source = decoded.source;
          slot.close = decoded.close;
          if (pending <= 0) finishBatch();
        }, function () {
          pending--;
          slot.failed = true;
          // 分清两种失败：压根不是图片文件，还是图片解不开
          var looksLikeImage = (file.type || '').indexOf('image/') === 0;
          upload.setStatus(looksLikeImage ? S.err_decode : S.err_read, true);
          if (pending <= 0) finishBatch();
        });
      });
    }

    /**
     * 一批解码都回来之后的收尾。
     */
    function finishBatch() {
      // 解不开的那些占位不能留在列表里
      state.items = state.items.filter(function (it) { return !it.failed; });
      render();
    }

    upload.input.addEventListener('change', function () {
      if (upload.input.files && upload.input.files.length) addFiles(upload.input.files);
    });
    var dropBox = upload.card.querySelector('.preview-box');
    if (dropBox) {
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (evt) {
        dropBox.addEventListener(evt, function (e) {
          e.preventDefault();
          e.stopPropagation();
        });
      });
      dropBox.addEventListener('drop', function (e) {
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) addFiles(files);
      });
    }

    /* ---------- 绘制 ---------- */

    /**
     * 原图尺寸（只取宽高，画的时候不需要位图本身）。
     *
     * @returns {Array<{width:number, height:number}>}
     */
    function imageSizes() {
      return state.items.map(function (item) {
        return { width: item.width, height: item.height };
      });
    }

    /**
     * 画预览。
     */
    function renderPreview() {
      if (!state.layout) return;
      var layout = state.layout;
      var longest = Math.max(layout.width, layout.height);
      var scale = longest > PREVIEW_MAX ? PREVIEW_MAX / longest : 1;
      var cw = Math.max(1, Math.round(layout.width * scale));
      var ch = Math.max(1, Math.round(layout.height * scale));
      previewCanvas.width = cw;
      previewCanvas.height = ch;
      var ctx = previewCanvas.getContext('2d');
      if (!ctx) return;
      drawLayout(ctx, layout, state.items.map(function (item) { return item.source; }), {
        scale: scale,
        canvasWidth: cw,
        canvasHeight: ch,
        background: state.background,
        transparent: state.transparent
      });
    }

    /**
     * 重排并刷新所有界面。
     */
    function render() {
      var hasItems = state.items.length > 0;
      paramsCard.hidden = !hasItems;
      listCard.hidden = !hasItems;
      previewCard.hidden = !hasItems;
      outputCard.hidden = !hasItems;
      resultCard.hidden = !hasItems;

      if (!hasItems) {
        state.layout = null;
        state.fit = null;
        renderList();
        return;
      }

      state.fit = fitLayout(state.params.mode, state.params, imageSizes());
      state.layout = state.fit.layout;
      // 缩参数重排之后，输入框里也得是缩过的值 —— 用户看到的就是真的。
      if (state.fit.shrunk) {
        state.params.cols = state.fit.params.cols;
        state.params.cellW = state.fit.params.cellW;
        state.params.cellH = state.fit.params.cellH;
        state.params.gap = state.fit.params.gap;
        state.params.margin = state.fit.params.margin;
        state.params.radius = state.fit.params.radius;
        colsInput.value = String(state.params.cols);
        widthInput.value = String(state.params.cellW);
        heightInput.value = String(state.params.cellH);
        gapInput.value = String(state.params.gap);
        marginInput.value = String(state.params.margin);
        radiusInput.value = String(state.params.radius);
      }

      renderList();
      renderPreview();
      renderResult();

      if (state.fit.shrunk) {
        setStatus(S.warn_shrunk
          .replace('{w}', String(state.fit.layout.width))
          .replace('{h}', String(state.fit.layout.height)), 'warn');
      }
    }

    /**
     * 画结果区。
     */
    function renderResult() {
      D.clear(resultBody);
      if (!state.layout) return;
      var layout = state.layout;
      var rows = [
        [S.label_size, layout.width + ' × ' + layout.height],
        [S.label_pictures, String(layout.count)],
        [S.label_layout, layoutText(layout)]
      ];
      var table = D.h('table.result-table');
      var tbody = D.h('tbody');
      rows.forEach(function (row) {
        tbody.appendChild(D.h('tr', null,
          D.h('th', { text: row[0] }),
          D.h('td', { text: row[1] })
        ));
      });
      table.appendChild(tbody);
      resultBody.appendChild(table);
    }

    /**
     * 版面的一段文字说明。
     *
     * @param {object} layout
     * @returns {string}
     */
    function layoutText(layout) {
      if (layout.mode === MODE_GRID) return S.mode_grid + ' ' + layout.cols + ' × ' + layout.rows;
      if (layout.mode === MODE_VERTICAL) return S.mode_vertical;
      return S.mode_horizontal;
    }

    /* ---------- 预览上的指点 ---------- */

    previewCanvas.addEventListener('click', function (e) {
      if (!state.layout) return;
      var rect = previewCanvas.getBoundingClientRect();
      // jsdom 里这个矩形全是 0 —— 除以 0 会得到 NaN，画布上的坐标就废了
      if (!rect || !rect.width || !rect.height) return;
      var scale = state.layout.width / rect.width;
      var x = Math.floor((e.clientX - rect.left) * scale);
      var y = Math.floor((e.clientY - rect.top) * scale);
      var index = cellAtPoint(state.layout, x, y);
      if (index < 0) {
        cellHint.textContent = '';
        return;
      }
      var cell = state.layout.cells[index];
      cellHint.textContent = (index + 1) + ' / ' + state.layout.count + ' — '
        + cell.w + ' × ' + cell.h;
    });

    /* ---------- 导出 ---------- */

    downloadBtn.addEventListener('click', function () {
      if (!state.layout || !state.items.length) {
        setStatus(S.err_no_pictures, 'error');
        return;
      }
      var layout = state.layout;
      var canvas = document.createElement('canvas');
      canvas.width = layout.width;
      canvas.height = layout.height;
      var ctx = canvas.getContext('2d');
      if (!ctx) {
        setStatus(S.err_no_pictures, 'error');
        return;
      }
      drawLayout(ctx, layout, state.items.map(function (item) { return item.source; }), {
        scale: 1,
        canvasWidth: layout.width,
        canvasHeight: layout.height,
        background: state.background,
        transparent: state.transparent
      });
      if (typeof canvas.toBlob !== 'function') {
        setStatus(S.err_no_pictures, 'error');
        return;
      }
      try {
        canvas.toBlob(function (blob) {
          if (!blob) {
            setStatus(S.err_no_pictures, 'error');
            return;
          }
          window.ItTools.download('collage.png', blob, 'image/png');
          setStatus('');
        }, 'image/png');
      } catch (e) {
        setStatus(String(e && e.message || e), 'error');
      }
    });

    /* ---------- 卸载 ---------- */

    syncVisibleParams();
    render();

    return {
      destroy: function () {
        disposed = true;
        // 解码出来的位图得放掉 —— 只在销毁时关的话，
        // 中途删图会一直留着上一张。
        state.items.forEach(function (item) {
          if (item && item.close) item.close();
        });
        state.items = [];
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑导出 ---------- */

  window.ItTools.logic['image-collage'] = {
    makeSlots: makeSlots,
    normalizeParams: normalizeParams,
    clampInt: clampInt,
    clampRadius: clampRadius,
    coverSource: coverSource,
    containRect: containRect,
    makeCell: makeCell,
    computeLayout: computeLayout,
    canvasLimit: canvasLimit,
    shrinkFactor: shrinkFactor,
    shrinkParams: shrinkParams,
    fitLayout: fitLayout,
    cellAtPoint: cellAtPoint,
    roundRectPath: roundRectPath,
    drawLayout: drawLayout,
    __cases: function (assert) {
      /* ---- 夹取 ---- */
      assert.eq(clampInt('123', 1, 50, 3), 50, '超出上限就夹到上限');
      assert.eq(clampInt('-5', 1, 50, 3), 1, '小于下限就夹到下限');
      assert.eq(clampInt('abc', 1, 50, 3), 3, '不是数字就用默认值');
      assert.eq(clampInt('7.6', 1, 50, 3), 8, '取整');

      /* ---- 占位 ----
         顺序必须跟用户选的顺序一致 —— 解码是异步的，
         要是等解码好了再入列，谁先解完谁就排在前面。 */
      var slots = makeSlots([{ name: 'a.png' }, { name: 'b.png' }, { name: 'c.png' }]);
      assert.eq(slots.map(function (s) { return s.name; }), ['a.png', 'b.png', 'c.png'],
        '占位按选择的顺序排');
      assert.eq(slots[0].width, 0, '占位的宽先空着');
      assert.eq(slots[0].failed, false, '占位一开始不是失败状态');
      assert.eq(makeSlots([{ name: '' }, { name: '' }]).map(function (s) { return s.name; }),
        ['image-1', 'image-2'], '没有文件名就按序号起名');
      assert.eq(makeSlots([]).length, 0, '空列表就是空列表');

      /* ---- 网格排版 ----
         两列两行：宽 = 外边距*2 + 2*格宽 + 1*间距，高同理。
         位置是累加出来的：第二列 = 外边距 + 格宽 + 间距。 */
      var four = [
        { width: 100, height: 100 }, { width: 100, height: 100 },
        { width: 100, height: 100 }, { width: 100, height: 100 }
      ];
      var grid = computeLayout('grid', {
        mode: 'grid', cols: 2, cellW: 200, cellH: 150, gap: 10, margin: 20, radius: 0, fit: 'cover'
      }, four);
      assert.eq(grid.width, 450, '网格宽度');
      assert.eq(grid.height, 350, '网格高度');
      assert.eq(grid.cells.length, 4, '四张图四个格子');
      assert.eq(grid.cells[0].x, 20, '第一格左边是外边距');
      assert.eq(grid.cells[0].y, 20, '第一格顶边是外边距');
      assert.eq(grid.cells[1].x, 230, '第二格左边是外边距 + 格宽 + 间距');
      assert.eq(grid.cells[1].y, 20, '第二格跟第一格同一行');
      assert.eq(grid.cells[2].x, 20, '第三格回到左边');
      assert.eq(grid.cells[2].y, 180, '第三格下一行');
      assert.eq(grid.cells[3].x, 230, '第四格在右下');
      assert.eq(grid.cells[0].w, 200, '格子宽度');
      assert.eq(grid.cells[0].h, 150, '格子高度');
      assert.eq(grid.rows, 2, '两行');
      assert.eq(grid.cols, 2, '两列');

      // 最后一格紧挨着第一格 —— 累加出来的位置不会有缝
      assert.eq(grid.cells[0].x + grid.cells[0].w + 10, grid.cells[1].x, '两格之间正好是间距');

      // 填不满的一行：格子不缩，行数照加
      var five = computeLayout('grid', {
        mode: 'grid', cols: 2, cellW: 200, cellH: 150, gap: 10, margin: 20, radius: 0, fit: 'cover'
      }, four.concat([{ width: 100, height: 100 }]));
      assert.eq(five.cells.length, 5, '五张图五个格子');
      assert.eq(five.rows, 3, '三行');
      assert.eq(five.width, 450, '宽度不变，最后一行空着');
      assert.eq(five.height, 510, '高度按三行算');

      /* ---- 填满 / 放进格子 ---- */
      // 200×150 的格子放 100×100 的图：缩放比取 2，裁成 100×75，上下各留 12
      var cover = coverSource(100, 100, 200, 150);
      assert.eq(cover, { sx: 0, sy: 12, sw: 100, sh: 75 }, '填满：裁掉上下');
      // 放进格子：正方形的图放进 200×150 的格子，缩放比取 1.5 → 150×150，左右各留 25
      var contain = containRect(100, 100, 0, 0, 200, 150);
      assert.eq(contain, { dx: 25, dy: 0, dw: 150, dh: 150 }, '放进：左右留白');
      // 宽图放进格子：缩放比取 1 → 200×100，上下各留 25
      assert.eq(containRect(200, 100, 0, 0, 200, 150),
        { dx: 0, dy: 25, dw: 200, dh: 100 }, '放进：上下留白');
      // 格子比图小的时候，contain 不能把图缩成 0
      assert(containRect(1000, 10, 0, 0, 50, 50).dh >= 1, '放进格子至少一个像素高');

      /* ---- 竖向拼接 ----
         两张图都缩到 300 宽：第一张是正方形 → 300 高，第二张 200×100 → 150 高。 */
      var vert = computeLayout('vertical', {
        mode: 'vertical', cols: 3, cellW: 300, cellH: 300, gap: 0, margin: 0, radius: 0, fit: 'cover'
      }, [{ width: 100, height: 100 }, { width: 200, height: 100 }]);
      assert.eq(vert.width, 300, '竖向拼出来的宽度就是参数里的宽度');
      assert.eq(vert.height, 450, '竖向拼出来的高度是各图高之和');
      assert.eq(vert.cells[0].y, 0, '第一张贴在顶上');
      assert.eq(vert.cells[0].h, 300, '第一张缩到 300 宽就是 300 高');
      assert.eq(vert.cells[1].y, 300, '第二张紧接在第一张下面');
      assert.eq(vert.cells[1].h, 150, '第二张等比缩放');
      // 宽度不由第一张图决定 —— 换一张图，输出宽度不能变
      var vert2 = computeLayout('vertical', {
        mode: 'vertical', cols: 3, cellW: 300, cellH: 300, gap: 0, margin: 0, radius: 0, fit: 'cover'
      }, [{ width: 400, height: 400 }, { width: 200, height: 100 }]);
      assert.eq(vert2.width, 300, '换了图，宽度还是参数说了算');

      /* ---- 横向拼接 ---- */
      var horiz = computeLayout('horizontal', {
        mode: 'horizontal', cols: 3, cellW: 300, cellH: 300, gap: 0, margin: 0, radius: 0, fit: 'cover'
      }, [{ width: 100, height: 100 }, { width: 200, height: 100 }]);
      assert.eq(horiz.height, 300, '横向拼出来的高度就是参数里的高度');
      // 所有图缩到同一个高度 300：正方形变 300 宽，2:1 的变 600 宽
      assert.eq(horiz.width, 900, '横向拼出来的宽度是各图缩放后宽度之和');
      assert.eq(horiz.cells[1].x, 300, '第二张紧接在第一张右边');

      /* ---- 间距与外边距 ---- */
      var gapped = computeLayout('vertical', {
        mode: 'vertical', cols: 1, cellW: 100, cellH: 100, gap: 20, margin: 10, radius: 0, fit: 'cover'
      }, [{ width: 100, height: 100 }, { width: 100, height: 100 }]);
      assert.eq(gapped.width, 120, '竖向：宽度 + 两侧外边距');
      assert.eq(gapped.height, 240, '竖向：两张 100 高 + 一条 20 的缝 + 两侧 10');
      assert.eq(gapped.cells[1].y, 130, '第二张在第一张下面隔着缝');

      /* ---- 圆角 ---- */
      assert.eq(clampRadius(100, 50, 30), 15, '圆角不超过短边的一半');
      assert.eq(clampRadius(0, 50, 30), 0, '半径为零就是直角');
      assert.eq(clampRadius(-5, 50, 30), 0, '负半径当直角');

      /* ---- 画布上限 ---- */
      assert.eq(canvasLimit(100, 100).ok, true, '小图放得下');
      assert.eq(canvasLimit(32767, 10).ok, true, '刚好到边长上限放得下');
      assert.eq(canvasLimit(32768, 10).reason, 'side', '超了边长上限');
      assert.eq(canvasLimit(20000, 20000).reason, 'area', '超了面积上限');
      assert.eq(canvasLimit(20000, 20000).ok, false, '超限就是放不下');
      // 面积那一项要开方：长宽各缩一半，面积就变成四分之一
      assert(Math.abs(shrinkFactor(20000, 20000) - Math.sqrt(MAX_CANVAS_AREA / 400000000)) < 1e-9,
        '面积超限时按开方缩');
      assert(Math.abs(shrinkFactor(40000, 100) - MAX_CANVAS_SIDE / 40000) < 1e-9,
        '边长超限时按长边缩');

      /* ---- 缩参数重排 ---- */
      var many = [];
      for (var i = 0; i < 50; i++) many.push({ width: 100, height: 100 });
      var big = fitLayout('grid', {
        mode: 'grid', cols: 12, cellW: 2000, cellH: 2000, gap: 200, margin: 400, radius: 0, fit: 'cover'
      }, many);
      assert.eq(big.shrunk, true, '放不下就缩');
      assert.eq(canvasLimit(big.layout.width, big.layout.height).ok, true, '缩完放得下了');
      assert(big.layout.width < big.original.width, '缩完比原来小');
      // 缩参数的时候缝也跟着缩 —— 只缩格子的话缝会显得越来越宽
      assert(big.params.gap < 200, '缝也跟着缩了');
      // 放得下的时候一点都不动
      var small = fitLayout('grid', {
        mode: 'grid', cols: 2, cellW: 100, cellH: 100, gap: 10, margin: 10, radius: 0, fit: 'cover'
      }, four);
      assert.eq(small.shrunk, false, '放得下就不缩');
      assert.eq(small.factor, 1, '放得下系数是 1');
      assert.eq(small.layout.width, 230, '放得下时尺寸就是算出来的那个');

      /* ---- 点格子 ---- */
      assert.eq(cellAtPoint(grid, 25, 25), 0, '点在第一格');
      assert.eq(cellAtPoint(grid, 250, 25), 1, '点在第二格');
      assert.eq(cellAtPoint(grid, 25, 190), 2, '点在第三格');
      assert.eq(cellAtPoint(grid, 0, 0), -1, '点在外边距上不算格子');
      assert.eq(cellAtPoint(grid, 500, 500), -1, '点在画布外面');
      assert.eq(cellAtPoint(null, 1, 1), -1, '没有版面时返回 -1');

      /* ---- 圆角路径 ----
         有 roundRect 就用它，没有就用四段 arcTo —— 两条路画出来一样，
         但不能一条路都没有（那就没有圆角）。 */
      var calls = [];
      var modern = {
        beginPath: function () { calls.push('beginPath'); },
        rect: function () { calls.push('rect'); },
        roundRect: function () { calls.push('roundRect'); },
        arcTo: function () { calls.push('arcTo'); },
        closePath: function () { calls.push('closePath'); }
      };
      roundRectPath(modern, 0, 0, 100, 50, 8);
      assert(calls.indexOf('roundRect') >= 0, '有 roundRect 就用它');
      assert(calls.indexOf('arcTo') < 0, '有 roundRect 就不走 arcTo');

      calls = [];
      var legacy = {
        beginPath: function () { calls.push('beginPath'); },
        rect: function () { calls.push('rect'); },
        arcTo: function () { calls.push('arcTo'); },
        moveTo: function () { calls.push('moveTo'); },
        closePath: function () { calls.push('closePath'); }
      };
      roundRectPath(legacy, 0, 0, 100, 50, 8);
      assert.eq(calls.filter(function (c) { return c === 'arcTo'; }).length, 4, '没有 roundRect 就画四段 arcTo');

      calls = [];
      roundRectPath(modern, 0, 0, 100, 50, 0);
      assert(calls.indexOf('rect') >= 0, '半径为零就画直角矩形');

      /* ---- 画布上限常量 ---- */
      assert.eq(MAX_CANVAS_SIDE, 32767, '边长上限');
      assert.eq(MAX_CANVAS_AREA, 268435456, '面积上限');
    }
  };
})();
