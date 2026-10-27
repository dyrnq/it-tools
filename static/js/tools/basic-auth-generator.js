/* ==========================================================================
   Basic Auth 生成器（basic-auth-generator）

   拼出 HTTP Basic 认证头：`Authorization: Basic base64(username:password)`。
   顺手给出一个 Authorization 头的解析（decode 方向），并带一个用 crypto
   生成随机密码的按钮。

   参考实现：src/tools/basic-auth-generator/（it-tools, GPLv3）
   与原版的差别：
   1. 原版只有编码方向，这里补了解析方向（从 base64 头还原用户名/密码）。
   2. 原版用 js-base64 的 textToBase64，这里显式走 UTF-8 字节，语义一致。
   3. 随机密码用 U.randomString（内部是 crypto.getRandomValues），不用 Math.random。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('basic-auth-generator');

  /** 生成随机密码用的字符集：大小写 + 数字 + 一些符号。 */
  var PASSWORD_CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+';

  /** 头部的形状：`Authorization: Basic <base64>`，大小写与空格都容错。 */
  var HEADER_RE = /^\s*authorization\s*:\s*(?:basic|b64)\s+(.+?)\s*$/i;

  /** 生成 `username:password` 这段被 base64 编码的原始串。 */
  function credentials(username, password) {
    return String(username == null ? '' : username) + ':' + String(password == null ? '' : password);
  }

  /** 完整的 Authorization 头。 */
  function buildHeader(username, password) {
    return 'Authorization: Basic ' + U.bytesToBase64(U.utf8Bytes(credentials(username, password)));
  }

  /** 只要 base64 部分，不要头。 */
  function buildToken(username, password) {
    return U.bytesToBase64(U.utf8Bytes(credentials(username, password)));
  }

  /**
   * 反向：从一个 Authorization 头（或裸 base64）里还原用户名与密码。
   * @returns {{ok:boolean, error?:string, username?:string, password?:string}}
   */
  function parseHeader(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw.length) return { ok: false, error: t('err_empty', 'Please enter an Authorization header or a base64 string.') };

    var token = raw;
    var m = raw.match(HEADER_RE);
    if (m) token = m[1];

    var text;
    try {
      text = U.utf8Decode(U.base64ToBytes(token.replace(/\s/g, '')));
    } catch (e) {
      return { ok: false, error: t('err_invalid_base64', 'Not valid Base64 — it cannot be decoded.') };
    }
    // RFC 7617 里用户名本身不允许含冒号，所以第一个冒号之前就是用户名
    var idx = text.indexOf(':');
    if (idx === -1) {
      return { ok: false, error: t('err_no_colon', 'Decoded successfully, but there is no colon — this is not the Basic authentication format.') };
    }
    return { ok: true, username: text.slice(0, idx), password: text.slice(idx + 1) };
  }

  /** 用 crypto 造一个随机密码。 */
  function generatePassword(length) {
    var n = Math.max(1, Math.min(128, Math.floor(length == null ? 24 : length)));
    return U.randomString(PASSWORD_CHARSET, n);
  }

  window.ItTools.register('basic-auth-generator', function (root) {
    var username = D.h('input.layui-input', { type: 'text', placeholder: t('username_ph', 'Your username...') });
    // U.passwordInput() 返回的是包了一层的 .input-group，这里再补一个必填的 id
    var passwordGroup = U.passwordInput({ placeholder: t('password_ph', 'Your password...') });
    var password = passwordGroup.querySelector('input');

    var headerBox = D.h('pre.mono-output');

    var parseInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('header_ph', 'Authorization: Basic ... or plain base64')
    });
    var parseOutput = D.h('div.field.kv-rows');
    var parseStatus = D.h('p.field-hint');

    function renderHeader() {
      headerBox.textContent = buildHeader(username.value, password.value);
    }

    function renderParse() {
      var result = parseHeader(parseInput.value);
      D.clear(parseOutput);
      parseStatus.textContent = result.error || '';
      parseStatus.classList.toggle('is-error', !result.ok);
      if (!result.ok) return;
      [
        [t('username', 'Username'), result.username],
        [t('password', 'Password'), result.password]
      ].forEach(function (pair) {
        var input = D.h('input.layui-input', { type: 'text', readonly: true, value: pair[1] });
        parseOutput.appendChild(D.h('div.field-row', null,
          D.h('label.field-label', { text: pair[0] }),
          input,
          U.copyButton(function () { return input.value; })
        ));
      });
    }

    var generateButton = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button',
      text: t('generate_password', 'Generate password'),
      onclick: function () {
        password.value = generatePassword(24);
        password.type = 'text';
        renderHeader();
      }
    });

    [username, password].forEach(function (el) { el.addEventListener('input', renderHeader); });
    parseInput.addEventListener('input', renderParse);

    root.appendChild(D.h('div.card', null,
      U.field(t('username', 'Username'), username),
      D.h('div.field', null,
        D.h('label.field-label', { text: t('password', 'Password') }),
        passwordGroup,
        D.h('p.field-hint', { text: t('rfc7617_hint', 'Per RFC 7617, the username and the password are separated by the first colon, so the username cannot contain a colon.') })
      ),
      D.h('div.field', null,
        D.h('span.field-label', { text: t('authorization_header', 'Authorization header:') }),
        D.h('div.preview-box', null, headerBox)
      ),
      D.h('div.form-actions', null,
        U.copyButton(function () { return headerBox.textContent; }, t('copy_header', 'Copy header')),
        generateButton
      )
    ));

    root.appendChild(D.h('div.card', null,
      U.field(t('decode_header', 'Decode an Authorization header'), parseInput, { wide: true }),
      parseStatus,
      parseOutput
    ));

    renderHeader();
    renderParse();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['basic-auth-generator'] = {
    credentials: credentials,
    buildHeader: buildHeader,
    buildToken: buildToken,
    parseHeader: parseHeader,
    generatePassword: generatePassword,
    __cases: function (assert) {
      assert.eq(credentials('user', 'pass'), 'user:pass', '凭据串');
      assert.eq(buildToken('user', 'pass'), 'dXNlcjpwYXNz', 'user:pass 的 base64');
      assert.eq(buildHeader('user', 'pass'), 'Authorization: Basic dXNlcjpwYXNz', '完整头');
      assert.eq(buildHeader('', ''), 'Authorization: Basic Og==', '空用户名空密码是 Og==');
      assert.eq(buildHeader('a', '中文'), 'Authorization: Basic YTrkuK3mloc=', '密码按 UTF-8 编码');
      // 解析
      var p = parseHeader('Authorization: Basic dXNlcjpwYXNz');
      assert(p.ok, '头部应能解析');
      assert.eq([p.username, p.password], ['user', 'pass'], '还原用户名密码');
      assert.eq(parseHeader('dXNlcjpwYXNz').username, 'user', '裸 base64 也能解析');
      assert.eq(parseHeader('  authorization:   basic   dXNlcjpwYXNz  ').password, 'pass', '大小写与空白容错');
      assert.eq(parseHeader('Authorization: B64 dXNlcjpwYXNz').username, 'user', 'B64 前缀也认');
      assert.eq(parseHeader(buildHeader('me', '中文密码')).password, '中文密码', '中文往返');
      // 密码里带冒号：只按第一个冒号切
      assert.eq(parseHeader(buildToken('u', 'a:b')).password, 'a:b', '密码里的冒号保留');
      assert(!parseHeader('').ok, '空串不合法');
      assert(!parseHeader('不是 base64 !!!').ok, '非法 base64 不合法');
      assert(!parseHeader('basic aGVsbG8').ok, '解出来没有冒号应报错');
      // 随机密码
      var r = generatePassword(24);
      assert.eq(r.length, 24, '默认 24 位');
      assert(generatePassword(8) !== generatePassword(8), '两次生成应不同');
      assert(generatePassword(1).length === 1, '长度下限 1');
      assert(generatePassword(9999).length === 128, '长度上限 128');
      assert(/^[a-zA-Z0-9!@#$%^&*()\-_=+]+$/.test(generatePassword(64)), '字符集不越界');
    }
  };
})();