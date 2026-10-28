/* ==========================================================================
   ARPA 地址解码器（arpa-decoder）

   把反向 DNS（ARPA）名字与 IP 地址互转。

   ---- 上游那版是什么 ----
   上游（it-tools2 的 arpa-decoder）只有**一个方向**：ARPA → IP。
   它把输入丢给 `Address4.fromArpa()` / `Address6.fromArpa()`，
   解析失败时把 catch 到的异常原文塞进输出区（`# Error: ...`）。

   ---- 差在哪 ----
   1. **上游用 `.includes('.in-addr.arpa')` 判 IPv4 —— 大小写敏感。**
      `4.3.2.1.IN-ADDR.ARPA` 会被当成 IPv6 送去 Address6.fromArpa，然后抛异常。
      DNS 名字**不区分大小写**，这里先转小写再判断。
   2. **上游没有 IPv6 压缩**：Address6.correctForm() 给的是展开形式
      （`2001:0db8:0000:0000:0000:0000:0000:0001`）。这里按 RFC 5952 压缩：
      压最长的一段零、多段等长取最左、只有一段全零时不压。
   3. **上游把异常原文当结果**（`# Error: Invalid ARPA address`）——
      用户分不清是「输入不对」还是「工具坏了」。这里给一句人话。
   4. **上游只有一个方向**。这里两个方向都能做；ARPA 一律输出**全展开**形式
      （IPv6 的 32 个 nibble 不压缩）—— 这是 ARPA 的规范写法。
   5. 上游的 `fromARPA()` 结尾补了个点，但**没有去掉**用户输入里多余的点，
      `foo.in-addr.arpa..` 会被当成非法名字。这里先剥掉所有结尾的点。

   ---- 依赖 ----
   无。纯字符串处理，不查 DNS —— 反向解析本来就是「名字 → 地址」的算术题。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('arpa-decoder');

  var V4_SUFFIX = 'in-addr.arpa';
  var V6_SUFFIX = 'ip6.arpa';

  /* ======================================================================
     纯逻辑
     ====================================================================== */

  /**
   * 归一化一个域名：去首尾空白、剥掉结尾的点、转小写。
   *
   * DNS 名字不区分大小写，但用户手输常带一个结尾的点（FQDN 的写法）。
   * @param {*} str
   * @returns {string}
   */
  function normalizeName(str) {
    return String(str == null ? '' : str).trim().replace(/\.+$/, '').toLowerCase();
  }

  /**
   * 解析 IPv4 地址。
   * @param {string} str
   * @returns {number[]|null} 4 个 0-255 的整数；不合法返回 null
   */
  function parseIPv4(str) {
    var parts = String(str == null ? '' : str).trim().split('.');
    if (parts.length !== 4) return null;
    var out = [];
    for (var i = 0; i < 4; i++) {
      if (!/^[0-9]{1,3}$/.test(parts[i])) return null;
      var n = parseInt(parts[i], 10);
      if (n > 255) return null;
      out.push(n);
    }
    return out;
  }

  /**
   * 解析 IPv6 地址（支持 `::` 缩写与末尾的 IPv4 形式）。
   * @param {string} str
   * @returns {number[]|null} 8 个 16 位整数；不合法返回 null
   */
  function parseIPv6(str) {
    var s = String(str == null ? '' : str).trim();
    if (!s) return null;

    // `::` 最多只能出现一次
    var dbl = s.indexOf('::');
    if (dbl >= 0 && s.indexOf('::', dbl + 1) >= 0) return null;

    var leftStr = dbl >= 0 ? s.slice(0, dbl) : s;
    var rightStr = dbl >= 0 ? s.slice(dbl + 2) : null;

    // 单冒号开头/结尾（`::` 本身不算）
    if (leftStr.charAt(0) === ':' || leftStr.charAt(leftStr.length - 1) === ':') return null;
    if (rightStr !== null &&
        (rightStr.charAt(0) === ':' || rightStr.charAt(rightStr.length - 1) === ':')) return null;

    var left = groupsOf(leftStr);
    if (left === null) return null;
    var right = rightStr === null ? [] : groupsOf(rightStr);
    if (right === null) return null;

    if (dbl < 0) return left.length === 8 ? left : null;
    // `::` 至少要代表一组零
    if (left.length + right.length > 7) return null;

    var out = left.slice();
    for (var i = left.length; i < 8 - right.length; i++) out.push(0);
    return out.concat(right);
  }

  /**
   * 把一段（不含 `::` 的）IPv6 文本拆成 16 位组。
   * @param {string} part
   * @returns {number[]|null}
   */
  function groupsOf(part) {
    if (part === '') return [];
    var list = part.split(':');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var piece = list[i];
      if (piece === '') return null;
      if (piece.indexOf('.') >= 0) {
        // IPv4 尾巴只能出现在最后一段
        if (i !== list.length - 1) return null;
        var v4 = parseIPv4(piece);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1]);
        out.push((v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        out.push(parseInt(piece, 16));
      }
    }
    return out;
  }

  /**
   * 按 RFC 5952 压缩 IPv6 地址。
   *
   * 规则（RFC 5952 §4）：
   * · 每组的前导零去掉；
   * · 最长的一段连续零压成 `::`；
   * · 多段一样长时取**最左**的那一段；
   * · 只有一段零时不压（`::` 至少代表两组）。
   *
   * @param {number[]} groups 8 个 16 位整数
   * @returns {string}
   */
  function compressIPv6(groups) {
    var bestStart = -1;
    var bestLen = 0;
    var i = 0;
    while (i < 8) {
      if (groups[i] === 0) {
        var j = i;
        while (j < 8 && groups[j] === 0) j++;
        // 严格大于 → 长度相同时保留最左的一段
        if (j - i > bestLen) { bestLen = j - i; bestStart = i; }
        i = j;
      } else {
        i++;
      }
    }
    var hex = [];
    for (var k = 0; k < 8; k++) hex.push(groups[k].toString(16));
    if (bestLen < 2) return hex.join(':');
    return hex.slice(0, bestStart).join(':') + '::' + hex.slice(bestStart + bestLen).join(':');
  }

  /**
   * 8 个 16 位组 → 32 个 nibble（小写十六进制，每组**四位**）。
   * @param {number[]} groups
   * @returns {string[]}
   */
  function toNibbles(groups) {
    var out = [];
    for (var i = 0; i < 8; i++) {
      var h = groups[i].toString(16);
      while (h.length < 4) h = '0' + h;
      out.push(h.charAt(0), h.charAt(1), h.charAt(2), h.charAt(3));
    }
    return out;
  }

  /**
   * ARPA 名字 → IP 地址。
   *
   * `4.3.2.1.in-addr.arpa` → `1.2.3.4`
   * `...ip6.arpa`（32 个 nibble）→ 压缩后的 IPv6
   *
   * @param {*} raw
   * @returns {{ok: boolean, ip?: string, error?: string}}
   */
  function decodeArpa(raw) {
    var name = normalizeName(raw);
    if (!name) return { ok: false, error: 'empty' };

    if (name.length > V4_SUFFIX.length &&
        name.slice(-(V4_SUFFIX.length + 1)) === '.' + V4_SUFFIX) {
      var v4 = name.slice(0, name.length - V4_SUFFIX.length - 1);
      var labels = v4.split('.');
      if (labels.length !== 4) return { ok: false, error: 'bad_v4_labels' };
      var nums = [];
      for (var i = 0; i < 4; i++) {
        if (!/^[0-9]{1,3}$/.test(labels[i])) return { ok: false, error: 'bad_v4_label' };
        var n = parseInt(labels[i], 10);
        if (n > 255) return { ok: false, error: 'bad_v4_label' };
        nums.push(n);
      }
      nums.reverse();
      return { ok: true, ip: nums.join('.') };
    }

    if (name.length > V6_SUFFIX.length &&
        name.slice(-(V6_SUFFIX.length + 1)) === '.' + V6_SUFFIX) {
      var v6 = name.slice(0, name.length - V6_SUFFIX.length - 1);
      var nibs = v6.split('.');
      if (nibs.length !== 32) return { ok: false, error: 'bad_v6_labels' };
      for (var j = 0; j < 32; j++) {
        if (!/^[0-9a-f]$/.test(nibs[j])) return { ok: false, error: 'bad_v6_label' };
      }
      nibs.reverse();
      var groups = [];
      // 32 个 nibble → 8 个 16 位组（每组 4 个 nibble）
      for (var k = 0; k < 32; k += 4) {
        groups.push(parseInt(nibs[k] + nibs[k + 1] + nibs[k + 2] + nibs[k + 3], 16));
      }
      return { ok: true, ip: compressIPv6(groups) };
    }

    return { ok: false, error: 'not_arpa' };
  }

  /**
   * IP 地址 → ARPA 名字（**全展开**，IPv6 的 32 个 nibble 不压缩）。
   * @param {*} raw
   * @returns {{ok: boolean, arpa?: string, error?: string}}
   */
  function encodeArpa(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, error: 'empty' };

    if (s.indexOf(':') >= 0) {
      var groups = parseIPv6(s);
      if (!groups) return { ok: false, error: 'bad_ip' };
      var nibs = toNibbles(groups);
      nibs.reverse();
      return { ok: true, arpa: nibs.join('.') + '.' + V6_SUFFIX };
    }

    var v4 = parseIPv4(s);
    if (!v4) return { ok: false, error: 'bad_ip' };
    return { ok: true, arpa: v4.slice().reverse().join('.') + '.' + V4_SUFFIX };
  }

  /* ======================================================================
     UI
     ====================================================================== */

  window.ItTools.register('arpa-decoder', function (root) {
    var dirSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'decode', text: t('opt_decode', 'ARPA name to IP address') }),
      D.h('option', { value: 'encode', text: t('opt_encode', 'IP address to ARPA name') })
    );

    var input = D.h('input.layui-input', { type: 'text', spellcheck: 'false' });

    var LABELS = {
      decode: t('label_arpa', 'ARPA name'),
      encode: t('label_ip', 'IP address')
    };
    var HINTS = {
      decode: t('hint_arpa', 'For example 4.3.2.1.in-addr.arpa, or the 32 nibble ip6.arpa form'),
      encode: t('hint_ip', 'For example 1.2.3.4 or 2001:db8::1')
    };
    var PLACEHOLDERS = {
      decode: t('placeholder_arpa', '4.3.2.1.in-addr.arpa'),
      encode: t('placeholder_ip', '1.2.3.4')
    };

    var field = U.field(LABELS.decode, input, { wide: true, hint: HINTS.decode });
    var labelEl = field.querySelector('.field-label');
    var hintEl = field.querySelector('.field-hint');

    var outCard = D.outputCard(t('output_title', 'Result'));
    var outBody = outCard.outputBody;
    var status = D.h('p.form-status');
    outCard.appendChild(status);

    var ERRORS = {
      empty: t('err_empty', 'Type an address above first.'),
      not_arpa: t('err_not_arpa', 'This is not an ARPA name: it has to end with in-addr.arpa or ip6.arpa.'),
      bad_v4_labels: t('err_bad_ipv4_arpa', 'An in-addr.arpa name has exactly 4 numeric labels, for example 4.3.2.1.in-addr.arpa.'),
      bad_v4_label: t('err_bad_ipv4_label', 'Each in-addr.arpa label has to be a number between 0 and 255.'),
      bad_v6_labels: t('err_bad_ipv6_arpa', 'An ip6.arpa name has exactly 32 labels, one hexadecimal digit each.'),
      bad_v6_label: t('err_bad_ipv6_label', 'Each ip6.arpa label has to be a single hexadecimal digit (0-9, a-f).'),
      bad_ip: t('err_bad_ip', 'This is not a valid IP address.')
    };

    /** 换方向时，标签/提示/占位符都要跟着换。 */
    function applyDirection() {
      var dir = dirSelect.value;
      labelEl.textContent = LABELS[dir];
      hintEl.textContent = HINTS[dir];
      input.placeholder = PLACEHOLDERS[dir];
    }

    function render() {
      var dir = dirSelect.value;
      var res = dir === 'encode' ? encodeArpa(input.value) : decodeArpa(input.value);
      if (res.ok) {
        outBody.textContent = dir === 'encode' ? res.arpa : res.ip;
        status.classList.remove('is-error');
        status.textContent = dir === 'encode'
          ? t('note_expanded', 'The ARPA name is fully expanded: the 32 nibbles of an IPv6 address are never compressed.')
          : t('note_rfc5952', 'The IPv6 address is compressed as described in RFC 5952.');
      } else {
        outBody.textContent = '';
        status.classList.add('is-error');
        status.textContent = ERRORS[res.error] || ERRORS.not_arpa;
      }
    }

    var swapBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button',
      text: t('btn_swap', 'Reverse direction'),
      onclick: function () {
        var dir = dirSelect.value;
        dirSelect.value = dir === 'encode' ? 'decode' : 'encode';
        // 有结果就把它搬到输入框里 —— 反向工具最常用的动作就是「来回倒」。
        var carried = outBody.textContent;
        if (carried) input.value = carried;
        applyDirection();
        render();
      }
    });

    var offs = [
      D.on(input, 'input', render),
      D.on(dirSelect, 'change', function () { applyDirection(); render(); })
    ];

    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('label_direction', 'Direction') }),
        dirSelect
      ),
      field,
      D.h('div.form-actions', null, swapBtn)
    ));
    root.appendChild(outCard);

    input.value = '4.3.2.1.in-addr.arpa';
    applyDirection();
    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  /* ======================================================================
     导出与自测
     ====================================================================== */

  window.ItTools.logic['arpa-decoder'] = {
    normalizeName: normalizeName,
    parseIPv4: parseIPv4,
    parseIPv6: parseIPv6,
    compressIPv6: compressIPv6,
    decodeArpa: decodeArpa,
    encodeArpa: encodeArpa,
    __cases: function (assert) {
      /* ---- 归一化 ---- */
      assert.eq(normalizeName('  4.3.2.1.IN-ADDR.ARPA.  '), '4.3.2.1.in-addr.arpa', '去空白、去尾点、转小写');
      assert.eq(normalizeName(''), '', '空串');
      assert.eq(normalizeName(null), '', 'null 不炸');

      /* ---- IPv4 解析 ---- */
      assert.eq(parseIPv4('1.2.3.4'), [1, 2, 3, 4], '正常 IPv4');
      assert.eq(parseIPv4('255.255.255.255'), [255, 255, 255, 255], '边界 255');
      assert.eq(parseIPv4('1.2.3'), null, '三段不合法');
      assert.eq(parseIPv4('1.2.3.4.5'), null, '五段不合法');
      assert.eq(parseIPv4('1.2.3.256'), null, '256 越界');
      assert.eq(parseIPv4('1.2.3.a'), null, '非数字');
      assert.eq(parseIPv4(''), null, '空串');
      assert.eq(parseIPv4(' 1.2.3.4 '), [1, 2, 3, 4], '首尾空白不算错');

      /* ---- IPv6 解析 ---- */
      assert.eq(parseIPv6('2001:db8::1'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1], ':: 缩写');
      assert.eq(parseIPv6('::'), [0, 0, 0, 0, 0, 0, 0, 0], '全零');
      assert.eq(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1], '::1');
      assert.eq(parseIPv6('1::'), [1, 0, 0, 0, 0, 0, 0, 0], '1::');
      assert.eq(parseIPv6('2001:0db8:0000:0000:0000:0000:0000:0001'),
        [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1], '全展开');
      assert.eq(parseIPv6('2001:db8:0:0:0:0:0:1'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1], '省略前导零');
      assert.eq(parseIPv6('::ffff:192.0.2.1'),
        [0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201], 'IPv4 尾巴');
      assert.eq(parseIPv6('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8], '八组');
      assert.eq(parseIPv6('1:2:3:4:5:6:7'), null, '七组没有 :: 不合法');
      assert.eq(parseIPv6('1::2::3'), null, '两个 :: 不合法');
      assert.eq(parseIPv6('1:2:3:4:5:6:7:8:9'), null, '九组不合法');
      assert.eq(parseIPv6(':1:2:3:4:5:6:7'), null, '单冒号开头不合法');
      assert.eq(parseIPv6('1:2:3:4:5:6:7:'), null, '单冒号结尾不合法');
      assert.eq(parseIPv6('2001:db8::1::'), null, ':: 出现两次');
      assert.eq(parseIPv6('12345::'), null, '五位十六进制不合法');
      assert.eq(parseIPv6('gggg::'), null, '非十六进制');
      assert.eq(parseIPv6(''), null, '空串');
      assert.eq(parseIPv6(null), null, 'null');

      /* ---- RFC 5952 压缩 ---- */
      var g = function (a) { return a; };
      assert.eq(compressIPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]), '2001:db8::1', '压一段零');
      assert.eq(compressIPv6([0, 0, 0, 0, 0, 0, 0, 0]), '::', '全零写成 ::');
      assert.eq(compressIPv6([0x2001, 0, 0, 0, 0, 0, 0, 0]), '2001::', '尾部一段零');
      assert.eq(compressIPv6([0, 0, 0, 0, 0, 0, 0, 1]), '::1', '头部一段零');
      assert.eq(compressIPv6([1, 0, 2, 0, 3, 0, 4, 5]), '1:0:2:0:3:0:4:5', '孤立的零组不压');
      assert.eq(compressIPv6([0, 0, 1, 0, 0, 2, 3, 4]), '::1:0:0:2:3:4', '等长时取最左');
      assert.eq(compressIPv6([1, 0, 0, 2, 3, 4, 0, 0]), '1::2:3:4:0:0', '两段一样长时取最左');
      assert.eq(compressIPv6([0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff]),
        'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '没有零就不压');
      assert.eq(compressIPv6([0x2001, 0x0db8, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0001]),
        '2001:db8::1', '前导零去掉');

      /* ---- 解码 ---- */
      assert.eq(decodeArpa('4.3.2.1.in-addr.arpa').ip, '1.2.3.4', 'IPv4 反向');
      assert.eq(decodeArpa('4.3.2.1.in-addr.arpa.').ip, '1.2.3.4', '结尾多个点');
      assert.eq(decodeArpa('4.3.2.1.IN-ADDR.ARPA').ip, '1.2.3.4', '大小写不敏感（上游在这里会炸）');
      assert.eq(decodeArpa('  4.3.2.1.in-addr.arpa  ').ip, '1.2.3.4', '首尾空白');
      assert.eq(decodeArpa('0.0.0.0.in-addr.arpa').ip, '0.0.0.0', '全零');
      assert.eq(decodeArpa('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa').ip,
        '2001:db8::1', 'IPv6 反向（32 个 nibble）');
      assert.eq(decodeArpa('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.IP6.ARPA').ip,
        '2001:db8::1', 'IPv6 也大小写不敏感');
      assert.eq(decodeArpa('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa').ok, true, 'IPv6 ok');

      /* ---- 解码的错 ---- */
      assert.eq(decodeArpa('').error, 'empty', '空串');
      assert.eq(decodeArpa('example.com').error, 'not_arpa', '普通域名不是 ARPA');
      assert.eq(decodeArpa('in-addr.arpa').error, 'not_arpa', '光有后缀没有标签');
      assert.eq(decodeArpa('1.2.3.in-addr.arpa').error, 'bad_v4_labels', 'IPv4 标签数不对');
      assert.eq(decodeArpa('1.2.3.4.5.in-addr.arpa').error, 'bad_v4_labels', 'IPv4 标签多了一个');
      assert.eq(decodeArpa('a.b.c.d.in-addr.arpa').error, 'bad_v4_label', 'IPv4 标签不是数字');
      assert.eq(decodeArpa('1.2.3.256.in-addr.arpa').error, 'bad_v4_label', 'IPv4 标签越界');
      assert.eq(decodeArpa('1.0.0.ip6.arpa').error, 'bad_v6_labels', 'IPv6 nibble 数不对');
      assert.eq(decodeArpa('g.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa').error,
        'bad_v6_label', 'IPv6 nibble 不是十六进制');
      assert.eq(decodeArpa(null).error, 'empty', 'null 不炸');

      /* ---- 编码 ---- */
      assert.eq(encodeArpa('1.2.3.4').arpa, '4.3.2.1.in-addr.arpa', 'IPv4 正向');
      assert.eq(encodeArpa(' 192.168.1.1 ').arpa, '1.1.168.192.in-addr.arpa', '首尾空白');
      assert.eq(encodeArpa('255.255.255.0').arpa, '0.255.255.255.in-addr.arpa', '广播地址');
      assert.eq(encodeArpa('2001:db8::1').arpa,
        '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa',
        'IPv6 正向（nibble 不压缩）');
      assert.eq(encodeArpa('::1').arpa,
        '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa', '::1');
      assert.eq(encodeArpa('::').arpa,
        '0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa', ':: 全展开');
      assert.eq(encodeArpa('1.2.3.4').ok, true, '编码 ok');
      assert.eq(encodeArpa('').error, 'empty', '编码空串');
      assert.eq(encodeArpa('999.1.1.1').error, 'bad_ip', '编码非法 IPv4');
      assert.eq(encodeArpa('2001:db8::g').error, 'bad_ip', '编码非法 IPv6');
      assert.eq(encodeArpa(null).error, 'empty', '编码 null 不炸');

      /* ---- 往返 ---- */
      assert.eq(encodeArpa(decodeArpa('4.3.2.1.in-addr.arpa').ip).arpa, '4.3.2.1.in-addr.arpa', 'IPv4 往返');
      assert.eq(encodeArpa(decodeArpa('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa').ip).arpa,
        '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa', 'IPv6 往返');
      assert.eq(decodeArpa(encodeArpa('2001:db8::1').arpa).ip, '2001:db8::1', 'IPv6 往返（压缩形式）');
      // 32 个 nibble + 'ip6' + 'arpa' 两段
      assert(g(encodeArpa('2001:db8::1').arpa.split('.').length === 34), 'ARPA 名是 32 个 nibble 加后缀');
    }
  };
})();
