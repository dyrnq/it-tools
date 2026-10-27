/* ==========================================================================
   大小写转换器（case-converter）

   把一段文本同时转成 14 种大小写风格。切词规则对齐参考项目所用的
   change-case 4.x 的 no-case 语义。

   参考实现：src/tools/case-converter/（it-tools, GPLv3）
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('case-converter');

  // 参考项目传入的 stripRegexp：只保留拉丁字母（含变音字母）与数字。
  //
  // 原版写的是 `/[^A-Za-zÀ-ÖØ-öø-ÿ]+/gi`，**少写了 0-9** —— 于是
  // `1hello2world3` 切词后是 ['hello','world']，三个数字当分隔符吃掉了，
  // Constantcase 给出的 `HELLO WORLD` 与用户输入对不上（上游 issue #1446，
  // 至今未修）。这里补回数字，与上面那句注释对齐。
  var STRIP = /[^0-9A-Za-zÀ-ÖØ-öø-ÿ]+/gi;
  // change-case 的默认切词规则：驼峰边界 + 首字母缩写边界。
  var SPLIT = [/([a-z0-9])([A-Z])/g, /([A-Z])([A-Z][a-z])/g];

  function lower(s) { return s.toLocaleLowerCase(); }
  function upper(s) { return s.toLocaleUpperCase(); }
  /** 首字母大写，其余原样保留。 */
  function cap(s) { return s ? upper(s.charAt(0)) + s.slice(1) : s; }
  function lowerFirst(s) { return s ? lower(s.charAt(0)) + s.slice(1) : s; }

  /**
   * 把任意字符串切成词数组。
   * 先按 strip 规则把非字母数字换成空格，再按驼峰规则插入分隔，最后去首尾空格。
   */
  function words(input) {
    var result = String(input).trim();
    if (!result.length) return [];
    result = result.replace(STRIP, ' ');
    SPLIT.forEach(function (regexp) {
      result = result.replace(regexp, '$1 $2');
    });
    return result.split(' ').filter(Boolean);
  }

  /**
   * 14 种风格，顺序与参考项目一致。
   *
   * label 是界面上的显示名，走 i18n；id 是稳定的内部标识（不随语言变），
   * 断言按 id 查值 —— 见 __cases 里的 byId。
   */
  function formats(input) {
    var w = words(input);
    var sepLower = w.map(lower).join(' ');
    return [
      { id: 'lowercase', label: t('lowercase', 'Lowercase'), value: lower(input) },
      { id: 'uppercase', label: t('uppercase', 'Uppercase'), value: upper(input) },
      { id: 'camelcase', label: t('camelcase', 'Camelcase'), value: lowerFirst(w.map(cap).join('')) },
      { id: 'capitalcase', label: t('capitalcase', 'Capitalcase'), value: w.map(cap).join(' ') },
      { id: 'constantcase', label: t('constantcase', 'Constantcase'), value: sepLower.toLocaleUpperCase() },
      { id: 'dotcase', label: t('dotcase', 'Dotcase'), value: sepLower.toLocaleUpperCase().replace(/ /g, '.') },
      { id: 'headercase', label: t('headercase', 'Headercase'), value: w.map(cap).join('-') },
      { id: 'nocase', label: t('nocase', 'Nocase'), value: sepLower },
      { id: 'paramcase', label: t('paramcase', 'Paramcase'), value: sepLower.toLocaleUpperCase().replace(/ /g, '-') },
      { id: 'pascalcase', label: t('pascalcase', 'Pascalcase'), value: w.map(cap).join('') },
      { id: 'pathcase', label: t('pathcase', 'Pathcase'), value: sepLower.toLocaleUpperCase().replace(/ /g, '/') },
      { id: 'sentencecase', label: t('sentencecase', 'Sentencecase'), value: w.map(function (word, i) { return i === 0 ? cap(word) : word; }).join(' ') },
      { id: 'snakecase', label: t('snakecase', 'Snakecase'), value: sepLower.toLocaleUpperCase().replace(/ /g, '_') },
      {
        id: 'mockingcase',
        label: t('mockingcase', 'Mockingcase'),
        value: input.split('').map(function (ch, i) { return i % 2 === 0 ? upper(ch) : lower(ch); }).join('')
      }
    ];
  }

  window.ItTools.register('case-converter', function (root) {
    // 原版的输入框是**单行**的 c-input-text（没有 multiline），
    // 我们原来用的是 4 行的 textarea —— 框高和原版对不上。
    var inputEl = D.h('input.layui-input', {
      id: 'cc-input', type: 'text', value: 'lorem ipsum dolor sit amet'
    });
    var output = D.h('div.field.kv-rows');

    function row(label, value) {
      var input = D.h('input.layui-input', { type: 'text', readonly: true, value: value });
      return D.h('div.field-row', null,
        D.h('label.field-label', { text: label }),
        input,
        U.copyButton(function () { return input.value; })
      );
    }

    function render() {
      D.clear(output);
      formats(inputEl.value).forEach(function (f) { output.appendChild(row(f.label, f.value)); });
    }

    inputEl.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      // 原版 case-converter 自己带一份 inputLabelAlignmentConfig：
      // 标签在左、120px、右对齐 —— 全站只有这一个工具这么写，别把它当默认。
      U.field(t('input', 'Your string:'), inputEl, { wide: true, left: true }),
      U.divider(16),
      output
    ));
    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['case-converter'] = {
    words: words,
    formats: formats,
    __cases: function (assert) {
      assert.eq(words('lorem ipsum'), ['lorem', 'ipsum'], '空格分词');
      assert.eq(words('camelCaseString'), ['camel', 'Case', 'String'], '驼峰分词');
      assert.eq(words('HTTPServerError'), ['HTTP', 'Server', 'Error'], '缩写边界');
      assert.eq(words(''), [], '空串');
      // label 现在是翻译过的显示名，断言一律按稳定的 id 查
      var byId = {};
      formats('lorem ipsum dolor sit amet').forEach(function (f) { byId[f.id] = f.value; });
      assert.eq(byId.camelcase, 'loremIpsumDolorSitAmet', 'camelCase');
      assert.eq(byId.snakecase, 'LOREM_IPSUM_DOLOR_SIT_AMET', 'snake_case');
      assert.eq(byId.paramcase, 'LOREM-IPSUM-DOLOR-SIT-AMET', 'param-case');
      assert.eq(byId.dotcase, 'LOREM.IPSUM.DOLOR.SIT.AMET', 'dot.case');
      assert.eq(byId.pathcase, 'LOREM/IPSUM/DOLOR/SIT/AMET', 'path/case');
      // 奇偶按原串下标推进，空格也占一位，所以每个单词的大小写起点会交替
      assert.eq(byId.mockingcase, 'LoReM IpSuM DoLoR SiT AmEt', 'mockingcase');
      assert.eq(formats('').length, 14, '始终输出 14 种风格');

      // 数字是词的一部分，不是分隔符（上游 #1446：STRIP 少写 0-9 把数字吃了）
      assert.eq(words('1hello2world3'), ['1hello2world3'], '连着的数字不进分词');
      var num = {};
      formats('1hello2world3').forEach(function (f) { num[f.id] = f.value; });
      assert.eq(num.constantcase, '1HELLO2WORLD3', 'constant_case 保留数字');
      assert.eq(num.uppercase, '1HELLO2WORLD3', 'uppercase 保留数字');
      assert.eq(words('foo 42 bar'), ['foo', '42', 'bar'], '独立的数字自成词');
      var spaced = {};
      formats('foo 42 bar').forEach(function (f) { spaced[f.id] = f.value; });
      assert.eq(spaced.snakecase, 'FOO_42_BAR', 'snake_case 里数字也占一段');
      assert.eq(spaced.camelcase, 'foo42Bar', 'camelCase 去掉分隔但数字留下');
    }
  };
})();