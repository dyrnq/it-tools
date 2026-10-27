/* ==========================================================================
   罗马数字转换器（roman-numeral-converter）

   阿拉伯数字 ↔ 罗马数字双向转换。罗马数字没有零、负数，也只到 3999
   （MMM），所以范围外的输入会给出提示而不是静默输出空串。

   参考实现：src/tools/roman-numeral-converter/（it-tools, GPLv3）
   与原版的差别：原版的校验正则 ^M{0,3}(...)(...)(...)$ 能匹配空串，
   于是 romanToArabic('') 返回 0（空输入显示成 0），isValidRomanNumber('')
   也返回 true；这里空串一律判为非法，与「空输入不产出结果」的预期一致。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('roman-numeral-converter');

  var MIN = 1;
  var MAX = 3999;

  /** 从大到小的符号表，贪心相减即得标准写法 */
  var LOOKUP = [
    ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400], ['C', 100], ['XC', 90],
    ['L', 50], ['XL', 40], ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]
  ];

  var VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

  // 严格的标准写法：千位不超 3 个，每一位只用合法的减法组合
  var ROMAN_RE = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

  /**
   * 阿拉伯数字转罗马数字。
   * 范围外（含 0、负数、> 3999）返回空串；小数向下取整，与原版一致。
   */
  function arabicToRoman(num) {
    var n = Number(num);
    if (!isFinite(n) || n < MIN || n > MAX) return '';
    var roman = '';
    for (var i = 0; i < LOOKUP.length; i++) {
      while (n >= LOOKUP[i][1]) {
        roman += LOOKUP[i][0];
        n -= LOOKUP[i][1];
      }
    }
    return roman;
  }

  /** 是否是合法的罗马数字写法（空串不算合法） */
  function isValidRomanNumber(s) {
    var str = String(s == null ? '' : s);
    if (!str.length) return false;
    return ROMAN_RE.test(str);
  }

  /**
   * 罗马数字转阿拉伯数字。非法写法（含空串）返回 null。
   * 减法记法（IV / IX / XL / XC / CD / CM）按「后一位更大就减」处理。
   */
  function romanToArabic(s) {
    if (!isValidRomanNumber(s)) return null;
    var str = String(s);
    var total = 0;
    for (var i = 0; i < str.length; i++) {
      var cur = VALUES[str.charAt(i)];
      var next = i + 1 < str.length ? VALUES[str.charAt(i + 1)] : 0;
      total += next > cur ? -cur : cur;
    }
    return total;
  }

  /** 解析数字输入框：空 / 非法返回 null */
  function parseNum(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s.length) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /** 「标签 + 输入框 + 只读结果 + 复制」一行，输入即算 */
  function converterRow(spec) {
    var input = D.h('input.layui-input', { type: spec.type, value: spec.value, placeholder: spec.placeholder });
    var result = D.h('input.layui-input', { type: 'text', readonly: true, value: '' });
    var hint = D.h('p.field-hint');

    function update() {
      var out = spec.compute(input.value);
      result.value = out.value;
      hint.textContent = out.hint;
      hint.style.color = out.hint ? '#d03050' : '';
    }
    input.addEventListener('input', update);
    update();

    return D.h('div', null,
      D.h('div.field-row', null,
        D.h('label.field-label', { text: spec.label }),
        input,
        result,
        U.copyButton(function () { return result.value; })
      ),
      hint
    );
  }

  /** 输入框 → { value, hint }，hint 只用于说明为什么没有结果 */
  function toRoman(raw) {
    var n = parseNum(raw);
    if (n === null) return { value: '', hint: '' };
    var out = arabicToRoman(n);
    if (out) return { value: out, hint: '' };
    return {
      value: '',
      hint: t('out_of_range', 'Only integers between {min} and {max} can be converted (Roman numerals have no zero or negative numbers, and do not go beyond MMM).')
        .replace('{min}', MIN).replace('{max}', MAX)
    };
  }

  function toArabic(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s.length) return { value: '', hint: '' };
    var out = romanToArabic(s);
    if (out === null) {
      return {
        value: '',
        hint: t('invalid_roman', 'Not a valid Roman numeral: only I V X L C D M are allowed, and each place must use a valid subtractive combination (max MMMCMXCIX).')
      };
    }
    return { value: String(out), hint: '' };
  }

  window.ItTools.register('roman-numeral-converter', function (root) {
    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('arabic_to_roman', 'Arabic to roman') }),
      converterRow({
        label: t('arabic_number', 'Arabic number'),
        type: 'number',
        value: '42',
        placeholder: t('arabic_ph', 'e.g. 42'),
        compute: toRoman
      })
    ));
    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('roman_to_arabic', 'Roman to arabic') }),
      converterRow({
        label: t('roman_numeral', 'Roman numeral'),
        type: 'text',
        value: 'XLII',
        placeholder: t('roman_ph', 'e.g. XLII'),
        compute: toArabic
      })
    ));

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['roman-numeral-converter'] = {
    MIN: MIN,
    MAX: MAX,
    LOOKUP: LOOKUP,
    arabicToRoman: arabicToRoman,
    romanToArabic: romanToArabic,
    isValidRomanNumber: isValidRomanNumber,
    __cases: function (assert) {
      // 与参考实现 vitest 用例一致的边界
      [-100, -42, -26, -10, 0, 0.5, 0.9].forEach(function (n) {
        assert.eq(arabicToRoman(n), '', '小于 1 的 ' + n + ' 应为空串');
      });
      [3999.1, 4000, 10000].forEach(function (n) {
        assert.eq(arabicToRoman(n), '', '大于 3999 的 ' + n + ' 应为空串');
      });
      assert.eq(arabicToRoman(1.1), 'I', '1.1 向下取整');
      assert.eq(arabicToRoman(1.9), 'I', '1.9 向下取整');
      assert.eq(arabicToRoman(17.6), 'XVII', '17.6 向下取整');
      assert.eq(arabicToRoman(29.999), 'XXIX', '29.999 向下取整');

      // 正整数
      var table = {
        1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII',
        9: 'IX', 10: 'X', 11: 'XI', 12: 'XII', 13: 'XIII', 14: 'XIV', 15: 'XV',
        16: 'XVI', 17: 'XVII', 18: 'XVIII', 19: 'XIX', 20: 'XX', 21: 'XXI',
        24: 'XXIV', 28: 'XXVIII', 29: 'XXIX', 30: 'XXX', 40: 'XL', 50: 'L',
        60: 'LX', 70: 'LXX', 80: 'LXXX', 90: 'XC', 100: 'C', 200: 'CC',
        300: 'CCC', 400: 'CD', 500: 'D', 600: 'DC', 700: 'DCC', 800: 'DCCC',
        900: 'CM', 999: 'CMXCIX', 1000: 'M', 2000: 'MM', 3999: 'MMMCMXCIX',
        42: 'XLII', 1987: 'MCMLXXXVII'
      };
      Object.keys(table).forEach(function (k) {
        assert.eq(arabicToRoman(Number(k)), table[k], k + ' → ' + table[k]);
      });

      // 校验
      assert(isValidRomanNumber('XLII'), 'XLII 合法');
      assert(isValidRomanNumber('MMMCMXCIX'), 'MMMCMXCIX 合法');
      assert(!isValidRomanNumber('IIII'), 'IIII 不是标准写法');
      assert(!isValidRomanNumber('ABC'), '含非法字符');
      assert(!isValidRomanNumber('IC'), '非法减法组合');
      assert(!isValidRomanNumber('MMMM'), '超过千位上限');
      // 原版的正则会把空串判为合法，这里明确排除
      assert(!isValidRomanNumber(''), '空串不算合法罗马数字');

      // 反向
      assert.eq(romanToArabic('XLII'), 42, 'XLII = 42');
      assert.eq(romanToArabic('IV'), 4, 'IV = 4');
      assert.eq(romanToArabic('MCMXCIV'), 1994, 'MCMXCIV = 1994');
      assert.eq(romanToArabic('MMMCMXCIX'), 3999, 'MMMCMXCIX = 3999');
      assert.eq(romanToArabic('IIII'), null, '非法写法返回 null');
      assert.eq(romanToArabic(''), null, '空串返回 null');

      // 1 ~ 3999 全量往返
      for (var n = 1; n <= MAX; n++) {
        if (romanToArabic(arabicToRoman(n)) !== n) {
          throw new Error('往返失败：' + n);
        }
      }
      assert(true, '1~3999 全量往返一致');
    }
  };
})();