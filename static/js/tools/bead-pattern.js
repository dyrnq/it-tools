/* ==========================================================================
   拼豆图纸（bead-pattern）

   把一张图片变成拼豆图纸：切成格子，每格取一个代表色，匹配到最近的豆色，
   可以逐格手改，最后导出图纸 PNG 和采购清单 CSV。

   底下是三件事，界面上看不出来，做错了整张图就废了：

   - **取样要在光的世界里平均**。一格是什么颜色，是它盖住的那些像素的
     **光**的平均，不是字节的平均 —— 所以先转线性 RGB 再平均，最后转回 sRGB。
     权重是「覆盖面积 × 不透明度」：全透明的像素一点份量都不给，
     否则边上那圈透明像素的黑色会渗进来（仓库里 image-filters 踩过同一个坑）。

   - **最近色得用人眼的那把尺子**。RGB 欧氏距离在蓝绿那一段挑不对颜色，
     所以走 CIELAB + CIEDE2000。仓库里的 colord 只打了核心版，没有 delta()
     也没有 toLab()，这套得自己写一遍。公式的正确性用 Sharma 等人公开的
     34 对测试数据钉死（见下面的 __cases）。

   - **手工改动压在所有自动步骤之上**。限色、去背景都是**自动层上的掩码**，
     跑在手工改动之前 —— 用户刚涂上去的那一格，不该被一个全局开关抹掉。
     代价是最后的颜色数可能超过上限，结果卡把两个数都摆出来，不偷偷修正。

   图片一个字节都不出浏览器：解码、取样、绘制、导出全在本地完成。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('bead-pattern');

  /* ---------- 常量 ---------- */

  /** 手工改动：这一格没有手工改过。 */
  var NO_OVERRIDE = -2;
  /** 手工改动：这一格手工清空了（不放豆）。 */
  var EMPTY = -1;

  /** 浏览器画布的上限：每边 32767、总面积 268435456（约 2.68 亿像素）。 */
  var MAX_CANVAS_SIDE = 32767;
  var MAX_CANVAS_AREA = 268435456;

  /** 网格宽度（列数）的范围。 */
  var MIN_COLS = 8;
  var MAX_COLS = 64;
  var DEFAULT_COLS = 29;

  /** 格子总数上限（= 64×64）。超了整个网格等比缩小，图纸才不会大到画不下。 */
  var MAX_CELLS = 4096;

  /** 一个格子在导出的图纸里占多少像素。 */
  var MIN_CELL_PX = 12;
  var MAX_CELL_PX = 48;
  var DEFAULT_CELL_PX = 24;

  /** 取样暂存画布的长边：跟网格挂钩，保证每格至少两个暂存像素。 */
  var SCRATCH_MIN = 256;
  var SCRATCH_MAX = 1600;

  /** 重算的防抖毫秒。改滑块时别每一帧都重取样。 */
  var RECOMPUTE_DEBOUNCE_MS = 80;

  /** 格子小于这个尺寸就不写色号了 —— 写不下。 */
  var MIN_CELL_FOR_CODE = 16;
  /** 格子小于这个尺寸就不写列号了 —— 一列挤不下两个数字。 */
  var MIN_CELL_FOR_COL_LABEL = 14;

  /**
   * 画布上写字用的字体栈。
   *
   * `ctx.font` 不继承页面的 CSS font-family，只认通用族或者自己写全的栈。
   * 这套栈里带了 CJK 家族 —— 行号列号是数字，但图例上万一有中文就该能显示。
   */
  var FONT_STACK = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'WenQuanYi Zen Hei', 'Droid Sans Fallback', sans-serif";

  /* ---------- 内置色板 ----------
     色名是**数据**，不是文案：不进语言包、不翻译（照 CSS 命名色的先例）。
     这些色值是我们自己定的通用色，**不是任何品牌的官方色号**。 */

  var BUILTIN_PALETTE = [
    { code: '01', name: 'White', hex: '#FFFFFF' },
    { code: '02', name: 'Light Grey', hex: '#D9D9D9' },
    { code: '03', name: 'Grey', hex: '#808080' },
    { code: '04', name: 'Dark Grey', hex: '#4D4D4D' },
    { code: '05', name: 'Black', hex: '#000000' },
    { code: '06', name: 'Cream', hex: '#F5EEDC' },
    { code: '07', name: 'Red', hex: '#E53935' },
    { code: '08', name: 'Dark Red', hex: '#9C1B1B' },
    { code: '09', name: 'Pink', hex: '#F49AC2' },
    { code: '10', name: 'Magenta', hex: '#C2185B' },
    { code: '11', name: 'Orange', hex: '#FB8C00' },
    { code: '12', name: 'Yellow', hex: '#FDD835' },
    { code: '13', name: 'Peach', hex: '#F7B7A3' },
    { code: '14', name: 'Light Green', hex: '#7CB342' },
    { code: '15', name: 'Green', hex: '#2E7D32' },
    { code: '16', name: 'Dark Green', hex: '#1B5E20' },
    { code: '17', name: 'Mint', hex: '#80CBC4' },
    { code: '18', name: 'Cyan', hex: '#00ACC1' },
    { code: '19', name: 'Sky Blue', hex: '#4FC3F7' },
    { code: '20', name: 'Blue', hex: '#1E88E5' },
    { code: '21', name: 'Navy', hex: '#16324F' },
    { code: '22', name: 'Purple', hex: '#8E24AA' },
    { code: '23', name: 'Light Purple', hex: '#B39DDB' },
    { code: '24', name: 'Brown', hex: '#6D4C41' }
  ];

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
   * 正确性用 Sharma, Wu & Dalal (2005) 公开的 34 对测试数据验证，
   * 见文件末尾的 __cases。
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
   * 用来决定格子里写黑字还是白字 —— 看着办是不行的，
   * 中间的亮度写白字和写黑字都看不清。
   */
  function relativeLuminance(r, g, b) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }

  /** 在黑和白里挑一个跟这个底色对比更强的，当格子里字的颜色。 */
  function textColourFor(rgb) {
    var lum = relativeLuminance(rgb[0], rgb[1], rgb[2]);
    var onBlack = (lum + 0.05) / 0.05;
    var onWhite = 1.05 / (lum + 0.05);
    return onBlack >= onWhite ? '#000000' : '#FFFFFF';
  }

  /* ---------- 色板 ---------- */

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

  /**
   * 解析粘贴的色板，顺带数一数有几行没读出来。
   *
   * 一行一个色，格式宽松：
   *   A01,#FF0000        编号 + 色值
   *   A01 #FF0000        编号和色值之间隔空格也行
   *   #FF0000            只有色值，编号自动给
   *   A01,#FF0000,Red    后面还能跟一个名字（名字里可以有逗号）
   *
   * 认不出来的行整行丢掉（不抛）—— 用户粘进来一大段带说明的文本很正常。
   * 丢掉几行要告诉用户，不能悄悄吞掉。
   *
   * @param {string} text
   * @returns {{palette: Array, skipped: number}}
   */
  function parsePaletteDetailed(text) {
    var out = [];
    var skipped = 0;
    var lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      // 先把色值找出来 —— 它把这一行分成「编号」和「名字」两半。
      var m = /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(line);
      if (!m) {
        skipped++;
        continue;
      }
      var rgb = parseHex(m[0]);
      if (!rgb) {
        skipped++;
        continue;
      }
      var before = line.slice(0, m.index).replace(/[\s,:;]+$/, '');
      var after = line.slice(m.index + m[0].length).replace(/^[\s,:;]+/, '');
      var code = before;
      if (!code) {
        var n = out.length + 1;
        code = (n < 10 ? '0' : '') + n;
      }
      out.push({
        code: code,
        name: after,
        hex: rgbToHex(rgb),
        rgb: rgb
      });
    }
    return { palette: out, skipped: skipped };
  }

  /**
   * 解析粘贴的色板（只要结果那一半）。
   *
   * @param {string} text
   * @returns {Array<{code:string,name:string,hex:string,rgb:number[]}>}
   */
  function parsePalette(text) {
    return parsePaletteDetailed(text).palette;
  }

  /** [r,g,b] → '#RRGGBB'（大写）。 */
  function rgbToHex(rgb) {
    var s = '#';
    for (var i = 0; i < 3; i++) {
      var h = rgb[i].toString(16).toUpperCase();
      s += h.length < 2 ? '0' + h : h;
    }
    return s;
  }

  /**
   * 把内置色板转成和粘贴色板一样的形状（补上 rgb）。
   *
   * @returns {Array<{code:string,name:string,hex:string,rgb:number[]}>}
   */
  function builtinPalette() {
    return BUILTIN_PALETTE.map(function (p) {
      return { code: p.code, name: p.name, hex: p.hex, rgb: parseHex(p.hex) };
    });
  }

  /** 色板里每一种颜色的 Lab（算一次，反复用）。 */
  function paletteLabs(palette) {
    return palette.map(function (p) {
      return rgbToLab(p.rgb[0], p.rgb[1], p.rgb[2]);
    });
  }

  /**
   * 色板两两之间的色差，方阵。限色时找「最近的那种保留色」要用。
   *
   * @returns {Float64Array} 长度 n*n，下标 i*n+j 是 i 到 j 的色差
   */
  function paletteDistances(labs) {
    var n = labs.length;
    var d = new Float64Array(n * n);
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var v = deltaE2000(labs[i], labs[j]);
        d[i * n + j] = v;
        d[j * n + i] = v;
      }
    }
    return d;
  }

  /**
   * 一个颜色在色板里最近的哪一个。
   *
   * @param {number[]} lab 这个颜色的 Lab
   * @param {number[][]} labs 色板的 Lab 列表
   * @returns {number} 色板下标（色板是空的返回 -1）
   */
  function nearestIndex(lab, labs) {
    var best = -1;
    var bestD = Infinity;
    for (var i = 0; i < labs.length; i++) {
      var d = deltaE2000(lab, labs[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* ---------- 网格 ---------- */

  /**
   * 行数：按图片的宽高比推出来，最少一行。
   *
   * @param {number} cols 列数
   * @param {number} srcW 原图宽
   * @param {number} srcH 原图高
   * @returns {number}
   */
  function gridRows(cols, srcW, srcH) {
    if (!(cols > 0) || !(srcW > 0) || !(srcH > 0)) return 1;
    return Math.max(1, Math.round((cols * srcH) / srcW));
  }

  /**
   * 格子总数超了就等比缩小整个网格。
   *
   * 只按比例算行数，长图会把画布撑爆：1:10 的图 64 列 → 640 行，
   * 格子 48 px 就是 30720 px 高，再加行号列和图例就越过 32767 的单边上限了。
   * 等比缩小（而不是截掉）是为了整张图还在 —— 比例也不变。
   *
   * @returns {{cols:number, rows:number}}
   */
  function fitGrid(cols, rows) {
    var c = Math.max(1, Math.round(cols));
    var r = Math.max(1, Math.round(rows));
    if (c * r <= MAX_CELLS) return { cols: c, rows: r };
    var k = Math.sqrt(MAX_CELLS / (c * r));
    c = Math.max(1, Math.floor(c * k));
    r = Math.max(1, Math.floor(r * k));
    // 缩小后如果还超（取整往小的方向偏），再收一点
    while (c * r > MAX_CELLS && (c > 1 || r > 1)) {
      if (c >= r && c > 1) c--;
      else if (r > 1) r--;
      else c--;
    }
    return { cols: c, rows: r };
  }

  /**
   * 盒式平均取样：把一张图切成 cols × rows 的格子，每格给一个代表色。
   *
   * 三个要点：
   *   - 权重是「覆盖面积 × 不透明度」，颜色和分母用**同一个**权重。
   *   - 平均在线性 RGB 里做（见文件头的说明）。
   *   - 格子边界落在像素中间时按覆盖比例算（不是按像素个数）。
   *
   * 纯函数，不碰画布，可以单测。
   *
   * @param {Uint8ClampedArray|number[]} rgba 源像素（RGBA8888）
   * @param {number} srcW 源宽
   * @param {number} srcH 源高
   * @param {number} cols
   * @param {number} rows
   * @returns {{rgb: Float64Array, alpha: Float64Array}} rgb 是 3n 项，alpha 是 n 项（0..255）
   */
  function sampleGrid(rgba, srcW, srcH, cols, rows) {
    var n = cols * rows;
    var rgb = new Float64Array(n * 3);
    var alpha = new Float64Array(n);
    var lin = LINEAR_LUT;
    var cy, cx, y, x;

    for (cy = 0; cy < rows; cy++) {
      var y0 = (cy * srcH) / rows;
      var y1 = ((cy + 1) * srcH) / rows;
      var py0 = Math.floor(y0);
      var py1 = Math.min(srcH, Math.ceil(y1));
      for (cx = 0; cx < cols; cx++) {
        var x0 = (cx * srcW) / cols;
        var x1 = ((cx + 1) * srcW) / cols;
        var px0 = Math.floor(x0);
        var px1 = Math.min(srcW, Math.ceil(x1));
        var sr = 0, sg = 0, sb = 0, sw = 0;
        var areaSum = 0, alphaSum = 0;
        for (y = py0; y < py1; y++) {
          var oy = Math.min(y + 1, y1) - Math.max(y, y0);
          if (oy <= 0) continue;
          for (x = px0; x < px1; x++) {
            var ox = Math.min(x + 1, x1) - Math.max(x, x0);
            if (ox <= 0) continue;
            var o = (y * srcW + x) * 4;
            var a = rgba[o + 3];
            var area = ox * oy;
            areaSum += area;
            alphaSum += area * a;
            if (a === 0) continue; // 全透明的像素一点份量都不给
            var w = area * (a / 255);
            sr += lin[rgba[o]] * w;
            sg += lin[rgba[o + 1]] * w;
            sb += lin[rgba[o + 2]] * w;
            sw += w;
          }
        }
        var idx = cy * cols + cx;
        if (sw > 0) {
          rgb[idx * 3] = linearToSrgb(sr / sw);
          rgb[idx * 3 + 1] = linearToSrgb(sg / sw);
          rgb[idx * 3 + 2] = linearToSrgb(sb / sw);
        }
        alpha[idx] = areaSum > 0 ? alphaSum / areaSum : 0;
      }
    }
    return { rgb: rgb, alpha: alpha };
  }

  /** 取样结果里每一格的 Lab。没有颜色的（整格全透明）给 null。 */
  function sampledLabs(sampled) {
    var out = [];
    for (var i = 0; i < sampled.alpha.length; i++) {
      if (sampled.alpha[i] <= 0) { out.push(null); continue; }
      out.push(rgbToLab(sampled.rgb[i * 3], sampled.rgb[i * 3 + 1], sampled.rgb[i * 3 + 2]));
    }
    return out;
  }

  /**
   * 每格匹配到色板里最近的颜色。
   *
   * @returns {Int16Array} 色板下标；没有颜色的格子是 EMPTY
   */
  function matchGrid(labs, plabs) {
    var out = new Int16Array(labs.length);
    for (var i = 0; i < labs.length; i++) {
      out[i] = labs[i] ? nearestIndex(labs[i], plabs) : EMPTY;
    }
    return out;
  }

  /**
   * 去背景：跟背景色太近的格子变成空格。
   *
   * 判据取两个色差的**较小值**：
   *   - 取样色 vs 背景色：背景色不在色板里时只有这一条能命中；
   *   - 匹配到的豆色 vs 背景色：背景色在色板里时这一条能抓到
   *     「自动匹配正好落到背景那一条」的格子。
   *
   * @returns {{cells: Int16Array, blanked: number}}
   */
  function blankBackground(cells, labs, plabs, bgLab, tol) {
    var out = new Int16Array(cells);
    var blanked = 0;
    for (var i = 0; i < out.length; i++) {
      var v = out[i];
      if (v < 0) continue;
      var d1 = labs[i] ? deltaE2000(labs[i], bgLab) : Infinity;
      var d2 = deltaE2000(plabs[v], bgLab);
      if (Math.min(d1, d2) <= tol) {
        out[i] = EMPTY;
        blanked++;
      }
    }
    return { cells: out, blanked: blanked };
  }

  /**
   * 限色：颜色多于上限时，把**用得最少**的那种并进离它最近的保留色。
   *
   * 两件要紧的事：
   *   - 实现成「格子值 p → q 的重映射」，**绝不压缩色板数组**。
   *     压缩会让每一个手工编辑的下标都指到别的颜色上 ——
   *     而手工编辑是最后套上去的，于是得到一堆静悄悄的垃圾。
   *   - 用量要在抠完背景之后算：被抠成空格的格子不该占一个颜色名额。
   *
   * @returns {{cells: Int16Array, merged: number}} merged 是被合并掉了几种颜色
   */
  function capColours(cells, plabs, dist, max) {
    var out = new Int16Array(cells);
    if (!max || max <= 0) return { cells: out, merged: 0 };
    var n = out.length;
    var nPal = plabs.length;
    var counts = [];
    var used = [];
    var i, k;

    for (i = 0; i < n; i++) {
      var v = out[i];
      if (v < 0) continue;
      if (counts[v] === undefined) { counts[v] = 0; used.push(v); }
      counts[v]++;
    }

    var merged = 0;
    while (used.length > max) {
      // 牺牲品：用量最少的；一样少时取下标最小的（要确定性）
      var victim = used[0];
      for (k = 1; k < used.length; k++) {
        var c = used[k];
        if (counts[c] < counts[victim] || (counts[c] === counts[victim] && c < victim)) victim = c;
      }
      // 并进哪个：在**还在保留集合里**的颜色中找最近的
      var target = -1;
      var best = Infinity;
      for (k = 0; k < used.length; k++) {
        var cand = used[k];
        if (cand === victim) continue;
        var d = dist[victim * nPal + cand];
        if (d < best) { best = d; target = cand; }
      }
      if (target < 0) break; // 只剩一种颜色了，没得并
      for (i = 0; i < n; i++) if (out[i] === victim) out[i] = target;
      counts[target] += counts[victim];
      counts[victim] = 0;
      used.splice(used.indexOf(victim), 1);
      merged++;
    }
    return { cells: out, merged: merged };
  }

  /** 把手工改动盖在自动结果上。 */
  function applyEdits(cells, edits) {
    var out = new Int16Array(cells);
    if (!edits) return out;
    for (var i = 0; i < out.length && i < edits.length; i++) {
      var e = edits[i];
      if (e === NO_OVERRIDE) continue;
      out[i] = e;
    }
    return out;
  }

  /**
   * 数每种颜色用了多少颗。
   *
   * 排序：用量从多到少；一样多时按色号升序 —— 采购的时候先买用量大的。
   *
   * @returns {Array<{index:number, count:number}>}
   */
  function countByColour(cells, palette) {
    var counts = [];
    for (var i = 0; i < cells.length; i++) {
      var v = cells[i];
      if (v < 0) continue;
      counts[v] = (counts[v] || 0) + 1;
    }
    var out = [];
    for (var k in counts) {
      if (!Object.prototype.hasOwnProperty.call(counts, k)) continue;
      out.push({ index: Number(k), count: counts[k] });
    }
    out.sort(function (a, b) {
      if (a.count !== b.count) return b.count - a.count;
      var ca = String(palette[a.index].code);
      var cb = String(palette[b.index].code);
      return ca < cb ? -1 : (ca > cb ? 1 : 0);
    });
    return out;
  }

  /* ---------- 图纸 ---------- */

  /**
   * 图纸的版面：各块多大、画布多大。
   *
   * 纯算，不碰画布 —— 所以 jsdom 里没有 2D 上下文也照样能单测。
   *
   * @param {number} cols
   * @param {number} rows
   * @param {number} cellPx 一格多少像素
   * @param {number} legendCount 图例里有几种颜色
   */
  function chartLayout(cols, rows, cellPx, legendCount) {
    var fontPx = Math.min(15, Math.max(9, Math.round(cellPx * 0.4)));
    var pad = 4;
    // 行号那一列：放得下最大位数的行号
    var rowDigits = String(Math.max(1, rows)).length;
    var gutterW = Math.ceil(pad * 2 + rowDigits * fontPx * 0.62);
    // 列号那一行：格子太窄就干脆不画列号
    var gutterH = cellPx >= MIN_CELL_FOR_COL_LABEL ? Math.ceil(pad * 2 + fontPx * 1.25) : 0;
    var width = gutterW + cols * cellPx;

    // 图例：一行放几块，取决于图纸有多宽
    var swatch = Math.max(10, Math.min(20, Math.round(cellPx * 0.7)));
    var itemW = Math.ceil(swatch + 6 + 3 * fontPx * 0.62 + 8 + 4 * fontPx * 0.62 + 10);
    var perRow = Math.max(1, Math.floor((width - pad * 2) / itemW));
    var legendRows = legendCount > 0 ? Math.ceil(legendCount / perRow) : 0;
    var legendH = legendRows > 0 ? Math.ceil(pad + legendRows * (swatch + 6)) : 0;
    var height = gutterH + rows * cellPx + legendH;

    return {
      cols: cols,
      rows: rows,
      cellPx: cellPx,
      fontPx: fontPx,
      pad: pad,
      gutterW: gutterW,
      gutterH: gutterH,
      swatch: swatch,
      itemW: itemW,
      legendRows: legendRows,
      legendH: legendH,
      width: width,
      height: height
    };
  }

  /**
   * 画布上的一个点落在哪一格。不在格子里返回 -1。
   *
   * 纯函数：DOM 那头只负责把屏幕坐标换成画布像素，换完就交给它。
   */
  function cellFromPoint(px, py, layout) {
    if (!layout) return -1;
    if (!(px >= 0) || !(py >= 0)) return -1;
    if (px < layout.gutterW || py < layout.gutterH) return -1;
    var cx = Math.floor((px - layout.gutterW) / layout.cellPx);
    var cy = Math.floor((py - layout.gutterH) / layout.cellPx);
    if (cx < 0 || cx >= layout.cols || cy < 0 || cy >= layout.rows) return -1;
    return cy * layout.cols + cx;
  }

  /**
   * 画布放不下就把格子缩小 —— 而不是拒绝出图。
   *
   * 拒绝的话用户连预览都看不到，只能干瞪眼。
   * 但格子缩到最小（能写色号的尺寸）还放不下，那就真的画不出来，
   * 这时候得说「放不下」，不能画一张缺了半边的图。
   *
   * legendCount 要一起算进去：图例挂在图纸**下面**，
   * 按 8 条算好的高度，遇上 30 种颜色就不够了。
   *
   * @returns {{ok:boolean, cellPx:number, width:number, height:number, reduced:boolean}}
   */
  function chartLimit(cols, rows, cellPx, legendCount) {
    var want = Math.round(cellPx);
    if (!isFinite(want)) want = DEFAULT_CELL_PX;
    var clamped = Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, want));
    var legend = legendCount === undefined ? 8 : legendCount;
    var c = clamped;
    var layout = chartLayout(cols, rows, c, legend);
    while (
      c > MIN_CELL_PX &&
      (layout.width > MAX_CANVAS_SIDE || layout.height > MAX_CANVAS_SIDE ||
        layout.width * layout.height > MAX_CANVAS_AREA)
    ) {
      c--;
      layout = chartLayout(cols, rows, c, legend);
    }
    var fits = layout.width <= MAX_CANVAS_SIDE && layout.height <= MAX_CANVAS_SIDE &&
      layout.width * layout.height <= MAX_CANVAS_AREA;
    return {
      ok: fits,
      cellPx: c,
      width: layout.width,
      height: layout.height,
      reduced: c !== clamped
    };
  }

  /* ---------- CSV ---------- */

  /**
   * 一个 CSV 字段（RFC 4180）。
   *
   * 只在值里真的有引号、逗号、换行时才加引号，内部引号翻倍。
   */
  function csvField(value) {
    var s = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * 一张 CSV 表。
   *
   * 行之间用 \n，**不加 BOM**（仓库里 json-to-csv 也是这么做的）。
   *
   * @param {Array<Array<string>>} rows
   * @returns {string}
   */
  function buildCsv(rows) {
    return rows.map(function (row) {
      return row.map(csvField).join(',');
    }).join('\n');
  }

  /* ---------- 文案 ---------- */

  var S = {
    title: t('title', 'Turn a picture into a bead pattern'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The picture is processed in your browser, nothing is uploaded.'),
    grid_title: t('grid_title', 'Grid'),
    label_cols: t('label_cols', 'Columns'),
    hint_cols: t('hint_cols', 'The number of rows follows the proportions of the picture. A very long picture makes the whole grid smaller, so it still fits on one page.'),
    label_cell: t('label_cell', 'Cell size'),
    hint_cell: t('hint_cell', 'How many pixels one cell takes in the exported chart. The preview on screen is scaled down to fit the page.'),
    palette_title: t('palette_title', 'Palette'),
    label_palette_source: t('label_palette_source', 'Colours'),
    palette_builtin: t('palette_builtin', 'Built-in palette'),
    palette_custom: t('palette_custom', 'My own palette'),
    hint_builtin: t('hint_builtin', 'Twenty-four generic colours. These are not the official colour codes of any brand.'),
    label_palette_text: t('label_palette_text', 'My palette'),
    hint_palette_text: t('hint_palette_text', 'One colour per line. Accepted: A01,#FF0000, A01 #FF0000, #FF0000, A01,#FF0000,Red. A colour without a code gets one automatically.'),
    err_palette_empty: t('err_palette_empty', 'No usable colour was found in that text, so the palette was left as it was.'),
    err_palette_lines: t('err_palette_lines', '{n} lines could not be read and were skipped.'),
    btn_builtin_palette: t('btn_builtin_palette', 'Use the built-in palette'),
    label_max_colours: t('label_max_colours', 'Colours to use'),
    hint_max_colours: t('hint_max_colours', 'The least used colours are merged into the closest one that is kept. Colours you painted by hand are counted as they are.'),
    label_blank_bg: t('label_blank_bg', 'Remove the background'),
    label_bg_colour: t('label_bg_colour', 'Background colour'),
    hint_bg_colour: t('hint_bg_colour', 'By default the colour used most often is taken as the background.'),
    label_tolerance: t('label_tolerance', 'Tolerance'),
    hint_tolerance: t('hint_tolerance', 'How close a cell has to be to the background to count as empty, in colour difference units.'),
    chart_title: t('chart_title', 'Chart'),
    hint_chart: t('hint_chart', 'Click a cell to select it, then click a colour to paint it. The empty swatch clears the cell, the arrow puts the automatic colour back.'),
    label_selected: t('label_selected', 'Selected'),
    no_selection: t('no_selection', 'No cell is selected'),
    label_blank_swatch: t('label_blank_swatch', 'Empty'),
    label_auto_swatch: t('label_auto_swatch', 'Automatic'),
    btn_clear_edits: t('btn_clear_edits', 'Clear every hand-painted cell'),
    hint_edits_cleared: t('hint_edits_cleared', 'Changing the grid width or the palette clears every cell you edited by hand.'),
    output_title: t('output_title', 'Output'),
    btn_download_png: t('btn_download_png', 'Download the chart (PNG)'),
    btn_download_csv: t('btn_download_csv', 'Download the material list (CSV)'),
    hint_png: t('hint_png', 'The chart is exported at 1:1 pixels. The preview on screen is scaled down.'),
    result_title: t('result_title', 'Result'),
    label_grid_size: t('label_grid_size', 'Grid'),
    label_colour_count: t('label_colour_count', 'Colours used'),
    label_colour_count_over: t('label_colour_count_over', 'Colours used (limit {max})'),
    hint_colour_over: t('hint_colour_over', 'Hand-painted cells are counted as they are, so the list can be longer than the limit.'),
    label_bead_count: t('label_bead_count', 'Beads needed'),
    label_empty_count: t('label_empty_count', 'Empty cells'),
    label_source_size: t('label_source_size', 'Original size'),
    label_code: t('label_code', 'Code'),
    label_name: t('label_name', 'Colour'),
    label_hex: t('label_hex', 'Colour value'),
    label_count: t('label_count', 'Count'),
    warn_merged: t('warn_merged', '{n} colours were merged into the closest one that was kept.'),
    warn_blanked: t('warn_blanked', '{n} cells were removed as background.'),
    warn_shrunk: t('warn_shrunk', 'The chart was shrunk to {cell} pixels per cell, because a canvas that big would not fit.'),
    status_reading: t('status_reading', 'Reading the file…'),
    status_edits_cleared: t('status_edits_cleared', 'The cells you edited by hand were cleared.'),
    err_read: t('err_read', 'The file could not be read.'),
    err_decode: t('err_decode', 'This picture could not be decoded.'),
    err_no_chart: t('err_no_chart', 'There is no chart to download yet.')
  };

  /* ---------- 界面 ---------- */

  window.ItTools.register('bead-pattern', function (root) {
    var disposed = false;
    /** 竞态闸门。慢的那次算完了不许盖掉快的那次的结果。 */
    var ticket = 0;
    var recomputeTimer = null;

    var state = {
      name: '',
      decoded: null,
      width: 0,
      height: 0,
      /** 用户要的列数。 */
      cols: DEFAULT_COLS,
      /** 实际用的列数（可能被等比缩小过）。 */
      gridCols: 0,
      gridRows: 0,
      cellPx: DEFAULT_CELL_PX,
      paletteMode: 'builtin',
      paletteText: '',
      /** 当前生效的色板。 */
      palette: builtinPalette(),
      maxColours: 12,
      blankBg: false,
      /** 空 = 自动取用得最多的那种颜色。 */
      bgHex: '',
      bgTol: 10,
      /** 自动层（限色之后）。 */
      base: null,
      /** 手工改动。 */
      edits: null,
      selected: -1,
      merged: 0,
      blanked: 0,
      shrunkTo: 0
    };

    /* ---------- 卡片 ---------- */

    var upload = C.uploadCard({
      accept: 'image/*',
      label: S.choose_file,
      hint: S.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);

    var gridCard = D.h('div.card', { hidden: true });
    var paletteCard = D.h('div.card', { hidden: true });
    var chartCard = D.h('div.card', { hidden: true });
    var outputCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(gridCard);
    root.appendChild(paletteCard);
    root.appendChild(chartCard);
    root.appendChild(outputCard);
    root.appendChild(resultCard);

    /* ---------- 控件 ---------- */

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
     * @returns {{field: HTMLElement, input: HTMLElement, set: function(number)}}
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
        set: function (v) {
          var s = String(v);
          if (input.value !== s) input.value = s;
          label.textContent = labelText + ': ' + v;
        }
      };
    }

    var colsSlider = makeSlider('bp-cols', S.label_cols, MIN_COLS, MAX_COLS, DEFAULT_COLS, S.hint_cols,
      function (v) {
        state.cols = clampInt(v, MIN_COLS, MAX_COLS, DEFAULT_COLS);
        scheduleRecompute();
      });
    gridCard.appendChild(D.h('h3', { text: S.grid_title }));
    gridCard.appendChild(colsSlider.field);

    var cellSlider = makeSlider('bp-cell', S.label_cell, MIN_CELL_PX, MAX_CELL_PX, DEFAULT_CELL_PX, S.hint_cell,
      function (v) {
        state.cellPx = clampInt(v, MIN_CELL_PX, MAX_CELL_PX, DEFAULT_CELL_PX);
        // 格子大小不影响颜色，手工改动留着
        render();
      });
    gridCard.appendChild(cellSlider.field);

    var paletteSource = D.h('select.layui-select', { id: 'bp-palette-source' },
      D.h('option', { value: 'builtin', text: S.palette_builtin }),
      D.h('option', { value: 'custom', text: S.palette_custom })
    );
    var paletteText = D.h('textarea', { rows: 5, id: 'bp-palette-text', class: 'mono' });
    var paletteTextField = U.field(S.label_palette_text, paletteText, { wide: true });
    var paletteTextHint = D.h('p.field-hint', { text: S.hint_palette_text });
    var paletteBuiltinHint = D.h('p.field-hint', { text: S.hint_builtin });
    var builtinBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: S.btn_builtin_palette
    });

    var maxColours = D.h('select.layui-select', { id: 'bp-max-colours' },
      D.h('option', { value: '4', text: '4' }),
      D.h('option', { value: '8', text: '8' }),
      D.h('option', { value: '12', text: '12' }),
      D.h('option', { value: '16', text: '16' }),
      D.h('option', { value: '24', text: '24' }),
      D.h('option', { value: '0', text: '∞' })
    );
    maxColours.value = '12';

    var blankBgInput = D.h('input', { type: 'checkbox', id: 'bp-blank-bg' });
    var bgColourInput = D.h('input', { type: 'color', value: '#ffffff', id: 'bp-bg-colour' });
    var toleranceSlider = makeSlider('bp-tolerance', S.label_tolerance, 0, 100, 10, S.hint_tolerance,
      function (v) {
        state.bgTol = clampInt(v, 0, 100, 10);
        scheduleRecompute();
      });

    paletteCard.appendChild(D.h('h3', { text: S.palette_title }));
    paletteCard.appendChild(U.field(S.label_palette_source, paletteSource));
    paletteCard.appendChild(paletteTextField);
    paletteTextField.appendChild(paletteTextHint);
    paletteTextField.appendChild(paletteBuiltinHint);
    paletteCard.appendChild(D.h('div.form-actions', null, builtinBtn));
    paletteCard.appendChild(U.field(S.label_max_colours, maxColours, { hint: S.hint_max_colours }));
    paletteCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, blankBgInput, D.h('span', { text: S.label_blank_bg }))
    ));
    paletteCard.appendChild(U.field(S.label_bg_colour, bgColourInput, { hint: S.hint_bg_colour }));
    paletteCard.appendChild(toleranceSlider.field);

    /* ---------- 图纸 ---------- */

    var chartCanvas = D.h('canvas');
    var chartBox = D.h('div.preview-box', null, chartCanvas);
    var selectionHint = D.h('p.field-hint', { text: S.no_selection });
    var swatchBox = D.h('div.bead-swatches');
    var clearEditsBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: S.btn_clear_edits
    });

    chartCard.appendChild(D.h('h3', { text: S.chart_title }));
    chartCard.appendChild(chartBox);
    chartCard.appendChild(selectionHint);
    chartCard.appendChild(swatchBox);
    chartCard.appendChild(D.h('div.form-actions', null, clearEditsBtn));
    chartCard.appendChild(D.h('p.field-hint', { text: S.hint_edits_cleared }));

    /* ---------- 输出 ---------- */

    var downloadPngBtn = D.h('button.layui-btn', { type: 'button', text: S.btn_download_png });
    var downloadCsvBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: S.btn_download_csv });
    var statusLine = D.h('p.form-status', { id: 'bp-status' });

    outputCard.appendChild(D.h('h3', { text: S.output_title }));
    outputCard.appendChild(D.h('div.form-actions', null, downloadPngBtn, downloadCsvBtn));
    outputCard.appendChild(D.h('p.field-hint', { text: S.hint_png }));
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

    /* ---------- 取图 ---------- */

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
        var myTicket = ++ticket;
        C.decode(file).then(function (decoded) {
          if (disposed || myTicket !== ticket) {
            if (decoded && decoded.close) decoded.close();
            return;
          }
          // 换图的时候先把上一张的位图放掉 —— 只在销毁时关的话，
          // 中途换图会一直留着上一张。
          if (state.decoded && state.decoded.close) state.decoded.close();

          state.name = file.name || 'image';
          state.decoded = decoded;
          state.width = decoded.width;
          state.height = decoded.height;
          state.edits = null;
          state.selected = -1;

          upload.setStatus('');
          gridCard.hidden = false;
          paletteCard.hidden = false;
          chartCard.hidden = false;
          outputCard.hidden = false;
          resultCard.hidden = false;
          recompute();
        }, function () {
          if (disposed || myTicket !== ticket) return;
          upload.setStatus(S.err_decode, true);
        });
      };
      reader.onerror = function () {
        if (disposed) return;
        upload.setStatus(S.err_read, true);
      };
      reader.readAsArrayBuffer(file);
    }

    /* ---------- 重算 ---------- */

    /** 夹一个整数。harness 会往数字框里填 '123'。 */
    function clampInt(v, min, max, fallback) {
      var n = Number(v);
      if (!isFinite(n)) return fallback;
      n = Math.round(n);
      if (n < min) return min;
      if (n > max) return max;
      return n;
    }

    function scheduleRecompute() {
      if (recomputeTimer) clearTimeout(recomputeTimer);
      recomputeTimer = setTimeout(function () {
        recomputeTimer = null;
        try {
          recompute();
        } catch (e) {
          setStatus(String(e && e.message || e), 'error');
        }
      }, RECOMPUTE_DEBOUNCE_MS);
    }

    /**
     * 把图片取样、匹配、抠背景、限色，重建自动层。
     */
    function recompute() {
      if (!state.decoded) return;
      var rows = gridRows(state.cols, state.width, state.height);
      var fit = fitGrid(state.cols, rows);
      var shapeChanged = (fit.cols !== state.gridCols || fit.rows !== state.gridRows);
      state.gridCols = fit.cols;
      state.gridRows = fit.rows;
      // 网格形状变了，手工改动的下标就指到别的格子上了 —— 清掉
      if (shapeChanged) {
        // 静悄悄地清掉不行：用户会以为刚才涂的还在
        if (state.edits) setStatus(S.status_edits_cleared, 'warn');
        state.edits = null;
        state.selected = -1;
      }

      var sampled = takeSample();
      if (!sampled) return;
      var labs = sampledLabs(sampled);
      var plabs = paletteLabs(state.palette);
      var dist = paletteDistances(plabs);

      var cells = matchGrid(labs, plabs);
      state.blanked = 0;
      if (state.blankBg) {
        var bg = pickBackground(cells, plabs);
        if (bg) {
          var blanked = blankBackground(cells, labs, plabs, bg, state.bgTol);
          cells = blanked.cells;
          state.blanked = blanked.blanked;
        }
      }
      var capped = capColours(cells, plabs, dist, state.maxColours);
      state.base = capped.cells;
      state.merged = capped.merged;

      render();
    }

    /**
     * 取样：把原图缩到一张暂存画布上，再盒式平均切格子。
     *
     * 暂存画布**不预填白底** —— 预填了的话透明像素会变成不透明白，
     * 那就永远抠不掉背景了。
     *
     * @returns {object|null} sampleGrid 的结果
     */
    function takeSample() {
      var src = state.decoded.source;
      var cols = state.gridCols;
      var rows = state.gridRows;
      if (!cols || !rows) return null;
      var long = Math.min(SCRATCH_MAX, Math.max(SCRATCH_MIN, Math.max(cols, rows) * 2));
      var sw, sh;
      if (state.width >= state.height) {
        sw = long;
        sh = Math.max(1, Math.round((long * state.height) / state.width));
      } else {
        sh = long;
        sw = Math.max(1, Math.round((long * state.width) / state.height));
      }
      var scratch = document.createElement('canvas');
      scratch.width = sw;
      scratch.height = sh;
      var ctx = scratch.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, sw, sh);
      var data;
      try {
        data = ctx.getImageData(0, 0, sw, sh).data;
      } catch (e) {
        return null;
      }
      return sampleGrid(data, sw, sh, cols, rows);
    }

    /**
     * 背景色：用户指定的就用指定的，没指定就取用得最多的那种豆色。
     *
     * @returns {number[]|null} Lab
     */
    function pickBackground(cells, plabs) {
      if (state.bgHex) {
        var rgb = parseHex(state.bgHex);
        if (rgb) return rgbToLab(rgb[0], rgb[1], rgb[2]);
      }
      var counts = [];
      for (var i = 0; i < cells.length; i++) {
        var v = cells[i];
        if (v < 0) continue;
        counts[v] = (counts[v] || 0) + 1;
      }
      var best = -1;
      var bestCount = 0;
      for (var k in counts) {
        if (!Object.prototype.hasOwnProperty.call(counts, k)) continue;
        if (counts[k] > bestCount) { bestCount = counts[k]; best = Number(k); }
      }
      if (best < 0) return null;
      return plabs[best];
    }

    /* ---------- 画图纸 ---------- */

    /**
     * 画图纸。屏幕上的预览和导出的 PNG 是**同一张画布**。
     *
     * @param {object} layout
     * @param {Int16Array} cells 最终的格子（自动层 + 手工改动）
     * @param {number[]} counts 用到的颜色与数量
     */
    function drawChart(layout, cells, counts) {
      var ctx = chartCanvas.getContext('2d');
      if (!ctx) return; // jsdom 里没有 2D 上下文
      var cellPx = layout.cellPx;

      // 量文字必须在单位变换下做
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, layout.width, layout.height);
      // 纸是白的 —— 这是一张要打印的图纸
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, layout.width, layout.height);

      var i, cy, cx, v;
      for (cy = 0; cy < layout.rows; cy++) {
        for (cx = 0; cx < layout.cols; cx++) {
          i = cy * layout.cols + cx;
          v = cells[i];
          var x = layout.gutterW + cx * cellPx;
          var y = layout.gutterH + cy * cellPx;
          if (v === EMPTY) {
            drawCheckerboard(ctx, x, y, cellPx);
          } else {
            ctx.fillStyle = state.palette[v].hex;
            ctx.fillRect(x, y, cellPx, cellPx);
          }
          // 网格线：+0.5 的半像素偏移，否则线会虚
          ctx.strokeStyle = 'rgba(0,0,0,0.22)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, cellPx - 1, cellPx - 1);
        }
      }

      // 格子里的色号
      if (cellPx >= MIN_CELL_FOR_CODE) {
        ctx.font = layout.fontPx + 'px ' + FONT_STACK;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        for (cy = 0; cy < layout.rows; cy++) {
          for (cx = 0; cx < layout.cols; cx++) {
            i = cy * layout.cols + cx;
            v = cells[i];
            if (v === EMPTY) continue;
            var entry = state.palette[v];
            ctx.fillStyle = textColourFor(entry.rgb);
            var x2 = layout.gutterW + cx * cellPx;
            var y2 = layout.gutterH + cy * cellPx;
            var w = ctx.measureText(entry.code).width;
            ctx.fillText(entry.code, x2 + (cellPx - w) / 2, y2 + cellPx / 2 + layout.fontPx * 0.35);
          }
        }
      }

      // 行号（左）和列号（上）
      ctx.font = layout.fontPx + 'px ' + FONT_STACK;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#444444';
      for (cy = 0; cy < layout.rows; cy++) {
        var label = String(cy + 1);
        var lw = ctx.measureText(label).width;
        ctx.fillText(label, layout.gutterW - layout.pad - lw, layout.gutterH + cy * cellPx + cellPx / 2 + layout.fontPx * 0.35);
      }
      if (layout.gutterH > 0) {
        for (cx = 0; cx < layout.cols; cx++) {
          var clabel = String(cx + 1);
          var cw = ctx.measureText(clabel).width;
          ctx.fillText(clabel, layout.gutterW + cx * cellPx + (cellPx - cw) / 2, layout.gutterH - layout.pad - layout.fontPx * 0.35);
        }
      }

      // 选中的那一格：描一圈
      if (state.selected >= 0 && state.selected < cells.length) {
        var scx = state.selected % layout.cols;
        var scy = Math.floor(state.selected / layout.cols);
        ctx.strokeStyle = '#1565c0';
        ctx.lineWidth = 2;
        ctx.strokeRect(
          layout.gutterW + scx * cellPx + 1,
          layout.gutterH + scy * cellPx + 1,
          cellPx - 2,
          cellPx - 2
        );
      }

      // 图例
      if (counts.length > 0) {
        var ly = layout.gutterH + layout.rows * cellPx + layout.pad;
        var perRow = Math.max(1, Math.floor((layout.width - layout.pad * 2) / layout.itemW));
        for (var k = 0; k < counts.length; k++) {
          var col = k % perRow;
          var row = Math.floor(k / perRow);
          var lx = layout.pad + col * layout.itemW;
          var ty = ly + row * (layout.swatch + 6);
          var pe = state.palette[counts[k].index];
          ctx.fillStyle = pe.hex;
          ctx.fillRect(lx, ty, layout.swatch, layout.swatch);
          ctx.strokeStyle = 'rgba(0,0,0,0.3)';
          ctx.lineWidth = 1;
          ctx.strokeRect(lx + 0.5, ty + 0.5, layout.swatch - 1, layout.swatch - 1);
          ctx.fillStyle = '#222222';
          ctx.font = layout.fontPx + 'px ' + FONT_STACK;
          ctx.textBaseline = 'alphabetic';
          ctx.textAlign = 'left';
          ctx.fillText(pe.code, lx + layout.swatch + 6, ty + layout.swatch - layout.fontPx * 0.35);
          var ctext = String(counts[k].count);
          var cw2 = ctx.measureText(ctext).width;
          ctx.fillText(ctext, lx + layout.itemW - cw2 - 6, ty + layout.swatch - layout.fontPx * 0.35);
        }
      }
    }

    /** 空格画成棋盘格（抄 image-cropper 的画法）。 */
    function drawCheckerboard(ctx, x, y, size) {
      var half = Math.max(2, Math.round(size / 4));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = '#e6e6e6';
      ctx.fillRect(x, y, half, half);
      ctx.fillRect(x + half, y + half, half, half);
    }

    /* ---------- 画色板色块 ---------- */

    /**
     * 重建色板色块。只有色板变了才重建 —— 每次编辑都重建的话，
     * 点一遍色块会顺带把图重新取样一遍。
     */
    function buildSwatches() {
      D.clear(swatchBox);
      // 两个特殊色块：空格、恢复自动
      swatchBox.appendChild(makeSwatchButton(S.label_blank_swatch, 'checker', function () {
        applyEdit(EMPTY);
      }));
      swatchBox.appendChild(makeSwatchButton(S.label_auto_swatch, 'auto', function () {
        applyEdit(NO_OVERRIDE);
      }));
      for (var i = 0; i < state.palette.length; i++) {
        (function (index) {
          var entry = state.palette[index];
          swatchBox.appendChild(makeSwatchButton(entry.code, entry.hex, function () {
            applyEdit(index);
          }, entry.name, entry.rgb));
        }(i));
      }
    }

    /**
     * 一个色块按钮。
     *
     * @param {string} label 按钮上的字
     * @param {string} fill 底色（'checker' 是空格的花纹，'auto' 是恢复自动）
     * @param {function(): void} onClick
     * @param {string} title 悬停提示
     */
    function makeSwatchButton(label, fill, onClick, title, rgb) {
      var btn = D.h('button.bead-swatch', { type: 'button', title: title || label });
      var text = D.h('span.bead-swatch-label', { text: label });
      if (fill === 'checker') {
        btn.classList.add('is-checker');
      } else if (fill === 'auto') {
        btn.classList.add('is-auto');
      } else {
        btn.style.background = fill;
        // 色号字要看得清：深色上写白字、浅色上写黑字。
        // 靠相对亮度判断，别靠眼睛。
        if (rgb) text.style.color = textColourFor(rgb);
      }
      btn.appendChild(text);
      btn.addEventListener('click', function () {
        try {
          onClick();
        } catch (e) {
          setStatus(String(e && e.message || e), 'error');
        }
      });
      return btn;
    }

    /* ---------- 编辑 ---------- */

    /**
     * 改一格。edits[i] = 值：EMPTY 清空，NO_OVERRIDE 恢复自动，下标是颜色。
     *
     * @param {number} value
     */
    function applyEdit(value) {
      if (state.selected < 0) {
        setStatus(S.no_selection);
        return;
      }
      if (!state.edits) {
        state.edits = new Int16Array(state.gridCols * state.gridRows);
        state.edits.fill(NO_OVERRIDE);
      }
      if (state.selected >= state.edits.length) return;
      state.edits[state.selected] = value;
      render();
    }

    /** 画布上的点击 → 选中一格。 */
    function onChartClick(ev) {
      var rect = chartCanvas.getBoundingClientRect();
      // jsdom 里这个矩形全是零 —— 不挡的话会算出 NaN 的下标
      if (!rect.width || !rect.height) return;
      var px = (ev.clientX - rect.left) * (chartCanvas.width / rect.width);
      var py = (ev.clientY - rect.top) * (chartCanvas.height / rect.height);
      var idx = cellFromPoint(px, py, state.layout || chartLayout(state.gridCols, state.gridRows, state.cellPx, 0));
      state.selected = idx >= 0 ? idx : -1;
      updateSelectionHint();
      render();
    }

    function updateSelectionHint() {
      if (state.selected < 0) {
        selectionHint.textContent = S.no_selection;
        return;
      }
      var cx = (state.selected % state.gridCols) + 1;
      var cy = Math.floor(state.selected / state.gridCols) + 1;
      selectionHint.textContent = S.label_selected + ': ' + cx + ', ' + cy;
    }

    /* ---------- 画 ---------- */

    /**
     * 重画图纸并刷新结果表。
     *
     * 只做「拿已有的自动层 + 手工改动 → 画」，不重新取样 ——
     * 所以改一格是立刻出结果的。
     */
    function render() {
      if (!state.base || !state.gridCols) {
        updateSelectionHint();
        return;
      }
      var cells = applyEdits(state.base, state.edits);
      var counts = countByColour(cells, state.palette);

      // 画布放不下就把格子缩小，而不是拒绝出图
      var limit = chartLimit(state.gridCols, state.gridRows, state.cellPx, counts.length);
      state.shrunkTo = limit.reduced ? limit.cellPx : 0;
      var cellPx = limit.cellPx;
      var layout = chartLayout(state.gridCols, state.gridRows, cellPx, counts.length);
      state.layout = layout;

      if (chartCanvas.width !== layout.width || chartCanvas.height !== layout.height) {
        chartCanvas.width = layout.width;
        chartCanvas.height = layout.height;
      }
      drawChart(layout, cells, counts);
      renderResult(cells, counts);
    }

    /** 结果卡：统计 + 每种颜色一行。 */
    function renderResult(cells, counts) {
      D.clear(resultBody);

      var beads = 0;
      var empty = 0;
      for (var i = 0; i < cells.length; i++) {
        if (cells[i] === EMPTY) empty++;
        else beads++;
      }

      var over = state.maxColours > 0 && counts.length > state.maxColours;
      var rows = [
        { label: S.label_grid_size, value: state.gridCols + ' × ' + state.gridRows },
        {
          label: over ? S.label_colour_count_over.replace('{max}', String(state.maxColours)) : S.label_colour_count,
          value: String(counts.length)
        },
        { label: S.label_bead_count, value: String(beads) },
        { label: S.label_empty_count, value: String(empty) },
        { label: S.label_source_size, value: state.width + ' × ' + state.height }
      ];
      var kv = D.h('table.kv-table');
      kv.appendChild(D.h('thead', null, D.h('tr', null,
        D.h('th', { text: S.label_name }),
        D.h('th', { text: S.label_count })
      )));
      var kvBody = D.h('tbody');
      rows.forEach(function (row) {
        kvBody.appendChild(D.h('tr', null,
          D.h('td', { text: row.label }),
          D.h('td.val', { text: row.value })
        ));
      });
      kv.appendChild(kvBody);
      resultBody.appendChild(kv);

      // 每种颜色一行
      var table = D.h('table.result-table');
      table.appendChild(D.h('thead', null, D.h('tr', null,
        D.h('th', { text: S.label_code }),
        D.h('th', { text: S.label_name }),
        D.h('th', { text: S.label_hex }),
        D.h('th', { text: S.label_count })
      )));
      var tbody = D.h('tbody');
      counts.forEach(function (c) {
        var entry = state.palette[c.index];
        var swatch = D.h('span.bead-chip', { style: { background: entry.hex } });
        tbody.appendChild(D.h('tr', null,
          D.h('td', null, swatch, D.h('span', { text: entry.code })),
          D.h('td', { text: entry.name }),
          D.h('td', null, D.h('span', { text: entry.hex }), U.copyButton(function () { return entry.hex; })),
          D.h('td', { text: String(c.count) })
        ));
      });
      table.appendChild(tbody);
      resultBody.appendChild(table);

      // 警告
      if (over) resultBody.appendChild(D.h('p.form-status.is-warn', { text: S.hint_colour_over }));
      if (state.merged > 0) {
        resultBody.appendChild(D.h('p.form-status.is-warn', { text: S.warn_merged.replace('{n}', String(state.merged)) }));
      }
      if (state.blanked > 0) {
        resultBody.appendChild(D.h('p.form-status.is-warn', { text: S.warn_blanked.replace('{n}', String(state.blanked)) }));
      }
      if (state.shrunkTo > 0) {
        resultBody.appendChild(D.h('p.form-status.is-warn', { text: S.warn_shrunk.replace('{cell}', String(state.shrunkTo)) }));
      }
    }

    /* ---------- 导出 ---------- */

    function baseName() {
      var name = state.name || 'image';
      var dot = name.lastIndexOf('.');
      return dot > 0 ? name.slice(0, dot) : name;
    }

    function downloadChart() {
      if (!state.base || !state.layout) {
        setStatus(S.err_no_chart, 'error');
        return;
      }
      // 先重画一次 —— 防抖里可能还挂着一版旧的
      render();
      if (typeof chartCanvas.toBlob !== 'function') {
        setStatus(S.err_no_chart, 'error');
        return;
      }
      try {
        chartCanvas.toBlob(function (blob) {
          if (!blob) {
            setStatus(S.err_no_chart, 'error');
            return;
          }
          window.ItTools.download(baseName() + '-pattern.png', blob, 'image/png');
          setStatus('');
        }, 'image/png');
      } catch (e) {
        setStatus(String(e && e.message || e), 'error');
      }
    }

    function downloadCsv() {
      if (!state.base) {
        setStatus(S.err_no_chart, 'error');
        return;
      }
      var cells = applyEdits(state.base, state.edits);
      var counts = countByColour(cells, state.palette);
      var rows = [[S.label_code, S.label_name, S.label_hex, S.label_count]];
      counts.forEach(function (c) {
        var entry = state.palette[c.index];
        rows.push([entry.code, entry.name, entry.hex, String(c.count)]);
      });
      var csv = buildCsv(rows);
      window.ItTools.download(baseName() + '-beads.csv', csv, 'text/csv;charset=utf-8');
      setStatus('');
    }

    /* ---------- 事件 ---------- */

    paletteSource.addEventListener('change', function () {
      var v = paletteSource.value;
      state.paletteMode = (v === 'custom') ? 'custom' : 'builtin';
      applyPalette(state.paletteMode === 'custom' ? parsePalette(state.paletteText) : builtinPalette(), true);
    });

    paletteText.addEventListener('input', function () {
      state.paletteText = paletteText.value || '';
      if (state.paletteMode !== 'custom') return;
      var parsed = parsePaletteDetailed(state.paletteText);
      applyPalette(parsed.palette, false, parsed.skipped);
    });

    builtinBtn.addEventListener('click', function () {
      state.paletteMode = 'builtin';
      paletteSource.value = 'builtin';
      applyPalette(builtinPalette(), true);
    });

    maxColours.addEventListener('change', function () {
      state.maxColours = clampInt(maxColours.value, 0, 64, 12);
      // 限色只重映射格子、不动色板 → 手工改动留着
      scheduleRecompute();
    });

    blankBgInput.addEventListener('change', function () {
      state.blankBg = !!blankBgInput.checked;
      bgColourInput.disabled = !state.blankBg;
      toleranceSlider.input.disabled = !state.blankBg;
      scheduleRecompute();
    });

    bgColourInput.addEventListener('input', function () {
      var v = bgColourInput.value;
      if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) return;
      state.bgHex = v;
      scheduleRecompute();
    });

    clearEditsBtn.addEventListener('click', function () {
      if (!state.edits) return;
      state.edits.fill(NO_OVERRIDE);
      setStatus(S.status_edits_cleared, 'warn');
      render();
    });

    downloadPngBtn.addEventListener('click', downloadChart);
    downloadCsvBtn.addEventListener('click', downloadCsv);

    chartCanvas.addEventListener('click', onChartClick);

    /**
     * 换色板。色板变了，之前手工改的下标就指到别的颜色上了 —— 清掉。
     *
     * @param {Array} palette 新色板
     * @param {boolean} announce 要不要在状态行说一声
     * @param {number} skipped 解析时丢掉了几行
     */
    function applyPalette(palette, announce, skipped) {
      var bad = skipped || 0;
      if (!palette || palette.length === 0) {
        if (announce) setStatus(S.err_palette_empty, 'error');
        return;
      }
      var hadEdits = !!state.edits;
      state.palette = palette;
      state.edits = null;
      state.selected = -1;
      buildSwatches();
      if (bad > 0) {
        // 丢掉几行要说出来 —— 静悄悄地少几种颜色，用户以为自己贴全了
        setStatus(S.err_palette_lines.replace('{n}', String(bad)), 'warn');
      } else if (hadEdits) {
        // 换色板把手工改动清掉了 —— 说一声，别让用户以为刚才涂的还在
        setStatus(S.status_edits_cleared, 'warn');
      } else if (announce) {
        setStatus('');
      }
      scheduleRecompute();
    }

    // 一开始就把色块摆出来（色板是内置的，不等图）
    buildSwatches();

    return {
      destroy: function () {
        disposed = true;
        ticket++;
        if (recomputeTimer) clearTimeout(recomputeTimer);
        recomputeTimer = null;
        if (state.decoded && state.decoded.close) state.decoded.close();
        state.decoded = null;
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['bead-pattern'] = {
    NO_OVERRIDE: NO_OVERRIDE,
    EMPTY: EMPTY,
    MAX_CELLS: MAX_CELLS,
    BUILTIN_PALETTE: BUILTIN_PALETTE,
    srgbToLinear: srgbToLinear,
    linearToSrgb: linearToSrgb,
    rgbToLab: rgbToLab,
    deltaE2000: deltaE2000,
    relativeLuminance: relativeLuminance,
    parseHex: parseHex,
    parsePalette: parsePalette,
    builtinPalette: builtinPalette,
    paletteLabs: paletteLabs,
    paletteDistances: paletteDistances,
    nearestIndex: nearestIndex,
    gridRows: gridRows,
    fitGrid: fitGrid,
    sampleGrid: sampleGrid,
    sampledLabs: sampledLabs,
    matchGrid: matchGrid,
    blankBackground: blankBackground,
    capColours: capColours,
    applyEdits: applyEdits,
    countByColour: countByColour,
    chartLayout: chartLayout,
    cellFromPoint: cellFromPoint,
    chartLimit: chartLimit,
    csvField: csvField,
    buildCsv: buildCsv,
    __cases: function (assert) {
      /* ---- 色差 ----
         Sharma, Wu & Dalal (2005), CIEDE2000 的补充测试数据。
         34 对里挑 12 对写死在这里 —— 每一对压一个容易写错的地方：
         色相角环绕、蓝色区的旋转项、灰轴上的恒等情形。
         第 30 对是 1.4146 —— 手抄最容易把它重样成 1.2644。 */
      var pairs = [
        [[50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425],
        [[50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615],
        [[50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485], 3.4412],
        [[50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0],
        [[50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669],
        [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0011], 7.2195],
        [[50.0, -0.001, 2.49], [50.0, 0.0011, -2.49], 4.7461],
        [[50.0, 2.5, 0.0], [56.0, -27.0, -3.0], 31.903],
        [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
        [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
        [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
        [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082]
      ];
      pairs.forEach(function (p, i) {
        var got = deltaE2000(p[0], p[1]);
        assert(Math.abs(got - p[2]) < 1e-4, 'ΔE00 第 ' + (i + 1) + ' 对是 ' + p[2] + '，实得 ' + got);
      });
      var labA = [50.0, 2.6772, -79.7751];
      var labB = [50.0, 0.0, -82.7485];
      assert(Math.abs(deltaE2000(labA, labB) - deltaE2000(labB, labA)) < 1e-9, 'ΔE00 是对称的');
      assert(Math.abs(deltaE2000(labA, labA)) < 1e-12, '同一个颜色 ΔE00 是 0');

      /* ---- Lab ----
         浮点上不是精确的 100：sRGB 矩阵的三行加起来是 0.9504700000000001
         而不是 0.95047，所以白点的 L 差个几微。容差给到 1e-3。 */
      var white = rgbToLab(255, 255, 255);
      assert(Math.abs(white[0] - 100) < 1e-3, '白色 L 是 100');
      assert(Math.abs(white[1]) < 1e-3 && Math.abs(white[2]) < 1e-3, '白色 a b 都是 0');
      var red = rgbToLab(255, 0, 0);
      assert(Math.abs(red[0] - 53.2408) < 1e-3, '红色 L 是 53.2408');
      assert(Math.abs(red[1] - 80.0925) < 1e-3, '红色 a 是 80.0925');
      assert(Math.abs(red[2] - 67.2032) < 1e-3, '红色 b 是 67.2032');
      var blue = rgbToLab(0, 0, 255);
      assert(Math.abs(blue[0] - 32.297) < 1e-3, '蓝色 L 是 32.297');
      assert(Math.abs(blue[1] - 79.1875) < 1e-3, '蓝色 a 是 79.1875');
      assert(Math.abs(blue[2] + 107.8602) < 1e-3, '蓝色 b 是 -107.8602');
      assert(Math.abs(rgbToLab(128, 128, 128)[0] - 53.585) < 1e-3, '中灰 L 是 53.585');

      /* ---- 取样 ---- */
      var quads = new Uint8ClampedArray([
        255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 255, 255, 255, 255, 255, 255
      ]);
      // 四原色合成一格：在线性空间平均是 0.5 → sRGB 187.5 → 188
      // （在 sRGB 空间平均会得到 127，这是最常见的那个错）
      var one = sampleGrid(quads, 2, 2, 1, 1);
      assert.eq([one.rgb[0], one.rgb[1], one.rgb[2]], [188, 188, 188], '四原色的一格是灰 188');
      var four = sampleGrid(quads, 2, 2, 2, 2);
      assert.eq([four.rgb[0], four.rgb[1], four.rgb[2]], [255, 0, 0], '第 (0,0) 格是红');
      assert.eq([four.rgb[3], four.rgb[4], four.rgb[5]], [0, 255, 0], '第 (1,0) 格是绿');
      assert.eq([four.rgb[6], four.rgb[7], four.rgb[8]], [0, 0, 255], '第 (0,1) 格是蓝');
      assert.eq([four.rgb[9], four.rgb[10], four.rgb[11]], [255, 255, 255], '第 (1,1) 格是白');
      // 格子边界落在像素中间：中间那个白像素各占一半 → 两格都是 156
      var thirds = new Uint8ClampedArray([
        0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255
      ]);
      var halves = sampleGrid(thirds, 3, 1, 2, 1);
      assert.eq([halves.rgb[0], halves.rgb[1], halves.rgb[2]], [156, 156, 156], '左格拿到一半白');
      assert.eq([halves.rgb[3], halves.rgb[4], halves.rgb[5]], [156, 156, 156], '右格拿到一半白');
      // 按不透明度加权：红不透明 + 绿半透明
      var alphaMix = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]);
      var mixed = sampleGrid(alphaMix, 2, 1, 1, 1);
      assert.eq([mixed.rgb[0], mixed.rgb[1], mixed.rgb[2]], [213, 156, 0], '按不透明度加权');
      // 透明像素不参与平均（否则透明的黑色会渗进来）
      var withClear = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
      var solid = sampleGrid(withClear, 2, 1, 1, 1);
      assert.eq([solid.rgb[0], solid.rgb[1], solid.rgb[2]], [255, 0, 0], '透明像素不参与平均');
      // 整格全透明 → 没有颜色
      var allClear = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]);
      assert.eq(sampleGrid(allClear, 2, 1, 1, 1).alpha[0], 0, '全透明的格子没有颜色');

      /* ---- 网格 ---- */
      assert.eq(gridRows(10, 400, 300), 8, '横图行数按比例推');
      assert.eq(gridRows(10, 300, 400), 13, '竖图行数更多');
      assert.eq(gridRows(1, 100, 100), 1, '最少一行');
      assert.eq(gridRows(29, 1000, 500), 15, '29 列的 2:1 图是 15 行');
      var fit = fitGrid(64, 87);
      assert(fit.cols * fit.rows <= MAX_CELLS, '缩���后总格数不超过上限');
      assert(Math.abs((fit.cols / fit.rows) - (64 / 87)) < 0.05, '缩小是等比的，长宽比不变');
      assert.eq(fitGrid(29, 29), { cols: 29, rows: 29 }, '没超上限就不动');

      /* ---- 色板 ---- */
      assert.eq(parsePalette('A01,#FF0000').length, 1, '逗号分隔');
      assert.eq(parsePalette('A01 #FF0000').length, 1, '空格分隔');
      assert.eq(parsePalette('#FF0000').length, 1, '只有色值');
      assert.eq(parsePalette('A01,#FF0000,Red')[0].name, 'Red', '第三段是名字');
      assert.eq(parsePalette('A01,#FF0000,Red')[0].code, 'A01', '第一段是编号');
      assert.eq(parsePalette('#FF0000')[0].code, '01', '没有编号就自动编号');
      assert.eq(parsePalette('123').length, 0, '坏行整行丢掉');
      assert.eq(parsePalette('').length, 0, '空表');
      assert.eq(parsePalette('A01,#GGGGGG').length, 0, '非法的色值丢掉');
      assert.eq(parseHex('#abc'), [170, 187, 204], '三位 hex');
      assert.eq(parseHex('nope'), null, '认不出来返回 null');
      assert.eq(builtinPalette().length, 24, '内置色板有 24 色');

      var pal = parsePalette('01,#000000\n02,#FFFFFF\n03,#FF0000');
      var plabs = paletteLabs(pal);
      assert.eq(nearestIndex(rgbToLab(255, 0, 0), plabs), 2, '纯红最近的是红');
      assert.eq(nearestIndex(rgbToLab(0, 0, 0), plabs), 0, '纯黑最近的是黑');

      /* ---- 限色 ----
         合并的候选只有**正在用的**那些颜色 —— 没被用到的颜色不参加，
         否则「限色」就会把图上根本没有的颜色重新引进来。
         白跟红的色差（约 45.8）比白跟黑（约 100）小得多，
         所以「白并进红」不是笔误，是公式算出来的。 */
      var dist = paletteDistances(plabs);
      var cells = new Int16Array([0, 0, 0, 1]); // 黑三次、白一次
      assert.eq(Array.from(capColours(cells, plabs, dist, 2).cells), [0, 0, 0, 1], '没超过上限就一步都不动');
      assert.eq(capColours(cells, plabs, dist, 2).merged, 0, '没超过上限就不合并');
      // 只剩黑在用，白只能并进黑 —— 红没被用上，不做候选
      var capped = capColours(cells, plabs, dist, 1);
      assert.eq(Array.from(capped.cells), [0, 0, 0, 0], '用得最少的白被并进唯一还在用的黑');
      assert.eq(capped.merged, 1, '合并掉一种颜色');
      assert.eq(pal.length, 3, '限色不动色板');
      // 白和红一样少 → 丢下标小的那个（白），它离红最近
      var mixed = capColours(new Int16Array([0, 0, 0, 1, 2]), plabs, dist, 2);
      assert.eq(Array.from(mixed.cells), [0, 0, 0, 2, 2], '一样少时丢下标最小的，白并进红');
      assert.eq(mixed.merged, 1, '合并掉一种');
      // 并列时丢下标最小的那个
      var tie = capColours(new Int16Array([0, 1, 2]), plabs, dist, 2);
      assert.eq(Array.from(tie.cells), [2, 1, 2], '三色一样多时丢下标最小的，黑并进红');
      assert.eq(tie.merged, 1, '并列那次也只合并一种');
      assert.eq(capColours(cells, plabs, dist, 0).merged, 0, '不限色时不合并');
      assert.eq(Array.from(capColours(cells, plabs, dist, 0).cells), [0, 0, 0, 1], '不限色时原样返回');
      // 几乎一样的两种色：用得少的那一种必然并进多的那一种
      var nearPal = parsePalette('01,#000000\n02,#FFFFFF\n03,#FF0000\n04,#FE0000');
      var nearPlabs = paletteLabs(nearPal);
      var nearDist = paletteDistances(nearPlabs);
      var nearCells = new Int16Array([0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3]);
      var nearCapped = capColours(nearCells, nearPlabs, nearDist, 3);
      assert.eq(Array.from(nearCapped.cells), [0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2], '稀有色并进最接近的那种');
      assert.eq(nearCapped.merged, 1, '合并掉一种');

      /* ---- 去背景 ----
         判据取两个色差的较小值：取样色 vs 背景、匹配到的豆色 vs 背景。 */
      var bgPal = parsePalette('01,#FFFFFF\n02,#FF0000\n03,#000000');
      var bgPlabs = paletteLabs(bgPal);
      var bgLab = bgPlabs[0];
      // 三格：纯白、纯红、差一点点白（250,250,250）
      var bgLabs = [bgPlabs[0], bgPlabs[1], rgbToLab(250, 250, 250)];
      var bgCells = new Int16Array([0, 1, 2]);
      var tight = blankBackground(bgCells, bgLabs, bgPlabs, bgLab, 0);
      assert.eq(Array.from(tight.cells), [-1, 1, 2], '容差 0 只抠颜色完全一样的那格');
      assert.eq(tight.blanked, 1, '容差 0 抠掉一格');
      var loose = blankBackground(bgCells, bgLabs, bgPlabs, bgLab, 5);
      assert.eq(Array.from(loose.cells), [-1, 1, -1], '容差 5 把接近背景的也抠掉');
      assert.eq(loose.blanked, 2, '容差 5 抠掉两格');

      /* ---- 手工改动 ---- */
      var edited = applyEdits(new Int16Array([0, 1, 2]), new Int16Array([NO_OVERRIDE, EMPTY, 1]));
      assert.eq(Array.from(edited), [0, -1, 1], '手工改动盖在自动结果上');

      /* ---- 计数 ---- */
      var counted = countByColour(new Int16Array([0, 0, 1, 2, -1]), pal);
      assert.eq(counted.length, 3, '空格不计数');
      assert.eq(counted[0].count, 2, '用量最多的排前面');
      assert.eq(counted[0].index, 0, '黑用得最多');

      /* ---- CSV ---- */
      assert.eq(csvField('plain'), 'plain', '普通值不加引号');
      assert.eq(csvField('a,b'), '"a,b"', '含逗号加引号');
      assert.eq(csvField('he said "hi"'), '"he said ""hi"""', '引号翻倍');
      assert.eq(csvField('l1\nl2'), '"l1\nl2"', '含换行加引号，不压成字面量');
      assert.eq(csvField('01'), '01', '数字样式的码不加引号');
      assert.eq(buildCsv([['a', 'b'], ['c', 'd']]), 'a,b\nc,d', '行用换行接');

      /* ---- 图纸几何 ---- */
      var layout = chartLayout(10, 20, 24, 3);
      assert.eq(cellFromPoint(layout.gutterW + 24 * 3 + 12, layout.gutterH + 24 * 5 + 12, layout), 5 * 10 + 3, '第三列第六行');
      assert.eq(cellFromPoint(layout.gutterW + 1, layout.gutterH + 1, layout), 0, '左上角那一格');
      assert.eq(cellFromPoint(2, 2, layout), -1, '页眉里点不到格子');
      assert.eq(cellFromPoint(layout.gutterW + 24 * 10 + 5, layout.gutterH + 10, layout), -1, '格外点不到格子');
      assert.eq(cellFromPoint(-1, -1, layout), -1, '负坐标点不到格子');
      assert.eq(chartLimit(64, 64, 48).ok, true, '64×64×48 放得下');
      assert.eq(chartLimit(64, 64, 48).reduced, false, '放得下就不缩格子');
      // 放不下就缩格子，而不是拒绝出图
      var shrunk = chartLimit(1000, 1000, 48);
      assert.eq(shrunk.ok, true, '太大了就缩格子，画布还放得下');
      assert.eq(shrunk.reduced, true, '格子确实被缩小了');
      assert(shrunk.cellPx < 48, '缩小后的格子比原来小');
      // 缩到最小还放不下，那就真的画不出来
      assert.eq(chartLimit(100000, 100000, 48).ok, false, '缩到最小也放不下就要说放不下');
    }
  };
}());
