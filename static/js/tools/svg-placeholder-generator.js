/* ==========================================================================
   SVG 占位图生成器（svg-placeholder-generator）

   按尺寸 / 配色 / 文案拼出一张 SVG 占位图，实时预览，可复制源码或 data URL，
   也能直接下载 .svg。

   参考实现：src/tools/svg-placeholder-generator/（it-tools, GPLv3）
   与原版的差别（原版这几处会真的坏掉）：
   1. 原版把自定义文案原样塞进 <text>，用户输入 `<` / `&` / `"` 就会生成非法
      SVG（更糟的是可以注入标签）。这里统一做 XML 转义。
   2. 原版的数字输入框可以被清空，此时 width/height 变成 null，产出的
      viewBox 是 "0 0 null null"。这里对三个数字都做范围钳制。
   3. 原版只校验不了颜色；这里非法颜色回落到默认值，避免整张图透明。
   4. 原版输出里 <text> 行尾有游离空格与制表符，这里输出干净的 SVG。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('svg-placeholder-generator');

  var DEFAULTS = {
    width: 600,
    height: 350,
    fontSize: 26,
    bg: '#cccccc',
    fg: '#333333'
  };

  var LIMITS = {
    width: [1, 10000],
    height: [1, 10000],
    fontSize: [1, 1000]
  };

  var HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  var NAMED = /^[a-z]{3,20}$/i;   // 只放行纯字母的关键帧名，挡住 url() 之类

  /** 数值钳制：空值、非数字、越界一律回落到默认值。 */
  function normNum(v, def, limits) {
    // Number('') 是 0 而不是 NaN，空输入必须单独判掉，否则会被当成「最小值」
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return def;
    var n = Math.round(Number(v));
    if (!isFinite(n)) return def;
    if (limits && n < limits[0]) return limits[0];
    if (limits && n > limits[1]) return limits[1];
    return n;
  }

  /** 颜色规范化：#rgb / #rrggbb / 颜色名放行，其余回落。 */
  function normColor(v, def) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return def;
    if (s.length > 1 && s[0] === '#') return HEX.test(s) ? s.toLowerCase() : def;
    return NAMED.test(s) ? s : def;
  }

  /** XML 文本转义 —— 占位图里的自定义文案必须过这一关。 */
  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }

  /**
   * 生成 SVG 源码。纯函数，可单测。
   * @param {{width?:number|string,height?:number|string,fontSize?:number|string,
   *          bg?:string,fg?:string,text?:string,exact?:boolean}} opts
   */
  function buildSvg(opts) {
    opts = opts || {};
    var w = normNum(opts.width, DEFAULTS.width, LIMITS.width);
    var h = normNum(opts.height, DEFAULTS.height, LIMITS.height);
    var size = normNum(opts.fontSize, DEFAULTS.fontSize, LIMITS.fontSize);
    var bg = normColor(opts.bg, DEFAULTS.bg);
    var fg = normColor(opts.fg, DEFAULTS.fg);
    var custom = String(opts.text == null ? '' : opts.text);
    var label = escapeXml(custom.length ? custom : w + 'x' + h);
    // 勾了「使用精确尺寸」才写死 width/height，否则交给 CSS 自适应
    var attrs = opts.exact ? ' width="' + w + '" height="' + h + '"' : '';

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '"' + attrs + '>\n' +
      '  <rect width="' + w + '" height="' + h + '" fill="' + bg + '"></rect>\n' +
      '  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" ' +
      'font-family="monospace" font-size="' + size + 'px" fill="' + fg + '">' + label + '</text>\n' +
      '</svg>';
  }

  /** SVG 源码 → data URL。走 UTF-8 编码，非 ASCII 文案才不会编出乱码。 */
  function toDataUrl(svg) {
    return 'data:image/svg+xml;base64,' + U.bytesToBase64(U.utf8Bytes(svg));
  }

  window.ItTools.register('svg-placeholder-generator', function (root) {
    var state = {
      width: DEFAULTS.width,
      height: DEFAULTS.height,
      fontSize: DEFAULTS.fontSize,
      bg: DEFAULTS.bg,
      fg: DEFAULTS.fg,
      text: '',
      exact: true
    };

    // 原版这一页没有卡片壳：整块表单直接铺在正文里，
    // 两个结果是「标签 + 代码卡」（TextareaCopyable，copy-placement="none"
    // 所以卡里没有复制按钮），复制按钮在页面底部那一行里。
    var svgOut = U.codeBlock({ noCopy: true });
    var b64Out = U.codeBlock({ noCopy: true });
    var preview = D.h('img', { alt: t('preview_alt', 'Generated placeholder'), style: { maxWidth: '100%' } });

    // 原版的 n-form 是 label-placement="left" label-width="100"：
    // 所有字段的标签都在左边、占 100px 列宽，naive-ui 左摆放时标签**右对齐**
    // （实测原版 n-form-item-label 的 text-align 就是 right）。
    // 标签列与控件之间没有间隙 —— 控件紧跟在 100px 的标签列后面；
    // 标签在控件高度里垂直居中，跟原版 n-form-item 一样。
    function leftField(labelText, control, opts) {
      opts = opts || {};
      var field = U.field(labelText, control, {
        left: true,
        labelWidth: '100px',
        labelAlign: 'right'
      });
      field.style.gap = '0';
      field.style.alignItems = 'center';
      // 两列并排时各占一半（原版是 flex gap-3 的两栏，各 294px）
      field.style.flex = '1 1 0';
      // 原版 n-form-item / c-input-text 的标签右边都留 12px
      var label = field.querySelector('.field-label');
      if (label) {
        label.style.paddingRight = '12px';
        // 两种机制的标签行高不一样（实测原版）：
        // n-form-item-label 是 1.25（14px → 17.5px），
        // c-input-text 的 label 跟正文一样是 1.6（14px → 22.4px）。
        label.style.lineHeight = opts.lineHeight || '1.25';
      }
      return field;
    }

    function numField(labelText, key, limits) {
      var input = D.h('input.layui-input', {
        type: 'number', min: String(limits[0]), max: String(limits[1]),
        step: '1', value: String(state[key])
      });
      input.addEventListener('input', function () {
        // 输入框被清空时先记 0，规范化那一步会按范围夹回去
        state[key] = input.value === '' ? NaN : Number(input.value);
        update();
      });
      return leftField(labelText, input);
    }

    function colorField(labelText, key) {
      var input = D.h('input', { type: 'color', value: state[key] });
      input.addEventListener('input', function () {
        state[key] = input.value;
        update();
      });
      return leftField(labelText, input);
    }

    var textInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('text_ph', 'Default is {w}x{h}')
        .replace('{w}', String(state.width)).replace('{h}', String(state.height))
    });
    textInput.addEventListener('input', function () {
      state.text = textInput.value;
      update();
    });

    var exactInput = D.h('input', { type: 'checkbox', checked: state.exact });
    exactInput.addEventListener('change', function () {
      state.exact = exactInput.checked;
      update();
    });

    function update() {
      var svg = buildSvg(state);
      svgOut.value = svg;
      var url = toDataUrl(svg);
      b64Out.value = url;
      preview.setAttribute('src', url);
      textInput.setAttribute('placeholder', t('text_ph', 'Default is {w}x{h}')
        .replace('{w}', String(state.width)).replace('{h}', String(state.height)));
    }

    function row(a, b) {
      return D.h('div.field-row', null, D.h('div', {
        style: { display: 'flex', gap: '12px', flex: '1 1 0', minWidth: '0' }
      }, a, b));
    }

    root.appendChild(D.h('div', null,
      row(
        numField(t('width', 'Width (in px):'), 'width', LIMITS.width),
        colorField(t('background', 'Background:'), 'bg')
      ),
      row(
        numField(t('height', 'Height (in px):'), 'height', LIMITS.height),
        colorField(t('text_color', 'Text color:'), 'fg')
      ),
      row(
        numField(t('font_size', 'Font size:'), 'fontSize', LIMITS.fontSize),
        // 原版这个字段是 c-input-text + label-position="left" + label-width="100px"
        // + label-align="right"，跟 n-form-item 那些字段一样是左标签、100px、右对齐；
        // 只是行高跟正文一样（1.6），不是 n-form-item 的 1.25
        leftField(t('custom_text', 'Custom text:'), textInput, { lineHeight: '1.6' })
      ),
      // 原版是 <n-form-item label="Use exact size" label-placement="left">：
      // 没写 label-width，宽度跟外层 n-form 的 label-width="100" 一样（实测 100px）
      leftField(t('exact_size', 'Use exact size'), D.h('label.switch', null, exactInput, D.h('span', {}))),

      // 原版这两个是 n-form-item（在 label-placement="left" 的 n-form 之外），
      // 所以走 naive-ui 的默认：**上标签**（14px/400、左对齐、在代码卡上面）。
      D.h('label.field-label', { text: t('svg_element', 'SVG HTML element:') }),
      svgOut.card,
      D.h('label.field-label', { text: t('svg_base64', 'SVG in Base64:') }),
      b64Out.card,

      D.h('div.form-actions', null,
        U.copyButton(function () { return svgOut.value; }, t('copy_svg', 'Copy svg')),
        U.copyButton(function () { return b64Out.value; }, t('copy_base64', 'Copy base64')),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download_svg', 'Download svg'), onclick: function () {
            window.ItTools.download('placeholder.svg', svgOut.value, 'image/svg+xml;charset=utf-8');
          }
        })
      )
    ));

    // 原版的预览图在整块内容的最后（模板里它是第二个根节点）
    root.appendChild(preview);

    update();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['svg-placeholder-generator'] = {
    buildSvg: buildSvg,
    toDataUrl: toDataUrl,
    escapeXml: escapeXml,
    normColor: normColor,
    normNum: normNum,
    __cases: function (assert) {
      var svg = buildSvg({ width: 600, height: 350, fontSize: 26, bg: '#cccccc', fg: '#333333', text: '', exact: true });
      assert(svg.indexOf('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 350" width="600" height="350">') === 0, '根标签带 viewBox 与精确尺寸');
      assert(svg.indexOf('<rect width="600" height="350" fill="#cccccc"></rect>') >= 0, '背景矩形');
      assert(svg.indexOf('font-size="26px" fill="#333333">600x350</text>') >= 0, '默认文案是宽x高');
      assert(svg.indexOf('\t') === -1 && !/[ \t]+\n/.test(svg) && /<\/svg>$/.test(svg), '行尾不应有游离空格或制表符，且以 </svg> 收尾');

      // 关掉「精确尺寸」就不写 width/height，只留 viewBox
      var fluid = buildSvg({ width: 800, height: 600, exact: false });
      assert(fluid.indexOf('viewBox="0 0 800 600">') >= 0, 'viewBox 始终存在');
      assert(fluid.split('\n')[0].indexOf('width=') === -1, '精确尺寸关闭时根标签不写死宽高');

      // 自定义文案必须转义，否则 < 和 & 会毁掉 SVG
      var escaped = buildSvg({ text: '<script>&"\'</script>' });
      assert(escaped.indexOf('&lt;script&gt;&amp;&quot;&apos;&lt;/script&gt;') >= 0, '自定义文案做 XML 转义');
      assert(escaped.indexOf('<script>') === -1, '转义后不得残留裸标签');
      assert.eq(escapeXml('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&apos;f', '转义五个实体');

      // 数字输入被清空 / 越界时的兜底
      assert(buildSvg({ width: '' }).indexOf('viewBox="0 0 600 350"') >= 0, '空宽度回落默认值');
      assert(buildSvg({ height: null }).indexOf('viewBox="0 0 600 350"') >= 0, 'null 高度回落默认值');
      assert(buildSvg({ width: 'abc' }).indexOf('viewBox="0 0 600 350"') >= 0, '非数字回落默认值');
      assert(buildSvg({ width: 0 }).indexOf('viewBox="0 0 1 350"') >= 0, '宽度下限夹到 1');
      assert(buildSvg({ height: 999999 }).indexOf('viewBox="0 0 600 10000"') >= 0, '高度上限夹到 10000');
      assert.eq(normNum('12.6', 5, LIMITS.width), 13, '小数四舍五入');

      // 颜色
      assert.eq(normColor('#ABC', '#000'), '#abc', '三位十六进制小写化');
      assert.eq(normColor('#a1b2c3', '#000'), '#a1b2c3', '六位十六进制');
      assert.eq(normColor('red', '#000'), 'red', '颜色名放行');
      assert.eq(normColor('url(javascript:alert(1))', '#000'), '#000', '非法颜色回落');
      assert.eq(normColor('', '#000'), '#000', '空颜色回落');
      assert.eq(normColor('#xyz', '#000'), '#000', '非法十六进制回落');
      assert(buildSvg({ bg: 'not-a-color' }).indexOf('fill="#cccccc"') >= 0, '背景色非法时用默认值');

      // data URL
      var url = toDataUrl('<svg></svg>');
      assert(url.indexOf('data:image/svg+xml;base64,') === 0, 'data URL 前缀');
      assert.eq(atob(url.split(',')[1]), '<svg></svg>', 'base64 可解码回原文');
      assert.eq(toDataUrl(buildSvg({ text: '中文' })).length > 0, true, '非 ASCII 文案也能编出 data URL');
    }
  };
})();