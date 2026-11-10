/* ==========================================================================
   改尺寸（image-resizer）

   把一张图缩成想要的宽高 —— 上传、填两个数字、下载，全程在浏览器里完成。

   这个工具只做**缩放**，不做裁剪：输出就是整张图被拉到目标宽高。
   目标宽高比跟原图不一样时图会被拉变形，所以这里把这件事说明白，
   并给一条去裁剪工具的链接 —— 想保住形状又改尺寸，先裁再缩。

   锁比例的时候，用的是**比例本身**去反算另一边，而不是拿当前宽高去算：
   拿当前宽高算，每取整一次就会偏一点，改十次就飘了。
   比例来自「比例预设」，预设里没有的（比如原图比例）就用原图宽高算。

   三条不能省的实话：

   - 原图比目标小的时候只能放大 —— 放大的图是插值出来的，
     并不会多出细节，说清楚比装作没这回事好。
   - 目标尺寸超过浏览器的画布上限时**不编码**：
     内核遇到画布吃不下的尺寸会悄悄把长宽减半重试，
     那样下载到的图就不是用户要的尺寸了 —— 不如直接报错。
   - 浏览器不支持某个格式的编码时，toBlob 会按规范悄悄退回 PNG，
     查 blob.type 把这件事讲明白。

   图片一个字节都不出浏览器：解码、缩放、编码全在本地完成。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-resizer');

  /**
   * 比例预设。
   *
   * original 是「原图的比例」—— 载入图片之后才知道是多少，
   * 表里先留 0。
   */
  var RATIO_PRESETS = [
    { id: 'original', key: 'ratio_original', width: 0, height: 0 },
    { id: '1:1', key: 'ratio_1_1', width: 1, height: 1 },
    { id: '16:9', key: 'ratio_16_9', width: 16, height: 9 },
    { id: '9:16', key: 'ratio_9_16', width: 9, height: 16 },
    { id: '4:3', key: 'ratio_4_3', width: 4, height: 3 },
    { id: '3:4', key: 'ratio_3_4', width: 3, height: 4 },
    { id: '3:2', key: 'ratio_3_2', width: 3, height: 2 },
    { id: '2:3', key: 'ratio_2_3', width: 2, height: 3 },
    { id: '21:9', key: 'ratio_21_9', width: 21, height: 9 }
  ];

  /** 预览画布的最长边 —— 预览只是给人看的，没必要按目标像素开画布。 */
  var PREVIEW_MAX = 720;

  /** 浏览器画布的上限：每边 32767、总面积 268435456（约 2.68 亿像素）。 */
  var MAX_CANVAS_SIDE = 32767;
  var MAX_CANVAS_AREA = 268435456;

  /** 编码防抖的毫秒 —— 改数字的时候不用每敲一下就编码一次。 */
  var ENCODE_DEBOUNCE_MS = 150;

  var S = {
    title: t('title', 'Resize an image to new dimensions'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.'),
    settings_title: t('settings_title', 'Resize settings'),
    label_width: t('label_width', 'Width'),
    label_height: t('label_height', 'Height'),
    label_lock: t('label_lock', 'Lock the aspect ratio'),
    label_ratio: t('label_ratio', 'Aspect ratio'),
    ratio_original: t('ratio_original', 'Original'),
    ratio_1_1: t('ratio_1_1', '1:1'),
    ratio_16_9: t('ratio_16_9', '16:9'),
    ratio_9_16: t('ratio_9_16', '9:16'),
    ratio_4_3: t('ratio_4_3', '4:3'),
    ratio_3_4: t('ratio_3_4', '3:4'),
    ratio_3_2: t('ratio_3_2', '3:2'),
    ratio_2_3: t('ratio_2_3', '2:3'),
    ratio_21_9: t('ratio_21_9', '21:9'),
    label_percent: t('label_percent', 'Scale'),
    hint_percent: t('hint_percent', 'The size of the output compared to the original width. Change it to scale both dimensions at once.'),
    label_format: t('label_format', 'Output format'),
    label_quality: t('label_quality', 'Quality'),
    hint_quality: t('hint_quality', 'PNG is lossless — the quality setting does not change it.'),
    hint_lock: t('hint_lock', 'With the ratio locked, changing one dimension changes the other to keep the shape. The ratio comes from the preset above, so it never drifts.'),
    preview_title: t('preview_title', 'Preview'),
    result_title: t('result_title', 'Result'),
    label_item: t('label_item', 'Item'),
    label_value: t('label_value', 'Value'),
    label_source_size: t('label_source_size', 'Original size'),
    label_output_size: t('label_output_size', 'Output size'),
    label_scale: t('label_scale', 'Scale'),
    label_file_size: t('label_file_size', 'File size'),
    label_output_format: t('label_output_format', 'Saved as'),
    no_result: t('no_result', 'No image yet.'),
    download: t('download', 'Download the resized image'),
    reset_original: t('reset_original', 'Reset to the original size'),
    status_reading: t('status_reading', 'Reading the file…'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_size: t('err_size', 'Enter a width and a height bigger than zero.'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    err_canvas_limit: t('err_canvas_limit', 'A browser canvas cannot hold {width} × {height} pixels (the limit is {max} pixels per side and {area} megapixels in total), so nothing was encoded.'),
    warn_upscale: t('warn_upscale', 'The picture is smaller than {width} × {height}, so it was enlarged {factor} times and may look blurry.'),
    warn_distort: t('warn_distort', 'The target ratio is not the ratio of the original picture, so the picture will be stretched.'),
    warn_fallback: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.'),
    warn_scaled: t('warn_scaled', 'The browser could not allocate a canvas of {width} × {height}, so the image was saved at {actualWidth} × {actualHeight}.'),
    link_crop: t('link_crop', 'Need to cut the picture instead? Open the crop tool.')
  };

  /* ---------- 纯逻辑（给 harness 用，也在下面被界面用） ---------- */

  /**
   * 解析一个尺寸输入框的值。
   *
   * 空、不是数字、0、负数都算无效 —— 这时候**退回旧值**，
   * 而不是把图缩成 0 像素（那会抛异常，整块工具就白了）。
   *
   * @param {*} value 输入框里的原始值
   * @param {number} fallback 兜底值（一般是当前尺寸）
   * @returns {number}
   */
  function parseDimension(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    n = Math.round(n);
    if (n <= 0) return fallback;
    return n;
  }

  /**
   * 解析百分比输入框的值。百分比允许带小数（0.5% 也认）。
   *
   * @param {*} value
   * @param {number} fallback
   * @returns {number}
   */
  function parsePercent(value, fallback) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return fallback;
    return n;
  }

  /**
   * 比例预设 → 数值比例。
   *
   * @param {string} ratioId 预设 id
   * @param {number} srcW 原图宽
   * @param {number} srcH 原图高
   * @returns {number|null} 比例（宽/高）；没有原图时 original 给 null
   */
  function ratioValue(ratioId, srcW, srcH) {
    if (ratioId === 'original') {
      var w = Number(srcW);
      var h = Number(srcH);
      if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
      return w / h;
    }
    for (var i = 0; i < RATIO_PRESETS.length; i++) {
      if (RATIO_PRESETS[i].id !== ratioId) continue;
      var p = RATIO_PRESETS[i];
      if (!p.width || !p.height) return null;
      return p.width / p.height;
    }
    return null;
  }

  /**
   * 按比例算另一边。
   *
   * @param {number} ratio 比例（宽/高）
   * @param {number} base 已知的那一维
   * @param {string} axis base 是哪一维：'width' 表示已知宽，'height' 表示已知高
   * @returns {number|null}
   */
  function dimensionFor(ratio, base, axis) {
    var r = Number(ratio);
    if (!isFinite(r) || r <= 0) return null;
    var b = Math.round(Number(base) || 0);
    if (b <= 0) return null;
    var v = Math.round(axis === 'height' ? b * r : b / r);
    return v > 0 ? v : null;
  }

  /**
   * 目标宽度是原图宽度的百分之多少。
   *
   * @param {number} targetW
   * @param {number} srcW
   * @returns {number|null}
   */
  function percentOf(targetW, srcW) {
    var t0 = Number(targetW);
    var s = Number(srcW);
    if (!isFinite(t0) || !isFinite(s) || s <= 0 || t0 <= 0) return null;
    return Math.round(t0 / s * 100);
  }

  /**
   * 按百分比同时缩两个维度。
   *
   * @param {number} srcW 原图宽
   * @param {number} srcH 原图高
   * @param {number} pct 百分比
   * @returns {{width: number, height: number}}
   */
  function sizeFromPercent(srcW, srcH, pct) {
    var p = Number(pct);
    var w = Math.round(Number(srcW) * p / 100);
    var h = Math.round(Number(srcH) * p / 100);
    if (!isFinite(w) || w < 1) w = 1;
    if (!isFinite(h) || h < 1) h = 1;
    return { width: w, height: h };
  }

  /**
   * 目标尺寸是不是浏览器画布吃得下的。
   *
   * 吃不下就别编码：内核遇到画布分配失败会自己把长宽减半重试，
   * 那样下载到的图就不是用户填的尺寸了 —— 不如报错。
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
   * 放大了几倍（没放大就是 1 或更小）。
   *
   * @param {number} w 目标宽
   * @param {number} h 目标高
   * @param {number} srcW 原图宽
   * @param {number} srcH 原图高
   * @returns {number}
   */
  function upscaleFactor(w, h, srcW, srcH) {
    var a = Number(w) / Number(srcW);
    var b = Number(h) / Number(srcH);
    if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return 1;
    return Math.max(a, b);
  }

  /**
   * 目标宽高比跟原图对不对得上（也就是会不会被拉变形）。
   *
   * 比的是**两个方向的缩放倍数**：锁比例时按比例取整会带来零点几个
   * 像素的误差，所以留了 2% 的容差 —— 那种误差看不出来，
   * 真正改了形状的比例差得远不止 2%。
   *
   * @param {number} w 目标宽
   * @param {number} h 目标高
   * @param {number} srcW 原图宽
   * @param {number} srcH 原图高
   * @returns {boolean}
   */
  function isDistorted(w, h, srcW, srcH) {
    var a = Number(w) / Number(srcW);
    var b = Number(h) / Number(srcH);
    if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return false;
    var lo = Math.min(a, b);
    var hi = Math.max(a, b);
    return hi / lo > 1.02;
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('image-resizer', function (root) {
    var disposed = false;
    /** 编码的序号。慢的那次算完了不许盖掉快的那次的结果。 */
    var ticket = 0;
    /** 编码防抖的计时器。 */
    var encodeTimer = null;

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
      /** 目标尺寸。 */
      targetWidth: 0,
      targetHeight: 0,
      /** 当前比例预设。 */
      ratioId: 'original',
      /** 锁不锁比例。 */
      locked: true,
      formatId: 'jpeg',
      quality: 90,
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

    var settingsCard = D.h('div.card', { hidden: true });
    var previewCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(settingsCard);
    root.appendChild(previewCard);
    root.appendChild(resultCard);

    /* ---------- 设置 ---------- */

    var widthInput = D.h('input.layui-input', { type: 'number', min: 1, step: 1, value: 0 });
    var heightInput = D.h('input.layui-input', { type: 'number', min: 1, step: 1, value: 0 });
    var percentInput = D.h('input.layui-input', { type: 'number', min: 1, step: 1, value: 100 });

    var lockInput = D.h('input', { type: 'checkbox', checked: true });
    var lockSwitch = D.h('div.switch-grid', null,
      D.h('label.switch', null, lockInput, D.h('span', { text: S.label_lock }))
    );

    var ratioSelect = D.h('select.layui-select');
    RATIO_PRESETS.forEach(function (preset) {
      ratioSelect.appendChild(D.h('option', { value: preset.id, text: S[preset.key] }));
    });

    var formatSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'jpeg', text: 'JPEG' }),
      D.h('option', { value: 'png', text: 'PNG' }),
      D.h('option', { value: 'webp', text: 'WebP' })
    );
    var qualityInput = D.h('input.slider', { type: 'range', min: 1, max: 100, step: 1, value: state.quality });

    var qualityHint = D.h('p.field-hint');
    var statusLine = D.h('p.form-status');
    var resetBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: S.reset_original });

    settingsCard.appendChild(D.h('h3', { text: S.settings_title }));
    settingsCard.appendChild(U.field(S.label_width, widthInput));
    settingsCard.appendChild(U.field(S.label_height, heightInput));
    settingsCard.appendChild(lockSwitch);
    settingsCard.appendChild(D.h('p.field-hint', { text: S.hint_lock }));
    settingsCard.appendChild(U.field(S.label_ratio, ratioSelect));
    settingsCard.appendChild(U.field(S.label_percent, percentInput, { hint: S.hint_percent }));
    settingsCard.appendChild(U.field(S.label_format, formatSelect));
    settingsCard.appendChild(U.field(S.label_quality, qualityInput));
    settingsCard.appendChild(qualityHint);
    settingsCard.appendChild(D.h('div.form-actions', null, resetBtn));
    settingsCard.appendChild(statusLine);
    settingsCard.appendChild(D.h('p.field-hint', null,
      D.h('a', { href: '/image-cropper', text: S.link_crop })
    ));

    /* ---------- 预览 ---------- */

    var previewCanvas = D.h('canvas');
    var previewSize = D.h('p.field-hint');
    previewCard.appendChild(D.h('h3', { text: S.preview_title }));
    previewCard.appendChild(D.h('div.preview-box', null, previewCanvas));
    previewCard.appendChild(previewSize);

    /* ---------- 结果 ---------- */

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

    /** 现在生效的比例。没锁或者没有原图时给 null。 */
    function currentRatio() {
      if (!state.locked) return null;
      return ratioValue(state.ratioId, state.width, state.height);
    }

    /**
     * 把状态里的数字回写到输入框。
     *
     * 值一样就**不写** —— 正在输入的时候被改掉，光标会跳。
     *
     * @param {HTMLInputElement} input
     * @param {number} value
     */
    function setInputValue(input, value) {
      var v = String(value);
      if (input.value !== v) input.value = v;
    }

    /** 状态 → 输入框。 */
    function syncInputs() {
      if (!state.width) return;
      setInputValue(widthInput, state.targetWidth);
      setInputValue(heightInput, state.targetHeight);
      var pct = percentOf(state.targetWidth, state.width);
      if (pct !== null) setInputValue(percentInput, pct);
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
      var wPct = percentOf(r.width, state.width);
      var hPct = percentOf(r.height, state.height);
      var scale = wPct === null ? '' : wPct + '%';
      // 两个方向的缩放不一样（比例被改了）时分开写，别只报一个百分比。
      if (wPct !== null && hPct !== null && wPct !== hPct) {
        scale = S.label_width + ' ' + wPct + '% · ' + S.label_height + ' ' + hPct + '%';
      }

      var rows = [
        { label: S.label_source_size, value: state.width + ' × ' + state.height },
        { label: S.label_output_size, value: r.width + ' × ' + r.height },
        { label: S.label_scale, value: scale },
        { label: S.label_file_size, value: C.formatBytes(r.bytes) },
        { label: S.label_output_format, value: format.label }
      ];
      resultBody.appendChild(kvTable(rows));

      // 原图比目标尺寸小 —— 只能放大，放大了会发糊，得说出来
      var factor = upscaleFactor(r.width, r.height, state.width, state.height);
      if (factor > 1.001) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: S.warn_upscale
              .replace('{width}', String(r.width))
              .replace('{height}', String(r.height))
              .replace('{factor}', String(Math.round(factor * 100) / 100))
          })
        ));
      }

      // 目标比例跟原图不一样 —— 会被拉变形，说清楚并给一条去裁剪的路
      if (isDistorted(r.width, r.height, state.width, state.height)) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', { text: S.warn_distort }),
          D.h('div', null, D.h('a', { href: '/image-cropper', text: S.link_crop }))
        ));
      }

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
              .replace('{width}', String(state.targetWidth))
              .replace('{height}', String(state.targetHeight))
              .replace('{actualWidth}', String(r.width))
              .replace('{actualHeight}', String(r.height))
          })
        ));
      }

      // 动图只剩第一帧 —— canvas 画不出后面的帧，不说清楚就成了骗人
      if (state.animation && state.animation.animated) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: S.warn_animation.replace('{n}', String(state.animation.frames))
          })
        ));
      }

      var downloadBtn = D.h('button.layui-btn.layui-btn-primary', {
        type: 'button', text: S.download
      });
      downloadBtn.addEventListener('click', function () {
        if (disposed || !state.result) return;
        var fmt = C.formatById(state.result.formatId) || C.FORMATS[0];
        window.ItTools.download(
          C.outputName(state.name, fmt.ext, state.result.width + 'x' + state.result.height),
          state.result.blob,
          fmt.mime
        );
      });
      resultBody.appendChild(D.h('div.form-actions', null, downloadBtn));
    }

    /* ---------- 预览 ---------- */

    /** 重画预览（同步，不等编码）。 */
    function redrawPreview() {
      if (!state.decoded || !state.targetWidth || !state.targetHeight) return;
      // 预览只是给人看的 —— 按目标像素开画布，一张 8000×6000 的预览
      // 会白白吃掉几十兆内存，所以缩到 PREVIEW_MAX 以内。
      var k = Math.min(1, PREVIEW_MAX / Math.max(state.targetWidth, state.targetHeight));
      var pw = Math.max(1, Math.round(state.targetWidth * k));
      var ph = Math.max(1, Math.round(state.targetHeight * k));
      if (previewCanvas.width !== pw || previewCanvas.height !== ph) {
        previewCanvas.width = pw;
        previewCanvas.height = ph;
      }
      var ctx = previewCanvas.getContext('2d');
      // 画的是**成品**：源图拉到目标宽高比，所以变形也能一眼看出来。
      if (ctx) ctx.drawImage(state.decoded.source, 0, 0, pw, ph);
      previewSize.textContent = state.targetWidth + ' × ' + state.targetHeight;
    }

    /* ---------- 编码 ---------- */

    /**
     * 按当前设置编码一次。
     *
     * @param {function(): boolean} isCurrent 竞态闸门
     * @returns {Promise<void>}
     */
    function encodeNow(isCurrent) {
      var limit = canvasLimit(state.targetWidth, state.targetHeight);
      if (!limit.ok) {
        state.result = null;
        if (limit.reason === 'size') {
          setStatus(S.err_size, true);
        } else {
          setStatus(S.err_canvas_limit
            .replace('{width}', String(state.targetWidth))
            .replace('{height}', String(state.targetHeight))
            .replace('{max}', String(MAX_CANVAS_SIDE))
            .replace('{area}', String(Math.round(MAX_CANVAS_AREA / 1000000))), true);
        }
        renderResult();
        return Promise.resolve();
      }

      return C.encode(state.decoded, {
        width: state.targetWidth,
        height: state.targetHeight,
        formatId: state.formatId,
        quality: state.quality,
        background: '#ffffff'
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

    /** 改设置之后的总入口：先重画预览，再防抖地编码。 */
    function refresh() {
      if (!state.decoded) return;
      redrawPreview();
      if (encodeTimer) {
        clearTimeout(encodeTimer);
        encodeTimer = null;
      }
      var mine = ++ticket;
      var isCurrent = function () { return !disposed && mine === ticket; };
      encodeTimer = setTimeout(function () {
        encodeTimer = null;
        encodeNow(isCurrent);
      }, ENCODE_DEBOUNCE_MS);
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

          // 新图进来，目标尺寸回到原图尺寸，比例回到「原图」
          state.targetWidth = decoded.width;
          state.targetHeight = decoded.height;
          state.ratioId = 'original';
          state.locked = true;
          lockInput.checked = true;
          ratioSelect.value = 'original';

          upload.setStatus('');
          settingsCard.hidden = false;
          previewCard.hidden = false;
          resultCard.hidden = false;
          syncInputs();
          refresh();
        }, function () {
          if (disposed) return;
          upload.setStatus(S.err_decode, true);
          settingsCard.hidden = true;
          previewCard.hidden = true;
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

    widthInput.addEventListener('input', function () {
      if (!state.decoded) return;
      state.targetWidth = parseDimension(widthInput.value, state.targetWidth);
      var ratio = currentRatio();
      if (ratio) {
        var h = dimensionFor(ratio, state.targetWidth, 'width');
        if (h) state.targetHeight = h;
      }
      syncInputs();
      refresh();
    });

    heightInput.addEventListener('input', function () {
      if (!state.decoded) return;
      state.targetHeight = parseDimension(heightInput.value, state.targetHeight);
      var ratio = currentRatio();
      if (ratio) {
        var w = dimensionFor(ratio, state.targetHeight, 'height');
        if (w) state.targetWidth = w;
      }
      syncInputs();
      refresh();
    });

    percentInput.addEventListener('input', function () {
      if (!state.decoded) return;
      var pct = parsePercent(percentInput.value, percentOf(state.targetWidth, state.width) || 100);
      var size = sizeFromPercent(state.width, state.height, pct);
      state.targetWidth = size.width;
      var ratio = currentRatio();
      if (ratio) {
        // 锁着比例时，高度跟着比例走 —— 比例预设说什么就是什么。
        var h = dimensionFor(ratio, state.targetWidth, 'width');
        state.targetHeight = h || size.height;
      } else {
        state.targetHeight = size.height;
      }
      syncInputs();
      refresh();
    });

    lockInput.addEventListener('change', function () {
      state.locked = lockInput.checked;
      // 刚锁上时，把当前宽高比当成要保持的比例 —— 免得锁一开就跳一下
      if (state.locked && state.width) {
        var ratio = ratioValue(state.ratioId, state.width, state.height);
        if (!ratio) {
          state.ratioId = 'original';
          ratio = state.width / state.height;
        }
        var h = dimensionFor(ratio, state.targetWidth, 'width');
        if (h) state.targetHeight = h;
        ratioSelect.value = state.ratioId;
      }
      syncInputs();
      refresh();
    });

    ratioSelect.addEventListener('change', function () {
      state.ratioId = ratioSelect.value;
      var ratio = ratioValue(state.ratioId, state.width, state.height);
      if (!ratio) return;
      // 选了比例就锁上 —— 比例预设的意思就是「按这个比例来」
      state.locked = true;
      lockInput.checked = true;
      // 保留宽度，只把高度改成新比例
      var h = dimensionFor(ratio, state.targetWidth, 'width');
      if (h) state.targetHeight = h;
      syncInputs();
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

    resetBtn.addEventListener('click', function () {
      if (!state.decoded) return;
      state.targetWidth = state.width;
      state.targetHeight = state.height;
      state.ratioId = 'original';
      state.locked = true;
      lockInput.checked = true;
      ratioSelect.value = 'original';
      syncInputs();
      refresh();
    });

    return {
      destroy: function () {
        disposed = true;
        ticket++;
        if (encodeTimer) {
          clearTimeout(encodeTimer);
          encodeTimer = null;
        }
        if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
        if (state.decoded && state.decoded.close) state.decoded.close();
        state.resultUrl = '';
        state.decoded = null;
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['image-resizer'] = {
    RATIO_PRESETS: RATIO_PRESETS,
    MAX_CANVAS_SIDE: MAX_CANVAS_SIDE,
    MAX_CANVAS_AREA: MAX_CANVAS_AREA,
    parseDimension: parseDimension,
    parsePercent: parsePercent,
    ratioValue: ratioValue,
    dimensionFor: dimensionFor,
    percentOf: percentOf,
    sizeFromPercent: sizeFromPercent,
    canvasLimit: canvasLimit,
    upscaleFactor: upscaleFactor,
    isDistorted: isDistorted,

    __cases: function (assert) {
      /* ---- 解析尺寸 ---- */

      assert.eq(parseDimension('123', 10), 123, '数字字符串照收');
      assert.eq(parseDimension(456, 10), 456, '数字照收');
      assert.eq(parseDimension('12.6', 10), 13, '小数取整');
      assert.eq(parseDimension('', 10), 10, '空值退回旧值');
      assert.eq(parseDimension('abc', 10), 10, '不是数字退回旧值');
      assert.eq(parseDimension('0', 10), 10, '0 退回旧值');
      assert.eq(parseDimension('-5', 10), 10, '负数退回旧值');
      assert.eq(parseDimension(NaN, 10), 10, 'NaN 退回旧值');

      /* ---- 解析百分比 ---- */

      assert.eq(parsePercent('50', 100), 50, '整数百分比');
      assert.eq(parsePercent('0.5', 100), 0.5, '小数百分比也认');
      assert.eq(parsePercent('0', 100), 100, '0 退回旧值');
      assert.eq(parsePercent('', 100), 100, '空值退回旧值');
      assert.eq(parsePercent('abc', 100), 100, '不是数字退回旧值');

      /* ---- 比例 ---- */

      assert.eq(ratioValue('1:1', 800, 600), 1, '1:1');
      assert.eq(ratioValue('16:9', 800, 600), 16 / 9, '16:9');
      assert.eq(ratioValue('21:9', 800, 600), 21 / 9, '21:9');
      assert.eq(ratioValue('original', 800, 600), 800 / 600, '原图比例');
      assert.eq(ratioValue('original', 0, 0), null, '没有原图时原图比例是 null');
      assert.eq(ratioValue('nope', 800, 600), null, '不存在的预设没有比例');

      /* ---- 按比例算另一边 ---- */

      assert.eq(dimensionFor(4 / 3, 1000, 'width'), 750, '按宽算高：1000 × 3/4');
      assert.eq(dimensionFor(4 / 3, 400, 'height'), 533, '按高算宽：400 × 4/3');
      assert.eq(dimensionFor(1, 640, 'width'), 640, '1:1 时宽高相等');
      assert.eq(dimensionFor(0, 640, 'width'), null, '比例是 0 不行');
      assert.eq(dimensionFor(4 / 3, 0, 'width'), null, '基准是 0 不行');
      assert.eq(dimensionFor(4 / 3, -10, 'width'), null, '基准是负数不行');

      /* ---- 百分比 ---- */

      assert.eq(percentOf(800, 4000), 20, '目标是原图的 20%');
      assert.eq(percentOf(4000, 4000), 100, '一样大就是 100%');
      assert.eq(percentOf(100, 0), null, '没有原图算不出百分比');
      assert.eq(sizeFromPercent(4000, 3000, 50), { width: 2000, height: 1500 }, '50% 两边都减半');
      assert.eq(sizeFromPercent(4000, 3000, 0.01), { width: 1, height: 1 }, '缩到 0 也不许小于 1 像素');

      /* ---- 画布上限 ---- */

      assert.eq(canvasLimit(1920, 1080).ok, true, '常见尺寸没问题');
      assert.eq(canvasLimit(32767, 100).ok, true, '刚好到上限没问题');
      assert.eq(canvasLimit(32768, 100).ok, false, '单边超过上限不行');
      assert.eq(canvasLimit(32768, 100).reason, 'side', '超边的原因');
      assert.eq(canvasLimit(20000, 20000).ok, false, '面积超了不行');
      assert.eq(canvasLimit(20000, 20000).reason, 'area', '超面积的原因');
      assert.eq(canvasLimit(0, 100).ok, false, '尺寸是 0 不行');
      assert.eq(canvasLimit(0, 100).reason, 'size', '尺寸不对的原因');

      /* ---- 放大倍数 ---- */

      assert.eq(upscaleFactor(800, 600, 4000, 3000), 0.2, '缩小了不算放大');
      assert.eq(upscaleFactor(8000, 6000, 4000, 3000), 2, '放大两倍');
      assert.eq(upscaleFactor(4000, 6000, 4000, 3000), 2, '只看最大的那个方向');

      /* ---- 变形判定 ---- */

      assert.eq(isDistorted(400, 300, 4000, 3000), false, '同比例不算变形');
      assert.eq(isDistorted(400, 301, 4000, 3000), false, '取整的零头不算变形');
      assert.eq(isDistorted(400, 400, 4000, 3000), true, '比例不一样算变形');
      assert.eq(isDistorted(800, 600, 4000, 3000), false, '等比缩小不算变形');
    }
  };
}());
