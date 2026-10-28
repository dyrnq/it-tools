/* ==========================================================================
   JSON 转 Schema（json-to-schema）

   参考实现：/data/work/it-tools2/src/tools/json-to-schema/（sharevb/it-tools 的 fork）
   它用 generate-schema 一个包出六种格式：generic / json / mysql / mongoose /
   bigquery / clickhouse。

   与上游的差别：
   1. **不引 generate-schema**。它自己带一整套类型映射，每种格式一套；
      我们这边用 `ItTools.jsonInfer` 那棵类型树，每种格式写一小段渲染，
      判定规则（整数多宽、数组是什么、对象怎么嵌套）只有**一份**，
      不会出现「JSON Schema 说 int64、MySQL 说 VARCHAR」这种对不上的情况。
   2. **上游的 clickhouse 格式要求手工传一个日期字段名**
      （`GenerateSchema.clickhouse(tableName, object, 'theDateField')`）——
      那个字段名在界面上根本没法填，等于写死了一个叫 theDateField 的列。
      这里不猜：日期样式的字符串就是 DATETIME。
   3. **BigQuery 用的是真正的 schema 形状**（[{name, type, fields}]），
      不是「属性名 → 类型」的扁平映射 —— 扁平映射表达不了 RECORD 的嵌套字段。
   4. **MySQL 的列名用反引号包起来**。上游不加，列名里有空格或保留字就直接语法错。
   5. **JSON Schema 用 draft-07**（`definitions` + `$ref`），跟上游一致；
      上游没写 `$schema`，这里补上。

   ------------------------------------------------------------------------
   六种格式：
     generic    —— 人看的缩进树
     json       —— JSON Schema（draft-07）
     mysql      —— CREATE TABLE
     mongoose   —— mongoose 的 schema 对象
     bigquery   —— BigQuery 的 schema（数组形状）
     clickhouse —— CREATE TABLE（ClickHouse 语法）
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-to-schema');
  /** 与语言无关的 JSON 类型推断内核（app.js 里）—— 几个 JSON 转代码的工具共用。 */
  var J = window.ItTools.jsonInfer;

  /** 六种目标格式 */
  var FORMATS = ['generic', 'json', 'mysql', 'mongoose', 'bigquery', 'clickhouse'];

  /* ==================================================================
     推断
     ================================================================== */

  /**
   * 推类型。**属性名一律用原始的 JSON 键**：
   * Schema 里的属性名 / 列名都是原样的键名，动了就接不上原数据。
   */
  function infer(data, rootName) {
    return J.infer(data, {
      rootName: rootName || 'Root',
      pascalCase: false,
      sanitizeMember: function (raw) { return raw; },
      sanitizeType: function (n) { return J.sanitizeIdentifier(n); }
    });
  }

  /** 顶层是不是一个对象（决定 schema 怎么写） */
  function rootObject(doc) {
    if (doc.root.kind === 'object') return doc.root;
    if (doc.root.kind === 'array' && doc.root.element.kind === 'object') return doc.root.element;
    return null;
  }

  /* ==================================================================
     1. JSON Schema（draft-07）
     ================================================================== */

  /** 一个类型节点 → JSON Schema 片段 */
  function jsonSchemaOf(node) {
    if (node.kind === 'array') return { type: 'array', items: jsonSchemaOf(node.element) };
    if (node.kind === 'object') return { $ref: '#/definitions/' + node.name };
    switch (node.type) {
      case 'boolean': return { type: 'boolean' };
      case 'integer': return { type: 'integer' };
      case 'number': return { type: 'number' };
      case 'string': return { type: 'string' };
      case 'date': return { type: 'string' };
      case 'null': return { type: 'null' };
      default: return {};
    }
  }

  /** 一个对象节点的属性表 */
  function jsonSchemaProperties(node) {
    var props = {};
    for (var i = 0; i < node.members.length; i++) {
      props[node.members[i].key] = jsonSchemaOf(node.members[i].type);
    }
    return props;
  }

  function jsonSchema(doc, title) {
    var root = rootObject(doc);
    var schema = { '$schema': 'http://json-schema.org/draft-07/schema#', title: title };
    if (root) {
      schema.type = 'object';
      schema.properties = jsonSchemaProperties(root);
    } else if (doc.root.kind === 'array') {
      schema.type = 'array';
      schema.items = jsonSchemaOf(doc.root.element);
    } else {
      // 顶层就是个标量：没有「对象」可写，直接给那一条
      return jsonSchemaOf(doc.root);
    }

    var definitions = {};
    for (var i = 0; i < doc.defs.length; i++) {
      if (doc.defs[i] === root) continue;
      definitions[doc.defs[i].name] = {
        type: 'object',
        properties: jsonSchemaProperties(doc.defs[i])
      };
    }
    if (Object.keys(definitions).length) schema.definitions = definitions;
    return schema;
  }

  /* ==================================================================
     2. MySQL
     ================================================================== */

  function mysqlType(node) {
    if (node.kind === 'array') return 'JSON';
    if (node.kind === 'object') return 'JSON';
    switch (node.type) {
      case 'boolean': return 'BOOLEAN';
      case 'integer':
        if (node.width === 'int32') return 'INT';
        if (node.width === 'int64') return 'BIGINT';
        return 'DECIMAL(65,0)';
      case 'number': return 'DOUBLE';
      case 'string': return 'VARCHAR(255)';
      case 'date': return 'DATETIME';
      case 'null': return 'TEXT';
      default: return 'TEXT';
    }
  }

  function mysqlSchema(doc, tableName) {
    var root = rootObject(doc);
    var cols = [];
    if (root) {
      for (var i = 0; i < root.members.length; i++) {
        var m = root.members[i];
        cols.push('  `' + m.key + '` ' + mysqlType(m.type));
      }
    } else if (doc.root.kind === 'array') {
      cols.push('  `value` ' + mysqlType(doc.root));
    } else {
      cols.push('  `value` ' + mysqlType(doc.root));
    }
    return 'CREATE TABLE `' + tableName + '` (\n' + cols.join(',\n') + '\n);';
  }

  /* ==================================================================
     3. mongoose
     ================================================================== */

  function mongooseScalar(node) {
    switch (node.type) {
      case 'boolean': return 'Boolean';
      case 'integer':
      case 'number': return 'Number';
      case 'string': return 'String';
      case 'date': return 'Date';
      case 'null': return 'Mixed';
      default: return 'Mixed';
    }
  }

  /** 一个对象节点 → mongoose 的 schema 对象 */
  function mongooseSchemaOf(node) {
    var out = {};
    for (var i = 0; i < node.members.length; i++) {
      var m = node.members[i];
      out[m.key] = mongooseField(m.type);
    }
    return out;
  }

  function mongooseField(type) {
    if (type.kind === 'object') {
      return { type: mongooseSchemaOf(type) };
    }
    if (type.kind === 'array') {
      var el = type.element;
      if (el.kind === 'object') return [{ type: mongooseSchemaOf(el) }];
      return [{ type: mongooseScalar(el) }];
    }
    return { type: mongooseScalar(type), required: type.type !== 'null' };
  }

  function mongooseSchema(doc) {
    var root = rootObject(doc);
    if (!root) return {};
    return mongooseSchemaOf(root);
  }

  /* ==================================================================
     4. BigQuery
     ================================================================== */

  function bigqueryType(node) {
    if (node.kind === 'array') {
      return 'ARRAY<' + bigqueryType(node.element) + '>';
    }
    if (node.kind === 'object') return 'RECORD';
    switch (node.type) {
      case 'boolean': return 'BOOLEAN';
      case 'integer':
        if (node.width === 'bigint') return 'NUMERIC';
        return 'INTEGER';
      case 'number': return 'FLOAT';
      case 'string': return 'STRING';
      case 'date': return 'DATETIME';
      case 'null': return 'STRING';
      default: return 'STRING';
    }
  }

  /** 一个对象节点 → BigQuery 的字段表 */
  function bigqueryFields(node) {
    var out = [];
    for (var i = 0; i < node.members.length; i++) {
      var m = node.members[i];
      var field = { name: m.key, type: bigqueryType(m.type) };
      var inner = m.type;
      if (inner.kind === 'array') inner = inner.element;
      if (inner.kind === 'object') field.fields = bigqueryFields(inner);
      out.push(field);
    }
    return out;
  }

  function bigquerySchema(doc) {
    var root = rootObject(doc);
    if (root) return bigqueryFields(root);
    if (doc.root.kind === 'array') {
      return [{ name: 'items', type: bigqueryType(doc.root), repeated: true }];
    }
    return [{ name: 'value', type: bigqueryType(doc.root) }];
  }

  /* ==================================================================
     5. ClickHouse
     ================================================================== */

  function clickhouseType(node) {
    if (node.kind === 'array') return 'Array(' + clickhouseType(node.element) + ')';
    if (node.kind === 'object') return 'Nested';
    switch (node.type) {
      case 'boolean': return 'UInt8';
      case 'integer':
        if (node.width === 'int32') return 'Int32';
        if (node.width === 'int64') return 'Int64';
        return 'Decimal(38, 0)';
      case 'number': return 'Float64';
      case 'string': return 'String';
      case 'date': return 'DateTime';
      case 'null': return 'String';
      default: return 'String';
    }
  }

  /**
   * 一列的类型。
   *
   * 嵌套类型（Nested(...)）要跨行，所以类型被拆成三块：
   * 开头（跟着列名那一行的）、中间的若干行、结尾。
   * 拼的时候不用做字符串替换 —— 那是最容易算错缩进的地方。
   *
   * @param {object} node 类型节点
   * @param {string} pad 当前缩进
   * @returns {{head: string, tail: string, inner: Array<string>}}
   */
  function clickhouseTypeParts(node, pad) {
    if (node.kind === 'object') {
      var inner = [];
      for (var i = 0; i < node.members.length; i++) {
        var m = node.members[i];
        var sub = clickhouseTypeParts(m.type, pad + '  ');
        inner.push(pad + '  `' + m.key + '` ' + sub.head);
        for (var j = 0; j < sub.inner.length; j++) inner.push(sub.inner[j]);
        if (sub.tail) inner.push(pad + '  ' + sub.tail);
      }
      return { head: 'Nested(', tail: ')', inner: inner };
    }
    if (node.kind === 'array' && node.element.kind === 'object') {
      var inner2 = [];
      var e = node.element;
      for (var k = 0; k < e.members.length; k++) {
        var em = e.members[k];
        var q = clickhouseTypeParts(em.type, pad + '  ');
        inner2.push(pad + '  `' + em.key + '` ' + q.head);
        for (var r = 0; r < q.inner.length; r++) inner2.push(q.inner[r]);
        if (q.tail) inner2.push(pad + '  ' + q.tail);
      }
      return { head: 'Array(Nested(', tail: '))', inner: inner2 };
    }
    if (node.kind === 'array') {
      return { head: 'Array(' + clickhouseType(node.element) + ')', tail: '', inner: [] };
    }
    return { head: clickhouseType(node), tail: '', inner: [] };
  }

  function clickhouseSchema(doc, tableName) {
    var root = rootObject(doc);
    var blocks = [];
    if (root) {
      for (var i = 0; i < root.members.length; i++) {
        var m = root.members[i];
        var p = clickhouseTypeParts(m.type, '  ');
        var block = ['  `' + m.key + '` ' + p.head];
        for (var j = 0; j < p.inner.length; j++) block.push(p.inner[j]);
        if (p.tail) block.push('  ' + p.tail);
        blocks.push(block);
      }
    } else {
      blocks.push(['  `value` ' + clickhouseType(doc.root)]);
    }
    // 逗号是**列与列之间**的分隔，不是同一列的续行之间 ——
    // 嵌套类型要占好几行，逗号加错了位置就成了 `Nested(,`。
    var cols = blocks.map(function (b) { return b.join('\n'); }).join(',\n');
    return 'CREATE TABLE ' + tableName + ' (\n' + cols +
      '\n) ENGINE = MergeTree() ORDER BY tuple();';
  }

  /* ==================================================================
     6. generic（人看的缩进树）
     ================================================================== */

  function genericLabel(node) {
    if (node.kind === 'array') return 'array';
    if (node.kind === 'object') return 'object';
    switch (node.type) {
      case 'boolean': return 'boolean';
      case 'integer': return 'integer';
      case 'number': return 'number';
      case 'string': return 'string';
      case 'date': return 'date';
      case 'null': return 'null';
      default: return 'any';
    }
  }

  function genericTree(node, indent, lines) {
    lines = lines || [];
    var pad = new Array(indent + 1).join('  ');
    if (node.kind === 'object') {
      for (var i = 0; i < node.members.length; i++) {
        var m = node.members[i];
        lines.push(pad + m.key + ': ' + genericLabel(m.type));
        var inner = m.type;
        if (inner.kind === 'array') inner = inner.element;
        if (inner.kind === 'object') genericTree(inner, indent + 1, lines);
      }
      return lines;
    }
    if (node.kind === 'array') {
      lines.push(pad + 'element: ' + genericLabel(node.element));
      if (node.element.kind === 'object') genericTree(node.element, indent + 1, lines);
    }
    return lines;
  }

  function genericSchema(doc) {
    var root = rootObject(doc);
    if (root) return genericTree(root, 0).join('\n');
    if (doc.root.kind === 'array') return genericTree(doc.root, 0).join('\n');
    return genericLabel(doc.root);
  }

  /* ==================================================================
     入口
     ================================================================== */

  /**
   * JSON → Schema。
   *
   * @param {string} src JSON 文本
   * @param {object} [options]
   * @param {string} [options.format] 六种格式之一
   * @param {string} [options.tableName] 表名（json / mysql / clickhouse 用）
   * @returns {string}
   */
  function jsonToSchema(src, options) {
    options = options || {};
    var format = options.format || 'json';
    var tableName = (options.tableName === undefined || options.tableName === null)
      ? 'TableName'
      : String(options.tableName);

    var data = JSON.parse(src);
    var doc = infer(data, tableName);

    switch (format) {
      case 'generic': return genericSchema(doc);
      case 'mysql': return mysqlSchema(doc, tableName);
      case 'mongoose': return JSON.stringify(mongooseSchema(doc), null, 2);
      case 'bigquery': return JSON.stringify(bigquerySchema(doc), null, 2);
      case 'clickhouse': return clickhouseSchema(doc, tableName);
      case 'json':
      default:
        return JSON.stringify(jsonSchema(doc, tableName), null, 2);
    }
  }

  /* ==================================================================
     界面
     ================================================================== */

  window.ItTools.register('json-to-schema', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 14,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Put your JSON here...')
    });

    var output = D.h('textarea.layui-textarea', {
      rows: 18,
      readonly: 'readonly',
      spellcheck: 'false',
      style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }
    });

    var status = D.h('p.form-status');
    var tableInput = D.h('input.layui-input', { type: 'text', value: 'TableName' });

    var formatSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'generic', text: t('fmt_generic', 'Generic') }),
      D.h('option', { value: 'json', text: t('fmt_json', 'JSON Schema') }),
      D.h('option', { value: 'mysql', text: t('fmt_mysql', 'MySQL table schema') }),
      D.h('option', { value: 'mongoose', text: t('fmt_mongoose', 'Mongoose schema') }),
      D.h('option', { value: 'bigquery', text: t('fmt_bigquery', 'Google BigQuery schema') }),
      D.h('option', { value: 'clickhouse', text: t('fmt_clickhouse', 'ClickHouse table schema') })
    );
    formatSelect.value = 'json';

    function render() {
      var raw = input.value;
      if (!raw.trim()) {
        output.value = '';
        status.className = 'form-status';
        status.textContent = t('status_empty', 'Type or paste some JSON above.');
        return;
      }
      try {
        output.value = jsonToSchema(raw, {
          format: formatSelect.value,
          tableName: tableInput.value
        });
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
      D.on(tableInput, 'input', render),
      D.on(formatSelect, 'change', render)
    ];

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your JSON'), input, { wide: true }),
      U.field(t('format', 'Target schema format'), formatSelect),
      U.field(t('table_name', 'Table name'), tableInput),
      status,
      D.h('p.field-hint', {
        text: t('hint', 'Generates a schema from JSON. The same inferred types drive every format, so the JSON Schema, the SQL table and the BigQuery schema always agree on what a field is. Table name is used as the JSON Schema title and as the SQL table name.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('output', 'Your schema') }),
        U.copyButton(function () { return output.value; }, t('copy_schema', 'Copy schema'))
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

  window.ItTools.logic['json-to-schema'] = {
    jsonToSchema: jsonToSchema,
    jsonSchema: jsonSchema,
    mysqlSchema: mysqlSchema,
    mongooseSchema: mongooseSchema,
    bigquerySchema: bigquerySchema,
    clickhouseSchema: clickhouseSchema,
    clickhouseTypeParts: clickhouseTypeParts,
    genericSchema: genericSchema,
    mysqlType: mysqlType,
    bigqueryType: bigqueryType,
    clickhouseType: clickhouseType,
    genericLabel: genericLabel,
    __cases: function (assert) {
      var SAMPLE = '{"id":1,"name":"John","active":true,"tags":["a"],"nested":{"city":"Paris"}}';

      /* ---------- 类型名 ---------- */
      assert.eq(mysqlType({ kind: 'scalar', type: 'boolean' }), 'BOOLEAN', 'MySQL 布尔');
      assert.eq(mysqlType({ kind: 'scalar', type: 'integer', width: 'int32' }), 'INT', 'MySQL int32');
      assert.eq(mysqlType({ kind: 'scalar', type: 'integer', width: 'int64' }), 'BIGINT', 'MySQL int64');
      assert.eq(mysqlType({ kind: 'scalar', type: 'number' }), 'DOUBLE', 'MySQL 小数');
      assert.eq(mysqlType({ kind: 'scalar', type: 'string' }), 'VARCHAR(255)', 'MySQL 字符串');
      assert.eq(mysqlType({ kind: 'scalar', type: 'date' }), 'DATETIME', 'MySQL 日期');
      assert.eq(mysqlType({ kind: 'scalar', type: 'null' }), 'TEXT', 'MySQL null');
      assert.eq(mysqlType({ kind: 'array', element: { kind: 'scalar', type: 'string' } }), 'JSON', 'MySQL 数组');
      assert.eq(bigqueryType({ kind: 'scalar', type: 'integer', width: 'int32' }), 'INTEGER', 'BigQuery 整数');
      assert.eq(bigqueryType({ kind: 'scalar', type: 'number' }), 'FLOAT', 'BigQuery 小数');
      assert.eq(bigqueryType({ kind: 'array', element: { kind: 'scalar', type: 'string' } }), 'ARRAY<STRING>',
        'BigQuery 数组');
      assert.eq(clickhouseType({ kind: 'scalar', type: 'boolean' }), 'UInt8', 'ClickHouse 布尔');
      assert.eq(clickhouseType({ kind: 'scalar', type: 'integer', width: 'int32' }), 'Int32', 'ClickHouse int32');
      assert.eq(clickhouseType({ kind: 'array', element: { kind: 'scalar', type: 'string' } }), 'Array(String)',
        'ClickHouse 数组');
      assert.eq(genericLabel({ kind: 'scalar', type: 'integer', width: 'int32' }), 'integer', 'generic 整数');

      /* ---------- JSON Schema ---------- */
      var js = JSON.parse(jsonToSchema('{"a":1,"b":"x"}', { format: 'json', tableName: 'T' }));
      assert.eq(js['$schema'], 'http://json-schema.org/draft-07/schema#', 'draft-07');
      assert.eq(js.title, 'T', 'title 是表名');
      assert.eq(js.type, 'object', '顶层是对象');
      assert.eq(js.properties.a.type, 'integer', '整数');
      assert.eq(js.properties.b.type, 'string', '字符串');

      var js2 = JSON.parse(jsonToSchema('{"n":{"c":1}}', { format: 'json', tableName: 'T' }));
      assert.eq(js2.properties.n['$ref'], '#/definitions/N', '嵌套对象 → $ref');
      assert.eq(js2.definitions.N.type, 'object', 'definitions 里有嵌套类型');
      assert.eq(js2.definitions.N.properties.c.type, 'integer', '嵌套类型的字段');

      var js3 = JSON.parse(jsonToSchema('{"t":["a"]}', { format: 'json', tableName: 'T' }));
      assert.eq(js3.properties.t.type, 'array', '数组');
      assert.eq(js3.properties.t.items.type, 'string', '数组的元素类型');

      /* ---------- MySQL ---------- */
      assert.eq(jsonToSchema('{"id":1,"name":"John"}', { format: 'mysql', tableName: 'users' }),
        'CREATE TABLE `users` (\n  `id` INT,\n  `name` VARCHAR(255)\n);', 'MySQL 建表');
      assert.eq(jsonToSchema('{"a":{"b":1}}', { format: 'mysql', tableName: 't' }),
        'CREATE TABLE `t` (\n  `a` JSON\n);', 'MySQL 嵌套对象 → JSON 列');

      /* ---------- mongoose ---------- */
      var ms = JSON.parse(jsonToSchema('{"name":"John","tags":["a"],"n":{"c":1}}',
        { format: 'mongoose' }));
      assert.eq(ms.name.type, 'String', 'mongoose 字符串');
      assert.eq(ms.name.required, true, 'mongoose required');
      assert.eq(ms.tags[0].type, 'String', 'mongoose 数组');
      assert.eq(ms.n.type.c.type, 'Number', 'mongoose 嵌套对象');

      /* ---------- BigQuery ---------- */
      var bq = JSON.parse(jsonToSchema('{"id":1,"n":{"c":1}}', { format: 'bigquery' }));
      assert.eq(bq[0].name, 'id', 'BigQuery 字段名');
      assert.eq(bq[0].type, 'INTEGER', 'BigQuery 字段类型');
      assert.eq(bq[1].type, 'RECORD', 'BigQuery 嵌套 → RECORD');
      assert.eq(bq[1].fields[0].name, 'c', 'RECORD 的子字段');

      /* ---------- ClickHouse ---------- */
      assert.eq(jsonToSchema('{"id":1,"name":"John"}', { format: 'clickhouse', tableName: 'users' }),
        'CREATE TABLE users (\n  `id` Int32,\n  `name` String\n) ENGINE = MergeTree() ORDER BY tuple();',
        'ClickHouse 建表');
      assert.eq(jsonToSchema('{"a":{"b":1}}', { format: 'clickhouse', tableName: 't' }),
        'CREATE TABLE t (\n  `a` Nested(\n    `b` Int32\n  )\n) ENGINE = MergeTree() ORDER BY tuple();',
        'ClickHouse 嵌套类型');
      assert.eq(jsonToSchema('{"a":[{"b":1}]}', { format: 'clickhouse', tableName: 't' }),
        'CREATE TABLE t (\n  `a` Array(Nested(\n    `b` Int32\n  ))\n) ENGINE = MergeTree() ORDER BY tuple();',
        'ClickHouse 数组套对象');

      /* ---------- generic ---------- */
      assert.eq(jsonToSchema('{"a":1,"n":{"c":"x"}}', { format: 'generic' }),
        'a: integer\nn: object\n  c: string', 'generic 缩进树');
    }
  };
})();
