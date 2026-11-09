/* ==========================================================================
   AVIF 转换（image-converter-avif）

   两个方向都能走：
     · 任意图片 → AVIF（用 @jsquash/avif 编码）
     · AVIF → JPEG / PNG / WebP（浏览器原生就能解 AVIF，再交给它编码）

   为什么要单独一个页面：AVIF 是下一代网页图片格式，
   「把图转成体积更小的 AVIF」是一件很具体的事 ——
   跟 JPEG 和 PNG 之间互转不是一回事。混在一个页面里，
   搜索引擎与用户都看不出这个页面是干什么的。

   图片一个字节都不出浏览器 —— 解码、编码全在本地完成。

   ---- 这一页为什么要带 wasm ----
   浏览器**会解码 AVIF，但不会编码它**（canvas.toBlob 遇到
   image/avif 会按规范悄悄退回 PNG）。所以编码方向必须自己带编码器：
   @jsquash/avif（Squoosh 官方那个），胶水脚本只有 42 KB，
   但它要用的 wasm 有 2.6 MB —— 那一块是**第一次转换时才拉**的，
   不是打开页面就拉。

   解码方向不用带 wasm：Chrome 85+ / Firefox 93+ / Safari 16.4+ 原生就能解
   AVIF，更老的浏览器解不出来，页面会明确报错。

   三个要老实说出来的限制：
   1. **编码很慢** —— 3 MP 的图默认档要两秒多，最快档也要半秒多，
      48 MP 的图要一分钟。编码跑在 Web Worker 里，页面全程还能用，
      但结果不会提前出来。
   2. **质量滑块要防抖** —— 拖一下就重编一次是没法用的。
   3. **速度档差很多** —— 最快档比默认档快三四倍，代价是画质差一点。

   界面是共用的（ItTools.imageCodec.converterView），这里只负责
   拼出自己的文案表、把界面调起来。共用界面的说明见 static/js/app.js。
   ========================================================================== */
(function () {
  'use strict';

  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-converter-avif');

  /** 默认的输出格式。这一页的主语就是 AVIF。 */
  var DEFAULT_FORMAT = 'avif';

  /**
   * 这一页能选的输出格式：AVIF 排第一（默认选中），
   * 后面跟着浏览器原生能编的三种 —— 从 AVIF 转出来的目标格式。
   */
  var FORMATS = [C.formatById('avif')].concat(C.FORMATS);

  /**
   * 速度档。值是 jsquash 的 speed（0~10，越小越慢越干净）。
   *
   * 实测 3 MP 的图：speed 10 要 0.6 秒，speed 6 要 2.2 秒 ——
   * 差三四倍，值得让用户自己选。
   */
  var SPEED_OPTIONS = [
    { value: 10, label: t('opt_fast', 'Fast') },
    { value: 6, label: t('opt_standard', 'Standard') },
    { value: 4, label: t('opt_fine', 'Fine') }
  ];

  /** 质量滑块的防抖毫秒数。wasm 编码一次要两秒多，拖一下就重编是不能忍的。 */
  var DEBOUNCE_MS = 400;

  /** 这个工具的文案表。 */
  var S = {
    title: t('title', 'Convert to AVIF'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.'),
    settings_title: t('settings_title', 'Conversion settings'),
    result_title: t('result_title', 'Result'),
    label_format: t('label_format', 'Target format'),
    label_quality: t('label_quality', 'Quality ({n})'),
    label_background: t('label_background', 'Background colour'),
    label_item: t('label_item', 'Item'),
    label_value: t('label_value', 'Value'),
    label_source_format: t('label_source_format', 'Original format'),
    label_target_format: t('label_target_format', 'Saved as'),
    label_before: t('label_before', 'Size before'),
    label_after: t('label_after', 'Size after'),
    label_dimensions: t('label_dimensions', 'Dimensions'),
    label_unknown: t('label_unknown', 'unknown'),
    preview_before: t('preview_before', 'Before'),
    preview_after: t('preview_after', 'After'),
    no_result: t('no_result', 'No image yet.'),
    download: t('download', 'Download the converted image'),
    status_reading: t('status_reading', 'Reading the file…'),
    status_encoding: t('status_encoding', 'Encoding…'),
    status_downloading: t('status_downloading', 'Downloading the AVIF encoder…'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image. AVIF decoding needs a recent browser (Chrome 85+, Firefox 93+, Safari 16.4+).'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    hint_quality: t('hint_quality', 'Lower quality means a smaller file and more visible artefacts.'),
    hint_lossless: t('hint_lossless', 'PNG is lossless — the quality setting does not apply to it.'),
    hint_background: t('hint_background', 'JPEG has no transparency, so transparent areas are filled with this colour.'),
    hint_same_format: t('hint_same_format', 'The target format is the same as the original — pick another one to really convert it.'),
    hint_formats: t('hint_formats', 'AVIF is encoded by the bundled encoder; JPEG, PNG and WebP are produced by the browser itself.'),
    hint_not_previewable: t('hint_not_previewable', 'This format cannot be previewed in the browser.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.'),
    warn_too_large: t('warn_too_large', 'This image is too large for the browser at that size, so it was scaled down to {width} × {height}.'),
    warn_fallback: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.'),

    /* ---- 这一页特有的 ---- */
    label_speed: t('label_speed', 'Speed'),
    opt_fast: t('opt_fast', 'Fast'),
    opt_standard: t('opt_standard', 'Standard'),
    opt_fine: t('opt_fine', 'Fine'),
    hint_lib: t('hint_lib', 'The first conversion to AVIF downloads the encoder (about 2.6 MB). It runs entirely in your browser.')
  };

  window.ItTools.register('image-converter-avif', function (root) {
    return C.converterView({
      root: root,
      s: S,
      formats: FORMATS,
      defaultFormat: DEFAULT_FORMAT,
      accept: 'image/*,.avif',
      speed: { label: S.label_speed, options: SPEED_OPTIONS },
      extraHints: [S.hint_lib],
      debounce: DEBOUNCE_MS
    });
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['image-converter-avif'] = {
    __cases: function (assert) {
      /* ---- AVIF 这个格式本身的性质 ---- */

      var avif = C.formatById('avif');
      assert.eq(avif.encoder, 'avif', 'AVIF 走 jsquash 编码');
      assert.eq(avif.qualityAdjustable, true, 'AVIF 能调质量');
      assert.eq(avif.speedAdjustable, true, 'AVIF 有速度档');
      assert.eq(avif.previewable, true, '浏览器预览得了 AVIF');
      assert.eq(avif.alpha, true, 'AVIF 有 alpha 通道');
      assert.eq(avif.ext, 'avif', 'AVIF 的扩展名');

      assert.eq(C.qualityApplies('avif'), true, 'AVIF 认质量');
      assert.eq(C.backgroundApplies('avif'), false, 'AVIF 有 alpha 通道，不用铺背景');

      /* ---- 质量 → cqLevel 的映射 ----
         cqLevel 是 0~63 且**0 最好**，界面上的质量是 1~100 且越大越好 ——
         映射反了的话滑块就是反的，这一段最该盯住。 */
      assert.eq(C.avifCqLevel(100), 0, '质量 100 → cqLevel 0（最好）');
      assert.eq(C.avifCqLevel(1), 63, '质量 1 → cqLevel 63（最差）');
      assert.eq(C.avifCqLevel(50), 32, '质量 50 → cqLevel 32');

      /* ---- 编码器的选项结构体：一个字段都不能少 ---- */
      var opts = C.avifOptions(90, 6);
      assert.eq(Object.keys(opts).sort().join(','),
        'chromaDeltaQ,cqAlphaLevel,cqLevel,denoiseLevel,sharpness,speed,subsample,tileColsLog2,tileRowsLog2,tune',
        'embind 的选项字段一个都不能少');
      assert.eq(opts.cqAlphaLevel, -1, 'cqAlphaLevel 跟着 cqLevel 走');
      assert.eq(opts.speed, 6, '速度档原样传下去');

      /* ---- 速度档要夹在 0~10 ---- */
      assert.eq(C.clampSpeed(20), 10, '超过 10 的夹到 10');
      assert.eq(C.clampSpeed(-3), 0, '小于 0 的夹到 0');
      assert.eq(C.clampSpeed('7'), 7, '字符串也认');
      assert.eq(C.clampSpeed('abc'), 6, '不认识的用默认档');

      /* ---- 认格式 ---- */
      var avifBytes = new Uint8Array(16);
      avifBytes[3] = 16;
      avifBytes[4] = 0x66; avifBytes[5] = 0x74; avifBytes[6] = 0x79; avifBytes[7] = 0x70;
      avifBytes[8] = 0x61; avifBytes[9] = 0x76; avifBytes[10] = 0x69; avifBytes[11] = 0x66;
      assert.eq(C.detectFormat(avifBytes), 'avif', 'ftyp+avif 认成 AVIF');

      // 动图（GIF）帧数还是要读出来 —— 换格式只剩第一帧，得说清楚
      var gif = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
                 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
                 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
                 0x02, 0x02, 0x44, 0x01, 0x00,
                 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
                 0x02, 0x02, 0x44, 0x01, 0x00,
                 0x3B];
      assert.eq(C.animationInfo(new Uint8Array(gif)), { frames: 2, animated: true }, '两帧的 GIF 是动图');

      /* ---- 编码到哪一步了：界面上那一行字 ----
         拉那 2.6 MB 的编码器和真正编码是两件事。
         混成一句「正在编码中」的话，头几秒用户会以为卡住了。 */

      assert.eq(C.busyText(S, 'loading'), S.status_downloading, '在拉编码器时显示「正在下载」');
      assert.eq(C.busyText(S, 'encoding'), S.status_encoding, '在编码时显示「正在编码」');
      // 没配「下载」那句话的页面（普通转换页）退回「正在编码」
      assert.eq(C.busyText({ status_encoding: 'E' }, 'loading'), 'E', '没有下载那句话就退回「正在编码」');

      /* ---- 下载进度条：百分比 ----
         那 2.6 MB 的编码器是第一次转换时才拉的，页面上画一条进度条。
         百分比算错了进度条就是骗人的 —— 这几行钉住它。 */

      assert.eq(C.progressPercent(0, 100), 0, '刚开始是 0%');
      assert.eq(C.progressPercent(50, 100), 50, '下了一半是 50%');
      assert.eq(C.progressPercent(100, 100), 100, '下完了是 100%');
      assert.eq(C.progressPercent(1, 3), 33, '不满一格的往下取整');
      assert.eq(C.progressPercent(7, 3), 100, '超了也不许超过 100');
      assert.eq(C.progressPercent(10, 0), null, '不知道总量就没有百分比');
      assert.eq(C.progressPercent(undefined, undefined), null, '什么都没有也是 null');

      /* ---- 交给 worker 的字节能不能整体转移 ----
         转移比拷贝省一大截时间：48 MP 的 RGBA 有 192 MB。 */

      var whole = new Uint8Array([1, 2, 3, 4]);
      assert.eq(C.ownBuffer(whole), whole.buffer, '自己独占的 buffer 整体转移，不用拷');
      // 切出来的一段 —— 只能拷一份（拷的那份要正好是这一段）
      var part = whole.subarray(1, 3);
      var copied = new Uint8Array(C.ownBuffer(part));
      assert.eq(copied.length, 2, '切出来的一段长度要对');
      assert.eq(Array.from(copied), [2, 3], '切出来的一段内容要对');
      assert.eq(part.buffer.byteLength, 4, '原来的 buffer 没被动过');
    }
  };
})();
