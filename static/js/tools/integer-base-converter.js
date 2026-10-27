/* ==========================================================================
   整数进制转换器（integer-base-converter）

   2 ~ 64 进制互转，一次给出 2/8/10/16/64 五个常用结果，外加一个自定义进制。
   用 BigInt 做中间值，所以超过 2^53 的整数也不会丢精度。

   参考实现：src/tools/integer-base-converter/（it-tools, GPLv3）
   与原版的三处差别：
   1. 原版的界面用 errorlessConvert 把所有出错都吞成空串，输入非法字符时
      用户只看到一片空白，没有任何提示；这里把错误原文显示出来，并且
      convertBase 本身只抛错、不返回空串。
   2. 原版的空输入会算出 "0"；这里空输入返回空串（没输入就没结果）。
   3. 原版的 64 位字符表是大小写敏感的，16 进制里输入 "A5" 会直接报错；
      这里在查不到原字符时回退到小写，所以 36 进制以下 A/a 等价，
      64 进制的行为与原版完全一致（两个字符都在字符表里，先命中原字符）。
   另外补了原版没有的前导正负号。
   以及原版没有的**进制前缀**（上游 #901）：`0x` / `&h` 开头按 16 进制读，
   `0o` / `&o` 按 8 进制，`0b` / `&b` 按 2 进制 —— 前缀说了算，用户选的
   「输入进制」这时被忽略；VB6 的类型后缀（`&HAAUL` 里的 `UL`）只影响读法。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('integer-base-converter');

  var MIN_BASE = 2;
  var MAX_BASE = 64;

  /** 与参考实现一致的字符表：0-9、a-z、A-Z、+/ */
  var DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/';

  /**
   * 进制前缀。C 风格的 `0x` 与 VB 风格的 `&h` 各写一遍，两种都收。
   * 前缀一旦出现，**它决定输入进制**，界面上选的「输入进制」被忽略 ——
   * 否则用户粘进来一个 `0xFF`、界面上还挂着 10，出来的数是错的。
   */
  var BASE_PREFIXES = [
    { base: 16, re: /^(?:0[xX]|&[hH])/ },
    { base: 8, re: /^(?:0[oO]|&[oO])/ },
    { base: 2, re: /^(?:0[bB]|&[bB])/ }
  ];

  /**
   * VB6 的类型后缀（`&HAAUL` 里的 `UL`）：I / L / U / Z / N，可任意组合。
   *
   * 只在**带前缀**时才剥：没有前缀时，「Z」在 36 进制里是个正经数字，
   * 盲目剥掉会把 `ZZ` 变成空串。
   */
  var TYPE_SUFFIX_RE = /[ILUZN]+$/;

  /**
   * 看一眼输入带没带进制前缀。
   * @param {string} text
   * @returns {{base:number}|null}
   */
  function detectBasePrefix(text) {
    var body = String(text == null ? '' : text).trim();
    if (body.charAt(0) === '+' || body.charAt(0) === '-') body = body.slice(1);
    for (var i = 0; i < BASE_PREFIXES.length; i++) {
      var m = body.match(BASE_PREFIXES[i].re);
      if (m) return { base: BASE_PREFIXES[i].base };
    }
    return null;
  }

  function checkBase(base, label) {
    if (!Number.isInteger(base) || base < MIN_BASE || base > MAX_BASE) {
      throw new Error(t('err_base_range', '{label} must be an integer between {min} and {max}, got {base}')
        .replace('{label}', label)
        .replace('{min}', MIN_BASE)
        .replace('{max}', MAX_BASE)
        .replace('{base}', base));
    }
  }

  /** 取出该进制下最大的合法字符，用于报错文案 */
  function lastDigitOf(base) {
    return DIGITS.charAt(base - 1);
  }

  /**
   * 进制转换。
   * @param {{value: string, fromBase: number, toBase: number}} opts
   * @returns {string} 非法字符 / 非法进制抛错；空输入返回空串
   */
  function convertBase(opts) {
    var fromBase = Number(opts.fromBase);
    var toBase = Number(opts.toBase);
    checkBase(fromBase, t('label_input_base', 'Input base'));
    checkBase(toBase, t('label_output_base', 'Output base'));

    var text = String(opts.value == null ? '' : opts.value).trim();
    if (!text.length) return '';

    var negative = false;
    var body = text;
    if (body.charAt(0) === '+' || body.charAt(0) === '-') {
      negative = body.charAt(0) === '-';
      body = body.slice(1);
    }
    if (!body.length) throw new Error(t('err_sign_only', 'Only a sign, no digits'));

    // 前缀决定进制（此时忽略用户选的输入进制），后缀只影响读法
    var prefixed = false;
    for (var p = 0; p < BASE_PREFIXES.length; p++) {
      var pm = body.match(BASE_PREFIXES[p].re);
      if (pm) {
        fromBase = BASE_PREFIXES[p].base;
        body = body.slice(pm[0].length);
        prefixed = true;
        break;
      }
    }
    if (prefixed) {
      var suffix = body.match(TYPE_SUFFIX_RE);
      if (suffix) body = body.slice(0, body.length - suffix[0].length);
    }
    if (!body.length) throw new Error(t('err_prefix_only', 'Only a prefix, no digits'));

    var fromRange = DIGITS.slice(0, fromBase);
    var dec = 0n;
    for (var i = 0; i < body.length; i++) {
      var ch = body.charAt(i);
      var index = fromRange.indexOf(ch);
      // 查不到再试小写：36 进制以下大小写等价，64 进制两个字符都在表里不会走到这里
      if (index < 0) index = fromRange.indexOf(ch.toLowerCase());
      if (index < 0) {
        throw new Error(t('err_invalid_char', 'Invalid character "{ch}": base {base} only accepts 0~{last} ({range})')
          // 用函数形式回填：非法字符可能正好是 '$'，字符串替换会把它当替换模式
          .replace('{ch}', function () { return ch; })
          .replace('{base}', fromBase)
          .replace('{last}', lastDigitOf(fromBase))
          .replace('{range}', fromRange));
      }
      dec = dec * BigInt(fromBase) + BigInt(index);
    }

    if (dec === 0n) return '0';

    var toRange = DIGITS.slice(0, toBase);
    var out = '';
    while (dec > 0n) {
      out = toRange[Number(dec % BigInt(toBase))] + out;
      dec = dec / BigInt(toBase);
    }
    return (negative ? '-' : '') + out;
  }

  /**
   * 不抛错的包装，界面用。
   * @returns {{value: string, error: string}}
   */
  function tryConvertBase(opts) {
    try {
      return { value: convertBase(opts), error: '' };
    } catch (e) {
      return { value: '', error: e.message };
    }
  }

  /**
   * 界面上固定展示的几个进制。
   *
   * label 是界面上的显示名，走 i18n；id 是稳定的内部标识（不随语言变）。
   */
  var TARGETS = [
    { id: 'binary', base: 2, label: t('binary', 'Binary (2)') },
    { id: 'octal', base: 8, label: t('octal', 'Octal (8)') },
    { id: 'decimal', base: 10, label: t('decimal', 'Decimal (10)') },
    { id: 'hexadecimal', base: 16, label: t('hexadecimal', 'Hexadecimal (16)') },
    { id: 'base64', base: 64, label: t('base64', 'Base64 (64)') }
  ];

  window.ItTools.register('integer-base-converter', function (root) {
    var valueInput = D.h('input.layui-input', { type: 'text', value: '42', spellcheck: 'false' });
    var fromInput = D.h('input.layui-input', { type: 'number', min: MIN_BASE, max: MAX_BASE, step: 1, value: 10 });
    var toInput = D.h('input.layui-input', { type: 'number', min: MIN_BASE, max: MAX_BASE, step: 1, value: 42 });
    var customBox = D.h('input.layui-input', { type: 'text', readonly: true, spellcheck: 'false' });
    // 原版：出错时是一条 n-alert（红底红边），不是一行红字
    var hint = D.h('div');
    var prefixNote = D.h('p.field-hint');

    var rows = TARGETS.map(function (target) {
      var box = D.h('input.layui-input', { type: 'text', readonly: true, spellcheck: 'false' });
      // 原版这里是一排 input-copyable：标签在左、170px、右对齐，
      // 复制图标是输入框的 suffix。不是表格 —— 表格里复制按钮会掉到框外面。
      return {
        base: target.base,
        box: box,
        el: D.h('div.field-row', { style: { '--field-label-width': '170px' } },
          D.h('label.field-label', { text: target.label }),
          box,
          U.copyButton(function () { return box.value; })),
      };
    });

    function row(labelText, control) {
      return D.h('div.field-row', { style: { '--field-label-width': '110px' } },
        D.h('label.field-label', { text: labelText }), control);
    }

    var fromRow = row(t('input_base', 'Input base ({min}-{max})')
      .replace('{min}', MIN_BASE).replace('{max}', MAX_BASE), fromInput);

    function render() {
      // 带前缀时前缀说了算：上面选的输入进制这时是无效的，得让人看出来
      var prefix = detectBasePrefix(valueInput.value);
      var base = prefix ? prefix.base : Number(fromInput.value);
      fromInput.disabled = !!prefix;
      fromRow.style.opacity = prefix ? '0.45' : '';
      prefixNote.textContent = prefix
        ? t('prefix_detected', 'Base prefix detected → parsed as base {base} (the input base selected above is ignored)')
            .replace('{base}', prefix.base)
        : '';

      var custom = Number(toInput.value);
      var error = '';

      rows.forEach(function (r) {
        var out = tryConvertBase({ value: valueInput.value, fromBase: base, toBase: r.base });
        r.box.value = out.value;
        if (!error) error = out.error;
      });

      var out = tryConvertBase({ value: valueInput.value, fromBase: base, toBase: custom });
      customBox.value = out.value;
      if (!error) error = out.error;

      // 原版出错时用 n-alert 提示，行还是照常渲染（出错的那格留空）
      D.clear(hint);
      if (error) hint.appendChild(U.alert('error', null, error));
    }

    valueInput.addEventListener('input', render);
    fromInput.addEventListener('input', render);
    toInput.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      row(t('input', 'Input number'), valueInput),
      fromRow,
      prefixNote,

      hint,
      // 原版这里有一条 n-divider，把「输入」和「结果」分开
      U.divider(),
      rows.map(function (r) { return r.el; }),
      // 「Custom:」是个数字输入框，跟结果并排 —— 原版就是这一行的两个控件。
      // 原版那格是 n-input-group-label：文字 + 左右各 12px 内边距 = 82px，
      // 而且它跟输入框是紧挨着的（n-input-group 里没有间隙）。
      // 82px 是按原版量出来的：原版那格是内容宽，可它的字体比我们的宽 5px，
      // 跟着内容走会变成 77px —— 这里直接钉死 82px，跟原版对齐。
      D.h('div.field-row', null,
        D.h('div.input-group', { style: { width: '160px', flex: '0 0 160px', gap: '0' } },
          D.h('span.input-group-label', { style: { width: '82px', flex: '0 0 82px', padding: '0 12px' }, text: t('custom', 'Custom:') }),
          toInput),
        customBox,
        U.copyButton(function () { return customBox.value; }))
    ));

    render();
    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['integer-base-converter'] = {
    DIGITS: DIGITS,
    MIN_BASE: MIN_BASE,
    MAX_BASE: MAX_BASE,
    TARGETS: TARGETS,
    convertBase: convertBase,
    tryConvertBase: tryConvertBase,
    detectBasePrefix: detectBasePrefix,
    __cases: function (assert) {
      // 与参考实现 vitest 用例一致
      assert.eq(convertBase({ value: '0', fromBase: 2, toBase: 11 }), '0', '0');
      assert.eq(convertBase({ value: '0', fromBase: 5, toBase: 2 }), '0', '0');
      assert.eq(convertBase({ value: '0', fromBase: 10, toBase: 16 }), '0', '0');
      assert.eq(convertBase({ value: '10100101', fromBase: 2, toBase: 16 }), 'a5', '二进制 → 十六进制');
      assert.eq(convertBase({ value: '192654', fromBase: 10, toBase: 8 }), '570216', '十进制 → 八进制');
      assert.eq(convertBase({ value: 'zz', fromBase: 64, toBase: 10 }), '2275', 'base64 字母 → 十进制');
      var big = '42540766411283223938465490632011909384';
      assert.eq(convertBase({ value: big, fromBase: 10, toBase: 10 }), big, '超长整数原样返回');
      assert.eq(convertBase({ value: big, fromBase: 10, toBase: 16 }), '20010db8000085a300000000ac1f8908', '超长整数 → 十六进制');
      assert.eq(convertBase({ value: '20010db8000085a300000000ac1f8908', fromBase: 16, toBase: 10 }), big, '超长整数 ← 十六进制');

      // 常用进制
      assert.eq(convertBase({ value: '255', fromBase: 10, toBase: 16 }), 'ff', '255 → ff');
      assert.eq(convertBase({ value: 'ff', fromBase: 16, toBase: 10 }), '255', 'ff → 255');
      assert.eq(convertBase({ value: '-255', fromBase: 10, toBase: 16 }), '-ff', '负数');
      assert.eq(convertBase({ value: '-ff', fromBase: 16, toBase: 10 }), '-255', '负数回来');
      assert.eq(convertBase({ value: '+42', fromBase: 10, toBase: 2 }), '101010', '前导加号');
      assert.eq(convertBase({ value: '00042', fromBase: 10, toBase: 10 }), '42', '前导零');
      assert.eq(convertBase({ value: 'A5', fromBase: 16, toBase: 10 }), '165', '十六进制大写字母（原版会报错）');
      assert.eq(convertBase({ value: 'Z', fromBase: 36, toBase: 10 }), '35', '36 进制最大数字');
      assert.eq(convertBase({ value: '7', fromBase: 8, toBase: 2 }), '111', '八进制 → 二进制');
      assert.eq(convertBase({ value: '  42  ', fromBase: 10, toBase: 16 }), '2a', '两端空白被 trim');
      assert.eq(convertBase({ value: '-0', fromBase: 10, toBase: 10 }), '0', '负零归一成 0');

      // 进制前缀（上游 #901）：前缀说了算，忽略用户选的输入进制
      assert.eq(convertBase({ value: '0xAA', fromBase: 10, toBase: 10 }), '170', '0x 前缀 → 16 进制');
      assert.eq(convertBase({ value: '0XAA', fromBase: 10, toBase: 10 }), '170', '0X 前缀');
      assert.eq(convertBase({ value: '&HAA', fromBase: 10, toBase: 10 }), '170', '&H 前缀');
      assert.eq(convertBase({ value: '&hAA', fromBase: 10, toBase: 10 }), '170', '&h 前缀');
      assert.eq(convertBase({ value: '0o252', fromBase: 10, toBase: 10 }), '170', '0o 前缀 → 8 进制');
      assert.eq(convertBase({ value: '&O252', fromBase: 10, toBase: 10 }), '170', '&O 前缀');
      assert.eq(convertBase({ value: '0b10101010', fromBase: 10, toBase: 10 }), '170', '0b 前缀 → 2 进制');
      assert.eq(convertBase({ value: '&B10101010', fromBase: 10, toBase: 10 }), '170', '&B 前缀');
      assert.eq(convertBase({ value: '0xAAUL', fromBase: 10, toBase: 10 }), '170', 'VB6 类型后缀只影响读法');
      assert.eq(convertBase({ value: '0xFF', fromBase: 16, toBase: 10 }), '255', '前缀与所选进制一致时也对');
      assert.eq(convertBase({ value: '-0x1F', fromBase: 10, toBase: 10 }), '-31', '负号 + 前缀');
      assert.eq(detectBasePrefix('0xAA'), { base: 16 }, '前缀识别');
      assert.eq(detectBasePrefix('42'), null, '没有前缀');
      assert.eq(detectBasePrefix(''), null, '空串没有前缀');
      assert(/no digits/.test(err({ value: '0x', fromBase: 10, toBase: 10 })), '只有前缀没有数字');

      // 空输入返回空串（原版返回 "0"）
      assert.eq(convertBase({ value: '', fromBase: 10, toBase: 16 }), '', '空输入');
      assert.eq(convertBase({ value: '   ', fromBase: 10, toBase: 16 }), '', '纯空白');
      assert.eq(convertBase({ value: null, fromBase: 10, toBase: 16 }), '', 'null 输入');

      // 非法字符必须给出明确错误，不能静默返回空串
      function err(opts) {
        try { convertBase(opts); } catch (e) { return e.message; }
        return '';
      }
      assert.eq(err({ value: '12', fromBase: 10, toBase: 2 }), '', '十进制 12 → 二进制合法');
      assert(/Invalid character "9"/.test(err({ value: '9', fromBase: 8, toBase: 10 })), '八进制里没有 9');
      assert(/Invalid character "g"/.test(err({ value: 'ffg', fromBase: 16, toBase: 10 })), '十六进制里没有 g');
      assert(/Invalid character "-"/.test(err({ value: '1-2', fromBase: 10, toBase: 2 })), '负号不能出现在中间');
      assert(/no digits/.test(err({ value: '-', fromBase: 10, toBase: 2 })), '只有符号');
      assert(/Invalid character/.test(err({ value: '1 2', fromBase: 10, toBase: 2 })), '中间不能有空格');
      assert(/must be an integer/.test(err({ value: '1', fromBase: 1, toBase: 10 })), '进制 1 非法');
      assert(/must be an integer/.test(err({ value: '1', fromBase: 10, toBase: 65 })), '进制 65 非法');
      assert(/must be an integer/.test(err({ value: '1', fromBase: 10, toBase: 2.5 })), '非整数进制');
      assert(/must be an integer/.test(err({ value: '1', fromBase: 10, toBase: NaN })), 'NaN 进制');

      // tryConvertBase 不抛错
      assert.eq(tryConvertBase({ value: 'ff', fromBase: 16, toBase: 10 }), { value: '255', error: '' }, '正常转换');
      assert.eq(tryConvertBase({ value: 'g', fromBase: 16, toBase: 10 }).value, '', '出错时 value 为空串');
      assert(tryConvertBase({ value: 'g', fromBase: 16, toBase: 10 }).error.length > 0, '出错时有错误信息');

      // 2 ~ 36 进制全覆盖：小数字在任意两种进制之间往返
      for (var from = 2; from <= 36; from++) {
        for (var to = 2; to <= 36; to++) {
          var text = convertBase({ value: '123456789', fromBase: 10, toBase: to });
          assert.eq(convertBase({ value: text, fromBase: to, toBase: from }),
            convertBase({ value: '123456789', fromBase: 10, toBase: from }),
            from + ' ⇄ ' + to + ' 往返');
        }
      }
    }
  };
})();