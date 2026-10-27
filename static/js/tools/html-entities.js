/* ==========================================================================
   HTML 实体转义 / 反转义（html-entities）

   转义：& < > " ' ` 换成实体；反转义：命名实体与数字引用换回字符。

   参考实现：src/tools/html-entities/（it-tools, GPLv3，用 lodash 的
   escape / unescape）。这里全部用原生 API 重写，差别如下：
   1. 转义没有直接复用 U.escapeHtml：lodash 的 escape 连反引号一起转成 &#96;
      （老 IE 的属性 / 注释上下文里反引号能逃逸出来），U.escapeHtml 只转 5 个
      字符。为了与参考实现输出一致，这里自己转 6 个。
   2. lodash 的 unescape 只认 6 个实体（&amp; &lt; &gt; &quot; &#39; &#96;），
      连 &nbsp; 都解不开；这里内置一张常用实体表（Latin-1 全段 64 个 +
      标点 / 箭头 / 数学符 / 希腊字母 / 卡牌等，合计 230 条），并支持十六进制 &#x41;。
   3. lodash 不检查 &#999999999; 这类越界码点，fromCharCode 会静默绕回；
      这里越界与代理区码点原样保留，不改坏用户文本。

   实体名区分大小写（&Amp; 不是实体），且一律要求结尾分号，
   与 lodash 及 HTML5 的常见用法一致。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('html-entities');

  /** XML / HTML 必备的 5 个，注意 HTML5 里 &apos; 也是标准实体。 */
  var XML_ENTITIES = [['amp', 0x26], ['lt', 0x3c], ['gt', 0x3e], ['quot', 0x22], ['apos', 0x27]];

  /**
   * Latin-1 段（U+00C0~U+00DE 与 U+00E0~U+00FE）按规范的大小写排布：
   * 两个数组的下标 i 对应码点 0xC0 + i / 0xE0 + i，中间的 ß 与结尾的 ÿ 单独补。
   */
  var LATIN1_UPPER = [
    'Agrave', 'Aacute', 'Acirc', 'Atilde', 'Auml', 'Aring', 'AElig', 'Ccedil',
    'Egrave', 'Eacute', 'Ecirc', 'Euml', 'Igrave', 'Iacute', 'Icirc', 'Iuml',
    'ETH', 'Ntilde', 'Ograve', 'Oacute', 'Ocirc', 'Otilde', 'Ouml', 'times',
    'Oslash', 'Ugrave', 'Uacute', 'Ucirc', 'Uuml', 'Yacute', 'THORN'
  ];
  var LATIN1_LOWER = [
    'agrave', 'aacute', 'acirc', 'atilde', 'auml', 'aring', 'aelig', 'ccedil',
    'egrave', 'eacute', 'ecirc', 'euml', 'igrave', 'iacute', 'icirc', 'iuml',
    'eth', 'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml', 'divide',
    'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute', 'thorn'
  ];

  /** 其它常用实体：[名字, 码点]。与 Latin-1 段重名的已剔除。 */
  var SYMBOL_ENTITIES = [['nbsp', 0xa0],
  ['ensp', 0x2002],
  ['emsp', 0x2003],
  ['thinsp', 0x2009],
  ['zwnj', 0x200c],
  ['zwj', 0x200d],
  ['lrm', 0x200e],
  ['rlm', 0x200f],
  ['shy', 0xad],
  ['wj', 0x2060],
  ['ndash', 0x2013],
  ['mdash', 0x2014],
  ['horbar', 0x2015],
  ['lsquo', 0x2018],
  ['rsquo', 0x2019],
  ['sbquo', 0x201a],
  ['ldquo', 0x201c],
  ['rdquo', 0x201d],
  ['bdquo', 0x201e],
  ['dagger', 0x2020],
  ['Dagger', 0x2021],
  ['bull', 0x2022],
  ['hellip', 0x2026],
  ['permil', 0x2030],
  ['prime', 0x2032],
  ['Prime', 0x2033],
  ['lsaquo', 0x2039],
  ['rsaquo', 0x203a],
  ['oline', 0x203e],
  ['frasl', 0x2044],
  ['laquo', 0xab],
  ['raquo', 0xbb],
  ['middot', 0xb7],
  ['para', 0xb6],
  ['sect', 0xa7],
  ['copy', 0xa9],
  ['reg', 0xae],
  ['trade', 0x2122],
  ['deg', 0xb0],
  ['plusmn', 0xb1],
  ['minus', 0x2212],
['frac12', 0xbd],
['frac14', 0xbc],
['frac34', 0xbe],
['sup1', 0xb9],
['sup2', 0xb2],
['sup3', 0xb3],
  ['micro', 0xb5],
  ['macr', 0xaf],
  ['acute', 0xb4],
  ['cedil', 0xb8],
  ['ordf', 0xaa],
  ['ordm', 0xba],
  ['iquest', 0xbf],
  ['iexcl', 0xa1],
  ['curren', 0xa4],
  ['brvbar', 0xa6],
  ['uml', 0xa8],
  ['not', 0xac],
  ['cent', 0xa2],
  ['pound', 0xa3],
  ['yen', 0xa5],
  ['euro', 0x20ac],
  ['lowast', 0x2217],
  ['radic', 0x221a],
  ['prop', 0x221d],
  ['infin', 0x221e],
  ['ne', 0x2260],
  ['le', 0x2264],
  ['ge', 0x2265],
  ['asymp', 0x2248],
  ['equiv', 0x2261],
  ['cong', 0x2245],
  ['sim', 0x223c],
  ['sum', 0x2211],
  ['prod', 0x220f],
  ['int', 0x222b],
  ['part', 0x2202],
  ['nabla', 0x2207],
  ['isin', 0x2208],
  ['notin', 0x2209],
  ['ni', 0x220b],
  ['forall', 0x2200],
  ['exist', 0x2203],
  ['empty', 0x2205],
  ['angle', 0x2220],
  ['and', 0x2227],
  ['or', 0x2228],
['there4', 0x2234],
  ['cap', 0x2229],
  ['cup', 0x222a],
  ['sub', 0x2282],
  ['sup', 0x2283],
  ['sube', 0x2286],
  ['supe', 0x2287],
  ['oplus', 0x2295],
  ['otimes', 0x2297],
  ['perp', 0x22a5],
  ['sdot', 0x22c5],
  ['larr', 0x2190],
  ['uarr', 0x2191],
  ['rarr', 0x2192],
  ['darr', 0x2193],
  ['harr', 0x2194],
  ['crarr', 0x21b5],
  ['lArr', 0x21d0],
  ['rArr', 0x21d2],
  ['hArr', 0x21d4],
  ['alpha', 0x3b1],
  ['beta', 0x3b2],
  ['gamma', 0x3b3],
  ['delta', 0x3b4],
  ['epsilon', 0x3b5],
  ['zeta', 0x3b6],
  ['eta', 0x3b7],
  ['theta', 0x3b8],
  ['iota', 0x3b9],
  ['kappa', 0x3ba],
  ['lambda', 0x3bb],
  ['mu', 0x3bc],
  ['nu', 0x3bd],
  ['xi', 0x3be],
  ['omicron', 0x3bf],
  ['pi', 0x3c0],
  ['rho', 0x3c1],
  ['sigmaf', 0x3c2],
  ['sigma', 0x3c3],
  ['tau', 0x3c4],
  ['upsilon', 0x3c5],
  ['phi', 0x3c6],
  ['chi', 0x3c7],
  ['psi', 0x3c8],
  ['omega', 0x3c9],
  ['Alpha', 0x391],
  ['Beta', 0x392],
  ['Gamma', 0x393],
  ['Delta', 0x394],
  ['Epsilon', 0x395],
  ['Zeta', 0x396],
  ['Eta', 0x397],
  ['Theta', 0x398],
  ['Iota', 0x399],
  ['Kappa', 0x39a],
  ['Lambda', 0x39b],
  ['Mu', 0x39c],
  ['Nu', 0x39d],
  ['Xi', 0x39e],
  ['Omicron', 0x39f],
  ['Pi', 0x3a0],
  ['Rho', 0x3a1],
  ['Sigma', 0x3a3],
  ['Tau', 0x3a4],
  ['Upsilon', 0x3a5],
  ['Phi', 0x3a6],
  ['Chi', 0x3a7],
  ['Psi', 0x3a8],
  ['Omega', 0x3a9],
  ['spades', 0x2660],
  ['clubs', 0x2663],
  ['hearts', 0x2665],
  ['diams', 0x2666]];

  /**
   * 常用命名实体表。不是 HTML5 全集（两千多条），只收日常会碰到的。
   * 用码点而不是字面量存值，源文件在任何编码下读出来都一样。
   */
  var ENTITIES = {};
  function put(name, codePoint) {
    ENTITIES[name] = String.fromCodePoint(codePoint);
  }

  XML_ENTITIES.forEach(function (pair) { put(pair[0], pair[1]); });
  LATIN1_UPPER.forEach(function (name, i) { put(name, 0xc0 + i); });
  LATIN1_LOWER.forEach(function (name, i) { put(name, 0xe0 + i); });
  put('szlig', 0xdf);
  put('yuml', 0xff);
  SYMBOL_ENTITIES.forEach(function (pair) { put(pair[0], pair[1]); });

  // 一个实体引用：&name; / &#123; / &#x7B;。分号是必需的。
  var ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

  /** 转义表：与 lodash 的 escape 逐字一致，注意它比 U.escapeHtml 多一个反引号。 */
  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

  /**
   * HTML 转义：& < > " ' 与反引号。
   * @param {string} text
   */
  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"'`]/g, function (char) {
      return ESCAPES[char];
    });
  }

  /** 码点 → 字符；越界或落在代理区时返回 fallback（也就是原样的引用文本）。 */
  function fromCodePoint(codePoint, fallback) {
    if (!isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return fallback;
    return String.fromCodePoint(codePoint);
  }

  /**
   * 反转义：命名实体、十进制与十六进制数字引用都认，单趟替换
   * （所以 '&amp;lt;' 出来是 '&lt;' 而不是 '<'，与 lodash 一致）。
   * 表里没有的名字原样保留。
   * @param {string} text
   */
  function unescapeHtml(text) {
    return String(text == null ? '' : text).replace(ENTITY_RE, function (match, body) {
      if (body.charAt(0) === '#') {
        var isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        return fromCodePoint(parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10), match);
      }
      var decoded = ENTITIES[body];
      return decoded === undefined ? match : decoded;
    });
  }

  /** 速查表：常用实体的名字、字符与码点，给界面下半部分用。 */
  function cheatSheet() {
    return ['amp', 'lt', 'gt', 'quot', 'apos', 'nbsp', 'copy', 'reg', 'trade', 'hellip', 'mdash', 'ndash',
      'lsquo', 'rsquo', 'ldquo', 'rdquo', 'laquo', 'raquo', 'times', 'divide', 'deg', 'plusmn', 'micro',
      'para', 'sect', 'bull', 'dagger', 'euro', 'pound', 'yen', 'cent', 'larr', 'rarr', 'harr',
      'ne', 'le', 'ge', 'infin', 'sum', 'radic', 'alpha', 'beta', 'omega', 'spades'].map(function (name) {
        var value = ENTITIES[name];
        if (value === undefined) return null;
        return {
          entity: '&' + name + ';',
          char: value,
          codePoint: 'U+' + value.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
        };
      }).filter(Boolean);
  }

  window.ItTools.register('html-entities', function (root) {
    var escapeInput = D.h('textarea.layui-textarea', { rows: 3, placeholder: t('ph_escape', 'The string to escape') });
    escapeInput.value = '<title>IT Tool</title>';
    var escapeOutput = D.h('pre.mono-output');

    var unescapeInput = D.h('textarea.layui-textarea', { rows: 3, placeholder: t('ph_unescape', 'The string to unescape') });
    unescapeInput.value = '&lt;title&gt;IT Tool&lt;/title&gt;';
    var unescapeOutput = D.h('pre.mono-output');

    var cheatBody = D.h('tbody');

    function render() {
      escapeOutput.textContent = escapeHtml(escapeInput.value);
      unescapeOutput.textContent = unescapeHtml(unescapeInput.value);
      D.clear(cheatBody);
      cheatSheet().forEach(function (row) {
        cheatBody.appendChild(D.h('tr', null,
          D.h('td.val', { text: row.entity }),
          D.h('td', { text: row.char }),
          D.h('td.val', { text: row.codePoint })
        ));
      });
    }

    escapeInput.addEventListener('input', render);
    unescapeInput.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      D.h('div.output-label', { text: t('title_escape', 'Escape html entities') }),
      U.field(t('input', 'Your string:'), escapeInput, { wide: true }),
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('escaped', 'Your string escaped') }),
        U.copyButton(function () { return escapeOutput.textContent; })
      ),
      escapeOutput,
      D.h('p.field-hint', {
        text: t('hint_escape', 'Only & < > " and the two quote characters (single quote, backtick) are escaped; everything else is kept as is.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-label', { text: t('title_unescape', 'Unescape html entities') }),
      U.field(t('input_escaped', 'Your escaped string:'), unescapeInput, { wide: true }),
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('unescaped', 'Your string unescaped') }),
        U.copyButton(function () { return unescapeOutput.textContent; })
      ),
      unescapeOutput,
      D.h('p.field-hint', {
        text: t('hint_unescape', 'Named entities, decimal &#65; and hexadecimal &#x41; are all decoded; names that are not in the table are kept as is.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-label', { text: t('title_common', 'Common entities') }),
      D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_entity', 'Entity') }),
          D.h('th', { text: t('col_character', 'Character') }),
          D.h('th', { text: t('col_code_point', 'Code point') })
        )),
        cheatBody
      )
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['html-entities'] = {
    escapeHtml: escapeHtml,
    unescapeHtml: unescapeHtml,
    entities: ENTITIES,
    cheatSheet: cheatSheet,
    __cases: function (assert) {
      var NBSP = String.fromCharCode(0xa0);
      var EMOJI = String.fromCodePoint(0x1f600);

      // 转义：与 lodash escape 一致
      assert.eq(escapeHtml('<title>IT Tool</title>'), '&lt;title&gt;IT Tool&lt;/title&gt;', '标签');
      assert.eq(escapeHtml('a & b'), 'a &amp; b', '与号');
      assert.eq(escapeHtml('"x"'), '&quot;x&quot;', '双引号');
      assert.eq(escapeHtml("'x'"), '&#39;x&#39;', '单引号');
      assert.eq(escapeHtml('`x`'), '&#96;x&#96;', '反引号（比 U.escapeHtml 多转的一个）');
      assert.eq(escapeHtml('plain'), 'plain', '无需转义的内容');
      assert.eq(escapeHtml(''), '', '空串');

      // 反转义：lodash 认的那 5 个必须一致
      assert.eq(unescapeHtml('&lt;title&gt;IT Tool&lt;/title&gt;'), '<title>IT Tool</title>', '反转义');
      assert.eq(unescapeHtml('&amp;'), '&', '与号');
      assert.eq(unescapeHtml('&quot;x&quot;'), '"x"', '双引号');
      assert.eq(unescapeHtml('&#39;'), "'", '单引号');
      assert.eq(unescapeHtml('&apos;'), "'", 'apos');
      assert.eq(unescapeHtml('a & b'), 'a & b', '没有引用');
      assert.eq(unescapeHtml(''), '', '空串');

      // lodash 解不开、这里能解开的
      assert.eq(unescapeHtml('&nbsp;'), NBSP, '不换行空格');
      assert.eq(unescapeHtml('&copy; 2024'), '© 2024', '版权符号');
      assert.eq(unescapeHtml('&hellip;'), '…', '省略号');
      assert.eq(unescapeHtml('&mdash;&ndash;'), '—–', '长短破折号');
      assert.eq(unescapeHtml('&euro;&pound;&yen;'), '€£¥', '货币');
      assert.eq(unescapeHtml('&larr;&rarr;&harr;'), '←→↔', '箭头');
      assert.eq(unescapeHtml('&times;&divide;'), '×÷', '乘除');
      assert.eq(unescapeHtml('&alpha;&beta;&omega;'), 'αβω', '希腊字母');
      assert.eq(unescapeHtml('&eacute;&uuml;'), 'éü', '带音标的拉丁字母');
      assert.eq(unescapeHtml('&Aacute;'), 'Á', '实体名区分大小写');
      assert.eq(unescapeHtml('&szlig;'), 'ß', '德语 ß');

      // 数字引用
      assert.eq(unescapeHtml('&#65;'), 'A', '十进制引用');
      assert.eq(unescapeHtml('&#x41;'), 'A', '十六进制引用');
      assert.eq(unescapeHtml('&#X41;'), 'A', '十六进制大写 X');
      assert.eq(unescapeHtml('&#128512;'), EMOJI, '超 BMP 码点');

      // 边界与非法输入
      assert.eq(unescapeHtml('&amp;lt;'), '&lt;', '单趟替换不递归');
      assert.eq(unescapeHtml('&unknown;'), '&unknown;', '表里没有的名字原样保留');
      assert.eq(unescapeHtml('&amp'), '&amp', '缺分号不解析');
      assert.eq(unescapeHtml('&#999999999;'), '&#999999999;', '越界码点原样保留');
      assert.eq(unescapeHtml('&#55296;'), '&#55296;', '代理区码点原样保留');
      assert.eq(unescapeHtml('100% &amp; more'), '100% & more', '混排');

      // 实体表本身
      assert.eq(Object.keys(ENTITIES).length, 230, '230 条实体');
      assert.eq(ENTITIES.amp, '&', 'amp');
      assert.eq(ENTITIES.nbsp, NBSP, 'nbsp 是 U+00A0');
      assert.eq(ENTITIES.Omega, 'Ω', '大写希腊字母');

      // 速查表
      var sheet = cheatSheet();
      assert.eq(sheet.length, 44, '速查表 44 条');
      assert.eq(sheet[0].entity, '&amp;', '第一条是 &amp;');
      assert.eq(sheet[0].codePoint, 'U+0026', '& 对应 U+0026');
      assert(sheet.some(function (r) { return r.entity === '&mdash;'; }), '速查表含 &mdash;');
    }
  };
})();