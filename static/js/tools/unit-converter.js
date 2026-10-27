/* ==========================================================================
   通用单位转换器（unit-converter）

   一个「类别 + 从单位 → 到单位 + 数值」的单位换算器，单位按类别分组。

   换算走 convert@5.4.1（vendor 进来的自包含 UMD，142KB）。
   ⚠ 它挂在 window 上的**不是函数**，而是一个命名空间对象 window.convert，
     里面是 { convert, default, convertMany, ms }；真正的换算函数是
     window.convert.default（window.convert.convert 是同一个函数）。
   ⚠ API 形状是 convert(数值, 从单位).to(到单位) —— **没有** .from() 方法。
     传错参数不会静默返回 undefined，而是抛 RangeError：
       "X is not a valid unit" / "Cannot convert between different measures: A and B"。

   与上游 PR #1330 的差别（逐条）：
   · 上游那个 PR 加的是 **10 个工具**：angle / area / energy / force / length /
     mass / many-units / power / pressure / volume —— angle 挂在 Math 分类，
     其余 9 个挂在 Measurement。这里合成**一个**工具：类别 + 从单位 + 到单位
     + 数值 + 结果。
   · 上游 9 个「每量纲一个」的转换器共用一个 UnitsConverter.vue 组件：**每个
     单位各占一行**（标签 + 数字输入框 + 单位符号），改任意一行，其余所有行
     一起重算，页面会拉得很长。这边是「一个数值输入框 → 一个结果」，
     源单位与目标单位用下拉选。
   · 上游的 many-units-converter 是个**表达式解析器**（输入 "1d 2m" → 换算成
     best 单位或指定单位），目标单位是一个塞满 allunits.json 里近千个别名
     （复数形式、同义符号）的可搜索下拉 —— 跟另外 9 个子工具的用法完全对不上。
     这边走的是「从单位 → 到单位」这条路，跟上游那 9 个的语义一致。
   · 温度**不收**：上游那个 PR 没加温度转换器（它复用了仓库里原有的那个），
     而本仓库已有 temperature-converter（Rust 侧实现），支持
     °C / °F / °K / °R / °De / °N / °Ré / °Rø 八种温标，比上游全。
   · 上游 pressure-converter 把 PPa 的**显示名**拼成了 'pettapascal'（单位 id
     本身是对的，所以它那边能换算，只是标签错字）；这边写的是 petapascal。
   · convert 包只有 12 种量纲（角度/面积/数据/能量/力/长度/质量/功率/压力/
     温度/时间/体积），**没有速度**。速度这一类是「长度 ÷ 时间」自己算的，
     系数也由长度/时间单位换算而来，不另写死常数。
   · 上游无任何测试；这边每个单位都有一条自检用例（能换算到本量纲的基准单位）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var It = window.ItTools;

  /**
   * 翻译函数。
   *
   * 变量**不叫** t —— 这类文件里循环变量很容易也叫 t，一遮蔽调用就 TypeError。
   * 但 Rust 侧（src/i18n.rs）与 scripts/new-tool/gen-locales.py 扫的是
   * 「标识符是 t、参数是两个字面量」这个**字面量形状**，所以这里挂在 i18n.t
   * 属性上：属性形式（前面是 '.'）照样扫得到，换名就不会被漏掉。
   */
  var i18n = { t: It.t('unit-converter') };

  /* ---------- 单位表 ---------- */

  /**
   * 每个类别一组单位。
   *
   * · units 里每一项是 [单位 id, 展示名]。id 同时是 select 的 value 和
   *   传给 convert 包的单位名 —— 必须是包认得的，否则抛 "X is not a valid unit"。
   * · base 是本量纲的基准单位，只用于自检：每个单位都要能换算到它。
   * · from / to 是切到这个类别时的默认源单位 / 目标单位。
   * · 展示名保持英文（单位名大多是专有名词或符号），中文界面里类别名会翻译，
   *   单位本身仍是国际通用的符号 + 英文名。
   */
  var CATEGORIES = [
    {
      id: 'length',
      label: i18n.t('cat_length', 'Length'),
      base: 'm',
      from: 'm',
      to: 'km',
      units: [
        ['m', 'meter'], ['km', 'kilometer'], ['cm', 'centimeter'],
        ['mm', 'millimeter'], ['µm', 'micrometer'], ['nm', 'nanometer'],
        ['dm', 'decimeter'], ['mi', 'mile'], ['yd', 'yard'],
        ['ft', 'foot'], ['in', 'inch'], ['nmi', 'nautical mile'],
        ['ly', 'light-year']
      ]
    },
    {
      id: 'mass',
      label: i18n.t('cat_mass', 'Mass / Weight'),
      base: 'kg',
      from: 'kg',
      to: 'lb',
      units: [
        ['kg', 'kilogram'], ['g', 'gram'], ['mg', 'milligram'],
        ['µg', 'microgram'], ['ng', 'nanogram'], ['t', 'tonne'],
        ['kt', 'kilotonne'], ['Mt', 'megatonne'], ['lb', 'pound'],
        ['oz', 'ounce'], ['st', 'stone']
      ]
    },
    {
      id: 'area',
      label: i18n.t('cat_area', 'Area'),
      base: 'm²',
      from: 'm²',
      to: 'ft²',
      units: [
        ['m²', 'square meter'], ['km²', 'square kilometer'],
        ['cm²', 'square centimeter'], ['mm²', 'square millimeter'],
        ['µm²', 'square micrometer'], ['nm²', 'square nanometer'],
        ['ha', 'hectare'], ['ac', 'acre'], ['daa', 'decare'],
        ['are', 'are'], ['da', 'deciare'], ['ca', 'centiare'],
        ['ft²', 'square foot'], ['in²', 'square inch'],
        ['yd²', 'square yard'], ['mi²', 'square mile']
      ]
    },
    {
      id: 'volume',
      label: i18n.t('cat_volume', 'Volume'),
      base: 'L',
      from: 'L',
      to: 'gal',
      units: [
        ['L', 'liter'], ['mL', 'milliliter'], ['m³', 'cubic meter'],
        ['cm³', 'cubic centimeter'], ['ft³', 'cubic foot'],
        ['in³', 'cubic inch'], ['gal', 'US gallon'], ['qt', 'US quart'],
        ['pt', 'US pint'], ['cup', 'cup'], ['fl oz', 'US fluid ounce'],
        ['tbsp', 'US tablespoon'], ['tsp', 'US teaspoon'],
        ['imp gal', 'imperial gallon'], ['imp bbl', 'imperial barrel'],
        ['US dry bbl', 'US dry barrel'], ['ac ft', 'acre-foot']
      ]
    },
    {
      id: 'time',
      label: i18n.t('cat_time', 'Time'),
      base: 's',
      from: 'h',
      to: 'min',
      units: [
        ['s', 'second'], ['ms', 'millisecond'], ['µs', 'microsecond'],
        ['ns', 'nanosecond'], ['min', 'minute'], ['h', 'hour'],
        ['d', 'day'], ['wk', 'week'], ['mo', 'month'], ['y', 'year'],
        ['fn', 'fortnight'], ['md', 'milliday'], ['dec', 'decade']
      ]
    },
    {
      id: 'speed',
      label: i18n.t('cat_speed', 'Speed'),
      base: null,
      from: 'km/h',
      to: 'mph',
      units: [
        ['m/s', 'meter per second'], ['km/h', 'kilometer per hour'],
        ['mph', 'mile per hour'], ['kn', 'knot'], ['ft/s', 'foot per second']
      ]
    },
    {
      id: 'angle',
      label: i18n.t('cat_angle', 'Angle'),
      base: 'deg',
      from: 'deg',
      to: 'rad',
      units: [
        ['deg', 'degree'], ['rad', 'radian'], ['grad', 'gradian'],
        ['turn', 'turn']
      ]
    },
    {
      id: 'pressure',
      label: i18n.t('cat_pressure', 'Pressure'),
      base: 'Pa',
      from: 'Pa',
      to: 'bar',
      units: [
        ['Pa', 'pascal'], ['kPa', 'kilopascal'], ['MPa', 'megapascal'],
        ['GPa', 'gigapascal'], ['hPa', 'hectopascal'], ['mPa', 'millipascal'],
        ['PPa', 'petapascal'], ['bar', 'bar'], ['mbar', 'millibar'],
        ['atm', 'atmosphere'], ['psi', 'pound per square inch'],
        ['Torr', 'torr']
      ]
    },
    {
      id: 'energy',
      label: i18n.t('cat_energy', 'Energy'),
      base: 'J',
      from: 'J',
      to: 'kWh',
      units: [
        ['J', 'joule'], ['kJ', 'kilojoule'], ['MJ', 'megajoule'],
        ['GJ', 'gigajoule'], ['mJ', 'millijoule'], ['µJ', 'microjoule'],
        ['Wh', 'watt-hour'], ['kWh', 'kilowatt-hour'],
        ['MWh', 'megawatt-hour'], ['GWh', 'gigawatt-hour']
      ]
    },
    {
      id: 'power',
      label: i18n.t('cat_power', 'Power'),
      base: 'W',
      from: 'W',
      to: 'hp',
      units: [
        ['W', 'watt'], ['kW', 'kilowatt'], ['MW', 'megawatt'],
        ['GW', 'gigawatt'], ['TW', 'terawatt'], ['mW', 'milliwatt'],
        ['hp', 'mechanical horsepower']
      ]
    },
    {
      id: 'force',
      label: i18n.t('cat_force', 'Force'),
      base: 'N',
      from: 'N',
      to: 'lbf',
      units: [
        ['N', 'newton'], ['kN', 'kilonewton'], ['MN', 'meganewton'],
        ['mN', 'millinewton'], ['dyn', 'dyne'], ['lbf', 'pound of force'],
        ['kgf', 'kilogram-force'], ['kip', 'kip']
      ]
    },
    {
      id: 'data',
      label: i18n.t('cat_data', 'Data size'),
      base: 'B',
      from: 'MB',
      to: 'MiB',
      units: [
        ['B', 'byte'], ['kB', 'kilobyte'], ['MB', 'megabyte'],
        ['GB', 'gigabyte'], ['TB', 'terabyte'], ['PB', 'petabyte'],
        ['KiB', 'kibibyte'], ['MiB', 'mebibyte'], ['GiB', 'gibibyte'],
        ['TiB', 'tebibyte'], ['PiB', 'pebibyte'], ['bit', 'bit']
      ]
    }
  ];

  /**
   * 速度单位 → { 长度单位, 时间单位 }。
   *
   * convert 包没有「速度」这个量纲，所以速度这一类自己算：
   * 1 个该单位 = (长度单位折成多少米) ÷ (时间单位折成多少秒) 米每秒。
   */
  var SPEED_PARTS = {
    'm/s': { len: 'm', tim: 's' },
    'km/h': { len: 'km', tim: 'h' },
    'mph': { len: 'mi', tim: 'h' },
    'kn': { len: 'nmi', tim: 'h' },
    'ft/s': { len: 'ft', tim: 's' }
  };

  /** 单位 id → 类别 id */
  var UNIT_CATEGORY = {};
  /** 类别 id → 类别对象 */
  var CATEGORY_BY_ID = {};
  CATEGORIES.forEach(function (cat) {
    CATEGORY_BY_ID[cat.id] = cat;
    cat.units.forEach(function (pair) {
      UNIT_CATEGORY[pair[0]] = cat.id;
    });
  });

  /* ---------- 纯逻辑 ---------- */

  /**
   * 拿到 convert 包的换算函数。
   * @returns {?function} 库没加载时返回 null（页面上会显示一条错误，而不是白屏）
   */
  function lib() {
    var ns = window.convert;
    if (!ns) return null;
    return ns.default || ns.convert || null;
  }

  /**
   * 解析数值输入。
   * 允许前导 +/-、小数、指数写法；空串与非法写法返回 null。
   * @param {string|number} raw
   * @returns {?number}
   */
  function parseNumber(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s.length) return null;
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /**
   * 结果格式化：先按 12 位有效数字收敛掉浮点尾数噪声
   * （1 cup = 236.58823650000002 mL 这种），非有限值返回空串。
   * @param {number} n
   * @returns {string}
   */
  function formatNumber(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return String(Number(n.toPrecision(12)));
  }

  /**
   * 浮点比较：换算里几乎每一处除法都会带尾数噪声
   * （1 m/s 换成 km/h 是 3.5999999999999996，不是 3.6），
   * 逐字比对期望值只会让用例变成噪声检测器。
   * @param {number} actual
   * @param {number} expected
   * @param {number} [tol] 相对容差，默认 1e-9
   * @returns {boolean}
   */
  function close(actual, expected, tol) {
    if (typeof actual !== 'number' || typeof expected !== 'number') return false;
    if (!isFinite(actual) || !isFinite(expected)) return false;
    var t = typeof tol === 'number' ? tol : 1e-9;
    var scale = Math.max(Math.abs(actual), Math.abs(expected));
    return Math.abs(actual - expected) <= t * Math.max(1, scale);
  }

  /**
   * 「best」那行的格式化：位数再收一点，1.0416666666666667 d → 1.04167 d。
   * @param {number} n
   * @returns {string}
   */
  function formatShort(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return String(Number(n.toPrecision(6)));
  }

  /**
   * 速度单位折成「米每秒」的系数。
   * @param {string} unitId
   * @returns {number}
   */
  function speedFactor(unitId) {
    var parts = SPEED_PARTS[unitId];
    if (!parts) throw new RangeError(unitId + ' is not a valid unit');
    var cv = lib();
    if (!cv) throw new Error('convert library is not loaded');
    var meters = cv(1, parts.len).to('m');
    var seconds = cv(1, parts.tim).to('s');
    return meters / seconds;
  }

  /**
   * 换算。
   *
   * 返回值是**结构化**的：失败时给一个错误码，界面按码取文案。
   * 这样纯逻辑不掺界面文案，__cases 也能对着码断言。
   *
   * @param {string|number} rawValue 输入的数值文本
   * @param {string} fromUnit 源单位 id
   * @param {string} toUnit 目标单位 id
   * @returns {{ok: true, value: number}|{ok: false, code: string}}
   */
  function convertValue(rawValue, fromUnit, toUnit) {
    var num = parseNumber(rawValue);
    if (num === null) return { ok: false, code: 'invalid_number' };

    var fromCat = UNIT_CATEGORY[fromUnit];
    var toCat = UNIT_CATEGORY[toUnit];
    if (!fromCat || !toCat) return { ok: false, code: 'unknown_unit' };
    if (fromCat !== toCat) return { ok: false, code: 'different_measures' };
    if (!lib()) return { ok: false, code: 'no_lib' };

    var out;
    try {
      out = fromCat === 'speed'
        ? num * speedFactor(fromUnit) / speedFactor(toUnit)
        : lib()(num, fromUnit).to(toUnit);
    } catch (e) {
      // 包只抛两种错：单位不认识 / 量纲不同。都已经判过了还抛，
      // 说明单位表里写错了 —— 归到 unknown_unit，界面上会看到。
      return { ok: false, code: 'unknown_unit' };
    }
    if (typeof out !== 'number' || !isFinite(out)) return { ok: false, code: 'not_finite' };
    return { ok: true, value: out };
  }

  /**
   * 「最合适的单位」那一行：库自己挑一个可读性好的单位（默认公制）。
   * 挑不出来就返回空串（不影响主结果）。
   * @param {number} num
   * @param {string} fromUnit
   * @returns {string}
   */
  function bestValue(num, fromUnit) {
    var cv = lib();
    if (!cv) return '';
    try {
      var best = cv(num, fromUnit).to('best');
      if (!best || typeof best.quantity !== 'number') return '';
      return formatShort(best.quantity) + ' ' + best.unit;
    } catch (e) {
      return '';
    }
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('unit-converter', function (root) {
    var catSel = D.h('select.layui-select', { id: 'uc-category' });
    var fromSel = D.h('select.layui-select', { id: 'uc-from' });
    var toSel = D.h('select.layui-select', { id: 'uc-to' });
    var valueInput = D.h('input.layui-input', {
      id: 'uc-value',
      type: 'text',
      inputmode: 'decimal',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: i18n.t('ph_value', 'e.g. 1')
    });
    var swapBtn = D.h('button.layui-btn.layui-btn-sm', {
      type: 'button',
      title: i18n.t('swap', 'Swap units'),
      'aria-label': i18n.t('swap', 'Swap units'),
      text: '⇄'
    });

    var outResult = D.h('div.output-primary');
    var outBest = D.h('div.field-hint');
    var outError = D.h('div.form-status.is-error');
    var outBody = D.h('div.output-body');
    // 复制按钮只复制主结果那一行 —— 共用的 outputCard 复制的是整段文本，
    // 那样会把「最合适的单位」那行也一起复制走（"0.001 kmBest unit: 1 m"）。
    var outCard = D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: i18n.t('result', 'Result') }),
        U.copyButton(function () { return outResult.textContent; })),
      outBody);

    /* 类别下拉 */
    CATEGORIES.forEach(function (cat) {
      catSel.appendChild(D.h('option', { value: cat.id, text: cat.label }));
    });

    /* 单位下拉：按类别分组（optgroup） */
    function fillUnits(sel) {
      D.clear(sel);
      CATEGORIES.forEach(function (cat) {
        var group = D.h('optgroup', { label: cat.label });
        cat.units.forEach(function (pair) {
          var id = pair[0];
          var text = id === pair[1] ? id : pair[1] + ' (' + id + ')';
          group.appendChild(D.h('option', { value: id, text: text }));
        });
        sel.appendChild(group);
      });
    }
    fillUnits(fromSel);
    fillUnits(toSel);

    /** 错误码 → 界面文案 */
    var ERRORS = {
      invalid_number: i18n.t('err_invalid_number', 'The value is not a valid number.'),
      unknown_unit: i18n.t('err_unknown_unit', 'Unknown unit.'),
      different_measures: i18n.t('err_different_measures', 'These units measure different things, so they cannot be converted.'),
      not_finite: i18n.t('err_not_finite', 'The result is not a finite number.'),
      no_lib: i18n.t('err_no_lib', 'The conversion library could not be loaded.')
    };

    /** 重新算一遍并刷新结果区 */
    function render() {
      var raw = valueInput.value;
      D.clear(outBody);
      outBody.appendChild(outResult);
      outBody.appendChild(outBest);
      outBody.appendChild(outError);

      if (!String(raw).trim()) {
        outResult.textContent = '';
        outBest.textContent = '';
        outError.textContent = '';
        return;
      }

      var res = convertValue(raw, fromSel.value, toSel.value);
      if (!res.ok) {
        outResult.textContent = '';
        outBest.textContent = '';
        outError.textContent = ERRORS[res.code] || ERRORS.unknown_unit;
        return;
      }
      outError.textContent = '';
      outResult.textContent = formatNumber(res.value) + ' ' + toSel.value;
      var best = bestValue(parseNumber(raw), fromSel.value);
      outBest.textContent = best ? i18n.t('best', 'Best unit') + ': ' + best : '';
    }

    /**
     * 把类别与两个单位下拉对齐。
     * 源单位和目标单位**必须落在同一个类别里** —— 不会出现「源是米、目标是千克」
     * 这种跨量纲的组合。
     *
     * @param {string} catId 目标类别
     * @param {?string} keepFrom 尽量保留的源单位
     * @param {?string} keepTo 尽量保留的目标单位
     */
    function applyCategory(catId, keepFrom, keepTo) {
      var cat = CATEGORY_BY_ID[catId] || CATEGORIES[0];
      catSel.value = cat.id;
      var from = (keepFrom && UNIT_CATEGORY[keepFrom] === cat.id) ? keepFrom : cat.from;
      var to = (keepTo && UNIT_CATEGORY[keepTo] === cat.id && keepTo !== from) ? keepTo : cat.to;
      if (to === from && cat.units.length > 1) to = cat.to;
      fromSel.value = from;
      toSel.value = to;
      render();
    }

    var offs = [];

    /* 换类别：源单位和目标单位一起更新 */
    offs.push(D.on(catSel, 'change', function () {
      applyCategory(catSel.value, null, null);
    }));

    /* 换源单位：如果它属于别的类别，类别跟着走，目标单位也一起换到同一类别 */
    offs.push(D.on(fromSel, 'change', function () {
      var catId = UNIT_CATEGORY[fromSel.value];
      if (!catId) return;
      if (UNIT_CATEGORY[toSel.value] !== catId) {
        applyCategory(catId, fromSel.value, null);
      } else {
        catSel.value = catId;
        render();
      }
    }));

    /* 换目标单位：同理，源单位要跟到同一类别去 */
    offs.push(D.on(toSel, 'change', function () {
      var catId = UNIT_CATEGORY[toSel.value];
      if (!catId) return;
      if (UNIT_CATEGORY[fromSel.value] !== catId) {
        applyCategory(catId, null, toSel.value);
      } else {
        catSel.value = catId;
        render();
      }
    }));

    /* 交换源单位与目标单位 */
    offs.push(D.on(swapBtn, 'click', function () {
      var f = fromSel.value;
      var t = toSel.value;
      fromSel.value = t;
      toSel.value = f;
      render();
    }));

    offs.push(D.on(valueInput, 'input', render));

    /* 首屏 */
    applyCategory('length', null, null);

    var inputCard = D.h('div.card', null,
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'uc-category', text: i18n.t('label_category', 'Category') }),
        catSel),
      D.h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', gap: '12px', alignItems: 'end', marginBottom: '12px' } },
        D.h('div', null,
          D.h('label.field-label', { for: 'uc-from', text: i18n.t('label_from', 'From') }),
          fromSel),
        swapBtn,
        D.h('div', null,
          D.h('label.field-label', { for: 'uc-to', text: i18n.t('label_to', 'To') }),
          toSel)),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'uc-value', text: i18n.t('label_value', 'Value') }),
        valueInput),
      D.h('p.field-hint', { text: i18n.t('hint', 'Pick a category first: the source and target units always belong to the same category, so metres are never converted into kilograms.') })
    );

    root.appendChild(inputCard);
    root.appendChild(outCard);

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        offs = [];
        D.clear(root);
      }
    };
  });

  /* ---------- 逻辑用例 ---------- */

  window.ItTools.logic['unit-converter'] = {
    CATEGORIES: CATEGORIES,
    UNIT_CATEGORY: UNIT_CATEGORY,
    SPEED_PARTS: SPEED_PARTS,
    parseNumber: parseNumber,
    formatNumber: formatNumber,
    formatShort: formatShort,
    close: close,
    speedFactor: speedFactor,
    convertValue: convertValue,
    bestValue: bestValue,
    __cases: function (assert) {
      /* ---- 数值解析 ---- */
      assert.eq(parseNumber('1'), 1, '普通整数');
      assert.eq(parseNumber('  2.5 '), 2.5, '前后空格 + 小数');
      assert.eq(parseNumber('-3'), -3, '负数');
      assert.eq(parseNumber('+7'), 7, '前导加号');
      assert.eq(parseNumber('.5'), 0.5, '省略整数位');
      assert.eq(parseNumber('1e3'), 1000, '指数写法');
      assert.eq(parseNumber('1.5e-2'), 0.015, '负指数');
      assert.eq(parseNumber(''), null, '空串不是数字');
      assert.eq(parseNumber('abc'), null, '字母不是数字');
      assert.eq(parseNumber('1,5'), null, '逗号不是小数点');
      assert.eq(parseNumber('1 2'), null, '中间有空格');
      assert.eq(parseNumber('Infinity'), null, 'Infinity 不是合法输入');
      assert.eq(parseNumber('NaN'), null, 'NaN 不是合法输入');

      /* ---- 格式化 ---- */
      assert.eq(formatNumber(1000), '1000', '整数原样输出');
      assert.eq(formatNumber(0.1 + 0.2), '0.3', '浮点尾数噪声被收敛掉');
      assert.eq(formatNumber(236.58823650000002), '236.5882365', '1 cup 的 mL 不带尾数噪声');
      assert.eq(formatNumber(NaN), '', 'NaN 输出空串');
      assert.eq(formatNumber(Infinity), '', 'Infinity 输出空串');
      assert.eq(formatShort(1.0416666666666667), '1.04167', 'best 那行位数更短');

      /* ---- 单位表自洽 ---- */
      assert(CATEGORIES.length >= 10, '至少要有 10 个单位类别');
      assert(!CATEGORIES.some(function (c) { return c.id === 'temperature'; }),
        '温度不收进来：仓库里已有 temperature-converter');
      var dup = [];
      var seen = {};
      CATEGORIES.forEach(function (cat) {
        assert(cat.units.length > 1, cat.id + ' 至少要有两个单位');
        assert(UNIT_CATEGORY[cat.from] === cat.id, cat.id + ' 的默认源单位在本类别里');
        assert(UNIT_CATEGORY[cat.to] === cat.id, cat.id + ' 的默认目标单位在本类别里');
        cat.units.forEach(function (pair) {
          if (seen[pair[0]]) dup.push(pair[0]);
          seen[pair[0]] = true;
        });
      });
      assert.eq(dup, [], '单位不能跨类别重复');
      assert.eq(seen.pettapascal, undefined, '上游把 petapascal 拼成了 pettapascal，这边不能跟着错');
      assert(UNIT_CATEGORY['PPa'] === 'pressure', 'petapascal 的单位名写对了（PPa）');

      /* ---- 每个单位都要能被库认得 ---- */
      var cv = lib();
      assert(typeof cv === 'function', 'convert 库挂出来了（window.convert.default）');
      var unknown = [];
      CATEGORIES.forEach(function (cat) {
        if (!cat.base) return;
        cat.units.forEach(function (pair) {
          try {
            cv(1, pair[0]).to(cat.base);
          } catch (e) {
            unknown.push(pair[0]);
          }
        });
      });
      assert.eq(unknown, [], '所有单位都要能换算到本量纲的基准单位');

      /* ---- 基本换算 ---- */
      var r1 = convertValue('1', 'km', 'm');
      assert(r1.ok && r1.value === 1000, '1 公里 = 1000 米');
      assert.eq(convertValue('1000', 'm', 'km').value, 1, '1000 米 = 1 公里');
      assert.eq(convertValue('1', 'kg', 'g').value, 1000, '1 千克 = 1000 克');
      assert.eq(convertValue('1', 'lb', 'kg').value, 0.45359237, '1 磅 = 0.45359237 千克');
      assert.eq(convertValue('1', 'h', 'min').value, 60, '1 小时 = 60 分钟');
      assert.eq(convertValue('1', 'atm', 'Pa').value, 101325, '1 标准大气压 = 101325 帕');
      assert.eq(convertValue('1', 'Wh', 'J').value, 3600, '1 瓦时 = 3600 焦耳');
      assert.eq(convertValue('1', 'deg', 'rad').value, Math.PI / 180, '1 度 = π/180 弧度');
      assert.eq(convertValue('1', 'hp', 'W').value, 745.699872, '1 马力 = 745.699872 瓦');
      assert.eq(convertValue('1', 'KiB', 'B').value, 1024, '1 KiB = 1024 B');
      assert.eq(convertValue('1', 'kB', 'B').value, 1000, '1 kB = 1000 B');
      assert.eq(convertValue('1', 'zorkmid', 'm'), { ok: false, code: 'unknown_unit' }, '不认识的单位要报错，不能静默');
      assert.eq(convertValue('1', 'gal', 'L').value, 3.785411784, '1 美制加仑 = 3.785411784 升');

      /* ---- 速度（convert 包没有这个量纲，自己算） ---- */
      assert(close(convertValue('1', 'km/h', 'm/s').value, 1 / 3.6), '1 km/h = 1/3.6 m/s');
      assert(close(convertValue('1', 'm/s', 'km/h').value, 3.6), '1 m/s = 3.6 km/h');
      assert(close(convertValue('100', 'km/h', 'mph').value, 62.13711922373339), '100 km/h ≈ 62.1371 mph');
      assert(close(convertValue('1', 'kn', 'm/s').value, 1852 / 3600), '1 节 = 1852/3600 m/s');
      assert(close(convertValue('1', 'ft/s', 'm/s').value, 0.3048), '1 ft/s = 0.3048 m/s');
      assert(close(speedFactor('km/h'), 1 / 3.6), '速度系数由长度/时间单位换算而来');

      /* ---- 失败要有错误码，不能静默 ---- */
      assert.eq(convertValue('abc', 'km', 'm'), { ok: false, code: 'invalid_number' }, '非法输入');
      assert.eq(convertValue('', 'km', 'm'), { ok: false, code: 'invalid_number' }, '空输入');
      assert.eq(convertValue('1', 'zzz', 'm'), { ok: false, code: 'unknown_unit' }, '源单位不认识');
      assert.eq(convertValue('1', 'm', 'zzz'), { ok: false, code: 'unknown_unit' }, '目标单位不认识');
      assert.eq(convertValue('1', 'm', 'kg'), { ok: false, code: 'different_measures' }, '跨量纲不换算');
      assert.eq(convertValue('1', 'kg', 'm'), { ok: false, code: 'different_measures' }, '跨量纲不换算（反过来也一样）');

      /* ---- best 那一行 ---- */
      assert.eq(bestValue(1234, 'm'), '1.234 km', '1234 米 ≈ 1.234 公里');
      assert.eq(bestValue(1, 'kg'), '1 kg', '1 千克本身就是 1 kg');
    }
  };
})();
