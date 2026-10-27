/* ==========================================================================
   CSV 转 JSON（csv-to-json）

   把 RFC 4180 的 CSV 文本转成 JSON 对象数组。带引号的字段里可以有分隔符、
   换行和转义过的双引号（""）；CRLF 与 LF 两种换行都认。

   参考实现：src/tools/csv-to-json/（it-tools, GPLv3）
   与原版的差别：
   1. **超范围整数不再丢精度**（原版的 bug）：原版 inferValue 一律 Number(raw)，
      19 位的订单号 9223372036854775807 会被舍成 ...808 再进 JSON —— 用户
      的数据被改了还不吭声。这里改用 app.js 里那套哨兵办法：
      U.guardBigIntegers 把超范围整数换成哨兵字符串，中间态里它是字符串，
      序列化之后 U.restoreBigIntegers 再换回裸数字 —— 文本无损。
   2. **超范围的小数保留成字符串**：整数部分就超出 2^53-1 的小数，
      Number() 一定改数据（9223372036854775807.5 → 9223372036854775808），
      宁可原样留成字符串，也不悄悄把用户的数字改掉。
   3. 多了「跳过空行」开关：原版只丢**末尾**整行皆空的行，中间的空行会变成
      一条各列都是 null 的记录；这里可以让中间的空行也一起丢掉。
   4. 多了自定义分隔符输入框（原版下拉框里只有四个）。
   5. 输出区多了下载按钮（原版没有）。
   行为与原版一致的：RFC 4180 的引号规则（引号内的分隔符/换行、"" 转义）、
   无表头时列名取 column_1 / column_2（带下划线）、类型推断
   （true / false / null / 数字，空串算 null）、缺列补 null、
   多出来的列丢掉、trim 只作用于没加引号的字段。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('csv-to-json');

  /** 默认配置，与参考实现 useStorage 里的初始值一致 */
  var DEFAULTS = {
    delimiter: ',',
    hasHeaders: true,
    inferTypes: true,
    trimFields: true,
    skipEmptyLines: false
  };

  /** 合并默认配置，调用方只写自己关心的字段即可 */
  function withDefaults(options) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    if (options) {
      Object.keys(options).forEach(function (k) {
        if (options[k] !== undefined && options[k] !== null) out[k] = options[k];
      });
    }
    return out;
  }

  /**
   * 值的类型推断。规则与参考实现一致：
   * 空串 → null，'true' / 'false' / 'null' → 对应的字面量，
   * 整数与小数 → number，其余 → 原样当字符串。
   *
   * 数字这一档多做了两件事（都是原版没有的）：
   * - 整数超出 2^53-1 时不转成 Number，改用 app.js 的哨兵字符串
   *   （U.guardBigIntegers），序列化时由 U.restoreBigIntegers 换回裸数字；
   * - 小数的整数部分就超范围时保留原字符串 —— Number() 一定会改它。
   *
   * @param {string} raw 字段的原始文本
   * @returns {*} null / 布尔 / 数字 / 字符串
   */
  function inferValue(raw) {
    if (raw === '') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return raw;

    var dot = raw.indexOf('.');
    var isDecimal = dot >= 0;
    var intPart = isDecimal ? raw.slice(0, dot) : raw;
    var guarded = U.guardBigIntegers(intPart);

    if (guarded !== intPart) {
      // 整数部分超出安全范围
      if (isDecimal) return raw;               // 小数：转成数字一定改数据，留着
      // 纯整数：换成哨兵（guardBigIntegers 给的是带引号的一整段，去掉引号）
      return guarded.slice(1, -1);
    }

    var n = Number(raw);
    if (Number.isFinite(n)) return n;
    return raw;
  }

  /**
   * RFC 4180 状态机：把 CSV 文本拆成二维数组（每一格是原始字符串）。
   *
   * - 引号里的分隔符、换行都是普通字符；
   * - 引号里的 "" 是转义过的一个引号；
   * - 字段外的 CR / LF / CRLF 都是行分隔符；
   * - 引号前面允许有空白（trim 开着的时候）—— 这是原版的宽松处理，
   *   原版 RFC 4180 的引号规则是照抄的，这里不动。
   *
   * @param {string} csv
   * @param {object} options 见 DEFAULTS
   * @returns {string[][]}
   */
  function parseRows(csv, options) {
    var o = withDefaults(options);
    // 原版：分隔符不是一个字符就退回逗号
    var delimiter = o.delimiter && o.delimiter.length === 1 ? o.delimiter : ',';
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var started = false;   // 这个字段是不是加过引号（加过就不 trim）

    for (var index = 0; index < csv.length; index++) {
      var char = csv.charAt(index);

      if (inQuotes) {
        if (char === '"') {
          if (csv.charAt(index + 1) === '"') { field += '"'; index++; }
          else { inQuotes = false; }
        }
        else {
          field += char;
        }
        continue;
      }

      // 开引号：字段开头，或者（trim 开着时）只有空白
      if (char === '"' && (field === '' || (o.trimFields && field.trim() === ''))) {
        inQuotes = true;
        started = true;
        field = '';
        continue;
      }

      if (char === delimiter) {
        row.push(o.trimFields && !started ? field.trim() : field);
        field = '';
        started = false;
        continue;
      }

      if (char === '\n' || char === '\r') {
        if (char === '\r' && csv.charAt(index + 1) === '\n') index++;   // CRLF 当一个换行
        row.push(o.trimFields && !started ? field.trim() : field);
        rows.push(row);
        row = [];
        field = '';
        started = false;
        // 末尾的换行不再算一行（原版行为）
        if (index + 1 >= csv.length) break;
        continue;
      }

      field += char;
    }

    // 循环结束时手上还有没落盘的东西（最后一行没有换行结尾）
    if (field !== '' || row.length > 0 || started) {
      row.push(o.trimFields && !started ? field.trim() : field);
      rows.push(row);
    }
    return rows;
  }

  /**
   * 主函数：CSV 文本 → {headers, records}。
   *
   * @param {string} csv
   * @param {object} options 见 DEFAULTS
   * @returns {{headers: string[], records: Object[]}}
   */
  function parseCsv(csv, options) {
    var o = withDefaults(options);
    var text = csv === null || csv === undefined ? '' : String(csv);
    var rows = parseRows(text, o);

    // 末尾整行皆空的行丢掉（原版行为）
    while (rows.length > 0 && rows[rows.length - 1].every(function (v) { return v === ''; })) {
      rows.pop();
    }
    // 打开「跳过空行」时，中间的空行也一起丢掉（默认关，与原版一致）
    if (o.skipEmptyLines) {
      rows = rows.filter(function (r) {
        return !r.every(function (v) { return v === ''; });
      });
    }

    if (rows.length === 0) return { headers: [], records: [] };

    var firstRow = rows[0];
    // 表头：给了就用，空的表头名补成 column_N；没给就自己生成 column_1 / column_2
    var headers = o.hasHeaders
      ? firstRow.map(function (header, index) { return header || ('column_' + (index + 1)); })
      : firstRow.map(function (_value, index) { return 'column_' + (index + 1); });
    var dataRows = o.hasHeaders ? rows.slice(1) : rows;

    var records = dataRows.map(function (dataRow) {
      var record = {};
      headers.forEach(function (header, index) {
        var raw = dataRow[index] === undefined ? '' : dataRow[index];
        record[header] = o.inferTypes ? inferValue(raw) : raw;
      });
      return record;
    });

    return { headers: headers, records: records };
  }

  /**
   * 记录数组 → JSON 文本（缩进两格）。
   *
   * 序列化之后跑一遍 U.restoreBigIntegers：中间态里那些超范围整数是哨兵字符串，
   * 这一步把它们换回裸的数字字面量 —— 于是 JSON 文本里的数字一位不差。
   *
   * @param {{headers: string[], records: Object[]}} result
   * @param {number} [indent]
   * @returns {string}
   */
  function toJsonText(result, indent) {
    var text = JSON.stringify(result.records, null, indent === undefined ? 2 : indent);
    return U.restoreBigIntegers(text);
  }

  window.ItTools.register('csv-to-json', function (root) {
    var opts = withDefaults(null);

    var input = D.h('textarea.layui-textarea', {
      rows: 8, spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your CSV here')
    });
    input.value = 'name,role,active\nAlice,admin,true\nBob,editor,false';

    var output = D.h('textarea.layui-textarea.mono-output', {
      rows: 12, readonly: 'readonly', spellcheck: 'false'
    });
    var stats = D.h('p.field-hint');
    var error = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });

    /** 一个开关，返回 label 元素并顺手接上状态变化 */
    function toggle(key, labelText) {
      var box = D.h('input', { type: 'checkbox', checked: opts[key] });
      box.checked = !!opts[key];
      box.addEventListener('change', function () {
        opts[key] = box.checked;
        render();
      });
      return D.h('label.switch', null, box, D.h('span', { text: labelText }));
    }

    var delimiterSelect = D.h('select.layui-select', null,
      D.h('option', { value: ',', text: t('delimiter_comma', 'Comma (,)') }),
      D.h('option', { value: ';', text: t('delimiter_semicolon', 'Semicolon (;)') }),
      D.h('option', { value: '\t', text: t('delimiter_tab', 'Tab (\\t)') }),
      D.h('option', { value: '|', text: t('delimiter_pipe', 'Pipe (|)') })
    );
    delimiterSelect.addEventListener('change', function () {
      opts.delimiter = delimiterSelect.value;
      render();
    });

    var customDelimiter = D.h('input.layui-input', {
      type: 'text', placeholder: t('delimiter_custom_ph', 'One character, e.g. |')
    });
    customDelimiter.addEventListener('input', function () { render(); });

    /**
     * 生效的分隔符：自定义框填了就用它，否则用下拉框。
     * 自定义的不是单个字符就报错并退回逗号（原版 parseCsv 也是退回逗号）。
     */
    function effectiveDelimiter() {
      var custom = customDelimiter.value;
      if (!custom) return { value: delimiterSelect.value, bad: false };
      if (custom.length !== 1) return { value: ',', bad: true };
      return { value: custom, bad: false };
    }

    var toggles = [
      toggle('hasHeaders', t('has_headers', 'First row is headers')),
      toggle('inferTypes', t('infer_types', 'Infer types')),
      toggle('trimFields', t('trim_fields', 'Trim fields')),
      toggle('skipEmptyLines', t('skip_empty_lines', 'Skip empty lines'))
    ];

    function render() {
      var delim = effectiveDelimiter();
      D.clear(error);
      if (delim.bad) {
        error.textContent = t('err_delimiter', 'The custom delimiter must be a single character; comma is used instead.');
      }
      opts.delimiter = delim.value;

      var result = parseCsv(input.value, opts);
      output.value = toJsonText(result);
      stats.textContent = t('stats', '{cols} columns · {rows} records · RFC 4180 quoted fields supported')
        .replace('{cols}', result.headers.length)
        .replace('{rows}', result.records.length);
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      D.h('div.switch-grid', null, toggles),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('delimiter', 'Delimiter') }),
        delimiterSelect,
        D.h('label.field-label', { text: t('delimiter_custom', 'Custom delimiter') }),
        customDelimiter
      ),
      error,
      U.field(t('input', 'CSV input'), input, {
        wide: true,
        hint: t('input_hint', 'Quoted fields may contain commas, quotes ("" for one quote) and line breaks.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      U.field(t('output', 'JSON output'), output, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return output.value; }, t('copy_json', 'Copy JSON')),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download', 'Download'), onclick: function () {
            if (output.value) {
              window.ItTools.download('output.json', output.value, 'application/json;charset=utf-8');
            }
          }
        })
      ),
      stats
    ));

    render();

    return { destroy: function () { off(); D.clear(root); } };
  });

  window.ItTools.logic['csv-to-json'] = {
    DEFAULTS: DEFAULTS,
    withDefaults: withDefaults,
    inferValue: inferValue,
    parseRows: parseRows,
    parseCsv: parseCsv,
    toJsonText: toJsonText,
    __cases: function (assert) {
      var base = { delimiter: ',', hasHeaders: true, inferTypes: true, trimFields: true, skipEmptyLines: false };
      var noHeader = { delimiter: ',', hasHeaders: false, inferTypes: true, trimFields: true, skipEmptyLines: false };

      // ---- 参考实现 vitest 用例（原样搬过来，期望值照抄上游）----

      // 带表头的简单表格
      var r = parseCsv('name,age\nAlice,30\nBob,25', base);
      assert.eq(r.headers, ['name', 'age'], '带表头：表头取第一行');
      assert.eq(r.records, [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }], '带表头：每行一个对象');

      // 无表头：列名自己生成
      r = parseCsv('Alice,30\nBob,25', noHeader);
      assert.eq(r.headers, ['column_1', 'column_2'], '无表头：列名是 column_1 / column_2');
      assert.eq(r.records, [
        { column_1: 'Alice', column_2: 30 },
        { column_1: 'Bob', column_2: 25 }
      ], '无表头：第一行也是数据');

      // 空输入
      assert.eq(parseCsv('', base), { headers: [], records: [] }, '空输入：没有表头也没有记录');

      // 引号里的分隔符
      r = parseCsv('name,quote\nSmith,"a, b"', base);
      assert.eq(r.records[0], { name: 'Smith', quote: 'a, b' }, '引号里的逗号是普通字符');

      // 转义过的双引号
      r = parseCsv('quote\n"He said ""hi"""', base);
      assert.eq(r.records[0].quote, 'He said "hi"', '引号里的 "" 还原成一个引号');

      // 引号里的换行
      r = parseCsv('name,text\nline1,"two\nlines"', base);
      assert.eq(r.records[0].text, 'two\nlines', '引号里的换行留在字段里');
      assert.eq(r.records.length, 1, '引号里的换行不算换行（仍是一条记录）');

      // CRLF
      r = parseCsv('a,b\r\n1,2\r\n', base);
      assert.eq(r.records, [{ a: 1, b: 2 }], 'CRLF 换行');

      // 末尾的换行不产生空记录
      r = parseCsv('a,b\n1,2\n\n', base);
      assert.eq(r.records.length, 1, '末尾空行被丢掉');

      // 自定义分隔符
      r = parseCsv('a;b\n1;2', { delimiter: ';', hasHeaders: true, inferTypes: true, trimFields: true, skipEmptyLines: false });
      assert.eq(r.records, [{ a: 1, b: 2 }], '分号做分隔符');

      // 关掉类型推断：全是字符串
      r = parseCsv('n,b,x\n42,true,null', { delimiter: ',', hasHeaders: true, inferTypes: false, trimFields: true, skipEmptyLines: false });
      assert.eq(r.records[0], { n: '42', b: 'true', x: 'null' }, '关掉类型推断：全是字符串');

      // 类型推断：数字 / 布尔 / null
      r = parseCsv('n,b,x,e\n42,true,null,', base);
      assert.eq(r.records[0], { n: 42, b: true, x: null, e: null }, '类型推断：数字、布尔、null、空串');

      // trim 只作用于没加引号的字段
      r = parseCsv('a,b\n  spaced , " kept  "', base);
      assert.eq(r.records[0], { a: 'spaced', b: ' kept  ' }, '引号外的字段被 trim，引号里的不动');

      // 缺的列补 null
      r = parseCsv('a,b,c\n1,2', base);
      assert.eq(r.records[0], { a: 1, b: 2, c: null }, '缺的列补 null');

      // ---- 自己补的边界 ----

      // 只有表头：没有记录
      r = parseCsv('a,b', base);
      assert.eq(r.headers, ['a', 'b'], '只有表头：表头还在');
      assert.eq(r.records, [], '只有表头：没有记录');

      // 表头里的空列名补成 column_N
      r = parseCsv('a,,c\n1,2,3', base);
      assert.eq(r.headers, ['a', 'column_2', 'c'], '空的表头名补成 column_2');
      assert.eq(r.records[0], { a: 1, column_2: 2, c: 3 }, '补出来的列名照样有值');

      // 中间的空行：默认变成一条各列都是 null 的记录
      r = parseCsv('a,b\n1,2\n\n3,4', base);
      assert.eq(r.records.length, 3, '默认不跳空行：空行也算一条记录');
      assert.eq(r.records[1], { a: null, b: null }, '空行那一条全是 null');

      // 打开「跳过空行」：中间的空行被丢掉
      r = parseCsv('a,b\n1,2\n\n3,4', { delimiter: ',', hasHeaders: true, inferTypes: true, trimFields: true, skipEmptyLines: true });
      assert.eq(r.records.length, 2, '打开跳过空行：空行没了');
      assert.eq(r.records[1], { a: 3, b: 4 }, '跳过空行后后面的记录还在');

      // 空行排在最前面：跳过空行之后表头才对得上
      r = parseCsv('\nname,age\nAlice,30', { delimiter: ',', hasHeaders: true, inferTypes: true, trimFields: true, skipEmptyLines: true });
      assert.eq(r.headers, ['name', 'age'], '跳过空行：开头的空行不算表头');

      // 引号字段里的 CRLF 也留着
      r = parseCsv('a\r\n"x\r\ny"', base);
      assert.eq(r.records[0].a, 'x\r\ny', '引号里的 CRLF 原样留着');

      // 转义过的引号出现在字段中间
      r = parseCsv('a\n"x""y"', base);
      assert.eq(r.records[0].a, 'x"y', '引号里的 "" 还原成一个引号');

      // 引号里只有一对双引号（空内容）
      r = parseCsv('a\n""""', base);
      assert.eq(r.records[0].a, '"', '四个引号还原成一个引号');

      // 超范围整数：不能被 JS 的 number 精度吃掉
      var big = parseCsv('id\n9223372036854775807', base);
      assert.eq(typeof big.records[0].id, 'string', '超范围整数在中间态里是哨兵字符串，不是 number');
      assert.eq(toJsonText(big), '[\n  {\n    "id": 9223372036854775807\n  }\n]', '超范围整数输出成一位不差的裸数字');
      assert.eq(toJsonText(parseCsv('id\n-9223372036854775807', base)),
        '[\n  {\n    "id": -9223372036854775807\n  }\n]', '负的超范围整数也一样');
      assert.eq(toJsonText(parseCsv('id\n9223372036854775807', { delimiter: ',', hasHeaders: true, inferTypes: false, trimFields: true, skipEmptyLines: false })),
        '[\n  {\n    "id": "9223372036854775807"\n  }\n]', '关掉类型推断：超范围整数留成字符串，数字一位不差');

      // 安全范围上下的整数照常转成 number
      assert.eq(parseCsv('n\n9007199254740991', base).records[0].n, 9007199254740991, '2^53-1 照常是数字');
      assert.eq(typeof parseCsv('n\n9007199254740993', base).records[0].n, 'string', '2^53+1 走哨兵');

      // 超范围的小数保留成字符串（转成数字一定会改数据）
      assert.eq(parseCsv('n\n9223372036854775807.5', base).records[0].n, '9223372036854775807.5', '超范围的小数原样留着');
      assert.eq(parseCsv('n\n1.5', base).records[0].n, 1.5, '普通小数照常是数字');

      // 类型推断的几个细节
      assert.eq(inferValue(''), null, '空串算 null');
      assert.eq(inferValue('TRUE'), 'TRUE', '只有小写的 true 才算布尔');
      assert.eq(inferValue('01'), 1, '前导零的数字照常转成数字');
      assert.eq(inferValue('1e3'), '1e3', '科学计数法不当数字（原版如此）');
      assert.eq(inferValue(' 42'), ' 42', '带空格的数字不当数字（原版如此）');

      // 多出来的列丢掉（原版行为）
      r = parseCsv('a,b\n1,2,3', base);
      assert.eq(r.records[0], { a: 1, b: 2 }, '多出来的列丢掉（原版行为）');

      // 只有空白：末尾的空行照旧被丢掉，什么都不剩
      assert.eq(parseCsv('   \n  ', base), { headers: [], records: [] }, '纯空白的输入没有记录');

      // JSON 文本：两格缩进
      assert.eq(toJsonText(parseCsv('a\n1', base)), '[\n  {\n    "a": 1\n  }\n]', '输出是两格缩进的 JSON');
    }
  };
})();
