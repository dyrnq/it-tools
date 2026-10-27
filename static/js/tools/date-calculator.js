/* ==========================================================================
   日期计算器（date-calculator）

   三件事：
   1. 给一个基准日期加减 N 天；
   2. 算两个日期之间隔多久（多少个日历日 / 整周 / 整月 / 整年 / 工作日）；
   3. 算年龄（年 / 月 / 日 + 总天数）。

   参考实现：it-tools PR #1811 里的 `date-calculator` 子工具（GPLv3，
   版权归 Corentin Thomasset 所有）。跟上游的差别：
   1. **不引第三方库。** 上游用 date-fns，但打包进浏览器的那个 date-fns 产物
      （static/lib/date-fns/bundle.js，入口只有 formatRelative/index.js）
      压根没有导出 addDays / differenceInDays 这些函数 —— 照抄直接崩。
      这里的日期算术全部自己写。
   2. **日期算术不走时间戳差。** 常见的日期库拿「毫秒数 ÷ 86400000」当天数，
      或者在**本地时区**的 Date 上 setDate —— 夏令时切换那天一天不是 24 小时，
      于是结果会凭空差一天。这里全程只用 Date.UTC / getUTC*：先把「年-月-日」
      换算成该日历日的序号（整数天），再用整数天差去算。整个工具里唯一碰本地
      时间的是「今天」（today 这个概念本来就是本地的），拿到年月日后立刻转成
      UTC 序号，后面再也不碰时区。
   3. **整月 / 整年按日历算**，不是按 30 天 / 365 天折算：把起始日加 N 个
      日历月（月末对齐裁剪）看有没有超过结束日。
   4. **非法日期直接判非法。** 2024-02-31 这种输入，JS 的 Date 会悄悄滚到
      3 月 2 号；这里一律拒绝并给出提示，不让错的日期混进算式。
   5. **工作日的区间取 (起始日, 结束日]** —— 不含起始日、含结束日。这与本
      卡片「相差 N 个日历日」的口径一致：相差 N 天就是这两天之间跨过的那
      N 天（起始日之后、结束日当天）。法定节假日不处理，界面提示里写明了。
      （规格正文另有一句「不含起始日与结束日」，那样 2024-01-01 → 2024-01-08
      只会剩 4 天；这里取了与「相差 N 天」自洽的那一版，界面上也写明了口径。）
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var t = window.ItTools.t('date-calculator');

  var MS_PER_DAY = 86400000;

  /** 「经过的每个月」这张表最多列几行（再多的给一行汇总）。 */
  var MAX_MONTH_ROWS = 24;

  /** 星期几的名字。索引与 Date#getUTCDay 一致（0 = 周日）。 */
  var WEEKDAY_NAMES = [
    t('weekday_sunday', 'Sunday'),
    t('weekday_monday', 'Monday'),
    t('weekday_tuesday', 'Tuesday'),
    t('weekday_wednesday', 'Wednesday'),
    t('weekday_thursday', 'Thursday'),
    t('weekday_friday', 'Friday'),
    t('weekday_saturday', 'Saturday')
  ];

  /* ---------------------------------------------------------------------
     纯逻辑：日历日 ↔ 序号、日期算术
     --------------------------------------------------------------------- */

  /** 公历闰年：四年一闰，百年不闰，四百年再闰。1900 不是闰年，2000 是。 */
  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  /** 某年某月的天数（m 从 1 数到 12）。 */
  function daysInMonth(y, m) {
    var LEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (m === 2) return isLeapYear(y) ? 29 : 28;
    return LEN[m - 1];
  }

  /**
   * 解析「YYYY-MM-DD」，非法返回 null。
   *
   * 严格：月份要 1..12、日要 1..当月的真实天数。2024-02-31、2024-13-01、
   * 2023-02-29、空串统统判非法 —— 绝不让 Date 把它滚到下个月去。
   * 月和日允许写成一位数（2024-1-5），跟原生日期框的行为对齐。
   */
  function parseDate(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s.length) return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (!m) return null;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (mo < 1 || mo > 12) return null;
    if (d < 1 || d > daysInMonth(y, mo)) return null;
    return { y: y, m: mo, d: d };
  }

  /**
   * 该日历日的 UTC 零点（毫秒）。
   *
   * 用 Date.UTC 而不是 new Date(y, m, d) —— 后者是**本地时区**的零点，
   * 夏令时那天它的 UTC 偏移会变，拿它算日期就会差一天。
   * Date.UTC 还有个坑：0..99 会被当成 1900..1999，这里要原样保留。
   */
  function utcMillis(date) {
    var ms = Date.UTC(date.y, date.m - 1, date.d);
    if (date.y >= 0 && date.y < 100) {
      var dt = new Date(ms);
      dt.setUTCFullYear(date.y);
      ms = dt.getTime();
    }
    return ms;
  }

  /**
   * 日历日 → 序号（自 1970-01-01 起的整数天）。
   * UTC 恒定是 24 小时制，所以这个除法永远整除，不会有夏令时的零头。
   */
  function toSerial(date) {
    return Math.floor(utcMillis(date) / MS_PER_DAY);
  }

  /** 序号 → 日历日。 */
  function fromSerial(n) {
    var dt = new Date(n * MS_PER_DAY);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  /** 加 N 天（可为负）。 */
  function addDays(date, n) {
    return fromSerial(toSerial(date) + n);
  }

  /**
   * 加 N 个日历月。日对不齐时裁到目标月的最后一天：
   * 2024-01-31 + 1 个月 = 2024-02-29（2024 是闰年）。
   * 生日在 2 月 29 日的人，到平年的 2 月 28 日就满一年了 —— 全靠这个裁剪。
   */
  function addMonths(date, n) {
    var total = (date.y * 12 + (date.m - 1)) + n;
    var y = Math.floor(total / 12);
    var m = total - y * 12 + 1;
    return { y: y, m: m, d: Math.min(date.d, daysInMonth(y, m)) };
  }

  /** 比较两个日历日：a < b → -1，相等 → 0，a > b → 1。 */
  function compareDates(a, b) {
    var sa = toSerial(a);
    var sb = toSerial(b);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }

  /** 相差多少个日历日（b − a，带符号）。 */
  function diffDays(a, b) {
    return toSerial(b) - toSerial(a);
  }

  /** 星期几：0 = 周日 … 6 = 周六（在 UTC 零点算，与本机时区无关）。 */
  function weekdayOf(date) {
    return new Date(utcMillis(date)).getUTCDay();
  }

  /** 星期几的名字。 */
  function weekdayName(w) {
    return WEEKDAY_NAMES[w] || '';
  }

  /**
   * 两个日期之间相差多少个整月。
   *
   * 口径：从起始日加 N 个日历月（月末对齐裁剪）之后不超过结束日的最大 N。
   * 这不是「按 30 天折算」—— 2024-01-01 到 2024-01-31 相隔 30 天，
   * 但整整 0 个月；2024-01-31 到 2024-02-29 则是整整 1 个月。
   * 结束日早于起始日时返回负数。
   */
  function wholeMonthsBetween(a, b) {
    var sign = compareDates(a, b) <= 0 ? 1 : -1;
    var lo = sign > 0 ? a : b;
    var hi = sign > 0 ? b : a;
    var months = (hi.y - lo.y) * 12 + (hi.m - lo.m);
    if (months > 0 && compareDates(addMonths(lo, months), hi) > 0) months -= 1;
    return sign * months;
  }

  /** 相差多少整年（按日历：周年那天才算满一年）。 */
  function wholeYearsBetween(a, b) {
    var months = wholeMonthsBetween(a, b);
    return months >= 0 ? Math.floor(months / 12) : Math.ceil(months / 12);
  }

  /**
   * 两个日期之间的工作日（周一到周五）个数。
   *
   * 区间取 (起始日, 结束日]：不含起始日、含结束日。与本卡片「相差 N 个
   * 日历日」的口径一致（相差 N 天 = 这两天之间跨过的那 N 天）。
   * 法定节假日不处理 —— 界面的提示里写明了。
   */
  function businessDaysBetween(a, b) {
    var sign = compareDates(a, b) <= 0 ? 1 : -1;
    var lo = sign > 0 ? a : b;
    var hi = sign > 0 ? b : a;
    var from = toSerial(lo) + 1;   // 不含起始日
    var to = toSerial(hi);         // 含结束日
    if (to < from) return 0;
    var total = to - from + 1;
    // 序号 0 = 1970-01-01 = 星期四，所以序号 % 7 为 2 是周六、3 是周日
    return sign * (total - countMod(from, to, 2) - countMod(from, to, 3));
  }

  /** [a, b] 里模 7 等于 r 的整数个数（a <= b）。 */
  function countMod(a, b, r) {
    return Math.floor((b - r) / 7) - Math.floor((a - 1 - r) / 7);
  }

  /**
   * 年龄：年 / 月 / 日，外加总天数。
   *
   * 先算整月数（见 wholeMonthsBetween），再拆成年 * 12 + 余月，
   * 剩下的天数是「从那个周年日算到参照日」的天数。
   * 参照日早于出生日时各项为负。
   */
  function ageBetween(birth, ref) {
    var sign = compareDates(birth, ref) <= 0 ? 1 : -1;
    var lo = sign > 0 ? birth : ref;
    var hi = sign > 0 ? ref : birth;
    var totalMonths = wholeMonthsBetween(lo, hi);
    var years = Math.floor(totalMonths / 12);
    var months = totalMonths - years * 12;
    var days = diffDays(addMonths(lo, totalMonths), hi);
    return {
      years: sign * years,
      months: sign * months,
      days: sign * days,
      totalMonths: sign * totalMonths,
      totalDays: sign * diffDays(lo, hi)
    };
  }

  /**
   * 两个日期之间经过的每个月，以及这个月里落在区间内的天数。
   * 例：2024-01-15 → 2024-03-10 = 1 月 17 天（15..31）、2 月 29 天、3 月 10 天。
   */
  function monthsBreakdown(a, b) {
    var sign = compareDates(a, b) <= 0 ? 1 : -1;
    var lo = sign > 0 ? a : b;
    var hi = sign > 0 ? b : a;
    var out = [];
    var y = lo.y;
    var m = lo.m;
    while (out.length < 120000) {   // 保险丝：年份最多四位，这个上限碰不到
      var last = daysInMonth(y, m);
      var from = (y === lo.y && m === lo.m) ? lo.d : 1;
      var to = (y === hi.y && m === hi.m) ? hi.d : last;
      out.push({ y: y, m: m, days: to - from + 1 });
      if (y === hi.y && m === hi.m) break;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }

  /** 日历日 → 'YYYY-MM-DD'。 */
  function formatIso(date) {
    var y = date.y < 0 ? '-' + String(-date.y).padStart(4, '0') : String(date.y).padStart(4, '0');
    return y + '-' + String(date.m).padStart(2, '0') + '-' + String(date.d).padStart(2, '0');
  }

  /** '2024-01' 这样的月份标签。 */
  function formatMonth(y, m) {
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0');
  }

  /**
   * 「今天」—— 本地日历日。
   *
   * 这是整个工具里唯一碰本地时区的地方：today 这个概念本来就是本地的
   * （UTC 的 2024-03-10 10:00 在纽约已经是 3 月 10 日凌晨）。
   * 拿到年月日之后立刻转成 UTC 序号，后面不再碰时区。
   */
  function todayLocal() {
    var now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  }

  /** 天数输入框：只收整数（含负号），其余给 null。 */
  function parseDayOffset(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s.length) return null;
    if (!/^[+-]?\d+$/.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /** 带符号的天数：正数带 '+'，负数自带 '-'，零就是 '0'。 */
  function signedNumber(n) {
    return n > 0 ? '+' + n : String(n);
  }

  /* ---------------------------------------------------------------------
     界面
     --------------------------------------------------------------------- */

  window.ItTools.register('date-calculator', function (root) {
    var offs = [];
    var today = todayLocal();

    /** 结果表里的一行「标签 | 值」。 */
    function resultRow(label, value) {
      return D.h('tr', null,
        D.h('td', { text: label }),
        D.h('td', null, D.h('strong', { text: value }))
      );
    }

    function resultTable(rows) {
      return D.h('table.result-table', null, D.h('tbody', null, rows));
    }

    /** 红色的错误提示。 */
    function errorLine(text) {
      return D.h('p.field-hint', { text: text, style: { color: '#d03050' } });
    }

    /** 区分「没填」与「填错了」两种非法。 */
    function dateError(input) {
      var raw = String(input.value == null ? '' : input.value).trim();
      if (!raw.length) return t('err_empty_date', 'Please pick a date.');
      return t('err_invalid_date', 'Invalid date. Use the YYYY-MM-DD format, for example 2024-01-31.');
    }

    /* ---- 一、加减日期 ---- */

    var baseInput = D.h('input.layui-input#dc-base', { type: 'date', value: formatIso(today) });
    var daysInput = D.h('input.layui-input#dc-days', { type: 'number', step: '1', value: '30' });
    var addOut = D.h('div');

    function renderAdd() {
      D.clear(addOut);
      var base = parseDate(baseInput.value);
      if (!base) {
        addOut.appendChild(errorLine(dateError(baseInput)));
        return;
      }
      var n = parseDayOffset(daysInput.value);
      if (n === null) {
        addOut.appendChild(errorLine(t('err_invalid_days', 'The number of days must be a whole number (it may be negative).')));
        return;
      }
      var target = addDays(base, n);
      var fromToday = diffDays(today, target);
      var card = D.outputCard(t('result', 'Result'));
      card.outputBody.appendChild(resultTable([
        resultRow(t('result_date', 'Result date'), formatIso(target)),
        resultRow(t('weekday', 'Weekday'), weekdayName(weekdayOf(target))),
        resultRow(t('days_from_today', 'Days from today'), signedNumber(fromToday))
      ]));
      addOut.appendChild(card);
    }

    /* ---- 二、两个日期之间的间隔 ---- */

    var startInput = D.h('input.layui-input#dc-start', { type: 'date', value: formatIso(today) });
    var endInput = D.h('input.layui-input#dc-end', { type: 'date', value: formatIso(today) });
    var diffOut = D.h('div');

    function renderDiff() {
      D.clear(diffOut);
      var a = parseDate(startInput.value);
      var b = parseDate(endInput.value);
      if (!a) {
        diffOut.appendChild(errorLine(dateError(startInput)));
        return;
      }
      if (!b) {
        diffOut.appendChild(errorLine(dateError(endInput)));
        return;
      }
      var days = diffDays(a, b);
      // 整周是「整整几周」，向零取整（-30 天是 -4 周零 2 天，不是 -5 周）
      var weeks = days >= 0 ? Math.floor(days / 7) : Math.ceil(days / 7);
      var months = wholeMonthsBetween(a, b);
      var years = wholeYearsBetween(a, b);
      var business = businessDaysBetween(a, b);

      var card = D.outputCard(t('result', 'Result'));
      card.outputBody.appendChild(resultTable([
        resultRow(t('calendar_days', 'Calendar days'), signedNumber(days)),
        resultRow(t('whole_weeks', 'Whole weeks'), signedNumber(weeks)),
        resultRow(t('whole_months', 'Whole months'), signedNumber(months)),
        resultRow(t('whole_years', 'Whole years'), signedNumber(years)),
        resultRow(t('business_days', 'Business days'), signedNumber(business))
      ]));

      // 经过的每个月各占多少天（表太长就只列前 24 行，剩下的给一行汇总）
      var breakdown = monthsBreakdown(a, b);
      if (breakdown.length) {
        var shown = breakdown.slice(0, MAX_MONTH_ROWS);
        var rows = shown.map(function (x) {
          return D.h('tr', null,
            D.h('td', { text: formatMonth(x.y, x.m) }),
            D.h('td', { text: String(x.days) })
          );
        });
        if (breakdown.length > shown.length) {
          rows.push(D.h('tr', null,
            D.h('td', { text: t('months_more', 'and {n} more months')
              .replace('{n}', function () { return String(breakdown.length - shown.length); }) }),
            D.h('td', { text: '' })
          ));
        }
        card.outputBody.appendChild(D.h('h3.section-head', { text: t('months_in_between', 'Months in between') }));
        card.outputBody.appendChild(D.h('table.result-table', null,
          D.h('thead', null, D.h('tr', null,
            D.h('th', { text: t('col_month', 'Month') }),
            D.h('th', { text: t('col_days', 'Days') }))),
          D.h('tbody', null, rows)
        ));
      }
      diffOut.appendChild(card);
    }

    /* ---- 三、年龄 ---- */

    var birthInput = D.h('input.layui-input#dc-birth', { type: 'date', value: '' });
    var refInput = D.h('input.layui-input#dc-ref', { type: 'date', value: formatIso(today) });
    var ageOut = D.h('div');

    function renderAge() {
      D.clear(ageOut);
      var birth = parseDate(birthInput.value);
      if (!birth) {
        ageOut.appendChild(errorLine(dateError(birthInput)));
        return;
      }
      var ref = parseDate(refInput.value);
      if (!ref) {
        ageOut.appendChild(errorLine(dateError(refInput)));
        return;
      }
      var age = ageBetween(birth, ref);
      var card = D.outputCard(t('result', 'Result'));
      card.outputBody.appendChild(D.h('div', {
        text: t('age_summary', '{years} years, {months} months, {days} days')
          .replace('{years}', function () { return String(age.years); })
          .replace('{months}', function () { return String(age.months); })
          .replace('{days}', function () { return String(age.days); })
      }));
      card.outputBody.appendChild(resultTable([
        resultRow(t('years', 'Years'), String(age.years)),
        resultRow(t('months', 'Months'), String(age.months)),
        resultRow(t('days', 'Days'), String(age.days)),
        resultRow(t('total_days', 'Total days'), String(age.totalDays))
      ]));
      ageOut.appendChild(card);
    }

    /* ---- 装配 ---- */

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('add_subtract_title', 'Add or subtract days') }),
      D.h('p.field-hint', { text: t('hint_calendar_day', 'Every date is a calendar day (YYYY-MM-DD): no time of day and no time zone, so a daylight-saving switch never shifts a result by a day.') }),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'dc-base', text: t('base_date', 'Base date') }),
        baseInput
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'dc-days', text: t('days_offset', 'Days to add (negative subtracts)') }),
        daysInput
      ),
      addOut
    ));

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('difference_title', 'Difference between two dates') }),
      D.h('p.field-hint', { text: t('hint_whole_months', 'Whole months and years are counted on the calendar, not as 30 or 365 days: the day is clipped to the last day of the month (January 31 + 1 month = February 29).') }),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'dc-start', text: t('start_date', 'Start date') }),
        startInput
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'dc-end', text: t('end_date', 'End date') }),
        endInput
      ),
      D.h('p.field-hint', { text: t('hint_business_days', 'Business days are Monday to Friday; the start date is excluded and the end date is included. Public holidays are not taken into account.') }),
      diffOut
    ));

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('age_title', 'Age') }),
      D.h('p.field-hint', { text: t('hint_age', 'The age is counted on the calendar: years and months are whole calendar months from the date of birth, and the remaining days are counted from that anniversary.') }),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'dc-birth', text: t('birth_date', 'Date of birth') }),
        birthInput
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'dc-ref', text: t('reference_date', 'Reference date') }),
        refInput
      ),
      ageOut
    ));

    function watch(el, fn) {
      offs.push(D.on(el, 'input', fn));
      offs.push(D.on(el, 'change', fn));
    }
    watch(baseInput, renderAdd);
    watch(daysInput, renderAdd);
    watch(startInput, renderDiff);
    watch(endInput, renderDiff);
    watch(birthInput, renderAge);
    watch(refInput, renderAge);

    renderAdd();
    renderDiff();
    renderAge();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  /* ---------------------------------------------------------------------
     单测用例
     --------------------------------------------------------------------- */
  window.ItTools.logic['date-calculator'] = {
    isLeapYear: isLeapYear,
    daysInMonth: daysInMonth,
    parseDate: parseDate,
    utcMillis: utcMillis,
    toSerial: toSerial,
    fromSerial: fromSerial,
    addDays: addDays,
    addMonths: addMonths,
    compareDates: compareDates,
    diffDays: diffDays,
    weekdayOf: weekdayOf,
    weekdayName: weekdayName,
    wholeMonthsBetween: wholeMonthsBetween,
    wholeYearsBetween: wholeYearsBetween,
    businessDaysBetween: businessDaysBetween,
    ageBetween: ageBetween,
    monthsBreakdown: monthsBreakdown,
    formatIso: formatIso,
    parseDayOffset: parseDayOffset,
    signedNumber: signedNumber,
    __cases: function (assert) {
      /* ---- 闰年规则（公历：四年一闰、百年不闰、四百年再闰） ---- */
      assert.eq(isLeapYear(2024), true, '2024 是闰年');
      assert.eq(isLeapYear(2023), false, '2023 不是闰年');
      assert.eq(isLeapYear(1900), false, '1900 不是闰年（百年不闰）');
      assert.eq(isLeapYear(2000), true, '2000 是闰年（四百年再闰）');
      assert.eq(isLeapYear(2100), false, '2100 不是闰年');
      assert.eq(isLeapYear(2400), true, '2400 是闰年');
      assert.eq(isLeapYear(1600), true, '1600 是闰年');
      assert.eq(isLeapYear(4), true, '公元 4 年是闰年');
      assert.eq(isLeapYear(1), false, '公元 1 年不是闰年');
      assert.eq(daysInMonth(2024, 2), 29, '2024 年 2 月 29 天');
      assert.eq(daysInMonth(2023, 2), 28, '2023 年 2 月 28 天');
      assert.eq(daysInMonth(1900, 2), 28, '1900 年 2 月 28 天');
      assert.eq(daysInMonth(2000, 2), 29, '2000 年 2 月 29 天');
      assert.eq(daysInMonth(2024, 1), 31, '1 月 31 天');
      assert.eq(daysInMonth(2024, 4), 30, '4 月 30 天');
      assert.eq(daysInMonth(2024, 12), 31, '12 月 31 天');

      /* ---- 解析：非法日期必须判非法，不许滚到下个月 ---- */
      assert.eq(parseDate('2024-01-15'), { y: 2024, m: 1, d: 15 }, '正常日期能解析');
      assert.eq(parseDate('2024-02-29'), { y: 2024, m: 2, d: 29 }, '闰年的 2 月 29 日合法');
      assert.eq(parseDate('2023-02-29'), null, '平年的 2 月 29 日非法');
      assert.eq(parseDate('2024-02-31'), null, '2024-02-31 非法（不能滚到 3 月 2 日）');
      assert.eq(parseDate('2024-13-01'), null, '13 月非法');
      assert.eq(parseDate('2024-00-10'), null, '0 月非法');
      assert.eq(parseDate('2024-01-00'), null, '0 日非法');
      assert.eq(parseDate('2024-01-32'), null, '32 日非法');
      assert.eq(parseDate(''), null, '空串非法');
      assert.eq(parseDate(null), null, 'null 非法');
      assert.eq(parseDate('  '), null, '只有空白的串非法');
      assert.eq(parseDate('not a date'), null, '乱七八糟的串非法');
      assert.eq(parseDate('2024/01/15'), null, '斜杠不是约定的格式');
      assert.eq(parseDate('2024-1-5'), { y: 2024, m: 1, d: 5 }, '月日写一位数也能解析');

      /* ---- 加减天数：跨年、跨月、闰年 ---- */
      assert.eq(formatIso(addDays(parseDate('2024-01-15'), 30)), '2024-02-14', '2024-01-15 + 30 天 = 2024-02-14');
      assert.eq(formatIso(addDays(parseDate('2024-01-15'), -30)), '2023-12-16', '2024-01-15 − 30 天 = 2023-12-16');
      assert.eq(formatIso(addDays(parseDate('2024-02-28'), 1)), '2024-02-29', '2024-02-28 + 1 天 = 2024-02-29');
      assert.eq(formatIso(addDays(parseDate('2023-02-28'), 1)), '2023-03-01', '2023-02-28 + 1 天 = 2023-03-01');
      assert.eq(formatIso(addDays(parseDate('2024-02-29'), 1)), '2024-03-01', '2024-02-29 + 1 天 = 2024-03-01');
      assert.eq(formatIso(addDays(parseDate('1899-12-31'), 1)), '1900-01-01', '1899-12-31 + 1 天 = 1900-01-01');
      assert.eq(formatIso(addDays(parseDate('1900-02-28'), 1)), '1900-03-01', '1900 不是闰年：1900-02-28 + 1 天 = 1900-03-01');
      assert.eq(formatIso(addDays(parseDate('2000-02-28'), 1)), '2000-02-29', '2000 是闰年：2000-02-28 + 1 天 = 2000-02-29');
      assert.eq(formatIso(addDays(parseDate('2024-01-01'), 0)), '2024-01-01', '加 0 天还是自己');
      assert.eq(formatIso(addDays(parseDate('2024-01-01'), -1)), '2023-12-31', '减 1 天跨年');
      assert.eq(formatIso(addDays(parseDate('2024-01-01'), 365)), '2024-12-31', '闰年加 365 天还差一天到年末');
      assert.eq(formatIso(addDays(parseDate('2024-01-01'), 366)), '2025-01-01', '闰年加 366 天正好一年');
      assert.eq(formatIso(addDays(parseDate('2023-01-01'), 365)), '2024-01-01', '平年加 365 天正好一年');

      /* ---- 夏令时：全程走 UTC 序号，切换日当天照样是一个日历日 ---- */
      assert.eq(formatIso(addDays(parseDate('2024-03-10'), 1)), '2024-03-11', '美国夏令时开始日 2024-03-10 + 1 天 = 2024-03-11');
      assert.eq(formatIso(addDays(parseDate('2024-10-06'), 1)), '2024-10-07', '美国夏令时结束日 2024-10-06 + 1 天 = 2024-10-07');
      assert.eq(formatIso(addDays(parseDate('2024-03-31'), 1)), '2024-04-01', '欧洲夏令时开始日 2024-03-31 + 1 天 = 2024-04-01');
      assert.eq(formatIso(addDays(parseDate('2024-10-27'), 1)), '2024-10-28', '欧洲夏令时结束日 2024-10-27 + 1 天 = 2024-10-28');
      assert.eq(diffDays(parseDate('2024-03-10'), parseDate('2024-03-11')), 1, '夏令时切换日当天相差正好 1 天');
      assert.eq(
        utcMillis(parseDate('2024-03-11')) - utcMillis(parseDate('2024-03-10')),
        86400000,
        '夏令时那天的 UTC 毫秒差正好是一整天（本地时区根本没参与）'
      );
      assert.eq(diffDays(parseDate('2024-03-09'), parseDate('2024-03-11')), 2, '跨夏令时的两天照样是 2 天');

      /* ---- 序号往返 ---- */
      assert.eq(formatIso(fromSerial(toSerial(parseDate('2024-02-29')))), '2024-02-29', '序号往返不丢信息');
      assert.eq(toSerial(parseDate('1970-01-01')), 0, '1970-01-01 的序号是 0');
      assert.eq(toSerial(parseDate('1970-01-02')), 1, '1970-01-02 的序号是 1');
      assert.eq(formatIso(fromSerial(-1)), '1969-12-31', '负序号也能还原');
      assert.eq(formatIso(fromSerial(0)), '1970-01-01', '序号 0 是 1970-01-01');
      // 序号 0 = 1970-01-01 = 星期四，所以序号模 7 的 2 是周六、3 是周日
      assert.eq(toSerial(parseDate('1970-01-01')) % 7, 0, '序号 0 是星期四');
      assert.eq(toSerial(parseDate('2024-01-01')) % 7, 4, '2024-01-01 是周一：序号模 7 = 4');
      assert.eq(toSerial(parseDate('2024-03-10')) % 7, 3, '2024-03-10 是周日：序号模 7 = 3');

      /* ---- 相差多少天 ---- */
      assert.eq(diffDays(parseDate('2024-01-01'), parseDate('2024-01-31')), 30, '1 月 1 日 → 1 月 31 日 = 30 天');
      assert.eq(diffDays(parseDate('2024-01-01'), parseDate('2024-01-01')), 0, '同一天 = 0 天');
      assert.eq(diffDays(parseDate('2024-03-01'), parseDate('2024-02-01')), -29, '3 月 1 日 → 2 月 1 日 = −29 天');
      assert.eq(diffDays(parseDate('2024-01-01'), parseDate('2025-01-01')), 366, '2024 是闰年，一整年 366 天');
      assert.eq(diffDays(parseDate('2023-01-01'), parseDate('2024-01-01')), 365, '2023 是平年，一整年 365 天');
      assert.eq(compareDates(parseDate('2024-01-01'), parseDate('2024-01-02')), -1, '比较：a < b');
      assert.eq(compareDates(parseDate('2024-01-02'), parseDate('2024-01-01')), 1, '比较：a > b');
      assert.eq(compareDates(parseDate('2024-01-01'), parseDate('2024-01-01')), 0, '比较：相等');

      /* ---- 整月 / 整年：按日历算，不是 30 天 / 365 天 ---- */
      assert.eq(wholeMonthsBetween(parseDate('2024-01-01'), parseDate('2024-01-31')), 0, '1 月 1 日 → 1 月 31 日是 30 天但 0 个整月');
      assert.eq(wholeMonthsBetween(parseDate('2024-01-01'), parseDate('2024-02-01')), 1, '1 月 1 日 → 2 月 1 日 = 1 个整月');
      assert.eq(wholeMonthsBetween(parseDate('2024-01-31'), parseDate('2024-02-29')), 1, '1 月 31 日 → 2 月 29 日 = 1 个整月（月末对齐）');
      assert.eq(wholeMonthsBetween(parseDate('2024-01-31'), parseDate('2024-02-28')), 0, '1 月 31 日 → 2 月 28 日不足一个月');
      assert.eq(wholeMonthsBetween(parseDate('2024-01-01'), parseDate('2024-12-31')), 11, '1 月 1 日 → 12 月 31 日 = 11 个整月');
      assert.eq(wholeMonthsBetween(parseDate('2024-01-01'), parseDate('2025-01-01')), 12, '整一年 = 12 个整月');
      assert.eq(wholeMonthsBetween(parseDate('2024-03-01'), parseDate('2024-02-01')), -1, '反向也是负数');
      assert.eq(wholeMonthsBetween(parseDate('2024-01-15'), parseDate('2024-01-14')), 0, '同一个月内 = 0 个整月');
      assert.eq(wholeMonthsBetween(parseDate('2024-02-29'), parseDate('2025-02-28')), 12, '2 月 29 日生日到平年的 2 月 28 日算满 12 个月');
      assert.eq(wholeYearsBetween(parseDate('2024-01-01'), parseDate('2024-12-31')), 0, '整年也是按日历：还没满一年');
      assert.eq(wholeYearsBetween(parseDate('2024-01-01'), parseDate('2025-01-01')), 1, '周年当天算满一年');
      assert.eq(wholeYearsBetween(parseDate('2024-02-29'), parseDate('2025-02-28')), 1, '2 月 29 日生日到平年 2 月 28 日算满一年');
      assert.eq(wholeYearsBetween(parseDate('2024-03-01'), parseDate('2024-02-01')), 0, '差一个月不满一年 → 0 年');
      assert.eq(wholeMonthsBetween(parseDate('2024-01-01'), parseDate('2024-01-31')) * 30, 0, '整月不是按 30 天折算出来的');

      /* ---- 工作日：区间取 (起始日, 结束日] ---- */
      assert.eq(businessDaysBetween(parseDate('2024-01-01'), parseDate('2024-01-08')), 5, '周一 → 周一：中间 5 个工作日');
      assert.eq(businessDaysBetween(parseDate('2024-01-01'), parseDate('2024-01-01')), 0, '同一天没有工作日');
      assert.eq(businessDaysBetween(parseDate('2024-01-01'), parseDate('2024-01-06')), 4, '周一 → 周六：周二到周五 4 个工作日');
      assert.eq(businessDaysBetween(parseDate('2024-01-05'), parseDate('2024-01-08')), 1, '周五 → 周一：只有下周一');
      assert.eq(businessDaysBetween(parseDate('2024-01-06'), parseDate('2024-01-08')), 1, '周六 → 周一：只有周一');
      assert.eq(businessDaysBetween(parseDate('2024-01-01'), parseDate('2024-01-31')), 22, '一整个月的工作日');
      assert.eq(businessDaysBetween(parseDate('2024-01-08'), parseDate('2024-01-01')), -5, '反向是负数');
      assert.eq(businessDaysBetween(parseDate('2024-01-02'), parseDate('2024-01-02')), 0, '周二 → 周二没有工作日');
      // 与朴素的逐日计数对拍：公式版不能比逐日版差一天
      (function () {
        var bad = null;
        var bases = ['2024-01-01', '2024-01-05', '2024-01-06', '2024-01-07', '2024-02-28', '2024-02-29', '2024-03-10', '2024-10-06', '2024-12-30'];
        for (var i = 0; i < bases.length && !bad; i++) {
          var a = parseDate(bases[i]);
          for (var k = 0; k <= 400 && !bad; k++) {
            var b = addDays(a, k);
            var naive = 0;
            for (var d = 1; d <= k; d++) {
              var w = weekdayOf(addDays(a, d));
              if (w !== 0 && w !== 6) naive++;
            }
            if (naive !== businessDaysBetween(a, b)) {
              bad = bases[i] + ' + ' + k + ' 天：公式 ' + businessDaysBetween(a, b) + ' ≠ 逐日 ' + naive;
            }
          }
        }
        assert.eq(bad, null, '工作日的公式版与逐日计数完全一致');
      })();

      /* ---- 年龄 ---- */
      var age0 = ageBetween(parseDate('2024-01-01'), parseDate('2024-01-01'));
      assert.eq([age0.years, age0.months, age0.days], [0, 0, 0], '生日当天 = 0 岁 0 月 0 天');
      assert.eq(age0.totalDays, 0, '生日当天的总天数是 0');
      var age1 = ageBetween(parseDate('2024-01-01'), parseDate('2024-12-31'));
      assert.eq([age1.years, age1.months, age1.days], [0, 11, 30], '生日前一天 = 0 岁 11 月 30 天');
      assert.eq(age1.totalDays, 365, '2024-01-01 → 2024-12-31 共 365 天');
      var age2 = ageBetween(parseDate('2000-01-15'), parseDate('2024-06-15'));
      assert.eq([age2.years, age2.months, age2.days], [24, 5, 0], '生日当天：24 岁 5 月 0 天');
      var age3 = ageBetween(parseDate('2000-01-15'), parseDate('2024-06-14'));
      assert.eq([age3.years, age3.months, age3.days], [24, 4, 30], '生日前一天：24 岁 4 月 30 天');
      assert.eq(ageBetween(parseDate('2000-02-29'), parseDate('2024-02-28')).years, 23, '2 月 29 日生日在平年还没满 24 岁');
      assert.eq(ageBetween(parseDate('2000-02-29'), parseDate('2024-02-29')).years, 24, '2 月 29 日生日在闰年满 24 岁');
      assert.eq(ageBetween(parseDate('2024-06-01'), parseDate('2024-05-01')).totalDays, -31, '参照日早于出生日：总天数为负');

      /* ---- 星期几 ---- */
      assert.eq(weekdayOf(parseDate('2024-01-01')), 1, '2024-01-01 是周一');
      assert.eq(weekdayOf(parseDate('2024-01-06')), 6, '2024-01-06 是周六');
      assert.eq(weekdayOf(parseDate('2024-01-07')), 0, '2024-01-07 是周日');
      assert.eq(weekdayOf(parseDate('2023-01-01')), 0, '2023-01-01 是周日');
      assert.eq(weekdayOf(parseDate('2024-03-10')), 0, '2024-03-10 是周日');
      assert(typeof weekdayName(1) === 'string' && weekdayName(1).length > 0, '星期一有名字');

      /* ---- 每个月的天数分布 ---- */
      var bd = monthsBreakdown(parseDate('2024-01-15'), parseDate('2024-03-10'));
      assert.eq(bd.length, 3, '跨了 3 个月');
      assert.eq(bd[0].days, 17, '1 月占 17 天（15 号到 31 号）');
      assert.eq(bd[1].days, 29, '2 月占 29 天（闰年）');
      assert.eq(bd[2].days, 10, '3 月占 10 天（1 号到 10 号）');
      assert.eq(monthsBreakdown(parseDate('2024-02-01'), parseDate('2024-02-29'))[0].days, 29, '同一个月：2 月整月 29 天');

      /* ---- 输入框与格式化 ---- */
      assert.eq(parseDayOffset('30'), 30, '正常的天数');
      assert.eq(parseDayOffset('-30'), -30, '负的天数');
      assert.eq(parseDayOffset('+7'), 7, '带加号的天数');
      assert.eq(parseDayOffset(''), null, '空的天数非法');
      assert.eq(parseDayOffset('1.5'), null, '小数天数非法');
      assert.eq(parseDayOffset('abc'), null, '不是数字的天数非法');
      assert.eq(signedNumber(5), '+5', '正数带加号');
      assert.eq(signedNumber(-5), '-5', '负数带负号');
      assert.eq(signedNumber(0), '0', '零不带符号');
      assert.eq(formatIso({ y: 2024, m: 1, d: 5 }), '2024-01-05', '格式化补零');
      assert.eq(formatIso({ y: 999, m: 12, d: 31 }), '0999-12-31', '年份不足四位要补零');
    }
  };
})();
