/* ==========================================================================
   SPF DNS 记录生成器（spf-dns-generator）

   填一张表 → 出一条能直接贴进 DNS 的 SPF TXT 记录（记录名 + 值 + zone 片段）。

   ---- 上游那版是什么 ----
   sharevb/it-tools2 的 spf-dns-generator.vue：naive-ui 的 n-dynamic-tags 四个
   「允许来源」列表（a: 域名 / IPv4 / IPv6 / include: 域名）、五个机制复选框
   （a / mx / ptr / exists / redirect）、四个策略单选（+all / -all / ~all / ?all），
   输出只有一个裸记录串 —— 连记录名都没有。

   ---- 差在哪（以及为什么）----
   1. **上游的 `exists` / `ptr` 不带取值**：RFC 7208 §5.7、§5.8 要求写成
      `exists:<domain-spec>` / `ptr:<domain-spec>`。上游的复选框只给出一个
      `exists` —— 那是语法错误（permerror），整条记录直接作废，
      比不配还糟。这一版把它们挪进「其它机制」里手填完整项，缺值的一律拒收。
   2. **上游的 `redirect` 是三个错叠在一起**：它把 redirect 当成机制
      （RFC 7208 §6.1 说的是「修饰符」）、拼的时候**漏了等号**
      （拼出 `redirect` 而不是 `redirect=example.com`）、位置还排在 `all` 前面。
      RFC 7208 §6.1 明确：出现 redirect 就**不能**再有 all，同时出现是
      permerror。这一版把 redirect 做成单独的字段，永远排在最后，
      一旦填了就自动去掉 all。
   3. **上游允许空项**：n-dynamic-tags 能塞空串，于是能拼出 `a:` 这种
      语法错误。这一版每个取值都要过一遍校验，不合格的既不进记录也不进 zone
      片段，只进提示（不抛异常）。
   4. **上游只给记录值，不给记录名**：SPF 要挂在域名自己身上
      （`example.com`，不是随便哪个名字）。这一版把记录名、完整记录串、
      zone 文件片段一起给出来。
   5. 上游不校验 IP、不管 255 字节上限、不管 RFC 7208 §4.6.4 的
      「最多 10 次 DNS 查询」—— 这一版都补上了。

   ---- 依赖 ----
   纯字符串拼装：不查 DNS、不发请求、不要外部库。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('spf-dns-generator');

  /* ======================================================================
     纯逻辑
     ====================================================================== */

  /** 非空才返回值，否则空串。 */
  function nz(str) {
    var s = String(str == null ? '' : str).trim();
    return s ? s : '';
  }

  /** 域名归一化：去首尾空白、去尾点、转小写。 */
  function fqdn(str) {
    return nz(str).replace(/\.+$/, '').toLowerCase();
  }

  /** 逗号 / 换行 / 空白分隔的列表 → 去掉空项的数组。 */
  function splitItems(str) {
    return String(str == null ? '' : str)
      .split(/[\s,]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s; });
  }

  /** 逗号 / 换行分隔的「机制项」列表（机制项内部可能带空格，不按空格切）。 */
  function splitTerms(str) {
    return String(str == null ? '' : str)
      .split(/[\n,]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s; });
  }

  /** UTF-8 字节数（DNS 的 255 字节上限按字节算，不按字符算）。 */
  function byteLen(str) {
    return U.utf8Bytes(String(str == null ? '' : str)).length;
  }

  /** 单个码点的 UTF-8 字节数。 */
  function codePointBytes(ch) {
    var cp = ch.codePointAt(0);
    if (cp < 0x80) return 1;
    if (cp < 0x800) return 2;
    if (cp < 0x10000) return 3;
    return 4;
  }

  /**
   * 把过长的 TXT 值按 255 字节切成几段。
   *
   * DNS 的一个 character-string 最长 255 字节，超了必须拆成多条字符串，
   * 解析方会把它们按顺序拼起来 —— 所以从哪儿切都不影响还原出来的值。
   * 切点优先落在 "; " 之后：一段里装的是完整的标签，比切成半个标签体面。
   * 切不开也没关系（DKIM 的 p= 就是这么长，只能从中间切）。
   */
  function splitTxt(value, limit) {
    limit = limit || 255;
    var rest = String(value == null ? '' : value);
    var out = [];
    while (rest.length) {
      if (byteLen(rest) <= limit) { out.push(rest); break; }
      // 找不超过 limit 字节的最长前缀（按码点走，不劈开代理对）
      var chars = Array.from(rest);
      var cut = 0, bytes = 0;
      for (var i = 0; i < chars.length; i++) {
        var b = codePointBytes(chars[i]);
        if (bytes + b > limit) break;
        bytes += b;
        cut += chars[i].length;
      }
      if (cut <= 0) cut = chars[0].length;   // 兜底：至少切掉一个字符
      var head = rest.slice(0, cut);
      var sep = head.lastIndexOf('; ');
      if (sep > 0) cut = sep + 2;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return out;
  }

  /** IPv4（可带 /prefix）。 */
  function isIpv4(str) {
    var m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\/(\d{1,2}))?$/.exec(nz(str));
    if (!m) return false;
    var parts = m[1].split('.');
    for (var i = 0; i < 4; i++) {
      if (!/^(0|[1-9]\d{0,2})$/.test(parts[i]) || Number(parts[i]) > 255) return false;
    }
    if (m[2] !== undefined && Number(m[2]) > 32) return false;
    return true;
  }

  /**
   * IPv6（可带 /prefix）。
   *
   * 只做「形状」检查，不做完整的地址解析 —— 完整解析要处理 IPv4 映射、
   * 各种缩写形式，收益不大而代码长。这里能挡掉的是「明显不是 IPv6」的输入
   * （漏冒号、十六进制位超 4 位、组数不对）。
   */
  function isIpv6(str) {
    var m = /^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/.exec(nz(str));
    if (!m) return false;
    if (m[2] !== undefined && Number(m[2]) > 128) return false;
    var body = m[1];
    if (body.indexOf(':') < 0) return false;
    var dbl = body.indexOf('::');
    if (dbl !== body.lastIndexOf('::')) return false;   // 至多一处 ::
    var head = dbl < 0 ? body : body.slice(0, dbl);
    var tail = dbl < 0 ? '' : body.slice(dbl + 2);
    var groups = (head ? head.split(':') : []).concat(tail ? tail.split(':') : []);
    var count = 0;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (g.indexOf('.') >= 0) {
        // 末尾可以是 IPv4 形式（::ffff:192.0.2.1）
        if (i !== groups.length - 1 || !isIpv4(g)) return false;
        count += 2;
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
      count++;
    }
    if (dbl < 0) return count === 8;
    return count <= 7;   // '::' 至少压缩掉一组
  }

  /**
   * domain-spec 的形状检查。
   *
   * 关键不是「是不是合法域名」，而是「会不会把记录串拆坏」：
   * 空白、分号、冒号、等号、引号一旦混进去，SPF 记录就废了。
   * 宏（%{i}.example.com）这种带花括号的允许存在。
   */
  function isDomainish(str) {
    var s = nz(str);
    if (!s) return false;
    return !/[\s;:"'=\\]/.test(s);
  }

  /**
   * 手填的机制项。
   *
   * value: 'required' 必须带取值 / 'optional' 取值可省（省了就是域名自己）
   * lookup: 该机制要不要消耗一次 DNS 查询（RFC 7208 §4.6.4 的 10 次上限）
   */
  var MECH = {
    a: { value: 'optional', kind: 'domain', lookup: true },
    mx: { value: 'optional', kind: 'domain', lookup: true },
    ptr: { value: 'required', kind: 'domain', lookup: true },
    exists: { value: 'required', kind: 'domain', lookup: true },
    include: { value: 'required', kind: 'domain', lookup: true },
    ip4: { value: 'required', kind: 'ipv4', lookup: false },
    ip6: { value: 'required', kind: 'ipv6', lookup: false }
  };

  /**
   * 检查一条手填的机制项。
   * @returns {{ok: boolean, reason?: string, lookup?: boolean}}
   */
  function checkTerm(term) {
    var s = nz(term);
    if (!s) return { ok: false, reason: 'syntax' };
    if (/[\s;]/.test(s)) return { ok: false, reason: 'syntax' };
    // 修饰符（带等号）：目前只有 redirect，而它是专门字段的事
    if (s.indexOf('=') >= 0) {
      return { ok: false, reason: /^redirect=/i.test(s) ? 'redirect' : 'syntax' };
    }
    // 光秃秃一个 redirect（没有等号）也是同一类错 —— 指到专门的字段上去
    if (/^redirect$/i.test(s)) return { ok: false, reason: 'redirect' };
    // 限定符：+ / - / ~（RFC 7208 §4.2）。`?` 只在 all 上有意义，不接受。
    var qual = '';
    if (/^[+\-~]/.test(s)) { qual = s.charAt(0); s = s.slice(1); }
    var colon = s.indexOf(':');
    var name = (colon < 0 ? s : s.slice(0, colon)).toLowerCase();
    var value = colon < 0 ? '' : s.slice(colon + 1);
    var spec = MECH[name];
    if (!spec) return { ok: false, reason: 'syntax' };
    if (spec.value === 'required' && !nz(value)) return { ok: false, reason: 'syntax' };
    // 取值可省（a / mx 省略就是域名自己）时，没填就不做取值检查
    if (nz(value)) {
      if (spec.kind === 'domain' && !isDomainish(value)) return { ok: false, reason: 'syntax' };
      if (spec.kind === 'ipv4' && !isIpv4(value)) return { ok: false, reason: 'syntax' };
      if (spec.kind === 'ipv6' && !isIpv6(value)) return { ok: false, reason: 'syntax' };
    }
    return { ok: true, lookup: spec.lookup, qualifier: qual };
  }

  /**
   * 生成 SPF 记录。
   *
   * @param {object} opts
   *   domain    记录挂在哪个域名上
   *   aDomains  允许的域名（a:）
   *   ipv4      允许的 IPv4（ip4:）
   *   ipv6      允许的 IPv6（ip6:）
   *   includes  交出去的域名（include:）
   *   ownA      放行域名自己的 A 记录
   *   ownMx     放行域名自己的 MX 记录
   *   custom    其它机制，一行一个
   *   redirect  redirect= 的目标
   *   all       结尾的 all 项
   * @returns {{name: string, value: string, full: string, zone: string, notes: string[]}}
   */
  function buildSpf(opts) {
    opts = opts || {};
    var terms = [];
    var notes = [];
    var bad = [];
    var lookups = 0;

    splitItems(opts.aDomains).forEach(function (d) {
      if (!isDomainish(d)) { bad.push('a:' + d); return; }
      terms.push('a:' + d); lookups++;
    });
    splitItems(opts.ipv4).forEach(function (ip) {
      if (!isIpv4(ip)) { bad.push('ip4:' + ip); return; }
      terms.push('ip4:' + ip);
    });
    splitItems(opts.ipv6).forEach(function (ip) {
      if (!isIpv6(ip)) { bad.push('ip6:' + ip); return; }
      terms.push('ip6:' + ip);
    });
    splitItems(opts.includes).forEach(function (d) {
      if (!isDomainish(d)) { bad.push('include:' + d); return; }
      terms.push('include:' + d); lookups++;
    });
    if (opts.ownA) { terms.push('a'); lookups++; }
    if (opts.ownMx) { terms.push('mx'); lookups++; }

    var redirectInCustom = false;
    splitTerms(opts.custom).forEach(function (term) {
      var r = checkTerm(term);
      if (r.ok) {
        terms.push(term);
        if (r.lookup) lookups++;
      } else if (r.reason === 'redirect') {
        redirectInCustom = true;
      } else {
        bad.push(term);
      }
    });

    var redirect = nz(opts.redirect);
    if (redirect) {
      if (!isDomainish(redirect)) { bad.push('redirect=' + redirect); redirect = ''; }
      else lookups++;   // redirect 自己也要查一次 DNS
    }

    var all = nz(opts.all);
    if (!/^[+?~-]all$/.test(all)) all = '~all';

    // v= 永远第一个，项之间一个空格，末尾不留空格
    var value = 'v=spf1';
    if (terms.length) value += ' ' + terms.join(' ');
    if (redirect) {
      value += ' redirect=' + redirect;
    } else {
      value += ' ' + all;
    }

    var name = fqdn(opts.domain);

    /* ---- 提示（只提示，不抛异常） ---- */
    if (bad.length) {
      notes.push(t('note_bad_values', 'Left out because the syntax is wrong or a value is missing: {list}')
        .replace('{list}', function () { return bad.join(', '); }));
    }
    if (redirectInCustom) {
      notes.push(t('note_redirect_in_custom', 'redirect is not a mechanism but a modifier: fill in the "Redirect to" field instead, it is put at the end and replaces the all term'));
    }
    if (!terms.length) {
      notes.push(t('note_no_mechanism', 'No mechanism is listed: this record authorizes nobody, it only states the policy'));
    }
    if (lookups > 10) {
      notes.push(t('note_too_many_lookups', 'This record has {count} mechanisms that need a DNS query, RFC 7208 allows at most 10')
        .replace('{count}', function () { return String(lookups); }));
    }
    if (all === '+all') {
      notes.push(t('note_plus_all', '+all authorizes every sender: it is the same as not setting SPF at all'));
    }
    if (all === '~all') {
      notes.push(t('note_softfail', '~all only marks the mail, it does not reject it: switch to -all once the configuration is confirmed'));
    }
    var bytes = byteLen(value);
    if (bytes > 255) {
      notes.push(t('note_too_long', 'The record value is {bytes} bytes, over the 255-byte limit of a single DNS string: the zone snippet below is already split into several strings, most DNS panels split it for you')
        .replace('{bytes}', function () { return String(bytes); }));
    }
    if (!name) {
      notes.push(t('note_no_domain', 'Fill in the domain to get the name of the record'));
    }

    return {
      name: name,
      value: value,
      full: name ? name + '. IN TXT "' + value + '"' : '',
      zone: name ? zoneBlock(name, value, t('zone_comment', 'SPF record for {domain}')
        .replace('{domain}', function () { return name; })) : '',
      notes: notes
    };
  }

  /** zone 文件里的一条 TXT 记录（过长时拆成多个字符串）。 */
  function zoneLine(name, value) {
    var parts = splitTxt(value);
    var txt = parts.length > 1
      ? '( "' + parts.join('" "') + '" )'
      : '"' + parts[0] + '"';
    return fqdn(name) + '. IN TXT ' + txt;
  }

  /** zone 文件片段：一行注释 + 一条记录。注释里的占位符在调用处替换。 */
  function zoneBlock(name, value, comment) {
    return String(comment) + '\n' + zoneLine(name, value);
  }

  /* ======================================================================
     UI
     ====================================================================== */

  var ALL_OPTIONS = [
    { value: '-all', label: t('all_fail', '-all (fail: reject the mail outright)') },
    { value: '~all', label: t('all_softfail', '~all (softfail: mark it, but do not reject)') },
    { value: '?all', label: t('all_neutral', '?all (neutral: leave the decision to the recipient)') },
    { value: '+all', label: t('all_pass', '+all (pass: the same as not setting SPF at all)') }
  ];

  window.ItTools.register('spf-dns-generator', function (root) {
    function textField(label, value, hint) {
      var el = D.h('input.layui-input', { type: 'text', value: value, spellcheck: 'false' });
      return { el: el, node: U.field(label, el, { wide: true, hint: hint }) };
    }
    function areaField(label, value, hint, rows) {
      var el = D.h('textarea.layui-textarea', { rows: rows || 2, spellcheck: 'false' });
      el.value = value;
      return { el: el, node: U.field(label, el, { wide: true, hint: hint }) };
    }
    function selectField(label, options, value, hint) {
      var el = D.h('select.layui-select', null, options.map(function (o) {
        return D.h('option', { value: o.value, text: o.label });
      }));
      el.value = value;
      return { el: el, node: U.field(label, el, { wide: true, hint: hint }) };
    }

    /* ---- 输入 ---- */
    var fDomain = textField(t('label_domain', 'Domain'), 'example.com',
      t('hint_domain', 'The domain the SPF record is published on: it sits on the domain itself, e.g. example.com'));
    var fADomains = areaField(t('label_allowed_domains', 'Allowed domains (a:)'), '',
      t('hint_allowed_domains', 'Comma separated. a:example.com allows the IPs in the A record of example.com'));
    var fIpv4 = areaField(t('label_allowed_ipv4', 'Allowed IPv4 addresses (ip4:)'), '',
      t('hint_allowed_ipv4', 'Comma separated. A CIDR suffix is allowed, e.g. 192.0.2.0/24'));
    var fIpv6 = areaField(t('label_allowed_ipv6', 'Allowed IPv6 addresses (ip6:)'), '',
      t('hint_allowed_ipv6', 'Comma separated. A CIDR suffix is allowed, e.g. 2001:db8::/32'));
    var fInclude = areaField(t('label_include_domains', 'Included domains (include:)'), '',
      t('hint_include_domains', 'Comma separated. include: delegates to the SPF record of the other side, e.g. _spf.google.com'));

    var ownA = D.h('input', { type: 'checkbox' });
    var ownMx = D.h('input', { type: 'checkbox' });
    var ownBox = D.h('div.switch-grid', null,
      D.h('label.switch', null, ownA, D.h('span', { text: t('opt_mech_a', 'a: the A record of the domain itself') })),
      D.h('label.switch', null, ownMx, D.h('span', { text: t('opt_mech_mx', 'mx: the MX records of the domain itself') }))
    );

    var fCustom = areaField(t('label_other_mechanisms', 'Other mechanisms'), '',
      t('hint_other_mechanisms', 'One term per line, e.g. exists:%{i}.example.com or ptr:example.com. exists and ptr must carry a value'), 3);
    var fRedirect = textField(t('label_redirect', 'Redirect to (redirect=)'), '',
      t('hint_redirect', 'Leave it empty unless the whole policy is delegated elsewhere: RFC 7208 forbids redirect and all at the same time'));
    var fAll = selectField(t('label_policy', 'Policy for everyone else (all)'), ALL_OPTIONS, '~all',
      t('hint_policy', 'Only this term decides what happens to the senders that are not listed'));

    var inputCard = D.h('div.card', null,
      D.h('p.field-hint', { text: t('desc', 'SPF declares which hosts may send mail for your domain. Fill in the allowed sources, then publish the record on the domain itself.') }),
      fDomain.node,
      fADomains.node,
      fIpv4.node,
      fIpv6.node,
      fInclude.node,
      ownBox,
      fCustom.node,
      fRedirect.node,
      fAll.node
    );

    /* ---- 输出 ---- */
    var outName = D.h('input.layui-input', { type: 'text', readonly: 'readonly', spellcheck: 'false' });
    var outValue = D.h('textarea.layui-textarea', { rows: 3, readonly: 'readonly', spellcheck: 'false' });
    var outFull = D.h('input.layui-input', { type: 'text', readonly: 'readonly', spellcheck: 'false' });
    var outZone = D.h('textarea.layui-textarea', { rows: 4, readonly: 'readonly', spellcheck: 'false' });
    var notesBox = D.h('div');

    var outputCard = D.h('div.card', null,
      U.field(t('label_record_name', 'Record name'), outName, { wide: true }),
      U.field(t('label_record_value', 'Record value (TXT)'), outValue, { wide: true }),
      U.field(t('label_full_record', 'Full record'), outFull, { wide: true }),
      U.field(t('label_zone', 'Zone file snippet'), outZone, { wide: true }),
      notesBox,
      D.h('div.form-actions', null,
        U.copyButton(function () { return outName.value; }, t('copy_name', 'Copy name')),
        U.copyButton(function () { return outValue.value; }, t('copy_value', 'Copy value')),
        U.copyButton(function () { return outFull.value; }, t('copy_full', 'Copy full record')),
        U.copyButton(function () { return outZone.value; }, t('copy_zone', 'Copy zone file'))
      )
    );

    function render() {
      var rec = buildSpf({
        domain: fDomain.el.value,
        aDomains: fADomains.el.value,
        ipv4: fIpv4.el.value,
        ipv6: fIpv6.el.value,
        includes: fInclude.el.value,
        ownA: ownA.checked,
        ownMx: ownMx.checked,
        custom: fCustom.el.value,
        redirect: fRedirect.el.value,
        all: fAll.el.value
      });
      outName.value = rec.name;
      outValue.value = rec.value;
      outFull.value = rec.full;
      outZone.value = rec.zone;
      D.clear(notesBox);
      rec.notes.forEach(function (n) {
        notesBox.appendChild(D.h('p.field-hint', { text: n }));
      });
    }

    // 事件委托挂在 root 上：input / change 都触发重算
    var offInput = D.on(root, 'input', render);
    var offChange = D.on(root, 'change', render);

    root.appendChild(inputCard);
    root.appendChild(outputCard);
    render();

    return {
      destroy: function () {
        offInput();
        offChange();
        D.clear(root);
      }
    };
  });

  /* ======================================================================
     导出与自测
     ====================================================================== */

  window.ItTools.logic['spf-dns-generator'] = {
    fqdn: fqdn,
    splitItems: splitItems,
    splitTerms: splitTerms,
    byteLen: byteLen,
    splitTxt: splitTxt,
    isIpv4: isIpv4,
    isIpv6: isIpv6,
    isDomainish: isDomainish,
    checkTerm: checkTerm,
    buildSpf: buildSpf,
    zoneLine: zoneLine,
    __cases: function (assert) {
      /* ---- 小工具 ---- */
      assert.eq(fqdn(' Example.COM. '), 'example.com', '去空白、去尾点、转小写');
      assert.eq(splitItems('a.com, b.com\nc.com'), ['a.com', 'b.com', 'c.com'], '逗号与换行都算分隔符');
      assert.eq(splitItems('  '), [], '空输入得到空列表');
      assert.eq(splitItems('a.com,,b.com'), ['a.com', 'b.com'], '空项被丢掉');
      assert.eq(splitTerms('exists:%{i}.x.com\nptr:y.com'), ['exists:%{i}.x.com', 'ptr:y.com'], '机制项按行切');
      assert.eq(byteLen('abc'), 3, 'ASCII 一个字节');
      assert.eq(byteLen('中'), 3, '汉字 UTF-8 三个字节');

      /* ---- IPv4 / IPv6 ---- */
      assert(isIpv4('192.0.2.1'), '普通 IPv4');
      assert(isIpv4('192.0.2.0/24'), '带 CIDR 的 IPv4');
      assert(!isIpv4('192.0.2.256'), '段大于 255 不行');
      assert(!isIpv4('192.0.2'), '三段不行');
      assert(!isIpv4('192.0.2.01'), '前导零不行');
      assert(!isIpv4('192.0.2.1/33'), '前缀超过 32 不行');
      assert(isIpv6('2001:db8::1'), '压缩写法');
      assert(isIpv6('2001:0db8:0000:0000:0000:0000:0000:0001'), '完整写法');
      assert(isIpv6('::1'), '::1');
      assert(isIpv6('::ffff:192.0.2.1'), 'IPv4 映射写法');
      assert(!isIpv6('192.0.2.1'), 'IPv4 不是 IPv6');
      assert(!isIpv6('2001:db8:::1'), '两个 :: 不行');
      assert(!isIpv6('2001:db8:0:0:0:0:1'), '组数不够');
      assert(!isIpv6('2001:db8::1/200'), '前缀超过 128 不行');

      /* ---- 机制项校验 ---- */
      assert(checkTerm('ip4:192.0.2.1').ok, 'ip4 带取值');
      assert(!checkTerm('ip4').ok, 'ip4 缺取值不行');
      assert(!checkTerm('exists').ok, 'exists 缺取值不行（上游那版就是这样）');
      assert(!checkTerm('ptr').ok, 'ptr 缺取值不行');
      assert(checkTerm('exists:%{i}.x.com').ok, 'exists 带取值');
      assert(checkTerm('a').ok, 'a 可以不带取值');
      assert(checkTerm('mx').ok, 'mx 可以不带取值');
      assert(checkTerm('-ip4:192.0.2.1').ok, '限定符可以带');
      assert.eq(checkTerm('redirect=x.com').reason, 'redirect', 'redirect 要走专门的字段');
      assert(!checkTerm('all').ok, 'all 不接受手填');
      assert(!checkTerm('ip4:999.0.0.1').ok, 'IP 不合法不行');

      /* ---- 记录生成 ---- */
      var r = buildSpf({ domain: 'example.com', all: '~all' });
      assert.eq(r.name, 'example.com', '记录名就是域名');
      assert.eq(r.value, 'v=spf1 ~all', '什么都不填时的记录');
      assert(r.value.indexOf('v=spf1') === 0, 'v= 永远是第一个字段');
      assert(!/\s$/.test(r.value), '末尾没有多余空格');
      assert.eq(buildSpf({
        domain: 'example.com', all: '-all',
        aDomains: 'example.org', ipv4: '192.0.2.1', ipv6: '2001:db8::1', includes: '_spf.google.com'
      }).value, 'v=spf1 a:example.org ip4:192.0.2.1 ip6:2001:db8::1 include:_spf.google.com -all', '四种来源');
      assert.eq(buildSpf({ domain: 'example.com', all: '~all', ownA: true, ownMx: true }).value,
        'v=spf1 a mx ~all', '域名自己的 A / MX');
      assert.eq(buildSpf({ domain: 'example.com', all: '~all', custom: 'exists:%{i}.x.com' }).value,
        'v=spf1 exists:%{i}.x.com ~all', '手填的机制');
      assert.eq(buildSpf({ domain: 'example.com', all: '~all', custom: 'exists' }).value,
        'v=spf1 ~all', '缺取值的 exists 不进记录');
      assert(buildSpf({ domain: 'example.com', all: '~all', custom: 'exists' }).notes
        .indexOf(t('note_bad_values', 'Left out because the syntax is wrong or a value is missing: {list}')
          .replace('{list}', function () { return 'exists'; })) !== -1,
        '缺取值的机制在提示里点名');
      assert(buildSpf({ domain: 'example.com', all: '~all', custom: 'redirect' }).notes
        .indexOf(t('note_redirect_in_custom', 'redirect is not a mechanism but a modifier: fill in the "Redirect to" field instead, it is put at the end and replaces the all term')) !== -1,
        '手填的 redirect 被点名');
      assert.eq(buildSpf({ domain: 'example.com', all: '-all', redirect: 'other.com' }).value,
        'v=spf1 redirect=other.com', 'redirect 排在最后，而且没有 all');
      assert(buildSpf({ domain: 'example.com', all: '-all', redirect: 'other.com' }).notes
        .indexOf(t('note_bad_values', 'Left out because the syntax is wrong or a value is missing: {list}')) === -1,
        '填了 redirect 不算错误');
      assert.eq(buildSpf({ domain: 'example.com', all: '~all', ipv4: '999.1.1.1' }).value,
        'v=spf1 ~all', '非法的 IPv4 不进记录');
      assert.eq(buildSpf({ domain: 'Example.com.', all: '~all' }).name, 'example.com', '域名归一化');
      assert.eq(buildSpf({ domain: '', all: '~all' }).name, '', '没填域名也不炸');
      assert(buildSpf({ domain: 'example.com', all: '~all' }).notes
        .indexOf(t('note_no_mechanism', 'No mechanism is listed: this record authorizes nobody, it only states the policy')) !== -1,
        '一个机制都没有时提醒');
      assert(buildSpf({ domain: 'example.com', all: '+all' }).notes
        .indexOf(t('note_plus_all', '+all authorizes every sender: it is the same as not setting SPF at all')) !== -1,
        '+all 提醒');
      assert(buildSpf({ domain: 'example.com', all: '~all', includes: 'a.com,b.com,c.com,d.com,e.com,f.com,g.com,h.com,i.com,j.com,k.com' }).notes
        .indexOf(t('note_too_many_lookups', 'This record has {count} mechanisms that need a DNS query, RFC 7208 allows at most 10')
          .replace('{count}', function () { return '11'; })) !== -1,
        '超过 10 次 DNS 查询时提醒');
      assert(buildSpf({ domain: 'example.com', all: '~all', includes: 'a.com,b.com,c.com,d.com,e.com,f.com,g.com,h.com,i.com,j.com' }).notes
        .indexOf(t('note_too_many_lookups', 'This record has {count} mechanisms that need a DNS query, RFC 7208 allows at most 10')
          .replace('{count}', function () { return '11'; })) === -1,
        '正好 10 次不提醒');
      var longRec = buildSpf({ domain: 'example.com', all: '~all', aDomains: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.com, ccccccccccccccccccccccccccccccc.com, dddddddddddddddddddddddddddddddddd.com, eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.com, ffffffffffffffffffffffffffffffffff.com, gggggggggggggggggggggggggggggggggg.com' });
      assert(byteLen(longRec.value) > 255, '这条记录确实超了 255 字节');
      assert(longRec.notes
        .indexOf(t('note_too_long', 'The record value is {bytes} bytes, over the 255-byte limit of a single DNS string: the zone snippet below is already split into several strings, most DNS panels split it for you')
          .replace('{bytes}', function () { return String(byteLen(longRec.value)); })) !== -1,
        '超过 255 字节时提醒');

      /* ---- 完整记录与 zone 片段 ---- */
      var full = buildSpf({ domain: 'example.com', all: '-all', ipv4: '192.0.2.1' });
      assert.eq(full.full, 'example.com. IN TXT "v=spf1 ip4:192.0.2.1 -all"', '完整记录串');
      assert.eq(full.zone, t('zone_comment', 'SPF record for {domain}').replace('{domain}', 'example.com') +
        '\nexample.com. IN TXT "v=spf1 ip4:192.0.2.1 -all"', 'zone 片段');

      /* ---- 255 字节切分 ---- */
      var long = 'v=DKIM1; k=rsa; p=' + new Array(400).join('A');
      var parts = splitTxt(long);
      assert(parts.length > 1, '过长的值被切成几段');
      assert(parts.join('') === long, '拼起来还是原来那个值');
      assert(parts.every(function (p) { return byteLen(p) <= 255; }), '每段都不超过 255 字节');
      assert.eq(splitTxt('short'), ['short'], '短值不切');
      assert.eq(splitTxt('a; b; c', 255).length, 1, '没超限就不切');
      assert.eq(zoneLine('example.com', long).indexOf('( "'), 'example.com. IN TXT '.length,
        'zone 里长值用多个字符串的写法');
    }
  };
})();
