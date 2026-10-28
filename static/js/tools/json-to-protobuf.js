/* ==========================================================================
   JSON 转 Protobuf 定义（json-to-protobuf）

   参考实现：/data/work/it-tools2/src/tools/json-to-protobuf/（sharevb/it-tools 的 fork）
   它的路子是「先生成 JSON Schema（generate-schema），再把 Schema 转成 protobuf
   （jsonschema-protobuf）」—— 中间绕了一圈，Schema 里表达不了的信息
   （比如 int32 还是 int64）到那一步已经丢了。

   与上游的差别：
   1. **直接推 protobuf，不再绕 JSON Schema**。数值宽度（int32 / int64）、
      数组的 repeated、嵌套 message 都是从 `ItTools.jsonInfer` 那棵类型树直接来的，
      不用猜。
   2. **不引新库**。generate-schema + jsonschema-protobuf 两个包都不用。
   3. **嵌套 message 写在父 message 里面**（protoc 生成的代码就是这个形状），
      字段类型直接写子 message 的名字。
   4. **超大的整数用 string**。proto3 没有任意精度整数（只有 int64/uint64），
      JSON 的双精度到 2^53 就到头了 —— 再大的数写 int64 已经是错的，
      这里老老实实写 string。
   5. **null 字段用 string**。proto3 没有 null 类型（除非上 google.protobuf.Value，
      那样就得引 import）。这里用 string，并在注释里写清楚。

   ------------------------------------------------------------------------
   输出的样子：
     syntax = "proto3";

     message Root {
       string a = 1;
       int32 age = 2;
       repeated string tags = 3;
       Nested nested = 4;

       message Nested {
         string city = 1;
       }
     }
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-to-protobuf');
  /** 与语言无关的 JSON 类型推断内核（app.js 里）—— 几个 JSON 转代码的工具共用。 */
  var J = window.ItTools.jsonInfer;

  /* ==================================================================
     类型名
     ================================================================== */

  /** 中立的类型节点 → protobuf 的类型写法 */
  function protoTypeName(node) {
    if (node.kind === 'array') return protoTypeName(node.element);
    if (node.kind === 'object') return node.name;
    switch (node.type) {
      case 'boolean': return 'bool';
      case 'integer':
        if (node.width === 'int32') return 'int32';
        if (node.width === 'int64') return 'int64';
        return 'string';                   // proto3 没有任意精度整数
      case 'number': return 'double';
      case 'string': return 'string';
      case 'date': return 'string';
      case 'null': return 'string';        // proto3 没有 null 类型
      default: return 'string';
    }
  }

  /* ==================================================================
     渲染
     ================================================================== */

  /**
   * 一个对象类型 → 一个 message（连同它里面的嵌套 message）。
   *
   * @param {object} node 类型树里的对象节点
   * @param {object} childrenByName 名字 → 子节点（由 buildChildren 算出来）
   * @param {number} indent 缩进层数
   * @returns {string}
   */
  function renderMessage(node, childrenByName, indent) {
    var pad = new Array(indent + 1).join('  ');
    var lines = [];
    lines.push(pad + 'message ' + node.name + ' {');

    for (var i = 0; i < node.members.length; i++) {
      var m = node.members[i];
      var type = m.type;
      var repeated = false;
      if (type.kind === 'array') {
        repeated = true;
        type = type.element;
      }
      var name = J.sanitizeIdentifier(m.name);
      if (!/^[A-Za-z_]/.test(name)) name = '_' + name;
      lines.push(pad + '  ' + (repeated ? 'repeated ' : '') +
        protoTypeName(type) + ' ' + name + ' = ' + (i + 1) + ';');
    }

    // 嵌套 message：先收一收子节点，等字段写完再写
    var kids = [];
    for (var j = 0; j < node.members.length; j++) {
      var mt = node.members[j].type;
      if (mt.kind === 'object') {
        kids.push(mt);
      } else if (mt.kind === 'array' && mt.element.kind === 'object') {
        kids.push(mt.element);
      }
    }
    for (var k = 0; k < kids.length; k++) {
      var child = kids[k];
      // 只在「真正的父 message 里面」写这个子 message：
      // childrenByName 记的是「子 → 父」。
      if (childrenByName[child.name] === node) {
        lines.push('');
        lines.push(renderMessage(child, childrenByName, indent + 1));
      }
    }

    lines.push(pad + '}');
    return lines.join('\n');
  }

  /**
   * 找出每个对象节点的孩子（它在谁里面）。
   *
   * 类型树是**平铺**的（defs 是一张表），但 protobuf 的 message 是嵌套的，
   * 所以得把「谁引用了谁」倒过来。
   *
   * @param {Array} defs
   * @returns {object} 子类型名 → 父节点
   */
  function buildChildren(defs) {
    var childrenByName = Object.create(null);
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      for (var j = 0; j < d.members.length; j++) {
        var mt = d.members[j].type;
        if (mt.kind === 'object') {
          childrenByName[mt.name] = d;
        } else if (mt.kind === 'array' && mt.element.kind === 'object') {
          childrenByName[mt.element.name] = d;
        }
      }
    }
    return childrenByName;
  }

  /**
   * JSON → Protobuf 定义。
   *
   * @param {string} src JSON 文本
   * @param {object} [options]
   * @param {string} [options.rootName] 根 message 名
   * @param {string} [options.packageName] package 名（可空）
   * @returns {string}
   */
  function jsonToProtobuf(src, options) {
    options = options || {};
    var rootName = J.sanitizeIdentifier(
      J.toPascalCase(options.rootName || 'RootName')
    );
    if (rootName === '_') rootName = 'RootName';

    var data = JSON.parse(src);
    var doc = J.infer(data, {
      rootName: rootName,
      pascalCase: false,
      sanitizeMember: function (raw) { return J.sanitizeIdentifier(raw); },
      sanitizeType: function (n) { return J.sanitizeIdentifier(n); }
    });

    var out = ['syntax = "proto3";'];

    var pkg = options.packageName === undefined || options.packageName === null
      ? ''
      : String(options.packageName).trim();
    if (pkg) out.push('', 'package ' + pkg + ';');

    if (doc.root.kind === 'object') {
      var childrenByName = buildChildren(doc.defs);
      out.push('', renderMessage(doc.root, childrenByName, 0));
    } else if (doc.root.kind === 'array') {
      var el = doc.root.element;
      if (el.kind === 'object') {
        var byName = buildChildren(doc.defs);
        out.push('', renderMessage(el, byName, 0));
      } else {
        out.push('', 'message ' + rootName + ' {',
          '  repeated ' + protoTypeName(el) + ' items = 1;',
          '}');
      }
    } else {
      out.push('', 'message ' + rootName + ' {',
        '  ' + protoTypeName(doc.root) + ' value = 1;',
        '}');
    }

    return out.join('\n') + '\n';
  }

  /* ==================================================================
     界面
     ================================================================== */

  window.ItTools.register('json-to-protobuf', function (root) {
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
    var rootNameInput = D.h('input.layui-input', { type: 'text', value: 'RootName' });
    var packageInput = D.h('input.layui-input', { type: 'text', value: '' });

    function render() {
      var raw = input.value;
      if (!raw.trim()) {
        output.value = '';
        status.className = 'form-status';
        status.textContent = t('status_empty', 'Type or paste some JSON above.');
        return;
      }
      try {
        output.value = jsonToProtobuf(raw, {
          rootName: rootNameInput.value,
          packageName: packageInput.value
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
      D.on(rootNameInput, 'input', render),
      D.on(packageInput, 'input', render)
    ];

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your JSON'), input, { wide: true }),
      U.field(t('root_name', 'Root message name'), rootNameInput),
      U.field(t('package_name', 'Package name (optional)'), packageInput),
      status,
      D.h('p.field-hint', {
        text: t('hint', 'Generates a protobuf3 message definition from JSON. Booleans become bool, whole numbers int32 or int64, decimals double, and strings stay string. Arrays become repeated fields and nested objects become nested messages.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('output', 'Your protobuf definition') }),
        U.copyButton(function () { return output.value; }, t('copy_proto', 'Copy protobuf'))
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

  window.ItTools.logic['json-to-protobuf'] = {
    jsonToProtobuf: jsonToProtobuf,
    protoTypeName: protoTypeName,
    renderMessage: renderMessage,
    buildChildren: buildChildren,
    __cases: function (assert) {
      /* ---------- 类型名 ---------- */
      assert.eq(protoTypeName({ kind: 'scalar', type: 'boolean' }), 'bool', '布尔 → bool');
      assert.eq(protoTypeName({ kind: 'scalar', type: 'integer', width: 'int32' }), 'int32', 'int32');
      assert.eq(protoTypeName({ kind: 'scalar', type: 'integer', width: 'int64' }), 'int64', 'int64');
      assert.eq(protoTypeName({ kind: 'scalar', type: 'integer', width: 'bigint' }), 'string',
        '超大整数 → string');
      assert.eq(protoTypeName({ kind: 'scalar', type: 'number' }), 'double', '小数 → double');
      assert.eq(protoTypeName({ kind: 'scalar', type: 'string' }), 'string', '字符串');
      assert.eq(protoTypeName({ kind: 'scalar', type: 'null' }), 'string', 'null → string');

      /* ---------- 基本形状 ---------- */
      assert.eq(jsonToProtobuf('{"name":"John","age":30,"active":true}'),
        'syntax = "proto3";\n\nmessage RootName {\n  string name = 1;\n  int32 age = 2;\n  bool active = 3;\n}\n',
        '字符串 / 整数 / 布尔');
      assert.eq(jsonToProtobuf('{"a":1}'),
        'syntax = "proto3";\n\nmessage RootName {\n  int32 a = 1;\n}\n', '默认根 message 名');
      assert.eq(jsonToProtobuf('{"a":1}', { rootName: 'User' }),
        'syntax = "proto3";\n\nmessage User {\n  int32 a = 1;\n}\n', '自定义根 message 名');
      assert.eq(jsonToProtobuf('{"a":1}', { packageName: 'demo.v1' }),
        'syntax = "proto3";\n\npackage demo.v1;\n\nmessage RootName {\n  int32 a = 1;\n}\n',
        'package');

      /* ---------- 数组与嵌套 ---------- */
      assert.eq(jsonToProtobuf('{"tags":["a"]}'),
        'syntax = "proto3";\n\nmessage RootName {\n  repeated string tags = 1;\n}\n', '数组 → repeated');
      assert.eq(jsonToProtobuf('{"nested":{"city":"Paris"}}'),
        'syntax = "proto3";\n\nmessage RootName {\n  Nested nested = 1;\n\n  message Nested {\n    string city = 1;\n  }\n}\n',
        '嵌套对象 → 嵌套 message');

      /* ---------- 顶层不是对象 ---------- */
      assert.eq(jsonToProtobuf('[1,2]'),
        'syntax = "proto3";\n\nmessage RootName {\n  repeated int32 items = 1;\n}\n',
        '顶层数组');
      assert.eq(jsonToProtobuf('"x"'),
        'syntax = "proto3";\n\nmessage RootName {\n  string value = 1;\n}\n', '顶层标量');
    }
  };
})();
