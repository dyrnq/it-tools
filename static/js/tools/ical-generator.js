/* ==========================================================================
   iCal 生成器（ical-generator）

   把一个事件表单变成合法的 RFC 5545 .ics 文本（UTF-8 + CRLF）。

   参考实现：上游 PR #1331 的 src/tools/ical-generator/ical-generator.vue
   （it-tools, GPLv3）。上游的三个问题这里都改了：

   1. **时长恒为零**。上游写的是
        `end: new Date(event.startend[0]).toUTCString()`
      —— 结束时间取的是**开始**那个下标（[0] 而不是 [1]），
      于是每个事件的 DTEND 都等于 DTSTART，在日历软件里是一个零长度的事件。
      这里强制「结束必须晚于开始」，否则直接报错，不给一个坏文件出去。
   2. **日历名是死代码**。上游界面上的 calendarName / Description 填了不生效
      （见上游 ical-merger.vue：两个 ref 收集了却从没传给 mergeIcals）。
      这里日历名真的写进 VCALENDAR 级的 X-WR-CALNAME。
   3. **折行按字符算**。RFC 5545 §3.1 规定内容行不超过 75 个**八位字节**，
      上游用的 ical-generator 库按字符折 —— 一个汉字 3 字节，
      折出来的行照样超限，Outlook / Apple 日历会直接拒绝整个文件。
      这里按 UTF-8 字节数折，且续行开头那个空格也计入 75 字节。

   ---- 刻意的取舍：只输出 UTC，不生成 VTIMEZONE ----
   表单用 <input type="datetime-local"> 收「墙上时间」，**默认按 UTC 解释**
   （界面上明写了这一点），输出形如 DTSTART:20261024T120000Z。
   之所以不做 TZID + VTIMEZONE：VTIMEZONE 里要塞历史时区规则与夏令时切换，
   是 RFC 5545 里最容易出错、也最容易被各家日历客户端挑刺的部分，
   而浏览器端没有权威的 tzdata 可用（Intl 能算偏移，但算不出规则本身）。
   统一用 UTC（UTC 的偏移量在任何时区都恒为 0，规则永远是「不变」）
   就没有这类坑，客户端按 UTC 解释也不会错。
   代价是「几点几分」要用户自己换算，所以界面里把浏览器所在时区与偏移量
   写出来，并且提供一个开关：按浏览器本地时间填 → 输出仍是 UTC。

   UID 用 crypto.getRandomValues 生成（不走 Math.random）：
   Math.random 不是密码学安全的，而且在不同标签页里容易撞号；
   RFC 5545 要求 UID 全局唯一，撞号会让日历软件把两个事件认成同一个。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('ical-generator');

  /* ==================================================================
     常量
     ================================================================== */

  /** PRODID 要能说明是谁生成的（RFC 5545 §3.7.2 要求它全局唯一）。 */
  var PRODID = '-//it-tools//iCal Generator//ZH';

  /** RFC 5545 §3.1：内容行不得超过 75 个八位字节（不含行尾）。 */
  var MAX_LINE_BYTES = 75;

  /** 没给结束时间时的默认时长：1 小时（免得生成零长度事件）。 */
  var DEFAULT_DURATION_MS = 60 * 60 * 1000;

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
   * 一个码点的 UTF-8 字节数。
   *
   * 折行必须按字节算而不是按字符算，所以这里不能用 str.length ——
   * 一个汉字 str.length 是 1，UTF-8 却是 3 个字节。
   *
   * @param {string} ch 一个码点（代理对要整个传进来）
   * @returns {number}
   */
  function utf8Len(ch) {
    var code = ch.codePointAt(0);
    if (code < 0x80) return 1;
    if (code < 0x800) return 2;
    if (code < 0x10000) return 3;
    return 4;
  }

  /**
   * RFC 5545 §3.3.11 的 TEXT 转义。
   *
   * 顺序不能换：先把反斜杠自己转义掉，后面加的反斜杠才不会二次转义。
   * 换行（\r\n / \r / \n）统一写成两字符的 \n —— 内容行里出现裸换行
   * 会把一行拆成两行，客户端读到的属性就只剩一半。
   *
   * @param {*} value
   * @returns {string}
   */
  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n/g, '\\n')
      .replace(/[\r\n]/g, '\\n');
  }

  /**
   * 按 RFC 5545 §3.1 折行：每行不超过 75 个**八位字节**，
   * 超出的部分用 CRLF + 一个空格接到下一行。
   *
   * 两个容易踩的点：
   *   · 续行开头那个空格也算在 75 字节里，所以续行只能放 74 字节内容；
   *   · 不能从一个多字节字符中间劈开（那样文件就不是合法 UTF-8 了），
   *     所以按码点（Array.from）遍历，而不是按 code unit。
   *
   * @param {string} line
   * @param {number} [limit]
   * @returns {string} 折好的内容（内部用 CRLF + 空格分隔）
   */
  function foldLine(line, limit) {
    limit = limit || MAX_LINE_BYTES;
    var chars = Array.from(String(line == null ? '' : line));
    var out = [];
    var cur = '';
    var bytes = 0;
    var cap = limit;

    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var b = utf8Len(ch);
      if (bytes + b > cap && cur.length) {
        out.push(cur);
        cur = '';
        bytes = 0;
        cap = limit - 1;      // 续行前面那个空格也占 75 字节里的一个
      }
      cur += ch;
      bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  }

  /**
   * 毫秒 → iCal 的 UTC 日期时间（20261024T120000Z）。
   * @param {number} ms
   * @returns {string}
   */
  function formatUtc(ms) {
    var d = new Date(ms);
    return pad4(d.getUTCFullYear()) +
      pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }

  /**
   * 解析 <input type="datetime-local"> 的值（YYYY-MM-DDTHH:MM[:SS]）。
   *
   * @param {string} value
   * @param {boolean} asLocal true = 按浏览器本地时区解释；false = 按 UTC 解释
   * @returns {number|null} 毫秒时间戳；不合法给 null
   */
  function parseDateTime(value, asLocal) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
      String(value == null ? '' : value).trim()
    );
    if (!m) return null;

    var y = +m[1], mo = +m[2], d = +m[3];
    var hh = +m[4], mi = +m[5], ss = m[6] ? +m[6] : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (hh > 23 || mi > 59 || ss > 59) return null;

    var ms = asLocal
      ? new Date(y, mo - 1, d, hh, mi, ss).getTime()
      : Date.UTC(y, mo - 1, d, hh, mi, ss);
    if (!isFinite(ms)) return null;

    // Date.UTC 会把 2 月 30 日悄悄挪到 3 月 2 日 —— 得校验没有溢出
    var chk = new Date(ms);
    if (asLocal) {
      if (chk.getFullYear() !== y || chk.getMonth() !== mo - 1 || chk.getDate() !== d) return null;
    } else {
      if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
    }
    return ms;
  }

  /**
   * Date → <input type="datetime-local"> 能吃的值。
   * @param {Date} date
   * @param {boolean} asLocal
   * @returns {string}
   */
  function toInputValue(date, asLocal) {
    var y, mo, d, hh, mi;
    if (asLocal) {
      y = date.getFullYear(); mo = date.getMonth() + 1; d = date.getDate();
      hh = date.getHours(); mi = date.getMinutes();
    } else {
      y = date.getUTCFullYear(); mo = date.getUTCMonth() + 1; d = date.getUTCDate();
      hh = date.getUTCHours(); mi = date.getUTCMinutes();
    }
    return pad4(y) + '-' + pad2(mo) + '-' + pad2(d) + 'T' + pad2(hh) + ':' + pad2(mi);
  }

  /**
   * 浏览器所在的时区与当前偏移 —— 界面上要写出来，
   * 否则「按 UTC 解释」这条提示对用户是没有参照系的。
   * @returns {{name: string, offset: string}}
   */
  function describeLocalZone() {
    var name = '';
    try {
      name = (Intl.DateTimeFormat().resolvedOptions().timeZone) || '';
    } catch (e) {
      name = '';
    }
    var off = -new Date().getTimezoneOffset();
    var abs = Math.abs(off);
    return {
      name: name || 'UTC',
      offset: 'UTC' + (off >= 0 ? '+' : '-') + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60)
    };
  }

  /**
   * 生成 .ics 文本。
   *
   * @param {object} opts
   * @param {string} opts.summary      事件标题（必填）
   * @param {string} opts.start        开始时间（datetime-local 的值）
   * @param {string} opts.end          结束时间（datetime-local 的值）
   * @param {string} [opts.description]
   * @param {string} [opts.location]
   * @param {string} [opts.calendarName] → X-WR-CALNAME
   * @param {string} [opts.uid]        VEVENT 的 UID
   * @param {number} [opts.dtstamp]    VEVENT 的 DTSTAMP（毫秒）
   * @param {boolean} [opts.asLocal]   true = 输入按浏览器本地时间解释
   * @returns {{ics: string, error: (null|{code: string, params: object})}}
   */
  function generateIcs(opts) {
    opts = opts || {};

    var summary = String(opts.summary == null ? '' : opts.summary).trim();
    if (!summary) return { ics: '', error: { code: 'title_required', params: {} } };

    var startRaw = String(opts.start == null ? '' : opts.start).trim();
    var endRaw = String(opts.end == null ? '' : opts.end).trim();
    if (!startRaw) return { ics: '', error: { code: 'start_required', params: {} } };
    if (!endRaw) return { ics: '', error: { code: 'end_required', params: {} } };

    var asLocal = !!opts.asLocal;
    var startMs = parseDateTime(startRaw, asLocal);
    if (startMs === null) return { ics: '', error: { code: 'start_invalid', params: {} } };
    var endMs = parseDateTime(endRaw, asLocal);
    if (endMs === null) return { ics: '', error: { code: 'end_invalid', params: {} } };

    // 上游的零时长 bug 就漏在这里：DTEND 必须晚于 DTSTART。
    // 相等也不放过 —— 零长度的事件在日历软件里显示成一列「无时长」。
    if (endMs <= startMs) {
      return {
        ics: '',
        error: { code: 'end_before_start', params: { start: startRaw, end: endRaw } }
      };
    }

    var lines = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:' + PRODID);
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');

    var calName = String(opts.calendarName == null ? '' : opts.calendarName).trim();
    if (calName) lines.push('X-WR-CALNAME:' + escapeText(calName));

    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + String(opts.uid == null ? '' : opts.uid));
    lines.push('DTSTAMP:' + formatUtc(opts.dtstamp == null ? Date.now() : opts.dtstamp));
    lines.push('DTSTART:' + formatUtc(startMs));
    lines.push('DTEND:' + formatUtc(endMs));
    lines.push('SUMMARY:' + escapeText(summary));

    var description = String(opts.description == null ? '' : opts.description);
    if (description.trim()) lines.push('DESCRIPTION:' + escapeText(description));

    var location = String(opts.location == null ? '' : opts.location).trim();
    if (location) lines.push('LOCATION:' + escapeText(location));

    lines.push('END:VEVENT');
    lines.push('END:VCALENDAR');

    // 每行按 75 字节折行；整份文件用 CRLF 连接（RFC 5545 §3.1 要求 CRLF）
    var ics = lines.map(function (line) { return foldLine(line); }).join('\r\n') + '\r\n';
    return { ics: ics, error: null };
  }

  /**
   * UID：随机十六进制 + 域名后半截。
   * 用 crypto.getRandomValues 而不是 Math.random —— 后者不是密码学安全的，
   * 而且两个标签页很容易撞出同一个号（RFC 5545 要求 UID 全局唯一）。
   * @returns {string}
   */
  function makeUid() {
    return U.hex(U.randomBytes(16)) + '@it-tools';
  }

  /**
   * 下载用的文件名：从日历名或标题里取，非法字符换成 '-'。
   * @param {string} text
   * @returns {string}
   */
  function fileNameFor(text) {
    var slug = String(text == null ? '' : text).trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return (slug || 'event') + '.ics';
  }

  /* ==================================================================
     界面
     ================================================================== */

  /**
   * 错误码 → 文案。
   *
   * 键必须是字符串字面量：Rust 侧扫的是源码里的 t('key', …)，
   * 拼出来的键它认不出来，语言包里也就查不到有没有这一条。
   *
   * @param {string} code
   * @param {object} params
   * @returns {string}
   */
  function errorMessage(code, params) {
    params = params || {};
    switch (code) {
      case 'title_required':
        return t('err_title_required', 'Please fill in the event title.');
      case 'start_required':
        return t('err_start_required', 'Please pick a start time.');
      case 'end_required':
        return t('err_end_required', 'Please pick an end time.');
      case 'start_invalid':
        return t('err_start_invalid', 'The start time is not a valid date and time.');
      case 'end_invalid':
        return t('err_end_invalid', 'The end time is not a valid date and time.');
      case 'end_before_start':
        return t('err_end_before_start', 'The end time ({end}) must be later than the start time ({start}).')
          .replace('{end}', function () { return params.end == null ? '' : params.end; })
          .replace('{start}', function () { return params.start == null ? '' : params.start; });
      default:
        return t('err_unknown', 'The event could not be generated.');
    }
  }

  window.ItTools.register('ical-generator', function (root) {
    var titleInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('title_ph', 'e.g. Team meeting')
    });
    var startInput = D.h('input.layui-input', { type: 'datetime-local', step: '60' });
    var endInput = D.h('input.layui-input', { type: 'datetime-local', step: '60' });
    var descInput = D.h('textarea.layui-textarea', {
      rows: 3,
      placeholder: t('desc_ph', 'What is this event about?')
    });
    var locInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('loc_ph', 'Room, address or meeting link')
    });
    var calInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('cal_ph', 'Shown as the calendar name by some apps (X-WR-CALNAME)')
    });
    var localModeInput = D.h('input', { type: 'checkbox' });

    var status = D.h('p.form-status');
    var tzHint = D.h('p.field-hint');

    // 输出用 <pre> 而不是 <textarea>：
    // textarea 的 value 会把 CRLF 归一成 LF（HTML 规范如此），
    // 复制/下载出来的 .ics 就不是 RFC 5545 要的 CRLF 了。
    var outPre = D.h('pre.output-raw');
    var outCard = D.outputCard(t('output', 'Generated .ics'));

    var downloadBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button',
      text: t('download', 'Download .ics')
    });
    outCard.outputBody.appendChild(outPre);
    // 下载按钮与提示都挂在**卡片**上，不挂在 outputBody 里 ——
    // outputCard 的复制按钮复制的是 outputBody.textContent，
    // 按钮放进去的话，复制出来的是「.ics 正文 + 按钮文案」。
    outCard.appendChild(D.h('div.form-actions', null, downloadBtn));
    outCard.appendChild(D.h('p.field-hint', {
      text: t('output_hint', 'The file uses CRLF line endings and UTF-8. Lines longer than 75 bytes are folded the way RFC 5545 asks for.')
    }));

    // UID 与 DTSTAMP 只生成一次：它们是「这个事件」的标识，
    // 每敲一个字就换一次的话，导出的文件每次都不一样（也谈不上唯一了）。
    var uid = makeUid();
    var dtstampMs = Date.now();

    // 结束时间是不是用户自己动过的。没动过的话，开始时间一变，
    // 结束时间跟着走（默认时长 1 小时）；动过就听用户的，
    // 哪怕他填错了 —— 那样要报错，而不是悄悄改掉他填的值。
    var endTouched = false;

    function nowWallClock(asLocal) {
      var d = new Date(Date.now() + 60 * 60 * 1000);
      d.setMinutes(0, 0, 0);       // 取下一个整点
      return toInputValue(d, asLocal);
    }

    function plusOneHour(value, asLocal) {
      var ms = parseDateTime(value, asLocal);
      if (ms === null) return '';
      return toInputValue(new Date(ms + DEFAULT_DURATION_MS), asLocal);
    }

    function renderHint() {
      var zone = describeLocalZone();
      if (localModeInput.checked) {
        tzHint.textContent = t('hint_local', 'Times are read as your browser local time ({tz}, {offset}) and converted to UTC in the output — the .ics still carries no VTIMEZONE.')
          .replace('{tz}', function () { return zone.name; })
          .replace('{offset}', function () { return zone.offset; });
      } else {
        tzHint.textContent = t('hint_utc', 'Times are read as UTC and written as ...Z (for example 20261024T120000Z), so no VTIMEZONE is needed. Your browser time zone is {tz} ({offset}) — enter UTC clock times, or turn on the toggle below to convert from your local time.')
          .replace('{tz}', function () { return zone.name; })
          .replace('{offset}', function () { return zone.offset; });
      }
    }

    function render() {
      renderHint();
      var res = generateIcs({
        summary: titleInput.value,
        start: startInput.value,
        end: endInput.value,
        description: descInput.value,
        location: locInput.value,
        calendarName: calInput.value,
        uid: uid,
        dtstamp: dtstampMs,
        asLocal: localModeInput.checked
      });

      if (res.error) {
        status.className = 'form-status is-error';
        status.textContent = errorMessage(res.error.code, res.error.params);
        outPre.textContent = '';
        downloadBtn.disabled = true;
        return;
      }

      var name = fileNameFor(calInput.value || titleInput.value);
      status.className = 'form-status';
      status.textContent = t('ready', 'Ready: {name}')
        .replace('{name}', function () { return name; });
      outPre.textContent = res.ics;
      downloadBtn.disabled = false;
      downloadBtn.onclick = function () {
        window.ItTools.download(name, res.ics, 'text/calendar;charset=utf-8');
      };
    }

    // 时间默认值：下一个整点 + 一小时。切换「按本地时间读」时也用它重填，
    // 但不动标题 —— 用户填的东西不能因为切了个开关就没了。
    function fillTimes() {
      var asLocal = localModeInput.checked;
      startInput.value = nowWallClock(asLocal);
      endInput.value = plusOneHour(startInput.value, asLocal);
      endTouched = false;
    }

    function setDefaults() {
      // 先摆一个能用的样例：一进来就能看到 .ics 长什么样，
      // 而不是一片空白外加一句「请填标题」。
      titleInput.value = 'Team meeting';
      fillTimes();
    }

    var offs = [];
    offs.push(D.on(titleInput, 'input', render));
    offs.push(D.on(descInput, 'input', render));
    offs.push(D.on(locInput, 'input', render));
    offs.push(D.on(calInput, 'input', render));
    offs.push(D.on(startInput, 'input', function () {
      if (!endTouched) endInput.value = plusOneHour(startInput.value, localModeInput.checked);
      render();
    }));
    offs.push(D.on(endInput, 'input', function () {
      endTouched = true;
      render();
    }));
    offs.push(D.on(localModeInput, 'change', function () {
      // 换了解释方式，墙上时间重新按新口径填一遍（标题不动）
      fillTimes();
      render();
    }));

    var suggestBtn = D.h('button.layui-btn.layui-btn-sm', {
      type: 'button',
      text: t('suggest_end', 'End = start + 1 h')
    });
    suggestBtn.addEventListener('click', function () {
      endInput.value = plusOneHour(startInput.value, localModeInput.checked);
      render();
    });

    // 两块面板：上面填表、下面出结果。
    // 子块必须待在卡片里 —— .tool-content 的 flex 把每个直属子元素
    // 都当成一块独立面板，字段、按钮条这些碎片飘在外面会各自变成一张卡片。
    root.appendChild(D.h('div.card', null,
      U.field(t('title_label', 'Event title'), titleInput),
      U.field(t('start_label', 'Start time'), startInput),
      U.field(t('end_label', 'End time'), endInput),
      D.h('div.form-actions', null, suggestBtn),
      D.h('p.field-hint', {
        text: t('duration_hint', 'The end time must be later than the start time. By default the end is one hour after the start.')
      }),
      U.field(t('desc_label', 'Description'), descInput),
      U.field(t('loc_label', 'Location'), locInput),
      U.field(t('cal_label', 'Calendar name'), calInput),
      D.h('label.switch', null,
        localModeInput,
        D.h('span', { text: t('local_mode', 'Read the times above as my browser local time') })
      ),
      tzHint,
      status
    ));

    root.appendChild(outCard);

    setDefaults();
    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  /* ==================================================================
     单测用的纯逻辑
     ================================================================== */

  window.ItTools.logic['ical-generator'] = {
    escapeText: escapeText,
    foldLine: foldLine,
    formatUtc: formatUtc,
    parseDateTime: parseDateTime,
    toInputValue: toInputValue,
    generateIcs: generateIcs,
    fileNameFor: fileNameFor,
    __cases: function (assert) {
      /* ---- 转义（RFC 5545 §3.3.11）---- */
      assert.eq(escapeText('plain'), 'plain', '没有特殊字符就不动');
      assert.eq(escapeText('a,b'), 'a\\,b', '逗号要转义');
      assert.eq(escapeText('a;b'), 'a\\;b', '分号要转义');
      assert.eq(escapeText('a\\b'), 'a\\\\b', '反斜杠要转义');
      assert.eq(escapeText('a\nb'), 'a\\nb', '换行写成两字符的 \\n');
      assert.eq(escapeText('a\r\nb'), 'a\\nb', 'CRLF 也算一次换行');
      assert.eq(escapeText('a\rb'), 'a\\nb', '单独的 CR 也是换行');
      assert.eq(escapeText(''), '', '空串');
      assert.eq(escapeText('\\\\n'), '\\\\\\\\n', '先转义反斜杠，再把真换行转义 —— 顺序不能换');
      assert.eq(escapeText('中,文'), '中\\,文', '中文照转义');

      /* ---- 折行：按字节，不按字符 ---- */
      assert.eq(foldLine('SHORT'), 'SHORT', '短行不折');
      // 149 个字符：第一段 75，第二段 74 —— 正好把「续行前面那个空格也占 75 字节」这条测到
      var long149 = 'SUMMARY:' + new Array(142).join('x');
      assert.eq(long149.length, 149, '样本长度对');
      var folded = foldLine(long149);
      var parts = folded.split('\r\n ');
      assert.eq(parts.length, 2, '长行折成了两段');
      assert.eq(parts[0].length, 75, '第一段正好 75 个字节');
      assert.eq(parts[1].length, 74, '续行只有 74 个字节（前面那个空格算第 75 个）');
      // 折行是可逆的：把折行展开要拿回原样
      assert.eq(parts.join(''), long149, '展开折行能还原原文');

      // 多字节：中文一个字 3 字节，按字符折会超限，按字节折才不会
      var zh = 'SUMMARY:' + new Array(30).join('中');
      var zhParts = foldLine(zh).split('\r\n ');
      var ok = true;
      for (var i = 0; i < zhParts.length; i++) {
        if (new TextEncoder().encode(zhParts[i]).length > 75) ok = false;
      }
      assert(ok, '中文行折开后每段都不超过 75 个字节');
      assert.eq(zhParts.join(''), zh, '中文折行展开后能还原');
      // 不能把一个汉字劈成两半（那样就不是合法 UTF-8 了）
      var half = foldLine('中'.repeat(30)).split('\r\n ');
      var intact = half.every(function (seg) { return !/[\uD800-\uDBFF]$/.test(seg); });
      assert(intact, '折行不会从一个多字节字符中间断开');

      /* ---- 时间解析 ---- */
      assert.eq(parseDateTime('2026-10-24T12:00', false), Date.UTC(2026, 9, 24, 12, 0, 0),
        '按 UTC 解释时就是 Date.UTC');
      assert.eq(parseDateTime('2026-10-24T12:00', true), new Date(2026, 9, 24, 12, 0, 0).getTime(),
        '按本地时间解释时走 Date 的本地构造器');
      assert.eq(parseDateTime('2026-10-24T12:00:30', false), Date.UTC(2026, 9, 24, 12, 0, 30),
        '带秒也能解析');
      assert.eq(parseDateTime('2026-10-24', true), null, '光有日期不行');
      assert.eq(parseDateTime('', true), null, '空串不行');
      assert.eq(parseDateTime('not a date', true), null, '垃圾输入不行');
      assert.eq(parseDateTime('2026-02-30T10:00', true), null, '2 月 30 日不存在');
      assert.eq(parseDateTime('2026-13-01T10:00', true), null, '13 月不存在');
      assert.eq(parseDateTime('2026-10-24T25:00', true), null, '25 点不存在');
      assert.eq(formatUtc(Date.UTC(2026, 9, 24, 12, 0, 0)), '20261024T120000Z', 'UTC 格式化');
      assert.eq(toInputValue(new Date(Date.UTC(2026, 9, 24, 12, 0, 0)), false), '2026-10-24T12:00',
        '回填 datetime-local（UTC）');

      /* ---- 生成 .ics ---- */
      var res = generateIcs({
        summary: 'Team meeting',
        start: '2026-10-24T12:00',
        end: '2026-10-24T13:00',
        description: 'Discuss, then demo.',
        location: 'Room 1',
        calendarName: 'Work',
        uid: 'abc123@it-tools',
        dtstamp: Date.UTC(2026, 9, 20, 9, 0, 0)
      });
      assert.eq(res.error, null, '合法输入不报错');
      var ics = res.ics;
      assert(ics.indexOf('BEGIN:VCALENDAR') === 0, '以 BEGIN:VCALENDAR 开头');
      assert(ics.indexOf('END:VCALENDAR') > 0, '有 END:VCALENDAR');
      assert(ics.indexOf('\r\nVERSION:2.0\r\n') > 0, '有 VERSION:2.0');
      assert(ics.indexOf('\r\nPRODID:-//it-tools//iCal Generator//ZH\r\n') > 0, '有 PRODID');
      assert(ics.indexOf('\r\nCALSCALE:GREGORIAN\r\n') > 0, '有 CALSCALE');
      assert(ics.indexOf('\r\nMETHOD:PUBLISH\r\n') > 0, '有 METHOD');
      assert(ics.indexOf('\r\nX-WR-CALNAME:Work\r\n') > 0, '日历名真的写进去了（上游这里是死代码）');
      assert(ics.indexOf('\r\nBEGIN:VEVENT\r\n') > 0, '有 BEGIN:VEVENT');
      assert(ics.indexOf('\r\nEND:VEVENT\r\n') > 0, '有 END:VEVENT');
      assert(ics.indexOf('\r\nUID:abc123@it-tools\r\n') > 0, '有 UID');
      assert(ics.indexOf('\r\nDTSTAMP:20261020T090000Z\r\n') > 0, '有 DTSTAMP');
      assert(ics.indexOf('\r\nDTSTART:20261024T120000Z\r\n') > 0, 'DTSTART 是 UTC');
      assert(ics.indexOf('\r\nDTEND:20261024T130000Z\r\n') > 0, 'DTEND 是 UTC');
      assert(ics.indexOf('\r\nSUMMARY:Team meeting\r\n') > 0, '有 SUMMARY');
      assert(ics.indexOf('\r\nDESCRIPTION:Discuss\\, then demo.\r\n') > 0, 'DESCRIPTION 里的逗号被转义');
      assert(ics.indexOf('\r\nLOCATION:Room 1\r\n') > 0, '有 LOCATION');
      assert(ics.slice(-2) === '\r\n', '文件以 CRLF 结尾');
      assert(/[^\r]\n/.test(ics) === false, '没有裸的 LF —— 行尾全是 CRLF');
      // 上游的零时长 bug：DTEND 必须晚于 DTSTART
      assert.eq(generateIcs({ summary: 'x', start: '2026-10-24T12:00', end: '2026-10-24T12:00' }).error.code,
        'end_before_start', '结束时间等于开始时间要报错（零时长）');
      assert.eq(generateIcs({ summary: 'x', start: '2026-10-24T13:00', end: '2026-10-24T12:00' }).error.code,
        'end_before_start', '结束时间早于开始时间要报错');
      assert.eq(generateIcs({ summary: 'x', start: '2026-10-24T12:00', end: '2026-10-24T12:00' }).ics, '',
        '出错时不产出半成品');
      assert.eq(generateIcs({ summary: '  ', start: '2026-10-24T12:00', end: '2026-10-24T13:00' }).error.code,
        'title_required', '标题必填');
      assert.eq(generateIcs({ summary: 'x', start: '', end: '2026-10-24T13:00' }).error.code,
        'start_required', '开始时间必填');
      assert.eq(generateIcs({ summary: 'x', start: '2026-10-24T12:00', end: '' }).error.code,
        'end_required', '结束时间必填');
      assert.eq(generateIcs({ summary: 'x', start: 'nope', end: '2026-10-24T13:00' }).error.code,
        'start_invalid', '开始时间不合法要报错');
      // 可选字段为空时不能留下空行
      var bare = generateIcs({ summary: 'x', start: '2026-10-24T12:00', end: '2026-10-24T13:00' }).ics;
      assert(bare.indexOf('DESCRIPTION') === -1, '没有描述就不写 DESCRIPTION');
      assert(bare.indexOf('LOCATION') === -1, '没有地点就不写 LOCATION');
      assert(bare.indexOf('X-WR-CALNAME') === -1, '没有日历名就不写 X-WR-CALNAME');
      // 长摘要要折行，且折开后每行仍然不超过 75 字节
      var longRes = generateIcs({
        summary: new Array(60).join('中'),
        start: '2026-10-24T12:00',
        end: '2026-10-24T13:00'
      });
      var longOk = longRes.ics.split('\r\n').every(function (line) {
        return new TextEncoder().encode(line).length <= 75;
      });
      assert(longOk, '折行后每行都不超过 75 字节');
      assert(longRes.ics.indexOf('\r\n ') > 0, '长行确实折了（续行以 CRLF + 空格开头）');
    }
  };
})();
