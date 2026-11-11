/* ==========================================================================
   图片滤镜（image-filters）

   调亮度、对比度、饱和度、灰度、反色、模糊、黑白，实时预览，然后导出。

   这个工具的核心不是界面，是底下那条像素流水线。四件事必须做对：

   - **一次只取一次整**。亮度、对比度、饱和度这些都在 0..255 的浮点里算，
     中间不取整 —— 每层都四舍五入一次，三层下来颜色就飘了。
     最后写进画布之前才统一取一次整。

   - **模糊不能把透明区域的颜色渗进不透明区域**。画布的内部存储是**预乘**
     的：全透明的像素里 RGB 其实是 0。直接平均四通道，透明处的黑色会渗到
     旁边，边缘发黑。所以模糊前先预乘（颜色乘上 alpha），模糊完再还原。

   - **大图不能一次性读像素**。整张 12 MP 的图 getImageData 一次要 48 MB，
     再加一份模糊的暂存就 96 MB。所以按横向的带处理，每带只读一小块。

   - **分带的晕圈必须够大**。模糊跑 3 趟（一趟 ±r，两趟 ±2r，三趟 ±3r），
     带里的行最终依赖上下各 3r 行的内容。晕圈给少了，接缝处会拿带内部
     的行去补 —— 那不是「有一条缝」，是**每一带都错**。

   - **两个方向的边界口径必须一样**：都是「把图按边缘像素无限延拓，再卷积」。
     纵向靠暂存画布上下那两段晕圈（复制边缘行）实现，横向靠缓冲区左右
     各 3r 列（复制边缘列）实现。延拓**只做一次**，三趟模糊都在延拓后的
     缓冲上跑 —— 每一趟都重新延拓一遍的话，每一趟都在「已经模糊过的值」
     上再做一次边缘复制，结果跟「先延拓再卷积」不是一回事。

   滤镜的顺序是固定的：模糊 → 亮度 → 对比度 → 饱和度 → 灰度 → 黑白 → 反色。
   模糊是空间上的操作必须最先；黑白是二值化必须在灰度之后；反色放最后。
   这个顺序写在界面上，不让用户猜。

   一个滤镜都没生效时走快路：源图直接画进结果画布，一个像素都不碰。

   图片一个字节都不出浏览器：解码、过滤、编码全在本地完成。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-filters');

  /** 预览画布的最长边 —— 预览只是给人看的，没必要按原图像素开画布。 */
  var PREVIEW_MAX = 640;

  /**
   * 一带能占多少像素。
   *
   * 暂存是浮点的（RGBA 四个通道各一个 float），1 M 像素就是 16 MB。
   * 预算要管住**整个暂存**（含上下两段晕圈），所以真正的带高要减掉晕圈。
   */
  var BUDGET_PIXELS = 1048576;

  /** 浏览器画布的上限：每边 32767、总面积 268435456（约 2.68 亿像素）。 */
  var MAX_CANVAS_SIDE = 32767;
  var MAX_CANVAS_AREA = 268435456;

  /** 模糊跑几趟。三趟盒式模糊叠起来接近高斯，单趟会看出方块状的台阶。 */
  var BLUR_PASSES = 3;

  /** 预览的防抖毫秒。预览很便宜，改滑块时跟手一点。 */
  var PREVIEW_DEBOUNCE_MS = 80;

  /** 导出的防抖毫秒。全分辨率要跑像素循环，等用户停手再算。 */
  var EXPORT_DEBOUNCE_MS = 350;

  var S = {
    title: t('title', 'Apply filters to an image'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.'),
    filters_title: t('filters_title', 'Filters'),
    preset_title: t('preset_title', 'Presets'),
    preset_original: t('preset_original', 'Original'),
    preset_grayscale: t('preset_grayscale', 'Grayscale'),
    preset_invert: t('preset_invert', 'Invert'),
    preset_bw: t('preset_bw', 'Black and white'),
    preset_soft: t('preset_soft', 'Soft'),
    preset_vivid: t('preset_vivid', 'Vivid'),
    label_brightness: t('label_brightness', 'Brightness'),
    label_contrast: t('label_contrast', 'Contrast'),
    label_saturation: t('label_saturation', 'Saturation'),
    label_grayscale: t('label_grayscale', 'Grayscale'),
    label_blur: t('label_blur', 'Blur'),
    label_threshold: t('label_threshold', 'Threshold'),
    label_invert: t('label_invert', 'Invert'),
    label_bw: t('label_bw', 'Black and white'),
    hint_brightness: t('hint_brightness', 'Brightens or darkens the whole picture. -100 is black, 0 leaves it as it is, 100 doubles every channel.'),
    hint_contrast: t('hint_contrast', 'Pushes the colours apart or pulls them together around the middle grey. -100 is flat grey, 0 changes nothing.'),
    hint_saturation: t('hint_saturation', 'Adds or removes colour intensity. -100 turns the picture grey, 100 doubles the intensity.'),
    hint_grayscale: t('hint_grayscale', 'Mixes the picture towards grey. 0 keeps the colours, 100 is fully grey.'),
    hint_blur: t('hint_blur', 'The blur strength in pixels of the full-size picture, the same as the blur() function in CSS. The picture is blurred in three box passes, which is close to a Gaussian.'),
    hint_threshold: t('hint_threshold', 'Turns the picture into pure black and white. Every pixel darker than the threshold becomes black.'),
    hint_order: t('hint_order', 'The filters always run in this order: blur, brightness, contrast, saturation, grayscale, black and white, invert.'),
    label_format: t('label_format', 'Output format'),
    label_quality: t('label_quality', 'Quality'),
    hint_quality: t('hint_quality', 'PNG is lossless — the quality setting does not change it.'),
    label_matte: t('label_matte', 'Matte colour'),
    hint_matte: t('hint_matte', 'Only JPEG needs a matte: it has no transparency, so the transparent areas are filled with this colour.'),
    preview_title: t('preview_title', 'Preview'),
    hint_preview: t('hint_preview', 'The preview is smaller than the export, so a blur that is only a few pixels wide cannot be seen here.'),
    result_title: t('result_title', 'Result'),
    label_item: t('label_item', 'Item'),
    label_value: t('label_value', 'Value'),
    label_source_size: t('label_source_size', 'Original size'),
    label_output_size: t('label_output_size', 'Output size'),
    label_file_size: t('label_file_size', 'File size'),
    label_output_format: t('label_output_format', 'Saved as'),
    label_adjustments: t('label_adjustments', 'Adjustments'),
    no_adjustments: t('no_adjustments', 'None'),
    no_result: t('no_result', 'No image yet.'),
    download: t('download', 'Download the filtered image'),
    status_reading: t('status_reading', 'Reading the file…'),
    status_filtering: t('status_filtering', 'Filtering the picture…'),
    status_encoding: t('status_encoding', 'Encoding…'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    err_canvas_limit: t('err_canvas_limit', 'A browser canvas cannot hold {width} × {height} pixels (the limit is {max} pixels per side and {area} megapixels in total), so nothing was encoded.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.'),
    warn_fallback: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.'),
    warn_scaled: t('warn_scaled', 'The browser could not allocate a canvas of {width} × {height}, so the image was saved at {actualWidth} × {actualHeight}.')
  };

  /* ---------- 纯逻辑（与画布无关，node 里能直接跑） ---------- */

  /**
   * 把一个数夹进区间。
   *
   * 不是数字就退回 lo —— 调用方多半自己还会兜一道，这里只管夹范围。
   *
   * @param {*} v
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  function clampNum(v, lo, hi) {
    var n = Number(v);
    if (!isFinite(n)) return lo;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /**
   * 亮度（人眼觉得的明暗）。
   *
   * 系数取自 CSS filter 规范：0.2126 / 0.7152 / 0.0722。
   * ImageMagick 的 Rec709 是 0.2125 / 0.7154 / 0.0721 —— 差在第 4 位小数上，
   * 这里跟 CSS 走，界面上的其它滤镜也是 CSS 的口径。
   *
   * @param {number} r 0..255
   * @param {number} g 0..255
   * @param {number} b 0..255
   * @returns {number} 0..255
   */
  function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * 亮度系数。滑块 −100..100 → 系数 0..2。
   *
   * 不是 1 + v/100 之外的算法：−100 全黑、0 不动、+100 两倍，
   * 跟 CSS 的 brightness() 一个口径，用户不用猜「−50 是减 50% 还是变成 50%」。
   *
   * @param {number} v
   * @returns {number}
   */
  function brightnessFactor(v) {
    var n = Number(v);
    if (!isFinite(n)) return 1;
    return 1 + clampNum(n, -100, 100) / 100;
  }

  /**
   * 对比度系数。口径跟亮度一样：−100 变成一片中灰（0.5），0 不动，+100 两倍。
   *
   * @param {number} v
   * @returns {number}
   */
  function contrastFactor(v) {
    var n = Number(v);
    if (!isFinite(n)) return 1;
    return 1 + clampNum(n, -100, 100) / 100;
  }

  /**
   * 饱和度系数。−100 变灰（系数 0），0 不动，+100 两倍。
   *
   * @param {number} v
   * @returns {number}
   */
  function saturationFactor(v) {
    var n = Number(v);
    if (!isFinite(n)) return 1;
    return 1 + clampNum(n, -100, 100) / 100;
  }

  /**
   * 灰度混合比例。0 保持原样，100 完全变灰。
   *
   * @param {number} v
   * @returns {number} 0..1
   */
  function grayscaleMix(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return clampNum(n, 0, 100) / 100;
  }

  /**
   * 夹到 0..255（浮点，不取整）。
   *
   * @param {number} v
   * @returns {number}
   */
  function clampChannel(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 255) return 255;
    return n;
  }

  /**
   * 夹到 0..255 并取整。整条流水线上只在这里取一次整。
   *
   * @param {number} v
   * @returns {number}
   */
  function roundChannel(v) {
    return Math.round(clampChannel(v));
  }

  /**
   * 取一个滑块的值：没给、不是数字就用默认值。
   *
   * 不能直接用 clampNum —— 它的「不是数字就退回区间下界」对滑块是错的：
   * 亮度缺省应该是 0（不动），退回下界 −100 就变成「全黑」了。
   *
   * @param {*} v
   * @param {number} fallback 缺省值
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  function sliderValue(v, fallback, lo, hi) {
    if (v === undefined || v === null || v === '') return fallback;
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    return clampNum(n, lo, hi);
  }

  /**
   * 把一组滑块值编译成「算的时候直接用」的参数。
   *
   * 逐像素的循环里每次都现算系数是浪费 —— 系数只在参数变了的时候才变，
   * 所以先算好，循环里只读。
   *
   * @param {object} f 原始参数
   * @returns {object} 编译后的参数
   */
  function compileFilters(f) {
    var src = f || {};
    return {
      brightness: sliderValue(src.brightness, 0, -100, 100),
      contrast: sliderValue(src.contrast, 0, -100, 100),
      saturation: sliderValue(src.saturation, 0, -100, 100),
      grayscale: sliderValue(src.grayscale, 0, 0, 100),
      invert: !!src.invert,
      blur: sliderValue(src.blur, 0, 0, 20),
      thresholdOn: !!src.thresholdOn,
      threshold: sliderValue(src.threshold, 128, 0, 255),
      bf: brightnessFactor(src.brightness),
      cf: contrastFactor(src.contrast),
      sf: saturationFactor(src.saturation),
      gf: grayscaleMix(src.grayscale)
    };
  }

  /**
   * 除模糊以外的全部上色运算。
   *
   * 顺序固定：亮度 → 对比度 → 饱和度 → 灰度 → 黑白 → 反色。
   * 每一层用的都是**当前**的像素值（上一层已经改过 RGB 了）。
   *
   * @param {number} r 0..255
   * @param {number} g 0..255
   * @param {number} b 0..255
   * @param {object} f 编译后的参数
   * @param {number[]} [out] 写进哪个数组（不给就新建一个）
   * @returns {number[]} [r, g, b]，0..255 的整数
   */
  function applyTone(r, g, b, f, out) {
    var res = out || [0, 0, 0];
    var c0 = r, c1 = g, c2 = b;
    var lum, v, i;

    if (f.bf !== 1) {
      c0 *= f.bf; c1 *= f.bf; c2 *= f.bf;
    }
    if (f.cf !== 1) {
      c0 = (c0 - 127.5) * f.cf + 127.5;
      c1 = (c1 - 127.5) * f.cf + 127.5;
      c2 = (c2 - 127.5) * f.cf + 127.5;
    }
    if (f.sf !== 1) {
      lum = luminance(c0, c1, c2);
      c0 = lum + (c0 - lum) * f.sf;
      c1 = lum + (c1 - lum) * f.sf;
      c2 = lum + (c2 - lum) * f.sf;
    }
    if (f.gf > 0) {
      lum = luminance(c0, c1, c2);
      c0 += (lum - c0) * f.gf;
      c1 += (lum - c1) * f.gf;
      c2 += (lum - c2) * f.gf;
    }
    if (f.thresholdOn) {
      lum = luminance(c0, c1, c2);
      v = lum >= f.threshold ? 255 : 0;
      c0 = c1 = c2 = v;
    }
    if (f.invert) {
      c0 = 255 - c0; c1 = 255 - c1; c2 = 255 - c2;
    }

    res[0] = roundChannel(c0);
    res[1] = roundChannel(c1);
    res[2] = roundChannel(c2);
    return res;
  }

  /**
   * 一个滤镜都没生效吗。
   *
   * 没生效就走快路：一个像素都不碰，导出来的图跟源图逐像素相同。
   *
   * @param {object} f 编译后的参数
   * @returns {boolean}
   */
  function isNeutral(f) {
    if (!f) return true;
    return f.brightness === 0 && f.contrast === 0 && f.saturation === 0 &&
      f.grayscale === 0 && f.blur === 0 && !f.invert && !f.thresholdOn;
  }

  /**
   * 模糊的内部半径。
   *
   * 滑块的值就是半径（0..20），跟 CSS 的 blur(Npx) 一样是标准差的口径。
   *
   * @param {number} r
   * @returns {number}
   */
  function blurRadius(r) {
    return Math.round(clampNum(r, 0, 20));
  }

  /**
   * 分带时上下各要留多少行真上下文。
   *
   * 模糊跑 BLUR_PASSES 趟，支持范围是 ±(趟数 × 半径)。
   * 晕圈给少了，带里的行最终会读到带内部的行 —— 每一带都错，不是「有接缝」。
   *
   * 同一个数也用来横向延拓：左右各 halo 列复制边缘列。
   *
   * @param {number} q 半径
   * @returns {number}
   */
  function haloFor(q) {
    return BLUR_PASSES * Math.max(0, Math.round(Number(q) || 0));
  }

  /**
   * 预览里的模糊半径。
   *
   * 预览是缩小的，模糊也得跟着缩，否则大图上 4 像素的模糊在预览里根本
   * 看不出来。但**不能**把 0 抬成 1：预览缩到三十分之一时，半径 1 会变成
   * 30 像素，比导出糊得多。宁可「小模糊在预览里看不出来」。
   *
   * @param {number} r 滑块值（原图半径）
   * @param {number} scale 预览相对原图的缩放比
   * @returns {number} 0..20
   */
  function previewBlurRadius(r, scale) {
    var q = blurRadius(r);
    if (q <= 0) return 0;
    var s = Number(scale);
    if (!isFinite(s) || s <= 0) return 0;
    var v = Math.round(q * s);
    if (v < 0) return 0;
    if (v > 20) return 20;
    return v;
  }

  /**
   * 把下标夹进 [0, n-1]。
   *
   * @param {number} i
   * @param {number} n
   * @returns {number}
   */
  function clampIdx(i, n) {
    if (i < 0) return 0;
    if (i >= n) return n - 1;
    return i;
  }

  /**
   * 一维盒式模糊（滑窗）。
   *
   * 越界的下标取数组边缘那个像素，窗口大小仍然算 2q+1（重复的算进去）。
   * 窗口大小必须恒定 —— 边缘上按「有效样本数」归一的话，颜色和 alpha
   * 的除数就不一样了，预乘那一套就废了。
   *
   * 注意：这个函数里的「边缘」是**调用方给的那份数组**的边缘。
   * 想要「把图按边缘像素无限延拓再卷积」的效果，调用方必须先把数组
   * 延拓开（三趟模糊共用同一份延拓好的数组）—— 每一趟都重新延拓一遍，
   * 等于每一趟都在已经模糊过的值上再做一次边缘复制，结果对不上。
   *
   * 滑窗：每前进一步减掉左边那个、加上右边那个，所以是 O(n)，
   * 跟半径多大没关系。
   *
   * @param {Float64Array|number[]} src
   * @param {number} n 元素个数
   * @param {number} q 半径
   * @param {Float64Array|number[]} [out] 写进哪个数组
   * @returns {Float64Array|number[]}
   */
  function boxBlur1d(src, n, q, out) {
    var dst = out || new Float64Array(n);
    var i, k, sum, win;
    if (q <= 0) {
      for (i = 0; i < n; i++) dst[i] = src[i];
      return dst;
    }
    win = 2 * q + 1;
    sum = 0;
    for (k = -q; k <= q; k++) sum += src[clampIdx(k, n)];
    for (i = 0; i < n; i++) {
      dst[i] = sum / win;
      sum -= src[clampIdx(i - q, n)];
      sum += src[clampIdx(i + q + 1, n)];
    }
    return dst;
  }

  /**
   * 把一带的像素读进缓冲区：纵向延拓 + 横向延拓 + 预乘。
   *
   * 纵向延拓：顶上 padTop 行复制第一行，底下 padBottom 行复制最后一行。
   * 横向延拓：左右各 halo 列复制边缘列（真实列落在 [halo, halo+w)）。
   * 预乘：颜色乘上 alpha —— 画布的内部存储就是预乘的，全透明的像素里
   * RGB 其实是 0；不预乘直接平均，透明处的黑色会渗进旁边，边缘发黑。
   *
   * 延拓在这里**只做一次**：三趟模糊都在这份延拓好的缓冲上跑。
   *
   * @param {Uint8ClampedArray|number[]} px 暂存画布读出来的像素（真实行）
   * @param {number} realRows 真实行数
   * @param {number} w 一行有多少个像素
   * @param {number} halo 左右各延拓多少列
   * @param {number} padTop 顶上补几行
   * @param {number} padBottom 底下补几行
   * @param {Float32Array} out 缓冲区
   */
  function readBand(px, realRows, w, halo, padTop, padBottom, out) {
    var usedRows = padTop + realRows + padBottom;
    var bufW = w + 2 * halo;
    var y, x, sx, sy, o, i, a;
    for (y = 0; y < usedRows; y++) {
      // 纵向：晕圈复制边缘行
      sy = y < padTop ? 0 : (y >= padTop + realRows ? realRows - 1 : y - padTop);
      for (x = 0; x < bufW; x++) {
        // 横向：晕圈复制边缘列
        sx = x < halo ? 0 : (x >= halo + w ? w - 1 : x - halo);
        o = (sy * w + sx) * 4;
        a = px[o + 3];
        i = (y * bufW + x) * 4;
        out[i] = px[o] * a / 255;
        out[i + 1] = px[o + 1] * a / 255;
        out[i + 2] = px[o + 2] * a / 255;
        out[i + 3] = a;
      }
    }
  }

  /**
   * 生效的调整，写成一行人话给结果表用。
   *
   * @param {object} f 编译后的参数
   * @returns {string}
   */
  function summarize(f) {
    var parts = [];
    if (!f) return S.no_adjustments;
    if (f.brightness) parts.push(S.label_brightness + ' ' + (f.brightness > 0 ? '+' : '') + f.brightness);
    if (f.contrast) parts.push(S.label_contrast + ' ' + (f.contrast > 0 ? '+' : '') + f.contrast);
    if (f.saturation) parts.push(S.label_saturation + ' ' + (f.saturation > 0 ? '+' : '') + f.saturation);
    if (f.grayscale) parts.push(S.label_grayscale + ' ' + f.grayscale);
    if (f.blur) parts.push(S.label_blur + ' ' + f.blur);
    if (f.thresholdOn) parts.push(S.label_bw + ' ' + f.threshold);
    if (f.invert) parts.push(S.label_invert);
    return parts.length ? parts.join(' · ') : S.no_adjustments;
  }

  /**
   * 目标尺寸是不是浏览器画布吃得下的。
   *
   * 吃不下就别编码：内核遇到画布分配失败会自己把长宽减半重试，
   * 那样下载到的图就不是用户要的那张了 —— 不如报错。
   *
   * @param {number} w
   * @param {number} h
   * @returns {{ok: boolean, reason: string}} reason: '' | 'size' | 'side' | 'area'
   */
  function canvasLimit(w, h) {
    var width = Math.round(Number(w) || 0);
    var height = Math.round(Number(h) || 0);
    if (width <= 0 || height <= 0) return { ok: false, reason: 'size' };
    if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_AREA / width) return { ok: false, reason: 'side' };
    if (width * height > MAX_CANVAS_AREA) return { ok: false, reason: 'area' };
    return { ok: true, reason: '' };
  }

  /* ---------- 画布上的活 ---------- */

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

  /**
   * 把源图缩到指定尺寸，画到一张新画布上。
   *
   * 预览走这条路：先缩小，再在缩小的图上跑滤镜（模糊半径也按比例缩）。
   *
   * @param {*} source 可画的东西（ImageBitmap / <img> / 画布）
   * @param {number} tw
   * @param {number} th
   * @returns {HTMLCanvasElement}
   */
  function makeScaledCanvas(source, tw, th) {
    var c = makeCanvas(tw, th);
    var ctx = c.getContext('2d');
    if (!ctx) return c;
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  /**
   * 横向模糊一趟：每一行、每一个通道各滑一次窗。
   *
   * @param {Float32Array} buf
   * @param {number} w
   * @param {number} rows
   * @param {number} q
   * @param {Float64Array} tmpA
   * @param {Float64Array} tmpB
   */
  function blurRows(buf, w, rows, q, tmpA, tmpB) {
    var y, c, x, base;
    for (y = 0; y < rows; y++) {
      base = y * w * 4;
      for (c = 0; c < 4; c++) {
        for (x = 0; x < w; x++) tmpA[x] = buf[base + x * 4 + c];
        boxBlur1d(tmpA, w, q, tmpB);
        for (x = 0; x < w; x++) buf[base + x * 4 + c] = tmpB[x];
      }
    }
  }

  /**
   * 纵向模糊一趟：每一列、每一个通道各滑一次窗。
   *
   * @param {Float32Array} buf
   * @param {number} w
   * @param {number} rows
   * @param {number} q
   * @param {Float64Array} tmpA
   * @param {Float64Array} tmpB
   */
  function blurCols(buf, w, rows, q, tmpA, tmpB) {
    var x, c, y, o;
    for (x = 0; x < w; x++) {
      for (c = 0; c < 4; c++) {
        for (y = 0; y < rows; y++) {
          o = (y * w + x) * 4 + c;
          tmpA[y] = buf[o];
        }
        boxBlur1d(tmpA, rows, q, tmpB);
        for (y = 0; y < rows; y++) {
          o = (y * w + x) * 4 + c;
          buf[o] = tmpB[y];
        }
      }
    }
  }

  /**
   * 造一个「把图过滤一遍」的引擎。
   *
   * 引擎可以分带推进：processBand(i) 处理第 i 带，全部处理完以后
   * done() 交出结果画布。界面里的导出在两带之间让一让主线程，
   * 页面不会卡住；单测和端到端用同步的 renderFiltered 一次跑完。
   *
   * @param {*} source 可画的东西，尺寸必须正好是 w × h
   * @param {number} w
   * @param {number} h
   * @param {object} f 编译后的参数
   * @param {number} [budget] 一带能占多少像素
   * @returns {object} 引擎
   */
  function createFilterEngine(source, w, h, f, budget) {
    var out = makeCanvas(w, h);
    var outCtx = out.getContext('2d');
    var q = blurRadius(f.blur);
    var halo = haloFor(q);

    // 一个滤镜都没生效 → 源图直接画进结果画布，一个像素都不碰。
    if (isNeutral(f)) {
      if (outCtx) outCtx.drawImage(source, 0, 0);
      return {
        neutral: true,
        bandCount: 0,
        bandHeight: h,
        processBand: function () {},
        done: function () { return out; }
      };
    }

    // 预算要管住整个暂存（含上下两段晕圈），所以带高要先减掉晕圈。
    // 横向的晕圈也算在预算里 —— 缓冲区比图宽 2×halo 列。
    var budgetPx = budget || BUDGET_PIXELS;
    var bufW = w + 2 * halo;
    var bandHeight = Math.min(h, Math.max(1, Math.floor(budgetPx / bufW) - 2 * halo));
    var bandCount = Math.ceil(h / bandHeight);

    var scratchRows = bandHeight + 2 * halo;
    var scratch = makeCanvas(w, scratchRows);
    var scratchCtx = scratch.getContext('2d');
    var buf = new Float32Array(bufW * scratchRows * 4);
    var tmpA = new Float64Array(Math.max(bufW, scratchRows));
    var tmpB = new Float64Array(Math.max(bufW, scratchRows));
    var tone = [0, 0, 0];

    /**
     * 处理第 index 带。
     *
     * @param {number} index
     */
    function processBand(index) {
      var y0 = index * bandHeight;
      var bandLen = Math.min(bandHeight, h - y0);

      // 这一带要装的源图行：[y0-halo, y0+bandLen+halo)
      var srcTop = y0 - halo;
      var srcBot = y0 + bandLen + halo;
      var realTop = Math.max(0, srcTop);
      var realBot = Math.min(h, srcBot);
      var padTop = realTop - srcTop;          // 顶上补几行（复制边缘行）
      var realRows = realBot - realTop;       // 中间是真实的行
      var bottomPad = srcBot - realBot;       // 底下补几行（复制边缘行）
      var usedRows = padTop + realRows + bottomPad;
      var bandStart = padTop + (y0 - realTop); // 带内的行在暂存里的位置

      // 每一带都把暂存重画一遍，不留上一带的残像素。
      //
      // 先清空是必须的：drawImage 默认是 source-over —— 画到**不透明**的旧内容上，
      // 源图里的透明像素会跟旧内容混在一起。上一带的不透明像素会从透明的地方
      // 渗进来，分带的结果就跟整张图一次性处理的不一样了。
      //
      // 暂存里只画**真实行**，而且是 1:1 画（不缩放）。
      // 晕圈不靠 drawImage 补：把一行源图拉成多行，浏览器的双线性滤波会
      // 把相邻的行也采进来 —— 晕圈里混进别的行，模糊出来的边缘就是错的。
      // 晕圈在缓冲区里补（复制边缘行/列），一个字节都不差。
      scratchCtx.clearRect(0, 0, w, scratchRows);
      if (realRows > 0) {
        scratchCtx.drawImage(source, 0, realTop, w, realRows, 0, 0, w, realRows);
      }

      var img = scratchCtx.getImageData(0, 0, w, realRows);
      var px = img.data;

      // 读成浮点并预乘，同时把上下左右都延拓开。
      //
      // 两个方向的边界口径必须一样（都是「复制边缘之后卷积」），
      // 不然左右边缘和上下边缘的模糊结果会差出一截。
      //
      // 延拓只做这一次：接下来三趟模糊都在这份延拓过的缓冲上跑。
      readBand(px, realRows, w, halo, padTop, bottomPad, buf);

      if (q > 0) {
        var pass;
        for (pass = 0; pass < BLUR_PASSES; pass++) {
          blurRows(buf, bufW, usedRows, q, tmpA, tmpB);
          blurCols(buf, bufW, usedRows, q, tmpA, tmpB);
        }
      }

      // 还原（预乘的逆）→ 上色 → 取整 → 写进结果画布。
      var outImg = outCtx.createImageData(w, bandLen);
      var dst = outImg.data;
      var row, xx, so, dof, al, r, g, b;
      for (row = 0; row < bandLen; row++) {
        so = ((bandStart + row) * bufW) * 4;
        dof = (row * w) * 4;
        for (xx = 0; xx < w; xx++) {
          var s = so + (halo + xx) * 4;
          var d = dof + xx * 4;
          al = buf[s + 3];
          if (al > 0) {
            r = buf[s] * 255 / al;
            g = buf[s + 1] * 255 / al;
            b = buf[s + 2] * 255 / al;
          } else {
            r = g = b = 0;
          }
          applyTone(r, g, b, f, tone);
          dst[d] = tone[0];
          dst[d + 1] = tone[1];
          dst[d + 2] = tone[2];
          dst[d + 3] = al;
        }
      }
      outCtx.putImageData(outImg, 0, y0);
    }

    return {
      neutral: false,
      bandCount: bandCount,
      bandHeight: bandHeight,
      processBand: processBand,
      done: function () { return out; }
    };
  }

  /**
   * 同步地把图过滤一遍，返回结果画布。
   *
   * @param {*} source 可画的东西，尺寸必须正好是 w × h
   * @param {number} w
   * @param {number} h
   * @param {object} f 编译后的参数
   * @param {number} [budget]
   * @returns {HTMLCanvasElement}
   */
  function renderFiltered(source, w, h, f, budget) {
    var engine = createFilterEngine(source, w, h, f, budget);
    var i;
    for (i = 0; i < engine.bandCount; i++) engine.processBand(i);
    return engine.done();
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('image-filters', function (root) {
    var disposed = false;
    /** 竞态闸门。慢的那次算完了不许盖掉快的那次的结果。 */
    var ticket = 0;
    var previewTimer = null;
    var exportTimer = null;

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
      /** 滑块的原始值。 */
      raw: {
        brightness: 0, contrast: 0, saturation: 0, grayscale: 0,
        invert: false, blur: 0, thresholdOn: false, threshold: 128
      },
      /** 编译后的参数（逐像素循环里直接读）。 */
      filters: compileFilters({}),
      formatId: 'png',
      quality: 90,
      matte: '#ffffff',
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

    var filtersCard = D.h('div.card', { hidden: true });
    var previewCard = D.h('div.card', { hidden: true });
    var outputCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(filtersCard);
    root.appendChild(previewCard);
    root.appendChild(outputCard);
    root.appendChild(resultCard);

    /* ---------- 滤镜控件 ---------- */

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
        /** 把值写回控件（预设切换时用）。值一样就不写，免得打断正在拖的手。 */
        set: function (v) {
          var s = String(v);
          if (input.value !== s) input.value = s;
          label.textContent = labelText + ': ' + v;
        }
      };
    }

    var brightness = makeSlider('filter-brightness', S.label_brightness, -100, 100, 0,
      S.hint_brightness, function (v) { state.raw.brightness = v; onFilterChange(); });
    var contrast = makeSlider('filter-contrast', S.label_contrast, -100, 100, 0,
      S.hint_contrast, function (v) { state.raw.contrast = v; onFilterChange(); });
    var saturation = makeSlider('filter-saturation', S.label_saturation, -100, 100, 0,
      S.hint_saturation, function (v) { state.raw.saturation = v; onFilterChange(); });
    var grayscale = makeSlider('filter-grayscale', S.label_grayscale, 0, 100, 0,
      S.hint_grayscale, function (v) { state.raw.grayscale = v; onFilterChange(); });
    var blur = makeSlider('filter-blur', S.label_blur, 0, 20, 0,
      S.hint_blur, function (v) { state.raw.blur = v; onFilterChange(); });
    var threshold = makeSlider('filter-threshold', S.label_threshold, 0, 255, 128,
      S.hint_threshold, function (v) { state.raw.threshold = v; onFilterChange(); });

    var invertInput = D.h('input', { type: 'checkbox' });
    invertInput.addEventListener('change', function () {
      state.raw.invert = invertInput.checked;
      onFilterChange();
    });
    var bwInput = D.h('input', { type: 'checkbox' });
    bwInput.addEventListener('change', function () {
      state.raw.thresholdOn = bwInput.checked;
      threshold.input.disabled = !bwInput.checked;
      onFilterChange();
    });

    var switches = D.h('div.switch-grid', null,
      D.h('label.switch', null, invertInput, D.h('span', { text: S.label_invert })),
      D.h('label.switch', null, bwInput, D.h('span', { text: S.label_bw }))
    );

    /** 预设。六个都能用上面的原语精确表达，不塞靠魔法数字凑出来的滤镜。 */
    var PRESETS = [
      { id: 'original', key: 'preset_original', values: {} },
      { id: 'grayscale', key: 'preset_grayscale', values: { grayscale: 100 } },
      { id: 'invert', key: 'preset_invert', values: { invert: true } },
      { id: 'bw', key: 'preset_bw', values: { thresholdOn: true, threshold: 128 } },
      { id: 'soft', key: 'preset_soft', values: { brightness: 12, contrast: -12, saturation: -15 } },
      { id: 'vivid', key: 'preset_vivid', values: { brightness: 5, contrast: 18, saturation: 35 } }
    ];

    var presetButtons = [];
    var presetRow = D.h('div.form-actions');
    PRESETS.forEach(function (preset) {
      var btn = D.h('button.layui-btn.layui-btn-primary', {
        type: 'button', text: S[preset.key]
      });
      btn.addEventListener('click', function () {
        applyPreset(preset);
      });
      presetButtons.push({ preset: preset, button: btn });
      presetRow.appendChild(btn);
    });

    filtersCard.appendChild(D.h('h3', { text: S.filters_title }));
    filtersCard.appendChild(D.h('p.field-label', { text: S.preset_title }));
    filtersCard.appendChild(presetRow);
    filtersCard.appendChild(D.h('div.grid', {
      style: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }
    },
      brightness.field,
      contrast.field,
      saturation.field,
      grayscale.field,
      blur.field,
      threshold.field
    ));
    filtersCard.appendChild(switches);
    filtersCard.appendChild(D.h('p.field-hint', { text: S.hint_order }));

    /* ---------- 输出 ---------- */

    var formatSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'png', text: 'PNG' }),
      D.h('option', { value: 'jpeg', text: 'JPEG' }),
      D.h('option', { value: 'webp', text: 'WebP' })
    );
    var qualityInput = D.h('input.slider', { type: 'range', min: 1, max: 100, step: 1, value: state.quality });
    var qualityHint = D.h('p.field-hint');
    var matteInput = D.h('input', { type: 'color', value: state.matte });
    var statusLine = D.h('p.form-status');

    outputCard.appendChild(D.h('h3', { text: S.label_format }));
    outputCard.appendChild(U.field(S.label_format, formatSelect));
    outputCard.appendChild(U.field(S.label_quality, qualityInput));
    outputCard.appendChild(qualityHint);
    outputCard.appendChild(U.field(S.label_matte, matteInput, { hint: S.hint_matte }));
    outputCard.appendChild(statusLine);

    /* ---------- 预览 ---------- */

    var previewCanvas = D.h('canvas');
    var previewSize = D.h('p.field-hint');
    previewCard.appendChild(D.h('h3', { text: S.preview_title }));
    previewCard.appendChild(D.h('div.preview-box', null, previewCanvas));
    previewCard.appendChild(previewSize);
    previewCard.appendChild(D.h('p.field-hint', { text: S.hint_preview }));

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

    /** 把滑块的状态写回控件。 */
    function syncControls() {
      brightness.set(state.raw.brightness);
      contrast.set(state.raw.contrast);
      saturation.set(state.raw.saturation);
      grayscale.set(state.raw.grayscale);
      blur.set(state.raw.blur);
      threshold.set(state.raw.threshold);
      if (invertInput.checked !== !!state.raw.invert) invertInput.checked = !!state.raw.invert;
      if (bwInput.checked !== !!state.raw.thresholdOn) bwInput.checked = !!state.raw.thresholdOn;
      threshold.input.disabled = !state.raw.thresholdOn;
    }

    /**
     * 应用一个预设。
     *
     * 预设是「整组参数」，所以先把其它预设的改动清掉再套上去 ——
     * 不然连点两个预设会把两个的设置叠在一起。
     *
     * @param {object} preset
     */
    function applyPreset(preset) {
      var base = {
        brightness: 0, contrast: 0, saturation: 0, grayscale: 0,
        invert: false, blur: 0, thresholdOn: false, threshold: 128
      };
      var values = preset.values || {};
      Object.keys(base).forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(values, key)) base[key] = values[key];
      });
      state.raw = base;
      syncControls();
      onFilterChange();
    }

    /** 滤镜参数变了：重新编译，然后预览与导出都重排一遍。 */
    function onFilterChange() {
      state.filters = compileFilters(state.raw);
      refresh();
    }

    /* ---------- 预览 ---------- */

    /** 预览的缩放比（1 表示不缩）。 */
    function previewScale() {
      if (!state.width || !state.height) return 1;
      return Math.min(1, PREVIEW_MAX / Math.max(state.width, state.height));
    }

    /** 预览用的滤镜：模糊半径按缩放比缩小。 */
    function previewFilters() {
      var f = compileFilters(state.raw);
      f.blur = previewBlurRadius(f.blur, previewScale());
      return f;
    }

    /** 重画预览。 */
    function renderPreview() {
      if (!state.decoded) return;
      var scale = previewScale();
      var pw = Math.max(1, Math.round(state.width * scale));
      var ph = Math.max(1, Math.round(state.height * scale));
      var small = makeScaledCanvas(state.decoded.source, pw, ph);
      var canvas = renderFiltered(small, pw, ph, previewFilters());
      if (previewCanvas.width !== pw || previewCanvas.height !== ph) {
        previewCanvas.width = pw;
        previewCanvas.height = ph;
      }
      var ctx = previewCanvas.getContext('2d');
      if (ctx) ctx.drawImage(canvas, 0, 0);
      previewSize.textContent = pw + ' × ' + ph + ' (' + state.width + ' × ' + state.height + ')';
    }

    /* ---------- 导出 ---------- */

    /**
     * 按当前设置导出一次。
     *
     * 分带处理，每带之间让一让主线程 —— 不然一张大图能把页面卡住好几秒，
     * 连进度条都来不及画。
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

      var engine;
      try {
        engine = createFilterEngine(state.decoded.source, state.width, state.height, state.filters, BUDGET_PIXELS);
      } catch (e) {
        state.result = null;
        setStatus(S.err_encode.replace('{reason}', function () {
          return String(e && e.message ? e.message : e);
        }), true);
        renderResult();
        return Promise.resolve();
      }

      var index = 0;

      /** 处理下一带。 */
      function step() {
        if (!isCurrent()) return Promise.resolve();
        if (index >= engine.bandCount) {
          setStatus(S.status_encoding);
          var canvas = engine.done();
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
        engine.processBand(index);
        index++;
        setStatus(S.status_filtering + ' ' + Math.round(index / engine.bandCount * 100) + '%');
        // 让出主线程，浏览器才有机会把进度画出来。
        return new Promise(function (resolve) {
          setTimeout(resolve, 0);
        }).then(step);
      }

      if (engine.bandCount === 0) {
        // 一个滤镜都没生效：没有带要处理，直接编码。
        setStatus(S.status_encoding);
        return C.encode({
          source: engine.done(),
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
      return step();
    }

    /* ---------- 结果 ---------- */

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
        { label: S.label_adjustments, value: summarize(state.filters) }
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
          C.outputName(state.name, fmt.ext, state.result.width + 'x' + state.result.height),
          state.result.blob,
          fmt.mime
        );
      });
      resultBody.appendChild(D.h('div.form-actions', null, downloadBtn));
    }

    /* ---------- 调度 ---------- */

    /** 滤镜或输出设置变了：预览（快）与导出（慢）各排一次。 */
    function refresh() {
      if (!state.decoded) return;
      var mine = ++ticket;
      var isCurrent = function () { return !disposed && mine === ticket; };

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

          // 新图进来，滤镜回到出厂设置
          applyPreset(PRESETS[0]);

          upload.setStatus('');
          filtersCard.hidden = false;
          previewCard.hidden = false;
          outputCard.hidden = false;
          resultCard.hidden = false;
          refresh();
        }, function () {
          if (disposed) return;
          upload.setStatus(S.err_decode, true);
          filtersCard.hidden = true;
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

  window.ItTools.logic['image-filters'] = {
    PREVIEW_MAX: PREVIEW_MAX,
    BUDGET_PIXELS: BUDGET_PIXELS,
    MAX_CANVAS_SIDE: MAX_CANVAS_SIDE,
    MAX_CANVAS_AREA: MAX_CANVAS_AREA,
    BLUR_PASSES: BLUR_PASSES,
    clampNum: clampNum,
    sliderValue: sliderValue,
    luminance: luminance,
    brightnessFactor: brightnessFactor,
    contrastFactor: contrastFactor,
    saturationFactor: saturationFactor,
    grayscaleMix: grayscaleMix,
    clampChannel: clampChannel,
    roundChannel: roundChannel,
    compileFilters: compileFilters,
    applyTone: applyTone,
    isNeutral: isNeutral,
    blurRadius: blurRadius,
    haloFor: haloFor,
    previewBlurRadius: previewBlurRadius,
    clampIdx: clampIdx,
    boxBlur1d: boxBlur1d,
    readBand: readBand,
    summarize: summarize,
    canvasLimit: canvasLimit,
    renderFiltered: renderFiltered,
    createFilterEngine: createFilterEngine,

    __cases: function (assert) {
      /* ---- 系数 ---- */

      assert.eq(brightnessFactor(0), 1, '亮度 0 是不动');
      assert.eq(brightnessFactor(50), 1.5, '亮度 50 是一点半');
      assert.eq(brightnessFactor(-100), 0, '亮度 −100 是全黑');
      assert.eq(brightnessFactor(100), 2, '亮度 100 是两倍');
      assert.eq(brightnessFactor(150), 2, '亮度超过上限就夹住');
      assert.eq(brightnessFactor('abc'), 1, '不是数字就当没调');

      assert.eq(contrastFactor(0), 1, '对比度 0 是不动');
      assert.eq(contrastFactor(-100), 0, '对比度 −100 是一片中灰');
      assert.eq(contrastFactor(100), 2, '对比度 100 是两倍');

      assert.eq(saturationFactor(0), 1, '饱和度 0 是不动');
      assert.eq(saturationFactor(-100), 0, '饱和度 −100 是全灰');
      assert.eq(saturationFactor(100), 2, '饱和度 100 是两倍');

      assert.eq(grayscaleMix(0), 0, '灰度 0 是不混');
      assert.eq(grayscaleMix(100), 1, '灰度 100 是全灰');
      assert.eq(grayscaleMix(50), 0.5, '灰度 50 是一半');

      /* ---- 亮度公式 ---- */

      assert.eq(Math.round(luminance(255, 255, 255)), 255, '全白');
      assert.eq(Math.round(luminance(0, 0, 0)), 0, '全黑');
      assert.eq(Math.round(luminance(255, 0, 0)), Math.round(0.2126 * 255), '纯红按 0.2126 算');
      assert.eq(Math.round(luminance(0, 255, 0)), Math.round(0.7152 * 255), '纯绿按 0.7152 算');
      assert.eq(Math.round(luminance(0, 0, 255)), Math.round(0.0722 * 255), '纯蓝按 0.0722 算');

      /* ---- 夹与取整 ---- */

      assert.eq(clampChannel(-10), 0, '负数夹到 0');
      assert.eq(clampChannel(300), 255, '超过 255 夹到 255');
      assert.eq(clampChannel(12.5), 12.5, '夹范围不改小数');
      assert.eq(roundChannel(12.4), 12, '取整往小');
      assert.eq(roundChannel(12.5), 13, '取整往大');
      assert.eq(roundChannel(-3), 0, '负数取整后是 0');

      /* ---- 上色 ---- */

      var neutral = compileFilters({});
      assert.eq(applyTone(10, 120, 200, neutral), [10, 120, 200], '什么都不调就是原样');

      var bright = compileFilters({ brightness: 50 });
      assert.eq(applyTone(100, 100, 100, bright), [150, 150, 150], '亮度 +50 是一点半');
      var dark = compileFilters({ brightness: -100 });
      assert.eq(applyTone(100, 100, 100, dark), [0, 0, 0], '亮度 −100 是全黑');

      var contrast = compileFilters({ contrast: 100 });
      assert.eq(applyTone(200, 200, 200, contrast), [255, 255, 255], '对比度 +100 把亮的推到头');
      var contrastDown = compileFilters({ contrast: -100 });
      assert.eq(applyTone(200, 200, 200, contrastDown), [128, 128, 128], '对比度 −100 变成中灰');

      var gray = compileFilters({ grayscale: 100 });
      var grayed = applyTone(100, 200, 50, gray);
      assert.eq(grayed[0], grayed[1], '灰度之后 R 等于 G');
      assert.eq(grayed[1], grayed[2], '灰度之后 G 等于 B');
      assert.eq(grayed[0], Math.round(luminance(100, 200, 50)), '灰度之后等于亮度值');

      var sat = compileFilters({ saturation: -100 });
      assert.eq(applyTone(100, 200, 50, sat), [Math.round(luminance(100, 200, 50)),
        Math.round(luminance(100, 200, 50)), Math.round(luminance(100, 200, 50))],
      '饱和度 −100 等于灰度 100');

      var inv = compileFilters({ invert: true });
      assert.eq(applyTone(0, 10, 255, inv), [255, 245, 0], '反色就是 255 减');

      var bw = compileFilters({ thresholdOn: true, threshold: 128 });
      assert.eq(applyTone(200, 200, 200, bw), [255, 255, 255], '比阈值亮就是白');
      assert.eq(applyTone(100, 100, 100, bw), [0, 0, 0], '比阈值暗就是黑');
      assert.eq(applyTone(130, 130, 130, bw), [255, 255, 255], '正好等于阈值算亮');

      /* ---- 中性判定 ---- */

      assert.eq(isNeutral(compileFilters({})), true, '什么都不调就是中性');
      assert.eq(isNeutral(compileFilters({ brightness: 0, blur: 0 })), true, '零值还是中性');
      assert.eq(isNeutral(compileFilters({ blur: 1 })), false, '有模糊就不是中性');
      assert.eq(isNeutral(compileFilters({ invert: true })), false, '有反色就不是中性');
      assert.eq(isNeutral(compileFilters({ thresholdOn: true })), false, '有黑白就不是中性');

      /* ---- 模糊半径与晕圈 ---- */

      assert.eq(blurRadius(0), 0, '半径 0');
      assert.eq(blurRadius(7.4), 7, '半径取整');
      assert.eq(blurRadius(999), 20, '半径夹在 20 以内');
      assert.eq(haloFor(0), 0, '没有模糊就没有晕圈');
      assert.eq(haloFor(4), 12, '三趟模糊要 3 倍半径的上下文');
      assert.eq(haloFor(20), 60, '半径 20 要 60 行上下文');

      /* ---- 预览半径 ---- */

      assert.eq(previewBlurRadius(0, 0.1), 0, '没有模糊时预览也没有');
      assert.eq(previewBlurRadius(20, 1), 20, '不缩小时预览跟原图一样');
      assert.eq(previewBlurRadius(20, 0.16), 3, '缩到六分之一时半径跟着缩');
      assert.eq(previewBlurRadius(1, 0.03), 0, '缩得狠的时候半径可以是 0，不能抬成 1');
      assert.eq(previewBlurRadius(4, 0), 0, '缩放比是 0 时没有模糊');

      /* ---- 一维盒式模糊 ---- */

      var line = [1, 2, 3, 4, 5];
      assert.eq(Array.prototype.slice.call(boxBlur1d(line, 5, 0)), line, '半径 0 是恒等');
      assert.eq(Array.prototype.slice.call(boxBlur1d([7, 7, 7, 7, 7], 5, 2)),
        [7, 7, 7, 7, 7], '常量数组模糊之后还是常量');
      var spike = boxBlur1d([0, 0, 100, 0, 0], 5, 1);
      assert(Math.abs(spike[1] - 100 / 3) < 1e-9, '尖峰左边的值是三分之一');
      assert(Math.abs(spike[2] - 100 / 3) < 1e-9, '尖峰自己也是三分之一');
      assert(Math.abs(spike[3] - 100 / 3) < 1e-9, '尖峰右边也是三分之一');
      assert(Math.abs(spike[0] - spike[4]) < 1e-9, '结果是关于尖峰对称的');

      // 边界是「复制边缘」不是「补零」：窗口大小恒定 2q+1，
      // 越界的下标取边缘那个像素（重复的也计入分母）。
      var edge = boxBlur1d([10, 0, 0, 0, 0], 5, 1);
      assert(Math.abs(edge[0] - 20 / 3) < 1e-9, '左边界的窗口里边缘像素算了两遍');
      assert(Math.abs(edge[1] - 10 / 3) < 1e-9, '第二格是三分之一');
      assert(Math.abs(edge[2]) < 1e-9, '离得远的格子不受影响');
      var edgeRight = boxBlur1d([0, 0, 0, 0, 10], 5, 1);
      assert(Math.abs(edgeRight[4] - edge[0]) < 1e-9, '左右边界是镜像的');
      assert(Math.abs(edgeRight[3] - edge[1]) < 1e-9, '左右边界的第二格也是镜像的');

      // 半径为 0 时必须原样返回，不能变成「除以 1 之后仍相等但类型变了」。
      var identity = boxBlur1d([1.5, 2.5, 3.5], 3, 0);
      assert.eq(Array.prototype.slice.call(identity), [1.5, 2.5, 3.5], '半径 0 不改小数');

      /* ---- 下标夹取 ---- */

      assert.eq(clampIdx(-5, 10), 0, '小于 0 的下标夹到 0');
      assert.eq(clampIdx(50, 10), 9, '越界的下标夹到最后一个');
      assert.eq(clampIdx(3, 10), 3, '中间的下标不动');

      /* ---- 延拓 + 预乘 ---- */

      // 两行、每行两个像素：
      //   第 0 行：红（全不透明）、绿（半透明）
      //   第 1 行：蓝（全不透明）、黄（全透明）
      var px = new Uint8ClampedArray([
        255, 0, 0, 255, 0, 255, 0, 128,
        0, 0, 255, 255, 255, 255, 0, 0
      ]);
      // halo = 1：左右各延拓一列；上下各补一行（复制边缘行）。
      var out = new Float32Array((2 + 2) * (2 + 2) * 4);
      readBand(px, 2, 2, 1, 1, 1, out);
      var stride = 4;   // 缓冲区一行 4 个像素（2 真实 + 左右各 1 延拓）
      function at(y, x, c) { return out[(y * stride + x) * 4 + (c || 0)]; }
      // 纵向：顶上那行复制第 0 行，底下那行复制第 1 行。
      assert.eq(at(0, 0), 255, '顶上的延拓行复制第一行');
      assert.eq(at(3, 1, 2), 255, '底下的延拓行复制最后一行');
      // 横向：左边那列复制第一列，右边那列复制最后一列。
      assert.eq(at(1, 0), 255, '左边的延拓列复制第一列');
      assert(Math.abs(at(1, 3, 1) - 128) < 1e-4, '右边的延拓列复制最后一列');
      // 预乘：全透明的黄色 → 颜色乘成 0；半透明的绿色 → 乘上 128/255。
      assert.eq(at(2, 2), 0, '全透明像素的颜色被乘成 0');
      assert(Math.abs(at(1, 2, 1) - 255 * 128 / 255) < 1e-4, '半透明的像素按 alpha 预乘');
      assert(Math.abs(at(1, 2, 3) - 128) < 1e-4, 'alpha 本身不预乘');
      assert.eq(at(2, 3), 0, '全透明那一列的延拓也是 0');

      // 延拓只做一次：三趟盒式的复合核是 [1,3,6,7,6,3,1]/27，
      // 作用在**延拓后**的那份数组上。
      // 尖峰落在边缘时，「先延拓」和「每一趟都在原图上夹边」差得很明显。
      var padded = [100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0]; // 左右各延拓三列
      var kernel = [1, 3, 6, 7, 6, 3, 1];
      function composite(i) {
        var sum = 0;
        for (var d = -3; d <= 3; d++) sum += kernel[d + 3] * padded[i + d];
        return sum / 27;
      }
      var extended = boxBlur1d(boxBlur1d(boxBlur1d(padded, padded.length, 1), padded.length, 1), padded.length, 1);
      assert(Math.abs(extended[3] - composite(3)) < 1e-9, '先延拓再模糊：边缘那列是复合核的值');
      assert(Math.abs(extended[6] - composite(6)) < 1e-9, '先延拓再模糊：第三列也是复合核的值');
      // 不延拓、每一趟都在原图上夹边：边缘那列对不上。
      var clamped = boxBlur1d(boxBlur1d(boxBlur1d([100, 0, 0, 0, 0], 5, 1), 5, 1), 5, 1);
      assert(Math.abs(clamped[0] - composite(3)) > 1e-9, '不延拓：边缘那列的值对不上');

      /* ---- 参数夹取 ---- */

      var clamped = compileFilters({ brightness: 500, contrast: -500, blur: 99, grayscale: -5 });
      assert.eq(clamped.brightness, 100, '亮度夹在 100 以内');
      assert.eq(clamped.contrast, -100, '对比度夹在 −100 以内');
      assert.eq(clamped.blur, 20, '模糊夹在 20 以内');
      assert.eq(clamped.grayscale, 0, '灰度不会小于 0');
      assert.eq(clamped.threshold, 128, '阈值没给就用 128');

      // 缺省的滑块是「不动」，不是「区间下界」——
      // 亮度缺省要是 −100，一开工具整张图就是全黑。
      assert.eq(sliderValue(undefined, 0, -100, 100), 0, '没给就用默认值');
      assert.eq(sliderValue(null, 0, -100, 100), 0, 'null 也用默认值');
      assert.eq(sliderValue('abc', 0, -100, 100), 0, '不是数字就用默认值');
      assert.eq(sliderValue(50, 0, -100, 100), 50, '给了就照用');
      assert.eq(sliderValue(50, 0, 0, 20), 20, '还是照样夹范围');
      assert.eq(compileFilters({}).brightness, 0, '空参数集的亮度是 0');
      assert.eq(compileFilters({}).blur, 0, '空参数集的模糊是 0');
      assert.eq(compileFilters({}).grayscale, 0, '空参数集的灰度是 0');

      /* ---- 一次只取一次整 ---- */

      // 亮度 +10、对比度不动：结果应该正好等于 round(200 × 1.1)，
      // 中间没有多余的一次四舍五入。
      var once = compileFilters({ brightness: 10 });
      assert.eq(applyTone(200, 200, 200, once), [220, 220, 220], '一次取整的结果');
      // 亮度 +100 再对比度 −100：先乘两倍再压成中灰，
      // 中间的值是 400 而不是夹到 255 —— 夹取只发生在最后一步。
      var order = compileFilters({ brightness: 100, contrast: -100 });
      assert.eq(applyTone(100, 100, 100, order), [128, 128, 128], '先亮度后对比度');

      /* ---- 摘要 ---- */

      var noneText = summarize(compileFilters({}));
      assert(!/\d/.test(noneText), '没有调整时那句话里没有数字');
      var someText = summarize(compileFilters({ brightness: 20, blur: 4 }));
      assert(someText.indexOf('+20') >= 0, '摘要里有亮度 +20');
      assert(someText.indexOf('4') >= 0, '摘要里有模糊半径');

      /* ---- 画布上限 ---- */

      assert.eq(canvasLimit(800, 600).ok, true, '普通尺寸没问题');
      assert.eq(canvasLimit(0, 600).ok, false, '宽度为 0 不行');
      assert.eq(canvasLimit(0, 600).reason, 'size', '尺寸不对的原因');
      assert.eq(canvasLimit(40000, 100).ok, false, '单边超过上限不行');
      assert.eq(canvasLimit(20000, 20000).ok, false, '面积超过上限不行');
    }
  };
}());