/* ==========================================================================
   图片压缩（image-compressor）

   在浏览器里把一张图片压小：调质量、按需缩尺寸，然后下载。
   图片一个字节都不出浏览器 —— 解码、缩放、编码全在本地完成。

   跟参考实现的差别：
   1. 参考实现（fork 里的 image-resizer + image-converter 拼起来的那套）
      把图片读进 ArrayBuffer 交给 wasm 编码器，输出 JPEG/PNG/WebP。
      我们用浏览器原生的 canvas.toBlob —— 少一个几兆的依赖，
      也不用等 wasm 编译完。
   2. **质量设置对 PNG 不生效**（PNG 是无损格式）。
      参考实现里 PNG 那条路根本没有质量参数，我们把这一点在界面上写清楚，
      免得用户拖了滑块发现文件一点没变小。
   3. 动图（GIF/APNG/动图 WebP）只会导出第一帧 —— canvas 只画第一帧。
      这一点必须说出来：无声地丢掉后面的帧，比明说更糟。
      所以读文件的时候顺手数一下帧数（见 imageAnimationInfo），
      是动图就在结果里明写「只剩第一帧、原来有 N 帧」。
   4. 浏览器不支持 WebP **编码**时，canvas.toBlob 会按规范悄悄退回 PNG。
      我们查 blob.type 把这件事讲明白，而不是让用户拿到一个
      「扩展名写着 .webp、里面其实是 PNG」的文件。

   编码器、格式表、算尺寸的规则都在共用的内核里
   （ItTools.imageCodec，见 static/js/app.js），
   「图片格式转换」那个工具用的是同一份 —— 见那里的说明。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-compressor');

  /** 默认质量（1~100）。 */
  var DEFAULT_QUALITY = 75;

  /** 源图已经是这两种有损格式时，默认就按同样的格式输出。 */
  var KEEP_AS_IS = ['jpeg', 'webp'];

  /**
   * 源图格式 → 默认的输出格式。
   *
   * 有损格式（JPEG/WebP）原样输出，只靠降质量压；
   * 其余的（PNG/GIF/BMP）默认转成 WebP —— PNG 重新编码基本压不动，
   * 而 WebP 在同样画质下小得多。要保住 PNG 的话自己在下拉框里改。
   *
   * @param {string} sourceFormat
   * @returns {string}
   */
  function defaultFormatFor(sourceFormat) {
    return KEEP_AS_IS.indexOf(sourceFormat) >= 0 ? sourceFormat : 'webp';
  }

  /**
   * 这个格式认不认质量设置。PNG 是无损的，拖滑块没有意义。
   * @param {string} formatId
   * @returns {boolean}
   */
  function qualityApplies(formatId) {
    var format = C.formatById(formatId);
    return !!format && format.lossy;
  }

  window.ItTools.register('image-compressor', function (root) {
    var disposed = false;
    var state = {
      name: '',
      size: 0,
      sourceFormat: '',
      /** 动图的帧数；静态图是 null。见 imageAnimationInfo。 */
      animation: null,
      decoded: null,
      width: 0,
      height: 0,
      formatId: 'jpeg',
      quality: DEFAULT_QUALITY,
      maxWidth: '',
      maxHeight: '',
      result: null,
      originalUrl: '',
      resultUrl: ''
    };
    /** 重算的序号。慢的那次算完了不许盖掉快的那次的结果。 */
    var ticket = 0;

    /* ---------- 卡片 ---------- */

    var upload = C.uploadCard({
      accept: 'image/*',
      label: t('choose_file', 'Choose an image file'),
      hint: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.'),
      onFile: handleFile
    });
    upload.card.insertBefore(
      D.h('h3', { text: t('title', 'Compress an image') }),
      upload.card.firstChild
    );

    var settingsCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(settingsCard);
    root.appendChild(resultCard);

    /* ---------- 设置 ---------- */

    var formatSelect = D.h('select.layui-select', null,
      C.FORMATS.map(function (f) {
        return D.h('option', { value: f.id, text: f.label });
      })
    );

    var qualityLabel = D.h('label.field-label', {
      for: 'ic-quality',
      text: t('label_quality', 'Quality ({n})').replace('{n}', DEFAULT_QUALITY)
    });
    var qualitySlider = D.h('input.slider', {
      type: 'range', id: 'ic-quality', min: 1, max: 100, step: 1, value: DEFAULT_QUALITY
    });

    var widthInput = D.h('input.layui-input', {
      type: 'number', min: 1, step: 1, placeholder: t('ph_keep', 'original')
    });
    var heightInput = D.h('input.layui-input', {
      type: 'number', min: 1, step: 1, placeholder: t('ph_keep', 'original')
    });

    var formatHint = D.h('p.field-hint');
    var qualityHint = D.h('p.field-hint');

    settingsCard.appendChild(D.h('h3', { text: t('settings_title', 'Compression settings') }));
    settingsCard.appendChild(U.field(t('label_format', 'Output format'), formatSelect));
    settingsCard.appendChild(D.h('div.field', null, qualityLabel, qualitySlider));
    settingsCard.appendChild(U.field(t('label_max_width', 'Max width'), widthInput));
    settingsCard.appendChild(U.field(t('label_max_height', 'Max height'), heightInput));
    settingsCard.appendChild(formatHint);
    settingsCard.appendChild(qualityHint);
    settingsCard.appendChild(D.h('p.field-hint', {
      text: t('hint_size', 'Leave the width or height empty to keep the original size. The image is scaled proportionally, never enlarged.')
    }));

    /* ---------- 结果 ---------- */

    var resultBody = D.h('div');
    resultCard.appendChild(D.h('h3', { text: t('result_title', 'Result') }));
    resultCard.appendChild(resultBody);

    /** 键值对照表。 */
    function kvTable(rows) {
      var table = D.h('table.kv-table');
      table.appendChild(D.h('thead', null, D.h('tr', null,
        D.h('th', { text: t('label_item', 'Item') }),
        D.h('th', { text: t('label_value', 'Value') })
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

    /** 换掉结果图的 object URL —— 不撤销的话每改一次设置就漏一个 blob。 */
    function replaceResultUrl(blob) {
      if (state.resultUrl) {
        URL.revokeObjectURL(state.resultUrl);
        state.resultUrl = '';
      }
      state.resultUrl = URL.createObjectURL(blob);
    }

    /** 设置变了之后刷新提示文案。 */
    function refreshHints() {
      var format = C.formatById(state.formatId);
      var lossy = qualityApplies(state.formatId);

      qualitySlider.disabled = !lossy;
      qualityHint.textContent = lossy
        ? t('hint_quality', 'Lower quality means a smaller file and more visible artefacts.')
        : t('hint_lossless', 'PNG is lossless — the quality setting does not apply to it.');
      qualityHint.classList.toggle('is-error', false);

      if (state.sourceFormat && format && state.sourceFormat !== format.id) {
        formatHint.textContent = t('hint_format_changed', 'The output format differs from the original ({from} → {to}).')
          .replace('{from}', state.sourceFormat.toUpperCase())
          .replace('{to}', format.label);
      } else {
        formatHint.textContent = '';
      }
    }

    /** 画结果卡片。 */
    function renderResult() {
      D.clear(resultBody);
      var r = state.result;
      if (!r) {
        resultBody.appendChild(D.h('p.field-hint', { text: t('no_result', 'No image yet.') }));
        return;
      }

      var format = C.formatById(r.formatId) || C.FORMATS[0];
      var saved = C.savings(r.beforeBytes, r.blob.size);
      var savedText = saved.isSmaller
        ? C.formatBytes(saved.savedBytes) + ' (' + saved.savedPercent.toFixed(1) + '%)'
        : (saved.savedBytes < 0
          ? C.formatBytes(-saved.savedBytes) + ' bigger (' + (-saved.savedPercent).toFixed(1) + '%)'
          : t('label_same_size', 'same size'));

      resultBody.appendChild(kvTable([
        { label: t('label_source_format', 'Original format'), value: state.sourceFormat ? state.sourceFormat.toUpperCase() : t('label_unknown', 'unknown') },
        { label: t('label_before', 'Size before'), value: C.formatBytes(r.beforeBytes) },
        { label: t('label_after', 'Size after'), value: C.formatBytes(r.blob.size) },
        { label: t('label_saved', 'Saved'), value: savedText },
        {
          label: t('label_dimensions', 'Dimensions'),
          value: r.width + ' × ' + r.height +
            (r.scaled ? ' (' + t('label_scaled', 'scaled') + ')' : '')
        },
        { label: t('label_output_format', 'Saved as'), value: format.label }
      ]));

      // 浏览器不支持这个格式的编码时，toBlob 会退回 PNG —— 必须说出来
      if (r.formatId !== r.requestedFormatId) {
        var requested = C.formatById(r.requestedFormatId);
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.')
              .replace('{format}', requested ? requested.label : r.requestedFormatId)
              .replace('{actual}', format.label)
          })
        ));
      }

      // 动图只剩第一帧 —— canvas 画不出后面的帧，不说清楚就成了骗人
      if (state.animation && state.animation.animated) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.')
              .replace('{n}', String(state.animation.frames))
          })
        ));
      }

      // 图太大，浏览器吃不下这个尺寸，内核自动缩过 —— 尺寸变了得说出来
      if (r.scaledToFit) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: t('warn_too_large', 'This image is too large for the browser at that size, so it was scaled down to {width} × {height}.')
              .replace('{width}', String(r.width))
              .replace('{height}', String(r.height))
          })
        ));
      }

      // 原图与结果的并排预览
      var preview = D.h('div.preview-box');
      if (state.originalUrl) {
        preview.appendChild(D.h('div', null,
          D.h('p.field-hint', { text: t('preview_before', 'Before') }),
          D.h('img', { src: state.originalUrl, alt: t('preview_before', 'Before'), style: { maxWidth: '100%' } })
        ));
      }
      preview.appendChild(D.h('div', null,
        D.h('p.field-hint', { text: t('preview_after', 'After') }),
        D.h('img', { src: state.resultUrl, alt: t('preview_after', 'After'), style: { maxWidth: '100%' } })
      ));
      resultBody.appendChild(preview);

      var downloadBtn = D.h('button.layui-btn.layui-btn-primary', {
        type: 'button', text: t('download', 'Download the compressed image')
      });
      downloadBtn.addEventListener('click', function () {
        if (disposed || !state.result) return;
        var fmt = C.formatById(state.result.formatId) || C.FORMATS[0];
        window.ItTools.download(
          C.outputName(state.name, fmt.ext, 'compressed'),
          state.result.blob,
          fmt.mime
        );
      });
      resultBody.appendChild(D.h('div.form-actions', null, downloadBtn));
    }

    /** 按当前设置重新编码。 */
    function recompute() {
      if (!state.decoded) return;
      var mine = ++ticket;
      var target = C.fitWithin(state.width, state.height, state.maxWidth, state.maxHeight);

      C.encode(state.decoded, {
        width: target.width,
        height: target.height,
        formatId: state.formatId,
        quality: state.quality,
        background: '#ffffff'
      }).then(function (out) {
        // 慢的那次算完了不许盖掉快的那次的结果
        if (disposed || mine !== ticket) return;
        state.result = {
          blob: out.blob,
          width: out.width,
          height: out.height,
          formatId: out.formatId,
          requestedFormatId: out.requestedFormatId,
          beforeBytes: state.size,
          scaled: target.scaled,
          scaledToFit: out.scaledToFit
        };
        replaceResultUrl(out.blob);
        renderResult();
      }, function (err) {
        if (disposed || mine !== ticket) return;
        state.result = null;
        D.clear(resultBody).appendChild(D.h('p.field-hint.is-error', {
          text: t('err_encode', 'Could not encode the image: {reason}').replace('{reason}', function () {
            return String(err && err.message ? err.message : err);
          })
        }));
      });
    }

    /* ---------- 处理文件 ---------- */

    function handleFile(file) {
      if (!file) return;
      upload.setStatus(t('status_reading', 'Reading the file…'));

      var reader = new FileReader();
      reader.onload = function () {
        if (disposed) return;
        var bytes;
        try {
          bytes = new Uint8Array(reader.result);
        } catch (e) {
          upload.setStatus(t('err_read', 'Could not read the file.'), true);
          return;
        }
        var format = C.detectFormat(bytes);

        C.decode(file).then(function (decoded) {
          if (disposed) return;

          state.name = file.name || 'image';
          state.size = file.size || bytes.length;
          state.sourceFormat = format || '';
          state.animation = C.animationInfo(bytes);
          state.decoded = decoded;
          state.width = decoded.width;
          state.height = decoded.height;
          state.maxWidth = '';
          state.maxHeight = '';
          state.quality = DEFAULT_QUALITY;
          state.formatId = defaultFormatFor(state.sourceFormat);

          widthInput.value = '';
          heightInput.value = '';
          qualitySlider.value = String(DEFAULT_QUALITY);
          qualityLabel.textContent = t('label_quality', 'Quality ({n})').replace('{n}', DEFAULT_QUALITY);
          formatSelect.value = state.formatId;

          if (state.originalUrl) {
            URL.revokeObjectURL(state.originalUrl);
            state.originalUrl = '';
          }
          state.originalUrl = URL.createObjectURL(file);

          upload.setStatus('');
          settingsCard.hidden = false;
          resultCard.hidden = false;
          refreshHints();
          recompute();
        }, function () {
          if (disposed) return;
          upload.setStatus(t('err_decode', 'This file could not be decoded as an image.'), true);
          settingsCard.hidden = true;
          resultCard.hidden = true;
        });
      };
      reader.onerror = function () {
        if (disposed) return;
        upload.setStatus(t('err_read', 'Could not read the file.'), true);
      };
      reader.readAsArrayBuffer(file);
    }

    /* ---------- 事件 ---------- */

    formatSelect.addEventListener('change', function () {
      state.formatId = formatSelect.value;
      refreshHints();
      recompute();
    });

    qualitySlider.addEventListener('input', function () {
      state.quality = C.clampQuality(qualitySlider.value);
      qualityLabel.textContent = t('label_quality', 'Quality ({n})').replace('{n}', state.quality);
      recompute();
    });

    widthInput.addEventListener('input', function () {
      state.maxWidth = widthInput.value;
      recompute();
    });

    heightInput.addEventListener('input', function () {
      state.maxHeight = heightInput.value;
      recompute();
    });

    return {
      destroy: function () {
        disposed = true;
        ticket++;
        if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
        if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
        if (state.decoded && state.decoded.close) state.decoded.close();
        state.originalUrl = '';
        state.resultUrl = '';
        state.decoded = null;
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['image-compressor'] = {
    defaultFormatFor: defaultFormatFor,
    qualityApplies: qualityApplies,

    __cases: function (assert) {
      /* ---- 共用内核：格式表 ---- */

      assert.eq(C.FORMATS.length, 3, '三种输出格式');
      assert.eq(C.formatById('jpeg').mime, 'image/jpeg', 'JPEG 的 mime');
      assert.eq(C.formatById('webp').ext, 'webp', 'WebP 的扩展名');
      assert.eq(C.formatById('png').lossy, false, 'PNG 是无损的');
      assert.eq(C.formatById('nope'), null, '不认识的格式 id');

      /* ---- 共用内核：认输入格式 ---- */

      function bytes(arr) { return new Uint8Array(arr); }

      assert.eq(C.detectFormat(bytes([0xFF, 0xD8, 0xFF, 0xE0])), 'jpeg', '认得出 JPEG');
      assert.eq(C.detectFormat(bytes([0x89, 0x50, 0x4E, 0x47, 0x0D])), 'png', '认得出 PNG');
      assert.eq(C.detectFormat(bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'webp', '认得出 WebP');
      assert.eq(C.detectFormat(bytes([0x47, 0x49, 0x46, 0x39])), 'gif', '认得出 GIF');
      assert.eq(C.detectFormat(bytes([0x42, 0x4D, 0, 0])), 'bmp', '认得出 BMP');
      assert.eq(C.detectFormat(bytes([1, 2, 3, 4])), null, '不是图片就认不出来');
      assert.eq(C.detectFormat(bytes([0x89, 0x50])), null, '太短的不认');
      assert.eq(C.detectFormat(null), null, '空输入');

      /* ---- 共用内核：数帧数（动图只剩第一帧，得说出来） ---- */

      // 造一个最小可用的 GIF。结构：6 字节签名 + 7 字节逻辑屏幕描述 +
      // 每帧（10 字节图像描述 + 1 字节 LZW 最小码长 + 数据子块）+ 1 字节结束符。
      // withPalette 打开就带上全局调色板 —— 真实的 GIF 几乎都带，
      // 不跳过去的话读到的是颜色值，不是块标记。
      function gif(frames, withPalette) {
        var out = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
                   0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00];
        if (withPalette) {
          out[10] = 0x80; // packed 的最高位 = 有全局调色板
          out.push(0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF); // 2 个颜色 = 6 字节
        }
        for (var i = 0; i < frames; i++) {
          out.push(0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
          out.push(0x02, 0x02, 0x44, 0x01, 0x00);
        }
        out.push(0x3B);
        return bytes(out);
      }

      // 最小可用的 PNG：签名 + IHDR + （可选的 acTL）+ IDAT
      function png(animated, frames) {
        var out = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        // IHDR：长度 13 + 类型 + 13 字节数据 + 4 字节 CRC
        out.push(0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52);
        for (var i = 0; i < 13; i++) out.push(0);
        out.push(0, 0, 0, 0);
        if (animated) {
          // acTL：长度 8 + 类型 + 8 字节数据（帧数、播放次数）+ 4 字节 CRC
          out.push(0x00, 0x00, 0x00, 0x08, 0x61, 0x63, 0x54, 0x4C);
          out.push(0x00, 0x00, 0x00, frames, 0x00, 0x00, 0x00, 0x00);
          out.push(0, 0, 0, 0);
        }
        // IDAT：长度 0
        out.push(0x00, 0x00, 0x00, 0x00, 0x49, 0x44, 0x41, 0x54);
        return bytes(out);
      }

      // 最小可用的 WebP：RIFF + WEBP + 一个 VP8X 块（标志位里有「动画」那一位）
      function webp(animated) {
        var out = [0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
        out.push(0x56, 0x50, 0x38, 0x58, 0x0A, 0x00, 0x00, 0x00);
        out.push(animated ? 0x02 : 0x00);
        for (var i = 0; i < 9; i++) out.push(0);
        return bytes(out);
      }

      assert.eq(C.animationInfo(gif(1)), { frames: 1, animated: false }, '单帧 GIF 不是动图');
      assert.eq(C.animationInfo(gif(3)), { frames: 3, animated: true }, '三帧 GIF 是动图');
      assert.eq(C.animationInfo(gif(2, true)), { frames: 2, animated: true },
        '带全局调色板的 GIF 也要数得出来');
      assert.eq(C.animationInfo(png(false, 0)), { frames: 1, animated: false }, '静态 PNG 只有一帧');
      assert.eq(C.animationInfo(png(true, 5)), { frames: 5, animated: true }, 'APNG 的帧数在 acTL 里');
      assert.eq(C.animationInfo(webp(false)), { frames: 1, animated: false }, '静态 WebP 只有一帧');
      assert.eq(C.animationInfo(webp(true)).animated, true, 'VP8X 的动画标志位认得出来');
      assert.eq(C.animationInfo(bytes([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null,
        'JPEG 是静态格式，没有帧数这回事');
      assert.eq(C.animationInfo(bytes([0x42, 0x4D, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null,
        'BMP 同理');
      assert.eq(C.animationInfo(bytes([1, 2, 3])), null, '太短的不认');
      assert.eq(C.animationInfo(null), null, '空输入');

      /* ---- 共用内核：目标尺寸 ---- */

      assert.eq(C.fitWithin(800, 600, '', ''), { width: 800, height: 600, scaled: false }, '两个上限都空就原样');
      assert.eq(C.fitWithin(800, 600, 400, ''), { width: 400, height: 300, scaled: true }, '只给宽度就按比例缩');
      assert.eq(C.fitWithin(800, 600, '', 300), { width: 400, height: 300, scaled: true }, '只给高度就按比例缩');
      assert.eq(C.fitWithin(800, 600, 400, 400), { width: 400, height: 300, scaled: true }, '两个上限取更紧的那个');
      assert.eq(C.fitWithin(800, 600, 1600, 1200), { width: 800, height: 600, scaled: false }, '比原图大的上限不放大');
      assert.eq(C.fitWithin(800, 600, 'abc', ''), { width: 800, height: 600, scaled: false }, '非法输入当没设');
      assert.eq(C.fitWithin(800, 600, 0, -5), { width: 800, height: 600, scaled: false }, '0 和负数当没设');
      assert.eq(C.fitWithin(1, 1, 0.4, ''), { width: 1, height: 1, scaled: false }, '缩到 0 也不许出 0 像素');
      assert.eq(C.fitWithin(0, 0, '', ''), { width: 1, height: 1, scaled: false }, '尺寸非法时兜底成 1×1');

      /* ---- 共用内核：编码失败后的缩一步 ---- */

      assert.eq(C.shrinkSize(800, 600), { width: 400, height: 300 }, '长宽各减半');
      assert.eq(C.shrinkSize(801, 601), { width: 401, height: 301 }, '奇数向上取整，不丢像素');
      assert.eq(C.shrinkSize(3, 1), { width: 2, height: 1 }, '1 像素的那一边不再缩');
      assert.eq(C.shrinkSize(1, 1), { width: 1, height: 1 }, '已经是最小了就停住');

      /* ---- 共用内核：质量 ---- */

      assert.eq(C.clampQuality(75), 75, '正常值');
      assert.eq(C.clampQuality(0), 1, '0 抬到 1');
      assert.eq(C.clampQuality(101), 100, '超过 100 压到 100');
      assert.eq(C.clampQuality('50'), 50, '字符串数字');
      assert.eq(C.clampQuality('abc'), 75, '非法值退回默认');
      assert.eq(C.clampQuality(''), 75, '空值退回默认');

      /* ---- 共用内核：省了多少 ---- */

      var saved = C.savings(1000, 250);
      assert.eq(saved.savedBytes, 750, '省了多少字节');
      assert.eq(saved.savedPercent, 75, '省了多少百分比');
      assert.eq(saved.isSmaller, true, '变小了');
      assert.eq(C.savings(250, 1000).isSmaller, false, '变大了不算省');
      assert.eq(C.savings(1000, 1000).savedBytes, 0, '一样大');
      assert.eq(C.savings(0, 100).savedPercent, 0, '原文件是 0 字节时不除以零');

      /* ---- 共用内核：大小与文件名 ---- */

      assert.eq(C.formatBytes(512), '512 B', '字节');
      assert.eq(C.formatBytes(2048), '2.00 KB', 'KB');
      assert.eq(C.formatBytes(1024 * 1024 * 3), '3.00 MB', 'MB');
      assert.eq(C.formatBytes(-1), '', '非法大小');
      assert.eq(C.outputName('photo.jpg', 'webp', 'compressed'), 'photo-compressed.webp', '换扩展名并加后缀');
      assert.eq(C.outputName('photo', 'png'), 'photo.png', '没有扩展名');
      assert.eq(C.outputName('a.b.png', 'jpg'), 'a.b.jpg', '只换最后一个扩展名');

      /* ---- 共用内核：浏览器实际编码出来的格式 ---- */

      assert.eq(C.actualFormatId({ type: 'image/webp' }, 'webp'), 'webp', 'WebP 编码成功');
      assert.eq(C.actualFormatId({ type: 'image/png' }, 'webp'), 'png', '不支持 WebP 时退回 PNG');
      assert.eq(C.actualFormatId({ type: 'image/jpeg' }, 'jpeg'), 'jpeg', 'JPEG');
      assert.eq(C.actualFormatId(null, 'jpeg'), 'jpeg', '拿不到类型时按用户选的算');

      /* ---- 本工具自己的规则 ---- */

      assert.eq(defaultFormatFor('jpeg'), 'jpeg', 'JPEG 原样输出');
      assert.eq(defaultFormatFor('webp'), 'webp', 'WebP 原样输出');
      assert.eq(defaultFormatFor('png'), 'webp', 'PNG 默认转 WebP');
      assert.eq(defaultFormatFor(''), 'webp', '认不出来的格式默认 WebP');
      assert.eq(qualityApplies('jpeg'), true, 'JPEG 认质量');
      assert.eq(qualityApplies('webp'), true, 'WebP 认质量');
      assert.eq(qualityApplies('png'), false, 'PNG 不认质量');
      assert.eq(qualityApplies('nope'), false, '不认识的格式不认质量');
    }
  };
})();
