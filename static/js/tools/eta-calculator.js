/* ==========================================================================
   到达时间估算（eta-calculator）

   「我按这个速度要走完这么多量，得多久、几点到？」
   每一段填：总量、每多少时间消化多少、从什么时候开始；可以加多段（路程/速度、
   洗盘子/速度……都算），总耗时是各段之和，到达时间 = 出发时间 + 总耗时，
   再用 date-fns 的 formatRelative 给一句「大约还有多久」的人话描述。

   参考实现：src/tools/eta-calculator/（it-tools, GPLv3）
   与原版的差别：
   1. 原版只有一个「总量 / 每时间段消费数」输入框，把盘子这种例子写死在文案里。
      这里抽象成「段」列表（起点 + 若干段 + 出发时间），一段就是原版那套公式，
      多段直接相加。
   2. **原版的 formatMsDuration 调 date-fns 的 formatDuration，而打包进浏览器的
      只有 formatRelative**（见 scripts/vendor-js-libs.sh 的 date-fns 条目），照抄
      直接 undefined。这里自己写一个纯函数的时长格式化，顺带补上了原版丢掉的
      「天」——原版 hours 可以一路涨到 900 也不换算，读起来很怪。
   3. 原版只有一句 formatRelative 的结果。这里同时给绝对到达时间（本地时区
      字符串）和相对描述。**实测**formatRelative 的文案随 locale/时区变，而且
      差值超过 **6 天**（不是 56 年）就直接退回 `MM/DD/YYYY` 绝对日期 —— 那句话
      对 ETA 毫无信息量，所以超过 6 天时改用自己的 formatDuration 说「还差多久」。
      相对描述只当参考，__cases 里不断言具体措辞。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('eta-calculator');

  /** 时间段单位 → 毫秒，和参考实现的下拉一致。label 是下拉框里的显示名，走 i18n。 */
  var TIME_UNITS = [
    { value: 1, label: t('unit_ms', 'milliseconds') },
    { value: 1000, label: t('unit_s', 'seconds') },
    { value: 60 * 1000, label: t('unit_min', 'minutes') },
    { value: 60 * 60 * 1000, label: t('unit_h', 'hours') },
    { value: 24 * 60 * 60 * 1000, label: t('unit_d', 'days') }
  ];

  var UNIT_BY_VALUE = {};
  TIME_UNITS.forEach(function (u) { UNIT_BY_VALUE[u.value] = u; });

  /** date-fns 的 formatRelative 只在 ±6 天内说人话，再远就退回绝对日期（实测） */
  var RELATIVE_WINDOW_DAYS = 6;

  /** 默认的一段：沿用参考实现的「3 个 62 分钟吃 500 个」的量级 */
  function defaultLeg() {
    return { amount: 500, perSpan: 3, span: 62, spanUnit: 60 * 1000 };
  }

  /** 出发时间 <input type="datetime-local"> 的字符串 → 毫秒时间戳；解析不了给 null */
  function parseLocalDateTime(value) {
    if (value === null || value === undefined || value === '') return null;
    var ts = Date.parse(value);
    return isNaN(ts) ? null : ts;
  }

  /** datetime-local 的字符串（本地时区）→ 人读的绝对时间 */
  function formatAbsolute(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /** 把 datetime-local 的字符串回填成 input 能吃的格式（去掉秒） */
  function toDatetimeLocalValue(ms) {
    var s = formatAbsolute(ms);
    return s.length >= 16 ? s.slice(0, 16) : '';
  }

  /**
   * 一段要花多久。
   * 参考实现的公式：unitCount / (unitPerTimeSpan / timeSpanMs)
   * 等价于 amount * spanMs / perSpan。
   * @param {{amount:number, perSpan:number, span:number, spanUnit:number}} leg
   * @returns {{ok:boolean, ms:(number|null), error:(string|null)}}
   */
  function legDuration(leg) {
    var amount = Number(leg && leg.amount);
    var perSpan = Number(leg && leg.perSpan);
    var span = Number(leg && leg.span);
    var spanUnit = Number(leg && leg.spanUnit);

    // 错误文案走 i18n，同时给一个稳定的 code —— 断言看 code，不看措辞
    if (!isFinite(amount) || amount < 0) {
      return { ok: false, ms: null, error: t('err_amount', 'Amount must be a number ≥ 0.'), errorCode: 'amount' };
    }
    if (!isFinite(perSpan) || perSpan <= 0) {
      return { ok: false, ms: null, error: t('err_rate', 'Rate must be a number > 0 (otherwise the ETA is infinite).'), errorCode: 'rate' };
    }
    if (!isFinite(span) || span <= 0) {
      return { ok: false, ms: null, error: t('err_span', 'Time span must be a number > 0.'), errorCode: 'span' };
    }
    if (!UNIT_BY_VALUE[spanUnit]) {
      return { ok: false, ms: null, error: t('err_unit', 'Unknown time span unit.'), errorCode: 'unit' };
    }

    var ms = amount * span * spanUnit / perSpan;
    if (!isFinite(ms)) {
      return { ok: false, ms: null, error: t('err_finite', 'Result is not a finite duration.'), errorCode: 'finite' };
    }
    return { ok: true, ms: ms, error: null, errorCode: null };
  }

  /**
   * 整条估算。所有段都合法才算成功。
   * @param {Array<Object>} legs
   * @param {number} startedAtMs 出发时间（毫秒时间戳）
   * @returns {{ok:boolean, durationMs:(number|null), endAtMs:(number|null), parts:Array, error:(string|null)}}
   */
  function estimate(legs, startedAtMs) {
    var list = Array.isArray(legs) ? legs : [];
    if (!list.length) {
      return { ok: false, durationMs: null, endAtMs: null, parts: [], error: t('err_no_leg', 'Add at least one leg.'), errorCode: 'no_leg' };
    }
    if (typeof startedAtMs !== 'number' || !isFinite(startedAtMs)) {
      return { ok: false, durationMs: null, endAtMs: null, parts: [], error: t('err_no_start', 'Pick a start date/time.'), errorCode: 'no_start' };
    }

    var total = 0;
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var r = legDuration(list[i]);
      if (!r.ok) {
        return {
          ok: false, durationMs: null, endAtMs: null, parts: parts,
          error: t('err_leg', 'Leg {n}: {error}').replace('{n}', String(i + 1)).replace('{error}', r.error),
          errorCode: 'leg', errorParams: { n: i + 1 }
        };
      }
      parts.push(r.ms);
      total += r.ms;
    }
    if (!isFinite(total)) {
      return { ok: false, durationMs: null, endAtMs: null, parts: parts, error: t('err_overflow', 'Total duration overflowed.'), errorCode: 'overflow' };
    }
    return { ok: true, durationMs: total, endAtMs: startedAtMs + total, parts: parts, error: null, errorCode: null };
  }

  /**
   * 把毫秒数写成「1 天 2 小时 3 分钟 4 秒 5 毫秒」。
   * 自己写而不用 date-fns 的 formatDuration：打包进浏览器的只有 formatRelative，
   * 而且原版那种写法永远停在「小时」这一级，900 小时也不折算成天。
   * @param {number} ms
   * @returns {string}
   */
  function formatDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    var sign = ms < 0 ? '-' : '';
    var rest = Math.floor(Math.abs(ms));
    var units = [
      { ms: 24 * 60 * 60 * 1000, one: t('dur_day', 'day'), many: t('dur_days', 'days') },
      { ms: 60 * 60 * 1000, one: t('dur_hour', 'hour'), many: t('dur_hours', 'hours') },
      { ms: 60 * 1000, one: t('dur_minute', 'minute'), many: t('dur_minutes', 'minutes') },
      { ms: 1000, one: t('dur_second', 'second'), many: t('dur_seconds', 'seconds') },
      { ms: 1, one: t('dur_millisecond', 'millisecond'), many: t('dur_milliseconds', 'milliseconds') }
    ];
    var parts = [];
    units.forEach(function (u) {
      var v = Math.floor(rest / u.ms);
      if (v > 0) {
        parts.push(t('dur_part', '{n} {unit}').replace('{n}', String(v)).replace('{unit}', v === 1 ? u.one : u.many));
      }
      rest -= v * u.ms;
    });
    if (!parts.length) return sign + t('dur_zero', '0 milliseconds');
    return sign + parts.join(' ');
  }

  /**
   * 相对描述。走 Intl，文案随 locale 和本机时区变，差值超过 6 天就退回 MM/DD/YYYY
   * 这种绝对日期，所以这里只保证「拿到一句非空的输出」，不保证具体措辞。
   * @param {number} targetMs
   * @param {number} [baseMs]
   * @returns {string}
   */
  function describeRelative(targetMs, baseMs) {
    if (!window.dateFns) return '';
    var base = typeof baseMs === 'number' ? baseMs : Date.now();
    try {
      // dateFns 就是 formatRelative(date, baseDate)，少传第二个参数会抛
      return window.dateFns(new Date(targetMs), new Date(base));
    } catch (e) {
      return '';
    }
  }

  /** 两个时间戳相差多少天（按日历天取整，够 UI 判断用） */
  function dayDifference(aMs, bMs) {
    if (typeof aMs !== 'number' || typeof bMs !== 'number' || !isFinite(aMs) || !isFinite(bMs)) return null;
    return Math.round((aMs - bMs) / 86400000);
  }

  /** 差值还在 formatRelative 说得清楚的范围里吗 */
  function isWithinRelativeWindow(aMs, bMs) {
    var d = dayDifference(aMs, bMs);
    return d === null ? false : Math.abs(d) <= RELATIVE_WINDOW_DAYS;
  }

  window.ItTools.register('eta-calculator', function (root) {
    var startedAtInput = D.h('input.layui-input', { type: 'datetime-local', step: '1' });
    startedAtInput.value = toDatetimeLocalValue(Date.now());

    var offs = [];
    var legsBox = D.h('div');
    var resultBox = D.h('div');
    var errorBox = D.h('p.field-hint.is-error', { style: { display: 'none' } });

    function legRow(leg) {
      var amount = D.h('input.layui-input', { type: 'number', min: '0', step: 'any', value: String(leg.amount) });
      var perSpan = D.h('input.layui-input', { type: 'number', min: '0.0001', step: 'any', value: String(leg.perSpan) });
      var span = D.h('input.layui-input', { type: 'number', min: '0.0001', step: 'any', value: String(leg.span) });
      var spanUnit = D.h('select.layui-input', null, TIME_UNITS.map(function (u) {
        return D.h('option', { value: String(u.value), text: u.label });
      }));
      spanUnit.value = String(leg.spanUnit);
      var del = D.h('button.icon-btn', {
        type: 'button',
        title: t('remove_leg', 'Remove this leg'),
        'aria-label': t('remove_leg', 'Remove this leg')
      });

      var row = D.h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' } },
        U.field(t('amount', 'Amount'), amount),
        U.field(t('per', 'per'), perSpan),
        U.field(t('in', 'in'), span),
        U.field('', spanUnit),
        del);

      del.addEventListener('click', function () {
        D.clear(legsBox);
        state = state.filter(function (x) { return x !== leg; });
        state.forEach(function (l) { legsBox.appendChild(legRow(l)); });
        render();
      });

      [amount, perSpan, span].forEach(function (el) {
        offs.push(D.on(el, 'input', function () {
          leg.amount = Number(amount.value);
          leg.perSpan = Number(perSpan.value);
          leg.span = Number(span.value);
          render();
        }));
      });
      offs.push(D.on(spanUnit, 'change', function () { leg.spanUnit = Number(spanUnit.value); render(); }));

      return row;
    }

    var state = [defaultLeg()];
    state.forEach(function (l) { legsBox.appendChild(legRow(l)); });

    function render() {
      var res = estimate(state, parseLocalDateTime(startedAtInput.value));
      D.clear(resultBox);
      if (!res.ok) {
        errorBox.style.display = '';
        errorBox.textContent = res.error;
        return;
      }
      errorBox.style.display = 'none';
      errorBox.textContent = '';

      var now = Date.now();
      var rows = res.parts.map(function (ms, i) {
        return D.h('tr', null,
          D.h('td', { text: t('leg', 'Leg {n}').replace('{n}', String(i + 1)) }),
          D.h('td', { text: formatDuration(ms) }),
          D.h('td', { text: formatAbsolute(parseLocalDateTime(startedAtInput.value) + res.parts.slice(0, i + 1).reduce(function (a, b) { return a + b; }, 0)) }));
      });
      rows.push(D.h('tr', null,
        D.h('td', null, D.h('strong', { text: t('total', 'Total') })),
        D.h('td', null, D.h('strong', { text: formatDuration(res.durationMs) })),
        D.h('td', null, D.h('strong', { text: formatAbsolute(res.endAtMs) }))));

      resultBox.appendChild(D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_segment', 'Segment') }),
          D.h('th', { text: t('col_duration', 'Duration') }),
          D.h('th', { text: t('col_done_at', 'Done at') }))),
        D.h('tbody', null, rows)));

      // 超过 6 天 formatRelative 就只给个绝对日期了（等于把上面那行再说一遍），
      // 这种时候改用自己的时长格式化说「还差多久」。
      var relative = isWithinRelativeWindow(res.endAtMs, now)
        ? describeRelative(res.endAtMs, now)
        : (res.endAtMs >= now
          ? t('ends_in', '{duration} from now').replace('{duration}', formatDuration(Math.abs(res.endAtMs - now)))
          : t('ends_ago', '{duration} ago').replace('{duration}', formatDuration(Math.abs(res.endAtMs - now))));
      var card = D.outputCard(t('it_will_end', 'It will end'));
      card.outputBody.appendChild(D.h('div', { text: formatAbsolute(res.endAtMs) }));
      card.outputBody.appendChild(D.h('div.muted', { text: relative ? '≈ ' + relative : '' }));
      resultBox.appendChild(card);
    }

    var addBtn = D.h('button.layui-btn.layui-btn-sm', { type: 'button', text: t('add_leg', '+ Add a leg') });
    addBtn.addEventListener('click', function () {
      var leg = defaultLeg();
      state.push(leg);
      legsBox.appendChild(legRow(leg));
      render();
    });
    offs.push(D.on(startedAtInput, 'input', render));

    // 两块面板：左边输入、右边结果。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      D.h('p.field-hint', {
        text: t('hint', 'With a concrete example: if you wash 5 plates in 3 minutes and you have 500 plates to wash, it takes about 5 hours. Fill one leg per stretch of the trip (distance / speed, tasks / pace…) and the ETA is the sum.')
      }),
      // 原版：说明文字 → 分隔线 → 输入区
      U.divider(),
      U.field(t('started_at', 'The consumption started at'), startedAtInput, { wide: true }),
      D.h('h3.section-head', { text: t('section_head', 'Amount consumed by time span'), style: { marginTop: '12px' } }),
      legsBox,
      D.h('div.form-actions', null, addBtn),
      errorBox
    ));
    // 原版：输入区 → 分隔线 → 两张统计卡
    root.appendChild(U.divider());
    root.appendChild(D.h('div.card', null, resultBox));
    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['eta-calculator'] = {
    TIME_UNITS: TIME_UNITS,
    defaultLeg: defaultLeg,
    parseLocalDateTime: parseLocalDateTime,
    formatAbsolute: formatAbsolute,
    toDatetimeLocalValue: toDatetimeLocalValue,
    legDuration: legDuration,
    estimate: estimate,
    formatDuration: formatDuration,
    describeRelative: describeRelative,
    dayDifference: dayDifference,
    isWithinRelativeWindow: isWithinRelativeWindow,
    RELATIVE_WINDOW_DAYS: RELATIVE_WINDOW_DAYS,
    __cases: function (assert) {
      var START = Date.UTC(2024, 0, 1, 12, 0, 0);

      /* ---- 单段时长：公式与参考实现一致（amount / (perSpan / spanMs)） ---- */
      // 参考实现的默认值：500 个盘子，62 分钟内吃 3 个 → 500/3*62 分钟
      var def = defaultLeg();
      assert.eq(def.amount, 500, '默认总量 500');
      assert.eq(def.perSpan, 3, '默认速率 3');
      assert.eq(def.span, 62, '默认时间段 62');
      assert.eq(def.spanUnit, 60 * 1000, '默认时间段单位是分钟');

      var one = legDuration({ amount: 500, perSpan: 3, span: 62, spanUnit: 60 * 1000 });
      assert(one.ok, '默认这一段算得出来');
      assert.eq(one.ms, 500 * 62 * 60000 / 3, '公式就是 amount × 时间段 ÷ 速率');
      assert.eq(legDuration({ amount: 5, perSpan: 5, span: 3, spanUnit: 60 * 1000 }).ms, 3 * 60000, '5 个 5 分钟 = 3 分钟');
      assert.eq(legDuration({ amount: 100, perSpan: 100, span: 1, spanUnit: 1000 }).ms, 1000, '100 米/秒 跑 100 米 = 1 秒');
      assert.eq(legDuration({ amount: 0, perSpan: 1, span: 1, spanUnit: 1000 }).ms, 0, '总量 0 → 用时 0');
      assert.eq(legDuration({ amount: 10, perSpan: 1, span: 1, spanUnit: 24 * 3600000 }).ms, 10 * 24 * 3600000, '天为单位的换算');
      assert.eq(legDuration({ amount: 2.5, perSpan: 1, span: 1, spanUnit: 1000 }).ms, 2500, '小数量也能算');

      /* ---- 非法输入 ---- */
      assert(!legDuration({ amount: -1, perSpan: 1, span: 1, spanUnit: 1000 }).ok, '负总量报错');
      assert(!legDuration({ amount: 1, perSpan: 0, span: 1, spanUnit: 1000 }).ok, '速率为 0 报错（否则 ETA 永远是无穷）');
      assert(!legDuration({ amount: 1, perSpan: -2, span: 1, spanUnit: 1000 }).ok, '负速率报错');
      assert(!legDuration({ amount: 1, perSpan: 1, span: 0, spanUnit: 1000 }).ok, '时间段为 0 报错');
      assert(!legDuration({ amount: 1, perSpan: 1, span: 1, spanUnit: 7 }).ok, '未知的时间段单位报错');
      assert(!legDuration({ amount: 'x', perSpan: 1, span: 1, spanUnit: 1000 }).ok, '非数字报错');
      assert(!legDuration(null).ok, 'null 段不崩');
      assert(!legDuration({}).ok, '空对象不崩');
      assert(typeof legDuration({ amount: 1, perSpan: 1, span: 1, spanUnit: 7 }).error === 'string', '错误要带可读信息');

      /* ---- 多段求和 ---- */
      var legs = [
        { amount: 500, perSpan: 3, span: 62, spanUnit: 60 * 1000 },
        { amount: 10, perSpan: 10, span: 1, spanUnit: 1000 },
        { amount: 0, perSpan: 1, span: 1, spanUnit: 1000 }
      ];
      var est = estimate(legs, START);
      assert(est.ok, '多段能算出来');
      assert.eq(est.parts.length, 3, '每段各有一个时长');
      assert.eq(est.durationMs, est.parts[0] + est.parts[1] + est.parts[2], '总时长 = 各段之和');
      assert.eq(est.endAtMs, START + est.durationMs, '到达时间 = 出发时间 + 总时长');
      assert.eq(estimate([legs[0]], START).durationMs, legs[0].amount * 62 * 60000 / 3, '只有一段时就是那一段');
      assert.eq(estimate(legs, START).error, null, '成功时没有错误');

      /* ---- estimate 的边界 ---- */
      assert(!estimate([], START).ok, '一段都没有要报错');
      assert(!estimate(null, START).ok, 'null 段列表不崩');
      assert(!estimate(legs, null).ok, '没有出发时间要报错');
      assert(!estimate(legs, NaN).ok, '出发时间是 NaN 要报错');
      assert(!estimate(legs, '2024-01-01').ok, '出发时间传字符串不静默转');
      assert(estimate([{ amount: 0, perSpan: 1, span: 1, spanUnit: 1000 }], START).endAtMs === START, '总量为 0 时到达时间 = 出发时间');
      var oneBad = estimate([legs[0], { amount: 1, perSpan: 0, span: 1, spanUnit: 1000 }], START);
      assert(!oneBad.ok, '有一段非法就整体失败');
      assert(oneBad.errorCode === 'leg' && oneBad.errorParams.n === 2, '错误信息指明是哪一段');

      /* ---- 时长格式化 ---- */
      assert.eq(formatDuration(0), '0 milliseconds', '0 也要有话可说');
      assert.eq(formatDuration(1), '1 millisecond', '1 不加复数 s');
      assert.eq(formatDuration(999), '999 milliseconds', '不足一秒');
      assert.eq(formatDuration(1000), '1 second', '一秒');
      assert.eq(formatDuration(1500), '1 second 500 milliseconds', '秒 + 毫秒');
      assert.eq(formatDuration(60000), '1 minute', '一分钟');
      assert.eq(formatDuration(3661000), '1 hour 1 minute 1 second', '时/分/秒');
      assert.eq(formatDuration(24 * 3600000), '1 day', '正好一天');
      assert.eq(formatDuration(24 * 3600000 + 1), '1 day 1 millisecond', '一天零一毫秒');
      assert.eq(formatDuration(90061000), '1 day 1 hour 1 minute 1 second', '原版会一直停在 25 小时，这里会折算成天');
      assert.eq(formatDuration(-2000), '-2 seconds', '负时长带负号');
      assert.eq(formatDuration(NaN), '—', 'NaN');
      assert.eq(formatDuration(Infinity), '—', 'Infinity');
      assert.eq(formatDuration('1000'), '—', '字符串不是时长');

      /* ---- 时间解析 / 格式化 ---- */
      assert.eq(parseLocalDateTime(''), null, '空串给 null');
      assert.eq(parseLocalDateTime(null), null, 'null 给 null');
      assert.eq(parseLocalDateTime('not a date'), null, '解析不了给 null，不抛');
      assert(typeof parseLocalDateTime('2024-01-01T12:00:00') === 'number', 'datetime-local 字符串能解析');
      var formatted = formatAbsolute(Date.UTC(2024, 0, 2, 3, 4, 5));
      assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(formatted), '绝对时间是 YYYY-MM-DD HH:mm:ss 形状：' + formatted);
      assert.eq(toDatetimeLocalValue(Date.UTC(2024, 0, 2, 3, 4, 5)).length, 16, '回填 datetime-local 截到分钟');
      assert.eq(formatAbsolute(NaN), '', '非法时间戳给空串');

      /* ---- 相对描述 ---- */
      // 文案走 Intl，随 locale 和本机时区变，且差值超过约 56 年会退回绝对日期，
      // 所以这里只断言「拿到一句非空的人话」，不断言具体措辞。
      var rel = describeRelative(START + 3600000, START);
      assert(typeof rel === 'string' && rel.length > 0, '一小时的差值能拿到相对描述');
      assert(describeRelative(START + 3600000, START) === describeRelative(START + 3600000, START), '同样输入两次结果一致');
      assert(describeRelative(START + 3600000, START) !== describeRelative(START - 3600000, START), '过去和未来的说法不同');
      assert(describeRelative(START + 10 * 86400000, START).length > 0, '10 天的差值也拿得到输出');
      var far = describeRelative(START + 60 * 365 * 24 * 3600000, START); // 60 年
      assert(typeof far === 'string' && far.length > 0, '60 年的差值退回绝对日期，但依然有输出');
      assert(describeRelative(START, START).length > 0, '零差值也有描述');

      /* ---- formatRelative 只在 ±6 天内说人话（实测，和清单里的说明不一致） ---- */
      assert.eq(RELATIVE_WINDOW_DAYS, 6, '阈值实测就是 6 天');
      assert.eq(dayDifference(START, START), 0, '同一个时刻差 0 天');
      assert.eq(dayDifference(START + 86400000, START), 1, '正好一天');
      assert.eq(dayDifference(START - 86400000, START), -1, '过去一天是 -1');
      assert.eq(dayDifference(START + 10 * 86400000, START), 10, '十天');
      assert.eq(dayDifference(NaN, START), null, 'NaN 给 null');
      assert(isWithinRelativeWindow(START + 6 * 86400000, START), '6 天还在窗口内');
      assert(!isWithinRelativeWindow(START + 7 * 86400000, START), '7 天就出窗口了');
      assert(!isWithinRelativeWindow(START - 7 * 86400000, START), '过去 7 天同样出窗口');
      assert(isWithinRelativeWindow(START, START), '0 天在窗口内');
      assert(!isWithinRelativeWindow(NaN, START), '非法输入不在窗口内');
    }
  };
})();