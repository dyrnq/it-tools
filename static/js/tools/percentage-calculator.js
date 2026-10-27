/* ==========================================================================
   百分比计算器（percentage-calculator）

   三种最常用的百分比问法：
     · x 是 y 的百分之几        → 100 × x ÷ y
     · x 的 p% 是多少            → p ÷ 100 × y
     · 从 a 变成 b 涨/跌了几个百分点 → (b - a) ÷ a × 100

   参考实现：src/tools/percentage-calculator/（it-tools, GPLv3）
   与原版的差别：原版直接 String(结果) 输出，0.3 这类浮点会把尾数噪声
   （0.30000000000000004）一起显示出来；这里显示前统一按 12 位有效数字收敛，
   输入缺一半或结果非有限（除以 0）时一律留空，不显示 Infinity / NaN。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('percentage-calculator');

  /**
   * 解析输入框：空串 / 非法字符返回 null（调用方据此留空结果）。
   * 允许前导 +、小数、指数写法。
   */
  function parseNum(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s.length) return null;
    if (s.charAt(0) === '+') s = s.slice(1);
    if (!s.length || s === '-') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /** x 占 y 的百分之几 */
  function whatPercent(x, y) { return 100 * x / y; }
  /** y 的 p% 是多少 */
  function percentOf(p, y) { return p / 100 * y; }
  /** 从 from 变成 to 的涨跌幅（%） */
  function percentChange(from, to) { return (to - from) / from * 100; }

  /**
   * 结果格式化：非有限值（除以 0、缺输入）一律显示空串，
   * 其余先按 12 位有效数字收敛掉浮点尾数噪声。
   */
  function format(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return String(Number(n.toPrecision(12)));
  }

  /**
   * 三个计算器一次算完，缺输入的那几个返回空串。
   * @param {?number} a
   * @param {?number} b
   * @returns {{whatPercent: string, percentOf: string, percentChange: string}}
   */
  function compute(a, b) {
    var hasA = typeof a === 'number' && isFinite(a);
    var hasB = typeof b === 'number' && isFinite(b);
    return {
      whatPercent: hasA && hasB ? format(whatPercent(a, b)) : '',
      percentOf: hasA && hasB ? format(percentOf(a, b)) : '',
      percentChange: hasA && hasB ? format(percentChange(a, b)) : ''
    };
  }

  /** 一行「说明 + 两个输入框 + 结果框 + 复制」 */
  function calcRow(spec, onInput) {
    var inputA = D.h('input.layui-input', { type: 'number', step: 'any', placeholder: t('ph_x', 'X') });
    var inputB = D.h('input.layui-input', { type: 'number', step: 'any', placeholder: t('ph_y', 'Y') });
    var result = D.h('input.layui-input', { type: 'text', readonly: true, value: '', placeholder: t('ph_result', 'Result') });

    function update() { onInput(parseNum(inputA.value), parseNum(inputB.value)); }
    inputA.addEventListener('input', update);
    inputB.addEventListener('input', update);

    // 原版是一行：说明文字 → X → 「% of」 → Y → 结果框（150px，右侧带复制图标）。
    // 结果框固定 150px，复制图标叠在框里 —— 叠在整行右端会跟框错位。
    var parts = [];
    if (spec.lead) parts.push(D.h('span.row-lead', { text: spec.lead }));
    parts.push(inputA);
    if (spec.mid) parts.push(D.h('span.row-lead', { text: spec.mid }));
    parts.push(inputB);
    parts.push(D.h('div.row-result', null,
      result,
      U.copyButton(function () { return result.value; })));

    return {
      a: inputA,
      b: inputB,
      result: result,
      el: D.h('div.field-row', null, parts)
    };
  }

  window.ItTools.register('percentage-calculator', function (root) {
    /** 每行用自己的两个输入框算自己的结果，互不影响 */
    function bind(key, spec, field) {
      var row = null;
      row = calcRow(spec, function (a, b) {
        row.result.value = compute(a, b)[field];
      });
      return row.el;
    }

    // 原版是三张卡，每张卡一行公式
    root.appendChild(D.h('div.card', null,
      bind('of', { lead: t('what_is', 'What is'), mid: t('percent_of', '% of') }, 'percentOf'),
      bind('who', { lead: '', mid: t('is_what_percent_of', 'is what percent of') }, 'whatPercent'),
      bind('change', { lead: t('percent_change', 'What is the percentage increase/decrease'), mid: '' }, 'percentChange'),
      D.h('p.field-hint', { text: t('hint', 'Row 1: p% of y; row 2: what percent x is of y; row 3: the percentage change from a to b. The result is left blank when an input is missing or when dividing by 0.') })
    ));

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['percentage-calculator'] = {
    whatPercent: whatPercent,
    percentOf: percentOf,
    percentChange: percentChange,
    parseNum: parseNum,
    format: format,
    compute: compute,
    __cases: function (assert) {
      // x 是 y 的百分之几
      assert.eq(whatPercent(50, 200), 25, '50 是 200 的 25%');
      assert.eq(whatPercent(1, 4), 25, '1 是 4 的 25%');
      assert.eq(format(whatPercent(123, 456)), '26.9736842105', '123/456 的百分比（收敛尾数噪声）');

      // y 的 p% 是多少
      assert.eq(percentOf(50, 200), 100, '200 的 50% = 100');
      assert.eq(format(percentOf(123, 456)), '560.88', '456 的 123%');
      assert.eq(format(percentOf(0.1, 3)), '0.003', '0.1% of 3，不应出现浮点噪声');

      // 涨跌幅
      assert.eq(percentChange(100, 150), 50, '100 → 150 涨 50%');
      assert.eq(percentChange(100, 50), -50, '100 → 50 跌 50%');
      assert.eq(percentChange(100, 100), 0, '没变就是 0%');
      assert.eq(format(percentChange(123, 456)), '270.731707317', '123 → 456');

      // 缺输入 / 除以 0 都要留空，而不是 NaN / Infinity
      assert.eq(compute(null, 456), { whatPercent: '', percentOf: '', percentChange: '' }, '缺第一个数');
      assert.eq(compute(123, null), { whatPercent: '', percentOf: '', percentChange: '' }, '缺第二个数');
      assert.eq(compute(1, 0), { whatPercent: '', percentOf: '0', percentChange: '-100' }, '除以 0 只有第一行无解，另两行仍是有限值');
      assert.eq(compute(1, 0).whatPercent, '', '除以 0 不显示 Infinity');
      assert.eq(compute(0, 0), { whatPercent: '', percentOf: '0', percentChange: '' }, '0 作分母时涨跌幅也无解');
      assert.eq(compute(50, 200), { whatPercent: '25', percentOf: '100', percentChange: '300' }, '正常输入');

      // 输入解析
      assert.eq(parseNum(''), null, '空串');
      assert.eq(parseNum('abc'), null, '非法字符');
      assert.eq(parseNum('-'), null, '只有符号');
      assert.eq(parseNum('+12'), 12, '前导加号');
      assert.eq(parseNum('.5'), 0.5, '省略整数位');

      assert.eq(format(NaN), '', 'NaN');
      assert.eq(format(Infinity), '', 'Infinity');
    }
  };
})();