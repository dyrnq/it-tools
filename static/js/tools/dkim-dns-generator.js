/* ==========================================================================
   DKIM DNS 记录生成器（dkim-dns-generator）

   贴一段公钥 → 出一条能直接贴进 DNS 的 DKIM TXT 记录。

   ---- 上游那版是什么 ----
   sharevb/it-tools2 的 dkim-dns-generator.vue：它不让人贴公钥，而是在浏览器里
   现生成一对 RSA 密钥（1024 / 2048 / 4096，可加口令），然后把公钥 PEM 剥掉
   头尾拼成 `v=DKIM1; k=rsa; p=…`，输出
   `<selector>._domainkey.<domain> IN TXT "…"`，顺带把私钥也显示出来。

   ---- 差在哪（以及为什么）----
   1. **上游生成的是新密钥，不是你的密钥**：DKIM 的公钥必须与邮件签名时用的
      那把私钥配对。真实场景里密钥由 MTA（postfix / opendkim / Exchange）管理，
      这一版改成「贴公钥」—— 只拼记录，不碰密钥管理。
   2. **上游的公钥格式没交代清楚**：DKIM 记录里的 p= 是 **DER 编码的
      SubjectPublicKeyInfo 的 base64**（也就是 `openssl rsa -pubout` 那段 PEM
      的正文）。这一版在提示里写死这句话，并且**认出 OpenSSH 格式**
      （`ssh-rsa AAAA…`，本站的 ssh-key-pair-generator 产出的正是这个）
      并当场拒绝 —— 那种格式的 base64 解出来不是 DER，贴进 DNS 只会得到一条
      永远验不过的记录。
   3. **上游只给一行 IN TXT**：2048 位 RSA 的公钥 base64 有 ~392 字节，
      超过 DNS 单字符串 255 字节上限。zone 文件里**必须**拆成多个字符串
      （`( "…" "…" )`），这一版的 zone 片段已经拆好了；主流 DNS 面板
      （Cloudflare / Route 53 / Namecheap）粘贴时会自动拆。
   4. **上游的输出是一整行**：记录名、记录值、完整记录、zone 片段这一版
      分开给，各自可复制。
   5. 上游的 keySize 里 1024 位还在推荐之列 —— 这一版不生成密钥，不涉及这个。

   ---- 依赖 ----
   纯字符串拼装：不查 DNS、不发请求、不要外部库。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('dkim-dns-generator');

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
   * DKIM 的 p= 就是长到切不开的那种，只能从中间切。
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

  /** base64 字符集是否合法（允许结尾的 = 填充）。 */
  function isBase64(str) {
    var s = nz(str);
    if (!s) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
    return s.replace(/=+$/, '').length % 4 !== 1;
  }

  /** base64 → 二进制字符串；解不了返回 null。 */
  function b64ToBin(str) {
    try {
      return atob(nz(str).replace(/=+$/, ''));
    } catch (e) {
      return null;
    }
  }

  /** 二进制串 → 十六进制串（用来找 DER 里的 OID）。 */
  function binToHex(bin) {
    var out = '';
    for (var i = 0; i < bin.length; i++) {
      out += ('0' + bin.charCodeAt(i).toString(16)).slice(-2);
    }
    return out;
  }

  /**
   * 认出用户贴的是哪种公钥。
   *
   * @param {string} input
   * @returns {{key: string, format: string, error: string|null}}
   *   format: none / der-b64 / pem-spki / pem-pkcs1 / pem-other / openssh / unknown
   *   error:  'empty' | 'openssh' | 'pkcs1' | 'pem-label' | 'base64' | 'not-der'
   */
  function normalizePublicKey(input) {
    var s = nz(input);
    if (!s) return { key: '', format: 'none', error: null };

    // OpenSSH 公钥：ssh-rsa AAAA… / ssh-ed25519 AAAA… / ecdsa-sha2-nistp256 AAAA…
    // 这种格式的 base64 解出来是 SSH 的 wire 格式，不是 DER —— 不能放进 DKIM。
    if (/^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+/.test(s)) {
      return { key: '', format: 'openssh', error: 'openssh' };
    }

    // PEM：剥掉头尾，只留正文
    var pem = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END [A-Z0-9 ]+-----/.exec(s);
    if (pem) {
      var label = pem[1].trim();
      var body = pem[2].replace(/\s+/g, '');
      if (label === 'PUBLIC KEY') return { key: body, format: 'pem-spki', error: null };
      if (label === 'RSA PUBLIC KEY') return { key: body, format: 'pem-pkcs1', error: 'pkcs1' };
      return { key: body, format: 'pem-other', error: 'pem-label' };
    }

    // 裸 base64
    var b64 = s.replace(/\s+/g, '');
    if (!isBase64(b64)) return { key: b64, format: 'unknown', error: 'base64' };
    var bin = b64ToBin(b64);
    if (bin === null) return { key: b64, format: 'unknown', error: 'base64' };
    // DER 的顶层一定是 SEQUENCE（0x30）
    if (!bin.length || bin.charCodeAt(0) !== 0x30) return { key: b64, format: 'unknown', error: 'not-der' };
    return { key: b64, format: 'der-b64', error: null };
  }

  /**
   * 这把公钥是不是 RSA 的 SubjectPublicKeyInfo。
   *
   * SPKI 的 AlgorithmIdentifier 里带 rsaEncryption 的 OID
   * （1.2.840.113549.1.1.1，DER 字节 06 09 2A 86 48 86 F7 0D 01 01 01）。
   * 不是它就说明贴错了格式 —— 比如 PKCS#1（`BEGIN RSA PUBLIC KEY`）或者
   * ed25519（那种要 k=ed25519，而且 p= 要的是裸密钥而不是 SPKI）。
   */
  function looksLikeRsaSpki(key) {
    var bin = b64ToBin(key);
    if (bin === null) return false;
    return binToHex(bin).indexOf('06092a864886f70d010101') >= 0;
  }

  /**
   * 生成 DKIM 记录。
   *
   * @param {{domain: string, selector: string, publicKey: string}} opts
   * @returns {{name: string, value: string, full: string, zone: string, notes: string[]}}
   */
  function buildDkim(opts) {
    opts = opts || {};
    var notes = [];

    var domain = fqdn(opts.domain);
    var selector = nz(opts.selector);
    var name = (selector && domain) ? selector + '._domainkey.' + domain : '';

    var norm = normalizePublicKey(opts.publicKey);
    var key = norm.key;

    if (norm.error === 'openssh') {
      notes.push(t('note_openssh', 'This is an OpenSSH public key (ssh-rsa …): DKIM needs the base64 of the DER SubjectPublicKeyInfo instead. Convert it with `openssl rsa -pubout -outform PEM` and paste the body of the PEM block'));
    } else if (norm.error === 'pkcs1') {
      notes.push(t('note_pkcs1', 'This is a PKCS#1 RSA public key: DKIM needs the SubjectPublicKeyInfo form. Convert it with `openssl rsa -pubout`'));
    } else if (norm.error === 'pem-label') {
      notes.push(t('note_pem_label', 'This PEM block is not a public key: DKIM needs the `PUBLIC KEY` block printed by `openssl rsa -pubout`'));
    } else if (norm.error === 'base64') {
      notes.push(t('note_bad_base64', 'The public key is not valid base64: check that nothing but the base64 body was pasted'));
    } else if (norm.error === 'not-der') {
      notes.push(t('note_not_der', 'This base64 does not decode to a DER structure: DKIM needs the DER SubjectPublicKeyInfo, not an OpenSSH or raw key'));
    } else if (!key) {
      notes.push(t('note_no_key', 'No public key yet: this record is incomplete, paste the public key in before publishing'));
    } else if (!looksLikeRsaSpki(key)) {
      notes.push(t('note_not_rsa', 'This does not look like an RSA SubjectPublicKeyInfo: check that the key really is the RSA key pair that signs your mail'));
    }

    if (!selector) {
      notes.push(t('note_no_selector', 'Fill in the selector: the record has to be published at <selector>._domainkey.{domain}')
        .replace('{domain}', function () { return domain || 'example.com'; }));
    }
    if (!domain) {
      notes.push(t('note_no_domain', 'Fill in the domain to get the name of the record'));
    }

    // RFC 6376 §3.1：v= 第一个，k= 是密钥类型（rsa 是默认值，写出来更保险），
    // p= 是公钥。标签之间一个分号加一个空格，末尾不留空格。
    var tags = ['v=DKIM1', 'k=rsa'];
    if (key) tags.push('p=' + key);
    var value = tags.join('; ');

    var bytes = byteLen(value);
    if (bytes > 255) {
      notes.push(t('note_too_long', 'The record value is {bytes} bytes, over the 255-byte limit of a single DNS string: the zone snippet below is already split into several strings, most DNS panels split it for you')
        .replace('{bytes}', function () { return String(bytes); }));
    }

    return {
      name: name,
      value: value,
      full: name ? name + '. IN TXT "' + value + '"' : '',
      zone: name ? zoneBlock(name, value, t('zone_comment', 'DKIM public key for {name}')
        .replace('{name}', function () { return name; })) : '',
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

  window.ItTools.register('dkim-dns-generator', function (root) {
    function textField(label, value, hint) {
      var el = D.h('input.layui-input', { type: 'text', value: value, spellcheck: 'false' });
      return { el: el, node: U.field(label, el, { wide: true, hint: hint }) };
    }

    var fDomain = textField(t('label_domain', 'Domain'), 'example.com',
      t('hint_domain', 'The domain that signs the mail, e.g. example.com'));
    var fSelector = textField(t('label_selector', 'Selector'), 'default',
      t('hint_selector', 'The part in front of ._domainkey. Any name works, a date or a purpose is common, e.g. default / mail / 20260101'));
    var fKey = (function () {
      var el = D.h('textarea.layui-textarea', { rows: 6, spellcheck: 'false' });
      el.value = '';
      return { el: el, node: U.field(t('label_public_key', 'Public key'), el, {
        wide: true,
        hint: t('hint_public_key', 'Paste the base64 of the DER-encoded SubjectPublicKeyInfo, that is the body of the PEM block printed by `openssl rsa -pubout`. The OpenSSH format `ssh-rsa AAAA…` cannot be used here')
      }) };
    })();

    var inputCard = D.h('div.card', null,
      D.h('p.field-hint', { text: t('desc', 'DKIM signs every outgoing mail with a private key and publishes the matching public key in DNS. Paste the public key and publish the record at <selector>._domainkey.<domain>.') }),
      fDomain.node,
      fSelector.node,
      fKey.node
    );

    var outName = D.h('input.layui-input', { type: 'text', readonly: 'readonly', spellcheck: 'false' });
    var outValue = D.h('textarea.layui-textarea', { rows: 4, readonly: 'readonly', spellcheck: 'false' });
    var outFull = D.h('input.layui-input', { type: 'text', readonly: 'readonly', spellcheck: 'false' });
    var outZone = D.h('textarea.layui-textarea', { rows: 5, readonly: 'readonly', spellcheck: 'false' });
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
      var rec = buildDkim({
        domain: fDomain.el.value,
        selector: fSelector.el.value,
        publicKey: fKey.el.value
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

  window.ItTools.logic['dkim-dns-generator'] = {
    fqdn: fqdn,
    byteLen: byteLen,
    splitTxt: splitTxt,
    isBase64: isBase64,
    normalizePublicKey: normalizePublicKey,
    looksLikeRsaSpki: looksLikeRsaSpki,
    buildDkim: buildDkim,
    zoneLine: zoneLine,
    __cases: function (assert) {
      /* 一把真的 2048 位 RSA 公钥（SubjectPublicKeyInfo 的 base64 前缀）。
         完整的 2048 位密钥有 392 个字符，这里只取头部做形状检查。 */
      var RSA_HEAD = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';
      var PEM = '-----BEGIN PUBLIC KEY-----\n' + RSA_HEAD + 'AAAA\n-----END PUBLIC KEY-----';

      /* ---- 归一化 ---- */
      assert.eq(normalizePublicKey('').format, 'none', '空输入');
      assert.eq(normalizePublicKey('  ').error, null, '空白不算错误');
      assert.eq(normalizePublicKey(RSA_HEAD + 'AAAA').key, RSA_HEAD + 'AAAA', '裸 base64 原样保留');
      assert.eq(normalizePublicKey(RSA_HEAD + 'AAAA').error, null, '裸 base64 没有错误');
      assert.eq(normalizePublicKey(PEM).key, RSA_HEAD + 'AAAA', 'PEM 头尾与换行都剥掉');
      assert.eq(normalizePublicKey(PEM).format, 'pem-spki', '认出 PUBLIC KEY');
      assert.eq(normalizePublicKey(PEM).error, null, 'PUBLIC KEY 没有错误');
      assert.eq(normalizePublicKey('-----BEGIN RSA PUBLIC KEY-----\nAAAA\n-----END RSA PUBLIC KEY-----').error,
        'pkcs1', '认出 PKCS#1');
      assert.eq(normalizePublicKey('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----').error,
        'pem-label', '不是公钥的 PEM 会被点名');
      assert.eq(normalizePublicKey('ssh-rsa AAAAB3NzaC1yc2E user@host').format, 'openssh', '认出 OpenSSH 格式');
      assert.eq(normalizePublicKey('ssh-rsa AAAAB3NzaC1yc2E user@host').error, 'openssh', 'OpenSSH 是错误');
      assert.eq(normalizePublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 user@host').error, 'openssh', 'ed25519 的 OpenSSH 也是错误');
      assert.eq(normalizePublicKey('not base64!!').error, 'base64', '非法 base64');
      assert.eq(normalizePublicKey('AAAA').error, 'not-der', '解出来不是 DER');
      assert(isBase64('MIIBIjANBgkq'), '合法 base64');
      assert(!isBase64('MIIB IjAN'), 'base64 里不能有空格');
      assert(!isBase64('!!!'), '非法字符');

      /* ---- 记录生成 ---- */
      var r = buildDkim({ domain: 'example.com', selector: 'default', publicKey: RSA_HEAD + 'AAAA' });
      assert.eq(r.name, 'default._domainkey.example.com', '记录名');
      assert.eq(r.value, 'v=DKIM1; k=rsa; p=' + RSA_HEAD + 'AAAA', '记录值');
      assert(r.value.indexOf('v=DKIM1') === 0, 'v= 永远是第一个字段');
      assert(!/;\s*$/.test(r.value), '末尾没有多余分号');
      assert.eq(buildDkim({ domain: 'Example.com.', selector: 's1', publicKey: RSA_HEAD + 'AAAA' }).name,
        's1._domainkey.example.com', '域名归一化');
      assert.eq(buildDkim({ domain: 'example.com', selector: '', publicKey: RSA_HEAD + 'AAAA' }).name,
        '', '没有 selector 就没有记录名');
      assert(buildDkim({ domain: 'example.com', selector: '', publicKey: RSA_HEAD + 'AAAA' }).notes
        .indexOf(t('note_no_selector', 'Fill in the selector: the record has to be published at <selector>._domainkey.{domain}')
          .replace('{domain}', function () { return 'example.com'; })) !== -1,
        '缺 selector 时提醒');
      assert.eq(buildDkim({ domain: '', selector: 's1', publicKey: RSA_HEAD + 'AAAA' }).name,
        '', '没有域名就没有记录名');
      assert.eq(buildDkim({ domain: 'example.com', selector: 's1', publicKey: '' }).value,
        'v=DKIM1; k=rsa', '没公钥时不写 p=');
      assert(buildDkim({ domain: 'example.com', selector: 's1', publicKey: '' }).notes
        .indexOf(t('note_no_key', 'No public key yet: this record is incomplete, paste the public key in before publishing')) !== -1,
        '没公钥时提醒');
      assert(buildDkim({ domain: 'example.com', selector: 's1', publicKey: 'ssh-rsa AAAAB3NzaC1yc2E user@host' }).notes
        .indexOf(t('note_openssh', 'This is an OpenSSH public key (ssh-rsa …): DKIM needs the base64 of the DER SubjectPublicKeyInfo instead. Convert it with `openssl rsa -pubout -outform PEM` and paste the body of the PEM block')) !== -1,
        'OpenSSH 格式当场被点名');
      assert(buildDkim({ domain: 'example.com', selector: 's1', publicKey: 'ssh-rsa AAAAB3NzaC1yc2E user@host' }).value,
        'v=DKIM1; k=rsa', 'OpenSSH 格式不进记录');
      assert(buildDkim({ domain: 'example.com', selector: 's1', publicKey: 'not base64!!' }).notes
        .indexOf(t('note_bad_base64', 'The public key is not valid base64: check that nothing but the base64 body was pasted')) !== -1,
        '非法 base64 被点名');
      assert.eq(buildDkim({}).name, '', '空输入不崩');
      assert.eq(buildDkim({}).value, 'v=DKIM1; k=rsa', '空输入也有记录值');

      /* ---- 255 字节切分 ---- */
      var longKey = new Array(400).join('A');
      var rec = buildDkim({ domain: 'example.com', selector: 's1', publicKey: longKey });
      assert(byteLen(rec.value) > 255, '这条记录确实超了 255 字节');
      assert(rec.notes
        .indexOf(t('note_too_long', 'The record value is {bytes} bytes, over the 255-byte limit of a single DNS string: the zone snippet below is already split into several strings, most DNS panels split it for you')
          .replace('{bytes}', function () { return String(byteLen(rec.value)); })) !== -1,
        '超长时提醒');
      assert(rec.zone.indexOf('( "') > 0, 'zone 片段里拆成了多个字符串');
      var parts = splitTxt(rec.value);
      assert(parts.join('') === rec.value, '拆开再拼起来还是原来那个值');
      assert(parts.every(function (p) { return byteLen(p) <= 255; }), '每段都不超过 255 字节');
      assert.eq(splitTxt('short').length, 1, '短值不切');
    }
  };
})();
