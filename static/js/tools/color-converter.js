/* ==========================================================================
   颜色转换器（color-converter）

   一个颜色同时给出 HEX / RGB / HSL / HSV / HWB / CMYK 六种写法，任意一种
   改动了其余五种跟着变。

   参考实现：src/tools/color-converter/（it-tools, GPLv3）

   ---- 与参考实现的差别 ----
   1. **少了 lch 和 name 两项**，因为打进 static/lib/colord/bundle.js 的
      colord@2.9.3 只挂出了 `colord` 这一个函数：
        window.Colord.extend            → undefined
        实例上只有 toHex / toRgb / toRgbString / toHsl / toHslString / toHsv
      也就是说 cmyk / hwb / names / lch 四个插件**一个都没打进来**。
      与其抄一份插件源码进来（等于自带第三方代码），不如：
        · hwb、cmyk 纯算 —— 它们就是 toRgb() 上的一个公式，自己写 20 行；
        · hsv 用核心自带的 toHsv() / Colord({h,s,v})；
        · lch 砍掉 —— 它要 sRGB → XYZ(D65) → Lab → LCH 整条链，还要处理
          gamut 映射，自己重写一份色彩学管线不值得；
        · name 砍掉 —— 没有 names 插件，`Colord('olive').isValid()` 是 false，
          连**解析**都做不到，留一个永远报错的输入框没意义。
   2. 颜色选择器从 naive-ui 的 n-color-picker 换成原生
      `<input type="color">`（没有构建步骤，也拿不到 naive-ui）。原版能带
      alpha，原生控件不能，所以选择器这一行固定输出 #rrggbb。
   3. `_.forEach(formats, …)` 换成 Object.keys 遍历 —— lodash 是参考实现的
      依赖，我们的清单里没有 lodash，而 Object.keys 对本工具这种纯对象
      枚举是等价的。
   4. Vue 的 ref / computed / useValidation 换成普通的 state 对象 + 事件
      监听；`buildColorFormat` / `updateColorValue` 保留成纯函数，
      这样 expected 值可以直接进 __cases 跑断言。
   5. 补了变换面板（上游 #1017 的 a 部分）：饱和度 / 亮度滑块 + 灰度 / 反相开关。
      上游为了调这些方法引了 colord 的插件，可我们打进来的 bundle 里
      **核心本来就带** grayscale / invert / saturate / desaturate / lighten /
      darken —— 一个新依赖都不用加。
      两个坑都在 transformColor() 的注释里：colord 的这些方法返回的是**新实例**，
      以及变换必须永远从源色重算（否则拖一次滑块叠一层）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('color-converter');

  /* ======================================================================
     一、从参考实现原样搬过来的纯逻辑
     ====================================================================== */

  /** 参考实现 color-converter.models.ts 里的 removeAlphaChannelWhenOpaque，逐字照抄。 */
  function removeAlphaChannelWhenOpaque(hexColor) {
    return hexColor.replace(/^(#(?:[0-9a-f]{3}){1,2})ff$/i, '$1');
  }

  /**
   * 造一种颜色格式的描述符。参考实现里它是 Vue 的组合式函数（自带 ref 和
   * useValidation），这里只留数据与纯函数部分，校验状态由 UI 自己管。
   *
   * @param {{label: string, parse?: (v: string) => any, format: (c: any) => string,
   *          placeholder?: string, invalidMessage?: string, type?: string}} spec
   */
  function buildColorFormat(spec) {
    var o = spec || {};
    var label = o.label || '';
    var rawParse = o.parse || function (v) { return window.Colord(v); };
    return {
      label: label,
      type: o.type || 'text',
      placeholder: o.placeholder || '',
      invalidMessage: o.invalidMessage || ('Invalid ' + String(label).toLowerCase() + ' format.'),
      format: o.format,
      /** 解析失败一律吞成 undefined（对应参考实现的 withDefaultOnError）。 */
      parse: function (value) {
        try { return rawParse(value); } catch (e) { return undefined; }
      },
      /** 空串算合法（对应参考实现的 validator：v === '' 直接 return true）。 */
      isValid: function (value) {
        if (String(value) === '') return true;
        var c;
        try { c = rawParse(value); } catch (e) { return false; }
        return !!c && typeof c.isValid === 'function' && c.isValid();
      }
    };
  }

  /**
   * 把一个颜色实例展开成各格式的文本。
   * @param {Object<string, {format: Function}>} formats
   * @param {{isValid: Function}|undefined} value
   * @param {string} [omitKey] 正在编辑的那一项，不覆盖它
   * @returns {Object<string, string>} key → 文本（无变化时返回 {}）
   */
  function updateColorValue(formats, value, omitKey) {
    if (value === undefined || value === null) return {};
    if (typeof value.isValid !== 'function' || !value.isValid()) return {};
    var out = {};
    Object.keys(formats).forEach(function (key) {
      if (key !== omitKey) out[key] = formats[key].format(value);
    });
    return out;
  }

  /* ======================================================================
     二、HWB / CMYK —— 库里的插件没打进来，这两段自己算
     ====================================================================== */

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  /** 取一个数字；带 % 的按百分数除以 100。解析不了给 NaN。 */
  function toNum(token) {
    var tok = String(token == null ? '' : token).trim().toLowerCase();
    var pct = /%$/.test(tok);
    tok = tok.replace(/(deg|grad|rad|turn|%)$/g, '');
    var n = parseFloat(tok);
    if (!isFinite(n)) return NaN;
    return pct ? n / 100 : n;
  }

  /**
   * 把 "hwb(60 0% 50%)" / "hwb(60, 0%, 50%)" / "hwb(60 0% 50% / 0.5)" 这类
   * 函数式写法拆成 4 个字符串片段（h, w, b, alpha）。不匹配返回 null。
   */
  function funcTokens(value, name) {
    var s = String(value == null ? '' : value).trim().toLowerCase();
    var at = s.indexOf(name);
    if (at === -1) return null;
    var open = s.indexOf('(', at);
    if (open === -1) return null;
    var close = s.indexOf(')', open);
    if (close === -1) return null;
    var body = s.slice(open + 1, close).trim();
    if (body === '') return [];
    return body.split(/[\s,\/]+/).filter(Boolean);
  }

  /**
   * "hsv(...)" / "hsva(...)" → {h, s, v, a}。
   * 注意 s/v 在 CSS 式写法里带 %，toNum 会除以 100，这里要乘回 0~100 ——
   * 跟 colord 核心的 toHsv() / Colord({h,s,v}) 保持同一套单位。
   */
  function hsvFromTokens(value) {
    var tok = funcTokens(value, 'hsv') || funcTokens(value, 'hsva');
    if (!tok || tok.length < 3 || tok.length > 4) return null;
    var h = toNum(tok[0]), s = toNum(tok[1]) * 100, v = toNum(tok[2]) * 100;
    var a = tok.length === 4 ? toNum(tok[3]) : 1;
    if (!isFinite(h) || !isFinite(s) || !isFinite(v) || !isFinite(a)) return null;
    return { h: h, s: s, v: v, a: a };
  }

  /** "hwb(...)" → {h, w, b, a}（w/b 是 0~1） */
  function hwbFromTokens(value) {
    var tok = funcTokens(value, 'hwb');
    if (!tok || tok.length < 3 || tok.length > 4) return null;
    var h = toNum(tok[0]), w = toNum(tok[1]), b = toNum(tok[2]);
    var a = tok.length === 4 ? toNum(tok[3]) : 1;
    if (!isFinite(h) || !isFinite(w) || !isFinite(b) || !isFinite(a)) return null;
    return { h: h, w: w, b: b, a: a };
  }

  /** "cmyk(...)" / "device-cmyk(...)" → {c, m, y, k, a}（0~1） */
  function cmykFromTokens(value) {
    var tok = funcTokens(value, 'device-cmyk') || funcTokens(value, 'cmyk');
    if (!tok || tok.length < 4 || tok.length > 5) return null;
    var c = toNum(tok[0]), m = toNum(tok[1]), y = toNum(tok[2]), k = toNum(tok[3]);
    var a = tok.length === 5 ? toNum(tok[4]) : 1;
    if (!isFinite(c) || !isFinite(m) || !isFinite(y) || !isFinite(k) || !isFinite(a)) return null;
    return { c: c, m: m, y: y, k: k, a: a };
  }

  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 100) / 100;
    v = clamp(v, 0, 100) / 100;
    var c = v * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = v - c;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }

  function hwbToRgb(h, w, b) {
    w = clamp(w, 0, 1);
    b = clamp(b, 0, 1);
    if (w + b >= 1) {
      var g = Math.round((w / (w + b)) * 255);
      return { r: g, g: g, b: g };
    }
    var pure = hsvToRgb(h, 100, 100);
    var f = 1 - w - b;
    return {
      r: Math.round(pure.r * f + w * 255),
      g: Math.round(pure.g * f + w * 255),
      b: Math.round(pure.b * f + w * 255)
    };
  }

  function cmykToRgb(c, m, y, k) {
    c = clamp(c, 0, 1); m = clamp(m, 0, 1); y = clamp(y, 0, 1); k = clamp(k, 0, 1);
    return {
      r: Math.round(255 * (1 - c) * (1 - k)),
      g: Math.round(255 * (1 - m) * (1 - k)),
      b: Math.round(255 * (1 - y) * (1 - k))
    };
  }

  /** {r,g,b}（0~255）→ Colord 实例，a 缺省 1。 */
  function rgbToColord(rgb, a) {
    var alpha = a === undefined || a === null ? 1 : clamp(a, 0, 1);
    var base = window.Colord('#' + U.hex(new Uint8Array([rgb.r, rgb.g, rgb.b])));
    return alpha >= 1 ? base : base.alpha(alpha);
  }

  /** 解析失败时给一个 isValid() 为 false 的 Colord，而不是退回黑色。 */
  function invalidColor() { return window.Colord(''); }

  function parseHsv(value) {
    var tok = hsvFromTokens(value);
    if (!tok) return invalidColor();
    return window.Colord({ h: tok.h, s: tok.s, v: tok.v, a: clamp(tok.a, 0, 1) });
  }

  function parseHwb(value) {
    var tok = hwbFromTokens(value);
    if (!tok) return invalidColor();
    return rgbToColord(hwbToRgb(tok.h, tok.w, tok.b), tok.a);
  }

  function parseCmyk(value) {
    var tok = cmykFromTokens(value);
    if (!tok) return invalidColor();
    return rgbToColord(cmykToRgb(tok.c, tok.m, tok.y, tok.k), tok.a);
  }

  function pct(x) { return Math.round(x * 100) + '%'; }
  function alphaText(a) { return a >= 1 ? '' : ' / ' + String(Math.round(a * 100) / 100); }

  function formatHsv(color) {
    var h = color.toHsv();
    return 'hsv(' + h.h + ', ' + h.s + '%, ' + h.v + '%' +
      (h.a >= 1 ? '' : ', ' + (Math.round(h.a * 100) / 100)) + ')';
  }

  function formatHwb(color) {
    var rgb = color.toRgb();
    var h = color.toHsl().h;
    var w = Math.min(rgb.r, rgb.g, rgb.b) / 255;
    var b = (255 - Math.max(rgb.r, rgb.g, rgb.b)) / 255;
    return 'hwb(' + h + ' ' + pct(w) + ' ' + pct(b) + alphaText(rgb.a) + ')';
  }

  function formatCmyk(color) {
    var rgb = color.toRgb();
    var k = 1 - Math.max(rgb.r, rgb.g, rgb.b) / 255;
    var d = 1 - k;
    var c = d === 0 ? 0 : (1 - rgb.r / 255 - k) / d;
    var m = d === 0 ? 0 : (1 - rgb.g / 255 - k) / d;
    var y = d === 0 ? 0 : (1 - rgb.b / 255 - k) / d;
    return 'device-cmyk(' + pct(c) + ' ' + pct(m) + ' ' + pct(y) + ' ' + pct(k) +
      alphaText(rgb.a) + ')';
  }

  /** 原生 <input type="color"> 只接受 #rrggbb，所以这里把 alpha 整个切掉。 */
  function formatPicker(color) {
    return removeAlphaChannelWhenOpaque(color.toHex()).slice(0, 7);
  }

  /* ======================================================================
     三、格式表
     ====================================================================== */

  var DEFAULT_COLOR = '#1ea54c';

  /**
   * 格式表。label 是界面上那一行的名字（走 i18n），invalidMessage 单独给 ——
   * 默认那条是用 label 拼出来的，label 一旦翻译就会拼出中英混排的句子。
   */
  var FORMATS = {
    picker: buildColorFormat({
      label: t('format_picker', 'color picker'), type: 'color-picker', format: formatPicker,
      invalidMessage: t('invalid_picker', 'Invalid color picker format.')
    }),
    hex: buildColorFormat({
      label: t('format_hex', 'hex'), format: function (c) { return c.toHex(); },
      placeholder: t('ph_hex', 'e.g. #ff0000'),
      invalidMessage: t('invalid_hex', 'Invalid hex format.')
    }),
    rgb: buildColorFormat({
      label: t('format_rgb', 'rgb'), format: function (c) { return c.toRgbString(); },
      placeholder: t('ph_rgb', 'e.g. rgb(255, 0, 0)'),
      invalidMessage: t('invalid_rgb', 'Invalid rgb format.')
    }),
    hsl: buildColorFormat({
      label: t('format_hsl', 'hsl'), format: function (c) { return c.toHslString(); },
      placeholder: t('ph_hsl', 'e.g. hsl(0, 100%, 50%)'),
      invalidMessage: t('invalid_hsl', 'Invalid hsl format.')
    }),
    hsv: buildColorFormat({
      label: t('format_hsv', 'hsv'), parse: parseHsv, format: formatHsv,
      placeholder: t('ph_hsv', 'e.g. hsv(0, 100%, 100%)'),
      invalidMessage: t('invalid_hsv', 'Invalid hsv format.')
    }),
    hwb: buildColorFormat({
      label: t('format_hwb', 'hwb'), parse: parseHwb, format: formatHwb,
      placeholder: t('ph_hwb', 'e.g. hwb(0 0% 0%)'),
      invalidMessage: t('invalid_hwb', 'Invalid hwb format.')
    }),
    cmyk: buildColorFormat({
      label: t('format_cmyk', 'cmyk'), parse: parseCmyk, format: formatCmyk,
      placeholder: t('ph_cmyk', 'e.g. device-cmyk(0% 100% 100% 0%)'),
      invalidMessage: t('invalid_cmyk', 'Invalid cmyk format.')
    })
  };

  var FORMAT_KEYS = Object.keys(FORMATS);

  /** 把一个颜色实例铺开成 {picker, hex, rgb, …} 的文本表。 */
  function formatAll(value) {
    return updateColorValue(FORMATS, value, undefined);
  }

  /* ======================================================================
     三之二、变换面板（上游 #1017 的 a 部分）
     ====================================================================== */

  /** 变换的初始状态：什么都不做。 */
  var DEFAULT_TRANSFORM = { saturation: 0, brightness: 0, grayscale: false, invert: false };

  /** 取数字；拿不到（非数、undefined）一律当 0。 */
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /**
   * 按变换状态算出显示色。
   *
   * 顺序与上游一致：灰度 → 反相 → 饱和度 → 亮度。
   *
   * 两个坑：
   * 1. colord 的这些方法都**返回新实例**（不修改原对象），所以每一步都得
   *    重新赋值 —— 写成 `source.grayscale()` 是白干。
   * 2. 必须永远从 sourceColor 重算，不能拿上一次的显示色接着算 ——
   *    那样拖一次滑块就叠一层，滑回 0 也回不到原色。
   *
   * 饱和度 / 亮度的单位是 HSL 上的**百分点**：+50 表示饱和度加 50 个点
   * （上限 100），-100 表示减到纯灰；亮度同理，-100 是纯黑、+100 是纯白。
   * 这是 colord 的口径（`saturate(0.5)` 就是 s += 50），上游也是这个口径。
   *
   * @param {Object} source Colord 实例
   * @param {{saturation?: number, brightness?: number, grayscale?: boolean, invert?: boolean}} [transform]
   * @returns {Object} Colord 实例
   */
  function transformColor(source, transform) {
    var tr = transform || DEFAULT_TRANSFORM;
    if (!source || typeof source.grayscale !== 'function') return source;
    var c = source;
    if (tr.grayscale) c = c.grayscale();
    if (tr.invert) c = c.invert();
    var sat = num(tr.saturation) / 100;
    if (sat > 0) c = c.saturate(sat);
    else if (sat < 0) c = c.desaturate(-sat);
    var bright = num(tr.brightness) / 100;
    if (bright > 0) c = c.lighten(bright);
    else if (bright < 0) c = c.darken(-bright);
    return c;
  }

  /** 当前变换是不是「什么都没做」。 */
  function isIdentityTransform(transform) {
    var tr = transform || DEFAULT_TRANSFORM;
    return !tr.grayscale && !tr.invert && num(tr.saturation) === 0 && num(tr.brightness) === 0;
  }

  /* ======================================================================
     四、界面
     ====================================================================== */

  window.ItTools.register('color-converter', function (root) {
    var inputs = {};
    var msgs = {};
    var offs = [];

    /* 变换状态 */
    var transform = { saturation: 0, brightness: 0, grayscale: false, invert: false };
    /** 源色：最后一次从输入框解析出来的原始色。变换永远从它重算。 */
    var sourceColor = window.Colord(DEFAULT_COLOR);
    /** 正在编辑的那一项 —— 编辑期间那一格保留用户敲的原文，不能被回写。 */
    var editingKey = null;

    // 原版这一页只有**一张** c-card（里面是一列格式输入框）。
    // 我们多了一个「Transformations」面板（上游 PR #1017 的东西，原版没有），
    // 但它也得待在同一张卡里 —— 拆成两张卡就凭空多出一圈边框。
    var card = D.h('div');
    FORMAT_KEYS.forEach(function (key) {
      var spec = FORMATS[key];
      var input = spec.type === 'color-picker'
        ? D.h('input.layui-input.color-swatch', { type: 'color' })
        : D.h('input.layui-input', { type: 'text', placeholder: spec.placeholder, spellcheck: 'false', autocomplete: 'off' });
      inputs[key] = input;
      msgs[key] = D.h('p.field-hint');
      input.id = 'cc-' + key;
      // 原版这一页是 c-card 里一列 input-copyable：
      // 标签在左、100px、右对齐（label-position="left" label-width="100px"
      // label-align="right"），复制图标是输入框自己的 suffix。
      // 取色器那一行不是 input-copyable，而是 n-form-item —— 只有标签和色块，
      // 没有输入框、也没有复制按钮。
      var isPicker = spec.type === 'color-picker';
      card.appendChild(D.h('div.field', null,
        D.h('div.field-row', {
          style: { '--field-label-width': '100px', '--field-label-align': 'right' }
        },
          D.h('label.field-label', { for: input.id, text: spec.label + ':' }),
          input,
          isPicker ? null : U.copyButton(function () { return input.value; })
        ),
        msgs[key]
      ));
      offs.push(D.on(input, 'input', function () { onEdit(key, input.value); }));
      // 失焦（或回车）时把编辑过的那一格也刷成显示值 —— 只在变换生效时做，
      // 否则会把用户敲的原文改掉（比如少了 # 的 hex）。
      offs.push(D.on(input, 'change', function () {
        if (editingKey !== key) return;
        editingKey = null;
        if (!isIdentityTransform(transform)) render();
      }));
    });

    function setError(key, text) {
      msgs[key].textContent = text || '';
      msgs[key].style.color = text ? 'var(--danger, #dc2626)' : '';
    }

    /** 把显示色铺到所有输入框（正在编辑的那一格除外）。 */
    function render(omitKey) {
      var updates = formatAll(transformColor(sourceColor, transform));
      FORMAT_KEYS.forEach(function (k) {
        if (k === omitKey) return;
        if (updates[k] === undefined) return;
        inputs[k].value = updates[k];
        setError(k, '');
      });
      if (swatchSource) swatchSource.style.background = formatPicker(sourceColor);
      if (swatchResult) swatchResult.style.background = updates.picker || formatPicker(sourceColor);
    }

    /** 改了一项 → 它成为新的源色，用它去刷新其余所有项。 */
    function onEdit(key, raw) {
      var spec = FORMATS[key];
      if (String(raw) !== '' && !spec.isValid(raw)) {
        setError(key, spec.invalidMessage);
        return;
      }
      setError(key, '');
      if (String(raw) === '') return;
      var parsed = spec.parse(raw);
      if (!parsed || !parsed.isValid()) return;
      sourceColor = parsed;
      editingKey = key;
      render(key);
    }

    function setAll(value) {
      var all = formatAll(value);
      FORMAT_KEYS.forEach(function (k) {
        if (all[k] === undefined) return;
        inputs[k].value = all[k];
        setError(k, '');
      });
    }

    /* ---- 变换面板 ---- */

    var satLabel = D.h('span', { text: t('saturation', 'Saturation ({n})').replace('{n}', '0') });
    var satSlider = D.h('input.slider', { type: 'range', min: -100, max: 100, step: 1, value: 0 });
    var brightLabel = D.h('span', { text: t('brightness', 'Brightness ({n})').replace('{n}', '0') });
    var brightSlider = D.h('input.slider', { type: 'range', min: -100, max: 100, step: 1, value: 0 });

    var grayInput = D.h('input', { type: 'checkbox' });
    var invertInput = D.h('input', { type: 'checkbox' });

    var swatchSource = D.h('div', {
      style: {
        width: '40px', height: '40px', borderRadius: '6px', flex: '0 0 auto',
        border: '1px solid var(--border-sider)', background: '#1ea54c'
      }
    });
    var swatchResult = D.h('div', {
      style: {
        width: '40px', height: '40px', borderRadius: '6px', flex: '0 0 auto',
        border: '1px solid var(--border-sider)', background: '#1ea54c'
      }
    });

    function onTransformChange() {
      editingKey = null;   // 变换一动，所有格子都该显示新的显示色
      render();
    }

    satSlider.addEventListener('input', function () {
      transform.saturation = Number(satSlider.value);
      satLabel.textContent = t('saturation', 'Saturation ({n})').replace('{n}', String(transform.saturation));
      onTransformChange();
    });
    brightSlider.addEventListener('input', function () {
      transform.brightness = Number(brightSlider.value);
      brightLabel.textContent = t('brightness', 'Brightness ({n})').replace('{n}', String(transform.brightness));
      onTransformChange();
    });
    grayInput.addEventListener('change', function () {
      transform.grayscale = grayInput.checked;
      onTransformChange();
    });
    invertInput.addEventListener('change', function () {
      transform.invert = invertInput.checked;
      onTransformChange();
    });

    var transformCard = D.h('div', null,
      D.h('h3', { text: t('transformations', 'Transformations') }),
      D.h('div.field', null, satLabel, satSlider),
      D.h('div.field', null, brightLabel, brightSlider),
      D.h('div.switch-grid', null,
        D.h('label.switch', null, grayInput, D.h('span', { text: t('grayscale', 'Grayscale') })),
        D.h('label.switch', null, invertInput, D.h('span', { text: t('invert', 'Invert') }))
      ),
      D.h('div.field-row', null,
        D.h('span.field-label', { text: t('source_result', 'Source → result') }),
        swatchSource,
        D.h('span', { text: '→' }),
        swatchResult
      ),
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('reset_transforms', 'Reset transforms'),
          onclick: function () {
            transform = { saturation: 0, brightness: 0, grayscale: false, invert: false };
            satSlider.value = '0';
            satLabel.textContent = t('saturation', 'Saturation ({n})').replace('{n}', '0');
            brightSlider.value = '0';
            brightLabel.textContent = t('brightness', 'Brightness ({n})').replace('{n}', '0');
            grayInput.checked = false;
            invertInput.checked = false;
            onTransformChange();
          }
        })
      ),
      D.h('p.field-hint', {
        text: t('transform_hint', 'Transformations always apply to the source color and never stack: dragging a slider back to 0 returns the original color. Editing any input makes that input the new source color.')
      })
    );

    setAll(window.Colord(DEFAULT_COLOR));
    render();
    // 变换面板在前、格式表在后（与上游 #1017 的排版一致）：
    // 先调效果，下面那堆格式跟着变。两者都在同一张卡里。
    root.appendChild(D.h('div.card', null, transformCard, card));

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  /* ======================================================================
     五、纯逻辑出口 + 单测用例
     ====================================================================== */

  window.ItTools.logic['color-converter'] = {
    DEFAULT_COLOR: DEFAULT_COLOR,
    DEFAULT_TRANSFORM: DEFAULT_TRANSFORM,
    FORMATS: FORMATS,
    FORMAT_KEYS: FORMAT_KEYS,
    removeAlphaChannelWhenOpaque: removeAlphaChannelWhenOpaque,
    buildColorFormat: buildColorFormat,
    updateColorValue: updateColorValue,
    formatAll: formatAll,
    formatHsv: formatHsv,
    formatHwb: formatHwb,
    formatCmyk: formatCmyk,
    formatPicker: formatPicker,
    parseHsv: parseHsv,
    parseHwb: parseHwb,
    parseCmyk: parseCmyk,
    hsvFromTokens: hsvFromTokens,
    hwbFromTokens: hwbFromTokens,
    cmykFromTokens: cmykFromTokens,
    hsvToRgb: hsvToRgb,
    hwbToRgb: hwbToRgb,
    cmykToRgb: cmykToRgb,
    transformColor: transformColor,
    isIdentityTransform: isIdentityTransform,

    __cases: function (assert) {
      /* ==================================================================
         removeAlphaChannelWhenOpaque —— 直接照抄参考实现的单测期望值
         （src/tools/color-converter/color-converter.models.test.ts）
         ================================================================== */
      assert.eq(removeAlphaChannelWhenOpaque('#000000ff'), '#000000', '不透明的黑去掉 alpha');
      assert.eq(removeAlphaChannelWhenOpaque('#ffffffFF'), '#ffffff', '大写的 FF 也认，保留原来的大小写');
      assert.eq(removeAlphaChannelWhenOpaque('#000000FE'), '#000000FE', '半透明的保持原样');
      assert.eq(removeAlphaChannelWhenOpaque('#00000000'), '#00000000', '全透明的保持原样');
      // 参考实现单测里没有的补充
      assert.eq(removeAlphaChannelWhenOpaque('#fff'), '#fff', '三位 hex 不受影响');
      assert.eq(removeAlphaChannelWhenOpaque('#ffffffff'), '#ffffff', '8 位 hex 结尾是 ff 时同样被砍成 6 位');
      assert.eq(removeAlphaChannelWhenOpaque('#1ea54c'), '#1ea54c', '没有 alpha 段就不动');

      /* ==================================================================
         buildColorFormat
         ================================================================== */
      var spec = buildColorFormat({ label: 'hex', format: function (c) { return c.toHex(); } });
      assert.eq(spec.label, 'hex', 'label 透传');
      assert.eq(spec.type, 'text', '默认是 text 类型');
      assert.eq(spec.invalidMessage, 'Invalid hex format.', '默认错误信息由 label 拼');
      assert.eq(buildColorFormat({ label: 'color picker' }).invalidMessage, 'Invalid color picker format.', '空格也原样带进错误信息');
      assert.eq(buildColorFormat({ label: 'x', invalidMessage: '自己写的' }).invalidMessage, '自己写的', '自己写的错误信息优先');
      assert.eq(spec.isValid(''), true, '空串算合法');
      assert.eq(spec.isValid('#ff0000'), true, '合法 hex');
      assert.eq(spec.isValid('#zz'), false, '非法 hex');
      assert.eq(spec.isValid('rgb(1,2,3)'), true, '默认 parse 认得 rgb()');
      assert.eq(buildColorFormat({ label: 'x', parse: function () { throw new Error('boom'); } }).parse('a'), undefined, 'parse 抛错被吞成 undefined');
      assert.eq(buildColorFormat({ label: 'x', parse: function () { throw new Error('boom'); } }).isValid('a'), false, 'isValid 遇到抛错判 false');

      /* ==================================================================
         updateColorValue
         ================================================================== */
      var c = window.Colord('#1ea54c');
      var all = formatAll(c);
      assert.eq(Object.keys(all).sort(), ['cmyk', 'hex', 'hsl', 'hsv', 'hwb', 'picker', 'rgb'], '六个格式 + 选择器都出了值');
      assert.eq(Object.keys(updateColorValue(FORMATS, c, 'hex')).indexOf('hex'), -1, 'omitKey 的那项不更新');
      assert.eq(updateColorValue(FORMATS, undefined), {}, 'undefined 什么都不做');
      assert.eq(updateColorValue(FORMATS, null), {}, 'null 什么都不做');
      assert.eq(updateColorValue(FORMATS, window.Colord('#zz')), {}, '非法颜色什么都不做');
      assert.eq(updateColorValue(FORMATS, {}), {}, '不是 colord 实例（没有 isValid）什么都不做');

      /* ==================================================================
         初始色 #1ea54c 的各格式输出
         ================================================================== */
      assert.eq(all.hex, '#1ea54c', 'hex');
      assert.eq(all.rgb, 'rgb(30, 165, 76)', 'rgb');
      assert.eq(all.hsl, 'hsl(140, 69%, 38%)', 'hsl');
      assert.eq(all.hsv, 'hsv(140, 82%, 65%)', 'hsv');
      assert.eq(all.hwb, 'hwb(140 12% 35%)', 'hwb：白=min/255，黑=1-max/255');
      assert.eq(all.cmyk, 'device-cmyk(82% 0% 54% 35%)', 'cmyk');
      assert.eq(all.picker, '#1ea54c', '选择器也是不带 alpha 的 hex');

      /* ==================================================================
         六种格式互相转换（往返）
         ================================================================== */
      var SAMPLES = ['#1ea54c', '#000000', '#ffffff', '#ff0000', '#808000', '#0000ff', '#808080', '#123456'];
      // 这些格式是把 0~255 的通道压成整数百分比显示的，本来就有损，往返差 1~2 是正常的；
      // 只有 hex / rgb / 选择器 是精确的。容差是实测出来的最大通道误差，不是拍脑袋写的。
      var TOLERANCE = { picker: 0, hex: 0, rgb: 0, hsv: 1, hwb: 1, cmyk: 1, hsl: 2 };
      SAMPLES.forEach(function (hex) {
        var out = formatAll(window.Colord(hex));
        assert.eq(out.hex, hex, hex + ' 的 hex 原样');
        Object.keys(FORMATS).forEach(function (key) {
          var text = out[key];
          assert(FORMATS[key].isValid(text), key + '(' + text + ') 自己认得自己');
          var back = FORMATS[key].parse(text);
          assert(back.isValid(), key + '(' + text + ') 反解出来是合法颜色');
          var a = window.Colord(hex).toRgb(), b = back.toRgb();
          var delta = Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
          assert(delta <= TOLERANCE[key],
            hex + ' 经 ' + key + '(' + text + ') 往返误差 ' + delta + ' <= ' + TOLERANCE[key]);
        });
      });

      /* ==================================================================
         alpha
         ================================================================== */
      var half = formatAll(window.Colord('#ff000080'));
      assert.eq(half.hex, '#ff000080', '半透明红保留 8 位 hex');
      assert.eq(half.rgb, 'rgba(255, 0, 0, 0.5)', 'rgb 用 rgba()');
      assert.eq(half.hsl, 'hsla(0, 100%, 50%, 0.5)', 'hsl 用 hsla()');
      assert.eq(half.hsv, 'hsv(0, 100%, 100%, 0.5)', 'hsv 带 alpha 分量');
      assert.eq(half.hwb, 'hwb(0 0% 0% / 0.5)', 'hwb 用 CSS4 的 / 语法');
      assert.eq(half.cmyk, 'device-cmyk(0% 100% 100% 0% / 0.5)', 'cmyk 用 CSS4 的 / 语法');
      assert.eq(half.picker, '#ff0000', '选择器没有 alpha 通道，只能丢掉');
      assert.eq(formatAll(window.Colord('#ff0000')).picker, '#ff0000', '不透明时选择器就是 hex');

      /* ==================================================================
         手写解析器的边界与错误输入
         ================================================================== */
      assert.eq(hsvFromTokens('hsv(140, 82%, 65%)'), { h: 140, s: 82, v: 65, a: 1 }, 'hsv 三段');
      assert.eq(hsvFromTokens('hsva(140, 82%, 65%, 0.5)'), { h: 140, s: 82, v: 65, a: 0.5 }, 'hsva 四段');
      assert.eq(hsvFromTokens('hsv(140, 82%, 65% / 0.5)'), { h: 140, s: 82, v: 65, a: 0.5 }, '逗号与 / 混着写也认');
      assert.eq(hsvFromTokens('nope'), null, '函数名不对返回 null');
      assert.eq(hsvFromTokens('hsv(1, 2)'), null, '分量不够返回 null');
      assert.eq(hsvFromTokens('hsv(1, 2, 3, 4, 5)'), null, '分量太多返回 null');
      assert.eq(hwbFromTokens('hwb(60 0% 50%)'), { h: 60, w: 0, b: 0.5, a: 1 }, 'hwb 三段');
      assert.eq(hwbFromTokens('hwb(60deg 0% 50% / 0.5)'), { h: 60, w: 0, b: 0.5, a: 0.5 }, 'hwb 带 deg 与 alpha');
      assert.eq(cmykFromTokens('device-cmyk(0% 0% 100% 50%)'), { c: 0, m: 0, y: 1, k: 0.5, a: 1 }, 'device-cmyk');
      assert.eq(cmykFromTokens('cmyk(0, 0, 1, 0.5)'), { c: 0, m: 0, y: 1, k: 0.5, a: 1 }, 'cmyk 不带百分号按 0~1');
      assert.eq(cmykFromTokens('cmyk(0%)'), null, '分量不够返回 null');

      assert.eq(FORMATS.hsv.isValid('hsv(garbage)'), false, 'hsv 垃圾输入判非法');
      assert.eq(FORMATS.hwb.isValid('hwb(garbage)'), false, 'hwb 垃圾输入判非法');
      assert.eq(FORMATS.cmyk.isValid('cmyk(garbage)'), false, 'cmyk 垃圾输入判非法');
      assert.eq(FORMATS.hwb.isValid('zzzz'), false, '函数名不对判非法');
      assert.eq(FORMATS.hsv.isValid(''), true, '空串算合法');
      assert.eq(FORMATS.rgb.isValid('rgb(300, -5, 0)'), true, '超范围的分量被 colord 夹住，仍算合法');
      assert.eq(FORMATS.hwb.isValid('hwb(60 0% 50%)'), true, '合法 hwb');

      // 白 + 黑超过 100% 时按 CSS 规范退化成灰
      assert.eq(hwbToRgb(60, 0.8, 0.8), { r: 128, g: 128, b: 128 }, 'w+b >= 1 时退化成灰');
      assert.eq(hwbToRgb(0, 1, 0), { r: 255, g: 255, b: 255 }, '全白');
      assert.eq(hwbToRgb(0, 0, 1), { r: 0, g: 0, b: 0 }, '全黑');
      assert.eq(cmykToRgb(0, 0, 0, 1), { r: 0, g: 0, b: 0 }, 'cmyk k=1 是黑');
      assert.eq(cmykToRgb(0, 0, 0, 0), { r: 255, g: 255, b: 255 }, 'cmyk 全 0 是白');
      assert.eq(cmykToRgb(1, 0, 0, 0), { r: 0, g: 255, b: 255 }, 'cmyk c=1 是青');
      assert.eq(hsvToRgb(0, 100, 100), { r: 255, g: 0, b: 0 }, 'hsv 红');
      assert.eq(hsvToRgb(120, 100, 100), { r: 0, g: 255, b: 0 }, 'hsv 绿');
      assert.eq(hsvToRgb(240, 100, 100), { r: 0, g: 0, b: 255 }, 'hsv 蓝');

      /* ==================================================================
         库的实际能力边界（这些是本轮踩到的坑，写进用例免得以后再踩）
         ================================================================== */
      assert.eq(window.Colord.extend, undefined, 'colord 包里没有 extend（插件没打进来）');
      assert.eq(typeof window.Colord('red').toHwbString, 'undefined', '没有 hwb 插件');
      assert.eq(typeof window.Colord('red').toCmykString, 'undefined', '没有 cmyk 插件');
      assert.eq(typeof window.Colord('red').toName, 'undefined', '没有 names 插件');
      assert.eq(window.Colord('olive').isValid(), false, '没有 names 插件时颜色名解析不了（参考实现的 e2e 用例因此不适用）');
      assert.eq(window.Colord('olive').toHex(), '#000000', '解析失败时 colord 返回黑色但 isValid() 为 false');
      assert.eq(typeof window.Colord('#fff').toHsv, 'function', 'toHsv 属于核心，没被砍');

      /* ==================================================================
         变换面板（上游 #1017 的 a 部分）
         ================================================================== */
      // 核心自带这些方法，不用引插件 —— 上游引插件只是为了调它们
      ['grayscale', 'invert', 'saturate', 'desaturate', 'lighten', 'darken'].forEach(function (m) {
        assert.eq(typeof window.Colord('#fff')[m], 'function', 'colord 核心自带 ' + m + '()');
      });

      var SRC = '#1ea54c';
      assert.eq(transformColor(window.Colord(SRC), {}).toHex(), SRC, '空变换 = 原色');
      assert.eq(transformColor(window.Colord(SRC), DEFAULT_TRANSFORM).toHex(), SRC, '默认变换 = 原色');
      assert.eq(transformColor(window.Colord(SRC)).toHex(), SRC, '不传变换参数也是原色');
      assert.eq(transformColor(window.Colord(SRC), { grayscale: true }).toHex(), '#616161', '灰度');
      assert.eq(transformColor(window.Colord(SRC), { invert: true }).toHex(), '#e15ab3', '反相');
      assert.eq(transformColor(window.Colord(SRC), { saturation: 50 }).toHex(), '#00c342', '饱和度 +50 个点');
      assert.eq(transformColor(window.Colord(SRC), { saturation: -50 }).toHex(), '#4f745c', '饱和度 -50 个点');
      assert.eq(transformColor(window.Colord(SRC), { brightness: 20 }).toHex(), '#4bde7d', '亮度 +20 个点');
      assert.eq(transformColor(window.Colord(SRC), { brightness: -20 }).toHex(), '#0e4f24', '亮度 -20 个点');
      assert.eq(transformColor(window.Colord(SRC), { grayscale: true, invert: true }).toHex(), '#9e9e9e', '灰度 + 反相');

      // 纯函数：同样的输入永远给同样的输出 —— 这正是「不叠加」的根据
      assert.eq(transformColor(window.Colord(SRC), { saturation: 50 }).toHex(),
        transformColor(window.Colord(SRC), { saturation: 50 }).toHex(), '同一变换算两次结果一样');
      // colord 的方法返回新实例，源色不能被就地改掉
      var keep = window.Colord(SRC);
      var changed = transformColor(keep, { grayscale: true });
      assert(keep.toHex() === SRC, '源色没被就地改掉');
      assert(changed !== keep, '返回的是新实例');

      // alpha 要跟着走
      assert.eq(transformColor(window.Colord('#ff000080'), { grayscale: true }).toHex(), '#80808080', '灰度保留 alpha');
      assert.eq(transformColor(window.Colord('#ff000080'), { invert: true }).toHex(), '#00ffff80', '反相保留 alpha');

      // 饱和度拉满/拉到底
      assert.eq(transformColor(window.Colord('#c08040'), { saturation: -100 }).toHex(), '#808080', '饱和度 -100 → 纯灰');
      assert.eq(transformColor(window.Colord('#c08040'), { brightness: -100 }).toHex(), '#000000', '亮度 -100 → 纯黑');
      assert.eq(transformColor(window.Colord('#c08040'), { brightness: 100 }).toHex(), '#ffffff', '亮度 +100 → 纯白');

      // isIdentityTransform
      assert.eq(isIdentityTransform({}), true, '空状态是恒等变换');
      assert.eq(isIdentityTransform(DEFAULT_TRANSFORM), true, '默认状态是恒等变换');
      assert.eq(isIdentityTransform({ saturation: 0, brightness: 0, grayscale: false, invert: false }), true, '全 0 是恒等变换');
      assert.eq(isIdentityTransform({ saturation: 1 }), false, '饱和度不为 0 就不是恒等变换');
      assert.eq(isIdentityTransform({ brightness: -1 }), false, '亮度不为 0 就不是恒等变换');
      assert.eq(isIdentityTransform({ grayscale: true }), false, '开了灰度就不是恒等变换');
      assert.eq(isIdentityTransform({ invert: true }), false, '开了反相就不是恒等变换');
    }
  };
})();