/* ==========================================================================
   JWT 生成器（jwt-generator）

   生成带签名的 JSON Web Token，并支持密钥对生成与 PEM ↔ JWK 互转。

   对应上游 PR：#1453（feat(new tool): JWT Generator and Signature verification）
   上游**没有这个工具** —— 这一份是从零实现的，没有照抄任何上游代码。

   与上游的差别：
   1. 上游用浏览器里的 jose 库算签名 —— 但 WebCrypto 只在**安全上下文**
      （https 或 localhost）里存在。本服务通常跑在内网的明文 http 上，
      浏览器端压根没有 crypto.subtle，放在前端会直接坏掉。
      所以密码学放服务端（POST /api/jwt/{sign,keygen,convert}），
      前端只管收集输入、显示结果。
   2. 上游的算法表里有 ES256K（secp256k1）。我们没有内置那条曲线，
      与其给出一个与别人不互通的签名，不如明说没有。
   3. 上游的 header 是前端拼的字符串。这里 header 也由服务端生成 ——
      「回显的 header」与「真签进 token 的 header」必须是同一份。
   4. 上游用 JSON5 解析 payload（允许注释、尾逗号）。我们要求标准 JSON ——
      JWS 签的是**字节**，重序列化会改掉用户的原文。宁可要求标准 JSON，
      也不能悄悄改掉用户写的内容。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('jwt-generator');

  var API_BASE = '/api/jwt';

  /**
   * 备用算法表。
   *
   * 服务端的 /api/jwt/algorithms 才是唯一事实来源，这张表只是**兜底** ——
   * 接口取不到时（比如反向代理把 /api/* 挡了）界面仍然可用。
   * Rust 侧有一条单测盯着这张表：算法名与顺序必须与 `Alg::ALL` 一致
   * （见 src/tools/jwt.rs 的 tests::fallback_algorithm_table_matches_the_server）。
   *
   * BEGIN_FALLBACK_ALGS */
  var FALLBACK_ALGS = [
    { alg: 'HS256', family: 'HMAC', keyType: 'secret', keyDesc: '256 bit (32 byte) secret', verify: 'HMAC-SHA256' },
    { alg: 'HS384', family: 'HMAC', keyType: 'secret', keyDesc: '384 bit (48 byte) secret', verify: 'HMAC-SHA384' },
    { alg: 'HS512', family: 'HMAC', keyType: 'secret', keyDesc: '512 bit (64 byte) secret', verify: 'HMAC-SHA512' },
    { alg: 'RS256', family: 'RSA', keyType: 'keypair', keyDesc: 'RSA key of at least 2048 bit modulus length', verify: 'RSA-SHA256' },
    { alg: 'RS384', family: 'RSA', keyType: 'keypair', keyDesc: 'RSA key of at least 2048 bit modulus length', verify: 'RSA-SHA384' },
    { alg: 'RS512', family: 'RSA', keyType: 'keypair', keyDesc: 'RSA key of at least 2048 bit modulus length', verify: 'RSA-SHA512' },
    { alg: 'PS256', family: 'RSA-PSS', keyType: 'keypair', keyDesc: 'RSA key of at least 2048 bit modulus length', verify: 'RSA-PSS-SHA256' },
    { alg: 'PS384', family: 'RSA-PSS', keyType: 'keypair', keyDesc: 'RSA key of at least 2048 bit modulus length', verify: 'RSA-PSS-SHA384' },
    { alg: 'PS512', family: 'RSA-PSS', keyType: 'keypair', keyDesc: 'RSA key of at least 2048 bit modulus length', verify: 'RSA-PSS-SHA512' },
    { alg: 'ES256', family: 'ECDSA', keyType: 'keypair', keyDesc: 'NIST P-256 elliptic curve key', verify: 'ECDSA-SHA256' },
    { alg: 'ES384', family: 'ECDSA', keyType: 'keypair', keyDesc: 'NIST P-384 elliptic curve key', verify: 'ECDSA-SHA384' },
    { alg: 'ES512', family: 'ECDSA', keyType: 'keypair', keyDesc: 'NIST P-521 elliptic curve key', verify: 'ECDSA-SHA512' }
  ];
  /* END_FALLBACK_ALGS */

  /** 样例 payload。 */
  var SAMPLE_PAYLOAD = '{\n  "sub": "1234567890",\n  "name": "John Doe",\n  "iat": 1516239022\n}';

  /**
   * 调服务端的 JWT 接口。统一走 {ok, data} / {ok:false, error:{message}} 信封。
   * @param {string} action sign / verify / keygen / convert
   * @param {object} body 请求体
   * @returns {Promise<object>} data
   */
  function api(action, body) {
    return fetch(API_BASE + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (!res.ok || !json || json.ok !== true) {
          var msg = (json && json.error && json.error.message) || ('HTTP ' + res.status);
          throw new Error(msg);
        }
        return json.data;
      });
    });
  }

  /** 取服务端的算法表。取不到就返回 null（调用方用备用表）。 */
  function fetchAlgorithms() {
    return fetch(API_BASE + '/algorithms').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      return json && json.data && json.data.algorithms ? json.data.algorithms : null;
    }).catch(function () { return null; });
  }

  /**
   * JOSE header 的预览文本。
   *
   * 真正签进 token 的 header 由服务端生成（`{"alg":…,"typ":"JWT"}`），
   * 这里只是签之前给人看的预览。
   */
  function buildHeader(alg) {
    return '{\n  "alg": "' + alg + '",\n  "typ": "JWT"\n}';
  }

  /** 美化 JSON。解析不了就原样返回（让服务端去报错，前端不拦）。 */
  function prettyJson(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
      return text;
    }
  }

  /** 算法的一行说明。 */
  function describeAlg(info) {
    if (!info) return '';
    return info.alg + ': ' + info.keyDesc + ' (verify with ' + info.verify + ')';
  }

  /**
   * 从一组框里取密钥材料：PEM 框优先，空了才用 JWK 框。
   * @param {string} pem
   * @param {string} jwk
   * @returns {string}
   */
  function pickMaterial(pem, jwk) {
    return String(pem || '').trim() || String(jwk || '').trim();
  }

  window.ItTools.register('jwt-generator', function (root) {
    var algs = FALLBACK_ALGS.slice();
    var current = algs[0];
    var alive = true;               // 接口回来时可能已经 destroy 了

    /* ---- 控件 ---- */

    var algSelect = D.h('select.layui-select');
    var algHint = D.h('p.field-hint');
    var headerArea = D.h('textarea.layui-textarea', {
      rows: 3, readonly: 'readonly', spellcheck: 'false', value: buildHeader(current.alg)
    });
    var payloadArea = D.h('textarea.layui-textarea', {
      rows: 6, spellcheck: 'false', value: SAMPLE_PAYLOAD
    });

    var secretInput = D.h('input.layui-input', {
      type: 'text', spellcheck: 'false', autocomplete: 'off'
    });

    var privPem = D.h('textarea.layui-textarea', { rows: 5, spellcheck: 'false' });
    var privJwk = D.h('textarea.layui-textarea', { rows: 5, spellcheck: 'false' });
    var pubPem = D.h('textarea.layui-textarea', { rows: 5, spellcheck: 'false' });
    var pubJwk = D.h('textarea.layui-textarea', { rows: 5, spellcheck: 'false' });

    var bitsSelect = D.h('select.layui-select', null, [2048, 3072, 4096].map(function (b) {
      return D.h('option', { value: String(b), text: b + ' bits' });
    }));

    var status = D.h('span.form-status');
    var tokenOut = D.h('textarea.layui-textarea', {
      rows: 4, readonly: 'readonly', spellcheck: 'false'
    });

    /* ---- 状态提示 ---- */

    function setStatus(text, kind) {
      status.textContent = text || '';
      status.className = kind ? ('form-status is-' + kind) : 'form-status';
    }

    /* ---- 算法表 ---- */

    function drawAlgs() {
      D.clear(algSelect);
      algs.forEach(function (a) {
        algSelect.appendChild(D.h('option', {
          value: a.alg, text: a.alg + ' — ' + a.verify, selected: a.alg === current.alg
        }));
      });
    }

    function algByName(name) {
      for (var i = 0; i < algs.length; i++) {
        if (algs[i].alg === name) return algs[i];
      }
      return null;
    }

    /** HMAC 用共享口令，其余用密钥对 —— 界面要跟着换。 */
    function isSecretAlg(info) {
      return !!info && info.keyType === 'secret';
    }

    /** 切算法：换说明、换 header 预览、换要填的框。 */
    function applyAlg() {
      current = algByName(algSelect.value) || algs[0];
      algHint.textContent = describeAlg(current);
      headerArea.value = buildHeader(current.alg);
      secretBox.style.display = isSecretAlg(current) ? '' : 'none';
      keyBox.style.display = isSecretAlg(current) ? 'none' : '';
      bitsField.style.display = current.family === 'RSA' || current.family === 'RSA-PSS' ? '' : 'none';
    }

    algSelect.addEventListener('change', applyAlg);

    /* ---- 按钮 ---- */

    var genKeyBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: t('generate', 'Generate key pair')
    });
    var convertBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: t('convert', 'Convert format')
    });
    var signBtn = D.h('button.layui-btn', {
      type: 'button', text: t('sign', 'Generate token')
    });

    /** 跑一个接口：统一处理 loading、成功、失败三态。 */
    function run(promise, okText) {
      setStatus(t('working', 'Working…'));
      return promise.then(function (data) {
        if (alive && okText) setStatus(okText);
        return data;
      }).catch(function (err) {
        if (alive) setStatus(String(err && err.message || err), 'error');
        throw err;
      });
    }

    /** 生成密钥对。RSA 的长度可选，EC 的曲线由算法定死。 */
    genKeyBtn.addEventListener('click', function () {
      var bits = parseInt(bitsSelect.value, 10) || 2048;
      run(api('keygen', { alg: current.alg, bits: bits })).then(function (data) {
        privPem.value = data.privateKey || '';
        privJwk.value = JSON.stringify(data.privateKeyJwk, null, 2);
        pubPem.value = data.publicKey || '';
        pubJwk.value = JSON.stringify(data.publicKeyJwk, null, 2);
        setStatus(t('generated', 'Key pair generated.'));
      }).catch(function () { /* 状态已经在 run 里写过了 */ });
    });

    /**
     * PEM ↔ JWK 互转。
     *
     * 私钥优先：给了私钥就把它换成两种表示，并顺带把公钥也导出来
     * （从私钥能推公钥，反过来不行）。只给了公钥就只换公钥。
     */
    convertBtn.addEventListener('click', function () {
      var priv = pickMaterial(privPem.value, privJwk.value);
      var pub = pickMaterial(pubPem.value, pubJwk.value);
      var kind = priv ? 'private' : 'public';
      var material = priv || pub;
      if (!material) {
        setStatus(t('no_key', 'Fill in a key first.'), 'warn');
        return;
      }
      run(api('convert', { alg: current.alg, kind: kind, material: material })).then(function (data) {
        if (kind === 'private') {
          privPem.value = data.pem || '';
          privJwk.value = JSON.stringify(data.jwk, null, 2);
          if (data.publicPem) pubPem.value = data.publicPem;
          if (data.publicJwk) pubJwk.value = JSON.stringify(data.publicJwk, null, 2);
        } else {
          pubPem.value = data.pem || '';
          pubJwk.value = JSON.stringify(data.jwk, null, 2);
        }
        setStatus(t('converted', 'Converted.'));
      }).catch(function () { /* 状态已经在 run 里写过了 */ });
    });

    /** 签名。 */
    signBtn.addEventListener('click', function () {
      var body = { alg: current.alg, payload: payloadArea.value };
      if (isSecretAlg(current)) {
        body.secret = secretInput.value;
      } else {
        body.privateKey = pickMaterial(privPem.value, privJwk.value);
      }
      run(api('sign', body)).then(function (data) {
        tokenOut.value = data.token || '';
        // header 用服务端回的那一份 —— 保证与真签进 token 的是同一份
        if (data.header) headerArea.value = JSON.stringify(data.header, null, 2);
        setStatus(t('signed', 'Token generated.'));
      }).catch(function () { /* 状态已经在 run 里写过了 */ });
    });

    /* ---- 卡片 ---- */

    var secretBox = U.field(
      t('secret', 'Shared secret'),
      secretInput,
      { wide: true, hint: t('secret_hint', 'The same secret must be used to verify the token.') }
    );

    var bitsField = U.field(
      t('key_size', 'RSA key size'),
      bitsSelect,
      { wide: true }
    );

    var keyBox = D.h('div', null,
      bitsField,
      U.field(t('private_pem', 'Private key (PEM)'), privPem, { wide: true }),
      U.field(t('private_jwk', 'Private key (JWK)'), privJwk, { wide: true }),
      U.field(t('public_pem', 'Public key (PEM)'), pubPem, { wide: true }),
      U.field(t('public_jwk', 'Public key (JWK)'), pubJwk, { wide: true }),
      D.h('div.form-actions', null, genKeyBtn, convertBtn)
    );

    var contentCard = D.h('div.card', null,
      U.field(t('alg', 'Algorithm'), algSelect, { wide: true }),
      algHint,
      U.field(t('header', 'Header'), headerArea, {
        wide: true,
        hint: t('header_hint', 'Generated by the server — this is exactly what gets signed.')
      }),
      U.field(t('payload', 'Payload (JSON)'), payloadArea, {
        wide: true,
        hint: t('payload_hint', 'Standard JSON only. The bytes are signed as written.')
      })
    );

    var keysCard = D.h('div.card', null,
      D.h('h3.section-head', { text: t('keys', 'Keys') }),
      secretBox,
      keyBox,
      D.h('p.field-hint', {
        text: t('keys_hint',
          'Keys never leave this machine except to the server that signs them — the server does the crypto.')
      })
    );

    var resultCard = D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('token', 'Generated token') }),
        U.copyButton(function () { return tokenOut.value; })
      ),
      tokenOut,
      D.h('div.form-actions', null, signBtn, status)
    );

    root.appendChild(contentCard);
    root.appendChild(keysCard);
    root.appendChild(resultCard);

    drawAlgs();
    applyAlg();

    // 服务端的算法表到了就换上去（取不到就用备用表，界面照常能用）
    fetchAlgorithms().then(function (list) {
      if (!alive || !list || !list.length) return;
      algs = list;
      drawAlgs();
      applyAlg();
    });

    return {
      destroy: function () {
        alive = false;
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['jwt-generator'] = {
    buildHeader: buildHeader,
    prettyJson: prettyJson,
    describeAlg: describeAlg,
    pickMaterial: pickMaterial,
    api: api,
    __cases: function (assert) {
      // header：alg 在前、typ 在后
      assert.eq(buildHeader('HS256'), '{\n  "alg": "HS256",\n  "typ": "JWT"\n}', 'header 预览');
      assert(buildHeader('ES512').indexOf('"alg": "ES512"') < buildHeader('ES512').indexOf('"typ"'),
        'alg 在 typ 前面');

      // JSON 美化
      assert.eq(prettyJson('{"a":1}'), '{\n  "a": 1\n}', '美化 JSON');
      assert.eq(prettyJson('not json'), 'not json', '非法 JSON 原样返回');
      assert.eq(prettyJson(''), '', '空串');

      // 算法说明
      assert.eq(describeAlg({ alg: 'HS256', keyDesc: '256 bit (32 byte) secret', verify: 'HMAC-SHA256' }),
        'HS256: 256 bit (32 byte) secret (verify with HMAC-SHA256)', '算法说明');
      assert.eq(describeAlg(null), '', '没有算法信息时是空串');

      // 密钥材料：PEM 优先，空了才用 JWK
      assert.eq(pickMaterial('PEM', 'JWK'), 'PEM', 'PEM 优先');
      assert.eq(pickMaterial('  ', 'JWK'), 'JWK', 'PEM 为空时用 JWK');
      assert.eq(pickMaterial('', ''), '', '两个都空');
      assert.eq(pickMaterial(null, undefined), '', '两个都没有');

      // 备用算法表：12 个算法，不能重名
      var names = FALLBACK_ALGS.map(function (a) { return a.alg; });
      assert.eq(names.length, 12, '备用表有 12 个算法');
      assert.eq(names.filter(function (n, i) { return names.indexOf(n) !== i; }), [], '算法名不重复');
      assert.eq(FALLBACK_ALGS.filter(function (a) { return a.keyType === 'secret'; }).length, 3,
        '三个 HMAC 算法用共享口令');
      assert.eq(FALLBACK_ALGS.filter(function (a) { return a.keyType === 'keypair'; }).length, 9,
        '其余九个用密钥对');
    }
  };
})();
