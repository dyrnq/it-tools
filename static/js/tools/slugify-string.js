/* ==========================================================================
   字符串 slug 化（slugify-string）

   把任意文本转成适合放进 URL 的 slug。

   参考实现：src/tools/slugify-string/（it-tools, GPLv3）
   原版用 @sindresorhus/slugify + transliterate（两张加起来上万行的替换表），
   这里全部自己实现，不引外部库。与原版的差别：
   1. 原版把「非字母数字」的多种写法区别对待：句点是直接删掉（my file.txt →
      my-filetxt），下划线和连字符原样保留，连续空格会留下一串连字符
      （a  b → a--b）。这里统一按「连续的非字母数字 = 一个分隔符」处理，
      更符合 URL slug 的常见预期。
   2. transliterate 的替换表覆盖了几千个码位，这里只做真正影响结果的折叠：
      NFD 拆掉变音记号 + 拉丁连字 + 西里尔字母 + 少量符号词。
      中文、日文、希腊文这类没有对应 ASCII 写法的字符会被丢掉。
   3. 分隔符可配（上游 #1232）：底层本来就支持 `opts.replacement`，
      原版没在界面上露出来，这里加了一个输入框。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('slugify-string');

  /** 组合记号区间，NFD 之后要把它们去掉。 */
  var COMBINING = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20f0\ufe20-\ufe2f]/g;

  /** 拆不开（NFD 也拼不回拉丁字母）的拉丁连字与小写形式。 */
  var LIGATURES = {
    'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th',
    'ł': 'l', 'ħ': 'h', 'ŋ': 'n', 'ı': 'i', 'ĳ': 'ij', 'ƒ': 'f', 'ŧ': 't'
  };

  /** 有常用英文说法的符号，替换时补空格，免得跟相邻字母粘在一起。 */
  var SYMBOLS = {
    '&': 'and', '@': 'at', '$': 'dollar', '%': 'percent', '+': 'plus', '№': 'no', 'µ': 'u'
  };

  /** 西里尔字母表，只列小写，匹配时用 i 标志兼容大写。 */
  var CYRILLIC = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya', 'ѓ': 'g',
    'є': 'ie', 'і': 'i', 'ї': 'i', 'ј': 'j'
  };

  /** 正则元字符转义，用来安全地把上面的表拼进字符类。 */
  function escapeRe(str) {
    return str.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
  }

  var LIGATURE_RE = new RegExp('[' + escapeRe(Object.keys(LIGATURES).join('')) + ']', 'gi');
  var SYMBOL_RE = new RegExp('[' + escapeRe(Object.keys(SYMBOLS).join('')) + ']', 'g');
  var CYRILLIC_RE = /[\u0400-\u04ff\u0500-\u052f]/g;

  // 中间占位符：先把它换成不可见的哨兵，最后再一次性替换成分隔符，
  // 这样分隔符本身是什么字符（甚至是不是正则元字符）都不影响中间步骤。
  var SENTINEL = '\u0000';

  /**
   * 主函数：把任意文本转成 slug。
   * @param {string} input
   * @param {{replacement?: string, lower?: boolean, trim?: boolean}} [opts]
   * @returns {string}
   */
  function slugify(input, opts) {
    var o = Object.assign({ replacement: '-', lower: true, trim: true }, opts || {});
    var s = input === null || input === undefined ? '' : String(input);
    if (!s) return '';

    // 1. 符号换成单词（先于 NFD，避免替换出来的词再被拆）
    s = s.replace(SYMBOL_RE, function (ch) { return ' ' + SYMBOLS[ch] + ' '; });
    // 2. 连字与西里尔字母转写，匹配用小写表 + i 标志
    s = s.replace(LIGATURE_RE, function (ch) { return LIGATURES[ch.toLowerCase()] || ch; });
    s = s.replace(CYRILLIC_RE, function (ch) { return CYRILLIC[ch.toLowerCase()] || ch; });
    // 3. NFD 拆出组合记号再去掉：é → e、ñ → n、å → a
    s = s.normalize('NFD').replace(COMBINING, '');

    // 4. 大小写
    if (o.lower) s = s.toLowerCase();

    // 5. 连续的非字母数字（空格、标点、已有的连字符与下划线……）压成一个分隔符
    s = s.replace(o.lower ? /[^a-z0-9]+/g : /[^A-Za-z0-9]+/g, SENTINEL);
    if (o.trim) s = s.replace(/^\u0000+|\u0000+$/g, '');
    return s.split(SENTINEL).join(o.replacement);
  }

  window.ItTools.register('slugify-string', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 3, placeholder: t('input_ph', 'Put your string here (ex: My file path)'), spellcheck: 'false'
    });
    var output = D.h('textarea.layui-textarea', {
      rows: 3, readonly: true, placeholder: t('output_ph', 'Your slug will be generated here (ex: my-file-path)')
    });
    // 分隔符可配（上游 #1232）：底层早就支持 opts.replacement，只是界面上没露出来
    var separator = D.h('input.layui-input', { type: 'text', value: '-', spellcheck: 'false' });

    function render() {
      // 空值回落到 '-'：留空的话整串会塌成一个词（hello world → helloworld），
      // 那通常不是用户想要的
      output.value = slugify(input.value, { replacement: separator.value || '-' });
    }

    input.addEventListener('input', render);
    separator.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your string to slugify'), input, { wide: true }),
      U.field(t('separator', 'Separator'), separator,
        { hint: t('separator_hint', 'Defaults to the hyphen -; you can also use _ or several characters') }),
      U.field(t('output', 'Your slug'), output,
        { wide: true, hint: t('output_hint', 'Consecutive non-alphanumeric characters are merged into a single separator') }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return output.value; })
      )
    ));
    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['slugify-string'] = {
    slugify: slugify,
    __cases: function (assert) {
      // 基本替换
      assert.eq(slugify('My file path'), 'my-file-path', '空格转连字符');
      assert.eq(slugify('Hello, World!'), 'hello-world', '标点被压成分隔符');
      assert.eq(slugify('  Trim  Me  '), 'trim-me', '首尾空白 + 连续空格');
      assert.eq(slugify('a--b'), 'a-b', '连续连字符合并');
      assert.eq(slugify('foo_bar'), 'foo-bar', '下划线当分隔符');
      assert.eq(slugify('Version 1.2.3'), 'version-1-2-3', '版本号');
      assert.eq(slugify('a--b_c d'), 'a-b-c-d', '混排');

      // 变音折叠与连字
      assert.eq(slugify('Café déjà vu'), 'cafe-deja-vu', '拉丁变音');
      assert.eq(slugify('Crème Brûlée'), 'creme-brulee', '带声调符号');
      assert.eq(slugify('Über Straße'), 'uber-strasse', '大写变音 + ß');
      assert.eq(slugify('Œuvre æsop Œuvre'), 'oeuvre-aesop-oeuvre', '连字');

      // 符号词
      assert.eq(slugify('AT&T'), 'at-and-t', '& → and');
      assert.eq(slugify('a&b'), 'a-and-b', '夹在词中间');
      assert.eq(slugify('50% off'), '50-percent-off', '% → percent');

      // 西里尔
      assert.eq(slugify('Привет мир'), 'privet-mir', '西里尔转写');
      assert.eq(slugify('МОСКВА'), 'moskva', '西里尔大写');

      // 没有 ASCII 写法的字符会被丢掉
      assert.eq(slugify('你好 世界'), '', 'CJK 被丢弃');
      assert.eq(slugify('Hello 世界'), 'hello', 'CJK 只剩周围的拉丁词');

      // 边界
      assert.eq(slugify(''), '', '空串');
      assert.eq(slugify(null), '', 'null');
      assert.eq(slugify(undefined), '', 'undefined');
      assert.eq(slugify('!!!'), '', '只有标点');
      assert.eq(slugify('123'), '123', '纯数字保留');

      // 选项
      assert.eq(slugify('Hello World', { lower: false }), 'Hello-World', '不转小写');
      assert.eq(slugify('Hello World', { replacement: '_' }), 'hello_world', '自定义分隔符');
      assert.eq(slugify('-a-', { trim: false }), '-a-', '不裁首尾');
      assert.eq(slugify('A B', { lower: false, replacement: '.' }), 'A.B', '组合选项');
    }
  };
})();