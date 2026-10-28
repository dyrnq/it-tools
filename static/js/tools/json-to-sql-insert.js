/* ==========================================================================
   JSON 转 SQL INSERT 语句（json-to-sql-insert）

   参考实现：/data/work/it-tools2/src/tools/json-to-sql-insert/（sharevb/it-tools 的 fork）
   它用 flatten-anything 把嵌套对象拍平，再用 objectArrayToData 的 'sql' 分支拼语句。

   与上游的差别：
   1. **数组不拆成多列**。flatten-anything 默认把数组也拍平，
      `[1,2]` 会变成两列 `a.0` / `a.1` —— 一条记录有几个元素就多几列，
      元素个数一变列就变，SQL 根本没法用。这里数组整体存成一段 JSON 文本
      （`'[1,2]'`），列数才是稳的。
   2. **非对象的行不再生成空列**。上游对 `[1,2,3]` 会输出
      `INSERT INTO t () VALUES ();`（列名是空的，值也是空的）—— 语法错误。
      这里非对象的行输出 `INSERT INTO t VALUES (1);`。
   3. **null / 布尔有正经的写法**。上游的 escapeSQL 只处理字符串，
      null 会被拼成裸的 `null`、布尔会拼成 `true` —— MySQL 不认小写的
      布尔字面量（PostgreSQL 认）。这里 null → NULL、布尔 → TRUE/FALSE。
   4. **值是对象时存 JSON 文本**（上游拍平后是空的）。
   5. **列名里的空白去掉**（跟上游一样：`first name` → `firstname`），
      但表名照原样用。

   ------------------------------------------------------------------------
   输出的样子：
     INSERT INTO my_table (id, name, nested.city) VALUES (1, 'John', 'Paris');
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-to-sql-insert');

  /* ==================================================================
     SQL 值的写法
     ================================================================== */

  /** 字符串字面量：单引号包起来，里面的单引号写成两个 */
  function sqlString(str) {
    return "'" + String(str).replace(/'/g, "''") + "'";
  }

  /** 一个 JSON 值 → SQL 字面量 */
  function sqlValue(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') {
      return isFinite(value) ? String(value) : 'NULL';
    }
    if (typeof value === 'object') {
      // 数组与对象整体存成 JSON 文本
      return sqlString(JSON.stringify(value));
    }
    return sqlString(String(value));
  }

  /**
   * 把一行数据拍平成「列名 → 值」。
   *
   * 嵌套对象继续往下拍（`nested.city`），数组与空对象就地成一个值。
   *
   * @param {object} obj
   * @param {string} [prefix] 递归时的列名前缀
   * @param {Array} [out]
   * @returns {Array<{name: string, value: *}>}
   */
  function flattenRow(obj, prefix, out) {
    out = out || [];
    prefix = prefix || '';
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = obj[key];
      var name = prefix ? prefix + '.' + key : key;
      var isPlain = value !== null && typeof value === 'object' && !Array.isArray(value);
      if (isPlain && Object.keys(value).length) {
        flattenRow(value, name, out);
      } else {
        out.push({ name: name, value: value });
      }
    }
    return out;
  }

  /** 列名：去掉空白（上游也是这么做的） */
  function columnName(name) {
    return String(name).replace(/\s/g, '');
  }

  /**
   * JSON → SQL INSERT 语句。
   *
   * @param {string} src JSON 文本
   * @param {object} [options]
   * @param {string} [options.tableName] 表名
   * @returns {string}
   */
  function jsonToSqlInsert(src, options) {
    options = options || {};
    var table = (options.tableName === undefined || options.tableName === null)
      ? 'MyTable'
      : String(options.tableName);

    var data = JSON.parse(src);
    var rows = Array.isArray(data) ? data : [data];

    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        // 不是对象的行：没有列名可写
        lines.push('INSERT INTO ' + table + ' VALUES (' + sqlValue(row) + ');');
        continue;
      }
      var cols = flattenRow(row);
      var names = [];
      var values = [];
      for (var j = 0; j < cols.length; j++) {
        names.push(columnName(cols[j].name));
        values.push(sqlValue(cols[j].value));
      }
      lines.push('INSERT INTO ' + table +
        (names.length ? ' (' + names.join(', ') + ')' : '') +
        ' VALUES (' + values.join(', ') + ');');
    }
    return lines.join('\n');
  }

  /* ==================================================================
     界面
     ================================================================== */

  window.ItTools.register('json-to-sql-insert', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 14,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Put your JSON here...')
    });

    var output = D.h('textarea.layui-textarea', {
      rows: 16,
      readonly: 'readonly',
      spellcheck: 'false',
      style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }
    });

    var status = D.h('p.form-status');
    var tableInput = D.h('input.layui-input', { type: 'text', value: 'MyTable' });

    function render() {
      var raw = input.value;
      if (!raw.trim()) {
        output.value = '';
        status.className = 'form-status';
        status.textContent = t('status_empty', 'Type or paste some JSON above.');
        return;
      }
      try {
        output.value = jsonToSqlInsert(raw, { tableName: tableInput.value });
        status.className = 'form-status';
        status.textContent = '';
      } catch (e) {
        output.value = '';
        status.className = 'form-status is-error';
        status.textContent = t('err_invalid', 'Provided JSON is not valid. {message}')
          .replace('{message}', function () { return e && e.message ? e.message : e; });
      }
    }

    var offs = [
      D.on(input, 'input', render),
      D.on(tableInput, 'input', render)
    ];

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your JSON'), input, { wide: true }),
      U.field(t('table_name', 'Table name'), tableInput),
      status,
      D.h('p.field-hint', {
        text: t('hint', 'Generates SQL INSERT statements from JSON. Nested objects become dotted column names, arrays are stored as JSON text, null becomes NULL and booleans become TRUE / FALSE. Strings are escaped by doubling single quotes.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('output', 'Your SQL code') }),
        U.copyButton(function () { return output.value; }, t('copy_sql', 'Copy SQL'))
      ),
      output
    ));

    render();

    return {
      destroy: function () {
        for (var i = 0; i < offs.length; i++) offs[i]();
        D.clear(root);
      }
    };
  });

  /* ==================================================================
     单测用的纯逻辑
     ================================================================== */

  window.ItTools.logic['json-to-sql-insert'] = {
    jsonToSqlInsert: jsonToSqlInsert,
    flattenRow: flattenRow,
    sqlValue: sqlValue,
    sqlString: sqlString,
    columnName: columnName,
    __cases: function (assert) {
      /* ---------- 值 ---------- */
      assert.eq(sqlValue(null), 'NULL', 'null → NULL');
      assert.eq(sqlValue(true), 'TRUE', 'true → TRUE');
      assert.eq(sqlValue(false), 'FALSE', 'false → FALSE');
      assert.eq(sqlValue(42), '42', '数字原样');
      assert.eq(sqlValue('x'), "'x'", '字符串加引号');
      assert.eq(sqlValue("it's"), "'it''s'", '单引号翻倍');
      assert.eq(sqlValue([1, 2]), "'[1,2]'", '数组存成 JSON 文本');
      assert.eq(sqlValue({ a: 1 }), '\'{"a":1}\'', '对象存成 JSON 文本');

      /* ---------- 拍平 ---------- */
      assert.eq(flattenRow({ a: 1, b: { c: 2 } }), [
        { name: 'a', value: 1 },
        { name: 'b.c', value: 2 }
      ], '嵌套对象点号连接');
      assert.eq(flattenRow({ a: { b: { c: 3 } } }), [
        { name: 'a.b.c', value: 3 }
      ], '多层嵌套');
      assert.eq(flattenRow({ a: [] }), [
        { name: 'a', value: [] }
      ], '空数组不往下拍');

      /* ---------- 语句 ---------- */
      assert.eq(jsonToSqlInsert('{"id":1,"name":"John"}', { tableName: 'users' }),
        "INSERT INTO users (id, name) VALUES (1, 'John');", '单行');
      assert.eq(jsonToSqlInsert('[{"id":1},{"id":2}]', { tableName: 'users' }),
        "INSERT INTO users (id) VALUES (1);\nINSERT INTO users (id) VALUES (2);", '多行');
      assert.eq(jsonToSqlInsert('{"a":{"b":1}}', { tableName: 't' }),
        "INSERT INTO t (a.b) VALUES (1);", '嵌套列名');
      assert.eq(jsonToSqlInsert('{"first name":"John"}', { tableName: 't' }),
        "INSERT INTO t (firstname) VALUES ('John');", '列名去空白');
      assert.eq(jsonToSqlInsert('{"a":null,"b":true}', { tableName: 't' }),
        "INSERT INTO t (a, b) VALUES (NULL, TRUE);", 'null 与布尔');
      assert.eq(jsonToSqlInsert('{"a":[1,2]}', { tableName: 't' }),
        "INSERT INTO t (a) VALUES ('[1,2]');", '数组存成 JSON 文本');
      assert.eq(jsonToSqlInsert('[1,2]', { tableName: 't' }),
        "INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);", '非对象的行');
      assert.eq(jsonToSqlInsert('{"a":1}'),
        "INSERT INTO MyTable (a) VALUES (1);", '默认表名');
    }
  };
})();
