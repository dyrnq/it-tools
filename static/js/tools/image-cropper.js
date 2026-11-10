/* ==========================================================================
   裁剪（image-cropper）

   在图上框出一块，把这一块取下来 —— 全程在浏览器里完成。

   交互是「拖拽框 + 数字框」两套：
   画布上有一个可拖可缩的裁剪矩形，旁边有 x / y / 宽 / 高 四个数字框，
   两边实时联动 —— 拖框，数字跟着变；改数字，框跟着变。

   图可以先旋转、翻转，再裁 —— 变换作用在**图**上，裁剪框框的是变换之后
   的样子（上游 crop-image 也是这个顺序：先转再裁）。

   四套坐标，别弄混：
     - 源图像素（sw × sh）：解码出来的原图。变换矩阵的输入。
     - 画面像素（dw × dh）：变换之后的画面 —— 旋转、翻转之后图占多大。
       裁剪框的位置、大小、命中测试、拖动计算，全是画面像素。
     - 预览画布像素（pw × ph）：画在 canvas 上的那些。
     - 屏幕像素：鼠标点的位置。进来先换算成画面像素再算。

   为什么要统一到画面像素：屏幕坐标是「这次预览缩了多少」下的坐标，
   换张图、换个缩放，全错。画面像素是唯一稳定的那一套。

   命中的容差也按屏幕像素算（8 像素）再换算成画面像素 ——
   不管图多大、手柄在屏幕上看着多大，点起来都一样好使。

   输出是裁剪框的原生像素，不做二次缩放（缩放是改尺寸工具的活）。
   直角（90° 的整倍数）的旋转是精确的 —— 一个像素都不重采样；
   任意角度必然要重采样，那是旋转本身的代价，说清楚就行。

   有一条不能省的实话：裁剪框比画面还大的话，浏览器画布装不下，
   这时候**不编码** —— 内核遇到装不下的尺寸会悄悄把长宽减半重试，
   那样下载到的就不是用户框出来的那一块了。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-cropper');

  /**
   * 比例预设。
   *
   * free 是「不管比例」，其余的都会把裁剪框按这个比例摆好。
   * original 是原图的比例 —— 载入图片之后才知道是多少。
   */
  var RATIO_PRESETS = [
    { id: 'free', key: 'ratio_free', width: 0, height: 0 },
    { id: 'original', key: 'ratio_original', width: 0, height: 0 },
    { id: '1:1', key: 'ratio_1_1', width: 1, height: 1 },
    { id: '16:9', key: 'ratio_16_9', width: 16, height: 9 },
    { id: '9:16', key: 'ratio_9_16', width: 9, height: 16 },
    { id: '4:3', key: 'ratio_4_3', width: 4, height: 3 },
    { id: '3:4', key: 'ratio_3_4', width: 3, height: 4 },
    { id: '3:2', key: 'ratio_3_2', width: 3, height: 2 }
  ];

  /** 预览画布的最长边 —— 预览只是给人看的，没必要按原图像素开画布。 */
  var PREVIEW_MAX = 720;

  /** 浏览器画布的上限：每边 32767、总面积 268435456（约 2.68 亿像素）。 */
  var MAX_CANVAS_SIDE = 32767;
  var MAX_CANVAS_AREA = 268435456;

  /** 手柄在屏幕上多大（屏幕像素）。命中判定也是按这个尺寸换算成源图像素。 */
  var HANDLE_PX = 8;

  /** 编码防抖的毫秒 —— 拖动的时候不用每一帧都编码一次。 */
  var ENCODE_DEBOUNCE_MS = 150;

  var S = {
    title: t('title', 'Crop an image with a draggable region'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.'),
    settings_title: t('settings_title', 'Crop settings'),
    label_ratio: t('label_ratio', 'Aspect ratio'),
    ratio_free: t('ratio_free', 'Free'),
    ratio_original: t('ratio_original', 'Original'),
    ratio_1_1: t('ratio_1_1', '1:1'),
    ratio_16_9: t('ratio_16_9', '16:9'),
    ratio_9_16: t('ratio_9_16', '9:16'),
    ratio_4_3: t('ratio_4_3', '4:3'),
    ratio_3_4: t('ratio_3_4', '3:4'),
    ratio_3_2: t('ratio_3_2', '3:2'),
    hint_ratio: t('hint_ratio', 'The crop keeps this shape. Pick a preset and the rectangle is fitted to it; Original follows the shape of the picture as it is displayed.'),
    label_x: t('label_x', 'Left'),
    label_y: t('label_y', 'Top'),
    label_width: t('label_width', 'Width'),
    label_height: t('label_height', 'Height'),
    hint_rect: t('hint_rect', 'Where the crop sits on the picture as you see it, in the pixels of that picture.'),
    transform_title: t('transform_title', 'Transform'),
    label_angle: t('label_angle', 'Rotation angle'),
    btn_rotate_left: t('btn_rotate_left', 'Rotate left 90°'),
    btn_rotate_right: t('btn_rotate_right', 'Rotate right 90°'),
    label_flip_h: t('label_flip_h', 'Flip horizontally'),
    label_flip_v: t('label_flip_v', 'Flip vertically'),
    btn_reset_transform: t('btn_reset_transform', 'Reset the transform'),
    hint_transform: t('hint_transform', 'Rotation and flipping happen before the crop. The numbers below are the pixels of the picture as you see it.'),
    label_background: t('label_background', 'Background colour'),
    label_bg_transparent: t('label_bg_transparent', 'Transparent background'),
    hint_background: t('hint_background', 'The colour under the picture. It fills the corners left over by the rotation and the transparent parts of the picture.'),
    hint_transparent_jpeg: t('hint_transparent_jpeg', 'JPEG cannot keep transparency: the transparent areas are filled with white.'),
    label_grid: t('label_grid', 'Rule-of-thirds grid'),
    label_format: t('label_format', 'Output format'),
    label_quality: t('label_quality', 'Quality'),
    hint_quality: t('hint_quality', 'PNG is lossless — the quality setting does not change it.'),
    preview_title: t('preview_title', 'Preview'),
    hint_drag: t('hint_drag', 'Drag the rectangle to move the crop, drag a corner or an edge to resize it.'),
    result_title: t('result_title', 'Result'),
    label_item: t('label_item', 'Item'),
    label_value: t('label_value', 'Value'),
    label_source_size: t('label_source_size', 'Original size'),
    label_canvas_size: t('label_canvas_size', 'Size after the transform'),
    label_position: t('label_position', 'Top left corner'),
    label_output_size: t('label_output_size', 'Cropped size'),
    label_file_size: t('label_file_size', 'File size'),
    label_output_format: t('label_output_format', 'Saved as'),
    no_result: t('no_result', 'No image yet.'),
    download: t('download', 'Download the cropped image'),
    reset_full: t('reset_full', 'Select the whole picture'),
    status_reading: t('status_reading', 'Reading the file…'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_size: t('err_size', 'Enter a width and a height bigger than zero.'),
    err_encode: t('err_encode', 'Could not encode the image: {reason}'),
    err_canvas_limit: t('err_canvas_limit', 'A browser canvas cannot hold {width} × {height} pixels (the limit is {max} pixels per side and {area} megapixels in total), so nothing was encoded.'),
    warn_fallback: t('warn_fallback', 'This browser cannot encode {format}, so the image was saved as {actual}.'),
    warn_animation: t('warn_animation', 'Animated images are flattened to their first frame — this one has {n} frames.'),
    warn_scaled: t('warn_scaled', 'The browser could not allocate a canvas of {width} × {height}, so the image was saved at {actualWidth} × {actualHeight}.'),
    link_resize: t('link_resize', 'Need a different size instead? Open the resize tool.')
  };

  /* ---------- 纯逻辑（给 harness 用，也在下面被界面用） ---------- */

  /**
   * 比例预设 → 数值比例。
   *
   * @param {string} ratioId 预设 id
   * @param {number} srcW 原图宽
   * @param {number} srcH 原图高
   * @returns {number|null} 比例（宽/高）；free 与未知预设给 null
   */
  function ratioValue(ratioId, srcW, srcH) {
    if (ratioId === 'free') return null;
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
   * 把宽高按比例调好，并且保证放得进给定的大小。
   *
   * @param {number} w 宽
   * @param {number} h 高
   * @param {number|null} ratio 比例（宽/高），null 表示不管比例
   * @param {number} maxW 最多能有多宽
   * @param {number} maxH 最多能有多高
   * @param {string} driver 比例由谁说了算：
   *   'width' —— 宽说了算，高跟着；'height' —— 高说了算；
   *   'auto' —— 取「能盖住指针」的那个（宽高谁大听谁的）
   * @returns {{width: number, height: number}}
   */
  function fitSize(w, h, ratio, maxW, maxH, driver) {
    var r = Number(ratio);
    var hasRatio = isFinite(r) && r > 0;
    var width = Math.max(1, Math.round(Number(w) || 1));
    var height = Math.max(1, Math.round(Number(h) || 1));
    if (hasRatio) {
      if (driver === 'width') height = Math.max(1, Math.round(width / r));
      else if (driver === 'height') width = Math.max(1, Math.round(height * r));
      else if (width / height > r) height = Math.max(1, Math.round(width / r));
      else width = Math.max(1, Math.round(height * r));
    }
    var capW = Math.max(1, Math.round(Number(maxW) || 1));
    var capH = Math.max(1, Math.round(Number(maxH) || 1));
    if (width > capW) {
      width = capW;
      // 宁可小一点，也不能把比例弄丢
      if (hasRatio) height = Math.max(1, Math.round(width / r));
    }
    if (height > capH) {
      height = capH;
      if (hasRatio) width = Math.max(1, Math.round(height * r));
    }
    if (width > capW) width = capW;
    if (height > capH) height = capH;
    return { width: width, height: height };
  }

  /**
   * 把裁剪框夹进原图。
   *
   * 越界往里挪，超出原图的尺寸砍掉 —— 裁剪框永远得在图里面。
   *
   * @param {object} rect {x, y, width, height}
   * @param {{width: number, height: number}} bounds 原图尺寸
   * @param {number} minSize 最小边长
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  function clampRect(rect, bounds, minSize) {
    var limitW = Math.max(1, Math.round(Number(bounds && bounds.width) || 1));
    var limitH = Math.max(1, Math.round(Number(bounds && bounds.height) || 1));
    var min = Math.max(1, Math.round(Number(minSize) || 1));

    var width = Math.round(Number(rect && rect.width) || 0);
    var height = Math.round(Number(rect && rect.height) || 0);
    if (width < min) width = min;
    if (height < min) height = min;
    if (width > limitW) width = limitW;
    if (height > limitH) height = limitH;

    var x = Math.round(Number(rect && rect.x) || 0);
    var y = Math.round(Number(rect && rect.y) || 0);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + width > limitW) x = limitW - width;
    if (y + height > limitH) y = limitH - height;
    return { x: x, y: y, width: width, height: height };
  }

  /**
   * 把裁剪框按比例调好（保持左上角和宽度）。
   *
   * 放不下就整体缩小 —— 比例比尺寸重要。
   *
   * @param {object} rect
   * @param {number|null} ratio
   * @param {{width: number, height: number}} bounds
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  function fitRatio(rect, bounds, ratio) {
    var r = Number(ratio);
    if (!isFinite(r) || r <= 0) return clampRect(rect, bounds, 1);
    var size = fitSize(rect.width, rect.width / r, r, bounds.width, bounds.height, 'width');
    return clampRect({ x: rect.x, y: rect.y, width: size.width, height: size.height }, bounds, 1);
  }

  /**
   * 命中测试：点在哪儿？该用哪个手柄拖？
   *
   * 角优先于边，边优先于框里 —— 角上的点总是想拖角。
   *
   * @param {object} rect {x, y, width, height}
   * @param {number} px 源图横坐标
   * @param {number} py 源图纵坐标
   * @param {number} tolX 横向容差（源图像素）
   * @param {number} tolY 纵向容差（源图像素）
   * @returns {string|null} 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'move'|null
   */
  function hitTest(rect, px, py, tolX, tolY) {
    if (!rect) return null;
    var tx = Math.max(0, Number(tolX) || 0);
    var ty = Math.max(0, Number(tolY) || 0);
    var x0 = rect.x;
    var y0 = rect.y;
    var x2 = rect.x + rect.width;
    var y2 = rect.y + rect.height;

    // 四个角
    if (Math.abs(px - x0) <= tx && Math.abs(py - y0) <= ty) return 'nw';
    if (Math.abs(px - x2) <= tx && Math.abs(py - y0) <= ty) return 'ne';
    if (Math.abs(px - x2) <= tx && Math.abs(py - y2) <= ty) return 'se';
    if (Math.abs(px - x0) <= tx && Math.abs(py - y2) <= ty) return 'sw';
    // 四条边（边中段，别跟角抢）
    if (Math.abs(py - y0) <= ty && px > x0 && px < x2) return 'n';
    if (Math.abs(px - x2) <= tx && py > y0 && py < y2) return 'e';
    if (Math.abs(py - y2) <= ty && px > x0 && px < x2) return 's';
    if (Math.abs(px - x0) <= tx && py > y0 && py < y2) return 'w';
    // 框里 —— 移动
    if (px > x0 && px < x2 && py > y0 && py < y2) return 'move';
    return null;
  }

  /**
   * 拖动：按手柄算出新的裁剪框。
   *
   * 锚点是「不动的那条边或那个角」：
   * 角 → 对角不动；边 → 对边不动，另一条边（左边或上边）也不动。
   * 有比例的时候，另一维跟着走。
   *
   * @param {object} rect 拖动前的裁剪框
   * @param {string} handle 手柄
   * @param {number} dx 横向拖了多少（源图像素）
   * @param {number} dy 纵向拖了多少（源图像素）
   * @param {{width: number, height: number}} bounds 原图尺寸
   * @param {number|null} ratio 比例（宽/高），null 表示自由
   * @returns {object|null} 新的裁剪框
   */
  function dragRect(rect, handle, dx, dy, bounds, ratio) {
    if (!rect) return null;
    var limitW = Math.max(1, Math.round(Number(bounds && bounds.width) || 1));
    var limitH = Math.max(1, Math.round(Number(bounds && bounds.height) || 1));
    var r = Number(ratio);
    var hasRatio = isFinite(r) && r > 0;
    var x0 = rect.x;
    var y0 = rect.y;
    var w0 = rect.width;
    var h0 = rect.height;
    var x2 = x0 + w0;
    var y2 = y0 + h0;
    var moveX = Number(dx) || 0;
    var moveY = Number(dy) || 0;

    // 移动整个框：位置跟着走，尺寸不变
    if (handle === 'move') {
      return clampRect({
        x: x0 + moveX, y: y0 + moveY, width: w0, height: h0
      }, bounds, 1);
    }

    // 边：只有一条边能动
    if (handle === 'n' || handle === 's' || handle === 'w' || handle === 'e') {
      var ew = w0;
      var eh = h0;
      var driver = 'width';
      if (handle === 'n') eh = Math.abs(h0 - moveY);
      else if (handle === 's') eh = Math.abs(h0 + moveY);
      else if (handle === 'w') { ew = Math.abs(w0 - moveX); driver = 'width'; }
      else { ew = Math.abs(w0 + moveX); driver = 'width'; }
      if (handle === 'n' || handle === 's') driver = 'height';
      var eSize = fitSize(ew, eh, hasRatio ? r : null, limitW, limitH, driver);
      if (handle === 'n') {
        return clampRect({ x: x0, y: y2 - eSize.height, width: eSize.width, height: eSize.height }, bounds, 1);
      }
      if (handle === 's') {
        return clampRect({ x: x0, y: y0, width: eSize.width, height: eSize.height }, bounds, 1);
      }
      if (handle === 'w') {
        return clampRect({ x: x2 - eSize.width, y: y0, width: eSize.width, height: eSize.height }, bounds, 1);
      }
      return clampRect({ x: x0, y: y0, width: eSize.width, height: eSize.height }, bounds, 1);
    }

    // 角：对角不动
    var ax, ay, rawW, rawH, maxW, maxH;
    if (handle === 'se') {
      ax = x0; ay = y0;
      rawW = Math.abs(w0 + moveX); rawH = Math.abs(h0 + moveY);
      maxW = limitW - ax; maxH = limitH - ay;
    } else if (handle === 'nw') {
      ax = x2; ay = y2;
      rawW = Math.abs(w0 - moveX); rawH = Math.abs(h0 - moveY);
      maxW = ax; maxH = ay;
    } else if (handle === 'ne') {
      ax = x0; ay = y2;
      rawW = Math.abs(w0 + moveX); rawH = Math.abs(h0 - moveY);
      maxW = limitW - ax; maxH = ay;
    } else if (handle === 'sw') {
      ax = x2; ay = y0;
      rawW = Math.abs(w0 - moveX); rawH = Math.abs(h0 + moveY);
      maxW = ax; maxH = limitH - ay;
    } else {
      return null;
    }
    var size = fitSize(rawW, rawH, hasRatio ? r : null, maxW, maxH, 'auto');
    if (handle === 'se') {
      return clampRect({ x: ax, y: ay, width: size.width, height: size.height }, bounds, 1);
    }
    if (handle === 'nw') {
      return clampRect({ x: ax - size.width, y: ay - size.height, width: size.width, height: size.height }, bounds, 1);
    }
    if (handle === 'ne') {
      return clampRect({ x: ax, y: ay - size.height, width: size.width, height: size.height }, bounds, 1);
    }
    return clampRect({ x: ax - size.width, y: ay, width: size.width, height: size.height }, bounds, 1);
  }

  /**
   * 数字框 → 裁剪框。
   *
   * 改宽或改高的时候，另一个按比例跟着走；改位置不影响尺寸。
   *
   * @param {object} values {x, y, width, height}
   * @param {{width: number, height: number}} bounds 原图尺寸
   * @param {number|null} ratio 比例（宽/高），null 表示自由
   * @param {string} changed 改的是哪个：'x' | 'y' | 'width' | 'height'
   * @returns {object} 新的裁剪框
   */
  function rectFromFields(values, bounds, ratio, changed) {
    var r = Number(ratio);
    var hasRatio = isFinite(r) && r > 0;
    var x = Math.round(Number(values.x) || 0);
    var y = Math.round(Number(values.y) || 0);
    var width = Math.round(Number(values.width) || 0);
    var height = Math.round(Number(values.height) || 0);
    if (width < 1) width = 1;
    if (height < 1) height = 1;
    if (hasRatio) {
      if (changed === 'width') height = Math.max(1, Math.round(width / r));
      else if (changed === 'height') width = Math.max(1, Math.round(height * r));
    }
    return clampRect({ x: x, y: y, width: width, height: height }, bounds, 1);
  }

  /**
   * 目标尺寸是不是浏览器画布吃得下的。
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
   * 解析一个整数输入框的值。空、非数字都退回旧值。
   *
   * 这里允许 0 —— 裁剪框的左边、上边可以是 0。
   *
   * @param {*} value
   * @param {number} fallback
   * @returns {number}
   */
  function parseInteger(value, fallback) {
    // Number('') 是 0 —— 空字符串要当无效值处理，不然清空输入框就把位置归零了
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.round(n);
  }

  /* ---------- 变换（纯逻辑） ---------- */

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
   * 那点误差看着无害，可它会让输出差半个像素：直角旋转本来是
   * 一个像素都不该动的，差这半个像素就要被重采样糊一遍。
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
   * @returns {{c: number, s: number}}
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
   * 变换矩阵：源图像素 → 画面像素。
   *
   * 顺序跟上游 crop-image 一致：**先翻转，再绕中心旋转**。
   * 正角度在屏幕上是顺时针（画布的 y 朝下）。
   *
   * 矩阵用画布的约定存：x' = a·x + c·y + e，y' = b·x + d·y + f。
   *
   * @param {number} angle 角度（度）
   * @param {boolean} flipH 水平翻转
   * @param {boolean} flipV 垂直翻转
   * @param {number} w 源图宽
   * @param {number} h 源图高
   * @returns {object} 矩阵 + 画面尺寸（width / height）
   */
  function transformMatrix(angle, flipH, flipV, w, h) {
    var sc = angleSinCos(angle);
    // 翻转：x → w − x（y → h − y），翻的是源图，翻完还占原来那么大
    var fx = flipH ? -1 : 1;
    var fy = flipV ? -1 : 1;
    var ftx = flipH ? w : 0;
    var fty = flipV ? h : 0;
    var cx = w / 2;
    var cy = h / 2;
    // 绕中心旋转：x' = cx + (x − cx)·cos − (y − cy)·sin
    var eR = cx - sc.c * cx + sc.s * cy;
    var fR = cy - sc.s * cx - sc.c * cy;
    var m = {
      a: sc.c * fx,
      b: sc.s * fx,
      c: -sc.s * fy,
      d: sc.c * fy,
      e: sc.c * ftx - sc.s * fty + eR,
      f: sc.s * ftx + sc.c * fty + fR
    };
    // 外接框：源图四角转过去之后的最小外接矩形 —— 画面就它那么大。
    // 任意角度时四角是空的，那块空白就是背景色要填的地方。
    var xs = [0, w, 0, w];
    var ys = [0, 0, h, h];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < 4; i++) {
      var p = matrixApply(m, xs[i], ys[i]);
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    m.e -= minX;
    m.f -= minY;
    // 向上取整：宁可画面大一点，也别把图最边上那一行切掉
    m.width = Math.ceil(maxX - minX);
    m.height = Math.ceil(maxY - minY);
    return m;
  }

  /**
   * 矩阵作用在一个点上。
   *
   * @param {object} m
   * @param {number} x
   * @param {number} y
   * @returns {{x: number, y: number}}
   */
  function matrixApply(m, x, y) {
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }

  /**
   * 矩阵的逆。行列式是 ±1（旋转 + 翻转），不会是 0。
   *
   * @param {object} m
   * @returns {object|null}
   */
  function matrixInverse(m) {
    var det = m.a * m.d - m.b * m.c;
    if (!det) return null;
    return {
      a: m.d / det,
      b: -m.b / det,
      c: -m.c / det,
      d: m.a / det,
      e: (m.c * m.f - m.d * m.e) / det,
      f: (m.b * m.e - m.a * m.f) / det
    };
  }

  /**
   * 变换换了以后，裁剪框挪到哪儿去。
   *
   * 旧框的四个角 → 旧矩阵的逆（回到源图） → 新矩阵（到新画面），
   * 取外接框。直角下这一步是精确的：框住的还是同一块内容。
   * 任意角度下只能取外接框 —— 转出来的四边形不是轴对齐的。
   *
   * @param {object} rect 旧裁剪框（画面像素）
   * @param {object} mOld 旧矩阵
   * @param {object} mNew 新矩阵
   * @returns {object} 新裁剪框（画面像素）
   */
  function remapRect(rect, mOld, mNew) {
    if (!rect || !mOld || !mNew) return rect;
    var inv = matrixInverse(mOld);
    if (!inv) return rect;
    var corners = [
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x, rect.y + rect.height],
      [rect.x + rect.width, rect.y + rect.height]
    ];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < corners.length; i++) {
      var src = matrixApply(inv, corners[i][0], corners[i][1]);
      var dst = matrixApply(mNew, src.x, src.y);
      if (dst.x < minX) minX = dst.x;
      if (dst.y < minY) minY = dst.y;
      if (dst.x > maxX) maxX = dst.x;
      if (dst.y > maxY) maxY = dst.y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * 三分线：裁剪框里的两条竖线、两条横线。
   *
   * @param {object} rect 裁剪框（画面像素）
   * @returns {Array<{x1: number, y1: number, x2: number, y2: number}>}
   */
  function gridLines(rect) {
    if (!rect) return [];
    var out = [];
    for (var i = 1; i <= 2; i++) {
      var gx = rect.x + rect.width * i / 3;
      var gy = rect.y + rect.height * i / 3;
      out.push({ x1: gx, y1: rect.y, x2: gx, y2: rect.y + rect.height });
      out.push({ x1: rect.x, y1: gy, x2: rect.x + rect.width, y2: gy });
    }
    return out;
  }

  /**
   * 棋盘格 —— 透明背景画在哪，用户才知道那块是空的。
   *
   * 只画在预览上，不进导出。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w 画布宽
   * @param {number} h 画布高
   * @param {number} cell 格子边长（画布像素）
   */
  function drawCheckerboard(ctx, w, h, cell) {
    var c = cell || 10;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#d9d9d9';
    for (var y = 0; y < h; y += c) {
      for (var x = 0; x < w; x += c) {
        if (((x / c) + (y / c)) % 2 === 0) ctx.fillRect(x, y, c, c);
      }
    }
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('image-cropper', function (root) {
    var disposed = false;
    /** 编码的序号。慢的那次算完了不许盖掉快的那次的结果。 */
    var ticket = 0;
    /** 编码防抖的计时器。 */
    var encodeTimer = null;
    /** 正在拖的��：null 表示没在拖。 */
    var drag = null;

    var state = {
      name: '',
      sourceFormat: '',
      animation: null,
      decoded: null,
      /** 画面尺寸 —— 变换之后的图占多大。裁剪框活动的范围。 */
      width: 0,
      height: 0,
      /** 裁剪框，画面像素。 */
      rect: null,
      /** 当前比例预设。 */
      ratioId: 'original',
      formatId: 'jpeg',
      quality: 90,
      /** 旋转角度（度，正的是顺时针）。 */
      angle: 0,
      flipH: false,
      flipV: false,
      /** 当前的变换矩阵（源图像素 → 画面像素）。 */
      matrix: null,
      /** 背景色。透明时用它填 JPEG 的底。 */
      bgColor: '#ffffff',
      bgTransparent: true,
      /** 三分网格。 */
      showGrid: true,
      result: null,
      /** 结果图的 object URL。 */
      resultUrl: ''
    };

    /** 预览缩放系数：画面像素 → 预览画布像素。 */
    var previewScale = 1;

    /* ---------- 卡片 ---------- */

    var upload = C.uploadCard({
      accept: 'image/*',
      label: S.choose_file,
      hint: S.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);

    var transformCard = D.h('div.card', { hidden: true });
    var settingsCard = D.h('div.card', { hidden: true });
    var previewCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(transformCard);
    root.appendChild(settingsCard);
    root.appendChild(previewCard);
    root.appendChild(resultCard);

    /* ---------- 变换 ---------- */

    var angleInput = D.h('input.slider', {
      type: 'range', id: 'crop-angle', min: -180, max: 180, step: 1, value: 0
    });
    var angleLabel = D.h('label.field-label', { for: 'crop-angle', text: S.label_angle + ': 0°' });
    var rotateLeftBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: S.btn_rotate_left });
    var rotateRightBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: S.btn_rotate_right });
    var resetTransformBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: S.btn_reset_transform });
    var flipHInput = D.h('input', { type: 'checkbox' });
    var flipVInput = D.h('input', { type: 'checkbox' });

    transformCard.appendChild(D.h('h3', { text: S.transform_title }));
    transformCard.appendChild(D.h('div.field', null, angleLabel, angleInput));
    transformCard.appendChild(D.h('div.form-actions', null, rotateLeftBtn, rotateRightBtn, resetTransformBtn));
    transformCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, flipHInput, D.h('span', { text: S.label_flip_h })),
      D.h('label.switch', null, flipVInput, D.h('span', { text: S.label_flip_v }))
    ));
    transformCard.appendChild(D.h('p.field-hint', { text: S.hint_transform }));

    /* ---------- 设置 ---------- */

    var xInput = D.h('input.layui-input', { type: 'number', min: 0, step: 1, value: 0 });
    var yInput = D.h('input.layui-input', { type: 'number', min: 0, step: 1, value: 0 });
    var widthInput = D.h('input.layui-input', { type: 'number', min: 1, step: 1, value: 0 });
    var heightInput = D.h('input.layui-input', { type: 'number', min: 1, step: 1, value: 0 });

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
    var resetBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: S.reset_full });
    var bgInput = D.h('input', { type: 'color', value: state.bgColor });
    var bgTransparentInput = D.h('input', { type: 'checkbox', checked: true });
    var gridInput = D.h('input', { type: 'checkbox', checked: true });
    var bgHint = D.h('p.field-hint');

    settingsCard.appendChild(D.h('h3', { text: S.settings_title }));
    settingsCard.appendChild(U.field(S.label_ratio, ratioSelect, { hint: S.hint_ratio }));
    // 四个数字框排成 2×2 —— minmax(0, 1fr) 加上 .grid > * {min-width:0}，
    // 窄屏上也不会把卡片撑出横向滚动条。
    settingsCard.appendChild(D.h('div.grid', {
      style: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }
    },
      U.field(S.label_x, xInput),
      U.field(S.label_y, yInput),
      U.field(S.label_width, widthInput),
      U.field(S.label_height, heightInput)
    ));
    settingsCard.appendChild(D.h('p.field-hint', { text: S.hint_rect }));
    settingsCard.appendChild(U.field(S.label_format, formatSelect));
    settingsCard.appendChild(U.field(S.label_quality, qualityInput));
    settingsCard.appendChild(qualityHint);
    settingsCard.appendChild(U.field(S.label_background, bgInput, { hint: S.hint_background }));
    settingsCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, bgTransparentInput, D.h('span', { text: S.label_bg_transparent })),
      D.h('label.switch', null, gridInput, D.h('span', { text: S.label_grid }))
    ));
    settingsCard.appendChild(bgHint);
    settingsCard.appendChild(D.h('div.form-actions', null, resetBtn));
    settingsCard.appendChild(statusLine);
    settingsCard.appendChild(D.h('p.field-hint', null,
      D.h('a', { href: '/image-resizer', text: S.link_resize })
    ));

    /* ---------- 预览 ---------- */

    var previewCanvas = D.h('canvas', {
      style: { touchAction: 'none', userSelect: 'none' }
    });
    var previewSize = D.h('p.field-hint');
    previewCard.appendChild(D.h('h3', { text: S.preview_title }));
    previewCard.appendChild(D.h('div.preview-box', null, previewCanvas));
    previewCard.appendChild(previewSize);
    previewCard.appendChild(D.h('p.field-hint', { text: S.hint_drag }));

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

    /** 原图尺寸。裁剪框活动的范围。 */
    function imageBounds() {
      return { width: state.width, height: state.height };
    }

    /** 现在生效的比例。free 或者没有原图时给 null。 */
    function currentRatio() {
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

    /** 裁剪框 → 输入框。 */
    function syncInputs() {
      if (!state.rect) return;
      setInputValue(xInput, state.rect.x);
      setInputValue(yInput, state.rect.y);
      setInputValue(widthInput, state.rect.width);
      setInputValue(heightInput, state.rect.height);
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
      var rect = state.rect || { x: 0, y: 0, width: r.width, height: r.height };
      // 「原图尺寸」是解码出来的原图，「变换后尺寸」是画面 —— 旋转 90° 两者会换位置
      var srcW = state.decoded ? state.decoded.width : state.width;
      var srcH = state.decoded ? state.decoded.height : state.height;
      var rows = [
        { label: S.label_source_size, value: srcW + ' × ' + srcH },
        { label: S.label_canvas_size, value: state.width + ' × ' + state.height },
        { label: S.label_position, value: rect.x + ', ' + rect.y },
        { label: S.label_output_size, value: r.width + ' × ' + r.height },
        { label: S.label_file_size, value: C.formatBytes(r.bytes) },
        { label: S.label_output_format, value: format.label }
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

      // 浏览器吃不下这么大的画布，内核把长宽减半了 —— 下载到的不是框出来的那一块
      if (r.scaledToFit) {
        resultBody.appendChild(D.h('div.alert.alert-warning', null,
          D.h('div', {
            text: S.warn_scaled
              .replace('{width}', String(rect.width))
              .replace('{height}', String(rect.height))
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

    /**
     * 预览画布在屏幕上的位置与大小。
     *
     * 画布的显示尺寸**不等于**它的 width/height 属性 —— css 里写着
     * max-width:100%，所以要问浏览器要实际显示出来的矩形。
     *
     * @returns {object|null} null 表示还没布局好（或者在 jsdom 里）
     */
    function canvasBox() {
      var rect = previewCanvas.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return null;
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }

    /** 屏幕坐标 → 源图像素。 */
    function clientToSource(clientX, clientY) {
      var box = canvasBox();
      if (!box || !state.width || !state.height) return null;
      return {
        x: (clientX - box.left) / box.width * state.width,
        y: (clientY - box.top) / box.height * state.height
      };
    }

    /**
     * 手柄的命中容差，换算成源图像素。
     *
     * 屏幕上是 8 个像素 —— 源图越大，一个屏幕像素对应的源图像素越多，
     * 容差跟着换算，手柄在屏幕上看着多大，点起来就多好使。
     */
    function hitTolerance() {
      var box = canvasBox();
      if (!box || !state.width || !state.height) return { x: 0, y: 0 };
      return {
        x: HANDLE_PX / box.width * state.width,
        y: HANDLE_PX / box.height * state.height
      };
    }

    /** 画布像素 ↔ 屏幕像素的比例 —— 用来把手柄画成屏幕上看着一样大。 */
    function uiScale() {
      var box = canvasBox();
      if (!box || !previewCanvas.width) return 1;
      return previewCanvas.width / box.width;
    }

    /**
     * 手柄在画布上的位置（画布像素）。
     *
     * @returns {Array<{name: string, x: number, y: number}>}
     */
    function handlePositions() {
      var rect = state.rect;
      if (!rect || !state.width || !state.height) return [];
      // 用预览缩放系数（而不是画布尺寸 ÷ 画面尺寸）：画面是按这个系数画上去的，
      // 框也得按同一个系数算，不然框和画面对不上，框住的就不是看到的那一块。
      var sx = previewScale;
      var sy = previewScale;
      var x0 = rect.x * sx;
      var y0 = rect.y * sy;
      var x2 = (rect.x + rect.width) * sx;
      var y2 = (rect.y + rect.height) * sy;
      return [
        { name: 'nw', x: x0, y: y0 },
        { name: 'n', x: (x0 + x2) / 2, y: y0 },
        { name: 'ne', x: x2, y: y0 },
        { name: 'e', x: x2, y: (y0 + y2) / 2 },
        { name: 'se', x: x2, y: y2 },
        { name: 's', x: (x0 + x2) / 2, y: y2 },
        { name: 'sw', x: x0, y: y2 },
        { name: 'w', x: x0, y: (y0 + y2) / 2 }
      ];
    }

    /** 重画预览。 */
    function redraw() {
      if (!state.decoded || !state.rect) return;
      var ctx = previewCanvas.getContext('2d');
      // jsdom 里没有 2d 上下文，画不了就算了 —— 不能因此抛异常。
      if (!ctx) return;
      var pw = previewCanvas.width;
      var ph = previewCanvas.height;
      if (!pw || !ph) return;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pw, ph);

      // 背景：透明就铺棋盘格，好让人一眼看出哪儿是空的
      if (state.bgTransparent) {
        drawCheckerboard(ctx, pw, ph);
      } else {
        ctx.fillStyle = state.bgColor;
        ctx.fillRect(0, 0, pw, ph);
      }

      // 画面 = 变换之后的图。矩阵把源图像素搬到画面像素，
      // 再按预览缩放系数缩到画布上。
      var m = state.matrix;
      if (m) {
        var k = previewScale;
        ctx.setTransform(m.a * k, m.b * k, m.c * k, m.d * k, m.e * k, m.f * k);
        try {
          ctx.drawImage(state.decoded.source, 0, 0);
        } catch (e) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          return;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }

      // 裁剪框以外压暗
      var scale = uiScale();
      var positions = handlePositions();
      var x0 = 0, y0 = 0, x2 = pw, y2 = ph;
      for (var i = 0; i < positions.length; i++) {
        if (positions[i].name === 'nw') { x0 = positions[i].x; y0 = positions[i].y; }
        if (positions[i].name === 'se') { x2 = positions[i].x; y2 = positions[i].y; }
      }
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, pw, y0);
      ctx.fillRect(0, y2, pw, ph - y2);
      ctx.fillRect(0, y0, x0, y2 - y0);
      ctx.fillRect(x2, y0, pw - x2, y2 - y0);

      // 三分网格：只在预览里，导出的文件里没有它
      if (state.showGrid) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = Math.max(1, scale);
        ctx.beginPath();
        var lines = gridLines(state.rect);
        for (var g = 0; g < lines.length; g++) {
          ctx.moveTo(lines[g].x1 * previewScale, lines[g].y1 * previewScale);
          ctx.lineTo(lines[g].x2 * previewScale, lines[g].y2 * previewScale);
        }
        ctx.stroke();
      }

      // 框线
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, 2 * scale);
      ctx.strokeRect(x0, y0, x2 - x0, y2 - y0);

      // 手柄
      var half = Math.max(2, HANDLE_PX * scale / 2);
      ctx.fillStyle = '#ffffff';
      for (var j = 0; j < positions.length; j++) {
        ctx.fillRect(positions[j].x - half, positions[j].y - half, half * 2, half * 2);
      }

      previewSize.textContent = state.rect.width + ' × ' + state.rect.height;
    }

    /** 按画面尺寸把预览画布摆好。 */
    function resizePreview() {
      if (!state.width || !state.height) return;
      var k = Math.min(1, PREVIEW_MAX / Math.max(state.width, state.height));
      var pw = Math.max(1, Math.round(state.width * k));
      var ph = Math.max(1, Math.round(state.height * k));
      // 画布尺寸是取整过的，缩放系数得记住 —— 画图和画框都得用同一个，
      // 否则框和画面对不上。
      previewScale = k;
      if (previewCanvas.width !== pw || previewCanvas.height !== ph) {
        previewCanvas.width = pw;
        previewCanvas.height = ph;
      }
    }

    /* ---------- 拖拽 ---------- */

    /** 手柄对应的鼠标指针。 */
    var CURSORS = {
      nw: 'nwse-resize', se: 'nwse-resize',
      ne: 'nesw-resize', sw: 'nesw-resize',
      n: 'ns-resize', s: 'ns-resize',
      e: 'ew-resize', w: 'ew-resize',
      move: 'move'
    };

    function onDown(e) {
      if (disposed || !state.decoded || !state.rect) return;
      var pt = clientToSource(e.clientX, e.clientY);
      if (!pt) return;
      var tol = hitTolerance();
      var handle = hitTest(state.rect, pt.x, pt.y, tol.x, tol.y);
      if (!handle) return;
      drag = {
        handle: handle,
        rect: {
          x: state.rect.x, y: state.rect.y,
          width: state.rect.width, height: state.rect.height
        },
        startX: pt.x,
        startY: pt.y
      };
      if (e.preventDefault) e.preventDefault();
      // 抓住之后指针移出画布也要跟手 —— 把事件抓到画布上。
      if (previewCanvas.setPointerCapture && e.pointerId !== undefined) {
        try {
          previewCanvas.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 抓不到就算了，document 上的监听照样跟手 */
        }
      }
    }

    function onMove(e) {
      if (disposed || !drag) return;
      var pt = clientToSource(e.clientX, e.clientY);
      if (!pt) return;
      var next = dragRect(
        drag.rect, drag.handle,
        pt.x - drag.startX, pt.y - drag.startY,
        imageBounds(), currentRatio()
      );
      if (!next) return;
      state.rect = next;
      syncInputs();
      redraw();
      scheduleEncode();
    }

    function onUp() {
      drag = null;
    }

    /** 鼠标在画布上挪动时改指针 —— 让人知道哪儿能拖。 */
    function onHover(e) {
      if (disposed || !state.decoded || !state.rect || drag) return;
      var pt = clientToSource(e.clientX, e.clientY);
      if (!pt) return;
      var tol = hitTolerance();
      var handle = hitTest(state.rect, pt.x, pt.y, tol.x, tol.y);
      previewCanvas.style.cursor = handle ? (CURSORS[handle] || 'crosshair') : 'crosshair';
    }

    /* ---------- 编码 ---------- */

    /**
     * 按当前裁剪框编码一次。
     *
     * @param {function(): boolean} isCurrent 竞态闸门
     * @returns {Promise<void>}
     */
    function encodeNow(isCurrent) {
      if (!state.decoded || !state.rect) return Promise.resolve();
      var rect = state.rect;
      var limit = canvasLimit(rect.width, rect.height);
      if (!limit.ok) {
        state.result = null;
        if (limit.reason === 'size') {
          setStatus(S.err_size, true);
        } else {
          setStatus(S.err_canvas_limit
            .replace('{width}', String(rect.width))
            .replace('{height}', String(rect.height))
            .replace('{max}', String(MAX_CANVAS_SIDE))
            .replace('{area}', String(Math.round(MAX_CANVAS_AREA / 1000000))), true);
        }
        renderResult();
        return Promise.resolve();
      }

      // 先把要裁的那一块搬到一张小画布上。
      var work = document.createElement('canvas');
      work.width = rect.width;
      work.height = rect.height;
      var wctx = work.getContext('2d');
      if (!wctx) {
        state.result = null;
        setStatus(S.err_encode.replace('{reason}', 'canvas'), true);
        renderResult();
        return Promise.resolve();
      }
      try {
        // 背景色铺在图下面 —— 旋转露出来的空白、图自带的透明，都靠它打底
        if (!state.bgTransparent) {
          wctx.fillStyle = state.bgColor;
          wctx.fillRect(0, 0, rect.width, rect.height);
        }
        // 矩阵把源图像素搬到画面像素，再把裁剪框的左上角挪到 (0,0)。
        // 画布只有裁剪框那么大，画出去的部分自然被切掉。
        var m = state.matrix;
        if (m) {
          wctx.setTransform(m.a, m.b, m.c, m.d, m.e - rect.x, m.f - rect.y);
          wctx.drawImage(state.decoded.source, 0, 0);
          wctx.setTransform(1, 0, 0, 1, 0, 0);
        }
      } catch (e) {
        state.result = null;
        setStatus(S.err_encode.replace('{reason}', function () {
          return String(e && e.message ? e.message : e);
        }), true);
        renderResult();
        return Promise.resolve();
      }

      return C.encode(
        { source: work, width: rect.width, height: rect.height },
        {
          width: rect.width,
          height: rect.height,
          formatId: state.formatId,
          quality: state.quality,
          // JPEG 没有 alpha，内核这时候才会用 background 铺底。
          // 透明背景传白色 —— 不能让它变黑（上游 crop-image 就栽在这儿）。
          background: state.bgTransparent ? '#ffffff' : state.bgColor
        }
      ).then(function (out) {
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

    /** 改裁剪框之后的总入口：先重画，再防抖地编码。 */
    function scheduleEncode() {
      if (!state.decoded) return;
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

    /* ---------- 变换 ---------- */

    /**
     * 变换的界面 → 状态。
     *
     * 角度滑块是 range，写回去的时候值一样就不写，免得正在拖的滑块跳回去。
     */
    function syncTransformInputs() {
      setInputValue(angleInput, state.angle);
      angleLabel.textContent = S.label_angle + ': ' + state.angle + '°';
      flipHInput.checked = state.flipH;
      flipVInput.checked = state.flipV;
    }

    /**
     * 变换变了：重算矩阵 → 重映裁剪框 → 重画 → 重新编码。
     *
     * 裁剪框要跟着走：变换换了之后，「原来框住的那块内容」在新的画面里
     * 换了位置，不跟着挪的话，用户框的东西就悄悄变了。
     */
    function applyTransform() {
      if (!state.decoded) return;
      var old = state.matrix;
      var m = transformMatrix(state.angle, state.flipH, state.flipV, state.decoded.width, state.decoded.height);
      state.matrix = m;
      state.width = m.width;
      state.height = m.height;
      if (state.rect) {
        if (old) state.rect = remapRect(state.rect, old, m);
        state.rect = clampRect(state.rect, imageBounds(), 1);
        var ratio = currentRatio();
        if (ratio) state.rect = fitRatio(state.rect, imageBounds(), ratio);
      }
      resizePreview();
      syncInputs();
      redraw();
      scheduleEncode();
    }

    /** 背景色那行下面的提示：JPEG 存不了透明，得说清楚会填成白色。 */
    function updateBackgroundHint() {
      var jpeg = state.bgTransparent && C.backgroundApplies(state.formatId);
      bgHint.textContent = jpeg ? S.hint_transparent_jpeg : '';
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
          state.sourceFormat = format || '';
          state.animation = C.animationInfo(bytes);
          state.decoded = decoded;
          // 新图进来，变换回到原样，裁剪框回到整张图，比例回到「原图」
          state.angle = 0;
          state.flipH = false;
          state.flipV = false;
          state.matrix = transformMatrix(0, false, false, decoded.width, decoded.height);
          state.width = state.matrix.width;
          state.height = state.matrix.height;
          state.rect = { x: 0, y: 0, width: state.width, height: state.height };
          state.ratioId = 'original';
          ratioSelect.value = 'original';
          syncTransformInputs();

          upload.setStatus('');
          transformCard.hidden = false;
          settingsCard.hidden = false;
          previewCard.hidden = false;
          resultCard.hidden = false;
          updateBackgroundHint();
          resizePreview();
          syncInputs();
          redraw();
          scheduleEncode();
        }, function () {
          if (disposed) return;
          upload.setStatus(S.err_decode, true);
          transformCard.hidden = true;
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

    /** 数字框改了 → 裁剪框跟着变。 */
    function onFieldChange(changed) {
      if (!state.decoded || !state.rect) return;
      state.rect = rectFromFields({
        x: parseInteger(xInput.value, state.rect.x),
        y: parseInteger(yInput.value, state.rect.y),
        width: parseInteger(widthInput.value, state.rect.width),
        height: parseInteger(heightInput.value, state.rect.height)
      }, imageBounds(), currentRatio(), changed);
      syncInputs();
      redraw();
      scheduleEncode();
    }

    xInput.addEventListener('input', function () { onFieldChange('x'); });
    yInput.addEventListener('input', function () { onFieldChange('y'); });
    widthInput.addEventListener('input', function () { onFieldChange('width'); });
    heightInput.addEventListener('input', function () { onFieldChange('height'); });

    ratioSelect.addEventListener('change', function () {
      state.ratioId = ratioSelect.value;
      if (!state.rect) return;
      var ratio = currentRatio();
      if (ratio) state.rect = fitRatio(state.rect, imageBounds(), ratio);
      syncInputs();
      redraw();
      scheduleEncode();
    });

    formatSelect.addEventListener('change', function () {
      state.formatId = formatSelect.value;
      // PNG 是无损的，画质对它没有意义 —— 滑块禁掉
      var lossless = state.formatId === 'png';
      qualityInput.disabled = lossless;
      qualityHint.textContent = lossless ? S.hint_quality : '';
      updateBackgroundHint();
      scheduleEncode();
    });

    qualityInput.addEventListener('input', function () {
      state.quality = Number(qualityInput.value) || 90;
      scheduleEncode();
    });

    angleInput.addEventListener('input', function () {
      state.angle = normalizeAngle(Number(angleInput.value) || 0);
      syncTransformInputs();
      applyTransform();
    });

    rotateLeftBtn.addEventListener('click', function () {
      state.angle = normalizeAngle(state.angle - 90);
      syncTransformInputs();
      applyTransform();
    });

    rotateRightBtn.addEventListener('click', function () {
      state.angle = normalizeAngle(state.angle + 90);
      syncTransformInputs();
      applyTransform();
    });

    flipHInput.addEventListener('change', function () {
      state.flipH = flipHInput.checked;
      applyTransform();
    });

    flipVInput.addEventListener('change', function () {
      state.flipV = flipVInput.checked;
      applyTransform();
    });

    resetTransformBtn.addEventListener('click', function () {
      state.angle = 0;
      state.flipH = false;
      state.flipV = false;
      syncTransformInputs();
      applyTransform();
    });

    bgInput.addEventListener('input', function () {
      state.bgColor = bgInput.value || '#ffffff';
      // 挑了颜色就意味着不透明了 —— 透明开着的话，这个颜色根本不起作用
      if (state.bgTransparent) {
        state.bgTransparent = false;
        bgTransparentInput.checked = false;
      }
      updateBackgroundHint();
      redraw();
      scheduleEncode();
    });

    bgTransparentInput.addEventListener('change', function () {
      state.bgTransparent = bgTransparentInput.checked;
      updateBackgroundHint();
      redraw();
      scheduleEncode();
    });

    gridInput.addEventListener('change', function () {
      state.showGrid = gridInput.checked;
      redraw();
    });

    resetBtn.addEventListener('click', function () {
      if (!state.decoded || !state.width) return;
      state.rect = { x: 0, y: 0, width: state.width, height: state.height };
      state.ratioId = 'original';
      ratioSelect.value = 'original';
      syncInputs();
      redraw();
      scheduleEncode();
    });

    // 指针事件优先（能拖出画布），老浏览器退回鼠标事件。
    var hasPointer = typeof window.PointerEvent === 'function';
    var downEvent = hasPointer ? 'pointerdown' : 'mousedown';
    var moveEvent = hasPointer ? 'pointermove' : 'mousemove';
    var upEvent = hasPointer ? 'pointerup' : 'mouseup';
    var offs = [
      D.on(previewCanvas, downEvent, onDown),
      D.on(document, moveEvent, onMove),
      D.on(document, upEvent, onUp),
      D.on(previewCanvas, 'mousemove', onHover)
    ];

    return {
      destroy: function () {
        disposed = true;
        ticket++;
        if (encodeTimer) {
          clearTimeout(encodeTimer);
          encodeTimer = null;
        }
        offs.forEach(function (off) { off(); });
        if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
        if (state.decoded && state.decoded.close) state.decoded.close();
        state.resultUrl = '';
        state.decoded = null;
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['image-cropper'] = {
    RATIO_PRESETS: RATIO_PRESETS,
    MAX_CANVAS_SIDE: MAX_CANVAS_SIDE,
    MAX_CANVAS_AREA: MAX_CANVAS_AREA,
    HANDLE_PX: HANDLE_PX,
    ratioValue: ratioValue,
    fitSize: fitSize,
    clampRect: clampRect,
    fitRatio: fitRatio,
    hitTest: hitTest,
    dragRect: dragRect,
    rectFromFields: rectFromFields,
    canvasLimit: canvasLimit,
    parseInteger: parseInteger,
    normalizeAngle: normalizeAngle,
    snapAngle: snapAngle,
    angleSinCos: angleSinCos,
    transformMatrix: transformMatrix,
    matrixApply: matrixApply,
    matrixInverse: matrixInverse,
    remapRect: remapRect,
    gridLines: gridLines,

    __cases: function (assert) {
      var bounds = { width: 1000, height: 800 };
      var rect = { x: 100, y: 100, width: 400, height: 300 };

      /* ---- 比例 ---- */

      assert.eq(ratioValue('free', 800, 600), null, '自由比例没有比例');
      assert.eq(ratioValue('1:1', 800, 600), 1, '1:1');
      assert.eq(ratioValue('16:9', 800, 600), 16 / 9, '16:9');
      assert.eq(ratioValue('original', 800, 600), 800 / 600, '原图比例');
      assert.eq(ratioValue('original', 0, 0), null, '没有原图时原图比例是 null');
      assert.eq(ratioValue('nope', 800, 600), null, '不存在的预设没有比例');

      /* ---- 按比例调尺寸 ---- */

      assert.eq(fitSize(100, 100, 1, 500, 500, 'auto'), { width: 100, height: 100 }, '1:1 不变形');
      assert.eq(fitSize(100, 100, 16 / 9, 500, 500, 'auto'), { width: 178, height: 100 }, '自动时宽高都盖住指针');
      assert.eq(fitSize(100, 100, 16 / 9, 500, 500, 'width'), { width: 100, height: 56 }, '宽说了算');
      assert.eq(fitSize(100, 100, 16 / 9, 500, 500, 'height'), { width: 178, height: 100 }, '高说了算');
      assert.eq(fitSize(100, 100, null, 500, 500, 'auto'), { width: 100, height: 100 }, '没有比例就不管');
      assert.eq(fitSize(100, 100, 1, 80, 500, 'auto'), { width: 80, height: 80 }, '装不下就砍到上限');
      assert.eq(fitSize(100, 100, 1, 80, 500, 'auto').width, 80, '砍完还是方的');

      /* ---- 夹进原图 ---- */

      assert.eq(clampRect({ x: -50, y: -50, width: 400, height: 300 }, bounds, 1),
        { x: 0, y: 0, width: 400, height: 300 }, '往里挪');
      assert.eq(clampRect({ x: 900, y: 700, width: 400, height: 300 }, bounds, 1),
        { x: 600, y: 500, width: 400, height: 300 }, '超出右边就往左挪');
      assert.eq(clampRect({ x: 0, y: 0, width: 5000, height: 300 }, bounds, 1),
        { x: 0, y: 0, width: 1000, height: 300 }, '比原图还宽就砍到原图宽');
      assert.eq(clampRect({ x: 0, y: 0, width: 0, height: 0 }, bounds, 10),
        { x: 0, y: 0, width: 10, height: 10 }, '太小就抬到最小值');
      assert.eq(clampRect({ x: 0, y: 0, width: 400, height: 300 }, bounds, 1),
        { x: 0, y: 0, width: 400, height: 300 }, '本来就在里面就不动');

      /* ---- 按比例摆框 ---- */

      assert.eq(fitRatio({ x: 0, y: 0, width: 400, height: 300 }, bounds, 1),
        { x: 0, y: 0, width: 400, height: 400 }, '1:1 时高度补上');
      assert.eq(fitRatio({ x: 10, y: 20, width: 400, height: 300 }, bounds, null),
        { x: 10, y: 20, width: 400, height: 300 }, '没有比例就不动');
      assert.eq(fitRatio({ x: 0, y: 0, width: 1000, height: 800 }, bounds, 1),
        { x: 0, y: 0, width: 800, height: 800 }, '放不下就整体缩小');

      /* ---- 命中测试 ---- */

      assert.eq(hitTest(rect, 100, 100, 10, 10), 'nw', '左上角');
      assert.eq(hitTest(rect, 500, 100, 10, 10), 'ne', '右上角');
      assert.eq(hitTest(rect, 500, 400, 10, 10), 'se', '右下角');
      assert.eq(hitTest(rect, 100, 400, 10, 10), 'sw', '左下角');
      assert.eq(hitTest(rect, 300, 100, 10, 10), 'n', '上边');
      assert.eq(hitTest(rect, 500, 250, 10, 10), 'e', '右边');
      assert.eq(hitTest(rect, 300, 400, 10, 10), 's', '下边');
      assert.eq(hitTest(rect, 100, 250, 10, 10), 'w', '左边');
      assert.eq(hitTest(rect, 300, 250, 10, 10), 'move', '框里是移动');
      assert.eq(hitTest(rect, 900, 700, 10, 10), null, '框外不算命中');
      assert.eq(hitTest(rect, 105, 105, 10, 10), 'nw', '角上有容差');
      assert.eq(hitTest(rect, 120, 100, 10, 10), 'n', '边上有容差');

      /* ---- 拖动 ---- */

      assert.eq(dragRect(rect, 'move', 50, 20, bounds, null),
        { x: 150, y: 120, width: 400, height: 300 }, '移动整个框');
      assert.eq(dragRect(rect, 'move', -500, -500, bounds, null),
        { x: 0, y: 0, width: 400, height: 300 }, '移到外面会被夹回来');
      assert.eq(dragRect(rect, 'se', 100, 100, bounds, null),
        { x: 100, y: 100, width: 500, height: 400 }, '拖右下角变大');
      assert.eq(dragRect(rect, 'se', -100, -100, bounds, null),
        { x: 100, y: 100, width: 300, height: 200 }, '拖右下角变小');
      assert.eq(dragRect(rect, 'nw', 50, 50, bounds, null),
        { x: 150, y: 150, width: 350, height: 250 }, '拖左上角：右下角不动');
      assert.eq(dragRect(rect, 'ne', 50, 50, bounds, null),
        { x: 100, y: 150, width: 450, height: 250 }, '拖右上角：左下角不动');
      assert.eq(dragRect(rect, 'sw', 50, 50, bounds, null),
        { x: 150, y: 100, width: 350, height: 350 }, '拖左下角：右上角不动');
      assert.eq(dragRect(rect, 'e', 100, 0, bounds, null),
        { x: 100, y: 100, width: 500, height: 300 }, '拖右边只改宽');
      assert.eq(dragRect(rect, 'n', 0, 50, bounds, null),
        { x: 100, y: 150, width: 400, height: 250 }, '拖上边只改高');
      assert.eq(dragRect(rect, 'se', 0, 0, bounds, 1),
        { x: 100, y: 100, width: 400, height: 400 }, '锁 1:1 时右下角拖成方的');
      assert.eq(dragRect(rect, 'se', 100, 100, bounds, 1),
        { x: 100, y: 100, width: 500, height: 500 }, '锁 1:1 时宽高一起长');
      assert.eq(dragRect(rect, 'nope', 10, 10, bounds, null), null, '不认识的手柄不管');

      /* ---- 数字框 → 裁剪框 ---- */

      assert.eq(rectFromFields({ x: 10, y: 20, width: 400, height: 300 }, bounds, null, 'x'),
        { x: 10, y: 20, width: 400, height: 300 }, '改位置不动尺寸');
      assert.eq(rectFromFields({ x: -50, y: 20, width: 400, height: 300 }, bounds, null, 'x'),
        { x: 0, y: 20, width: 400, height: 300 }, '位置越界夹回来');
      assert.eq(rectFromFields({ x: 10, y: 20, width: 400, height: 300 }, bounds, 1, 'width'),
        { x: 10, y: 20, width: 400, height: 400 }, '改宽时高按比例跟上');
      assert.eq(rectFromFields({ x: 10, y: 20, width: 400, height: 300 }, bounds, 1, 'height'),
        { x: 10, y: 20, width: 300, height: 300 }, '改高时宽按比例跟上');
      assert.eq(rectFromFields({ x: 10, y: 20, width: 0, height: 300 }, bounds, null, 'width'),
        { x: 10, y: 20, width: 1, height: 300 }, '宽是 0 就抬到 1');

      /* ---- 画布上限 ---- */

      assert.eq(canvasLimit(1920, 1080).ok, true, '常见尺寸没问题');
      assert.eq(canvasLimit(32767, 100).ok, true, '刚好到上限没问题');
      assert.eq(canvasLimit(32768, 100).reason, 'side', '单边超过上限不行');
      assert.eq(canvasLimit(20000, 20000).reason, 'area', '面积超了不行');
      assert.eq(canvasLimit(0, 100).reason, 'size', '尺寸是 0 不行');

      /* ---- 解析整数 ---- */

      assert.eq(parseInteger('123', 0), 123, '数字字符串照收');
      assert.eq(parseInteger('12.6', 0), 13, '小数取整');
      assert.eq(parseInteger('', 7), 7, '空值退回旧值');
      assert.eq(parseInteger('abc', 7), 7, '不是数字退回旧值');
      assert.eq(parseInteger('-5', 7), -5, '负数照收，越界交给 clampRect 夹紧');

      /* ---- 变换矩阵 ---- */

      var same = transformMatrix(0, false, false, 800, 600);
      assert.eq(same, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, width: 800, height: 600 },
        '不转不翻就是原图');

      var rot = transformMatrix(90, false, false, 800, 600);
      assert.eq(rot, { a: 0, b: 1, c: -1, d: 0, e: 600, f: 0, width: 600, height: 800 },
        '顺时针 90°：宽高互换，矩阵是精确值');
      assert.eq(matrixApply(rot, 0, 0), { x: 600, y: 0 }, '顺时针 90°：左上角跑到右上角');
      assert.eq(matrixApply(rot, 800, 0), { x: 600, y: 800 }, '顺时针 90°：右上角跑到右下角');

      var flip = transformMatrix(0, true, false, 800, 600);
      assert.eq(flip, { a: -1, b: 0, c: 0, d: 1, e: 800, f: 0, width: 800, height: 600 },
        '水平翻转');
      assert.eq(matrixApply(flip, 0, 0), { x: 800, y: 0 }, '水平翻转：左边翻到右边');

      var diag = transformMatrix(45, false, false, 800, 600);
      assert.eq(diag.width, 990, '45°：外接框变宽');
      assert.eq(diag.height, 990, '45°：外接框变高');

      /* ---- 矩阵求逆 ---- */

      var back = matrixInverse(rot);
      var there = matrixApply(rot, 123, 456);
      assert.eq(matrixApply(back, there.x, there.y), { x: 123, y: 456 },
        '转过去再转回来是原位');
      assert.eq(matrixInverse({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }), null, '退化矩阵没有逆');

      /* ---- 变换换了，裁剪框跟着挪 ---- */

      assert.eq(remapRect({ x: 100, y: 100, width: 400, height: 300 }, same, same),
        { x: 100, y: 100, width: 400, height: 300 }, '没变就不挪');
      assert.eq(remapRect({ x: 100, y: 100, width: 400, height: 300 }, same, rot),
        { x: 200, y: 100, width: 300, height: 400 }, '转 90°：框住的还是同一块，宽高互换');
      assert.eq(remapRect({ x: 100, y: 100, width: 400, height: 300 }, same, flip),
        { x: 300, y: 100, width: 400, height: 300 }, '水平翻转：框住的还是同一块');

      /* ---- 角度 ---- */

      assert.eq(normalizeAngle(0), 0, '0 度');
      assert.eq(normalizeAngle(270), -90, '270 度折成 -90 度');
      assert.eq(normalizeAngle(-90), -90, '-90 度不动');
      assert.eq(normalizeAngle(400), 40, '400 度折成 40 度');
      assert.eq(snapAngle(90), 90, '90 度取整');
      assert.eq(snapAngle(45), 45, '45 度不动');
      assert.eq(angleSinCos(0), { c: 1, s: 0 }, '0 度的正弦余弦');
      assert.eq(angleSinCos(90), { c: 0, s: 1 }, '90 度的正弦余弦是精确值');
      assert.eq(angleSinCos(270), { c: 0, s: -1 }, '270 度的正弦余弦是精确值');

      /* ---- 三分线 ---- */

      var grid = gridLines({ x: 0, y: 0, width: 300, height: 300 });
      assert.eq(grid.length, 4, '两条竖线两条横线');
      assert.eq(grid[0], { x1: 100, y1: 0, x2: 100, y2: 300 }, '第一条竖线在三分之一处');
      assert.eq(grid[1], { x1: 0, y1: 100, x2: 300, y2: 100 }, '第一条横线在三分之一处');
      assert.eq(gridLines(null), [], '没有框就没有线');
    }
  };
}());
