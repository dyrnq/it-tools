/* ==========================================================================
   IPv4 子网计算器（ipv4-subnet-calculator）

   输入一个 IPv4（可带 /24 或点分掩码 255.255.255.0），列出网络地址、掩码、
   通配符掩码、可用主机数、首末地址和广播地址，并能在相邻子网之间翻页。
   另外补上 ARPA 反向名、IPv4 映射地址、6to4 前缀、IANA 特殊用途类型，
   以及「这一层里能切出哪几个子网」。

   参考实现：src/tools/ipv4-subnet-calculator/（it-tools, GPLv3）
   原版用 netmask 这个第三方库算块信息，这里全部自己实现（纯位运算），
   对齐 netmask 的取值约定，另外补上原版没给的「可用主机数」。
   与原版的差别：
   1. 原版的 Network size 一栏填的是块内地址总数，却叫「大小」；
      这里保留这一项（叫 Block size）并另加 Usable hosts，避免歧义。
   2. 原版的 netmask 库接受 /33 这类非法前缀时报错时机很靠后（前缀为 0 时
      0xffffffff << 32 的结果依赖 JS 的移位溢出），这里显式限定 0~32。
   3. 原版（PR #969 之后）补的「子网列表」有两个 bug：前缀是 8 的倍数时
      直接返回空列表（最常见的 /24 会显示「0 个子网」），而且列表从当前块
      的地址起算、不是从父网段的地址起算（/20 会列到父网段外面去）。
      详见下面 subnetBlocks() 的注释。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('ipv4-subnet-calculator');

  // 共用的换算与 IANA 登记表放在 app.js 里，两个 IPv4 工具用同一份
  var IP = window.ItTools.ip;
  var isValidIpv4 = IP.isValidIpv4;
  var ipv4ToInt = IP.ipv4ToInt;
  var intToIpv4 = IP.intToIpv4;

  /**
   * IANA 特殊用途地址的类型名。
   * 键是登记表里的 kind，文案走语言包；语言包里没有的退回英文兜底。
   */
  var TYPE_LABELS = {
    this_host: t('type_this_host', 'This host on this network'),
    private_use: t('type_private_use', 'Private Use'),
    shared_address_space: t('type_shared_address_space', 'Shared Address Space'),
    loopback: t('type_loopback', 'Loopback'),
    link_local: t('type_link_local', 'Link Local'),
    ietf_protocol_assignments: t('type_ietf_protocol_assignments', 'IETF Protocol Assignments'),
    documentation_testnet1: t('type_documentation_testnet1', 'Documentation (TEST-NET-1)'),
    documentation_testnet2: t('type_documentation_testnet2', 'Documentation (TEST-NET-2)'),
    documentation_testnet3: t('type_documentation_testnet3', 'Documentation (TEST-NET-3)'),
    benchmarking: t('type_benchmarking', 'Benchmarking'),
    multicast: t('type_multicast', 'Multicast'),
    reserved: t('type_reserved', 'Reserved'),
    limited_broadcast: t('type_limited_broadcast', 'Limited Broadcast'),
    public: t('type_public', 'Public')
  };

  /** 类型名：语言包里有就翻，没有就退回登记表里的英文。 */
  function typeLabel(entry) {
    if (!entry) return '';
    return TYPE_LABELS[entry.kind] || entry.name || entry.kind;
  }

  /** /24 与 255.255.255.0 都接受；前缀限 0~32。 */
  function parseMask(mask) {
    if (mask === undefined || mask === null || mask === '') return 32;
    var text = String(mask).trim();
    if (text.indexOf('.') !== -1) {
      var long = ipv4ToInt(text);
      if (long === null) return null;
      // 掩码必须是一串 1 后接一串 0，否则不是合法掩码
      var binary = long.toString(2).padStart(32, '0');
      if (/01/.test(binary)) return null;
      return binary.indexOf('0') === -1 ? 32 : binary.indexOf('0');
    }
    if (!/^\d{1,2}$/.test(text)) return null;
    var prefix = Number(text);
    return prefix >= 0 && prefix <= 32 ? prefix : null;
  }

  /**
   * 父网段的前缀长度：按字节对齐的那一层。
   *
   * 前缀 p 的地址落在 8 × floor(p / 8) 这一层的网段里（p < 8 时就是 /0），
   * 那一层就是它的「父网段」。父网段被切成 2^(p − 父前缀) 个同样大小的块，
   * 这些块就是「子网」：
   *   /24 → 父网段是 /24 自己 → 1 块
   *   /25 → 父网段是 /24      → 2 块
   *   /11 → 父网段是 /8       → 8 块
   */
  function parentPrefix(prefix) {
    return Math.floor(prefix / 8) * 8;
  }

  /** 这一层里能切出几个同样大小的块。 */
  function subnetCount(prefix) {
    return Math.pow(2, prefix - parentPrefix(prefix));
  }

  /**
   * 把父网段切成同样大小的块。
   *
   * 从**父网段的**网络地址起算 —— 从当前块的地址起算的话，
   * 列表会一路列到父网段外面去（/20 会有 4 块跑到 /16 之外）。
   *
   * 上游（it-tools PR #969）这里有两条 bug：前缀是 8 的倍数时返回空列表
   * （/24 这种最常见的输入会显示「0 个子网」），以及上面说的起算点不对。
   *
   * @param {number} address 地址的 32 位整数
   * @param {number} prefix 前缀长度
   * @returns {string[]} 形如 ['192.168.0.0/24']
   */
  function subnetBlocks(address, prefix) {
    var parent = parentPrefix(prefix);
    var parentNet = (address & IP.mask(parent)) >>> 0;
    var step = Math.pow(2, 32 - prefix);
    var out = [];
    for (var i = 0; i < subnetCount(prefix); i++) {
      out.push(intToIpv4(parentNet + i * step) + '/' + prefix);
    }
    return out;
  }

  /**
   * 主函数：算出一个 IP（带掩码）的全部子网信息。
   * @param {string} input 例如 "192.168.0.1/24" / "192.168.0.1/255.255.255.0" / "192.168.0.1"
   * @returns {?object} 解析不了返回 null
   */
  function calculateSubnet(input) {
    if (typeof input !== 'string') return null;
    var text = input.trim();
    if (!text) return null;

    var parts = text.split('/');
    if (parts.length > 2) return null;
    if (!isValidIpv4(parts[0])) return null;

    var prefix = parseMask(parts[1]);
    if (prefix === null) return null;

    var addrText = parts[0];
    var address = ipv4ToInt(addrText);
    var maskLong = IP.mask(prefix);
    var hostBits = 32 - prefix;
    var size = Math.pow(2, hostBits);
    var networkLong = (address & maskLong) >>> 0;

    // /31 与 /32 没有「网络地址 + 广播地址」之分，首末地址就是全部地址
    var isSingleOrPair = prefix >= 31;

    return {
      input: text,
      address: intToIpv4(address),
      prefixLength: prefix,
      cidr: intToIpv4(networkLong) + '/' + prefix,
      networkAddress: intToIpv4(networkLong),
      netmask: intToIpv4(maskLong),
      netmaskBinary: toMaskDottedBinary(maskLong),
      wildcardMask: intToIpv4(~maskLong >>> 0),
      blockSize: size,
      // /31 算 2 个点对点地址，/32 算 1 个，都不扣掉网络/广播两个地址
      usableHosts: isSingleOrPair ? size : size - 2,
      firstHost: intToIpv4(isSingleOrPair ? networkLong : networkLong + 1),
      lastHost: intToIpv4(isSingleOrPair ? networkLong + size - 1 : networkLong + size - 2),
      broadcast: isSingleOrPair ? null : intToIpv4(networkLong + size - 1),
      ipClass: IP.getIpClass(addrText),
      // 这一层里的兄弟块
      subnetsCount: subnetCount(prefix),
      subnets: subnetBlocks(address, prefix),
      // 「更多 IP 信息」用的是**用户填的地址**，不是归一后的网络地址
      arpa: IP.toArpa(addrText),
      mappedAddress: IP.toMappedHex(addrText),
      mappedAddressDecimal: IP.toMappedDecimal(addrText),
      sixtofour: IP.to6to4Prefix(addrText),
      type: typeLabel(IP.getType(addrText))
    };
  }

  /** 掩码的二进制写法，按字节点分，例如 11111111.11111111.11111111.00000000。 */
  function toMaskDottedBinary(maskLong) {
    return maskLong.toString(2).padStart(32, '0').match(/.{8}/g).join('.');
  }

  /**
   * 相邻的第 count 个子网（count 为 ±1 时就是上/下一块）。
   * 已经走到头（越出 0.0.0.0~255.255.255.255）时返回 null，
   * 免得像参考实现那样用移位溢出把地址绕回 0。
   */
  function neighborSubnet(input, count) {
    var info = calculateSubnet(input);
    if (!info) return null;
    var networkLong = ipv4ToInt(info.networkAddress);
    var next = networkLong + info.blockSize * count;
    if (next < 0 || next > 0xffffffff) return null;
    // blockSize 是 2 的幂且 networkLong 已按它对齐，next 必然还是块首地址
    return intToIpv4(next) + '/' + info.prefixLength;
  }

  /** 展示用的行列表，UI 和逻辑共用一份顺序。 */
  var SECTIONS = [
    { label: t('netmask', 'Netmask'), get: function (i) { return i.cidr; } },
    { label: t('network_address', 'Network address'), get: function (i) { return i.networkAddress; } },
    { label: t('network_mask', 'Network mask'), get: function (i) { return i.netmask; } },
    { label: t('network_mask_binary', 'Network mask in binary'), get: function (i) { return i.netmaskBinary; } },
    { label: t('cidr_notation', 'CIDR notation'), get: function (i) { return '/' + i.prefixLength; } },
    { label: t('wildcard_mask', 'Wildcard mask'), get: function (i) { return i.wildcardMask; } },
    { label: t('block_size', 'Block size'), get: function (i) { return i.blockSize.toLocaleString('en-US'); } },
    { label: t('usable_hosts', 'Usable hosts'), get: function (i) { return i.usableHosts.toLocaleString('en-US'); } },
    { label: t('subnets_count', 'Subnets count'), get: function (i) { return i.subnetsCount.toLocaleString('en-US'); } },
    { label: t('subnets', 'Subnets'), get: function (i) { return i.subnets.join(', '); } },
    { label: t('first_address', 'First address'), get: function (i) { return i.firstHost; } },
    { label: t('last_address', 'Last address'), get: function (i) { return i.lastHost; } },
    { label: t('broadcast_address', 'Broadcast address'), get: function (i) { return i.broadcast; }, fallback: t('no_broadcast', 'No broadcast address with this mask') },
    { label: t('arpa', 'ARPA'), get: function (i) { return i.arpa; } },
    { label: t('mapped_address', 'IPv4 Mapped Address'), get: function (i) { return i.mappedAddress; } },
    { label: t('mapped_address_decimal', 'IPv4 Mapped Address (decimal)'), get: function (i) { return i.mappedAddressDecimal; } },
    { label: t('sixtofour', '6to4 prefix'), get: function (i) { return i.sixtofour; } },
    { label: t('ip_class', 'IP class'), get: function (i) { return i.ipClass; }, fallback: t('unknown_class', 'Unknown class type') },
    { label: t('type', 'Type'), get: function (i) { return i.type; } }
  ];

  window.ItTools.register('ipv4-subnet-calculator', function (root) {
    var input = D.h('input.layui-input', {
      type: 'text', value: '192.168.0.1/24', spellcheck: 'false', placeholder: t('input_ph', 'The ipv4 address...')
    });
    var output = D.h('div');
    var nav = D.h('div.form-actions');

    function render() {
      D.clear(output);
      D.clear(nav);

      var info = calculateSubnet(input.value);
      if (!info) {
        output.appendChild(D.h('p.field-hint', { text: t('err_parse', 'We cannot parse this address, check the format') }));
        return;
      }

      var tbody = D.h('tbody');
      SECTIONS.forEach(function (section) {
        var value = section.get(info);
        var cell = value === null || value === undefined
          ? D.h('td', { style: { opacity: '.7' }, text: section.fallback || '' })
          : D.h('td.val', { text: String(value) });
        tbody.appendChild(D.h('tr', null,
          D.h('td', { text: section.label }),
          cell
        ));
      });
      output.appendChild(D.h('table.kv-table', null, tbody));

      function step(count) {
        var next = neighborSubnet(input.value, count);
        if (!next) return;
        input.value = next;
        render();
      }
      nav.appendChild(D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button', text: t('previous_block', 'Previous block'), onclick: function () { step(-1); }
      }));
      nav.appendChild(D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button', text: t('next_block', 'Next block'), onclick: function () { step(1); }
      }));
    }

    input.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'An IPv4 address with or without mask:'), input, {
        hint: t('input_hint', 'Accepts 192.168.0.1/24, 192.168.0.1/255.255.255.0 or no mask at all')
      }),
      output,
      nav
    ));
    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['ipv4-subnet-calculator'] = {
    calculateSubnet: calculateSubnet,
    parseMask: parseMask,
    neighborSubnet: neighborSubnet,
    getIpClass: IP.getIpClass,
    parentPrefix: parentPrefix,
    subnetCount: subnetCount,
    subnetBlocks: subnetBlocks,
    typeLabel: typeLabel,
    TYPE_LABELS: TYPE_LABELS,
    __cases: function (assert) {
      var n = calculateSubnet('192.168.0.1/24');
      assert.eq(n.cidr, '192.168.0.0/24', 'CIDR 归一到网络地址');
      assert.eq(n.networkAddress, '192.168.0.0', '网络地址');
      assert.eq(n.netmask, '255.255.255.0', '子网掩码');
      assert.eq(n.netmaskBinary, '11111111.11111111.11111111.00000000', '掩码二进制');
      assert.eq(n.wildcardMask, '0.0.0.255', '通配符掩码');
      assert.eq(n.blockSize, 256, '块大小');
      assert.eq(n.usableHosts, 254, '可用主机数');
      assert.eq(n.firstHost, '192.168.0.1', '首个可用地址');
      assert.eq(n.lastHost, '192.168.0.254', '末个可用地址');
      assert.eq(n.broadcast, '192.168.0.255', '广播地址');
      assert.eq(n.ipClass, 'C', 'IP 类别');

      // 点分掩码与前缀等价
      assert.eq(calculateSubnet('192.168.0.1/255.255.255.0').cidr, '192.168.0.0/24', '点分掩码');
      assert.eq(parseMask('255.255.255.0'), 24, '掩码转前缀');
      assert.eq(parseMask('255.255.255.255'), 32, '全 1 掩码');
      assert.eq(parseMask('0.0.0.0'), 0, '全 0 掩码');
      assert.eq(parseMask(''), 32, '缺省即 /32');
      assert.eq(parseMask('255.0.255.0'), null, '不连续的掩码非法');
      assert.eq(parseMask('33'), null, '前缀越界');
      assert.eq(parseMask('-1'), null, '负前缀非法');

      // 边界：/0 与 /32 不能崩
      var zero = calculateSubnet('10.20.30.40/0');
      assert.eq(zero.cidr, '0.0.0.0/0', '/0 网络地址');
      assert.eq(zero.netmask, '0.0.0.0', '/0 掩码');
      assert.eq(zero.blockSize, 4294967296, '/0 块大小');
      assert.eq(zero.usableHosts, 4294967294, '/0 可用主机数');
      assert.eq(zero.broadcast, '255.255.255.255', '/0 广播地址');
      assert.eq(zero.lastHost, '255.255.255.254', '/0 末个可用地址');

      var full = calculateSubnet('10.20.30.40/32');
      assert.eq(full.cidr, '10.20.30.40/32', '/32 归一');
      assert.eq(full.netmask, '255.255.255.255', '/32 掩码');
      assert.eq(full.blockSize, 1, '/32 块大小');
      assert.eq(full.usableHosts, 1, '/32 可用主机数');
      assert.eq(full.firstHost, '10.20.30.40', '/32 首地址');
      assert.eq(full.lastHost, '10.20.30.40', '/32 末地址');
      assert.eq(full.broadcast, null, '/32 没有广播地址');

      // /31 点对点
      var pair = calculateSubnet('10.0.0.0/31');
      assert.eq(pair.usableHosts, 2, '/31 两个地址都可用');
      assert.eq(pair.firstHost, '10.0.0.0', '/31 首地址');
      assert.eq(pair.lastHost, '10.0.0.1', '/31 末地址');
      assert.eq(pair.broadcast, null, '/31 没有广播地址');

      // 不带掩码等价于 /32
      assert.eq(calculateSubnet('8.8.8.8').cidr, '8.8.8.8/32', '不带掩码');

      // 类别划分
      assert.eq(IP.getIpClass('10.0.0.1'), 'A', 'A 类');
      assert.eq(IP.getIpClass('172.16.0.1'), 'B', 'B 类');
      assert.eq(IP.getIpClass('192.168.0.1'), 'C', 'C 类');
      assert.eq(IP.getIpClass('224.0.0.1'), 'D', 'D 类');
      assert.eq(IP.getIpClass('240.0.0.1'), 'E', 'E 类');
      assert.eq(IP.getIpClass('nope'), null, '非法地址没有类别');

      // 非法输入
      ['', '   ', 'foo', '192.168.0.256', '192.168.0', '192.168.0.1/33', '192.168.0.1/abc',
        '192.168.0.1/24/24'].forEach(function (bad) {
        assert.eq(calculateSubnet(bad), null, '应拒绝：' + JSON.stringify(bad));
      });

      // 上下块
      assert.eq(neighborSubnet('192.168.0.1/24', 1), '192.168.1.0/24', '下一块');
      assert.eq(neighborSubnet('192.168.0.1/24', -1), '192.167.255.0/24', '上一块');
      assert.eq(neighborSubnet('0.0.0.0/8', -1), null, '走到 0 之前停住');
      assert.eq(neighborSubnet('255.255.255.255/8', 1), null, '越过 255.255.255.255 停住');
      assert.eq(neighborSubnet('bogus', 1), null, '非法输入没有邻居');

      // --- 兄弟块（上游 PR #969 的「Subnets」）---

      // 父网段是按字节对齐的那一层
      assert.eq(parentPrefix(0), 0, '/0 的父网段是 /0');
      assert.eq(parentPrefix(1), 0, '/1 的父网段是 /0');
      assert.eq(parentPrefix(8), 8, '/8 的父网段是 /8');
      assert.eq(parentPrefix(11), 8, '/11 的父网段是 /8');
      assert.eq(parentPrefix(24), 24, '/24 的父网段是 /24');
      assert.eq(parentPrefix(25), 24, '/25 的父网段是 /24');
      assert.eq(parentPrefix(32), 32, '/32 的父网段是 /32');

      // 前缀是 8 的倍数时，父网段就是它自己 —— 有 1 块，不是 0 块
      // （上游在这里返回空列表，最常见的 /24 会显示「0 个子网」）
      assert.eq(subnetCount(24), 1, '/24 有 1 个兄弟块');
      assert.eq(subnetCount(8), 1, '/8 有 1 个兄弟块');
      assert.eq(subnetCount(16), 1, '/16 有 1 个兄弟块');
      assert.eq(subnetCount(32), 1, '/32 有 1 个兄弟块');
      assert.eq(subnetCount(25), 2, '/25 有 2 个兄弟块');
      assert.eq(subnetCount(26), 4, '/26 有 4 个兄弟块');
      assert.eq(subnetCount(11), 8, '/11 有 8 个兄弟块');
      assert.eq(subnetCount(1), 2, '/1 有 2 个兄弟块');
      assert.eq(subnetCount(0), 1, '/0 有 1 个兄弟块');
      assert.eq(subnetCount(7), 128, '/7 有 128 个兄弟块');

      assert.eq(calculateSubnet('192.168.0.1/24').subnets.join(', '), '192.168.0.0/24', '/24 只有自己');
      assert.eq(calculateSubnet('192.168.0.1/25').subnets.join(', '),
        '192.168.0.0/25, 192.168.0.128/25', '/25 切成两块');
      assert.eq(calculateSubnet('172.16.2.2/26').subnets.join(', '),
        '172.16.2.0/26, 172.16.2.64/26, 172.16.2.128/26, 172.16.2.192/26', '/26 切成四块');
      assert.eq(calculateSubnet('1.1.1.1/11').subnets.join(', '),
        '1.0.0.0/11, 1.32.0.0/11, 1.64.0.0/11, 1.96.0.0/11, ' +
        '1.128.0.0/11, 1.160.0.0/11, 1.192.0.0/11, 1.224.0.0/11', '/11 在 /8 里切成 8 块');
      assert.eq(calculateSubnet('1.1.1.1/1').subnets.join(', '), '0.0.0.0/1, 128.0.0.0/1', '/1 切成两块');

      // 从**父网段**的地址起算，不会列到父网段外面去
      var twenty = calculateSubnet('10.20.30.40/20');
      assert.eq(twenty.subnets.length, 16, '/20 在 /16 里切成 16 块');
      assert.eq(twenty.subnets[0], '10.20.0.0/20', '/20 的头一块在父网段开头');
      assert.eq(twenty.subnets[15], '10.20.240.0/20', '/20 的末一块在父网段结尾');

      // --- 更多 IP 信息 ---

      var info = calculateSubnet('192.168.0.1/24');
      assert.eq(info.arpa, '1.0.168.192.in-addr.arpa', 'ARPA 用的是用户填的地址');
      assert.eq(info.mappedAddress, '::ffff:c0a8:0001', '映射地址（十六进制）');
      assert.eq(info.mappedAddressDecimal, '::ffff:192.168.0.1', '映射地址（点分）');
      assert.eq(info.sixtofour, '2002:c0a8:0001::/48', '6to4 前缀');
      assert.eq(info.type, 'Private Use', 'IANA 类型');

      // 登记表里的英文跟本工具的兜底文案必须一致（语言包是照着代码生成的）
      IP.registry.forEach(function (entry) {
        assert.eq(TYPE_LABELS[entry.kind], entry.name, '登记表与文案对不上：' + entry.kind);
      });
    }
  };
})();
