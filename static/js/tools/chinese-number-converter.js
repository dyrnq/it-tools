/* ==========================================================================
   中文数字转换器（chinese-number-converter）

   阿拉伯数字 ↔ 中文数字双向转换。

     · 方向：阿拉伯数字 → 中文数字 / 中文数字 → 阿拉伯数字
     · 风格：大写（零壹贰叁肆伍陆柒捌玖，财务用法）/ 小写（零一二三四五六七八九，日常用法）
     · 模式：人民币金额（元/角/分/整）/ 普通数字（小数逐位读，用「点」分隔）

   参考实现：src/tools/chinese-numeral-converter/（it-tools, GPLv3, PR #1863）。
   取的是其中的 .models.ts 纯逻辑，界面用 layui + 原生 DOM 重写。

   ---- 与参考实现的差别 ----
   1. 参考实现只有「阿拉伯数字 → 中文数字」一个方向，这里补上了反向。
   2. 参考实现金额模式的小数用 Number 算，浮点误差会吞掉「元」那部分
      （1.005 静默截成 1.00）；这里全程用十进制字符串算，角/分以「分」
      为单位累加，不碰浮点，16 位整数也不会掉精度。
   3. 参考实现只认简体和它那两套字表；这里输入端还认繁体与异体字
      （貳/參/陸/萬/億/圓/負/〇 等）。
   4. 参考实现非法输入返回英文错误串；这里返回错误码，由界面翻成中文。
   5. 参考实现不认全角数字；这里先把全角数字折成半角再解析。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;

  /* 文案翻译。
     Rust 侧的 i18n 单测（src/i18n.rs 里的 scan_text_calls）只认「函数名
     就是 t、后面紧跟左括号」的调用 —— 换个变量名就扫不到，语言包也就不会
     生成对应条目，界面会一直显示英文兜底。
     所以这里用 CN.t(...) 而不是把翻译函数存成别的变量名：既扫得到，
     又不会遮蔽 window.ItTools.t。 */
  var CN = { t: window.ItTools.t('chinese-number-converter') };

  /* ---------- 数字表 ---------- */

  // 大写（财务）：零壹贰叁肆伍陆柒捌玖
  var UPPER_DIGITS = '零壹贰叁肆伍陆柒捌玖';
  // 小写（日常）：零一二三四五六七八九
  var LOWER_DIGITS = '零一二三四五六七八九';
  // 节内单位：一节 4 位，从高位到低位
  var UPPER_GROUP_UNITS = ['仟', '佰', '拾'];
  var LOWER_GROUP_UNITS = ['千', '百', '十'];
  // 节单位：每节 4 位，索引即 10 的幂次（万=4、亿=8、兆=12）
  var SECTION_UNITS = ['', '万', '亿', '兆'];

  var MAX_INTEGER_DIGITS = SECTION_UNITS.length * 4;   // 16
  var MAX_CURRENCY_DECIMALS = 2;
  var MAX_PLAIN_DECIMALS = 9;

  // 解析用的数字表：小写 + 大写 + 繁体/异体字
  var DIGIT_MAP = {
    '零': 0, '〇': 0,
    '一': 1, '壹': 1, '幺': 1,
    '二': 2, '两': 2, '兩': 2, '贰': 2, '貳': 2, '弍': 2,
    '三': 3, '叁': 3, '參': 3, '参': 3,
    '四': 4, '肆': 4,
    '五': 5, '伍': 5,
    '六': 6, '陆': 6, '陸': 6,
    '七': 7, '柒': 7,
    '八': 8, '捌': 8,
    '九': 9, '玖': 9
  };
  // 节内单位（十/百/千）
  var SMALL_UNIT_MAP = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };
  // 节单位（万/亿/兆），值是 10 的幂次
  var BIG_UNIT_MAP = { '万': 4, '萬': 4, '亿': 8, '億': 8, '兆': 12 };
  // 「元」
  var YUAN_MAP = { '元': 1, '圆': 1, '圓': 1 };
  // 负号
  var NEGATIVE_CHARS = { '负': 1, '負': 1 };

  /* ---------- 十进制字符串运算（全程不碰浮点） ---------- */

  /** 去掉前导零，保留至少一位。 */
  function normalizeDec(s) {
    var out = String(s).replace(/^0+(?=\d)/, '');
    return out;
  }

  /** 两个非负十进制整数字符串相加。 */
  function addDec(a, b) {
    var i = a.length - 1;
    var j = b.length - 1;
    var carry = 0;
    var out = [];
    while (i >= 0 || j >= 0 || carry) {
      var sum = carry;
      if (i >= 0) sum += a.charCodeAt(i--) - 48;
      if (j >= 0) sum += b.charCodeAt(j--) - 48;
      out.push(String.fromCharCode(48 + (sum % 10)));
      carry = sum >= 10 ? 1 : 0;
    }
    return normalizeDec(out.reverse().join(''));
  }

  /** 十进制整数串乘 10 的 zeros 次方（就是后面补 zeros 个 0）。 */
  function shiftDec(s, zeros) {
    var base = normalizeDec(s);
    var tail = '';
    for (var i = 0; i < zeros; i++) tail += '0';
    return base + tail;
  }

  /** 补成 4 位。 */
  function pad4(s) {
    var out = String(s);
    while (out.length < 4) out = '0' + out;
    return out;
  }

  /* ---------- 阿拉伯数字 → 中文数字 ---------- */

  function digitsFor(style) {
    return style === 'lowercase' ? LOWER_DIGITS : UPPER_DIGITS;
  }

  function groupUnitsFor(style) {
    return style === 'lowercase' ? LOWER_GROUP_UNITS : UPPER_GROUP_UNITS;
  }

  /**
   * 把一节（4 位，已补零）转成中文，不带节单位。
   * 零的处理：连续多个 0 只出一个「零」，节尾的 0 不出。
   */
  function groupToChinese(paddedGroup, style) {
    var digits = digitsFor(style);
    var units = groupUnitsFor(style);
    var result = '';
    var zeroPending = false;

    for (var index = 0; index < paddedGroup.length; index++) {
      var digit = Number(paddedGroup.charAt(index));
      if (digit === 0) {
        zeroPending = result !== '';
        continue;
      }
      if (zeroPending) {
        result += digits.charAt(0);
        zeroPending = false;
      }
      var unit = index === paddedGroup.length - 1 ? '' : units[index];
      result += digits.charAt(digit) + unit;
    }
    return result;
  }

  /**
   * 整数部分（纯数字串，无符号无分隔符）转中文。
   * 4 位一节，节单位依次是 万/亿/兆；节与节之间空着时补一个「零」。
   */
  function integerToChinese(integer, style) {
    var digits = digitsFor(style);
    var sections = [];
    for (var end = integer.length; end > 0; end -= 4) {
      sections.unshift(integer.slice(Math.max(0, end - 4), end));
    }

    var result = '';
    var zeroPending = false;

    sections.forEach(function (section, index) {
      var unit = SECTION_UNITS[sections.length - 1 - index] || '';
      var padded = pad4(section);
      var groupText = groupToChinese(padded, style);

      if (groupText) {
        // 本节高位是 0（或者上一节整节为 0）时，两节之间要读一个「零」：
        // 一亿零一万零一。
        if (result && (zeroPending || padded.charAt(0) === '0')) {
          result += digits.charAt(0);
        }
        result += groupText + unit;
        zeroPending = false;
      } else {
        zeroPending = result !== '';
      }
    });

    result = result || digits.charAt(0);

    // 日常读法里「一十五」读作「十五」；财务大写保留「壹拾」，防涂改。
    if (style === 'lowercase' && result.indexOf('一十') === 0) {
      result = result.slice(1);
    }
    return result;
  }

  /**
   * 角/分。linkZero 表示「元」那部分存在、角为零时要补一个连接用的「零」
   * （壹元零伍分）。
   */
  function decimalsToRmb(decimals, digits, linkZero) {
    var jiao = Number(decimals.charAt(0) || 0);
    var fen = Number(decimals.charAt(1) || 0);
    var result = '';

    if (jiao !== 0) result += digits.charAt(jiao) + '角';
    if (fen !== 0) {
      if (jiao === 0 && linkZero) result += digits.charAt(0);
      result += digits.charAt(fen) + '分';
    }
    return result;
  }

  /** 全角数字/符号折成半角。 */
  function normalizeWidth(s) {
    return String(s)
      .replace(/[０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .replace(/[．]/g, '.')
      .replace(/[＋]/g, '+')
      .replace(/[－−﹣]/g, '-');
  }

  /**
   * 阿拉伯数字 → 中文数字。
   * @param {string} input
   * @param {{style?: string, currency?: boolean}} options
   * @returns {{result?: string, error?: string}}
   */
  function convertToChinese(input, options) {
    var opts = options || {};
    var style = opts.style === 'lowercase' ? 'lowercase' : 'uppercase';
    var currency = !!opts.currency;

    var cleaned = normalizeWidth(input == null ? '' : input).trim().replace(/[,，\s¥￥]/g, '');
    if (!cleaned.length) return { error: 'empty' };

    var negative = false;
    if (cleaned.charAt(0) === '-') {
      negative = true;
      cleaned = cleaned.slice(1);
    }
    else if (cleaned.charAt(0) === '+') {
      cleaned = cleaned.slice(1);
    }
    if (!cleaned.length) return { error: 'invalid' };
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return { error: 'invalid' };

    var parts = cleaned.split('.');
    var integer = parts[0].replace(/^0+(?=\d)/, '');
    var decimal = parts.length > 1 ? parts[1] : '';

    if (integer.length > MAX_INTEGER_DIGITS) {
      return { error: 'too_many_digits', max: MAX_INTEGER_DIGITS };
    }
    // 「-0」没有意义，直接判非法
    if (negative && integer === '0' && !decimal.length) return { error: 'invalid' };

    var sign = negative ? '负' : '';
    var digits = digitsFor(style);

    if (!currency) {
      if (!decimal.length) {
        return { result: sign + integerToChinese(integer, style) };
      }
      if (decimal.length > MAX_PLAIN_DECIMALS) {
        return { error: 'too_many_decimals', max: MAX_PLAIN_DECIMALS };
      }
      // 小数逐位读：3.1415926 → 三点一四一五九二六
      var trimmed = decimal.replace(/0+$/, '');
      var decimalText = '';
      for (var i = 0; i < trimmed.length; i++) {
        decimalText += digits.charAt(Number(trimmed.charAt(i)));
      }
      return { result: sign + integerToChinese(integer, style) + '点' + (decimalText || digits.charAt(0)) };
    }

    if (decimal.length > MAX_CURRENCY_DECIMALS) {
      return { error: 'too_many_decimals', max: MAX_CURRENCY_DECIMALS };
    }

    var isZeroAmount = integer === '0' && (!decimal.length || Number(decimal) === 0);
    if (isZeroAmount) return { result: digits.charAt(0) + '元整' };

    var hasJiao = decimal.length > 0 && decimal.charAt(0) !== '0';
    var hasFen = decimal.length > 1 && decimal.charAt(1) !== '0';

    var result = sign + (integer === '0' ? '' : integerToChinese(integer, style) + '元');
    if (!decimal.length || (!hasJiao && !hasFen)) return { result: result + '整' };

    result += decimalsToRmb(decimal, digits, integer !== '0');
    // 有角无分时补「整」：壹元伍角整
    if (hasJiao && !hasFen) result += '整';
    return { result: result };
  }

  /* ---------- 中文数字 → 阿拉伯数字 ---------- */

  /**
   * 解析一节（不含节单位）的值，返回 0~9999 的数字；无法解析返回 null。
   *
   * 一节里出现过十/百/千就按「单位 + 数字」读（壹佰零壹）；
   * 一个单位都没有就按数字逐位读（二零三 = 203）。
   */
  function parseGroup(text) {
    if (!text.length) return 0;

    var hasUnit = false;
    var i;
    for (i = 0; i < text.length; i++) {
      if (SMALL_UNIT_MAP[text.charAt(i)] !== undefined) {
        hasUnit = true;
        break;
      }
    }

    if (!hasUnit) {
      var positional = 0;
      for (i = 0; i < text.length; i++) {
        var digit = DIGIT_MAP[text.charAt(i)];
        if (digit === undefined) return null;
        positional = positional * 10 + digit;
      }
      return positional;
    }

    var number = 0;
    var pending = null;
    for (i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var value = DIGIT_MAP[ch];
      if (value !== undefined) {
        pending = value;
        continue;
      }
      var unit = SMALL_UNIT_MAP[ch];
      if (unit === undefined) return null;
      // 「十」前面没有数字时按 1 读（十五 = 15）
      number += (pending === null ? 1 : pending) * unit;
      pending = null;
    }
    if (pending !== null) number += pending;
    return number;
  }

  /**
   * 解析中文整数部分（只含数字字/节内单位/节单位），返回十进制字符串。
   *
   * 节单位是「节」级的：万 = 10^4、亿 = 10^8、兆 = 10^12。
   * 「万亿」这种单位逆序的写法也认：万先到就先进「万」累加器，
   * 遇到亿时把累加器整体乘 10^8。
   */
  function parseChineseInteger(text) {
    if (!text.length) return { value: '0' };

    var segments = [];
    var buffer = '';
    var i;
    for (i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var exp = BIG_UNIT_MAP[ch];
      if (exp !== undefined) {
        segments.push({ text: buffer, exp: exp });
        buffer = '';
      }
      else {
        buffer += ch;
      }
    }
    segments.push({ text: buffer, exp: null });

    var total = '0';
    var section = '0';

    for (i = 0; i < segments.length; i++) {
      var group = parseGroup(segments[i].text);
      if (group === null) return { error: 'invalid_chinese' };
      var exponent = segments[i].exp;

      if (exponent === null) {
        total = addDec(total, addDec(section, String(group)));
      }
      else if (exponent === 4) {
        section = addDec(section, shiftDec(String(group), 4));
      }
      else {
        // 亿（10^8）与兆（10^12）：此前累积的「万」倍数整体升到这一级
        total = addDec(total, shiftDec(addDec(section, String(group)), exponent));
        section = '0';
      }
    }
    return { value: total };
  }

  /**
   * 解析角/分，返回「分」的个数（0~99）。分前面的数字是分值，
   * 角前面的数字是角值。
   */
  function parseFraction(text) {
    var cents = 0;
    var pending = null;
    var seenJiao = false;
    var seenFen = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '零' || ch === '〇') {
        pending = 0;
        continue;
      }
      var digit = DIGIT_MAP[ch];
      if (digit !== undefined) {
        pending = digit;
        continue;
      }
      if (ch === '角') {
        if (seenJiao) return null;
        seenJiao = true;
        cents += (pending === null ? 0 : pending) * 10;
        pending = null;
        continue;
      }
      if (ch === '分') {
        if (seenFen) return null;
        seenFen = true;
        cents += (pending === null ? 0 : pending);
        pending = null;
        continue;
      }
      return null;
    }
    // 「伍分」后面不该再跟个光秃秃的数字
    if (pending !== null) return null;
    return cents;
  }

  /**
   * 中文数字 → 阿拉伯数字。
   * @param {string} input
   * @param {{currency?: boolean}} options
   * @returns {{result?: string, error?: string}}
   */
  function convertToArabic(input, options) {
    var opts = options || {};
    var currency = !!opts.currency;

    var text = String(input == null ? '' : input).replace(/[\s,，]/g, '');
    if (!text.length) return { error: 'empty' };

    var negative = false;
    if (NEGATIVE_CHARS[text.charAt(0)]) {
      negative = true;
      text = text.slice(1);
      if (!text.length) return { error: 'invalid_chinese' };
    }

    var integerText;
    var fractionText;

    if (currency) {
      // 结尾的「整」是修饰语，去掉
      if (text.charAt(text.length - 1) === '整') text = text.slice(0, -1);
      if (!text.length) return { error: 'invalid_chinese' };

      var yuanAt = -1;
      var jiaoAt = -1;
      var fenAt = -1;
      for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        if (yuanAt < 0 && YUAN_MAP[ch]) yuanAt = i;
        if (jiaoAt < 0 && ch === '角') jiaoAt = i;
        if (fenAt < 0 && ch === '分') fenAt = i;
      }

      // 金额的写法是「整数 + 角值 + 角 + 分值 + 分」。
      // 有「元」时，元后面第一位就是角值；没有「元」时，角/分前面那一位
      // 才是角值/分值（壹佰伍角 = 100.5，伍分 = 0.05）。
      if (yuanAt >= 0) {
        integerText = text.slice(0, yuanAt);
        fractionText = text.slice(yuanAt + 1);
      }
      else if (jiaoAt >= 0) {
        integerText = text.slice(0, Math.max(0, jiaoAt - 1));
        fractionText = text.slice(Math.max(0, jiaoAt - 1));
      }
      else if (fenAt >= 0) {
        integerText = text.slice(0, Math.max(0, fenAt - 1));
        fractionText = text.slice(Math.max(0, fenAt - 1));
      }
      else {
        integerText = text;
        fractionText = '';
      }

      var parsed = parseChineseInteger(integerText);
      if (parsed.error) return parsed;

      var cents = parseFraction(fractionText);
      if (cents === null) return { error: 'invalid_chinese' };

      if (parsed.value.length > MAX_INTEGER_DIGITS) {
        return { error: 'too_many_digits', max: MAX_INTEGER_DIGITS };
      }

      var result = parsed.value;
      if (cents > 0) {
        var tail = cents < 10 ? '0' + cents : String(cents);
        // 角为 0 时补零（1.05 而不是 1.5）
        if (cents % 10 === 0) tail = String(cents / 10);
        result += '.' + tail;
      }
      return { result: negative ? '-' + result : result };
    }

    // 普通数字模式：小数用「点」分隔，逐位读
    var pointAt = text.indexOf('点');
    if (pointAt >= 0) {
      integerText = text.slice(0, pointAt);
      fractionText = text.slice(pointAt + 1);
    }
    else {
      integerText = text;
      fractionText = '';
    }

    var plain = parseChineseInteger(integerText);
    if (plain.error) return plain;

    var digits = '';
    for (var j = 0; j < fractionText.length; j++) {
      var digitValue = DIGIT_MAP[fractionText.charAt(j)];
      if (digitValue === undefined) return { error: 'invalid_chinese' };
      digits += String(digitValue);
    }

    if (plain.value.length > MAX_INTEGER_DIGITS) {
      return { error: 'too_many_digits', max: MAX_INTEGER_DIGITS };
    }

    var out = plain.value + (digits.length ? '.' + digits : '');
    return { result: negative ? '-' + out : out };
  }

  /* ---------- 错误文案 ---------- */

  var ERROR_TEXT = {
    empty: CN.t('err_empty', 'Enter a number'),
    invalid: CN.t('err_invalid', 'Invalid number'),
    invalid_chinese: CN.t('err_invalid_chinese', 'Not a valid Chinese numeral'),
    too_many_digits: CN.t('err_too_many_digits', 'Supports up to {max} integer digits'),
    too_many_decimals: CN.t('err_too_many_decimals', 'Supports up to {max} decimal digits')
  };

  function errorText(res) {
    var text = ERROR_TEXT[res && res.error] || ERROR_TEXT.invalid;
    if (res && res.max !== undefined) text = text.replace('{max}', String(res.max));
    return text;
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('chinese-number-converter', function (root) {
    var state = {
      direction: 'toChinese',
      style: 'uppercase',
      currency: true
    };

    var listeners = [];
    function on(el, event, handler) {
      el.addEventListener(event, handler);
      listeners.push(function () { el.removeEventListener(event, handler); });
    }

    var input = D.h('textarea.layui-textarea', {
      id: 'cnc-input',
      rows: 3,
      value: '1234567.89'
    });
    var output = D.h('textarea.layui-textarea', {
      id: 'cnc-output',
      rows: 3,
      readonly: true
    });
    var status = D.h('p.form-status');

    var directionSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'toChinese', text: CN.t('dir_to_chinese', 'Arabic → Chinese') }),
      D.h('option', { value: 'toArabic', text: CN.t('dir_to_arabic', 'Chinese → Arabic') })
    );
    directionSelect.value = state.direction;

    var styleSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'uppercase', text: CN.t('style_uppercase', 'Uppercase (壹贰叁)') }),
      D.h('option', { value: 'lowercase', text: CN.t('style_lowercase', 'Lowercase (一二三)') })
    );
    styleSelect.value = state.style;

    var currencyBox = D.h('input', { type: 'checkbox' });
    currencyBox.checked = state.currency;

    var inputField = U.field(CN.t('label_arabic', 'Arabic number:'), input, { wide: true });
    var outputField = U.field(CN.t('label_result', 'Result:'), output, { wide: true });
    inputField.style.marginBottom = '16px';
    outputField.style.marginBottom = '8px';
    var inputLabel = inputField.querySelector('.field-label');

    var copyButton = U.copyButton(function () { return output.value; }, CN.t('copy_result', 'Copy result'));

    function optionRow(labelText, control, hint) {
      return D.h('div.field-row', null,
        D.h('label.field-label', { text: labelText }),
        control,
        hint ? D.h('span.field-hint', { text: hint }) : null
      );
    }

    function render() {
      var res = state.direction === 'toChinese'
        ? convertToChinese(input.value, { style: state.style, currency: state.currency })
        : convertToArabic(input.value, { currency: state.currency });

      if (res.error) {
        output.value = '';
        status.textContent = errorText(res);
        status.classList.add('is-error');
      }
      else {
        output.value = res.result;
        status.textContent = '';
        status.classList.remove('is-error');
      }
    }

    function applyDirection() {
      var toChinese = state.direction === 'toChinese';
      inputLabel.textContent = toChinese
        ? CN.t('label_arabic', 'Arabic number:')
        : CN.t('label_chinese', 'Chinese numeral:');
      input.placeholder = toChinese
        ? CN.t('ph_arabic', 'e.g. 1234567.89')
        : CN.t('ph_chinese', 'e.g. 壹仟贰佰叁拾肆元伍角陆分');
      // 风格只影响中文输出，反向时没有意义
      styleSelect.disabled = !toChinese;
      render();
    }

    on(directionSelect, 'change', function () {
      state.direction = directionSelect.value === 'toArabic' ? 'toArabic' : 'toChinese';
      applyDirection();
    });
    on(styleSelect, 'change', function () {
      state.style = styleSelect.value === 'lowercase' ? 'lowercase' : 'uppercase';
      render();
    });
    on(currencyBox, 'change', function () {
      state.currency = currencyBox.checked;
      render();
    });
    on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: CN.t('card_input', 'Number to convert') }),
      optionRow(CN.t('direction', 'Direction:'), directionSelect),
      optionRow(CN.t('style', 'Numeral style:'), styleSelect, CN.t('hint_style', 'Only affects the Chinese output.')),
      D.h('div.form-actions', null,
        D.h('label.switch', null, currencyBox, D.h('span', { text: CN.t('currency', 'Read as an RMB amount (元/角/分)') }))
      ),
      inputField,
      D.h('p.field-hint', { text: CN.t('hint_chinese_input', 'Simplified and traditional characters are both accepted.') })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: CN.t('card_output', 'Conversion result') }),
      outputField,
      status,
      D.h('div.form-actions', null, copyButton)
    ));

    applyDirection();

    return {
      destroy: function () {
        listeners.forEach(function (off) { off(); });
        listeners = [];
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（供 node 侧的 jsdom 测试调用） ---------- */

  window.ItTools.logic['chinese-number-converter'] = {
    convertToChinese: convertToChinese,
    convertToArabic: convertToArabic,
    integerToChinese: integerToChinese,
    parseChineseInteger: parseChineseInteger,
    parseGroup: parseGroup,
    MAX_INTEGER_DIGITS: MAX_INTEGER_DIGITS,
    __cases: function (assert) {
      // 金额模式、大写：与参考实现的 vitest 用例逐条对齐
      var rmb = function (value) {
        return convertToChinese(value, { style: 'uppercase', currency: true });
      };
      var plain = function (value, style) {
        return convertToChinese(value, { style: style || 'lowercase', currency: false });
      };

      assert.eq(rmb('0').result, '零元整', '0 元');
      assert.eq(rmb('1').result, '壹元整', '1 元');
      assert.eq(rmb('10').result, '壹拾元整', '10 元');
      assert.eq(rmb('15').result, '壹拾伍元整', '15 元');
      assert.eq(rmb('110').result, '壹佰壹拾元整', '110 元');
      assert.eq(rmb('1001').result, '壹仟零壹元整', '1001 元');
      assert.eq(rmb('10000').result, '壹万元整', '1 万元');
      assert.eq(rmb('10001').result, '壹万零壹元整', '10001 元');
      assert.eq(rmb('100000001').result, '壹亿零壹元整', '1 亿零 1 元');
      assert.eq(rmb('100010001').result, '壹亿零壹万零壹元整', '1 亿零 1 万零 1 元');
      assert.eq(rmb('123456789').result, '壹亿贰仟叁佰肆拾伍万陆仟柒佰捌拾玖元整', '123456789 元');
      assert.eq(rmb('123405001').result, '壹亿贰仟叁佰肆拾万伍仟零壹元整', '节内有空零');
      assert.eq(rmb('123450001').result, '壹亿贰仟叁佰肆拾伍万零壹元整', '节尾的空零');
      assert.eq(rmb('1000000000000').result, '壹兆元整', '1 兆');
      assert.eq(rmb('1000000000000000').result, '壹仟兆元整', '1000 兆（16 位整数不丢精度）');

      assert.eq(rmb('1234.56').result, '壹仟贰佰叁拾肆元伍角陆分', '带角分');
      assert.eq(rmb('1.05').result, '壹元零伍分', '角为零要补零');
      assert.eq(rmb('1.50').result, '壹元伍角整', '有角无分补「整」');
      assert.eq(rmb('1.5').result, '壹元伍角整', '一位小数也是角');
      assert.eq(rmb('0.15').result, '壹角伍分', '不足 1 元');
      assert.eq(rmb('0.05').result, '伍分', '只有分');
      assert.eq(rmb('5.00').result, '伍元整', '元整');
      assert.eq(rmb('0.00').result, '零元整', '零元整');
      assert.eq(rmb('10.02').result, '壹拾元零贰分', '元 + 分');

      assert.eq(rmb('-123').result, '负壹佰贰拾叁元整', '负数');
      assert.eq(rmb('001234.56').result, '壹仟贰佰叁拾肆元伍角陆分', '前导零');
      assert.eq(rmb('¥1,234.56').result, '壹仟贰佰叁拾肆元伍角陆分', '¥ 与千分位');
      assert.eq(rmb('￥1,234.56').result, '壹仟贰佰叁拾肆元伍角陆分', '￥ 与千分位');
      assert.eq(rmb('＋123').result, '壹佰贰拾叁元整', '全角加号');
      assert.eq(rmb('１２３').result, '壹佰贰拾叁元整', '全角数字');

      assert.eq(rmb('').error, 'empty', '空输入是错误');
      assert.eq(rmb('abc').error, 'invalid', '非数字是错误');
      assert.eq(rmb('1.234').error, 'too_many_decimals', '金额只支持两位小数');
      assert.eq(rmb('-').error, 'invalid', '光秃秃的负号是错误');
      assert.eq(rmb('-0').error, 'invalid', '负零没有意义');
      assert.eq(rmb('1.234').max, 2, '金额小数上限是 2');
      assert.eq(rmb('1'.repeat(17)).error, 'too_many_digits', '整数最多 16 位');
      assert.eq(rmb('1'.repeat(17)).max, 16, '整数位数上限是 16');

      // 普通数字模式、小写
      assert.eq(plain('0').result, '零', '0');
      assert.eq(plain('10').result, '十', '10 的日常读法不带「一」');
      assert.eq(plain('15').result, '十五', '15');
      assert.eq(plain('110').result, '一百一十', '110');
      assert.eq(plain('1001').result, '一千零一', '1001');
      assert.eq(plain('10000').result, '一万', '1 万');
      assert.eq(plain('100010001').result, '一亿零一万零一', '1 亿零 1 万零 1');
      assert.eq(plain('123405001').result, '一亿二千三百四十万五千零一', '节内有空零');
      assert.eq(plain('1000000000').result, '十亿', '10 亿');
      assert.eq(plain('10', 'uppercase').result, '壹拾', '大写保留「壹拾」');
      assert.eq(plain('110', 'uppercase').result, '壹佰壹拾', '大写 110');
      assert.eq(plain('3.1415926').result, '三点一四一五九二六', '小数逐位读');
      assert.eq(plain('0.5').result, '零点五', '小数逐位读');
      assert.eq(plain('-2.5', 'uppercase').result, '负贰点伍', '负小数');
      assert.eq(plain('1.1234567890').error, 'too_many_decimals', '普通模式最多 9 位小数');
      assert.eq(plain('1.1234567890').max, 9, '普通模式小数上限是 9');

      // 中文数字 → 阿拉伯数字（金额模式）
      var toNum = function (value) {
        return convertToArabic(value, { currency: true });
      };
      var toNumPlain = function (value) {
        return convertToArabic(value, { currency: false });
      };

      assert.eq(toNum('零元整').result, '0', '零元整');
      assert.eq(toNum('壹元整').result, '1', '壹元整');
      assert.eq(toNum('壹拾元整').result, '10', '壹拾元整');
      assert.eq(toNum('壹佰壹拾元整').result, '110', '壹佰壹拾元整');
      assert.eq(toNum('壹仟零壹元整').result, '1001', '壹仟零壹元整');
      assert.eq(toNum('壹万元整').result, '10000', '壹万元整');
      assert.eq(toNum('壹万零壹元整').result, '10001', '壹万零壹元整');
      assert.eq(toNum('壹亿零壹元整').result, '100000001', '壹亿零壹元整');
      assert.eq(toNum('壹亿零壹万零壹元整').result, '100010001', '壹亿零壹万零壹元整');
      assert.eq(toNum('壹亿贰仟叁佰肆拾伍万陆仟柒佰捌拾玖元整').result, '123456789', '十二位数');
      assert.eq(toNum('壹亿贰仟叁佰肆拾万伍仟零壹元整').result, '123405001', '节内空零');
      assert.eq(toNum('壹兆元整').result, '1000000000000', '1 兆');
      assert.eq(toNum('壹仟兆元整').result, '1000000000000000', '1000 兆');

      assert.eq(toNum('壹仟贰佰叁拾肆元伍角陆分').result, '1234.56', '角分');
      assert.eq(toNum('壹元零伍分').result, '1.05', '角为零补零');
      assert.eq(toNum('壹元伍角整').result, '1.5', '有角无分');
      assert.eq(toNum('壹角伍分').result, '0.15', '不足 1 元');
      assert.eq(toNum('伍分').result, '0.05', '只有分');
      assert.eq(toNum('壹拾元零贰分').result, '10.02', '元 + 分');
      assert.eq(toNum('壹佰伍角').result, '100.5', '没有「元」时的角');
      assert.eq(toNum('壹佰零伍角').result, '100.5', '零是整数位上的占位，不是角位');
      assert.eq(toNum('壹佰').result, '100', '没有「元」也没有角分');
      assert.eq(toNum('负壹佰贰拾叁元整').result, '-123', '负数');

      // 小写与繁体
      assert.eq(toNum('十元整').result, '10', '小写十');
      assert.eq(toNum('十五元整').result, '15', '小写十五');
      assert.eq(toNum('一百一十元整').result, '110', '小写一百一十');
      assert.eq(toNum('一千零一元整').result, '1001', '小写一千零一');
      assert.eq(toNum('一亿零一万零一元整').result, '100010001', '小写一亿零一万零一');
      assert.eq(toNum('一亿二千三百四十万五千零一元整').result, '123405001', '小写节内空零');
      assert.eq(toNum('十亿元整').result, '1000000000', '小写十亿');
      assert.eq(toNum('壹億零壹萬零壹元整').result, '100010001', '繁体壹億零壹萬');
      assert.eq(toNum('壹仟貳佰參拾肆元伍角陸分').result, '1234.56', '繁体角分');
      assert.eq(toNum('負壹佰貳拾參元整').result, '-123', '繁体负号');
      assert.eq(toNum('兩萬元整').result, '20000', '「兩」当二读');
      assert.eq(toNum('一万亿元整').result, '1000000000000', '「万亿」= 10^12');
      assert.eq(toNum('零五分').result, '0.05', '零分值');

      // 普通数字模式（小数用「点」）
      assert.eq(toNumPlain('三点一四一五九二六').result, '3.1415926', '小数逐位读');
      assert.eq(toNumPlain('零点五').result, '0.5', '零点五');
      assert.eq(toNumPlain('负二点五').result, '-2.5', '负小数');
      assert.eq(toNumPlain('一百一十').result, '110', '小写整数');
      assert.eq(toNumPlain('一亿零一万零一').result, '100010001', '小写整数带节单位');
      assert.eq(toNumPlain('零').result, '0', '零');
      assert.eq(toNumPlain('二零三').result, '203', '纯数字写法按位读');

      // 非法输入
      assert.eq(toNum('').error, 'empty', '空输入是错误');
      assert.eq(toNum('abc').error, 'invalid_chinese', '非中文数字是错误');
      assert.eq(toNum('壹元贰角叁分肆厘').error, 'invalid_chinese', '「厘」不认');
      assert.eq(toNum('壹元贰角叁角').error, 'invalid_chinese', '两个角不认');
      assert.eq(toNum('壹元贰').error, 'invalid_chinese', '元后面光秃秃的数字不认');
      assert.eq(toNumPlain('壹元整').error, 'invalid_chinese', '普通模式不认「元」');
      assert.eq(toNumPlain('三点甲').error, 'invalid_chinese', '小数位必须是数字字');

      // 往返一致（阿拉伯 → 中文 → 阿拉伯）
      var roundTrip = [
        '0', '1', '9', '10', '15', '110', '1001', '10000', '10001', '12345',
        '100000001', '100010001', '123456789', '123405001', '1000000000',
        '1000000000000', '1000000000000000'
      ];
      roundTrip.forEach(function (value) {
        var chinese = convertToChinese(value, { style: 'uppercase', currency: false }).result;
        assert.eq(convertToArabic(chinese, { currency: false }).result, value, value + ' 往返一致');
      });
      var roundTripMoney = ['0', '1', '10', '110', '1001', '10001', '100010001', '123456789', '1.05', '0.05', '0.15', '10.02', '1234.56'];
      roundTripMoney.forEach(function (value) {
        var chinese = convertToChinese(value, { style: 'uppercase', currency: true }).result;
        assert.eq(convertToArabic(chinese, { currency: true }).result, value, value + ' 金额往返一致');
      });
      // 小写风格也往返
      roundTrip.forEach(function (value) {
        var chinese = convertToChinese(value, { style: 'lowercase', currency: false }).result;
        assert.eq(convertToArabic(chinese, { currency: false }).result, value, value + ' 小写往返一致');
      });
    }
  };
})();
