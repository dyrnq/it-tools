/* ==========================================================================
   DNS 记录生成器（dns-record-generator）

   生成四类「邮件身份」相关的 DNS 记录：SPF、DKIM、DMARC、BIMI。
   填个表单 → 出记录串 + 该填在哪个名字上。

   上游 issue #1387，参考 easydmarc 的四个生成器页面。
   上游**没有这个工具** —— 这一份是从零实现的，没有照抄任何上游代码。

   ---- 为什么放在前端 ----
   这四个记录全是**纯字符串拼装**：记录长什么样完全由你填的参数决定，
   不需要去查 DNS。所以不需要服务端，也就不需要「去 example.com 拉一下现有
   记录」这类网络请求 —— 那反而超出了上游 issue 要求的范围。

   ---- 与 easydmarc 的差别 ----
   easydmarc 会顺手去 DNS 查你填的域名现在有没有 SPF/DKIM/DMARC，并提示冲突。
   这里不做：纯前端、零请求、零外部依赖，代价是得自己确认没有重复记录
   （同一个名字上有两条 SPF 是会导致 permerror 的）。

   ---- 一个容易踩的坑 ----
   同一个名字上**只能有一条** SPF 和一条 DMARC。不是「多条取最严格的那条」——
   接收方按 RFC 7208 §6.7 处理多条 SPF 时会直接判 permerror，比没配还糟。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('dns-record-generator');

  /* ======================================================================
     通用小工具
     ====================================================================== */

  /** 去掉首尾空白与结尾的点 —— 有人会习惯性把 FQDN 写成 `example.com.` */
  function fqdn(str) {
    return String(str == null ? '' : str).trim().replace(/\.+$/, '').toLowerCase();
  }

  /** 非空才返回，否则空串。用来剔除记录里的空标签。 */
  function nz(str) {
    var s = String(str == null ? '' : str).trim();
    return s ? s : '';
  }

  /**
   * 报告地址归一化。
   *
   * rua / ruf 的值应该是 `mailto:a@x.com`，但表单里没人愿意手打 mailto: 前缀，
   * 所以没写协议的自动补上；已经带了协议的（`https://…`）原样保留。
   */
  function normalizeReportAddress(str) {
    var raw = String(str == null ? '' : str).trim();
    if (!raw) return '';
    return raw.split(',').map(function (one) {
      var s = one.trim();
      if (!s) return '';
      return /^(mailto:|https?:\/\/)/i.test(s) ? s : 'mailto:' + s;
    }).filter(Boolean).join(',');
  }

  /** 记录值的超长提醒（DNS 单个字符串上限 255 字节）。 */
  function lengthNote(value) {
    var n = U.utf8Bytes(value).length;
    if (n <= 255) return null;
    return t('note_too_long', '⚠ This record value is {bytes} bytes, over the 255-byte limit of a single DNS string; split it into several strings before publishing')
      .replace('{bytes}', n);
  }

  /* ======================================================================
     1. SPF
     ====================================================================== */

  /** SPF 机制（mechanism）。`value` 只对需要冒号的那几种有意义。 */
  var SPF_MECHANISMS = [
    { type: 'include', label: 'include', needsValue: true, hint: t('hint_mech_include', 'e.g. _spf.google.com (the SPF domain of the other side)') },
    { type: 'ip4', label: 'ip4', needsValue: true, hint: t('hint_mech_ip4', 'e.g. 203.0.113.10') },
    { type: 'ip6', label: 'ip6', needsValue: true, hint: t('hint_mech_ip6', 'e.g. 2001:db8::1') },
    { type: 'a', label: 'a', needsValue: false, hint: t('hint_mech_a', 'Allow the A record of the domain itself') },
    { type: 'mx', label: 'mx', needsValue: false, hint: t('hint_mech_mx', 'Allow the MX records of the domain itself') },
    { type: 'exists', label: 'exists', needsValue: true, hint: t('hint_mech_exists', 'Allow as soon as the DNS lookup returns any address') },
    { type: 'ptr', label: 'ptr', needsValue: true, hint: t('hint_mech_ptr', 'Checked against the reverse DNS (mostly deprecated)') }
  ];

  /** SPF 限定符。`+` 是默认值，所以留空就当 `+` 处理。 */
  var SPF_QUALIFIERS = [
    { value: '', label: t('qual_pass', '+ pass (default)') },
    { value: '-', label: t('qual_fail', '- fail') },
    { value: '~', label: t('qual_softfail', '~ softfail') },
    { value: '?', label: t('qual_neutral', '? neutral') }
  ];

  /** 结尾的 all 项：SPF 里只有它能决定「没列到的发信方怎么办」。 */
  var SPF_ALL = [
    { value: '-all', label: t('all_fail', '-all (fail: reject strictly)') },
    { value: '~all', label: t('all_softfail', '~all (softfail: mark but do not reject)') },
    { value: '?all', label: t('all_neutral', '?all (neutral: leave the decision to the recipient)') },
    { value: '+all', label: t('all_pass', '+all (pass: same as not configuring SPF)') }
  ];

  /**
   * 生成 SPF 记录。
   *
   * @param {{domain: string, mechanisms: {qualifier?: string, type: string, value?: string}[], all?: string}} opts
   * @returns {{name: string, type: string, value: string, note: string|null}}
   */
  function buildSpf(opts) {
    opts = opts || {};
    var parts = ['v=spf1'];
    var skipped = [];

    (opts.mechanisms || []).forEach(function (m) {
      var type = nz(m && m.type);
      if (!type) return;
      var value = nz(m.value);
      var spec = SPF_MECHANISMS.filter(function (s) { return s.type === type; })[0];
      // 不带参数的机制（a / mx）**不能**带冒号取值 —— `a:example.com` 语法上
      // 是合法的，但语义是「A 记录指向 example.com 的主机」，和用户填的
      // 意图（放行本域 A 记录）完全不是一回事，静默带上会生成误导性记录。
      if (!spec || !spec.needsValue) { parts.push(nz(m.qualifier) + type); return; }
      if (!value) { skipped.push(type); return; }
      parts.push(nz(m.qualifier) + type + ':' + value);
    });

    parts.push(nz(opts.all) || '-all');
    var value = parts.join(' ');
    var note = lengthNote(value);
    if (skipped.length) {
      note = t('note_spf_missing_value', 'Ignored mechanisms without a value: {list}')
        .replace('{list}', skipped.join(', ')) + (note ? t('sep_note', '; ') + note : '');
    }
    return { name: fqdn(opts.domain), type: 'TXT', value: value, note: note };
  }

  /* ======================================================================
     2. DKIM
     ====================================================================== */

  /**
   * 从 PEM 里取出公钥的 base64 正文。
   *
   * 用户多半是直接把 `openssl rsa -pubout` 的输出整段粘进来的，DNS TXT 记录
   * 里只该放中间那坨 base64，头尾两行和换行都得去掉。
   */
  function extractPublicKey(str) {
    var s = String(str == null ? '' : str).trim();
    if (!s) return '';
    var m = s.match(/-----BEGIN [^-]+-----(.+?)-----END [^-]+-----/s);
    if (m) s = m[1];
    return s.replace(/\s+/g, '');
  }

  /**
   * 生成 DKIM 公钥记录。
   * @param {{selector: string, domain: string, keyType: string, publicKey: string}} opts
   */
  function buildDkim(opts) {
    opts = opts || {};
    var key = extractPublicKey(opts.publicKey);
    var tags = ['v=DKIM1'];
    // k= 只在非默认（rsa）时才写 —— RFC 6376 §3.1：省略即 rsa
    var kt = nz(opts.keyType).toLowerCase();
    if (kt && kt !== 'rsa') tags.push('k=' + kt);
    if (key) tags.push('p=' + key);

    var value = tags.join('; ');
    var note = lengthNote(value);
    if (!key) {
      note = t('note_dkim_no_key', 'No public key yet - this record is incomplete, paste the public key in before publishing');
    } else if (/\s/.test(key)) {
      note = t('note_dkim_key_whitespace', 'The public key contains whitespace characters');
    }
    return {
      name: (nz(opts.selector) ? nz(opts.selector) + '._domainkey.' : '') + fqdn(opts.domain),
      type: 'TXT',
      value: value,
      note: note
    };
  }

  /* ======================================================================
     3. DMARC
     ====================================================================== */

  var DMARC_POLICIES = [
    { value: 'none', label: t('policy_none', 'none (report only, no action - start with this one to observe)') },
    { value: 'quarantine', label: t('policy_quarantine', 'quarantine (send to the spam folder)') },
    { value: 'reject', label: t('policy_reject', 'reject (reject outright)') }
  ];

  var DMARC_FO = [
    { value: '0', label: t('fo_0', '0: report when the authentication fails') },
    { value: '1', label: t('fo_1', '1: report when any of the checks fails') },
    { value: 'd', label: t('fo_d', 'd: report when DKIM fails') },
    { value: 's', label: t('fo_s', 's: report when SPF fails') }
  ];

  /** 把百分比夹到 [0, 100]。DMARC 的 pct 允许小数。 */
  function clampPct(v) {
    var n = Number(v);
    if (!isFinite(n)) return 100;
    return Math.max(0, Math.min(100, n));
  }

  /**
   * 生成 DMARC 记录。
   * @param {{domain: string, policy: string, sp: string, pct: *, rua: string, ruf: string, fo: string, adkim: string, aspf: string}} opts
   */
  function buildDmarc(opts) {
    opts = opts || {};
    var tags = ['v=DMARC1'];
    var policy = nz(opts.policy) || 'none';
    var notes = [];

    tags.push('p=' + policy);

    var sp = nz(opts.sp);
    if (sp && sp !== policy) tags.push('sp=' + sp);

    var pct = clampPct(opts.pct);
    if (pct !== 100) tags.push('pct=' + pct);

    var rua = normalizeReportAddress(opts.rua);
    if (rua) tags.push('rua=' + rua);
    var ruf = normalizeReportAddress(opts.ruf);
    if (ruf) tags.push('ruf=' + ruf);

    var fo = nz(opts.fo);
    if (fo) tags.push('fo=' + fo);

    // adkim / aspf 是对齐模式，不填就不写 —— 写了默认值 r 反而改变了语义
    ['adkim', 'aspf'].forEach(function (k) {
      var v = nz(opts[k]);
      if (!v) return;
      var mode = v.toLowerCase() === 's' ? 's' : 'r';
      tags.push(k + '=' + mode);
      if (mode === 'r') notes.push(t('note_dmarc_alignment_r', '{key} is set to r (relaxed): SPF or DKIM aligned in **either** way is enough to pass').replace('{key}', k));
      if (mode === 's') notes.push(t('note_dmarc_alignment_s', '{key} is set to s (strict): SPF and DKIM must **both** be aligned').replace('{key}', k));
    });

    var value = tags.join('; ');
    var note = lengthNote(value);
    if (policy === 'none') {
      notes.push(t('note_dmarc_policy_none', 'p=none is only an observation mode: recipients will not reject any mail because of it'));
    }
    if (!rua) {
      notes.push(t('note_dmarc_no_rua', 'rua is not set: nobody receives the authentication results, which is the same as not turning on DMARC monitoring'));
    }

    var all = notes.concat(note ? [note] : []);
    return {
      name: '_dmarc.' + fqdn(opts.domain),
      type: 'TXT',
      value: value,
      note: all.length ? all.join(t('sep_note', '; ')) : null
    };
  }

  /* ======================================================================
     4. BIMI
     ====================================================================== */

  /**
   * 生成 BIMI 记录。
   *
   * BIMI 靠 VMC（Verified Mark Certificate）证明「这个 logo 归你」，
   * 所以 l= 里放的是 VMC 的公钥，不是图片本身。
   *
   * @param {{domain: string, vmc: string, authority: string}} opts
   */
  function buildBimi(opts) {
    opts = opts || {};
    var tags = ['v=BIMI1'];
    var notes = [];

    var key = extractPublicKey(opts.vmc);
    var authority = nz(opts.authority);
    if (key) tags.push('l=' + key);
    if (authority) tags.push('a=' + authority);

    var value = tags.join('; ');
    var note = lengthNote(value);

    if (!key && !authority) {
      notes.push(t('note_bimi_need_one', 'BIMI needs a VMC public key (l=) or a compliance evidence URL (a=), fill in at least one of them'));
    } else if (!key) {
      notes.push(t('note_bimi_only_authority', 'Only a= is set: most recipients (Gmail in particular) still require a VMC public key in l='));
    }

    var all = notes.concat(note ? [note] : []);
    return {
      name: 'default._bimi.' + fqdn(opts.domain),
      type: 'TXT',
      value: value,
      note: all.length ? all.join(t('sep_note', '; ')) : null
    };
  }

  /* ======================================================================
     UI
     ====================================================================== */

  var KINDS = [
    { id: 'spf', label: 'SPF', build: buildSpf, desc: t('desc_spf', 'Declare which IPs may send mail with your domain') },
    { id: 'dkim', label: 'DKIM', build: buildDkim, desc: t('desc_dkim', 'Sign the mails, the public key lives in DNS') },
    { id: 'dmarc', label: 'DMARC', build: buildDmarc, desc: t('desc_dmarc', 'Decide whether a mail is accepted or rejected based on SPF/DKIM') },
    { id: 'bimi', label: 'BIMI', build: buildBimi, desc: t('desc_bimi', 'Show a logo in the supported brand indicators') }
  ];

  window.ItTools.register('dns-record-generator', function (root) {
    var current = 'spf';

    /** 顶部四个切换按钮。用 .form-actions（现成的按钮行）而不是另造 tab 组件。 */
    var tabs = D.h('div.form-actions');
    var pane = D.h('div');
    var forms = {};      // id -> { node, read }
    KINDS.forEach(function (k) {
      var btn = D.h('button.layui-btn.layui-btn-sm', {
        type: 'button', text: k.label,
        onclick: function () { show(k.id); }
      });
      btn.dataset.kind = k.id;
      tabs.appendChild(btn);
    });

    function show(id) {
      current = id;
      Object.keys(forms).forEach(function (f) { forms[f].node.hidden = f !== id; });
      [...tabs.children].forEach(function (b) {
        b.classList.toggle('layui-btn-normal', b.dataset.kind === id);
        b.classList.toggle('layui-btn-primary', b.dataset.kind !== id);
      });
      render();
    }

    /* ---- 结果区（四个共用） ---- */
    var outName = D.h('textarea.layui-textarea', { rows: 2, readonly: 'readonly', spellcheck: 'false' });
    var outValue = D.h('textarea.layui-textarea', { rows: 3, readonly: 'readonly', spellcheck: 'false' });
    var outNote = D.h('p.field-hint');
    var outBlock = D.h('div.card', null,
      U.field(t('label_record_name', 'Record name'), outName, { wide: true }),
      U.field(t('label_record_value', 'Record value (TXT)'), outValue, { wide: true }),
      outNote,
      D.h('div.form-actions', null,
        U.copyButton(function () { return outName.value; }, t('copy_name', 'Copy name')),
        U.copyButton(function () { return outValue.value; }, t('copy_value', 'Copy value')),
        U.copyButton(function () { return outName.value + ' IN TXT "' + outValue.value + '"'; }, t('copy_zone_file', 'Copy as zone file'))
      )
    );

    /* ---- 表单控件工厂 ---- */
    function text(label, value, hint) {
      var el = D.h('input.layui-input', { type: 'text', value: value || '', spellcheck: 'false' });
      return { el: el, node: U.field(label, el, { wide: true, hint: hint }) };
    }
    function textarea(label, value, hint, rows) {
      var el = D.h('textarea.layui-textarea', { rows: rows || 3, spellcheck: 'false' });
      el.value = value || '';
      return { el: el, node: U.field(label, el, { wide: true, hint: hint }) };
    }
    function select(label, options, value, hint) {
      var el = D.h('select.layui-select', null, options.map(function (o) {
        return D.h('option', { value: o.value, text: o.label, selected: o.value === value });
      }));
      return { el: el, node: U.field(label, el, { wide: true, hint: hint }) };
    }
    function card(children) {
      var c = D.h('div.card', null, children);
      return c;
    }

    /* ---- SPF：可增删的机制列表 ---- */
    var spfDomain = text(t('label_domain', 'Domain'), 'example.com', t('hint_domain', 'Only the domain itself, do not write the full record'));
    var spfMechs = [];
    var spfMechList = D.h('div');

    function mechRow(m) {
      m = m || {};
      var qSel = D.h('select.layui-select', { style: { width: '150px' } }, SPF_QUALIFIERS.map(function (q) {
        return D.h('option', { value: q.value, text: q.label, selected: q.value === (m.qualifier || '') });
      }));
      var tSel = D.h('select.layui-select', { style: { width: '150px' } }, SPF_MECHANISMS.map(function (s) {
        return D.h('option', { value: s.type, text: s.label, selected: s.type === (m.type || 'include') });
      }));
      var vIn = D.h('input.layui-input', { type: 'text', value: m.value || '', placeholder: t('ph_value', 'Value'), spellcheck: 'false' });
      var del = D.h('button.layui-btn.layui-btn-sm.layui-btn-danger', {
        type: 'button', text: t('remove', 'Remove'),
        onclick: function () {
          spfMechs = spfMechs.filter(function (r) { return r !== row; });
          drawMechs();
        }
      });
      var hint = D.h('p.field-hint', { text: (SPF_MECHANISMS.filter(function (s) { return s.type === (m.type || 'include'); })[0] || {}).hint || '' });
      var row = D.h('div', null,
        D.h('div.field-row', null, qSel, tSel, del),
        D.h('div.field-row', null, vIn),
        hint
      );
      [qSel, tSel, vIn].forEach(function (el) {
        el.addEventListener('input', render);
        el.addEventListener('change', function () {
          var spec = SPF_MECHANISMS.filter(function (s) { return s.type === tSel.value; })[0];
          hint.textContent = (spec && spec.hint) || '';
          render();
        });
      });
      return { node: row, qualifier: qSel, type: tSel, value: vIn };
    }

    function drawMechs() {
      D.clear(spfMechList);
      spfMechs.forEach(function (r) { spfMechList.appendChild(r.node); });
      render();
    }

    var addMech = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: t('add_mechanism', '+ Add mechanism'),
      onclick: function () { spfMechs.push(mechRow()); drawMechs(); }
    });
    var spfAll = select(t('label_ending_all', 'Ending "all" term'), SPF_ALL, '-all',
      t('hint_ending_all', 'In SPF only this term decides what happens to the senders that are not listed, the default should be -all'));

    /* ---- DKIM ---- */
    var dkimSelector = text(t('label_selector', 'Selector'), 's1', t('hint_selector', 'Any name you like, a date or a purpose is common, e.g. s1 / mail / 20260101'));
    var dkimDomain = text(t('label_domain', 'Domain'), 'example.com', t('hint_dkim_domain', 'The domain that issues the DKIM'));
    var dkimType = select(t('label_key_type', 'Key type'), [
      { value: 'rsa', label: t('keytype_rsa', 'rsa (default, best compatibility)') },
      { value: 'ed25519', label: t('keytype_ed25519', 'ed25519 (short, but old recipients may not support it)') }
    ], 'rsa');
    var dkimKey = textarea(t('label_public_key', 'Public key'), '',
      t('hint_public_key', 'Paste the whole PEM output of `openssl rsa -pubout` - the first and last lines are stripped automatically'), 5);

    /* ---- DMARC ---- */
    var dmarcDomain = text(t('label_domain', 'Domain'), 'example.com', '');
    var dmarcPolicy = select(t('label_policy', 'Policy (p)'), DMARC_POLICIES, 'none');
    var dmarcSp = select(t('label_subdomain_policy', 'Subdomain policy (sp)'), [
      { value: '', label: t('opt_same_as_p', '(same as p)') },
      { value: 'none', label: 'none' },
      { value: 'quarantine', label: 'quarantine' },
      { value: 'reject', label: 'reject' }
    ], '');
    var dmarcPct = text(t('label_percentage', 'Percentage (pct)'), '100', t('hint_percentage', '0-100, decimals allowed. Start with a small percentage and ramp it up later'));
    var dmarcRua = text(t('label_aggregate_reports', 'Aggregate reports (rua)'), 'dmarc-reports@example.com', t('hint_aggregate_reports', 'Comma separated; mailto: is added automatically when it is missing'));
    var dmarcRuf = text(t('label_forensic_reports', 'Forensic reports (ruf)'), '', t('hint_forensic_reports', 'Needs an extra authorization from the recipient, most free mail providers do not give it, so you may never receive them'));
    var dmarcFo = select(t('label_failure_options', 'Failure options (fo)'), [].concat([{ value: '', label: t('opt_not_set', '(not set)') }], DMARC_FO), '1');
    var dmarcAdkim = select(t('label_dkim_alignment', 'DKIM alignment (adkim)'), [
      { value: '', label: t('opt_not_written', '(not written, r by default)') }, { value: 'r', label: t('opt_relaxed', 'r — relaxed') }, { value: 's', label: t('opt_strict', 's — strict') }
    ], '');
    var dmarcAspf = select(t('label_spf_alignment', 'SPF alignment (aspf)'), [
      { value: '', label: t('opt_not_written', '(not written, r by default)') }, { value: 'r', label: t('opt_relaxed', 'r — relaxed') }, { value: 's', label: t('opt_strict', 's — strict') }
    ], '');

    /* ---- BIMI ---- */
    var bimiDomain = text(t('label_domain', 'Domain'), 'example.com', '');
    var bimiVmc = textarea(t('label_vmc_public_key', 'VMC public key'), '', t('hint_vmc_public_key', 'The public key of the Verified Mark Certificate (PEM or raw base64 both work)'), 4);
    var bimiAuthority = text(t('label_authority_evidence', 'Authority evidence (a)'), '', t('hint_authority_evidence', 'The compliance evidence URL required by the VMC issuer, it can be left empty'));

    /* ---- 组装四个面板 ---- */
    var spfPanel = card([
      D.h('p.field-hint', { text: KINDS[0].desc }),
      spfDomain.node, spfMechList, addMech, spfAll.node
    ]);

    forms.spf = {
      node: spfPanel,
      read: function () {
        return {
          domain: spfDomain.el.value,
          all: spfAll.el.value,
          mechanisms: spfMechs.map(function (r) {
            return { qualifier: r.qualifier.value, type: r.type.value, value: r.value.value };
          })
        };
      }
    };
    // 初始行必须在 forms.spf 建好之后再加：drawMechs 结尾会调 render，
    // 那时 render 要从 forms.spf.read() 读值。
    spfMechs.push(mechRow({ type: 'include', value: '_spf.google.com' }));
    drawMechs();

    forms.dkim = {
      node: card([
        D.h('p.field-hint', { text: KINDS[1].desc }),
        dkimSelector.node, dkimDomain.node, dkimType.node, dkimKey.node
      ]),
      read: function () {
        return {
          selector: dkimSelector.el.value, domain: dkimDomain.el.value,
          keyType: dkimType.el.value, publicKey: dkimKey.el.value
        };
      }
    };
    forms.dmarc = {
      node: card([
        D.h('p.field-hint', { text: KINDS[2].desc }),
        dmarcDomain.node, dmarcPolicy.node, dmarcSp.node, dmarcPct.node,
        dmarcRua.node, dmarcRuf.node, dmarcFo.node, dmarcAdkim.node, dmarcAspf.node
      ]),
      read: function () {
        return {
          domain: dmarcDomain.el.value, policy: dmarcPolicy.el.value, sp: dmarcSp.el.value,
          pct: dmarcPct.el.value, rua: dmarcRua.el.value, ruf: dmarcRuf.el.value,
          fo: dmarcFo.el.value, adkim: dmarcAdkim.el.value, aspf: dmarcAspf.el.value
        };
      }
    };
    forms.bimi = {
      node: card([
        D.h('p.field-hint', { text: KINDS[3].desc }),
        bimiDomain.node, bimiVmc.node, bimiAuthority.node
      ]),
      read: function () {
        return {
          domain: bimiDomain.el.value, vmc: bimiVmc.el.value, authority: bimiAuthority.el.value
        };
      }
    };

    function render() {
      var kind = KINDS.filter(function (k) { return k.id === current; })[0];
      var rec = kind.build(forms[current].read());
      outName.value = rec.name;
      outValue.value = rec.value;
      outNote.textContent = rec.note || '';
    }

    // 所有控件的输入都触发重算。用事件委托挂一次，省得逐个控件绑。
    root.addEventListener('input', render);
    root.addEventListener('change', render);

    root.appendChild(card([tabs]));
    Object.keys(forms).forEach(function (id) { root.appendChild(forms[id].node); });
    root.appendChild(outBlock);

    show('spf');

    return { destroy: function () { D.clear(root); } };
  });

  /* ======================================================================
     导出与自测
     ====================================================================== */

  window.ItTools.logic['dns-record-generator'] = {
    fqdn: fqdn,
    normalizeReportAddress: normalizeReportAddress,
    lengthNote: lengthNote,
    extractPublicKey: extractPublicKey,
    clampPct: clampPct,
    buildSpf: buildSpf,
    buildDkim: buildDkim,
    buildDmarc: buildDmarc,
    buildBimi: buildBimi,
    __cases: function (assert) {
      /* ---- 通用 ---- */
      assert.eq(fqdn(' Example.COM. '), 'example.com', '去空白、去尾点、转小写');
      assert.eq(normalizeReportAddress('a@x.com'), 'mailto:a@x.com', '补 mailto 前缀');
      assert.eq(normalizeReportAddress('mailto:a@x.com'), 'mailto:a@x.com', '已有 mailto 不重复加');
      assert.eq(normalizeReportAddress('https://x.com/r'), 'https://x.com/r', 'https 报告地址原样保留');
      assert.eq(normalizeReportAddress('a@x.com, b@y.com'), 'mailto:a@x.com,mailto:b@y.com', '多个地址逐个处理');
      assert.eq(normalizeReportAddress(''), '', '空串');
      assert.eq(lengthNote('short'), null, '不超长不给提示');
      assert(lengthNote(new Array(257).join('x')) !== null, '256 字节超限给提示');
      assert.eq(lengthNote(new Array(256).join('x')), null, '正好 255 字节不提示');
      assert(lengthNote(new Array(100).join('中')) !== null, '中文按 UTF-8 字节算：99 字 = 297 字节，超限');
      assert.eq(clampPct(50), 50, '正常百分比');
      assert.eq(clampPct(-1), 0, '负数夹到 0');
      assert.eq(clampPct(150), 100, '超量夹到 100');
      assert.eq(clampPct('x'), 100, '非数字退回 100');
      assert.eq(clampPct('33.3'), 33.3, '允许小数');

      /* ---- SPF ---- */
      assert.eq(buildSpf({ domain: 'example.com', mechanisms: [], all: '-all' }).value,
        'v=spf1 -all', '只有 all');
      assert.eq(buildSpf({
        domain: 'Example.com.', all: '-all',
        mechanisms: [{ type: 'ip4', value: '203.0.113.10' }, { type: 'include', value: '_spf.google.com' }, { type: 'a' }]
      }).value, 'v=spf1 ip4:203.0.113.10 include:_spf.google.com a -all', '三种机制');
      assert.eq(buildSpf({
        domain: 'x.com', all: '~all',
        mechanisms: [{ qualifier: '-', type: 'ip4', value: '1.2.3.4' }]
      }).value, 'v=spf1 -ip4:1.2.3.4 ~all', '限定符');
      assert.eq(buildSpf({ domain: 'x.com', mechanisms: [{ qualifier: '?', type: 'exists', value: '%{i}.example.com' }] }).value,
        'v=spf1 ?exists:%{i}.example.com -all', '未指定 all 时默认 -all');
      assert.eq(buildSpf({ domain: 'x.com', mechanisms: [{ qualifier: '+', type: 'a', value: 'ignored' }] }).value,
        'v=spf1 +a -all', '不需要值的机制不追加冒号');
      assert.eq(buildSpf({ domain: 'x.com', mechanisms: [{ type: 'include', value: '' }] }).note,
        t('note_spf_missing_value', 'Ignored mechanisms without a value: {list}').replace('{list}', 'include'),
        '缺值的机制被忽略并说明');
      assert.eq(buildSpf({ domain: 'x.com', mechanisms: [{ type: 'include', value: '' }] }).value,
        'v=spf1 -all', '缺值的机制不进记录');
      assert.eq(buildSpf({ domain: 'x.com', mechanisms: [{ type: '' }, null] }).value, 'v=spf1 -all', '空机制被跳过');

      /* ---- DKIM ---- */
      var pem = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\nhkiG9w0BAQ\n-----END PUBLIC KEY-----';
      assert.eq(extractPublicKey(pem), 'MIIBIjANBgkqhkiG9w0BAQ', 'PEM 头尾与换行都剥掉');
      assert.eq(extractPublicKey('  AAA BBB\nCCC '), 'AAABBBCCC', '裸 base64 里的空白也去掉');
      assert.eq(extractPublicKey(''), '', '空输入');
      var dk = buildDkim({ selector: 's1', domain: 'example.com', keyType: 'rsa', publicKey: pem });
      assert.eq(dk.name, 's1._domainkey.example.com', '记录名');
      assert.eq(dk.value, 'v=DKIM1; p=MIIBIjANBgkqhkiG9w0BAQ', 'rsa 是默认，k= 不写');
      assert.eq(dk.note, null, '完整记录没有提示');
      assert.eq(buildDkim({ selector: 'k', domain: 'x.com', keyType: 'ed25519', publicKey: 'AAAA' }).value,
        'v=DKIM1; k=ed25519; p=AAAA', '非默认类型才写 k=');
      assert.eq(buildDkim({ selector: 's1', domain: 'x.com', keyType: 'rsa', publicKey: '' }).note,
        t('note_dkim_no_key', 'No public key yet - this record is incomplete, paste the public key in before publishing'),
        '没公钥时提示不完整');
      assert.eq(buildDkim({ selector: '', domain: 'x.com', keyType: 'rsa', publicKey: 'AA' }).name,
        'x.com', '没填 selector 就只给域名，不留半截 _domainkey 前缀');

      /* ---- DMARC ---- */
      var dm = buildDmarc({ domain: 'Example.com', policy: 'reject', pct: 100, rua: 'r@x.com' });
      assert.eq(dm.name, '_dmarc.example.com', '记录名');
      assert.eq(dm.value, 'v=DMARC1; p=reject; rua=mailto:r@x.com', '基本记录');
      assert.eq(dm.note, null, '该说的都说了、记录也不长，就不给提示');
      assert(buildDmarc({ domain: 'x.com', policy: 'none', rua: '' }).note
        .indexOf(t('note_dmarc_policy_none', 'p=none is only an observation mode: recipients will not reject any mail because of it')) !== -1,
        'p=none 提醒这只是观察模式');
      assert(buildDmarc({ domain: 'x.com', policy: 'reject', rua: '' }).note
        .indexOf(t('note_dmarc_no_rua', 'rua is not set: nobody receives the authentication results, which is the same as not turning on DMARC monitoring')) !== -1,
        '没 rua 提醒等于没监控');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', sp: 'reject', pct: 100, rua: 'a@x.com' }).value,
        'v=DMARC1; p=none; sp=reject; rua=mailto:a@x.com', 'sp 与 p 不同才写');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', sp: 'none', pct: 100, rua: 'a@x.com' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com', 'sp 与 p 相同就不重复写');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'quarantine', pct: 50, rua: 'a@x.com' }).value,
        'v=DMARC1; p=quarantine; pct=50; rua=mailto:a@x.com', 'pct=100 不写');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: 100, rua: 'a@x.com', fo: '1' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; fo=1', 'fo');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: 100, rua: 'a@x.com', ruf: 'f@x.com' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; ruf=mailto:f@x.com', 'ruf');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'none', pct: 100, rua: 'a@x.com', adkim: 's', aspf: 'r' }).value,
        'v=DMARC1; p=none; rua=mailto:a@x.com; adkim=s; aspf=r', '对齐模式');
      assert(buildDmarc({ domain: 'x.com', policy: 'none', pct: 100, rua: 'a@x.com', adkim: 's' }).note
        .indexOf(t('note_dmarc_alignment_s', '{key} is set to s (strict): SPF and DKIM must **both** be aligned').replace('{key}', 'adkim')) !== -1,
        'strict 模式给出说明');
      assert.eq(buildDmarc({ domain: 'x.com', policy: 'weird', pct: 100, rua: 'a@x.com' }).value,
        'v=DMARC1; p=weird; rua=mailto:a@x.com', '未知策略原样透传（不偷偷改用户意图）');
      assert.eq(buildDmarc({}).name, '_dmarc.', '空输入不崩');

      /* ---- BIMI ---- */
      assert.eq(buildBimi({ domain: 'x.com' }).name, 'default._bimi.x.com', '记录名');
      assert.eq(buildBimi({ domain: 'x.com', vmc: pem }).value, 'v=BIMI1; l=MIIBIjANBgkqhkiG9w0BAQ', 'VMC 公钥进 l=');
      assert.eq(buildBimi({ domain: 'x.com', authority: 'https://v.x.com/e.pem' }).value,
        'v=BIMI1; a=https://v.x.com/e.pem', '证据 URL 进 a=');
      assert(buildBimi({ domain: 'x.com' }).note
        .indexOf(t('note_bimi_need_one', 'BIMI needs a VMC public key (l=) or a compliance evidence URL (a=), fill in at least one of them')) !== -1, '什么都没填时提示');
      assert(buildBimi({ domain: 'x.com', authority: 'https://x' }).note
        .indexOf(t('note_bimi_only_authority', 'Only a= is set: most recipients (Gmail in particular) still require a VMC public key in l=')) !== -1, '只有 a= 时提醒 Gmail 还要 l=');
      assert.eq(buildBimi({}).name, 'default._bimi.', '空输入不崩');
    }
  };
})();