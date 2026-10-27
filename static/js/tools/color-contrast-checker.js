/* ==========================================================================
   颜色对比度检查器（color-contrast-checker）

   按 WCAG 2.1 检查前景色与背景色的对比度：给出比值，并逐档标注
   普通文本 AA/AAA、大号文本 AA/AAA、UI 组件 AA 是否通过。

   参考实现：src/tools/color-contrast-checker/（it-tools, GPLv3）

   与原版的差别：
   1. **格式支持更宽**。原版只认 #rgb / #rrggbb / rgb() / rgba()，hsl() 和
      命名色一概不认。这里用项目里已经 vendor 的 colord 补上 hsl() / hsla()、
      4 位与 8 位 hex、百分数写法与 CSS Color 4 的空格语法；
      命名色因为 colord 的 names 插件没打进 static/lib/colord/bundle.js
      （color-converter.js 里已经踩过这个坑：Colord('olive').isValid() 是
      false），所以自带一张 CSS 命名色表。
   2. **alpha 真正参与合成**。原版直接忽略 alpha —— rgba(0,0,0,0.5) 被当成
      纯黑，算出来的比值比眼睛看到的实际比值大得多。本工具按浏览器的
      source-over 规则合成：前景合成到背景上，背景合成到白色上
      （口径写在 resolveColors 的注释里）。
   3. **阈值用未取整的比值判定**。原版先把比值四舍五入到两位小数再比阈值，
      4.4996 会被四舍五入成 4.5，于是「通过」AA。判定用原始比值，
      显示出来的仍然是两位小数。
   4. **阈值档位与原版完全一致**（WCAG 2.1 SC 1.4.3 / 1.4.6 / 1.4.11）：
      普通文本 4.5 / 7，大号文本 3 / 4.5，图形对象与 UI 组件 3。
      档位含义与原版逐条对齐，没有多也没有少。
   5. 界面从 Vue 组件换成原生 DOM；颜色输入是文本框 + 原生 <input type="color">。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('color-contrast-checker');

  /* ======================================================================
     一、纯逻辑
     ====================================================================== */

  /** 合成用的白色底 —— 背景本身带 alpha 时合成到它上面（页面底色默认白）。 */
  var WHITE = { r: 255, g: 255, b: 255, a: 1 };

  /**
   * CSS Color 4 的命名色关键字（值是 6 位 hex，不带 #）。
   *
   * 为什么自己带这张表：colord 的 names 插件没打进我们 vendor 的 bundle，
   * 只挂了核心 —— Colord('olive').isValid() 是 false，toName 也不存在。
   * 名字表是 CSS 规范里的标准值，147 个关键字（含 gray/grey 等异写）。
   */
  var NAMED_COLORS = {
    aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4',
    azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000',
    blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
    burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e',
    coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
    cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b',
    darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
    darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc',
    darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b',
    darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3',
    deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969',
    dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22',
    fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700',
    goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f',
    grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
    indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
    lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6',
    lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
    lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
    lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
    lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32',
    linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa',
    mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
    mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585',
    midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5',
    navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000',
    olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
    palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093',
    papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb',
    plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399',
    red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513',
    salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee',
    sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd',
    slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f',
    steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8',
    tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3',
    white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32'
  };

  function clamp01(x) {
    if (typeof x !== 'number' || !isFinite(x)) return 0;
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }

  /** 6 位 hex（不带 #）→ {r,g,b} */
  function hexToRgb(hex) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }

  /** {r,g,b} → '#rrggbb'（给原生取色器和界面显示用） */
  function formatHex(rgb) {
    return '#' + [rgb.r, rgb.g, rgb.b].map(function (v) {
      var s = Number(v).toString(16);
      return s.length < 2 ? '0' + s : s;
    }).join('');
  }

  /**
   * 拆 CSS 函数的参数：逗号写法与 CSS Color 4 的「空格 + /」写法都认。
   *   rgb(30, 136, 229)      → ['30','136','229']
   *   rgb(30 136 229 / 0.5)  → ['30','136','229','0.5']
   */
  function splitCssArgs(body) {
    var s = String(body == null ? '' : body).trim();
    if (s.indexOf(',') !== -1) {
      return s.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
    }
    var slash = s.split('/');
    var head = slash[0].trim().split(/\s+/).filter(Boolean);
    if (slash.length > 1) {
      var tail = slash[1].trim();
      if (tail) head.push(tail);
    }
    return head;
  }

  /**
   * rgb() 的一个通道：整数 0~255 或百分数。
   * 越界判非法 —— 原版也是判非法（rgb(300, 0, 0) 判非法），
   * 这里跟它一致，而不是像 CSS 那样夹到边界。
   */
  function parseRgbComponent(token) {
    var s = String(token == null ? '' : token).trim().toLowerCase();
    if (s === '') return undefined;
    var isPct = /%$/.test(s);
    var body = isPct ? s.slice(0, -1) : s;
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(body)) return undefined;
    var n = parseFloat(body);
    if (!isFinite(n)) return undefined;
    var v = isPct ? (n / 100) * 255 : n;
    if (v < 0 || v > 255) return undefined;
    return Math.round(v);
  }

  /** alpha：数字或百分数；越界夹到 0~1；'none' 当作 1（CSS Color 4）。 */
  function parseAlpha(token) {
    var s = String(token == null ? '' : token).trim().toLowerCase();
    if (s === '' || s === 'none') return 1;
    var isPct = /%$/.test(s);
    var body = isPct ? s.slice(0, -1) : s;
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(body)) return undefined;
    var n = parseFloat(body);
    if (!isFinite(n)) return undefined;
    return clamp01(isPct ? n / 100 : n);
  }

  /** 用 colord 试解析一次；解析不了（或库没加载）返回 undefined。 */
  function colordParse(text) {
    if (typeof window.Colord !== 'function') return undefined;
    try {
      var c = window.Colord(text);
      if (!c || typeof c.isValid !== 'function' || !c.isValid()) return undefined;
      return c;
    } catch (e) {
      return undefined;
    }
  }

  /**
   * 解析一个颜色 → {r, g, b, a}（a 是 0~1）；解析不了返回 undefined。
   *
   * 认得的写法：
   *   · #rgb / #rgba / #rrggbb / #rrggbbaa（不带 # 的 3 位与 6 位也认，与原版一致）
   *   · rgb() / rgba()：逗号写法、空格写法、百分数写法都认
   *   · hsl() / hsla()：逗号写法、空格写法、deg 单位都认
   *   · CSS 命名色（red / white / rebeccapurple …）与 transparent
   */
  function parseColorRgba(input) {
    if (typeof input !== 'string') return undefined;
    var s = input.trim();
    if (!s) return undefined;
    var lower = s.toLowerCase();

    /* 1) 命名色 */
    if (lower === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, lower)) {
      var named = hexToRgb(NAMED_COLORS[lower]);
      return { r: named.r, g: named.g, b: named.b, a: 1 };
    }

    /* 2) hex */
    if (/^#/.test(lower) || /^[0-9a-f]{3}$/.test(lower) || /^[0-9a-f]{6}$/.test(lower)) {
      var m = /^#?([0-9a-f]*)$/.exec(lower);
      if (!m) return undefined;
      var h = m[1];
      var withHash = lower.charAt(0) === '#';
      var len = h.length;
      // 带 # 认 3/4/6/8 位，不带 # 只认 3/6 位（与原版一致）
      var ok = withHash
        ? (len === 3 || len === 4 || len === 6 || len === 8)
        : (len === 3 || len === 6);
      if (!ok) return undefined;
      var full = (len === 3 || len === 4)
        ? h.split('').map(function (ch) { return ch + ch; }).join('')
        : h;
      var alpha = 1;
      if (full.length === 8) {
        alpha = parseInt(full.slice(6, 8), 16) / 255;
        full = full.slice(0, 6);
      }
      var rgb = hexToRgb(full);
      return { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha };
    }

    /* 3) rgb() / rgba() */
    if (/^rgba?\(/i.test(s)) {
      var rm = /^rgba?\(([^()]*)\)$/i.exec(s);
      if (!rm) return undefined;
      var args = splitCssArgs(rm[1]);
      if (args.length !== 3 && args.length !== 4) return undefined;
      var comps = [];
      for (var i = 0; i < 3; i++) {
        var c = parseRgbComponent(args[i]);
        if (c === undefined) return undefined;
        comps.push(c);
      }
      var a = 1;
      if (args.length === 4) {
        a = parseAlpha(args[3]);
        if (a === undefined) return undefined;
      }
      return { r: comps[0], g: comps[1], b: comps[2], a: a };
    }

    /* 4) hsl() / hsla() —— 交给 colord（它认 deg 单位与空格写法）。
     *    colord 不认 CSS Color 4 的「/ alpha」写法，这里先改写成逗号形式。 */
    if (/^hsla?\(/i.test(s)) {
      var hm = /^hsla?\(([^()]*)\)$/i.exec(s);
      if (!hm) return undefined;
      var body = hm[1];
      if (body.indexOf('/') !== -1) {
        var parts = body.split('/');
        var head = parts[0].trim().split(/\s+/).filter(Boolean);
        var tail = parts.length > 1 ? parts[1].trim() : '';
        if (head.length === 3 && tail) body = head.join(', ') + ', ' + tail;
      }
      // 有 alpha 用 hsla()，没有就用 hsl()（colord 两种都收，但分开写更保险）
      var hc = colordParse((splitCssArgs(body).length === 4 ? 'hsla(' : 'hsl(') + body + ')');
      if (!hc) return undefined;
      var hrgb = hc.toRgb();
      return { r: hrgb.r, g: hrgb.g, b: hrgb.b, a: hrgb.a };
    }

    /* 5) 兜底：再问一次 colord（万一以后 bundle 里多了别的插件） */
    var fallback = colordParse(s);
    if (fallback) {
      var frgb = fallback.toRgb();
      return { r: frgb.r, g: frgb.g, b: frgb.b, a: frgb.a };
    }
    return undefined;
  }

  /**
   * 原版的 parseColor：只给 r/g/b，alpha 直接丢掉。
   *
   * 原版对 rgba(0,0,0,0.5) 就是这么干的 —— 它的对比度计算把 alpha 当不存在。
   * 要真正参与合成请用 parseColorRgba + resolveColors。
   */
  function parseColor(input) {
    var c = parseColorRgba(input);
    if (!c) return undefined;
    return { r: c.r, g: c.g, b: c.b };
  }

  /** WCAG 2.1 相对亮度（sRGB → 线性化 → 加权求和）。 */
  function relativeLuminance(rgb) {
    function channel(component) {
      var scaled = component / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  /** 未取整的比值 —— 阈值判定用它（见 checkContrast 的注释）。 */
  function rawContrastRatio(a, b) {
    var la = relativeLuminance(a);
    var lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** 对比度比值（保留两位小数）。 */
  function contrastRatio(a, b) {
    return Math.round(rawContrastRatio(a, b) * 100) / 100;
  }

  /**
   * 逐档判定。
   *
   * 阈值取自 WCAG 2.1：
   *   · SC 1.4.3 对比度（最低）—— 普通文本 AA 4.5:1，大号文本 AA 3:1
   *   · SC 1.4.6 对比度（增强）—— 普通文本 AAA 7:1，大号文本 AAA 4.5:1
   *   · SC 1.4.11 非文本对比 —— 图形对象与 UI 组件 3:1
   *
   * 判定用的是**未取整**的比值：比值 4.4996 达不到 4.5:1 的 AA，
   * 先四舍五入成 4.5 再判就会放过它（原版就是先取整再判）。
   * 对外显示的 ratio 仍然是两位小数。
   */
  function checkContrast(fg, bg) {
    var raw = rawContrastRatio(fg, bg);
    var lf = relativeLuminance(fg);
    var lb = relativeLuminance(bg);
    var lighter = lf >= lb ? fg : bg;
    var darker = lighter === fg ? bg : fg;
    return {
      ratio: Math.round(raw * 100) / 100,
      aaNormal: raw >= 4.5,
      aaaNormal: raw >= 7,
      aaLarge: raw >= 3,
      aaaLarge: raw >= 4.5,
      uiComponents: raw >= 3,
      lighter: lighter,
      darker: darker
    };
  }

  /** {r,g,b} → 'rgb(r, g, b)' */
  function formatRgb(rgb) {
    return 'rgb(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ')';
  }

  /**
   * 把带 alpha 的前景色合成到不透明的背景色上（浏览器的 source-over 规则）。
   *
   * 合成在 **sRGB 空间**做（不是线性光），与浏览器默认的 CSS 合成一致；
   * 结果按四舍五入取整到 0~255 的整数通道。
   */
  function compositeOver(fg, bg) {
    var a = clamp01(fg.a === undefined ? 1 : fg.a);
    return {
      r: Math.round(fg.r * a + bg.r * (1 - a)),
      g: Math.round(fg.g * a + bg.g * (1 - a)),
      b: Math.round(fg.b * a + bg.b * (1 - a))
    };
  }

  /**
   * 解析两个颜色输入，并按「合成口径」求出真正要拿来比的那两种颜色。
   *
   * 口径（本工具与原版最大的差别）：
   *   · 背景带 alpha → **合成到白色上**（页面底色默认白；不透明时是恒等变换）
   *   · 前景带 alpha → **合成到（已合成的）背景上** —— 这正是浏览器里
   *     半透明文字叠在背景上的样子
   *   · 合成在 sRGB 空间做，结果取整到 0~255
   *
   * 原版的做法是**完全忽略 alpha**：rgba(0,0,0,0.5) 被当成纯黑，
   * 算出来的比值比实际看到的大得多（比如 50% 的黑叠在白底上，原版给 21:1，
   * 合成之后其实是中灰配白底，只有 3.95:1）。
   *
   * @returns {{fg, bg, fgSolid, bgSolid}|undefined} 解析不了返回 undefined
   */
  function resolveColors(fgInput, bgInput) {
    var fg = parseColorRgba(fgInput);
    var bg = parseColorRgba(bgInput);
    if (!fg || !bg) return undefined;
    var bgSolid = compositeOver(bg, WHITE);
    var fgSolid = compositeOver(fg, bgSolid);
    return {
      fg: fg,
      bg: bg,
      fgSolid: fgSolid,
      bgSolid: bgSolid
    };
  }

  /**
   * 端到端：输入两段颜色文本 → 合成后的对比度报告。
   * 解析不了返回 undefined。
   */
  function checkContrastText(fgInput, bgInput) {
    var resolved = resolveColors(fgInput, bgInput);
    if (!resolved) return undefined;
    var result = checkContrast(resolved.fgSolid, resolved.bgSolid);
    result.fgSource = resolved.fg;
    result.bgSource = resolved.bg;
    result.fgSolid = resolved.fgSolid;
    result.bgSolid = resolved.bgSolid;
    return result;
  }

  /* ======================================================================
     二、界面
     ====================================================================== */

  var DEFAULT_FG = '#1e88e5';
  var DEFAULT_BG = '#ffffff';

  /** 五个档位：键对应 checkContrast 返回的字段，阈值是 WCAG 2.1 的要求。 */
  var LEVELS = [
    { key: 'aaNormal', label: t('level_aa_normal', 'AA · normal text'), threshold: '4.5:1' },
    { key: 'aaaNormal', label: t('level_aaa_normal', 'AAA · normal text'), threshold: '7:1' },
    { key: 'aaLarge', label: t('level_aa_large', 'AA · large text'), threshold: '3:1' },
    { key: 'aaaLarge', label: t('level_aaa_large', 'AAA · large text'), threshold: '4.5:1' },
    { key: 'uiComponents', label: t('level_ui', 'UI components & graphics'), threshold: '3:1' }
  ];

  window.ItTools.register('color-contrast-checker', function (root) {
    var offs = [];

    /* ---- 输入区 ---- */
    var fgInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('fg_ph', '#1e88e5, rgb(30, 136, 229), hsl(207, 79%, 51%) or red'),
      spellcheck: 'false', autocomplete: 'off'
    });
    var bgInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('bg_ph', '#ffffff, white, rgb(255, 255, 255)'),
      spellcheck: 'false', autocomplete: 'off'
    });
    var fgPicker = D.h('input.layui-input', {
      type: 'color', value: DEFAULT_FG,
      title: t('fg_picker', 'Foreground color picker'),
      style: { flex: '0 0 46px', width: '46px', padding: '2px', height: '34px', cursor: 'pointer' }
    });
    var bgPicker = D.h('input.layui-input', {
      type: 'color', value: DEFAULT_BG,
      title: t('bg_picker', 'Background color picker'),
      style: { flex: '0 0 46px', width: '46px', padding: '2px', height: '34px', cursor: 'pointer' }
    });

    // 错误提示用 .form-status.is-error —— app.css 里给深色主题单独配过颜色，
    // 自己写死一个红色在深色主题下会太暗。
    var fgError = D.h('p.form-status', { style: { margin: '4px 0 0', fontSize: '12px' } });
    var bgError = D.h('p.form-status', { style: { margin: '4px 0 0', fontSize: '12px' } });

    var colorsCard = D.h('div.card', null,
      D.h('h3', { text: t('title_colors', 'Colors') }),
      D.h('div.field', null,
        D.h('label.field-label', { for: 'ccc-fg', text: t('fg_label', 'Foreground (text)') }),
        D.h('div.input-group', null, fgInput, fgPicker),
        fgError,
        D.h('p.field-hint', { text: t('formats_hint', 'Accepts #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla() and CSS color names.') })
      ),
      D.h('div.field', null,
        D.h('label.field-label', { for: 'ccc-bg', text: t('bg_label', 'Background') }),
        D.h('div.input-group', null, bgInput, bgPicker),
        bgError,
        D.h('p.field-hint', { text: t('alpha_hint', 'Alpha is composited: the foreground is blended over the background, the background over white.') })
      ),
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('swap', 'Swap colors'),
          onclick: function () {
            var f = fgInput.value;
            fgInput.value = bgInput.value;
            bgInput.value = f;
            render();
          }
        }),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('reset', 'Reset'),
          onclick: function () {
            fgInput.value = DEFAULT_FG;
            bgInput.value = DEFAULT_BG;
            render();
          }
        })
      )
    );
    fgInput.id = 'ccc-fg';
    bgInput.id = 'ccc-bg';

    /* ---- 结果区 ---- */
    var ratioEl = D.h('div', { style: { fontSize: '34px', fontWeight: '600', lineHeight: '1.2' } });
    var verdictEl = D.h('div.form-status', { style: { marginTop: '2px' } });
    var onEl = D.h('p.field-hint');
    var previewEl = D.h('div', {
      style: {
        padding: '16px', borderRadius: '6px',
        border: '1px solid var(--border-sider)', marginTop: '12px'
      }
    },
      D.h('span', { text: t('sample_text', 'Sample text at 16px and') }),
      D.h('span', { style: { fontSize: '24px' }, text: t('sample_text_large', '24px') })
    );
    var levelsBody = D.h('tbody');
    var detailsBody = D.h('tbody');

    var resultsCard = D.h('div.card', null,
      D.h('h3', { text: t('title_results', 'Results') }),
      D.h('div', null,
        D.h('div.field-label', { text: t('ratio_label', 'Contrast ratio') }),
        ratioEl,
        verdictEl,
        onEl
      ),
      previewEl,
      D.h('div.form-actions', { style: { marginTop: '12px' } },
        U.copyButton(function () { return ratioText(); }, t('copy_ratio', 'Copy ratio'))
      ),
      D.h('table.kv-table', { style: { marginTop: '12px' } },
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_level', 'Level') }),
          D.h('th', { text: t('col_threshold', 'Threshold') }),
          D.h('th', { text: t('col_result', 'Result') })
        )),
        levelsBody
      ),
      D.h('table.kv-table', { style: { marginTop: '12px' } },
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_property', 'Property') }),
          D.h('th', { text: t('col_color', 'Color') }),
          D.h('th', { text: t('col_luminance', 'Relative luminance') })
        )),
        detailsBody
      )
    );

    /** 复制按钮的取值：比值那一行。 */
    function ratioText() {
      var res = checkContrastText(fgInput.value, bgInput.value);
      return res ? res.ratio + ':1' : '';
    }

    /* ---- 渲染 ---- */

    function row(cells) {
      return D.h('tr', null, cells.map(function (c) {
        return D.h('td', { text: c });
      }));
    }

    function render() {
      var fg = parseColorRgba(fgInput.value);
      var bg = parseColorRgba(bgInput.value);

      fgError.textContent = fg ? '' : t('invalid_color', 'Not a valid color.');
      bgError.textContent = bg ? '' : t('invalid_color', 'Not a valid color.');
      fgError.classList.toggle('is-error', !fg);
      bgError.classList.toggle('is-error', !bg);
      fgError.hidden = !!fg;
      bgError.hidden = !!bg;
      // 取色器只能表示不透明的颜色，alpha 只在文本框里给
      if (fg) fgPicker.value = formatHex(fg);
      if (bg) bgPicker.value = formatHex(bg);

      var res = checkContrastText(fgInput.value, bgInput.value);
      if (!res) {
        resultsCard.hidden = true;
        return;
      }
      resultsCard.hidden = false;

      ratioEl.textContent = res.ratio + ':1';
      var aaOk = res.aaNormal && res.aaLarge && res.uiComponents;
      verdictEl.textContent = aaOk
        ? t('overall_pass', 'Passes every WCAG 2.1 AA requirement')
        : t('overall_fail', 'Fails at least one WCAG 2.1 AA requirement');
      verdictEl.classList.toggle('is-error', !aaOk);
      verdictEl.style.color = aaOk ? 'var(--primary)' : '';
      onEl.textContent = t('on_color', '{fg} on {bg}')
        .replace('{fg}', formatHex(res.fgSolid))
        .replace('{bg}', formatHex(res.bgSolid));

      previewEl.style.background = formatHex(res.bgSolid);
      previewEl.style.color = formatHex(res.fgSolid);

      D.clear(levelsBody);
      LEVELS.forEach(function (lv) {
        var pass = res[lv.key];
        levelsBody.appendChild(row([
          lv.label,
          lv.threshold,
          pass ? t('pass', 'Pass') : t('fail', 'Fail')
        ]));
      });

      D.clear(detailsBody);
      detailsBody.appendChild(row([
        t('lighter', 'Lighter'),
        formatHex(res.lighter),
        relativeLuminance(res.lighter).toFixed(4)
      ]));
      detailsBody.appendChild(row([
        t('darker', 'Darker'),
        formatHex(res.darker),
        relativeLuminance(res.darker).toFixed(4)
      ]));
      if (res.fgSource.a < 1 || res.bgSource.a < 1) {
        detailsBody.appendChild(row([
          t('composited', 'Composited colors'),
          formatHex(res.fgSolid) + ' / ' + formatHex(res.bgSolid),
          ''
        ]));
      }
    }

    offs.push(D.on(fgInput, 'input', render));
    offs.push(D.on(bgInput, 'input', render));
    offs.push(D.on(fgPicker, 'input', function () {
      fgInput.value = fgPicker.value;
      render();
    }));
    offs.push(D.on(bgPicker, 'input', function () {
      bgInput.value = bgPicker.value;
      render();
    }));

    fgInput.value = DEFAULT_FG;
    bgInput.value = DEFAULT_BG;
    render();

    root.appendChild(colorsCard);
    root.appendChild(resultsCard);

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  /* ======================================================================
     三、纯逻辑出口 + 单测用例
     ====================================================================== */
  window.ItTools.logic['color-contrast-checker'] = {
    DEFAULT_FG: DEFAULT_FG,
    DEFAULT_BG: DEFAULT_BG,
    LEVELS: LEVELS,
    NAMED_COLORS: NAMED_COLORS,
    parseColor: parseColor,
    parseColorRgba: parseColorRgba,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    rawContrastRatio: rawContrastRatio,
    checkContrast: checkContrast,
    checkContrastText: checkContrastText,
    formatRgb: formatRgb,
    formatHex: formatHex,
    compositeOver: compositeOver,
    resolveColors: resolveColors,
    splitCssArgs: splitCssArgs,

    __cases: function (assert) {
      /* ==================================================================
         parseColor —— 直接照抄参考实现的单测期望值
         （src/tools/color-contrast-checker/color-contrast-checker.models.test.ts）
         ================================================================== */
      assert.eq(parseColor('#fff'), { r: 255, g: 255, b: 255 }, '三位 hex 展开成 rgb');
      assert.eq(parseColor('#1e88e5'), { r: 0x1E, g: 0x88, b: 0xE5 }, '六位 hex');
      assert.eq(parseColor('rgb(30, 136, 229)'), { r: 30, g: 136, b: 229 }, 'rgb() 逗号写法');
      assert.eq(parseColor('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0 }, 'rgba() 的 alpha 被丢掉（原版口径）');

      assert.eq(parseColor('not-a-color'), undefined, '垃圾输入判非法');
      assert.eq(parseColor('#12345'), undefined, '五位 hex 判非法');
      assert.eq(parseColor('rgb(300, 0, 0)'), undefined, '越界的通道判非法（原版口径，不夹到边界）');

      /* ==================================================================
         relativeLuminance 与 contrastRatio
         ================================================================== */
      assert.eq(relativeLuminance({ r: 0, g: 0, b: 0 }), 0, '黑色的相对亮度是 0');
      assert(Math.abs(relativeLuminance({ r: 255, g: 255, b: 255 }) - 1) < 1e-12, '白色的相对亮度是 1');

      assert.eq(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21, '黑白对比度正好是 21:1');
      assert.eq(contrastRatio({ r: 0x76, g: 0x76, b: 0x76 }, { r: 255, g: 255, b: 255 }), 4.54, '#767676 配白底是 4.54:1（刚好过 AA 的那个灰）');

      var a = { r: 0x1E, g: 0x88, b: 0xE5 };
      var b = { r: 255, g: 255, b: 255 };
      assert.eq(contrastRatio(a, b), contrastRatio(b, a), '对比度是对称的 —— 谁亮谁暗都一样');

      /* ==================================================================
         checkContrast
         ================================================================== */
      var result = checkContrast({ r: 0x76, g: 0x76, b: 0x76 }, { r: 255, g: 255, b: 255 });
      assert.eq(result.ratio, 4.54, '比值是 4.54');
      assert.eq(result.aaNormal, true, '普通文本 AA 过');
      assert.eq(result.aaaNormal, false, '普通文本 AAA 不过');
      assert.eq(result.aaLarge, true, '大号文本 AA 过');
      assert.eq(result.aaaLarge, true, '大号文本 AAA 过');
      assert.eq(result.uiComponents, true, 'UI 组件过');

      var bw = checkContrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
      assert.eq(bw.lighter, { r: 255, g: 255, b: 255 }, '白的那个是较亮的');
      assert.eq(bw.darker, { r: 0, g: 0, b: 0 }, '黑的那个是较暗的');

      var same = checkContrast({ r: 128, g: 128, b: 128 }, { r: 128, g: 128, b: 128 });
      assert.eq(same.ratio, 1, '同一个颜色比值是 1');
      assert.eq(same.aaNormal, false, '同一个颜色过不了普通文本 AA');
      assert.eq(same.uiComponents, false, '同一个颜色过不了 UI 组件');

      /* ==================================================================
         formatRgb
         ================================================================== */
      assert.eq(formatRgb({ r: 30, g: 136, b: 229 }), 'rgb(30, 136, 229)', '输出 css 的 rgb() 写法');

      /* ==================================================================
         新增：格式支持比原版宽
         ================================================================== */
      assert.eq(parseColor('hsl(210, 79%, 51%)'), { r: 31, g: 130, b: 229 }, 'hsl() 逗号写法');
      assert.eq(parseColor('hsl(210 79% 51%)'), { r: 31, g: 130, b: 229 }, 'hsl() 空格写法');
      assert.eq(parseColor('hsl(210deg 79% 51%)'), { r: 31, g: 130, b: 229 }, 'hsl() 带 deg 单位');
      assert.eq(parseColor('hsla(210, 79%, 51%, 0.5)'), { r: 31, g: 130, b: 229 }, 'hsla() 的 alpha 被丢掉');
      assert.eq(parseColor('red'), { r: 255, g: 0, b: 0 }, '命名色 red');
      assert.eq(parseColor('WHITE'), { r: 255, g: 255, b: 255 }, '命名色不区分大小写');
      assert.eq(parseColor('rebeccapurple'), { r: 0x66, g: 0x33, b: 0x99 }, '命名色 rebeccapurple');
      assert.eq(parseColor('#abc'), { r: 0xAA, g: 0xBB, b: 0xCC }, '三位 hex 仍然认');
      assert.eq(parseColor('rgb(100%, 0%, 0%)'), { r: 255, g: 0, b: 0 }, 'rgb() 的百分数写法');
      assert.eq(parseColor('rgb(30 136 229)'), { r: 30, g: 136, b: 229 }, 'rgb() 的空格写法');
      assert.eq(parseColor('#fff'), { r: 255, g: 255, b: 255 }, '原版认的写法一个没少');

      assert.eq(parseColor('hsl(210, 79, 51)'), undefined, 'hsl 的饱和度必须是百分数');
      assert.eq(parseColor('rgb(1, 2)'), undefined, 'rgb 分量不够判非法');
      assert.eq(parseColor('rgb(1, 2, 3, 4, 5)'), undefined, 'rgb 分量太多判非法');
      assert.eq(parseColor('rgb(1, 2, 3) garbage'), undefined, 'rgb() 后面有别的字符判非法');
      assert.eq(parseColor('rgb(-5, 0, 0)'), undefined, '负数通道判非法');
      assert.eq(parseColor('notacolor'), undefined, '纯字母的垃圾输入判非法');
      assert.eq(parseColor(''), undefined, '空串判非法');
      assert.eq(parseColor(undefined), undefined, '非字符串判非法');

      /* ==================================================================
         新增：alpha 真正参与合成（口径见 resolveColors 的注释）
         ================================================================== */
      // 半透明黑叠在白底上 —— 原版会当成纯黑给出 21:1，合成后其实是中灰配白底
      var half = checkContrastText('rgba(0, 0, 0, 0.5)', '#ffffff');
      assert.eq(half.ratio, 3.95, '半透明黑叠白底合成后是 3.95:1（不是原版的 21:1）');
      assert.eq(half.fgSolid, { r: 128, g: 128, b: 128 }, '半透明黑合成到白底上是中灰');
      assert.eq(half.bgSolid, { r: 255, g: 255, b: 255 }, '背景不透明，合成后不变');

      // 不透明的 alpha=1 不受影响
      assert.eq(checkContrastText('rgba(0, 0, 0, 1)', '#ffffff').ratio, 21, 'alpha=1 就是纯黑');
      // 完全透明的前景合成到背景上 → 与背景同色，比值 1
      assert.eq(checkContrastText('rgba(0, 0, 0, 0)', '#ffffff').ratio, 1, '全透明的前景等于背景');
      // 背景带 alpha → 合成到白色上
      var overWhite = checkContrastText('#000000', 'rgba(255, 255, 255, 0.5)');
      assert.eq(overWhite.bgSolid, { r: 255, g: 255, b: 255 }, '半透明白背景合成到白底上仍是白');
      assert.eq(overWhite.ratio, 21, '黑字配半透明白底还是 21:1');

      // 半透明前景叠在已知色上：50% 的黑叠在 #767676 上 = (118 + 0) / 2 = 59
      assert.eq(compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 118, g: 118, b: 118 }),
        { r: 59, g: 59, b: 59 }, '50% 的黑叠在 #767676 上是 #3b3b3b');

      // alpha 通道本身也要认
      assert.eq(parseColorRgba('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 }, 'rgba() 保留 alpha');
      assert.eq(parseColorRgba('#00000080'), { r: 0, g: 0, b: 0, a: 128 / 255 }, '八位 hex 的 alpha 是后两位');
      assert.eq(parseColorRgba('#0008'), { r: 0, g: 0, b: 0, a: 136 / 255 }, '四位 hex 的 alpha 会被复制成两位');
      assert.eq(parseColorRgba('transparent'), { r: 0, g: 0, b: 0, a: 0 }, 'transparent 是全透明的黑');

      /* ==================================================================
         新增：阈值用未取整的比值判定（原版先取整，会放过 4.4996）
         ================================================================== */
      // 找一个比值落在 4.47~4.5 之间的颜色：#777777 配白底
      var near = checkContrast({ r: 0x77, g: 0x77, b: 0x77 }, { r: 255, g: 255, b: 255 });
      assert(near.ratio < 4.5, '#777777 配白底的比值不到 4.5');
      assert.eq(near.aaNormal, false, '不到 4.5 就不能算普通文本 AA 通过');
      assert.eq(near.aaaLarge, false, '大号文本 AAA 要 4.5，也不过');
      assert.eq(near.aaLarge, true, '#777777 过 AA 大号文本（3:1）');
      assert.eq(near.uiComponents, true, '#777777 过 UI 组件（3:1）');

      /* ==================================================================
         工具自己的其它纯函数
         ================================================================== */
      assert.eq(formatHex({ r: 30, g: 136, b: 229 }), '#1e88e5', '转成 #rrggbb');
      assert.eq(formatHex({ r: 0, g: 0, b: 0 }), '#000000', '补齐两位');
      assert.eq(splitCssArgs('30, 136, 229'), ['30', '136', '229'], '逗号写法拆参数');
      assert.eq(splitCssArgs('30 136 229 / 0.5'), ['30', '136', '229', '0.5'], '空格加斜杠写法拆参数');
      assert.eq(resolveColors('#fff', 'not-a-color'), undefined, '背景解析不了时返回 undefined');
      assert.eq(Object.keys(LEVELS).length, 5, '五个档位');
    }
  };
})();
