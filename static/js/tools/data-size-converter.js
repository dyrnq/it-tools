/* ==========================================================================
   数据大小转换器（data-size-converter）

   B / KB / MB / GB / TB / PB 六个单位互转。十进制（SI，1 kB = 1000 B）与
   二进制（IEC，1 KiB = 1024 B）两套基数可以切换 —— 把 1000 和 1024 混着用
   是这类工具最常见的错误来源，所以基数是一个显眼的下拉框，而不是藏在代码里。

   参考实现：上游 PR #1863 的 src/tools/data-size-converter/（it-tools, GPLv3）
   与原版的差别（逐条）：
   1. 原版用 `value * base ** index` 做浮点乘法，1 PB 之类的大数会带上
      1.0000000000000002e+9 这种浮点尾巴；这里全程走 BigInt 精确分数
      （分子分母都是 BigInt），十进制与二进制换算一个字节都不差。
   2. 原版的 `Number.isFinite(storage.value.value)` 拿到的是输入框给的**字符串**，
      而 `Number.isFinite('42')` 恒为 false —— 于是原版永远输出 0。
      这里自己解析输入（小数、指数、前导正负号都收）。
   3. 原版用 `toFixed(12)` 截断：小数很小时会被截成 0，正常值又会拖一串
      没意义的零；这里改成「整数精确显示 + 非整数按有效数字四舍五入」，
      并去掉多余的 0（1.500 → 1.5，1000 → 1000 而不是 1e+3）。
   4. 原版输入非法时只有一句「Enter a number to convert.」，不说是哪儿错了；
      这里把错误原文显示出来（空串 / 非数字 / 指数越界各有各的说法）。
   5. 原版只能选「输入单位」；这里还认单位后缀 —— 直接输入 `1.5 GB` 就会把
      「输入单位」同步过去，IEC 名字（KiB/MiB/…）按定义强制二进制基数。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('data-size-converter');

  /* ---------- 单位表 ---------- */

  /** 六个单位，下标就是它的「级数」（B 是 0 级，KB 是 1 级…）。 */
  var UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  var BASE_DECIMAL = 1000;
  var BASE_BINARY = 1024;

  /** 有效数字的可选值（界面上的「精度」下拉）。 */
  var PRECISIONS = [2, 3, 4, 6, 8];

  /** 十进制指数的上下限 —— 再大就该用科学计数法硬撑了，没有意义。 */
  var MAX_EXPONENT = 10000;

  /** 输入里能认的单位后缀（小写比较）。 */
  var UNIT_ALIASES = {
    b: 0, byte: 0, bytes: 0,
    kb: 1, mb: 2, gb: 3, tb: 4, pb: 5,
    kib: 1, mib: 2, gib: 3, tib: 4, pib: 5
  };

  /** IEC 名字的定义就是二进制 —— 见到它们就把基数按到 1024。 */
  var IEC_ALIASES = { kib: true, mib: true, gib: true, tib: true, pib: true };

  /* ---------- 整数工具 ---------- */

  /** 10 的 n 次方（n >= 0）。用平方折叠而不是 ** BigInt，兼容老一点的引擎。 */
  function pow10(n) {
    var out = 1n;
    var base = 10n;
    var e = n;
    while (e > 0) {
      if (e & 1) out *= base;
      base *= base;
      e >>= 1;
    }
    return out;
  }

  /** 正整数的十进制位数。 */
  function digitCount(n) {
    if (n === 0n) return 1;
    return n.toString().length;
  }

  /** 去掉字符串末尾的 0。 */
  function stripZeros(s) {
    return String(s).replace(/0+$/, '');
  }

  /* ---------- 精确十进制解析 ---------- */

  var DECIMAL_RE = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/;

  /**
   * 把一段文本解析成**精确**的十进制分数 { num, den }。
   *
   * 不走 Number：浮点的尾数会把 0.1 变成 0.1000000000000000055511151231257827，
   * 换算成 KB 之后那点误差会被放大成「1 KB = 1000.0000000000001 B」。
   *
   * @param {string} raw
   * @returns {{num: bigint, den: bigint}}
   */
  function parseDecimal(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s.length) {
      throw new Error(t('err_empty', 'Enter a number to convert.'));
    }
    var m = DECIMAL_RE.exec(s);
    if (!m) {
      throw new Error(t('err_not_number', 'Not a valid number: {input}').replace('{input}', s));
    }
    var intPart = m[2] || '';
    var fracPart = m[3] || '';
    if (!intPart.length && !fracPart.length) {
      throw new Error(t('err_not_number', 'Not a valid number: {input}').replace('{input}', s));
    }
    var exponent = m[4] ? parseInt(m[4], 10) : 0;
    if (exponent > MAX_EXPONENT || exponent < -MAX_EXPONENT) {
      throw new Error(t('err_exp_range', 'The exponent is out of range (|exponent| must be at most {max}).')
        .replace('{max}', String(MAX_EXPONENT)));
    }
    var num = BigInt((intPart + fracPart) || '0');
    var den = pow10(fracPart.length);
    if (m[1] === '-') num = -num;
    if (exponent > 0) num *= pow10(exponent);
    else if (exponent < 0) den *= pow10(-exponent);
    return { num: num, den: den };
  }

  /**
   * 把「数值 + 单位」拆开。
   *
   * "1.5 GB" → { text: '1.5', unit: 'gb' }；"42" → { text: '42', unit: null }。
   * 后缀不是认识的单位时整个串当数字处理（于是会报「不是合法数字」）。
   *
   * @param {string} raw
   * @returns {{text: string, unit: string|null}}
   */
  function splitUnit(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var m = /^([+-]?[0-9]*\.?[0-9]*(?:[eE][+-]?[0-9]+)?)\s*([A-Za-z]+)$/.exec(s);
    if (!m) return { text: s, unit: null };
    var letters = m[2].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(UNIT_ALIASES, letters)) {
      return { text: s, unit: null };
    }
    return { text: m[1], unit: letters };
  }

  /* ---------- 换算 ---------- */

  /**
   * 单位名 → 级数（下标）。不认识就抛错，不静默当成 0 级。
   * @param {string} unit
   * @returns {number}
   */
  function unitIndex(unit) {
    var idx = UNITS.indexOf(unit);
    if (idx < 0) {
      throw new Error(t('err_unknown_unit', 'Unknown unit: {unit}').replace('{unit}', String(unit)));
    }
    return idx;
  }

  /**
   * base 的 k 次方。1000 与 1024 的整数次幂都是精确的：
   * 1000^k = 10^(3k)，1024^k = 2^(10k)。
   */
  function basePow(base, k) {
    if (base === BASE_DECIMAL) return pow10(3 * k);
    if (base === BASE_BINARY) return 1n << BigInt(10 * k);
    throw new Error(t('err_base', 'Unsupported base: {base}').replace('{base}', String(base)));
  }

  /**
   * 精确换算：把 value 从 from 级单位换到 to 级单位。
   *
   *   结果 = value × base^from ÷ base^to
   *
   * 全程整数运算，返回的是精确分数，不做任何浮点近似。
   *
   * @param {{num: bigint, den: bigint}} value 精确的十进制分数
   * @param {number} fromIdx 源单位级数
   * @param {number} toIdx   目标单位级数
   * @param {number} base    1000 或 1024
   * @returns {{num: bigint, den: bigint}}
   */
  function convertExact(value, fromIdx, toIdx, base) {
    return {
      num: value.num * basePow(base, fromIdx),
      den: value.den * basePow(base, toIdx)
    };
  }

  /* ---------- 精确格式化 ---------- */

  /**
   * p / den 的十进制指数：10^e <= p/den < 10^(e+1)。
   * p、den 都是正 BigInt。
   */
  function decimalExponent(p, den) {
    var e = digitCount(p) - digitCount(den);
    var diff;
    if (e >= 0) diff = p - den * pow10(e);
    else diff = p * pow10(-e) - den;
    if (diff < 0) e -= 1;
    return e;
  }

  /**
   * 把 p/den 按 sig 位有效数字四舍五入，返回 { n, e }：
   * n 是有效数字拼成的整数，e 是它的十进制指数（n × 10^(e - 位数 + 1) ≈ 原值）。
   */
  function roundToSignificant(p, den, e, sig) {
    var shift = sig - 1 - e;
    var num, divisor;
    if (shift >= 0) {
      num = p * pow10(shift);
      divisor = den;
    } else {
      num = p;
      divisor = den * pow10(-shift);
    }
    var q = num / divisor;
    var rest = num % divisor;
    if (rest * 2n >= divisor) q += 1n;   // 四舍五入（0.5 向上）
    // 进位可能把位数顶成 sig+1 位（9.999 → 10.00），这时指数加一
    if (q >= pow10(sig)) {
      q /= 10n;
      e += 1;
    }
    return { n: q, e: e };
  }

  /**
   * 把有效数字渲染成字符串。
   * 太小或太大时改用科学计数法（1e-12 / 1.5e+16）。
   */
  function renderSignificant(n, e, sig) {
    var s = n.toString();
    var width = s.length;
    if (e < -6 || e > 15) {
      var frac = width > 1 ? stripZeros(s.slice(1)) : '';
      var mantissa = width > 1 ? (frac.length ? s.charAt(0) + '.' + frac : s.charAt(0)) : s;
      return mantissa + 'e' + (e < 0 ? '-' : '+') + Math.abs(e);
    }
    var exp10 = e - (width - 1);
    if (exp10 >= 0) return s + '0'.repeat(exp10);
    var cut = width + exp10;
    var intPart;
    var fracPart;
    if (cut > 0) {
      intPart = s.slice(0, cut);
      fracPart = s.slice(cut);
    } else {
      intPart = '0';
      fracPart = '0'.repeat(-cut) + s;
    }
    fracPart = stripZeros(fracPart);
    return fracPart.length ? intPart + '.' + fracPart : intPart;
  }

  /**
   * 把精确分数格式化成可读的字符串。
   *
   * 规则：
   *   · 0 → "0"；
   *   · **整数精确显示**（1048576 就写 1048576，不四舍五入成 1049000）；
   *   · 非整数按 sig 位有效数字四舍五入，并去掉多余的 0；
   *   · 位数太多（小数点前 7 位以后、小数点后 7 位以前）改用科学计数法。
   *
   * @param {{num: bigint, den: bigint}} frac
   * @param {number} sig 有效数字位数
   * @returns {string}
   */
  function formatFraction(frac, sig) {
    var num = frac.num;
    var den = frac.den;
    if (num === 0n) return '0';
    var negative = num < 0n;
    var p = negative ? -num : num;
    var sign = negative ? '-' : '';

    if (p % den === 0n) {
      var whole = (p / den).toString();
      if (whole.length <= 40) return sign + whole;
    }

    var e = decimalExponent(p, den);
    var rounded = roundToSignificant(p, den, e, sig);
    return sign + renderSignificant(rounded.n, rounded.e, sig);
  }

  /**
   * 一次算完所有单位的换算结果。
   *
   * @param {{num: bigint, den: bigint}} value
   * @param {string} from 源单位（B/KB/MB/GB/TB/PB）
   * @param {number} base 1000 或 1024
   * @param {number} sig  有效数字位数
   * @returns {Array<{unit: string, value: string}>}
   */
  function convertAll(value, from, base, sig) {
    var fromIdx = unitIndex(from);
    var out = [];
    for (var i = 0; i < UNITS.length; i++) {
      out.push({
        unit: UNITS[i],
        value: formatFraction(convertExact(value, fromIdx, i, base), sig)
      });
    }
    return out;
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('data-size-converter', function (root) {
    /** 卸载时要解掉的监听，全记在这儿 */
    var cleanups = [];

    function on(el, ev, fn) {
      el.addEventListener(ev, fn);
      cleanups.push(function () { el.removeEventListener(ev, fn); });
    }

    var valueInput = D.h('input.layui-input', {
      type: 'text',
      value: '1',
      placeholder: t('ph_value', 'Number to convert, e.g. 1.5 or 2 GB'),
      spellcheck: 'false',
      autocomplete: 'off'
    });
    valueInput.id = 'dsc-value';

    var unitSelect = D.h('select.layui-input', { id: 'dsc-unit' }, UNITS.map(function (u) {
      return D.h('option', { value: u, text: u });
    }));
    unitSelect.value = 'GB';

    var baseSelect = D.h('select.layui-input', { id: 'dsc-base' }, [
      D.h('option', { value: String(BASE_DECIMAL), text: t('base_decimal', 'Decimal (1 kB = 1000 B)') }),
      D.h('option', { value: String(BASE_BINARY), text: t('base_binary', 'Binary (1 KiB = 1024 B)') })
    ]);
    baseSelect.value = String(BASE_DECIMAL);

    var precisionSelect = D.h('select.layui-input', { id: 'dsc-precision' }, PRECISIONS.map(function (n) {
      return D.h('option', { value: String(n), text: String(n) });
    }));
    precisionSelect.value = '4';

    var status = D.h('p.form-status');
    var results = D.h('div');

    /** 显示一条消息；出错时用红色。 */
    function setStatus(message, isError) {
      D.clear(status);
      status.classList.remove('is-error');
      if (!message) return;
      if (isError) status.classList.add('is-error');
      status.appendChild(D.h('span', { text: message }));
    }

    function render(fromInput) {
      var split = splitUnit(valueInput.value);
      var value;
      try {
        value = parseDecimal(split.text);
      } catch (e) {
        D.clear(results);
        setStatus(e && e.message ? e.message : String(e), true);
        return;
      }

      var from = unitSelect.value;
      var base = parseInt(baseSelect.value, 10);
      var note = '';

      if (split.unit) {
        if (fromInput) {
          // 输入里带了单位后缀 → 以它为准，把界面上的下拉同步过去
          from = UNITS[UNIT_ALIASES[split.unit]];
          unitSelect.value = from;
          if (IEC_ALIASES[split.unit]) {
            // IEC 名字（KiB/MiB/…）按定义就是二进制
            base = BASE_BINARY;
            baseSelect.value = String(BASE_BINARY);
            note = t('unit_detected_binary', 'Unit taken from the input: {unit} — IEC names (KiB/MiB/…) are binary by definition, so the base was switched to binary.')
              .replace('{unit}', from);
          } else {
            note = t('unit_detected', 'Unit taken from the input: {unit}').replace('{unit}', from);
          }
        } else {
          // 用户手动改了单位或基数 → 把输入里的后缀换成当前选中的单位。
          // 不换的话就会出现「输入框写着 1 GiB、下拉却是十进制」这种自相矛盾：
          // 1 GiB 按定义就是二进制，而下拉说的是十进制，两边只能有一个是对的。
          valueInput.value = split.text + ' ' + unitSelect.value;
        }
      }
      setStatus(note, false);

      var sig = parseInt(precisionSelect.value, 10);
      var rows = convertAll(value, from, base, sig);

      D.clear(results);
      results.appendChild(D.h('div.form-actions', null,
        D.h('span.field-label', { text: t('title_results', 'Results') }),
        U.copyButton(function () {
          return rows.map(function (r) { return r.unit + ': ' + r.value; }).join('\n');
        }, t('copy_all', 'Copy all'))
      ));
      results.appendChild(D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_unit', 'Unit') }),
          D.h('th', { text: t('col_value', 'Value') }),
          D.h('th', { text: t('col_action', 'Action') })
        )),
        D.h('tbody', null, rows.map(function (r) {
          var isSource = r.unit === from;
          return D.h('tr', null,
            D.h('td', { text: r.unit, style: isSource ? { fontWeight: '600' } : null }),
            D.h('td.val', { text: r.value }),
            D.h('td', null, U.copyButton(function () { return r.value; }, t('copy_value', 'Copy')))
          );
        }))
      ));
    }

    on(valueInput, 'input', function () { render(true); });
    on(unitSelect, 'change', function () { render(false); });
    on(baseSelect, 'change', function () { render(false); });
    on(precisionSelect, 'change', function () { render(false); });

    root.appendChild(D.h('div.card', null,
      D.h('p.field-hint', {
        text: t('hint_base', 'Decimal (SI) means 1 kB = 1000 B, binary (IEC) means 1 KiB = 1024 B. Mixing the two is the most common source of wrong numbers.')
      }),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: valueInput.id, text: t('label_value', 'Value') }),
        valueInput
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: unitSelect.id, text: t('label_input_unit', 'Input unit') }),
        unitSelect
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: baseSelect.id, text: t('label_base', 'Base') }),
        baseSelect
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: precisionSelect.id, text: t('label_precision', 'Precision') }),
        precisionSelect
      ),
      D.h('p.field-hint', { text: t('precision_hint', 'Significant digits kept for non-integer results; integers are shown exactly.') }),
      status,
      D.h('div.tool-separator'),
      results
    ));

    render(true);

    return {
      destroy: function () {
        cleanups.forEach(function (fn) {
          try { fn(); } catch (e) { /* 忽略：卸载不能因为解绑失败而抛 */ }
        });
        cleanups = [];
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（供 node 侧用例调用） ---------- */

  window.ItTools.logic['data-size-converter'] = {
    UNITS: UNITS,
    BASE_DECIMAL: BASE_DECIMAL,
    BASE_BINARY: BASE_BINARY,
    PRECISIONS: PRECISIONS,
    UNIT_ALIASES: UNIT_ALIASES,
    IEC_ALIASES: IEC_ALIASES,
    parseDecimal: parseDecimal,
    splitUnit: splitUnit,
    unitIndex: unitIndex,
    basePow: basePow,
    convertExact: convertExact,
    convertAll: convertAll,
    formatFraction: formatFraction,
    decimalExponent: decimalExponent,
    roundToSignificant: roundToSignificant,
    __cases: function (assert) {
      function near(a, b, msg) {
        assert(Math.abs(a - b) < 1e-9, (msg || '') + ' 期望≈' + b + '，实际 ' + a);
      }

      /* ---- 解析 ----
         BigInt 过不了 JSON.stringify，所以一律比字符串。 */
      assert.eq(parseDecimal('42').num.toString(), '42', '整数解析');
      assert.eq(parseDecimal('42').den.toString(), '1', '整数分母是 1');
      assert.eq(parseDecimal('1.5').num.toString(), '15', '小数解析成精确分数');
      assert.eq(parseDecimal('1.5').den.toString(), '10', '小数分母是 10 的幂');
      assert.eq(parseDecimal('0.1').num.toString(), '1', '0.1 不是浮点的 0.1000000000000000055');
      assert.eq(parseDecimal('0.1').den.toString(), '10', '0.1 的分母');
      assert.eq(parseDecimal('-2.25').num.toString(), '-225', '负数');
      assert.eq(parseDecimal('-2.25').den.toString(), '100', '负数分母');
      assert.eq(parseDecimal('1e3').num.toString(), '1000', '正指数');
      assert.eq(parseDecimal('1e-3').num.toString(), '1', '负指数');
      assert.eq(parseDecimal('1e-3').den.toString(), '1000', '负指数进分母');
      assert.eq(parseDecimal('+7').num.toString(), '7', '前导加号');
      assert.eq(parseDecimal('.5').num.toString(), '5', '省略整数位');
      assert.eq(parseDecimal('5.').num.toString(), '5', '省略小数位');
      assert.eq(parseDecimal('  12  ').num.toString(), '12', '前后空白');

      var threw = false;
      try { parseDecimal(''); } catch (e) { threw = true; }
      assert(threw, '空串必须报错');
      threw = false;
      try { parseDecimal('abc'); } catch (e) { threw = true; }
      assert(threw, '非数字必须报错');
      threw = false;
      try { parseDecimal('1.2.3'); } catch (e) { threw = true; }
      assert(threw, '两个小数点必须报错');
      threw = false;
      try { parseDecimal('1e999999'); } catch (e) { threw = true; }
      assert(threw, '指数越界必须报错');

      /* ---- 单位后缀 ---- */
      assert.eq(splitUnit('1.5 GB').text, '1.5', '带单位时拆出数值');
      assert.eq(splitUnit('1.5 GB').unit, 'gb', '带单位时拆出单位');
      assert.eq(splitUnit('42').unit, null, '没有单位后缀');
      assert.eq(splitUnit('42').text, '42', '没有单位后缀时原样返回数值');
      assert.eq(splitUnit('1e3').unit, null, '指数不是单位');
      assert.eq(splitUnit('1KiB').unit, 'kib', 'IEC 名字要认出来');
      assert.eq(splitUnit('1ZiB').unit, null, '不认识的后缀不算单位');

      /* ---- 换算 ---- */
      var one = parseDecimal('1');
      assert.eq(formatFraction(convertExact(one, 1, 1, BASE_DECIMAL), 4), '1', '同单位换算不变');
      assert.eq(formatFraction(convertExact(one, 1, 0, BASE_DECIMAL), 4), '1000', '十进制 1 KB = 1000 B');
      assert.eq(formatFraction(convertExact(one, 1, 0, BASE_BINARY), 4), '1024', '二进制 1 KB = 1024 B');
      assert.eq(formatFraction(convertExact(one, 3, 2, BASE_DECIMAL), 4), '1000', '十进制 1 GB = 1000 MB');
      assert.eq(formatFraction(convertExact(one, 3, 2, BASE_BINARY), 4), '1024', '二进制 1 GB = 1024 MB');
      assert.eq(formatFraction(convertExact(one, 4, 3, BASE_BINARY), 4), '1024', '二进制 1 TB = 1024 GB');
      assert.eq(formatFraction(convertExact(parseDecimal('1500'), 0, 1, BASE_DECIMAL), 4), '1.5', '1500 B = 1.5 KB');
      assert.eq(formatFraction(convertExact(parseDecimal('2048'), 0, 1, BASE_BINARY), 4), '2', '2048 B = 2 KB');
      assert.eq(formatFraction(convertExact(one, 5, 0, BASE_DECIMAL), 4), '1000000000000000', '十进制 1 PB = 10^15 B');
      assert.eq(formatFraction(convertExact(one, 0, 5, BASE_DECIMAL), 4), '1e-15', '十进制 1 B = 1e-15 PB');
      assert.eq(formatFraction(convertExact(one, 0, 5, BASE_BINARY), 4), '8.882e-16', '二进制 1 B = 8.882e-16 PB');
      assert.eq(formatFraction(convertExact(parseDecimal('0'), 3, 2, BASE_BINARY), 4), '0', '0 是 0');
      assert.eq(formatFraction(convertExact(parseDecimal('-1'), 3, 2, BASE_DECIMAL), 4), '-1000', '负数保留符号');

      // 整数必须精确 —— 不能被四舍五入成 1049000
      assert.eq(formatFraction(convertExact(one, 2, 0, BASE_BINARY), 4), '1048576', '1 MB = 1048576 B（精确）');
      assert.eq(formatFraction(convertExact(parseDecimal('0.1'), 1, 0, BASE_DECIMAL), 4), '100', '0.1 KB = 100 B（精确）');
      assert.eq(formatFraction(convertExact(parseDecimal('0.1'), 1, 0, BASE_BINARY), 4), '102.4', '0.1 KB = 102.4 B');

      // 浮点尾巴不该出现
      assert.eq(formatFraction(convertExact(one, 1, 0, BASE_DECIMAL), 4).indexOf('.'), -1, '1000 不该带小数尾巴');
      assert.eq(formatFraction(convertExact(one, 3, 0, BASE_BINARY), 4), '1073741824', '1 GB = 1073741824 B（精确）');

      /* ---- 有效数字与去零 ---- */
      var frac = parseDecimal('1.5');
      assert.eq(formatFraction(convertExact(frac, 1, 0, BASE_DECIMAL), 4), '1500', '1.5 KB = 1500 B');
      assert.eq(formatFraction(convertExact(frac, 1, 2, BASE_DECIMAL), 2), '0.0015', '两位有效数字');
      assert.eq(formatFraction(convertExact(parseDecimal('1234.5'), 0, 0, BASE_DECIMAL), 4), '1235', '四舍五入到 4 位有效数字');
      assert.eq(formatFraction(convertExact(parseDecimal('1234.5'), 0, 0, BASE_DECIMAL), 2), '1200', '四舍五入到 2 位有效数字');
      assert.eq(formatFraction(convertExact(parseDecimal('9.9999'), 0, 0, BASE_DECIMAL), 4), '10', '进位后不能留下 10.00');
      assert.eq(formatFraction(convertExact(parseDecimal('1.500'), 0, 0, BASE_DECIMAL), 4), '1.5', '多余的 0 要去掉');
      assert.eq(formatFraction(convertExact(parseDecimal('1000'), 0, 0, BASE_DECIMAL), 4), '1000', '1000 不该变成 1e+3');
      assert.eq(formatFraction(convertExact(parseDecimal('0.0009765625'), 0, 0, BASE_DECIMAL), 4), '0.0009766', '非整数按有效数字取整');
      assert.eq(formatFraction(convertExact(parseDecimal('0.0009765625'), 0, 0, BASE_DECIMAL), 8), '0.0009765625', '精度调大就能看到全貌');
      assert.eq(formatFraction(convertExact(parseDecimal('0.0009765625'), 0, 0, BASE_DECIMAL), 2), '0.00098', '两位有效数字的小数');
      assert.eq(formatFraction(convertExact(parseDecimal('0.0000001'), 0, 0, BASE_DECIMAL), 4), '1e-7', '太小了用科学计数法');

      /* ---- 往返 ---- */
      UNITS.forEach(function (u) {
        var from = unitIndex(u);
        UNITS.forEach(function (v) {
          var to = unitIndex(v);
          var there = convertExact(parseDecimal('1'), from, to, BASE_BINARY);
          var back = convertExact(there, to, from, BASE_BINARY);
          assert.eq(formatFraction(back, 8), '1', u + ' → ' + v + ' 往返');
        });
      });

      /* ---- convertAll ---- */
      var all = convertAll(parseDecimal('1'), 'GB', BASE_BINARY, 4);
      assert.eq(all.length, 6, 'convertAll 返回 6 个单位');
      assert.eq(all[0].unit, 'B', '第一行是 B');
      assert.eq(all[0].value, '1073741824', '1 GB = 1073741824 B');
      assert.eq(all[1].value, '1048576', '1 GB = 1048576 KB');
      assert.eq(all[2].value, '1024', '1 GB = 1024 MB');
      assert.eq(all[3].value, '1', '1 GB = 1 GB');
      assert.eq(all[4].value, '0.0009766', '1 GB ≈ 0.0009766 TB（4 位有效数字）');
      assert.eq(all[5].value, '9.537e-7', '1 GB ≈ 9.537e-7 PB（4 位有效数字）');

      var allDec = convertAll(parseDecimal('1'), 'GB', BASE_DECIMAL, 4);
      assert.eq(allDec[1].value, '1000000', '十进制 1 GB = 1000000 KB');
      assert.eq(allDec[3].value, '1', '十进制 1 GB = 1 GB');

      /* ---- 错误 ---- */
      threw = false;
      try { unitIndex('XB'); } catch (e) { threw = true; }
      assert(threw, '未知单位必须报错');
      threw = false;
      try { basePow(500, 1); } catch (e) { threw = true; }
      assert(threw, '未知基数必须报错');
      threw = false;
      try { convertAll(parseDecimal('1'), 'XB', BASE_DECIMAL, 4); } catch (e) { threw = true; }
      assert(threw, '未知源单位必须报错');

      /* ---- 指数 ---- */
      assert.eq(decimalExponent(1n, 1n), 0, '1 的指数是 0');
      assert.eq(decimalExponent(1000n, 1n), 3, '1000 的指数是 3');
      assert.eq(decimalExponent(1n, 1000n), -3, '0.001 的指数是 -3');
      assert.eq(decimalExponent(999n, 1000n), -1, '0.999 的指数是 -1');
      near(decimalExponent(1n, 2n), -1, '0.5 的指数是 -1');
    }
  };
})();
