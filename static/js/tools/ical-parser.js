/* ==========================================================================
   iCal 解析器（ical-parser）

   把一份 .ics 文本拆成结构化的事件列表。

   参考实现：上游 PR #1331 的 src/tools/ical-parser/ical-parser.vue
   （it-tools, GPLv3）。上游做的是「把 ical.js 解析出来的组件原样 JSON.stringify
   出来」—— 那是一堆嵌套数组，没有时间、没有转义还原、也没有概览，
   拿到手还得自己看。这里换成一张能读的表。

   ---- 三个必须自己处理的地方 ----
   1. **折行必须先展开**。RFC 5545 §3.1 规定内容行超过 75 字节就要折，
      续行以「一个空格或制表符」开头。折行是传输层的产物，
      不展开的话长描述会被切成好几行，后面的行看起来就像属性。
      展开时那个行首空白字符要去掉（它是折行标记，不是内容）。
   2. **TEXT 值要反转义**。`\n` 是换行、`\,` 是逗号、`\;` 是分号、`\\` 是反斜杠。
      不还原的话描述里全是字面的「\n」。
   3. **时间有两种形态**：
        · `20261024T120000Z` —— UTC，转成本地时间显示；
        · `20261024T120000`  —— 浮动时间或带 TZID 的本地时间。
      后者**不做时区换算**，按墙上的时间原样显示，只把 TZID 标出来。
      原因：把「某个时区的墙上时间」换算成 UTC 需要那个时区的规则，
      浏览器里没有权威的 tzdata（Intl 只能给偏移，给不了历史规则），
      换算错了比不换算更糟 —— 显示的钟点会骗人。

   ---- 安全 ----
   解析出来的每个字段都是用户自己贴进来的内容，一律用 textContent 写进页面，
   不用 innerHTML 拼 —— 描述里塞一段 <img onerror=…> 就是一个 XSS。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('ical-parser');

  /* ==================================================================
     纯逻辑
     ================================================================== */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function pad4(n) {
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  /**
   * 展开折行：把「以空格或制表符开头」的物理行接回上一行。
   *
   * 先把 CRLF / CR 都归一成 LF 再切分 —— 不然 CR 会留在行尾，
   * 值里就多出一个看不见的字符。
   *
   * @param {string} text
   * @returns {Array<{text: string, line: number}>} 逻辑行 + 它在原文里的起始行号
   */
  function unfoldLines(text) {
    var normalized = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var physical = normalized.split('\n');
    var out = [];

    for (var i = 0; i < physical.length; i++) {
      var line = physical[i];
      var first = line.charAt(0);
      if (out.length && (first === ' ' || first === '\t')) {
        // 续行：行首那个空白字符是折行标记，去掉，其余接回上一行
        out[out.length - 1].text += line.slice(1);
        continue;
      }
      out.push({ text: line, line: i + 1 });
    }
    return out;
  }

  /**
   * 拆一条内容行：NAME[;参数=值…]:值
   *
   * 找冒号时要跳过引号里的内容 —— 参数值可以是带引号的
   * （`;TZID="Europe/Paris"`），引号里也可能出现冒号。
   *
   * @param {string} line
   * @returns {{name: string, params: object, value: string}|null} 不是内容行给 null
   */
  function parseContentLine(line) {
    var s = String(line == null ? '' : line);
    var colon = -1;
    var inQuote = false;

    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '"') inQuote = !inQuote;
      else if (c === ':' && !inQuote) { colon = i; break; }
    }
    if (colon < 0) return null;

    var head = s.slice(0, colon);
    var value = s.slice(colon + 1);

    // 参数之间用 ';' 分，但引号里的 ';' 不算分隔符
    var parts = [];
    var buf = '';
    var quoted = false;
    for (var j = 0; j < head.length; j++) {
      var ch = head.charAt(j);
      if (ch === '"') { quoted = !quoted; buf += ch; continue; }
      if (ch === ';' && !quoted) { parts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    parts.push(buf);

    var name = parts[0].trim().toUpperCase();
    var params = {};
    for (var k = 1; k < parts.length; k++) {
      var p = parts[k];
      var eq = p.indexOf('=');
      if (eq < 0) continue;
      var key = p.slice(0, eq).trim().toUpperCase();
      var val = p.slice(eq + 1).trim();
      if (val.length >= 2 && val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') {
        val = val.slice(1, -1);
      }
      params[key] = val;
    }

    return { name: name, params: params, value: value };
  }

  /**
   * TEXT 值反转义（RFC 5545 §3.3.11）。
   *
   * 单遍扫描：不能先 replace('\\n') 再 replace('\\\\') ——
   * 那样 `\\n`（一个反斜杠 + 一个 n）会被先换成换行，再把剩下的反斜杠换掉，
   * 结果完全错。所以按顺序一次走完。
   *
   * @param {*} value
   * @returns {string}
   */
  function unescapeText(value) {
    var s = String(value == null ? '' : value);
    var out = '';

    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c !== '\\') { out += c; continue; }

      var next = s.charAt(i + 1);
      if (next === '') { out += '\\'; break; }   // 末尾的孤立反斜杠：原样留着
      i++;
      switch (next) {
        case 'n': case 'N': out += '\n'; break;
        case ',': out += ','; break;
        case ';': out += ';'; break;
        case '\\': out += '\\'; break;
        default: out += next; break;   // 未定义的转义：去掉反斜杠，字符留下
      }
    }
    return out;
  }

  /**
   * 解析一条日期时间属性。
   *
   * @param {string} value 20261024T120000Z / 20261024T120000 / 20261024
   * @param {object} [params] 该属性的参数（TZID 等）
   * @returns {object|null}
   */
  function parseIcalDate(value, params) {
    var raw = String(value == null ? '' : value).trim();
    var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
    if (!m) return null;

    var y = +m[1], mo = +m[2], d = +m[3];
    var hasTime = m[4] !== undefined;
    var hh = hasTime ? +m[4] : 0;
    var mi = hasTime ? +m[5] : 0;
    var ss = hasTime && m[6] !== undefined ? +m[6] : 0;

    return {
      raw: raw,
      ms: Date.UTC(y, mo - 1, d, hh, mi, ss),
      isUtc: !!m[7],
      isDate: !hasTime,
      tzid: (params && params.TZID) ? params.TZID : '',
      y: y, mo: mo, d: d, hh: hh, mi: mi, ss: ss
    };
  }

  /**
   * 本地时间（浏览器所在时区）的可读字符串。
   * @param {number} ms
   * @returns {string}
   */
  function formatLocalClock(ms) {
    var d = new Date(ms);
    return pad4(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /**
   * 本地时区在那一刻的偏移（UTC+08:00 这种）。
   * @param {number} ms
   * @returns {string}
   */
  function formatUtcOffset(ms) {
    var off = -new Date(ms).getTimezoneOffset();
    var abs = Math.abs(off);
    return 'UTC' + (off >= 0 ? '+' : '-') + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
  }

  /**
   * 把日期时间属性变成一句人话。
   *
   * UTC 的转成本地时间显示；浮动时间 / 带 TZID 的按墙上的时间原样显示，
   * 并把 TZID 标出来（不做时区换算 —— 见文件头的说明）。
   *
   * @param {object} dt
   * @returns {string}
   */
  function describeDateTime(dt) {
    if (!dt) return '';
    if (dt.isUtc) return formatLocalClock(dt.ms) + ' (' + formatUtcOffset(dt.ms) + ')';

    var wall = pad4(dt.y) + '-' + pad2(dt.mo) + '-' + pad2(dt.d);
    if (!dt.isDate) wall += ' ' + pad2(dt.hh) + ':' + pad2(dt.mi) + ':' + pad2(dt.ss);
    if (dt.tzid) return wall + ' (TZID=' + dt.tzid + ')';
    return wall + ' (' + t('floating_time', 'floating') + ')';
  }

  /**
   * 收集一个 VEVENT 的属性。
   * @param {object} props
   * @returns {object}
   */
  function buildEvent(props) {
    return {
      uid: props.UID ? unescapeText(props.UID.value) : '',
      summary: props.SUMMARY ? unescapeText(props.SUMMARY.value) : '',
      description: props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : '',
      location: props.LOCATION ? unescapeText(props.LOCATION.value) : '',
      status: props.STATUS ? unescapeText(props.STATUS.value) : '',
      dtstamp: props.DTSTAMP ? parseIcalDate(props.DTSTAMP.value, props.DTSTAMP.params) : null,
      start: props.DTSTART ? parseIcalDate(props.DTSTART.value, props.DTSTART.params) : null,
      end: props.DTEND ? parseIcalDate(props.DTEND.value, props.DTEND.params) : null
    };
  }

  /**
   * 解析一份 .ics。
   *
   * @param {string} text
   * @returns {{error: (null|{code: string, ...}), events: Array, vtimezones: number, calendar: object}}
   */
  function parseIcs(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return { error: { code: 'empty' }, events: [], vtimezones: 0, calendar: {} };

    var lines = unfoldLines(src);
    var stack = [];
    var events = [];
    var vtimezones = 0;
    var calendar = {};
    var current = null;
    var sawCalendar = false;

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      // 行尾空白不是内容的一部分（不少 .ics 生成器会多打一个空格）
      var s = ln.text.replace(/[ \t]+$/, '');
      if (!s) continue;

      var upper = s.toUpperCase();

      if (upper.indexOf('BEGIN:') === 0) {
        var comp = s.slice(6).trim().toUpperCase();
        stack.push({ name: comp, line: ln.line });
        if (comp === 'VCALENDAR') sawCalendar = true;
        else if (comp === 'VEVENT') current = {};
        else if (comp === 'VTIMEZONE') vtimezones++;
        continue;
      }

      if (upper.indexOf('END:') === 0) {
        var name = s.slice(4).trim().toUpperCase();
        var top = stack.pop();
        if (!top) {
          return { error: { code: 'end_without_begin', line: ln.line, name: name }, events: [], vtimezones: 0, calendar: {} };
        }
        if (top.name !== name) {
          return {
            error: { code: 'mismatch', line: ln.line, name: name, begin: top.name, beginLine: top.line },
            events: [], vtimezones: 0, calendar: {}
          };
        }
        if (name === 'VEVENT' && current) {
          events.push(buildEvent(current));
          current = null;
        }
        continue;
      }

      var cl = parseContentLine(s);
      if (!cl) {
        return { error: { code: 'bad_line', line: ln.line, text: s }, events: [], vtimezones: 0, calendar: {} };
      }

      var ctx = stack.length ? stack[stack.length - 1].name : '';
      if (ctx === 'VCALENDAR') calendar[cl.name] = cl;
      else if (ctx === 'VEVENT' && current) current[cl.name] = cl;
      // VTIMEZONE / VALARM 里的内容先忽略：这里只数个数，不展开时区规则
    }

    if (stack.length) {
      var open = stack[stack.length - 1];
      return { error: { code: 'unclosed', line: open.line, name: open.name }, events: [], vtimezones: 0, calendar: {} };
    }
    if (!sawCalendar) {
      return { error: { code: 'no_calendar' }, events: [], vtimezones: 0, calendar: {} };
    }

    return { error: null, events: events, vtimezones: vtimezones, calendar: calendar };
  }

  /**
   * VCALENDAR 级别的属性（给概览用）。
   * @param {object} calendar
   * @returns {{prodid: string, version: string, calscale: string, calname: string, method: string}}
   */
  function calendarSummary(calendar) {
    calendar = calendar || {};
    return {
      prodid: calendar.PRODID ? unescapeText(calendar.PRODID.value) : '',
      version: calendar.VERSION ? calendar.VERSION.value : '',
      calscale: calendar.CALSCALE ? calendar.CALSCALE.value : '',
      calname: calendar['X-WR-CALNAME'] ? unescapeText(calendar['X-WR-CALNAME'].value) : '',
      method: calendar.METHOD ? calendar.METHOD.value : ''
    };
  }

  /* ==================================================================
     界面
     ================================================================== */

  /**
   * 错误码 → 文案。键必须是字符串字面量（Rust 侧扫源码里的 t('key', …)）。
   * @param {object} err
   * @returns {string}
   */
  function errorMessage(err) {
    if (!err) return '';
    switch (err.code) {
      case 'empty':
        return t('err_empty', 'Nothing to parse — paste the content of an .ics file.');
      case 'no_calendar':
        return t('err_no_calendar', 'No BEGIN:VCALENDAR found: this does not look like an iCalendar file.');
      case 'bad_line':
        return t('err_bad_line', 'Line {line}: this is not a valid content line (no colon).')
          .replace('{line}', function () { return String(err.line); });
      case 'mismatch':
        return t('err_mismatch', 'Line {line}: END:{name} does not match BEGIN:{begin} on line {beginLine}.')
          .replace('{line}', function () { return String(err.line); })
          .replace('{name}', function () { return err.name; })
          .replace('{begin}', function () { return err.begin; })
          .replace('{beginLine}', function () { return String(err.beginLine); });
      case 'unclosed':
        return t('err_unclosed', 'Line {line}: BEGIN:{name} is never closed.')
          .replace('{line}', function () { return String(err.line); })
          .replace('{name}', function () { return err.name; });
      case 'end_without_begin':
        return t('err_end_without_begin', 'Line {line}: END:{name} without a matching BEGIN.')
          .replace('{line}', function () { return String(err.line); })
          .replace('{name}', function () { return err.name; });
      default:
        return t('err_unknown', 'The iCal content could not be parsed.');
    }
  }

  /** 界面上先摆一份样例：一来是让人看到能解析成什么样，二来是各条文案都能被走到。 */
  var SAMPLE = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//it-tools//iCal Parser//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Example calendar',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Paris',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:sample-1@it-tools',
    'DTSTAMP:20261020T090000Z',
    'DTSTART:20261024T120000Z',
    'DTEND:20261024T130000Z',
    'SUMMARY:Sprint review',
    'DESCRIPTION:Walk through the backlog\\, then demo.',
    'LOCATION:Room 3',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:sample-2@it-tools',
    'DTSTAMP:20261020T090000Z',
    'DTSTART;TZID=Europe/Paris:20261024T150000',
    'DTEND;TZID=Europe/Paris:20261024T160000',
    'SUMMARY:1:1 with the team',
    'DESCRIPTION:First line\\nSecond line',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  window.ItTools.register('ical-parser', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 12,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste the content of an .ics file here...')
    });
    input.value = SAMPLE;

    var status = D.h('p.form-status');
    var overviewBody = D.h('div.output-body');
    var eventsBody = D.h('div.output-body');

    /**
     * 一行「标签 + 值」。
     */
    function kvRow(label, value) {
      return D.h('tr', null,
        D.h('th', { text: label }),
        D.h('td.val', { text: value || '—' })
      );
    }

    function renderOverview(res) {
      D.clear(overviewBody);
      var cal = calendarSummary(res.calendar);
      overviewBody.appendChild(D.h('table.kv-table', null,
        D.h('tbody', null,
          kvRow(t('col_prodid', 'PRODID'), cal.prodid),
          kvRow(t('col_version', 'VERSION'), cal.version),
          kvRow(t('col_calscale', 'CALSCALE'), cal.calscale),
          kvRow(t('col_calname', 'X-WR-CALNAME'), cal.calname),
          kvRow(t('col_method', 'METHOD'), cal.method),
          kvRow(
            t('count_events', '{count} event(s)').replace('{count}', function () { return String(res.events.length); }),
            String(res.events.length)
          ),
          kvRow(
            t('count_vtimezone', '{count} time zone(s)').replace('{count}', function () { return String(res.vtimezones); }),
            String(res.vtimezones)
          )
        )
      ));
    }

    function renderEvents(res) {
      D.clear(eventsBody);
      if (!res.events.length) {
        eventsBody.appendChild(D.h('p.field-hint', { text: t('no_events', 'No VEVENT found in this calendar.') }));
        return;
      }

      var rows = res.events.map(function (ev) {
        var timeCell = D.h('td', null,
          D.h('div', { text: ev.start ? describeDateTime(ev.start) : '—' }),
          ev.end ? D.h('div', { text: '→ ' + describeDateTime(ev.end) }) : null
        );

        // UID / STATUS / DTSTAMP 放在摘要下面的小字里 —— 表头只有四列，
        // 但这几个字段是解析出来的，不能悄悄丢掉。
        var bits = [];
        if (ev.uid) {
          bits.push(t('meta_uid', 'UID: {uid}').replace('{uid}', function () { return ev.uid; }));
        }
        if (ev.status) {
          bits.push(t('meta_status', 'STATUS: {status}').replace('{status}', function () { return ev.status; }));
        }
        if (ev.dtstamp) {
          bits.push(t('meta_dtstamp', 'DTSTAMP: {dtstamp}').replace('{dtstamp}', function () {
            return describeDateTime(ev.dtstamp);
          }));
        }

        var summaryCell = D.h('td', null,
          D.h('div', { text: ev.summary || '—' }),
          bits.length ? D.h('div.muted', { text: bits.join(' · ') }) : null
        );

        // 描述里的换行要看得见，所以用保留换行的块（不是 textContent 的默认行为）。
        // 注意别用 .output-raw：那个类是给 base64/PEM 那种「没有词边界的长串」用的
        // （word-break: break-all），描述是人话，照着断就太难看了 ——
        // 窄屏上 93px 的格子里会碎成「Walk throug」「h the backl」「og, then de」「mo.」。
        // 这里只要「保留换行 + 按词换行」，断词交给 .result-table 的
        // word-break: normal; overflow-wrap: break-word 就行。
        var descCell = D.h('td', null,
          ev.description ? D.h('div', { style: { whiteSpace: 'pre-wrap' }, text: ev.description }) : D.h('span', { text: '—' })
        );

        return D.h('tr', null,
          timeCell,
          summaryCell,
          D.h('td', { text: ev.location || '—' }),
          descCell
        );
      });

      eventsBody.appendChild(D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_time', 'Time') }),
          D.h('th', { text: t('col_summary', 'Summary') }),
          D.h('th', { text: t('col_location', 'Location') }),
          D.h('th', { text: t('col_description', 'Description') })
        )),
        D.h('tbody', null, rows)
      ));
    }

    function render() {
      var res = parseIcs(input.value);
      if (res.error) {
        status.className = 'form-status is-error';
        status.textContent = errorMessage(res.error);
        D.clear(overviewBody);
        overviewBody.appendChild(D.h('p.field-hint', { text: '—' }));
        D.clear(eventsBody);
        eventsBody.appendChild(D.h('p.field-hint', { text: '—' }));
        return;
      }
      status.className = 'form-status';
      status.textContent = '';
      renderOverview(res);
      renderEvents(res);
    }

    var off = D.on(input, 'input', render);

    // 三块面板：输入、概览、事件表。子块必须待在卡片里 ——
    // .tool-content 的 flex 把每个直属子元素都当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      U.field(t('input_label', 'iCal content'), input),
      status,
      D.h('p.field-hint', {
        text: t('hint', 'Folded lines are unfolded first (a line starting with a space or a tab continues the previous one), then every VEVENT is parsed. Times ending with Z are shown in your browser local time; floating times and times carrying a TZID are shown as they are written, with the TZID next to them.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('overview_title', 'Overview') })),
      overviewBody
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('events_title', 'Events') })),
      eventsBody
    ));

    render();

    return {
      destroy: function () {
        off();
        D.clear(root);
      }
    };
  });

  /* ==================================================================
     单测用的纯逻辑
     ================================================================== */

  window.ItTools.logic['ical-parser'] = {
    unfoldLines: unfoldLines,
    parseContentLine: parseContentLine,
    unescapeText: unescapeText,
    parseIcalDate: parseIcalDate,
    describeDateTime: describeDateTime,
    parseIcs: parseIcs,
    calendarSummary: calendarSummary,
    __cases: function (assert) {
      /* ---- 折行展开 ---- */
      var unfolded = unfoldLines('SUMMARY:hello\n world');
      assert.eq(unfolded.length, 1, '续行被接回上一行');
      // RFC 5545 §3.1：展开 = 去掉 CRLF 与它后面那个空白字符 ——
      // 所以折行处不会多出一个空格
      assert.eq(unfolded[0].text, 'SUMMARY:helloworld', '折行处不多一个空格');
      assert.eq(unfolded[0].line, 1, '逻辑行的起始行号');
      assert.eq(unfoldLines('A\nB').length, 2, '没有续行时各行独立');
      assert.eq(unfoldLines('A\n\tB')[0].text, 'AB', '制表符开头的续行也一样接上');
      assert.eq(unfoldLines('A\r\n B')[0].text, 'AB', 'CRLF 也认');
      assert.eq(unfoldLines('A\r B')[0].text, 'AB', '单独的 CR 也认');
      assert.eq(unfoldLines('').length, 1, '空文本只有一行');
      assert.eq(unfoldLines('A\n B\nC')[1].text, 'C', '续行之后的行号是 3');
      // 折行前本来就有的空格要留着（那是内容，不是折行标记）
      assert.eq(unfoldLines('DESCRIPTION:Hello \n world')[0].text, 'DESCRIPTION:Hello world',
        '折行前原有的空格留着，折行带来的那个不留');

      /* ---- 内容行 ---- */
      var cl = parseContentLine('DTSTART;TZID=Europe/Paris:20261024T150000');
      assert.eq(cl.name, 'DTSTART', '属性名');
      assert.eq(cl.params.TZID, 'Europe/Paris', 'TZID 参数');
      assert.eq(cl.value, '20261024T150000', '属性值');
      assert.eq(parseContentLine('SUMMARY:hi').name, 'SUMMARY', '没有参数也行');
      assert.eq(parseContentLine('SUMMARY:hi').params, {}, '没有参数就是空对象');
      assert.eq(parseContentLine('X;VALUE=DATE;TZID="Europe/Paris":20261024').params.VALUE, 'DATE', '多个参数');
      assert.eq(parseContentLine('X;TZID="Europe/Paris":20261024').params.TZID, 'Europe/Paris', '带引号的参数值要去引号');
      assert.eq(parseContentLine('DESCRIPTION:a:b').value, 'a:b', '值里的冒号不算分隔符');
      assert.eq(parseContentLine('no colon here'), null, '没有冒号就不是内容行');

      /* ---- 反转义 ---- */
      assert.eq(unescapeText('a\\nb'), 'a\nb', '\\n 变成换行');
      assert.eq(unescapeText('a\\,b'), 'a,b', '\\, 变成逗号');
      assert.eq(unescapeText('a\\;b'), 'a;b', '\\; 成分号');
      assert.eq(unescapeText('a\\\\b'), 'a\\b', '\\\\ 变成反斜杠');
      assert.eq(unescapeText('plain'), 'plain', '没有转义就不动');
      assert.eq(unescapeText('a\\\\nb'), 'a\\nb', '\\\\n 是一个反斜杠加一个 n，不能被当成换行');
      assert.eq(unescapeText('a\\'), 'a\\', '末尾的孤立反斜杠原样保留');
      assert.eq(unescapeText(''), '', '空串');

      /* ---- 时间 ---- */
      var utc = parseIcalDate('20261024T120000Z', {});
      assert.eq(utc.isUtc, true, '带 Z 的是 UTC');
      assert.eq(utc.ms, Date.UTC(2026, 9, 24, 12, 0, 0), 'UTC 的时间戳');
      var local = parseIcalDate('20261024T150000', { TZID: 'Europe/Paris' });
      assert.eq(local.isUtc, false, '不带 Z 的是本地 / 浮动时间');
      assert.eq(local.tzid, 'Europe/Paris', 'TZID 读到了');
      assert.eq(parseIcalDate('20261024', {}).isDate, true, '纯日期');
      assert.eq(parseIcalDate('not a date', {}), null, '不是日期就给 null');
      assert.eq(parseIcalDate('20261024T120000', {}).tzid, '', '没有 TZID 就是空串');
      // UTC 的显示要转成本地时间
      assert.eq(describeDateTime(utc), formatLocalClock(utc.ms) + ' (' + formatUtcOffset(utc.ms) + ')',
        'UTC 显示成本地时间并带上偏移');
      assert(describeDateTime(local).indexOf('2026-10-24 15:00:00') === 0, '带 TZID 的按墙上时间显示');
      assert(describeDateTime(local).indexOf('TZID=Europe/Paris') > 0, 'TZID 显示出来了');

      /* ---- 整体解析 ---- */
      var ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//example//EN',
        'CALSCALE:GREGORIAN',
        'X-WR-CALNAME:My calendar',
        'BEGIN:VEVENT',
        'UID:one@test',
        'DTSTAMP:20261020T090000Z',
        'DTSTART:20261024T120000Z',
        'DTEND:20261024T130000Z',
        'SUMMARY:First',
        'DESCRIPTION:line1\\nline2',
        'LOCATION:Room 1',
        'STATUS:CONFIRMED',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:two@test',
        'DTSTART;TZID=Europe/Paris:20261024T150000',
        'DTEND;TZID=Europe/Paris:20261024T160000',
        'SUMMARY:Second',
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n');

      var res = parseIcs(ics);
      assert.eq(res.error, null, '合法 .ics 不报错');
      assert.eq(res.events.length, 2, '两个 VEVENT');
      assert.eq(res.events[0].uid, 'one@test', 'UID');
      assert.eq(res.events[0].summary, 'First', 'SUMMARY');
      assert.eq(res.events[0].description, 'line1\nline2', 'DESCRIPTION 里的 \\n 还原成换行');
      assert.eq(res.events[0].location, 'Room 1', 'LOCATION');
      assert.eq(res.events[0].status, 'CONFIRMED', 'STATUS');
      assert.eq(res.events[0].dtstamp.ms, Date.UTC(2026, 9, 20, 9, 0, 0), 'DTSTAMP');
      assert.eq(res.events[0].start.isUtc, true, '第一个事件是 UTC 时间');
      assert.eq(res.events[0].end.ms, Date.UTC(2026, 9, 24, 13, 0, 0), 'DTEND');
      assert.eq(res.events[1].summary, 'Second', '第二个事件的摘要');
      assert.eq(res.events[1].start.tzid, 'Europe/Paris', '第二个事件带 TZID');
      assert.eq(res.events[1].start.isUtc, false, '第二个事件不是 UTC');
      assert.eq(res.events[1].end.ms, Date.UTC(2026, 9, 24, 16, 0, 0), '第二个事件的 DTEND');

      var summary = calendarSummary(res.calendar);
      assert.eq(summary.prodid, '-//example//EN', 'PRODID');
      assert.eq(summary.version, '2.0', 'VERSION');
      assert.eq(summary.calscale, 'GREGORIAN', 'CALSCALE');
      assert.eq(summary.calname, 'My calendar', 'X-WR-CALNAME');

      // VTIMEZONE 要数出来
      var withTz = parseIcs([
        'BEGIN:VCALENDAR',
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Paris',
        'END:VTIMEZONE',
        'BEGIN:VTIMEZONE',
        'TZID:Asia/Shanghai',
        'END:VTIMEZONE',
        'END:VCALENDAR'
      ].join('\r\n'));
      assert.eq(withTz.vtimezones, 2, '两个 VTIMEZONE');

      // 折行要先展开，否则长描述会被切成几行
      var foldedIcs = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:folded@test',
        'SUMMARY:A very long summary that',
        '  continues on the next line',
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n');
      var foldedRes = parseIcs(foldedIcs);
      assert.eq(foldedRes.error, null, '折行的 .ics 能解析');
      assert.eq(foldedRes.events[0].summary, 'A very long summary that continues on the next line',
        '折行展开后摘要是一整句');

      /* ---- 出错要有明确原因 ---- */
      assert.eq(parseIcs('').error.code, 'empty', '空文本报错');
      assert.eq(parseIcs('   \n  ').error.code, 'empty', '只有空白也算空');
      assert.eq(parseIcs('hello world').error.code, 'bad_line', '垃圾输入报错而不是抛异常');
      assert.eq(parseIcs('SUMMARY:x').error.code, 'no_calendar', '没有 VCALENDAR 报错');
      var badLine = parseIcs(['BEGIN:VCALENDAR', 'this is not a content line', 'END:VCALENDAR'].join('\r\n'));
      assert.eq(badLine.error.code, 'bad_line', '不是内容行要报错');
      assert.eq(badLine.error.line, 2, '报错要带行号');
      var mismatch = parseIcs(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'END:VCALENDAR'].join('\r\n'));
      assert.eq(mismatch.error.code, 'mismatch', 'BEGIN / END 不匹配要报错');
      assert.eq(mismatch.error.line, 3, '不匹配的行号');
      assert.eq(mismatch.error.begin, 'VEVENT', '不匹配时说出是哪个 BEGIN');
      var unclosed = parseIcs(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x'].join('\r\n'));
      assert.eq(unclosed.error.code, 'unclosed', '没闭合的组件要报错');
      assert.eq(unclosed.error.line, 2, '没闭合时指出 BEGIN 的行号');
      var lonelyEnd = parseIcs('END:VCALENDAR');
      assert.eq(lonelyEnd.error.code, 'end_without_begin', '孤零零的 END 要报错');
      // 报错而不是抛异常
      var threw = false;
      try { parseIcs('}{)(*&^%$#@!~'); } catch (e) { threw = true; }
      assert(!threw, '再乱的输入也只是返回错误，不抛异常');
    }
  };
})();
