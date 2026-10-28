/* ==========================================================================
   PTR DNS 生成器（ptr-dns-generator）

   给一个 IP 地址算出反向 DNS 名，并拼出那条 PTR 记录：

       1.2.3.4       → 4.3.2.1.in-addr.arpa
       2001:db8::1   → 1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa

   参考实现：/data/work/it-tools2/src/tools/ptr-dns-generator/（it-tools, GPLv3），
   核心是上游的 src/utils/ip.ts 里的 toARPA()。上游那版改了五处：

   1. **名字带尾点**。上游两条路径都返回一个结尾有点的名字
      （4.3.2.1.in-addr.arpa. / …ip6.arpa.）。这个点在 zone 文件里是对的
      （表示绝对名），但它返回的是「给人填到 DNS 服务商后台主机名栏」的值 ——
      后台自己会补域名后缀，带着它多半变成两个点或者直接被拒。
      这里：主机名不带点，只有 zone 文件片段带点。
   2. **把异常当成结果显示**。上游的 Vue 组件 catch 住异常之后，
      把 `# AddressError: Bad characters detected in address: nop`
      这么一串 JS 错误写进结果框；空输入也一样（`new Address6('')` 会抛
      "Incorrect number of groups found"），末尾多个点的 IPv4
      （1.2.3.4.）同样会变成一串错误。这里：非法输入给一句人话，工具不抛异常。
   3. **只给反向名，不给记录**。上游输出的是「该建哪条记录的名字」，
      没有 PTR 的值、没有 `IN PTR <目标>` 那一行、也没有能粘的 zone 片段。
      这里：主机名、值、完整记录、zone 文件片段四段，各自带复制按钮。
   4. **两个 npm 依赖**。上游靠 is-ip 判断是不是 IPv4、靠 ip-address 生成
      IPv6 的反向名。本工具自己算，不引新库，也就不用动 manifest.tsv。
   5. **IPv6 的 32 个 nibble 是自己算的**。RFC 3596 要求反向名是
      **完整的 32 个 nibble、不压缩**（压缩写法 `::` 在 zone 文件里不合法）。
      上游这条对，是因为 ip-address 的 canonicalForm() 恰好把地址展开成
      8 组 4 位 —— 也就是说它对得很「巧」：谁要是顺手把 canonicalForm()
      换成 correctForm()（压缩形式），生成出来的就是废的。这里从解析出来的
      8 个组直接拼 32 个 nibble，压缩写法进不来。

   依赖：无。纯字符串计算。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('ptr-dns-generator');

  // IPv4 的合法性判断借用仓库里共用的那一份（两个 IPv4 工具共用同一套口径：
  // 四段、不允许前导零）
  var IP = window.ItTools.ip;
  var isValidIpv4 = IP.isValidIpv4;

  /* ======================================================================
     纯逻辑
     ====================================================================== */

  /** 去首尾空白。 */
  function nz(str) {
    return String(str == null ? '' : str).trim();
  }

  /**
   * 解析一段 IPv6 地址（`::` 左边或右边的一半）。
   *
   * @param {string} text 半边地址
   * @param {boolean} allowV4 这一半里允许出现点分十进制（IPv4 映射写法）
   * @returns {?number[]} 8 组里的若干个 16 位组；不合法给 null
   */
  function parseSide(text, allowV4) {
    if (text === '') return [];
    var parts = text.split(':');
    var groups = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      // 空组说明写成了 ":::" 或者结尾多一个冒号
      if (p === '') return null;
      if (p.indexOf('.') !== -1) {
        // 点分十进制只能出现在**整个地址的最后**（::ffff:1.2.3.4），
        // 而且只能有一处
        if (!allowV4 || i !== parts.length - 1) return null;
        if (!isValidIpv4(p)) return null;
        var b = p.split('.').map(Number);
        groups.push((b[0] << 8) | b[1]);
        groups.push((b[2] << 8) | b[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      groups.push(parseInt(p, 16));
    }
    return groups;
  }

  /**
   * IPv6 地址 → 8 个 16 位组。
   *
   * @param {string} str
   * @returns {?number[]} 8 个数；不合法给 null
   */
  function parseIpv6Groups(str) {
    var s = nz(str);
    if (!s) return null;
    // 带 zone id（fe80::1%eth0）的地址不是给 DNS 用的
    if (s.indexOf('%') !== -1) return null;

    var dpos = s.indexOf('::');
    var head, tail = null;
    if (dpos !== -1) {
      // 只能有一个 "::"
      if (s.indexOf('::', dpos + 1) !== -1) return null;
      head = s.slice(0, dpos);
      tail = s.slice(dpos + 2);
    } else {
      head = s;
    }

    var h = parseSide(head, false);
    if (!h) return null;
    var t2 = tail === null ? [] : parseSide(tail, true);
    if (!t2) return null;

    if (tail === null) {
      // 没有 "::"，那就得正好八组
      if (h.length !== 8) return null;
      return h;
    }

    // "::" 代表一组或多组全零，所以至少要能填上一组
    var need = 8 - h.length - t2.length;
    if (need < 1) return null;
    var groups = h.slice();
    for (var i = 0; i < need; i++) groups.push(0);
    return groups.concat(t2);
  }

  /**
   * IPv6 → 32 个 nibble 的十六进制串（不压缩）。
   * @param {string} str
   * @returns {?string} 32 位小写十六进制；不合法给 null
   */
  function ipv6Nibbles(str) {
    var groups = parseIpv6Groups(str);
    if (!groups) return null;
    var out = '';
    for (var i = 0; i < 8; i++) {
      var h = groups[i].toString(16);
      while (h.length < 4) h = '0' + h;
      out += h;
    }
    return out;
  }

  /**
   * 反向 DNS 名。
   *
   * zone 给的是**被委派出去的那一段**的名字：IPv4 按常规的 /24 委派
   * （前三段倒过来），IPv6 按 /32（头 8 个 nibble 倒过来）。
   * 真正的委派长度取决于 RIR 怎么切，这只是最常见的那一档。
   *
   * @param {string} ip
   * @returns {?{family: number, name: string, zone: string}}
   */
  function reverseName(ip) {
    var s = nz(ip);
    if (!s) return null;
    if (isValidIpv4(s)) {
      var parts = s.split('.');
      return {
        family: 4,
        // 四段倒过来
        name: parts.slice().reverse().join('.') + '.in-addr.arpa',
        zone: parts.slice(0, 3).reverse().join('.') + '.in-addr.arpa'
      };
    }
    var nib = ipv6Nibbles(s);
    if (!nib) return null;
    return {
      family: 6,
      // 32 个 nibble 逐个倒过来（RFC 3596）
      name: nib.split('').reverse().join('.') + '.ip6.arpa',
      zone: nib.slice(0, 8).split('').reverse().join('.') + '.ip6.arpa'
    };
  }

  /**
   * PTR 目标主机名归一化：去空白、去结尾的点、转小写。
   */
  function normalizeTarget(str) {
    return nz(str).replace(/\.+$/, '').toLowerCase();
  }

  /** 目标主机名是否像个主机名（允许下划线标签，空格/引号/分号不行）。 */
  function isValidTarget(str) {
    if (!str) return false;
    if (/[\s;"]/.test(str)) return false;
    var labels = str.split('.');
    return labels.every(function (label) {
      return label.length > 0 && label.length <= 63 &&
        /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/.test(label);
    });
  }

  /**
   * 生成 PTR 记录。
   *
   * @param {{ip: string, target: string}} opts
   * @returns {{ok: boolean, error: (?{code: string, params: object}),
   *            host: string, value: string, record: string, zone: string,
   *            notes: string[]}}
   */
  function buildPtr(opts) {
    opts = opts || {};
    var ip = nz(opts.ip);
    var target = normalizeTarget(opts.target);
    var notes = [];

    if (!ip) return fail('ip_required', '');

    var rev = reverseName(ip);
    if (!rev) return fail('ip_invalid', '');

    if (rev.family === 6) {
      notes.push(t('note_ipv6_full', 'The IPv6 reverse name uses all 32 nibbles, uncompressed: RFC 3596 requires it and the compressed form is not valid in a zone file.'));
    }
    notes.push(t('note_zone_owner', 'This record belongs to the {zone} zone (the usual /24 delegation for IPv4, /32 for IPv6), which is delegated to whoever holds the IP block - your host or the RIR. The domain registrar usually will not let you add it.')
      .replace('{zone}', function () { return rev.zone; }));

    if (!target) {
      var res = fail('target_required', rev.name);
      res.notes = notes;
      return res;
    }
    if (!isValidTarget(target)) {
      var res2 = fail('target_invalid', rev.name);
      res2.notes = notes;
      return res2;
    }

    return {
      ok: true,
      error: null,
      host: rev.name,
      value: target,
      record: rev.name + ' IN PTR ' + target,
      // zone 文件里的名字是绝对的：两个都带尾点
      zone: rev.name + '. IN PTR ' + target + '.',
      notes: notes
    };
  }

  /** 失败时的统一返回。host 有值就带上（IP 本身可能是好的）。 */
  function fail(code, host) {
    return {
      ok: false,
      error: { code: code, params: {} },
      host: host || '', value: '', record: '', zone: '',
      notes: []
    };
  }

  /**
   * 错误码 → 文案。
   *
   * 键必须是字符串字面量：Rust 侧扫的是源码里的 t('key', …)，
   * 拼出来的键它认不出来，语言包里也就查不到有没有这一条。
   */
  function errorMessage(code) {
    switch (code) {
      case 'ip_required':
        return t('err_ip_required', 'Please fill in an IP address.');
      case 'ip_invalid':
        return t('err_ip_invalid', 'That is not a valid IPv4 or IPv6 address.');
      case 'target_required':
        return t('err_target_required', 'Please fill in the hostname the PTR record points to.');
      case 'target_invalid':
        return t('err_target_invalid', 'That is not a valid hostname.');
      default:
        return t('err_unknown', 'The PTR record could not be generated.');
    }
  }

  /* ======================================================================
     界面
     ====================================================================== */

  window.ItTools.register('ptr-dns-generator', function (root) {
    var ipInput = D.h('input.layui-input', {
      type: 'text', value: '1.2.3.4', spellcheck: 'false',
      placeholder: t('ph_ip', 'e.g. 1.2.3.4 or 2001:db8::1')
    });
    var targetInput = D.h('input.layui-input', {
      type: 'text', value: 'mail.example.com', spellcheck: 'false',
      placeholder: t('ph_target', 'e.g. mail.example.com')
    });

    /**
     * 一行输出：标签 + 只读框 + 复制按钮。
     * 复制按钮带文字而不是图标 —— 上面一行行输出并排放着，
     * 光看图标分不清复制的是哪一段。
     */
    function outRow(label, copyLabel) {
      var box = D.h('input.layui-input', { type: 'text', readonly: true, spellcheck: 'false' });
      var node = D.h('div.field-row', {
        style: { '--field-label-width': '150px', '--field-label-align': 'right' }
      },
        D.h('label.field-label', { text: label }),
        box,
        U.copyButton(function () { return box.value; }, copyLabel)
      );
      return { box: box, node: node };
    }

    var hostRow = outRow(t('out_host', 'Reverse name'), t('copy_host', 'Copy name'));
    var valueRow = outRow(t('out_value', 'PTR value'), t('copy_value', 'Copy value'));
    var recordRow = outRow(t('out_record', 'Full record'), t('copy_record', 'Copy record'));

    // zone 文件片段用等宽块：IPv6 的反向名有七十多个字符，
    // 塞进一个输入框里只能横向拖着看。
    var zoneBlock = U.codeBlock();

    var status = D.h('p.form-status');
    var notesBox = D.h('div');

    var outCard = D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('out_title', 'Generated PTR record') })),
      hostRow.node,
      valueRow.node,
      recordRow.node,
      D.h('p.field-label', { text: t('out_zone', 'Zone file') }),
      zoneBlock.card,
      D.h('p.field-hint', {
        text: t('hint_zone', 'The zone file form ends the names with a dot, which is what makes them absolute.')
      }),
      status,
      notesBox
    );

    var inCard = D.h('div.card', null,
      U.field(t('label_ip', 'IP address (IPv4 or IPv6)'), ipInput, {
        wide: true,
        hint: t('hint_ip', 'The address to look up. IPv4 gives 4.3.2.1.in-addr.arpa, IPv6 gives the 32 nibbles under ip6.arpa.')
      }),
      U.field(t('label_target', 'PTR target hostname'), targetInput, {
        wide: true,
        hint: t('hint_target', 'The hostname the PTR record points to. It should have its own forward (A/AAAA) record.')
      })
    );

    function render() {
      var res = buildPtr({ ip: ipInput.value, target: targetInput.value });

      hostRow.box.value = res.host;
      valueRow.box.value = res.value;
      recordRow.box.value = res.record;
      zoneBlock.value = res.zone;

      if (res.error) {
        status.className = 'form-status is-error';
        status.textContent = errorMessage(res.error.code);
      } else {
        status.className = 'form-status';
        status.textContent = '';
      }

      D.clear(notesBox);
      res.notes.forEach(function (note) {
        notesBox.appendChild(D.h('p.field-hint', { text: note }));
      });
    }

    var offs = [];
    offs.push(D.on(ipInput, 'input', render));
    offs.push(D.on(targetInput, 'input', render));

    root.appendChild(inCard);
    root.appendChild(outCard);
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

  window.ItTools.logic['ptr-dns-generator'] = {
    parseSide: parseSide,
    parseIpv6Groups: parseIpv6Groups,
    ipv6Nibbles: ipv6Nibbles,
    reverseName: reverseName,
    normalizeTarget: normalizeTarget,
    isValidTarget: isValidTarget,
    buildPtr: buildPtr,
    errorMessage: errorMessage,
    __cases: function (assert) {
      /* ---- IPv6 解析 ---- */
      assert.eq(parseIpv6Groups('2001:db8::1'), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1], '基本写法');
      assert.eq(parseIpv6Groups('::'), [0, 0, 0, 0, 0, 0, 0, 0], '全零');
      assert.eq(parseIpv6Groups('::1'), [0, 0, 0, 0, 0, 0, 0, 1], '::1');
      assert.eq(parseIpv6Groups('1::'), [1, 0, 0, 0, 0, 0, 0, 0], '1::');
      assert.eq(parseIpv6Groups('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8], '八组齐全');
      assert.eq(parseIpv6Groups('1:2:3:4:5:6:7::'), [1, 2, 3, 4, 5, 6, 7, 0], '七个组加 ::');
      assert.eq(parseIpv6Groups('::ffff:192.168.1.1'),
        [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0101], 'IPv4 映射写法');
      assert.eq(parseIpv6Groups('2001:db8:0:0:0:0:0:1'), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1], '不用 :: 也能写');
      assert.eq(parseIpv6Groups('2001:db8::1::2'), null, '两个 ::');
      assert.eq(parseIpv6Groups('1:2:3:4:5:6:7'), null, '七组没有 ::');
      assert.eq(parseIpv6Groups('1:2:3:4:5:6:7:8:9'), null, '九组');
      assert.eq(parseIpv6Groups('1:2:3:4:5:6:7:8::'), null, ':: 前面已经满了');
      assert.eq(parseIpv6Groups(':1:2:3:4:5:6:7'), null, '开头的空组');
      assert.eq(parseIpv6Groups('1:2:3:4:5:6:7:'), null, '结尾多一个冒号');
      assert.eq(parseIpv6Groups('12345::1'), null, '一组超过四位');
      assert.eq(parseIpv6Groups('gggg::1'), null, '不是十六进制');
      assert.eq(parseIpv6Groups('1.2.3.4::'), null, 'IPv4 不能出现在 :: 前面');
      assert.eq(parseIpv6Groups('fe80::1%eth0'), null, '带 zone id 的不收');
      assert.eq(parseIpv6Groups(''), null, '空串');

      /* ---- 32 个 nibble ---- */
      assert.eq(ipv6Nibbles('2001:db8::1'), '20010db8000000000000000000000001', '展开成 32 位');
      assert.eq(ipv6Nibbles('2001:db8::1').length, 32, '正好 32 个 nibble');
      assert.eq(ipv6Nibbles('::'), '00000000000000000000000000000000', '全零也是 32 位');
      assert.eq(ipv6Nibbles('::1'), '00000000000000000000000000000001', '::1');
      assert.eq(ipv6Nibbles('nope'), null, '非法地址没有 nibble');

      /* ---- 反向名 ---- */
      assert.eq(reverseName('1.2.3.4').name, '4.3.2.1.in-addr.arpa', 'IPv4 反向名');
      assert.eq(reverseName('1.2.3.4').zone, '3.2.1.in-addr.arpa', 'IPv4 反向区（常规 /24 委派）');
      assert.eq(reverseName('1.2.3.4').family, 4, 'IPv4');
      assert.eq(reverseName('2001:db8::1').name,
        '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa',
        'IPv6 反向名：32 个 nibble 逐个倒过来');
      assert.eq(reverseName('2001:db8::1').zone, '8.b.d.0.1.0.0.2.ip6.arpa', 'IPv6 反向区（常规 /32 委派）');
      assert.eq(reverseName('2001:db8::1').family, 6, 'IPv6');
      assert.eq(reverseName('::1').name,
        '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa',
        '::1 的反向名');
      assert.eq(reverseName('nope'), null, '非法地址没有反向名');
      assert.eq(reverseName(''), null, '空地址没有反向名');
      assert.eq(reverseName('256.1.1.1'), null, '越界的 IPv4');

      /* ---- 目标主机名 ---- */
      assert.eq(normalizeTarget(' Mail.Example.com. '), 'mail.example.com', '去空白、去尾点、转小写');
      assert(isValidTarget('mail.example.com'), '普通主机名');
      assert(isValidTarget('my_host.example.com'), '下划线标签');
      assert(!isValidTarget('-bad.example.com'), '连字符开头');
      assert(!isValidTarget('bad label'), '有空格');
      assert(!isValidTarget('a"b'), '有引号');
      assert(!isValidTarget('a;b'), '有分号');

      /* ---- 记录生成 ---- */
      var p = buildPtr({ ip: '1.2.3.4', target: 'mail.example.com' });
      assert.eq(p.ok, true, '基本输入没问题');
      assert.eq(p.host, '4.3.2.1.in-addr.arpa', '反向名');
      assert.eq(p.value, 'mail.example.com', 'PTR 的值');
      assert.eq(p.record, '4.3.2.1.in-addr.arpa IN PTR mail.example.com', '完整记录');
      assert.eq(p.zone, '4.3.2.1.in-addr.arpa. IN PTR mail.example.com.', 'zone 文件：名字都带尾点');
      assert.eq(p.notes.length, 1, 'IPv4 只有「谁管这个区」那条提示');

      var p6 = buildPtr({ ip: '2001:db8::1', target: 'mail.example.com' });
      assert.eq(p6.host, '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa', 'IPv6 反向名');
      assert.eq(p6.record,
        '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa IN PTR mail.example.com',
        'IPv6 完整记录');
      assert.eq(p6.notes.length, 2, 'IPv6 多一条「32 个 nibble」的提示');
      assert(p6.notes[0].indexOf(t('note_ipv6_full', 'The IPv6 reverse name uses all 32 nibbles, uncompressed: RFC 3596 requires it and the compressed form is not valid in a zone file.')) !== -1,
        'IPv6 提示说的是 32 个 nibble');

      assert.eq(buildPtr({}).error.code, 'ip_required', '什么都没填');
      assert.eq(buildPtr({ ip: 'nope' }).error.code, 'ip_invalid', '地址不合法');
      assert.eq(buildPtr({ ip: '1.2.3.4' }).error.code, 'target_required', '缺目标');
      assert.eq(buildPtr({ ip: '1.2.3.4' }).host, '4.3.2.1.in-addr.arpa', '缺目标时反向名照样给');
      assert.eq(buildPtr({ ip: '1.2.3.4', target: 'bad host' }).error.code, 'target_invalid', '目标不合法');
      assert.eq(buildPtr({ ip: '1.2.3.4', target: '  ' }).error.code, 'target_required', '空白当没填');

      // 错误也有话说：不会静悄悄地给一个空结果
      assert(errorMessage('ip_invalid').length > 0, '错误码能翻出文案');
      assert(errorMessage('nope').length > 0, '未知错误码也有兜底文案');
    }
  };
})();
