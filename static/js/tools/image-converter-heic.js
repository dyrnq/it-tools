/* ==========================================================================
   HEIC 转换（image-converter-heic）

   两个方向都能走：
     · 任意图片 → HEIC（用 elheif 编码）
     · HEIC → JPEG / PNG / WebP（用 elheif 解码，再交给浏览器编码）

   为什么要单独一个页面：HEIC 是 iPhone 的默认照片格式，
   「把它转成能直接发微信 / 传网页的 JPEG」是一件很具体的事 ——
   跟 JPEG 和 PNG 之间互转不是一回事。混在一个页面里，
   搜索引擎与用户都看不出这个页面是干什么的。

   图片一个字节都不出浏览器 —— 解码、编码全在本地完成。

   ---- 这个工具绕不开 wasm ----
   浏览器**解码不了 HEIC，也编码不了 HEIC**（canvas.toBlob 遇到
   image/heic 会按规范悄悄退回 PNG）。所以这一页自带一个编解码器：
   elheif（libheif + libde265 + kvazaar），wasm 以 base64 内联在
   1.5 MB 的胶水脚本里，打开页面时就下载了。

   两个要老实说出来的限制：
   1. **HEIC 编码没有质量参数** —— kvazaar 的画质是固定的，
      界面上不给质量滑块，只给一句说明。
   2. **编码很慢** —— 3 MP 的图要一秒多。编码跑在 Web Worker 里，
      页面全程还能用；但 HEIC 浏览器显示不了，
      预览是把编码结果**解回来**画的。

   界面是共用的（ItTools.imageCodec.converterView），这里只负责
   拼出自己的文案表、把界面调起来。共用界面的说明见 static/js/app.js。
   ========================================================================== */
(function () {
  'use strict';

  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-converter-heic');

  /** 默认的输出格式。这一页的主语就是 HEIC。 */
  var DEFAULT_FORMAT = 'heic';

  /**
   * 这一页能选的输出格式：HEIC 排第一（默认选中），
   * 后面跟着浏览器原生能编的三种 —— 从 HEIC 转出来的目标格式。
   */
  var FORMATS = [C.formatById('heic')].concat(C.FORMATS);

  /** 这个工具的文案表。 */
  var S = {
    title: t('title', 'Convert to HEIC'),
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
    status_downloading: t('status_downloading', 'Downloading the HEIC codec…'),
    status_decoding: t('status_decoding', 'Decoding the HEIC file…'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image. HEIC files are decoded by the bundled codec.'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    hint_quality: t('hint_quality', 'Lower quality means a smaller file and more visible artefacts.'),
    hint_lossless: t('hint_lossless', 'PNG is lossless — the quality setting does not apply to it.'),
    hint_background: t('hint_background', 'JPEG has no transparency, so transparent areas are filled with this colour.'),
    hint_same_format: t('hint_same_format', 'The target format is the same as the original — pick another one to really convert it.'),
    hint_formats: t('hint_formats', 'HEIC is encoded by the bundled codec; JPEG, PNG and WebP are produced by the browser itself.'),
    hint_not_previewable: t('hint_not_previewable', 'This format cannot be previewed in the browser.'),
    hint_preview_decoded: t('hint_preview_decoded', 'Browsers cannot display HEIC directly — this preview was decoded with the bundled codec.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.'),
    warn_too_large: t('warn_too_large', 'This image is too large for the browser at that size, so it was scaled down to {width} × {height}.'),
    warn_fallback: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.'),

    /* ---- 这一页特有的 ---- */
    hint_no_quality: t('hint_no_quality', 'The HEIC encoder has no quality setting — its picture quality is fixed.'),
    hint_lib: t('hint_lib', 'Opening this page downloads the HEIC codec (about 1.5 MB). It runs entirely in your browser.')
  };

  window.ItTools.register('image-converter-heic', function (root) {
    return C.converterView({
      root: root,
      s: S,
      formats: FORMATS,
      defaultFormat: DEFAULT_FORMAT,
      accept: 'image/*,.heic,.heif',
      qualityNote: S.hint_no_quality,
      extraHints: [S.hint_lib]
    });
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['image-converter-heic'] = {
    __cases: function (assert) {
      /* ---- HEIC 这个格式本身的性质 ---- */

      var heic = C.formatById('heic');
      assert.eq(heic.encoder, 'elheif', 'HEIC 走 elheif 编解码');
      assert.eq(heic.qualityAdjustable, false, 'HEIC 编码器没有质量参数');
      assert.eq(heic.previewable, false, '浏览器预览不了 HEIC');
      assert.eq(heic.alpha, true, 'HEIC 有 alpha 通道');
      assert.eq(heic.ext, 'heic', 'HEIC 的扩展名');

      // 质量滑块对 HEIC 没有意义 —— 界面上要藏起来，不是置灰。
      assert.eq(C.qualityApplies('heic'), false, 'HEIC 不认质量');
      assert.eq(C.qualityApplies('jpeg'), true, 'JPEG 认质量');
      assert.eq(C.qualityApplies('png'), false, 'PNG 不认质量');
      assert.eq(C.backgroundApplies('heic'), false, 'HEIC 有 alpha 通道，不用铺背景');

      /* ---- 认格式：HEIC 是 ISOBMFF，品牌说了算 ---- */

      // ftyp + 'heic' → HEIC
      var heicBytes = new Uint8Array(16);
      heicBytes[3] = 16;
      heicBytes[4] = 0x66; heicBytes[5] = 0x74; heicBytes[6] = 0x79; heicBytes[7] = 0x70;
      heicBytes[8] = 0x68; heicBytes[9] = 0x65; heicBytes[10] = 0x69; heicBytes[11] = 0x63;
      assert.eq(C.detectFormat(heicBytes), 'heic', 'ftyp+heic 认成 HEIC');

      // 同一个盒子，牌子不一样就是别的东西
      var avifBytes = new Uint8Array(16);
      avifBytes[3] = 16;
      avifBytes[4] = 0x66; avifBytes[5] = 0x74; avifBytes[6] = 0x79; avifBytes[7] = 0x70;
      avifBytes[8] = 0x61; avifBytes[9] = 0x76; avifBytes[10] = 0x69; avifBytes[11] = 0x66;
      assert.eq(C.detectFormat(avifBytes), 'avif', 'ftyp+avif 认成 AVIF');

      // mif1 是通用 HEIF 品牌 —— 一律按 HEIC 解
      var mif1Bytes = new Uint8Array(16);
      mif1Bytes[3] = 16;
      mif1Bytes[4] = 0x66; mif1Bytes[5] = 0x74; mif1Bytes[6] = 0x79; mif1Bytes[7] = 0x70;
      mif1Bytes[8] = 0x6D; mif1Bytes[9] = 0x69; mif1Bytes[10] = 0x66; mif1Bytes[11] = 0x31;
      assert.eq(C.detectFormat(mif1Bytes), 'heic', 'ftyp+mif1 也按 HEIC 解');

      // 不是 ISOBMFF 的照旧
      assert.eq(C.detectFormat(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])), 'jpeg', 'JPEG 还是 JPEG');
      assert.eq(C.detectFormat(new Uint8Array([0x42, 0x4D, 0x00, 0x00])), 'bmp', 'BMP 还是 BMP');

      /* ---- 取像素：elheif 给的 buffer 比图像长 ---- */

      // elheif 的 core/src/impl.cpp 解完码又把整个 plane 追加了一遍，
      // 所以 buffer 常常是 width*height*4 的两倍。前面那一份才是图像。
      var px = new Uint8Array(2 * 2 * 4);
      for (var i = 0; i < 16; i++) px[i] = i + 1;
      for (var j = 16; j < 32; j++) px[j] = 0xEE; // 多出来的那一半
      var got = C.rgbaFromFrame({ width: 2, height: 2, data: px });
      assert.eq(got.width, 2, '取出来的宽度对得上');
      assert.eq(got.height, 2, '取出来的高度对得上');
      assert.eq(got.data.length, 16, '只取前面 width*height*4 字节');
      assert.eq(Array.from(got.data), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        '取到的是图像本身，不是后面重复的那份');

      // 长度刚好时原样返回
      var exact = C.rgbaFromFrame({ width: 2, height: 2, data: new Uint8Array(16) });
      assert.eq(exact.data.length, 16, '长度刚好也照取');

      // 数据不够 —— 那是真的解坏了，得报错，不能拿半张图去编码
      var threw = false;
      try { C.rgbaFromFrame({ width: 2, height: 2, data: new Uint8Array(8) }); } catch (e) { threw = true; }
      assert(threw, '像素不够时要报错');

      // 尺寸是 0 的帧也要报错
      threw = false;
      try { C.rgbaFromFrame({ width: 0, height: 0, data: new Uint8Array(0) }); } catch (e) { threw = true; }
      assert(threw, '尺寸为 0 的帧要报错');

      // 不是 Uint8Array（普通数组）也得能取
      var plain = C.rgbaFromFrame({ width: 1, height: 1, data: [9, 8, 7, 6] });
      assert.eq(Array.from(plain.data), [9, 8, 7, 6], '普通数组也能取');

      /* ---- 编码到哪一步了：界面上那一行字 ---- */

      assert.eq(C.busyText(S, 'loading'), S.status_downloading, '在拉编解码器时显示「正在下载」');
      assert.eq(C.busyText(S, 'encoding'), S.status_encoding, '在编码时显示「正在编码」');
      assert.eq(C.busyText(S, 'decoding'), S.status_decoding, '在解 HEIC 时显示「正在解码」');

      /* ---- 预览那句话 ----
         HEIC 浏览器显示不了，预览是把编码结果**解回来**画的 ——
         界面上得说清楚这是怎么回事，不然用户以为预览坏了。 */

      assert(S.hint_preview_decoded && S.hint_preview_decoded.length > 10,
        '预览得有一句说明（HEIC 是解回来画的）');
    }
  };
})();
