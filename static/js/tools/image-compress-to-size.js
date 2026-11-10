/* ==========================================================================
   压缩到指定大小（image-compress-to-size）

   「帮我把这张图压到 100 KB 以内」—— 现有的图片压缩工具只给一根质量滑块，
   用户不知道要拖到多少才算 100 KB，只能一次次试。这个工具反过来做：
   填一个目标体积，工具自己在「画质」和「尺寸」两个维度上找那个刚好达标的组合。

   算法分三步：

   1. 画质 100 达不达标？达标就用它（目标给得宽裕，一次编码就够）。
   2. 不达标就看画质 1 达不达标。达标就**二分**找最大的达标画质 ——
      体积随画质单调下降（实践中如此），七八次编码就能找到。
   3. 连画质 1 都超标，那就只能缩尺寸。体积大致按面积走，
      所以边长按 sqrt(目标 / 当前) 缩，缩完再二分一次校正
      （体积与面积只是大致成正比，小图上 JPEG 还有固定开销）。

   缩尺寸时拿「画质 75」当参考：缩完以后这个画质刚好达标，
   接着的二分会再往上找一点（通常 75~85）。这样尺寸和画质同时到位，
   比「缩到画质 1 刚好达标、再在低画质里挑」强得多。

   三条不能省的实话：

   - PNG 是无损格式，画质设置对它没有意义 —— 压不到目标大小。
     所以这个工具只给 JPEG 和 WebP，界面上写清楚为什么没有 PNG。
   - 动图只剩第一帧（canvas 只画第一帧），跟图片压缩工具一样要说出来。
   - 浏览器不支持某个格式的编码时，toBlob 会按规范悄悄退回 PNG。
     查 blob.type 把这件事讲明白，而不是让用户拿到一个
     「扩展名写着 .webp、里面其实是 PNG」的文件。

   图片一个字节都不出浏览器：解码、缩放、编码全在本地完成。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-compress-to-size');

  /** 最多缩放几轮。缩完还超标是极少见的情况，三轮足够兜底。 */
  var MAX_ROUNDS = 3;

  /** 目标大小输入的防抖毫秒 —— 一次搜索要编码七八次，不能边打字边搜。 */
  var TARGET_DEBOUNCE_MS = 250;

  /** 缩尺寸时拿这个画质当参考：缩完它刚好达标，二分再往上找。 */
  var REFERENCE_QUALITY = 75;

  /** 缩放的安全系数：宁可略缩一点，也不要缩完还超标。 */
  var SCALE_SAFETY = 0.98;

  /** 只有有损格式能靠画质压到目标大小。PNG 是无损的，画质对它没有意义。 */
  var LOSSY_FORMATS = C.FORMATS.filter(function (f) { return f.lossy; });

  var S = {
    title: t('title', 'Compress an image to a target size'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.'),
    settings_title: t('settings_title', 'Compression settings'),
    label_target: t('label_target', 'Target size'),
    label_unit: t('label_unit', 'Unit'),
    label_format: t('label_format', 'Output format'),
    hint_formats: t('hint_formats', 'Only JPEG and WebP can be compressed to a target size. PNG is lossless, so its size does not depend on the quality setting.'),
    hint_search: t('hint_search', 'The tool looks for the highest quality that still fits under the target. If even the lowest quality is too big, it scales the picture down.'),
    hint_format_changed: t('hint_format_changed', 'The output format differs from the original ({from} → {to}).'),
    status_reading: t('status_reading', 'Reading the file…'),
    status_searching: t('status_searching', 'Searching for the right quality…'),
    status_scaling: t('status_scaling', 'Scaling the picture down to {width} × {height}…'),
    result_title: t('result_title', 'Result'),
    label_item: t('label_item', 'Item'),
    label_value: t('label_value', 'Value'),
    label_target_size: t('label_target_size', 'Target size'),
    label_before: t('label_before', 'Size before'),
    label_after: t('label_after', 'Size after'),
    label_saved: t('label_saved', 'Saved'),
    label_dimensions: t('label_dimensions', 'Dimensions'),
    label_quality: t('label_quality', 'Quality'),
    label_output_format: t('label_output_format', 'Saved as'),
    label_unknown: t('label_unknown', 'unknown'),
    label_scaled: t('label_scaled', 'scaled'),
    label_kept: t('label_kept', 'not re-encoded'),
    no_result: t('no_result', 'No image yet.'),
    preview_before: t('preview_before', 'Before'),
    preview_after: t('preview_after', 'After'),
    download: t('download', 'Download the compressed image'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_target: t('err_target', 'Enter a target size bigger than zero.'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    warn_scaled: t('warn_scaled', 'Even at the lowest quality the picture was still over {target}, so it was scaled down to {width} × {height}.'),
    warn_too_large: t('warn_too_large', 'This image is too large for the browser at that size, so it was scaled down to {width} × {height}.'),
    warn_fallback: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.'),
    hint_id_photo: t('hint_id_photo', 'Need a standard size instead? Resize it to an ID photo size.')
  };

  /* ---------- 纯逻辑（给 harness 用，也在下面被界面用） ---------- */

  /**
   * 用户填的目标大小 → 字节数。
   *
   * 单位按 1024 进制（1 KB = 1024 字节），跟操作系统显示文件大小一个口径。
   * 允许小数（「1.5 MB」这种）。
   *
   * @param {*} value 输入框里的内容
   * @param {string} unit 'KB' 或 'MB'
   * @returns {number|null} 字节数；填得不对就 null
   */
  function parseTargetSize(value, unit) {
    var text = String(value === null || value === undefined ? '' : value).trim();
    var n = parseFloat(text);
    if (!isFinite(n) || n <= 0) return null;
    var mult = unit === 'MB' ? 1024 * 1024 : 1024;
    var bytes = Math.round(n * mult);
    return bytes > 0 ? bytes : null;
  }

  /**
   * 体积按面积走 —— 要把体积压到 target、当前体积是 current，
   * 面积就得乘上 target/current，边长的比例就是它的平方根。
   *
   * @param {number} currentBytes 当前体积
   * @param {number} targetBytes 目标体积
   * @returns {number} 边长比例（小于 1 表示要缩小）
   */
  function areaRatio(currentBytes, targetBytes) {
    if (!(currentBytes > 0) || !(targetBytes > 0)) return 1;
    return Math.sqrt(targetBytes / currentBytes);
  }

  /**
   * 按比例缩尺寸，两边同比例 —— 至少留一个像素。
   *
   * @param {number} width
   * @param {number} height
   * @param {number} ratio
   * @returns {{width: number, height: number}}
   */
  function scaledSize(width, height, ratio) {
    return {
      width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio))
    };
  }

  /**
   * 下载文件名里的后缀：100 KB 的目标叫 xxx-100kb.jpg。
   *
   * @param {number} targetBytes
   * @returns {string}
   */
  function targetSuffix(targetBytes) {
    if (targetBytes >= 1024 * 1024) {
      return (Math.round(targetBytes / (1024 * 1024) * 10) / 10) + 'mb';
    }
    return Math.max(1, Math.round(targetBytes / 1024)) + 'kb';
  }

  window.ItTools.register('image-compress-to-size', function (root) {
    var disposed = false;
    var state = {
      name: '',
      size: 0,
      sourceFormat: '',
      /** 动图的帧数；静态图是 null。见 imageAnimationInfo。 */
      animation: null,
      file: null,
      decoded: null,
      width: 0,
      height: 0,
      formatId: 'jpeg',
      targetValue: '100',
      targetUnit: 'KB',
      result: null,
      originalUrl: '',
      resultUrl: ''
    };
    /** 重算的序号。慢的那次算完了不许盖掉快的那次的结果。 */
    var ticket = 0;
    /** 目标大小输入的防抖计时器。 */
    var debounceTimer = null;

    /* ---------- 卡片 ---------- */

    var upload = C.uploadCard({
      accept: 'image/*',
      label: S.choose_file,
      hint: S.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);

    var settingsCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(settingsCard);
    root.appendChild(resultCard);

    /* ---------- 设置 ---------- */

    var targetInput = D.h('input.layui-input', {
      type: 'number', min: 1, step: 1, value: state.targetValue
    });
    var unitSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'KB', text: 'KB' }),
      D.h('option', { value: 'MB', text: 'MB' })
    );
    var formatSelect = D.h('select.layui-select', null,
      LOSSY_FORMATS.map(function (f) {
        return D.h('option', { value: f.id, text: f.label });
      })
    );

    var formatHint = D.h('p.field-hint');
    var statusLine = D.h('p.field-hint');

    settingsCard.appendChild(D.h('h3', { text: S.settings_title }));
    settingsCard.appendChild(U.field(S.label_target, targetInput));
    settingsCard.appendChild(U.field(S.label_unit, unitSelect));
    settingsCard.appendChild(U.field(S.label_format, formatSelect));
    settingsCard.appendChild(D.h('p.field-hint', { text: S.hint_formats }));
    settingsCard.appendChild(D.h('p.field-hint', { text: S.hint_search }));
    settingsCard.appendChild(formatHint);
    settingsCard.appendChild(statusLine);
    // 另一个尺寸向的工具：证件照标准尺寸。两页互相给个入口。
    settingsCard.appendChild(D.h('p.field-hint', null,
      D.h('a', { href: '/id-photo-resizer', text: S.hint_id_photo })
    ));

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

    /** 换掉结果图的 object URL —— 不撤销的话每搜一次就漏一个 blob。 */
    function replaceResultUrl(blob) {
      if (state.resultUrl) {
        URL.revokeObjectURL(state.resultUrl);
        state.resultUrl = '';
      }
      state.resultUrl = URL.createObjectURL(blob);
    }

    /** 刷新「输出格式跟原图不一样」的提示。 */
    function refreshFormatHint() {
      if (state.sourceFormat && state.sourceFormat !== state.formatId) {
        var format = C.formatById(state.formatId);
        formatHint.textContent = S.hint_format_changed
          .replace('{from}', state.sourceFormat.toUpperCase())
          .replace('{to}', format ? format.label : state.formatId);
      } else {
        formatHint.textContent = '';
      }
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
      var saved = C.savings(r.beforeBytes, r.bytes);
      var savedText = saved.isSmaller
        ? C.formatBytes(saved.savedBytes) + ' (' + saved.savedPercent.toFixed(1) + '%)'
        : (saved.savedBytes < 0
          ? C.formatBytes(-saved.savedBytes) + ' bigger (' + (-saved.savedPercent).toFixed(1) + '%)'
          : t('label_same_size', 'same size'));

      resultBody.appendChild(kvTable([
        { label: S.label_target_size, value: C.formatBytes(r.targetBytes) },
        { label: S.label_before, value: C.formatBytes(r.beforeBytes) },
        { label: S.label_after, value: C.formatBytes(r.bytes) },
        { label: S.label_saved, value: savedText },
        {
          label: S.label_dimensions,
          value: r.width + ' × ' + r.height +
            (r.scaled ? ' (' + S.label_scaled + ')' : '')
        },
        {
          label: S.label_quality,
          value: r.original ? S.label_kept : String(r.quality)
        },
        { label: S.label_output_format, value: format.label }
      ]));

      // 尺寸被迫缩过 —— 尺寸变了就得说出来
      if (r.scaled) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: S.warn_scaled
              .replace('{target}', C.formatBytes(r.targetBytes))
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

      // 原图与结果的并排预览
      var preview = D.h('div.preview-box');
      if (state.originalUrl) {
        preview.appendChild(D.h('div', null,
          D.h('p.field-hint', { text: S.preview_before }),
          D.h('img', { src: state.originalUrl, alt: S.preview_before, style: { maxWidth: '100%' } })
        ));
      }
      var afterUrl = r.original ? state.originalUrl : state.resultUrl;
      if (afterUrl) {
        preview.appendChild(D.h('div', null,
          D.h('p.field-hint', { text: S.preview_after }),
          D.h('img', { src: afterUrl, alt: S.preview_after, style: { maxWidth: '100%' } })
        ));
      }
      resultBody.appendChild(preview);

      var downloadBtn = D.h('button.layui-btn.layui-btn-primary', {
        type: 'button', text: S.download
      });
      downloadBtn.addEventListener('click', function () {
        if (disposed || !state.result) return;
        var fmt = C.formatById(state.result.formatId) || C.FORMATS[0];
        window.ItTools.download(
          C.outputName(state.name, fmt.ext, targetSuffix(state.result.targetBytes)),
          state.result.blob,
          fmt.mime
        );
      });
      resultBody.appendChild(D.h('div.form-actions', null, downloadBtn));
    }

    /* ---------- 搜索 ---------- */

    /**
     * 在某个尺寸上按某个画质编码一次。
     *
     * @param {number} quality 1~100
     * @param {number} width
     * @param {number} height
     * @returns {Promise<{bytes: number, out: object}>}
     */
    function encodeAt(quality, width, height) {
      return C.encode(state.decoded, {
        width: width,
        height: height,
        formatId: state.formatId,
        quality: quality,
        background: '#ffffff'
      }).then(function (out) {
        return { bytes: out.blob.size, out: out };
      });
    }

    /**
     * 在当前尺寸上找「最大的、仍然不超过目标体积的画质」。
     *
     * 体积随画质单调下降（实践中如此），所以可以二分。
     * 连画质 1 都超标就返回 {tooBig: true} —— 那只能缩尺寸了。
     *
     * @param {number} width
     * @param {number} height
     * @param {number} targetBytes
     * @returns {Promise<object>}
     */
    function searchQuality(width, height, targetBytes) {
      return encodeAt(100, width, height).then(function (top) {
        if (top.bytes <= targetBytes) {
          return { quality: 100, bytes: top.bytes, out: top.out };
        }
        return encodeAt(1, width, height).then(function (bottom) {
          if (bottom.bytes > targetBytes) {
            return { tooBig: true, bytes: bottom.bytes };
          }
          // 二分：下界 1 已知达标，上界 99 已知超标
          var best = { quality: 1, bytes: bottom.bytes, out: bottom.out };
          var lo = 2;
          var hi = 99;

          function step() {
            if (lo > hi) return Promise.resolve(best);
            var q = Math.floor((lo + hi) / 2);
            return encodeAt(q, width, height).then(function (probe) {
              if (probe.bytes <= targetBytes) {
                if (q > best.quality) {
                  best = { quality: q, bytes: probe.bytes, out: probe.out };
                }
                lo = q + 1;
              } else {
                hi = q - 1;
              }
              return step();
            });
          }
          return step();
        });
      });
    }

    /**
     * 把图压到目标体积以内。
     *
     * @param {number} targetBytes
     * @param {function(): boolean} isCurrent 竞态闸门 —— 过期了就别再往下走
     * @returns {Promise<object|null>} 找不到就 null
     */
    function compressToTarget(targetBytes, isCurrent) {
      var dims = { width: state.width, height: state.height };
      var scaled = false;
      var round = 0;

      function attempt() {
        return searchQuality(dims.width, dims.height, targetBytes).then(function (found) {
          if (found && !found.tooBig) {
            return {
              quality: found.quality,
              bytes: found.bytes,
              out: found.out,
              scaled: scaled,
              width: found.out.width,
              height: found.out.height
            };
          }
          // 连画质 1 都超标 —— 只能缩尺寸再来一轮
          if (round >= MAX_ROUNDS) return null;
          round++;
          return encodeAt(REFERENCE_QUALITY, dims.width, dims.height).then(function (ref) {
            if (!isCurrent()) return null;
            var ratio = Math.min(1, areaRatio(ref.bytes, targetBytes) * SCALE_SAFETY);
            var next = scaledSize(dims.width, dims.height, ratio);
            if (next.width === dims.width && next.height === dims.height) {
              // 没变 —— 强制退一像素，否则下一轮还是同样的尺寸，转圈出不来
              next = {
                width: Math.max(1, dims.width - 1),
                height: Math.max(1, dims.height - 1)
              };
            }
            dims = next;
            scaled = true;
            setStatus(S.status_scaling
              .replace('{width}', String(dims.width))
              .replace('{height}', String(dims.height)));
            return attempt();
          });
        });
      }
      return attempt();
    }

    /** 目标大小没填对 —— 结果区空着，状态行说明。 */
    function failTarget() {
      state.result = null;
      if (state.resultUrl) {
        URL.revokeObjectURL(state.resultUrl);
        state.resultUrl = '';
      }
      setStatus(S.err_target, true);
      renderResult();
    }

    /** 按当前设置重新搜一遍。 */
    function recompute() {
      if (!state.decoded) return;
      var mine = ++ticket;
      var targetBytes = parseTargetSize(state.targetValue, state.targetUnit);
      if (!targetBytes) {
        failTarget();
        return;
      }
      setStatus(S.status_searching);

      var isCurrent = function () { return !disposed && mine === ticket; };

      // 原图本来就达标、而且格式也一样 —— 直接用原文件，不重新编码。
      // 否则「压到 1 MB」一张 300 KB 的图，反而会拿到一张更大的 q=100。
      if (state.size <= targetBytes && state.sourceFormat === state.formatId) {
        state.result = {
          blob: state.file,
          bytes: state.size,
          beforeBytes: state.size,
          width: state.width,
          height: state.height,
          quality: 0,
          original: true,
          scaled: false,
          targetBytes: targetBytes,
          formatId: state.formatId,
          requestedFormatId: state.formatId
        };
        setStatus('');
        renderResult();
        return;
      }

      compressToTarget(targetBytes, isCurrent).then(function (found) {
        if (!isCurrent()) return;
        if (!found) {
          state.result = null;
          setStatus(S.err_encode.replace('{reason}', 'the picture could not be made small enough'), true);
          renderResult();
          return;
        }
        var out = found.out;
        state.result = {
          blob: out.blob,
          bytes: found.bytes,
          beforeBytes: state.size,
          width: found.width,
          height: found.height,
          quality: found.quality,
          original: false,
          scaled: found.scaled,
          scaledToFit: out.scaledToFit,
          targetBytes: targetBytes,
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

          if (state.originalUrl) {
            URL.revokeObjectURL(state.originalUrl);
            state.originalUrl = '';
          }
          state.originalUrl = URL.createObjectURL(file);

          upload.setStatus('');
          settingsCard.hidden = false;
          resultCard.hidden = false;
          refreshFormatHint();
          recompute();
        }, function () {
          if (disposed) return;
          upload.setStatus(S.err_decode, true);
          settingsCard.hidden = true;
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

    formatSelect.addEventListener('change', function () {
      state.formatId = formatSelect.value;
      refreshFormatHint();
      recompute();
    });

    unitSelect.addEventListener('change', function () {
      state.targetUnit = unitSelect.value;
      recompute();
    });

    /** 目标大小输入：防抖之后再搜 —— 一次搜索要编码七八次。 */
    function scheduleRecompute() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        recompute();
      }, TARGET_DEBOUNCE_MS);
    }

    targetInput.addEventListener('input', function () {
      state.targetValue = targetInput.value;
      scheduleRecompute();
    });
    targetInput.addEventListener('change', function () {
      state.targetValue = targetInput.value;
      recompute();
    });

    return {
      destroy: function () {
        disposed = true;
        ticket++;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
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

  window.ItTools.logic['image-compress-to-size'] = {
    parseTargetSize: parseTargetSize,
    areaRatio: areaRatio,
    scaledSize: scaledSize,
    targetSuffix: targetSuffix,

    __cases: function (assert) {
      /* ---- 目标大小 ---- */

      assert.eq(parseTargetSize('100', 'KB'), 102400, '100 KB');
      assert.eq(parseTargetSize('1', 'MB'), 1048576, '1 MB');
      assert.eq(parseTargetSize('1.5', 'MB'), 1572864, '1.5 MB');
      assert.eq(parseTargetSize(' 100 ', 'KB'), 102400, '前后有空格也要认');
      assert.eq(parseTargetSize('0', 'KB'), null, '0 不是合法目标');
      assert.eq(parseTargetSize('-5', 'KB'), null, '负数不是合法目标');
      assert.eq(parseTargetSize('', 'KB'), null, '空的不是合法目标');
      assert.eq(parseTargetSize('abc', 'KB'), null, '不是数字就不是合法目标');
      assert.eq(parseTargetSize(null, 'KB'), null, 'null 不是合法目标');
      assert.eq(parseTargetSize(undefined, 'MB'), null, 'undefined 不是合法目标');
      assert.eq(parseTargetSize('0.5', 'KB'), 512, '0.5 KB');

      /* ---- 面积比例 ---- */

      assert.eq(areaRatio(100000, 10000), 0.31622776601683794, '压到十分之一 → 边长约 0.316');
      assert.eq(areaRatio(10000, 100000), 3.1622776601683795, '放大十倍 → 边长约 3.16');
      assert.eq(areaRatio(10000, 10000), 1, '一样大 → 比例 1');
      assert.eq(areaRatio(0, 10000), 1, '当前体积是 0 → 不缩');
      assert.eq(areaRatio(10000, 0), 1, '目标体积是 0 → 不缩');

      /* ---- 缩尺寸 ---- */

      assert.eq(scaledSize(1000, 500, 0.5), { width: 500, height: 250 }, '等比缩一半');
      assert.eq(scaledSize(1000, 500, 2), { width: 2000, height: 1000 }, '等比放大');
      assert.eq(scaledSize(3, 3, 0.01), { width: 1, height: 1 }, '再小也留一个像素');
      assert.eq(scaledSize(1, 1, 0.5), { width: 1, height: 1 }, '一像素的图缩不动');

      /* ---- 文件名后缀 ---- */

      assert.eq(targetSuffix(102400), '100kb', '100 KB');
      assert.eq(targetSuffix(1048576), '1mb', '1 MB');
      assert.eq(targetSuffix(1572864), '1.5mb', '1.5 MB');
      assert.eq(targetSuffix(512), '1kb', '不到 1 KB 也叫 1kb');

      /* ---- 可压的格式 ---- */

      var lossy = window.ItTools.imageCodec.FORMATS.filter(function (f) { return f.lossy; });
      assert.eq(lossy.length, 2, '只有 JPEG 和 WebP 能压到目标大小');
      assert(lossy.every(function (f) { return f.id === 'jpeg' || f.id === 'webp'; }), '有损的两种正是 JPEG 与 WebP');
    }
  };
}());
