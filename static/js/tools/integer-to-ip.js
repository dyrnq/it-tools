/* ==========================================================================
   整数 → IP 地址转换器（integer-to-ip）

   把一个整数（IPv4 的 32 位 / IPv6 的 128 位无符号数）同时转成
   IPv4 点分十进制、IPv6 的 RFC 5952 压缩写法、十六进制和二进制。

   来源：it-tools 上游 PR #1264「feat(new tool): Integers to IP」（GPLv3）。
   上游用 ip-bigint 这个纯 ESM 库，本项目没有打包器、只用浏览器原生 API，
   所以取模/除法/零段压缩全部自己用 BigInt 写。

   与上游的差别（上游的坑，逐条绕开）：
   1. 上游的 #1264 顺手把 integer-base-converter 的中间值从 bigint 降级成了
      number（把 `carry += BigInt(...)` 改成了 `carry += fromRange.indexOf(digit) * ...`），
      于是超过 2^53 的整数（IPv6 的大地址全是这种）会变成科学计数法，直接坏掉；
      上游自己那份还把 convertBase 的返回值再喂给 BigInt(...)，那时候已经晚了。
      **本工具从解析到格式化全程 BigInt，一个数都不落到 Number** ——
      唯一的例外是切 8 位/16 位分片，那一步的值必然 < 256 / < 65536，丢不了精度。
      __cases 里有一条断言专门把 2^128-1 钉死。
   2. 上游的 IPv6 压缩没写清「只有一个全零段时不能压」和「多段等长时取最左」
      这两条 RFC 5952 的细则，边界上会给出不合规的写法。这里按 RFC 5952 §4.2
      自己实现：压就压最长的一段，只有一个零段时不压，等长取最左。
   3. 上游只给了一套写法，没有说明 IPv4 映射地址的取舍。这里统一用**纯十六进制**
      （192.168.0.1 的映射形式写成 ::ffff:c0a8:1，而不是 ::ffff:192.168.0.1）：
      RFC 5952 对映射地址的混写（::ffff:x.x.x.x）与纯十六进制都认可，
      本工具按 §4.3 的十六进制规则统一走小写纯十六进制，同一份输出里不会出现两种风格。
   4. 反方向（IP 地址 → 整数）不在本工具里重复实现，本站已有 IPv4 / IPv6
      地址转换器 —— 只在提示里指个路。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('integer-to-ip');

  /** IPv4 的上界：2^32-1 */
  var MAX_IPV4 = 0xFFFFFFFFn;
  /** IPv6 的上界：2^128-1 */
  var MAX_IPV6 = (1n << 128n) - 1n;

  /**
   * 进制前缀。C 风格的 0x/0b/0o 与 VB 风格的 &h/&b/&o 各写一遍，两种都收。
   * 前缀一旦出现，它就决定输入进制 —— 否则用户粘进来一个 0xC0A80001、
   * 界面上还挂着十进制，出来的数是错的。
   */
  var BASE_PREFIXES = [
    { base: 16, re: /^(?:0[xX]|&[hH])/ },
    { base: 2, re: /^(?:0[bB]|&[bB])/ },
    { base: 8, re: /^(?:0[oO]|&[oO])/ }
  ];

  /** C# 风格的类型后缀：I / L / U / Z / N（可组合）。这些字母在 2/8/10/16 进制里都不是数字，剥掉不会误伤。 */
  var TYPE_SUFFIX_RE = /[ILUZN]+$/;

  /** 数字里的分隔符：空格（含制表符、换行）、逗号、下划线。 */
  var SEPARATOR_RE = /[\s,_]/g;

  /**
   * 去掉数字里的分隔符，再把两端空白去掉。
   * @param {string} text
   * @returns {string}
   */
  function stripSeparators(text) {
    return String(text == null ? '' : text).replace(SEPARATOR_RE, '').trim();
  }

  /**
   * 看一眼输入带没带进制前缀。
   * @param {string} text
   * @returns {{base:number, length:number}|null} length 是前缀的字符数
   */
  function detectPrefix(text) {
    var body = stripSeparators(text);
    if (body.charAt(0) === '+' || body.charAt(0) === '-') body = body.slice(1);
    for (var i = 0; i < BASE_PREFIXES.length; i++) {
      var m = body.match(BASE_PREFIXES[i].re);
      if (m) return { base: BASE_PREFIXES[i].base, length: m[0].length };
    }
    return null;
  }

  /**
   * 一个字符在给定进制下是多少；不是合法数字返回 -1。
   * 十六进制的字母只有 10~15 这几个值，所以 base < 16 时自然被判非法。
   */
  function digitValue(ch, base) {
    var d;
    if (ch >= '0' && ch <= '9') d = ch.charCodeAt(0) - 48;
    else if (ch >= 'a' && ch <= 'f') d = ch.charCodeAt(0) - 87;
    else if (ch >= 'A' && ch <= 'F') d = ch.charCodeAt(0) - 55;
    else return -1;
    return d < base ? d : -1;
  }

  /**
   * 解析整数。
   *
   * **全程 BigInt**：中间值一旦落到 Number，超过 2^53 就开始丢精度，
   * IPv6 的大地址（2^128 级别）必然踩中这个坑。
   *
   * @param {string} text 原始输入
   * @param {number} base 调用方选的进制（带前缀时以前缀为准）
   * @returns {{value: BigInt|null, error: string, base: number}}
   *          value 为 null 表示「没有输入」或「解析失败」，用 error 区分
   */
  function parseInteger(text, base) {
    var body = stripSeparators(text);
    if (!body.length) return { value: null, error: '', base: base };

    var negative = false;
    if (body.charAt(0) === '+' || body.charAt(0) === '-') {
      negative = body.charAt(0) === '-';
      body = body.slice(1);
    }

    // 前缀决定进制（此时忽略调用方给的进制），后缀只影响读法
    var effectiveBase = base;
    var prefix = detectPrefix(body);
    if (prefix) {
      effectiveBase = prefix.base;
      body = body.slice(prefix.length);
    }
    body = body.replace(TYPE_SUFFIX_RE, '');
    if (!body.length) {
      return { value: null, error: t('err_no_digits', 'No digits to convert'), base: effectiveBase };
    }

    var radix = BigInt(effectiveBase);
    var value = 0n;
    for (var i = 0; i < body.length; i++) {
      var ch = body.charAt(i);
      var d = digitValue(ch, effectiveBase);
      if (d < 0) {
        return {
          value: null,
          error: t('err_invalid_char', 'Invalid character "{ch}" for base {base}')
            // 用函数形式回填：非法字符可能正好是 '$'，字符串替换会把它当替换模式
            .replace('{ch}', function () { return ch; })
            .replace('{base}', effectiveBase),
          base: effectiveBase
        };
      }
      value = value * radix + BigInt(d);
    }
    if (negative) value = -value;
    return { value: value, error: '', base: effectiveBase };
  }

  /**
   * IPv4 点分十进制。装不进 32 位就返回空串（由调用方给出说明）。
   * @param {BigInt} value
   * @returns {string}
   */
  function ipv4FromBigInt(value) {
    if (value < 0n || value > MAX_IPV4) return '';
    var parts = [];
    for (var i = 0; i < 4; i++) {
      // 切下来的分片必然 < 256，转成 Number 不会丢精度
      parts.push(Number((value >> BigInt(8 * (3 - i))) & 0xFFn));
    }
    return parts.join('.');
  }

  /** 一个 16 位组的十六进制写法：小写、不带前导零（RFC 5952 §4.3） */
  function hexGroup(group) {
    return group.toString(16);
  }

  /**
   * IPv6 的文本写法（RFC 5952 §4.2）。
   *
   *   - 十六进制小写、不带前导零；
   *   - 连续的全零 16 位段用 :: 代替，要压就压**最长**的一段；
   *   - 只有一个全零段时不压（:: 不能只代表一个 0）；
   *   - 多段一样长时压**最左**的一段。
   *
   * IPv4 映射地址（192.168.0.1 → ::ffff:192.168.0.1）本工具统一写成
   * 纯十六进制的 ::ffff:c0a8:1，理由见文件头。
   *
   * @param {BigInt} value
   * @returns {string} 超出 128 位返回空串
   */
  function ipv6FromBigInt(value) {
    if (value < 0n || value > MAX_IPV6) return '';
    var groups = [];
    for (var i = 0; i < 8; i++) {
      // 分片必然 < 65536，转成 Number 不会丢精度
      groups.push(Number((value >> BigInt(16 * (7 - i))) & 0xFFFFn));
    }

    var bestStart = -1, bestLen = 0;
    var curStart = -1, curLen = 0;
    for (var j = 0; j < 8; j++) {
      if (groups[j] === 0) {
        if (curStart < 0) { curStart = j; curLen = 1; } else { curLen++; }
        // 严格大于才更新 —— 这样多段等长时保住更靠左的那一段（RFC 5952 §4.2.3）
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      } else {
        curStart = -1; curLen = 0;
      }
    }

    // 只有一个零段时不压（RFC 5952 §4.2.2）
    if (bestLen < 2) return groups.map(hexGroup).join(':');

    var head = groups.slice(0, bestStart).map(hexGroup).join(':');
    var tail = groups.slice(bestStart + bestLen).map(hexGroup).join(':');
    return head + '::' + tail;
  }

  /**
   * 十六进制（不带 0x），按位数补前导零。
   * @param {BigInt} value
   * @param {number} bits 32 或 128
   */
  function hexFromBigInt(value, bits) {
    return value.toString(16).padStart(bits / 4, '0');
  }

  /**
   * 二进制，每 8 位一组用下划线隔开，方便数位数。
   * @param {BigInt} value
   * @param {number} bits 32 或 128
   */
  function binaryFromBigInt(value, bits) {
    var s = value.toString(2).padStart(bits, '0');
    var groups = [];
    for (var i = 0; i < s.length; i += 8) groups.push(s.slice(i, i + 8));
    return groups.join('_');
  }

  /**
   * 十六进制/二进制用几位来展示：装得进 32 位就按 IPv4 的长度
   * （8 位十六进制 / 32 位二进制），否则按 IPv6 的长度
   * （32 位十六进制 / 128 位二进制）。
   */
  function widthFor(value) {
    return value <= MAX_IPV4 ? 32 : 128;
  }

  /**
   * 一次算出全部结果。
   * @param {string} text
   * @param {number} base
   * @returns {{value: BigInt|null, error: string, base: number, fits4: boolean,
   *            ipv4: string, ipv6: string, hex: string, binary: string}}
   */
  function convertAll(text, base) {
    var parsed = parseInteger(text, base);
    var empty = {
      value: null, error: parsed.error, base: parsed.base, fits4: false,
      ipv4: '', ipv6: '', hex: '', binary: ''
    };
    if (parsed.error || parsed.value === null) return empty;

    var value = parsed.value;
    if (value < 0n) {
      empty.error = t('err_negative', 'A negative number has no IP address representation');
      return empty;
    }
    if (value > MAX_IPV6) {
      empty.error = t('err_ipv6_range', 'Out of IPv6 range: an IPv6 address is 0 to 340282366920938463463374607431768211455');
      return empty;
    }

    var bits = widthFor(value);
    return {
      value: value,
      error: '',
      base: parsed.base,
      fits4: value <= MAX_IPV4,
      ipv4: ipv4FromBigInt(value),
      ipv6: ipv6FromBigInt(value),
      hex: hexFromBigInt(value, bits),
      binary: binaryFromBigInt(value, bits)
    };
  }

  window.ItTools.register('integer-to-ip', function (root) {
    var valueInput = D.h('input.layui-input', {
      type: 'text', value: '3232235777', spellcheck: 'false',
      placeholder: t('input_ph', 'e.g. 3232235777 or 0xC0A80001')
    });

    var baseSelect = D.h('select.layui-select', null,
      D.h('option', { value: '2', text: t('base_binary', 'Binary (2)') }),
      D.h('option', { value: '8', text: t('base_octal', 'Octal (8)') }),
      D.h('option', { value: '10', text: t('base_decimal', 'Decimal (10)') }),
      D.h('option', { value: '16', text: t('base_hexadecimal', 'Hexadecimal (16)') })
    );
    baseSelect.value = '10';

    /** 用户自己选的进制；带前缀时以前缀为准，没有前缀时回到这个值 */
    var userBase = 10;

    var prefixNote = D.h('p.field-hint');
    var errorNote = D.h('p.field-hint');

    /** 一条输出：标签 + 只读输入框 + 复制按钮，下面跟一行说明 */
    function outputRow(labelText, noteText) {
      var box = D.h('input.layui-input', { type: 'text', readonly: true, spellcheck: 'false' });
      var note = D.h('p.field-hint', { text: noteText || '' });
      var el = D.h('div', null,
        D.h('div.field-row', null,
          D.h('label.field-label', { text: labelText }),
          box,
          U.copyButton(function () { return box.value; })
        ),
        note
      );
      return { el: el, box: box, note: note };
    }

    var ipv4Row = outputRow(t('ipv4', 'IPv4 address'));
    var ipv6Row = outputRow(t('ipv6', 'IPv6 address'),
      t('ipv6_hint', 'RFC 5952 form: the longest run of zero fields is written as ::. An IPv4-mapped address keeps the hexadecimal form (::ffff:c0a8:1).'));
    var hexRow = outputRow(t('hexadecimal', 'Hexadecimal'),
      t('hex_hint', 'No 0x prefix. 8 digits for an IPv4-length value, 32 digits for an IPv6-length value.'));
    var binaryRow = outputRow(t('binary', 'Binary'),
      t('binary_hint', '32 bits for an IPv4-length value, 128 bits for an IPv6-length value, in blocks of 8.'));

    function render() {
      // 带前缀时前缀说了算：下拉框跟着变，提示里说明「已根据前缀识别」
      var prefix = detectPrefix(valueInput.value);
      var base = prefix ? prefix.base : userBase;
      baseSelect.value = String(base);
      prefixNote.textContent = prefix
        ? t('prefix_detected', 'Base prefix detected → parsed as base {base}').replace('{base}', prefix.base)
        : '';

      var out = convertAll(valueInput.value, base);

      ipv4Row.box.value = out.ipv4;
      ipv6Row.box.value = out.ipv6;
      hexRow.box.value = out.hex;
      binaryRow.box.value = out.binary;

      errorNote.textContent = out.error;
      errorNote.style.color = out.error ? '#d03050' : '';

      // 装不进 32 位：IPv4 这一栏留空并说明原因，别的栏照常给
      if (out.value !== null && !out.fits4) {
        ipv4Row.note.textContent = t('err_ipv4_range', 'Does not fit in 32 bits: an IPv4 address is 0 to 4294967295');
        ipv4Row.note.style.color = '#d03050';
      } else {
        ipv4Row.note.textContent = '';
        ipv4Row.note.style.color = '';
      }
    }

    valueInput.addEventListener('input', render);
    baseSelect.addEventListener('change', function () {
      userBase = Number(baseSelect.value);
      render();
    });

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Integer to convert'), valueInput, {
        wide: true,
        hint: t('input_hint', 'Prefixes (0x, 0b, 0o, &h, &b, &o) and C# suffixes (I, L, U, Z, N) are accepted. Spaces, commas and underscores are ignored.')
      }),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('input_base', 'Input base') }),
        baseSelect
      ),
      prefixNote,
      errorNote,
      D.h('p.field-hint', { text: t('reverse_hint', 'The reverse conversion (IP address to integer) is in the IPv4 and IPv6 address converters on this site.') })
    ));

    root.appendChild(D.h('div.card', null,
      ipv4Row.el,
      ipv6Row.el,
      hexRow.el,
      binaryRow.el
    ));

    render();
    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['integer-to-ip'] = {
    MAX_IPV4: MAX_IPV4,
    MAX_IPV6: MAX_IPV6,
    BASE_PREFIXES: BASE_PREFIXES,
    detectPrefix: detectPrefix,
    stripSeparators: stripSeparators,
    parseInteger: parseInteger,
    ipv4FromBigInt: ipv4FromBigInt,
    ipv6FromBigInt: ipv6FromBigInt,
    hexFromBigInt: hexFromBigInt,
    binaryFromBigInt: binaryFromBigInt,
    widthFor: widthFor,
    convertAll: convertAll,
    __cases: function (assert) {
      /** 由 8 个 16 位组拼出一个数，写 RFC 5952 的用例时好读 */
      function fromGroups(groups) {
        return groups.reduce(function (acc, g) { return (acc << 16n) + BigInt(g); }, 0n);
      }

      // ---- IPv4 点分十进制 ----
      assert.eq(ipv4FromBigInt(3232235777n), '192.168.1.1', '3232235777 → 192.168.1.1');
      assert.eq(ipv4FromBigInt(3232235521n), '192.168.0.1', '3232235521 → 192.168.0.1');
      assert.eq(ipv4FromBigInt(0n), '0.0.0.0', '0 → 0.0.0.0');
      assert.eq(ipv4FromBigInt(4294967295n), '255.255.255.255', '4294967295 → 255.255.255.255');
      assert.eq(ipv4FromBigInt(1n), '0.0.0.1', '1 → 0.0.0.1');
      assert.eq(ipv4FromBigInt(2130706433n), '127.0.0.1', '2130706433 → 127.0.0.1');
      assert.eq(ipv4FromBigInt(167772161n), '10.0.0.1', '167772161 → 10.0.0.1');
      assert.eq(ipv4FromBigInt(4294967296n), '', '超过 2^32-1 没有 IPv4');
      assert.eq(ipv4FromBigInt(-1n), '', '负数没有 IPv4');

      // ---- IPv6 与 RFC 5952 的压缩写法 ----
      assert.eq(ipv6FromBigInt(0n), '::', '0 → ::');
      assert.eq(ipv6FromBigInt(1n), '::1', '1 → ::1');
      assert.eq(ipv6FromBigInt(fromGroups([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 1])),
        '::ffff:c0a8:1', 'IPv4 映射地址按十六进制写（口径见文件头）');
      assert.eq(ipv6FromBigInt(fromGroups([0x2001, 0x0db8, 0, 1, 2, 3, 4, 5])),
        '2001:db8:0:1:2:3:4:5', '只有一个零段时不压缩');
      assert.eq(ipv6FromBigInt(fromGroups([1, 0, 0, 2, 3, 0, 0, 4])),
        '1::2:3:0:0:4', '多段等长时压最左的一段');
      assert.eq(ipv6FromBigInt(fromGroups([0, 0, 1, 2, 3, 4, 5, 6])),
        '::1:2:3:4:5:6', '压最长的一段');
      assert.eq(ipv6FromBigInt(fromGroups([1, 2, 3, 4, 5, 6, 7, 8])),
        '1:2:3:4:5:6:7:8', '没有零段时全展开');
      assert.eq(ipv6FromBigInt(MAX_IPV6 + 1n), '', '超过 2^128-1 没有 IPv6');
      assert.eq(ipv6FromBigInt(-1n), '', '负数没有 IPv6');

      // ---- 上游坏掉的那条路：2^128-1 全程 BigInt ----
      var max128 = (1n << 128n) - 1n;
      assert.eq(ipv6FromBigInt(max128), 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2^128-1 的 IPv6');
      assert.eq(hexFromBigInt(max128, 128), 'ffffffffffffffffffffffffffffffff', '2^128-1 的十六进制');
      assert.eq(binaryFromBigInt(max128, 128),
        '11111111_11111111_11111111_11111111_11111111_11111111_11111111_11111111_11111111_11111111_11111111_11111111_11111111_11111111_11111111_11111111',
        '2^128-1 的二进制');
      var parsedMax = parseInteger('340282366920938463463374607431768211455', 10);
      assert(parsedMax.value === max128, '2^128-1 用 BigInt 解析，结果精确');
      assert.eq(convertAll('340282366920938463463374607431768211455', 10).ipv6,
        'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2^128-1 从十进制字符串一路走到 IPv6');
      // 上游把中间值降级成 number 之后，这一步就会变成 3.402823669209385e+38
      assert(String(Number('340282366920938463463374607431768211455')) !==
        '340282366920938463463374607431768211455', '用 Number 解析就会丢精度 —— 这正是上游坏掉的地方');

      // ---- 十六进制 / 二进制的位数 ----
      assert.eq(hexFromBigInt(3232235521n, 32), 'c0a80001', 'IPv4 长度的十六进制是 8 位');
      assert.eq(hexFromBigInt(3232235521n, 32).length, 8, 'IPv4 长度的十六进制定长 8 位');
      assert.eq(binaryFromBigInt(3232235521n, 32), '11000000_10101000_00000000_00000001', 'IPv4 长度的二进制每 8 位一组');
      assert.eq(binaryFromBigInt(3232235521n, 32).split('_').length, 4, 'IPv4 长度的二进制是 4 组');
      assert.eq(widthFor(4294967295n), 32, '装得进 32 位按 IPv4 的长度');
      assert.eq(widthFor(4294967296n), 128, '装不进 32 位按 IPv6 的长度');
      assert.eq(binaryFromBigInt(max128, 128).split('_').length, 16, 'IPv6 长度的二进制是 16 组');

      // ---- 前缀识别：前缀说了算，忽略调用方给的进制 ----
      assert(parseInteger('0xC0A80001', 10).value === 3232235521n, '0x 前缀 → 16 进制');
      assert(parseInteger('0XC0A80001', 10).value === 3232235521n, '0X 前缀');
      assert(parseInteger('&HC0A80001', 10).value === 3232235521n, '&H 前缀');
      assert(parseInteger('&hC0A80001', 10).value === 3232235521n, '&h 前缀');
      assert(parseInteger('0b11000000101010000000000000000001', 10).value === 3232235521n, '0b 前缀 → 2 进制');
      assert(parseInteger('0B11000000101010000000000000000001', 10).value === 3232235521n, '0B 前缀');
      assert(parseInteger('&B11000000101010000000000000000001', 10).value === 3232235521n, '&B 前缀');
      assert(parseInteger('0o252', 10).value === 170n, '0o 前缀 → 8 进制');
      assert(parseInteger('&O252', 10).value === 170n, '&O 前缀');
      assert(parseInteger('0xFF', 16).value === 255n, '前缀与所选进制一致时也对');
      assert.eq(parseInteger('0xFF', 10).base, 16, '前缀会把进制改成 16');
      assert.eq(parseInteger('42', 10).base, 10, '没有前缀时用调用方给的进制');
      assert.eq(detectPrefix('0xAA').base, 16, 'detectPrefix 认出 0x');
      assert.eq(detectPrefix('&b1010').base, 2, 'detectPrefix 认出 &b');
      assert.eq(detectPrefix('42'), null, '没有前缀');
      assert.eq(detectPrefix(''), null, '空串没有前缀');

      // ---- C# 类型后缀 ----
      assert(parseInteger('0xFFUL', 10).value === 255n, '0xFFUL');
      assert(parseInteger('42U', 10).value === 42n, '十进制 U 后缀');
      assert(parseInteger('42L', 10).value === 42n, '十进制 L 后缀');
      assert(parseInteger('42I', 10).value === 42n, '十进制 I 后缀');
      assert(parseInteger('42Z', 10).value === 42n, '十进制 Z 后缀');
      assert(parseInteger('42N', 10).value === 42n, '十进制 N 后缀');

      // ---- 分隔符 ----
      assert(parseInteger('3232 235777', 10).value === 3232235777n, '空格是分隔符');
      assert(parseInteger('3,232,235,777', 10).value === 3232235777n, '逗号是分隔符');
      assert(parseInteger('3_232_235_777', 10).value === 3232235777n, '下划线是分隔符');
      assert(parseInteger('  3232235777  ', 10).value === 3232235777n, '两端空白被 trim');
      assert(parseInteger('0xC0 A8 0001', 10).value === 3232235521n, '带前缀的数字里也可以有空格');

      // ---- 非法输入 ----
      assert.eq(parseInteger('', 10).value, null, '空输入没有值');
      assert.eq(parseInteger('', 10).error, '', '空输入不算错误');
      assert(/Invalid character/.test(parseInteger('abc', 10).error), '十进制里没有字母');
      assert(/Invalid character/.test(parseInteger('9', 8).error), '八进制里没有 9');
      assert(/Invalid character/.test(parseInteger('g', 16).error), '十六进制里没有 g');
      assert(/No digits/.test(parseInteger('0x', 16).error), '只有前缀没有数字');
      assert(/No digits/.test(parseInteger('U', 10).error), '只有后缀没有数字');

      // ---- 范围 ----
      assert(/negative/i.test(convertAll('-1', 10).error), '负数给出明确提示');
      assert(/IPv6 range/.test(convertAll('340282366920938463463374607431768211456', 10).error),
        '超过 2^128-1 给出明确提示');
      assert.eq(convertAll('340282366920938463463374607431768211456', 10).ipv6, '', '超范围时没有输出');
      assert.eq(convertAll('340282366920938463463374607431768211456', 10).value, null, '超范围时没有值');
      assert.eq(convertAll('4294967296', 10).ipv4, '', '超过 32 位时 IPv4 留空');
      assert.eq(convertAll('4294967296', 10).fits4, false, '超过 32 位时 fits4 为假');
      assert.eq(convertAll('4294967296', 10).ipv6, '::1:0:0', '超过 32 位时 IPv6 照常给');

      // ---- 端到端 ----
      var out = convertAll('3232235777', 10);
      assert.eq(out.ipv4, '192.168.1.1', '端到端：IPv4');
      assert.eq(out.ipv6, '::c0a8:101', '端到端：IPv6');
      assert.eq(out.hex, 'c0a80101', '端到端：十六进制');
      assert.eq(out.binary, '11000000_10101000_00000001_00000001', '端到端：二进制');
      assert.eq(convertAll('0xC0A80001', 10).ipv4, '192.168.0.1', '端到端：0x 前缀');
      assert.eq(convertAll('0b11000000101010000000000000000001', 10).ipv4, '192.168.0.1', '端到端：0b 前缀');
      assert.eq(convertAll('2130706433', 10).ipv4, '127.0.0.1', '端到端：127.0.0.1');
      assert.eq(convertAll('0', 10).ipv4, '0.0.0.0', '端到端：0');
      assert.eq(convertAll('4294967295', 10).ipv4, '255.255.255.255', '端到端：2^32-1');
    }
  };
})();
