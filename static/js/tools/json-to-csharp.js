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
  var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

  /* ==================================================================
     名字：切词、大小写、标识符清洗
     ================================================================== */

  /**
   * 切词：把一个原始键名拆成一个个词。PascalCase / camelCase 都基于它。
   *
   * 切词规则：
   *   1. 分隔符：连字符、下划线、空格、点…… 一律不是 [A-Za-z0-9] 的字符都是分隔符；
   *   2. 驼峰边界：小写或数字后面跟一个大写 → 断开（fooBar → foo | Bar）；
   *   3. 缩写边界：大写 + 大写 + 小写 → 在后一个大写前断开（HTTPServer → HTTP | Server）；
   *   4. 数字边界：字母 ↔ 数字之间断开（foo2bar → foo | 2 | bar）。
   *
   * @param {string} str
   * @returns {string[]}
   */
  function splitWords(str) {
    var s = String(str == null ? '' : str);
    var words = [];
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (!/[A-Za-z0-9]/.test(ch)) {
        if (cur) { words.push(cur); cur = ''; }
        continue;
      }
      if (cur) {
        var prev = s.charAt(i - 1);
        var next = i + 1 < s.length ? s.charAt(i + 1) : '';
        var boundary = false;
        if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(ch)) {
          boundary = true;                                    // 驼峰边界
        } else if (/[A-Z]/.test(prev) && /[A-Z]/.test(ch) && /[a-z]/.test(next)) {
          boundary = true;                                    // 缩写边界
        } else if (/[0-9]/.test(prev) !== /[0-9]/.test(ch)) {
          boundary = true;                                    // 数字边界
        }
        if (boundary) { words.push(cur); cur = ''; }
      }
      cur += ch;
    }
    if (cur) words.push(cur);
    return words;
  }

  /**
   * PascalCase：每个词首字母大写、其余小写。
   * 数字开头的词保持数字开头（2fa → 2 | fa → 2Fa），后面再由 sanitizeIdentifier 补 _ 前缀。
   *
   * @param {string} str
   * @returns {string}
   */
  function toPascalCase(str) {
    var words = splitWords(str);
    var out = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var head = w.charAt(0);
      var tail = w.substr(1).toLowerCase();
      out += (head >= '0' && head <= '9') ? head + tail : head.toUpperCase() + tail;
    }
    return out;
  }

  /**
   * camelCase：跟 PascalCase 同样的切词，首词首字母小写。
   * 用来生成构造函数参数名 —— C# 的参数名是 camelCase 的。
   *
   * @param {string} str
   * @returns {string}
   */
  function toCamelCase(str) {
    var p = toPascalCase(str);
    if (!p) return p;
    var head = p.charAt(0);
    if (head >= '0' && head <= '9') return p;    // 数字开头没法小写开头
    return head.toLowerCase() + p.substr(1);
  }

  /**
   * 洗成合法的 C# 标识符：[A-Za-z_][A-Za-z0-9_]*。
   *
   *   1. 不是标识符字符的一律换成 _（连字符、点、空格、中文……）；
   *   2. 数字开头 → 加 _ 前缀；
   *   3. C# 关键字 → 加 @ 前缀。
   *
   * 空串给个 '_'，免得生成的东西没名字。
   *
   * @param {string} name
   * @returns {string}
   */
  function sanitizeIdentifier(name) {
    var s = String(name == null ? '' : name).replace(/[^A-Za-z0-9_]/g, '_');
    if (!s) s = '_';
    if (s.charAt(0) >= '0' && s.charAt(0) <= '9') s = '_' + s;
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
     ================================================================== */

  /** 是不是一个普通的 JSON 对象（不是数组、不是 null） */
  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  /**
   * 数字 → C# 数值类型。
   *
   * int 的范围是 int32；超出用 long；再超出（JSON 的双精度已经装不下 long 了）用 decimal。
   * 注意 long 的上界写的是 < 2^63：JS 的 number 是双精度，2^63 正好可表示，
   * 而 long.MaxValue 是 2^63-1，所以要用「小于 2^63」而不是「小于等于 long.MaxValue」。
   *
   * @param {number} n
   * @returns {string}
   */
  function numberType(n) {
    if (!Number.isInteger(n)) return 'double';
    if (n >= -2147483648 && n <= 2147483647) return 'int';
    if (n >= -9223372036854775808 && n < 9223372036854775808) return 'long';
    return 'decimal';
  }

  /** 字符串是不是 ISO-8601 日期/日期时间的形状 */
  function isIsoDate(str) {
    return ISO_DATE_RE.test(String(str == null ? '' : str));
  }

  /**
   * 标量值 → C# 类型。
   * reference 表示它是不是**引用类型**（可空引用类型开关只给引用类型加 ?）。
   * DateTime / int / bool / double 都是值类型，不能加 ?。
   *
   * @param {*} value
   * @returns {{kind: string, type: string, reference: boolean}}
   */
  function inferValueType(value) {
    if (value === null) return { kind: 'scalar', type: 'object', reference: true };
    switch (typeof value) {
      case 'boolean':
        return { kind: 'scalar', type: 'bool', reference: false };
      case 'number':
        return { kind: 'scalar', type: numberType(value), reference: false };
      case 'string':
        // DateTime 是**值类型**（不是可空引用类型那个 DateTime?），
        // 所以可空引用类型开关不能给它加 ?。
        return isIsoDate(value)
          ? { kind: 'scalar', type: 'DateTime', reference: false }
          : { kind: 'scalar', type: 'string', reference: true };
      default:
        return { kind: 'scalar', type: 'object', reference: true };
    }
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

  /**
   * 开一个新类：名字洗成合法标识符，跟已有的重名就加数字后缀。
   *
   * 重名是必然的：两个不同的键（"user-name" 与 "user_name"）转成同一个类名，
   * 生成两份一模一样的 class 编译不过。
   *
   * @param {{classes: Array, usedClassNames: Object}} ctx
   * @param {string} nameHint
   * @returns {{name: string, members: Array}}
   */
  function newClass(ctx, nameHint) {
    var base = sanitizeIdentifier(toPascalCase(nameHint));
    if (!base || base === '_') base = 'Root';
    var name = base;
    var i = 2;
    while (ctx.usedClassNames[name]) { name = base + i; i++; }
    ctx.usedClassNames[name] = true;
    var cls = { name: name, members: [] };
    ctx.classes.push(cls);
    return cls;
  }

  /** 同一个类里的成员名不能重样（C# 不允许），撞了就加数字后缀 */
  function uniqueMemberName(name, used) {
    var candidate = name;
    var i = 2;
    while (used[candidate]) { candidate = name + i; i++; }
    used[candidate] = true;
    return candidate;
  }

  /**
   * 一个 JSON 值对应的 C# 类型。
   * 对象在这里被展开成一个新 class（类名用属性名做提示）。
   *
   * @param {object} ctx
   * @param {*} value
   * @param {string} nameHint 生成类名时的提示（一般是属性名）
   * @param {object} opts
   * @returns {{kind: string, type: string, elementType: string, reference: boolean}}
   */
  function buildType(ctx, value, nameHint, opts) {
    if (value === null) return { kind: 'scalar', type: 'object', reference: true };

    if (Array.isArray(value)) {
      if (!value.length) {
        // 空数组：元素类型无从推断 → object[]
        return { kind: 'array', elementType: 'object', reference: true };
      }
      // 只看**第一个**元素：数组里元素类型不一致时没有公共类型可取，
      // 上游也是按第一个元素算的。与其编一个 object[]，不如给出最可能的类型。
      var elem = buildType(ctx, value[0], nameHint, opts);
      // 嵌套数组的元素类型固定写成 T[]（不跟只读列表开关走）——
      // 否则 IReadOnlyList<IReadOnlyList<T>> 的初始化 new List<…>() 没法写对。
      var elemName = elem.kind === 'array' ? elem.elementType + '[]' : elem.type;
      return { kind: 'array', elementType: elemName, reference: true };
    }

    if (isPlainObject(value)) {
      var cls = buildClass(ctx, value, nameHint, opts);
      return { kind: 'class', type: cls.name, reference: true };
    }

    return inferValueType(value);
  }

  /**
   * 把一个 JSON 对象展开成一个 class。
   *
   * @param {object} ctx
   * @param {object} obj
   * @param {string} nameHint
   * @param {object} opts
   * @returns {{name: string, members: Array}}
   */
  function buildClass(ctx, obj, nameHint, opts) {
    var cls = newClass(ctx, nameHint);
    var usedNames = Object.create(null);
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var type = buildType(ctx, obj[key], key, opts);
      var raw = opts.pascalCase ? toPascalCase(key) : String(key);
      var name = uniqueMemberName(sanitizeIdentifier(raw), usedNames);
      cls.members.push({
        jsonKey: key,
        name: name,
        type: type
      });
    }
    return cls;
  }

  /**
   * 顶层是一个数组时，按上游的约定把「元素类型」当根：
   * 元素是对象 → 元素类直接当根类；元素是标量 → 根类里放一个 T[] 的容器属性。
   *
   * @param {object} ctx
   * @param {*} data
   * @param {object} opts
   * @returns {{name: string, members: Array}}
   */
  function buildRoot(ctx, data, opts) {
    if (Array.isArray(data)) {
      if (!data.length) {
        var empty = newClass(ctx, opts.rootName);
        empty.members.push({
          jsonKey: null,
          name: 'Items',
          type: { kind: 'array', elementType: 'object', reference: true }
        });
        return empty;
      }
      if (isPlainObject(data[0])) {
        return buildClass(ctx, data[0], opts.rootName, opts);
      }
      var cls = newClass(ctx, opts.rootName);
      var elem = buildType(ctx, data[0], opts.rootName, opts);
      cls.members.push({
        jsonKey: null,
        name: 'Items',
        type: { kind: 'array', elementType: elem.type, reference: true }
      });
      return cls;
    }

    if (isPlainObject(data)) {
      return buildClass(ctx, data, opts.rootName, opts);
    }

    // 顶层是标量：根类里放一个标量属性
    var scalar = newClass(ctx, opts.rootName);
    scalar.members.push({
      jsonKey: null,
      name: 'Value',
      type: inferValueType(data)
    });
    return scalar;
  }

  /* ---------- 渲染 ---------- */

  /** 类型名（数组按开关写成 T[] 或 IReadOnlyList<T>） */
  function typeNameOf(type, opts) {
    if (type.kind !== 'array') return type.type;
    if (opts.useReadonlyLists) return 'IReadOnlyList<' + type.elementType + '>';
    return type.elementType + '[]';
  }

  /** 可空引用类型：只给引用类型加 ?（值类型加了就是 Nullable<T>，语义完全不同） */
  function nullableSuffix(type, opts) {
    if (!opts.useNullable) return '';
    return type.reference ? '?' : '';
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
    return ' = new List<' + type.elementType + '>()';
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
    if (member.jsonKey === null || member.jsonKey === undefined) return attrs;
    var escaped = escapeCSharpString(member.jsonKey);
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

    var ctx = { classes: [], usedClassNames: Object.create(null) };
    buildRoot(ctx, data, options);

    var out = [];
    for (var i = 0; i < ctx.classes.length; i++) {
      out.push(renderClass(ctx.classes[i], options));
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
