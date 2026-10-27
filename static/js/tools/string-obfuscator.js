/* ==========================================================================
   字符串混淆器（string-obfuscator）

   把字符串中间的一段用替换字符盖住，可分别指定保留开头与结尾的字符数。

   参考实现：src/tools/string-obfuscator/（it-tools, GPLv3）
   与原版的差别：
   1. 原版用 str.split('') 按 UTF-16 码元切分，emoji / 增补平面字符会被劈成
      两个残缺码元分别盖住，输出既不是合法字符也不再等长。这里按码点切。
   2. 原版的「保留空格」只认半角空格 U+0020，制表符、换行、全角空格照样被盖住；
      这里按「所有空白字符」判断。
   3. keepFirst / keepLast 现在会被夹在 [0, 字符串长度] 内，输入框里填了
      999 也不会把整串原样放行（超出长度与不填等价，长度上限即字符串本身）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('string-obfuscator');

  var WHITESPACE = /\s/;

  /** 取非负整数：没给值用 fallback，负数夹到 0，非数字也退回 fallback。 */
  function toCount(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.max(0, Math.floor(n));
  }

  /**
   * 混淆一段字符串。
   * @param {string} text
   * @param {{replacementChar?: string, keepFirst?: number, keepLast?: number, keepSpace?: boolean}} [opts]
   */
  function obfuscateString(text, opts) {
    opts = opts || {};
    var replacementChar = opts.replacementChar === undefined ? '*' : String(opts.replacementChar);
    var chars = Array.from(String(text == null ? '' : text));
    var length = chars.length;
    var first = Math.min(toCount(opts.keepFirst, 4), length);
    var last = Math.min(toCount(opts.keepLast, 0), length);
    var keepSpace = opts.keepSpace === undefined ? true : !!opts.keepSpace;

    return chars.map(function (char, index) {
      if (keepSpace && WHITESPACE.test(char)) return char;
      if (index < first || index >= length - last) return char;
      return replacementChar;
    }).join('');
  }

  /** 被替换掉的字符个数，界面上做提示用。 */
  function obfuscatedCount(text, opts) {
    opts = opts || {};
    var before = Array.from(String(text == null ? '' : text));
    var after = Array.from(obfuscateString(text, opts));
    var diff = 0;
    for (var i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) diff++;
    }
    return diff;
  }

  /**
   * 横排选项里的一栏：上面一个普通 div 小标题，下面才是控件。
   *
   * 原版那三个小标题（"Keep first:" / "Keep last:" / "Keep spaces:"）
   * 就是 <div>，不是 <label> —— 所以这里也不用 label，
   * 整页只有主输入框那一个「看得见的」标签。
   *
   * @param {string} captionText 小标题文字
   * @param {HTMLElement} control 控件
   * @param {boolean} [gapUnderCaption] 小标题下面留一段空白（开关那栏用）：
   *        开关比数字框矮，留了这道缝才跟旁边的输入框上下对齐。
   */
  function optionColumn(captionText, control, gapUnderCaption) {
    return D.h('div', null,
      D.h('div', { style: { marginBottom: gapUnderCaption ? '8px' : '0px' }, text: captionText }),
      control);
  }

  window.ItTools.register('string-obfuscator', function (root) {
    var textInput = D.h('textarea.layui-textarea', {
      rows: 4, placeholder: t('input_ph', 'Enter string to obfuscate')
    });
    textInput.value = 'Lorem ipsum dolor sit amet';

    // 数字框给个固定宽度：横排以后每一栏的宽度由内容决定，
    // 不定宽的话浏览器会拿 input 的默认固有宽度（size=20）来算，
    // 四栏一排就撑破 600px 的正文宽度了。
    var keepFirst = D.h('input.layui-input#so-first', { type: 'number', min: 0, step: 1, value: 4, style: { width: '150px' } });
    var keepLast = D.h('input.layui-input#so-last', { type: 'number', min: 0, step: 1, value: 4, style: { width: '150px' } });
    var replacement = D.h('input.layui-input#so-repl', { type: 'text', maxlength: 4, value: '*', style: { width: '80px' } });

    // 原版的开关是「光杆」的 n-switch，文字在上方的小标题里，
    // 所以这里也不带行内文字，文字留作 title/aria-label。
    var keepSpaceInput = D.h('input', { type: 'checkbox', checked: true, 'aria-label': t('keep_spaces', 'Keep spaces') });
    var keepSpace = D.h('label.switch', { title: t('keep_spaces', 'Keep spaces') }, keepSpaceInput,
      D.h('span'));

    var resultBox = D.h('pre.mono-output');
    var badge = D.h('span.badge-note');

    function render() {
      var opts = {
        keepFirst: Number(keepFirst.value),
        keepLast: Number(keepLast.value),
        replacementChar: replacement.value,
        keepSpace: keepSpaceInput.checked
      };
      var result = obfuscateString(textInput.value, opts);
      resultBox.textContent = result;
      badge.textContent = t('hidden_count', '{n} character(s) hidden')
        .replace('{n}', obfuscatedCount(textInput.value, opts));
    }

    [textInput, keepFirst, keepLast, replacement, keepSpaceInput].forEach(function (el) {
      el.addEventListener('input', render);
      el.addEventListener('change', render);
    });

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'String to obfuscate:'), textInput, { wide: true }),
      // 原版这里是 <div mt-4 flex gap-10px>：几个选项横排成几栏，
      // 每栏上面一个普通 div 小标题，下面才是控件；小标题不是 <label>。
      // 我们多一个「替换字符」选项，排在原版那三栏后面，凑成四栏。
      // 上面的 .field 自带 16px 下边距，栏与栏之间再留 10px 缝。
      D.h('div', { style: { display: 'flex', gap: '10px' } },
        optionColumn(t('keep_first', 'Keep first:'), keepFirst),
        optionColumn(t('keep_last', 'Keep last:'), keepLast),
        optionColumn(t('keep_spaces_label', 'Keep spaces:'), keepSpace, true),
        optionColumn(t('replacement_char', 'Replacement character:'), replacement)
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('result', 'Obfuscated string') }),
        U.copyButton(function () { return resultBox.textContent; })
      ),
      resultBox,
      D.h('div.form-actions', null, badge)
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['string-obfuscator'] = {
    obfuscateString: obfuscateString,
    obfuscatedCount: obfuscatedCount,
    __cases: function (assert) {
      // 与参考实现的 vitest 用例一致
      assert.eq(obfuscateString('1234567890'), '1234******', '默认保留前 4 位');
      assert.eq(obfuscateString('1234567890', { replacementChar: 'x' }), '1234xxxxxx', '自定义替换字符');
      assert.eq(obfuscateString('1234567890', { keepFirst: 5 }), '12345*****', '保留前 5 位');
      assert.eq(obfuscateString('1234567890', { keepFirst: 0, keepLast: 5 }), '*****67890', '只保留后 5 位');
      assert.eq(obfuscateString('1234567890', { keepFirst: 5, keepLast: 5 }), '1234567890', '前后加起来超长时整串保留');
      assert.eq(obfuscateString('1234567890', { keepFirst: 2, keepLast: 2, replacementChar: 'x' }), '12xxxxxx90', '前后各 2 位');
      assert.eq(obfuscateString('12345 67890'), '1234* *****', '默认保留空格');
      assert.eq(obfuscateString('12345 67890', { keepSpace: false }), '1234*******', '不保留空格');

      // 边界
      assert.eq(obfuscateString(''), '', '空串');
      assert.eq(obfuscateString('abc', { keepFirst: 0, keepLast: 0 }), '***', '全盖');
      assert.eq(obfuscateString('abc', { keepFirst: 99 }), 'abc', 'keepFirst 超过长度按长度算');
      assert.eq(obfuscateString('abc', { keepFirst: 0, keepLast: 99 }), 'abc', 'keepLast 超过长度按长度算');
      assert.eq(obfuscateString('abc', { keepFirst: -5, keepLast: -5 }), '***', '负数按 0 处理');
      assert.eq(obfuscateString('abc', { keepFirst: 0, keepLast: 0, replacementChar: '' }), '', '空替换字符会真的删掉字符');
      assert.eq(obfuscateString('abc', { keepFirst: 0, keepLast: 0, replacementChar: '**' }), '******', '替换字符可以是多个字符');

      // 修掉的行为：按码点切，空白不止半角空格
      assert.eq(obfuscateString('😀😀😀', { keepFirst: 1 }), '😀**', 'emoji 不会被劈开');
      assert.eq(Array.from(obfuscateString('😀😀😀', { keepFirst: 1 })).length, 3, '输出与输入等长');
      assert.eq(obfuscateString('a\tb\nc', { keepFirst: 1 }), 'a\t*\n*', '制表符与换行也算空白');

      assert.eq(obfuscatedCount('1234567890'), 6, '统计被盖住的字符数');
      assert.eq(obfuscatedCount('1234567890', { keepFirst: 5, keepLast: 5 }), 0, '整串保留时是 0');
    }
  };
})();