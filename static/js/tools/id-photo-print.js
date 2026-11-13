(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('id-photo-print');

  /* ==========================================================================
     把证件照排到一张可打印的纸上

     这一批的第三个工具。仓库里已经有「证件照标准尺寸」（id-photo-resizer），
     它管的是**一张**照片裁成多少像素；这个工具管的是**很多张**排到一张纸上 ——
     6 寸相纸排 10 张一寸照、A4 排一版，打印出来照着虚线剪开。

     设计上的几个取舍，写在这里免得后来的人重新踩一遍：

     1. 毫米是「物理尺寸」，像素是「打印精度」，两者分开算。
        毫米 → 像素是 px = round(mm / 25.4 * dpi)。照片的**物理尺寸**是用户定的
        （一寸就是 25×35 毫米），一毫米都不能多；剩下的余量只能进页边距。

     2. 能放几张用 floor，余量进页边距，整块照片在纸上居中。
        把余量摊进间距，间距就跟用户设的不一样了；摊给照片，一寸就变成一寸零几，
        打印出来不合规。居中比「靠左对齐、多的全在右边」好看，也更符合「排版」这两个字。

     3. 排版图**只给 PNG**。图上有细虚线和小字，JPEG 的 4:2:0 色度抽样
        会把它们糊掉，150 DPI 下尤其明显。

     4. 裁切线是**手算**出来的虚线段，不用 ctx.setLineDash ——
        仓库里一次都没用过 setLineDash，而且虚线要画在两张照片**中间**那条
        间距的正中间（照着剪才不会切到照片），手算能保证这一点。

     5. 画布太大时降 DPI，不降纸张和照片的物理尺寸。
        降 DPI 只让图变糊，不改变它在纸上的大小 —— 这是唯一可以牺牲的东西。
     ========================================================================== */

  /* ---------- 常量 ---------- */

  var MM_PER_INCH = 25.4;

  /** 默认分辨率：证件照冲印与打印的常规值。 */
  var DEFAULT_DPI = 300;

  /** 画布超限时往下走的台阶（只能降，不能升）。 */
  var DPI_LADDER = [600, 300, 150];
  var MIN_DPI = 150;
  var MAX_DPI = 1200;

  /** 浏览器画布的上限：每边 32767、总面积 268435456（约 2.68 亿像素）。 */
  var MAX_CANVAS_SIDE = 32767;
  var MAX_CANVAS_AREA = 268435456;

  /** 预览按物理尺寸画：屏幕按 96 DPI 算，一寸相纸在屏幕上就是那么宽。 */
  var SCREEN_DPI = 96;
  var MAX_PREVIEW_PX = 720;

  /** 标注条的高度（毫米）与字号（毫米）。没有标注也没有编号时标注条高为 0。 */
  var CAPTION_STRIP_MM = 5;
  var CAPTION_FONT_MM = 3.2;

  /** 裁切线：实线段 2 毫米、空隙 1.5 毫米、线宽 0.25 毫米。 */
  var DASH_MM = 2;
  var DASH_GAP_MM = 1.5;
  var CUT_WIDTH_MM = 0.25;

  /** 毫米输入的夹取范围。 */
  var MIN_MM = 1;
  var MAX_MM = 2000;
  var MIN_GAP_MM = 0;
  var MAX_GAP_MM = 50;
  var MIN_MARGIN_MM = 0;
  var MAX_MARGIN_MM = 50;

  /** 改参数后多久重画一次预览（毫秒）。 */
  var RENDER_DEBOUNCE_MS = 150;

  /**
   * 纸张预设（毫米）。
   *
   * 「几寸相纸」说的是**长边**：6 寸相纸是 152×102 毫米（6×4 英寸），
   * 5 寸是 127×89（5×3.5 英寸），7 寸是 178×127（7×5 英寸）。
   * 注意别跟「5 寸照片」（3.5×2.5 英寸 = 89×63 毫米）混起来。
   */
  var PAPER_PRESETS = [
    { id: 'photo5', width: 127, height: 89 },
    { id: 'photo6', width: 152, height: 102 },
    { id: 'photo7', width: 178, height: 127 },
    { id: 'a6', width: 105, height: 148 },
    { id: 'a4', width: 210, height: 297 },
    { id: 'custom', width: 0, height: 0 }
  ];

  /**
   * 照片预设（毫米）。
   *
   * 这五个尺寸在 300 DPI 下换算成像素是
   * 295×413 / 260×378 / 390×567 / 413×579 / 413×531，
   * 跟「证件照标准尺寸」（id-photo-resizer）里的那五个像素预设**逐个对得上** ——
   * 那边那张表本来就是「毫米换算成像素」，只是没写毫米。
   * __cases 里把两边的对应关系钉死，免得以后有一边改了另一边不跟。
   */
  var PHOTO_PRESETS = [
    { id: 'one_inch', width: 25, height: 35 },
    { id: 'small_one_inch', width: 22, height: 32 },
    { id: 'large_one_inch', width: 33, height: 48 },
    { id: 'two_inch', width: 35, height: 49 },
    { id: 'small_two_inch', width: 35, height: 45 },
    { id: 'custom', width: 0, height: 0 }
  ];

  /* ---------- 文案 ---------- */

  var S = {
    title: t('title', 'Put ID photos on a printable sheet'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The picture is processed in your browser, nothing is uploaded.'),
    status_reading: t('status_reading', 'Reading the file…'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_paper: t('err_paper', 'The width and the height of the sheet both need to be bigger than zero.'),
    err_photo: t('err_photo', 'The width and the height of the photo both need to be bigger than zero.'),
    err_too_big: t('err_too_big', 'At {dpi} DPI this sheet would be {width} × {height} pixels, which is more than a browser canvas holds (the limit is {max} pixels per side and {area} megapixels in total). Even {used} DPI does not fit.'),
    warn_dpi: t('warn_dpi', 'This sheet does not fit at {dpi} DPI, so it was brought down to {used} DPI. The size on the paper is unchanged, the picture is just a little softer.'),
    params_title: t('params_title', 'Settings'),
    label_paper: t('label_paper', 'Sheet'),
    label_paper_custom: t('label_paper_custom', 'Custom sheet (mm)'),
    label_photo: t('label_photo', 'Photo size'),
    label_photo_custom: t('label_photo_custom', 'Custom photo (mm)'),
    label_gap: t('label_gap', 'Gap (mm)'),
    label_margin: t('label_margin', 'Margin (mm)'),
    label_dpi: t('label_dpi', 'Resolution'),
    label_caption: t('label_caption', 'Caption'),
    label_number: t('label_number', 'Number the photos'),
    label_cut: t('label_cut', 'Cut lines'),
    label_width: t('label_width', 'Width'),
    label_height: t('label_height', 'Height'),
    hint_paper: t('hint_paper', 'A 6 inch sheet of photo paper is 152 × 102 mm.'),
    hint_photo: t('hint_photo', 'A one inch photo is 25 × 35 mm.'),
    hint_gap: t('hint_gap', 'The white space between two photos.'),
    hint_margin: t('hint_margin', 'The white space kept at the four edges of the sheet.'),
    hint_dpi: t('hint_dpi', '300 DPI is what photo printing uses. The tool lowers it on its own when the sheet would not fit.'),
    hint_caption: t('hint_caption', 'Written under every photo. Leave it empty to write nothing.'),
    hint_number: t('hint_number', 'Counts the photos from one upwards.'),
    hint_cut: t('hint_cut', 'Draws a dashed line down the middle of the gap, so the scissors have something to follow.'),
    paper_photo5: t('paper_photo5', '5 inch photo paper'),
    paper_photo6: t('paper_photo6', '6 inch photo paper'),
    paper_photo7: t('paper_photo7', '7 inch photo paper'),
    paper_a6: t('paper_a6', 'A6'),
    paper_a4: t('paper_a4', 'A4'),
    paper_custom: t('paper_custom', 'Custom'),
    photo_one_inch: t('photo_one_inch', 'One inch'),
    photo_small_one_inch: t('photo_small_one_inch', 'Small one inch'),
    photo_large_one_inch: t('photo_large_one_inch', 'Large one inch'),
    photo_two_inch: t('photo_two_inch', 'Two inch'),
    photo_small_two_inch: t('photo_small_two_inch', 'Small two inch'),
    photo_custom: t('photo_custom', 'Custom'),
    preview_title: t('preview_title', 'Preview'),
    export_title: t('export_title', 'Export'),
    btn_download: t('btn_download', 'Download the sheet (PNG)'),
    btn_print: t('btn_print', 'Print'),
    hint_print: t('hint_print', 'Set the scaling to 100% before printing, otherwise the photos come out at the wrong size.'),
    hint_export: t('hint_export', 'PNG only: the sheet has thin dashed lines and small text, and JPEG smears them.'),
    status_popup: t('status_popup', 'The browser blocked the print window. Allow pop-ups for this site and press the button again.'),
    summary_title: t('summary_title', 'Summary'),
    label_sheet_size: t('label_sheet_size', 'Sheet size'),
    label_canvas_size: t('label_canvas_size', 'Canvas size'),
    label_photo_size: t('label_photo_size', 'Photo size'),
    label_layout: t('label_layout', 'Layout'),
    label_count: t('label_count', 'Photos'),
    label_dpi_used: t('label_dpi_used', 'Resolution used')
  };

  /* ==========================================================================
     纯逻辑
     ========================================================================== */

  /**
   * 毫米 → 像素。
   *
   * @param {number} mm  毫米
   * @param {number} dpi 每英寸多少像素
   * @returns {number} 像素（四舍五入）
   */
  function mmToPx(mm, dpi) {
    var m = Number(mm);
    var d = Number(dpi);
    if (!isFinite(m) || m <= 0) return 0;
    if (!isFinite(d) || d <= 0) d = DEFAULT_DPI;
    return Math.round((m / MM_PER_INCH) * d);
  }

  /**
   * 画布放不放得下。
   *
   * @param {number} w 宽（像素）
   * @param {number} h 高（像素）
   * @returns {{ok: boolean, width: number, height: number}}
   */
  function canvasLimit(w, h) {
    var width = Math.max(0, Math.round(Number(w) || 0));
    var height = Math.max(0, Math.round(Number(h) || 0));
    var ok = width > 0 && height > 0 &&
      width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE &&
      width * height <= MAX_CANVAS_AREA;
    return { ok: ok, width: width, height: height };
  }

  /**
   * 这张纸用多少 DPI 画得下。
   *
   * 只能往下走（600 → 300 → 150），不能往上走 —— 用户要 300 就给 300，
   * 不因为「600 更清楚」就自己加钱。纸张和照片的物理尺寸一个都不动：
   * 降 DPI 只让图变糊，不改变它在纸上的大小。
   *
   * @param {number} paperWmm  纸宽（毫米）
   * @param {number} paperHmm  纸高（毫米）
   * @param {number} wantedDpi 用户要的分辨率
   * @returns {{dpi: number, width: number, height: number}} dpi 为 0 表示怎么都不行
   */
  function fitDpi(paperWmm, paperHmm, wantedDpi) {
    var want = clampInt(wantedDpi, MIN_DPI, MAX_DPI, DEFAULT_DPI);
    var ladder = [want];
    for (var i = 0; i < DPI_LADDER.length; i++) {
      if (DPI_LADDER[i] < want && ladder.indexOf(DPI_LADDER[i]) < 0) ladder.push(DPI_LADDER[i]);
    }
    for (var j = 0; j < ladder.length; j++) {
      var d = ladder[j];
      var w = mmToPx(paperWmm, d);
      var h = mmToPx(paperHmm, d);
      if (canvasLimit(w, h).ok) return { dpi: d, width: w, height: h };
    }
    return { dpi: 0, width: 0, height: 0 };
  }

  /**
   * 源图里那块「目标比例」的最大矩形。
   *
   * 原图比目标比例宽 → 满高、裁宽；比目标比例窄 → 满宽、裁高。
   * 这样切出来的块一定是目标比例，缩到目标尺寸时不会被拉变形。
   *
   * 算法跟「证件照标准尺寸」里的一样（那边是单张照片裁切，这边是批量同一种裁切），
   * 但那边是别的工具的文件，harness 一次只 eval 一个工具，
   * 调不到它的 ItTools.logic，所以这里自己写一份。
   *
   * @param {number} sourceW 原图宽
   * @param {number} sourceH 原图高
   * @param {number} targetW 目标宽
   * @param {number} targetH 目标高
   * @returns {{sw: number, sh: number}} 裁剪块的宽高
   */
  function cropRect(sourceW, sourceH, targetW, targetH) {
    var sw0 = Math.max(1, Math.round(Number(sourceW) || 0));
    var sh0 = Math.max(1, Math.round(Number(sourceH) || 0));
    var tw = Math.max(1, Math.round(Number(targetW) || 0));
    var th = Math.max(1, Math.round(Number(targetH) || 0));

    var targetRatio = tw / th;
    var sourceRatio = sw0 / sh0;
    var sw;
    var sh;
    if (sourceRatio > targetRatio) {
      // 原图更宽 —— 满高，裁掉左右
      sh = sh0;
      sw = Math.round(sh0 * targetRatio);
    } else {
      // 原图更窄 —— 满宽，裁掉上下
      sw = sw0;
      sh = Math.round(sw0 / targetRatio);
    }
    // 取整可能差一个像素，别让裁剪块超出原图
    sw = Math.max(1, Math.min(sw, sw0));
    sh = Math.max(1, Math.min(sh, sh0));
    return { sw: sw, sh: sh };
  }

  /**
   * 裁剪块在源图里的位置（居中）。
   *
   * @returns {{sx: number, sy: number, sw: number, sh: number}}
   */
  function cropPlan(sourceW, sourceH, targetW, targetH) {
    var r = cropRect(sourceW, sourceH, targetW, targetH);
    return {
      sx: Math.max(0, Math.round((sourceW - r.sw) / 2)),
      sy: Math.max(0, Math.round((sourceH - r.sh) / 2)),
      sw: r.sw,
      sh: r.sh
    };
  }

  /**
   * 一张纸上能排多少张。
   *
   * 数量用 floor：宁可少放一张，也不让最后一行超出版心。
   * 公式是 floor((可用宽 + 间距) / (格子宽 + 间距)) ——
   * 加上间距是因为最后一张右边不需要再留一条间距。
   *
   * @param {number} sheetW 纸宽（毫米）
   * @param {number} sheetH 纸高（毫米）
   * @param {number} cellW  一格多宽（毫米，含照片与标注条）
   * @param {number} cellH  一格多高（毫米）
   * @param {number} gap    间距（毫米）
   * @param {number} margin 页边距（毫米）
   * @returns {{cols: number, rows: number}}
   */
  function gridCount(sheetW, sheetH, cellW, cellH, gap, margin) {
    var availW = Number(sheetW) - 2 * Number(margin);
    var availH = Number(sheetH) - 2 * Number(margin);
    var stepW = Number(cellW) + Number(gap);
    var stepH = Number(cellH) + Number(gap);
    var cols = stepW > 0 ? Math.floor((availW + Number(gap)) / stepW) : 0;
    var rows = stepH > 0 ? Math.floor((availH + Number(gap)) / stepH) : 0;
    return {
      cols: Math.max(0, cols),
      rows: Math.max(0, rows)
    };
  }

  /**
   * 网格的位置。
   *
   * 整块照片在纸上**居中**：照片的物理尺寸是用户定的，一毫米都不能多；
   * 间距也是用户定的，同样不能动。剩下的余量只能进页边距，
   * 左右（上下）对半分 —— 这样版心是居中的，比「全堆在左边」好看。
   *
   * @returns {{cols, rows, blockW, blockH, offsetX, offsetY}} 长度单位都是毫米
   */
  function gridLayout(sheetW, sheetH, cellW, cellH, gap, margin) {
    var n = gridCount(sheetW, sheetH, cellW, cellH, gap, margin);
    var blockW = n.cols > 0 ? n.cols * cellW + (n.cols - 1) * gap : 0;
    var blockH = n.rows > 0 ? n.rows * cellH + (n.rows - 1) * gap : 0;
    return {
      cols: n.cols,
      rows: n.rows,
      blockW: blockW,
      blockH: blockH,
      offsetX: (sheetW - blockW) / 2,
      offsetY: (sheetH - blockH) / 2
    };
  }

  /**
   * 一条虚线。
   *
   * 沿着矩形的周边走一圈，实线段 dash 毫米、空隙 gap 毫米；
   * 跨过拐角时断开（一条斜线划过拐角看着像画错了）。
   *
   * 返回的是可以直接喂给 ctx.moveTo/lineTo 的线段表 ——
   * 纯几何，不碰 canvas，可以直接单测。
   *
   * @param {number} x 左
   * @param {number} y 上
   * @param {number} w 宽
   * @param {number} h 高
   * @param {number} dash 实线段长度
   * @param {number} gap  空隙长度
   * @returns {Array<{x1: number, y1: number, x2: number, y2: number}>}
   */
  function dashSegments(x, y, w, h, dash, gap) {
    var out = [];
    var width = Number(w), height = Number(h);
    var d = Number(dash), g = Number(gap);
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return out;
    if (!isFinite(d) || d <= 0 || !isFinite(g) || g < 0) return out;

    var period = d + g;
    var total = 2 * (width + height);
    // 四条边，按周长顺序：上 → 右 → 下 → 左
    var edges = [
      { len: width, start: 0, dirX: 1, dirY: 0, baseX: x, baseY: y },
      { len: height, start: width, dirX: 0, dirY: 1, baseX: x + width, baseY: y },
      { len: width, start: width + height, dirX: -1, dirY: 0, baseX: x + width, baseY: y + height },
      { len: height, start: 2 * width + height, dirX: 0, dirY: -1, baseX: x, baseY: y + height }
    ];

    function edgeAt(dist) {
      for (var i = 0; i < edges.length; i++) {
        if (dist < edges[i].start + edges[i].len) {
          return { edge: edges[i], k: dist - edges[i].start };
        }
      }
      var last = edges[edges.length - 1];
      return { edge: last, k: last.len };
    }

    function pointOn(edge, k) {
      return { x: edge.baseX + edge.dirX * k, y: edge.baseY + edge.dirY * k };
    }

    var pos = 0;
    while (pos < total) {
      var len = Math.min(d, total - pos);
      var a = edgeAt(pos);
      var b = edgeAt(pos + len);
      var p1 = pointOn(a.edge, a.k);
      if (a.edge === b.edge) {
        var p2 = pointOn(b.edge, b.k);
        out.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
      } else {
        // 跨过拐角：在拐角处断开，画成两段
        var corner = pointOn(a.edge, a.edge.len);
        var p3 = pointOn(b.edge, b.k);
        out.push({ x1: p1.x, y1: p1.y, x2: corner.x, y2: corner.y });
        // 第二段可能正好落在拐角上（长度 0），那就别画一个点出来
        if (Math.abs(p3.x - corner.x) > 1e-9 || Math.abs(p3.y - corner.y) > 1e-9) {
          out.push({ x1: corner.x, y1: corner.y, x2: p3.x, y2: p3.y });
        }
      }
      pos += period;
    }
    return out;
  }

  /**
   * 一张照片下面的标注。
   *
   * @param {string} text     用户写的字
   * @param {number} index    第几张（从 0 数）
   * @param {boolean} numbered 要不要编号
   * @returns {string}
   */
  function captionText(text, index, numbered) {
    var s = String(text === null || text === undefined ? '' : text).trim();
    var n = numbered ? String((Number(index) || 0) + 1) : '';
    if (!s) return n;
    if (!n) return s;
    return s + ' ' + n;
  }

  /**
   * 按 id 取预置；取不到返回 null。
   *
   * @param {Array} list 预置表
   * @param {string} id
   * @returns {?Object}
   */
  function presetById(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /**
   * 夹一个整数。
   */
  function clampInt(value, min, max, fallback) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) n = Math.round(Number(fallback));
    if (!isFinite(n)) n = min;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  /**
   * 夹一个毫米数。
   */
  function clampMm(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  /* ==========================================================================
     界面
     ========================================================================== */

  window.ItTools.register('id-photo-print', function (root) {
    var state = {
      source: null,
      name: '',
      imgW: 0,
      imgH: 0,
      paperId: 'photo6',
      paperW: 152,
      paperH: 102,
      photoId: 'one_inch',
      photoW: 25,
      photoH: 35,
      gap: 2,
      margin: 3,
      dpi: DEFAULT_DPI,
      caption: '',
      numbered: false,
      cut: true,
      disposed: false
    };

    var timer = null;

    /* ---------- 上传 ---------- */

    var upload = C.uploadCard({
      label: S.choose_file,
      hint: S.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);

    /* ---------- 参数 ---------- */

    var paramsCard = D.h('div.card', { hidden: true });
    paramsCard.appendChild(D.h('h3', { text: S.params_title }));

    var paperSelect = D.h('select.layui-select.idprint-paper',
      D.h('option', { value: 'photo5', text: S.paper_photo5 }),
      D.h('option', { value: 'photo6', text: S.paper_photo6 }),
      D.h('option', { value: 'photo7', text: S.paper_photo7 }),
      D.h('option', { value: 'a6', text: S.paper_a6 }),
      D.h('option', { value: 'a4', text: S.paper_a4 }),
      D.h('option', { value: 'custom', text: S.paper_custom })
    );
    // select 默认选中第一项，得手动摆到 state 上想的那一项
    paperSelect.value = state.paperId;
    paramsCard.appendChild(U.field(S.label_paper, paperSelect, { hint: S.hint_paper }));

    var paperWInput = D.h('input.layui-input.idprint-paper-w', {
      type: 'number', min: MIN_MM, max: MAX_MM, step: 1, value: 152
    });
    var paperHInput = D.h('input.layui-input.idprint-paper-h', {
      type: 'number', min: MIN_MM, max: MAX_MM, step: 1, value: 102
    });
    var paperCustomField = U.field(S.label_paper_custom,
      D.h('div.input-group', null,
        D.h('span.input-group-label', { style: { flex: '0 0 64px' }, text: S.label_width }),
        paperWInput,
        D.h('span.input-group-label', { style: { flex: '0 0 64px', borderRadius: '0 3px 3px 0' }, text: S.label_height }),
        paperHInput
      )
    );
    paperCustomField.hidden = true;
    paramsCard.appendChild(paperCustomField);

    var photoSelect = D.h('select.layui-select.idprint-photo',
      D.h('option', { value: 'one_inch', text: S.photo_one_inch }),
      D.h('option', { value: 'small_one_inch', text: S.photo_small_one_inch }),
      D.h('option', { value: 'large_one_inch', text: S.photo_large_one_inch }),
      D.h('option', { value: 'two_inch', text: S.photo_two_inch }),
      D.h('option', { value: 'small_two_inch', text: S.photo_small_two_inch }),
      D.h('option', { value: 'custom', text: S.paper_custom })
    );
    photoSelect.value = state.photoId;
    paramsCard.appendChild(U.field(S.label_photo, photoSelect, { hint: S.hint_photo }));

    var photoWInput = D.h('input.layui-input.idprint-photo-w', {
      type: 'number', min: MIN_MM, max: MAX_MM, step: 1, value: 25
    });
    var photoHInput = D.h('input.layui-input.idprint-photo-h', {
      type: 'number', min: MIN_MM, max: MAX_MM, step: 1, value: 35
    });
    var photoCustomField = U.field(S.label_photo_custom,
      D.h('div.input-group', null,
        D.h('span.input-group-label', { style: { flex: '0 0 64px' }, text: S.label_width }),
        photoWInput,
        D.h('span.input-group-label', { style: { flex: '0 0 64px', borderRadius: '0 3px 3px 0' }, text: S.label_height }),
        photoHInput
      )
    );
    photoCustomField.hidden = true;
    paramsCard.appendChild(photoCustomField);

    var gapInput = D.h('input.layui-input.idprint-gap', {
      type: 'number', min: MIN_GAP_MM, max: MAX_GAP_MM, step: 1, value: 2
    });
    paramsCard.appendChild(U.field(S.label_gap, gapInput, { hint: S.hint_gap }));

    var marginInput = D.h('input.layui-input.idprint-margin', {
      type: 'number', min: MIN_MARGIN_MM, max: MAX_MARGIN_MM, step: 1, value: 3
    });
    paramsCard.appendChild(U.field(S.label_margin, marginInput, { hint: S.hint_margin }));

    var dpiSelect = D.h('select.layui-select.idprint-dpi',
      D.h('option', { value: '150', text: '150 DPI' }),
      D.h('option', { value: '300', text: '300 DPI' }),
      D.h('option', { value: '600', text: '600 DPI' })
    );
    dpiSelect.value = String(DEFAULT_DPI);
    paramsCard.appendChild(U.field(S.label_dpi, dpiSelect, { hint: S.hint_dpi }));

    var captionInput = D.h('input.layui-input.idprint-caption', {
      type: 'text', value: '', placeholder: 'Name'
    });
    paramsCard.appendChild(U.field(S.label_caption, captionInput, { hint: S.hint_caption }));

    var numberInput = D.h('input.idprint-number', { type: 'checkbox' });
    paramsCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, numberInput, D.h('span', { text: S.label_number }))
    ));
    paramsCard.appendChild(D.h('p.field-hint', { text: S.hint_number }));

    var cutInput = D.h('input.idprint-cut', { type: 'checkbox' });
    cutInput.checked = true;
    paramsCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, cutInput, D.h('span', { text: S.label_cut }))
    ));
    paramsCard.appendChild(D.h('p.field-hint', { text: S.hint_cut }));

    /* ---------- 预览 ---------- */

    var previewCard = D.h('div.card', { hidden: true });
    previewCard.appendChild(D.h('h3', { text: S.preview_title }));
    var previewCanvas = D.h('canvas.idprint-canvas');
    previewCard.appendChild(previewCanvas);
    var statusLine = D.h('p.form-status.idprint-status');
    previewCard.appendChild(statusLine);

    /* ---------- 导出 ---------- */

    var exportCard = D.h('div.card', { hidden: true });
    exportCard.appendChild(D.h('h3', { text: S.export_title }));
    var downloadBtn = D.h('button.layui-btn.idprint-download', {
      type: 'button', text: S.btn_download
    });
    var printBtn = D.h('button.layui-btn.layui-btn-primary.idprint-print', {
      type: 'button', text: S.btn_print
    });
    exportCard.appendChild(D.h('div.form-actions', null, downloadBtn, printBtn));
    exportCard.appendChild(D.h('p.field-hint', { text: S.hint_export }));
    exportCard.appendChild(D.h('p.field-hint', { text: S.hint_print }));

    /* ---------- 摘要 ---------- */

    var summaryCard = D.h('div.card', { hidden: true });
    summaryCard.appendChild(D.h('h3', { text: S.summary_title }));
    var summaryBody = D.h('div');
    summaryCard.appendChild(summaryBody);

    /* ---------- 挂载 ---------- */

    root.appendChild(upload.card);
    root.appendChild(paramsCard);
    root.appendChild(previewCard);
    root.appendChild(exportCard);
    root.appendChild(summaryCard);

    /* ---------- 读文件 ---------- */

    function handleFile(file) {
      if (!file) return;
      upload.setStatus(S.status_reading, false);
      C.decode(file).then(function (decoded) {
        if (state.disposed) {
          if (decoded && decoded.close) decoded.close();
          return;
        }
        state.source = decoded.source;
        state.imgW = decoded.width;
        state.imgH = decoded.height;
        state.name = file.name || '';
        upload.setStatus('', false);
        paramsCard.hidden = false;
        previewCard.hidden = false;
        exportCard.hidden = false;
        render();
      }).catch(function () {
        if (state.disposed) return;
        upload.setStatus(S.err_decode, true);
      });
    }

    /* ---------- 当前参数 ---------- */

    /**
     * 现在的纸张（毫米）。
     */
    function currentPaper() {
      if (state.paperId === 'custom') {
        var w = clampMm(state.paperW, MIN_MM, MAX_MM);
        var h = clampMm(state.paperH, MIN_MM, MAX_MM);
        return { width: w, height: h };
      }
      var p = presetById(PAPER_PRESETS, state.paperId) || presetById(PAPER_PRESETS, 'photo6');
      return { width: p.width, height: p.height };
    }

    /**
     * 现在的照片尺寸（毫米）。
     */
    function currentPhoto() {
      if (state.photoId === 'custom') {
        return {
          width: clampMm(state.photoW, MIN_MM, MAX_MM),
          height: clampMm(state.photoH, MIN_MM, MAX_MM)
        };
      }
      var p = presetById(PHOTO_PRESETS, state.photoId) || presetById(PHOTO_PRESETS, 'one_inch');
      return { width: p.width, height: p.height };
    }

    /**
     * 拼出完整的版面（毫米为主，DPI 只在最后换算像素）。
     *
     * @returns {?Object} null 表示参数不合法
     */
    function buildLayout() {
      var paper = currentPaper();
      var photo = currentPhoto();
      if (!(paper.width > 0) || !(paper.height > 0)) return null;
      if (!(photo.width > 0) || !(photo.height > 0)) return null;

      var fit = fitDpi(paper.width, paper.height, state.dpi);
      if (!fit.dpi) return null;

      var caption = String(state.caption || '').trim();
      var stripMm = (caption || state.numbered) ? CAPTION_STRIP_MM : 0;
      var cellW = photo.width;
      var cellH = photo.height + stripMm;
      var gap = clampMm(state.gap, MIN_GAP_MM, MAX_GAP_MM);
      var margin = clampMm(state.margin, MIN_MARGIN_MM, MAX_MARGIN_MM);
      var g = gridLayout(paper.width, paper.height, cellW, cellH, gap, margin);

      return {
        paperW: paper.width,
        paperH: paper.height,
        photoW: photo.width,
        photoH: photo.height,
        stripMm: stripMm,
        cellW: cellW,
        cellH: cellH,
        gap: gap,
        margin: margin,
        cols: g.cols,
        rows: g.rows,
        offsetX: g.offsetX,
        offsetY: g.offsetY,
        caption: caption,
        numbered: !!state.numbered,
        cut: !!state.cut,
        dpi: fit.dpi,
        canvasW: fit.width,
        canvasH: fit.height
      };
    }

    /* ---------- 画 ---------- */

    /**
     * 把版面画到画布上。
     *
     * pxPerMm 决定这张画布的分辨率：导出用 DPI，预览用屏幕的 96。
     * 预览按**物理尺寸**画，所以 300 DPI 与 600 DPI 的预览长得一样大 ——
     * 那本来就是同一张纸。
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} layout   buildLayout 的结果
     * @param {*} source         可画进 canvas 的源
     * @param {number} pxPerMm   每毫米多少像素
     */
    function drawSheet(ctx, layout, source, pxPerMm) {
      if (!ctx || !layout || !source) return;
      var paperW = Math.round(layout.paperW * pxPerMm);
      var paperH = Math.round(layout.paperH * pxPerMm);
      var photoW = Math.round(layout.photoW * pxPerMm);
      var photoH = Math.round(layout.photoH * pxPerMm);
      var stripPx = layout.stripMm > 0 ? Math.round(layout.stripMm * pxPerMm) : 0;
      var gapPx = layout.gap * pxPerMm;
      var fontPx = Math.max(6, Math.round(CAPTION_FONT_MM * pxPerMm));

      ctx.save();
      // 白纸 —— 外面是深色主题时，白纸才像纸
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, paperW, paperH);

      var plan = cropPlan(state.imgW, state.imgH, photoW, photoH);
      for (var r = 0; r < layout.rows; r++) {
        for (var c = 0; c < layout.cols; c++) {
          var x = Math.round((layout.offsetX + c * (layout.cellW + layout.gap)) * pxPerMm);
          var y = Math.round((layout.offsetY + r * (layout.cellH + layout.gap)) * pxPerMm);
          ctx.drawImage(source, plan.sx, plan.sy, plan.sw, plan.sh, x, y, photoW, photoH);

          if (stripPx > 0) {
            var text = captionText(layout.caption, r * layout.cols + c, layout.numbered);
            if (text) {
              ctx.fillStyle = '#000000';
              ctx.font = fontPx + 'px sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(text, x + photoW / 2, y + photoH + stripPx / 2);
            }
          }

          if (layout.cut) {
            // 裁切线在格子边界上 —— 两张照片中间那条间距的正中间，
            // 照着剪才不会切到照片上。
            var half = gapPx / 2;
            var segs = dashSegments(
              x - half, y - half,
              photoW + gapPx, photoH + stripPx + gapPx,
              DASH_MM * pxPerMm, DASH_GAP_MM * pxPerMm
            );
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = Math.max(1, Math.round(CUT_WIDTH_MM * pxPerMm));
            ctx.beginPath();
            for (var i = 0; i < segs.length; i++) {
              ctx.moveTo(segs[i].x1, segs[i].y1);
              ctx.lineTo(segs[i].x2, segs[i].y2);
            }
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    /**
     * 预览用的每毫米多少像素。
     *
     * 先按屏幕的 96 DPI 算（纸在屏幕上就是那个物理大小），
     * 太宽了就按比例压到 MAX_PREVIEW_PX。
     */
    function previewPxPerMm(paperWmm) {
      var perMm = SCREEN_DPI / MM_PER_INCH;
      var width = paperWmm * perMm;
      if (width > MAX_PREVIEW_PX) perMm = MAX_PREVIEW_PX / paperWmm;
      return perMm;
    }

    /**
     * 画一整张纸（导出用，分辨率 = layout.dpi）。
     *
     * @returns {?HTMLCanvasElement}
     */
    function renderSheetCanvas(layout) {
      var limit = canvasLimit(layout.canvasW, layout.canvasH);
      if (!limit.ok) return null;
      var canvas = document.createElement('canvas');
      canvas.width = limit.width;
      canvas.height = limit.height;
      var ctx = canvas.getContext('2d');
      // jsdom 里 getContext('2d') 返回 null
      if (!ctx) return null;
      drawSheet(ctx, layout, state.source, layout.dpi / MM_PER_INCH);
      return canvas;
    }

    /* ---------- 重画 ---------- */

    function schedule() {
      if (state.disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        render();
      }, RENDER_DEBOUNCE_MS);
    }

    function render() {
      if (state.disposed) return;
      setStatus('');

      if (!state.source) {
        summaryCard.hidden = true;
        return;
      }

      var paper = currentPaper();
      var photo = currentPhoto();
      if (!(paper.width > 0) || !(paper.height > 0)) {
        setStatus(S.err_paper, 'error');
        summaryCard.hidden = true;
        return;
      }
      if (!(photo.width > 0) || !(photo.height > 0)) {
        setStatus(S.err_photo, 'error');
        summaryCard.hidden = true;
        return;
      }

      var layout = buildLayout();
      if (!layout) {
        // 连 150 DPI 都放不下 —— 这张纸画不出来
        var wanted = state.dpi;
        var w = mmToPx(paper.width, wanted);
        var h = mmToPx(paper.height, wanted);
        setStatus(S.err_too_big
          .replace('{dpi}', function () { return wanted; })
          .replace('{width}', function () { return w; })
          .replace('{height}', function () { return h; })
          .replace('{max}', function () { return MAX_CANVAS_SIDE; })
          .replace('{area}', function () { return Math.round(MAX_CANVAS_AREA / 1000000); })
          .replace('{used}', function () { return DPI_LADDER[DPI_LADDER.length - 1]; }), 'error');
        summaryCard.hidden = true;
        return;
      }

      // 降过 DPI 就说一声 —— 尺寸没变，但图糊了
      if (layout.dpi !== state.dpi) {
        setStatus(S.warn_dpi
          .replace('{dpi}', function () { return state.dpi; })
          .replace('{used}', function () { return layout.dpi; }), 'warn');
      }

      var pxPerMm = previewPxPerMm(layout.paperW);
      previewCanvas.width = Math.max(1, Math.round(layout.paperW * pxPerMm));
      previewCanvas.height = Math.max(1, Math.round(layout.paperH * pxPerMm));
      var ctx = previewCanvas.getContext('2d');
      if (!ctx) return;
      drawSheet(ctx, layout, state.source, pxPerMm);

      renderSummary(layout);
    }

    /**
     * 提示行：空 / is-error（红） / is-warn（黄）。
     */
    function setStatus(message, kind) {
      statusLine.textContent = message || '';
      statusLine.classList.toggle('is-error', kind === 'error');
      statusLine.classList.toggle('is-warn', kind === 'warn');
    }

    function renderSummary(layout) {
      D.clear(summaryBody);
      var photoPxW = mmToPx(layout.photoW, layout.dpi);
      var photoPxH = mmToPx(layout.photoH, layout.dpi);
      var rowsData = [
        [S.label_sheet_size, layout.paperW + ' × ' + layout.paperH + ' mm'],
        [S.label_canvas_size, layout.canvasW + ' × ' + layout.canvasH + ' px'],
        [S.label_photo_size, layout.photoW + ' × ' + layout.photoH + ' mm (' + photoPxW + ' × ' + photoPxH + ' px)'],
        [S.label_layout, layout.cols + ' × ' + layout.rows],
        [S.label_count, String(layout.cols * layout.rows)],
        [S.label_dpi_used, layout.dpi + ' DPI']
      ];
      var table = D.h('table.result-table');
      var tbody = D.h('tbody');
      rowsData.forEach(function (row) {
        tbody.appendChild(D.h('tr', null,
          D.h('th', { text: row[0] }),
          D.h('td', { text: row[1] })
        ));
      });
      table.appendChild(tbody);
      summaryBody.appendChild(table);
      summaryCard.hidden = false;
    }

    /* ---------- 事件 ---------- */

    paperSelect.addEventListener('change', function () {
      state.paperId = paperSelect.value;
      paperCustomField.hidden = state.paperId !== 'custom';
      if (state.paperId !== 'custom') {
        var p = presetById(PAPER_PRESETS, state.paperId);
        if (p) {
          state.paperW = p.width;
          state.paperH = p.height;
        }
      }
      schedule();
    });

    function bindMm(input, key) {
      input.addEventListener('input', function () {
        state[key] = clampMm(input.value, MIN_MM, MAX_MM);
        schedule();
      });
      input.addEventListener('change', function () {
        state[key] = clampMm(input.value, MIN_MM, MAX_MM);
        schedule();
      });
    }
    bindMm(paperWInput, 'paperW');
    bindMm(paperHInput, 'paperH');
    bindMm(photoWInput, 'photoW');
    bindMm(photoHInput, 'photoH');

    photoSelect.addEventListener('change', function () {
      state.photoId = photoSelect.value;
      photoCustomField.hidden = state.photoId !== 'custom';
      if (state.photoId !== 'custom') {
        var p = presetById(PHOTO_PRESETS, state.photoId);
        if (p) {
          state.photoW = p.width;
          state.photoH = p.height;
        }
      }
      schedule();
    });

    gapInput.addEventListener('input', function () {
      state.gap = clampMm(gapInput.value, MIN_GAP_MM, MAX_GAP_MM);
      schedule();
    });
    gapInput.addEventListener('change', function () {
      state.gap = clampMm(gapInput.value, MIN_GAP_MM, MAX_GAP_MM);
      schedule();
    });

    marginInput.addEventListener('input', function () {
      state.margin = clampMm(marginInput.value, MIN_MARGIN_MM, MAX_MARGIN_MM);
      schedule();
    });
    marginInput.addEventListener('change', function () {
      state.margin = clampMm(marginInput.value, MIN_MARGIN_MM, MAX_MARGIN_MM);
      schedule();
    });

    dpiSelect.addEventListener('change', function () {
      state.dpi = clampInt(dpiSelect.value, MIN_DPI, MAX_DPI, DEFAULT_DPI);
      schedule();
    });

    captionInput.addEventListener('input', function () {
      state.caption = captionInput.value;
      schedule();
    });

    numberInput.addEventListener('change', function () {
      state.numbered = !!numberInput.checked;
      schedule();
    });

    cutInput.addEventListener('change', function () {
      state.cut = !!cutInput.checked;
      schedule();
    });

    /* ---------- 导出 ---------- */

    downloadBtn.addEventListener('click', function () {
      if (state.disposed || !state.source) return;
      var layout = buildLayout();
      if (!layout) return;
      var canvas = renderSheetCanvas(layout);
      if (!canvas) return;
      if (typeof canvas.toBlob !== 'function') return;
      canvas.toBlob(function (blob) {
        if (!blob) return;
        window.ItTools.download(C.outputName(state.name, 'png', 'sheet'), blob, 'image/png');
      }, 'image/png');
    });

    printBtn.addEventListener('click', function () {
      if (state.disposed || !state.source) return;
      var layout = buildLayout();
      if (!layout) return;

      // window.open 必须在点击的**同步栈**里调用 ——
      // 放到 Promise 后面会被弹窗拦截器当成「不是用户点的」。
      var w = null;
      try {
        w = window.open('', '_blank');
      } catch (e) {
        w = null;
      }
      if (!w) {
        setStatus(S.status_popup, 'error');
        return;
      }

      var canvas = renderSheetCanvas(layout);
      if (!canvas || typeof canvas.toBlob !== 'function') {
        try { w.close(); } catch (e2) { /* 关不掉就算了 */ }
        return;
      }
      canvas.toBlob(function (blob) {
        if (!blob) {
          try { w.close(); } catch (e3) { /* 同上 */ }
          return;
        }
        var url = URL.createObjectURL(blob);
        writePrintPage(w, url, layout, state.name);
      }, 'image/png');
    });

    /**
     * 打印页。
     *
     * @page 的 size 就是纸张的物理尺寸，缩放必须是 100% ——
     * 浏览器默认会按「适合页面」缩放，打印出来就小了一圈。
     */
    function writePrintPage(w, url, layout, name) {
      var doc = w.document;
      var title = name ? name : 'sheet';
      var html = '<!doctype html><html><head><meta charset="utf-8"><title>' +
        escapeHtml(title) + '</title><style>@page{size:' +
        layout.paperW + 'mm ' + layout.paperH + 'mm;margin:0}' +
        'html,body{margin:0;padding:0;background:#fff}' +
        'img{display:block;width:' + layout.paperW + 'mm;height:' + layout.paperH + 'mm}' +
        '</style></head><body><img id="sheet" src="' + url + '"></body></html>';
      try {
        doc.open();
        doc.write(html);
        doc.close();
        var img = doc.getElementById('sheet');
        if (img) {
          img.onload = function () {
            try {
              w.focus();
              w.print();
            } catch (e) { /* 打印被拒就算了 */ }
            revoke(url);
          };
          img.onerror = function () { revoke(url); };
        }
      } catch (e) {
        revoke(url);
      }
    }

    function revoke(url) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) { /* 有的浏览器没有这个 API */ }
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    return {
      destroy: function () {
        state.disposed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        D.clear(root);
      }
    };
  });

  /* ==========================================================================
     纯逻辑出口（node 侧的 jsdom 测试直接调这些）
     ========================================================================== */

  window.ItTools.logic['id-photo-print'] = {
    PAPER_PRESETS: PAPER_PRESETS,
    PHOTO_PRESETS: PHOTO_PRESETS,
    mmToPx: mmToPx,
    canvasLimit: canvasLimit,
    fitDpi: fitDpi,
    cropRect: cropRect,
    cropPlan: cropPlan,
    gridCount: gridCount,
    gridLayout: gridLayout,
    dashSegments: dashSegments,
    captionText: captionText,
    __cases: function (assert) {
      var assertFn = assert;

      /* ---- 毫米换算 ---- */

      // 跟「证件照标准尺寸」那张像素表一一对应：
      // 一寸 295×413、小一寸 260×378、大一寸 390×567、二寸 413×579、小二寸 413×531
      assertFn.eq(mmToPx(25, 300), 295, '一寸的宽在 300 DPI 下是 295 像素');
      assertFn.eq(mmToPx(35, 300), 413, '一寸的高在 300 DPI 下是 413 像素');
      assertFn.eq(mmToPx(22, 300), 260, '小一寸的宽是 260 像素');
      assertFn.eq(mmToPx(32, 300), 378, '小一寸的高是 378 像素');
      assertFn.eq(mmToPx(33, 300), 390, '大一寸的宽是 390 像素');
      assertFn.eq(mmToPx(48, 300), 567, '大一寸的高是 567 像素');
      assertFn.eq(mmToPx(49, 300), 579, '二寸的高是 579 像素');
      assertFn.eq(mmToPx(45, 300), 531, '小二寸的高是 531 像素');
      assertFn.eq(mmToPx(210, 600), 4961, 'A4 的宽在 600 DPI 下是 4961 像素');
      assertFn.eq(mmToPx(297, 600), 7016, 'A4 的高在 600 DPI 下是 7016 像素');
      assertFn.eq(mmToPx(0, 300), 0, '零毫米没有像素');
      assertFn.eq(mmToPx(25, 0), 295, 'DPI 非法时用默认值 300');

      /* ---- 画布上限 ---- */

      assertFn.eq(canvasLimit(4961, 7016).ok, true, 'A4 在 600 DPI 下放得下');
      assertFn.eq(canvasLimit(40000, 100).ok, false, '单边超过 32767 放不下');
      assertFn.eq(canvasLimit(20000, 20000).ok, false, '面积超过上限放不下');
      assertFn.eq(canvasLimit(0, 100).ok, false, '零宽放不下');

      /* ---- 降分辨率 ---- */

      assertFn.eq(fitDpi(210, 297, 600).dpi, 600, 'A4 在 600 DPI 下放得下，不用降');
      assertFn.eq(fitDpi(210, 297, 300).dpi, 300, '要 300 就给 300');
      assertFn.eq(fitDpi(600, 900, 600).dpi, 300, '太大的纸从 600 降到 300');
      assertFn.eq(fitDpi(4000, 4000, 150).dpi, 0, '怎么都放不下就返回 0');
      assertFn.eq(fitDpi(210, 297, 600).width, 4961, '降分辨率那一步也要给出画布宽');

      /* ---- 裁剪 ---- */

      assertFn.eq(cropRect(200, 100, 100, 100).sw, 100, '方块目标从宽图里裁成方的');
      assertFn.eq(cropRect(200, 100, 100, 100).sh, 100, '方块目标的高就是原图的高');
      assertFn.eq(cropRect(100, 200, 100, 100).sw, 100, '方块目标从高图里裁成方的');
      assertFn.eq(cropRect(100, 200, 100, 100).sh, 100, '方块目标的高被裁短');
      assertFn.eq(cropRect(600, 1000, 300, 200).sw, 600, '源图更窄：取满宽');
      assertFn.eq(cropRect(600, 1000, 300, 200).sh, 400, '源图更窄：上下裁到目标比例');
      assertFn.eq(cropRect(1000, 600, 300, 200).sw, 900, '源图更宽：满高裁宽');
      assertFn.eq(cropRect(1000, 600, 300, 200).sh, 600, '源图更宽：高度不变');
      assertFn.eq(cropPlan(200, 100, 100, 100).sx, 50, '裁剪块在源图里居中');
      assertFn.eq(cropPlan(200, 100, 100, 100).sy, 0, '裁剪块的高度就是原图高度');
      assertFn.eq(cropPlan(400, 400, 100, 100).sx, 0, '比例一样就不裁，一刀都不动');
      assertFn.eq(cropPlan(1000, 500, 250, 250).sx, 250, '裁宽的时候左右对半分');

      /* ---- 网格 ---- */

      // 6 寸纸（152×102）放一寸照（25×35），间距 2、页边距 3 → 5×2 = 10 张
      assertFn.eq(gridCount(152, 102, 25, 35, 2, 3).cols, 5, '6 寸纸横向放 5 张一寸');
      assertFn.eq(gridCount(152, 102, 25, 35, 2, 3).rows, 2, '6 寸纸纵向放 2 张一寸');
      assertFn.eq(gridCount(152, 102, 25, 35, 2, 3).cols * gridCount(152, 102, 25, 35, 2, 3).rows, 10, '一共 10 张');

      // 照片比版心还大 → 一张也放不下
      assertFn.eq(gridCount(152, 102, 200, 35, 2, 3).cols, 0, '放不下就是 0');

      var g = gridLayout(152, 102, 25, 35, 2, 3);
      assertFn.eq(g.blockW, 5 * 25 + 4 * 2, '整块的宽是 5 张照片加 4 条间距');
      assertFn.eq(g.blockH, 2 * 35 + 1 * 2, '整块的高是 2 张照片加 1 条间距');
      assertFn(g.offsetX >= 3, '左边距不会比用户设的小');
      assertFn(Math.abs(g.offsetX - (152 - g.blockW) / 2) < 1e-9, '整块在纸上居中');
      assertFn(Math.abs(g.offsetY - (102 - g.blockH) / 2) < 1e-9, '整块在纸上居中（纵向）');
      // 照片的物理尺寸一分没多
      assertFn.eq(g.cols * 25 + (g.cols - 1) * 2 + 2 * g.offsetX, 152, '余量全在页边距上');

      /* ---- 虚线 ---- */

      var segs = dashSegments(0, 0, 100, 50, 10, 5);
      assertFn(segs.length > 0, '虚线有段');
      var allInside = segs.every(function (s) {
        return s.x1 >= -1e-9 && s.y1 >= -1e-9 &&
          s.x2 <= 100 + 1e-9 && s.y2 <= 50 + 1e-9;
      });
      assertFn(allInside, '虚线不跑出矩形');
      var totalLen = segs.reduce(function (sum, s) {
        return sum + Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      }, 0);
      // 周长 300，每 15 走 10 → 20 个周期，减去最后一段被截短的
      assertFn(totalLen <= 300, '虚线总长不超过周长');
      assertFn(totalLen >= 190, '虚线总长接近 20 段 × 10');

      assertFn.eq(dashSegments(0, 0, 0, 10, 5, 2).length, 0, '宽度为 0 没有虚线');
      assertFn.eq(dashSegments(0, 0, 10, 10, 0, 2).length, 0, '实线段长度为 0 没有虚线');

      // 拐角处要断开：一段虚线不能斜着穿过拐角
      var cornerSegs = dashSegments(0, 0, 100, 100, 30, 10);
      var crossesCorner = cornerSegs.some(function (s) {
        var dx = s.x2 - s.x1, dy = s.y2 - s.y1;
        return dx !== 0 && dy !== 0;
      });
      assertFn(!crossesCorner, '虚线段都是横的或竖的，不斜穿拐角');

      /* ---- 标注 ---- */

      assertFn.eq(captionText('Photo', 2, true), 'Photo 3', '有字也有编号时两个都写');
      assertFn.eq(captionText('Photo', 0, false), 'Photo', '不编号就只写字');
      assertFn.eq(captionText('', 2, true), '3', '没字就只写编号');
      assertFn.eq(captionText('', 0, false), '', '没字也不编号就是空');
      assertFn.eq(captionText('  Name  ', 0, false), 'Name', '两边的空格去掉');

      /* ---- 预置表 ---- */

      assertFn.eq(PHOTO_PRESETS.length >= 5, true, '至少五个照片预置');
      assertFn.eq(PAPER_PRESETS.length >= 5, true, '至少五个纸张预置');
      var oneInch = null;
      for (var i = 0; i < PHOTO_PRESETS.length; i++) {
        if (PHOTO_PRESETS[i].id === 'one_inch') oneInch = PHOTO_PRESETS[i];
      }
      assertFn.eq(oneInch.width * oneInch.height, 25 * 35, '一寸是 25×35 毫米');
    }
  };
})();
