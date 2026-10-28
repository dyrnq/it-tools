/* ==========================================================================
   BIMI DNS 生成器（bimi-dns-generator）

   填一张表单 → 一条把品牌标识（logo）挂到域名上的 BIMI TXT 记录：

       default._bimi.example.com IN TXT "v=BIMI1; l=https://example.com/logo.svg"

   参考实现：/data/work/it-tools2/src/tools/bimi-dns-generator/（it-tools, GPLv3）。
   上游那版是三个输入框、一个输出框，这里修了五处：

   1. **l= 不检查 HTTPS**。BIMI 规范要求 logo 用 https 给出，上游照单全收，
      `http://` 的 logo 也会原样写进记录 —— 而收件方（Gmail、Microsoft 365）
      一律当没配过。这里非 https 直接报错。
   2. **缺输入时输出是空字符串**。上游在域名或 logo 为空时返回空串，
      结果框里什么也没有，用户分不清是自己没填还是工具坏了。这里给一句话说明。
   3. **a= 只认 URL**。BIMI 规范允许用 `mailto:` 给权威证据（authority evidence），
      上游没有这条路；这里裸邮箱自动补 mailto:。
   4. **域名是原样拼的**。上游把用户输入直接接在 `default._bimi.` 后面：
      带结尾的点就多一个点（default._bimi.example.com.），带空格就拼出一个
      根本解析不了的域名。这里归一化：去空白、去结尾的点、转小写。
   5. **值里的 ";" 没人管**。BIMI 的标签是用分号分隔的，而分号在 URL 里是合法字符
      （https://x/logo.svg;a=1），拼出来的记录会被解析成 `l=https://x/logo.svg`
      外加一个野标签 `a=1`。这里直接拒绝带空格/分号/引号的值。

   另外上游只给一整条 zone 记录（主机名和值混在一起），这里拆成
   主机名、值、完整记录、zone 文件片段四段，各自带复制按钮。

   依赖：无。纯字符串拼装，不需要查 DNS，也就不需要动 manifest.tsv。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('bimi-dns-generator');

  /* ======================================================================
     纯逻辑
     ====================================================================== */

  /** 去首尾空白。 */
  function nz(str) {
    return String(str == null ? '' : str).trim();
  }

  /**
   * 域名归一化：去空白、去结尾的点、转小写。
   *
   * 结尾那个点有人会习惯性地带上（FQDN 的写法），而在 DNS 服务商的后台里
   * 把它跟后缀拼起来，很容易变成两个点。
   */
  function normalizeDomain(str) {
    return nz(str).replace(/\.+$/, '').toLowerCase();
  }

  /** 主机名是否合法：每段是字母数字或连字符，不能以连字符开头结尾，至少两段。 */
  function isValidDomain(str) {
    var s = nz(str);
    if (!s || s.length > 253) return false;
    var labels = s.split('.');
    if (labels.length < 2) return false;
    return labels.every(function (label) {
      return label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
    });
  }

  /**
   * 绝对 URL 解析。
   *
   * 浏览器自带的 URL 构造器很宽容（「https:/x」也收），这里额外要求协议后面
   * 是两个斜杠 —— BIMI 的 l= 要的是一个真正的 URL，不是「看着像」。
   */
  function parseAbsoluteUrl(str) {
    var s = nz(str);
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (!u.hostname) return null;
    return u;
  }

  /** 邮箱粗判：够用即可，不追求 RFC 5322 全套。 */
  function isEmail(str) {
    return /^[^\s@,;:<>()\[\]\\"]+@[^\s@,;:<>()\[\]\\"]+\.[^\s@,;:<>()\[\]\\"]+$/.test(str);
  }

  /**
   * 值里不能出现的字符：空格、分号、引号、反斜杠。
   *
   * 分号是 BIMI 的标签分隔符，引号是 zone 文件里 TXT 值的定界符 ——
   * 这两个字符出现在 l= 或 a= 的值里，整条记录就会被拆坏。
   */
  function hasBreakingChars(str) {
    return /[\s;"\\]/.test(str);
  }

  /**
   * a=（权威证据）的归一化。
   *
   * 规范给两种写法：VMC 证书的 URL，或者 mailto: 邮箱。
   * @param {string} str
   * @returns {{value: string, error: (string|null), insecure: boolean}}
   */
  function normalizeAuthority(str) {
    var s = nz(str);
    if (!s) return { value: '', error: null, insecure: false };
    if (/^mailto:/i.test(s)) {
      var addr = nz(s.slice(7));
      if (!isEmail(addr)) return { value: '', error: 'authority_invalid', insecure: false };
      return { value: 'mailto:' + addr, error: null, insecure: false };
    }
    if (isEmail(s)) return { value: 'mailto:' + s, error: null, insecure: false };
    var u = parseAbsoluteUrl(s);
    if (!u) return { value: '', error: 'authority_invalid', insecure: false };
    return { value: s, error: null, insecure: u.protocol !== 'https:' };
  }

  /**
   * 生成 BIMI 记录。
   *
   * @param {{domain: string, logoUrl: string, authority: string}} opts
   * @returns {{ok: boolean, error: (?{code: string, params: object}),
   *            host: string, value: string, record: string, zone: string,
   *            notes: string[]}}
   */
  function buildBimi(opts) {
    opts = opts || {};
    var notes = [];

    var domain = normalizeDomain(opts.domain);
    var logoRaw = nz(opts.logoUrl);
    var authorityRaw = nz(opts.authority);

    if (!domain) return fail('domain_required');
    if (!isValidDomain(domain)) return fail('domain_invalid');
    if (!logoRaw) return fail('logo_required');

    var logoUrl = parseAbsoluteUrl(logoRaw);
    if (!logoUrl) return fail('logo_invalid');
    if (logoUrl.protocol !== 'https:') return fail('logo_scheme');
    if (hasBreakingChars(logoRaw)) return fail('logo_charset');

    var authority = normalizeAuthority(authorityRaw);
    if (authority.error) return fail(authority.error);
    if (authority.value && hasBreakingChars(authority.value)) return fail('authority_invalid');

    var host = 'default._bimi.' + domain;
    var value = 'v=BIMI1; l=' + logoRaw;
    if (authority.value) value += '; a=' + authority.value;

    if (!authority.value) {
      notes.push(t('note_no_authority', 'No a= tag: recipients that demand a VMC (Gmail, Microsoft 365) will not display the logo.'));
    }
    if (!/\.svg(\?|#|$)/i.test(logoRaw)) {
      notes.push(t('note_svg', 'Most recipients only display the logo when it is an SVG (SVG Tiny P/S).'));
    }
    if (authority.insecure) {
      notes.push(t('note_authority_insecure', 'The authority evidence is not served over HTTPS: some verifiers refuse it.'));
    }

    return {
      ok: true,
      error: null,
      host: host,
      value: value,
      // 完整记录：DNS 服务商后台里「主机名 / 类型 / 值」三栏填的就是这个
      record: host + ' IN TXT "' + value + '"',
      // zone 文件片段：名字后面那个点是「绝对名」的写法
      zone: host + '. IN TXT "' + value + '"',
      notes: notes
    };
  }

  /** 失败时的统一返回。 */
  function fail(code) {
    return {
      ok: false,
      error: { code: code, params: {} },
      host: '', value: '', record: '', zone: '',
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
      case 'domain_required':
        return t('err_domain_required', 'Please fill in the domain.');
      case 'domain_invalid':
        return t('err_domain_invalid', 'That is not a valid domain name.');
      case 'logo_required':
        return t('err_logo_required', 'Please fill in the logo URL.');
      case 'logo_invalid':
        return t('err_logo_invalid', 'The logo URL must be an absolute URL, for example https://example.com/logo.svg.');
      case 'logo_scheme':
        return t('err_logo_scheme', 'The logo URL must use https:// - the BIMI specification requires HTTPS.');
      case 'logo_charset':
        return t('err_logo_charset', 'The logo URL must not contain a space, a ";" or a quote: they would break the tag syntax of the record.');
      case 'authority_invalid':
        return t('err_authority_invalid', 'The authority evidence must be an HTTPS URL or an email address.');
      default:
        return t('err_unknown', 'The BIMI record could not be generated.');
    }
  }

  /* ======================================================================
     界面
     ====================================================================== */

  window.ItTools.register('bimi-dns-generator', function (root) {
    var domainInput = D.h('input.layui-input', {
      type: 'text', value: 'example.com', spellcheck: 'false',
      placeholder: t('ph_domain', 'e.g. example.com')
    });
    var logoInput = D.h('input.layui-input', {
      type: 'text', value: 'https://example.com/logo.svg', spellcheck: 'false',
      placeholder: t('ph_logo', 'https://example.com/logo.svg')
    });
    var authorityInput = D.h('input.layui-input', {
      type: 'text', value: '', spellcheck: 'false',
      placeholder: t('ph_authority', 'https://example.com/vmc.pem or compliance@example.com')
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

    var hostRow = outRow(t('out_host', 'Hostname'), t('copy_host', 'Copy hostname'));
    var valueRow = outRow(t('out_value', 'Value (TXT)'), t('copy_value', 'Copy value'));
    var recordRow = outRow(t('out_record', 'Full record'), t('copy_record', 'Copy record'));

    // zone 文件片段用等宽块：IPv6 的反向名有 70 多个字符，
    // 塞进一个输入框里只能横向拖着看。
    var zoneBlock = U.codeBlock();

    var status = D.h('p.form-status');
    var notesBox = D.h('div');

    var outCard = D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('out_title', 'Generated BIMI record') })),
      hostRow.node,
      valueRow.node,
      recordRow.node,
      D.h('p.field-label', { text: t('out_zone', 'Zone file') }),
      zoneBlock.card,
      D.h('p.field-hint', {
        text: t('hint_zone', 'The zone file form ends the name with a dot, which is what makes it absolute.')
      }),
      status,
      notesBox
    );

    var inCard = D.h('div.card', null,
      U.field(t('label_domain', 'Domain'), domainInput, {
        wide: true,
        hint: t('hint_domain', 'The domain that sends the mail. The record lives under the "default" selector, at default._bimi.<domain>.')
      }),
      U.field(t('label_logo', 'Logo URL (l=)'), logoInput, {
        wide: true,
        hint: t('hint_logo', 'The logo location. It must be an absolute HTTPS URL: the BIMI specification asks for https, and recipients ignore an insecure logo.')
      }),
      U.field(t('label_authority', 'Authority evidence (a=)'), authorityInput, {
        wide: true,
        hint: t('hint_authority', 'Optional. Either the URL of a Verified Mark Certificate (VMC), or an email address - mailto: is added for you. Gmail and Microsoft 365 only show the logo when a VMC is present.')
      })
    );

    function render() {
      var res = buildBimi({
        domain: domainInput.value,
        logoUrl: logoInput.value,
        authority: authorityInput.value
      });

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
    offs.push(D.on(domainInput, 'input', render));
    offs.push(D.on(logoInput, 'input', render));
    offs.push(D.on(authorityInput, 'input', render));

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

  window.ItTools.logic['bimi-dns-generator'] = {
    normalizeDomain: normalizeDomain,
    isValidDomain: isValidDomain,
    parseAbsoluteUrl: parseAbsoluteUrl,
    isEmail: isEmail,
    hasBreakingChars: hasBreakingChars,
    normalizeAuthority: normalizeAuthority,
    buildBimi: buildBimi,
    errorMessage: errorMessage,
    __cases: function (assert) {
      /* ---- 归一化 ---- */
      assert.eq(normalizeDomain('  Example.COM.  '), 'example.com', '去空白、去尾点、转小写');
      assert.eq(normalizeDomain('example.com...'), 'example.com', '多个尾点都去掉');
      assert.eq(normalizeDomain(''), '', '空串');
      assert.eq(normalizeDomain('a..b'), 'a..b', '中间的空段保留（那是无效域名，由校验去拦）');

      assert(isValidDomain('example.com'), 'example.com 合法');
      assert(isValidDomain('mail.example.co.uk'), '多级域名合法');
      assert(isValidDomain('xn--fsq.example.com'), 'punycode 合法');
      assert(!isValidDomain('example'), '单段不算域名');
      assert(!isValidDomain('-bad.example.com'), '连字符开头不合法');
      assert(!isValidDomain('bad-.example.com'), '连字符结尾不合法');
      assert(!isValidDomain('a..b.com'), '空段不合法');
      assert(!isValidDomain('exa mple.com'), '空格不合法');
      assert(!isValidDomain(''), '空串不合法');

      /* ---- URL / 邮箱 ---- */
      assert(parseAbsoluteUrl('https://example.com/logo.svg'), 'https URL 能解析');
      assert(parseAbsoluteUrl('http://example.com/logo.svg'), 'http URL 能解析（协议在别处判）');
      assert.eq(parseAbsoluteUrl('example.com/logo.svg'), null, '没有协议不算绝对 URL');
      assert.eq(parseAbsoluteUrl('https:/example.com'), null, '只有一个斜杠不算');
      assert.eq(parseAbsoluteUrl(''), null, '空串');

      assert(isEmail('a@b.com'), '邮箱');
      assert(!isEmail('a@b'), '邮箱必须有域名点');
      assert(!isEmail('https://x.com'), 'URL 不是邮箱');
      assert(!isEmail('mailto:a@b.com'), 'mailto: 前缀不是裸邮箱');

      assert(hasBreakingChars('a;b'), '分号');
      assert(hasBreakingChars('a b'), '空格');
      assert(hasBreakingChars('a"b'), '引号');
      assert(!hasBreakingChars('https://x.com/logo.svg'), '正常 URL 没有坏字符');

      /* ---- a= 归一化 ---- */
      assert.eq(normalizeAuthority('').value, '', '空值');
      assert.eq(normalizeAuthority('  ').value, '', '空白当空值');
      assert.eq(normalizeAuthority('compliance@example.com').value, 'mailto:compliance@example.com', '裸邮箱补 mailto:');
      assert.eq(normalizeAuthority('mailto:compliance@example.com').value, 'mailto:compliance@example.com', '已有 mailto: 不重复加');
      assert.eq(normalizeAuthority('https://example.com/vmc.pem').value, 'https://example.com/vmc.pem', 'URL 原样保留');
      assert.eq(normalizeAuthority('https://example.com/vmc.pem').insecure, false, 'https 不算不安全');
      assert.eq(normalizeAuthority('http://example.com/vmc.pem').insecure, true, 'http 标记为不安全');
      assert.eq(normalizeAuthority('not a url').error, 'authority_invalid', '乱七八糟的值报错');
      assert.eq(normalizeAuthority('mailto:nope').error, 'authority_invalid', 'mailto 后面不是邮箱报错');

      /* ---- 记录生成 ---- */
      var b = buildBimi({
        domain: 'example.com',
        logoUrl: 'https://example.com/logo.svg',
        authority: ''
      });
      assert.eq(b.ok, true, '基本输入没问题');
      assert.eq(b.host, 'default._bimi.example.com', '主机名在 default 选择器下');
      assert.eq(b.value, 'v=BIMI1; l=https://example.com/logo.svg', '记录值');
      assert.eq(b.record, 'default._bimi.example.com IN TXT "v=BIMI1; l=https://example.com/logo.svg"', '完整记录');
      assert.eq(b.zone, 'default._bimi.example.com. IN TXT "v=BIMI1; l=https://example.com/logo.svg"', 'zone 文件片段：名字带尾点');
      assert.eq(b.notes.length, 1, '没填 a=：一条提示（logo 是 svg，不另提）');

      var b2 = buildBimi({
        domain: 'Example.com.',
        logoUrl: 'https://example.com/logo.svg',
        authority: 'https://v.example.com/vmc.pem'
      });
      assert.eq(b2.host, 'default._bimi.example.com', '域名归一化后接上');
      assert.eq(b2.value, 'v=BIMI1; l=https://example.com/logo.svg; a=https://v.example.com/vmc.pem', 'a= 接在后面');
      assert.eq(b2.notes.length, 0, 'a= 齐了、logo 也是 svg：没有提示');

      var b3 = buildBimi({
        domain: 'example.com',
        logoUrl: 'https://example.com/logo.svg',
        authority: 'compliance@example.com'
      });
      assert.eq(b3.value, 'v=BIMI1; l=https://example.com/logo.svg; a=mailto:compliance@example.com', 'a= 用 mailto: 形式');

      // 提示该给的都给：logo 不是 svg、a= 不是 https
      var b4 = buildBimi({
        domain: 'example.com',
        logoUrl: 'https://example.com/logo.png',
        authority: 'http://v.example.com/vmc.pem'
      });
      assert.eq(b4.notes.length, 2, 'logo 不是 svg + a= 不是 https：两条提示');
      assert(b4.notes.join(' ').indexOf(t('note_svg', 'Most recipients only display the logo when it is an SVG (SVG Tiny P/S).')) !== -1,
        '提示里有「logo 最好用 svg」');
      assert(b4.notes.join(' ').indexOf(t('note_authority_insecure', 'The authority evidence is not served over HTTPS: some verifiers refuse it.')) !== -1,
        '提示里有「a= 不是 https」');

      assert.eq(buildBimi({}).error.code, 'domain_required', '什么都没填');
      assert.eq(buildBimi({ domain: 'example.com' }).error.code, 'logo_required', '缺 logo');
      assert.eq(buildBimi({ domain: 'nope', logoUrl: 'https://x.com/a.svg' }).error.code, 'domain_invalid', '域名不合法');
      assert.eq(buildBimi({ domain: 'example.com', logoUrl: 'example.com/logo.svg' }).error.code, 'logo_invalid', 'logo 不是绝对 URL');
      assert.eq(buildBimi({ domain: 'example.com', logoUrl: 'http://example.com/logo.svg' }).error.code, 'logo_scheme', 'logo 不是 https');
      assert.eq(buildBimi({ domain: 'example.com', logoUrl: 'https://example.com/logo.svg;a=1' }).error.code, 'logo_charset', 'logo 里的分号会毁掉标签语法');
      assert.eq(buildBimi({ domain: 'example.com', logoUrl: 'https://example.com/logo.svg', authority: 'zzz' }).error.code,
        'authority_invalid', 'a= 不是 URL 也不是邮箱');
      assert.eq(buildBimi({ domain: 'example.com', logoUrl: 'https://example.com/logo.svg', authority: 'https://x.com/a;b' }).error.code,
        'authority_invalid', 'a= 里的分号同样不行');

      // 错误也有话说：不会静悄悄地给一个空结果
      assert(buildBimi({}).error.code !== null, '非法输入给出错误码');
      assert(errorMessage('logo_scheme').length > 0, '错误码能翻出文案');
      assert(errorMessage('nope').length > 0, '未知错误码也有兜底文案');
    }
  };
})();
