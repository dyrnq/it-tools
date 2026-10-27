/* ==========================================================================
   JWT 解析器（jwt-parser）

   把 JWT 的 header / payload 两段 base64url 解开，逐条列出 claim；
   另有一张「签名验证」卡片，把令牌拿去服务端验签（上游 PR #1453 带过来的）。

   参考实现：src/tools/jwt-parser/（it-tools, GPLv3）
   与原版的差别：
   1. 原版用 jwt-decode，这里自己解 base64url（补齐 '=' 填充后交给 atob），
      不引第三方库。行为对齐 jwt-decode：段数不对、base64 非法、
      JSON 不合法一律抛错。
   2. 原版对 exp / nbf / iat 无条件按时间戳格式化，遇到非数字就显示
      "Invalid Date"。这里非有限数直接不给友好值。
   3. 嵌套 claim 的缩进原版用 3，这里用常规的 2。
   4. 原版是一张表加两个表头行；这里拆成 header / payload 两张表。
   5. 验签放在**服务端**（POST /api/jwt/verify）：WebCrypto 只在安全上下文
      （https / localhost）里存在，本服务通常跑在内网的明文 http 上，
      浏览器端压根没有 crypto.subtle。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('jwt-parser');

  /** RFC 7518 §3.1 的算法说明。 */
  var ALGORITHM_DESCRIPTIONS = {
    HS256: 'HMAC using SHA-256',
    HS384: 'HMAC using SHA-384',
    HS512: 'HMAC using SHA-512',
    RS256: 'RSASSA-PKCS1-v1_5 using SHA-256',
    RS384: 'RSASSA-PKCS1-v1_5 using SHA-384',
    RS512: 'RSASSA-PKCS1-v1_5 using SHA-512',
    ES256: 'ECDSA using P-256 and SHA-256',
    ES384: 'ECDSA using P-384 and SHA-384',
    ES512: 'ECDSA using P-521 and SHA-512',
    PS256: 'RSASSA-PSS using SHA-256 and MGF1 with SHA-256',
    PS384: 'RSASSA-PSS using SHA-384 and MGF1 with SHA-384',
    PS512: 'RSASSA-PSS using SHA-512 and MGF1 with SHA-512',
    none: 'No digital signature or MAC performed'
  };

  /** IANA 的 JWT claim 列表。 */
  var CLAIM_DESCRIPTIONS = {
    typ: 'Type',
    alg: 'Algorithm',
    iss: 'Issuer',
    sub: 'Subject',
    aud: 'Audience',
    exp: 'Expiration Time',
    nbf: 'Not Before',
    iat: 'Issued At',
    jti: 'JWT ID',
    name: 'Full name',
    given_name: 'Given name(s) or first name(s)',
    family_name: 'Surname(s) or last name(s)',
    middle_name: 'Middle name(s)',
    nickname: 'Casual name',
    preferred_username: 'Shorthand name by which the End-User wishes to be referred',
    profile: 'Profile page URL',
    picture: 'Profile picture URL',
    website: 'Web page or blog URL',
    email: 'Preferred e-mail address',
    email_verified: 'True if the e-mail address has been verified; otherwise false',
    gender: 'Gender',
    birthdate: 'Birthday',
    zoneinfo: 'Time zone',
    locale: 'Locale',
    phone_number: 'Preferred telephone number',
    phone_number_verified: 'True if the phone number has been verified; otherwise false',
    address: 'Preferred postal address',
    updated_at: 'Time the information was last updated',
    azp: 'Authorized party - the party to which the ID Token was issued',
    nonce: 'Value used to associate a Client session with an ID Token',
    auth_time: 'Time when the authentication occurred',
    at_hash: 'Access Token hash value',
    c_hash: 'Code hash value',
    acr: 'Authentication Context Class Reference',
    amr: 'Authentication Methods References',
    sub_jwk: 'Public key used to check the signature of an ID Token',
    cnf: 'Confirmation',
    sip_from_tag: 'SIP From tag header field parameter value',
    sip_date: 'SIP Date header field value',
    sip_callid: 'SIP Call-Id header field value',
    sip_cseq_num: 'SIP CSeq numeric header field parameter value',
    sip_via_branch: 'SIP Via branch field parameter value',
    orig: 'Originating Identity String',
    dest: 'Destination Identity String',
    mky: 'Media Key Fingerprint String',
    events: 'Security Events',
    toe: 'Time of Event',
    txn: 'Transaction Identifier',
    rph: 'Resource Priority Header Authorization',
    sid: 'Session ID',
    vot: 'Vector of Trust value',
    vtm: 'Vector of Trust trustmark URL',
    attest: 'Attestation level as defined in SHAKEN framework',
    origid: 'Originating Identifier as defined in SHAKEN framework',
    act: 'Actor',
    scope: 'Scope Values',
    client_id: 'Client Identifier',
    may_act: 'Authorized Actor - the party that is authorized to become the actor',
    jcard: 'jCard data',
    at_use_nbr: 'Number of API requests for which the access token can be used',
    div: 'Diverted Target of a Call',
    opt: 'Original PASSporT (in Full Form)',
    vc: 'Verifiable Credential as specified in the W3C Recommendation',
    vp: 'Verifiable Presentation as specified in the W3C Recommendation',
    sph: 'SIP Priority header field',
    ace_profile: 'ACE profile a token is supposed to be used with.',
    cnonce: 'Client nonce',
    exi: 'Expires in',
    roles: 'Roles',
    groups: 'Groups',
    entitlements: 'Entitlements',
    token_introspection: 'Token introspection response'
  };

  /** 需要按本地时间展示的 claim。 */
  var TIME_CLAIMS = ['exp', 'nbf', 'iat'];

  /**
   * 解一段 base64url。atob 只认标准 base64，先把 -_ 换回 +/ 并补齐 = 填充。
   * @throws {Error} 段里出现非 base64 字符，或长度对不上
   */
  function decodeBase64Url(segment) {
    var text = String(segment).trim().replace(/=+$/, '');
    if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('段里含有非 base64url 字符');
    if (text.length % 4 === 1) throw new Error('base64url 长度非法');
    var padded = text.replace(/-/g, '+').replace(/_/g, '/');
    padded += '='.repeat((4 - (padded.length % 4)) % 4);
    try {
      return U.utf8Decode(U.base64ToBytes(padded));
    } catch (e) {
      throw new Error('base64url 解码失败');
    }
  }

  /** 解一段并 JSON.parse。 */
  function decodeSegment(segment) {
    var json = decodeBase64Url(segment);
    var value;
    try {
      value = JSON.parse(json);
    } catch (e) {
      throw new Error('段不是合法的 JSON');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('段必须是一个 JSON 对象');
    }
    return value;
  }

  /** 把 Date 格式化成「日期 + 时间」。非有限数返回 undefined。 */
  function dateFormatter(value) {
    if (value === null || value === undefined || value === '') return undefined;
    var seconds = Number(value);
    if (!Number.isFinite(seconds)) return undefined;
    var date = new Date(seconds * 1000);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  }

  /** claim 的人类可读附注：时间戳转本地时间，算法名转说明。 */
  function getFriendlyValue(claim, value) {
    if (TIME_CLAIMS.indexOf(claim) !== -1) return dateFormatter(value);
    if (claim === 'alg' && typeof value === 'string') return ALGORITHM_DESCRIPTIONS[value];
    return undefined;
  }

  /** 把一个 claim 整理成 UI 要的行。 */
  function parseClaim(claim, value) {
    var isPlain = value !== null && typeof value === 'object';
    return {
      claim: claim,
      claimDescription: CLAIM_DESCRIPTIONS[claim],
      value: isPlain ? JSON.stringify(value, null, 2) : (value === null || value === undefined ? '' : String(value)),
      friendlyValue: getFriendlyValue(claim, value)
    };
  }

  /**
   * 主函数：解出一个 JWT 的 header 与 payload。
   * @param {string} jwt
   * @returns {{header: object[], payload: object[], signature: string, signed: boolean}}
   * @throws {Error} 结构不对或内容解不开
   */
  function decodeJwt(jwt) {
    if (typeof jwt !== 'string' || !jwt.trim()) throw new Error('JWT 为空');
    var parts = jwt.trim().split('.');
    // JWS 三段（签名可缺省成两段）；JWE 五段，payload 不是 base64url 的 JSON，解不了
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(parts.length > 3 ? '这是 JWE（加密令牌），本工具只解未加密的 JWS' : 'JWT 至少要有两段');
    }
    var header = decodeSegment(parts[0]);
    var payload = decodeSegment(parts[1]);

    return {
      header: Object.keys(header).map(function (k) { return parseClaim(k, header[k]); }),
      payload: Object.keys(payload).map(function (k) { return parseClaim(k, payload[k]); }),
      signature: parts[2] || '',
      signed: parts.length === 3 && parts[2] !== ''
    };
  }

  /** 不抛错的版本，给 UI 用。 */
  function tryDecodeJwt(jwt) {
    try {
      return { ok: true, data: decodeJwt(jwt) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  /**
   * 从令牌里读出它自己声明的算法。读不出来就返回 null。
   * @param {string} jwt
   * @returns {string|null}
   */
  function algOf(jwt) {
    try {
      var parts = String(jwt || '').trim().split('.');
      if (parts.length < 2) return null;
      var header = decodeSegment(parts[0]);
      return typeof header.alg === 'string' ? header.alg : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 依据令牌自己声明的算法，决定验签请求里该把密钥放在哪个字段。
   *
   * HMAC 用共享口令，其余用公钥 —— 与服务端的「算法混淆」防护一致：
   * 拿公钥当 HMAC 口令的经典攻击（RS256 → HS256）在服务端被直接拒绝，
   * 前端也不该帮用户把它绕过去。
   *
   * @param {string} jwt
   * @param {string} keyMaterial 公钥（PEM / JWK）或共享口令
   * @returns {{token: string, secret?: string, publicKey?: string}}
   */
  function verifyPayload(jwt, keyMaterial) {
    var body = { token: String(jwt || '').trim() };
    var alg = algOf(jwt);
    if (alg && /^HS/.test(alg)) body.secret = keyMaterial;
    else body.publicKey = keyMaterial;
    return body;
  }

  /**
   * 调服务端的验签接口。
   * @param {string} token
   * @param {string} keyMaterial
   * @returns {Promise<object>}
   */
  function verifySignature(token, keyMaterial) {
    return fetch('/api/jwt/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyPayload(token, keyMaterial))
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (!res.ok || !json || json.ok !== true) {
          throw new Error((json && json.error && json.error.message) || ('HTTP ' + res.status));
        }
        return json.data;
      });
    });
  }

  window.ItTools.register('jwt-parser', function (root) {
    var SAMPLE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

    var textarea = D.h('textarea.layui-textarea', {
      rows: 5, value: SAMPLE, spellcheck: 'false', placeholder: t('input_ph', 'Put your token here...')
    });
    var output = D.h('div');

    function claimRow(claim) {
      var left = D.h('td', null, D.h('strong', { text: claim.claim }));
      if (claim.claimDescription) {
        left.appendChild(D.h('span', { style: { opacity: '.7', marginLeft: '8px' }, text: '(' + claim.claimDescription + ')' }));
      }
      var right = D.h('td.val', { text: claim.value });
      if (claim.friendlyValue) {
        right.appendChild(D.h('div', {
          style: { opacity: '.7', marginTop: '4px' }, text: '(' + claim.friendlyValue + ')'
        }));
      }
      return D.h('tr', null, left, right);
    }

    function claimTable(title, claims) {
      var tbody = D.h('tbody');
      claims.forEach(function (c) { tbody.appendChild(claimRow(c)); });
      return D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null, D.h('th', { colspan: '2', text: title }))),
        tbody
      );
    }

    function render() {
      D.clear(output);
      var result = tryDecodeJwt(textarea.value);

      if (!result.ok) {
        output.appendChild(D.h('p.field-hint', { text: result.error }));
        return;
      }

      var data = result.data;
      output.appendChild(D.h('div.field', null,
        D.h('span.badge-note', {
          text: data.signed
            ? 'Signature present but NOT verified — this token is decoded, not validated.'
            : 'Unsecured token (alg=none / no signature) — nothing is verified here.'
        })
      ));
      output.appendChild(claimTable(t('header', 'Header'), data.header));
      output.appendChild(claimTable(t('payload', 'Payload'), data.payload));
      if (data.signature) {
        output.appendChild(D.h('div.field', null,
          D.h('span.badge-note', { text: t('signature', 'Signature: ') + data.signature.slice(0, 24) + (data.signature.length > 24 ? '…' : '') })
        ));
      }
    }

    textarea.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'JWT to decode'), textarea, {
        wide: true,
        hint: t('decode_only_hint', 'Decoding only, no signature check: the fields below can be forged at will.')
      }),
      output
    ));

    /* ---- 签名验证（上游 PR #1453 带过来的） ---- */

    var verifyKey = D.h('textarea.layui-textarea', { rows: 4, spellcheck: 'false' });
    var verifyOut = D.h('div');
    var verifyStatus = D.h('span.form-status');
    var verifyBtn = D.h('button.layui-btn', {
      type: 'button', text: t('verify', 'Verify signature')
    });

    verifyBtn.addEventListener('click', function () {
      var token = textarea.value.trim();
      D.clear(verifyOut);
      if (!token) {
        verifyStatus.textContent = t('no_token', 'There is no token to verify.');
        return;
      }
      verifyStatus.textContent = t('verifying', 'Verifying…');
      verifySignature(token, verifyKey.value).then(function (data) {
        verifyStatus.textContent = '';
        verifyOut.appendChild(D.h('div.field', null,
          D.h('span.badge-note', {
            text: data.valid
              ? t('valid', 'Signature is valid.')
              : t('invalid', 'Signature is INVALID.')
          })
        ));
        verifyOut.appendChild(D.h('p.field-hint', {
          text: t('alg_used', 'Algorithm: {alg}')
            .replace('{alg}', String(data.alg || '?'))
        }));
      }).catch(function (err) {
        verifyStatus.textContent = '';
        verifyOut.appendChild(D.h('p.field-hint', {
          text: String(err && err.message || err)
        }));
      });
    });

    root.appendChild(D.h('div.card', null,
      D.h('h3.section-head', { text: t('verify_title', 'Signature validation') }),
      U.field(
        t('verify_key', 'Public key (PEM / JWK) or shared secret'),
        verifyKey,
        {
          wide: true,
          hint: t('verify_hint',
            'HMAC tokens need the shared secret; the others need the public key. Verification runs on the server.')
        }
      ),
      D.h('div.form-actions', null, verifyBtn, verifyStatus),
      verifyOut
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['jwt-parser'] = {
    decodeJwt: decodeJwt,
    tryDecodeJwt: tryDecodeJwt,
    decodeSegment: decodeSegment,
    decodeBase64Url: decodeBase64Url,
    parseClaim: parseClaim,
    dateFormatter: dateFormatter,
    __cases: function (assert) {
      var SAMPLE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
        '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ' +
        '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

      var r = decodeJwt(SAMPLE);
      assert.eq(r.header.map(function (c) { return c.claim; }), ['alg', 'typ'], 'header 的 claim 列表');
      assert.eq(r.payload.map(function (c) { return c.claim; }), ['sub', 'name', 'iat'], 'payload 的 claim 列表');
      assert.eq(r.header[1].value, 'JWT', 'typ 的值');
      assert.eq(r.header[0].claimDescription, 'Algorithm', 'alg 的说明');
      assert.eq(r.header[0].friendlyValue, 'HMAC using SHA-256', 'alg 的友好值');
      assert.eq(r.payload[1].value, 'John Doe', 'name 的值');
      assert.eq(r.payload[2].claimDescription, 'Issued At', 'iat 的说明');
      assert(r.payload[2].friendlyValue.indexOf('2018') !== -1, 'iat 转本地时间: ' + r.payload[2].friendlyValue);
      assert.eq(r.signed, true, '三段即已签名');

      // base64url：- 与 _ 要能解出来，补齐填充也要对
      assert.eq(decodeBase64Url('eyJhIjoxfQ=='), '{"a":1}', '带填充');
      assert.eq(decodeBase64Url('eyJhIjoxfQ'), '{"a":1}', '填充可省');
      assert.eq(decodeBase64Url('eyJhIg'), '{"a"', '需要补两位填充');
      assert.eq(decodeBase64Url('P34-Pw'), '?~>?', '含 - 的 base64url');
      assert.eq(decodeBase64Url('w7_Dvg'), 'ÿþ', '含 _ 的 base64url 且是合法 UTF-8');
      assert.eq(decodeSegment('eyJzdWIiOiIxIn0').sub, '1', '解一段');

      // 两段（未签名）也要能解
      var unsigned = decodeJwt(SAMPLE.split('.').slice(0, 2).join('.'));
      assert.eq(unsigned.signed, false, '两段即未签名');
      assert.eq(unsigned.signature, '', '没有签名段');

      // 非法输入
      ['', '   ', 'abc', 'a.b',
        SAMPLE.replace('eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ', 'bm90IGpzb24'),
        SAMPLE.replace('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9+')].forEach(function (bad) {
        assert.eq(tryDecodeJwt(bad).ok, false, '应拒绝：' + JSON.stringify(bad.slice(0, 24)));
      });
      assert(tryDecodeJwt('a.b.c.d.e').error.indexOf('JWE') !== -1, '五段按 JWE 提示');
      assert(tryDecodeJwt('a.b.c.d').error.indexOf('JWE') !== -1, '四段按 JWE 提示');

      // 签名段不参与解码（这里没有公钥，谈不上验签），所以它写什么都照样解得开
      var forged = decodeJwt(SAMPLE.replace('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', '!!!!'));
      assert.eq(forged.header.length, 2, '签名乱写也照样解出 header');
      assert.eq(forged.signature, '!!!!', '签名原样回显');

      // 数组/标量不是合法的 claim 容器
      assert.eq(tryDecodeJwt('WzFd.WzFd').ok, false, '段是数组');

      // 嵌套对象与数组的 claim 要能显示出来
      var nested = decodeJwt('eyJhIjp7ImIiOjEsImMiOlsxLDJdfX0.eyJhIjp7ImIiOjEsImMiOlsxLDJdfX0');
      assert.eq(nested.payload[0].value, '{\n  "b": 1,\n  "c": [\n    1,\n    2\n  ]\n}', '嵌套结构缩进 2');
      assert.eq(nested.payload[0].friendlyValue, undefined, '嵌套结构没有友好值');
      assert.eq(nested.header[0].claim, 'a', 'claim 名为 a 时没有说明');

      // 非数字的时间戳不显示 Invalid Date
      assert.eq(dateFormatter('not-a-date'), undefined, '非法时间戳');
      assert.eq(dateFormatter(null), undefined, 'null 时间戳');
      assert.eq(dateFormatter(undefined), undefined, 'undefined 时间戳');
      assert(dateFormatter(0) !== undefined, '0 是合法时间戳');
      assert.eq(getFriendlyValue('exp', 1516239022).indexOf('2018') !== -1, true, 'exp 转本地时间');
      assert.eq(getFriendlyValue('nbf', 'x'), undefined, 'nbf 非数字不给友好值');
      assert.eq(getFriendlyValue('sub', 'x'), undefined, 'sub 没有友好值');
      assert.eq(parseClaim('x', null).value, '', 'null 值显示为空');
      assert.eq(parseClaim('x', false).value, 'false', '布尔值');
      assert.eq(parseClaim('x', 12).value, '12', '数字值');

      // 算法从令牌自己的 header 里读
      assert.eq(algOf(SAMPLE), 'HS256', '读出 alg');
      assert.eq(algOf('eyJhbGciOiJSUzI1NiJ9.eyJhIjoxfQ.c2ln'), 'RS256', '读出 RS256');
      assert.eq(algOf('not-a-token'), null, '读不出时是 null');
      assert.eq(algOf(''), null, '空令牌');
      assert.eq(algOf('a.b.c'), null, '段解不开时是 null');

      // 验签请求：HMAC 放 secret，其余放 publicKey
      var hs = verifyPayload(SAMPLE, 'my-secret');
      assert.eq(hs.secret, 'my-secret', 'HMAC 走 secret 字段');
      assert.eq(hs.publicKey, undefined, 'HMAC 不带 publicKey');
      assert.eq(hs.token, SAMPLE, '带上令牌本身');

      var rs = verifyPayload('eyJhbGciOiJSUzI1NiJ9.eyJhIjoxfQ.c2ln', '-----BEGIN PUBLIC KEY-----');
      assert.eq(rs.publicKey, '-----BEGIN PUBLIC KEY-----', '非对称走 publicKey 字段');
      assert.eq(rs.secret, undefined, '非对称不带 secret');

      // 读不出 alg 时不猜：交给服务端报错
      var unknown = verifyPayload('a.b.c', 'x');
      assert.eq(unknown.publicKey, 'x', '读不出 alg 时按公钥发');
      assert.eq(unknown.secret, undefined, '读不出 alg 时不带 secret');
    }
  };
})();