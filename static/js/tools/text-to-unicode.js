/* ==========================================================================
   文本与 Unicode 字符引用互转（text-to-unicode）

   文本 → 数字字符引用（&#65; / &#x41; / A），反向再解回原文本。

   参考实现：src/tools/text-to-unicode/（it-tools, GPLv3）
   与原版的差别：
   1. 原版用 split('') 按 UTF-16 码元切分，emoji 会被劈成两个代理码元，
      分别写成 &#55357;&#56832;——HTML 解析器遇到代理区码点会直接判为非法，
      渲染出来是乱码。这里按码点切，一个 emoji 只写一个引用。
   2. 原版解码用 String.fromCharCode(dec)，码点超过 0xFFFF 会绕回
      （&#128512; 会变成 NUL）；这里改用 String.fromCodePoint，并对越界 /
      代理区的码点原样保留匹配文本，不打断输入。
   3. 原版只认十进制引用。这里额外支持十六进制 &#x41; 与 JS 转义 \\u0041;
      （界面可切换输出格式，解码三种都认）。

   十进制默认输出与原版逐字节一致：'it-tools' → '&#105;&#116;&#45;…'。
   - 补了上游 #1087 的两样东西：
     1. **UTF-16 码元模式**（`utf16`）：按 UTF-16 码元转义，一个 emoji 写成
        两个代理转义（\\ud83d\\ude00）而不是一个花括号转义（\\u{1f600}）。
        有些系统（老式 JS 字符串、某些 C 库）只认 \\uXXXX。
        反向解码时把代理对合成一个码点，emoji 才不会解成两个孤立代理。
     2. **跳过 ASCII** 开关：只转义非 ASCII 的字符，ASCII 原样保留 ——
        排错时一眼能看出改了哪几个字。
     另外补了上游的 `fullUnicode` 档（\\u0041，不带分号）。
     上游的 `fullUnicode` 与本工具原来的 `escape` 只差一个尾分号：
     本工具的 `escape` 保留分号（`\\u0041;`，更常见），两者解码时都认。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('text-to-unicode');

  /**
   * 「跳过 ASCII」时用来切段的正则，各带**一个**捕获组。
   * `String.split` 带捕获组时，偶数下标是「没被切到的部分」、奇数下标是「切到的部分」，
   * 于是「奇数下标原样保留、偶数下标转义」就实现了跳过。
   */
  var SKIP_NOTHING_RE = /(\b\B)/;          // 永不匹配，但有捕获组 —— 让下标奇偶规则统一
  var SKIP_ASCII_JS = /([ -!#-&(-\[\]-~]+)/g;   // 不含 " ' \
  var SKIP_ASCII_HTML = /([ -!#-%(-;=?-~]+)/g;  // 不含 " & < =

  /** 转义一个码点为 \\uXXXX（超 BMP 用花括号形式，JS 里才合法）。 */
  function toUnicodeEscape(cp, semicolon) {
    if (cp > 0xffff) return '\\u{' + cp.toString(16) + '}';
    return '\\u' + cp.toString(16).padStart(4, '0') + (semicolon ? ';' : '');
  }

  var FORMATS = [
    {
      key: 'decimal',
      label: t('format_decimal', 'Decimal — &#65;'),
      skipper: SKIP_ASCII_HTML,
      render: function (cp) { return '&#' + cp + ';'; }
    },
    {
      key: 'hex',
      label: t('format_hexadecimal', 'Hexadecimal — &#x41;'),
      skipper: SKIP_ASCII_HTML,
      render: function (cp) { return '&#x' + cp.toString(16) + ';'; }
    },
    {
      key: 'escape',
      label: t('format_javascript_escape', 'JavaScript escape — \\u0041;'),
      skipper: SKIP_ASCII_JS,
      render: function (cp) { return toUnicodeEscape(cp, true); }
    },
    {
      key: 'full-unicode',
      label: t('format_full_unicode', 'Full Unicode — \\u0041'),
      skipper: SKIP_ASCII_JS,
      render: function (cp) { return toUnicodeEscape(cp, false); }
    },
    {
      // UTF-16 码元：超 BMP 的字符被拆成两个代理码元分别转义
      key: 'utf16',
      label: t('format_utf16_code_units', 'UTF-16 code units — \\ud83d\\ude00'),
      skipper: SKIP_ASCII_JS,
      byCodeUnit: true,
      render: function (cp) { return toUnicodeEscape(cp, false); }
    }
  ];

  /** 按格式取转换器，格式不认识就退回十进制。 */
  function converterOf(format) {
    var found = FORMATS.filter(function (f) { return f.key === format; })[0];
    return found || FORMATS[0];
  }

  /**
   * 文本 → 字符引用。空串返回空串（与原版一致）。
   * @param {string} text
   * @param {string} [format] decimal | hex | escape | full-unicode | utf16
   * @param {boolean} [skipAscii] 只转义非 ASCII 的字符
   */
  function textToUnicode(text, format, skipAscii) {
    if (!text) return '';
    var conv = converterOf(format);
    var parts = String(text).split(skipAscii ? conv.skipper : SKIP_NOTHING_RE);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      // 奇数下标是被切出来的 ASCII 段，原样保留
      if (i % 2) {
        out.push(parts[i]);
        continue;
      }
      var chars = conv.byCodeUnit ? parts[i].split('') : Array.from(parts[i]);
      for (var j = 0; j < chars.length; j++) {
        out.push(conv.render(chars[j].codePointAt(0)));
      }
    }
    return out.join('');
  }

  /**
   * 码点 → 字符。越界（> U+10FFFF）或落在代理区（U+D800~U+DFFF）时
   * 返回 fallback（也就是原样的匹配文本），不抛异常，免得边打字边报错。
   */
  function fromCodePoint(codePoint, fallback) {
    if (!isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return fallback;
    return String.fromCodePoint(codePoint);
  }

  /**
   * 解 JS 转义。`\u{XXXXXX}`（花括号形式）与 `\uXXXX`（定长形式）都认，
   * 定长形式后面可以跟一个分号。
   *
   * 关键在代理对：UTF-16 里一个超 BMP 的字符写成**两个**转义
   * （`😀` 才是那个 emoji）。逐个解会得到两个孤立代理码元，
   * 结果是乱码，所以这里按 UTF-16 的规矩把高代理 + 低代理合成一个码点。
   * 落单的代理（只有高代理或只有低代理）原样保留，不打断输入。
   */
  var RE_BRACED_ESCAPE = /\\u\{([0-9a-f]{1,6})\}/gi;
  var RE_FIXED_ESCAPE = /\\u([0-9a-f]{4,6})(;?)/gi;

  function decodeUnicodeEscapes(src) {
    var out = '';
    var i = 0;
    while (i < src.length) {
      // 只有 \u 开头才可能是转义
      if (src.charAt(i) !== '\\' || src.charAt(i + 1) !== 'u') {
        out += src.charAt(i);
        i += 1;
        continue;
      }
      // 花括号形式：\u{1f600}
      RE_BRACED_ESCAPE.lastIndex = i;
      var braced = RE_BRACED_ESCAPE.exec(src);
      if (braced && braced.index === i) {
        out += fromCodePoint(parseInt(braced[1], 16), braced[0]);
        i += braced[0].length;
        continue;
      }
      // 定长形式：\uD83D
      RE_FIXED_ESCAPE.lastIndex = i;
      var fixed = RE_FIXED_ESCAPE.exec(src);
      if (!fixed || fixed.index !== i) {
        out += src.charAt(i);
        i += 1;
        continue;
      }
      var cp = parseInt(fixed[1], 16);
      var consumed = fixed[0].length;
      // 高代理：看看后面紧跟着的是不是低代理，是的话合成一个码点
      if (cp >= 0xd800 && cp <= 0xdbff) {
        RE_FIXED_ESCAPE.lastIndex = i + consumed;
        var low = RE_FIXED_ESCAPE.exec(src);
        if (low && low.index === i + consumed) {
          var lowCp = parseInt(low[1], 16);
          if (lowCp >= 0xdc00 && lowCp <= 0xdfff) {
            var combined = 0x10000 + ((cp - 0xd800) << 10) + (lowCp - 0xdc00);
            out += String.fromCodePoint(combined);
            i += consumed + low[0].length;
            continue;
          }
        }
      }
      out += fromCodePoint(cp, fixed[0]);
      i += consumed;
    }
    return out;
  }

  /**
   * 字符引用 / JS 转义 → 文本。引用各做一趟替换，转义交给 decodeUnicodeEscapes；
   * 解出来的内容不会再被解一次；命名实体（&amp;、&nbsp; 等）不归这里管，
   * 见 html-entities。
   * 引用必须带分号，跟 HTML5 规范一致（少数字体名允许省略，这里不放开）。
   */
  function unicodeToText(unicode) {
    var src = String(unicode == null ? '' : unicode)
      .replace(/&#x([0-9a-f]+);/gi, function (match, hex) {
        return fromCodePoint(parseInt(hex, 16), match);
      })
      .replace(/&#(\d+);/g, function (match, dec) {
        return fromCodePoint(parseInt(dec, 10), match);
      });
    return decodeUnicodeEscapes(src);
  }

  window.ItTools.register('text-to-unicode', function (root) {
    var textInput = D.h('textarea.layui-textarea', { rows: 4, placeholder: t('input_ph', 'e.g. \'Hello Avengers\'') });
    var formatSelect = D.h('select.layui-input#t2u-format', null, FORMATS.map(function (f) {
      return D.h('option', { value: f.key, text: f.label });
    }));
    var skipAsciiInput = D.h('input', { type: 'checkbox' });
    var unicodeOut = D.h('pre.mono-output');
    var codePointBadge = D.h('span.badge-note');

    var unicodeInput = D.h('textarea.layui-textarea', { rows: 4, placeholder: t('input_unicode_ph', 'Input Unicode, e.g. &#72;&#101;&#108;&#108;&#111;') });
    var textOut = D.h('pre.mono-output');

    function renderUnicode() {
      var text = textInput.value;
      unicodeOut.textContent = textToUnicode(text, formatSelect.value, skipAsciiInput.checked);
      var points = text ? Array.from(text) : [];
      codePointBadge.textContent = points.length + ' ' +
        (points.length === 1 ? t('character', 'character') : t('characters', 'characters'));
    }

    function renderText() {
      textOut.textContent = unicodeToText(unicodeInput.value);
    }

    textInput.addEventListener('input', renderUnicode);
    formatSelect.addEventListener('change', renderUnicode);
    skipAsciiInput.addEventListener('change', renderUnicode);
    unicodeInput.addEventListener('input', renderText);

    // 原版的输出也是「上标签 + 只读框」（c-input-text 的 label 默认在控件上面），
    // 所以输出那一行用 label.field-label（14px/400）压在输出框正上方，
    // 不用我们自己的 .output-label（13px/500 的小标题）。
    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Enter text to convert to unicode:'), textInput, { wide: true }),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 't2u-format', text: t('format', 'Format:') }),
        formatSelect,
        D.h('label.switch', null, skipAsciiInput, D.h('span', { text: t('skip_ascii', 'Skip ASCII') }))
      ),
      U.field(t('unicode_from_text', 'Unicode from your text'), unicodeOut, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return unicodeOut.textContent; })
      ),
      D.h('div.form-actions', null, codePointBadge)
    ));

    root.appendChild(D.h('div.card', null,
      U.field(t('input_unicode', 'Enter unicode to convert to text:'), unicodeInput, {
        wide: true,
        hint: t('hint_unicode', 'Accepts &#65;, &#x41; and \\u0041; at the same time; unterminated or invalid references are kept as is.')
      }),
      U.field(t('text_from_unicode', 'Text from your unicode'), textOut, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return textOut.textContent; })
      )
    ));

    renderUnicode();
    renderText();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['text-to-unicode'] = {
    textToUnicode: textToUnicode,
    unicodeToText: unicodeToText,
    __cases: function (assert) {
      // 与参考实现的 vitest / e2e 用例一致
      assert.eq(textToUnicode('A'), '&#65;', '十进制');
      assert.eq(textToUnicode('it-tools'), '&#105;&#116;&#45;&#116;&#111;&#111;&#108;&#115;', 'e2e 用例');
      assert.eq(textToUnicode('linke the string convert to unicode'),
        '&#108;&#105;&#110;&#107;&#101;&#32;&#116;&#104;&#101;&#32;&#115;&#116;&#114;&#105;&#110;&#103;&#32;&#99;&#111;&#110;&#118;&#101;&#114;&#116;&#32;&#116;&#111;&#32;&#117;&#110;&#105;&#99;&#111;&#100;&#101;',
        '整句');
      assert.eq(textToUnicode(''), '', '空串');
      assert.eq(unicodeToText('&#65;'), 'A', '反向单个引用');
      assert.eq(unicodeToText('&#108;&#105;&#110;&#107;&#101;&#32;&#116;&#104;&#101;'), 'linke the', '反向整句');
      assert.eq(unicodeToText(''), '', '反向空串');
      assert.eq(unicodeToText('it-tools'), 'it-tools', '没有引用就原样返回');

      // 新增格式
      assert.eq(textToUnicode('A', 'hex'), '&#x41;', '十六进制');
      assert.eq(textToUnicode('A', 'escape'), '\\u0041;', 'JS 转义');
      assert.eq(textToUnicode('中', 'hex'), '&#x4e2d;', '汉字十六进制');
      assert.eq(unicodeToText('&#x41;'), 'A', '反向十六进制');
      assert.eq(unicodeToText('\\u0041;'), 'A', '反向 JS 转义');
      assert.eq(unicodeToText('\\u0041'), 'A', 'JS 转义可以不带分号');
      assert.eq(unicodeToText('&#X4E2D;'), '中', '十六进制大小写都认');

      // 修掉的行为：按码点输出，代理区码点不被当成合法字符
      assert.eq(textToUnicode('😀'), '&#128512;', 'emoji 一个引用');
      assert.eq(unicodeToText('&#128512;'), '😀', 'emoji 反向');
      assert.eq(unicodeToText(textToUnicode('a😀中')), 'a😀中', '混合往返');
      assert.eq(textToUnicode('😀', 'escape'), '\\u{1f600}', '超 BMP 用花括号转义');
      assert.eq(unicodeToText('\\u{1f600}'), '😀', '反向花括号转义');

      // 非法码点不打断输入
      assert.eq(unicodeToText('&#1114112;'), '&#1114112;', '越界码点原样保留');
      assert.eq(unicodeToText('&#55296;'), '&#55296;', '代理区码点原样保留');
      assert.eq(unicodeToText('&#65'), '&#65', '缺分号不解析');
      assert.eq(unicodeToText('&#xZZ;'), '&#xZZ;', '非十六进制不解析');

      // 上游 #1087：fullUnicode 档（\uXXXX 不带分号）
      assert.eq(textToUnicode('A', 'full-unicode'), '\\u0041', 'full unicode 不带分号');
      assert.eq(textToUnicode('中', 'full-unicode'), '\\u4e2d', 'full unicode 汉字');
      assert.eq(textToUnicode('😀', 'full-unicode'), '\\u{1f600}', 'full unicode 超 BMP 用花括号');

      // 上游 #1087：UTF-16 码元档 —— 一个 emoji 拆成两个代理转义
      assert.eq(textToUnicode('A', 'utf16'), '\\u0041', 'utf16 基本拉丁字母');
      assert.eq(textToUnicode('中', 'utf16'), '\\u4e2d', 'utf16 汉字');
      assert.eq(textToUnicode('😀', 'utf16'), '\\ud83d\\ude00', 'utf16 emoji 是两个代理转义');
      assert.eq(textToUnicode('a😀b', 'utf16'), '\\u0061\\ud83d\\ude00\\u0062', 'utf16 混排');
      // 反向要把代理对合成一个码点，否则 emoji 会解成两个孤立代理
      assert.eq(unicodeToText('\\uD83D\\uDE00'), '😀', '代理对反向合成一个码点');
      assert.eq(unicodeToText(textToUnicode('😀', 'utf16')), '😀', 'utf16 往返');
      assert.eq(unicodeToText(textToUnicode('a😀中', 'utf16')), 'a😀中', 'utf16 混排往返');
      assert.eq(unicodeToText('\\uD83D'), '\\uD83D', '落单的高代理原样保留');
      assert.eq(unicodeToText('\\uDE00'), '\\uDE00', '落单的低代理原样保留');
      assert.eq(unicodeToText('\\uD83D\\u0041'), '\\uD83DA', '高代理后面不是低代理就不合并');

      // 上游 #1087：跳过 ASCII —— 只转义非 ASCII 字符
      assert.eq(textToUnicode('a中', 'decimal', true), 'a&#20013;', '跳过 ASCII：只转义汉字');
      assert.eq(textToUnicode('a中', 'hex', true), 'a&#x4e2d;', '跳过 ASCII：十六进制');
      assert.eq(textToUnicode('a中', 'escape', true), 'a\\u4e2d;', '跳过 ASCII：JS 转义');
      assert.eq(textToUnicode('a😀b', 'utf16', true), 'a\\ud83d\\ude00b', '跳过 ASCII：utf16');
      assert.eq(textToUnicode('it-tools', 'decimal', true), 'it-tools', '全是 ASCII 就原样返回');
      assert.eq(textToUnicode('a b', 'decimal', true), 'a b', '空格也算 ASCII');
      // HTML 风格要转义 & " < >，JS 风格要转义 " ' \
      assert.eq(textToUnicode('a&b', 'hex', true), 'a&#x26;b', 'HTML 风格：& 不跳过');
      assert.eq(textToUnicode('a"b', 'hex', true), 'a&#x22;b', 'HTML 风格：" 不跳过');
      assert.eq(textToUnicode("a'b", 'escape', true), "a\\u0027;b", 'JS 风格：\' 不跳过');
      assert.eq(textToUnicode('a\\b', 'escape', true), 'a\\u005c;b', 'JS 风格：\\ 不跳过');
      // 不跳过时一切照旧
      assert.eq(textToUnicode('a&b', 'hex', false), '&#x61;&#x26;&#x62;', '不跳过时全部转义');
    }
  };
})();