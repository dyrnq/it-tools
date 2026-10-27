/* ==========================================================================
   MongoDB ObjectId 生成 / 解析（object-id）

   ObjectId 是 MongoDB 的默认主键：12 字节，24 个十六进制字符。

     字节 0–3    4 字节 Unix 时间戳（秒，**大端** / 网络字节序）
     字节 4–8    5 字节随机值（进程启动时随机生成一次，之后一直复用）
     字节 9–11   3 字节计数器（进程启动时随机初始化，每生成一个 +1，到 2^24 回绕）

   ---- 与上游 PR #1463 的差别（上游有 bug，不能照抄） ----
   1. **时间戳用完整的 32 位无符号数**。上游写的是
      `(milliseconds / 1000 | 0).toString(16)` —— 那个 `| 0` 是**有符号**的
      32 位截断：2038 年之后（秒数 > 2^31）会变成负数，十六进制里带着负号，
      长度都不是 24 了。这里一律 `>>> 0`，时间戳字段能表示
      [1970-01-01, 2106-02-07)。解析那一侧同理：四个字节按大端拼回整数之后
      必须再 `>>> 0` 一次，否则 2038 年后的 ObjectId 会被解成负数。
   2. **随机数走 crypto**。上游用 lodash 的 `_.random(0, 1, true)`（底下是
      Math.random），不是密码学安全的随机源。这里一律 U.randomBytes。
   3. **随机值与计数器按进程维护**，跟 MongoDB 驱动一个路数：5 字节随机值整个
      进程只生成一次，3 字节计数器在进程内单调递增。所以同一进程里连续生成的
      几个 ObjectId **只有计数器那 3 个字节不同**。
      上游每次生成都把整条尾巴重随一遍 —— 那不是 ObjectId，
      同进程内生成的多个 id 之间没有任何先后关系。
   4. **上游压根没有计数器**：它把时间戳后面 16 个 hex 全用随机数填了，
      12 字节的布局是错的（8 字节时间戳 + 8 字节随机 + 4 字节随机）。
   5. ObjectId **没有 version 字段**。有些实现（含一些第三方库）把第 4 个字节的
      高位当成版本号 —— 那是 UUID 的概念，ObjectId 里没有这个东西，
      第 4 个字节属于随机值。

   ---- 与本仓库 date-time-converter 的分工 ----
   date-time-converter 已经支持 mongo-objectid 格式（日期 ↔ ObjectId 双向换算），
   那边管的是「换算」，这里管的是「批量生成 + 结构拆解」，互补不重复。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('object-id');

  /** ObjectId 的字节数。 */
  var BYTE_LEN = 12;
  /** ObjectId 的十六进制长度（12 字节 × 2）。 */
  var HEX_LEN = 24;

  var MIN_AMOUNT = 1;
  var MAX_AMOUNT = 1000;

  /** 时间戳字段能表示的最大秒数：2^32-1 = 4294967295 = 2106-02-07T06:28:15Z。 */
  var MAX_TIMESTAMP = 0xffffffff;
  /** 计数器是 3 字节，进制 2^24。 */
  var COUNTER_MOD = 0x1000000;

  /**
   * 进程级状态：5 字节随机值 + 3 字节计数器。
   *
   * MongoDB 驱动就是这两个 —— 随机值整个进程只生成一次（叫「机器值」，
   * 同一台机器上的进程用它做粗粒度区分），计数器在进程内单调递增，
   * 用来保证同一个进程里生成的 id 不重复。
   *
   * **延迟到第一次生成时再初始化**：一是模块加载时不碰 crypto
   * （老浏览器没有 crypto 时不至于整个模块挂掉），二是「进程」的语义更贴切 ——
   * 页面来回切几次、工具反复挂载卸载，计数器都接着往下走。
   */
  var processRandom = null;    // number[5]
  var processCounter = null;   // number，0..2^24-1

  function ensureProcessState() {
    if (processRandom !== null) return;
    var r = U.randomBytes(5);
    processRandom = [r[0], r[1], r[2], r[3], r[4]];
    var c = U.randomBytes(3);
    processCounter = ((c[0] << 16) | (c[1] << 8) | c[2]) >>> 0;
  }

  /** 计数器 +1，到 2^24 回绕（3 字节只有这么多位）。 */
  function nextCounter() {
    processCounter = (processCounter + 1) % COUNTER_MOD;
    return processCounter;
  }

  /**
   * 秒数是否落在 ObjectId 时间戳字段能表示的范围内。
   * @param {*} secs
   * @returns {boolean}
   */
  function isValidTimestamp(secs) {
    var n = Number(secs);
    return isFinite(n) && Math.floor(n) === n && n >= 0 && n <= MAX_TIMESTAMP;
  }

  /**
   * 生成一个 ObjectId。
   *
   * @param {{timestamp?: (number|string|null)}} [opts]
   *   timestamp —— Unix 秒；不给（或给 null / 空串）就用当前时间
   * @returns {string} 24 位小写十六进制
   */
  function generateObjectId(opts) {
    opts = opts || {};
    ensureProcessState();

    var raw = opts.timestamp;
    // 空串 / 全是空白 = 「没填」= 用当前时间（界面上留空就是这个意思）
    var blank = raw === undefined || raw === null ||
      (typeof raw === 'string' && raw.trim() === '');
    var secs = blank ? Math.floor(Date.now() / 1000) : Number(raw);
    if (!isValidTimestamp(secs)) {
      throw new Error(t('err_timestamp_range', 'Timestamp must be a whole number of seconds between 0 and {max}.')
        .replace('{max}', function () { return String(MAX_TIMESTAMP); }));
    }

    // `>>> 0` 而不是 `| 0`：时间戳字段是**无符号** 32 位。
    // `| 0` 会把超过 2^31 的秒数（2038 年之后）截成负数 —— 上游就栽在这里。
    var ts = secs >>> 0;
    var counter = nextCounter();
    var bytes = [
      (ts >>> 24) & 0xff, (ts >>> 16) & 0xff, (ts >>> 8) & 0xff, ts & 0xff,
      processRandom[0], processRandom[1], processRandom[2], processRandom[3], processRandom[4],
      (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff
    ];
    return U.hex(bytes);
  }

  /**
   * 批量生成。
   * @param {number} amount
   * @param {{timestamp?: (number|string|null)}} [opts]
   * @returns {string[]}
   */
  function generateObjectIds(amount, opts) {
    var n = clampAmount(amount);
    var out = [];
    for (var i = 0; i < n; i++) out.push(generateObjectId(opts));
    return out;
  }

  /** 数量夹到 [1, 1000]。NaN / 空 / 负数 / 超量都归到这个区间里。 */
  function clampAmount(amount) {
    var n = Math.floor(Number(amount));
    if (!isFinite(n)) return MIN_AMOUNT;
    return Math.max(MIN_AMOUNT, Math.min(MAX_AMOUNT, n));
  }

  /** 一个十进制字节值（0..255）。 */
  function isByteValue(tok) {
    if (!/^\d{1,3}$/.test(tok)) return false;
    var n = parseInt(tok, 10);
    return n >= 0 && n <= 255;
  }

  /**
   * 把一行输入解成 12 字节。
   *
   * 接受两种写法：24 个十六进制字符（大小写都收），或者 12 个十进制字节值
   * （空格 / 逗号分隔）—— 后者是「12 字节」的字面写法。
   *
   * **不抛异常**：非法输入一律以 { ok: false, error: … } 返回，
   * 界面上把 error 显示出来，而不是让整页炸掉。
   *
   * @param {string} text
   * @returns {{ok: true, bytes: number[]}|{ok: false, error: string}}
   */
  function decodeObjectId(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return { ok: false, error: t('err_empty', 'Nothing to parse.') };

    if (/^[0-9a-fA-F]{24}$/.test(s)) {
      var bytes = [];
      for (var i = 0; i < BYTE_LEN; i++) bytes.push(parseInt(s.substr(i * 2, 2), 16));
      return { ok: true, bytes: bytes };
    }

    var toks = s.split(/[\s,]+/).filter(function (x) { return x.length > 0; });
    if (toks.length === BYTE_LEN) {
      var bad = null;
      toks.forEach(function (tok) { if (bad === null && !isByteValue(tok)) bad = tok; });
      if (bad === null) {
        return { ok: true, bytes: toks.map(function (tok) { return parseInt(tok, 10); }) };
      }
      return { ok: false, error: t('err_byte_value', 'Byte value {v} is not in the range 0-255.')
        .replace('{v}', function () { return bad; }) };
    }

    return { ok: false, error: describeInvalid(s) };
  }

  /**
   * 说清楚输入错在哪：长度不对就说长度，字符非法就点名第一个非法字符。
   * @param {string} s 已经 trim 过的输入
   * @returns {string}
   */
  function describeInvalid(s) {
    if (s.length !== HEX_LEN) {
      return t('err_length', 'Expected 24 hex characters (12 bytes), got {len}.')
        .replace('{len}', function () { return String(s.length); });
    }
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (!/[0-9a-fA-F]/.test(ch)) {
        return t('err_char', 'Invalid hex character {ch} at position {pos}.')
          .replace('{ch}', function () { return ch; })
          .replace('{pos}', function () { return String(i + 1); });
      }
    }
    // 长度对、字符也都是 hex —— 上面那条正则早就匹配上了，走不到这里。
    return t('err_format', 'Expected 24 hex characters or 12 byte values.');
  }

  /**
   * 把 12 字节拆成结构。
   *
   * 时间戳是**大端**（网络字节序，高位在前），拼回整数之后要 `>>> 0`：
   * `(b0 << 24)` 是有符号运算，2038 年后的 ObjectId 会解成负数。
   *
   * @param {number[]} bytes 12 个字节
   * @param {string} input 原始输入（回显用）
   * @returns {Object}
   */
  function describeBytes(bytes, input) {
    var ts = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    var ms = ts * 1000;
    var date = new Date(ms);
    var counter = ((bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0;
    return {
      input: input,
      hex: U.hex(bytes),
      bytes: bytes.slice(),
      byteLength: bytes.length,
      hexLength: bytes.length * 2,
      timestamp: ts,
      timestampHex: U.hex([bytes[0], bytes[1], bytes[2], bytes[3]]),
      timestampMs: ms,
      // 本地时间与 UTC 都交给 Date 去做，不要自己换算时区
      dateLocal: date.toString(),
      dateUtc: date.toISOString(),
      randomHex: U.hex([bytes[4], bytes[5], bytes[6], bytes[7], bytes[8]]),
      counterHex: U.hex([bytes[9], bytes[10], bytes[11]]),
      counter: counter
    };
  }

  /**
   * 解析多行输入。**一行一个**，空行跳过；出错的那行不影响其它行。
   * @param {string} text
   * @returns {{results: Object[], errors: {line: number, message: string}[]}}
   */
  function parseObjectIds(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var results = [];
    var errors = [];
    lines.forEach(function (line, idx) {
      var s = line.trim();
      if (!s) return;
      var decoded = decodeObjectId(s);
      if (decoded.ok) results.push(describeBytes(decoded.bytes, s));
      else errors.push({ line: idx + 1, message: decoded.error });
    });
    return { results: results, errors: errors };
  }

  /**
   * 把一条拆解结果渲染成文本。
   *
   * 标签逐条走 i18n，所以用「标签: 值」而不是对齐的表格 ——
   * 中文标签的宽度跟英文不一样，对齐表格在中文界面里会歪。
   *
   * @param {Object} d describeBytes 的结果
   * @returns {string}
   */
  function formatDescription(d) {
    var lines = [];
    lines.push(t('parse_id', 'ObjectId') + ' ' + d.hex);
    lines.push(t('parse_bytes', 'Bytes') + ': ' + d.byteLength + ' (' + d.hexLength + ' hex chars)');
    lines.push(t('parse_timestamp', 'Timestamp') + ': ' + d.timestamp + ' s (0x' + d.timestampHex + ')');
    lines.push(t('parse_utc', 'UTC') + ': ' + d.dateUtc);
    lines.push(t('parse_local', 'Local') + ': ' + d.dateLocal);
    lines.push(t('parse_random', 'Random value') + ': ' + d.randomHex + ' (5 bytes)');
    lines.push(t('parse_counter', 'Counter') + ': ' + d.counterHex + ' (0x' + d.counterHex + ' = ' + d.counter + ')');
    return lines.join('\n');
  }

  /* ==================================================================
     界面
     ================================================================== */

  window.ItTools.register('object-id', function (root) {
    /* ---------- 生成 ---------- */

    var amount = D.h('input.layui-input', { type: 'number', min: MIN_AMOUNT, max: MAX_AMOUNT, value: 1 });
    var tsInput = D.h('input.layui-input', {
      type: 'number', min: 0, max: MAX_TIMESTAMP, spellcheck: 'false',
      placeholder: t('ph_timestamp', 'Unix seconds, empty = now')
    });
    var genBody = D.h('div.output-body');
    var genStatus = D.h('p.form-status');

    /** 当前这一批生成的 id（复制全部 / 逐条复制都用它）。 */
    var generated = [];

    function renderGenerated() {
      D.clear(genBody);
      generated.forEach(function (id) {
        // 每个 id 一行，行尾一个复制按钮
        genBody.appendChild(D.h('div.form-actions', null,
          D.h('span', { text: id }),
          U.copyButton(function () { return id; }, t('copy_one', 'Copy'))
        ));
      });
    }

    function generate() {
      var raw = tsInput.value.trim();
      var opts = {};
      if (raw !== '') opts.timestamp = Number(raw);
      try {
        generated = generateObjectIds(amount.value, opts);
      } catch (e) {
        generated = [];
        genStatus.className = 'form-status is-error';
        genStatus.textContent = e.message;
        renderGenerated();
        return;
      }
      genStatus.className = 'form-status';
      genStatus.textContent = t('generated_count', '{count} ObjectId(s) generated.')
        .replace('{count}', function () { return String(generated.length); });
      renderGenerated();
    }

    var copyAll = U.copyButton(function () { return generated.join('\n'); }, t('copy_all', 'Copy all'));

    /* ---------- 解析 ---------- */

    var parseInput = D.h('textarea.layui-textarea', {
      rows: 6, spellcheck: 'false',
      placeholder: t('ph_parse', '507f1f77bcf86cd799439011')
    });
    var parseBody = D.h('div.output-body');
    var parseStatus = D.h('p.form-status');

    function renderParsed() {
      var res = parseObjectIds(parseInput.value);
      parseBody.textContent = res.results.map(formatDescription).join('\n\n');

      if (res.errors.length) {
        parseStatus.className = 'form-status is-error';
        parseStatus.textContent = res.errors.map(function (e) {
          return t('err_line', 'Line {line}: {msg}')
            .replace('{line}', function () { return String(e.line); })
            .replace('{msg}', function () { return e.message; });
        }).join('\n');
      } else if (!res.results.length) {
        parseStatus.className = 'form-status';
        parseStatus.textContent = t('status_empty', 'Type or paste an ObjectId above.');
      } else {
        parseStatus.className = 'form-status';
        parseStatus.textContent = '';
      }
    }

    var offs = [];
    offs.push(D.on(parseInput, 'input', renderParsed));

    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('quantity', 'Quantity:') }), amount),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('fixed_timestamp', 'Fixed timestamp (Unix seconds):') }), tsInput),
      D.h('p.field-hint', { text: t('timestamp_hint', 'Leave empty to use the current time. The timestamp field is 32-bit unsigned: 0 to 4294967295 seconds (1970-01-01 to 2106-02-07).') }),
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('generate', 'Generate'), onclick: generate }),
        copyAll
      ),
      D.h('label.field-label', { text: t('generated_ids', 'Generated ObjectIds') }),
      genBody,
      genStatus
    ));

    root.appendChild(D.h('div.card', null,
      U.field(t('objectids', 'ObjectIds:'), parseInput, { wide: true }),
      D.h('p.field-hint', { text: t('parse_hint', 'One ObjectId per line. Accepts 24 hex characters (case-insensitive) or 12 byte values separated by spaces.') }),
      parseStatus,
      D.h('label.field-label', { text: t('parsed_ids', 'Structure') }),
      parseBody
    ));

    generate();
    renderParsed();

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

  window.ItTools.logic['object-id'] = {
    BYTE_LEN: BYTE_LEN,
    HEX_LEN: HEX_LEN,
    MIN_AMOUNT: MIN_AMOUNT,
    MAX_AMOUNT: MAX_AMOUNT,
    MAX_TIMESTAMP: MAX_TIMESTAMP,
    COUNTER_MOD: COUNTER_MOD,
    isValidTimestamp: isValidTimestamp,
    clampAmount: clampAmount,
    generateObjectId: generateObjectId,
    generateObjectIds: generateObjectIds,
    decodeObjectId: decodeObjectId,
    describeBytes: describeBytes,
    parseObjectIds: parseObjectIds,
    formatDescription: formatDescription,
    __cases: function (assert) {
      var HEX_RE = /^[0-9a-f]{24}$/;

      /* ---- 生成的基本形状 ---- */
      var one = generateObjectId();
      assert.eq(one.length, 24, 'ObjectId 是 24 个字符');
      assert(HEX_RE.test(one), '只含小写十六进制字符: ' + one);
      assert.eq(generateObjectIds(7).length, 7, '批量生成 7 条');
      assert(generateObjectIds(7).every(function (id) { return HEX_RE.test(id); }), '批量结果都合法');

      /* ---- 数量夹取 ---- */
      assert.eq(clampAmount(1), 1, '下限');
      assert.eq(clampAmount(1000), 1000, '上限');
      assert.eq(clampAmount(0), 1, '0 抬到 1');
      assert.eq(clampAmount(-5), 1, '负数抬到 1');
      assert.eq(clampAmount(9999), 1000, '超量压到 1000');
      assert.eq(clampAmount('12'), 12, '数字字符串也吃');
      assert.eq(clampAmount('nope'), 1, '非数字退到 1');
      assert.eq(clampAmount(''), 1, '空串退到 1');

      /* ---- 时间戳：大端 + 32 位无符号（这几条是防 Y2038 的） ---- */
      // 0x507f1f77 = 1350508407 = 2012-10-17T21:13:27Z
      assert.eq(generateObjectId({ timestamp: 0x507f1f77 }).slice(0, 8), '507f1f77',
        '固定时间戳占头 4 字节（大端，高位在前）');
      assert.eq(generateObjectId({ timestamp: 1700000000 }).slice(0, 8), '6553f100',
        '另一个固定时间戳的大端表示');

      // 2^31 = 2038-01-19T03:14:08Z：符号位正好翻过来的那一个。
      // 用 | 0 会得到 '80000000' 之外的负数表示，长度都不是 8。
      assert.eq(generateObjectId({ timestamp: 0x80000000 }).slice(0, 8), '80000000',
        '2^31 的时间戳仍是无符号大端（2038 年之后不算负数）');
      assert.eq(generateObjectId({ timestamp: 0x80000000 }).length, 24, '2^31 的时间戳下长度仍是 24');
      // 2^32-1 = 2106-02-07T06:28:15Z：时间戳字段的上界
      assert.eq(generateObjectId({ timestamp: 0xffffffff }).slice(0, 8), 'ffffffff',
        '2^32-1 的时间戳不被截断');
      assert.eq(generateObjectId({ timestamp: 0xffffffff }).length, 24, '上界下长度仍是 24');

      assert(isValidTimestamp(0xffffffff), '2^32-1 是合法时间戳');
      assert(isValidTimestamp(0), '0 是合法时间戳');
      assert(!isValidTimestamp(0x100000000), '超过 2^32-1 不合法');
      assert(!isValidTimestamp(-1), '负数不合法');
      assert(!isValidTimestamp(1.5), '小数不合法');
      assert(!isValidTimestamp('abc'), '非数字不合法');

      // 越界的时间戳要报错，不能悄悄回绕成一个看着合法的 id
      var rangeThrew = false;
      var rangeMsg = '';
      try { generateObjectId({ timestamp: 0x100000000 }); } catch (e) { rangeThrew = true; rangeMsg = e.message; }
      assert(rangeThrew, '越界的时间戳被拒');
      assert(rangeMsg.length > 0, '越界时报错带说明');

      /* ---- 计数器：同一批次里只有计数器字节不同 ---- */
      var batch = generateObjectIds(5, { timestamp: 0x507f1f77 });
      var stamps = batch.map(function (id) { return id.slice(0, 8); });
      var randoms = batch.map(function (id) { return id.slice(8, 18); });
      var counters = batch.map(function (id) { return id.slice(18); });
      assert.eq(new Set(stamps).size, 1, '同一时间戳下头 4 字节都一样');
      assert.eq(new Set(randoms).size, 1, '同一进程里 5 字节随机值全程复用');
      assert.eq(new Set(batch.map(function (id) { return id.slice(0, 18); })).size, 1,
        '同一批次里只有计数器那 3 个字节不同');
      for (var i = 1; i < batch.length; i++) {
        var prev = parseInt(counters[i - 1], 16);
        var cur = parseInt(counters[i], 16);
        assert.eq(cur, (prev + 1) % COUNTER_MOD, '第 ' + i + ' 条的计数器 +1');
      }
      // 计数器是 3 字节，十六进制 6 位
      counters.forEach(function (c) { assert(/^[0-9a-f]{6}$/.test(c), '计数器占 6 个 hex 字符: ' + c); });

      /* ---- 解析：结构拆解 ---- */
      var known = describeBytes(
        [0x50, 0x7f, 0x1f, 0x77, 0xbc, 0xf8, 0x6c, 0xd7, 0x99, 0x43, 0x90, 0x11],
        '507f1f77bcf86cd799439011');
      assert.eq(known.hex, '507f1f77bcf86cd799439011', '字节拼回 hex');
      assert.eq(known.timestamp, 1350508407, '时间戳（秒）');
      assert.eq(known.timestampHex, '507f1f77', '时间戳的十六进制');
      assert.eq(known.dateUtc, '2012-10-17T21:13:27.000Z', 'UTC ISO 字符串');
      assert(known.dateLocal.length > 0, '本地时间字符串不为空: ' + known.dateLocal);
      assert.eq(known.randomHex, 'bcf86cd799', '随机值 5 字节 = 10 个 hex 字符');
      assert.eq(known.counterHex, '439011', '计数器 3 字节 = 6 个 hex 字符');
      assert.eq(known.counter, 4427793, '计数器的十进制');
      assert.eq(known.byteLength, 12, '字节总数');
      assert.eq(known.hexLength, 24, '十六进制长度');

      // 解析也要按无符号 32 位读时间戳：2038 年后的 ObjectId 不能解成负数
      var future = describeBytes([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 1], 'ffffffff0000000000000001');
      assert.eq(future.timestamp, 4294967295, '解析侧的时间戳也是无符号 32 位');
      assert.eq(future.dateUtc, '2106-02-07T06:28:15.000Z', '2106 年的时间戳解得出来');

      /* ---- 往返 ---- */
      var id = generateObjectId({ timestamp: 1700000000 });
      var decoded = decodeObjectId(id);
      assert(decoded.ok, '生成的结果能解');
      assert.eq(decoded.bytes.length, 12, '还是 12 字节');
      var back = describeBytes(decoded.bytes, id);
      assert.eq(back.hex, id, '往返：hex 对得上');
      assert.eq(back.timestamp, 1700000000, '往返：时间戳对得上');
      assert.eq(back.timestampHex, '6553f100', '往返：时间戳 hex 对得上');

      /* ---- 非法输入：报错而不是抛异常 ---- */
      var bad23 = decodeObjectId('507f1f77bcf86cd79943901');       // 23 位
      assert(!bad23.ok, '23 位被判非法');
      assert(typeof bad23.error === 'string' && bad23.error.length > 0, '23 位给出错误说明');
      var badChar = decodeObjectId('507f1f77bcf86cd79943901g');    // 带 g
      assert(!badChar.ok, '带 g 被判非法');
      assert(badChar.error.indexOf('g') >= 0, '错误信息里点名了非法字符: ' + badChar.error);
      assert(!decodeObjectId('').ok, '空串被判非法');
      assert(!decodeObjectId('zz').ok, '两个字符被判非法');

      var threw = false;
      try { parseObjectIds('507f1f77bcf86cd79943901\ng507f1f77bcf86cd799439011'); } catch (e) { threw = true; }
      assert(!threw, '多行里有非法行也不抛异常');

      /* ---- 多行解析 ---- */
      var multi = parseObjectIds('507f1f77bcf86cd799439011\n507f1f77bcf86cd799439012\n');
      assert.eq(multi.results.length, 2, '两行解析出两条');
      assert.eq(multi.errors.length, 0, '没有错误');
      assert.eq(multi.results[1].counter, 4427794, '两条的计数器差 1');
      var mixed = parseObjectIds('507f1f77bcf86cd799439011\nxxx');
      assert.eq(mixed.results.length, 1, '坏行不影响好行');
      assert.eq(mixed.errors.length, 1, '坏行被记成一条错误');
      assert.eq(mixed.errors[0].line, 2, '错误行号是 2');

      /* ---- 大小写与「12 字节」写法 ---- */
      var upper = decodeObjectId('507F1F77BCF86CD799439011');
      assert(upper.ok, '大写十六进制也收');
      assert.eq(describeBytes(upper.bytes, '').hex, '507f1f77bcf86cd799439011', '大写解出来的 hex 是小写');
      var byBytes = decodeObjectId('80 127 31 119 188 248 108 215 153 67 144 17');
      assert(byBytes.ok, '12 个字节值也能解');
      assert.eq(U.hex(byBytes.bytes), '507f1f77bcf86cd799439011', '字节值解出来的 hex 对得上');
      assert(!decodeObjectId('80 127 31 119 188 248 108 215 153 67 144 300').ok, '越界的字节值被判非法');
      assert(!decodeObjectId('80 127 31 119 188 248 108 215 153 67 144').ok, '只有 11 个字节值被判非法');

      /* ---- 渲染 ---- */
      var text = formatDescription(known);
      assert(text.indexOf('507f1f77bcf86cd799439011') >= 0, '渲染里有 id 本身');
      assert(text.indexOf('1350508407') >= 0, '渲染里有时间戳');
      assert(text.indexOf('bcf86cd799') >= 0, '渲染里有随机值');
      assert(text.indexOf('4427793') >= 0, '渲染里有计数器的十进制');
    }
  };
})();
