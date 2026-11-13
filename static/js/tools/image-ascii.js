/* ==========================================================================
   图片转字符画（image-ascii）

   把一张图变成一片字符：每个格子取一块像素的平均亮度，按亮度挑一个字符。
   也可以切成盲文点阵（一个字符是 2 列 × 4 行的凸点）。

   几个定下来的地方：

   1. **格子数按字符格的宽高比算**，不是 1:1。
      等宽字体的一个字符格，高是宽的 1.67 倍左右。
      按 1:1 排出来的画在屏幕上会被拉长近一倍 —— 几乎所有人第一反应都是「太长了」。
      所以 rows = round(图片高 × 列数 × 宽高修正 / 图片宽)，
      宽高修正默认 0.60（就是那个 1.67 的倒数）。

   2. **取平均与算亮度都在线性光里做**。
      一块像素「看起来是什么颜色」是它发出的光的平均，不是字节的平均。
      这里跟「图片调色板」用同一套 srgbToLinear / relativeLuminance，
      所以同一个像素在两个工具里算出来的亮度完全一样。
      （线性光下 50% 灰的平均是 188，不是 127。）

   3. **每格的平均自己算**，不用浏览器的缩放。
      drawImage 缩小不保证是盒式平均：imageSmoothingQuality 'high' 会让相邻块互相串色，
      'low' 只在缩放比正好整除时才碰巧等于盒式平均。
      所以格子的颜色是按格子切像素求出来的，结果是确定的。

   4. **字符表统一「密 → 疏」排**，最密的在第 0 位，空格在最后。
      索引 = round(亮度 × (档数 − 1))：暗处拿密字符，亮处拿空格。
      明暗反转**不改字符表**，只把亮度换成 1 − 亮度，索引公式只有一套。

   5. **盲文模式只换格子里的点阵，不换格子数**。
      一个字符是 2 列 × 4 行的点阵，行数公式不变 ——
      另算一套宽高比会让切模式的时候整幅画跳一下。

   6. **ANSI 上色只进 .txt**，预览永远是纯文本（浏览器不渲染 ANSI 转义序列）。

   图片一个字节都不出浏览器。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-ascii');

  /* ---------- 常量 ---------- */

  /**
   * 一个字符格的宽/高比 —— 等宽字体的字符格高是宽的 1.67 倍左右，
   * 0.6 是它的倒数，也是宽高修正滑块的默认值。
   */
  var CELL_ASPECT = 0.6;

  /** 宽高修正的取值范围（滑块用的是百分数：30..100）。 */
  var ASPECT_MIN = 0.3;
  var ASPECT_MAX = 1.0;

  /** 列数（每行的字符数）的默认值与范围。 */
  var DEFAULT_COLS = 80;
  var MIN_COLS = 8;
  var MAX_COLS = 400;

  /**
   * 采样图最多多少像素。
   *
   * 取平均要读像素，一次 getImageData 就是 4 个通道 × 像素数，
   * 4 M 像素是 16 MB —— 再多机器就开始卡了。
   * 超预算的图先让浏览器缩一次（这一步是低通滤波，误差很小），
   * 再在缩过的图上做**严格**的盒式平均，真正定形状的是后者。
   */
  var SAMPLE_MAX_PIXELS = 4 * 1024 * 1024;

  /** 参数改动后多久重算一次（毫秒）。拖滑块时每帧都重算会跟不动。 */
  var DEBOUNCE_MS = 120;

  /** 自定义字符表至少要几个字符 —— 少于两个就分不出深浅。 */
  var MIN_RAMP = 2;

  /**
   * 预置字符表。
   *
   * 顺序是「密 → 疏」：第 0 位最密，最后一位是空格。
   * 暗处拿前面的（密的），亮处拿后面的（疏的）——
   * 这是字符画的老规矩，跟 figlet 之类也是一套口径。
   */
  var RAMPS = {
    classic: '@%#*+=-:. ',
    simple: '@%:. ',
    blocks: '█▓▒░ ',
    binary: '# ',
    dense: '$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,"^`\'. '
  };

  /**
   * 宽字符的码点表。
   *
   * 这张表有**两个**用处：判断用户写的字符表里有没有会撑歪列的宽字符，
   * 以及给 CSS 的 unicode-range（让等宽块里的中文正好占两格）。
   * 「算两格」跟「渲染两格」必须落在同一批码点上，否则表照样歪。
   */
  var WIDE_CJK_RANGES = [
    [0x1100, 0x115f],   // 谚文字母
    [0x2e80, 0x303e],   // CJK 部首、康熙部首、CJK 符号与标点
    [0x3041, 0x33ff],   // 假名、注音、兼容汉字、韩文兼容
    [0x3400, 0x4dbf],   // CJK 扩展 A
    [0x4e00, 0x9fff],   // CJK 统一表意文字
    [0xa000, 0xa4cf],   // 彝文
    [0xac00, 0xd7a3],   // 韩文音节
    [0xf900, 0xfaff],   // CJK 兼容表意文字
    [0xfe10, 0xfe19],   // 竖排标点
    [0xfe30, 0xfe6f],   // CJK 兼容形式
    [0xff00, 0xff60],   // 全角形式
    [0xffe0, 0xffe6],
    [0x20000, 0x3fffd]  // CJK 扩展 B 及以后
  ];
  var WIDE_EMOJI_RANGES = [
    [0x1f300, 0x1f64f],
    [0x1f680, 0x1f6ff],
    [0x1f900, 0x1f9ff]
  ];

  var S = {
    title: t('title', 'Turn a picture into characters'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The picture is processed in your browser, nothing is uploaded.'),
    status_reading: t('status_reading', 'Reading the file…'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_no_picture: t('err_no_picture', 'There is no picture yet. Choose one first.'),
    err_ramp: t('err_ramp', 'The character set needs at least two characters.'),
    err_ramp_wide: t('err_ramp_wide', 'The character set contains the wide character {char}. It would break the alignment, so it was left out.'),
    params_title: t('params_title', 'Settings'),
    label_cols: t('label_cols', 'Width in characters'),
    hint_cols: t('hint_cols', 'How many characters one line of the picture is.'),
    label_ramp: t('label_ramp', 'Character set'),
    hint_ramp: t('hint_ramp', 'The characters go from dense to sparse, and the dark parts of the picture get the dense ones.'),
    ramp_classic: t('ramp_classic', 'Classic'),
    ramp_simple: t('ramp_simple', 'Simple'),
    ramp_blocks: t('ramp_blocks', 'Blocks'),
    ramp_binary: t('ramp_binary', 'Black and white'),
    ramp_dense: t('ramp_dense', '70 levels'),
    ramp_custom: t('ramp_custom', 'Your own'),
    label_custom_ramp: t('label_custom_ramp', 'Your own characters'),
    hint_custom_ramp: t('hint_custom_ramp', 'At least two characters, the densest first. Wide characters are not allowed.'),
    label_aspect: t('label_aspect', 'Shape correction'),
    hint_aspect: t('hint_aspect', 'A character cell is taller than it is wide, so the picture is stretched by this factor.'),
    label_invert: t('label_invert', 'Swap light and dark'),
    hint_invert: t('hint_invert', 'The bright parts of the picture get the dense characters instead.'),
    label_braille: t('label_braille', 'Braille dots'),
    hint_braille: t('hint_braille', 'Every character becomes a grid of two by four raised dots.'),
    label_threshold: t('label_threshold', 'Dot threshold'),
    hint_threshold: t('hint_threshold', 'Leave this empty to let the tool work the threshold out from the picture.'),
    label_ansi: t('label_ansi', 'Colour in the download'),
    hint_ansi: t('hint_ansi', 'The preview stays plain text; the downloaded file carries ANSI colour codes.'),
    result_title: t('result_title', 'Characters'),
    export_title: t('export_title', 'Export'),
    btn_copy: t('btn_copy', 'Copy the characters'),
    btn_download: t('btn_download', 'Download the characters as a text file'),
    hint_download: t('hint_download', 'The text file keeps the ANSI colour codes when they are on.'),
    summary_title: t('summary_title', 'Summary'),
    label_source_size: t('label_source_size', 'Original size'),
    label_grid: t('label_grid', 'Grid'),
    label_levels: t('label_levels', 'Characters used'),
    label_threshold_used: t('label_threshold_used', 'Dot threshold'),
    no_picture: t('no_picture', 'Choose a picture to see the characters.')
  };

  /* ---------- 颜色（跟「图片调色板」同一套口径） ---------- */

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

  /** sRGB → 线性 的查找表（256 项），每个像素查一次就够。 */
  var LINEAR_LUT = (function () {
    var lut = new Float64Array(256);
    for (var i = 0; i < 256; i++) lut[i] = srgbToLinear(i);
    return lut;
  }());

  /**
   * 相对亮度（WCAG 那套：0.2126 / 0.7152 / 0.0722 + sRGB 线性化）。
   *
   * 这里要的是「人眼看这个像素有多深浅的档位」，
   * 所以不能用 gamma 编码的 0.2126r + 0.7152g + 0.0722b ——
   * 那个是「人眼看滤镜效果」的视觉近似，跟这里要的档位不是一回事。
   */
  function relativeLuminance(r, g, b) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }

  /* ---------- 几何 ---------- */

  /**
   * 行数：按字符格的宽高比算。
   *
   * rows = round(图片高 × 列数 × 宽高修正 / 图片宽)
   *
   * @param {number} srcW   原图宽（像素）
   * @param {number} srcH   原图高（像素）
   * @param {number} cols   列数（一行的字符数）
   * @param {number} aspect 宽高修正系数
   * @returns {number} 行数，至少 1
   */
  function asciiRows(srcW, srcH, cols, aspect) {
    var w = Math.max(1, Math.round(Number(srcW) || 1));
    var h = Math.max(1, Math.round(Number(srcH) || 1));
    var c = Math.max(1, Math.round(Number(cols) || 1));
    var a = Number(aspect);
    if (!isFinite(a) || a <= 0) a = CELL_ASPECT;
    return Math.max(1, Math.round(h * c * a / w));
  }

  /**
   * 一个格子在采样图上覆盖的范围。
   *
   * 边界用 floor(c × W / cols)：相邻格子正好接上，不留缝也不重叠 ——
   * 留缝会在画面上出现一条条规则的亮线。
   *
   * @param {number} w     采样图宽
   * @param {number} h     采样图高
   * @param {number} cols  列数
   * @param {number} rows  行数
   * @param {number} c     第几列
   * @param {number} r     第几行
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  function cellRect(w, h, cols, rows, c, r) {
    var x0 = Math.floor(c * w / cols);
    var x1 = Math.floor((c + 1) * w / cols);
    var y0 = Math.floor(r * h / rows);
    var y1 = Math.floor((r + 1) * h / rows);
    // 格子比一个采样像素还窄的时候（列数比像素多），至少留一个像素，
    // 不然这一格什么也读不到。
    if (x1 <= x0) x1 = Math.min(w, x0 + 1);
    if (y1 <= y0) y1 = Math.min(h, y0 + 1);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /* ---------- 取平均 ---------- */

  /**
   * 盒式平均：把采样图切成 cols × rows 个格子，每格求一个平均颜色。
   *
   * 平均在**线性光**里做 —— 一块像素看起来是什么颜色，是它发出的光的平均。
   * 字节的平均会把 50% 灰算成 127，线性光下是 188。
   *
   * @param {{data: Uint8ClampedArray, w: number, h: number}} img 采样图
   * @param {number} cols 列数
   * @param {number} rows 行数
   * @returns {Array} 每格 {rgb: [r,g,b], lum: 相对亮度}
   */
  function boxAverage(img, cols, rows) {
    var data = img.data, w = img.w, h = img.h;
    var out = new Array(cols * rows);
    for (var r = 0; r < rows; r++) {
      var y0 = Math.floor(r * h / rows);
      var y1 = Math.floor((r + 1) * h / rows);
      if (y1 <= y0) y1 = Math.min(h, y0 + 1);
      for (var c = 0; c < cols; c++) {
        var x0 = Math.floor(c * w / cols);
        var x1 = Math.floor((c + 1) * w / cols);
        if (x1 <= x0) x1 = Math.min(w, x0 + 1);
        var lr = 0, lg = 0, lb = 0, n = 0;
        for (var y = y0; y < y1; y++) {
          var o = (y * w + x0) * 4;
          for (var x = x0; x < x1; x++) {
            lr += LINEAR_LUT[data[o]];
            lg += LINEAR_LUT[data[o + 1]];
            lb += LINEAR_LUT[data[o + 2]];
            o += 4;
            n++;
          }
        }
        var inv = n ? 1 / n : 0;
        var linR = lr * inv, linG = lg * inv, linB = lb * inv;
        out[r * cols + c] = {
          rgb: [linearToSrgb(linR), linearToSrgb(linG), linearToSrgb(linB)],
          // 亮度直接从线性值算 —— 绕一圈 sRGB 会白白丢掉精度。
          lum: 0.2126 * linR + 0.7152 * linG + 0.0722 * linB
        };
      }
    }
    return out;
  }

  /* ---------- 字符表 ---------- */

  /**
   * 亮度 → 字符表里的下标。
   *
   * 字符表是「密 → 疏」排的（第 0 位最密，最后一位是空格），
   * 所以暗 → 0（密字符），亮 → 档数 − 1（空格）。
   *
   * @param {number} lum 相对亮度 0..1
   * @param {number} n   字符表长度
   * @returns {number} 下标
   */
  function rampIndex(lum, n) {
    var count = Math.max(1, Math.round(Number(n) || 1));
    var l = Number(lum);
    if (!isFinite(l)) l = 0;
    if (l < 0) l = 0;
    else if (l > 1) l = 1;
    var i = Math.round(l * (count - 1));
    if (i < 0) i = 0;
    else if (i > count - 1) i = count - 1;
    return i;
  }

  /** 按 id 取预置字符表；取不到返回 null。 */
  function rampById(id) {
    if (Object.prototype.hasOwnProperty.call(RAMPS, id)) return RAMPS[id];
    return null;
  }

  /** 码点是不是宽字符（占两格）。 */
  function isWideChar(code) {
    return inRanges(code, WIDE_CJK_RANGES) || inRanges(code, WIDE_EMOJI_RANGES);
  }

  function inRanges(code, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (code >= ranges[i][0] && code <= ranges[i][1]) return true;
    }
    return false;
  }

  /**
   * 把用户写的字符表收拾干净：宽字符剔掉。
   *
   * 宽字符在等宽字体里占两格，一格里塞一个宽字符，这一行就比别行长一格，
   * 整幅画会歪 —— 所以宁可少一个字符，也不能让它进来。
   *
   * @param {string} text 用户写的字符表
   * @returns {{ramp: string, dropped: string[]}}
   */
  function cleanRamp(text) {
    var src = String(text === null || text === undefined ? '' : text);
    var out = '';
    var dropped = [];
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      var code = src.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < src.length) {
        // 代理对：算真正的码点，不然 emoji 的后半截会被当成宽字符。
        var low = src.charCodeAt(i + 1);
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        ch = src.substr(i, 2);
        i++;
      }
      if (isWideChar(code)) {
        dropped.push(ch);
        continue;
      }
      out += ch;
    }
    return { ramp: out, dropped: dropped };
  }

  /* ---------- 盲文 ---------- */

  /**
   * 盲文点阵里某个点对应哪一位。
   *
   * 盲文的八点排法是：
   *     点1 点4
   *     点2 点5
   *     点3 点6
   *     点7 点8
   * Unicode 把它们编成 U+2800 的低八位，位号 0..7。
   *
   * @param {number} col 0 或 1
   * @param {number} row 0..3
   * @returns {number} 位号 0..7；越界返回 -1
   */
  function brailleBit(col, row) {
    if (col < 0 || col > 1 || row < 0 || row > 3) return -1;
    if (row === 0) return col === 0 ? 0 : 3;   // 点1 / 点4
    if (row === 1) return col === 0 ? 1 : 4;   // 点2 / 点5
    if (row === 2) return col === 0 ? 2 : 5;   // 点3 / 点6
    return col === 0 ? 6 : 7;                 // 点7 / 点8
  }

  /** 位号 → 盲文字符（U+2800 + 位掩码）。 */
  function brailleChar(bits) {
    var v = Math.round(Number(bits) || 0);
    if (v < 0) v = 0;
    else if (v > 0xff) v = 0xff;
    return String.fromCharCode(0x2800 + v);
  }

  /**
   * Otsu 阈值：在 0..255 的亮度直方图上，找两个类之间方差最大的那条线。
   *
   * 同一个直方图上通常有**一整段**阈值给出同样的方差（两个峰之间都算），
   * 拿哪一条都能分开两个类，但拿最左边那条会把阈值压在暗峰上，
   * 把中间调也判成暗 —— 所以取这一段的**中点**。
   *
   * @param {number[]} values 0..255 的亮度
   * @returns {number} 0..255 的阈值
   */
  function otsuThreshold(values) {
    var hist = new Array(256);
    for (var i = 0; i < 256; i++) hist[i] = 0;
    var total = 0;
    for (var j = 0; j < values.length; j++) {
      var v = Math.round(Number(values[j]));
      if (!isFinite(v)) continue;
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      hist[v]++;
      total++;
    }
    if (!total) return 128;

    var sum = 0;
    for (var k = 0; k < 256; k++) sum += k * hist[k];

    var sumB = 0, wB = 0, best = -1, first = -1, last = -1;
    for (var t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      // 用相对误差比大小：同一段平台上的方差在浮点上是同一个数，
      // 但不同形状的直方图上平台可能只有 1e-15 的差别。
      var eps = best < 0 ? 0 : Math.max(1e-9, best * 1e-12);
      if (best < 0 || between > best + eps) {
        best = between;
        first = t;
        last = t;
      } else if (between >= best - eps) {
        last = t;
      }
    }
    if (first < 0) return 128;
    return Math.round((first + last) / 2);
  }

  /** 把格子的相对亮度换成 0..255 的整数，喂给 Otsu。 */
  function luminanceSamples(cells) {
    var out = [];
    for (var i = 0; i < cells.length; i++) {
      var l = Number(cells[i] && cells[i].lum);
      if (!isFinite(l)) l = 0;
      if (l < 0) l = 0;
      else if (l > 1) l = 1;
      out.push(Math.round(l * 255));
    }
    return out;
  }

  /* ---------- 渲染 ---------- */

  /**
   * 把格子变成字符画。
   *
   * @param {Array} cells boxAverage 的结果
   * @param {number} cols 列数
   * @param {number} rows 行数
   * @param {{ramp: string, invert: boolean}} opts
   * @returns {{lines: string[], colours: string[]}}
   */
  function renderAscii(cells, cols, rows, opts) {
    opts = opts || {};
    var ramp = opts.ramp || RAMPS.classic;
    var invert = !!opts.invert;
    var n = ramp.length;
    var lines = [];
    var colours = [];
    for (var r = 0; r < rows; r++) {
      var chars = [];
      var rgbs = [];
      for (var c = 0; c < cols; c++) {
        var cell = cells[r * cols + c];
        var lum = cell ? cell.lum : 0;
        // 明暗反转只动亮度，不动字符表 —— 索引公式只有一套。
        if (invert) lum = 1 - lum;
        chars.push(ramp.charAt(rampIndex(lum, n)));
        rgbs.push(cell ? cell.rgb : [0, 0, 0]);
      }
      // 行尾不留空格：有些编辑器会自己删，删了行就短一截。
      // 行首的空格要留着 —— 那是「亮」的格子。
      var line = chars.join('').replace(/ +$/, '');
      lines.push(line);
      colours.push(ansiLine(chars, rgbs, line.length));
    }
    return { lines: lines, colours: colours };
  }

  /**
   * 把格子变成盲文。
   *
   * 一个字符是 2 列 × 4 行的点阵；点的深浅按阈值切，
   * 暗的那一半变成凸点（盲文里凸点表示有笔画）。
   *
   * @param {Array} cells  采样格子，尺寸是 cols×2 宽、rows×4 高
   * @param {number} cols  字符列数
   * @param {number} rows  字符行数
   * @param {?number} threshold 阈值；null 表示自动算
   * @returns {{lines: string[], colours: string[], threshold: number}}
   */
  function renderBraille(cells, cols, rows, threshold) {
    var dotsW = cols * 2, dotsH = rows * 4;
    var thr = threshold;
    if (typeof thr !== 'number' || !isFinite(thr)) {
      thr = otsuThreshold(luminanceSamples(cells));
    }
    thr = Math.max(0, Math.min(255, Math.round(thr)));

    var lines = [];
    var colours = [];
    for (var r = 0; r < rows; r++) {
      var chars = [];
      var rgbs = [];
      for (var c = 0; c < cols; c++) {
        var bits = 0;
        var sr = 0, sg = 0, sb = 0, n = 0;
        for (var dy = 0; dy < 4; dy++) {
          for (var dx = 0; dx < 2; dx++) {
            var cell = cells[(r * 4 + dy) * dotsW + (c * 2 + dx)];
            if (!cell) continue;
            sr += cell.rgb[0];
            sg += cell.rgb[1];
            sb += cell.rgb[2];
            n++;
            if (cell.lum * 255 <= thr) {
              var bit = brailleBit(dx, dy);
              if (bit >= 0) bits |= (1 << bit);
            }
          }
        }
        chars.push(brailleChar(bits));
        rgbs.push(n
          ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)]
          : [0, 0, 0]);
      }
      // 行尾的空点阵（U+2800）跟行尾的空格一样，看不见，留着只是占地方。
      var keep = chars.length;
      while (keep > 0 && chars[keep - 1] === '⠀') keep--;
      var line = chars.slice(0, keep).join('');
      lines.push(line);
      colours.push(ansiLine(chars, rgbs, keep));
    }
    return { lines: lines, colours: colours, threshold: thr };
  }

  /* ---------- ANSI 彩色 ---------- */

  /** 一个格子的 ANSI 前景色转义序列。 */
  function ansiCell(rgb) {
    var c = rgb || [0, 0, 0];
    return '\u001b[38;2;' + c[0] + ';' + c[1] + ';' + c[2] + 'm';
  }

  function sameRgb(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  }

  /**
   * 一行的 ANSI 彩色串。
   *
   * 连续的同色格子合成一段 —— 每一格都包一次转义序列，文件会大一倍还难读。
   *
   * @param {string[]} chars  这一行的字符
   * @param {number[][]} rgbs 每一格的颜色
   * @param {number} keep   取前几个字符（后面的是被去掉的行尾空白）
   * @returns {string}
   */
  function ansiLine(chars, rgbs, keep) {
    var limit = keep === undefined ? chars.length : keep;
    var out = '';
    var start = 0;
    while (start < limit) {
      var rgb = rgbs[start];
      var end = start + 1;
      while (end < limit && sameRgb(rgbs[end], rgb)) end++;
      out += ansiCell(rgb) + chars.slice(start, end).join('') + '\u001b[0m';
      start = end;
    }
    return out;
  }

  /* ---------- 采样 ---------- */

  /**
   * 把原图缩到「采样图」上，再在采样图上取格子。
   *
   * 为什么要中间这一步：格子平均要读像素，一张 12 MP 的图一次 getImageData
   * 就是 48 MB。超预算的图先让浏览器缩一次（这一步是低通，误差很小），
   * 再在缩过的图上做**严格**的盒式平均 —— 真正定形状的是后者。
   *
   * 图本身就在预算内的时候**不缩**，直接读原图，一步到位。
   *
   * @param {*} source      可画进 canvas 的源（ImageBitmap / HTMLImageElement）
   * @param {number} srcW   原图宽
   * @param {number} srcH   原图高
   * @param {number} cols   目标网格宽
   * @param {number} rows   目标网格高
   * @returns {?Array} 每格 {rgb, lum}；拿不到画布时返回 null
   */
  function sampleCells(source, srcW, srcH, cols, rows) {
    if (!source) return null;
    var scale = 1;
    var px = srcW * srcH;
    if (px > SAMPLE_MAX_PIXELS) scale = Math.sqrt(SAMPLE_MAX_PIXELS / px);
    var sw = Math.max(1, Math.round(srcW * scale));
    var sh = Math.max(1, Math.round(srcH * scale));

    var canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    var ctx = canvas.getContext('2d');
    // jsdom 里 getContext('2d') 返回 null
    if (!ctx) return null;
    try {
      ctx.drawImage(source, 0, 0, sw, sh);
      var data = ctx.getImageData(0, 0, sw, sh);
    } catch (e) {
      return null;
    }
    return boxAverage({ data: data.data, w: sw, h: sh }, cols, rows);
  }

  /* ---------- 小工具 ---------- */

  function clampInt(value, min, max, fallback) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) n = Math.round(Number(fallback));
    if (!isFinite(n)) n = min;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  /* ==========================================================================
     界面
     ========================================================================== */

  window.ItTools.register('image-ascii', function (root) {
    var state = {
      source: null,
      name: '',
      imgW: 0,
      imgH: 0,
      cols: DEFAULT_COLS,
      rampId: 'classic',
      customRamp: '',
      aspect: CELL_ASPECT,
      invert: false,
      braille: false,
      threshold: '',
      ansi: false,
      lines: [],
      ansiLines: [],
      disposed: false
    };

    var timer = null;

    /* ---------- 上传 ---------- */

    var upload = C.uploadCard({
      label: S.choose_file,
      hint: S.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);

    /* ---------- 参数 ---------- */

    var paramsCard = D.h('div.card', { hidden: true });
    paramsCard.appendChild(D.h('h3', { text: S.params_title }));

    var colsInput = D.h('input.layui-input.ascii-cols', {
      type: 'number', min: MIN_COLS, max: MAX_COLS, step: 1, value: DEFAULT_COLS
    });
    paramsCard.appendChild(U.field(S.label_cols, colsInput, { hint: S.hint_cols }));

    var rampSelect = D.h('select.layui-select.ascii-ramp',
      D.h('option', { value: 'classic', text: S.ramp_classic }),
      D.h('option', { value: 'simple', text: S.ramp_simple }),
      D.h('option', { value: 'blocks', text: S.ramp_blocks }),
      D.h('option', { value: 'binary', text: S.ramp_binary }),
      D.h('option', { value: 'dense', text: S.ramp_dense }),
      D.h('option', { value: 'custom', text: S.ramp_custom })
    );
    paramsCard.appendChild(U.field(S.label_ramp, rampSelect, { hint: S.hint_ramp }));

    var customRampInput = D.h('input.layui-input.ascii-custom-ramp', {
      type: 'text', value: '', placeholder: '@#*:. '
    });
    var customRampField = U.field(S.label_custom_ramp, customRampInput, { hint: S.hint_custom_ramp });
    customRampField.hidden = true;
    paramsCard.appendChild(customRampField);

    var rampView = D.h('div.ascii-ramp-view');
    paramsCard.appendChild(rampView);

    var aspectInput = D.h('input.slider.ascii-aspect', {
      type: 'range', min: Math.round(ASPECT_MIN * 100), max: Math.round(ASPECT_MAX * 100), step: 1, value: 60
    });
    var aspectLabel = D.h('label.field-label', {
      for: 'ascii-aspect', text: S.label_aspect + ': 0.60'
    });
    aspectInput.id = 'ascii-aspect';
    var aspectField = D.h('div.field', null, aspectLabel, aspectInput);
    aspectField.appendChild(D.h('p.field-hint', { text: S.hint_aspect }));
    paramsCard.appendChild(aspectField);

    var invertInput = D.h('input.ascii-invert', { type: 'checkbox' });
    paramsCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, invertInput, D.h('span', { text: S.label_invert }))
    ));
    paramsCard.appendChild(D.h('p.field-hint', { text: S.hint_invert }));

    var brailleInput = D.h('input.ascii-braille', { type: 'checkbox' });
    paramsCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, brailleInput, D.h('span', { text: S.label_braille }))
    ));
    paramsCard.appendChild(D.h('p.field-hint', { text: S.hint_braille }));

    var thresholdInput = D.h('input.layui-input.ascii-threshold', {
      type: 'number', min: 0, max: 255, step: 1, value: ''
    });
    var thresholdField = U.field(S.label_threshold, thresholdInput, { hint: S.hint_threshold });
    thresholdField.hidden = true;
    paramsCard.appendChild(thresholdField);

    var ansiInput = D.h('input.ascii-ansi', { type: 'checkbox' });
    paramsCard.appendChild(D.h('div.switch-grid', null,
      D.h('label.switch', null, ansiInput, D.h('span', { text: S.label_ansi }))
    ));
    paramsCard.appendChild(D.h('p.field-hint', { text: S.hint_ansi }));

    /* ---------- 结果 ---------- */

    var code = U.codeBlock({ noCopy: true });
    code.el.classList.add('ascii-code');
    code.card.insertBefore(D.h('h3', { text: S.result_title }), code.card.firstChild);
    U.monoCjk(code.el, [{ kind: 'cjk', ranges: WIDE_CJK_RANGES }]);
    // 提示单独一行放在画下面 —— 提示混进 <pre> 里的话，
    // 预览就不是「下载下来的那个文件」了。
    var statusLine = D.h('p.form-status.ascii-status');
    code.card.appendChild(statusLine);

    /* ---------- 导出 ---------- */

    var exportCard = D.h('div.card', { hidden: true });
    exportCard.appendChild(D.h('h3', { text: S.export_title }));
    var copyBtn = U.copyButton(function () { return state.lines.join('\n'); }, S.btn_copy);
    var downloadBtn = D.h('button.layui-btn.layui-btn-primary.ascii-download', {
      type: 'button', text: S.btn_download
    });
    exportCard.appendChild(D.h('div.form-actions', null, copyBtn, downloadBtn));
    exportCard.appendChild(D.h('p.field-hint', { text: S.hint_download }));

    /* ---------- 摘要 ---------- */

    var summaryCard = D.h('div.card', { hidden: true });
    summaryCard.appendChild(D.h('h3', { text: S.summary_title }));
    var summaryBody = D.h('div');
    summaryCard.appendChild(summaryBody);

    /* ---------- 挂载 ---------- */

    root.appendChild(upload.card);
    root.appendChild(paramsCard);
    root.appendChild(code.card);
    root.appendChild(exportCard);
    root.appendChild(summaryCard);

    /* ---------- 读文件 ---------- */

    function handleFile(file) {
      if (!file) return;
      upload.setStatus(S.status_reading, false);
      C.decode(file).then(function (decoded) {
        if (state.disposed) {
          if (decoded && decoded.close) decoded.close();
          return;
        }
        state.source = decoded.source;
        state.imgW = decoded.width;
        state.imgH = decoded.height;
        state.name = file.name || '';
        upload.setStatus('', false);
        paramsCard.hidden = false;
        exportCard.hidden = false;
        render();
      }).catch(function () {
        if (state.disposed) return;
        upload.setStatus(S.err_decode, true);
      });
    }

    /* ---------- 当前字符表 ---------- */

    /**
     * 现在的字符表是什么。
     *
     * 自定义的那一份要先剔掉宽字符 —— 宽字符在等宽字体里占两格，
     * 一行里多一个宽字符，这一行就比别行长，整幅画歪掉。
     *
     * @returns {{ramp: string, dropped: string[], error: ?string}}
     */
    function currentRamp() {
      if (state.rampId === 'custom') {
        var cleaned = cleanRamp(state.customRamp);
        if (cleaned.ramp.length < MIN_RAMP) {
          return { ramp: '', dropped: cleaned.dropped, error: 'ramp' };
        }
        return { ramp: cleaned.ramp, dropped: cleaned.dropped, error: null };
      }
      var preset = rampById(state.rampId);
      if (!preset) return { ramp: RAMPS.classic, dropped: [], error: null };
      return { ramp: preset, dropped: [], error: null };
    }

    /* ---------- 重算 ---------- */

    function schedule() {
      if (state.disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        render();
      }, DEBOUNCE_MS);
    }

    function render() {
      if (state.disposed) return;

      var rampInfo = currentRamp();
      rampView.textContent = rampInfo.ramp || '';
      statusLine.textContent = '';
      statusLine.classList.remove('is-error');
      statusLine.classList.remove('is-warn');

      if (!state.source) {
        code.value = S.no_picture;
        state.lines = [];
        state.ansiLines = [];
        summaryCard.hidden = true;
        return;
      }

      if (rampInfo.error === 'ramp') {
        code.value = '';
        state.lines = [];
        state.ansiLines = [];
        summaryCard.hidden = true;
        setStatus(S.err_ramp, 'error');
        return;
      }

      var cols = clampInt(state.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
      var rows = asciiRows(state.imgW, state.imgH, cols, state.aspect);
      var result = null;

      if (state.braille) {
        // 盲文：一个字符是 2 列 × 4 行的点阵，所以采样网格是它的两倍宽、四倍高。
        var dots = sampleCells(state.source, state.imgW, state.imgH, cols * 2, rows * 4);
        if (dots) {
          var manual = state.threshold === '' ? null : clampInt(state.threshold, 0, 255, 128);
          result = renderBraille(dots, cols, rows, manual);
        }
      } else {
        var cells = sampleCells(state.source, state.imgW, state.imgH, cols, rows);
        if (cells) {
          result = renderAscii(cells, cols, rows, {
            ramp: rampInfo.ramp,
            invert: state.invert
          });
        }
      }

      if (!result) {
        code.value = '';
        state.lines = [];
        state.ansiLines = [];
        summaryCard.hidden = true;
        setStatus(S.err_no_picture, 'error');
        return;
      }

      state.lines = result.lines;
      state.ansiLines = result.colours;
      code.value = result.lines.join('\n');

      if (rampInfo.dropped.length) {
        // 宽字符被剔掉了 —— 说一声，不然用户会以为自己写的表没生效。
        setStatus(S.err_ramp_wide.replace('{char}', function () {
          return rampInfo.dropped[0];
        }), 'warn');
      }

      renderSummary(cols, rows, rampInfo, result);
    }

    /**
     * 提示行。
     *
     * 三种状态：空、is-error（红，出错）、is-warn（黄，提醒）。
     */
    function setStatus(message, kind) {
      statusLine.textContent = message || '';
      statusLine.classList.toggle('is-error', kind === 'error');
      statusLine.classList.toggle('is-warn', kind === 'warn');
    }

    function renderSummary(cols, rows, rampInfo, result) {
      D.clear(summaryBody);
      var rowsData = [
        [S.label_source_size, state.imgW + ' × ' + state.imgH],
        [S.label_grid, cols + ' × ' + rows]
      ];
      if (state.braille) {
        rowsData.push([S.label_threshold_used, String(result.threshold)]);
      } else {
        rowsData.push([S.label_levels, String(rampInfo.ramp.length)]);
      }
      var table = D.h('table.result-table');
      var tbody = D.h('tbody');
      rowsData.forEach(function (row) {
        tbody.appendChild(D.h('tr', null,
          D.h('th', { text: row[0] }),
          D.h('td', { text: row[1] })
        ));
      });
      table.appendChild(tbody);
      summaryBody.appendChild(table);
      summaryCard.hidden = false;
    }

    /* ---------- 事件 ---------- */

    colsInput.addEventListener('input', function () {
      state.cols = clampInt(colsInput.value, MIN_COLS, MAX_COLS, DEFAULT_COLS);
      schedule();
    });
    colsInput.addEventListener('change', function () {
      state.cols = clampInt(colsInput.value, MIN_COLS, MAX_COLS, DEFAULT_COLS);
      schedule();
    });

    rampSelect.addEventListener('change', function () {
      state.rampId = rampSelect.value;
      customRampField.hidden = state.rampId !== 'custom';
      schedule();
    });

    customRampInput.addEventListener('input', function () {
      state.customRamp = customRampInput.value;
      schedule();
    });

    aspectInput.addEventListener('input', function () {
      var v = clampInt(aspectInput.value, Math.round(ASPECT_MIN * 100), Math.round(ASPECT_MAX * 100), 60);
      state.aspect = v / 100;
      aspectLabel.textContent = S.label_aspect + ': ' + (v / 100).toFixed(2);
      schedule();
    });

    invertInput.addEventListener('change', function () {
      state.invert = !!invertInput.checked;
      schedule();
    });

    brailleInput.addEventListener('change', function () {
      state.braille = !!brailleInput.checked;
      thresholdField.hidden = !state.braille;
      schedule();
    });

    thresholdInput.addEventListener('input', function () {
      state.threshold = thresholdInput.value;
      schedule();
    });

    ansiInput.addEventListener('change', function () {
      state.ansi = !!ansiInput.checked;
    });

    downloadBtn.addEventListener('click', function () {
      if (state.disposed || !state.lines.length) return;
      var text = state.ansi ? state.ansiLines : state.lines;
      window.ItTools.download(
        C.outputName(state.name, 'txt', 'ascii'),
        text.join('\n') + '\n',
        'text/plain;charset=utf-8'
      );
    });

    return {
      destroy: function () {
        state.disposed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        D.clear(root);
      }
    };
  });

  /* ==========================================================================
     纯逻辑出口（node 侧的 jsdom 测试直接调这些）
     ========================================================================== */

  window.ItTools.logic['image-ascii'] = {
    asciiRows: asciiRows,
    cellRect: cellRect,
    srgbToLinear: srgbToLinear,
    linearToSrgb: linearToSrgb,
    relativeLuminance: relativeLuminance,
    boxAverage: boxAverage,
    rampIndex: rampIndex,
    rampById: rampById,
    cleanRamp: cleanRamp,
    isWideChar: isWideChar,
    brailleBit: brailleBit,
    brailleChar: brailleChar,
    otsuThreshold: otsuThreshold,
    luminanceSamples: luminanceSamples,
    renderAscii: renderAscii,
    renderBraille: renderBraille,
    ansiCell: ansiCell,
    ansiLine: ansiLine,

    __cases: function (assert) {
      /* --- 行数 --- */
      assert.eq(asciiRows(1200, 900, 80, 0.6), 36, '1200×900 的图，80 列 → 36 行');
      assert.eq(asciiRows(900, 1200, 80, 0.6), 64, '竖着的图行数更多');
      assert.eq(asciiRows(100, 100, 80, 0.6), 48, '正方形的图：80 × 0.6 = 48 行');
      assert.eq(asciiRows(100, 100, 80, 1), 80, '宽高修正调到 1 就是 1:1');
      assert.eq(asciiRows(100, 10, 80, 0.6), 5, '扁图行数少');
      assert.eq(asciiRows(1000, 1, 80, 0.6), 1, '算出来是 0 行也得有 1 行');

      /* --- 格子边界 --- */
      assert.eq(cellRect(1200, 900, 80, 36, 0, 0), { x: 0, y: 0, width: 15, height: 25 },
        '第一个格子是 15×25');
      assert.eq(cellRect(1200, 900, 80, 36, 79, 35), { x: 1185, y: 875, width: 15, height: 25 },
        '最后一个格子也是 15×25');
      // 相邻格子必须正好接上：80 个 15 宽的格子正好铺满 1200。
      var totalW = 0;
      for (var c = 0; c < 80; c++) totalW += cellRect(1200, 900, 80, 36, c, 0).width;
      assert.eq(totalW, 1200, '80 个格子正好铺满整幅宽，不留缝也不重叠');
      var totalH = 0;
      for (var r = 0; r < 36; r++) totalH += cellRect(1200, 900, 80, 36, 0, r).height;
      assert.eq(totalH, 900, '36 个格子正好铺满整幅高');

      /* --- 颜色 --- */
      assert.eq(srgbToLinear(0), 0, '黑 → 线性 0');
      assert.eq(srgbToLinear(255), 1, '白 → 线性 1');
      assert.eq(linearToSrgb(1), 255, '线性 1 → 白');
      assert.eq(linearToSrgb(0), 0, '线性 0 → 黑');
      assert.eq(relativeLuminance(0, 0, 0), 0, '黑的亮度是 0');
      assert.eq(relativeLuminance(255, 255, 255), 1, '白的亮度是 1');
      assert(relativeLuminance(128, 128, 128) > 0.2,
        '50% 灰在线性光里比 0.2 亮（gamma 编码那套只有 0.216，但线性是 0.216）');
      assert(relativeLuminance(128, 128, 128) < 0.25, '50% 灰的亮度在 0.2 与 0.25 之间');

      /* --- 盒式平均 --- */
      // 一个 2×1 的图：左边红，右边绿。平均在**线性光**里做 → 188，不是 128。
      var two = { w: 2, h: 1, data: new Uint8ClampedArray(2 * 4) };
      two.data[0] = 255; two.data[3] = 255;      // 第一个像素：红
      two.data[5] = 255; two.data[7] = 255;      // 第二个像素：绿
      var avg = boxAverage(two, 1, 1)[0];
      assert.eq(avg.rgb, [188, 188, 0], '红绿各一半 → 线性光下的黄 [188,188,0]');
      assert(avg.lum > 0.45 && avg.lum < 0.48, '这一格的亮度是 0.464 左右');

      // 一个 4×4 的图，左半黑右半白，切成 2×2。
      var quad = { w: 4, h: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
      for (var y = 0; y < 4; y++) {
        for (var x = 0; x < 4; x++) {
          var o = (y * 4 + x) * 4;
          var v = x < 2 ? 0 : 255;
          quad.data[o] = v; quad.data[o + 1] = v; quad.data[o + 2] = v; quad.data[o + 3] = 255;
        }
      }
      var q = boxAverage(quad, 2, 2);
      assert.eq(q[0].rgb, [0, 0, 0], '左上格是黑的');
      assert.eq(q[1].rgb, [255, 255, 255], '右上格是白的');
      assert.eq(q[2].rgb, [0, 0, 0], '左下格是黑的');
      assert.eq(q[3].rgb, [255, 255, 255], '右下格是白的');

      /* --- 字符表下标 --- */
      assert.eq(rampIndex(0, 5), 0, '最暗 → 第 0 位（最密的字符）');
      assert.eq(rampIndex(1, 5), 4, '最亮 → 最后一位（空格）');
      assert.eq(rampIndex(0.5, 5), 2, '中间 → 中间那位');
      assert.eq(rampIndex(0, 1), 0, '只有一个字符时永远是 0');
      assert.eq(rampById('classic'), '@%#*+=-:. ', 'classic 是这十个字符');
      assert.eq(rampById('blocks'), '█▓▒░ ', 'blocks 是这五个');
      assert.eq(rampById('nope'), null, '没有这个预置');

      /* --- 宽字符 --- */
      assert(isWideChar(0x4e00), '汉字是宽字符');
      assert(!isWideChar(0x41), '字母不是宽字符');
      assert(!isWideChar(0x2588), '方块 █ 在多数终端里是单宽');
      assert(!isWideChar(0x2800), '盲文 U+2800 是单宽');
      var cleaned = cleanRamp('ab中');
      assert.eq(cleaned.ramp, 'ab', '宽字符被剔掉了');
      assert.eq(cleaned.dropped, ['中'], '剔掉的是那个汉字');
      var emojiClean = cleanRamp('😀a');
      assert.eq(emojiClean.ramp, 'a', 'emoji 是宽字符，被剔掉了');
      assert.eq(emojiClean.dropped.length, 1, '剔掉的是一整个 emoji');
      assert.eq(emojiClean.dropped[0].length, 2, 'emoji 没有被拆成两个半个代理项');

      /* --- 盲文位号 --- */
      assert.eq(brailleBit(0, 0), 0, '左上角是点1（位0）');
      assert.eq(brailleBit(1, 0), 3, '右上角是点4（位3）');
      assert.eq(brailleBit(0, 1), 1, '左二行是点2（位1）');
      assert.eq(brailleBit(1, 1), 4, '右二行是点5（位4）');
      assert.eq(brailleBit(0, 3), 6, '左四行是点7（位6）');
      assert.eq(brailleBit(1, 3), 7, '右四行是点8（位7）');
      assert.eq(brailleBit(2, 0), -1, '只有两列');
      assert.eq(brailleChar(0), '⠀', '空点阵是 U+2800');
      assert.eq(brailleChar(0xff), '⣿', '八个点全是 U+28FF');
      assert.eq(brailleChar(1), '⠁', '只有点1');

      /* --- Otsu --- */
      var bimodal = [];
      for (var i = 0; i < 10; i++) bimodal.push(0);
      for (var j = 0; j < 10; j++) bimodal.push(200);
      var thr = otsuThreshold(bimodal);
      assert(thr > 0 && thr < 200, '双峰直方图的阈值落在两个峰之间');
      assert(thr >= 10 && thr <= 190, '阈值取的是平台的中点，不会贴在暗峰上');
      assert.eq(otsuThreshold([]), 128, '没有样本时给个中间值');

      /* --- ANSI --- */
      assert.eq(ansiCell([1, 2, 3]), '\u001b[38;2;1;2;3m', '前景色转义序列');
      assert.eq(ansiLine(['a', 'b'], [[1, 2, 3], [1, 2, 3]], 2),
        '\u001b[38;2;1;2;3mab\u001b[0m', '连续同色的格子合成一段');

      /* --- 端到端 --- */
      // 2×2 的图：左半白、右半黑。切 2 列 1 行 → 左格是空格，右格是 '@'。
      var small = { w: 2, h: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
      for (var yy = 0; yy < 2; yy++) {
        for (var xx = 0; xx < 2; xx++) {
          var oo = (yy * 2 + xx) * 4;
          var vv = xx === 0 ? 255 : 0;
          small.data[oo] = vv; small.data[oo + 1] = vv; small.data[oo + 2] = vv; small.data[oo + 3] = 255;
        }
      }
      var cells2 = boxAverage(small, 2, 1);
      var art = renderAscii(cells2, 2, 1, { ramp: RAMPS.classic, invert: false });
      assert.eq(art.lines[0], ' @', '暗的那半是 @，亮的那半是空格');
      assert.eq(art.lines[0].length, 2, '行首的空格留着');
      assert.eq(art.lines[0].indexOf('@'), 1, '@ 在第二个位置');

      // 反转：亮的那半变成 @。
      var inv = renderAscii(cells2, 2, 1, { ramp: RAMPS.classic, invert: true });
      assert.eq(inv.lines[0], '@', '反转之后亮的那半变成 @，暗的那半变成空格');
      assert.eq(inv.lines[0].length, 1, '行尾的空格被去掉了');

      // 盲文：同样这张图，2 列 1 行 → 点阵是 4×4，左半的点都不凸，右半都凸。
      var dotCells = boxAverage(small, 4, 4);
      var brl = renderBraille(dotCells, 2, 1, null);
      assert.eq(brl.lines[0], '⠀⣿', '左边是空点阵，右边是满点阵');
      assert(brl.threshold > 0 && brl.threshold < 255, '自动阈值落在中间');
      var brlManual = renderBraille(dotCells, 2, 1, 254);
      assert.eq(brlManual.lines[0], '⠀⣿', '阈值放到 255 以下时白点也不凸');
    }
  };
})();
