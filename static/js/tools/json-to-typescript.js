/* ==========================================================================
   JSON 转 TypeScript 类型（json-to-typescript）

   参考实现：/data/work/it-tools2/src/tools/json-to-typescript/（sharevb/it-tools 的 fork）
   它用的是 quicktype-core —— 一个能做「联合类型 / 枚举 / 交叉类型」的完整推断器。

   与上游的差别（本仓库自己写的，没引 quicktype）：
   1. **不引 quicktype-core**。quicktype-core 是个大包（带 wasm/依赖树），
      而我们这边没有打包器，只能整包 UMD 引进 static/lib —— 代价与收益不成比例。
      这里改用 `ItTools.jsonInfer`（app.js 里那棵与语言无关的类型树）自己渲染。
   2. **没有联合类型与枚举**。quicktype 扫**整个**样本，能发现
      「同一个字段在数组的不同元素里是 string 又是 number」，于是给出
      `string | number`；还会把取值有限的对象字段变成枚举。
      我们的推断只看**第一个**数组元素（见 app.js 的注释：元素类型不一致时
      没有公共类型可取），所以没有联合类型、没有枚举。
      —— 这是一个真实的功能差距，不是等价实现，取舍写在这里。
   3. **日期不单独成类型**。TS 没有 Date 类型，长得像 ISO-8601 的字符串
      仍然映射成 string（quicktype 也一样）。
   4. **null → any**。proto3 那边我们用 string，这里用 any：TS 里 null
      本身是可赋值的类型，`any` 比 `string` 少骗人一点。

   ------------------------------------------------------------------------
   输出形状：
     export interface Root {
       a: string;
       arr: number[];
       nested: Nested;
     }
   顶层是数组时给的是 `export type Root = RootItem[];`（数组没法写成 interface）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-to-typescript');
  /** 与语言无关的 JSON 类型推断内核（app.js 里）—— 几个 JSON 转代码的工具共用。 */
  var J = window.ItTools.jsonInfer;

  /** TS 里不能拿来当属性名的（interface 的成员叫 constructor 会编译不过） */
  var RESERVED_MEMBER = { constructor: true, prototype: true };

  /* ==================================================================
     名字
     ================================================================== */

  /**
   * 属性名：先洗成合法标识符，再按需要转驼峰。
   * @param {string} raw 原始的 JSON 键
   * @param {boolean} camel 是否转驼峰
   */
  function memberName(raw, camel) {
    var s = camel ? J.toCamelCase(raw) : String(raw);
    s = J.sanitizeIdentifier(s);
    if (RESERVED_MEMBER[s]) s = '_' + s;
    return s;
  }

  /* ==================================================================
     类型名
     ================================================================== */

  /** 中立的类型节点 → TypeScript 的类型写法 */
  function tsTypeName(node) {
    if (node.kind === 'array') return tsTypeName(node.element) + '[]';
    if (node.kind === 'object') return node.name;
    switch (node.type) {
      case 'boolean': return 'boolean';
      case 'integer':
      case 'number': return 'number';
      case 'string': return 'string';
      case 'date': return 'string';
      case 'null': return 'any';
      default: return 'any';
    }
  }

  /* ==================================================================
     渲染
     ================================================================== */

  /**
   * 一个对象类型 → interface 或 type 别名。
   *
   * `export type X = { … }` 与 `export interface X { … }` 是两种写法，
   * 差别在于前者可以被再次交叉（`type A = B & { … }`），后者不能。
   * 开关就是给想要交叉的人用的。
   */
  function renderObjectDef(node, opts) {
    var body = [];
    for (var i = 0; i < node.members.length; i++) {
      var m = node.members[i];
      body.push('  ' + (opts.readonly ? 'readonly ' : '') + m.name +
        (opts.optional ? '?' : '') + ': ' + tsTypeName(m.type) + ';');
    }
    var inner = body.length ? '\n' + body.join('\n') + '\n' : '';
    if (opts.useType) return 'export type ' + node.name + ' = {' + inner + '};';
    return 'export interface ' + node.name + ' {' + inner + '}';
  }

  /**
   * JSON → TypeScript 类型定义。
   *
   * @param {string} src JSON 文本
   * @param {object} [options]
   * @param {string} [options.rootName] 顶层类型名
   * @param {boolean} [options.useType] 用 type 别名而不是 interface
   * @param {boolean} [options.camelCase] 属性名转驼峰
   * @param {boolean} [options.optional] 所有属性可选
   * @param {boolean} [options.readonly] 成员 readonly
   * @returns {string}
   */
  function jsonToTypescript(src, options) {
    options = options || {};
    var opts = {
      rootName: options.rootName || 'Root',
      useType: !!options.useType,
      camelCase: !!options.camelCase,
      optional: !!options.optional,
      readonly: !!options.readonly
    };

    var data = JSON.parse(src);
    var doc = J.infer(data, {
      rootName: opts.rootName,
      // 属性名走 memberName 自己处理（驼峰与否是这一侧的事），
      // 所以核心那边不要替我们先转一遍 PascalCase。
      pascalCase: false,
      sanitizeMember: function (raw) { return memberName(raw, opts.camelCase); },
      sanitizeType: function (n) { return J.sanitizeIdentifier(n); }
    });

    var out = [];

    if (doc.root.kind === 'object') {
      // 根就是对象 → 它是根类型，其余定义跟在后面
      out.push(renderObjectDef(doc.root, opts));
      for (var i = 1; i < doc.defs.length; i++) {
        out.push(renderObjectDef(doc.defs[i], opts));
      }
    } else if (doc.root.kind === 'array') {
      var el = doc.root.element;
      if (el.kind === 'object') {
        // 顶层数组的元素是个对象 → 它自己成为一个 interface，
        // 名字用「根名 + Item」，跟根类型名 Root 区分开。
        el.name = doc.newTypeName(opts.rootName + 'Item');
        out.push('export type ' + opts.rootName + ' = ' + el.name + '[];');
        out.push(renderObjectDef(el, opts));
        for (var j = 0; j < doc.defs.length; j++) {
          if (doc.defs[j] !== el) out.push(renderObjectDef(doc.defs[j], opts));
        }
      } else {
        out.push('export type ' + opts.rootName + ' = ' + tsTypeName(el) + '[];');
      }
    } else {
      out.push('export type ' + opts.rootName + ' = ' + tsTypeName(doc.root) + ';');
    }

    return out.join('\n\n');
  }

  /* ==================================================================
     界面
     ================================================================== */

  window.ItTools.register('json-to-typescript', function (root) {
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
    var rootNameInput = D.h('input.layui-input', { type: 'text', value: 'Root' });

    var declSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'interface', text: t('decl_interface', 'interface') }),
      D.h('option', { value: 'type', text: t('decl_type', 'type') })
    );

    var camelInput = D.h('input', { type: 'checkbox' });
    var optionalInput = D.h('input', { type: 'checkbox' });
    var readonlyInput = D.h('input', { type: 'checkbox' });

    function render() {
      var raw = input.value;
      if (!raw.trim()) {
        output.value = '';
        status.className = 'form-status';
        status.textContent = t('status_empty', 'Type or paste some JSON above.');
        return;
      }
      try {
        output.value = jsonToTypescript(raw, {
          rootName: rootNameInput.value,
          useType: declSelect.value === 'type',
          camelCase: camelInput.checked,
          optional: optionalInput.checked,
          readonly: readonlyInput.checked
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
      D.on(declSelect, 'change', render),
      D.on(camelInput, 'change', render),
      D.on(optionalInput, 'change', render),
      D.on(readonlyInput, 'change', render)
    ];

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your JSON'), input, { wide: true }),
      U.field(t('root_name', 'Root type name'), rootNameInput),
      U.field(t('decl_kind', 'Declaration'), declSelect),
      D.h('div.switch-grid', null,
        D.h('label.switch', null, camelInput, D.h('span', { text: t('camel_case', 'camelCase property names') })),
        D.h('label.switch', null, optionalInput, D.h('span', { text: t('optional_props', 'Make all properties optional') })),
        D.h('label.switch', null, readonlyInput, D.h('span', { text: t('readonly_members', 'Readonly members') }))
      ),
      status,
      D.h('p.field-hint', {
        text: t('hint', 'Generates TypeScript types from JSON. Booleans become boolean, numbers become number, and strings that look like ISO-8601 dates stay string. Objects become their own interface and arrays become T[]. A top-level array is exported as a type alias over the element type.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('output', 'Your TypeScript code') }),
        U.copyButton(function () { return output.value; }, t('copy_ts', 'Copy TypeScript'))
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

  window.ItTools.logic['json-to-typescript'] = {
    jsonToTypescript: jsonToTypescript,
    memberName: memberName,
    tsTypeName: tsTypeName,
    renderObjectDef: renderObjectDef,
    __cases: function (assert) {
      /* ---------- 名字 ---------- */
      assert.eq(memberName('user_name', true), 'userName', '驼峰');
      assert.eq(memberName('user_name', false), 'user_name', '不转驼峰');
      assert.eq(memberName('a-b', false), 'a_b', '非法字符换成 _');
      assert.eq(memberName('constructor', false), '_constructor', 'constructor 撞名');
      assert.eq(memberName('2fa', true), '_2Fa', '数字开头补 _');

      /* ---------- 基本形状 ---------- */
      assert.eq(jsonToTypescript('{"name":"John","age":30,"active":true}'),
        'export interface Root {\n  name: string;\n  age: number;\n  active: boolean;\n}',
        '字符串 / 数字 / 布尔');
      assert.eq(jsonToTypescript('{"a":1}'),
        'export interface Root {\n  a: number;\n}', '整数也是 number');
      assert.eq(jsonToTypescript('{"a":1.5}'),
        'export interface Root {\n  a: number;\n}', '小数也是 number');
      assert.eq(jsonToTypescript('{"a":null}'),
        'export interface Root {\n  a: any;\n}', 'null → any');
      assert.eq(jsonToTypescript('{"a":"2024-01-02"}'),
        'export interface Root {\n  a: string;\n}', '日期样式的字符串仍是 string');

      /* ---------- 嵌套与数组 ---------- */
      assert.eq(jsonToTypescript('{"nested":{"a":1}}'),
        'export interface Root {\n  nested: Nested;\n}\n\nexport interface Nested {\n  a: number;\n}',
        '嵌套对象 → 自己的 interface');
      assert.eq(jsonToTypescript('{"tags":["a"]}'),
        'export interface Root {\n  tags: string[];\n}', '字符串数组');
      assert.eq(jsonToTypescript('{"a":[[1,2],[3]]}'),
        'export interface Root {\n  a: number[][];\n}', '数组套数组');
      assert.eq(jsonToTypescript('{"tags":[]}'),
        'export interface Root {\n  tags: any[];\n}', '空数组 → any[]');

      /* ---------- 顶层是数组 ---------- */
      assert.eq(jsonToTypescript('[{"a":1}]'),
        'export type Root = RootItem[];\n\nexport interface RootItem {\n  a: number;\n}',
        '顶层数组 → type 别名 + 元素 interface');
      assert.eq(jsonToTypescript('[1,2]'),
        'export type Root = number[];', '顶层标量数组');

      /* ---------- 开关 ---------- */
      assert.eq(jsonToTypescript('{"a":1}', { useType: true }),
        'export type Root = {\n  a: number;\n};', 'type 别名');
      assert.eq(jsonToTypescript('{"a":1}', { optional: true }),
        'export interface Root {\n  a?: number;\n}', '属性可选');
      assert.eq(jsonToTypescript('{"a":1}', { readonly: true }),
        'export interface Root {\n  readonly a: number;\n}', 'readonly 成员');
      assert.eq(jsonToTypescript('{"user_name":"x"}', { camelCase: true }),
        'export interface Root {\n  userName: string;\n}', '驼峰属性名');
      assert.eq(jsonToTypescript('{"user_name":"x"}'),
        'export interface Root {\n  user_name: string;\n}', '默认保留原键名');
      assert.eq(jsonToTypescript('{"a":1}', { rootName: 'User' }),
        'export interface User {\n  a: number;\n}', '自定义根类型名');

      /* ---------- 名字撞车 ---------- */
      assert.eq(jsonToTypescript('{"user-name":1,"user_name":2}', { camelCase: true }),
        'export interface Root {\n  userName: number;\n  userName2: number;\n}',
        '洗完重名 → 加数字后缀');
    }
  };
})();
