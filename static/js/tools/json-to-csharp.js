/* ==========================================================================
   JSON 转 C# 类型定义（json-to-csharp）

   把一份 JSON 变成 C# 的类型定义（class / record）。

   参考实现：it-tools 上游 PR #1102「feat(new tool): JSON to C#」，
   上游那一版是 Vue 组件里的 json2csharp.ts（it-tools, GPLv3）。
   本工具沿用上游 GPLv3 许可（与本仓库一致），来源与改动如下。
   与上游的差别 —— 上游有 3 个真 bug，这里都修掉了（上游的测试把这些 bug 锁死了，
   所以这里不能照抄它的期望值）：
   1. **null 不再生成空 class**。上游用 `typeof obj[k] == 'object'` 判对象，
      而 `typeof null` 也是 'object'，于是 {"a":null} 会生成一个没有任何成员的
      `public class A {}`，属性类型还指向它 —— 编译不过。
      这里 null 的类型是 object（开可空引用类型时是 object?），不给它开 class。
   2. **只读列表不再生成非法 C#**。上游拼的是 `= new IReadonlyList<X>();` ——
      一来接口名拼错了（.NET 里是 IReadOnlyList<T>），
      二来接口不能 new，`new IReadonlyList<X>()` 编译不过。
      这里类型写 IReadOnlyList<X>，初始化写 `= new List<X>();`
      （List<T> 实现了 IReadOnlyList<T>）。
   3. **数组里的对象不再指向没定义 / 重名的类型**。上游给 [{…}] 的属性写成 X[]，
      而 X 这个类名跟外层撞名时会生成两份重复定义。
      这里数组的元素类型从**第一个元素**推断（空数组给 object），
      生成的类名保证唯一（撞名时加数字后缀）。

   另外补了上游没做的标识符清洗（上游的 normalize() 只看首字符是不是数字）：
   类名与属性名必须是合法的 C# 标识符（[A-Za-z_][A-Za-z0-9_]*）——
     · 不是标识符字符的一律换成 _；
     · 数字开头的加 _ 前缀；
     · C# 关键字加 @ 前缀（@class 指的还是 class）。

   ------------------------------------------------------------------------
   依赖：上游用了 change-case（大小写转换）与 json5（宽松 JSON 解析）两个第三方库，
   本站都没 vendor —— 所以大小写转换自己写（toPascalCase / toCamelCase），
   解析用严格的 JSON.parse（与本站的姊妹工具 json-to-go 保持一致）。

   ------------------------------------------------------------------------
   类型推断（口径跟 json-to-go 对齐）：
     · bool            → bool
     · 整数            → int（int32 范围）/ long / decimal（再超出）
     · 小数            → double
     · 字符串          → string；形状像 ISO-8601 日期时间的 → DateTime
     · 数组            → T[]（开只读列表时是 IReadOnlyList<T>）；空数组 → object[]
     · 对象            → 单独一个 class
     · null            → object（开可空引用类型时 object?）
     · DateTime / int / bool / double 这些是**值类型**，可空引用类型开关不给它们加 ?。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-to-csharp');
  /** 与语言无关的 JSON 类型推断内核（app.js 里）—— 几个 JSON 转代码的工具共用。 */
  var J = window.ItTools.jsonInfer;

  /* ==================================================================
     常量
     ================================================================== */

  /**
   * C# 的保留关键字。用 @ 前缀就能当标识符（@class 指的还是 class）。
   * 只列真正的关键字（全是小写）；上下文关键字（value / record / async / …）
   * 本来就能当标识符，不必处理。
   */
  var CSHARP_KEYWORDS = [
    'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch',
    'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default',
    'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern',
    'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if',
    'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long',
    'namespace', 'new', 'null', 'object', 'operator', 'out', 'override',
    'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return',
    'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string',
    'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint',
    'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void',
    'volatile', 'while'
  ];

  /**
   * ISO-8601 日期 / 日期时间的形状。
   *
   * 只看形状不看真实性 —— 2024-13-45 这种不存在的日子也算日期形状
   * （跟 json-to-go 的口径一致）。要的是「像不像时间戳」，不是「是不是存在的时刻」。
   *
   * 允许的形状：
   *   YYYY-MM-DD
   *   YYYY-MM-DDTHH:MM[ :SS[.fff]][Z|±hh:mm]
   */
  /* ==================================================================
     名字：切词、大小写、标识符清洗
     ==================================================================

     切词与大小写转换是**与语言无关**的，已经挪到 app.js 的
     `ItTools.jsonInfer` —— json-to-typescript / json-to-protobuf /
     json-to-schema 要用同一套规则。两边各写一份，迟早会漂移：同一个键在
     C# 里叫 UserName、在 TypeScript 里叫 userName 那还算好的；漂到两边
     切词规则不一样（比如一边把 HTTPServer 切成 HTTP|Server、另一边不切），
     生成出来的类型名就再也对不上了。

     这里只留 C# 特有的那一步：关键字加 @ 前缀。 */

  var splitWords = J.splitWords;
  var toPascalCase = J.toPascalCase;
  var toCamelCase = J.toCamelCase;

  /**
   * C# 的标识符清洗：先把不合法的字符换掉（通用那步在核心里），
   * 再给关键字加 @ 前缀（@class 指的还是 class）。
   */
  function sanitizeIdentifier(name) {
    var s = J.sanitizeIdentifier(name);
    if (CSHARP_KEYWORDS.indexOf(s) !== -1) s = '@' + s;
    return s;
  }

  /** 去掉标识符前面的 @（@ 只是转义前缀，不算名字的一部分） */
  function stripAt(name) {
    var s = String(name == null ? '' : name);
    return s.charAt(0) === '@' ? s.substr(1) : s;
  }

  /* ==================================================================
     类型推断
     ==================================================================

     推断本身已经挪到 app.js 的 `ItTools.jsonInfer` —— 那是一棵**与语言无关**的
     类型树（标量 / 数组 / 对象），节点形状见 app.js 里那一段的注释。

     C# 这一侧只做翻译：把中立类型映射成 C# 的类型名，并说清哪些是值类型
     （可空引用类型那个 ? 只给引用类型加）。 */

  var isPlainObject = J.isPlainObject;
  var isIsoDate = J.isIsoDate;

  /** 中立的标量类型 → C# 类型名 */
  function csharpTypeName(type) {
    switch (type.type) {
      case 'boolean': return 'bool';
      case 'integer':
        if (type.width === 'int32') return 'int';
        if (type.width === 'int64') return 'long';
        return 'decimal';
      case 'number': return 'double';
      case 'string': return 'string';
      case 'date': return 'DateTime';
      case 'null': return 'object';
      default: return 'object';
    }
  }

  /**
   * 是不是**值类型**（可空引用类型那个 ? 只给引用类型加）。
   * DateTime / int / bool / double 都是值类型 —— 给它们加 ? 变成的是
   * Nullable<T>，语义完全不是一回事。
   */
  function csharpIsValueType(type) {
    if (type.kind !== 'scalar') return false;
    return type.type !== 'string' && type.type !== 'null';
  }

  /**
   * 数字 → C# 数值类型。
   *
   * int 的范围是 int32；超出用 long；再超出（JSON 的双精度已经装不下 long 了）用 decimal。
   * 注意 long 的上界写的是 < 2^63：JS 的 number 是双精度，2^63 正好可表示，
   * 而 long.MaxValue 是 2^63-1，所以要用「小于 2^63」而不是「小于等于 long.MaxValue」。
   */
  function numberType(n) {
    return csharpTypeName(J.inferScalar(n));
  }

  /* ==================================================================
     生成
     ================================================================== */

  /** 补齐默认值 —— 界面上的开关直接映射过来 */
  function normalizeOptions(opts) {
    opts = opts || {};
    return {
      pascalCase: opts.pascalCase !== false,
      useRecordTypes: !!opts.useRecordTypes,
      useReadonlyLists: !!opts.useReadonlyLists,
      useFields: !!opts.useFields,
      useNullable: !!opts.useNullable,
      addJsonProperty: !!opts.addJsonProperty,
      addJsonPropertyName: !!opts.addJsonPropertyName,
      nullValueHandlingIgnore: !!opts.nullValueHandlingIgnore,
      generateImmutableClasses: !!opts.generateImmutableClasses,
      rootName: opts.rootName || 'Root'
    };
  }

  /** 同一个类里的成员名不能重样（C# 不允许），撞了就加数字后缀 */
  var uniqueMemberName = J.uniqueMemberName;

  /**
   * 把推断出来的类型树翻译成 C# 的类列表。
   *
   * 顶层是数组或标量时，C# 没有「根类型」这个东西 —— 得造一个类把它装起来：
   * 数组装成 `T[] Items`，标量装成 `T Value`。但**顶层数组的元素本身是对象
   * 时**，那个元素类直接当根类（不另造一个 Items 壳）—— 跟上游一个口径。
   */
  function buildClasses(doc, opts) {
    var classes = doc.defs.slice();

    // 顶层就是对象 → 它自己就是根类
    if (doc.root.kind === 'object') {
      return { classes: classes, root: doc.root };
    }

    // 顶层是数组、元素是对象 → 元素类就是根类
    if (doc.root.kind === 'array' && doc.root.element.kind === 'object') {
      return { classes: classes, root: doc.root.element };
    }

    var rootClass = {
      kind: 'object',
      name: doc.newTypeName(opts.rootName),
      members: []
    };
    if (doc.root.kind === 'array') {
      rootClass.members.push({
        key: null,
        name: 'Items',
        type: { kind: 'array', element: doc.root.element }
      });
    } else {
      rootClass.members.push({ key: null, name: 'Value', type: doc.root });
    }
    classes.unshift(rootClass);
    return { classes: classes, root: rootClass };
  }

  /* ---------- 渲染 ---------- */

  /**
   * 类型名。
   *
   * 数组按开关写成 `T[]` 或 `IReadOnlyList<T>`。
   */
  function typeNameOf(type, opts) {
    if (type.kind === 'array') {
      var inner = plainTypeName(type.element, opts);
      return opts.useReadonlyLists ? 'IReadOnlyList<' + inner + '>' : inner + '[]';
    }
    if (type.kind === 'object') return type.name;
    return csharpTypeName(type);
  }

  /**
   * 数组的「元素类型名」（不带 []）。
   *
   * 嵌套的数组在这里被拍成 `T[]` —— 只读列表**不**跟着嵌套：
   * 否则 IReadOnlyList<IReadOnlyList<T>> 的初始化 new List<…>() 没法写对。
   */
  function plainTypeName(type, opts) {
    if (type.kind === 'array') return plainTypeName(type.element, opts) + '[]';
    return typeNameOf(type, opts);
  }

  /** 可空引用类型：只给引用类型加 ?（值类型加了就是 Nullable<T>，语义完全不同） */
  function nullableSuffix(type, opts) {
    if (!opts.useNullable) return '';
    return csharpIsValueType(type) ? '' : '?';
  }

  /** 带 ? 的类型名 */
  function renderType(type, opts) {
    return typeNameOf(type, opts) + nullableSuffix(type, opts);
  }

  /**
   * 只读列表的初始化：`= new List<T>()`（分号由调用方补）。
   * List<T> 实现了 IReadOnlyList<T>，所以这是唯一能同时满足「类型是接口」和「能 new」的写法。
   */
  function listInitializer(type, opts) {
    if (type.kind !== 'array' || !opts.useReadonlyLists) return '';
    return ' = new List<' + plainTypeName(type.element, opts) + '>()';
  }

  /** C# 字符串字面量里的转义 */
  function escapeCSharpString(str) {
    return String(str == null ? '' : str)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, function (ch) {
        return '\\u' + ('000' + ch.charCodeAt(0).toString(16)).slice(-4);
      });
  }

  /**
   * 成员上的 JSON 特性。
   *
   * Newtonsoft 的 [JsonProperty] 与 System.Text.Json 的 [JsonPropertyName] 是两套东西，
   * 两个开关都开就两个都写上（各管各的序列化器）。
   * NullValueHandling 是 Newtonsoft 的 JsonProperty 上的属性，所以它跟 JsonProperty 合并成一条；
   * 只开「忽略 null 值」时就单独写一条不带名字的 [JsonProperty(…)]。
   *
   * @param {object} member
   * @param {object} opts
   * @param {boolean} isRecordParam record 的位置参数要写 property: 目标
   * @returns {string[]}
   */
  function renderAttributes(member, opts, isRecordParam) {
    var attrs = [];
    if (member.key === null || member.key === undefined) return attrs;
    var escaped = escapeCSharpString(member.key);
    if (opts.addJsonProperty) {
      if (opts.nullValueHandlingIgnore) {
        attrs.push('[JsonProperty("' + escaped + '", NullValueHandling = NullValueHandling.Ignore)]');
      } else {
        attrs.push('[JsonProperty("' + escaped + '")]');
      }
    } else if (opts.nullValueHandlingIgnore) {
      attrs.push('[JsonProperty(NullValueHandling = NullValueHandling.Ignore)]');
    }
    if (opts.addJsonPropertyName) {
      attrs.push('[JsonPropertyName("' + escaped + '")]');
    }
    if (isRecordParam) {
      for (var i = 0; i < attrs.length; i++) {
        attrs[i] = '[property: ' + attrs[i].slice(1, -1) + ']';
      }
    }
    return attrs;
  }

  /** 构造函数参数名：camelCase，且必须是合法标识符 */
  function constructorParamName(member, used) {
    return uniqueMemberName(sanitizeIdentifier(toCamelCase(stripAt(member.name))), used);
  }

  /**
   * 普通成员（属性 / 字段）的一行声明。
   *
   * 属性声明后面**没有**分号（`public int A { get; set; }`），
   * 字段有（`public int A;`）—— 分号加错了编译不过。
   *
   * @param {object} member
   * @param {object} opts
   * @param {boolean} immutable
   * @returns {string}
   */
  function renderMember(member, opts, immutable) {
    var lines = renderAttributes(member, opts, false);
    var type = renderType(member.type, opts);
    var init = listInitializer(member.type, opts);
    if (opts.useFields) {
      lines.push('public ' + (immutable ? 'readonly ' : '') + type + ' ' + member.name + init + ';');
    } else {
      // 属性声明后面没有分号；只有带初始化的时候才有一个（`{ get; set; } = new List<T>();`）
      lines.push('public ' + type + ' ' + member.name + ' { ' + (immutable ? 'get;' : 'get; set;') + ' }' +
        (init ? init + ';' : ''));
    }
    return lines.join('\n');
  }

  /** record 的位置参数 */
  function renderRecordParameter(member, opts) {
    var parts = renderAttributes(member, opts, true);
    parts.push(renderType(member.type, opts) + ' ' + member.name);
    return parts.join(' ');
  }

  /**
   * 渲染一个 class。
   *
   * 形态：
   *   · class + 属性            → public class X { public T Y { get; set; } }
   *   · class + 字段            → public class X { public T Y; }
   *   · class + 不可变          → 带构造函数 + 只读属性（字段则是 readonly 字段）
   *   · record（位置参数形式）  → public record X(T Y, …)
   *   · record + 字段           → public record X { public T Y; }
   *
   * @param {{name: string, members: Array}} cls
   * @param {object} opts
   * @returns {string}
   */
  function renderClass(cls, opts) {
    var lines = [];
    var isRecord = opts.useRecordTypes;
    // record 本身就是不可变的，「不可变类」开关在 record 形态下没有意义
    var immutable = opts.generateImmutableClasses && !isRecord;

    if (isRecord && !opts.useFields) {
      lines.push('public record ' + cls.name + '(');
      for (var i = 0; i < cls.members.length; i++) {
        var last = i === cls.members.length - 1;
        lines.push('    ' + renderRecordParameter(cls.members[i], opts) + (last ? '' : ','));
      }
      lines.push(');');
      return lines.join('\n');
    }

    lines.push('public ' + (isRecord ? 'record' : 'class') + ' ' + cls.name);
    lines.push('{');

    var body = [];
    if (immutable && cls.members.length) {
      var usedParams = Object.create(null);
      var params = [];
      var assigns = [];
      for (var j = 0; j < cls.members.length; j++) {
        var m = cls.members[j];
        var pname = constructorParamName(m, usedParams);
        // 构造函数的参数类型不加 ?：可空标记说的是「成员可能是 null」，
        // 参数类型加了反而会让人以为这里在收一个可空的入参。
        params.push(typeNameOf(m.type, opts) + ' ' + pname);
        // 左边一律写 this.：参数名跟成员名撞上时（成员叫 `class`、
        // 参数也叫 `class`；或者关掉 PascalCase 后成员叫 `name`、参数也叫 `name`），
        // 光写成员名会被解析成那个参数本身 —— 赋给参数是编译错误。
        assigns.push('        this.' + m.name + ' = ' + pname + ';');
      }
      body.push('    public ' + cls.name + '(' + params.join(', ') + ')');
      body.push('    {');
      for (var k = 0; k < assigns.length; k++) body.push(assigns[k]);
      body.push('    }');
      body.push('');
    }

    for (var n = 0; n < cls.members.length; n++) {
      // 成员可能带特性（好几行），每一行都要缩进
      var memberLines = renderMember(cls.members[n], opts, immutable).split('\n');
      for (var q = 0; q < memberLines.length; q++) body.push('    ' + memberLines[q]);
    }

    for (var b = 0; b < body.length; b++) lines.push(body[b]);
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * JSON → C# 类型定义。
   *
   * 非法 JSON 直接抛错（JSON.parse 的原始报错带行列号，界面原样显示）。
   * 空输入返回空串。
   *
   * @param {string} json
   * @param {object} [opts]
   * @returns {string}
   */
  function jsonToCSharp(json, opts) {
    var options = normalizeOptions(opts);
    var src = String(json == null ? '' : json);
    if (!src.trim()) return '';

    var data = JSON.parse(src);

    var doc = J.infer(data, {
      rootName: options.rootName,
      pascalCase: options.pascalCase,
      sanitizeMember: sanitizeIdentifier,
      sanitizeType: sanitizeIdentifier
    });

    var built = buildClasses(doc, options);

    var out = [];
    for (var i = 0; i < built.classes.length; i++) {
      out.push(renderClass(built.classes[i], options));
    }
    return out.join('\n\n');
  }

  /* ==================================================================
     界面
     ================================================================== */

  window.ItTools.register('json-to-csharp', function (root) {
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

    // 九个开关，跟上游界面上的一一对应（没自己发明）
    var pascalInput = D.h('input', { type: 'checkbox', checked: 'checked' });
    var recordInput = D.h('input', { type: 'checkbox' });
    var readonlyInput = D.h('input', { type: 'checkbox' });
    var fieldsInput = D.h('input', { type: 'checkbox' });
    var nullableInput = D.h('input', { type: 'checkbox' });
    var newtonsoftInput = D.h('input', { type: 'checkbox' });
    var stjInput = D.h('input', { type: 'checkbox' });
    var ignoreNullInput = D.h('input', { type: 'checkbox' });
    var immutableInput = D.h('input', { type: 'checkbox' });

    function render() {
      var raw = input.value;
      if (!raw.trim()) {
        output.value = '';
        status.className = 'form-status';
        status.textContent = t('status_empty', 'Type or paste some JSON above.');
        return;
      }
      try {
        output.value = jsonToCSharp(raw, {
          pascalCase: pascalInput.checked,
          useRecordTypes: recordInput.checked,
          useReadonlyLists: readonlyInput.checked,
          useFields: fieldsInput.checked,
          useNullable: nullableInput.checked,
          addJsonProperty: newtonsoftInput.checked,
          addJsonPropertyName: stjInput.checked,
          nullValueHandlingIgnore: ignoreNullInput.checked,
          generateImmutableClasses: immutableInput.checked,
          rootName: rootNameInput.value
        });
        status.className = 'form-status';
        status.textContent = '';
      } catch (e) {
        output.value = '';
        status.className = 'form-status is-error';
        status.textContent = t('err_invalid', 'Provided JSON is not valid. {message}')
          // 用函数形式回填：JSON.parse 的报错里可能有 '$'，字符串替换会把它当替换模式
          .replace('{message}', function () { return e && e.message ? e.message : e; });
      }
    }

    var offs = [
      D.on(input, 'input', render),
      D.on(rootNameInput, 'input', render),
      D.on(pascalInput, 'change', render),
      D.on(recordInput, 'change', render),
      D.on(readonlyInput, 'change', render),
      D.on(fieldsInput, 'change', render),
      D.on(nullableInput, 'change', render),
      D.on(newtonsoftInput, 'change', render),
      D.on(stjInput, 'change', render),
      D.on(ignoreNullInput, 'change', render),
      D.on(immutableInput, 'change', render)
    ];

    root.appendChild(D.h('div.card', null,
      D.h('div.switch-grid', null,
        D.h('label.switch', null, pascalInput, D.h('span', { text: t('pascal_case', 'PascalCase naming') })),
        D.h('label.switch', null, recordInput, D.h('span', { text: t('use_records', 'Use record types') })),
        D.h('label.switch', null, readonlyInput, D.h('span', { text: t('readonly_lists', 'Use readonly lists') })),
        D.h('label.switch', null, fieldsInput, D.h('span', { text: t('use_fields', 'Use fields instead of properties') })),
        D.h('label.switch', null, nullableInput, D.h('span', { text: t('use_nullable', 'Nullable reference types') })),
        D.h('label.switch', null, newtonsoftInput, D.h('span', { text: t('newtonsoft_attr', 'Newtonsoft.Json attribute') })),
        D.h('label.switch', null, stjInput, D.h('span', { text: t('stj_attr', 'System.Text.Json attribute') })),
        D.h('label.switch', null, ignoreNullInput, D.h('span', { text: t('ignore_nulls', 'Ignore null values') })),
        D.h('label.switch', null, immutableInput, D.h('span', { text: t('immutable', 'Immutable classes') }))
      ),
      U.field(t('input', 'Your JSON'), input, { wide: true }),
      U.field(t('root_name', 'Root type name'), rootNameInput),
      status,
      D.h('p.field-hint', {
        text: t('hint', 'Generates C# type definitions from JSON. Booleans become bool, whole numbers int / long / decimal, decimals double, and strings that look like ISO-8601 dates become DateTime. Arrays become T[] (or IReadOnlyList<T> with readonly lists), objects become their own class, and null becomes object. Class and property names are always valid C# identifiers.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('output', 'Your C# code') }),
        U.copyButton(function () { return output.value; }, t('copy_cs', 'Copy C#'))
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

  window.ItTools.logic['json-to-csharp'] = {
    jsonToCSharp: jsonToCSharp,
    splitWords: splitWords,
    toPascalCase: toPascalCase,
    toCamelCase: toCamelCase,
    sanitizeIdentifier: sanitizeIdentifier,
    numberType: numberType,
    isIsoDate: isIsoDate,
    escapeCSharpString: escapeCSharpString,
    __cases: function (assert) {
      /* ---------- 切词与大小写 ---------- */
      assert.eq(splitWords('user_name'), ['user', 'name'], '下划线是分隔符');
      assert.eq(splitWords('user-name'), ['user', 'name'], '连字符是分隔符');
      assert.eq(splitWords('user name'), ['user', 'name'], '空格是分隔符');
      assert.eq(splitWords('fooBar'), ['foo', 'Bar'], '驼峰边界');
      assert.eq(splitWords('HTTPServer'), ['HTTP', 'Server'], '缩写边界');
      assert.eq(splitWords('foo2bar'), ['foo', '2', 'bar'], '数字边界');
      assert.eq(toPascalCase('user_name'), 'UserName', 'snake_case → PascalCase');
      assert.eq(toPascalCase('user-name'), 'UserName', 'kebab-case → PascalCase');
      assert.eq(toPascalCase('user name'), 'UserName', '带空格 → PascalCase');
      assert.eq(toPascalCase('fooBar'), 'FooBar', 'camelCase → PascalCase');
      assert.eq(toPascalCase('HTTP_SERVER'), 'HttpServer', 'SCREAMING_SNAKE_CASE → PascalCase');
      assert.eq(toPascalCase('2fa'), '2Fa', '数字开头的词保持数字开头');
      assert.eq(toCamelCase('user_name'), 'userName', 'camelCase 形式');
      assert.eq(toCamelCase('HTTP_SERVER'), 'httpServer', 'SCREAMING_SNAKE_CASE → camelCase');

      /* ---------- 标识符清洗 ---------- */
      assert.eq(sanitizeIdentifier('class'), '@class', 'C# 关键字加 @ 前缀');
      assert.eq(sanitizeIdentifier('int'), '@int', 'int 也是关键字');
      assert.eq(sanitizeIdentifier('2fa'), '_2fa', '数字开头加 _ 前缀');
      assert.eq(sanitizeIdentifier('a-b'), 'a_b', '非法字符换成 _');
      assert.eq(sanitizeIdentifier('a b'), 'a_b', '空格换成 _');
      assert.eq(sanitizeIdentifier(''), '_', '空串给个占位');
      assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(sanitizeIdentifier('中文键')), '中文键洗完是合法标识符');

      /* ---------- 基本类型推断 ---------- */
      assert.eq(jsonToCSharp('{"name":"John","age":30,"active":true}'),
        'public class Root\n{\n    public string Name { get; set; }\n    public int Age { get; set; }\n    public bool Active { get; set; }\n}',
        '字符串 / 整数 / 布尔');
      assert.eq(jsonToCSharp('{"a":2147483647}'),
        'public class Root\n{\n    public int A { get; set; }\n}', 'int32 上界仍是 int');
      assert.eq(jsonToCSharp('{"a":2147483648}'),
        'public class Root\n{\n    public long A { get; set; }\n}', '超出 int32 → long');
      assert.eq(jsonToCSharp('{"a":1e19}'),
        'public class Root\n{\n    public decimal A { get; set; }\n}', '再超出 → decimal');
      assert.eq(jsonToCSharp('{"a":1.5}'),
        'public class Root\n{\n    public double A { get; set; }\n}', '小数 → double');
      assert.eq(jsonToCSharp('{"a":-5}'),
        'public class Root\n{\n    public int A { get; set; }\n}', '负整数 → int');
      assert.eq(jsonToCSharp('{"a":false}'),
        'public class Root\n{\n    public bool A { get; set; }\n}', 'false → bool');

      /* ---------- 日期判定 ---------- */
      assert.eq(jsonToCSharp('{"a":"2024-01-02"}'),
        'public class Root\n{\n    public DateTime A { get; set; }\n}', 'YYYY-MM-DD → DateTime');
      assert.eq(jsonToCSharp('{"a":"2024-01-02T03:04:05Z"}'),
        'public class Root\n{\n    public DateTime A { get; set; }\n}', 'UTC 时间戳 → DateTime');
      assert.eq(jsonToCSharp('{"a":"2024-01-02T03:04:05.123+08:00"}'),
        'public class Root\n{\n    public DateTime A { get; set; }\n}', '带时区偏移 → DateTime');
      assert.eq(jsonToCSharp('{"a":"2024-13-45"}'),
        'public class Root\n{\n    public DateTime A { get; set; }\n}', '不存在的日子也是日期形状');
      assert.eq(jsonToCSharp('{"a":"hello"}'),
        'public class Root\n{\n    public string A { get; set; }\n}', '普通字符串 → string');
      assert.eq(jsonToCSharp('{"a":"2024-1-2"}'),
        'public class Root\n{\n    public string A { get; set; }\n}', '形状不对就不是日期');

      /* ---------- 嵌套对象 ---------- */
      assert.eq(jsonToCSharp('{"address":{"city":"Paris"}}'),
        'public class Root\n{\n    public Address Address { get; set; }\n}\n\npublic class Address\n{\n    public string City { get; set; }\n}',
        '嵌套对象 → 两个 class');
      assert(jsonToCSharp('{"a":{"b":{"c":"d"}}}').indexOf('public class B\n') !== -1, '三层嵌套也各出一个 class');

      /* ---------- 数组 ---------- */
      assert.eq(jsonToCSharp('{"tags":["a","b"]}'),
        'public class Root\n{\n    public string[] Tags { get; set; }\n}', '字符串数组 → string[]');
      assert.eq(jsonToCSharp('{"tags":[]}'),
        'public class Root\n{\n    public object[] Tags { get; set; }\n}', '空数组 → object[]');
      assert.eq(jsonToCSharp('{"people":[{"name":"Frank"}]}'),
        'public class Root\n{\n    public People[] People { get; set; }\n}\n\npublic class People\n{\n    public string Name { get; set; }\n}',
        '对象数组 → 元素类 + X[]');
      assert.eq(jsonToCSharp('{"a":[[1,2],[3]]}'),
        'public class Root\n{\n    public int[][] A { get; set; }\n}', '数组套数组');
      assert.eq(jsonToCSharp('{"a":[null]}'),
        'public class Root\n{\n    public object[] A { get; set; }\n}', 'null 元素 → object[]');

      /* ---------- 上游 bug 1：null 不生成空 class ---------- */
      var nullOut = jsonToCSharp('{"a":null}');
      assert.eq(nullOut, 'public class Root\n{\n    public object A { get; set; }\n}', 'null → object，不开空 class');
      assert(nullOut.indexOf('class A') === -1, 'null 不会生成一个空的 A 类');
      assert.eq(jsonToCSharp('{"a":null}', { useNullable: true }),
        'public class Root\n{\n    public object? A { get; set; }\n}', '可空引用类型下 null → object?');

      /* ---------- 上游 bug 2：只读列表 ---------- */
      var ro = jsonToCSharp('{"tags":["a"]}', { useReadonlyLists: true });
      assert.eq(ro, 'public class Root\n{\n    public IReadOnlyList<string> Tags { get; set; } = new List<string>();\n}',
        '只读列表：类型是 IReadOnlyList<T>，初始化是 new List<T>()');
      assert(ro.indexOf('IReadonlyList') === -1, '接口名不能拼成 IReadonlyList');
      assert(ro.indexOf('new IReadOnlyList') === -1, '接口不能 new');
      assert(ro.indexOf('= new List<string>();') !== -1, '初始化写的是 new List<T>()');
      assert.eq(jsonToCSharp('{"tags":["a"]}', { useReadonlyLists: true, useFields: true }),
        'public class Root\n{\n    public IReadOnlyList<string> Tags = new List<string>();\n}',
        '只读列表 + 字段：初始化后面只有一个分号');

      /* ---------- 上游 bug 3：类名唯一 ---------- */
      var dup = jsonToCSharp('{"user-name":{"a":1},"user_name":{"b":2}}');
      assert(dup.indexOf('public class UserName\n') !== -1, '第一个类叫 UserName');
      assert(dup.indexOf('public class UserName2\n') !== -1, '撞名的类加数字后缀');
      assert(dup.indexOf('public class UserName\n{') !== dup.lastIndexOf('public class UserName'), '没有生成两份同名类');

      /* ---------- 标识符 ---------- */
      assert.eq(jsonToCSharp('{"class":"x"}', { pascalCase: false }),
        'public class Root\n{\n    public string @class { get; set; }\n}', '关键字属性名 → @class');
      assert.eq(jsonToCSharp('{"class":"x"}'),
        'public class Root\n{\n    public string Class { get; set; }\n}', 'PascalCase 之后不再是关键字');
      assert.eq(jsonToCSharp('{"2fa":true}', { pascalCase: false }),
        'public class Root\n{\n    public bool _2fa { get; set; }\n}', '数字开头的键 → _ 前缀');
      assert.eq(jsonToCSharp('{"2fa":true}'),
        'public class Root\n{\n    public bool _2Fa { get; set; }\n}', '数字开头的键（PascalCase）');
      assert.eq(jsonToCSharp('{"a-b":1}'),
        'public class Root\n{\n    public int AB { get; set; }\n}', '连字符切词');
      assert.eq(jsonToCSharp('{"user_name":"x"}'),
        'public class Root\n{\n    public string UserName { get; set; }\n}', '下划线切词');

      /* ---------- PascalCase 开关 ---------- */
      assert.eq(jsonToCSharp('{"user_name":"x"}', { pascalCase: false }),
        'public class Root\n{\n    public string user_name { get; set; }\n}', '关掉 PascalCase 就保留原键名');
      assert.eq(jsonToCSharp('{"a-b":1}', { pascalCase: false }),
        'public class Root\n{\n    public int a_b { get; set; }\n}', '关掉 PascalCase 仍要做标识符清洗');

      /* ---------- record ---------- */
      assert.eq(jsonToCSharp('{"a":1,"b":"x"}', { useRecordTypes: true }),
        'public record Root(\n    int A,\n    string B\n);', 'record 位置参数形式');
      assert.eq(jsonToCSharp('{"a":1}', { useRecordTypes: true, useFields: true }),
        'public record Root\n{\n    public int A;\n}', 'record + 字段 → 体里的字段');
      assert.eq(jsonToCSharp('{"a":1}', { useRecordTypes: true, addJsonProperty: true }),
        'public record Root(\n    [property: JsonProperty("a")] int A\n);', 'record 的特性要写 property: 目标');

      /* ---------- 字段 ---------- */
      assert.eq(jsonToCSharp('{"a":1}', { useFields: true }),
        'public class Root\n{\n    public int A;\n}', '用字段而不是属性');

      /* ---------- 不可变类 ---------- */
      assert.eq(jsonToCSharp('{"a":1,"b":"x"}', { generateImmutableClasses: true }),
        'public class Root\n{\n    public Root(int a, string b)\n    {\n        this.A = a;\n        this.B = b;\n    }\n\n    public int A { get; }\n    public string B { get; }\n}',
        '不可变类：构造函数 + 只读属性');
      assert.eq(jsonToCSharp('{"a":1}', { generateImmutableClasses: true, useFields: true }),
        'public class Root\n{\n    public Root(int a)\n    {\n        this.A = a;\n    }\n\n    public readonly int A;\n}',
        '不可变类 + 字段 → readonly 字段');
      assert.eq(jsonToCSharp('{"class":"x"}', { generateImmutableClasses: true, pascalCase: false }),
        'public class Root\n{\n    public Root(string @class)\n    {\n        this.@class = @class;\n    }\n\n    public string @class { get; }\n}',
        '不可变类 + 关键字成员名：左边要写 this.@class');

      /* ---------- 可空引用类型 ---------- */
      assert.eq(jsonToCSharp('{"a":"x","b":1,"c":null}', { useNullable: true }),
        'public class Root\n{\n    public string? A { get; set; }\n    public int B { get; set; }\n    public object? C { get; set; }\n}',
        '可空引用类型只给引用类型加 ?');
      assert.eq(jsonToCSharp('{"a":"2024-01-02"}', { useNullable: true }),
        'public class Root\n{\n    public DateTime A { get; set; }\n}', 'DateTime 是值类型，不加 ?');

      /* ---------- JSON 特性 ---------- */
      assert.eq(jsonToCSharp('{"userName":"x"}', { addJsonProperty: true }),
        'public class Root\n{\n    [JsonProperty("userName")]\n    public string UserName { get; set; }\n}',
        'Newtonsoft 的 [JsonProperty]');
      assert.eq(jsonToCSharp('{"userName":"x"}', { addJsonPropertyName: true }),
        'public class Root\n{\n    [JsonPropertyName("userName")]\n    public string UserName { get; set; }\n}',
        'System.Text.Json 的 [JsonPropertyName]');
      assert.eq(jsonToCSharp('{"userName":"x"}', { addJsonProperty: true, nullValueHandlingIgnore: true }),
        'public class Root\n{\n    [JsonProperty("userName", NullValueHandling = NullValueHandling.Ignore)]\n    public string UserName { get; set; }\n}',
        'NullValueHandling 合并进 JsonProperty');
      assert.eq(jsonToCSharp('{"userName":"x"}', { nullValueHandlingIgnore: true }),
        'public class Root\n{\n    [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]\n    public string UserName { get; set; }\n}',
        '只开忽略 null 值也写 Newtonsoft 的特性');
      assert.eq(jsonToCSharp('{"userName":"x"}', { addJsonProperty: true, addJsonPropertyName: true }),
        'public class Root\n{\n    [JsonProperty("userName")]\n    [JsonPropertyName("userName")]\n    public string UserName { get; set; }\n}',
        '两个序列化器的特性可以同时写');

      /* ---------- 根类型名 ---------- */
      assert.eq(jsonToCSharp('{"a":1}', { rootName: 'User' }),
        'public class User\n{\n    public int A { get; set; }\n}', '自定义根类型名');
      assert.eq(jsonToCSharp('{"a":1}', { rootName: 'my_root' }),
        'public class MyRoot\n{\n    public int A { get; set; }\n}', '根类型名也走 PascalCase');

      /* ---------- 顶层是数组 ---------- */
      assert.eq(jsonToCSharp('[{"a":1}]'),
        'public class Root\n{\n    public int A { get; set; }\n}', '顶层数组：元素类型当根');
      assert.eq(jsonToCSharp('[1,2,3]'),
        'public class Root\n{\n    public int[] Items { get; set; }\n}', '顶层标量数组：根类里放一个 T[]');
      assert.eq(jsonToCSharp('[]'),
        'public class Root\n{\n    public object[] Items { get; set; }\n}', '顶层空数组');
      assert.eq(jsonToCSharp('42'),
        'public class Root\n{\n    public int Value { get; set; }\n}', '顶层标量');

      /* ---------- 边界 ---------- */
      assert.eq(jsonToCSharp(''), '', '空输入输出空串');
      assert.eq(jsonToCSharp('   '), '', '纯空白输出空串');
      assert.eq(jsonToCSharp('{}'), 'public class Root\n{\n}', '空对象 → 空 class');
      assert.eq(jsonToCSharp('{"a":{}}'),
        'public class Root\n{\n    public A A { get; set; }\n}\n\npublic class A\n{\n}',
        '空对象字段也出一个空 class');
      assert.eq(jsonToCSharp('{"a-b":1,"a_b":2}'),
        'public class Root\n{\n    public int AB { get; set; }\n    public int AB2 { get; set; }\n}',
        '同一个类里成员名不能重样');
      assert.eq(escapeCSharpString('a"b\\c'), 'a\\"b\\\\c', '特性里的字符串要转义');

      /* ---------- 非法 JSON ---------- */
      var threw = false;
      try { jsonToCSharp('{"a":'); } catch (e) { threw = true; }
      assert(threw, '非法 JSON 抛错');
      threw = false;
      try { jsonToCSharp('not json'); } catch (e) { threw = true; }
      assert(threw, '不是 JSON 的输入抛错');
      var msg = '';
      try { jsonToCSharp('{"a":1,}'); } catch (e) { msg = String(e && e.message); }
      assert(msg.indexOf('position') !== -1, 'JSON.parse 的原始报错带位置信息：' + msg);
    }
  };
})();
