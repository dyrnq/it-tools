/* ==========================================================================
   Punycode 域名转换器（punycode-converter）

   Punycode（RFC 3492）↔ Unicode 域名 / 邮箱互转。
   两个方向各一张卡：Punycode → 国际域名、国际域名 → Punycode。

   参考实现：src/tools/punycode-converter/（it-tools, GPLv3）
   与原版的差别：
   1. 原版用 npm 的 punycode@2.3.1（这个包已经废弃了）。这里把它的
      encode / decode / toASCII / toUnicode 原样移植进本模块 ——
      算法、错误类型（RangeError）、错误文案、边界处理全部一致，
      但不引入第三方依赖（manifest.tsv 与 vendor 脚本都不用动）。
   2. 其余行为与原版一致，包括原版那几个「不修」的地方：
      · mapDomain 按 '@' 切开后只取前两段 —— 'a@b@c' 的 'c' 会被丢掉；
      · toASCII 只编码「含非 ASCII 字符」的标签，纯 ASCII 的标签原样返回；
      · toUnicode 只解码以 'xn--' 开头的标签（正则大小写敏感，
        'XN--' 不解码），解码前先把标签整体转小写；
      · 标签分隔符 '。' '．' '｡' 统一换成 '.'（RFC 3490）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('punycode-converter');

  /* ======================================================================
     RFC 3492 bootstring —— 移植自 npm punycode@2.3.1
     ====================================================================== */

  /** 最高的有符号 32 位正整数 */
  var maxInt = 2147483647; // aka. 0x7FFFFFFF or 2^31-1

  /** bootstring 参数 */
  var base = 36;
  var tMin = 1;
  var tMax = 26;
  var skew = 38;
  var damp = 700;
  var initialBias = 72;
  var initialN = 128; // 0x80
  var delimiter = '-'; // '\x2D'

  /** 正则 */
  var regexPunycode = /^xn--/;
  var regexNonASCII = /[^\0-\x7F]/; // 注意：U+007F DEL 也算 ASCII
  var regexSeparators = /[\x2E。．｡]/g; // RFC 3490 分隔符

  /** 错误文案（与 npm 包逐字一致） */
  var ERRORS = {
    overflow: 'Overflow: input needs wider integers to process',
    'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
    'invalid-input': 'Invalid input'
  };

  var baseMinusTMin = base - tMin;

  /** 抛 RangeError —— npm 那份也是 RangeError，错误文案逐字照抄 */
  function punyError(type) {
    throw new RangeError(ERRORS[type]);
  }

  /**
   * 把字符串拆成 Unicode 码点数组。
   * JS 内部是 UTF-16，代理对（增补平面字符，比如 emoji）会被劈成两个码元，
   * 这一步把它们还原成单个码点 —— 少了它，emoji 域名的编码结果就是错的。
   * @param {string} string
   * @returns {number[]}
   */
  function ucs2decode(string) {
    var output = [];
    var counter = 0;
    var length = string.length;
    while (counter < length) {
      var value = string.charCodeAt(counter++);
      if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
        // 高位代理，后面还有字符
        var extra = string.charCodeAt(counter++);
        if ((extra & 0xFC00) == 0xDC00) {
          // 低位代理，合成一个码点
          output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
        } else {
          // 落单的代理：只收这个码元，下一个码元可能是另一个高位代理
          output.push(value);
          counter--;
        }
      } else {
        output.push(value);
      }
    }
    return output;
  }

  /**
   * 基本码点 → 数值（0..base-1，不是基本码点则返回 base）。
   * @param {number} codePoint
   * @returns {number}
   */
  function basicToDigit(codePoint) {
    if (codePoint >= 0x30 && codePoint < 0x3A) {
      return 26 + (codePoint - 0x30); // 0-9
    }
    if (codePoint >= 0x41 && codePoint < 0x5B) {
      return codePoint - 0x41; // A-Z
    }
    if (codePoint >= 0x61 && codePoint < 0x7B) {
      return codePoint - 0x61; // a-z
    }
    return base;
  }

  /**
   * 数值 → 基本码点。flag 非零用大写，否则小写。
   * @param {number} digit
   * @param {number} flag
   * @returns {number}
   */
  function digitToBasic(digit, flag) {
    // 0..25 → a..z / A..Z，26..35 → 0..9
    return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
  }

  /**
   * 偏差自适应函数（RFC 3492 第 3.4 节）。
   * @param {number} delta
   * @param {number} numPoints
   * @param {boolean} firstTime
   * @returns {number}
   */
  function adapt(delta, numPoints, firstTime) {
    var k = 0;
    delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
      delta = Math.floor(delta / baseMinusTMin);
    }
    return Math.floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
  }

  /**
   * Punycode（纯 ASCII）→ Unicode。
   * @param {string} input
   * @returns {string}
   */
  function decode(input) {
    var output = [];
    var inputLength = input.length;
    var i = 0;
    var n = initialN;
    var bias = initialBias;

    // 基本码点：最后一个分隔符之前的部分，复制到输出开头
    var basic = input.lastIndexOf(delimiter);
    if (basic < 0) {
      basic = 0;
    }

    for (var j = 0; j < basic; ++j) {
      if (input.charCodeAt(j) >= 0x80) {
        punyError('not-basic');
      }
      output.push(input.charCodeAt(j));
    }

    // 主解码循环
    for (var index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {
      var oldi = i;
      for (var w = 1, k = base; /* no condition */; k += base) {
        if (index >= inputLength) {
          punyError('invalid-input');
        }

        var digit = basicToDigit(input.charCodeAt(index++));

        if (digit >= base) {
          punyError('invalid-input');
        }
        if (digit > Math.floor((maxInt - i) / w)) {
          punyError('overflow');
        }

        i += digit * w;
        var tk = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

        if (digit < tk) {
          break;
        }

        var baseMinusT = base - tk;
        if (w > Math.floor(maxInt / baseMinusT)) {
          punyError('overflow');
        }

        w *= baseMinusT;
      }

      var out = output.length + 1;
      bias = adapt(i - oldi, out, oldi == 0);

      // i 本该从 out 绕回 0 并让 n 加一，这里补上
      if (Math.floor(i / out) > maxInt - n) {
        punyError('overflow');
      }

      n += Math.floor(i / out);
      i %= out;

      // 把 n 插到输出的第 i 位
      output.splice(i++, 0, n);
    }

    return String.fromCodePoint.apply(String, output);
  }

  /**
   * Unicode → Punycode（纯 ASCII）。
   * @param {string} input
   * @returns {string}
   */
  function encode(input) {
    var output = [];

    // UTF-16 码元 → Unicode 码点
    input = ucs2decode(input);

    var inputLength = input.length;

    var n = initialN;
    var delta = 0;
    var bias = initialBias;

    // 基本码点原样保留
    for (var i = 0; i < input.length; i++) {
      if (input[i] < 0x80) {
        output.push(String.fromCharCode(input[i]));
      }
    }

    var basicLength = output.length;
    var handledCPCount = basicLength;

    // 基本串后面加一个分隔符（空串不加）
    if (basicLength) {
      output.push(delimiter);
    }

    // 主编码循环
    while (handledCPCount < inputLength) {
      // 找出下一个大于等于 n 的最小码点
      var m = maxInt;
      for (var a = 0; a < input.length; a++) {
        if (input[a] >= n && input[a] < m) {
          m = input[a];
        }
      }

      // 把 delta 推进到解码器的 <m,0> 状态，注意溢出
      var handledCPCountPlusOne = handledCPCount + 1;
      if (m - n > Math.floor((maxInt - delta) / handledCPCountPlusOne)) {
        punyError('overflow');
      }

      delta += (m - n) * handledCPCountPlusOne;
      n = m;

      for (var b = 0; b < input.length; b++) {
        if (input[b] < n && ++delta > maxInt) {
          punyError('overflow');
        }
        if (input[b] === n) {
          // 把 delta 写成变长整数
          var q = delta;
          for (var k = base; /* no condition */; k += base) {
            var tk = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
            if (q < tk) {
              break;
            }
            var qMinusT = q - tk;
            var baseMinusT = base - tk;
            output.push(String.fromCharCode(digitToBasic(tk + qMinusT % baseMinusT, 0)));
            q = Math.floor(qMinusT / baseMinusT);
          }

          output.push(String.fromCharCode(digitToBasic(q, 0)));
          bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
          delta = 0;
          ++handledCPCount;
        }
      }

      ++delta;
      ++n;
    }
    return output.join('');
  }

  /**
   * 像 npm 那样逐个标签地处理域名 / 邮箱。
   *
   * ⚠ 按 '@' 切开后只取 parts[0] 与 parts[1]：'a@b@c' 的 'c' 会被丢掉。
   *   这是 npm 的行为，原版照抄，这里也照抄。
   *
   * @param {string} domain
   * @param {(label: string) => string} callback
   * @returns {string}
   */
  function mapDomain(domain, callback) {
    var parts = domain.split('@');
    var result = '';
    if (parts.length > 1) {
      // 邮箱只 punycode 域名部分，本地部分（'@' 之前的）原样保留
      result = parts[0] + '@';
      domain = parts[1];
    }
    // RFC 3490 的分隔符统一成 '.'
    domain = domain.replace(regexSeparators, '\x2E');
    var labels = domain.split('.');
    // npm 那份是从后往前遍历的（数组没有空洞，顺序结果一样，
    // 但「哪个标签先报错」会反过来）—— 这里照样从后往前
    var encoded = [];
    var length = labels.length;
    while (length--) {
      encoded[length] = callback(labels[length]);
    }
    return result + encoded.join('.');
  }

  /**
   * Punycode 域名 / 邮箱 → Unicode。
   * 只解码以 'xn--' 开头的标签；其余标签原样返回。
   * @param {string} input
   * @returns {string}
   */
  function toUnicode(input) {
    return mapDomain(input, function (label) {
      return regexPunycode.test(label) ? decode(label.slice(4).toLowerCase()) : label;
    });
  }

  /**
   * Unicode 域名 / 邮箱 → Punycode。
   * 只编码含非 ASCII 字符的标签；纯 ASCII 的标签原样返回。
   * @param {string} input
   * @returns {string}
   */
  function toASCII(input) {
    return mapDomain(input, function (label) {
      return regexNonASCII.test(label) ? 'xn--' + encode(label) : label;
    });
  }

  /* ======================================================================
     UI 用的一层壳
     ====================================================================== */

  /**
   * 界面用的安全包装：先 trim 再转换，出错时把错误信息摆出来（不炸页面）。
   * 与原版一致：出错时输出框里显示的是 e.toString()。
   *
   * @param {'decode'|'encode'} direction
   * @param {string} input
   * @returns {{ok: boolean, output: string, error: string}}
   */
  function convert(direction, input) {
    var text = typeof input === 'string' ? input.trim() : '';
    try {
      var out = direction === 'decode' ? toUnicode(text) : toASCII(text);
      return { ok: true, output: out, error: '' };
    } catch (e) {
      var msg = String(e);
      return { ok: false, output: msg, error: msg };
    }
  }

  /* ======================================================================
     界面
     ====================================================================== */

  window.ItTools.register('punycode-converter', function (root) {
    var decodeInput = D.h('textarea.layui-textarea', {
      rows: 2,
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      placeholder: t('input_decode_ph', 'Put your punycode domain name or email to decode...')
    });
    var decodeOutput = D.h('textarea.layui-textarea', { rows: 2, readonly: true });
    var decodeStatus = D.h('p.form-status');

    var encodeInput = D.h('textarea.layui-textarea', {
      rows: 2,
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      placeholder: t('input_encode_ph', 'Put your international domain or email name here...')
    });
    var encodeOutput = D.h('textarea.layui-textarea', { rows: 2, readonly: true });
    var encodeStatus = D.h('p.form-status');

    function renderDecode() {
      var r = convert('decode', decodeInput.value);
      decodeOutput.value = r.output;
      if (r.ok) {
        decodeStatus.textContent = '';
        decodeStatus.classList.remove('is-error');
      } else {
        decodeStatus.textContent = t('err_decode', 'Decoding failed: {error}').replace('{error}', r.error);
        decodeStatus.classList.add('is-error');
      }
    }

    function renderEncode() {
      var r = convert('encode', encodeInput.value);
      encodeOutput.value = r.output;
      if (r.ok) {
        encodeStatus.textContent = '';
        encodeStatus.classList.remove('is-error');
      } else {
        encodeStatus.textContent = t('err_encode', 'Encoding failed: {error}').replace('{error}', r.error);
        encodeStatus.classList.add('is-error');
      }
    }

    var offDecode = D.on(decodeInput, 'input', renderDecode);
    var offEncode = D.on(encodeInput, 'input', renderEncode);

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('title_decode', 'Punycode to International') }),
      U.field(t('input_decode', 'Punycode Domain name/Email'), decodeInput, {
        wide: true,
        hint: t('hint_decode', 'Only labels starting with xn-- are decoded. In an email address, the local part is left untouched.')
      }),
      U.field(t('output_decode', 'Decoded Domain name/Email'), decodeOutput, { wide: true }),
      decodeStatus,
      D.h('div.form-actions', null,
        U.copyButton(function () { return decodeOutput.value; }, t('copy_decoded', 'Copy decoded'))
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('title_encode', 'International to Punycode') }),
      U.field(t('input_encode', 'Domain name or email to encode'), encodeInput, {
        wide: true,
        hint: t('hint_encode', 'Only labels containing non-ASCII characters are encoded. ASCII-only domains are left as they are.')
      }),
      U.field(t('output_encode', 'Punycode Domain name/Email'), encodeOutput, { wide: true }),
      encodeStatus,
      D.h('div.form-actions', null,
        U.copyButton(function () { return encodeOutput.value; }, t('copy_encoded', 'Copy encoded'))
      )
    ));

    renderDecode();
    renderEncode();

    return {
      destroy: function () {
        offDecode();
        offEncode();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['punycode-converter'] = {
    ucs2decode: ucs2decode,
    basicToDigit: basicToDigit,
    digitToBasic: digitToBasic,
    adapt: adapt,
    encode: encode,
    decode: decode,
    mapDomain: mapDomain,
    toASCII: toASCII,
    toUnicode: toUnicode,
    convert: convert,
    __cases: function (assert) {
      /* ---- toASCII ---- */
      assert.eq(toASCII('example.com'), 'example.com', '纯 ASCII 域名原样返回');
      assert.eq(toASCII('mañana.com'), 'xn--maana-pta.com', 'mañana → xn--maana-pta');
      assert.eq(toASCII('例え.テスト'), 'xn--r8jz45g.xn--zckzah', '日文标签逐个编码');
      assert.eq(toASCII('bücher.example'), 'xn--bcher-kva.example', '非 ASCII 标签编码，ASCII 标签不动');
      assert.eq(toASCII('user@mañana.com'), 'user@xn--maana-pta.com', '邮箱只编码域名部分');
      assert.eq(toASCII('a@b@c'), 'a@b', '两个以上 @ 时后面的段被丢掉（与 npm 一致）');
      assert.eq(toASCII('xn--maana-pta.com'), 'xn--maana-pta.com', '已经是 punycode 的原样返回');
      assert.eq(toASCII('mañana。com'), 'xn--maana-pta.com', '全角句号当分隔符');
      assert.eq(toASCII(''), '', '空串');

      /* ---- toUnicode ---- */
      assert.eq(toUnicode('xn--maana-pta.com'), 'mañana.com', '解码');
      assert.eq(toUnicode('xn--r8jz45g.xn--zckzah'), '例え.テスト', '逐个标签解码');
      assert.eq(toUnicode('example.com'), 'example.com', '没有 xn-- 前缀的原样返回');
      assert.eq(toUnicode('user@xn--maana-pta.com'), 'user@mañana.com', '邮箱只解码域名部分');
      assert.eq(toUnicode('XN--MAANA-PTA.com'), 'XN--MAANA-PTA.com', 'xn-- 前缀判断大小写敏感（与 npm 一致）');
      assert.eq(toUnicode('xn--MAANA-PTA.com'), 'mañana.com', '前缀匹配后整体转小写再解码');
      assert.eq(toUnicode('a@b@c'), 'a@b', '两个以上 @ 时后面的段被丢掉（与 npm 一致）');

      /* ---- 边界与错误 ---- */
      assert.eq(toUnicode('xn--a'), '\u0080', '只有一个字符的 punycode 解出控制字符');
      assert.eq(toUnicode('xn--a-'), 'a', '尾部只有一个分隔符时不做主解码循环');
      assert.eq(toUnicode('xn--'), '', '空 punycode 解出空串');

      var threw = false;
      try { toUnicode('xn--!'); } catch (e) { threw = e instanceof RangeError; }
      assert(threw, '非法 punycode 抛 RangeError');

      threw = false;
      try { toUnicode('xn--é-x'); } catch (e) { threw = e instanceof RangeError; }
      assert(threw, '基本部分含非 ASCII 字符时抛 RangeError');

      /* ---- UI 包装层 ---- */
      assert.eq(convert('decode', '  xn--maana-pta.com  ').output, 'mañana.com', 'convert 先 trim');
      assert.eq(convert('encode', '  mañana.com ').output, 'xn--maana-pta.com', 'convert 先 trim');
      assert.eq(convert('encode', 'mañana.com').ok, true, '正常转换 ok 为 true');
      assert.eq(convert('decode', 'xn--!').ok, false, '出错时 ok 为 false');
      assert.eq(convert('decode', 'xn--!').error.indexOf('RangeError'), 0, '错误信息带上 RangeError 前缀');
      assert.eq(convert('decode', 'xn--!').output, convert('decode', 'xn--!').error, '出错时输出框里显示错误信息');
    }
  };
})();
