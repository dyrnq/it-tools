/* ==========================================================================
   文本与二进制互转（text-to-binary）

   文本按 UTF-8 编码成字节，每个字节转成 8 位二进制；反向按 8 位切回字节再解码。

   参考实现：src/tools/text-to-binary/（it-tools, GPLv3）
   与原版的差别（原版两处都是 bug）：
   1. 原版取 charCodeAt(0) 相当于按 UTF-16 码元转二进制，遇到非拉丁 1 字符
      （例如「中」= U+4E2D）时 toString(2) 会超过 8 位，输出长度不再对齐 8 的倍数，
      自己转回去必然抛 'Invalid binary string'；代理对还会被拆成两个残缺码元。
      这里改成先取 UTF-8 字节，全 Unicode 范围内都能无损往返。
   2. 原版解码时从不清查 UTF-8 合法性。这里改成**严格解码**：不合法的字节序列
      直接报错，而不是按 TextDecoder 的惯例变成 U+FFFD（�）——
      拿到一串 � 用户根本看不出自己的数据哪里不对（上游 #1849 也改成严格模式）。

   仍与原版保持一致的地方：转换前先丢掉所有非 0/1 字符；清理后长度不是 8 的
   倍数就抛 'Invalid binary string'。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('text-to-binary');

  /**
   * 严格解码 UTF-8 字节序列。
   *
   * `fatal: true` 的意思是「遇到不合法的字节序列就抛错」，而不是按惯例
   * 替换成 U+FFFD。
   *
   * 注意：**不能**改全局的 `U.utf8Decode` —— base64、jwt、basic-auth
   * 那几个工具也用它，那边的宽松行为是对的（解出来能看就行）。
   */
  function decodeUtf8Strict(bytes) {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  /** 分隔符选项：键是实际插入的分隔符，值是下拉框上的名字。 */
  var SEPARATORS = [
    { value: ' ', label: t('sep_space', 'Space — 01101000 01100101') },
    { value: '', label: t('sep_none', 'None — 0110100001100101') },
    { value: ', ', label: t('sep_comma', 'Comma — 01101000, 01100101') },
    { value: ': ', label: t('sep_colon', 'Colon — 01101000: 01100101') },
    { value: '\n', label: t('sep_newline', 'New line') }
  ];

  /**
   * 文本 → 二进制串。每个 UTF-8 字节一组，组宽固定 8 位，组间插 separator。
   * @param {string} text
   * @param {{separator?: string}} [opts]
   */
  function textToBinary(text, opts) {
    var separator = opts && opts.separator !== undefined ? String(opts.separator) : ' ';
    if (!text) return '';
    return Array.prototype.map.call(U.utf8Bytes(text), function (byte) {
      return byte.toString(2).padStart(8, '0');
    }).join(separator);
  }

  /**
   * 二进制串 → 文本。非 0/1 字符（空格、换行、乱插的字母）在转换前一律丢掉。
   * 清理后长度不是 8 的倍数说明少了半个字节，抛错；
   * 字节凑齐了但不是合法的 UTF-8，也抛错（而不是解出一串 �）。
   * @param {string} binary
   */
  function binaryToText(binary) {
    var clean = String(binary == null ? '' : binary).replace(/[^01]/g, '');
    if (clean.length % 8) throw new Error(t('err_invalid_binary', 'Invalid binary string'));
    var bytes = new Uint8Array(clean.length / 8);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 8, 8), 2);
    try {
      return decodeUtf8Strict(bytes);
    } catch (e) {
      throw new Error(t('err_invalid_utf8', 'Invalid UTF-8 byte sequence'));
    }
  }

  /** 字节数，界面上用来提示输出长度。 */
  function byteCount(text) {
    return text ? U.utf8Bytes(text).length : 0;
  }

  window.ItTools.register('text-to-binary', function (root) {
    var textInput = D.h('textarea.layui-textarea', { rows: 4, placeholder: t('text_ph', 'e.g. \'Hello world\'') });
    var textInputWrap = U.field(t('input_text', 'Enter text to convert to binary:'), textInput, { wide: true });
    var separatorSelect = D.h('select.layui-input#t2b-sep', null, SEPARATORS.map(function (sep) {
      return D.h('option', { value: sep.value, text: sep.label });
    }));
    var binaryOut = D.h('pre.mono-output');
    var byteBadge = D.h('span.badge-note');

    var binaryInput = D.h('textarea.layui-textarea', { rows: 4, placeholder: t('binary_ph', 'e.g. \'01101000 01100101 01101100 01101100 01101111\'') });
    var textOut = D.h('pre.mono-output');
    var errorBadge = D.h('span.badge-note.form-status');

    function renderBinary() {
      var binary = textToBinary(textInput.value, { separator: separatorSelect.value });
      binaryOut.textContent = binary;
      var bytes = byteCount(textInput.value);
      byteBadge.textContent = bytes + ' ' + (bytes === 1 ? t('byte', 'byte') : t('bytes', 'bytes')) + ' (' +
        U.hex(U.utf8Bytes(textInput.value)) + ')';
    }

    function renderText() {
      try {
        var text = binaryToText(binaryInput.value);
        textOut.textContent = text;
        errorBadge.textContent = t('valid_binary', 'valid binary');
        errorBadge.classList.remove('is-error');
      } catch (e) {
        textOut.textContent = '';
        errorBadge.textContent = e.message;
        errorBadge.classList.add('is-error');
      }
    }

    textInput.addEventListener('input', renderBinary);
    separatorSelect.addEventListener('change', renderBinary);
    binaryInput.addEventListener('input', renderText);

    // 原版的输出也是「上标签 + 只读框」：c-input-text 的 label 默认在控件上面，
    // 所以输出那一行不能用我们自己的 .output-label（13px/500 的小标题），
    // 要用 label.field-label（14px/400）压在输出框正上方。
    root.appendChild(D.h('div.card', null,
      textInputWrap,
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 't2b-sep', text: t('separator', 'Separator:') }),
        separatorSelect
      ),
      U.field(t('binary_from_text', 'Binary from your text'), binaryOut, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return binaryOut.textContent; })
      ),
      D.h('div.form-actions', null, byteBadge)
    ));

    root.appendChild(D.h('div.card', null,
      U.field(t('input_binary', 'Enter binary to convert to text:'), binaryInput, {
        wide: true,
        hint: t('binary_hint', 'Whitespace and other non-0/1 characters are ignored; every 8 bits must form a complete byte, and the bytes must be valid UTF-8.')
      }),
      U.field(t('text_from_binary', 'Text from your binary'), textOut, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return textOut.textContent; })
      ),
      D.h('div.form-actions', null, errorBadge)
    ));

    renderBinary();
    renderText();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['text-to-binary'] = {
    textToBinary: textToBinary,
    binaryToText: binaryToText,
    byteCount: byteCount,
    __cases: function (assert) {
      // 与参考实现的 vitest 用例一致
      assert.eq(textToBinary('A'), '01000001', '单个字符');
      assert.eq(textToBinary('hello'), '01101000 01100101 01101100 01101100 01101111', 'hello');
      assert.eq(textToBinary(''), '', '空串');
      assert.eq(textToBinary('hello', { separator: '' }), '0110100001100101011011000110110001101111', '换掉分隔符');
      assert.eq(textToBinary('it-tools'),
        '01101001 01110100 00101101 01110100 01101111 01101111 01101100 01110011', 'e2e 用例');
      assert.eq(binaryToText('01101000 01100101 01101100 01101100 01101111'), 'hello', '反向转换');
      assert.eq(binaryToText('01000001'), 'A', '反向单个字节');
      assert.eq(binaryToText(''), '', '反向空串');
      assert.eq(binaryToText('  01000 001garbage'), 'A', '转换前清理杂字符');
      var threw = 0;
      try { binaryToText('010000011'); } catch (e) { threw++; }
      try { binaryToText('1'); } catch (e) { threw++; }
      assert.eq(threw, 2, '不完整的字节要抛错');
      assert.eq(textToBinary('hello', { separator: ', ' }).indexOf(','), 8, '逗号分隔符');
      // 修掉的行为：非拉丁 1 字符与 emoji 必须能无损往返
      assert.eq(textToBinary('中'), '11100100 10111000 10101101', '汉字走 UTF-8 三字节');
      assert.eq(byteCount('中'), 3, '一个汉字 3 字节');
      assert.eq(byteCount('😀'), 4, '一个 emoji 4 字节');
      assert.eq(binaryToText(textToBinary('中')), '中', '汉字往返');
      assert.eq(binaryToText(textToBinary('😀')), '😀', 'emoji 往返');
      assert.eq(binaryToText(textToBinary('a😀中')), 'a😀中', '混合往返');
      // 严格解码：不是合法 UTF-8 的字节要报错，而不是解出一串 �
      var threwUtf8 = 0;
      try { binaryToText('11111111'); } catch (e) { threwUtf8++; }
      try { binaryToText('11000000 10000000'); } catch (e) { threwUtf8++; }
      assert.eq(threwUtf8, 2, '非法 UTF-8 字节序列要抛错');
      assert.eq(binaryToText('11000011 10101001'), 'é', '合法的两字节序列照常解');
    }
  };
})();