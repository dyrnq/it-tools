/* ==========================================================================
   图片取色（image-palette）

   从一张图片里找出主色：算出每种颜色占了多大面积，按面积排序，
   给人起个名字（英文色名），还能用吸管点一个具体的像素，
   最后导出 CSS 变量、JSON 或者一张色卡图。

   底下是四件事，界面上看不出来，做错了结果就是错的：

   - **像素要按线性光来平均**。一格是什么颜色，是它盖住的那些像素的
     **光**的平均，不是字节的平均 —— 所以先转线性 RGB 再平均，最后转回 sRGB。
     仓库里的 bead-pattern 踩过这一整套，公式直接抄那边的。

   - **簇的中心不能取 Lab 的算术平均**。sRGB 色域在 Lab 里不是凸的，
     取算术平均会算出色域里根本没有的颜色，裁回 sRGB 之后跟簇里的像素
     对不上。所以中心点取**簇内像素在线性 RGB 里的加权平均** ——
     那就是簇里像素真正的平均值，永远在色域里。

   - **不能按权重截断前 N 个桶**。量化会把一个渐变劈成好几个碎片，
     「权重前 N」既会漏掉面积大但颜色特殊的色，也会把一个视觉上的颜色
     拆成好几个输出。所以是**权重下限过滤**（小的扔掉），
     碎片交给后面的合并规则收拾。

   - **合并的判据用人眼的那把尺子**。RGB 欧氏距离在蓝绿那一段挑不对颜色，
     所以走 CIELAB + CIEDE2000。两个颜色差得小于 3.0（CIEDE2000 在大色块上的
     刚可分辨差约 2.3）就并成一个 —— 不然会出现六个几乎一样的红。

   图片一个字节都不出浏览器：解码、取样、聚类、导出全在本地完成。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-palette');

  /* ---------- 常量 ---------- */

  /** 直方图的分桶：每个通道 5 位（32 级），一共 32³ = 32768 个桶。 */
  var BUCKET_BITS = 5;
  var BUCKET_LEVELS = 1 << BUCKET_BITS;      // 32
  var BUCKET_COUNT = BUCKET_LEVELS * BUCKET_LEVELS * BUCKET_LEVELS;  // 32768

  /** 权重下限：一个桶的权重占总权重的比例低于这个值就扔掉。
      1e-5 意味着十万分之一 —— 小到只是把噪点去掉，不会漏掉真正的颜色。 */
  var MIN_BUCKET_SHARE = 1e-5;

  /** 采样前先降采样：超过这么多像素就先把图缩到长边 2000 再统计。
      占比误差在千分之一以下，但聚类快一个数量级。 */
  var MAX_SAMPLE_PIXELS = 4000000;
  var SCRATCH_MAX = 2000;

  /** 要找几种主色。 */
  var MIN_COLOURS = 2;
  var MAX_COLOURS = 16;
  var DEFAULT_COLOURS = 6;

  /** 聚类最多迭代几轮。指派不再变就提前收工。 */
  var MAX_ITERATIONS = 24;

  /** 两个颜色的色差小于这个值就并成一个。
      CIEDE2000 在大色块上的刚可分辨差约 2.3，取 3.0 略宽松一点。 */
  var MERGE_DELTA_E = 3.0;

  /** 差得再远就不给名字了。硬套一个差 30 的名字比不给名字更糟 ——
      用户照着名字写 CSS 会对不上。 */
  var NAME_MAX_DELTA_E = 12.0;

  /** 预览图的长边上限。 */
  var PREVIEW_MAX = 1200;

  /** 色卡图的格子。 */
  var CARD_CELL_W = 240;
  var CARD_CELL_H = 160;
  var CARD_RADIUS = 8;
  var CARD_GAP = 12;
  var CARD_MARGIN = 12;
  var CARD_MAX_COLS = 4;

  /* ---------- 颜色 ---------- */

  /**
   * sRGB 分量（0..255）→ 线性（0..1）。
   *
   * sRGB 不是线性的：中间的值比线性空间里「显得」更亮。
   * 要算光的平均就得先走到线性空间去。
   */
  function srgbToLinear(c) {
    var v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  /** 线性（0..1）→ sRGB 分量（0..255），四舍五入。 */
  function linearToSrgb(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 255;
    var s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(s * 255);
  }

  /** sRGB → 线性 的查找表（256 项），取样时每个像素查一次就够。 */
  var LINEAR_LUT = (function () {
    var lut = new Float64Array(256);
    for (var i = 0; i < 256; i++) lut[i] = srgbToLinear(i);
    return lut;
  }());

  /**
   * sRGB → CIELAB（D65 白点）。
   *
   * 白点用 D65：sRGB 自己的白点就是 D65。
   * 注意 CSS Color 4 的 lab() 用的是 D50（为了跟色彩管理对齐），
   * 那是另一套口径 —— 我们这里是从 sRGB 直接推，D65 才对。
   *
   * @param {number} r 0..255
   * @param {number} g 0..255
   * @param {number} b 0..255
   * @returns {number[]} [L, a, b]
   */
  function rgbToLab(r, g, b) {
    var lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    // sRGB → XYZ（D65）
    var X = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
    var Y = 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb;
    var Z = 0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb;
    // 归一到白点
    X /= 0.95047; Y /= 1.0; Z /= 1.08883;
    var fx = labF(X), fy = labF(Y), fz = labF(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  /** CIELAB 的那个 f(t)：膝点以下走线性，以上走立方根。 */
  function labF(t) {
    var e = 216 / 24389;
    var k = 24389 / 27;
    return t > e ? Math.cbrt(t) : (k * t + 16) / 116;
  }

  /**
   * CIEDE2000 色差。
   *
   * 这是人眼看到的颜色差：同一个 ΔE 在不同色相区代表的「差得多」不一样，
   * 公式里那些 sin/cos 的修正项就是在补这个。
   *
   * @param {number[]} lab1 [L, a, b]
   * @param {number[]} lab2 [L, a, b]
   * @returns {number} 色差（0 = 完全一样）
   */
  function deltaE2000(lab1, lab2) {
    var L1 = lab1[0], a1 = lab1[1], b1 = lab1[2];
    var L2 = lab2[0], a2 = lab2[1], b2 = lab2[2];

    var C1 = Math.sqrt(a1 * a1 + b1 * b1);
    var C2 = Math.sqrt(a2 * a2 + b2 * b2);
    var Cbar = (C1 + C2) / 2;
    var Cbar7 = Math.pow(Cbar, 7);
    var G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7

    var a1p = (1 + G) * a1;
    var a2p = (1 + G) * a2;
    var C1p = Math.sqrt(a1p * a1p + b1 * b1);
    var C2p = Math.sqrt(a2p * a2p + b2 * b2);
    var Cbarp = (C1p + C2p) / 2;

    var h1p = hueAngle(b1, a1p);
    var h2p = hueAngle(b2, a2p);

    var dLp = L2 - L1;
    var dCp = C2p - C1p;
    var dhp = 0;
    if (C1p * C2p !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    var dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);

    var Lbarp = (L1 + L2) / 2;
    var Cbarp7 = Math.pow(Cbarp, 7);
    var RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));

    var hbarp;
    if (C1p * C2p === 0) {
      hbarp = h1p + h2p;
    } else if (Math.abs(h1p - h2p) <= 180) {
      hbarp = (h1p + h2p) / 2;
    } else if (h1p + h2p < 360) {
      hbarp = (h1p + h2p + 360) / 2;
    } else {
      hbarp = (h1p + h2p - 360) / 2;
    }

    var T = 1 - 0.17 * Math.cos(((hbarp - 30) * Math.PI) / 180)
      + 0.24 * Math.cos((2 * hbarp * Math.PI) / 180)
      + 0.32 * Math.cos(((3 * hbarp + 6) * Math.PI) / 180)
      - 0.20 * Math.cos(((4 * hbarp - 63) * Math.PI) / 180);

    var dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
    var RT = -Math.sin((2 * dTheta * Math.PI) / 180) * RC;

    var kL = 1, kC = 1, kH = 1;
    var SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
    var SC = 1 + 0.045 * Cbarp;
    var SH = 1 + 0.015 * Cbarp * T;

    var tL = dLp / (kL * SL);
    var tC = dCp / (kC * SC);
    var tH = dHp / (kH * SH);
    return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
  }

  /** 色相角（0..360）。a 和 b 都是 0 时色相没有意义，规定为 0。 */
  function hueAngle(b, ap) {
    if (b === 0 && ap === 0) return 0;
    var h = (Math.atan2(b, ap) * 180) / Math.PI;
    return h < 0 ? h + 360 : h;
  }

  /**
   * WCAG 的相对亮度（0..1）。
   *
   * 用来决定色块上写黑字还是白字 —— 看着办是不行的，
   * 中间的亮度写白字和写黑字都看不清。
   */
  function relativeLuminance(r, g, b) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }

  /**
   * 两个颜色的对比度比值（WCAG 定义，1..21）。
   *
   * @param {number[]} rgb1
   * @param {number[]} rgb2
   * @returns {number}
   */
  function contrastRatio(rgb1, rgb2) {
    var l1 = relativeLuminance(rgb1[0], rgb1[1], rgb1[2]);
    var l2 = relativeLuminance(rgb2[0], rgb2[1], rgb2[2]);
    if (l1 < l2) {
      var tmp = l1;
      l1 = l2;
      l2 = tmp;
    }
    return (l1 + 0.05) / (l2 + 0.05);
  }

  /** 在黑和白里挑一个跟这个底色对比更强的，当色块上字的颜色。 */
  function textColourFor(rgb) {
    return contrastRatio(rgb, [0, 0, 0]) >= contrastRatio(rgb, [255, 255, 255])
      ? '#000000'
      : '#FFFFFF';
  }

  /**
   * 解析一个十六进制色值。认不出来返回 null。
   *
   * @param {string} text
   * @returns {number[]|null} [r, g, b]
   */
  function parseHex(text) {
    if (typeof text !== 'string') return null;
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }

  /** [r,g,b] → '#rrggbb'（小写 —— CSS 里的惯例）。 */
  function rgbToHex(rgb) {
    var s = '#';
    for (var i = 0; i < 3; i++) {
      var h = rgb[i].toString(16).toLowerCase();
      s += h.length < 2 ? '0' + h : h;
    }
    return s;
  }

  /**
   * [r,g,b] → [h, s, l]（HSL，h 是 0..360，s/l 是 0..100）。
   *
   * @param {number[]} rgb
   * @returns {number[]}
   */
  function rgbToHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var h = 0;
    var s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }

  /* ---------- 英文色名 ----------
     色名是**数据**，不是文案：不进语言包、不翻译（照 bead-pattern 与 CSS 命名色的先例）。
     这些色值是我们自己定的通用色，**不是任何品牌的官方色号**。 */

  var COLOUR_NAMES = [
    { name: 'Black', hex: '#000000' },
    { name: 'Charcoal', hex: '#36454f' },
    { name: 'Dark Grey', hex: '#555555' },
    { name: 'Grey', hex: '#808080' },
    { name: 'Silver', hex: '#c0c0c0' },
    { name: 'Light Grey', hex: '#d3d3d3' },
    { name: 'White', hex: '#ffffff' },
    { name: 'Ivory', hex: '#fffff0' },
    { name: 'Cream', hex: '#fffdd0' },
    { name: 'Beige', hex: '#f5f5dc' },
    { name: 'Red', hex: '#ff0000' },
    { name: 'Dark Red', hex: '#8b0000' },
    { name: 'Crimson', hex: '#dc143c' },
    { name: 'Coral', hex: '#ff7f50' },
    { name: 'Salmon', hex: '#fa8072' },
    { name: 'Pink', hex: '#ffc0cb' },
    { name: 'Rose', hex: '#ff007f' },
    { name: 'Orange', hex: '#ff8c00' },
    { name: 'Dark Orange', hex: '#cc5500' },
    { name: 'Amber', hex: '#ffbf00' },
    { name: 'Yellow', hex: '#ffff00' },
    { name: 'Olive', hex: '#808000' },
    { name: 'Lime Green', hex: '#00ff00' },
    { name: 'Green', hex: '#008000' },
    { name: 'Dark Green', hex: '#006400' },
    { name: 'Teal', hex: '#008080' },
    { name: 'Cyan', hex: '#00ffff' },
    { name: 'Sky Blue', hex: '#87ceeb' },
    { name: 'Azure', hex: '#007fff' },
    { name: 'Steel Blue', hex: '#4682b4' },
    { name: 'Blue', hex: '#0000ff' },
    { name: 'Navy Blue', hex: '#000080' },
    { name: 'Indigo', hex: '#4b0082' },
    { name: 'Cobalt', hex: '#0047ab' },
    { name: 'Violet', hex: '#ee82ee' },
    { name: 'Purple', hex: '#800080' },
    { name: 'Lavender', hex: '#e6e6fa' },
    { name: 'Magenta', hex: '#ff00ff' },
    { name: 'Plum', hex: '#8e4585' },
    { name: 'Brown', hex: '#8b4513' },
    { name: 'Tan', hex: '#d2b48c' },
    { name: 'Coffee', hex: '#6f4e37' },
    { name: 'Chocolate', hex: '#7b3f00' }
  ];

  /** 色名表连同算好的 Lab —— 建一次，反复用。 */
  var NAME_TABLE = (function () {
    return COLOUR_NAMES.map(function (entry) {
      var rgb = parseHex(entry.hex);
      return {
        name: entry.name,
        hex: entry.hex,
        rgb: rgb,
        lab: rgbToLab(rgb[0], rgb[1], rgb[2])
      };
    });
  }());

  /* ---------- 直方图 ---------- */

  /**
   * 一个像素该落进哪个桶。
   *
   * 每通道 5 位：>>(8-5) = >>3。键是 32×32×32 的三维数组摊平成的一维下标。
   *
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @returns {number}
   */
  function bucketKey(r, g, b) {
    return (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);
  }

  /**
   * 扫一遍像素，建直方图。
   *
   * 每个桶累计：权重（按不透明度算）和**线性** RGB 的和。
   * 累计线性 RGB 而不是 sRGB：桶的均值因此就是桶内像素在光里的平均值，
   * 一点量化误差都没有 —— 量化只影响「哪些像素算同一个桶」。
   *
   * 全透明的像素一点份量都不给（权重是 0），
   * 否则边上那圈透明像素的黑色会渗进来。
   *
   * @param {Uint8ClampedArray|Uint8Array} data RGBA
   * @param {number} width
   * @param {number} height
   * @returns {object} 直方图
   */
  function buildHistogram(data, width, height) {
    var weights = new Float64Array(BUCKET_COUNT);
    var sumR = new Float64Array(BUCKET_COUNT);
    var sumG = new Float64Array(BUCKET_COUNT);
    var sumB = new Float64Array(BUCKET_COUNT);
    var totalWeight = 0;
    var pixels = 0;
    var count = width * height;
    for (var i = 0; i < count; i++) {
      var o = i * 4;
      var a = data[o + 3];
      if (a === 0) continue;
      var w = a / 255;
      var r = data[o];
      var g = data[o + 1];
      var b = data[o + 2];
      var key = bucketKey(r, g, b);
      weights[key] += w;
      sumR[key] += LINEAR_LUT[r] * w;
      sumG[key] += LINEAR_LUT[g] * w;
      sumB[key] += LINEAR_LUT[b] * w;
      totalWeight += w;
      pixels++;
    }
    return {
      weights: weights,
      sumR: sumR,
      sumG: sumG,
      sumB: sumB,
      totalWeight: totalWeight,
      pixels: pixels,
      width: width,
      height: height
    };
  }

  /**
   * 挑出值得考虑的桶。
   *
   * 判据是**权重下限**，不是「权重前 N」——
   * 量化会把一个渐变劈成好几个碎片，「前 N」既会漏掉面积大但颜色特殊的色，
   * 也会把一个视觉上的颜色拆成好几份输出。
   *
   * @param {object} hist
   * @param {number} floor 权重下限
   * @returns {Array<object>} 桶的列表
   */
  function selectBuckets(hist, floor) {
    var out = [];
    var weights = hist.weights;
    for (var key = 0; key < BUCKET_COUNT; key++) {
      var w = weights[key];
      if (w <= 0 || w < floor) continue;
      // 桶均值 = 桶内像素在光里的平均值（精确，不是桶的中心）
      var lr = hist.sumR[key] / w;
      var lg = hist.sumG[key] / w;
      var lb = hist.sumB[key] / w;
      var rgb = [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
      out.push({
        key: key,
        weight: w,
        linear: [lr, lg, lb],
        rgb: rgb,
        lab: rgbToLab(rgb[0], rgb[1], rgb[2])
      });
    }
    return out;
  }

  /**
   * 默认的权重下限。
   *
   * @param {object} hist
   * @returns {number}
   */
  function bucketFloor(hist) {
    var shareFloor = hist.totalWeight * MIN_BUCKET_SHARE;
    // 一个不透明像素的份量就是 1 —— 比这更小的桶一个像素都装不下
    var pixelFloor = 1;
    return Math.max(shareFloor, pixelFloor);
  }

  /* ---------- 聚类 ---------- */

  /**
   * Lab 空间里的平方距离。
   *
   * 迭代过程中用它（便宜），只在合并和命名的时候才用贵的 CIEDE2000。
   *
   * @param {number[]} a
   * @param {number[]} b
   * @returns {number}
   */
  function labDist2(a, b) {
    var dL = a[0] - b[0];
    var da = a[1] - b[1];
    var db = a[2] - b[2];
    return dL * dL + da * da + db * db;
  }

  /**
   * 挑初始中心点。
   *
   * 第一个取权重最大的桶；之后每次取「到最近的中心的平方距离 × 权重」最大的桶。
   * 乘上权重是必要的：纯按距离挑，会挑到权重接近 0 的离群像素上，
   * 那样初始化出来的簇全是噪点。
   *
   * 遍历顺序固定，并列永远取下标小的 —— 结果因此是确定的，
   * 同样的图跑两次必须给出同样的答案。
   *
   * @param {Array<object>} buckets
   * @param {number} k
   * @returns {Array<object>} 中心点
   */
  function initCenters(buckets, k) {
    var centers = [];
    if (!buckets.length) return centers;
    var first = 0;
    for (var i = 1; i < buckets.length; i++) {
      if (buckets[i].weight > buckets[first].weight) first = i;
    }
    centers.push(buckets[first]);
    var chosen = {};
    chosen[buckets[first].key] = true;
    while (centers.length < k) {
      var best = -1;
      var bestScore = -1;
      for (var j = 0; j < buckets.length; j++) {
        if (chosen[buckets[j].key]) continue;
        var d2 = Infinity;
        for (var c = 0; c < centers.length; c++) {
          var dd = labDist2(buckets[j].lab, centers[c].lab);
          if (dd < d2) d2 = dd;
        }
        var score = d2 * buckets[j].weight;
        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }
      if (best < 0) break;
      chosen[buckets[best].key] = true;
      centers.push(buckets[best]);
    }
    return centers;
  }

  /**
   * 簇的中心点 = 簇内像素在线性 RGB 里的加权平均。
   *
   * 绝不能取 Lab 的算术平均：sRGB 色域在 Lab 里不是凸的，
   * 中点会跑出色域，裁回 sRGB 之后跟簇里的像素对不上。
   *
   * @param {Array<object>} members 桶的列表
   * @returns {object} {linear, rgb, lab, weight}
   */
  function clusterCentre(members) {
    var lr = 0, lg = 0, lb = 0, w = 0;
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      lr += m.linear[0] * m.weight;
      lg += m.linear[1] * m.weight;
      lb += m.linear[2] * m.weight;
      w += m.weight;
    }
    if (w <= 0) {
      return { linear: [0, 0, 0], rgb: [0, 0, 0], lab: rgbToLab(0, 0, 0), weight: 0 };
    }
    lr /= w; lg /= w; lb /= w;
    var rgb = [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
    return {
      linear: [lr, lg, lb],
      rgb: rgb,
      lab: rgbToLab(rgb[0], rgb[1], rgb[2]),
      weight: w
    };
  }

  /**
   * k-means 聚类。
   *
   * 迭代到指派不再变化就停（最多 24 轮）。
   * 空的簇直接丢掉 —— 图里的颜色可能比要求的少，
   * 这时候出来的颜色数会少于用户要的，界面上要说出来。
   *
   * @param {Array<object>} buckets
   * @param {number} k
   * @param {number} iterations
   * @returns {Array<object>} 簇的列表
   */
  function kmeansPalette(buckets, k, iterations) {
    if (!buckets.length) return [];
    var centers = initCenters(buckets, k);
    if (!centers.length) return [];
    // assign 用普通数组而不是 Int32Array：那样初始值是 undefined，
    // 第一轮比较一定判「变了」，不会出现「第一轮就收敛」的假象
    var assign = [];
    var maxIter = iterations || MAX_ITERATIONS;
    for (var iter = 0; iter < maxIter; iter++) {
      var changed = false;
      for (var i = 0; i < buckets.length; i++) {
        var best = 0;
        var bestD = Infinity;
        for (var c = 0; c < centers.length; c++) {
          var d = labDist2(buckets[i].lab, centers[c].lab);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        if (assign[i] !== best) {
          assign[i] = best;
          changed = true;
        }
      }
      // 用新指派重算中心点
      var groups = [];
      for (var g = 0; g < centers.length; g++) groups.push([]);
      for (var j = 0; j < buckets.length; j++) groups[assign[j]].push(buckets[j]);
      var next = [];
      for (var k2 = 0; k2 < groups.length; k2++) {
        if (!groups[k2].length) continue;
        next.push(clusterCentre(groups[k2]));
      }
      centers = next;
      if (!changed) break;
      if (centers.length === 0) break;
    }
    // 最后再算一次权重（中心点重算时已经算过了）
    var out = [];
    for (var m = 0; m < centers.length; m++) {
      out.push({
        rgb: centers[m].rgb,
        lab: centers[m].lab,
        linear: centers[m].linear,
        weight: centers[m].weight
      });
    }
    return out;
  }

  /**
   * 合并太接近的颜色。
   *
   * 反复找出色差最小的一对：颜色数还比要求多就一定要合并，
   * 就算不超量，色差小于 3.0 的也合并（不然会出现六个几乎一样的红）。
   * 权重小的并进权重大的 —— 保住那个更有代表性的颜色。
   *
   * 合并后的颜色是按权重做的**线性加权平均**，
   * 不能取两个代表色的算术平均（那会跑出色域）。
   *
   * @param {Array<object>} clusters
   * @param {number} k 最多留几种
   * @param {number} threshold 色差阈值
   * @returns {{clusters: Array<object>, merged: number}} merged 是合并了几次
   */
  function mergeClusters(clusters, k, threshold) {
    var list = clusters.map(function (c) {
      return {
        rgb: c.rgb.slice(),
        lab: c.lab.slice(),
        linear: c.linear.slice(),
        weight: c.weight
      };
    });
    var limit = threshold === undefined ? MERGE_DELTA_E : threshold;
    var merged = 0;
    var guard = 0;
    while (list.length > 1 && guard++ < 1000) {
      var bestI = -1;
      var bestJ = -1;
      var bestDelta = Infinity;
      for (var i = 0; i < list.length; i++) {
        for (var j = i + 1; j < list.length; j++) {
          var d = deltaE2000(list[i].lab, list[j].lab);
          if (d < bestDelta) {
            bestDelta = d;
            bestI = i;
            bestJ = j;
          }
        }
      }
      if (bestI < 0) break;
      // 不超量而且差得够远，就到此为止
      if (list.length <= k && bestDelta >= limit) break;
      // 权重小的并进权重大的
      var keep = list[bestI].weight >= list[bestJ].weight ? bestI : bestJ;
      var drop = keep === bestI ? bestJ : bestI;
      var a = list[keep];
      var b = list[drop];
      var total = a.weight + b.weight;
      var lr = (a.linear[0] * a.weight + b.linear[0] * b.weight) / total;
      var lg = (a.linear[1] * a.weight + b.linear[1] * b.weight) / total;
      var lb = (a.linear[2] * a.weight + b.linear[2] * b.weight) / total;
      var rgb = [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
      list[keep] = {
        rgb: rgb,
        lab: rgbToLab(rgb[0], rgb[1], rgb[2]),
        linear: [lr, lg, lb],
        weight: total
      };
      list.splice(drop, 1);
      merged++;
    }
    return { clusters: list, merged: merged };
  }

  /* ---------- 命名 ---------- */

  /**
   * 找最近的那个色名。
   *
   * @param {number[]} lab
   * @param {number} threshold 差得超过这个数就不给名字
   * @returns {{name: string, deltaE: number}|null}
   */
  function nearestName(lab, threshold) {
    var limit = threshold === undefined ? NAME_MAX_DELTA_E : threshold;
    var best = null;
    var bestDelta = Infinity;
    for (var i = 0; i < NAME_TABLE.length; i++) {
      var d = deltaE2000(lab, NAME_TABLE[i].lab);
      if (d < bestDelta) {
        bestDelta = d;
        best = NAME_TABLE[i];
      }
    }
    if (!best || bestDelta > limit) return null;
    return { name: best.name, deltaE: bestDelta };
  }

  /**
   * 给一群颜色起名字，而且**不许重名**。
   *
   * 按占比从大到小依次分配：占比大的先挑，挑完的名字不许别人再用。
   * 名字用完了就**不给名字** —— 不留「Red 2」这种后缀，
   * 导出的 CSS 变量名干净，名字也不会骗人。
   *
   * @param {Array<object>} colours [{rgb, lab, share}]
   * @returns {Array<object>} 多了 name 与 namedBy 字段
   */
  function nameColours(colours) {
    var used = {};
    var order = colours.map(function (c, i) { return i; });
    // 占比大的先起名。并列时按原下标来，结果是确定的。
    order.sort(function (a, b) {
      var sa = colours[a].share === null ? -1 : colours[a].share;
      var sb = colours[b].share === null ? -1 : colours[b].share;
      if (sb !== sa) return sb - sa;
      return a - b;
    });
    var out = colours.map(function (c) {
      return {
        rgb: c.rgb.slice(),
        lab: c.lab.slice(),
        share: c.share,
        alpha: c.alpha === undefined || c.alpha === null ? 255 : c.alpha,
        manual: !!c.manual,
        name: null,
        namedBy: null
      };
    });
    order.forEach(function (index) {
      var c = out[index];
      var best = null;
      var bestDelta = Infinity;
      for (var i = 0; i < NAME_TABLE.length; i++) {
        if (used[NAME_TABLE[i].name]) continue;
        var d = deltaE2000(c.lab, NAME_TABLE[i].lab);
        if (d < bestDelta) {
          bestDelta = d;
          best = NAME_TABLE[i];
        }
      }
      if (!best || bestDelta > NAME_MAX_DELTA_E) return;
      used[best.name] = true;
      c.name = best.name;
      c.namedBy = bestDelta;
    });
    return out;
  }

  /**
   * 名字变成能当 CSS 变量名用的样子。
   *
   * @param {string} name
   * @returns {string}
   */
  function cssName(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /* ---------- 导出 ---------- */

  /**
   * 导出成 CSS 变量。
   *
   * 有名字用名字，没名字用序号。半透明的颜色输出 rgba()。
   *
   * @param {Array<object>} colours
   * @param {string} prefix 变量名前缀
   * @returns {string}
   */
  function formatCssVars(colours, prefix) {
    var head = prefix || '--color-';
    var lines = [];
    for (var i = 0; i < colours.length; i++) {
      var c = colours[i];
      var slug = c.name ? cssName(c.name) : String(i + 1);
      var value;
      if (c.alpha !== undefined && c.alpha !== null && c.alpha < 255) {
        value = 'rgba(' + c.rgb[0] + ', ' + c.rgb[1] + ', ' + c.rgb[2] + ', '
          + (Math.round(c.alpha / 255 * 100) / 100) + ')';
      } else {
        value = rgbToHex(c.rgb);
      }
      var note = c.share === null || c.share === undefined
        ? ''
        : ' /* ' + (Math.round(c.share * 1000) / 10) + '% */';
      lines.push(head + slug + ': ' + value + ';' + note);
    }
    return lines.join('\n');
  }

  /**
   * 导出成 JSON。
   *
   * @param {Array<object>} colours
   * @returns {string}
   */
  function formatJson(colours) {
    var rows = colours.map(function (c) {
      return {
        hex: rgbToHex(c.rgb),
        rgb: c.rgb.slice(),
        name: c.name || null,
        share: c.share === null || c.share === undefined ? null : c.share,
        alpha: c.alpha === undefined || c.alpha === null ? 255 : c.alpha
      };
    });
    return JSON.stringify(rows, null, 2);
  }

  /**
   * 色卡图的版面。
   *
   * @param {number} count 几块
   * @returns {object} {width, height, cells}
   */
  function cardLayout(count) {
    var n = Math.max(0, count);
    var cols = Math.min(CARD_MAX_COLS, Math.max(1, n));
    var rows = Math.ceil(n / cols);
    var cells = [];
    for (var i = 0; i < n; i++) {
      var c = i % cols;
      var r = Math.floor(i / cols);
      cells.push({
        index: i,
        x: CARD_MARGIN + c * (CARD_CELL_W + CARD_GAP),
        y: CARD_MARGIN + r * (CARD_CELL_H + CARD_GAP),
        w: CARD_CELL_W,
        h: CARD_CELL_H
      });
    }
    return {
      width: CARD_MARGIN * 2 + cols * CARD_CELL_W + Math.max(0, cols - 1) * CARD_GAP,
      height: CARD_MARGIN * 2 + rows * CARD_CELL_H + Math.max(0, rows - 1) * CARD_GAP,
      cells: cells,
      cols: cols,
      rows: rows
    };
  }

  /**
   * 把色卡图画到画布上。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array<object>} colours
   * @returns {object} {width, height}
   */
  function drawCard(ctx, colours) {
    var layout = cardLayout(colours.length);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);
    for (var i = 0; i < layout.cells.length; i++) {
      var cell = layout.cells[i];
      var c = colours[i];
      ctx.save();
      roundRectPath(ctx, cell.x, cell.y, cell.w, cell.h, CARD_RADIUS);
      ctx.fillStyle = rgbToHex(c.rgb);
      ctx.fill();
      ctx.clip();
      var fg = textColourFor(c.rgb);
      ctx.fillStyle = fg;
      ctx.textBaseline = 'top';
      ctx.font = '600 20px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(rgbToHex(c.rgb).toUpperCase(), cell.x + 14, cell.y + 14);
      if (c.name) {
        ctx.font = '400 17px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(c.name, cell.x + 14, cell.y + 44);
      }
      if (c.share !== null && c.share !== undefined) {
        ctx.font = '400 15px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.fillText((Math.round(c.share * 1000) / 10) + '%', cell.x + 14, cell.y + 68);
      }
      ctx.restore();
    }
    ctx.restore();
    return { width: layout.width, height: layout.height };
  }

  /**
   * 圆角矩形路径。老浏览器没有 roundRect 就用四段 arcTo 拼一个。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} r
   */
  function roundRectPath(ctx, x, y, w, h, r) {
    var radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    if (radius <= 0) {
      ctx.rect(x, y, w, h);
      return;
    }
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
      return;
    }
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /* ---------- 吸管 ---------- */

  /**
   * 屏幕坐标 → 画布上的像素。
   *
   * 画布在页面上会被 CSS 缩到容器宽度以内（max-width:100%），
   * 所以屏幕上的一个像素不等于画布上的一个像素 —— 得按两者的宽高比换算。
   *
   * @param {number} clientX
   * @param {number} clientY
   * @param {{left:number, top:number, width:number, height:number}} rect 画布在页面上的矩形
   * @param {number} canvasWidth 画布自身的像素宽
   * @param {number} canvasHeight 画布自身的像素高
   * @returns {{x:number, y:number}} 画布上的像素；换不了返回 -1
   */
  function clientToCanvas(clientX, clientY, rect, canvasWidth, canvasHeight) {
    if (!rect || !rect.width || !rect.height) return { x: -1, y: -1 };
    return {
      x: Math.floor((clientX - rect.left) * (canvasWidth / rect.width)),
      y: Math.floor((clientY - rect.top) * (canvasHeight / rect.height))
    };
  }

  /**
   * 画布上的像素 → 原图上的像素。
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   * @param {number} srcWidth
   * @param {number} srcHeight
   * @returns {{x:number, y:number}}
   */
  function canvasToSource(cx, cy, canvasWidth, canvasHeight, srcWidth, srcHeight) {
    if (!canvasWidth || !canvasHeight) return { x: -1, y: -1 };
    return {
      x: Math.floor(cx * (srcWidth / canvasWidth)),
      y: Math.floor(cy * (srcHeight / canvasHeight))
    };
  }

  /**
   * 从原图上取一个像素。
   *
   * 用一张 1×1 的暂存画布做 1:1 复制 —— 浏览器不做重采样，
   * 取到的就是原图那个像素的颜色，不是预览缩放后混出来的颜色。
   *
   * @param {*} source 原图
   * @param {number} x
   * @param {number} y
   * @returns {number[]|null} [r, g, b, a]
   */
  function pickPixel(source, x, y) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      var ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(source, x, y, 1, 1, 0, 0, 1, 1);
      var data = ctx.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2], data[3]];
    } catch (e) {
      return null;
    }
  }

  /* ---------- 文案 ---------- */

  var S = {
    title: t('title', 'Pick the colours out of a picture'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The picture is processed in your browser, nothing is uploaded.'),
    params_title: t('params_title', 'Colours'),
    label_count: t('label_count', 'Colours to find'),
    hint_count: t('hint_count', 'How many dominant colours to look for. If the picture has fewer colours than that, only the ones that are really there are listed.'),
    preview_title: t('preview_title', 'Picture'),
    hint_preview: t('hint_preview', 'Click on the picture to pick the colour under the pointer. The preview is scaled down, but the colour is taken from the original picture.'),
    picker_title: t('picker_title', 'Picked colour'),
    label_picked: t('label_picked', 'Picked'),
    no_pick: t('no_pick', 'Nothing picked yet'),
    btn_add_colour: t('btn_add_colour', 'Add to the palette'),
    palette_title: t('palette_title', 'Palette'),
    label_hex: t('label_hex', 'Colour value'),
    label_name: t('label_name', 'Name'),
    label_share: t('label_share', 'Share'),
    label_no_name: t('label_no_name', 'no close match'),
    label_manual: t('label_manual', 'picked by hand'),
    output_title: t('output_title', 'Output'),
    btn_copy_css: t('btn_copy_css', 'Copy the CSS variables'),
    btn_copy_json: t('btn_copy_json', 'Copy the JSON'),
    btn_download_card: t('btn_download_card', 'Download the colour card (PNG)'),
    hint_output: t('hint_output', 'The CSS variables use the English colour names. Colours without a close match get a number instead.'),
    result_title: t('result_title', 'Result'),
    label_size: t('label_size', 'Original size'),
    label_found: t('label_found', 'Colours found'),
    label_covered: t('label_covered', 'Share of the picture covered'),
    label_sampled: t('label_sampled', 'Pixels sampled'),
    err_read: t('err_read', 'The file could not be read.'),
    err_decode: t('err_decode', 'This picture could not be decoded.'),
    err_no_picture: t('err_no_picture', 'There is no picture yet. Choose one first.'),
    status_added: t('status_added', 'The colour was added to the palette.'),
    warn_few: t('warn_few', 'Only {n} colours are far enough apart in this picture, so that is what is listed.'),
    warn_merged: t('warn_merged', '{n} colours were too close to each other and were merged into the closest one.')
  };

  /* ---------- 工具 ---------- */

  window.ItTools.register('image-palette', function (root) {
    var disposed = false;

    var state = {
      name: '',
      decoded: null,
      width: 0,
      height: 0,
      /** 采样用的图（可能是降采样过的暂存画布）。 */
      sample: null,
      sampleWidth: 0,
      sampleHeight: 0,
      /** 预览画布与原图的比例：预览上一个像素等于原图几个像素。 */
      previewScale: 1,
      count: DEFAULT_COLOURS,
      colours: [],
      /** 手动加进来的颜色。 */
      manual: [],
      /** 这一轮合并掉了几对太接近的颜色。 */
      merged: 0,
      picked: null
    };

    /* ---------- 卡片 ---------- */

    var upload = C.uploadCard({
      accept: 'image/*',
      label: S.choose_file,
      hint: S.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);

    var paramsCard = D.h('div.card', { hidden: true });
    var previewCard = D.h('div.card', { hidden: true });
    var paletteCard = D.h('div.card', { hidden: true });
    var outputCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(paramsCard);
    root.appendChild(previewCard);
    root.appendChild(paletteCard);
    root.appendChild(outputCard);
    root.appendChild(resultCard);

    /* ---------- 控件 ---------- */

    var countSelect = D.h('select.layui-select', { id: 'ip-count' },
      D.h('option', { value: '2', text: '2' }),
      D.h('option', { value: '3', text: '3' }),
      D.h('option', { value: '4', text: '4' }),
      D.h('option', { value: '5', text: '5' }),
      D.h('option', { value: '6', text: '6' }),
      D.h('option', { value: '8', text: '8' }),
      D.h('option', { value: '10', text: '10' }),
      D.h('option', { value: '12', text: '12' }),
      D.h('option', { value: '16', text: '16' })
    );
    countSelect.value = String(DEFAULT_COLOURS);

    paramsCard.appendChild(D.h('h3', { text: S.params_title }));
    paramsCard.appendChild(U.field(S.label_count, countSelect, { hint: S.hint_count }));

    /* ---------- 预览 ---------- */

    var previewCanvas = D.h('canvas.palette-canvas');
    var pickedBox = D.h('div.palette-picked');
    var addBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: S.btn_add_colour });
    previewCard.appendChild(D.h('h3', { text: S.preview_title }));
    previewCard.appendChild(D.h('div.preview-box', null, previewCanvas));
    previewCard.appendChild(D.h('p.field-hint', { text: S.hint_preview }));
    previewCard.appendChild(D.h('h3', { text: S.picker_title }));
    previewCard.appendChild(U.field(S.label_picked, pickedBox));
    previewCard.appendChild(D.h('div.form-actions', null, addBtn));

    /* ---------- 调色板 ---------- */

    var paletteBox = D.h('div.palette-list');
    paletteCard.appendChild(D.h('h3', { text: S.palette_title }));
    paletteCard.appendChild(paletteBox);

    /* ---------- 输出 ---------- */

    var copyCssBtn = U.copyButton(function () { return formatCssVars(allColours(), '--color-'); }, S.btn_copy_css);
    var copyJsonBtn = U.copyButton(function () { return formatJson(allColours()); }, S.btn_copy_json);
    var downloadCardBtn = D.h('button.layui-btn', { type: 'button', text: S.btn_download_card });
    var statusLine = D.h('p.form-status', { id: 'ip-status' });

    outputCard.appendChild(D.h('h3', { text: S.output_title }));
    outputCard.appendChild(D.h('div.form-actions', null, copyCssBtn, copyJsonBtn, downloadCardBtn));
    outputCard.appendChild(D.h('p.field-hint', { text: S.hint_output }));
    outputCard.appendChild(statusLine);

    /* ---------- 结果 ---------- */

    var resultBody = D.h('div');
    resultCard.appendChild(D.h('h3', { text: S.result_title }));
    resultCard.appendChild(resultBody);

    /**
     * 状态行。
     *
     * @param {string} message
     * @param {string} kind 'error' | 'warn' | 空
     */
    function setStatus(message, kind) {
      statusLine.textContent = message || '';
      statusLine.classList.toggle('is-error', kind === 'error');
      statusLine.classList.toggle('is-warn', kind === 'warn');
    }

    /* ---------- 取色 ---------- */

    /**
     * 手动加的颜色和自动找的颜色合在一起 —— 导出时是一起的。
     *
     * @returns {Array<object>}
     */
    function allColours() {
      return state.colours.concat(state.manual);
    }

    /**
     * 重新起一遍名字。
     *
     * 自动色和手动色**一起**起 —— 分开起的话，手动色会拿到一个
     * 自动色已经用过的名字，导出的 CSS 变量就撞名了。
     * 手动色的占比是 null，排序时天然排在最后，所以自动色的名字不会因此改变。
     */
    function renameAll() {
      var autoCount = state.colours.length;
      var named = nameColours(state.colours.concat(state.manual));
      state.colours = named.slice(0, autoCount);
      state.manual = named.slice(autoCount);
    }

    /**
     * 载入一张图片。
     *
     * @param {File} file
     */
    function handleFile(file) {
      if (!file) return;
      upload.setStatus(S.err_read);
      C.decode(file).then(function (decoded) {
        if (disposed) {
          if (decoded && decoded.close) decoded.close();
          return;
        }
        if (state.decoded && state.decoded.close) state.decoded.close();
        state.name = file.name || 'image';
        state.decoded = decoded;
        state.width = decoded.width;
        state.height = decoded.height;
        state.manual = [];
        state.picked = null;
        upload.setStatus('');
        paramsCard.hidden = false;
        previewCard.hidden = false;
        paletteCard.hidden = false;
        outputCard.hidden = false;
        resultCard.hidden = false;
        analyse();
      }, function () {
        if (disposed) return;
        upload.setStatus(S.err_decode, true);
      });
    }

    /**
     * 采样用的图。
     *
     * 图太大就降采样：占比误差在千分之一以下，但聚类快一个数量级。
     * 吸管读的是原图，不受降采样影响。
     *
     * @returns {object} {data, width, height}
     */
    function buildSample() {
      var src = state.decoded.source;
      var w = state.width;
      var h = state.height;
      var pixels = w * h;
      if (pixels > MAX_SAMPLE_PIXELS) {
        var scale = SCRATCH_MAX / Math.max(w, h);
        var sw = Math.max(1, Math.round(w * scale));
        var sh = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        var ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(src, 0, 0, sw, sh);
          var data = ctx.getImageData(0, 0, sw, sh).data;
          return { data: data, width: sw, height: sh, scaled: true };
        }
      }
      var canvas2 = document.createElement('canvas');
      canvas2.width = w;
      canvas2.height = h;
      var ctx2 = canvas2.getContext('2d');
      if (!ctx2) return null;
      ctx2.drawImage(src, 0, 0);
      return {
        data: ctx2.getImageData(0, 0, w, h).data,
        width: w,
        height: h,
        scaled: false
      };
    }

    /**
     * 算主色。
     */
    function analyse() {
      if (!state.decoded) return;
      var sample = buildSample();
      if (!sample) {
        setStatus(S.err_decode, 'error');
        return;
      }
      state.sample = sample;
      state.sampleWidth = sample.width;
      state.sampleHeight = sample.height;

      var hist = buildHistogram(sample.data, sample.width, sample.height);
      var buckets = selectBuckets(hist, bucketFloor(hist));
      var clusters = kmeansPalette(buckets, state.count, MAX_ITERATIONS);
      var merged = mergeClusters(clusters, state.count, MERGE_DELTA_E);
      state.merged = merged.merged;

      var colours = merged.clusters.map(function (c) {
        return {
          rgb: c.rgb,
          lab: c.lab,
          share: hist.totalWeight > 0 ? c.weight / hist.totalWeight : 0,
          alpha: 255
        };
      });
      // 占比大的排前面
      colours.sort(function (a, b) { return b.share - a.share; });
      state.colours = colours;
      renameAll();

      renderPreview();
      renderPalette();
      renderResult();

      if (state.colours.length < state.count) {
        setStatus(S.warn_few.replace('{n}', String(state.colours.length)), 'warn');
      } else if (state.merged > 0) {
        setStatus(S.warn_merged.replace('{n}', String(state.merged)), 'warn');
      } else {
        setStatus('');
      }
    }

    /* ---------- 渲染 ---------- */

    /**
     * 画预览。
     */
    function renderPreview() {
      if (!state.decoded) return;
      var longest = Math.max(state.width, state.height);
      var scale = longest > PREVIEW_MAX ? PREVIEW_MAX / longest : 1;
      var cw = Math.max(1, Math.round(state.width * scale));
      var ch = Math.max(1, Math.round(state.height * scale));
      state.previewScale = cw / state.width;
      previewCanvas.width = cw;
      previewCanvas.height = ch;
      var ctx = previewCanvas.getContext('2d');
      if (!ctx) return;
      try {
        ctx.drawImage(state.decoded.source, 0, 0, cw, ch);
      } catch (e) {
        // 画不上就空着
      }
      renderPicked();
    }

    /**
     * 画「取到的颜色」。
     */
    function renderPicked() {
      D.clear(pickedBox);
      if (!state.picked) {
        pickedBox.appendChild(D.h('p.field-hint', { text: S.no_pick }));
        return;
      }
      var rgb = state.picked.rgb;
      var hsl = rgbToHsl(rgb);
      var swatch = D.h('span.palette-chip-colour');
      swatch.style.background = rgbToHex(rgb);
      pickedBox.appendChild(D.h('div.palette-picked-row', null,
        swatch,
        D.h('span.palette-picked-text', {
          text: rgbToHex(rgb).toUpperCase() + '  ·  rgb(' + rgb.join(', ') + ')  ·  hsl('
            + hsl.join(', ') + ')'
        })
      ));
    }

    /**
     * 画调色板。
     *
     * 一行一种颜色：色块 + 色值 + 名字 + 占比 + 复制。
     * 用 grid 而不是 flex —— 各列要对得整齐，表头跟正文才能对齐。
     */
    function renderPalette() {
      D.clear(paletteBox);
      var list = allColours();
      paletteBox.hidden = list.length === 0;
      if (!list.length) return;
      // 表头：跟下面每一行的列一一对应
      paletteBox.appendChild(D.h('div.palette-row.palette-row-head', null,
        D.h('span.palette-cell-empty'),
        D.h('span.palette-row-hex', { text: S.label_hex }),
        D.h('span.palette-row-name', { text: S.label_name }),
        D.h('span.palette-row-share', { text: S.label_share }),
        D.h('span.palette-cell-empty')
      ));
      for (var i = 0; i < list.length; i++) {
        (function (colour) {
          var hex = rgbToHex(colour.rgb);
          var swatch = D.h('span.palette-chip-colour');
          swatch.style.background = hex;
          var share = colour.share === null || colour.share === undefined
            ? S.label_manual
            : (Math.round(colour.share * 1000) / 10) + '%';
          var row = D.h('div.palette-row', null,
            swatch,
            D.h('span.palette-row-hex', { text: hex.toUpperCase() }),
            D.h('span.palette-row-name', { text: colour.name || S.label_no_name }),
            D.h('span.palette-row-share', { text: share }),
            U.copyButton(function () { return hex; })
          );
          paletteBox.appendChild(row);
        })(list[i]);
      }
    }

    /**
     * 画结果区。
     */
    function renderResult() {
      D.clear(resultBody);
      if (!state.decoded) return;
      var covered = 0;
      state.colours.forEach(function (c) { covered += c.share; });
      var rows = [
        [S.label_size, state.width + ' × ' + state.height],
        [S.label_found, String(state.colours.length)],
        [S.label_covered, (Math.round(covered * 1000) / 10) + '%'],
        [S.label_sampled, state.sample && state.sample.scaled
          ? state.sampleWidth + ' × ' + state.sampleHeight
          : state.width + ' × ' + state.height]
      ];
      var table = D.h('table.result-table');
      var tbody = D.h('tbody');
      rows.forEach(function (row) {
        tbody.appendChild(D.h('tr', null,
          D.h('th', { text: row[0] }),
          D.h('td', { text: row[1] })
        ));
      });
      table.appendChild(tbody);
      resultBody.appendChild(table);
    }

    /* ---------- 吸管 ---------- */

    previewCanvas.addEventListener('click', function (e) {
      if (!state.decoded) return;
      var rect = previewCanvas.getBoundingClientRect();
      // jsdom 里这个矩形全是 0 —— 除以 0 会得到 NaN
      if (!rect || !rect.width || !rect.height) return;
      var canvasPos = clientToCanvas(e.clientX, e.clientY, rect, previewCanvas.width, previewCanvas.height);
      var pos = canvasToSource(canvasPos.x, canvasPos.y, previewCanvas.width, previewCanvas.height, state.width, state.height);
      if (pos.x < 0 || pos.y < 0 || pos.x >= state.width || pos.y >= state.height) return;
      // 读**原图**，不是预览 —— 预览是缩放混合过的，颜色会偏
      var px = pickPixel(state.decoded.source, pos.x, pos.y);
      if (!px) return;
      state.picked = { rgb: [px[0], px[1], px[2]], alpha: px[3], x: pos.x, y: pos.y };
      renderPicked();
    });

    addBtn.addEventListener('click', function () {
      if (!state.picked) {
        setStatus(S.err_no_picture, 'error');
        return;
      }
      var rgb = state.picked.rgb;
      var lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
      state.manual.push({
        rgb: rgb,
        lab: lab,
        share: null,
        alpha: state.picked.alpha,
        manual: true,
        name: null
      });
      renameAll();
      setStatus(S.status_added, '');
      renderPalette();
    });

    /* ---------- 导出 ---------- */

    countSelect.addEventListener('change', function () {
      var n = parseInt(countSelect.value, 10);
      state.count = isFinite(n) ? Math.max(MIN_COLOURS, Math.min(MAX_COLOURS, n)) : DEFAULT_COLOURS;
      analyse();
    });

    downloadCardBtn.addEventListener('click', function () {
      var list = allColours();
      if (!list.length) {
        setStatus(S.err_no_picture, 'error');
        return;
      }
      var canvas = document.createElement('canvas');
      var layout = cardLayout(list.length);
      canvas.width = layout.width;
      canvas.height = layout.height;
      var ctx = canvas.getContext('2d');
      if (!ctx) {
        setStatus(S.err_no_picture, 'error');
        return;
      }
      drawCard(ctx, list);
      if (typeof canvas.toBlob !== 'function') {
        setStatus(S.err_no_picture, 'error');
        return;
      }
      try {
        canvas.toBlob(function (blob) {
          if (!blob) {
            setStatus(S.err_no_picture, 'error');
            return;
          }
          window.ItTools.download('palette.png', blob, 'image/png');
          setStatus('');
        }, 'image/png');
      } catch (e) {
        setStatus(String(e && e.message || e), 'error');
      }
    });

    return {
      destroy: function () {
        disposed = true;
        if (state.decoded && state.decoded.close) state.decoded.close();
        state.decoded = null;
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑导出 ---------- */

  window.ItTools.logic['image-palette'] = {
    srgbToLinear: srgbToLinear,
    linearToSrgb: linearToSrgb,
    rgbToLab: rgbToLab,
    deltaE2000: deltaE2000,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    textColourFor: textColourFor,
    parseHex: parseHex,
    rgbToHex: rgbToHex,
    rgbToHsl: rgbToHsl,
    bucketKey: bucketKey,
    buildHistogram: buildHistogram,
    selectBuckets: selectBuckets,
    bucketFloor: bucketFloor,
    labDist2: labDist2,
    initCenters: initCenters,
    clusterCentre: clusterCentre,
    kmeansPalette: kmeansPalette,
    mergeClusters: mergeClusters,
    nearestName: nearestName,
    nameColours: nameColours,
    /** 色名表（含算好的 Lab），测试用。 */
    nameTable: function () { return NAME_TABLE; },
    cssName: cssName,
    formatCssVars: formatCssVars,
    formatJson: formatJson,
    cardLayout: cardLayout,
    drawCard: drawCard,
    roundRectPath: roundRectPath,
    clientToCanvas: clientToCanvas,
    canvasToSource: canvasToSource,
    pickPixel: pickPixel,
    __cases: function (assert) {
      /* ---- 颜色 ----
         Sharma, Wu & Dalal (2005), CIEDE2000 的补充测试数据。
         34 对里挑几对写死在这里 —— 每一对压一个容易写错的地方：
         色相角环绕、蓝色区的旋转项、灰轴上的恒等情形。 */
      var pairs = [
        [[50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425],
        [[50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485], 3.4412],
        [[50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0],
        [[50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669],
        [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0011], 7.2195],
        [[50.0, 2.5, 0.0], [56.0, -27.0, -3.0], 31.903],
        [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146]
      ];
      pairs.forEach(function (p, i) {
        var got = deltaE2000(p[0], p[1]);
        assert(Math.abs(got - p[2]) < 1e-4, 'ΔE00 第 ' + (i + 1) + ' 对是 ' + p[2] + '，实得 ' + got);
      });
      assert(Math.abs(deltaE2000(pairs[0][0], pairs[0][1]) - deltaE2000(pairs[0][1], pairs[0][0])) < 1e-9,
        'ΔE00 是对称的');
      assert(Math.abs(deltaE2000(pairs[0][0], pairs[0][0])) < 1e-12, '同一个颜色 ΔE00 是 0');

      var white = rgbToLab(255, 255, 255);
      assert(Math.abs(white[0] - 100) < 1e-3, '白色 L 是 100');
      var red = rgbToLab(255, 0, 0);
      assert(Math.abs(red[0] - 53.2408) < 1e-3, '红色 L 是 53.2408');
      assert(Math.abs(red[1] - 80.0925) < 1e-3, '红色 a 是 80.0925');

      assert.eq(rgbToHex([255, 0, 0]), '#ff0000', 'hex 是小写的');
      assert.eq(rgbToHex([0, 128, 255]), '#0080ff', '不足两位补零');
      assert.eq(parseHex('#abc'), [170, 187, 204], '三位 hex');
      assert.eq(parseHex('nope'), null, '认不出来返回 null');
      assert.eq(rgbToHsl([255, 0, 0]), [0, 100, 50], '纯红的 HSL');
      assert.eq(rgbToHsl([0, 0, 0]), [0, 0, 0], '纯黑的 HSL');
      assert.eq(rgbToHsl([255, 255, 255]), [0, 0, 100], '纯白的 HSL');
      // 对比度：黑白是 21:1
      assert(Math.abs(contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 0.01, '黑白对比度是 21');
      assert.eq(textColourFor([255, 255, 255]), '#000000', '白底写黑字');
      assert.eq(textColourFor([0, 0, 0]), '#FFFFFF', '黑底写白字');

      /* ---- 直方图 ---- */
      // 两个像素：一半红一半蓝
      var px = new Uint8ClampedArray([
        255, 0, 0, 255, 0, 0, 255, 255
      ]);
      var hist = buildHistogram(px, 2, 1);
      assert.eq(hist.pixels, 2, '两个像素');
      assert(Math.abs(hist.totalWeight - 2) < 1e-9, '总权重是 2');
      var redBucket = selectBuckets(hist, 0);
      assert.eq(redBucket.length, 2, '红和蓝是两个桶');
      // 桶均值就是像素本身（一个桶只有一个像素）
      var redOne = redBucket.filter(function (b) { return b.rgb[0] === 255; })[0];
      assert.eq(redOne.rgb, [255, 0, 0], '红桶的均值是红');

      // 半透明的像素权重是它的一半
      var alphaPx = new Uint8ClampedArray([0, 255, 0, 128]);
      var alphaHist = buildHistogram(alphaPx, 1, 1);
      assert(Math.abs(alphaHist.totalWeight - 128 / 255) < 1e-9, '半透明的权重是一半');

      // 全透明的像素一点份量都不给
      var clearPx = new Uint8ClampedArray([0, 0, 0, 0]);
      var clearHist = buildHistogram(clearPx, 1, 1);
      assert.eq(clearHist.pixels, 0, '全透明不算数');
      assert.eq(clearHist.totalWeight, 0, '全透明的权重是 0');

      // 同一个桶里的像素，平均出来还是桶里的颜色
      var mixed = new Uint8ClampedArray([
        255, 0, 0, 255, 250, 0, 0, 255
      ]);
      var mixedHist = buildHistogram(mixed, 2, 1);
      var mixedBuckets = selectBuckets(mixedHist, 0);
      assert.eq(mixedBuckets.length, 1, '两个相近的红色落进同一个桶');
      assert.eq(mixedBuckets[0].rgb, [253, 0, 0], '桶均值是桶内像素的平均');

      assert.eq(bucketKey(0, 0, 0), 0, '全黑是第 0 个桶');
      assert.eq(bucketKey(255, 255, 255), 32767, '全白是最后一个桶');

      /* ---- 权重下限 ---- */
      var many = new Uint8ClampedArray(4 * 1000);
      for (var i = 0; i < 1000; i++) {
        many[i * 4] = 255;
        many[i * 4 + 3] = 255;
      }
      var manyHist = buildHistogram(many, 1000, 1);
      assert(manyHist.totalWeight > 0, '有像素');
      assert(bucketFloor(manyHist) > 0, '下限是正的');

      /* ---- 聚类 ---- */
      // 三个颜色：红、蓝、白，各占三分之一
      var three = new Uint8ClampedArray(12);
      for (var t = 0; t < 3; t++) {
        three[t * 4] = [255, 0, 255][t];
        three[t * 4 + 1] = [0, 0, 255][t];
        three[t * 4 + 2] = [0, 255, 255][t];
        three[t * 4 + 3] = 255;
      }
      var threeHist = buildHistogram(three, 3, 1);
      var threeBuckets = selectBuckets(threeHist, bucketFloor(threeHist));
      var threeClusters = kmeansPalette(threeBuckets, 3, MAX_ITERATIONS);
      assert.eq(threeClusters.length, 3, '三种颜色聚成三个簇');
      var reds = threeClusters.filter(function (c) { return c.rgb[0] === 255 && c.rgb[1] === 0; });
      assert.eq(reds.length, 1, '红色是一个簇');
      assert.eq(reds[0].weight, 1, '红色的权重是 1');

      // 只有两种颜色却要 6 种 —— 只能给两种
      var twoHist = buildHistogram(three, 3, 1);
      var twoClusters = kmeansPalette(selectBuckets(twoHist, 0), 6, MAX_ITERATIONS);
      assert.eq(twoClusters.length, 3, '桶只有三种，聚不出六种');

      // 确定性：同样的输入跑两遍，结果必须一样
      var a1 = kmeansPalette(selectBuckets(buildHistogram(three, 3, 1), 0), 3, MAX_ITERATIONS);
      var a2 = kmeansPalette(selectBuckets(buildHistogram(three, 3, 1), 0), 3, MAX_ITERATIONS);
      assert.eq(JSON.stringify(a1), JSON.stringify(a2), '聚类是确定的');

      /* ---- 合并 ---- */
      // 两个几乎一样的红：色差 1，应该并成一个
      var near = [
        { rgb: [255, 0, 0], lab: rgbToLab(255, 0, 0), linear: [1, 0, 0], weight: 10 },
        { rgb: [254, 0, 0], lab: rgbToLab(254, 0, 0), linear: [srgbToLinear(254), 0, 0], weight: 2 }
      ];
      assert(deltaE2000(near[0].lab, near[1].lab) < MERGE_DELTA_E, '这两个红差得够近');
      assert.eq(mergeClusters(near, 8, MERGE_DELTA_E).clusters.length, 1, '差得近就并成一个');
      // 差得远的不能并
      var far = [
        { rgb: [255, 0, 0], lab: rgbToLab(255, 0, 0), linear: [1, 0, 0], weight: 10 },
        { rgb: [0, 0, 255], lab: rgbToLab(0, 0, 255), linear: [0, 0, 1], weight: 10 }
      ];
      var farMerged = mergeClusters(far, 8, MERGE_DELTA_E);
      assert.eq(farMerged.clusters.length, 2, '差得远就不并');
      assert.eq(farMerged.merged, 0, '没并过');
      // 要求少的时候必须合并到要求的数量
      assert.eq(mergeClusters(far, 1, MERGE_DELTA_E).clusters.length, 1, '要一种就合并成一种');
      // 合并后权重是两者之和
      var mergedOne = mergeClusters(near, 1, MERGE_DELTA_E);
      assert.eq(mergedOne.clusters.length, 1, '并成一个');
      assert.eq(mergedOne.clusters[0].weight, 12, '权重是两者之和');
      assert.eq(mergedOne.merged, 1, '并了一次');
      // 合并后的颜色在线性空间里加权，不是两个代表色的算术平均
      var mergedRgb = mergedOne.clusters[0].rgb;
      assert(mergedRgb[0] > 250 && mergedRgb[0] <= 255, '合并后的红还是红');

      /* ---- 命名 ---- */
      var named = nameColours([
        { rgb: [255, 0, 0], lab: rgbToLab(255, 0, 0), share: 0.5 },
        { rgb: [0, 0, 255], lab: rgbToLab(0, 0, 255), share: 0.3 },
        { rgb: [0, 255, 0], lab: rgbToLab(0, 255, 0), share: 0.2 }
      ]);
      assert.eq(named.length, 3, '三种颜色都起了名');
      assert.eq(named[0].name, 'Red', '纯红叫 Red');
      assert.eq(named[1].name, 'Blue', '纯蓝叫 Blue');
      // 不许重名
      var names = named.map(function (c) { return c.name; });
      assert.eq(new Set(names).size, names.length, '名字不重样');
      // 差太远的不给名字：(0,192,128) 离最近的那个色名也有 21.4
      assert.eq(nearestName(rgbToLab(0, 192, 128)), null, '离所有色名都很远就不给名字');
      assert.eq(nearestName(rgbToLab(0, 192, 128), 1.0), null, '阈值收紧就更加没有名字');
      // 刚好压着阈值给一个
      assert.eq(nearestName(rgbToLab(0, 192, 128), 30.0).name, 'Lime Green', '阈值放宽就给最近的');
      // 名字不重样：两个一模一样的颜色只能有一个拿到名字
      var dup = nameColours([
        { rgb: [255, 0, 0], lab: rgbToLab(255, 0, 0), share: 0.5 },
        { rgb: [255, 0, 0], lab: rgbToLab(255, 0, 0), share: 0.3 }
      ]);
      assert.eq(dup[0].name, 'Red', '第一个拿到 Red');
      assert.eq(dup[1].name, null, '第二个没有名字了，也不叫 Red 2');

      assert.eq(cssName('Dark Grey'), 'dark-grey', '名字转成 CSS 能用的样子');
      assert.eq(cssName('Navy Blue'), 'navy-blue', '带空格的也转得掉');

      /* ---- 导出 ---- */
      var css = formatCssVars([
        { rgb: [229, 57, 53], lab: null, share: 0.402, name: 'Red', alpha: 255 },
        { rgb: [255, 255, 255], lab: null, share: 0.1, name: null, alpha: 255 }
      ], '--color-');
      assert(css.indexOf('--color-red: #e53935; /* 40.2% */') >= 0, 'CSS 变量带占比');
      assert(css.indexOf('--color-2: #ffffff;') >= 0, '没名字的用序号');
      var rgba = formatCssVars([
        { rgb: [0, 0, 0], lab: null, share: 0.5, name: null, alpha: 128 }
      ], '--color-');
      assert(rgba.indexOf('rgba(0, 0, 0, 0.5)') >= 0, '半透明输出 rgba');

      var json = JSON.parse(formatJson([
        { rgb: [229, 57, 53], lab: null, share: 0.402, name: 'Red', alpha: 255 }
      ]));
      assert.eq(json.length, 1, 'JSON 是一条');
      assert.eq(json[0].hex, '#e53935', 'JSON 里有 hex');
      assert.eq(json[0].name, 'Red', 'JSON 里有名字');
      assert.eq(json[0].rgb, [229, 57, 53], 'JSON 里有 rgb');

      /* ---- 色卡图 ---- */
      var layout = cardLayout(3);
      assert.eq(layout.cells.length, 3, '三块');
      assert(layout.width > 0 && layout.height > 0, '色卡图有尺寸');
      assert(layout.cells[0].x < layout.cells[1].x, '第二块在第一块右边');
      assert.eq(cardLayout(0).cells.length, 0, '没有颜色就没有格子');
      // 四块一行，五块就要换行
      assert(cardLayout(5).height > cardLayout(4).height, '超过一行就换行');

      /* ---- 坐标换算 ---- */
      // 预览是 600 宽，原图是 1200 宽 —— 预览一个像素等于原图两个像素
      assert.eq(canvasToSource(10, 20, 600, 400, 1200, 800), { x: 20, y: 40 }, '画布坐标换算成原图坐标');
      assert.eq(canvasToSource(0, 0, 600, 400, 1200, 800), { x: 0, y: 0 }, '左上角');
      assert.eq(canvasToSource(0, 0, 0, 0, 1200, 800), { x: -1, y: -1 }, '画布没有尺寸就换不了');
      // 画布在页面上被缩到 300 宽显示（原尺寸 600）—— 屏幕上的一个像素等于画布上的两个
      assert.eq(clientToCanvas(20, 30, { left: 10, top: 10, width: 300, height: 200 }, 600, 400),
        { x: 20, y: 40 }, '屏幕坐标换算成画布坐标');
      assert.eq(clientToCanvas(20, 30, { left: 0, top: 0, width: 0, height: 0 }, 600, 400),
        { x: -1, y: -1 }, '矩形是 0 就换不了（jsdom 全零）');
    }
  };
})();
