/* ==========================================================================
   数学表达式求值器（math-evaluator）

   输入一条数学表达式（mathjs 语法），点 Evaluate 出结果；带历史记录、
   常用函数/常量速查表，以及十进制/十六进制/八进制/二进制的显示切换。

   参考实现：src/tools/math-evaluator/（it-tools, GPLv3）
   与原版的差别：
   1. **原版直接 `math.evaluate(expr)`，等于在页面里执行任意 JS**。mathjs 的
      import/parser 能一路摸到全局对象，原版没有任何防护。这里改成 mathjs
      官方推荐的受限写法：`math.parse(expr).compile().evaluate(new Map())`。
      实测（见文件末尾 __cases）import / constructor / __proto__ / require /
      process / window 这些逃逸口全部被挡在门外；mathjs 自带的函数（sqrt、
      gcd、derivative…）照常可用。
   2. 原版靠 `withDefaultOnError(() => evaluate(...) ?? '', '')` 静默吞掉所有
      错误，语法错误、除零在页面上什么都不显示。这里把错误原文显示出来，
      并对 Infinity / NaN 给可读说明。
   3. 原版没有历史、没有速查表、没有进制切换（原版连求值按钮都没有，输入即算）。
      这三样是按本项目的要求补的。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('math-evaluator');

  var HISTORY_KEY = 'math-evaluator:history';
  var HISTORY_MAX = 30;

  /**
   * 这些符号不该出现在用户作用域里：parser() / mathWithTransform 之类能拿到
   * mathjs 命名空间，evaluate/parse 能再开一层求值，config 能改全局配置。
   * 用 undefined 占位把它们在作用域里「遮住」——正常表达式一个都用不到，
   * 少一条通往命名对象的路就少一条。
   * simplify / derivative / resolve 不在名单里：实测它们只把字符串**解析**成
   * 节点（simplify("import('a')") 只是返回一段文本），并不会真的求值。
   * （实测 11.9.1 下它们就算不遮也已经被 restricted scope 挡住了，
   *   这里只是纵深防御：万一某个版本把嵌套 evaluate 放回默认作用域，也还挡着。）
   */
  var BLOCKED_SYMBOLS = [
    'import', 'parser', 'evaluate', 'parse', 'config', 'configuration',
    'chain', 'create', 'reviver', 'math', 'mathWithTransform'
  ];

  var BASES = [
    { value: 10, label: t('base_decimal', 'Decimal'), prefix: '' },
    { value: 16, label: t('base_hex', 'Hex'), prefix: '0x' },
    { value: 8, label: t('base_octal', 'Octal'), prefix: '0' },
    { value: 2, label: t('base_binary', 'Binary'), prefix: '0b' }
  ];

  /**
   * 速查表的分组显示名。group 字段是稳定的内部标识（英文 slug），
   * 界面上显示的名字走 i18n —— 断言按 group 查，不受语言影响。
   */
  var GROUP_LABELS = {
    constants: function () { return t('group_constants', 'Constants'); },
    arithmetic: function () { return t('group_arithmetic', 'Arithmetic'); },
    rounding: function () { return t('group_rounding', 'Rounding'); },
    trigonometry: function () { return t('group_trigonometry', 'Trigonometry'); },
    roots_logs: function () { return t('group_roots_logs', 'Roots & Logarithms'); },
    statistics: function () { return t('group_statistics', 'Statistics'); },
    units: function () { return t('group_units', 'Units'); },
    others: function () { return t('group_others', 'Others'); }
  };

  /** 分组 id → 显示名；名单外的分组原样返回。 */
  function groupLabel(group) {
    var f = GROUP_LABELS[group];
    return f ? f() : group;
  }

  /** 速查表：每一项都要能在受限作用域里跑通（__cases 里逐条验过） */
  var CHEATSHEET = [
    { group: 'constants', expr: 'pi', desc: t('cheat_pi', 'Pi ≈ 3.141592653589793') },
    { group: 'constants', expr: 'e', desc: t('cheat_e', 'The natural constant e ≈ 2.718281828459045') },
    { group: 'constants', expr: 'tau', desc: t('cheat_tau', 'Twice pi (2π)') },
    { group: 'constants', expr: 'phi', desc: t('cheat_phi', 'The golden ratio (1+√5)/2') },
    { group: 'constants', expr: 'i', desc: t('cheat_i', 'The imaginary unit') },
    { group: 'constants', expr: 'Infinity', desc: t('cheat_infinity', 'Positive infinity') },
    { group: 'constants', expr: 'NaN', desc: t('cheat_nan', 'Not a number (the result of 0/0)') },
    { group: 'constants', expr: 'true', desc: t('cheat_true', 'Boolean true') },

    { group: 'arithmetic', expr: '2 + 3 * 4', desc: t('cheat_precedence', 'Multiplication and division come first: the result is 14') },
    { group: 'arithmetic', expr: '(2 + 3) * 4', desc: t('cheat_parens', 'Parentheses change the precedence') },
    { group: 'arithmetic', expr: '2 ^ 10', desc: t('cheat_power', 'Power: 2 to the 10th = 1024') },
    { group: 'arithmetic', expr: 'mod(7, 3)', desc: t('cheat_mod', 'Modulo (the mathematical modulus, always non-negative)') },
    { group: 'arithmetic', expr: 'gcd(12, 18)', desc: t('cheat_gcd', 'Greatest common divisor') },
    { group: 'arithmetic', expr: 'lcm(4, 6)', desc: t('cheat_lcm', 'Least common multiple') },
    { group: 'arithmetic', expr: 'factorial(5)', desc: t('cheat_factorial', 'Factorial 5! = 120') },
    { group: 'arithmetic', expr: 'combinations(5, 2)', desc: t('cheat_combinations', 'Combinations C(5,2) = 10') },
    { group: 'arithmetic', expr: 'permutations(5, 2)', desc: t('cheat_permutations', 'Permutations P(5,2)') },

    { group: 'rounding', expr: 'ceil(2.1)', desc: t('cheat_ceil', 'Round up') },
    { group: 'rounding', expr: 'floor(2.9)', desc: t('cheat_floor', 'Round down') },
    { group: 'rounding', expr: 'round(2.567, 2)', desc: t('cheat_round', 'Round to 2 decimal places') },
    { group: 'rounding', expr: 'sign(-3)', desc: t('cheat_sign', 'Sign function: -1 / 0 / 1') },
    { group: 'rounding', expr: 'max(1, 5, 3)', desc: t('cheat_max', 'Maximum (variable number of arguments)') },
    { group: 'rounding', expr: 'min(1, 5, 3)', desc: t('cheat_min', 'Minimum (variable number of arguments)') },

    { group: 'trigonometry', expr: 'sin(pi / 2)', desc: t('cheat_sin', 'Sine (in radians)') },
    { group: 'trigonometry', expr: 'cos(0)', desc: t('cheat_cos', 'Cosine') },
    { group: 'trigonometry', expr: 'tan(pi / 4)', desc: t('cheat_tan', 'Tangent') },
    { group: 'trigonometry', expr: 'atan2(1, 1)', desc: t('cheat_atan2', 'Four-quadrant arctangent') },

    { group: 'roots_logs', expr: 'sqrt(16)', desc: t('cheat_sqrt', 'Square root') },
    { group: 'roots_logs', expr: 'cbrt(27)', desc: t('cheat_cbrt', 'Cube root') },
    { group: 'roots_logs', expr: 'nthRoot(32, 5)', desc: t('cheat_nthroot', '5th root of 32') },
    { group: 'roots_logs', expr: 'log(100)', desc: t('cheat_log', 'Logarithm with base e') },
    { group: 'roots_logs', expr: 'log2(1024)', desc: t('cheat_log2', 'Logarithm with base 2') },
    { group: 'roots_logs', expr: 'log10(100)', desc: t('cheat_log10', 'Logarithm with base 10') },

    { group: 'statistics', expr: 'mean([1, 2, 3, 4])', desc: t('cheat_mean', 'Arithmetic mean') },
    { group: 'statistics', expr: 'median([3, 1, 2])', desc: t('cheat_median', 'Median') },
    { group: 'statistics', expr: 'max([1, 9, 5])', desc: t('cheat_array_max', 'Maximum of an array') },
    { group: 'statistics', expr: 'std([2, 4, 4, 4, 5, 5, 7, 9])', desc: t('cheat_std', 'Population standard deviation') },
    { group: 'statistics', expr: 'variance([1, 2, 3, 4])', desc: t('cheat_variance', 'Variance') },

    { group: 'units', expr: '5 cm to inch', desc: t('cheat_unit_length', 'Length conversion') },
    { group: 'units', expr: '1 N to lbf', desc: t('cheat_unit_force', 'Force conversion') },
    { group: 'units', expr: '2 kg to lb', desc: t('cheat_unit_mass', 'Mass conversion') },

    { group: 'others', expr: 'x = 5; x ^ 2', desc: t('cheat_assignment', 'Assignment (statements separated by ;)') },
    { group: 'others', expr: 'derivative("x^2", "x")', desc: t('cheat_derivative', 'Symbolic differentiation') },
    { group: 'others', expr: 'simplify("x + x")', desc: t('cheat_simplify', 'Simplify') },
    { group: 'others', expr: '[1, 2, 3]', desc: t('cheat_array_literal', 'Array literal') }
  ];

  /**
   * 新建一个受限作用域。
   * @param {Object} [vars] 额外暴露的变量
   * @returns {Map} mathjs 认的受限作用域
   */
  function createScope(vars) {
    var scope = new Map();
    BLOCKED_SYMBOLS.forEach(function (name) { scope.set(name, undefined); });
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach(function (k) { scope.set(k, vars[k]); });
    }
    return scope;
  }

  /**
   * 求值主函数，**不抛异常**——出错时把原因放在 error 里给页面显示。
   * @param {string} expr
   * @param {Object} [vars]
   * @returns {{ok:boolean, value:string, number:(number|null), error:(string|null), special:(string|null)}}
   */
  function evaluateExpression(expr, vars) {
    var src = String(expr == null ? '' : expr).trim();
    if (!src) return { ok: false, value: '', number: null, error: t('err_empty', 'Enter an expression first.'), special: null };

    var math = window.math;
    if (!math) return { ok: false, value: '', number: null, error: t('err_not_loaded', 'mathjs is not loaded.'), special: null };

    var compiled;
    try {
      compiled = math.parse(src).compile();
    } catch (e) {
      return { ok: false, value: '', number: null, error: t('err_syntax', 'Syntax error — ') + errText(e), special: null };
    }

    var result;
    try {
      result = compiled.evaluate(createScope(vars));
    } catch (e) {
      return { ok: false, value: '', number: null, error: errText(e), special: null };
    }

    result = unwrapScalar(result);

    // 数字直接 String()：math.format 会把 1000000 写成 "1e+6"，对计算器不合适。
    // 非数字（单位、数组、布尔……）才交给 math.format。
    var value;
    try {
      value = typeof result === 'number' ? String(result) : math.format(result);
    } catch (e2) {
      value = String(result);
    }

    var number = null;
    if (typeof result === 'number') number = result;
    else if (result && typeof result.toNumber === 'function') {
      try { number = result.toNumber(); } catch (e3) { number = null; }
    }

    var special = null;
    if (typeof number === 'number' && !isFinite(number)) {
      special = number > 0 ? 'Infinity' : (isNaN(number) ? 'NaN' : '-Infinity');
    }

    return { ok: true, value: value, number: number, error: null, special: special };
  }

  /**
   * 表达式带 `;` 时 mathjs 返回的是一个「语句数组」（x = 5; x ^ 2 → [25]），
   * 直接 String() 会得到 "[25]"。这里把长度为 1 的那种拆开。
   * DenseMatrix（[1]、[1,2,3]）带 isMatrix 标记，不会被误拆。
   */
  function unwrapScalar(result) {
    if (!result || typeof result !== 'object' || result.isMatrix) return result;
    var v;
    try { v = result.valueOf(); } catch (e) { return result; }
    return (Array.isArray(v) && v.length === 1) ? v[0] : result;
  }

  function errText(e) {
    if (!e) return t('err_unknown', 'Unknown error');
    // 用 message 而不是 toString()：后者会多带一层 "SyntaxError: " 前缀
    if (e.message) return e.message;
    try { return String(e); } catch (x) { return t('err_unknown', 'Unknown error'); }
  }

  /**
   * 整数转任意进制。只处理整数：带小数的数返回 null（非整数没有「另一种进制」的说法）。
   * @param {number} n
   * @param {number} base 2 / 8 / 10 / 16
   * @returns {(string|null)}
   */
  function toBase(n, base) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    if (!Number.isInteger(n)) return null;
    if (base === 10) return String(n);
    if (base !== 2 && base !== 8 && base !== 16) return null;
    if (n < 0) {
      var neg = toBase(-n, base);
      return neg === null ? null : '-' + neg;
    }
    var digits = '0123456789abcdefghijklmnopqrstuvwxyz';
    if (n === 0) return '0';
    var out = '';
    var v = n;
    while (v > 0) {
      out = digits[v % base] + out;
      v = Math.floor(v / base);
    }
    return out;
  }

  /** 按选中的进制渲染结果；拿不到数字就只给十进制那一份 */
  function formatResult(res, base) {
    if (!res.ok) return '';
    var lines = [res.value];
    if (res.number === null || base === 10) return lines.join('\n');
    var alt = toBase(res.number, base);
    if (alt === null) return lines.join('\n');
    var meta = null;
    for (var i = 0; i < BASES.length; i++) { if (BASES[i].value === base) meta = BASES[i]; }
    lines.push(base + ' → ' + (meta ? meta.prefix + alt : alt));
    return lines.join('\n');
  }

  /* ---- 历史记录：localStorage，读写都包 try（隐私模式会抛） ---- */

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (x) { return x && typeof x.expr === 'string'; }) : [];
    } catch (e) { return []; }
  }

  function saveHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) { /* 忽略 */ }
  }

  /** 新的排在前面，重复的表达式去掉旧记录再前置 */
  function pushHistory(list, expr, value) {
    var rest = list.filter(function (x) { return x.expr !== expr; });
    return [{ expr: expr, value: value, at: Date.now() }].concat(rest).slice(0, HISTORY_MAX);
  }

  window.ItTools.register('math-evaluator', function (root) {
    // 原版这个输入框是 monospace 的
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 2, spellcheck: 'false', placeholder: t('input_ph', 'Your math expression (ex: 2*sqrt(6))...')
    });
    var baseSelect = D.h('select.layui-input', null, BASES.map(function (b) {
      return D.h('option', { value: String(b.value), text: b.label });
    }));
    baseSelect.value = '10';

    var evalBtn = D.h('button.layui-btn', { type: 'button', text: window.ItTools.i18n('run', 'Run') });
    var clearBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: window.ItTools.i18n('clear', 'Clear') });
    var resultCard = D.outputCard(window.ItTools.i18n('output', 'Output'));
    var errorBox = D.h('p.field-hint.is-error', { style: { display: 'none' } });
    var historyBox = D.h('div');

    function renderHistory() {
      D.clear(historyBox);
      var list = loadHistory();
      if (!list.length) {
        historyBox.appendChild(D.h('p.muted', { text: t('no_history', 'No history yet.') }));
        return;
      }
      list.forEach(function (item) {
        var row = D.h('div', {
          style: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '2px 0', flexWrap: 'wrap' }
        },
          D.h('code', { text: item.expr }),
          D.h('span.muted', { text: '= ' + item.value }),
          D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', { type: 'button', text: t('use', 'Use') }));
        var useBtn = row.lastChild;
        useBtn.addEventListener('click', function () { input.value = item.expr; evaluate(); });
        historyBox.appendChild(row);
      });
    }

    function evaluate() {
      var src = input.value.trim();
      if (!src) {
        errorBox.style.display = '';
        errorBox.textContent = t('err_empty', 'Enter an expression first.');
        D.clear(resultCard.outputBody);
        return;
      }
      var res = evaluateExpression(src);
      if (!res.ok) {
        errorBox.style.display = '';
        errorBox.textContent = res.error;
        D.clear(resultCard.outputBody);
        return;
      }
      errorBox.style.display = 'none';
      errorBox.textContent = '';

      var text = formatResult(res, Number(baseSelect.value));
      if (res.special === 'Infinity') text += '\n' + t('special_infinity', 'Result is Infinity — something is being divided by zero.');
      else if (res.special === '-Infinity') text += '\n' + t('special_neg_infinity', 'Result is -Infinity — something is being divided by zero.');
      else if (res.special === 'NaN') text += '\n' + t('special_nan', 'Result is NaN — an invalid operation, e.g. 0/0 or sqrt(-1).');
      resultCard.outputBody.textContent = text;

      saveHistory(pushHistory(loadHistory(), src, res.value));
      renderHistory();
    }

    var offs = [];
    offs.push(D.on(evalBtn, 'click', evaluate));
    offs.push(D.on(clearBtn, 'click', function () {
      input.value = '';
      errorBox.style.display = 'none';
      D.clear(resultCard.outputBody);
      input.focus();
    }));
    offs.push(D.on(input, 'keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); evaluate(); }
    }));
    offs.push(D.on(baseSelect, 'change', function () {
      var res = evaluateExpression(input.value);
      if (res.ok) resultCard.outputBody.textContent = formatResult(res, Number(baseSelect.value));
    }));

    // 面板必须是整张卡片：.tool-content 是 flex 容器，
    // 直属子元素各自会成为一块面板，字段/按钮/提示这类碎片不能直接挂在 root 上。
    root.appendChild(D.h('div.card', null,
      U.field(t('expression', 'Expression'), input, { wide: true }),
      D.h('div.form-actions', null,
        evalBtn, clearBtn,
        D.h('span', { style: { marginLeft: '12px' } }),
        U.field(t('show_base', 'Show base'), baseSelect)),
      errorBox
    ));
    root.appendChild(resultCard);

    var historyCard = D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('history', 'History') }),
        (function () {
          var b = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', { type: 'button', text: t('clear_all', 'Clear all') });
          b.addEventListener('click', function () { saveHistory([]); renderHistory(); });
          return b;
        })()),
      historyBox);
    root.appendChild(historyCard);

    /* ---- 速查表：点一下填进输入框并立即求值；所有分组收进同一张卡片 ---- */
    var cheatCard = D.h('div.card');
    var lastGroup = null;
    CHEATSHEET.forEach(function (item) {
      if (item.group === lastGroup) return;
      lastGroup = item.group;
      cheatCard.appendChild(D.h('h3.section-head', { text: groupLabel(item.group), style: { marginTop: '16px' } }));
      var rows = CHEATSHEET.filter(function (x) { return x.group === item.group; }).map(function (entry) {
        var btn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', { type: 'button', text: entry.expr, title: entry.desc });
        btn.addEventListener('click', function () { input.value = entry.expr; evaluate(); });
        return D.h('tr', null, D.h('td', null, btn), D.h('td', { text: entry.desc }));
      });
      cheatCard.appendChild(D.h('table.kv-table', null, D.h('tbody', null, rows)));
    });
    root.appendChild(cheatCard);

    renderHistory();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['math-evaluator'] = {
    BLOCKED_SYMBOLS: BLOCKED_SYMBOLS,
    CHEATSHEET: CHEATSHEET,
    createScope: createScope,
    unwrapScalar: unwrapScalar,
    evaluateExpression: evaluateExpression,
    toBase: toBase,
    formatResult: formatResult,
    pushHistory: pushHistory,
    __cases: function (assert) {
      /* ---- 正常求值 ---- */
      var r = evaluateExpression('2 + 3 * 4');
      assert(r.ok, '基本算式能算出来');
      assert.eq(r.value, '14', '运算符优先级');
      assert.eq(evaluateExpression('2*sqrt(6)').value, String(2 * Math.sqrt(6)), 'sqrt');
      assert.eq(evaluateExpression('pi').value, '3.141592653589793', '常量 pi');
      assert.eq(evaluateExpression('e').value, '2.718281828459045', '常量 e');
      assert.eq(evaluateExpression('2^10').value, '1024', '幂运算');
      assert.eq(evaluateExpression('round(2.567, 2)').value, '2.57', '四舍五入');
      assert.eq(evaluateExpression('gcd(12, 18)').value, '6', '最大公约数');
      assert.eq(evaluateExpression('x = 5; x ^ 2').value, '25', '赋值与分号：mathjs 返回语句数组，拆开后是 25');
      assert.eq(evaluateExpression('[1]').value, '[1]', '长度为 1 的数组字面量不能被当成语句数组拆掉');
      assert.eq(evaluateExpression('max([1, 9, 5])').value, '9', '数组最大值');
      assert.eq(evaluateExpression('derivative("x^2", "x")').value, '2 * x', '符号求导');
      assert(evaluateExpression('5 cm to inch').value.indexOf('in') !== -1, '单位换算');

      /* ---- 显示格式：数字不用 math.format（否则 1000000 会变成 1e+6） ---- */
      assert.eq(evaluateExpression('1000000').value, '1000000', '大整数不走科学计数法');
      assert.eq(evaluateExpression('9007199254740992').value, '9007199254740992', '2^53 不被写成 e+15');
      assert.eq(evaluateExpression('0.1 + 0.2').value, '0.30000000000000004', '浮点误差如实显示');

      /* ---- 除零 / NaN：可读信息，不是 console 报错 ---- */
      var inf = evaluateExpression('1 / 0');
      assert(inf.ok, '1/0 不算错误（数学上就是无穷）');
      assert.eq(inf.special, 'Infinity', '标记出 Infinity');
      var ninf = evaluateExpression('-1 / 0');
      assert.eq(ninf.special, '-Infinity', '标记出 -Infinity');
      var nan = evaluateExpression('0 / 0');
      assert.eq(nan.special, 'NaN', '标记出 NaN');
      assert(evaluateExpression('sqrt(-1)').ok, '负数开方不报错，mathjs 直接给复数');
      assert.eq(evaluateExpression('sqrt(-1)').value, 'i', 'sqrt(-1) = i');
      assert(evaluateExpression('1/0').error === null, '无穷不算错误，error 为 null');

      /* ---- 语法错误 / 未知符号：给可读信息，不抛 ---- */
      var bad = evaluateExpression('2 +* 3');
      assert(!bad.ok, '语法错误要认出来');
      assert(typeof bad.error === 'string' && bad.error.length > 0, '语法错误带可读信息');
      var unknown = evaluateExpression('nope(1)');
      assert(!unknown.ok, '未知函数要认出来');
      assert(unknown.error.indexOf('nope') !== -1, '错误信息里带上出错的函数名');
      assert.eq(evaluateExpression('').ok, false, '空表达式不算成功');
      assert.eq(evaluateExpression('   ').ok, false, '纯空格也不算成功');
      assert(!evaluateExpression('2 +* 3').value, '出错时没有结果文本');
      assert(!evaluateExpression(undefined).ok, 'undefined 输入也不崩');

      /* ---- 沙箱：mathjs 的 import / constructor / __proto__ 这些逃逸口必须挡住 ---- */
      var escapes = [
        'import("a")', 'import({})',
        'constructor', '__proto__',
        'a = ["x"]; a["constructor"]', 'a = ["x"]; a["__proto__"]',
        'a = {}; a.constructor',
        'eval("1")', 'require("fs")',
        'process', 'globalThis', 'window', 'document',
        'Function("return 1")',
        'parser().import({a: 1})',
        'parser().evaluate("import(\'a\')")',
        'config({number: "hex"})',
        '[1, 2].constructor'
      ];
      escapes.forEach(function (e) {
        var res = evaluateExpression(e);
        assert(res.ok === false, '逃逸表达式必须失败：' + e);
        assert(typeof res.error === 'string' && res.error.length > 0, '逃逸表达式要有可读报错：' + e);
      });

      /* ---- 沙箱不能误伤正常用法 ---- */
      ['sqrt(16)', '2+2', 'pi', '[1,2,3]', 'gcd(12,18)', 'derivative("x^3","x")', 'simplify("x + x")',
        'b = 5; b * 3', '1 km to m', 'mod(7,3)'].forEach(function (e) {
          assert(evaluateExpression(e).ok === true, '正常表达式不该被沙箱误伤：' + e);
        });
      assert(BLOCKED_SYMBOLS.every(function (s) { return createScope().has(s); }), '受限作用域里确实遮住了这些符号');
      assert.eq(evaluateExpression('import').value, 'undefined', '被遮住的 import 求出来是 undefined，而不是「Undefined symbol」');
      assert.eq(evaluateExpression('simplify("import(\'a\')")').value, 'import("a")', 'simplify 只解析不求值，import 没被执行');
      assert.eq(createScope({ foo: 7 }).get('foo'), 7, '额外变量能进作用域');
      assert.eq(evaluateExpression('foo * 2', { foo: 21 }).value, '42', '注入的变量参与求值');

      /* ---- 进制转换 ---- */
      assert.eq(toBase(255, 16), 'ff', '255 的十六进制');
      assert.eq(toBase(255, 2), '11111111', '255 的二进制');
      assert.eq(toBase(255, 8), '377', '255 的八进制');
      assert.eq(toBase(255, 10), '255', '十进制原样');
      assert.eq(toBase(0, 16), '0', '0 的十六进制还是 0');
      assert.eq(toBase(1, 2), '1', '最小正数');
      assert.eq(toBase(-255, 16), '-ff', '负数带符号');
      assert.eq(toBase(-0, 16), '0', '-0 当 0 处理');
      assert.eq(toBase(2.5, 16), null, '非整数没有另一种进制');
      assert.eq(toBase(NaN, 16), null, 'NaN 没有进制');
      assert.eq(toBase(Infinity, 2), null, 'Infinity 没有进制');
      assert.eq(toBase('255', 16), null, '字符串不是数字');
      assert.eq(toBase(255, 7), null, '只支持 2/8/10/16');

      /* ---- 结果渲染 ---- */
      var rr = evaluateExpression('255');
      assert.eq(formatResult(rr, 10), '255', '十进制只有一行');
      assert.eq(formatResult(rr, 16), '255\n16 → 0xff', '十六进制带上进制标记');
      assert.eq(formatResult(rr, 2), '255\n2 → 0b11111111', '二进制');
      assert.eq(formatResult(evaluateExpression('1/0'), 16), 'Infinity', '无穷没有二进制那一份');
      assert.eq(formatResult(evaluateExpression('2 +* 3'), 10), '', '出错时渲染为空');

      /* ---- 历史 ---- */
      assert.eq(pushHistory([], '1+1', '2').length, 1, '空历史加一条');
      var h = pushHistory([{ expr: 'old', value: 'x' }], '1+1', '2');
      assert.eq(h.length, 2, '两条');
      assert.eq(h[0].expr, '1+1', '新的排最前');
      var dup = pushHistory([{ expr: '1+1', value: '2' }, { expr: '2+2', value: '4' }], '1+1', '2');
      assert.eq(dup.length, 2, '重复表达式不重复记');
      assert.eq(dup.map(function (x) { return x.expr; }), ['1+1', '2+2'], '重复的那条被顶到最前');
      var many = [];
      for (var i = 0; i < HISTORY_MAX + 10; i++) many = pushHistory(many, 'e' + i, String(i));
      assert.eq(many.length, HISTORY_MAX, '历史最多留 ' + HISTORY_MAX + ' 条');

      /* ---- 速查表：每一条都要能在受限作用域里跑通 ---- */
      var broken = CHEATSHEET.filter(function (x) { return evaluateExpression(x.expr).ok !== true; });
      assert.eq(broken.map(function (x) { return x.expr; }), [], '速查表里的每条表达式都求得了值');
      assert(CHEATSHEET.length >= 30, '速查表内容足够多');
    }
  };
})();