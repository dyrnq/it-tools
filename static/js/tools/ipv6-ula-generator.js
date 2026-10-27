/* ==========================================================================
   IPv6 ULA 生成器（ipv6-ula-generator）

   按 RFC 4193 的第一种方法，用「当前时间戳 + MAC 地址」做 SHA-1，
   取摘要低 40 位作为 Prefix ID，生成一条 /48 的 ULA（fc00::/7，固定取 fd）。

   参考实现：src/tools/ipv6-ula-generator/（it-tools, GPLv3）
   与原版的两处差别：
   1. 原版用 crypto-js 算 SHA-1。这里自己实现了一份（几十行，标准算法），
      原因是 crypto.subtle.digest 只在**安全上下文**里有 —— 这个工具通常
      自建在局域网 IP + 明文 HTTP 上，那时 window.crypto.subtle 是 undefined，
      WebCrypto 这条路直接不通。自己算就到处都能跑。
   2. 原版的 MAC 校验正则 `/^([0-9A-Fa-f]{2}[:-]){2,5}([0-9A-Fa-f]{2})$/`
      允许 3~6 组，所以 `aa:bb:cc` 也算「合法 MAC 地址」，照样能算出一串
      ULA。MAC 地址是定长 6 字节，这里收紧成正好 6 组，并额外接受 Cisco
      的点分三位写法（aabb.ccdd.eeff）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('ipv6-ula-generator');

  /* ---------- SHA-1（FIPS 180-4），同步实现 ---------- */

  /** 32 位循环左移 */
  function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) | 0; }

  /**
   * 算 UTF-8 字符串的 SHA-1，返回 40 位小写十六进制串。
   *
   * 自己写而不是用 crypto.subtle.subtle.digest()：后者只在 HTTPS 或 localhost
   * 下存在（安全上下文要求），而这类自托管工具经常就架在明文 HTTP 的内网 IP 上，
   * 那时 crypto.subtle 整个是 undefined。
   */
  function sha1Hex(message) {
    var bytes = U.utf8Bytes(String(message));
    var ml = bytes.length;
    // 补 1 字节 0x80，再补到 56 mod 64，最后 8 字节存 64 位比特长度（大端）
    var total = ((ml + 8) >> 6 << 6) + 64;
    var buf = new Uint8Array(total);
    buf.set(bytes);
    buf[ml] = 0x80;
    var view = new DataView(buf.buffer);
    // 本函数只处理短输入，高 32 位恒为 0，但仍然按大端写满以免以后误用
    view.setUint32(total - 8, Math.floor(ml / 0x20000000), false);
    view.setUint32(total - 4, (ml << 3) >>> 0, false);

    var h0 = 0x67452301, h1 = 0xEFCDAB89 | 0, h2 = 0x98BADCFE | 0,
        h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var w = new Int32Array(80);
    var off, i, a, b, c, d, e, f, k, temp;

    for (off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4, false);
      for (i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

      a = h0; b = h1; c = h2; d = h3; e = h4;
      for (i = 0; i < 80; i++) {
        if (i < 20)      { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d;            k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else             { f = b ^ c ^ d;            k = 0xCA62C1D6; }
        temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = temp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
      h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }

    return [h0, h1, h2, h3, h4]
      .map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); })
      .join('');
  }

  /* ---------- MAC 地址 ---------- */

  var MAC_COLON = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
  var MAC_DASH = /^([0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}$/;
  var MAC_DOT = /^([0-9A-Fa-f]{4}\.){2}[0-9A-Fa-f]{4}$/;

  /** 严格校验：必须正好 6 字节（见文件头「与原版的差别 2」）。 */
  function isValidMac(value) {
    var s = String(value == null ? '' : value).trim();
    return MAC_COLON.test(s) || MAC_DASH.test(s) || MAC_DOT.test(s);
  }

  /** 归一成 12 位小写十六进制（去掉分隔符）。 */
  function normalizeMac(value) {
    return String(value == null ? '' : value).trim().replace(/[:-]/g, '').replace(/\./g, '').toLowerCase();
  }

  /* ---------- ULA 生成 ---------- */

  /**
   * 由 MAC 与时间戳算出 ULA 前缀。
   * @param {string} mac   MAC 地址
   * @param {number} timestamp 毫秒时间戳
   * @returns {string} 形如 fdab:cdef:1234 的 48 位前缀（不含 /48）
   */
  function buildUlaPrefix(mac, timestamp) {
    if (!isValidMac(mac)) throw new Error('不是合法的 MAC 地址：' + mac);
    if (!isFinite(timestamp)) throw new Error('时间戳无效：' + timestamp);
    // 取 SHA-1 十六进制摘要的**低 40 位**（最后 10 个字符），前置 fd 定 /8
    var low40 = sha1Hex(timestamp + normalizeMac(mac)).substring(30);
    return 'fd' + low40.substring(0, 2) + ':' + low40.substring(2, 6) + ':' + low40.substring(6);
  }

  /**
   * 算出展示用的各段。
   *
   * label 是界面上的显示名，走 i18n；id 是稳定的内部标识（不随语言变），
   * 断言按 id 查值 —— 见 __cases 里的 byId。
   * @returns {Array<{id:string, label:string, value:string}>}
   */
  function computeSections(mac, timestamp) {
    var ula = buildUlaPrefix(mac, timestamp);
    return [
      { id: 'ula', label: t('ula', 'IPv6 ULA'), value: ula + '::/48' },
      { id: 'first_block', label: t('first_block', 'First routable block'), value: ula + ':0::/64' },
      { id: 'last_block', label: t('last_block', 'Last routable block'), value: ula + ':ffff::/64' }
    ];
  }

  window.ItTools.register('ipv6-ula-generator', function (root) {
    var macInput = D.h('input.layui-input', {
      value: '20:37:06:12:34:56',
      placeholder: t('input_ph', 'Type a MAC address')
    });
    var output = D.h('div');
    var status = D.h('p.field-hint');
    var timer = null;

    function render() {
      D.clear(output);
      var mac = macInput.value.trim();
      var ok = isValidMac(mac);
      macInput.classList.toggle('is-error', !ok && mac.length > 0);
      status.textContent = ok ? '' : (mac ? t('err_invalid_mac', 'Invalid MAC address') : '');
      if (!ok) return;
      var ts = new Date().getTime();
      computeSections(mac, ts).forEach(function (section) {
        // 原版这三行是 InputCopyable：标签在左、160px、右对齐，复制图标在框里
        output.appendChild(D.h('div.field-row', { style: { '--field-label-width': '160px' } },
          D.h('label.field-label', { text: section.label + ':' }),
          D.h('input.layui-input', { value: section.value, readonly: 'readonly' }),
          U.copyButton(function () { return section.value; })
        ));
      });
    }

    var off = D.on(macInput, 'input', function () {
      // 去抖：连打 MAC 时不必每敲一个字符都算一次 SHA-1
      if (timer) clearTimeout(timer);
      timer = setTimeout(render, 200);
    });
    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    // 原版这一页没有卡片外壳：n-alert（Info）→ c-input-text（标签在上）→ 三行结果
    root.appendChild(D.h('div.card', null,
      U.alert('info', t('alert_title', 'Info'), t('hint', 'Uses the first method suggested by IETF: the current timestamp plus the MAC address, SHA-1 hashed, taking the lower 40 bits as the ULA prefix.')),
      U.field(t('input', 'MAC address:'), macInput, { wide: true }),
      status,
      output
    ));
    render();

    return {
      destroy: function () {
        off();
        if (timer) { clearTimeout(timer); timer = null; }
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['ipv6-ula-generator'] = {
    sha1Hex: sha1Hex,
    isValidMac: isValidMac,
    normalizeMac: normalizeMac,
    buildUlaPrefix: buildUlaPrefix,
    computeSections: computeSections,
    __cases: function (assert) {
      // --- SHA-1：标准测试向量 ---
      assert.eq(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709', '空串');
      assert.eq(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d', '"abc"');
      assert.eq(sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
                '84983e441c3bd26ebaae4aa1f95129e5e54670f1', '56 字节（跨块边界）');
      assert.eq(sha1Hex('a'.repeat(1000000)), '34aa973cd4c4daa4f61eeb2bdbad27316534016f', '100 万个 a（补位跨上万块）');
      assert.eq(sha1Hex('中文测试'), sha1Hex('中文测试'), 'UTF-8 幂等');
      assert(sha1Hex('中文测试') !== sha1Hex('abc'), '多字节输入走的是 UTF-8 分支');

      // 跨 64 字节块边界的补位是 SHA-1 最容易错的地方
      assert.eq(sha1Hex('a'.repeat(55)), 'c1c8bbdc22796e28c0e15163d20899b65621d65a', '55 字节（恰好填满一块）');
      assert.eq(sha1Hex('a'.repeat(56)), 'c2db330f6083854c99d4b5bfb6e8f29f201be699', '56 字节（触发补块）');
      assert.eq(sha1Hex('a'.repeat(63)), '03f09f5b158a7a8cdad920bddc29b81c18a551f5', '63 字节');
      assert.eq(sha1Hex('a'.repeat(64)), '0098ba824b5c16427bd7a1122a5a442a25ec644d', '64 字节（整块）');
      assert.eq(sha1Hex('a'.repeat(65)), '11655326c708d70319be2610e8a57d9a5b959d3b', '65 字节（进第二块）');

      // --- MAC 校验：原版会放行 aa:bb:cc，这里不放行 ---
      assert(isValidMac('20:37:06:12:34:56'), '冒号分隔 6 组');
      assert(isValidMac('20-37-06-12-34-56'), '横线分隔 6 组');
      assert(isValidMac('2037.0612.3456'), 'Cisco 点分');
      assert(isValidMac('  20:37:06:12:34:56  '), '首尾空白容忍');
      assert(!isValidMac('aa:bb:cc'), '只有 3 组 —— 原版会误判为合法');
      assert(!isValidMac('aa:bb:cc:dd:ee:ff:00'), '7 组，超长');
      assert(!isValidMac('20:37:06:12:34'), '5 组');
      assert(!isValidMac('zz:37:06:12:34:56'), '非十六进制');
      assert(!isValidMac(''), '空串');
      assert(!isValidMac(null), 'null');

      assert.eq(normalizeMac('20:37:06:12:34:56'), '203706123456', '归一化去分隔符');
      assert.eq(normalizeMac('2037.0612.3456'), '203706123456', '点分也归一');
      assert.eq(normalizeMac('AA:BB:CC:DD:EE:FF'), 'aabbccddeeff', '小写化');

      // --- ULA 前缀 ---
      var p = buildUlaPrefix('20:37:06:12:34:56', 1700000000000);
      assert(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}$/.test(p), '形如 fdXX:XXXX:XXXX：' + p);
      assert.eq(p.substring(0, 2), 'fd', '前 8 位固定为 fd（ULA 不含全局路由的 fc00::/7 落在 fd..ff）');

      // 与时间戳和 MAC 都有关：任一变化都要换前缀
      var a = buildUlaPrefix('20:37:06:12:34:56', 1700000000000);
      var b = buildUlaPrefix('20:37:06:12:34:56', 1700000000001);
      var c = buildUlaPrefix('20:37:06:12:34:57', 1700000000000);
      assert(a !== b, '时间戳不同 -> 不同前缀');
      assert(a !== c, 'MAC 不同 -> 不同前缀');

      // 同一个输入必须完全确定
      assert.eq(buildUlaPrefix('aa:bb:cc:dd:ee:ff', 1700000000000),
                buildUlaPrefix('AA-BB-CC-DD-EE-FF', 1700000000000),
                '分隔符/大小写不影响结果');

      // 低 40 位确实取自摘要末尾
      var digest = sha1Hex('1700000000000' + '203706123456');
      assert.eq(p.replace(/:/g, '').substring(2), digest.substring(30), '前缀 = fd + 摘要低 40 位');

      // 三段地址
      var sections = computeSections('20:37:06:12:34:56', 1700000000000);
      assert.eq(sections.length, 3, '三段');
      // label 现在是翻译过的显示名，断言一律按稳定的 id 查
      var byId = {};
      sections.forEach(function (s) { byId[s.id] = s.value; });
      assert.eq(byId.ula, p + '::/48', '/48 本体');
      assert.eq(byId.first_block, p + ':0::/64', '第一段可路由');
      assert.eq(byId.last_block, p + ':ffff::/64', '最后一段可路由');
      assert(byId.first_block < byId.last_block, '第一段确实排在最后一段之前');

      // 非法输入必须抛错
      var threw = false;
      try { buildUlaPrefix('nope', 1700000000000); } catch (e) { threw = true; }
      assert(threw, '非法 MAC 抛错');
      threw = false;
      try { buildUlaPrefix('20:37:06:12:34:56', NaN); } catch (e) { threw = true; }
      assert(threw, '非法时间戳抛错');
    }
  };
})();