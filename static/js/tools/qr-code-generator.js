/* ==========================================================================
   二维码生成器（qr-code-generator）

   把一段文本（链接、WiFi 配置、纯文字都行）画成二维码，可调尺寸 / 容错级别 /
   前景底色，也能复制原文、下载 PNG。

   参考实现：src/tools/qr-code-generator/（it-tools, GPLv3）
   核心在 useQRCode.ts —— 它 watch 一串 ref，任意一个变了就重跑
   `QRCode.toDataURL(text.trim(), {color:{dark,light}, errorCorrectionLevel, width:1024})`。

   —— 与参考实现的差别 ——
   1. **尺寸变成了可调项**。参考实现把 width 写死成 1024，用户既看不到也改不了；
      而 qrcode 本身支持 width 与 margin，这里把它们放出来，范围钳在 [21, 4096]
      与 [0, 100]。下界 21 不是随便定的：qrcode 的 getOptions 里是
      `width && width >= 21 ? width : undefined`，小于 21 的 width 会被**静默丢弃**、
      悄悄回落到 scale=4，画出来只有几十像素。这里直接夹到 21，让输入框所见即所得。
   2. **颜色在交给 qrcode 之前先校验**。qrcode 自带的解析是
      `parseInt(str, 16)`，`#zzz` 会 parse 成 NaN、再被 `& 255` 抹成纯黑 ——
      用户填错一个字，拿到的是一张全黑的图，而且没有任何提示。这里提前拦下。
   3. **容错级别两边都认**：UI 用 low/medium/quartile/high（与参考实现一致），
      但纯逻辑函数也接受 qrcode 认的单字母 L/M/Q/H，并统一归一成前者。
   4. 参考实现只产出 data URL；这里 canvas 出预览、toDataURL 出可下载的 PNG。
      ——注意 vendor 进来的是 build/qrcode.js（带 Node 兼容层的浏览器构建），
      它画图要真 canvas，而 node 侧的 jsdom 没装 canvas 实现。所以「校验参数 /
      拼 options / 解析颜色」这些纯逻辑都放在本文件里并单测，
      真正的 toCanvas / toDataURL 调用留在 UI 代码里，入口先探一次
      canvasAvailable()，探测不过就整段跳过。

   —— 容错级别 ——
   级别越高，能被「遮住/弄脏」的面积越大，代价是同样内容要用更大的码。
   这里的百分比是 qrcode 规格里的纠错容量：L 7% / M 15% / Q 25% / H 30%。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('qr-code-generator');

  var DEFAULTS = {
    text: 'https://example.com',
    width: 1024,
    margin: 4,
    errorCorrectionLevel: 'medium',
    foreground: '#000000',
    background: '#ffffff'
  };

  var LIMITS = { width: [21, 4096], margin: [0, 100] };

  /**
   * 容错级别。value 用 qrcode 认的长名字（它的 ECLevel.from 同时接受
   * low/medium/quartile/high 与 L/M/Q/H，参考实现用的就是长名字）。
   * label 是下拉框里的显示名，走 i18n；value 是不随语言变的内部标识。
   */
  var ERROR_LEVELS = [
    { value: 'low', label: t('ec_low', 'Low — 7% recovery'), recovery: 7 },
    { value: 'medium', label: t('ec_medium', 'Medium — 15% recovery'), recovery: 15 },
    { value: 'quartile', label: t('ec_quartile', 'Quartile — 25% recovery'), recovery: 25 },
    { value: 'high', label: t('ec_high', 'High — 30% recovery'), recovery: 30 }
  ];

  /** 长名字 / 单字母 → 统一的长名字。 */
  var ERROR_LEVEL_ALIASES = {
    l: 'low', low: 'low',
    m: 'medium', medium: 'medium',
    q: 'quartile', quartile: 'quartile',
    h: 'high', high: 'high'
  };

  /* ---------- 纯逻辑 ---------- */

  /**
   * 容错级别归一。大小写不敏感，两套命名都认；空值回落到 medium（qrcode 的默认值）。
   * 认不出来的直接抛错 —— 与其画出一张「看着正常、其实纠错能力不是你选的那档」
   * 的图，不如当场报错。
   */
  function normalizeErrorCorrectionLevel(v) {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      return DEFAULTS.errorCorrectionLevel;
    }
    if (typeof v !== 'string') {
      throw new Error(t('err_unknown_ec', 'Unknown error correction level: {value}').replace('{value}', JSON.stringify(v)));
    }
    var key = v.trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ERROR_LEVEL_ALIASES, key)) {
      throw new Error(t('err_unknown_ec', 'Unknown error correction level: {value}').replace('{value}', v));
    }
    return ERROR_LEVEL_ALIASES[key];
  }

  /**
   * 十六进制颜色 → {r,g,b,a,hex}。
   * 接受 #rgb / #rgba / #rrggbb / #rrggbbaa（qrcode 自带的那段解析也照收 7 位的
   * 怪长度，口径保持一致），其余一律抛错。
   *
   * 与 qrcode 自带解析的两处收紧：只剥**开头**的那个 `#`（它是 `replace('#','')`
   * 会剥掉任意位置的第一个 #），并且强制每一位都是十六进制数字（它是直接
   * `parseInt(str, 16)`，`#zzz` 会静默 parse 成 NaN 再被 `& 255` 抹成纯黑）。
   */
  function parseHexColor(color) {
    if (typeof color === 'number') color = String(color);
    if (typeof color !== 'string') throw new Error(t('err_color_not_string', 'Color should be defined as hex string'));
    var s = color.charAt(0) === '#' ? color.slice(1) : color;
    if (!/^[0-9a-fA-F]*$/.test(s)) {
      throw new Error(t('err_invalid_hex', 'Invalid hex color: {value}').replace('{value}', color));
    }
    var digits = s.split('');
    if (digits.length < 3 || digits.length === 5 || digits.length > 8) {
      throw new Error(t('err_invalid_hex', 'Invalid hex color: {value}').replace('{value}', color));
    }
    if (digits.length === 3 || digits.length === 4) {
      digits = digits.reduce(function (acc, c) { return acc.concat([c, c]); }, []);
    }
    if (digits.length === 6) digits = digits.concat(['F', 'F']);
    var v = parseInt(digits.join(''), 16);
    return {
      r: (v >>> 24) & 255,
      g: (v >>> 16) & 255,
      b: (v >>> 8) & 255,
      a: v & 255,
      hex: '#' + digits.slice(0, 6).join('').toLowerCase()
    };
  }

  /** 数值钳制：空值、非数字回落到默认值，越界夹到边界（与站内其它工具一致）。 */
  function normInt(v, def, limits) {
    // Number('') 是 0 而不是 NaN，空输入必须单独判掉，否则会被当成「最小值」
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return def;
    var n = Math.round(Number(v));
    if (!isFinite(n)) return def;
    if (limits && n < limits[0]) return limits[0];
    if (limits && n > limits[1]) return limits[1];
    return n;
  }

  /** 内容去首尾空白（qrcode 会把空白也编进去，两端空白纯属噪音）。 */
  function normalizeText(v) {
    return String(v == null ? '' : v).trim();
  }

  /**
   * 表单 → 一份可以直接喂给 QRCode.toCanvas / toDataURL 的参数。纯逻辑，不碰 canvas。
   * 内容为空时抛错（qrcode 自己也抛 "No input text"），颜色非法时抛错。
   * @param {{text?:string,width?:*,margin?:*,errorCorrectionLevel?:string,
   *          foreground?:string,background?:string}} state
   * @returns {{text:string,width:number,margin:number,errorCorrectionLevel:string,
   *            color:{dark:string,light:string}}}
   */
  function buildQrOptions(state) {
    state = state || {};
    var text = normalizeText(state.text);
    if (!text) throw new Error(t('err_empty_content', 'Type or paste something to encode first.'));

    return {
      text: text,
      width: normInt(state.width, DEFAULTS.width, LIMITS.width),
      margin: normInt(state.margin, DEFAULTS.margin, LIMITS.margin),
      errorCorrectionLevel: normalizeErrorCorrectionLevel(state.errorCorrectionLevel),
      color: {
        dark: parseHexColor(state.foreground == null ? DEFAULTS.foreground : state.foreground).hex,
        light: parseHexColor(state.background == null ? DEFAULTS.background : state.background).hex
      }
    };
  }

  /**
   * 本环境有没有可用的 canvas。jsdom（node 侧测试）没装 canvas 实现：
   * HTMLCanvasElement 在，getContext 却只会往控制台喷一句 Not implemented
   * 并返回 null，qrcode 随即在 createImageData 上炸掉。这里拿 ImageData 当判据
   * —— 真实浏览器一定有，没装 canvas 的 jsdom 里没有，且探测本身不产生噪音。
   */
  function canvasAvailable() {
    try {
      return typeof window.ImageData !== 'undefined' &&
        typeof document !== 'undefined' &&
        typeof document.createElement('canvas').getContext === 'function';
    } catch (e) { return false; }
  }

  window.ItTools.register('qr-code-generator', function (root) {
    var state = {
      text: DEFAULTS.text,
      width: DEFAULTS.width,
      margin: DEFAULTS.margin,
      errorCorrectionLevel: DEFAULTS.errorCorrectionLevel,
      foreground: DEFAULTS.foreground,
      background: DEFAULTS.background
    };

    var status = D.h('p.field-hint');
    var canvas = D.h('canvas', { style: { maxWidth: '100%' } });
    var downloadBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('download_png', 'Download PNG') });

    // textarea 的初值要走 .value（HTML 里 textarea 没有 value 属性，
    // D.h 那样设只会落到一个普通属性上，输入框看起来是空的）
    var textInput = D.h('textarea.layui-textarea', {
      rows: 3, spellcheck: 'false', placeholder: t('input_ph', 'Your link or text...')
    });
    textInput.value = state.text;
    textInput.addEventListener('input', function () { state.text = textInput.value; update(); });

    function numField(labelText, key, hint) {
      var input = D.h('input.layui-input', {
        type: 'number', min: String(LIMITS[key][0]), max: String(LIMITS[key][1]),
        step: '1', value: String(state[key])
      });
      input.addEventListener('input', function () {
        // 输入框被清空时 value 是 ''，Number('') 是 0，这里记成 NaN 交给 normInt 回落
        state[key] = input.value === '' ? NaN : Number(input.value);
        update();
      });
      return U.field(labelText, input, { hint: hint, left: true, labelWidth: '130px' });
    }

    var ecSelect = D.h('select.layui-input', null, ERROR_LEVELS.map(function (lvl) {
      return D.h('option', { value: lvl.value, text: lvl.label, selected: lvl.value === state.errorCorrectionLevel });
    }));
    ecSelect.addEventListener('change', function () {
      state.errorCorrectionLevel = ecSelect.value;
      update();
    });

    function colorField(labelText, key) {
      var input = D.h('input', { type: 'color', value: state[key] });
      input.addEventListener('input', function () { state[key] = input.value; update(); });
      // 原版这一页的四个表单项全是左标签、130px、右对齐
      // （c-input-text / n-form-item / c-select 都写死了 label-width="130px"）。
      return U.field(labelText, input, { left: true, labelWidth: '130px' });
    }

    function setStatus(text, isError) {
      status.textContent = text;
      status.style.color = isError ? 'var(--danger, #d93025)' : 'var(--text-muted)';
    }

    function update() {
      var opts;
      try { opts = buildQrOptions(state); }
      catch (e) {
        setStatus(e.message, true);
        downloadBtn.disabled = true;
        return;
      }
      setStatus('');
      downloadBtn.disabled = false;
      if (!canvasAvailable()) return;

      // qrcode 的绘制在 Promise executor 里是同步跑的，但接口本身返回 Promise，
      // 必须挂上拒绝处理 —— 否则 node 侧会以 unhandledRejection 直接退出进程。
      // 内容超出二维码容量时它抛 "The amount of data is too big…"，正好显示出来。
      window.QRCode.toCanvas(canvas, opts.text, opts).catch(function (err) {
        setStatus(String((err && err.message) || err), true);
      });
    }

    downloadBtn.addEventListener('click', function () {
      var opts;
      try { opts = buildQrOptions(state); } catch (e) { setStatus(e.message, true); return; }
      window.QRCode.toDataURL(opts.text, opts).then(function (dataUrl) {
        // data URL 只是文本，必须先解回字节再交给 download，否则下到的是
        // 一个「内容是 base64 字符串」的假 PNG
        var bytes = U.base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
        window.ItTools.download('qr-code.png', new Blob([bytes], { type: 'image/png' }), 'image/png');
      }).catch(function (err) {
        setStatus(String((err && err.message) || err), true);
      });
    });

    root.appendChild(D.h('div.card', null,
      // 原版这页的输入框是 label-position="left"、130px、右对齐
      U.field(t('content', 'Content:'), textInput, { wide: true, left: true, labelWidth: '130px' }),
      D.h('div.field-row', null,
        numField(t('size', 'Size (px):'), 'width', t('size_hint', '21–4096')),
        numField(t('margin', 'Margin (modules):'), 'margin', t('margin_hint', '0–100, 0 means no quiet zone'))
      ),
      D.h('div.field-row', null,
        U.field(t('error_resistance', 'Error resistance:'), ecSelect, { left: true, labelWidth: '130px' }),
        colorField(t('foreground', 'Foreground:'), 'foreground')
      ),
      D.h('div.field-row', null, colorField(t('background', 'Background:'), 'background')),
      status
    ));

    root.appendChild(D.h('div.card', null,
      U.field(t('qr_code', 'QR code:'), D.h('div.preview-box', null, canvas), { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return normalizeText(state.text); }, t('copy_content', 'Copy content')),
        downloadBtn
      )
    ));

    update();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['qr-code-generator'] = {
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    ERROR_LEVELS: ERROR_LEVELS,
    normalizeErrorCorrectionLevel: normalizeErrorCorrectionLevel,
    parseHexColor: parseHexColor,
    normInt: normInt,
    normalizeText: normalizeText,
    buildQrOptions: buildQrOptions,
    canvasAvailable: canvasAvailable,
    __cases: function (assert) {
      /* ---- 容错级别 ---- */
      assert.eq(normalizeErrorCorrectionLevel('low'), 'low', '长名字原样');
      assert.eq(normalizeErrorCorrectionLevel('medium'), 'medium', 'medium');
      assert.eq(normalizeErrorCorrectionLevel('quartile'), 'quartile', 'quartile');
      assert.eq(normalizeErrorCorrectionLevel('high'), 'high', 'high');
      assert.eq(normalizeErrorCorrectionLevel('L'), 'low', '单字母 L → low');
      assert.eq(normalizeErrorCorrectionLevel('q'), 'quartile', '单字母 q → quartile');
      assert.eq(normalizeErrorCorrectionLevel('HIGH'), 'high', '大小写不敏感');
      assert.eq(normalizeErrorCorrectionLevel('  High  '), 'high', '去空白');
      assert.eq(normalizeErrorCorrectionLevel(''), 'medium', '空值回落到 medium（qrcode 的默认）');
      assert.eq(normalizeErrorCorrectionLevel(null), 'medium', 'null 回落');
      assert.eq(normalizeErrorCorrectionLevel(undefined), 'medium', 'undefined 回落');
      ['xyz', 'M4', 'lowest', 'constructor', '__proto__'].forEach(function (bad, i) {
        var threw = false;
        try { normalizeErrorCorrectionLevel(bad); } catch (e) { threw = true; }
        assert(threw, '未知容错级别 ' + JSON.stringify(bad) + ' 应抛错（样本' + i + '）');
      });
      [42, {}, []].forEach(function (bad) {
        var threw = false;
        try { normalizeErrorCorrectionLevel(bad); } catch (e) { threw = true; }
        assert(threw, '非字符串的容错级别应抛错：' + JSON.stringify(bad));
      });
      // 恰好这四个长名字与 qrcode 的 ECLevel.from 一致，少一个多一个都会画错档
      assert.eq(ERROR_LEVELS.map(function (l) { return l.value; }),
        ['low', 'medium', 'quartile', 'high'], '四档与 qrcode 的长名字一致');

      /* ---- 颜色 ---- */
      assert.eq(parseHexColor('#000000ff'), { r: 0, g: 0, b: 0, a: 255, hex: '#000000' }, '8 位带透明度');
      assert.eq(parseHexColor('#fff'), { r: 255, g: 255, b: 255, a: 255, hex: '#ffffff' }, '3 位 shorthand');
      assert.eq(parseHexColor('#1234'), { r: 17, g: 34, b: 51, a: 68, hex: '#112233' }, '4 位 shorthand 带 alpha');
      assert.eq(parseHexColor('#ffffff00'), { r: 255, g: 255, b: 255, a: 0, hex: '#ffffff' }, '全透明');
      assert.eq(parseHexColor('#AABBCC'), { r: 170, g: 187, b: 204, a: 255, hex: '#aabbcc' }, 'hex 统一小写');
      assert.eq(parseHexColor('00ff00'), { r: 0, g: 255, b: 0, a: 255, hex: '#00ff00' }, '省略 # 也认');
      // qrcode 自带的解析会把 #zzz 静默 parse 成 NaN 再抹成纯黑，这里必须拦住
      ['red', '#ff', '#fffff', '#zzz', '#fffffffff', '#12 34', '', null, 42].forEach(function (bad, i) {
        var threw = false;
        try { parseHexColor(bad); } catch (e) { threw = true; }
        assert(threw, '非法颜色 ' + JSON.stringify(bad) + ' 应抛错（样本' + i + '）');
      });

      /* ---- 数值钳制 ---- */
      assert.eq(normInt('', 7, LIMITS.width), 7, '空串回落默认值（Number 对空串给的是 0 而不是 NaN）');
      assert.eq(normInt(null, 7, LIMITS.width), 7, 'null 回落');
      assert.eq(normInt('abc', 7, LIMITS.width), 7, '非数字回落');
      assert.eq(normInt('300', 7, LIMITS.width), 300, '合法值原样');
      assert.eq(normInt(12.6, 7, [1, 100]), 13, '小数四舍五入');
      assert.eq(normInt(10, 1024, LIMITS.width), 21, '小于 21 夹到 21（qrcode 会静默丢弃 <21 的 width）');
      assert.eq(normInt(0, 1024, LIMITS.width), 21, '0 也是 21');
      assert.eq(normInt(99999, 1024, LIMITS.width), 4096, '超上限夹到 4096');
      assert.eq(normInt(-5, 4, LIMITS.margin), 0, 'margin 负数夹到 0');
      assert.eq(normInt(1000, 4, LIMITS.margin), 100, 'margin 超上限夹到 100');

      /* ---- 文本 ---- */
      assert.eq(normalizeText('  hi  '), 'hi', '去首尾空白');
      assert.eq(normalizeText('  \n '), '', '纯空白归零');
      assert.eq(normalizeText(null), '', 'null 是空串');
      assert.eq(normalizeText('a\nb'), 'a\nb', '中间的换行保留（换行在 QR 里是合法内容）');

      /* ---- buildQrOptions ----
         DEFAULTS 只是 UI 的初始状态，不会被套到空内容上 —— 用户把输入框清空
         必须得到「没有内容」而不是凭空冒出一条默认文本。 */
      var o = buildQrOptions({ text: 'https://example.com' });
      assert.eq(o, {
        text: 'https://example.com',
        width: 1024, margin: 4, errorCorrectionLevel: 'medium',
        color: { dark: '#000000', light: '#ffffff' }
      }, '只给内容时其余走默认值，且与参考实现的默认值一致');

      o = buildQrOptions({
        text: '  https://a.b/c?d=1  ', width: 256, margin: 0,
        errorCorrectionLevel: 'H', foreground: '#003366ff', background: 'fff'
      });
      assert.eq(o, {
        text: 'https://a.b/c?d=1', width: 256, margin: 0, errorCorrectionLevel: 'high',
        color: { dark: '#003366', light: '#ffffff' }
      }, '单字母级别与带透明度的颜色都会被归一');

      assert.eq(buildQrOptions({ text: 'x', width: 1 }).width, 21, '过小的尺寸被夹住');
      assert.eq(buildQrOptions({ text: 'x', margin: '' }).margin, 4, 'margin 清空回落到 4');
      assert.eq(buildQrOptions({ text: 'x', width: NaN }).width, 1024, 'width 变成 NaN 回落到默认');

      /* ---- 非法输入必须抛错，不能静默出一张废图 ---- */
      ['', '   ', null, undefined].forEach(function (bad, i) {
        var threw = false;
        try { buildQrOptions({ text: bad }); } catch (e) { threw = true; }
        assert(threw, '空内容应抛错（样本' + i + '：' + JSON.stringify(bad) + '）');
      });
      // 整个 state 都没传 / 是空对象，等价于「没有内容」，同样要抛错而不是编一个空码
      [undefined, {}, null].forEach(function (bad, i) {
        var threw = false;
        try { buildQrOptions(bad); } catch (e) { threw = true; }
        assert(threw, '整个 state 为空应抛错（样本' + i + '）');
      });
      var threw = false;
      try { buildQrOptions({ text: 'x', foreground: 'nope' }); } catch (e) { threw = true; }
      assert(threw, '非法前景色抛错');
      threw = false;
      try { buildQrOptions({ text: 'x', background: '#12345' }); } catch (e) { threw = true; }
      assert(threw, '5 位颜色抛错');
      threw = false;
      try { buildQrOptions({ text: 'x', errorCorrectionLevel: 'ultra' }); } catch (e) { threw = true; }
      assert(threw, '未知容错级别抛错');

      /* ---- canvas 能力探测 ---- */
      assert.eq(typeof canvasAvailable(), 'boolean', 'canvasAvailable 永远给布尔值');
    }
  };
})();