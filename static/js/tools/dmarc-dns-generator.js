/* ==========================================================================
   DMARC DNS 记录生成器（dmarc-dns-generator）

   填一张表 → 出一条能直接贴进 DNS 的 DMARC TXT 记录。

   ---- 上游那版是什么 ----
   sharevb/it-tools2 的 dmarc-dns-generator.vue：域名 + 策略 + 子域策略 +
   百分比 + rua + ruf + 对齐方式 + 上报间隔，输出只有一条裸记录串
   （`v=DMARC1; p=none; sp=none; rua=mailto:…`），连记录名都没有。

   ---- 差在哪（以及为什么）----
   1. **上游只给记录值，不给记录名**：DMARC 记录必须发布在 `_dmarc.<域名>`
      上，域名填错一个字这条记录就白发。这一版把记录名一起给出来。
   2. **上游的 rua / ruf 会拼出 `mailto:mailto:…`**：它无条件加 mailto: 前缀，
      用户从别处复制来一个已经带 `mailto:` 的地址时就重了 —— 这种地址在
      DMARC 解析里是**无效**的（RFC 7489 §7.1），整条记录直接作废。
      这一版先看有没有协议头，没有才补。
   3. **上游的 sp 永远都写**：哪怕 sp 与 p 完全相同也要写一遍
      （`v=DMARC1; p=none; sp=none; …`）。RFC 7489 §6.3 说 sp 省略时取 p 的值，
      多写一遍只是噪音。这一版提供「与 p 相同」这一项，相同就不写。
   4. **上游没有 fo**：失败选项（fo）是 RFC 7489 §6.3 里的一级标签，
      决定「什么情况下生成报告」，收件方最常问的就是它。
   5. **上游的 ri 永远都写**（默认 86400 秒）：RFC 7489 §6.3 的默认值就是
      86400，写出来是冗余。这一版留空就不写。
   6. 上游不校验百分比、不看报告地址像不像邮箱、不管 255 字节上限 ——
      这一版都补上了。

   ---- 标签顺序 ----
   RFC 7489 §6.3 把 DMARC 记录定义成「一串用分号隔开的 tag=value」，
   解析方逐个标签读，标签之间的先后不影响含义（Google 与 Microsoft
   生成的记录顺序就不一样）。这一版固定用
   v, p, sp, rua, ruf, pct, fo, adkim, aspf, ri 这个顺序，
   跟常见的示例记录一致。

   ---- 依赖 ----
   纯字符串拼装：不查 DNS、不发请求、不要外部库。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('dmarc-dns-generator');

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
   */
  function splitTxt(value, limit) {
    limit = limit || 255;
    var rest = String(value == null ? '' : value);
    var out = [];
    while (rest.length) {
      if (byteLen(rest) <= limit) { out.push(rest); break; }
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

  /**
   * 报告地址归一化。
   *
   * rua / ruf 的值应该是 `mailto:a@x.com`，但表单里没人愿意手打 mailto: 前缀，
   * 所以没写协议的自动补上；已经带了协议的（`https://…`）原样保留。
   * 上游那版无条件加 mailto:，从别处复制来的地址就变成了 `mailto:mailto:…`
   * —— 那种记录在 RFC 7489 §7.1 里是无效的。
   */
  function normalizeAddresses(str) {
    var raw = String(str == null ? '' : str).trim();
    if (!raw) return '';
    return raw.split(',').map(function (one) {
      var s = one.trim();
      if (!s) return '';
      return /^(mailto:|https?:\/\/)/i.test(s) ? s : 'mailto:' + s;
    }).filter(Boolean).join(',');
  }

  /** 报告地址里有没有不像邮箱的（只提醒，不拦着）。 */
  function badAddresses(str) {
    var raw = String(str == null ? '' : str).trim();
    if (!raw) return [];
    return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean).filter(function (s) {
      if (/^https?:\/\//i.test(s)) return false;
      var addr = s.replace(/^mailto:/i, '');
      return !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(addr);
    });
  }

  /**
   * 百分比：空 → 不写；数字 → 夹到 [0, 100]；不是数字 → 不写。
   * @returns {{value: ?number, clamped: boolean, invalid: boolean}}
   */
  function parsePct(str) {
    var raw = nz(str);
    if (!raw) return { value: null, clamped: false, invalid: false };
    if (!/^\d+(\.\d+)?$/.test(raw)) return { value: null, clamped: false, invalid: true };
    var n = Number(raw);
    if (n > 100) return { value: 100, clamped: true, invalid: false };
    if (n < 0) return { value: 0, clamped: true, invalid: false };
    return { value: n, clamped: false, invalid: false };
  }

  /**
   * 上报间隔（秒）：RFC 7489 §6.3 要求是 3600 以上的整数秒。
   * @returns {{value: ?number, invalid: boolean}}
   */
  function parseRi(str) {
    var raw = nz(str);
    if (!raw) return { value: null, invalid: false };
    if (!/^\d+$/.test(raw) || Number(raw) < 3600) return { value: null, invalid: true };
    return { value: Number(raw), invalid: false };
  }

  /**
   * 生成 DMARC 记录。
   *
   * @param {object} opts
   *   domain  记录挂在哪个域名上
   *   policy  p
   *   sp      子域策略
   *   pct     百分比
   *   rua     汇总报告地址
   *   ruf     取证报告地址
   *   fo      失败选项
   *   adkim   DKIM 对齐方式
   *   aspf    SPF 对齐方式
   *   ri      上报间隔（秒）
   * @returns {{name: string, value: string, full: string, zone: string, notes: string[]}}
   */
  function buildDmarc(opts) {
    opts = opts || {};
    var notes = [];
    var tags = ['v=DMARC1'];

    var domain = fqdn(opts.domain);
    var name = domain ? '_dmarc.' + domain : '';

    var policy = nz(opts.policy).toLowerCase();
    if (['none', 'quarantine', 'reject'].indexOf(policy) < 0) policy = 'none';
    tags.push('p=' + policy);

    var sp = nz(opts.sp).toLowerCase();
    if (['none', 'quarantine', 'reject'].indexOf(sp) < 0) sp = '';
    // sp 省略时取 p 的值（RFC 7489 §6.3），相同就别写
    if (sp && sp !== policy) tags.push('sp=' + sp);

    var rua = normalizeAddresses(opts.rua);
    if (rua) tags.push('rua=' + rua);
    var ruf = normalizeAddresses(opts.ruf);
    if (ruf) tags.push('ruf=' + ruf);

    var pct = parsePct(opts.pct);
    if (pct.value !== null) tags.push('pct=' + pct.value);

    var fo = nz(opts.fo).toLowerCase();
    if (fo) tags.push('fo=' + fo);

    ['adkim', 'aspf'].forEach(function (key) {
      var v = nz(opts[key]).toLowerCase();
      if (v !== 'r' && v !== 's') return;
      tags.push(key + '=' + v);
      if (v === 'r') {
        notes.push(t('note_alignment_r', '{key} is r (relaxed): SPF or DKIM aligned in **either** way is enough to pass')
          .replace('{key}', function () { return key; }));
      } else {
        notes.push(t('note_alignment_s', '{key} is s (strict): SPF and DKIM must **both** be aligned')
          .replace('{key}', function () { return key; }));
      }
    });

    var ri = parseRi(opts.ri);
    if (ri.value !== null) tags.push('ri=' + ri.value);

    // 标签之间一个分号加一个空格，末尾不留空格
    var value = tags.join('; ');

    /* ---- 提示（只提示，不抛异常） ---- */
    if (pct.invalid) {
      notes.push(t('note_pct_invalid', 'The percentage is not a number: it was left out of the record'));
    }
    if (pct.clamped) {
      notes.push(t('note_pct_clamped', 'The percentage was clamped to {value}: it has to stay between 0 and 100')
        .replace('{value}', function () { return String(pct.value); }));
    }
    if (ri.invalid) {
      notes.push(t('note_ri_invalid', 'The reporting interval has to be a whole number of seconds, at least 3600: it was left out of the record'));
    }
    var bad = badAddresses(opts.rua).concat(badAddresses(opts.ruf));
    if (bad.length) {
      notes.push(t('note_bad_email', 'These report addresses do not look like email addresses: {list}')
        .replace('{list}', function () { return bad.join(', '); }));
    }
    if (policy === 'none') {
      notes.push(t('note_policy_none', 'p=none is only an observation mode: recipients will not reject any mail because of it'));
    }
    if (!rua) {
      notes.push(t('note_no_rua', 'rua is not set: nobody receives the authentication results, which is the same as not turning on DMARC monitoring'));
    }
    if (!name) {
      notes.push(t('note_no_domain', 'Fill in the domain to get the name of the record'));
    }
    var bytes = byteLen(value);
    if (bytes > 255) {
      notes.push(t('note_too_long', 'The record value is {bytes} bytes, over the 255-byte limit of a single DNS string: split it into several strings before publishing')
        .replace('{bytes}', function () { return String(bytes); }));
    }

    return {
      name: name,
      value: value,
      full: name ? name + '. IN TXT "' + value + '"' : '',
      zone: name ? zoneBlock(name, value, t('zone_comment', 'DMARC record for {domain}')
        .replace('{domain}', function () { return domain; })) : '',
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

  var POLICY_OPTIONS = [
    { value: 'none', label: t('policy_none', 'none (report only, no action - start with this one to observe)') },
    { value: 'quarantine', label: t('policy_quarantine', 'quarantine (send to the spam folder)') },
    { value: 'reject', label: t('policy_reject', 'reject (reject outright)') }
  ];

  var ALIGNMENT_OPTIONS = [
    { value: '', label: t('opt_not_written', '(not written, r by default)') },
    { value: 'r', label: t('opt_relaxed', 'r — relaxed') },
    { value: 's', label: t('opt_strict', 's — strict') }
  ];

  window.ItTools.register('dmarc-dns-generator', function (root) {
    function textField(label, value, hint) {
      var el = D.h('input.layui-input', { type: 'text', value: value, spellcheck: 'false' });
      return { el: el, node: U.field(label, el, { wide: true, hint: hint }) };
    }
    function selectField(label, options, value, hint) {
      var el = D.h('select.layui-select', null, options.map(function (o) {
        return D.h('option', { value: o.value, text: o.label });
      }));
      el.value = value;
      return { el: el, node: U.field(label, el, { wide: true, hint: hint }) };
    }

    var fDomain = textField(t('label_domain', 'Domain'), 'example.com',
      t('hint_domain', 'The domain the DMARC record is published on, e.g. example.com'));
    var fPolicy = selectField(t('label_policy', 'Policy (p)'), POLICY_OPTIONS, 'none',
      t('hint_policy', 'What the recipient does with a mail that fails DMARC'));
    var fSp = selectField(t('label_subdomain_policy', 'Subdomain policy (sp)'), [
      { value: '', label: t('opt_same_as_p', '(same as p)') },
      { value: 'none', label: 'none' },
      { value: 'quarantine', label: 'quarantine' },
      { value: 'reject', label: 'reject' }
    ], '', t('hint_subdomain_policy', 'The policy for the subdomains: left out of the record when it is the same as p'));
    var fPct = textField(t('label_percentage', 'Percentage (pct)'), '100',
      t('hint_percentage', '0-100, decimals allowed. Start with a small percentage and ramp it up later'));
    var fRua = textField(t('label_aggregate_reports', 'Aggregate reports (rua)'), 'dmarc@example.com',
      t('hint_aggregate_reports', 'Comma separated; mailto: is added automatically when it is missing'));
    var fRuf = textField(t('label_forensic_reports', 'Forensic reports (ruf)'), '',
      t('hint_forensic_reports', 'Needs an extra authorization from the recipient, most free mail providers do not give it, so you may never receive them'));
    var fFo = selectField(t('label_failure_options', 'Failure options (fo)'), [
      { value: '', label: t('opt_not_set', '(not set)') },
      { value: '0', label: t('fo_0', '0: report when the authentication fails') },
      { value: '1', label: t('fo_1', '1: report when any of the checks fails') },
      { value: 'd', label: t('fo_d', 'd: report when DKIM fails') },
      { value: 's', label: t('fo_s', 's: report when SPF fails') }
    ], '1', t('hint_failure_options', 'Which failures make the recipient send a report'));
    var fAdkim = selectField(t('label_dkim_alignment', 'DKIM alignment (adkim)'), ALIGNMENT_OPTIONS, '');
    var fAspf = selectField(t('label_spf_alignment', 'SPF alignment (aspf)'), ALIGNMENT_OPTIONS, '');
    var fRi = textField(t('label_reporting_interval', 'Reporting interval (ri)'), '',
      t('hint_reporting_interval', 'In seconds, at least 3600. Left out of the record when it is empty, the default is 86400'));

    var inputCard = D.h('div.card', null,
      D.h('p.field-hint', { text: t('desc', 'DMARC tells the recipients what to do with the mail that fails SPF or DKIM. Publish the record at _dmarc.<domain>.') }),
      fDomain.node,
      fPolicy.node,
      fSp.node,
      fPct.node,
      fRua.node,
      fRuf.node,
      fFo.node,
      fAdkim.node,
      fAspf.node,
      fRi.node
    );

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
      var rec = buildDmarc({
        domain: fDomain.el.value,
        policy: fPolicy.el.value,
        sp: fSp.el.value,
        pct: fPct.el.value,
        rua: fRua.el.value,
        ruf: fRuf.el.value,
        fo: fFo.el.value,
        adkim: fAdkim.el.value,
        aspf: fAspf.el.value,
        ri: fRi.el.value
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

  window.ItTools.logic['dmarc-dns-generator'] = {
    fqdn: fqdn,
    byteLen: byteLen,
    splitTxt: splitTxt,
    normalizeAddresses: normalizeAddresses,
    badAddresses: badAddresses,
    parsePct: parsePct,
    parseRi: parseRi,
    buildDmarc: buildDmarc,
    zoneLine: zoneLine,
    __cases: function (assert) {
      /* ---- 地址归一化 ---- */
      assert.eq(normalizeAddresses('a@x.com'), 'mailto:a@x.com', '补 mailto 前缀');
      assert.eq(normalizeAddresses('mailto:a@x.com'), 'mailto:a@x.com', '已有 mailto 不重复加');
      assert.eq(normalizeAddresses('https://x.com/r'), 'https://x.com/r', 'https 报告地址原样保留');
      assert.eq(normalizeAddresses('a@x.com, b@y.com'), 'mailto:a@x.com,mailto:b@y.com', '多个地址逐个处理');
      assert.eq(normalizeAddresses(''), '', '空串');
      assert.eq(normalizeAddresses('mailto:a@x.com').indexOf('mailto:mailto:'), -1, '不会出现 mailto:mailto:');
      assert.eq(badAddresses('a@x.com'), [], '正常邮箱不报');
      assert.eq(badAddresses('admin'), ['admin'], '不像邮箱的报出来');
      assert.eq(badAddresses('mailto:a@x.com'), [], '带 mailto 的正常邮箱不报');

      /* ---- 百分比与间隔 ---- */
      assert.eq(parsePct('100').value, 100, '正常百分比');
      assert.eq(parsePct('').value, null, '空 → 不写');
      assert.eq(parsePct('abc').invalid, true, '不是数字 → 不写');
      assert.eq(parsePct('150').value, 100, '超量夹到 100');
      assert.eq(parsePct('33.3').value, 33.3, '允许小数');
      assert.eq(parseRi('').value, null, '空 → 不写');
      assert.eq(parseRi('3600').value, 3600, '3600 秒是下限');
      assert.eq(parseRi('60').invalid, true, '小于 3600 无效');
      assert.eq(parseRi('abc').invalid, true, '不是数字无效');

      /* ---- 记录生成 ---- */
      var r = buildDmarc({ domain: 'example.com', policy: 'none', pct: '100', rua: 'dmarc@example.com', fo: '1' });
      assert.eq(r.name, '_dmarc.example.com', '记录名');
      assert.eq(r.value, 'v=DMARC1; p=none; rua=mailto:dmarc@example.com; pct=100; fo=1', '默认记录');
      assert(r.value.indexOf('v=DMARC1') === 0, 'v= 永远是第一个字段');
      assert(!/[;\s]$/.test(r.value), '末尾没有多余分号');
      assert.eq(buildDmarc({ domain: 'Example.com.', policy: 'reject', pct: '100', rua: 'a@x.com' }).name,
        '_dmarc.example.com', '域名归一化');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'reject', sp: 'quarantine', pct: '100', rua: 'a@x.com' }).value,
        'v=DMARC1; p=reject; sp=quarantine; rua=mailto:a@x.com; pct=100', 'sp 与 p 不同才写');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', sp: 'none', pct: '100', rua: 'a@x.com' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; pct=100', 'sp 与 p 相同就不重复写');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: '50', rua: 'a@x.com' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; pct=50', 'pct');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: '', rua: 'a@x.com' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com', 'pct 留空就不写');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: 'a@x.com', ruf: 'f@x.com' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; ruf=mailto:f@x.com; pct=100', 'ruf');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: 'a@x.com', fo: 'd' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; pct=100; fo=d', 'fo');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: 'a@x.com', adkim: 's', aspf: 'r' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; pct=100; adkim=s; aspf=r', '对齐方式');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: 'a@x.com', ri: '86400' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; pct=100; ri=86400', '上报间隔');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: 'a@x.com', ri: '60' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; pct=100', '太小的间隔不写');
      assert(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: 'a@x.com', ri: '60' }).notes
        .indexOf(t('note_ri_invalid', 'The reporting interval has to be a whole number of seconds, at least 3600: it was left out of the record')) !== -1,
        '间隔不合法时提醒');
      assert(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: 'a@x.com', adkim: 's' }).notes
        .indexOf(t('note_alignment_s', '{key} is s (strict): SPF and DKIM must **both** be aligned')
          .replace('{key}', function () { return 'adkim'; })) !== -1,
        'strict 模式给出说明');
      assert(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: '' }).notes
        .indexOf(t('note_no_rua', 'rua is not set: nobody receives the authentication results, which is the same as not turning on DMARC monitoring')) !== -1,
        '没 rua 提醒等于没监控');
      assert(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: 'admin' }).notes
        .indexOf(t('note_bad_email', 'These report addresses do not look like email addresses: {list}')
          .replace('{list}', function () { return 'admin'; })) !== -1,
        '不像邮箱的报告地址被点名');
      assert(buildDmarc({ domain: 'x.com', policy: 'none', pct: '100', rua: 'a@x.com' }).notes
        .indexOf(t('note_policy_none', 'p=none is only an observation mode: recipients will not reject any mail because of it')) !== -1,
        'p=none 提醒这只是观察模式');
      assert.eq(buildDmarc({ domain: '', policy: 'none', pct: '100', rua: 'a@x.com' }).name,
        '', '没填域名就没有记录名');
      assert.eq(buildDmarc({}).value, 'v=DMARC1; p=none', '空输入不崩');
      assert.eq(buildDmarc({}).name, '', '空输入不崩');

      /* ---- 完整记录与 zone 片段 ---- */
      var full = buildDmarc({ domain: 'example.com', policy: 'none', pct: '100', rua: 'dmarc@example.com', fo: '1' });
      assert.eq(full.full, '_dmarc.example.com. IN TXT "v=DMARC1; p=none; rua=mailto:dmarc@example.com; pct=100; fo=1"', '完整记录串');
      assert.eq(full.zone, t('zone_comment', 'DMARC record for {domain}').replace('{domain}', 'example.com') +
        '\n_dmarc.example.com. IN TXT "v=DMARC1; p=none; rua=mailto:dmarc@example.com; pct=100; fo=1"', 'zone 片段');
    }
  };
})();
