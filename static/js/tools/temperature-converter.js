/* ==========================================================================
   温度换算器（temperature-converter）

   八个温标（K / °C / °F / °R / °De / °N / °Ré / °Rø）以开尔文为中枢互相换算。
   改任意一行，其余七行同步刷新。

   参考实现：src/tools/temperature-converter/（it-tools, GPLv3）
   与原版的两处差别：
   1. 原版把结果写回 units[index]，而 index 来自「omit 掉源单位之后」的数组，
      源单位是 kelvin（第 0 项）时整体错位一位 —— 编辑 Kelvin 会把别的单位的结果
      写到错误的行上。这里改成「解析源值 → 转 K → 逐个目标单位换算」，没有下标错位。
   2. 原版用 Math.floor(x * 100) / 100 截断（0.999 → 0.99，负数还会向下多切一位），
      这里改成四舍五入到两位小数，并把 -0 归一成 0。

   Delisle 按定义式实现（0 °De = 100 °C，150 °De = 0 °C）：
   °De = (373.15 - K) × 1.5，反解 K = 373.15 - (2/3)·°De。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('temperature-converter');

  /* ---- 换算公式：全部以开尔文为中枢 ---- */

  function identity(v) { return v; }

  var c2k = function (v) { return v + 273.15; };
  var k2c = function (v) { return v - 273.15; };
  var f2k = function (v) { return (v + 459.67) * (5 / 9); };
  var k2f = function (v) { return v * (9 / 5) - 459.67; };
  var r2k = function (v) { return v * (5 / 9); };
  var k2r = function (v) { return v * (9 / 5); };
  /** Delisle：0 °De = 100 °C（373.15 K），150 °De = 0 °C（273.15 K）。
      定义式 °De = (373.15 - K) × 1.5，反解就是 K = 373.15 - (2/3)·°De。 */
  var de2k = function (v) { return 373.15 - (2 / 3) * v; };
  var kde = function (v) { return (373.15 - v) * 1.5; };
  /** Newton：33 °N = 100 °C。 */
  var n2k = function (v) { return v * (100 / 33) + 273.15; };
  var kn = function (v) { return (v - 273.15) * (33 / 100); };
  /** Réaumur：80 °Ré = 100 °C。 */
  var re2k = function (v) { return v * (5 / 4) + 273.15; };
  var kre = function (v) { return (v - 273.15) * (4 / 5); };
  /** Rømer：7.5 °Rø = 0 °C，60 °Rø = 100 °C（每 40 °C 走 21 °Rø）。 */
  var ro2k = function (v) { return (v - 7.5) * (40 / 21) + 273.15; };
  var kro = function (v) { return (v - 273.15) * (21 / 40) + 7.5; };

  var UNITS = [
    { key: 'kelvin', title: t('kelvin', 'Kelvin'), unit: 'K', toK: identity, fromK: identity },
    { key: 'celsius', title: t('celsius', 'Celsius'), unit: '°C', toK: c2k, fromK: k2c },
    { key: 'fahrenheit', title: t('fahrenheit', 'Fahrenheit'), unit: '°F', toK: f2k, fromK: k2f },
    { key: 'rankine', title: t('rankine', 'Rankine'), unit: '°R', toK: r2k, fromK: k2r },
    { key: 'delisle', title: t('delisle', 'Delisle'), unit: '°De', toK: de2k, fromK: kde },
    { key: 'newton', title: t('newton', 'Newton'), unit: '°N', toK: n2k, fromK: kn },
    { key: 'reaumur', title: t('reaumur', 'Réaumur'), unit: '°Ré', toK: re2k, fromK: kre },
    { key: 'romer', title: t('romer', 'Rømer'), unit: '°Rø', toK: ro2k, fromK: kro }
  ];

  var byKey = {};
  UNITS.forEach(function (u) { byKey[u.key] = u; });

  /**
   * 四舍五入到两位小数，-0 归一成 0。
   * Math.round 在 .5 处向 +∞ 取整，对负数不对称，这里用「符号对称」写法修正。
   */
  function round2(value) {
    var n = Number(value);
    if (!isFinite(n)) return NaN;
    var r = Math.round(Math.abs(n) * 100) / 100;
    return (r === 0 ? 0 : (n < 0 ? -r : r));
  }

  /**
   * 单次换算。单位键不认识时抛错，不静默返回 NaN。
   * @param {number} value
   * @param {string} from 单位键
   * @param {string} to   单位键
   */
  function convert(value, from, to) {
    var src = byKey[from];
    var dst = byKey[to];
    if (!src) throw new Error('未知单位：' + from);
    if (!dst) throw new Error('未知单位：' + to);
    var n = Number(value);
    if (!isFinite(n)) throw new Error('不是有效数字：' + value);
    return dst.fromK(src.toK(n));
  }

  /**
   * 读数换算成开尔文。
   * @param {number} value
   * @param {string} from 单位键
   */
  function kelvinOf(value, from) {
    var src = byKey[from];
    if (!src) throw new Error('未知单位：' + from);
    var n = Number(value);
    if (!isFinite(n)) throw new Error('不是有效数字：' + value);
    return src.toK(n);
  }

  /**
   * 读数是否低于绝对零度（0 K）。
   *
   * 绝对零度是物理下限，负的开尔文不存在。原版（与上游 #1879 一样）会把
   * 换算出来的负开尔文原样显示出来，用户只会以为程序算错了 —— 这里钳到 0 K，
   * 并由界面明确提示「低于绝对零度，已钳位」。
   *
   * @param {number} value
   * @param {string} from 单位键
   */
  function belowAbsoluteZero(value, from) {
    return kelvinOf(value, from) < 0;
  }

  /**
   * 把某个温标的读数一次换算成全部八个温标，返回值已按两位小数舍入。
   * 低于绝对零度的输入按 0 K 算（见 belowAbsoluteZero）。
   * @returns {Array<{key:string,title:string,unit:string,value:number}>}
   */
  function convertAll(value, from) {
    var kelvin = kelvinOf(value, from);
    if (kelvin < 0) kelvin = 0;
    return UNITS.map(function (u) {
      return { key: u.key, title: u.title, unit: u.unit, value: round2(u.fromK(kelvin)) };
    });
  }

  /**
   * 解析输入框：空串、只有一个负号、非法字符都返回 null（调用方据此清空其它行）。
   * 允许前导 +、小数、指数写法。
   */
  function parseValue(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s.length) return null;
    if (s.charAt(0) === '+') s = s.slice(1);
    if (!s.length || s === '-') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  window.ItTools.register('temperature-converter', function (root) {
    /** key -> input，同步换算时按 key 找输入框 */
    var inputs = {};
    var warn = D.h('p.form-status');

    function showWarning(v, from) {
      D.clear(warn);
      if (v === null || !belowAbsoluteZero(v, from)) {
        warn.classList.remove('is-warn');
        return;
      }
      warn.classList.add('is-warn');
      warn.appendChild(D.h('span', {
        text: t('below_absolute_zero', 'This temperature is below absolute zero (0 K), which is physically impossible — the converted result has been clamped to 0 K.')
      }));
    }

    var rows = UNITS.map(function (u) {
      var input = D.h('input.layui-input', {
        type: 'number', step: 'any', value: '0', 'aria-label': u.title
      });
      input.id = 'tc-' + u.key;
      inputs[u.key] = input;

      input.addEventListener('input', function () {
        var v = parseValue(input.value);
        if (v === null) {
          // 输入框被清空或正在输入非法字符：其余行跟着空掉，但不动它自己
          UNITS.forEach(function (o) { if (o.key !== u.key) inputs[o.key].value = ''; });
          showWarning(null, u.key);
          return;
        }
        var all = convertAll(v, u.key);
        all.forEach(function (row) {
          if (row.key !== u.key) inputs[row.key].value = String(row.value);
        });
        showWarning(v, u.key);
      });

      // 原版每个温标是一行 n-input-group：左边一格 100px 的温标名、
      // 中间是输入框、右边一格 50px 的单位 —— 三格紧挨着（没有间隙），
      // 两格都是带边框的 n-input-group-label，文字左对齐。
      return D.h('div.input-group.temperature-converter-row', null,
        D.h('span.input-group-label.temperature-converter-scale', { text: u.title }),
        input,
        D.h('span.input-group-label.temperature-converter-unit', { text: u.unit })
      );
    });

    root.appendChild(D.h('div.card', null,
      D.h('p.field-hint', { text: t('sync_hint', 'Edit any row and the other seven scales convert immediately.') }),
      warn,
      rows
    ));

    // 初始状态对齐原版：0 K 出发，八个温标全是 0
    convertAll(0, 'kelvin').forEach(function (row) { inputs[row.key].value = String(row.value); });

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['temperature-converter'] = {
    UNITS: UNITS,
    convert: convert,
    convertAll: convertAll,
    kelvinOf: kelvinOf,
    belowAbsoluteZero: belowAbsoluteZero,
    round2: round2,
    parseValue: parseValue,
    __cases: function (assert) {
      function near(a, b, msg) {
        assert(Math.abs(a - b) < 1e-9, (msg || '') + ' 期望≈' + b + '，实际 ' + a);
      }

      // 常见温标（浮点尾数用 round2 收掉，和界面显示的口径一致）
      assert.eq(convert(0, 'celsius', 'kelvin'), 273.15, '0°C = 273.15 K');
      assert.eq(round2(convert(100, 'celsius', 'fahrenheit')), 212, '100°C = 212°F');
      assert.eq(round2(convert(-40, 'celsius', 'fahrenheit')), -40, '-40°C = -40°F');
      assert.eq(convert(273.15, 'kelvin', 'celsius'), 0, '273.15 K = 0°C');
      assert.eq(round2(convert(32, 'fahrenheit', 'celsius')), 0, '32°F = 0°C');
      assert.eq(round2(convert(212, 'fahrenheit', 'kelvin')), 373.15, '212°F = 373.15 K');
      near(convert(0, 'rankine', 'kelvin'), 0, '0°R = 0 K');
      near(convert(491.67, 'rankine', 'fahrenheit'), 32, '491.67°R ≈ 32°F');

      // Delisle 的两个定点：0 °De = 100 °C，150 °De = 0 °C（正好是 100 与 150 两个刻度）
      assert.eq(convert(0, 'delisle', 'celsius'), 100, '0 °De = 100 °C');
      assert.eq(convert(150, 'delisle', 'celsius'), 0, '150 °De = 0 °C');
      assert.eq(round2(convert(273.15, 'kelvin', 'delisle')), 150, '273.15 K = 0 °C = 150 °De');
      assert.eq(round2(convert(373.15, 'kelvin', 'delisle')), 0, '373.15 K = 100 °C = 0 °De');
      // 负温方向：−50 °C = 223.15 K，对应 225 °De
      assert.eq(round2(convert(-50, 'celsius', 'delisle')), 225, '-50 °C = 225 °De');

      // Newton / Réaumur / Rømer 的定点
      near(convert(0, 'newton', 'celsius'), 0, '0 °N = 0 °C');
      near(convert(33, 'newton', 'celsius'), 100, '33 °N = 100 °C');
      near(convert(80, 'reaumur', 'celsius'), 100, '80 °Ré = 100 °C');
      near(convert(7.5, 'romer', 'celsius'), 0, '7.5 °Rø = 0 °C');
      near(convert(60, 'romer', 'celsius'), 100, '60 °Rø = 100 °C（1 °Rø = 40/21 °C）');
      near(convert(0, 'reaumur', 'kelvin'), 273.15, '0 °Ré = 273.15 K');

      // 八个温标两两往返都应回到原值
      UNITS.forEach(function (u) {
        UNITS.forEach(function (v) {
          near(convert(convert(21.5, u.key, v.key), v.key, u.key), 21.5, u.key + ' → ' + v.key + ' 往返');
        });
      });

      // convertAll：8 行、源单位原样、其余都是 273.15 K 的等价读数
      var all = convertAll(0, 'celsius');
      assert.eq(all.length, 8, 'convertAll 返回 8 个温标');
      assert.eq(all[1].value, 0, '源单位保留原值');
      near(all[0].value, 273.15, 'kelvin');
      near(all[2].value, 32, 'fahrenheit');
      near(all[3].value, 491.67, 'rankine');
      near(all[4].value, 150, 'delisle');

      // 舍入
      assert.eq(round2(1.23456), 1.23, '四舍五入');
      assert.eq(round2(1.235), 1.24, '四舍五入到 0.5 向上');
      assert.eq(round2(-1.235), -1.24, '负数对称');
      assert.eq(round2(-0.001), 0, '-0 归一为 0');

      // 低于绝对零度（上游 #1879）：钳到 0 K，并把这件事报告出来
      assert.eq(belowAbsoluteZero(-300, 'celsius'), true, '-300°C 低于绝对零度');
      assert.eq(belowAbsoluteZero(0, 'kelvin'), false, '0 K 不是低于绝对零度');
      assert.eq(belowAbsoluteZero(-273.15, 'celsius'), false, '-273.15°C 正好是 0 K');
      var clamped = convertAll(-300, 'celsius');
      assert.eq(clamped[0].value, 0, '低于绝对零度时开尔文钳到 0');
      assert.eq(clamped[1].value, -273.15, '摄氏度是 -273.15（也就是 0 K）');
      assert.eq(convertAll(0, 'celsius')[0].value, 273.15, '正常输入不受钳位影响');

      // 输入解析
      assert.eq(parseValue(''), null, '空串');      assert.eq(parseValue('-'), null, '只有一个符号');
      assert.eq(parseValue('abc'), null, '非法字符');
      assert.eq(parseValue('.5'), 0.5, '省略整数位');
      assert.eq(parseValue('+12'), 12, '前导加号');

      // 未知单位必须报错，不能静默
      var threw = false;
      try { convert(1, 'foo', 'kelvin'); } catch (e) { threw = true; }
      assert(threw, '未知源单位应抛错');
      threw = false;
      try { convert(1, 'kelvin', 'bar'); } catch (e) { threw = true; }
      assert(threw, '未知目标单位应抛错');
    }
  };
})();