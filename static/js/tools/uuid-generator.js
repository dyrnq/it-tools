/* ==========================================================================
   UUID 生成器（uuid-generator）

   批量生成 UUID，可选版本 NIL / v1 / v3 / v4 / v5 / v6 / v7。v3、v5 需要一个
   namespace（命名空间 UUID）和一个 name，v3 是 MD5、v5 是 SHA-1。

   参考实现：src/tools/uuid-generator/（it-tools, GPLv3）

   ---- 与参考实现的差别 ----
   1. 原版只有「版本 + 数量 + namespace + name」四个选项。这里在原版基础上补了
      大小写和分隔符两项 —— 需求里点名要有。注意这**不是**用 change-case 那套
      做的：change-case 是 case-converter 用的库，uuid-generator 根本没引它，
      这里就是原生 toUpperCase()/toLowerCase()/字符串替换。
   2. 原版的 v1 用 Math.random() 造 nsecs 和 node —— 不是密码学安全的随机源，
      撞号概率比 crypto 高。这里一次向 crypto 取 nsecs 和 6 字节 node。
   3. 原版把「数量」交给 n-input-number，值可以是任意数字（没有真正夹住
      1..50，只是那组件自己带 min/max）。这里在纯逻辑里硬夹到 [1, 50]，
      单测也就锁得住这个边界。
   4. 补了 v6 / v7（上游 #1654）。vendored 的 uuid 是 9.0.0，压根没有这两个
      版本（uuid 10 才加 v7、11 才加 v6），所以这里是手写的字节布局，
      测试向量对着 uuid@11 的 `v6()` / `v7()` 校过（v6 是 20k 组随机输入
      逐字节相等，见 __cases）。
   5. 输出框的行数跟着「数量」走（上游 #1064）—— 固定 8 行，生成 1 条时下面
      空一大片，生成 50 条时又得滚动。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('uuid-generator');

  /** 可选版本。v6 / v7 是后加的（上游 #1654），排在原版五个之后。 */
  var VERSIONS = ['NIL', 'v1', 'v3', 'v4', 'v5', 'v6', 'v7'];

  /**
   * 版本号的显示名（取值不变，只是可翻译）。
   * 键必须是字面量，语言包要逐条对账，所以这里老老实实一个个写出来，
   * 而不是 `t('version_' + v)` 那种拼出来的键。
   */
  var VERSION_LABELS = {
    NIL: function () { return t('version_nil', 'NIL'); },
    v1: function () { return t('version_v1', 'v1'); },
    v3: function () { return t('version_v3', 'v3'); },
    v4: function () { return t('version_v4', 'v4'); },
    v5: function () { return t('version_v5', 'v5'); },
    v6: function () { return t('version_v6', 'v6'); },
    v7: function () { return t('version_v7', 'v7'); }
  };

  /** 版本号 → 显示名；名单外的版本原样返回。 */
  function versionLabel(v) {
    return VERSION_LABELS[v] ? VERSION_LABELS[v]() : v;
  }

  /**
   * RFC 4122 预定义的四个命名空间。
   * 原版 v35Args 的初值是 URL 那一个，这里保持一致。
   */
  var NAMESPACES = {
    DNS: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    URL: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
    OID: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
    X500: '6ba7b814-9dad-11d1-80b4-00c04fd430c8'
  };
  var DEFAULT_NAMESPACE = NAMESPACES.URL;

  var CASES = [
    { label: t('case_lower', 'Lowercase'), value: 'lower' },
    { label: t('case_upper', 'Uppercase'), value: 'upper' }
  ];

  /**
   * 分隔符。'hyphen' 是 UUID 的标准写法，也就是原样，所以它等价于恒等变换；
   * 'compact' 去掉连字符，给那些把 UUID 存成 32 位十六进制的库用。
   */
  var SEPARATORS = [
    { label: t('sep_hyphens', 'Hyphens (standard)'), value: 'hyphen' },
    { label: t('sep_none', 'None (32 hex chars)'), value: 'compact' },
    { label: t('sep_braces', 'Braces { }'), value: 'braces' },
    { label: t('sep_urn', 'urn:uuid:'), value: 'urn' }
  ];

  var MIN_AMOUNT = 1;
  var MAX_AMOUNT = 50;

  /**
   * namespace 是否是合法的 RFC 4122 UUID。
   * 直接用原版 validUuidRules 里那条正则：版本位限定 1-5、variant 位限定
   * 8/9/a/b。注意 NIL（00000000-0000-0000-0000-000000000000）过不了这条
   * —— 原版也正因如此才在生成器那边单独特判了 nilUuid。
   * @param {string} value
   */
  function isValidNamespace(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(String(value == null ? '' : value).trim());
  }

  /** 六个随机字节，供 v1 / v6 当 node 标识。默认走 crypto。 */
  function randomNodeBytes() {
    return U.randomBytes(6);
  }

  /** v1 / v6 的时间单位是「1582-10-15 起的 100 纳秒数」，纪元比 Unix 早得多。 */
  var GREGORIAN_OFFSET_MS = 12219292800000;

  /** 16 个字节 -> 标准写法的 UUID 字符串（uuid 库那套 string 化的逆过程）。 */
  function stringifyBytes(bytes) {
    var h = U.hex(bytes);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
      h.slice(16, 20) + '-' + h.slice(20);
  }

  /**
   * v6 的 16 个字节（RFC 9562 §5.6）。
   *
   * v6 说到底就是 v1 把 60 位时间戳**按高位在前**重排了一遍：v1 把时间戳拆成
   * time_low(32) / time_mid(16) / time_hi(12) 分三段存，低位在前，于是同一秒
   * 内相邻的两个 v1 在字节序上看着毫不相干；v6 改成整体 60 位大端，只在第 7 个
   * 字节（0 起数）的高半字节塞版本位。clock_seq(14) 与 node(48) 原地不动 ——
   * 所以同一台机器上 v6 和 v1 的标识是等价的，可以互相替换。
   *
   * 60 位在 JS 的双精度里放不下（超过 2^53 就开始丢精度，而当前时间戳约 2^57），
   * 所以这里从不直接算那个整数，而是拆成 (hi 28 位, lo 32 位) 两段分别算，
   * 每段都稳稳小于 2^53。
   *
   * @param {number} ms Unix 毫秒
   * @param {number} nsecs 毫秒内的 100 纳秒增量，[0, 10000)
   * @param {number} clockseq 14 位时钟序列号
   * @param {ArrayLike<number>} node 6 字节节点标识
   * @returns {number[]} 16 个字节
   */
  function v6Bytes(ms, nsecs, clockseq, node) {
    var shifted = ms + GREGORIAN_OFFSET_MS;            // 1582 纪元的毫秒，< 2^53
    var highMs = Math.floor(shifted / 0x100000000);    // 高 32 位
    var lowMs = shifted - highMs * 0x100000000;       // 低 32 位，整数，精确

    var hi = highMs * 10000;                           // 毫秒 -> 100 纳秒单位，28 位以内
    var lo = lowMs * 10000 + (nsecs || 0);             // 46 位以内，仍然精确
    var carry = Math.floor(lo / 0x100000000);
    hi += carry;
    lo -= carry * 0x100000000;

    return [
      (hi >>> 20) & 0xff, (hi >>> 12) & 0xff, (hi >>> 4) & 0xff, ((hi & 0x0f) << 4) | ((lo >>> 28) & 0x0f),
      (lo >>> 20) & 0xff, (lo >>> 12) & 0xff, 0x60 | ((lo >>> 8) & 0x0f), lo & 0xff,
      0x80 | ((clockseq >>> 8) & 0x3f), clockseq & 0xff,
      node[0] & 0xff, node[1] & 0xff, node[2] & 0xff, node[3] & 0xff, node[4] & 0xff, node[5] & 0xff
    ];
  }

  /**
   * v7 的 16 个字节（RFC 9562 §5.7）：48 位 Unix 毫秒 | ver=7 | 12 位 rand_a |
   * var=0b10 | 62 位 rand_b。
   *
   * 时间戳摆在最前面正是 v7 存在的理由：按字节字典序比就等于按时间先后比，
   * 拿去做数据库主键不会像 v4（完全随机）那样到处插页。
   *
   * rand_a 默认也取随机数 —— 那么**同一毫秒内**的几条 v7 之间是没有顺序的，
   * 只有跨毫秒才严格有序。想在同毫秒内也有序就把 seq 传进来（见 UI 上的
   * Monotonic 开关，RFC 9562 §6.2 明确推荐这么做）。
   *
   * @param {number} ms Unix 毫秒
   * @param {Uint8Array} rnd 至少 16 字节的随机源，只用到 [6..15]
   * @param {number} [seq] rand_a；不给就是随机
   * @returns {number[]} 16 个字节
   */
  function v7Bytes(ms, rnd, seq) {
    var randA = seq == null ? (((rnd[6] << 4) | (rnd[7] >> 4)) & 0xfff) : (seq & 0xfff);
    return [
      Math.floor(ms / 0x10000000000) & 0xff,
      Math.floor(ms / 0x100000000) & 0xff,
      (ms >>> 24) & 0xff, (ms >>> 16) & 0xff, (ms >>> 8) & 0xff, ms & 0xff,
      0x70 | ((randA >>> 8) & 0x0f), randA & 0xff,
      0x80 | (rnd[8] & 0x3f),
      rnd[9], rnd[10], rnd[11], rnd[12], rnd[13], rnd[14], rnd[15]
    ];
  }

  /**
   * 生成一条 UUID（未做大小写/分隔符处理，始终是小写标准写法）。
   *
   * @param {string} version NIL | v1 | v3 | v4 | v5 | v6 | v7
   * @param {Object} [opts]
   *   name      {string} v3/v5 的输入名
   *   namespace {string} v3/v5 的命名空间
   *   index     {number} v1/v6 的 clockseq，也让批量生成不至于在同一毫秒里撞号
   *   monotonic {boolean} v7 是否用递增的 rand_a（同一毫秒内也保证有序）
   *   seq       {number} v7 的 rand_a，直接指定（单测注入用）
   *   nsecs     {number} v6 的 100 纳秒增量，不给就从 node 派生（同 v1）
   *   now       {() => number}  取当前毫秒，单测注入用
   *   randomBytes {() => Uint8Array} 取随机字节，单测注入用；v1/v6 要 6 个，v7 要 16 个
   * @returns {string}
   */
  function generateOne(version, opts) {
    opts = opts || {};
    var lib = window.uuid;

    if (version === 'v4') return lib.v4();

    if (version === 'v1') {
      // node 必须正好 6 个字节。传短了 uuid 库不会报错，而是把越界的部分
      // 直接拼成 "undefinedundefinedundefined"（实测过），所以这里固定取 6 个。
      var node = opts.randomBytes ? opts.randomBytes() : randomNodeBytes();
      var nsecs = U.bytesToNumber(node) % 10000;
      return lib.v1({
        clockseq: (opts.index || 0) % 16384,   // clockseq 是 14 位
        msecs: opts.now ? opts.now() : Date.now(),
        nsecs: nsecs,
        node: Array.prototype.slice.call(node)
      });
    }

    // v6 和 v1 共用同一套输入（时间 / clockseq / node），只是排布方式不同 ——
    // 所以抽出来给两边共用，省得两处各算一遍 100 纳秒时间戳。
    if (version === 'v6' || version === 'v7') {
      var ms = opts.now ? opts.now() : Date.now();

      if (version === 'v6') {
        var v6node = opts.randomBytes ? opts.randomBytes() : randomNodeBytes();
        // nsecs 默认从 node 派生（跟 v1 一样），也可以直接指定 —— 单测要靠它
        // 钉死时间戳的最后 12 位。
        var v6nsecs = opts.nsecs != null ? opts.nsecs : (U.bytesToNumber(v6node) % 10000);
        return stringifyBytes(v6Bytes(ms, v6nsecs, (opts.index || 0) % 16384, v6node));
      }

      var rnd = opts.randomBytes ? opts.randomBytes() : U.randomBytes(16);
      // seq 不给就是随机 rand_a；给了就用它（批量 + Monotonic 时由下标驱动）
      var seq = opts.seq != null ? opts.seq : (opts.monotonic ? (opts.index || 0) : null);
      return stringifyBytes(v7Bytes(ms, rnd, seq));
    }

    if (version === 'v3' || version === 'v5') {
      var ns = String(opts.namespace == null ? DEFAULT_NAMESPACE : opts.namespace).trim();
      if (!isValidNamespace(ns)) {
        throw new Error(t('err_invalid_namespace_value', 'Invalid namespace: {ns}')
          .replace('{ns}', function () { return ns || '(empty)'; }));
      }
      var name = String(opts.name == null ? '' : opts.name);
      return version === 'v3' ? lib.v3(name, ns) : lib.v5(name, ns);
    }

    // NIL 以及任何不认识的版本都落到全零 UUID，与原版 `?? generators.NIL` 一致
    return lib.NIL;
  }

  /**
   * 批量生成，返回未格式化的原始小写 UUID 列表。
   * @returns {string[]}
   */
  function generateUuids(version, opts) {
    opts = opts || {};
    var amount = clampAmount(opts.amount);
    var out = [];
    for (var i = 0; i < amount; i++) {
      // seq 只在 Monotonic 打开时才给 i —— 给了就等于强制 v7 用递增 rand_a。
      // 不给（null）时 generateOne 会退回从随机源取 rand_a，也就是 v7 的默认行为。
      out.push(generateOne(version, { index: i, seq: opts.monotonic ? i : null,
        name: opts.name, namespace: opts.namespace, now: opts.now, randomBytes: opts.randomBytes }));
    }
    return out;
  }

  /** 数量夹到 [1, 50]。NaN / 空 / 负数 / 超量都归到这个区间里。 */
  function clampAmount(amount) {
    var n = Math.floor(Number(amount));
    if (!isFinite(n)) return MIN_AMOUNT;
    return Math.max(MIN_AMOUNT, Math.min(MAX_AMOUNT, n));
  }

  /**
   * 给一条标准写法的小写 UUID 套上大小写与分隔符。
   * @param {string} raw 形如 6ba7b810-9dad-11d1-80b4-00c04fd430c8
   * @param {{case?: string, separator?: string}} [opts]
   */
  function formatUuid(raw, opts) {
    opts = opts || {};
    var base = String(raw);
    if (opts.case === 'upper') base = base.toUpperCase();

    switch (opts.separator) {
      case 'compact': return base.replace(/-/g, '');
      case 'braces': return '{' + base + '}';
      case 'urn': return 'urn:uuid:' + base;
      case 'hyphen':
      default: return base;
    }
  }

  /**
   * 主入口：一次给出版本、数量、大小写、分隔符都定好的多行文本。
   * @returns {string} 换行分隔
   */
  function buildUuids(version, opts) {
    return generateUuids(version, opts)
      .map(function (raw) { return formatUuid(raw, opts); })
      .join('\n');
  }

  window.ItTools.register('uuid-generator', function (root) {
    var versionSelect = D.h('select.layui-select', null, VERSIONS.map(function (v, i) {
      return D.h('option', { value: v, text: versionLabel(v), selected: v === 'v4' });
    }));
    var amount = D.h('input.layui-input', { type: 'number', min: MIN_AMOUNT, max: MAX_AMOUNT, value: 1 });
    var caseSelect = D.h('select.layui-select', null, CASES.map(function (c, i) {
      return D.h('option', { value: c.value, text: c.label, selected: i === 0 });
    }));
    var separatorSelect = D.h('select.layui-select', null, SEPARATORS.map(function (s, i) {
      return D.h('option', { value: s.value, text: s.label, selected: i === 0 });
    }));

    var namespaceSelect = D.h('select.layui-select', null, Object.keys(NAMESPACES).map(function (k) {
      return D.h('option', { value: k, text: k, selected: k === 'URL' });
    }));
    var namespaceInput = D.h('input.layui-input', {
      value: DEFAULT_NAMESPACE, spellcheck: 'false', placeholder: t('ph_namespace_uuid', 'Namespace UUID')
    });
    var nameInput = D.h('input.layui-input', { placeholder: t('ph_name', 'Name (hashed with the namespace)') });

    // 原版生成的 UUID 是居中的等宽字（c-input-text + monospace）
    var output = D.h('textarea.layui-textarea.mono', { rows: 8, readonly: 'readonly', spellcheck: 'false' });
    var error = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });
    var hint = D.h('p.field-hint');
    var v35Block = D.h('div', null,
      // 原版这三个字段是 label-position="left"、label-width="100px"；
      // 对齐是 **左** —— c-label 的 labelAlign 默认值就是 left，不是 right
      U.field(t('namespace', 'Namespace:'), namespaceSelect, { left: true, labelWidth: '100px', labelAlign: 'left' }),
      U.field(t('namespace_uuid', 'Namespace UUID:'), namespaceInput, { left: true, labelWidth: '100px', labelAlign: 'left' }),
      U.field(t('name', 'Name:'), nameInput, { left: true, labelWidth: '100px', labelAlign: 'left' })
    );

    // 原版 uuid-generator 的标签列是**一列**：UUID version（c-buttons-select，
    // label-width="100px"）、Quantity（一个 w-100px 的 span）、Namespace 与 Name
    // （c-input-text，label-width="100px" + label-position="left"）——
    // 全都是 100px 宽、左对齐（c-label 的默认对齐就是 left）。
    // 我们这几行共用同一个标签列，免得左边一列 120px 右对齐、右边一列 100px 左对齐。
    var LABEL_STYLE = { '--field-label-width': '100px', '--field-label-align': 'left' };
    // 但 Quantity 那一行例外：原版是个裸 <span w-100px>Quantity </span>，
    // 所在的 <div mb-2 flex items-center> 里没有 gap，span 也没有 pr-12px
    // —— 标签和输入框是 0 间距。其余几行的标签都自带 pr-12px。
    var BARE_LABEL_STYLE = {
      '--field-label-width': '100px',
      '--field-label-align': 'left',
      '--field-label-pr': '0px'
    };

    // 只有 v7 用得上：默认 rand_a 是随机的，同一毫秒内生成的批次之间没顺序；
    // 打开之后 rand_a 改用递增计数器，整批（含同一毫秒内的）严格有序。
    var monotonicInput = D.h('input', { type: 'checkbox' });
    var monotonicRow = D.h('label.switch', null, monotonicInput,
      D.h('span', { text: t('monotonic', 'Monotonic (sortable within the same millisecond)') }));

    function needsNamespace() {
      var v = versionSelect.value;
      return v === 'v3' || v === 'v5';
    }

    function refresh() {
      var useNs = needsNamespace();
      v35Block.hidden = !useNs;
      monotonicRow.hidden = versionSelect.value !== 'v7';

      var nsValue = useNs ? namespaceInput.value.trim() : '';
      var ok = !useNs || isValidNamespace(nsValue);
      error.textContent = ok ? '' : t('err_invalid_namespace', 'Invalid namespace: expected an RFC 4122 UUID (8-4-4-4-12 hex)');
      namespaceInput.style.borderColor = useNs && !ok ? 'var(--danger, #d93025)' : '';

      if (!ok) { output.value = ''; hint.textContent = ''; return; }

      try {
        output.value = buildUuids(versionSelect.value, {
          amount: amount.value,
          namespace: nsValue,
          name: nameInput.value,
          case: caseSelect.value,
          separator: separatorSelect.value,
          monotonic: monotonicInput.checked
        });
        // 行数跟着条数走（上游 #1064）：生成 1 条时留一大片空白、生成 50 条要滚动，
        // 固定 8 行两头不讨好
        output.rows = Math.min(20, Math.max(3, clampAmount(amount.value)));
        var count = clampAmount(amount.value);
        hint.textContent = (count === 1
          ? t('generated_one', '{count} UUID generated.')
          : t('generated_many', '{count} UUIDs generated.'))
          .replace('{count}', function () { return String(count); });
      } catch (e) {
        output.value = '';
        error.textContent = t('err_generation_failed', 'Generation failed: {msg}')
          .replace('{msg}', function () { return e.message; });
        hint.textContent = '';
      }
    }

    // 预设选中的同时把值填进输入框，用户可以直接改（原版是同一个 v-model）
    function syncNamespace() {
      namespaceInput.value = NAMESPACES[namespaceSelect.value] || DEFAULT_NAMESPACE;
      refresh();
    }

    // 监听统一走 D.on 收进 offs，destroy() 里一次性解绑
    var offs = [];
    [versionSelect, amount, caseSelect, separatorSelect, namespaceInput, nameInput].forEach(function (el) {
      offs.push(D.on(el, 'input', refresh));
      offs.push(D.on(el, 'change', refresh));
    });
    offs.push(D.on(namespaceSelect, 'change', syncNamespace));
    offs.push(D.on(monotonicInput, 'change', refresh));

    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('uuid_version', 'UUID version:') }), versionSelect),
      D.h('div.field-row', { style: BARE_LABEL_STYLE }, D.h('label.field-label', { text: t('quantity', 'Quantity:') }), amount),
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('case', 'Case:') }), caseSelect),
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('separator', 'Separator:') }), separatorSelect),
      monotonicRow,
      v35Block,
      error,
      D.h('label.field-label', { text: t('uuids', 'UUIDs') }),
      output,
      hint,
      D.h('div.form-actions', null,
        U.copyButton(function () { return output.value; }, t('copy', 'Copy')),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('refresh', 'Refresh'), onclick: refresh
        }),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download', 'Download'), onclick: function () {
            if (output.value) window.ItTools.download('uuid.txt', output.value, 'text/plain;charset=utf-8');
          }
        })
      )
    ));

    refresh();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['uuid-generator'] = {
    VERSIONS: VERSIONS,
    NAMESPACES: NAMESPACES,
    DEFAULT_NAMESPACE: DEFAULT_NAMESPACE,
    CASES: CASES,
    SEPARATORS: SEPARATORS,
    MIN_AMOUNT: MIN_AMOUNT,
    MAX_AMOUNT: MAX_AMOUNT,
    isValidNamespace: isValidNamespace,
    GREGORIAN_OFFSET_MS: GREGORIAN_OFFSET_MS,
    stringifyBytes: stringifyBytes,
    v6Bytes: v6Bytes,
    v7Bytes: v7Bytes,
    generateOne: generateOne,
    generateUuids: generateUuids,
    clampAmount: clampAmount,
    formatUuid: formatUuid,
    buildUuids: buildUuids,
    __cases: function (assert) {
      var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

      /* ---- namespace 校验（与原版 validUuidRules 同一条正则） ---- */
      Object.keys(NAMESPACES).forEach(function (k) {
        assert(isValidNamespace(NAMESPACES[k]), '预定义 namespace 合法：' + k);
      });
      assert(isValidNamespace('  ' + NAMESPACES.DNS + '  '), '前后空白先 trim 再校验');
      assert(!isValidNamespace(''), '空 namespace 非法');
      assert(!isValidNamespace(null), 'null 非法');
      assert(!isValidNamespace('6ba7b810-9dad-11d1-80b4-00c04fd430cg'), '末位非十六进制非法');
      assert(!isValidNamespace('6ba7b8109dad11d180b400c04fd430c8'), '没连字符非法');
      // NIL 的版本位是 0，过不了 [1-5]：原版正因如此才在生成器那边特判
      assert(!isValidNamespace('00000000-0000-0000-0000-000000000000'), 'NIL 走的是另一条判断，不算合法 namespace');

      /* ---- 数量夹取 ---- */
      assert.eq(clampAmount(1), 1, '下限');
      assert.eq(clampAmount(50), 50, '上限');
      assert.eq(clampAmount(0), 1, '0 抬到 1');
      assert.eq(clampAmount(-5), 1, '负数抬到 1');
      assert.eq(clampAmount(999), 50, '超量压到 50');
      assert.eq(clampAmount(3.9), 3, '小数向下取整');
      assert.eq(clampAmount('7'), 7, '数字字符串也吃');
      assert.eq(clampAmount('abc'), 1, '非数字退到 1');
      assert.eq(clampAmount(''), 1, '空串退到 1');

      /* ---- NIL / v4 ---- */
      assert.eq(generateOne('NIL'), '00000000-0000-0000-0000-000000000000', 'NIL 是全零');
      assert(UUID_RE.test(generateOne('v4')), 'v4 符合 UUID 正则');
      assert(generateOne('v4') !== generateOne('v4'), '两次 v4 不同');
      assert(generateOne('v4')[14] === '4', 'v4 的版本位是 4');
      // 原版 `generators[version.value] ?? generators.NIL` 认不出的版本也落到 NIL
      assert.eq(generateOne('v2'), '00000000-0000-0000-0000-000000000000', '未知版本回落到 NIL');

      /* ---- v1：注入固定的时钟与随机源，结果可复现 ---- */
      var fixed = { now: function () { return 1465838170105; }, randomBytes: function () { return new Uint8Array([0, 1, 2, 3, 4, 5]); } };
      var u1 = generateOne('v1', fixed);
      assert(UUID_RE.test(u1), 'v1 符合 UUID 正则');
      assert(u1[14] === '1', 'v1 的版本位是 1');
      assert(u1.indexOf('000102030405') > 0, 'node 用了注入的 6 字节: ' + u1);
      assert(u1 === generateOne('v1', fixed), '同样输入同样输出（时钟与随机源都注入时）');
      assert(generateOne('v1', { now: fixed.now, randomBytes: fixed.randomBytes, index: 3 }).indexOf('-8') > 0,
        'index 进 clockseq: ' + generateOne('v1', { now: fixed.now, randomBytes: fixed.randomBytes, index: 3 }));

      /* ---- v3 / v5：标准测试向量（RFC 4122 附录里的 DNS 命名空间） ---- */
      assert.eq(generateOne('v3', { name: 'www.google.com', namespace: NAMESPACES.DNS }),
        'de87628d-5377-3ba7-b31b-cde1cc8d423f', 'v3 DNS 命名空间');
      assert.eq(generateOne('v5', { name: 'www.google.com', namespace: NAMESPACES.DNS }),
        '488416f4-fcaf-5027-8c63-0105cfa213ea', 'v5 DNS 命名空间');
      assert(generateOne('v3', { name: 'a', namespace: NAMESPACES.URL })[14] === '3', 'v3 版本位');
      assert(generateOne('v5', { name: 'a', namespace: NAMESPACES.URL })[14] === '5', 'v5 版本位');
      // 同一个 name + namespace 必须给同一个 UUID —— 这正是 v3/v5 的定义
      assert(generateOne('v5', { name: 'x', namespace: NAMESPACES.OID }) ===
        generateOne('v5', { name: 'x', namespace: NAMESPACES.OID }), 'v5 是确定性的');
      assert(generateOne('v5', { name: 'x', namespace: NAMESPACES.OID }) !==
        generateOne('v5', { name: 'y', namespace: NAMESPACES.OID }), '换 name 结果就变');
      assert(generateOne('v5', { name: 'x', namespace: NAMESPACES.OID }) !==
        generateOne('v5', { name: 'x', namespace: NAMESPACES.X500 }), '换 namespace 结果就变');
      // 空 name 也是合法的（v5 对空串照样有定义）
      assert(UUID_RE.test(generateOne('v5', { name: '', namespace: NAMESPACES.URL })), '空 name 也出 UUID');

      /* ---- v3 / v5 的错误输入 ---- */
      ['not-a-uuid', '', '6ba7b810-9dad-11d1-80b4-00c04fd430cg', '00000000-0000-0000-0000-000000000000']
        .forEach(function (bad) {
          var threw = false;
          try { generateOne('v3', { name: 'a', namespace: bad }); } catch (e) { threw = true; }
          assert(threw, '非法 namespace 应抛错: ' + JSON.stringify(bad));
        });

      /* ---- 大小写与分隔符（扩展项，用原生 replace，不用 change-case） ---- */
      var raw = 'de87628d-5377-3ba7-b31b-cde1cc8d423f';
      assert.eq(formatUuid(raw, {}), raw, '不传选项就是原样');
      assert.eq(formatUuid(raw, { case: 'upper' }), 'DE87628D-5377-3BA7-B31B-CDE1CC8D423F', '大写');
      assert.eq(formatUuid(raw, { case: 'lower' }), raw, '小写（也是默认）');
      assert.eq(formatUuid(raw, { separator: 'hyphen' }), raw, '连字符是恒等变换');
      assert.eq(formatUuid(raw, { separator: 'compact' }), 'de87628d53773ba7b31bcde1cc8d423f', '去掉连字符');
      assert.eq(formatUuid(raw, { separator: 'braces' }), '{' + raw + '}', '花括号');
      assert.eq(formatUuid(raw, { separator: 'urn' }), 'urn:uuid:' + raw, 'URN 前缀');
      assert.eq(formatUuid(raw, { case: 'upper', separator: 'braces' }),
        '{DE87628D-5377-3BA7-B31B-CDE1CC8D423F}', '大小写 + 分隔符可以叠加');
      // 先套大小写再套分隔符，所以 URN 前缀本身不会被转成大写以外的怪东西
      assert.eq(formatUuid(raw, { separator: 'urn', case: 'upper' }), 'urn:uuid:DE87628D-5377-3BA7-B31B-CDE1CC8D423F',
        'URN 前缀保持小写，主体大写');

      /* ---- 批量 ---- */
      assert.eq(generateUuids('v4', { amount: 3 }).length, 3, '生成 3 条');
      assert.eq(generateUuids('v4', { amount: 0 }).length, 1, '数量 0 按 1 算');
      assert.eq(generateUuids('v4', { amount: 500 }).length, 50, '数量超量按 50 算');
      assert.eq(generateUuids('NIL', { amount: 2 }), ['00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'],
        'NIL 批量就是重复的全零');
      var batch = generateUuids('v4', { amount: 20 });
      assert.eq(new Set(batch).size, 20, '20 条互不相同');

      var text = buildUuids('NIL', { amount: 3, case: 'upper', separator: 'braces' });
      assert.eq(text, ['{00000000-0000-0000-0000-000000000000}', '{00000000-0000-0000-0000-000000000000}', '{00000000-0000-0000-0000-000000000000}'].join('\n'),
        '主入口把选项一路带到输出');

      /* ================= v6 / v7（上游 #1654） ================= */

      // v6/v7 的版本位落在 [1-5] 之外，所以上面那条 UUID_RE 不适用，各自单测。
      var V67_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-67][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

      /* ---- v6：对着 uuid@11 的 v6() 校准的测试向量 ---- */
      // 这条向量是 ms=1700000000123, nsecs=5678, clockseq=0x1234,
      // node=01:23:45:67:89:ab 的确切结果 —— 逐字节比对过 2 万组随机输入。
      assert.eq(stringifyBytes(v6Bytes(1700000000123, 5678, 0x1234, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab])),
        '1ee833b0-4c29-6ade-9234-0123456789ab', 'v6 字节布局：uuid@11 参考向量');
      // v6 相对 v1 只重排时间戳，clock_seq + node 原地不动（RFC 9562 §5.6），
      // 所以同参数下这两段字节必须一模一样。
      var v1same = window.uuid.v1({ clockseq: 0x1234, msecs: 1700000000123, nsecs: 5678,
        node: [0x01, 0x23, 0x45, 0x67, 0x89, 0xab] });
      var v1raw = window.uuid.parse(v1same);
      var v6raw = v6Bytes(1700000000123, 5678, 0x1234, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);
      assert.eq(v6raw.slice(8).join(','), Array.prototype.slice.call(v1raw, 8).join(','),
        'v6 与 v1 同参数下 clock_seq + node 完全一致');
      assert(v6raw.slice(0, 8).join(',') !== Array.prototype.slice.call(v1raw, 0, 8).join(','),
        '但时间戳那段确实重排过（v1 是低位在前，v6 是高位在前）');

      var v6fixed = { now: function () { return 1700000000123; }, randomBytes: function () { return new Uint8Array([1, 0x23, 0x45, 0x67, 0x89, 0xab]); }, index: 0x1234, nsecs: 5678 };
      assert.eq(generateOne('v6', v6fixed), '1ee833b0-4c29-6ade-9234-0123456789ab', 'generateOne v6 走同一套布局');
      assert(V67_RE.test(generateOne('v6')), 'v6 符合 8-4-4-4-12 形状');
      assert(generateOne('v6')[14] === '6', 'v6 的版本位是 6');
      assert(generateOne('v6') !== generateOne('v6'), '两次 v6 不同');

      // v6 的 60 位时间戳是「高位在前」，所以同一秒内相邻两条 v6 的前 6 字节
      // 只差末尾；反过来 v1 是低位在前，前 6 字节在同秒内看起来是乱跳的。
      var a = stringifyBytes(v6Bytes(1000000000000, 0, 0, [0, 0, 0, 0, 0, 0]));
      var b = stringifyBytes(v6Bytes(1000000000000, 1, 0, [0, 0, 0, 0, 0, 0]));
      assert(a < b, 'v6 同毫秒内按 nsecs 递增: ' + a + ' < ' + b);

      /* ---- v7 ---- */
      // 时间戳还原：前 6 字节大端拼回来必须等于输入的毫秒
      var rnd16 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      var v7b = v7Bytes(0x1ec9414c232a, rnd16, null);
      assert.eq(stringifyBytes(v7b).slice(0, 13), '1ec9414c-232a', 'v7 前 48 位就是 Unix 毫秒');
      assert.eq(v7b[6] >> 4, 7, 'v7 版本位是 7');
      assert.eq(v7b[8] >> 6, 2, 'v7 variant 位是 0b10');
      assert.eq(v7b.length, 16, 'v7 正好 16 字节');

      // rand_a：不给 seq 就是从 rnd[6]/rnd[7] 取的 12 位；给了就照给的来
      assert.eq(v7Bytes(0, rnd16, null)[6] & 0x0f, (rnd16[6] >> 4) & 0x0f, 'rand_a 高 4 位来自 rnd[6]');
      assert.eq(v7Bytes(0, rnd16, null)[7], ((rnd16[6] << 4) | (rnd16[7] >> 4)) & 0xff, 'rand_a 低 8 位');
      assert.eq(v7Bytes(0, rnd16, 0xabc)[6] & 0x0f, 0xa, '指定 seq 时 rand_a 高 4 位照用');
      assert.eq(v7Bytes(0, rnd16, 0xabc)[7], 0xbc, '指定 seq 时 rand_a 低 8 位照用');
      assert.eq(v7Bytes(0, rnd16, 0xfff)[7], 0xff, 'seq 取满 12 位');
      assert.eq(v7Bytes(0, rnd16, 0x1000)[7], 0x00, 'seq 超过 12 位只留低 12 位');

      // 单调：同一毫秒内 rand_a 递增，整条 UUID 的字节序也跟着递增
      // rand_a 是第三段里版本位后面那 3 位十六进制，也就是下标 15..17（下标 18 是连字符）
      var randAOf = function (u) { return u.slice(15, 18); };
      var mono = [];
      for (var i2 = 0; i2 < 5; i2++) mono.push(stringifyBytes(v7Bytes(1700000000000, rnd16, i2)));
      assert.eq(mono.map(randAOf).join(','), '000,001,002,003,004', 'Monotonic 下 rand_a 就是 0,1,2,3,4');
      assert.eq(mono.slice().sort().join(','), mono.join(','), 'Monotonic 模式下同毫秒内严格递增');

      // 毫秒本身跨过去也递增（v7 最大的卖点：字典序 = 时间序）
      assert(stringifyBytes(v7Bytes(1700000000000, rnd16, 0xfff)) <
        stringifyBytes(v7Bytes(1700000000001, rnd16, 0)), '时间戳优先于 rand_a');

      var v7fixed = { now: function () { return 0x1ec9414c232a; }, randomBytes: function () { return rnd16; } };
      assert(V67_RE.test(generateOne('v7', v7fixed)), 'v7 符合形状');
      assert(generateOne('v7', v7fixed)[14] === '7', 'v7 的版本位是 7');
      assert(generateOne('v7', v7fixed) === generateOne('v7', v7fixed), 'v7 注入时钟与随机源后可复现');
      assert(generateOne('v7') !== generateOne('v7'), '两次 v7 不同');

      // 批量：不开 Monotonic 时 rand_a 是随机的，同毫秒内不保证有序（这是预期，
      // 所以只断言跨毫秒有序；开了才断言整批有序）
      var v7batch = generateUuids('v7', { amount: 8, monotonic: true,
        now: function () { return 1700000000000; }, randomBytes: function () { return rnd16; } });
      assert.eq(v7batch.length, 8, 'v7 批量生成 8 条');
      assert.eq(v7batch.slice().sort().join(','), v7batch.join(','), 'Monotonic 批量整体有序');
      assert.eq(new Set(v7batch).size, 8, 'v7 批量 8 条互不相同');
      // 关掉 Monotonic 就退回随机 rand_a。固定随机源时这个「随机」是可以钉死的：
      // rand_a 恒等于 rnd[6]/rnd[7] 取的那 12 位，整批自然全都一样。
      var v7rand = generateUuids('v7', { amount: 8,
        now: function () { return 1700000000000; }, randomBytes: function () { return rnd16; } });
      var expectRandA = randAOf(stringifyBytes(v7Bytes(0, rnd16, null)));
      assert.eq(v7rand.length, 8, '非 Monotonic 也生成 8 条');
      assert.eq(new Set(v7rand).size, 1,
        '不开 Monotonic 时 rand_a 取自随机源（非递增，固定随机源下整批相同）');
      assert.eq(randAOf(v7rand[0]), expectRandA, 'rand_a 与 v7Bytes 的随机取值一致');
      // rnd16[6]=6、rnd16[7]=7 -> rand_a = (6<<4)|(7>>4) = 0x60
      assert.eq(expectRandA, '060', '随机 rand_a = (rnd[6]<<4 | rnd[7]>>4) 的低 12 位');

      // v7 也要走格式化那条路
      assert.eq(formatUuid(generateOne('v7', v7fixed), { separator: 'compact' }).replace(/-/g, ''),
        generateOne('v7', v7fixed).replace(/-/g, ''), 'v7 一样支持 compact');
    }
  };
})();