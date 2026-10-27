/* ==========================================================================
   Base64 字符串转换器（base64-string-converter）

   文本 ↔ Base64，两个方向都支持 URL safe 变体（`-` `_` 替代 `+` `/`，
   并可去掉 `=` 填充）。

   参考实现：src/tools/base64-string-converter/ + src/utils/base64.ts
   （it-tools, GPLv3），那边用的是 js-base64。
   与原版的差别：
   1. 原版把 makeUriSafe 定义成「删掉所有 `=`」，这里同样照做（它是靠
      unURI 把非 base64 字符过滤掉来实现解码时补不回填充的）；
   2. 原版 encode 走 js-base64 的 Base64.encode(str)，那等价于 UTF-8 字节的
      base64；这里显式走 TextEncoder -> bytesToBase64，语义一致但没有外部依赖。
   3. 这里额外加了第三块「Base64 ↔ 十六进制」（上游 #1505）。理由是 hex 和
      base64 是同一批字节的两种写法 —— `base64 cert.der` 之后往往下一步就是
      `xxd -p` 看内容，或者反过来。两边都按**原始字节**转，不走 UTF-8：
      base64 里装的是证书/密钥这类二进制时，按 UTF-8 解会炸。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('base64-string-converter');

  var DATA_URI_PREFIX = /^data:.*?;base64,/i;

  /** 去掉 data URI 前缀（用户常常整段粘进来）。 */
  function stripDataUri(str) {
    return String(str).replace(DATA_URI_PREFIX, '');
  }

  /** 去掉所有空白 —— Base64 常被换行拆开。 */
  function stripWhitespace(str) {
    return String(str).replace(/\s/g, '');
  }

  /** 标准 base64 -> URL safe（`+`->`-`, `/`->`_`, 去掉 `=`）。 */
  function makeUriSafe(encoded) {
    return encoded.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  /** URL safe -> 标准 base64，并丢弃非 base64 字符（`=` 也丢，等价于去填充）。 */
  function unUriSafe(encoded) {
    return encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  }

  /**
   * 文本 -> base64。
   * @param {string} text
   * @param {{urlSafe?:boolean}} [opts]
   */
  function textToBase64(text, opts) {
    var encoded = U.bytesToBase64(U.utf8Bytes(String(text == null ? '' : text)));
    return (opts && opts.urlSafe) ? makeUriSafe(encoded) : encoded;
  }

  /**
   * base64 -> 文本。非法输入返回 null（参考实现是抛错再被上层兜住）。
   * @param {string} str
   * @param {{urlSafe?:boolean}} [opts]
   */
  function base64ToText(str, opts) {
    if (!isValidBase64(str, opts)) return null;
    var clean = stripWhitespace(stripDataUri(String(str == null ? '' : str)));
    if (opts && opts.urlSafe) clean = unUriSafe(clean);
    try {
      return U.utf8Decode(U.base64ToBytes(clean));
    } catch (e) {
      return null;
    }
  }

  /**
   * 校验：把输入解码成字节再重新编码，跟「规整化后的原文」逐字比较。
   * 这是参考实现 isValidBase64 的做法，能挡掉长度不合法 / 字符集非法 /
   * 填充位非零等情况。urlSafe 模式下因为原串没有 `=`，比较时也去掉 `=`。
   */
  function isValidBase64(str, opts) {
    var raw = stripWhitespace(stripDataUri(String(str == null ? '' : str)));
    var urlSafe = !!(opts && opts.urlSafe);
    var clean = urlSafe ? unUriSafe(raw) : raw;
    if (!clean.length) return false;
    try {
      var reencoded = U.bytesToBase64(U.base64ToBytes(clean));
      if (urlSafe) return reencoded.replace(/=/g, '') === clean;
      return reencoded === clean;
    } catch (e) {
      return false;
    }
  }

  /* ---- 十六进制 ---- */

  /**
   * 去掉十六进制里的分隔符与 `0x` 前缀。
   *
   * `xxd -p` 出来的是纯 hex，`openssl xxd -p` 也是，但人肉从 Wireshark 里
   * 复制出来的是 `aa:bb:cc` —— 冒号、空格、逗号、连字符都见过。
   */
  function stripHexSeparators(str) {
    return String(str == null ? '' : str)
      .replace(/\b0x/gi, '')
      .replace(/[\s:,_-]/g, '');
  }

  /**
   * 十六进制 -> 字节数组。非法输入返回 null。
   *
   * 奇数位（`abc`）判非法而不是补零：补零是猜用户意图，猜错了没人知道。
   *
   * 返回的是**普通数组**而不是 Uint8Array —— Uint8Array 被 JSON.stringify
   * 出来是 `{"0":72,...}`，测试断言和日志里都没法看。
   */
  function hexToBytes(str) {
    var clean = stripHexSeparators(str);
    if (!clean.length) return null;
    if (clean.length % 2 !== 0) return null;
    if (!/^[0-9a-f]+$/i.test(clean)) return null;
    var out = [];
    for (var i = 0; i < clean.length; i += 2) {
      out.push(parseInt(clean.substr(i, 2), 16));
    }
    return out;
  }

  /**
   * base64 -> **原始字节**，不做 UTF-8 解码。
   *
   * 和 `base64ToText` 的区别：那一个假设里面装的是文本；这一个假设里面装的是
   * 任意二进制（证书、密钥、gzip）。非法输入返回 null。
   */
  function base64ToRawBytes(str, opts) {
    if (!isValidBase64(str, opts)) return null;
    var clean = stripWhitespace(stripDataUri(String(str == null ? '' : str)));
    if (opts && opts.urlSafe) clean = unUriSafe(clean);
    try {
      return U.base64ToBytes(clean);
    } catch (e) {
      return null;
    }
  }

  /** 十六进制 -> base64 字符串。非法 hex 返回 null。 */
  function hexToBase64(str, opts) {
    var bytes = hexToBytes(str);
    if (!bytes) return null;
    var encoded = U.bytesToBase64(bytes);
    return (opts && opts.urlSafe) ? makeUriSafe(encoded) : encoded;
  }

  /** base64 -> 十六进制字符串（不带分隔符，小写）。非法 base64 返回 null。 */
  function base64ToHex(str, opts) {
    var bytes = base64ToRawBytes(str, opts);
    if (!bytes) return null;
    return U.hex(bytes);
  }

  window.ItTools.register('base64-string-converter', function (root) {
    var textInput = D.h('textarea.layui-textarea', { rows: 5, placeholder: t('input_ph', 'Put your string here...') });
    var base64Output = D.h('textarea.layui-textarea', { rows: 5, readonly: true, placeholder: t('output_ph', 'The base64 encoding of your string will be here') });

    var base64Input = D.h('textarea.layui-textarea', { rows: 5, placeholder: t('input_ph_base64', 'Your base64 string...') });
    var textOutput = D.h('textarea.layui-textarea', { rows: 5, readonly: true, placeholder: t('output_ph_decoded', 'The decoded string will be here') });

    var encodeSafe = false;
    var decodeSafe = false;
    var decodeStatus = D.h('p.field-hint');

    /**
     * 一个「左标签 + 开关」的行。
     *
     * 原版这里是 `<n-form-item label="Encode URL safe" label-placement="left">`
     * 包一个 n-switch：标签在开关**左边**，列宽按文字宽度（naive-ui 没写
     * label-width，就是 auto），而且**右**对齐 —— 实测原版的 n-form-item
     * 左标签一律右对齐。所以标签和开关要拆成两个元素：把文字塞在开关
     * 旁边（原版那种写法）的话，文字会跑到开关的右边去。
     */
    function switchRow(id, labelText, initial, onChange) {
      var input = D.h('input', { type: 'checkbox', checked: initial });
      input.id = id;
      input.addEventListener('change', function () { onChange(input.checked); render(); });
      return D.h('div.field-row', { style: { '--field-label-width': 'auto', '--field-label-align': 'right' } },
        D.h('label.field-label', { for: input.id, text: labelText }),
        D.h('label.switch', null, input, D.h('span'))
      );
    }

    function render() {
      base64Output.value = textToBase64(textInput.value, { urlSafe: encodeSafe });
      var ok = isValidBase64(base64Input.value, { urlSafe: decodeSafe });
      textOutput.value = ok ? base64ToText(base64Input.value, { urlSafe: decodeSafe }) : '';
      decodeStatus.textContent = base64Input.value.trim() && !ok ? t('invalid_base64', 'Invalid base64 string') : '';
      decodeStatus.classList.toggle('is-error', !!decodeStatus.textContent);
    }

    [textInput, base64Input].forEach(function (ta) { ta.addEventListener('input', render); });

    root.appendChild(D.h('div.card', null,
      switchRow('b64-encode-url-safe', t('encode_url_safe', 'Encode URL safe'), false, function (v) { encodeSafe = v; }),
      U.field(t('string_to_encode', 'String to encode'), textInput, { wide: true }),
      U.field(t('base64_of_string', 'Base64 of string'), base64Output, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return base64Output.value; }, t('copy_base64', 'Copy base64'))
      )
    ));

    root.appendChild(D.h('div.card', null,
      switchRow('b64-decode-url-safe', t('decode_url_safe', 'Decode URL safe'), false, function (v) { decodeSafe = v; }),
      U.field(t('base64_string_to_decode', 'Base64 string to decode'), base64Input, { wide: true }),
      U.field(t('decoded_string', 'Decoded string'), textOutput, { wide: true }),
      decodeStatus,
      D.h('div.form-actions', null,
        U.copyButton(function () { return textOutput.value; }, t('copy_decoded_string', 'Copy decoded string'))
      )
    ));

    // ── 第三块：Base64 ↔ 十六进制 ──
    // 两个方向并排放：左边输什么右边就出什么，互不影响。
    var hexInput = D.h('textarea.layui-textarea', { rows: 5, placeholder: t('ph_hex', '48656c6c6f20686578') });
    var hexToB64Output = D.h('textarea.layui-textarea', { rows: 5, readonly: true, placeholder: t('ph_base64', 'SGVsbG8gaGV4') });

    var b64Input = D.h('textarea.layui-textarea', { rows: 5, placeholder: t('ph_base64', 'SGVsbG8gaGV4') });
    var b64ToHexOutput = D.h('textarea.layui-textarea', { rows: 5, readonly: true, placeholder: t('ph_hex', '48656c6c6f20686578') });

    var hexStatus = D.h('p.field-hint');
    var b64HexStatus = D.h('p.field-hint');

    function renderHex() {
      var raw = hexInput.value.trim();
      var out = hexToBase64(hexInput.value);
      hexToB64Output.value = out === null ? '' : out;
      hexStatus.textContent = raw && out === null ? t('invalid_hexadecimal', 'Invalid hexadecimal string') : '';
      hexStatus.classList.toggle('is-error', !!hexStatus.textContent);
    }

    function renderB64Hex() {
      var raw = b64Input.value.trim();
      var out = base64ToHex(b64Input.value);
      b64ToHexOutput.value = out === null ? '' : out;
      b64HexStatus.textContent = raw && out === null ? t('invalid_base64', 'Invalid base64 string') : '';
      b64HexStatus.classList.toggle('is-error', !!b64HexStatus.textContent);
    }

    hexInput.addEventListener('input', renderHex);
    b64Input.addEventListener('input', renderB64Hex);

    root.appendChild(D.h('div.card', null,
      U.field(t('hexadecimal_to_encode', 'Hexadecimal to encode'), hexInput, { wide: true }),
      U.field(t('base64_of_hexadecimal', 'Base64 of hexadecimal'), hexToB64Output, { wide: true }),
      hexStatus,
      D.h('div.form-actions', null,
        U.copyButton(function () { return hexToB64Output.value; }, t('copy_base64', 'Copy base64'))
      )
    ));

    root.appendChild(D.h('div.card', null,
      U.field(t('base64_to_hexadecimal', 'Base64 to decode to hexadecimal'), b64Input, { wide: true }),
      U.field(t('hexadecimal_of_base64', 'Hexadecimal of base64'), b64ToHexOutput, { wide: true }),
      b64HexStatus,
      D.h('div.form-actions', null,
        U.copyButton(function () { return b64ToHexOutput.value; }, t('copy_hexadecimal', 'Copy hexadecimal'))
      )
    ));

    renderHex();
    renderB64Hex();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['base64-string-converter'] = {
    textToBase64: textToBase64,
    base64ToText: base64ToText,
    isValidBase64: isValidBase64,
    makeUriSafe: makeUriSafe,
    unUriSafe: unUriSafe,
    stripDataUri: stripDataUri,
    hexToBytes: hexToBytes,
    base64ToRawBytes: base64ToRawBytes,
    hexToBase64: hexToBase64,
    base64ToHex: base64ToHex,
    __cases: function (assert) {
      assert.eq(textToBase64(''), '', '空串编码为空串');
      assert.eq(textToBase64('hello'), 'aGVsbG8=', 'hello');
      assert.eq(textToBase64('hello world'), 'aGVsbG8gd29ybGQ=', 'hello world');
      assert.eq(textToBase64('中文'), '5Lit5paH', '中文按 UTF-8 编码');
      assert.eq(base64ToText('aGVsbG8='), 'hello', '解码 hello');
      assert.eq(base64ToText('5Lit5paH'), '中文', '中文往返');
      // 数据 URI 前缀要被剥掉
      assert.eq(stripDataUri('data:image/png;base64,iVBORw0KGgo='), 'iVBORw0KGgo=', '剥 data URI');
      assert.eq(base64ToText('data:text/plain;base64,aGVsbG8='), 'hello', '带 data URI 也能解');
      assert.eq(base64ToText('aGVs\nbG8='), 'hello', '换行被忽略');
      // URL safe 变体
      var raw = textToBase64('ûÿÿ>>>??~');
      assert(textToBase64('ûÿÿ>>>??~', { urlSafe: true }).indexOf('=') === -1, 'url safe 去掉填充');
      assert.eq(textToBase64('ûÿÿ>>>??~', { urlSafe: true }), makeUriSafe(raw), 'url safe 只是替换 +/ 和删 =');
      assert.eq(makeUriSafe('a+b/c=='), 'a-b_c', 'makeUriSafe');
      assert.eq(unUriSafe('a-b_c'), 'a+b/c', 'unUriSafe');
      assert.eq(base64ToText(textToBase64('ûÿÿ>>>??~', { urlSafe: true }), { urlSafe: true }), 'ûÿÿ>>>??~', 'url safe 往返');
      assert.eq(base64ToText('w7_Dvw', { urlSafe: true }), 'ÿÿ', 'url safe 解码');
      // 校验
      assert(isValidBase64('aGVsbG8='), '合法 base64');
      // 标准模式用「解码再重新编码」逐字比较，所以缺 '=' 的串同样会被判非法 ——
      // 这跟参考实现一致（那边也是拿 re-encoded 和原文比），需要无填充请开 URL safe。
      assert(!isValidBase64('aGVsbG8'), '标准模式要求补齐填充');
      assert(isValidBase64('data:text/plain;base64,aGVsbG8='), '带 data URI 合法');
      assert(!isValidBase64(''), '空串不合法');
      assert(!isValidBase64('aGVsbG8*'), '非法字符不合法');
      assert(!isValidBase64('w7_Dvw'), '标准模式不接受 url safe 字符');
      assert(isValidBase64('w7_Dvw', { urlSafe: true }), 'url safe 模式接受');
      // unUriSafe 只丢掉 '=' 与其它杂字符，'+' '/' 本来就留在标准字母表里，
      // 所以 url safe 模式也照收标准 base64（与参考实现一致）。
      assert(isValidBase64('w7/Dvw', { urlSafe: true }), 'url safe 模式也接受标准字母表');
      assert.eq(base64ToText('aGVsbG8*'), null, '非法输入解码返回 null');
      assert.eq(base64ToText('w7_Dvw'), null, '标准模式下 url safe 串解不出来');

      // ---- 十六进制 ----
      assert.eq(hexToBytes('48656c6c6f'), [0x48, 0x65, 0x6c, 0x6c, 0x6f], 'hex -> 字节');
      assert.eq(hexToBytes('48:65:6c:6c:6f'), [0x48, 0x65, 0x6c, 0x6c, 0x6f], '冒号分隔也能解');
      assert.eq(hexToBytes('48 65 6C 6C 6F'), [0x48, 0x65, 0x6c, 0x6c, 0x6f], '空格分隔 + 大写');
      assert.eq(hexToBytes('0x48656c6c6f'), [0x48, 0x65, 0x6c, 0x6c, 0x6f], '0x 前缀被剥掉');
      assert.eq(hexToBytes('abc'), null, '奇数位判非法，不补零');
      assert.eq(hexToBytes('zz'), null, '非十六进制字符判非法');
      assert.eq(hexToBytes(''), null, '空串非法');
      assert.eq(hexToBase64('48656c6c6f'), 'SGVsbG8=', 'hex -> base64');
      assert.eq(hexToBase64(''), null, '空 hex 非法');
      assert.eq(base64ToHex('SGVsbG8='), '48656c6c6f', 'base64 -> hex');
      // 二进制内容不该被当 UTF-8 处理：0xff 不是合法 UTF-8，按文本解会变成 U+FFFD
      assert.eq(base64ToHex('/w=='), 'ff', 'base64 -> hex 保留原始字节');
      assert.eq(hexToBase64('ff'), '/w==', 'hex -> base64 保留原始字节');
      // 往返
      assert.eq(base64ToHex(hexToBase64('00ff10')), '00ff10', 'hex -> base64 -> hex 往返');
      assert.eq(hexToBase64(base64ToHex('AAECAw==')), 'AAECAw==', 'base64 -> hex -> base64 往返');
      // 非法 base64 返回 null 而不是半截结果
      assert.eq(base64ToHex('aGVsbG8*'), null, '非法 base64 返回 null');
      assert.eq(base64ToHex(''), null, '空 base64 非法');
    }
  };
})();