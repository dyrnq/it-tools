/* ==========================================================================
   证件照标准尺寸（id-photo-resizer）

   报名、签证、简历、驾考都要一张固定尺寸的证件照：一寸 295 × 413、
   二寸 413 × 579、签证方照 600 × 600…… 尺寸都是按 300 DPI 折算的。
   现在这些尺寸只能拿别的工具一点点凑 —— 凑出来的往往不是「中心裁切」，
   也不是用户想要的那张脸。

   这个工具反过来做：挑一个标准尺寸（或者自己填宽高），挑一种裁法，
   再用两根滑块调画面里留下哪一块，然后导出**精确**的那个像素尺寸。

   两种裁法：

   - 「裁剪填满」（fill）—— 先在原图里切一块目标比例的最大矩形，
     再缩放到目标像素。照片会被切掉一部分，切到哪儿由两根滑块决定。
   - 「留白加白边」（contain）—— 整张图按比例缩进去，
     上下或左右补白边，一张都不丢。

   两根滑块分别是水平方向和垂直方向的偏移：
   滑块 -100 贴左边（/上边），+100 贴右边（/下边），0 是居中。
   原图在某个方向上没有富余（比例正好），那个方向就没有可挪动的空间 ——
   这时滑块是禁用的，界面上也说明一句，不能让用户拖一根没用的滑块。

   三条不能省的实话：

   - 原图比目标尺寸小的时候只能放大 —— 放大的图是插值出来的，
     并不会多出细节，说清楚比装作没这回事好。
   - 浏览器不支持某个格式的编码时，toBlob 会按规范悄悄退回 PNG，
     查 blob.type 把这件事讲明白。
   - 动图只剩第一帧（canvas 只画第一帧）。

   图片一个字节都不出浏览器：解码、裁剪、缩放、编码全在本地完成。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('id-photo-resizer');

  /**
   * 尺寸预设（300 DPI 折算的像素）。
   *
   * 名字走 t()（每种语言的说法不一样），像素是数字，不译。
   * custom 的宽高由用户自己填，表里留 0。
   */
  var PRESET_SIZES = [
    { id: 'one_inch', width: 295, height: 413 },
    { id: 'small_one_inch', width: 260, height: 378 },
    { id: 'large_one_inch', width: 390, height: 567 },
    { id: 'two_inch', width: 413, height: 579 },
    { id: 'small_two_inch', width: 413, height: 531 },
    { id: 'visa_square', width: 600, height: 600 },
    { id: 'custom', width: 0, height: 0 }
  ];

  /** 编码防抖的毫秒 —— 拖滑块的时候不用每帧都编码一次。 */
  var ENCODE_DEBOUNCE_MS = 150;

  /** 裁剪方式。 */
  var MODE_FILL = 'fill';
  var MODE_CONTAIN = 'contain';

  var S = {
    title: t('title', 'Resize a photo to an ID photo size'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.'),
    settings_title: t('settings_title', 'ID photo settings'),
    label_preset: t('label_preset', 'Size'),
    preset_one_inch: t('preset_one_inch', 'One inch'),
    preset_small_one_inch: t('preset_small_one_inch', 'Small one inch'),
    preset_large_one_inch: t('preset_large_one_inch', 'Large one inch'),
    preset_two_inch: t('preset_two_inch', 'Two inch'),
    preset_small_two_inch: t('preset_small_two_inch', 'Small two inch'),
    preset_visa_square: t('preset_visa_square', 'Square (visa)'),
    preset_custom: t('preset_custom', 'Custom'),
    label_width: t('label_width', 'Width'),
    label_height: t('label_height', 'Height'),
    label_mode: t('label_mode', 'Crop'),
    mode_fill: t('mode_fill', 'Crop to fill'),
    mode_contain: t('mode_contain', 'Fit with a white border'),
    label_offset_x: t('label_offset_x', 'Horizontal position'),
    label_offset_y: t('label_offset_y', 'Vertical position'),
    hint_offset: t('hint_offset', 'The picture is cut to the target size. Use the sliders to choose which part is kept: left and top are −100, right and bottom are +100.'),
    hint_no_slack: t('hint_no_slack', 'This picture has no room to move on this axis, so the slider is disabled.'),
    label_format: t('label_format', 'Output format'),
    label_quality: t('label_quality', 'Quality'),
    hint_quality: t('hint_quality', 'PNG is lossless — the quality setting does not change it.'),
    preview_title: t('preview_title', 'Preview'),
    result_title: t('result_title', 'Result'),
    label_item: t('label_item', 'Item'),
    label_value: t('label_value', 'Value'),
    label_source_size: t('label_source_size', 'Original size'),
    label_output_size: t('label_output_size', 'Output size'),
    label_crop_size: t('label_crop_size', 'Cropped area'),
    label_crop_pos: t('label_crop_pos', 'Crop position'),
    label_whole: t('label_whole', 'the whole picture'),
    label_file_size: t('label_file_size', 'File size'),
    label_output_format: t('label_output_format', 'Saved as'),
    no_result: t('no_result', 'No image yet.'),
    download: t('download', 'Download the ID photo'),
    status_reading: t('status_reading', 'Reading the file…'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_size: t('err_size', 'Enter a width and a height bigger than zero.'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    warn_upscale: t('warn_upscale', 'The picture is smaller than {width} × {height}, so it was enlarged and may look blurry.'),
    warn_fallback: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.'),
    link_compress: t('link_compress', 'Need a smaller file? Compress it to a target size.')
  };

  /* ---------- 纯逻辑（给 harness 用，也在下面被界面用） ---------- */

  /**
   * 按 id 找预设。
   * @param {string} id
   * @returns {object|null}
   */
  function presetById(id) {
    for (var i = 0; i < PRESET_SIZES.length; i++) {
      if (PRESET_SIZES[i].id === id) return PRESET_SIZES[i];
    }
    return null;
  }

  /**
   * 原图里那块「目标比例」的最大矩形。
   *
   * 原图比目标比例宽 → 满高、裁宽；比目标比例窄 → 满宽、裁高。
   * 这样切出来的块一定是目标比例，缩到目标尺寸时不会被拉变形。
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
   * 滑块位置 → 相对居中的偏移量。
   *
   * 滑块是 -100 ~ +100：-100 贴左（上），0 居中，+100 贴右（下）。
   * 返回的是**相对居中**的偏移（可以是负数），夹紧交给调用方。
   *
   * @param {number} slider -100 ~ 100
   * @param {number} free 这一轴上可挪动的像素数
   * @returns {number}
   */
  function offsetPixels(slider, free) {
    var s = Number(slider);
    if (!isFinite(s)) s = 0;
    if (s > 100) s = 100;
    if (s < -100) s = -100;
    var f = Number(free);
    if (!isFinite(f) || f <= 0) return 0;
    return (f / 2) * (s / 100);
  }

  /**
   * 裁剪方案：原图里切哪一块。
   *
   * @param {number} sourceW
   * * @param {number} sourceH
   * * @param {number} targetW
   * * @param {number} targetH
   * * @param {number} sliderX 水平滑块 -100 ~ 100
   * * @param {number} sliderY 垂直滑块 -100 ~ 100
   * @returns {{sx: number, sy: number, sw: number, sh: number, freeX: number, freeY: number}}
   */
  function cropPlan(sourceW, sourceH, targetW, targetH, sliderX, sliderY) {
    var rect = cropRect(sourceW, sourceH, targetW, targetH);
    var srcW = Math.max(1, Math.round(Number(sourceW) || 0));
    var srcH = Math.max(1, Math.round(Number(sourceH) || 0));
    var freeX = Math.max(0, srcW - rect.sw);
    var freeY = Math.max(0, srcH - rect.sh);
    var sx = Math.round(Math.max(0, Math.min(freeX, freeX / 2 + offsetPixels(sliderX, freeX))));
    var sy = Math.round(Math.max(0, Math.min(freeY, freeY / 2 + offsetPixels(sliderY, freeY))));
    return {
      sx: sx, sy: sy, sw: rect.sw, sh: rect.sh,
      freeX: freeX, freeY: freeY
    };
  }

  /**
   * 留白方案：整张图缩进去以后摆在哪儿。
   *
   * @param {number} sourceW
   * @param {number} sourceH
   * @param {number} targetW
   * @param {number} targetH
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  function containPlan(sourceW, sourceH, targetW, targetH) {
    var sw = Math.max(1, Math.round(Number(sourceW) || 0));
    var sh = Math.max(1, Math.round(Number(sourceH) || 0));
    var tw = Math.max(1, Math.round(Number(targetW) || 0));
    var th = Math.max(1, Math.round(Number(targetH) || 0));
    var scale = Math.min(tw / sw, th / sh);
    var w = Math.max(1, Math.round(sw * scale));
    var h = Math.max(1, Math.round(sh * scale));
    return {
      x: Math.round((tw - w) / 2),
      y: Math.round((th - h) / 2),
      width: w,
      height: h
    };
  }

  /**
   * 目标尺寸 —— 预设就查表，自定义就取用户填的值。
   *
   * @param {string} presetId
   * @param {*} customWidth
   * @param {*} customHeight
   * @returns {{width: number, height: number}|null} 填得不对就 null
   */
  function targetSize(presetId, customWidth, customHeight) {
    if (presetId === 'custom') {
      var w = parseInt(String(customWidth), 10);
      var h = parseInt(String(customHeight), 10);
      if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
      return { width: w, height: h };
    }
    var preset = presetById(presetId);
    if (!preset || preset.width <= 0 || preset.height <= 0) return null;
    return { width: preset.width, height: preset.height };
  }

  window.ItTools.register('id-photo-resizer', function (root) {
    var disposed = false;
    var state = {
      name: '',
      size: 0,
      sourceFormat: '',
      /** 动图的帧数；静态图是 null。 */
      animation: null,
      file: null,
      decoded: null,
      width: 0,
      height: 0,
      presetId: 'one_inch',
      customWidth: '295',
      customHeight: '413',
      mode: MODE_FILL,
      offsetX: 0,
      offsetY: 0,
      formatId: 'jpeg',
      quality: 90,
      result: null,
      /** 结果图的 object URL。 */
      resultUrl: ''
    };
    /** 编码的序号。慢的那次算完了不许盖掉快的那次的结果。 */
    var ticket = 0;
    /** 编码防抖的计时器。 */
    var encodeTimer = null;

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

    var presetSelect = D.h('select.layui-select');
    PRESET_SIZES.forEach(function (preset) {
      var label = S['preset_' + preset.id] || preset.id;
      // 预设的名字后面缀上像素尺寸 —— 数字不用译。
      var text = preset.width > 0 ? label + ' — ' + preset.width + ' × ' + preset.height : label;
      presetSelect.appendChild(D.h('option', { value: preset.id, text: text }));
    });

    var widthInput = D.h('input.layui-input', {
      type: 'number', min: 1, step: 1, value: state.customWidth
    });
    var heightInput = D.h('input.layui-input', {
      type: 'number', min: 1, step: 1, value: state.customHeight
    });
    var widthField = U.field(S.label_width, widthInput);
    var heightField = U.field(S.label_height, heightInput);
    // 自定义宽高只有选了「自定义」才用得上 —— 默认先藏起来
    widthField.hidden = true;
    heightField.hidden = true;

    var modeSelect = D.h('select.layui-select', null,
      D.h('option', { value: MODE_FILL, text: S.mode_fill }),
      D.h('option', { value: MODE_CONTAIN, text: S.mode_contain })
    );

    var offsetXInput = D.h('input.slider', { type: 'range', min: -100, max: 100, step: 1, value: 0 });
    var offsetYInput = D.h('input.slider', { type: 'range', min: -100, max: 100, step: 1, value: 0 });
    var offsetXField = U.field(S.label_offset_x, offsetXInput);
    var offsetYField = U.field(S.label_offset_y, offsetYInput);

    var formatSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'jpeg', text: 'JPEG' }),
      D.h('option', { value: 'png', text: 'PNG' }),
      D.h('option', { value: 'webp', text: 'WebP' })
    );
    var qualityInput = D.h('input.slider', { type: 'range', min: 1, max: 100, step: 1, value: state.quality });

    var slackHint = D.h('p.field-hint');
    var qualityHint = D.h('p.field-hint');
    // 状态行用 .form-status —— app.css 只给 .form-status.is-error 配了红色，
    // .field-hint.is-error 没有任何规则（错误提示会一直是灰的）。
    var statusLine = D.h('p.form-status');

    settingsCard.appendChild(D.h('h3', { text: S.settings_title }));
    settingsCard.appendChild(U.field(S.label_preset, presetSelect));
    settingsCard.appendChild(widthField);
    settingsCard.appendChild(heightField);
    settingsCard.appendChild(U.field(S.label_mode, modeSelect));
    settingsCard.appendChild(D.h('p.field-hint', { text: S.hint_offset }));
    settingsCard.appendChild(offsetXField);
    settingsCard.appendChild(offsetYField);
    settingsCard.appendChild(slackHint);
    settingsCard.appendChild(U.field(S.label_format, formatSelect));
    settingsCard.appendChild(U.field(S.label_quality, qualityInput));
    settingsCard.appendChild(qualityHint);
    settingsCard.appendChild(statusLine);
    settingsCard.appendChild(D.h('p.field-hint', null,
      D.h('a', { href: '/image-compress-to-size', text: S.link_compress })
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
        { label: S.label_output_size, value: r.width + ' × ' + r.height }
      ];
      if (r.mode === MODE_CONTAIN) {
        rows.push({
          label: S.label_crop_size,
          value: state.width + ' × ' + state.height + ' (' + S.label_whole + ')'
        });
      } else {
        rows.push({ label: S.label_crop_size, value: r.sw + ' × ' + r.sh });
        rows.push({ label: S.label_crop_pos, value: r.sx + ', ' + r.sy });
      }
      rows.push({ label: S.label_file_size, value: C.formatBytes(r.bytes) });
      rows.push({ label: S.label_output_format, value: format.label });

      resultBody.appendChild(kvTable(rows));

      // 原图比目标尺寸小 —— 只能放大，放大了会发糊，得说出来
      if (r.upscaled) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: S.warn_upscale
              .replace('{width}', String(r.width))
              .replace('{height}', String(r.height))
          })
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

    /* ---------- 裁剪与预览 ---------- */

    /**
     * 现在的裁剪方案。留白模式下没有裁剪，给的是整张图缩进去的位置。
     */
    function currentPlan() {
      var size = targetSize(state.presetId, state.customWidth, state.customHeight);
      if (!size) return null;
      if (state.mode === MODE_CONTAIN) {
        var fit = containPlan(state.width, state.height, size.width, size.height);
        return {
          mode: MODE_CONTAIN,
          size: size,
          x: fit.x, y: fit.y, w: fit.width, h: fit.height,
          sw: state.width, sh: state.height, sx: 0, sy: 0,
          freeX: 0, freeY: 0,
          upscaled: state.width < size.width || state.height < size.height
        };
      }
      var plan = cropPlan(state.width, state.height, size.width, size.height, state.offsetX, state.offsetY);
      return {
        mode: MODE_FILL,
        size: size,
        sx: plan.sx, sy: plan.sy, sw: plan.sw, sh: plan.sh,
        x: 0, y: 0, w: size.width, h: size.height,
        freeX: plan.freeX, freeY: plan.freeY,
        upscaled: state.width < size.width || state.height < size.height
      };
    }

    /**
     * 把方案画到一张 tw × th 的画布上。
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} plan
     * @param {number} tw
     * @param {number} th
     */
    function paint(ctx, plan, tw, th) {
      ctx.clearRect(0, 0, tw, th);
      if (plan.mode === MODE_CONTAIN) {
        // 留白模式：先把底铺白，再把整张图缩进去摆在中间
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, tw, th);
        ctx.drawImage(state.decoded.source, 0, 0, state.width, state.height,
          plan.x, plan.y, plan.w, plan.h);
        return;
      }
      // 裁剪填满：先切一块目标比例的，再铺满整张目标画布
      ctx.drawImage(state.decoded.source, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, tw, th);
    }

    /** 重画预览（同步，不等编码）。 */
    function redrawPreview() {
      var plan = currentPlan();
      if (!plan || !state.decoded) return null;

      var tw = plan.size.width;
      var th = plan.size.height;
      if (previewCanvas.width !== tw || previewCanvas.height !== th) {
        previewCanvas.width = tw;
        previewCanvas.height = th;
      }
      var ctx = previewCanvas.getContext('2d');
      if (ctx) paint(ctx, plan, tw, th);
      previewSize.textContent = tw + ' × ' + th;

      // 某个方向上没有富余就没有可挪动的空间 —— 滑块禁掉，说明一句
      var noSlack = [];
      if (plan.mode === MODE_FILL) {
        if (plan.freeX === 0) noSlack.push(S.label_offset_x);
        if (plan.freeY === 0) noSlack.push(S.label_offset_y);
      }
      offsetXInput.disabled = plan.mode !== MODE_FILL || plan.freeX === 0;
      offsetYInput.disabled = plan.mode !== MODE_FILL || plan.freeY === 0;
      slackHint.textContent = noSlack.length
        ? S.hint_no_slack + ' (' + noSlack.join(', ') + ')'
        : '';

      return plan;
    }

    /* ---------- 编码 ---------- */

    /**
     * 按当前设置编码一次。
     *
     * 裁好的结果先画到一张临时的 canvas 上，再交给共用的图片内核去编码 ——
     * 格式回退检测（浏览器悄悄退回 PNG）、JPEG 的白底铺底都在那边，
     * 这里不重写一遍。
     *
     * @param {object} plan
     * @param {function(): boolean} isCurrent 竞态闸门
     * @returns {Promise<void>}
     */
    function encodeNow(plan, isCurrent) {
      var tw = plan.size.width;
      var th = plan.size.height;

      var work = document.createElement('canvas');
      work.width = tw;
      work.height = th;
      var ctx = work.getContext('2d');
      if (!ctx) {
        setStatus(S.err_encode.replace('{reason}', 'canvas'), true);
        renderResult();
        return Promise.resolve();
      }
      paint(ctx, plan, tw, th);

      return C.encode({ source: work, width: tw, height: th }, {
        width: tw,
        height: th,
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
          mode: plan.mode,
          sw: plan.sw, sh: plan.sh, sx: plan.sx, sy: plan.sy,
          upscaled: plan.upscaled,
          formatId: out.formatId,
          requestedFormatId: out.requestedFormatId
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
      var plan = redrawPreview();
      if (!plan) {
        state.result = null;
        setStatus(S.err_size, true);
        renderResult();
        return;
      }
      if (encodeTimer) {
        clearTimeout(encodeTimer);
        encodeTimer = null;
      }
      var mine = ++ticket;
      var isCurrent = function () { return !disposed && mine === ticket; };
      encodeTimer = setTimeout(function () {
        encodeTimer = null;
        encodeNow(plan, isCurrent);
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
          if (disposed) return;

          state.name = file.name || 'image';
          state.size = file.size || bytes.length;
          state.sourceFormat = format || '';
          state.animation = C.animationInfo(bytes);
          state.file = file;
          state.decoded = decoded;
          state.width = decoded.width;
          state.height = decoded.height;

          upload.setStatus('');
          settingsCard.hidden = false;
          previewCard.hidden = false;
          resultCard.hidden = false;
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

    presetSelect.addEventListener('change', function () {
      state.presetId = presetSelect.value;
      // 自定义宽高只有选了「自定义」才用得上
      var custom = state.presetId === 'custom';
      widthField.hidden = !custom;
      heightField.hidden = !custom;
      refresh();
    });

    widthInput.addEventListener('input', function () {
      state.customWidth = widthInput.value;
      refresh();
    });
    heightInput.addEventListener('input', function () {
      state.customHeight = heightInput.value;
      refresh();
    });

    modeSelect.addEventListener('change', function () {
      state.mode = modeSelect.value;
      refresh();
    });

    /** 拖滑块 → 立刻重画预览，编码防抖。 */
    function onOffset() {
      state.offsetX = Number(offsetXInput.value) || 0;
      state.offsetY = Number(offsetYInput.value) || 0;
      refresh();
    }
    offsetXInput.addEventListener('input', onOffset);
    offsetYInput.addEventListener('input', onOffset);

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

  window.ItTools.logic['id-photo-resizer'] = {
    PRESET_SIZES: PRESET_SIZES,
    presetById: presetById,
    cropRect: cropRect,
    offsetPixels: offsetPixels,
    cropPlan: cropPlan,
    containPlan: containPlan,
    targetSize: targetSize,

    __cases: function (assert) {
      /* ---- 预设表 ---- */

      assert.eq(PRESET_SIZES.length, 7, '六个标准尺寸加一个自定义');
      assert.eq(presetById('one_inch'), { id: 'one_inch', width: 295, height: 413 }, '一寸 295 × 413');
      assert.eq(presetById('small_one_inch').width, 260, '小一寸宽 260');
      assert.eq(presetById('small_one_inch').height, 378, '小一寸高 378');
      assert.eq(presetById('large_one_inch').width, 390, '大一寸宽 390');
      assert.eq(presetById('large_one_inch').height, 567, '大一寸高 567');
      assert.eq(presetById('two_inch').width, 413, '二寸宽 413');
      assert.eq(presetById('two_inch').height, 579, '二寸高 579');
      assert.eq(presetById('small_two_inch').height, 531, '小二寸高 531');
      assert.eq(presetById('visa_square'), { id: 'visa_square', width: 600, height: 600 }, '签证方照 600 × 600');
      assert.eq(presetById('custom').width, 0, '自定义没有固定宽高');
      assert.eq(presetById('nope'), null, '不存在的预设是 null');

      /* ---- 目标尺寸 ---- */

      assert.eq(targetSize('one_inch', '', ''), { width: 295, height: 413 }, '预设取表里的尺寸');
      assert.eq(targetSize('custom', '800', '600'), { width: 800, height: 600 }, '自定义取用户填的');
      assert.eq(targetSize('custom', '0', '600'), null, '宽是 0 不行');
      assert.eq(targetSize('custom', '800', '-1'), null, '高是负数不行');
      assert.eq(targetSize('custom', '', ''), null, '没填不行');
      assert.eq(targetSize('custom', 'abc', '600'), null, '填的不是数字不行');
      assert.eq(targetSize('nope', '', ''), null, '不存在的预设没有尺寸');

      /* ---- 裁剪块 ---- */

      assert.eq(cropRect(1200, 1600, 295, 413), { sw: 1143, sh: 1600 }, '原图更宽 → 满高裁宽');
      assert.eq(cropRect(1600, 1200, 295, 413), { sw: 857, sh: 1200 }, '横图进竖版 → 还是满高裁宽');
      assert.eq(cropRect(600, 1200, 295, 413), { sw: 600, sh: 840 }, '原图更窄 → 满宽裁高');
      assert.eq(cropRect(295, 413, 295, 413), { sw: 295, sh: 413 }, '比例正好 → 原样');
      assert.eq(cropRect(100, 100, 600, 600), { sw: 100, sh: 100 }, '比目标小 → 取整也不许超出原图');
      assert.eq(cropRect(1000, 1000, 1, 3), { sw: 333, sh: 1000 }, '极端比例：满高、裁到三分之一宽');

      /* ---- 偏移 ---- */

      assert.eq(offsetPixels(0, 100), 0, '滑块在中间 → 没有偏移');
      assert.eq(offsetPixels(-100, 100), -50, '滑块拉到最左 → 偏移半个富余量');
      assert.eq(offsetPixels(100, 100), 50, '滑块拉到最右 → 偏移半个富余量');
      assert.eq(offsetPixels(50, 100), 25, '滑块在中间偏右一点');
      assert.eq(offsetPixels(0, 0), 0, '没有富余就没有偏移');
      assert.eq(offsetPixels(-500, 100), -50, '超范围的滑块夹到边上');
      assert.eq(offsetPixels(500, 100), 50, '超范围的滑块夹到边上');

      /* ---- 裁剪方案 ---- */

      var plan = cropPlan(1200, 1600, 295, 413, 0, 0);
      assert.eq(plan.sw, 1143, '裁剪块的宽');
      assert.eq(plan.sh, 1600, '裁剪块的高');
      assert.eq(plan.freeX, 57, '水平方向富余 57 像素');
      assert.eq(plan.freeY, 0, '垂直方向没有富余');
      assert.eq(plan.sx, 29, '居中时左边留 29');
      assert.eq(plan.sy, 0, '垂直方向没有富余 → 贴上边');

      var left = cropPlan(1200, 1600, 295, 413, -100, 0);
      assert.eq(left.sx, 0, '滑块拉到底 → 贴左边');
      var right = cropPlan(1200, 1600, 295, 413, 100, 0);
      assert.eq(right.sx, 57, '滑块拉到底 → 贴右边');

      var square = cropPlan(1000, 1000, 500, 500, 0, 0);
      assert.eq(square.freeX, 0, '正方形切正方形没有富余');
      assert.eq(square.sx, 0, '没有富余 → 起点就是 0');

      /* ---- 留白 ---- */

      var fit = containPlan(1200, 1600, 295, 413);
      assert.eq(fit.width, 295, '留白模式：宽度铺满');
      assert.eq(fit.height, 393, '留白模式：高度按比例');
      assert.eq(fit.x, 0, '宽度铺满 → 左边不补白');
      assert.eq(fit.y, 10, '上下各补一点');

      var fitSquare = containPlan(1000, 1000, 600, 600);
      assert.eq(fitSquare, { x: 0, y: 0, width: 600, height: 600 }, '正方形进正方形不留白');

      var fitWide = containPlan(1600, 1200, 295, 413);
      assert.eq(fitWide.width, 295, '宽图进竖版：宽度铺满');
      assert.eq(fitWide.height, 221, '宽图进竖版：高度按比例');
      assert.eq(fitWide.x, 0, '宽图进竖版：左右不补白');
      assert.eq(fitWide.y, 96, '宽图进竖版：上下补白');
    }
  };
}());
