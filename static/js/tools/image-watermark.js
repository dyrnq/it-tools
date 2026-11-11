/* ==========================================================================
   文字水印（image-watermark）

   给图片加一段文字水印 —— 写文字、调字体和颜色、选位置（或平铺满图），
   实时预览，然后导出 PNG / JPEG / WebP。

   这个工具的核心不是界面，是**几何**。四件事必须做对：

   - **预览和导出必须是同一张图**。预览是缩小的、导出是原图尺寸，
     如果两边各量一遍文字，Chrome 的字形整形在不同字号上有不同的定点量化
     （推进宽度约 1/64 px），量出来会差零点几个像素 —— 差一点点不影响锚点，
     但**可能让平铺的格数差一格**，预览和导出的水印数量就不一样了。
     所以布局只算一次（原图分辨率），预览是把同一套坐标缩放 s 倍画上去。

   - **量文字必须在单位变换下做**。`ctx.font` 不继承页面的 CSS 字体，
     `measureText` 的 `actualBoundingBox*` 又会把 CTM 的变换映射进去 ——
     在旋转过或缩放过的上下文里量，量到的是变换之后的框。
     布局和锚点都依赖这些数，再乘一次变换就错了。

   - **描边要算进包围盒**。`strokeText` 沿着字形轮廓**居中**描，
     四周各长 `lineWidth / 2`。少算这一圈，水印就会压到边距外面去。

   - **放不下就缩小字号**。一段长文字转到 45° 之后，外接框比图片还大，
     这时候没有别的办法：按比例缩到刚好放得下，并把缩过的字号告诉用户。

   图片一个字节都不出浏览器：解码、排版、绘制、编码全在本地完成。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-watermark');

  /** 预览画布的最长边 —— 预览只是给人看的，没必要按原图像素开画布。 */
  var PREVIEW_MAX = 640;

  /** 浏览器画布的上限：每边 32767、总面积 268435456（约 2.68 亿像素）。 */
  var MAX_CANVAS_SIDE = 32767;
  var MAX_CANVAS_AREA = 268435456;

  /** 预览的防抖毫秒。预览很便宜，改滑块时跟手一点。 */
  var PREVIEW_DEBOUNCE_MS = 80;

  /** 导出的防抖毫秒。全分辨率要画一遍，等用户停手再算。 */
  var EXPORT_DEBOUNCE_MS = 350;

  /**
   * 三档字体的完整字体栈。
   *
   * `ctx.font` 不继承页面的 CSS font-family —— 只认通用族或者自己写全的栈。
   * 每档都带上 CJK 家族：`'Noto Sans'` 里**没有**汉字，光写它等于没写
   * （app.js 里的等宽 CJK 字体已经踩过这个坑）。
   */
  var FONT_STACKS = {
    sans: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'WenQuanYi Zen Hei', 'Droid Sans Fallback', sans-serif",
    serif: "Georgia, 'Times New Roman', 'Noto Serif', 'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', SimSun, serif",
    mono: "ui-monospace, 'DejaVu Sans Mono', Menlo, Consolas, 'Noto Sans Mono', 'Noto Sans Mono CJK SC', monospace"
  };

  var S = {
    title: t('title', 'Add a text watermark to an image'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.'),
    watermark_title: t('watermark_title', 'Watermark'),
    label_text: t('label_text', 'Watermark text'),
    hint_text: t('hint_text', 'Several lines are allowed; each line is drawn on its own. Leave it empty to draw no watermark at all.'),
    label_font: t('label_font', 'Font'),
    font_sans: t('font_sans', 'Sans serif'),
    font_serif: t('font_serif', 'Serif'),
    font_mono: t('font_mono', 'Monospace'),
    label_bold: t('label_bold', 'Bold'),
    label_size: t('label_size', 'Size'),
    hint_size: t('hint_size', 'The size is a percentage of the shorter side of the picture, so the preview and the export have the same proportions.'),
    label_color: t('label_color', 'Colour'),
    label_opacity: t('label_opacity', 'Opacity'),
    hint_opacity: t('hint_opacity', '0 is invisible, 100 is fully opaque.'),
    label_outline: t('label_outline', 'Outline'),
    hint_outline: t('hint_outline', 'A stroke around the letters, so the watermark stays readable on a light picture.'),
    label_outline_color: t('label_outline_color', 'Outline colour'),
    label_outline_width: t('label_outline_width', 'Outline width'),
    layout_title: t('layout_title', 'Layout'),
    label_position: t('label_position', 'Position'),
    pos_tl: t('pos_tl', 'Top left'),
    pos_tc: t('pos_tc', 'Top centre'),
    pos_tr: t('pos_tr', 'Top right'),
    pos_ml: t('pos_ml', 'Middle left'),
    pos_mc: t('pos_mc', 'Centre'),
    pos_mr: t('pos_mr', 'Middle right'),
    pos_bl: t('pos_bl', 'Bottom left'),
    pos_bc: t('pos_bc', 'Bottom centre'),
    pos_br: t('pos_br', 'Bottom right'),
    pos_tile: t('pos_tile', 'Tile'),
    hint_tile: t('hint_tile', 'The watermark is repeated over the whole picture. The copies at the edge are cut off on purpose, and the margin does not apply.'),
    label_angle: t('label_angle', 'Angle'),
    hint_angle: t('hint_angle', '0 is horizontal. A positive angle turns the text clockwise.'),
    label_margin: t('label_margin', 'Margin'),
    hint_margin: t('hint_margin', 'How far the watermark stays from the edge, as a percentage of the shorter side.'),
    label_gap: t('label_gap', 'Gap'),
    hint_gap: t('hint_gap', 'The distance between two watermarks when tiling, as a percentage of the shorter side.'),
    preview_title: t('preview_title', 'Preview'),
    hint_preview: t('hint_preview', 'The preview is smaller than the export. It is the same picture scaled down, so the watermark sits in the same place.'),
    label_format: t('label_format', 'Output format'),
    label_quality: t('label_quality', 'Quality'),
    hint_quality: t('hint_quality', 'PNG is lossless — the quality setting does not change it.'),
    label_matte: t('label_matte', 'Matte colour'),
    hint_matte: t('hint_matte', 'Only JPEG needs a matte: it has no transparency, so the transparent areas are filled with this colour.'),
    result_title: t('result_title', 'Result'),
    label_item: t('label_item', 'Item'),
    label_value: t('label_value', 'Value'),
    label_source_size: t('label_source_size', 'Original size'),
    label_output_size: t('label_output_size', 'Output size'),
    label_file_size: t('label_file_size', 'File size'),
    label_output_format: t('label_output_format', 'Saved as'),
    label_watermark_text: t('label_watermark_text', 'Watermark'),
    label_watermark_size: t('label_watermark_size', 'Font size'),
    label_watermark_layout: t('label_watermark_layout', 'Layout'),
    no_watermark: t('no_watermark', 'None'),
    shrunk_to_fit: t('shrunk_to_fit', 'shrunk to fit'),
    no_result: t('no_result', 'No image yet.'),
    download: t('download', 'Download the watermarked image'),
    status_reading: t('status_reading', 'Reading the file…'),
    status_encoding: t('status_encoding', 'Encoding…'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    err_canvas_limit: t('err_canvas_limit', 'A browser canvas cannot hold {width} × {height} pixels (the limit is {max} pixels per side and {area} megapixels in total), so nothing was encoded.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.'),
    warn_fallback: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.'),
    warn_scaled: t('warn_scaled', 'The browser could not allocate a canvas of {width} × {height}, so the image was saved at {actualWidth} × {actualHeight}.'),
    hint_no_font: t('hint_no_font', 'This machine has no font that can draw these characters, so the watermark may come out as empty boxes.')
  };

  /* ---------- 纯逻辑（与画布无关，node 里能直接跑） ---------- */

  /**
   * 把一个数夹进区间。不是数字就退回 fallback。
   *
   * @param {*} v
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   */
  function clampPercent(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /**
   * 保留两位小数。
   *
   * 字号是「短边的百分之几」换算出来的，取整会让比例对不上
   * （29/480 ≠ 6.00%），差 0.7% 看不出来，但既然能算准就算准。
   *
   * @param {number} v
   * @returns {number}
   */
  function round2(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  /**
   * 字号：图片短边的百分之几 → 像素。
   *
   * @param {number} shorterSide
   * @param {number} sizePct
   * @returns {number}
   */
  function fontSizeFor(shorterSide, sizePct) {
    var s = Number(shorterSide);
    var p = Number(sizePct);
    if (!isFinite(s) || !isFinite(p)) return 0;
    return round2(s * p / 100);
  }

  /**
   * 边距：图片短边的百分之几 → 像素。
   *
   * @param {number} shorterSide
   * @param {number} marginPct
   * @returns {number}
   */
  function marginFor(shorterSide, marginPct) {
    var s = Number(shorterSide);
    var p = Number(marginPct);
    if (!isFinite(s) || !isFinite(p)) return 0;
    return round2(s * p / 100);
  }

  /**
   * 间距：图片短边的百分之几 → 像素。
   *
   * @param {number} shorterSide
   * @param {number} gapPct
   * @returns {number}
   */
  function gapFor(shorterSide, gapPct) {
    var s = Number(shorterSide);
    var p = Number(gapPct);
    if (!isFinite(s) || !isFinite(p)) return 0;
    return round2(s * p / 100);
  }

  /**
   * 把文字拆成行。
   *
   * `\r\n` 要一起拆 —— 否则每行尾巴上挂个 `\r`，量出来的宽度就多了。
   * 行尾的空行不算行（textarea 里手滑多敲的一个回车不该多出一行空框），
   * 中间的空行保留（那是真的空行）。
   *
   * @param {*} text
   * @returns {string[]}
   */
  function splitLines(text) {
    var parts = String(text == null ? '' : text).split(/\r\n|\r|\n/);
    while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    return parts.length ? parts : [''];
  }

  /**
   * 文字是不是全是空白。
   *
   * 不是看整串 trim 一下 —— `"\n\n  \n"` 整串 trim 完还剩东西，
   * 但它每一行都是空的，不该画水印。
   *
   * @param {*} text
   * @returns {boolean}
   */
  function isBlankText(text) {
    var lines = splitLines(text);
    var i;
    for (i = 0; i < lines.length; i++) {
      if (String(lines[i]).replace(/\s+/g, '') !== '') return false;
    }
    return true;
  }

  /**
   * 文字块的尺寸和每行的绘制偏移。
   *
   * 描边是**对称**的（`strokeText` 沿字形轮廓居中描），所以块的中心
   * 仍然是字框的中心，只是尺寸胀大一个描边宽度。胀大要在旋转**之前**做 ——
   先胀大再旋转，胀出来的那一圈也跟着转；反过来会少算。
   *
   * @param {number[]} advances 每行的推进宽度
   * @param {object} metrics {ascent, descent, lineHeight, strokePx}
   * @returns {object} {width, height, glyphHeight, offsets}
   */
  function textBlock(advances, metrics) {
    var list = advances || [];
    var n = list.length;
    var maxAdvance = 0;
    var stroke = Number(metrics.strokePx) || 0;
    var lineHeight = Number(metrics.lineHeight) || 0;
    var glyphHeight = metrics.ascent + (n - 1) * lineHeight + metrics.descent;
    var offsets = [];
    var i;
    for (i = 0; i < n; i++) {
      if (list[i] > maxAdvance) maxAdvance = list[i];
      offsets.push({
        x: -list[i] / 2,
        y: (metrics.ascent + i * lineHeight) - glyphHeight / 2
      });
    }
    return {
      width: maxAdvance + stroke,
      height: glyphHeight + stroke,
      glyphHeight: glyphHeight,
      offsets: offsets
    };
  }

  /**
   * 矩形绕中心旋转 θ 之后的轴对齐外接框。
   *
   * 对尺寸是**齐次**的（放大 k 倍，外接框也放大 k 倍）——
   * 自动缩小字号的时候靠这个性质算「缩多少才刚好放得下」。
   *
   * @param {number} w
   * @param {number} h
   * @param {number} angleDeg
   * @returns {object} {width, height}
   */
  function rotatedExtent(w, h, angleDeg) {
    var sc = angleSinCos(angleDeg);
    var cw = Math.abs(sc.c);
    var sw = Math.abs(sc.s);
    return {
      width: w * cw + h * sw,
      height: w * sw + h * cw
    };
  }

  /**
   * 边距框：四边各缩进 margin。
   *
   * @param {number} imgW
   * @param {number} imgH
   * @param {number} marginPx
   * @returns {object} {left, top, right, bottom, width, height}
   */
  function marginBox(imgW, imgH, marginPx) {
    var w = Number(imgW) || 0;
    var h = Number(imgH) || 0;
    var m = Math.max(0, Number(marginPx) || 0);
    return {
      left: m,
      top: m,
      right: Math.max(m, w - m),
      bottom: Math.max(m, h - m),
      width: Math.max(0, w - 2 * m),
      height: Math.max(0, h - 2 * m)
    };
  }

  /**
   * 把水印锚到边距框的某个角 / 边 / 中心。
   *
   * 位置串的第 0 位是垂直（t/m/b），第 1 位是水平（l/c/r）。
   * 返回的是**绘制原点** —— 旋转后的外接框的中心，也就是块的中心。
   *
   * @param {string} pos tl/tc/tr/ml/mc/mr/bl/bc/br
   * @param {number} bw 旋转后的外接宽
   * @param {number} bh 旋转后的外接高
   * @param {number} imgW
   * @param {number} imgH
   * @param {number} marginPx
   * @returns {object} {x, y, left, top, right, bottom}
   */
  function anchorBox(pos, bw, bh, imgW, imgH, marginPx) {
    var p = String(pos == null ? '' : pos);
    var alignH = p.charAt(1);
    var alignV = p.charAt(0);
    if (alignH !== 'l' && alignH !== 'c' && alignH !== 'r') alignH = 'r';
    if (alignV !== 't' && alignV !== 'm' && alignV !== 'b') alignV = 'b';

    var box = marginBox(imgW, imgH, marginPx);
    var x;
    var y;
    if (alignH === 'l') x = box.left + bw / 2;
    else if (alignH === 'c') x = imgW / 2;
    else x = box.right - bw / 2;
    if (alignV === 't') y = box.top + bh / 2;
    else if (alignV === 'm') y = imgH / 2;
    else y = box.bottom - bh / 2;

    // 夹回图内 —— 文字比图还宽的时候这个区间是空的，退回居中
    if (bw >= imgW) x = imgW / 2;
    else x = Math.min(Math.max(x, bw / 2), imgW - bw / 2);
    if (bh >= imgH) y = imgH / 2;
    else y = Math.min(Math.max(y, bh / 2), imgH - bh / 2);

    return {
      x: x, y: y,
      left: x - bw / 2, top: y - bh / 2,
      right: x + bw / 2, bottom: y + bh / 2
    };
  }

  /**
   * 要缩到多小才放得下。
   *
   * @param {number} bw 外接宽
   * @param {number} bh 外接高
   * @param {number} availW 可用宽
   * @param {number} availH 可用高
   * @returns {number} ≤ 1
   */
  function fitScale(bw, bh, availW, availH) {
    var w = Number(bw) || 0;
    var h = Number(bh) || 0;
    var aw = Number(availW);
    var ah = Number(availH);
    var fit = 1;
    if (w > 0 && isFinite(aw) && aw >= 0 && aw < w) fit = Math.min(fit, aw / w);
    if (h > 0 && isFinite(ah) && ah >= 0 && ah < h) fit = Math.min(fit, ah / h);
    return fit;
  }

  /**
   * 平铺的网格。
   *
   * 格子在**旋转空间**里排（`ctx.rotate` 是绕原点转的，所以要先平移到中心）。
   * 网格以图片中心为中心：偶数格时中心落在两块之间的缝里，补成奇数之后
   * 正好有一块落在正中间，图案关于中心对称。
   *
   * @param {number} imgW
   * @param {number} imgH
   * @param {number} angleDeg
   * @param {number} cellW
   * @param {number} cellH
   * @returns {object} {cols, rows, cellW, cellH, originX, originY}
   */
  function tileGrid(imgW, imgH, angleDeg, cellW, cellH) {
    var w = Number(imgW) || 0;
    var h = Number(imgH) || 0;
    var sc = angleSinCos(angleDeg);
    var cw = Math.abs(sc.c);
    var sw = Math.abs(sc.s);
    // 旋转空间里图片的外接矩形
    var spanW = w * cw + h * sw;
    var spanH = w * sw + h * cw;
    var cW = Math.max(1, Number(cellW) || 1);
    var cH = Math.max(1, Number(cellH) || 1);
    var cols = Math.max(1, Math.ceil(spanW / cW));
    var rows = Math.max(1, Math.ceil(spanH / cH));
    if (cols % 2 === 0) cols++;
    if (rows % 2 === 0) rows++;
    return {
      cols: cols,
      rows: rows,
      cellW: cW,
      cellH: cH,
      originX: -cols * cW / 2,
      originY: -rows * cH / 2
    };
  }

  /**
   * 画布装不装得下这个尺寸。
   *
   * 内核遇到画布分配失败会自己把长宽减半，那样下载到的就不是用户要的尺寸，
   * 所以工具自己先查一遍。
   *
   * @param {number} w
   * @param {number} h
   * @returns {object} {ok, reason}
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
   * 把角度折进 (−180, 180]。
   *
   * @param {number} angle
   * @returns {number}
   */
  function normalizeAngle(angle) {
    var a = Number(angle);
    if (!isFinite(a)) return 0;
    var r = a % 360;
    if (r > 180) r -= 360;
    if (r <= -180) r += 360;
    return r;
  }

  /**
   * 90° 的整倍数取整 —— 免得 Math.cos(90°) 的 6.1e-17 混进来。
   *
   * @param {number} angle
   * @returns {number}
   */
  function snapAngle(angle) {
    var a = Number(angle);
    if (!isFinite(a)) return 0;
    var r = a % 90;
    if (Math.abs(r) < 1e-9) return Math.round(a / 90) * 90;
    return a;
  }

  /**
   * 角度的正弦余弦。90° 的整倍数给精确值。
   *
   * @param {number} angle
   * @returns {object} {c, s}
   */
  function angleSinCos(angle) {
    var deg = ((snapAngle(angle) % 360) + 360) % 360;
    if (deg === 0) return { c: 1, s: 0 };
    if (deg === 90) return { c: 0, s: 1 };
    if (deg === 180) return { c: -1, s: 0 };
    if (deg === 270) return { c: 0, s: -1 };
    var rad = deg * Math.PI / 180;
    return { c: Math.cos(rad), s: Math.sin(rad) };
  }

  /**
   * 位置串对应的文案键。
   *
   * @param {string} pos
   * @returns {string}
   */
  function positionLabelKey(pos) {
    var p = String(pos == null ? '' : pos);
    if (p === 'tile') return 'pos_tile';
    if ('tl tc tr ml mc mr bl bc br'.indexOf(p) >= 0) return 'pos_' + p;
    return 'pos_br';
  }

  /**
   * 造一张画布。
   *
   * @param {number} w
   * @param {number} h
   * @returns {HTMLCanvasElement}
   */
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('image-watermark', function (root) {
    var disposed = false;
    /** 竞态闸门。慢的那次算完了不许盖掉快的那次的结果。 */
    var ticket = 0;
    var previewTimer = null;
    var exportTimer = null;
    /** 量文字用的空画布 —— 量的时候必须是单位变换。 */
    var measureCanvas = null;
    var measureCtx = null;

    var state = {
      name: '',
      size: 0,
      sourceFormat: '',
      animation: null,
      file: null,
      decoded: null,
      /** 原图尺寸。 */
      width: 0,
      height: 0,
      /* 水印 */
      text: '',
      font: 'sans',
      bold: false,
      sizePct: 6,
      color: '#ffffff',
      opacity: 50,
      outlineOn: false,
      outlineColor: '#000000',
      outlinePct: 12,
      /* 布局 */
      position: 'br',
      angle: -30,
      marginPct: 4,
      gapPct: 15,
      /* 输出 */
      formatId: 'png',
      quality: 90,
      matte: '#ffffff',
      /** 算好的布局（预览和导出共用同一份）。 */
      layout: null,
      result: null,
      /** 结果图的 object URL。 */
      resultUrl: ''
    };

    /* ---------- 卡片 ---------- */

    var upload = C.uploadCard({
      accept: 'image/*',
      label: S.choose_file,
      hint: S.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);

    var watermarkCard = D.h('div.card', { hidden: true });
    var layoutCard = D.h('div.card', { hidden: true });
    var previewCard = D.h('div.card', { hidden: true });
    var outputCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(watermarkCard);
    root.appendChild(layoutCard);
    root.appendChild(previewCard);
    root.appendChild(outputCard);
    root.appendChild(resultCard);

    /* ---------- 控件 ---------- */

    /**
     * 造一个滑块：上面是标签（带读数），下面是滑杆。
     *
     * @param {string} id
     * @param {string} labelText
     * @param {number} min
     * @param {number} max
     * @param {number} value
     * @param {string} hint
     * @param {function(number): void} onChange
     * @returns {object} {field, input, set}
     */
    function makeSlider(id, labelText, min, max, value, hint, onChange) {
      var input = D.h('input.slider', {
        type: 'range', id: id, min: min, max: max, step: 1, value: value
      });
      var label = D.h('label.field-label', { for: id, text: labelText + ': ' + value });
      var field = D.h('div.field', null, label, input);
      if (hint) field.appendChild(D.h('p.field-hint', { text: hint }));

      input.addEventListener('input', function () {
        var v = Number(input.value);
        if (!isFinite(v)) return;
        label.textContent = labelText + ': ' + v;
        onChange(v);
      });

      return {
        field: field,
        input: input,
        /** 把值写回控件。值一样就不写，免得打断正在拖的手。 */
        set: function (v) {
          var s = String(v);
          if (input.value !== s) input.value = s;
          label.textContent = labelText + ': ' + v;
        }
      };
    }

    /* --- 水印卡 --- */

    var textArea = D.h('textarea', { rows: 3, id: 'wm-text' });
    var fontHint = D.h('p.field-hint');
    var fontSelect = D.h('select.layui-select', { id: 'wm-font' },
      D.h('option', { value: 'sans', text: S.font_sans }),
      D.h('option', { value: 'serif', text: S.font_serif }),
      D.h('option', { value: 'mono', text: S.font_mono })
    );
    var boldInput = D.h('input', { type: 'checkbox', id: 'wm-bold' });
    var colorInput = D.h('input', { type: 'color', value: state.color, id: 'wm-color' });
    var outlineInput = D.h('input', { type: 'checkbox', id: 'wm-outline' });
    var outlineColorInput = D.h('input', { type: 'color', value: state.outlineColor, id: 'wm-outline-color' });

    var size = makeSlider('wm-size', S.label_size, 1, 40, state.sizePct, S.hint_size,
      function (v) { state.sizePct = v; refresh(); });
    var opacity = makeSlider('wm-opacity', S.label_opacity, 0, 100, state.opacity, S.hint_opacity,
      function (v) { state.opacity = v; refresh(); });
    var outlineWidth = makeSlider('wm-outline-width', S.label_outline_width, 2, 40, state.outlinePct, null,
      function (v) { state.outlinePct = v; refresh(); });

    watermarkCard.appendChild(D.h('h3', { text: S.watermark_title }));
    watermarkCard.appendChild(U.field(S.label_text, textArea, { wide: true, hint: S.hint_text }));
    watermarkCard.appendChild(fontHint);
    watermarkCard.appendChild(U.field(S.label_font, fontSelect));
    watermarkCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, boldInput, D.h('span', { text: S.label_bold }))
    ));
    watermarkCard.appendChild(D.h('div.grid', {
      style: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }
    }, size.field, opacity.field));
    watermarkCard.appendChild(U.field(S.label_color, colorInput));
    watermarkCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, outlineInput, D.h('span', { text: S.label_outline }))
    ));
    watermarkCard.appendChild(U.field(S.label_outline_color, outlineColorInput, { hint: S.hint_outline }));
    watermarkCard.appendChild(outlineWidth.field);

    /* --- 布局卡 --- */

    var positionSelect = D.h('select.layui-select', { id: 'wm-position' },
      D.h('option', { value: 'tl', text: S.pos_tl }),
      D.h('option', { value: 'tc', text: S.pos_tc }),
      D.h('option', { value: 'tr', text: S.pos_tr }),
      D.h('option', { value: 'ml', text: S.pos_ml }),
      D.h('option', { value: 'mc', text: S.pos_mc }),
      D.h('option', { value: 'mr', text: S.pos_mr }),
      D.h('option', { value: 'bl', text: S.pos_bl }),
      D.h('option', { value: 'bc', text: S.pos_bc }),
      D.h('option', { value: 'br', text: S.pos_br }),
      D.h('option', { value: 'tile', text: S.pos_tile })
    );
    positionSelect.value = state.position;

    var angle = makeSlider('wm-angle', S.label_angle, -180, 180, state.angle, S.hint_angle,
      function (v) { state.angle = v; refresh(); });
    var margin = makeSlider('wm-margin', S.label_margin, 0, 20, state.marginPct, S.hint_margin,
      function (v) { state.marginPct = v; refresh(); });
    var gap = makeSlider('wm-gap', S.label_gap, 0, 50, state.gapPct, S.hint_gap,
      function (v) { state.gapPct = v; refresh(); });

    layoutCard.appendChild(D.h('h3', { text: S.layout_title }));
    layoutCard.appendChild(U.field(S.label_position, positionSelect));
    layoutCard.appendChild(D.h('div.grid', {
      style: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }
    }, angle.field, margin.field));
    layoutCard.appendChild(gap.field);

    /* --- 输出卡 --- */

    var formatSelect = D.h('select.layui-select', { id: 'wm-format' },
      D.h('option', { value: 'png', text: 'PNG' }),
      D.h('option', { value: 'jpeg', text: 'JPEG' }),
      D.h('option', { value: 'webp', text: 'WebP' })
    );
    var qualityInput = D.h('input.slider', { type: 'range', id: 'wm-quality', min: 1, max: 100, step: 1, value: state.quality });
    var qualityHint = D.h('p.field-hint');
    var matteInput = D.h('input', { type: 'color', value: state.matte, id: 'wm-matte' });
    var statusLine = D.h('p.form-status');

    outputCard.appendChild(D.h('h3', { text: S.label_format }));
    outputCard.appendChild(U.field(S.label_format, formatSelect));
    outputCard.appendChild(U.field(S.label_quality, qualityInput));
    outputCard.appendChild(qualityHint);
    outputCard.appendChild(U.field(S.label_matte, matteInput, { hint: S.hint_matte }));
    outputCard.appendChild(statusLine);

    /* --- 预览卡 --- */

    var previewCanvas = D.h('canvas');
    var previewSize = D.h('p.field-hint');
    previewCard.appendChild(D.h('h3', { text: S.preview_title }));
    previewCard.appendChild(D.h('div.preview-box', null, previewCanvas));
    previewCard.appendChild(previewSize);
    previewCard.appendChild(D.h('p.field-hint', { text: S.hint_preview }));

    /* --- 结果卡 --- */

    var resultBody = D.h('div');
    resultCard.appendChild(D.h('h3', { text: S.result_title }));
    resultCard.appendChild(resultBody);

    /** 键值对照表。 */
    function kvTable(rows) {
      var table = D.h('table.kv-table');
      table.appendChild(D.h('thead', null, D.h('tr', null,
        D.h('th', { text: S.label_item }),
        D.h('th', { text: S.label_value })
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

    /** 状态行。传 true 表示这是条错误。 */
    function setStatus(message, isError) {
      statusLine.textContent = message || '';
      statusLine.classList.toggle('is-error', !!isError);
    }

    /** 换掉结果图的 object URL —— 不撤销的话每改一次就漏一个 blob。 */
    function replaceResultUrl(blob) {
      if (state.resultUrl) {
        URL.revokeObjectURL(state.resultUrl);
        state.resultUrl = '';
      }
      state.resultUrl = URL.createObjectURL(blob);
    }

    /* ---------- 排版 ---------- */

    /**
     * 量一遍文字。
     *
     * 必须在**单位变换**下量 —— `actualBoundingBox*` 会把 CTM 的变换映射进去，
     * 在旋转过或缩放过的上下文里量，量到的是变换之后的框。
     *
     * @param {string[]} lines
     * @param {string} fontSpec
     * @returns {object} {advances, fontAsc, fontDesc, inkAsc, inkDesc}
     */
    function measureLines(lines, fontSpec) {
      if (!measureCtx) {
        measureCanvas = makeCanvas(1, 1);
        measureCtx = measureCanvas.getContext('2d');
        if (!measureCtx) return null;
      }
      var ctx = measureCtx;
      var advances = [];
      var fontAsc = 0;
      var fontDesc = 0;
      var inkAsc = 0;
      var inkDesc = 0;
      var i;
      var m;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = fontSpec;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      for (i = 0; i < lines.length; i++) {
        m = ctx.measureText(lines[i]);
        advances.push(m.width);
        if (!fontAsc && typeof m.fontBoundingBoxAscent === 'number' && isFinite(m.fontBoundingBoxAscent)) {
          fontAsc = m.fontBoundingBoxAscent;
          fontDesc = typeof m.fontBoundingBoxDescent === 'number' ? m.fontBoundingBoxDescent : 0;
        }
        if (m.actualBoundingBoxAscent > inkAsc) inkAsc = m.actualBoundingBoxAscent;
        if (m.actualBoundingBoxDescent > inkDesc) inkDesc = m.actualBoundingBoxDescent;
      }
      ctx.restore();
      return {
        advances: advances,
        fontAsc: fontAsc,
        fontDesc: fontDesc,
        inkAsc: inkAsc,
        inkDesc: inkDesc
      };
    }

    /**
     * 算整套布局：字号、块尺寸、外接框、锚点。
     *
     * 放不下的时候按比例缩小字号，再量一遍 —— 推进宽度不是严格线性的，
     * 所以缩完必须重量，不能拿旧的尺寸乘一个系数。
     *
     * @returns {object|null} 布局；文字全空时返回 null
     */
    function computeLayout() {
      if (!state.width || !state.height) return null;
      var lines = splitLines(state.text);
      if (isBlankText(state.text)) return null;

      var stack = FONT_STACKS[state.font] || FONT_STACKS.sans;
      var shorter = Math.min(state.width, state.height);
      var marginPx = marginFor(shorter, state.marginPct);
      var gapPx = gapFor(shorter, state.gapPct);
      var angleDeg = normalizeAngle(state.angle);
      var tile = state.position === 'tile';
      var fontPx = fontSizeFor(shorter, state.sizePct);
      var strokePct = state.outlineOn ? state.outlinePct : 0;

      var attempt = 0;
      var out = null;
      while (attempt < 8) {
        attempt++;
        var strokePx = round2(fontPx * strokePct / 100);
        var fontSpec = (state.bold ? 'bold ' : '') + round2(fontPx) + 'px ' + stack;
        var measured = measureLines(lines, fontSpec);
        if (!measured) return null;

        // 字体度量打底，墨迹框兜底（CJK 回退字体比主字体高）
        var asc = Math.max(measured.fontAsc, measured.inkAsc) || fontPx * 0.8;
        var desc = Math.max(measured.fontDesc, measured.inkDesc) || fontPx * 0.2;
        // 行距不能比字体自己的行盒还挤，否则 CJK 的行会叠上
        var lineHeight = Math.max(fontPx * 1.25, asc + desc);
        var block = textBlock(measured.advances, {
          ascent: asc, descent: desc, lineHeight: lineHeight, strokePx: strokePx
        });
        var ext = tile
          ? { width: block.width, height: block.height }
          : rotatedExtent(block.width, block.height, angleDeg);
        var avail = tile
          ? { width: shorter, height: shorter }
          : marginBox(state.width, state.height, marginPx);
        var fit = fitScale(ext.width, ext.height, avail.width, avail.height);

        out = {
          lines: lines,
          fontSpec: fontSpec,
          fontPx: fontPx,
          strokePx: strokePx,
          block: block,
          ext: ext,
          fill: state.color,
          outline: state.outlineColor,
          outlineOn: state.outlineOn,
          opacity: clampPercent(state.opacity, 0, 100, 50) / 100,
          angleDeg: angleDeg,
          position: state.position,
          marginPx: marginPx,
          gapPx: gapPx,
          imgW: state.width,
          imgH: state.height
        };
        if (fit >= 1) break;
        fontPx = round2(fontPx * fit);
        if (fontPx <= 0) break;
      }
      return out;
    }

    /**
     * 把水印画到画布上。
     *
     * 画布的变换由调用方决定：导出是单位变换，预览是缩放 s 倍 ——
     * 两边用的是同一套坐标，所以预览就是导出的等比缩放版。
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} layout
     */
    function drawWatermark(ctx, layout) {
      if (!ctx || !layout) return;
      var block = layout.block;
      var offsets = block.offsets;
      var lines = layout.lines;
      var rad = layout.angleDeg * Math.PI / 180;
      var i;

      ctx.save();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = layout.fontSpec;
      ctx.globalAlpha = layout.opacity;
      ctx.fillStyle = layout.fill;
      if (layout.outlineOn && layout.strokePx > 0) {
        ctx.strokeStyle = layout.outline;
        ctx.lineWidth = layout.strokePx;
        ctx.lineJoin = 'round';
      }

      /** 画一整块（多行）文字，块心在 (ox, oy)。 */
      function drawBlock(ox, oy) {
        var j;
        for (j = 0; j < lines.length; j++) {
          var x = ox + offsets[j].x;
          var y = oy + offsets[j].y;
          // 描边先画：填充会盖住描边朝里的那一半
          if (layout.outlineOn && layout.strokePx > 0) ctx.strokeText(lines[j], x, y);
          ctx.fillText(lines[j], x, y);
        }
      }

      if (layout.position === 'tile') {
        var grid = tileGrid(
          layout.imgW, layout.imgH, layout.angleDeg,
          block.width + layout.gapPx, block.height + layout.gapPx
        );
        // ctx.rotate 是绕原点转的 —— 先平移到图片中心
        ctx.translate(layout.imgW / 2, layout.imgH / 2);
        ctx.rotate(rad);
        var r;
        var c;
        for (r = 0; r < grid.rows; r++) {
          for (c = 0; c < grid.cols; c++) {
            drawBlock(
              grid.originX + (c + 0.5) * grid.cellW,
              grid.originY + (r + 0.5) * grid.cellH
            );
          }
        }
      } else {
        var anchor = anchorBox(
          layout.position, layout.ext.width, layout.ext.height,
          layout.imgW, layout.imgH, layout.marginPx
        );
        ctx.translate(anchor.x, anchor.y);
        ctx.rotate(rad);
        drawBlock(0, 0);
      }
      ctx.restore();
      i = 0;
    }

    /* ---------- 预览 ---------- */

    /** 预览的缩放比（1 表示不缩）。 */
    function previewScale() {
      if (!state.width || !state.height) return 1;
      return Math.min(1, PREVIEW_MAX / Math.max(state.width, state.height));
    }

    /** 重画预览。 */
    function renderPreview() {
      if (!state.decoded) return;
      var scale = previewScale();
      var pw = Math.max(1, Math.round(state.width * scale));
      var ph = Math.max(1, Math.round(state.height * scale));
      if (previewCanvas.width !== pw || previewCanvas.height !== ph) {
        previewCanvas.width = pw;
        previewCanvas.height = ph;
      }
      var ctx = previewCanvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pw, ph);
      // 之后的坐标都是**原图分辨率**的，缩放交给变换 —— 预览就是导出的缩小版
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(state.decoded.source, 0, 0, state.width, state.height);
      if (state.layout) drawWatermark(ctx, state.layout);
      previewSize.textContent = pw + ' × ' + ph + ' (' + state.width + ' × ' + state.height + ')';
    }

    /* ---------- 导出 ---------- */

    /**
     * 按当前设置导出一次。
     *
     * @param {function(): boolean} isCurrent 竞态闸门
     * @returns {Promise<void>}
     */
    function exportNow(isCurrent) {
      var limit = canvasLimit(state.width, state.height);
      if (!limit.ok) {
        state.result = null;
        setStatus(S.err_canvas_limit
          .replace('{width}', String(state.width))
          .replace('{height}', String(state.height))
          .replace('{max}', String(MAX_CANVAS_SIDE))
          .replace('{area}', String(Math.round(MAX_CANVAS_AREA / 1000000))), true);
        renderResult();
        return Promise.resolve();
      }

      var canvas;
      var ctx;
      try {
        canvas = makeCanvas(state.width, state.height);
        ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas');
        ctx.drawImage(state.decoded.source, 0, 0, state.width, state.height);
        if (state.layout) drawWatermark(ctx, state.layout);
      } catch (e) {
        state.result = null;
        setStatus(S.err_encode.replace('{reason}', function () {
          return String(e && e.message ? e.message : e);
        }), true);
        renderResult();
        return Promise.resolve();
      }

      setStatus(S.status_encoding);
      return C.encode({
        source: canvas,
        width: state.width,
        height: state.height,
        close: function () {}
      }, {
        width: state.width,
        height: state.height,
        formatId: state.formatId,
        quality: state.quality,
        background: state.matte
      }).then(function (out) {
        if (!isCurrent()) return;
        state.result = {
          blob: out.blob,
          bytes: out.blob.size,
          width: out.width,
          height: out.height,
          formatId: out.formatId,
          requestedFormatId: out.requestedFormatId,
          scaledToFit: out.scaledToFit
        };
        replaceResultUrl(out.blob);
        setStatus('');
        renderResult();
      }, function (err) {
        if (!isCurrent()) return;
        state.result = null;
        setStatus(S.err_encode.replace('{reason}', function () {
          return String(err && err.message ? err.message : err);
        }), true);
        renderResult();
      });
    }

    /* ---------- 结果 ---------- */

    /** 字号那一行：被自动缩小过时写清楚。 */
    function sizeText() {
      var shorter = Math.min(state.width, state.height);
      if (!shorter) return state.sizePct + ' %';
      var actual = round2(state.layout.fontPx / shorter * 100);
      if (actual < state.sizePct - 0.05) {
        return state.sizePct + ' % → ' + actual + ' % · ' + S.shrunk_to_fit;
      }
      return actual + ' %';
    }

    /** 布局那一行：位置 + 角度。 */
    function layoutText() {
      var label = S[positionLabelKey(state.position)];
      return label + ' · ' + state.angle + '°';
    }

    /** 画结果卡片。 */
    function renderResult() {
      D.clear(resultBody);
      var r = state.result;
      if (!r) {
        resultBody.appendChild(D.h('p.field-hint', { text: S.no_result }));
        return;
      }
      var format = C.formatById(r.formatId) || C.FORMATS[0];
      var rows = [
        { label: S.label_source_size, value: state.width + ' × ' + state.height },
        { label: S.label_output_size, value: r.width + ' × ' + r.height },
        { label: S.label_file_size, value: C.formatBytes(r.bytes) },
        { label: S.label_output_format, value: format.label },
        {
          label: S.label_watermark_text,
          value: state.layout ? state.layout.lines.join(' / ') : S.no_watermark
        },
        { label: S.label_watermark_size, value: state.layout ? sizeText() : S.no_watermark },
        { label: S.label_watermark_layout, value: state.layout ? layoutText() : S.no_watermark }
      ];
      resultBody.appendChild(kvTable(rows));

      // 浏览器不支持这个格式的编码时，toBlob 会退回 PNG —— 必须说出来
      if (r.formatId !== r.requestedFormatId) {
        var requested = C.formatById(r.requestedFormatId);
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: S.warn_fallback
              .replace('{format}', requested ? requested.label : r.requestedFormatId)
              .replace('{actual}', format.label)
          })
        ));
      }

      // 浏览器吃不下这么大的画布，内核把长宽减半了 —— 下载到的不是用户要的尺寸
      if (r.scaledToFit) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: S.warn_scaled
              .replace('{width}', String(state.width))
              .replace('{height}', String(state.height))
              .replace('{actualWidth}', String(r.width))
              .replace('{actualHeight}', String(r.height))
          })
        ));
      }

      // 动图只剩第一帧 —— canvas 画不出后面的帧，不说清楚就成了骗人
      if (state.animation && state.animation.animated) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', { text: S.warn_animation.replace('{n}', String(state.animation.frames)) })
        ));
      }

      var downloadBtn = D.h('button.layui-btn.layui-btn-primary', {
        type: 'button', text: S.download
      });
      downloadBtn.addEventListener('click', function () {
        if (disposed || !state.result) return;
        var fmt = C.formatById(state.result.formatId) || C.FORMATS[0];
        window.ItTools.download(
          C.outputName(state.name, fmt.ext, 'watermark'),
          state.result.blob,
          fmt.mime
        );
      });
      resultBody.appendChild(D.h('div.form-actions', null, downloadBtn));
    }

    /* ---------- 调度 ---------- */

    /** 设置变了：布局重算，预览（快）与导出（慢）各排一次。 */
    function refresh() {
      if (!state.decoded) return;
      var mine = ++ticket;
      var isCurrent = function () { return !disposed && mine === ticket; };

      state.layout = computeLayout();

      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
      }
      previewTimer = setTimeout(function () {
        previewTimer = null;
        if (!isCurrent()) return;
        try {
          renderPreview();
        } catch (e) {
          /* 预览失败不该把整块工具带崩，导出的那条路上会报正经的错误 */
        }
      }, PREVIEW_DEBOUNCE_MS);

      if (exportTimer) {
        clearTimeout(exportTimer);
        exportTimer = null;
      }
      exportTimer = setTimeout(function () {
        exportTimer = null;
        if (!isCurrent()) return;
        exportNow(isCurrent).catch(function () {
          /* 错误已经在 exportNow 里报过了 */
        });
      }, EXPORT_DEBOUNCE_MS);
    }

    /* ---------- 处理文件 ---------- */

    /**
     * 载入一张图片。
     *
     * @param {File} file
     */
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
        var format = C.detectFormat(bytes);

        C.decode(file).then(function (decoded) {
          if (disposed) {
            if (decoded && decoded.close) decoded.close();
            return;
          }
          // 换图的时候先把上一张的位图放掉 —— 只在销毁时关的话，
          // 中途换图会一直留着上一张。
          if (state.decoded && state.decoded.close) state.decoded.close();

          state.name = file.name || 'image';
          state.size = file.size || bytes.length;
          state.sourceFormat = format || '';
          state.animation = C.animationInfo(bytes);
          state.file = file;
          state.decoded = decoded;
          state.width = decoded.width;
          state.height = decoded.height;

          upload.setStatus('');
          watermarkCard.hidden = false;
          layoutCard.hidden = false;
          previewCard.hidden = false;
          outputCard.hidden = false;
          resultCard.hidden = false;
          refresh();
        }, function () {
          if (disposed) return;
          upload.setStatus(S.err_decode, true);
          watermarkCard.hidden = true;
          layoutCard.hidden = true;
          previewCard.hidden = true;
          outputCard.hidden = true;
          resultCard.hidden = true;
        });
      };
      reader.onerror = function () {
        if (disposed) return;
        upload.setStatus(S.err_read, true);
      };
      reader.readAsArrayBuffer(file);
    }

    /* ---------- 事件 ---------- */

    textArea.addEventListener('input', function () {
      state.text = textArea.value || '';
      checkFont();
      refresh();
    });

    fontSelect.addEventListener('change', function () {
      var v = fontSelect.value;
      state.font = (v === 'serif' || v === 'mono') ? v : 'sans';
      checkFont();
      refresh();
    });

    boldInput.addEventListener('change', function () {
      state.bold = !!boldInput.checked;
      refresh();
    });

    colorInput.addEventListener('input', function () {
      var v = colorInput.value;
      if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) return;
      state.color = v;
      refresh();
    });

    opacity.input.addEventListener('input', function () {
      state.opacity = Number(opacity.input.value) || 0;
      refresh();
    });

    outlineInput.addEventListener('change', function () {
      state.outlineOn = !!outlineInput.checked;
      outlineColorInput.disabled = !state.outlineOn;
      outlineWidth.input.disabled = !state.outlineOn;
      refresh();
    });

    outlineColorInput.addEventListener('input', function () {
      var v = outlineColorInput.value;
      if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) return;
      state.outlineColor = v;
      refresh();
    });

    positionSelect.addEventListener('change', function () {
      var v = positionSelect.value;
      state.position = (v === 'tile' || 'tl tc tr ml mc mr bl bc br'.indexOf(v) >= 0) ? v : 'br';
      // 平铺没有边距（边缘的水印本来就该被裁掉），改成间距
      var tiling = state.position === 'tile';
      margin.input.disabled = tiling;
      gap.input.disabled = !tiling;
      refresh();
    });

    formatSelect.addEventListener('change', function () {
      state.formatId = formatSelect.value;
      // PNG 是无损的，画质对它没有意义 —— 滑块禁掉
      var lossless = state.formatId === 'png';
      qualityInput.disabled = lossless;
      qualityHint.textContent = lossless ? S.hint_quality : '';
      refresh();
    });

    qualityInput.addEventListener('input', function () {
      state.quality = Number(qualityInput.value) || 90;
      refresh();
    });

    matteInput.addEventListener('input', function () {
      var v = matteInput.value;
      if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) return;
      state.matte = v;
      refresh();
    });

    /**
     * 这台机器上有没有能画出这些字的字体。
     *
     * 没有的话中文会变成豆腐块（方框）。只是**提示**一下 ——
     * 机器上压根没装 CJK 字体是很正常的事，工具本身不能因此坏掉。
     */
    function checkFont() {
      var text = state.text || '';
      if (!text || isBlankText(text)) {
        fontHint.textContent = '';
        return;
      }
      var stack = FONT_STACKS[state.font] || FONT_STACKS.sans;
      var spec = (state.bold ? 'bold ' : '') + '16px ' + stack;
      var ok = true;
      try {
        if (document.fonts && typeof document.fonts.check === 'function') {
          ok = document.fonts.check(spec, text);
        }
      } catch (e) {
        ok = true;
      }
      fontHint.textContent = ok ? '' : S.hint_no_font;
    }

    return {
      destroy: function () {
        disposed = true;
        ticket++;
        if (previewTimer) clearTimeout(previewTimer);
        if (exportTimer) clearTimeout(exportTimer);
        previewTimer = null;
        exportTimer = null;
        if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
        if (state.decoded && state.decoded.close) state.decoded.close();
        state.resultUrl = '';
        state.decoded = null;
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['image-watermark'] = {
    PREVIEW_MAX: PREVIEW_MAX,
    MAX_CANVAS_SIDE: MAX_CANVAS_SIDE,
    MAX_CANVAS_AREA: MAX_CANVAS_AREA,
    FONT_STACKS: FONT_STACKS,
    clampPercent: clampPercent,
    round2: round2,
    fontSizeFor: fontSizeFor,
    marginFor: marginFor,
    gapFor: gapFor,
    splitLines: splitLines,
    isBlankText: isBlankText,
    textBlock: textBlock,
    rotatedExtent: rotatedExtent,
    marginBox: marginBox,
    anchorBox: anchorBox,
    fitScale: fitScale,
    tileGrid: tileGrid,
    canvasLimit: canvasLimit,
    normalizeAngle: normalizeAngle,
    angleSinCos: angleSinCos,
    positionLabelKey: positionLabelKey,
    __cases: function (assert) {
      assert.eq(clampPercent(50, 0, 100, 10), 50, '透明度 50 不变');
      assert.eq(clampPercent(200, 0, 100, 10), 100, '超范围夹到 100');
      assert.eq(clampPercent(-5, 0, 100, 10), 0, '负数夹到 0');
      assert.eq(clampPercent('abc', 0, 100, 10), 10, '不是数字就退回 fallback');

      assert.eq(fontSizeFor(1000, 6), 60, '短边 1000 的 6% 是 60 像素');
      assert.eq(fontSizeFor(600, 6), 36, '短边 600 的 6% 是 36 像素');
      assert.eq(marginFor(1000, 4), 40, '短边 1000 的 4% 是 40 像素');
      assert.eq(gapFor(1000, 15), 150, '短边 1000 的 15% 是 150 像素');

      assert.eq(splitLines('a\nb'), ['a', 'b'], '换行拆得开');
      assert.eq(splitLines('a\r\nb'), ['a', 'b'], 'Windows 的换行也拆得开');
      assert.eq(splitLines('a\n\nb'), ['a', '', 'b'], '中间的空行保留');
      assert.eq(splitLines('a\nb\n\n'), ['a', 'b'], '行尾的空行不算行');

      assert.eq(isBlankText('  \n\t '), true, '全是空白就不画水印');
      assert.eq(isBlankText(' a '), false, '有字就画');

      assert.eq(textBlock([100, 60], { ascent: 20, descent: 5, lineHeight: 24, strokePx: 4 }), {
        width: 104,
        height: 53,
        glyphHeight: 49,
        offsets: [{ x: -50, y: -4.5 }, { x: -30, y: 19.5 }]
      }, '文字块宽是最宽的一行加描边，高是字框加描边，每行各自居中');
      assert.eq(textBlock([100], { ascent: 20, descent: 5, lineHeight: 24, strokePx: 4 }), {
        width: 104,
        height: 29,
        glyphHeight: 25,
        offsets: [{ x: -50, y: 7.5 }]
      }, '只有一行时块高就是字框加描边');

      assert.eq(rotatedExtent(200, 40, 0), { width: 200, height: 40 }, '不转时外接框就是自己');
      assert.eq(rotatedExtent(200, 40, 90), { width: 40, height: 200 }, '转 90 度宽高互换');
      assert.eq(rotatedExtent(200, 40, 180), { width: 200, height: 40 }, '转 180 度外接框不变');
      assert(
        Math.abs(rotatedExtent(200, 40, 45).width - 240 * Math.SQRT1_2) < 1e-9,
        '转 45 度的宽是 (200+40) 乘根号二分之一'
      );
      assert(
        Math.abs(rotatedExtent(200, 40, 45).height - 240 * Math.SQRT1_2) < 1e-9,
        '转 45 度的高是 (200+40) 乘根号二分之一'
      );

      assert.eq(marginBox(1000, 800, 40), {
        left: 40, top: 40, right: 960, bottom: 760, width: 920, height: 720
      }, '边距框是四边各缩进 40');

      assert.eq(anchorBox('tl', 200, 40, 1000, 800, 40), {
        x: 140, y: 60, left: 40, top: 40, right: 240, bottom: 80
      }, '左上角贴左边与上边');
      assert.eq(anchorBox('tc', 200, 40, 1000, 800, 40), {
        x: 500, y: 60, left: 400, top: 40, right: 600, bottom: 80
      }, '上中是水平居中、垂直贴上边');
      assert.eq(anchorBox('tr', 200, 40, 1000, 800, 40), {
        x: 860, y: 60, left: 760, top: 40, right: 960, bottom: 80
      }, '右上角贴右边与上边');
      assert.eq(anchorBox('ml', 200, 40, 1000, 800, 40), {
        x: 140, y: 400, left: 40, top: 380, right: 240, bottom: 420
      }, '左中是水平贴左边、垂直居中');
      assert.eq(anchorBox('mc', 200, 40, 1000, 800, 40), {
        x: 500, y: 400, left: 400, top: 380, right: 600, bottom: 420
      }, '正中是两个方向都居中');
      assert.eq(anchorBox('mr', 200, 40, 1000, 800, 40), {
        x: 860, y: 400, left: 760, top: 380, right: 960, bottom: 420
      }, '右中是水平贴右边、垂直居中');
      assert.eq(anchorBox('bl', 200, 40, 1000, 800, 40), {
        x: 140, y: 740, left: 40, top: 720, right: 240, bottom: 760
      }, '左下角贴左边与下边');
      assert.eq(anchorBox('bc', 200, 40, 1000, 800, 40), {
        x: 500, y: 740, left: 400, top: 720, right: 600, bottom: 760
      }, '下中是水平居中、垂直贴下边');
      assert.eq(anchorBox('br', 200, 40, 1000, 800, 40), {
        x: 860, y: 740, left: 760, top: 720, right: 960, bottom: 760
      }, '右下角贴右边与下边');

      assert.eq(fitScale(200, 40, 900, 900), 1, '放得下就不缩');
      assert.eq(fitScale(200, 40, 100, 100), 0.5, '宽度不够就按宽度缩');
      assert.eq(fitScale(40, 200, 100, 100), 0.5, '高度不够就按高度缩');
      assert.eq(fitScale(200, 40, 100, 400), 0.5, '两个方向取更小的那个');

      assert.eq(tileGrid(1000, 800, 0, 200, 100), {
        cols: 5, rows: 9, cellW: 200, cellH: 100, originX: -500, originY: -450
      }, '不转时 5 列 9 行，网格居中（行数补成奇数）');
      assert.eq(tileGrid(1000, 1000, 45, 200, 100), {
        cols: 9, rows: 15, cellW: 200, cellH: 100, originX: -900, originY: -750
      }, '转 45 度时外接矩形是 1414，列数行数都补成奇数');

      assert.eq(canvasLimit(1000, 1000).ok, true, '正常尺寸画布装得下');
      assert.eq(canvasLimit(40000, 100).ok, false, '超过单边上限装不下');
      assert.eq(canvasLimit(20000, 20000).ok, false, '超过面积上限装不下');

      assert.eq(normalizeAngle(370), 10, '370 度折回 10 度');
      assert.eq(normalizeAngle(-190), 170, '负 190 度折回 170 度');
      assert.eq(normalizeAngle('abc'), 0, '不是数字就当 0 度');
      assert.eq(angleSinCos(0), { c: 1, s: 0 }, '0 度的正弦余弦是精确值');
      assert.eq(angleSinCos(90), { c: 0, s: 1 }, '90 度的正弦余弦是精确值');
      assert.eq(angleSinCos(180), { c: -1, s: 0 }, '180 度的正弦余弦是精确值');
    }
  };
}());
