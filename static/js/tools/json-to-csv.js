/* ==========================================================================
   JSON 转 CSV（json-to-csv）

   把一个 JSON 数组（对象数组）转成 CSV 文本。表头取所有对象键的并集，
   按首次出现顺序排列。

   嵌套的对象会被**压平**成 `a.b.c` 这样的列名（上游 #1277 的能力），
   顶层给一个对象（不是数组）也行 —— 包成只有一行的数组即可。

   参考实现：src/tools/json-to-csv/（it-tools, GPLv3）
   与原版的一处差别 —— **原版的引号处理是坏的**：
   它先把 `"` 换成 `\"`，然后只在「值里含逗号」时才给整段套上引号。于是
   `he said "hi"` 这种不含逗号的值会输出成 `he said \"hi\"` —— 反斜杠在 CSV 里
   没有转义含义，整行会被解析成带引号的垃圾。这里按 RFC 4180 来：含逗号、
   引号、CR 或 LF 才套引号，内部的引号翻倍（""）。
   换行也不再压成字面量 \n —— 丢数据不是转义的代价。
   - 补了下载按钮（上游 #1169）：输出区多一个 Download 按钮，把结果存成
     output.csv。下载用的是 app.js 里早就写好的 ItTools.download，
     这里只是把按钮补上（文件名与上游一致）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-to-csv');

  /**
   * 把嵌套对象压平成单层键（`{a:{b:1}}` → `{'a.b': 1}`）。
   *
   * 规则与上游用的 `flatten-anything` 一致：
   * - 只有**非空的对象**会被展开；数组原样保留成一个值
   *   （`{a:[1,2]}` 的 `a` 这一列里就是那个数组，不会变成 `a.0` / `a.1`）；
   * - 空对象也原样保留 —— 否则这一列会整个消失，数据凭空丢了。
   *
   * 自己写而不是 vendor 那个包：它只有二十来行，而且是纯 ESM，
   * 我们这套前端没有构建步骤，ESM 产物得先转成 IIFE 才用得上。
   *
   * @param {Object} obj
   * @param {string} [prefix]
   * @param {Object} [out]
   * @returns {Object}
   */
  function flattenObject(obj, prefix, out) {
    out = out || {};
    prefix = prefix || '';
    Object.keys(obj).forEach(function (key) {
      var value = obj[key];
      var path = prefix ? prefix + '.' + key : key;
      var isPlainObject = value !== null && typeof value === 'object' &&
        !Array.isArray(value) && Object.keys(value).length > 0;
      if (isPlainObject) flattenObject(value, path, out);
      else out[path] = value;
    });
    return out;
  }

  /**
   * 表头 = 所有对象键的并集，按首次出现顺序。
   * @param {Array<Object>} array
   * @returns {string[]}
   */
  function getHeaders(array) {
    var headers = [];
    var seen = {};
    if (!Array.isArray(array)) return headers;
    array.forEach(function (item) {
      if (item === null || typeof item !== 'object') return;
      Object.keys(flattenObject(item)).forEach(function (key) {
        if (!seen[key]) { seen[key] = true; headers.push(key); }
      });
    });
    return headers;
  }

  /**
   * 单个值转成 CSV 字段。null → 'null'，undefined/null 字段 → 空串。
   * @param {*} value
   */
  function serializeValue(value) {
    if (value === null) return 'null';
    if (value === undefined) return '';
    // 哨兵在 CSV 里只能是裸数字：它是「数字」不是「数字的字符串」，
    // 加引号会被 Excel 当文本。这里逐值还原，别对拼好的 CSV 跑
    // restoreBigIntegers —— 那会把 RFC 4180 的引号一起吃掉。
    if (typeof value === 'string') value = U.restoreBigIntegerValue(value);
    if (typeof value === 'object') return serializeValue(JSON.stringify(value));

    var s = String(value);
    // RFC 4180：只有这些字符出现时才必须加引号
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * 主函数：对象数组 → CSV 文本。
   *
   * 顶层给一个对象（不是数组）也接受 —— 包成只有一行的数组。
   * @param {Array<Object>|Object} input
   * @returns {string}
   */
  function convertArrayToCsv(input) {
    if (input === null || typeof input !== 'object') {
      throw new Error(t('err_input_type', 'Input must be a JSON array or object'));
    }
    var array = Array.isArray(input) ? input : [input];
    var headers = getHeaders(array);
    var rows = array.map(function (item) {
      if (item === null || typeof item !== 'object') return headers.map(function () { return serializeValue(item); });
      var flat = flattenObject(item);
      return headers.map(function (h) { return serializeValue(flat[h]); });
    });
    return [headers.map(serializeValue).join(',')].concat(rows.map(function (r) { return r.join(','); })).join('\n');
  }

  /** 表头也是字段，同样要转义（键里带逗号是合法的） */
  function escapeHeader(header) { return serializeValue(header); }

  window.ItTools.register('json-to-csv', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20, spellcheck: 'false', placeholder: t('input_ph', 'Paste your raw JSON here...')
    });
    var output = U.codeBlock();
    var error = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });

    function render() {
      var raw = input.value.trim();
      D.clear(error);
      if (!raw) { output.value = ''; return; }
      var parsed;
      // 保护超范围整数，否则 19 位订单号会被舍掉末几位再进 CSV
      try { parsed = JSON.parse(U.guardBigIntegers(raw)); }
      catch (e) {
        output.value = '';
        error.textContent = t('err_parse', 'JSON parse failed: {msg}').replace('{msg}', e.message);
        return;
      }
      if (parsed === null || typeof parsed !== 'object') {
        output.value = '';
        error.textContent = t('err_not_object',
          'A JSON array or object is required — the top level is {type}.')
          .replace('{type}', parsed === null ? 'null' : typeof parsed);
        return;
      }
      try { output.value = convertArrayToCsv(parsed); }
      catch (e) {
        output.value = '';
        error.textContent = t('err_convert', 'Conversion failed: {msg}').replace('{msg}', e.message);
      }
    }

    var off = D.on(input, 'input', render);
    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your raw JSON'), input),
      error
    ));
    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'CSV') }),
      output.card,
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download', 'Download'), onclick: function () {
            if (output.value) {
              window.ItTools.download('output.csv', output.value, 'text/csv;charset=utf-8');
            }
          }
        })
      )
    ));
    render();

    return { destroy: function () { off(); D.clear(root); } };
  });

  window.ItTools.logic['json-to-csv'] = {
    getHeaders: getHeaders,
    flattenObject: flattenObject,
    serializeValue: serializeValue,
    convertArrayToCsv: convertArrayToCsv,
    escapeHeader: escapeHeader,
    __cases: function (assert) {
      // 表头是所有对象键的并集，按首次出现顺序
      assert.eq(getHeaders([{ a: 1 }, { b: 2 }, { a: 3 }]), ['a', 'b'], '表头取并集且去重');
      assert.eq(getHeaders([]), [], '空数组没有表头');
      assert.eq(getHeaders([{ 'x,y': 1 }]), ['x,y'], '键里带逗号也要收进表头');

      // 嵌套对象压平成 a.b.c（上游 #1277）
      assert.eq(flattenObject({ a: { b: 1 }, c: 2 }), { 'a.b': 1, c: 2 }, '嵌套对象压平');
      assert.eq(flattenObject({ a: { b: { c: 1 } } }), { 'a.b.c': 1 }, '多层嵌套');
      assert.eq(flattenObject({ a: [1, 2] }), { a: [1, 2] }, '数组原样保留，不拆成 a.0 / a.1');
      assert.eq(flattenObject({ a: {} }), { a: {} }, '空对象原样保留（否则这一列会整个消失）');
      assert.eq(getHeaders([{ a: { c: 1, d: 1 }, b: 2 }, { a: 3, c: 4 }]),
        ['a.c', 'a.d', 'b', 'a', 'c'], '表头取压平后的键');
      assert.eq(convertArrayToCsv([{ a: { c: 1, d: 1 }, b: 2 }, { a: 3, c: 4 }]),
        'a.c,a.d,b,a,c\n1,1,2,,\n,,,3,4', '嵌套数组转 CSV');
      assert.eq(convertArrayToCsv([{ a: { b: { c: 1 } } }]), 'a.b.c\n1', '多层嵌套转 CSV');

      // 基本转换
      assert.eq(convertArrayToCsv([{ a: 1, b: 'x' }]), 'a,b\n1,x', '单行');
      assert.eq(convertArrayToCsv([{ a: 1 }, { a: 2 }]), 'a\n1\n2', '同结构多行');
      assert.eq(convertArrayToCsv([{ a: 1 }, { b: 2 }]), 'a,b\n1,\n,2', '缺字段补空');

      // RFC 4180 引号：这三条是原版坏掉的地方
      assert.eq(serializeValue('he said "hi"'), '"he said ""hi"""', '含引号必须整体加引号并翻倍');
      assert.eq(serializeValue('a,b'), '"a,b"', '含逗号加引号');
      assert.eq(serializeValue('line1\nline2'), '"line1\nline2"', '含换行加引号而不是压成字面量');
      assert.eq(serializeValue('plain'), 'plain', '不含特殊字符不加引号');
      assert.eq(convertArrayToCsv([{ a: 'x,y', b: 'q"z' }]), 'a,b\n"x,y","q""z"', '整行转义');

      // null / undefined
      assert.eq(serializeValue(null), 'null', 'null 字面量');
      assert.eq(serializeValue(undefined), '', 'undefined 是空串');
      assert.eq(convertArrayToCsv([{ a: null }]), 'a\nnull', 'null 字段');

      // 非标量
      assert.eq(serializeValue({ x: 1 }), '"{""x"":1}"', '对象先 JSON.stringify 再转义');
      assert.eq(serializeValue([1, 2]), '"[1,2]"', '数组同理');
      assert.eq(serializeValue(false), 'false', '布尔');
      assert.eq(serializeValue(0), '0', '数字 0 不是空');

      // 边界
      assert.eq(convertArrayToCsv([]), '', '空数组得到空串（连表头都没有）');
      assert.eq(serializeValue(''), '', '空串');

      // 顶层给一个对象（不是数组）也接受 —— 包成只有一行
      assert.eq(convertArrayToCsv({ a: { c: 1, d: 1 }, b: 2 }), 'a.c,a.d,b\n1,1,2', '单个对象转 CSV');
      assert.eq(convertArrayToCsv({ a: 1, b: 'x' }), 'a,b\n1,x', '单个简单对象');

      // 顶层既不是数组也不是对象（数字、字符串、null）必须报错，不能静默
      var threw = false;
      try { convertArrayToCsv(42); } catch (e) { threw = true; }
      assert(threw, '顶层是数字应抛错');
      threw = false;
      try { convertArrayToCsv(null); } catch (e) { threw = true; }
      assert(threw, '顶层是 null 应抛错');
    }
  };
})();