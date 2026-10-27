/* ==========================================================================
   IPv4 地址转换器（ipv4-address-converter）

   把一个 IPv4 点分地址同时转成十进制、十六进制、二进制和两种 IPv6 写法，
   再补上 ARPA 反向名、6to4 前缀、CIDR 写法、IP 类别与 IANA 特殊用途类型。

   参考实现：src/tools/ipv4-address-converter/（it-tools, GPLv3）
   与原版的差别：
   1. 原版的 ipv4ToInt() 在地址非法时返回 0，而 0.0.0.0 本身是个合法地址，
      于是「填错」和「填 0.0.0.0」变得无法区分。这里改成返回 null。
   2. 原版用一条正则 /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/ 判合法性。
      这条正则是对的，但可读性差、依赖 \b 的位置技巧。这里改成显式拆四段，
      判定结果与原正则逐字符等价（已用随机串对拍过，唯一差别是两边都会先 trim）。
   3. 原版（PR #969 之后）补的「更多 IP 信息」里有几处是错的，这里修掉了：
      - 6to4 前缀把 IPv4 地址拆成四个单字节写进 IPv6（2002:01:0:1:01:01::/48），
        6to4 明明是 2002::/16 后面跟整个 32 位地址，正确写法是 2002:c0a8:0101::/48；
      - 组播被登记成 224.0.0.0/24，IANA 登记的是 224.0.0.0/4；
      - 特殊用途类型按「表里最后一条命中的」算，不是最长前缀匹配。
      详见 static/js/app.js 里 ItTools.ip 的注释。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('ipv4-address-converter');

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

  /**
   * 把非负整数转成指定进制的字符串。
   * 只服务 2/16 两种进制：IPv4 转出来的值最大 4294967295，远在 double 的
   * 精确整数范围内，不必像参考实现那样为它引入 BigInt。
   */
  function toBase(num, base) {
    if (!num) return '0';
    var digits = '0123456789abcdef';
    var out = '';
    for (var n = num; n > 0; n = Math.floor(n / base)) out = digits[n % base] + out;
    return out;
  }

  /**
   * IPv4 → IPv6 的 IPv4 映射写法（RFC 4291）。
   * 参考实现默认展开成 0000:0000:...:ffff:xxxx:xxxx，
   * 「short」只是把前缀换成 ::ffff:，不做 RFC 5952 的零压缩，这里沿用该行为。
   */
  function ipv4ToIpv6(ip, prefix) {
    if (!isValidIpv4(ip)) return '';
    var bytes = ip.trim().split('.').map(function (part) {
      return Number(part).toString(16).padStart(2, '0');
    });
    return (prefix === undefined ? '0000:0000:0000:0000:0000:ffff:' : prefix) +
      bytes.join('').match(/.{4}/g).join(':');
  }

  /**
   * 主函数：一次算出全部转换结果。
   *
   * label 是界面上的显示名，走 i18n；id 是稳定的内部标识（不随语言变），
   * 断言按 id 查值 —— 见 __cases 里的 byId。
   * @param {string} ip
   * @returns {{id: string, label: string, value: string}[]} 非法时返回空数组
   */
  function convertAll(ip) {
    var num = ipv4ToInt(ip);
    if (num === null) return [];
    return [
      { id: 'decimal', label: t('decimal', 'Decimal'), value: String(num) },
      { id: 'hexadecimal', label: t('hexadecimal', 'Hexadecimal'), value: toBase(num, 16).toUpperCase() },
      { id: 'binary', label: t('binary', 'Binary'), value: toBase(num, 2) },
      { id: 'ipv6', label: t('ipv6', 'IPv6'), value: ipv4ToIpv6(ip) },
      { id: 'ipv6_short', label: t('ipv6_short', 'IPv6 (short)'), value: ipv4ToIpv6(ip, '::ffff:') },
      { id: 'ipv6_decimal', label: t('ipv6_decimal', 'IPv6 (decimal)'), value: IP.toMappedDecimal(ip) },
      { id: 'sixtofour', label: t('sixtofour', '6to4 prefix'), value: IP.to6to4Prefix(ip) },
      { id: 'cidr_notation', label: t('cidr_notation', 'CIDR notation'), value: ip.trim() + '/32' },
      { id: 'arpa', label: t('arpa', 'ARPA'), value: IP.toArpa(ip) },
      { id: 'ip_class', label: t('ip_class', 'IP class'), value: IP.getIpClass(ip) },
      { id: 'type', label: t('type', 'Type'), value: typeLabel(IP.getType(ip)) }
    ];
  }

  window.ItTools.register('ipv4-address-converter', function (root) {
    var input = D.h('input.layui-input', {
      type: 'text', value: '192.168.1.1', spellcheck: 'false',
      placeholder: t('input_ph', 'The ipv4 address...')
    });
    var output = D.h('div.field.kv-rows');

    function row(label, value) {
      var box = D.h('input.layui-input', { type: 'text', readonly: true, value: value });
      // 原版是 input-copyable：标签在左、**100px**、右对齐，
      // 复制图标是输入框的 suffix。
      // 原版的标签文案自带一个冒号（'Decimal: ' / 'Ipv6 (short): '…），
      // 这里补上，免得渲染出来跟原版差一个冒号。
      return D.h('div.field-row', {
        style: { '--field-label-width': '100px', '--field-label-align': 'right' }
      },
        D.h('label.field-label', { text: label + ':' }),
        box,
        U.copyButton(function () { return box.value; })
      );
    }

    function render() {
      D.clear(output);
      var rows = convertAll(input.value);
      if (!rows.length) {
        output.appendChild(D.h('p.field-hint', { text: t('err_invalid', 'Set a correct ipv4 address') }));
        return;
      }
      rows.forEach(function (r) { output.appendChild(row(r.label, r.value)); });
    }

    input.addEventListener('input', render);

    // 原版这一页没有卡片外壳：输入框、分隔线、结果行直接排在正文里
    root.appendChild(D.h('div', null,
      U.field(t('input', 'The ipv4 address:'), input, { hint: t('input_hint', 'e.g. 192.168.1.1, no prefix and no port') }),
      U.divider(),
      output
    ));
    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['ipv4-address-converter'] = {
    convertAll: convertAll,
    isValidIpv4: isValidIpv4,
    ipv4ToInt: ipv4ToInt,
    intToIpv4: intToIpv4,
    ipv4ToIpv6: ipv4ToIpv6,
    typeLabel: typeLabel,
    TYPE_LABELS: TYPE_LABELS,
    __cases: function (assert) {
      // 与参考实现的 vitest 用例一致
      assert.eq(ipv4ToInt('192.168.0.1'), 3232235521, '192.168.0.1');
      assert.eq(ipv4ToInt('10.0.0.1'), 167772161, '10.0.0.1');
      assert.eq(ipv4ToInt('255.255.255.255'), 4294967295, '全 1');
      assert.eq(ipv4ToInt('0.0.0.0'), 0, '全 0');

      ['192.168.0.1', '10.0.0.1', '0.0.0.0', '255.255.255.255', ' 192.168.0.1 '].forEach(function (ip) {
        assert(isValidIpv4(ip), '应合法：' + ip);
      });
      ['256.168.0.1', '192.168.0', '192.168.0.1.2', '192.168.0.1.', '.192.168.0.1',
        '192.168.0.a', '', ' ', 'foo', '-1', '0', '01.2.3.4', '1.2.3.04'].forEach(function (ip) {
        assert(!isValidIpv4(ip), '应非法：' + JSON.stringify(ip));
      });

      // 非法地址不再悄悄变成 0.0.0.0
      assert.eq(ipv4ToInt('256.168.0.1'), null, '非法输入返回 null');

      assert.eq(intToIpv4(3232235521), '192.168.0.1', 'intToIpv4 往返');
      assert.eq(intToIpv4(4294967295), '255.255.255.255', 'intToIpv4 上界');

      // label 现在是翻译过的显示名，断言一律按稳定的 id 查
      var byId = {};
      convertAll('192.168.0.1').forEach(function (r) { byId[r.id] = r.value; });
      assert.eq(byId.decimal, '3232235521', '十进制');
      assert.eq(byId.hexadecimal, 'C0A80001', '十六进制');
      assert.eq(byId.binary, '11000000101010000000000000000001', '二进制');
      assert.eq(byId.ipv6, '0000:0000:0000:0000:0000:ffff:c0a8:0001', 'IPv6 全展开');
      assert.eq(byId.ipv6_short, '::ffff:c0a8:0001', 'IPv6 短写');
      assert.eq(convertAll('nope'), [], '非法输入没有输出');

      // --- 更多 IP 信息（上游 PR #969）---

      var byId2 = {};
      convertAll('192.168.1.1').forEach(function (r) { byId2[r.id] = r.value; });
      assert.eq(byId2.ipv6_decimal, '::ffff:192.168.1.1', 'IPv6 点分写法');
      assert.eq(byId2.sixtofour, '2002:c0a8:0101::/48', '6to4 前缀（整个 32 位地址）');
      assert.eq(byId2.cidr_notation, '192.168.1.1/32', 'CIDR 写法');
      assert.eq(byId2.arpa, '1.1.168.192.in-addr.arpa', 'ARPA 反向名');
      assert.eq(byId2.ip_class, 'C', 'IP 类别');
      assert.eq(byId2.type, 'Private Use', '私有地址的类型');

      // ARPA 是四段倒过来
      assert.eq(IP.toArpa('1.1.1.1'), '1.1.1.1.in-addr.arpa', 'ARPA（1.1.1.1）');
      assert.eq(IP.toArpa('10.10.1.1'), '1.1.10.10.in-addr.arpa', 'ARPA（10.10.1.1）');
      assert.eq(IP.toArpa('255.255.255.0'), '0.255.255.255.in-addr.arpa', 'ARPA（255.255.255.0）');
      assert.eq(IP.toArpa('nope'), '', '非法地址没有 ARPA');

      // 映射地址的两种写法是同一个地址
      assert.eq(IP.toMappedHex('192.168.1.1'), '::ffff:c0a8:0101', '映射地址（十六进制）');
      assert.eq(IP.toMappedHex('1.1.1.1'), '::ffff:0101:0101', '映射地址（1.1.1.1）');
      assert.eq(IP.toMappedHex('255.255.255.0'), '::ffff:ffff:ff00', '映射地址（255.255.255.0）');
      assert.eq(IP.toMappedDecimal('172.18.10.9'), '::ffff:172.18.10.9', '映射地址（点分）');
      assert.eq(IP.toMappedDecimal('nope'), '', '非法地址没有映射地址');

      // 6to4：2002::/16 后面跟整个 32 位地址
      assert.eq(IP.to6to4Prefix('1.1.1.1'), '2002:0101:0101::/48', '6to4（1.1.1.1）');
      assert.eq(IP.to6to4Prefix('10.10.1.1'), '2002:0a0a:0101::/48', '6to4（10.10.1.1）');
      assert.eq(IP.to6to4Prefix('172.18.10.9'), '2002:ac12:0a09::/48', '6to4（172.18.10.9）');
      assert.eq(IP.to6to4Prefix('255.255.255.0'), '2002:ffff:ff00::/48', '6to4（255.255.255.0）');
      assert.eq(IP.to6to4Prefix('nope'), '', '非法地址没有 6to4 前缀');

      // IANA 特殊用途类型（最长前缀匹配）
      assert.eq(IP.getType('1.1.1.1').kind, 'public', '公网地址');
      assert.eq(IP.getType('10.10.1.1').kind, 'private_use', '10/8 私有');
      assert.eq(IP.getType('172.16.0.1').kind, 'private_use', '172.16/12 私有');
      assert.eq(IP.getType('192.168.1.1').kind, 'private_use', '192.168/16 私有');
      assert.eq(IP.getType('127.0.0.1').kind, 'loopback', '回环');
      assert.eq(IP.getType('169.254.0.1').kind, 'link_local', '链路本地');
      assert.eq(IP.getType('100.64.0.1').kind, 'shared_address_space', '共享地址空间');
      assert.eq(IP.getType('0.0.0.0').kind, 'this_host', '本网络内的本机');
      assert.eq(IP.getType('192.0.0.1').kind, 'ietf_protocol_assignments', 'IETF 协议分配');
      assert.eq(IP.getType('192.0.2.1').kind, 'documentation_testnet1', 'TEST-NET-1');
      assert.eq(IP.getType('198.51.100.1').kind, 'documentation_testnet2', 'TEST-NET-2');
      assert.eq(IP.getType('203.0.113.1').kind, 'documentation_testnet3', 'TEST-NET-3');
      assert.eq(IP.getType('198.18.0.1').kind, 'benchmarking', '基准测试');
      assert.eq(IP.getType('224.0.0.1').kind, 'multicast', '组播');
      // 上游把组播登记成 224.0.0.0/24，IANA 登记的是 224.0.0.0/4
      assert.eq(IP.getType('224.0.1.1').kind, 'multicast', '组播不止 224.0.0.0/24');
      assert.eq(IP.getType('239.1.2.3').kind, 'multicast', '组播上界');
      assert.eq(IP.getType('240.0.0.1').kind, 'reserved', '保留');
      assert.eq(IP.getType('255.255.255.255').kind, 'limited_broadcast', '受限广播');
      assert.eq(IP.getType('255.255.255.0').kind, 'reserved', '255.255.255.0 属于保留段');
      assert.eq(IP.getType('nope'), null, '非法地址没有类型');

      // 类型名：语言包里翻不到时退回登记表的英文
      assert.eq(typeLabel(IP.getType('192.168.1.1')), 'Private Use', '类型文案');
      assert.eq(typeLabel(null), '', '没有类型就没有文案');

      // 登记表里的英文跟本工具的兜底文案必须一致（语言包是照着代码生成的）
      IP.registry.forEach(function (entry) {
        assert.eq(TYPE_LABELS[entry.kind], entry.name, '登记表与文案对不上：' + entry.kind);
      });
    }
  };
})();
