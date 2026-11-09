/* ==========================================================================
   图片格式转换（image-converter）

   在浏览器里把一张图片换成另一种格式（JPEG / WebP / PNG），下载新的文件。
   图片一个字节都不出浏览器 —— 解码、编码全在本地完成。

   跟参考实现的差别：
   1. 参考实现（fork 里的 image-converter）用 `image-in-browser` 这个 wasm 库，
      输出 BMP/GIF/ICO/TGA/PVR/TIFF 等一堆格式，WebP 还要额外拉一个
      `webp-converter-browser`。我们只用浏览器原生能编的三种
      （JPEG / WebP / PNG）—— 多出来那些格式在实际场景里用得极少，
      却要背上几兆的 wasm 依赖。HEIC / AVIF 另有专门的页面
      （/image-converter-heic、/image-converter-avif）。
   2. 参考实现把 SVG 先转成 PNG 再处理；我们不收 SVG ——
      canvas 画不了 SVG，而且这里要做的是「位图换格式」。
   3. **透明区域**这件事参考实现没管：PNG（有 alpha）转 JPEG（无 alpha）时，
      透明的地方会变成黑色。我们让用户选一个背景色铺上去，
      默认白色 —— 黑色往往不是用户想要的。
   4. 浏览器不支持 WebP **编码**时，canvas.toBlob 会按规范悄悄退回 PNG。
      我们查 blob.type 把这件事讲明白，而不是让用户拿到一个
      「扩展名写着 .webp、里面其实是 PNG」的文件。
   5. 动图（GIF/APNG/动图 WebP）换完格式只剩第一帧 —— canvas 画不出后面的帧。
      我们把原图的帧数读出来，在结果里明写「原来有 N 帧」。

   **这个文件现在只是一层薄壳**：界面是共用的（ItTools.imageCodec.converterView），
   这里只负责两件事 —— 拼出自己的文案表、把界面调起来。
   三个转换页（普通 / HEIC / AVIF）的界面有九成是重合的，
   各写一份的话，改一处就得记得改三处。共用界面的说明见 static/js/app.js。

   文案为什么在本文件里而不是共用界面里：语言包的对账
   （src/i18n.rs 的 js_text 模块）**只扫 static/js/tools/*.js** 里的
   字面量 t() 调用 —— 文案放在共用内核里就扫不到了，单测会直接红。
   ========================================================================== */
(function () {
  'use strict';

  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-converter');

  /** 默认的输出格式。参考实现默认也是 png。 */
  var DEFAULT_FORMAT = 'png';

  /**
   * 这个格式认不认质量设置。PNG 是无损的，拖滑块没有意义。
   * @param {string} formatId
   * @returns {boolean}
   */
  function qualityApplies(formatId) {
    return C.qualityApplies(formatId);
  }

  /**
   * 这个格式要不要铺背景色。只有没有 alpha 通道的格式要。
   * @param {string} formatId
   * @returns {boolean}
   */
  function backgroundApplies(formatId) {
    return C.backgroundApplies(formatId);
  }

  /** 这个工具的文案表。 */
  var S = {
    title: t('title', 'Convert an image'),
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
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    hint_quality: t('hint_quality', 'Lower quality means a smaller file and more visible artefacts.'),
    hint_lossless: t('hint_lossless', 'PNG is lossless — the quality setting does not apply to it.'),
    hint_background: t('hint_background', 'JPEG has no transparency, so transparent areas are filled with this colour.'),
    hint_same_format: t('hint_same_format', 'The target format is the same as the original — pick another one to really convert it.'),
    hint_formats: t('hint_formats', 'Only JPEG, WebP and PNG can be encoded in the browser.'),
    hint_not_previewable: t('hint_not_previewable', 'This format cannot be previewed in the browser.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.'),
    warn_too_large: t('warn_too_large', 'This image is too large for the browser at that size, so it was scaled down to {width} × {height}.'),
    warn_fallback: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.')
  };

  window.ItTools.register('image-converter', function (root) {
    return C.converterView({
      root: root,
      s: S,
      formats: C.FORMATS,
      defaultFormat: DEFAULT_FORMAT,
      accept: 'image/*'
    });
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['image-converter'] = {
    qualityApplies: qualityApplies,
    backgroundApplies: backgroundApplies,

    __cases: function (assert) {
      /* ---- 本工具自己的规则 ---- */

      assert.eq(qualityApplies('jpeg'), true, 'JPEG 认质量');
      assert.eq(qualityApplies('webp'), true, 'WebP 认质量');
      assert.eq(qualityApplies('png'), false, 'PNG 不认质量');
      assert.eq(qualityApplies('nope'), false, '不认识的格式不认质量');

      assert.eq(backgroundApplies('jpeg'), true, 'JPEG 没有 alpha 通道，要铺背景');
      assert.eq(backgroundApplies('webp'), false, 'WebP 有 alpha 通道，不用铺');
      assert.eq(backgroundApplies('png'), false, 'PNG 有 alpha 通道，不用铺');
      assert.eq(backgroundApplies('nope'), false, '不认识的格式不铺');

      /* ---- 共用内核：转换本身要盯的几处 ---- */

      // 目标格式就是原格式时，体积可能反而变大（PNG 重编码不保证更小）——
      // 这种事必须如实报出来，不能只报「变小了」。
      var grown = C.savings(1000, 1400);
      assert.eq(grown.isSmaller, false, '变大了不算省');
      assert.eq(grown.savedBytes, -400, '差值是负的');

      // 浏览器不支持 WebP 编码时退回 PNG —— 文件名要跟着实际格式走，
      // 不能写一个 .webp 装 PNG 的文件。
      assert.eq(C.actualFormatId({ type: 'image/png' }, 'webp'), 'png', '退回 PNG');
      assert.eq(C.outputName('photo.webp', C.formatById('png').ext, 'converted'), 'photo-converted.png',
        '扩展名按实际格式来');

      assert.eq(C.formatById('png').ext, 'png', 'PNG 的扩展名');
      assert.eq(C.formatById('jpeg').ext, 'jpg', 'JPEG 的扩展名是 jpg 不是 jpeg');
      assert.eq(C.formatById('jpeg').alpha, false, 'JPEG 没有 alpha 通道');
      assert.eq(C.formatById('webp').alpha, true, 'WebP 有 alpha 通道');

      // 图太大、浏览器吃不下这个尺寸时，内核会自动缩一次再编码 ——
      // 缩完的尺寸得是「长宽各减半」，不能把某一边的比例改掉。
      assert.eq(C.shrinkSize(1200, 800), { width: 600, height: 400 }, '长宽各减半');
      assert.eq(C.shrinkSize(1, 1), { width: 1, height: 1 }, '缩到底了就停住');

      // 动图只剩第一帧 —— canvas 画不出后面的帧，界面得说出来
      var gif = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
                 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
                 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
                 0x02, 0x02, 0x44, 0x01, 0x00,
                 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
                 0x02, 0x02, 0x44, 0x01, 0x00,
                 0x3B];
      assert.eq(C.animationInfo(new Uint8Array(gif)), { frames: 2, animated: true }, '两帧的 GIF 是动图');
    }
  };
})();
