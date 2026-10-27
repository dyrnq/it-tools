/* ==========================================================================
   MAC 地址生成器（mac-address-generator）

   按给定的前缀（OUI / 组织标识符）批量生成随机 MAC 地址。

   参考实现：src/tools/mac-address-generator/（it-tools, GPLv3）
   与原版的差别：
   1. 原版每个字节调一次 lodash.random()，也就是 Math.random()，
      不是密码学安全的随机源。这里一次向 crypto 取 6 个字节再十六进制化。
   2. 原版对超过 6 字节的前缀不处理（_.times 传负数返回空数组），
      会直接输出一条 7 组甚至更长的「MAC 地址」。这里把前缀截到 6 字节。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('mac-address-generator');

  /** 一个 MAC 地址最多 6 个字节。 */
  var MAX_BYTES = 6;
  /** 一次最多生成多少条。 */
  var MAX_AMOUNT = 100;

  var CASES = [
    { label: t('case_upper', 'Uppercase'), value: 'upper' },
    { label: t('case_lower', 'Lowercase'), value: 'lower' }
  ];

  var SEPARATORS = [
    { label: ':', value: ':' },
    { label: '-', value: '-' },
    { label: '.', value: '.' },
    { label: t('separator_none', 'None'), value: '' }
  ];

  /**
   * 把前缀拆成字节数组。
   * 纯十六进制的输入按每两位一组切；含分隔符的按分隔符切，每段左补零到两位。
   * 与参考实现的 splitPrefix 行为一致（'ff:ee:a' → ['ff','ee','0a']）。
   * @param {string} prefix
   * @returns {string[]}
   */
  function splitPrefix(prefix) {
    var text = String(prefix == null ? '' : prefix);
    var isPureHex = /[^0-9a-f]/i.test(text) === false;
    var parts = isPureHex ? text.match(/.{1,2}/g) || [] : text.split(/[^0-9a-f]+/i);
    return parts.filter(Boolean).map(function (byte) { return byte.padStart(2, '0'); });
  }

  /** 取 n 个随机字节的十六进制串（两位小写）。 */
  function randomByteHex(n) {
    return U.hex(U.randomBytes(n));
  }

  /**
   * 主函数：生成一条 MAC 地址。
   * @param {{prefix?: string, separator?: string, getRandomByte?: () => string}} opts
   *        getRandomByte 供单测注入；默认一次性从 crypto 取随机字节
   */
  function generateRandomMacAddress(opts) {
    opts = opts || {};
    var separator = opts.separator === undefined ? ':' : opts.separator;
    var prefix = splitPrefix(opts.prefix).slice(0, MAX_BYTES);
    var need = MAX_BYTES - prefix.length;

    var randomBytes = [];
    if (need > 0) {
      if (opts.getRandomByte) {
        for (var i = 0; i < need; i++) randomBytes.push(String(opts.getRandomByte(i)));
      } else {
        randomBytes = randomByteHex(need).match(/.{2}/g);
      }
    }

    return prefix.concat(randomBytes).join(separator);
  }

  /**
   * 批量生成。case 为 'upper' | 'lower'。
   * @returns {string} 多行输出
   */
  function generateMany(opts) {
    opts = opts || {};
    var amount = Math.max(1, Math.min(MAX_AMOUNT, Math.floor(opts.amount || 1)));
    var lines = [];
    for (var i = 0; i < amount; i++) {
      var mac = generateRandomMacAddress(opts);
      lines.push(opts.case === 'lower' ? mac.toLowerCase() : mac.toUpperCase());
    }
    return lines.join('\n');
  }

  /** 部分 MAC 前缀是否合法（最多 6 段，每段两位十六进制，可带 : - . 或空格分隔）。 */
  function isValidPartialPrefix(prefix) {
    return /^([0-9a-f]{2}[:\-. ]){0,5}([0-9a-f]{0,2})$/i.test(String(prefix == null ? '' : prefix).trim());
  }

  window.ItTools.register('mac-address-generator', function (root) {
    var amount = D.h('input.layui-input', { type: 'number', min: 1, max: 100, value: 1 });
    var prefix = D.h('input.layui-input', {
      type: 'text', value: '64:16:7F', spellcheck: 'false', placeholder: t('prefix_ph', 'Set a prefix, e.g. 64:16:7F')
    });
    var caseSelect = D.h('select.layui-select');
    CASES.forEach(function (c, i) {
      caseSelect.appendChild(D.h('option', { value: c.value, selected: i === 0, text: c.label }));
    });
    var separatorSelect = D.h('select.layui-select');
    SEPARATORS.forEach(function (sep, i) {
      separatorSelect.appendChild(D.h('option', { value: sep.value, selected: i === 0, text: sep.label }));
    });
    // 原版的结果是一张 c-card 里的 <pre m-0 m-x-auto> —— 宽度按内容收缩、
    // 水平居中。照着来。
    var output = D.h('pre.mono-output', { style: { width: 'fit-content', margin: '0 auto' } });
    var hint = D.h('p.field-hint');

    function options() {
      return {
        amount: Number(amount.value),
        prefix: prefix.value,
        separator: separatorSelect.value,
        case: caseSelect.value
      };
    }

    function refresh() {
      var ok = isValidPartialPrefix(prefix.value);
      hint.textContent = ok ? '' : t('invalid_prefix', 'Invalid partial MAC address');
      output.textContent = ok ? generateMany(options()) : '';
    }

    [amount, prefix, caseSelect, separatorSelect].forEach(function (el) {
      el.addEventListener('input', refresh);
      el.addEventListener('change', refresh);
    });

    // 原版这一页：输入区直接躺在页面背景上（没有卡片），
    // 结果单独装在**一张卡片**里（c-card mt-5 + 一个 <pre>），
    // 按钮排在结果卡片**下面**。
    //
    // 四个字段的标签都在左边、固定 **150px**、右对齐
    // （Quantity 是裸 <label w-150px text-right>，其余三个是
    //  c-input-text / c-buttons-select 显式写的 label-width="150px"）。
    var LABEL_STYLE = { '--field-label-width': '150px' };

    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('quantity', 'Quantity:') }), amount),
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('prefix', 'MAC address prefix:') }), prefix),
      hint,
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('case', 'Case:') }), caseSelect),
      D.h('div.field-row', { style: LABEL_STYLE }, D.h('label.field-label', { text: t('separator', 'Separator:') }), separatorSelect)
    ));

    root.appendChild(D.h('div.card', null, output));

    // 按钮排在结果卡片**下面**（原版的顺序）。
    // 外面再包一层 div：顶层元素得是「装着完整内容」的块，
    // 光秃秃一个 .form-actions 会被当成散件（见 test/js/harness.js）。
    root.appendChild(D.h('div', null,
      D.h('div.form-actions', null,
        U.copyButton(function () { return output.textContent; }),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('refresh', 'Refresh'), onclick: refresh
        })
      )
    ));
    refresh();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['mac-address-generator'] = {
    generateRandomMacAddress: generateRandomMacAddress,
    generateMany: generateMany,
    splitPrefix: splitPrefix,
    isValidPartialPrefix: isValidPartialPrefix,
    __cases: function (assert) {
      // 与参考实现的 vitest 用例一致：确定性字节序列 00 01 02 03 04 05
      function counter() {
        var i = 0;
        return function () { return (i++).toString(16).padStart(2, '0'); };
      }

      // 前缀切分
      assert.eq(splitPrefix(''), [], '空前缀');
      assert.eq(splitPrefix('01'), ['01'], '两位');
      assert.eq(splitPrefix('01:'), ['01'], '带尾分隔符');
      assert.eq(splitPrefix('01:23'), ['01', '23'], '冒号分隔');
      assert.eq(splitPrefix('01-23'), ['01', '23'], '连字符分隔');
      assert.eq(splitPrefix('0123'), ['01', '23'], '纯十六进制按两位切');
      assert.eq(splitPrefix('012345'), ['01', '23', '45'], '六位纯十六进制');
      assert.eq(splitPrefix('0123456'), ['01', '23', '45', '06'], '七位纯十六进制，末位补零');

      // 生成
      assert.eq(generateRandomMacAddress({ getRandomByte: counter() }), '00:01:02:03:04:05', '无前缀');
      assert.eq(generateRandomMacAddress({ prefix: 'ff:ee:aa', getRandomByte: counter() }), 'ff:ee:aa:00:01:02', '三字节前缀');
      assert.eq(generateRandomMacAddress({ prefix: 'ff:ee:a', getRandomByte: counter() }), 'ff:ee:0a:00:01:02', '末段左补零');
      assert.eq(generateRandomMacAddress({ prefix: 'ff-ee-aa', separator: '-', getRandomByte: counter() }), 'ff-ee-aa-00-01-02', '连字符前缀 + 连字符分隔');
      assert.eq(generateRandomMacAddress({ prefix: 'ff-ee:aa', separator: '-', getRandomByte: counter() }), 'ff-ee-aa-00-01-02', '混合前缀');
      assert.eq(generateRandomMacAddress({ prefix: 'ff ee:aa', separator: '-', getRandomByte: counter() }), 'ff-ee-aa-00-01-02', '空格前缀');
      assert.eq(generateRandomMacAddress({ separator: '', getRandomByte: counter() }), '000102030405', '无分隔符');
      assert.eq(generateRandomMacAddress({ prefix: 'ff:ee:aa:bb:cc:dd', getRandomByte: counter() }), 'ff:ee:aa:bb:cc:dd', '满 6 字节前缀不再补随机位');

      // 超过 6 字节的前缀要截断，而不是输出一条 7 组的伪地址
      var tooLong = generateRandomMacAddress({ prefix: 'aabbccddeeff', getRandomByte: counter() });
      assert.eq(tooLong, 'aa:bb:cc:dd:ee:ff', '超长前缀截到 6 字节');

      // 随机源走 crypto，两次生成不应相同
      var a = generateRandomMacAddress({ prefix: '64:16:7F' });
      var b = generateRandomMacAddress({ prefix: '64:16:7F' });
      assert(/^64:16:7F:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/.test(a), '默认分隔符与前缀: ' + a);
      assert(a !== b, '两次生成应不同');

      // 批量与大小写
      var many = generateMany({ amount: 3, prefix: '64:16:7F', case: 'upper' });
      assert.eq(many.split('\n').length, 3, '生成 3 条');
      assert(many.split('\n').every(function (line) {
        return /^64:16:7F:[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/.test(line);
      }), '大写: ' + many);
      assert(/^64:16:7f:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/.test(generateMany({ amount: 1, prefix: '64:16:7f', case: 'lower' })), '小写');

      // 前缀合法性
      // 分隔符只有一位，所以「两位一组」是硬约束：aabb.ccdd.ee 这种三组两字节的
      // Cisco 写法反而通不过（与参考实现的校验正则一致）
      ['64:16:7F', '00-11-22', 'aa-bb:cc', '', 'aa bb', 'aa:bb:cc:dd:ee:ff'].forEach(function (p) {
        assert(isValidPartialPrefix(p), '合法前缀：' + JSON.stringify(p));
      });
      ['xyz', 'aa:bb:zz', 'aa:bb:cc:dd:ee:ff:11', 'aabb.ccdd.ee'].forEach(function (p) {
        assert(!isValidPartialPrefix(p), '非法前缀：' + JSON.stringify(p));
      });
    }
  };
})();