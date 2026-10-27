/* ==========================================================================
   URL 编解码器（url-encoder）

   两个方向各一张卡：文本 → 百分号编码、百分号编码 → 文本。
   核心就是浏览器自带的 encodeURIComponent / decodeURIComponent，
   参考实现只是给它们套了一层「出错就显示空串」的壳。

   关于 encodeURI 与 encodeURIComponent 的区别（UI 里也写了一遍）：
   - encodeURIComponent 会把 `A-Z a-z 0-9 - _ . ! ~ * ' ( )` 以外的所有字符
     都编码掉，包括 `/ ? # & = +` 这些 URL 结构字符。适合编码「一个字段的值」。
   - encodeURI 会额外放过 `: / ? # & = + $ , ; @` 等保留字符，只编码空格、
     中文等。适合编码「一整段 URL」。
   本工具两种都提供，默认走 encodeURIComponent（与参考实现一致）。

   另外补了三种**严格**模式（来自上游 PR #1474）：
   - RFC 3986 的 unreserved 只有 `A-Z a-z 0-9 - _ . ~`，所以 `! ' ( ) *`
     也必须编码。`encodeURIComponent` 放过了这五个字符 —— OAuth 2.0 签名、
     AWS SigV4、JWT 里的 base64url 变体都按 RFC 3986 算，用
     `encodeURIComponent` 直接签会对不上（400 invalid_request）。
   - RFC 3986 的 URI 变体保留 `/ ? # & = +` 等结构字符，但把 `! ' ( ) *`
     编码掉，并把 `[` `]` 还原成字面量（encodeURI 默认会把它们编码成 %5B/%5D，
     而 RFC 3986 允许它们出现在 path 里）。
   - RFC 5987 的 ext-value（`Content-Disposition` 的 `filename*`）：
     `!` 不编码，`| ` `^` 也保留原样 —— 它们都在 RFC 5987 的 attr-char 里。

   注意：RFC 5987 的 `charset'language'value` 那种前缀形式（`UTF-8''%E4%B8%AD.txt`）
   本工具**不解析**，解码时按普通的百分号编码处理 —— 真要拆前缀得单独写一段。

   参考实现：src/tools/url-encoder/（it-tools, GPLv3）
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('url-encoder');

  /** 把 `!` `'` `(` `)` `*` 这几个「JS 觉得不用编码」的字符补编码成 %XX。 */
  function encodeStrict(s) {
    return s.replace(/[!'()*]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  /** RFC 3986 的 URIComponent：unreserved 只有 A-Za-z0-9-._~，其余全编码。 */
  function encodeRFC3986Component(s) {
    return encodeStrict(encodeURIComponent(s));
  }

  /** RFC 3986 的 URI：先按 encodeURI 编，再把 `[` `]` 还原，最后补编 !'()* 。 */
  function encodeRFC3986Uri(s) {
    return encodeStrict(encodeURI(s).replace(/%5B/g, '[').replace(/%5D/g, ']'));
  }

  /**
   * RFC 5987 的 ext-value（Content-Disposition 的 filename*）。
   *
   * 与 RFC 3986 的两处不同：
   * - `!` 在 RFC 5987 的 attr-char 里，**不编码**；
   * - `|` `` ` `` `^` 也在 attr-char 里，encodeURIComponent 把它们编掉了，这里还原。
   */
  function encodeRFC5987ValueChars(s) {
    return encodeURIComponent(s)
      .replace(/['()*]/g, function (c) {
        return '%' + c.charCodeAt(0).toString(16).toUpperCase();
      })
      .replace(/%(7C|60|5E)/g, function (m, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      });
  }

  var MODES = {
    component: {
      label: t('mode_component', 'encodeURIComponent'),
      hint: t('hint_component', 'Encode a field value: URL structural characters such as / ? # & = are encoded too.'),
      encode: function (s) { return encodeURIComponent(s); },
      decode: function (s) { return decodeURIComponent(s); }
    },
    'rfc3986-component': {
      label: t('mode_rfc3986_component', 'RFC 3986 (URIComponent)'),
      hint: t('hint_rfc3986_component', 'Strictly encode a field value per RFC 3986: even ! \' ( ) * are encoded, which is what OAuth signatures and AWS SigV4 need.'),
      encode: function (s) { return encodeRFC3986Component(s); },
      decode: function (s) { return decodeURIComponent(s); }
    },
    'rfc5987': {
      label: t('mode_rfc5987', 'RFC 5987 (Content-Disposition)'),
      hint: t('hint_rfc5987', 'Encode a filename per RFC 5987: ! is not encoded and | ` ^ are kept as-is (they all belong to attr-char).'),
      encode: function (s) { return encodeRFC5987ValueChars(s); },
      decode: function (s) { return decodeURIComponent(s); }
    },
    uri: {
      label: t('mode_uri', 'encodeURI'),
      hint: t('hint_uri', 'Encode a whole URL: structural characters such as / ? # & = are kept as-is.'),
      encode: function (s) { return encodeURI(s); },
      decode: function (s) { return decodeURI(s); }
    },
    'rfc3986-uri': {
      label: t('mode_rfc3986_uri', 'RFC 3986 (URI)'),
      hint: t('hint_rfc3986_uri', 'Strictly encode a whole URL per RFC 3986: structural characters are kept, but ! \' ( ) * are encoded.'),
      encode: function (s) { return encodeRFC3986Uri(s); },
      decode: function (s) { return decodeURI(s); }
    }
  };

  /** 取某个模式下的编/解码函数，非法名字退回 component。 */
  function fnOf(mode, dir) {
    var m = MODES[mode] || MODES.component;
    return m[dir];
  }

  /**
   * 安全编码：畸形输入（例如未配对的 %）不该把整个页面炸掉，返回 null 表示失败。
   * 参考实现用 withDefaultOnError 包了一层，这里等价。
   */
  function encode(input, mode) {
    try { return fnOf(mode, 'encode')(String(input)); }
    catch (e) { return null; }
  }

  function decode(input, mode) {
    try { return fnOf(mode, 'decode')(String(input)); }
    catch (e) { return null; }
  }

  /** 当前模式能不能吃下这个串 —— UI 用它标红。 */
  function canDecode(input, mode) { return decode(input, mode) !== null; }

  window.ItTools.register('url-encoder', function (root) {
    var mode = 'component';

    var encodeInput = D.h('textarea.layui-textarea', { rows: 3, placeholder: t('ph_encode', 'The string to encode') });
    encodeInput.value = 'Hello world :)';
    var encodeOutput = D.h('textarea.layui-textarea', { rows: 3, readonly: true, placeholder: t('ph_encoded', 'Your string encoded') });

    var decodeInput = D.h('textarea.layui-textarea', { rows: 3, placeholder: t('ph_decode', 'The string to decode') });
    decodeInput.value = 'Hello%20world%20%3A)';
    var decodeOutput = D.h('textarea.layui-textarea', { rows: 3, readonly: true, placeholder: t('ph_decoded', 'Your string decoded') });

    var status = D.h('p.field-hint');
    var modeHint = D.h('span.badge-note');
    // 提示文字要跟着模式一起换 —— 以前是建卡片时就把初始模式的文案写死了，
    // 切了模式说明还是旧的（模式一多就更误导了）。
    var modeHelp = D.h('p.field-hint');

    function renderMode() {
      modeHint.textContent = MODES[mode].label;
      modeHelp.textContent = MODES[mode].hint;
    }

    function render() {
      var enc = encode(encodeInput.value, mode);
      var dec = decode(decodeInput.value, mode);
      encodeOutput.value = enc === null ? '' : enc;
      decodeOutput.value = dec === null ? '' : dec;
      if (dec === null && decodeInput.value.length) {
        status.textContent = t('err_decode', 'Decoding failed: this percent-encoding is incomplete or contains an invalid escape (for example a stray %).');
        status.classList.add('is-error');
      } else {
        status.textContent = '';
        status.classList.remove('is-error');
      }
    }

    var toggles = Object.keys(MODES).map(function (key) {
      var input = D.h('input', { type: 'radio', name: 'url-encoder-mode', value: key, checked: key === mode });
      input.addEventListener('change', function () {
        mode = key;
        renderMode();
        render();
      });
      return D.h('label.switch', null, input, D.h('span', { text: MODES[key].label }));
    });

    [encodeInput, decodeInput].forEach(function (ta) {
      ta.addEventListener('input', render);
    });

    renderMode();

    root.appendChild(D.h('div.card', null,
      D.h('div.switch-grid', null, toggles),
      modeHelp,
      D.h('div.form-actions', null, modeHint),
      U.field(t('input', 'Your string :'), encodeInput, { wide: true }),
      U.field(t('input_encoded', 'Your string encoded :'), encodeOutput, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return encodeOutput.value; }, t('copy_encoded', 'Copy encoded'))
      )
    ));

    root.appendChild(D.h('div.card', null,
      U.field(t('input_encoded_string', 'Your encoded string :'), decodeInput, { wide: true }),
      U.field(t('input_decoded_string', 'Your string decoded :'), decodeOutput, { wide: true }),
      status,
      D.h('div.form-actions', null,
        U.copyButton(function () { return decodeOutput.value; }, t('copy_decoded', 'Copy decoded'))
      )
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['url-encoder'] = {
    encode: encode,
    decode: decode,
    canDecode: canDecode,
    MODES: MODES,
    __cases: function (assert) {
      assert.eq(encode('Hello world :)'), 'Hello%20world%20%3A)', '默认走 encodeURIComponent');
      assert.eq(decode('Hello%20world%20%3A)'), 'Hello world :)', 'decodeURIComponent');
      assert.eq(encode('https://a.b/c?d=1&e=2'), 'https%3A%2F%2Fa.b%2Fc%3Fd%3D1%26e%3D2', 'component 连结构字符一起编码');
      assert.eq(encode('https://a.b/c?d=1&e=2', 'uri'), 'https://a.b/c?d=1&e=2', 'uri 放过结构字符');
      assert.eq(encode('中文 a', 'uri'), '%E4%B8%AD%E6%96%87%20a', 'uri 仍会编码空格与中文');
      // encodeURI / encodeURIComponent 都放过的保留字符
      assert.eq(encode('a-_.!~*\'()'), 'a-_.!~*\'()', '保留字符原样');
      // 未配对的百分号会让解码抛错，这里返回 null 而不是把页面炸掉
      assert.eq(decode('abc%'), null, '非法转义返回 null');
      assert.eq(decode('%E0%A4%A'), null, '残缺 UTF-8 序列返回 null');
      assert.eq(encode('%'), '%25', '百分号本身要编码');
      assert.eq(decode(encode('a b&c=d 中文', 'uri'), 'uri'), 'a b&c=d 中文', 'uri 往返');
      // decodeURI 不会还原 %26 / %3D 这类保留字符的转义 —— 它只知道 decodeURI 的规则
      assert.eq(decode('a%20b%26c', 'uri'), 'a b%26c', 'decodeURI 保留转义后的保留字符');
      assert.eq(decode(encode('a b&c=d 中文')), 'a b&c=d 中文', 'component 往返');
      assert.eq(encode('', 'uri'), '', '空串');
      assert.eq(decode('', 'uri'), '', '空串解码');
      assert(!canDecode('abc%', 'uri'), 'canDecode 应报假');
      assert(canDecode('abc%20', 'uri'), '合法编码 canDecode 应报真');

      // ---- RFC 3986：unreserved 只有 A-Za-z0-9-._~，!'()* 必须编码 ----
      assert.eq(encode('a!b\'c(d)e*f', 'rfc3986-component'), 'a%21b%27c%28d%29e%2Af',
        'RFC3986 component 连 !\'()* 一起编码');
      assert.eq(encode('a-_.~', 'rfc3986-component'), 'a-_.~', 'unreserved 原样');
      assert.eq(encode('中文 a', 'rfc3986-component'), '%E4%B8%AD%E6%96%87%20a',
        'RFC3986 component 与 encodeURIComponent 对中文一致');
      assert.eq(encode('https://a.b/c?d=1&e=2', 'rfc3986-uri'), 'https://a.b/c?d=1&e=2',
        'RFC3986 uri 保留结构字符');
      assert.eq(encode('https://a.b/[x]', 'rfc3986-uri'), 'https://a.b/[x]',
        'RFC3986 uri 把方括号还原成字面量');
      assert.eq(encode('a!b\'c(d)e*f', 'rfc3986-uri'), 'a%21b%27c%28d%29e%2Af',
        'RFC3986 uri 编码 !\'()*');
      assert.eq(decode('a%21b%27c%28d%29e%2Af', 'rfc3986-component'), 'a!b\'c(d)e*f',
        'RFC3986 解码');

      // ---- RFC 5987：! 不编码，| ` ^ 保留 ----
      assert.eq(encode("a!b'c(d)e*f", 'rfc5987'), 'a!b%27c%28d%29e%2Af',
        'RFC5987 只编 \'()*');
      assert.eq(encode('a|b`c^d', 'rfc5987'), 'a|b`c^d', 'RFC5987 保留 | ` ^');
      assert.eq(encode('中文.txt', 'rfc5987'), '%E4%B8%AD%E6%96%87.txt', 'RFC5987 编码非 ASCII');
      assert.eq(decode('%E4%B8%AD%E6%96%87.txt', 'rfc5987'), '中文.txt', 'RFC5987 解码');

      // 严格模式与宽松模式的差别只在 ! ' ( ) * 这五个字符上
      assert.eq(encode('a b', 'rfc3986-component'), encode('a b', 'component'),
        '空格与中文的处理两种模式一致');
    }
  };
})();