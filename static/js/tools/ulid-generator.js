/* ==========================================================================
   ULID 生成器（ulid-generator）

   批量生成 ULID（26 位 Crockford Base32）。ULID = 10 位时间戳（48 位毫秒）
   + 16 位随机数，所以按字典序排序即按时间排序。

   参考实现：src/tools/ulid-generator/（it-tools, GPLv3）

   ---- 与参考实现的差别 ----
   原版只有「数量」和「格式（Raw / JSON）」两个选项 —— 我逐条核对过
   ulid-generator.vue，它没有别的开关。这里在这两项之外补了需求点名的三项，
   都标成扩展：
     · Case              大小写
     · Timestamp prefix  每行前置毫秒时间戳（ISO 8601 或 Unix ms）
     · Split             把 10 位时间戳段与 16 位随机段之间用下划线断开
   「下划线分隔」这一项之所以长这样：ULID 本身不含连字符，没法像 UUID 那样
   换分隔符，能断开的只有时间戳段与随机段之间那一个位置。

   另一个坑记在这里：`ulid` 的 UMD 挂在 window.ULID 上的是**命名空间**，
   不是函数 —— 必须 ULID.ulid()，写成 ULID() 会报 not a function。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('ulid-generator');

  /** 原版 n-input-number 的 min/max 就是 1..100。 */
  var MIN_AMOUNT = 1;
  var MAX_AMOUNT = 100;

  /** 原版 formats，顺序保持一致。 */
  var FORMATS = [
    { label: t('format_raw', 'Raw'), value: 'raw' },
    { label: t('format_json', 'JSON'), value: 'json' }
  ];

  var CASES = [
    { label: t('case_as_generated', 'As generated'), value: 'keep' },
    { label: t('case_lowercase', 'Lowercase'), value: 'lower' },
    { label: t('case_uppercase', 'Uppercase'), value: 'upper' }
  ];

  var TIMESTAMPS = [
    { label: t('timestamp_off', 'Off'), value: 'none' },
    { label: t('timestamp_iso', 'ISO 8601 (UTC)'), value: 'iso' },
    { label: t('timestamp_unix_ms', 'Unix (ms)'), value: 'ms' }
  ];

  /** ULID 的时间戳段长度（字符），其余 16 位是随机段。 */
  var TIME_LEN = 10;
  var ULID_LEN = 26;
  var SPLIT_CHAR = '_';

  /** 数量夹到 [1, 100]。 */
  function clampAmount(amount) {
    var n = Math.floor(Number(amount));
    if (!isFinite(n)) return MIN_AMOUNT;
    return Math.max(MIN_AMOUNT, Math.min(MAX_AMOUNT, n));
  }

  /**
   * 生成 count 条 ULID。
   * opts.make 供单测注入（默认每次调 window.ULID.ulid()）。
   *
   * 注意**每次调 ulid() 之间没有单调性保证** —— 这个库的 ulid() 是无状态的，
   * 同一毫秒里连着调两次，后一条可能比前一条小。要同毫秒内严格递增得用
   * monotonicFactory()（实测过：连调 100 次里有几十次是逆序的）。
   * @returns {string[]}
   */
  function generateUlids(amount, opts) {
    opts = opts || {};
    var n = clampAmount(amount);
    var make = opts.make || function () { return window.ULID.ulid(); };
    var out = [];
    for (var i = 0; i < n; i++) out.push(String(make(i)));
    return out;
  }

  /**
   * 把一条 ULID 拆成时间戳段 / 随机段。
   * @returns {{time: string, random: string}}
   */
  function splitUlid(id) {
    var s = String(id);
    return { time: s.slice(0, TIME_LEN), random: s.slice(TIME_LEN) };
  }

  /**
   * 大小写与分段。
   * @param {string} raw
   * @param {{case?: string, split?: boolean}} opts
   */
  function formatUlid(raw, opts) {
    opts = opts || {};
    var s = String(raw);
    if (opts.split && s.length === ULID_LEN) {
      s = splitUlid(s).time + SPLIT_CHAR + splitUlid(s).random;
    }
    if (opts.case === 'lower') return s.toLowerCase();
    if (opts.case === 'upper') return s.toUpperCase();
    return s;
  }

  /**
   * 解出 ULID 里的毫秒时间戳。长度不对时库会抛 'malformed ulid'，这里吞成 null。
   * @returns {number|null}
   */
  function ulidTimestamp(id) {
    try {
      var ts = window.ULID.decodeTime(String(id));
      return typeof ts === 'number' && isFinite(ts) ? ts : null;
    } catch (e) {
      return null;
    }
  }

  /** 毫秒 → 显示文本。ms 未知时给一个占位符，不让整块输出挂掉。 */
  function formatTimestamp(ms, mode) {
    if (ms === null || ms === undefined) return 'unknown timestamp';
    if (mode === 'iso') {
      try { return new Date(ms).toISOString(); } catch (e) { return String(ms); }
    }
    return String(ms);
  }

  /**
   * 主入口：把一批 ULID 渲染成最终输出文本。
   *
   * JSON 格式下，时间戳前缀不是文本前缀而是多带一个 timestamp 字段 —— 往数组
   * 元素前面塞字符串会毁掉 JSON 的类型，所以开时间戳时数组元素变成对象。
   * 不开时间戳时元素仍是纯字符串，与原版的 `JSON.stringify(ids, null, 2)` 一致。
   *
   * @param {string[]} ids
   * @param {{format?: string, case?: string, split?: boolean, timestamp?: string}} [opts]
   * @returns {string}
   */
  function renderUlids(ids, opts) {
    opts = opts || {};
    var tsMode = opts.timestamp || 'none';
    var rows = ids.map(function (raw) {
      return { ulid: formatUlid(raw, opts), ms: ulidTimestamp(raw) };
    });

    if (opts.format === 'json') {
      if (tsMode === 'none') {
        return JSON.stringify(rows.map(function (r) { return r.ulid; }), null, 2);
      }
      return JSON.stringify(rows.map(function (r) {
        return { ulid: r.ulid, timestamp: formatTimestamp(r.ms, tsMode) };
      }), null, 2);
    }

    return rows.map(function (r) {
      return tsMode === 'none' ? r.ulid : formatTimestamp(r.ms, tsMode) + ' ' + r.ulid;
    }).join('\n');
  }

  /** 生成 + 渲染一步到位，UI 直接调它。 */
  function generateAndRender(amount, opts) {
    return renderUlids(generateUlids(amount, opts), opts);
  }

  window.ItTools.register('ulid-generator', function (root) {
    var amount = D.h('input.layui-input', { type: 'number', min: MIN_AMOUNT, max: MAX_AMOUNT, value: 1 });
    var formatSelect = D.h('select.layui-select', null, FORMATS.map(function (f, i) {
      return D.h('option', { value: f.value, text: f.label, selected: i === 0 });
    }));
    var caseSelect = D.h('select.layui-select', null, CASES.map(function (c, i) {
      return D.h('option', { value: c.value, text: c.label, selected: i === 0 });
    }));
    var timestampSelect = D.h('select.layui-select', null, TIMESTAMPS.map(function (ts, i) {
      return D.h('option', { value: ts.value, text: ts.label, selected: i === 0 });
    }));
    var splitBox = D.h('input', { type: 'checkbox' });

    var output = D.h('pre.mono-output', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } });
    var info = D.h('p.field-hint');

    // 标签列：75px、左对齐。原版 ulid-generator 的两行标签都是这个规格 ——
    // Quantity 是裸 <label w-75px>（默认左对齐），Format 是 c-buttons-select
    // 的 label-width="75px"（c-label 的 labelAlign 默认也是 left）。
    var LABEL_STYLE = { '--field-label-width': '75px', '--field-label-align': 'left' };
    // 但两者的**间距**不一样：裸 <label> 没有 pr-12px（那一行的
    // <div flex items-center> 里也没有 gap），标签与输入框是 0 间距；
    // c-buttons-select 的标签自带 pr-12px。
    var BARE_LABEL_STYLE = {
      '--field-label-width': '75px',
      '--field-label-align': 'left',
      '--field-label-pr': '0px'
    };

    function options() {
      return {
        format: formatSelect.value,
        case: caseSelect.value,
        timestamp: timestampSelect.value,
        split: splitBox.checked
      };
    }

    function refresh() {
      output.textContent = generateAndRender(amount.value, options());
      info.textContent = t('info', '{count} ULID(s) · 10-char ms timestamp + 16-char randomness.')
        .replace('{count}', clampAmount(amount.value));
    }

    // 监听统一走 D.on 收进 offs，destroy() 里一次性解绑
    var offs = [];
    [amount, formatSelect, caseSelect, timestampSelect].forEach(function (el) {
      offs.push(D.on(el, 'input', refresh));
      offs.push(D.on(el, 'change', refresh));
    });
    offs.push(D.on(splitBox, 'change', refresh));

    root.appendChild(D.h('div.card', null,
      // 原版 ulid-generator 的标签列也是**一列**，全是 75px 宽、左对齐：
      //   Quantity  裸 <label w-75px>
      //   Format    c-buttons-select 的 label-width="75px"
      D.h('div.field-row', { style: BARE_LABEL_STYLE }, D.h('label.field-label', { text: t('quantity', 'Quantity:') }), amount),
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('format', 'Format:') }), formatSelect),
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('case', 'Case:') }), caseSelect),
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('timestamp_prefix', 'Timestamp prefix:') }), timestampSelect),
      D.h('label.switch', null, splitBox, D.h('span', {
        text: t('split_timestamp_random', 'Split timestamp / random with "{char}"').replace('{char}', SPLIT_CHAR)
      }))
    ));

    var outCard = D.outputCard(t('ulids', 'ULIDs'));
    outCard.outputBody.style.whiteSpace = 'pre-wrap';
    outCard.outputBody.style.wordBreak = 'break-all';
    outCard.outputBody.appendChild(output);
    // 刷新按钮和提示塞进输出卡片内部 —— 直接挂到 root 上会被 flex 拆成独立面板
    outCard.appendChild(D.h('div.form-actions', null,
      D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('refresh', 'Refresh'), onclick: refresh })
    ));
    outCard.appendChild(info);
    root.appendChild(outCard);

    refresh();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['ulid-generator'] = {
    MIN_AMOUNT: MIN_AMOUNT,
    MAX_AMOUNT: MAX_AMOUNT,
    FORMATS: FORMATS,
    CASES: CASES,
    TIMESTAMPS: TIMESTAMPS,
    TIME_LEN: TIME_LEN,
    ULID_LEN: ULID_LEN,
    SPLIT_CHAR: SPLIT_CHAR,
    clampAmount: clampAmount,
    generateUlids: generateUlids,
    splitUlid: splitUlid,
    formatUlid: formatUlid,
    ulidTimestamp: ulidTimestamp,
    formatTimestamp: formatTimestamp,
    renderUlids: renderUlids,
    generateAndRender: generateAndRender,
    __cases: function (assert) {
      var ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

      /* ---- 数量夹取 ---- */
      assert.eq(clampAmount(1), 1, '下限');
      assert.eq(clampAmount(100), 100, '上限');
      assert.eq(clampAmount(0), 1, '0 抬到 1');
      assert.eq(clampAmount(-3), 1, '负数抬到 1');
      assert.eq(clampAmount(101), 100, '超量压到 100');
      assert.eq(clampAmount('12'), 12, '数字字符串也吃');
      assert.eq(clampAmount('nope'), 1, '非数字退到 1');

      /* ---- 真的调库：UMD 挂的是命名空间，所以是 ULID.ulid() 不是 ULID() ---- */
      var one = window.ULID.ulid();
      assert.eq(one.length, 26, 'ULID 26 字符');
      assert(ULID_RE.test(one), '符合 Crockford Base32: ' + one);
      assert(window.ULID.ulid() !== one, '两次生成不同');

      // 时间戳前缀：前 10 位是毫秒时间的 base32 编码
      var now = Date.now();
      var back = window.ULID.decodeTime(window.ULID.ulid(now));
      assert.eq(back, now, '指定 seedTime 后时间戳能原样解回来');

      /* ---- 批量生成（注入 make，结果可复现） ---- */
      var fixed = ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAX'];
      var seq = function () { return fixed[0]; };   // make() 永远给同一条
      assert.eq(generateUlids(3, { make: seq }), [fixed[0], fixed[0], fixed[0]], '注入固定源时逐条取 make 的返回值');
      var walk = function (i) { return fixed[i]; };
      assert.eq(generateUlids(3, { make: walk }), fixed, 'make 收到下标，可以按序给出不同的值');
      assert.eq(generateUlids(3, { make: walk })[1], fixed[1], '注入固定源时内容对');
      assert.eq(generateUlids(0, { make: seq }).length, 1, '数量 0 按 1 算');
      assert.eq(generateUlids(1000, { make: seq }).length, 100, '超量按 100 算');
      // 不注入时走真库：100 条互不相同且都合法
      var live = generateUlids(100);
      assert.eq(live.length, 100, '真库生成 100 条');
      assert.eq(new Set(live).size, 100, '100 条互不相同');
      assert(live.every(function (u) { return ULID_RE.test(u); }), '100 条全部合法');
      // ulid() 本身**不保证**单调，同毫秒里可能逆序，所以这里不断言递增。
      // 要严格递增得用库里的 monotonicFactory()，那才是它的单调保证。
      var mono = window.ULID.monotonicFactory();
      var seqIds = [];
      var i;
      for (i = 0; i < 100; i++) seqIds.push(mono());
      assert.eq(new Set(seqIds).size, 100, 'monotonicFactory 连调 100 次不重复');
      for (i = 1; i < seqIds.length; i++) {
        assert(seqIds[i - 1] < seqIds[i], 'monotonicFactory 第 ' + i + ' 条严格递增');
      }

      /* ---- 分段 ---- */
      assert.eq(splitUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV'), { time: '01ARZ3NDEK', random: 'TSV4RRFFQ69G5FAV' }, '按 10 位切开');
      assert.eq(splitUlid('abc'), { time: 'abc', random: '' }, '短输入不炸');
      assert.eq(splitUlid(''), { time: '', random: '' }, '空串不炸');

      /* ---- 大小写与分段格式化 ---- */
      var raw = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      assert.eq(formatUlid(raw, {}), raw, '不传选项就是原样');
      assert.eq(formatUlid(raw, { case: 'keep' }), raw, 'keep 就是原样');
      assert.eq(formatUlid(raw, { case: 'lower' }), '01arz3ndektsv4rrffq69g5fav', '小写');
      assert.eq(formatUlid(raw, { case: 'upper' }), raw, '大写（原库本来就输出大写）');
      assert.eq(formatUlid(raw, { split: true }), '01ARZ3NDEK_TSV4RRFFQ69G5FAV', '下划线分段');
      assert.eq(formatUlid(raw, { split: true, case: 'lower' }), '01arz3ndek_tsv4rrffq69g5fav', '分段 + 小写');
      // 长度不是 26 就不断，否则会把随机段啃掉
      assert.eq(formatUlid('abc', { split: true }), 'abc', '长度不对不切');

      /* ---- 时间戳 ---- */
      assert.eq(ulidTimestamp('01ARZ3NDEKTSV4RRFFQ69G5FAV'), 1469922850259, '解出毫秒');
      assert.eq(ulidTimestamp('abc'), null, '长度不对返回 null 而不是抛');
      assert.eq(ulidTimestamp(''), null, '空串返回 null');
      assert(ulidTimestamp(window.ULID.ulid()) > 0, '新生成的能解出时间戳');
      assert.eq(formatTimestamp(0, 'iso'), '1970-01-01T00:00:00.000Z', 'ISO 到毫秒');
      assert.eq(formatTimestamp(1469922850259, 'ms'), '1469922850259', 'Unix 毫秒');
      assert.eq(formatTimestamp(null, 'iso'), 'unknown timestamp', '未知时间戳有占位符');
      assert.eq(formatTimestamp(null, 'none'), 'unknown timestamp', '未知时间戳与模式无关');

      /* ---- 渲染 ---- */
      var ids = ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW'];
      assert.eq(renderUlids(ids, {}), ids.join('\n'), 'Raw 默认就是换行拼接');
      assert.eq(renderUlids(ids, { format: 'json' }), JSON.stringify(ids, null, 2), 'JSON 与原版一致');
      assert.eq(renderUlids(ids, { case: 'lower' }).split('\n')[0], '01arz3ndektsv4rrffq69g5fav', 'Raw + 小写');
      assert.eq(renderUlids(ids, { split: true }).split('\n')[1], '01ARZ3NDEK_TSV4RRFFQ69G5FAW', 'Raw + 分段');

      // 时间戳前缀：Raw 是行前缀
      var iso = renderUlids(ids, { timestamp: 'iso' });
      assert.eq(iso.split('\n')[0], '2016-07-30T23:54:10.259Z 01ARZ3NDEKTSV4RRFFQ69G5FAV', 'Raw + ISO 前缀');
      var ms = renderUlids(ids, { timestamp: 'ms' });
      assert.eq(ms.split('\n')[1], '1469922850259 01ARZ3NDEKTSV4RRFFQ69G5FAW', 'Raw + Unix ms 前缀');

      // 时间戳前缀：JSON 里不能是文本前缀，改成多一个 timestamp 字段
      var json = JSON.parse(renderUlids(ids, { format: 'json', timestamp: 'iso' }));
      assert.eq(json.length, 2, 'JSON 仍是两条');
      assert.eq(json[0].ulid, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'JSON 的 ulid 字段');
      assert.eq(json[0].timestamp, '2016-07-30T23:54:10.259Z', 'JSON 的 timestamp 字段');
      assert.eq(JSON.parse(renderUlids(ids, { format: 'json' })), ids, '不开时间戳时 JSON 元素仍是纯字符串');

      /* ---- 边界与错误输入 ---- */
      assert.eq(renderUlids([], {}), '', '空列表得到空串');
      assert.eq(renderUlids([], { format: 'json' }), '[]', '空列表的 JSON 是 []');
      assert.eq(renderUlids(['abc'], { timestamp: 'iso' }), 'unknown timestamp abc', '解不出时间戳时不崩，只给占位符');
      assert.eq(renderUlids(['abc'], { format: 'json', timestamp: 'ms' })[0] !== undefined, true, '解不出时间戳时 JSON 仍可解析');
      assert.eq(formatUlid(null, {}), 'null', 'null 走 String() 不炸');

      /* ---- 一条龙 ---- */
      var text = generateAndRender(2, { format: 'raw', case: 'upper', split: true });
      var lines = text.split('\n');
      assert.eq(lines.length, 2, '一次生成并渲染出 2 行');
      lines.forEach(function (l, i) {
        assert(/^[0-9A-Z]{10}_[0-9A-Z]{16}$/.test(l), '第 ' + i + ' 行是分段大写格式: ' + l);
        assert.eq(ulidTimestamp(l.replace(SPLIT_CHAR, '')) !== null, true, '第 ' + i + ' 行去掉分隔符后仍能解出时间戳');
      });
    }
  };
})();