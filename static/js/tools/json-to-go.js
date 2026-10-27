/* ==========================================================================
   JSON 转 Go 类型（json-to-go）

   把一份 JSON 变成 Go 的类型定义（struct / type）。
   核心算法来自 mholt/json-to-go，it-tools 上游 PR 1031 把它搬进了 Vue 版。

   参考实现：src/tools/json-to-go/（it-tools, GPLv3）
   与原版的差别：
   1. **float hack 不再破坏字符串**。上游在 JSON.parse 之前用一条正则把
      「: 1.0」改成「: 1.1」（JSON 分不清 1 和 1.0，得靠文本层逼出浮点），
      但那条正则不认字符串字面量，字符串里的 ": 1.0" 会被一起改掉。
      这里先把原文按字符串字面量切成段，只在**非字符串**片段上做同样的替换 ——
      数值的行为与上游逐字节一致（golden 测试里的 -1.00 → -1.1 就是这么来的），
      字符串里的内容则原样保留。
   2. **Unicode 键不再变成 NAMING_FAILED**。上游把非 [a-z0-9] 的字符全删光，
      中文键删完就空了 → NAMING_FAILED（不是合法 Go 标识符）。
      这里 ASCII 删空了再退一步：保留 Unicode 字母/数字（Go 标识符本来就认），
      再空才用 Field。
   3. **数组套数组不再生成非法 Go**。上游 flatten 模式把 slice 的元素类型写成
      「[]父类型」，数组套数组会得到 []A[]int —— A 还是个从没定义过的类型。
      这里只有「元素是结构体」时才用「[]父类型」。
   4. **int32 的边界修掉了**。上游写的是 val > -2147483648 && val < 2147483647，
      恰好把 int32 的两个端点（-2147483648 与 2147483647）排除在外，
      而这两个值本来装得下 int32。
   5. **flatten 模式也支持 Example 开关**。上游只在 inline 分支里加 example，
      两种模式的输出对不上。
   6. **json tag 里的引号/反斜杠做了转义**（键名与 example 值都转义）。
      上游直接把原始值塞进 tag，值里有引号就会把 tag 拆坏。
   7. **键名撞上 Object.prototype 上的属性名**（toString / constructor / …）时不再乱掉。
      上游用 `key in allFields` 判断「已存在」，继承来的属性也算数。
   8. **uuid 走 U.randomInt**（crypto.getRandomValues），不用 Math.random。

   ------------------------------------------------------------------------
   对象键顺序：**JS 语义**（ECMAScript ordinary own property keys）——
     · 形如数组下标的整数键（"0"、"1"、"42"…，且小于 2^32-1）排在最前面，按数值升序；
     · 其余字符串键按插入顺序。
   JSON.parse 造出来的对象本身就是这个顺序，Object.keys() 直接可用，不需要归一化。
   （Rust 的 serde_json 默认 BTreeMap 是字典序、preserve_order 才是插入序，
     两者都不是这个顺序 —— 那边要自己写归一化。）

   ------------------------------------------------------------------------
   类型推断（与上游的差异也写在这里）：
     · bool        → bool
     · 整数        → int（int32 范围）/ int64 / uint64（超出 int64 且不超过 2^64）
                    —— 上游只有 int / int64，超出 int64 的一律 int64
     · 小数        → float64
     · 字符串      → string；长得像 ISO-8601 时间戳的（上游就有这条规则）→ time.Time
     · 数组        → []T
     · 对象        → struct（上游不做 map[string]T：JSON 对象的键是已知的，用 struct 更贴切）
     · null / 混不拢 → any（上游用 any 而不是 interface{}：any 是 Go 1.18 起的别名）
     · 不生成指针（上游也不生成）
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-to-go');

  /* ==================================================================
     小工具
     ================================================================== */

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /**
   * 把源码按「字符串字面量 / 非字符串」切成若干段。
   *
   * 只需要知道「哪些字符在字符串里」，不用真的把字符串解析出来。
   * 反斜杠转义会把下一个字符无条件带走（哪怕它就是引号本身）。
   *
   * @param {string} src
   * @returns {Array<{text: string, str: boolean}>}
   */
  function splitOutsideStrings(src) {
    var segs = [];
    var buf = '';
    var i = 0;
    var n = src.length;
    var inStr = false;

    while (i < n) {
      var c = src.charAt(i);
      if (inStr) {
        buf += c;
        if (c === '\\') {
          if (i + 1 < n) buf += src.charAt(i + 1);
          i += 2;
          continue;
        }
        if (c === '"') {
          // 字符串整段（含两端的引号）单独成一段
          segs.push({ text: buf, str: true });
          buf = '';
          inStr = false;
        }
        i++;
        continue;
      }
      if (c === '"') {
        segs.push({ text: buf, str: false });
        buf = '"';            // 开引号属于字符串段
        inStr = true;
        i++;
        continue;
      }
      buf += c;
      i++;
    }
    segs.push({ text: buf, str: inStr });   // 没闭合的字符串也整段保住
    return segs;
  }

  /**
   * 上游那个「文本级 float hack」。
   *
   * JSON 本身分不清 1 和 1.0，但用户写了 1.0 就是想要 float64。
   * 上游的办法是在解析前把文本里的「.0」改成「.1」，逼出浮点 ——
   * 副作用是数值本身被改掉（-1.00 → -1.1），而 golden 测试的期望值正是按
   * 这个副作用写的，所以这里必须一模一样地改。
   *
   * 唯一的改动：只在**非字符串**片段上做替换。上游那条正则不认字符串，
   * 于是 '{"a":"x: 1.0"}' 里的字面量会被一起改掉。
   * 匹配式 `(:\s*\[?\s*-?\d*)\.0` 里没有一个字符可能是字符串的一部分，
   * 所以它不可能跨过片段边界 —— 分段替换与整段替换等价。
   *
   * @param {string} src
   * @returns {string}
   */
  function hackFloats(src) {
    var segs = splitOutsideStrings(String(src == null ? '' : src));
    var out = '';
    for (var i = 0; i < segs.length; i++) {
      out += segs[i].str ? segs[i].text : segs[i].text.replace(/(:\s*\[?\s*-?\d*)\.0/g, '$1.1');
    }
    return out;
  }

  /**
   * 转义 Go struct tag 里 interpreted string literal 的特殊字符。
   * tag 是反引号包着的，里面那对双引号里还得再转义一层。
   * @param {*} value
   * @returns {string}
   */
  function escapeTagText(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * 把一个字符串洗成合法的 Go 标识符（不含首字母大写之类的规矩）。
   *
   * 上游只留 [a-z0-9]，别的全删 —— 中文键删完就空了。
   * 这里 ASCII 删空了再退一步：Go 标识符本来就接受 Unicode 字母与数字，
   * 所以把它们留下（首字母大小写对非拉丁文字没有意义）。
   *
   * @param {string} str
   * @returns {string} 可能为空串（调用方要处理）
   */
  function sanitizeIdentifier(str) {
    var ascii = String(str).replace(/[^a-z0-9]/ig, '');
    if (ascii) return ascii;

    var unicode = Array.from(String(str)).filter(function (ch) {
      return /\p{L}|\p{Nd}/u.test(ch);
    }).join('');
    return unicode;
  }

  /**
   * 生成一个唯一的字段名：跟已有重名时在后面追加数字。
   * 上游是从 0 开始追加（Name → Name0），这里保持一致。
   *
   * @param {string} name
   * @param {string[]} seen
   * @returns {string}
   */
  function uniqueTypeName(name, seen) {
    if (seen.indexOf(name) === -1) return name;
    var i = 0;
    for (;;) {
      var newName = name + String(i);
      if (seen.indexOf(newName) === -1) return newName;
      i++;
    }
  }

  /**
   * 数字开头的标识符不合法，给它加个前缀。
   * @param {string} str
   * @returns {string}
   */
  function formatNumber(str) {
    if (!str) return '';
    if (/^\d+$/.test(str)) return 'Num' + str;
    if (/\d/.test(str.charAt(0))) {
      var numbers = {
        0: 'Zero_', 1: 'One_', 2: 'Two_', 3: 'Three_', 4: 'Four_',
        5: 'Five_', 6: 'Six_', 7: 'Seven_', 8: 'Eight_', 9: 'Nine_'
      };
      str = numbers[str.charAt(0)] + str.substr(1);
    }
    return str;
  }

  /**
   * 按 Go 的习惯把字符串转成 ProperCase。
   * @param {string} str
   * @returns {string}
   */
  function toProperCase(str) {
    // SCREAMING_SNAKE_CASE 先转成 snake_case
    if (/^[_A-Z0-9]+$/.test(str)) str = str.toLowerCase();

    // https://github.com/golang/lint/blob/5614ed5bae6fb75893070bdc0996a68765fdd275/lint.go#L771-L810
    var commonInitialisms = [
      'ACL', 'API', 'ASCII', 'CPU', 'CSS', 'DNS', 'EOF', 'GUID', 'HTML', 'HTTP',
      'HTTPS', 'ID', 'IP', 'JSON', 'LHS', 'QPS', 'RAM', 'RHS', 'RPC', 'SLA',
      'SMTP', 'SQL', 'SSH', 'TCP', 'TLS', 'TTL', 'UDP', 'UI', 'UID', 'UUID',
      'URI', 'URL', 'UTF8', 'VM', 'XML', 'XMPP', 'XSRF', 'XSS'
    ];

    return str.replace(/(^|[^a-zA-Z])([a-z]+)/g, function (unused, sep, frag) {
      if (commonInitialisms.indexOf(frag.toUpperCase()) !== -1) {
        return sep + frag.toUpperCase();
      }
      return sep + frag.charAt(0).toUpperCase() + frag.substr(1).toLowerCase();
    }).replace(/([A-Z])([a-z]+)/g, function (unused, sep, frag) {
      if (commonInitialisms.indexOf((sep + frag).toUpperCase()) !== -1) {
        return (sep + frag).toUpperCase();
      }
      return sep + frag;
    });
  }

  /**
   * 洗成合法的 Go 字段名。
   * @param {*} str
   * @returns {string}
   */
  function format(str) {
    str = formatNumber(str);

    var sanitized = sanitizeIdentifier(toProperCase(str));
    if (!sanitized) return 'Field';        // 上游这里返回 NAMING_FAILED（不是合法标识符）

    // 洗完之后可能以数字开头，再跑一遍 formatNumber：
    // 保证出来的是 Num0 / Zero_… 而不是 0。
    return formatNumber(sanitized);
  }

  /**
   * 判断一个值该是什么 Go 类型。
   * @param {*} val
   * @returns {string}
   */
  function goType(val) {
    if (val === null) return 'any';

    switch (typeof val) {
      case 'string':
        // 上游就有这条规则：长得像 ISO-8601 时间戳的字符串 → time.Time
        if (/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(\+\d\d:\d\d|Z)/.test(val)) return 'time.Time';
        return 'string';
      case 'number':
        if (val % 1 === 0) {
          if (val >= -2147483648 && val <= 2147483647) return 'int';
          if (val >= -9223372036854775808 && val <= 9223372036854775807) return 'int64';
          // 超出 int64 但还塞得进 uint64 的（JSON 数值精度有限，只当到 2^64）
          if (val > 0 && val < 18446744073709551616) return 'uint64';
          return 'int64';
        }
        return 'float64';
      case 'boolean':
        return 'bool';
      case 'object':
        return Array.isArray(val) ? 'slice' : 'struct';
      default:
        return 'any';
    }
  }

  /**
   * 两个类型混在一起时，取更具体的那个；实在合不了就 any。
   * @param {string} typ1
   * @param {string} typ2
   * @returns {string}
   */
  function mostSpecificPossibleGoType(typ1, typ2) {
    if (typ1.substr(0, 5) === 'float' && typ2.substr(0, 3) === 'int') return typ1;
    if (typ1.substr(0, 3) === 'int' && typ2.substr(0, 5) === 'float') return typ2;
    return 'any';
  }

  /**
   * 两个值是不是都是普通对象。
   */
  function compareObjects(objectA, objectB) {
    var object = '[object Object]';
    return Object.prototype.toString.call(objectA) === object &&
           Object.prototype.toString.call(objectB) === object;
  }

  /**
   * 两组键是不是同一组（不看顺序）。
   */
  function compareObjectKeys(itemAKeys, itemBKeys) {
    if (itemAKeys.length === 0 && itemBKeys.length === 0) return true;
    if (itemAKeys.length !== itemBKeys.length) return false;
    for (var i = 0; i < itemAKeys.length; i++) {
      if (itemBKeys.indexOf(itemAKeys[i]) === -1) return false;
    }
    return true;
  }

  /**
   * 键名洗一遍，用来比较两个结构是不是同一个形状。
   * @param {string[]} keys
   * @returns {string[]}
   */
  function formatScopeKeys(keys) {
    var out = [];
    for (var i = 0; i < keys.length; i++) out.push(format(keys[i]));
    return out;
  }

  /**
   * 上游给「形状不同但键名相同」的字段加的是 _<uuid> 后缀，
   * 写 tag 时要把这个后缀摘掉，还原成原来的 JSON 键。
   * @param {string} unique
   * @returns {string}
   */
  function getOriginalName(unique) {
    var reLiteralUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    var uuidLength = 36;

    if (unique.length >= uuidLength) {
      var tail = unique.substr(-uuidLength);
      if (reLiteralUUID.test(tail)) {
        return unique.slice(0, -1 * (uuidLength + 1));
      }
    }
    return unique;
  }

  /**
   * uuid v4（上游用来给「形状不同」的字段名加后缀）。
   * 随机数走 crypto.getRandomValues，不用 Math.random。
   * @returns {string}
   */
  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = U.randomInt(16);
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /* ==================================================================
     主函数
     ================================================================== */

  /**
   * JSON → Go 类型定义。
   *
   * @param {string} json              JSON 文本
   * @param {string} [typename]        顶层类型名，默认 AutoGenerated
   * @param {boolean} [flatten]         true = 嵌套结构体拆成独立的 type（上游的 flatten）
   *                                    false = 嵌套结构体内联（默认，也是上游界面的默认）
   * @param {boolean} [example]         是否在 json tag 里附上示例值
   * @param {boolean} [allOmitempty]    是否给所有字段加 ,omitempty
   * @returns {{go: string, error: (Error|null)}}
   */
  function jsonToGo(json, typename, flatten, example, allOmitempty) {
    var data;
    var scope;
    var go = '';
    var tabs = 0;
    var seen = {};
    var stack = [];
    var accumulator = '';
    var innerTabs = 0;
    var parent = '';

    var src = String(json == null ? '' : json);
    if (!src.trim()) return { go: '', error: null };

    try {
      data = JSON.parse(hackFloats(src));
      scope = data;
    } catch (e) {
      return { go: '', error: e };
    }

    typename = format(typename || 'AutoGenerated');
    append('type ' + typename + ' ');

    parseScope(scope);

    return {
      go: flatten ? go + accumulator : go,
      error: null
    };

    function parseScope(scope, depth) {
      depth = depth || 0;

      if (typeof scope === 'object' && scope !== null) {
        if (Array.isArray(scope)) {
          var sliceType;
          var scopeLength = scope.length;

          for (var i = 0; i < scopeLength; i++) {
            var thisType = goType(scope[i]);
            if (!sliceType) {
              sliceType = thisType;
            }
            else if (sliceType !== thisType) {
              sliceType = mostSpecificPossibleGoType(thisType, sliceType);
              if (sliceType === 'any') break;
            }
          }

          // 只有「元素是结构体」才用 []父类型。
          // 上游把 slice（数组套数组）也算进去，会得到 []A[]int —— A 根本没定义过。
          var slice = (flatten && sliceType === 'struct') ? '[]' + parent : '[]';

          if (flatten && depth >= 2) appender(slice);
          else append(slice);

          if (sliceType === 'struct') {
            // 数组里每个元素都是对象：把它们的字段并成一个结构体，
            // 并记录哪些字段不是每个元素都有（→ ,omitempty）
            var allFields = {};

            for (var j = 0; j < scopeLength; j++) {
              var keys = Object.keys(scope[j]);
              for (var k = 0; k < keys.length; k++) {
                var keyname = keys[k];
                if (!hasOwn(allFields, keyname)) {
                  allFields[keyname] = { value: scope[j][keyname], count: 0 };
                }
                else {
                  var existingValue = allFields[keyname].value;
                  var currentValue = scope[j][keyname];

                  if (compareObjects(existingValue, currentValue)) {
                    // 键名一样但里面的结构不一样 → 加个 uuid 后缀区分开
                    var sameShape = compareObjectKeys(Object.keys(currentValue), Object.keys(existingValue));
                    if (!sameShape) {
                      keyname = keyname + '_' + uuidv4();
                      allFields[keyname] = { value: currentValue, count: 0 };
                    }
                  }
                }
                allFields[keyname].count++;
              }
            }

            var allKeys = Object.keys(allFields);
            var struct = {};
            var omitempty = {};
            for (var m = 0; m < allKeys.length; m++) {
              var name = allKeys[m];
              var elem = allFields[name];
              struct[name] = elem.value;
              omitempty[name] = elem.count !== scopeLength;
            }
            parseStruct(depth + 1, innerTabs, struct, omitempty);
          }
          else if (sliceType === 'slice') {
            parseScope(scope[0], depth);
          }
          else {
            if (flatten && depth >= 2) appender(sliceType || 'any');
            else append(sliceType || 'any');
          }
        }
        else {
          if (flatten) {
            if (depth >= 2) appender(parent);
            else append(parent);
          }
          parseStruct(depth + 1, innerTabs, scope, undefined);
        }
      }
      else {
        if (flatten && depth >= 2) appender(goType(scope));
        else append(goType(scope));
      }
    }

    function parseStruct(depth, innerTabsArg, scope, omitempty) {
      if (flatten) {
        if (depth !== undefined) {
          stack.push(depth >= 2 ? '\n' : '');
        }
      }

      var seenTypeNames = [];

      if (flatten && depth !== undefined && depth >= 2) {
        // 嵌套类型：单独一个 type 定义，字段类型写它的名字
        var parentType = 'type ' + parent;
        var scopeKeys = formatScopeKeys(Object.keys(scope));

        // 同一个类型名已经定义过、形状也一样 → 不用再定义一遍
        if (hasOwn(seen, parent) && compareObjectKeys(scopeKeys, seen[parent])) {
          stack.pop();
          return;
        }
        seen[parent] = scopeKeys;

        appender(parentType + ' struct {\n');
        ++innerTabsArg;
        var keys = Object.keys(scope);
        for (var i = 0; i < keys.length; i++) {
          var keyname = getOriginalName(keys[i]);
          indenter(innerTabsArg);
          var typename = uniqueTypeName(format(keyname), seenTypeNames);
          seenTypeNames.push(typename);

          appender(typename + ' ');
          parent = typename;
          parseScope(scope[keys[i]], depth);
          // tag 的收尾引号由最后那行 '"`\n' 补上 —— 上游就是这个写法，
          // 闭合引号要排在 example 之后，所以这里不能提前写。
          appender(' `json:"' + escapeTagText(keyname));
          if (allOmitempty || (omitempty && omitempty[keys[i]] === true)) appender(',omitempty');
          appendExample(scope[keys[i]], appender);
          appender('"`\n');
        }
        indenter(--innerTabsArg);
        appender('}');
      }
      else {
        // 内联结构体
        append('struct {\n');
        ++tabs;
        var keys2 = Object.keys(scope);
        for (var j = 0; j < keys2.length; j++) {
          var keyname2 = getOriginalName(keys2[j]);
          indent(tabs);
          var typename2 = uniqueTypeName(format(keyname2), seenTypeNames);
          seenTypeNames.push(typename2);
          append(typename2 + ' ');
          parent = typename2;
          parseScope(scope[keys2[j]], depth);
          append(' `json:"' + escapeTagText(keyname2));
          if (allOmitempty || (omitempty && omitempty[keys2[j]] === true)) append(',omitempty');
          appendExample(scope[keys2[j]], append);
          append('"`\n');
        }
        indent(--tabs);
        append('}');
      }

      if (flatten) {
        accumulator += stack.pop();
      }
    }

    /**
     * example 开关：给 json tag 补一个示例值（对象/数组与空串除外）。
     * @param {*} value 字段的原始值
     * @param {function(string)} write 往哪儿写：内联模式写 go，flatten 模式写栈
     */
    function appendExample(value, write) {
      if (!example) return;
      if (value === '' || typeof value === 'object') return;
      write('" example:"' + escapeTagText(value));
    }

    function indent(n) {
      for (var i = 0; i < n; i++) go += '\t';
    }

    function append(s) {
      go += s;
    }

    function indenter(n) {
      for (var i = 0; i < n; i++) stack[stack.length - 1] += '\t';
    }

    function appender(s) {
      stack[stack.length - 1] += s;
    }
  }

  /* ==================================================================
     界面
     ================================================================== */

  window.ItTools.register('json-to-go', function (root) {
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

    // 三个开关都跟上游界面一一对应，没有自己发明的：
    //   inline  —— 上游的 "Inline type definitions"（默认开 → 嵌套结构体内联）
    //   omitempty —— 上游的 "Omit Empty"
    //   example —— 上游的 "Example"
    var inlineInput = D.h('input', { type: 'checkbox', checked: 'checked' });
    var omitEmptyInput = D.h('input', { type: 'checkbox' });
    var exampleInput = D.h('input', { type: 'checkbox' });

    function render() {
      var raw = input.value;
      if (!raw.trim()) {
        output.value = '';
        status.textContent = t('status_empty', 'Type or paste some JSON above.');
        status.className = 'form-status';
        return;
      }
      var result = jsonToGo(
        raw,
        '',
        !inlineInput.checked,     // 上游：definitions 开 → flatten 关
        exampleInput.checked,
        omitEmptyInput.checked
      );
      if (result.error) {
        output.value = '';
        status.className = 'form-status is-error';
        status.textContent = t('err_invalid', 'Provided JSON is not valid.') + ' ' +
          String((result.error && result.error.message) || result.error);
        return;
      }
      output.value = result.go;
      status.textContent = '';
      status.className = 'form-status';
    }

    var offInput = D.on(input, 'input', render);
    var offInline = D.on(inlineInput, 'change', render);
    var offOmit = D.on(omitEmptyInput, 'change', render);
    var offExample = D.on(exampleInput, 'change', render);

    root.appendChild(D.h('div.card', null,
      D.h('div.switch-grid', null,
        D.h('label.switch', null, inlineInput, D.h('span', { text: t('inline_types', 'Inline type definitions') })),
        D.h('label.switch', null, omitEmptyInput, D.h('span', { text: t('omit_empty', 'Omit empty') })),
        D.h('label.switch', null, exampleInput, D.h('span', { text: t('example', 'Example') }))
      ),
      U.field(t('input', 'Your JSON'), input, { wide: true }),
      status,
      D.h('p.field-hint', {
        text: t('hint',
          'Generates Go type definitions from JSON. Booleans become bool, whole numbers int / int64 / uint64, decimals float64, and strings that look like ISO-8601 timestamps become time.Time (remember to import "time"). Field names follow Go conventions and every field keeps its original JSON key in a json tag.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('output', 'Your Go String') }),
        U.copyButton(function () { return output.value; }, t('copy_go', 'Copy Go'))
      ),
      output
    ));

    render();

    return {
      destroy: function () {
        offInput();
        offInline();
        offOmit();
        offExample();
        D.clear(root);
      }
    };
  });

  /* ==================================================================
     单测用的纯逻辑
     ================================================================== */

  window.ItTools.logic['json-to-go'] = {
    jsonToGo: jsonToGo,
    hackFloats: hackFloats,
    format: format,
    formatNumber: formatNumber,
    toProperCase: toProperCase,
    goType: goType,
    sanitizeIdentifier: sanitizeIdentifier,
    escapeTagText: escapeTagText,
    splitOutsideStrings: splitOutsideStrings,
    __cases: function (assert) {
      /* ================================================================
         上游那 18 例 golden 测试（逐字节照抄上游的期望输出）
         ================================================================ */

      // 1
      assert.eq(jsonToGo('{"SourceCode": "exampleDataHere"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tSourceCode string `json:"SourceCode"`\n}', 'golden 1：SourceCode');
      assert.eq(jsonToGo('{"SourceCode": "exampleDataHere"}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tSourceCode string `json:"SourceCode" example:"exampleDataHere"`\n}',
        'golden 1（带 example）');

      // 2
      assert.eq(jsonToGo('{"source_code": "exampleDataHere"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tSourceCode string `json:"source_code"`\n}', 'golden 2：snake_case');
      assert.eq(jsonToGo('{"source_code": "exampleDataHere"}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tSourceCode string `json:"source_code" example:"exampleDataHere"`\n}',
        'golden 2（带 example）');

      // 3
      assert.eq(jsonToGo('{"sourceCode": "exampleDataHere"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tSourceCode string `json:"sourceCode"`\n}', 'golden 3：camelCase');
      assert.eq(jsonToGo('{"sourceCode": "exampleDataHere"}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tSourceCode string `json:"sourceCode" example:"exampleDataHere"`\n}',
        'golden 3（带 example）');

      // 4
      assert.eq(jsonToGo('{"SOURCE_CODE": ""}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tSourceCode string `json:"SOURCE_CODE"`\n}', 'golden 4：SCREAMING_SNAKE_CASE');
      assert.eq(jsonToGo('{"SOURCE_CODE": ""}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tSourceCode string `json:"SOURCE_CODE"`\n}',
        'golden 4（带 example）：空串没有示例值');

      // 5
      assert.eq(jsonToGo('{"PublicIP": ""}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tPublicIP string `json:"PublicIP"`\n}', 'golden 5：PublicIP');
      assert.eq(jsonToGo('{"PublicIP": ""}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tPublicIP string `json:"PublicIP"`\n}',
        'golden 5（带 example）：空串没有示例值');

      // 6
      assert.eq(jsonToGo('{"public_ip": ""}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tPublicIP string `json:"public_ip"`\n}', 'golden 6：public_ip');
      assert.eq(jsonToGo('{"public_ip": ""}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tPublicIP string `json:"public_ip"`\n}',
        'golden 6（带 example）：空串没有示例值');

      // 7
      assert.eq(jsonToGo('{"publicIP": ""}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tPublicIP string `json:"publicIP"`\n}', 'golden 7：publicIP');
      assert.eq(jsonToGo('{"publicIP": ""}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tPublicIP string `json:"publicIP"`\n}',
        'golden 7（带 example）：空串没有示例值');

      // 8
      assert.eq(jsonToGo('{"PUBLIC_IP": ""}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tPublicIP string `json:"PUBLIC_IP"`\n}', 'golden 8：PUBLIC_IP');
      assert.eq(jsonToGo('{"PUBLIC_IP": ""}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tPublicIP string `json:"PUBLIC_IP"`\n}',
        'golden 8（带 example）：空串没有示例值');

      // 9
      assert.eq(jsonToGo('{"+1": "Fails", "-1": "This should not cause duplicate field name"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tNum1 string `json:"+1"`\n\tNum10 string `json:"-1"`\n}',
        'golden 9：数字开头的键不重名');
      assert.eq(jsonToGo('{"+1": "Fails", "-1": "This should not cause duplicate field name"}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tNum1 string `json:"+1" example:"Fails"`\n\tNum10 string `json:"-1" example:"This should not cause duplicate field name"`\n}',
        'golden 9（带 example）');

      // 10
      assert.eq(jsonToGo('{"age": 46}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tAge int `json:"age"`\n}', 'golden 10：整数 → int');
      assert.eq(jsonToGo('{"age": 46}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tAge int `json:"age" example:"46"`\n}', 'golden 10（带 example）');

      // 11
      assert.eq(jsonToGo('{"negativeFloat": -1.00}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tNegativeFloat float64 `json:"negativeFloat"`\n}', 'golden 11：负小数 → float64');
      assert.eq(jsonToGo('{"negativeFloat": -1.00}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tNegativeFloat float64 `json:"negativeFloat" example:"-1.1"`\n}',
        'golden 11（带 example）：float hack 把 -1.00 改成 -1.1');

      // 12
      assert.eq(jsonToGo('{"zeroFloat": 0.00}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tZeroFloat float64 `json:"zeroFloat"`\n}', 'golden 12：零小数 → float64');
      assert.eq(jsonToGo('{"zeroFloat": 0.00}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tZeroFloat float64 `json:"zeroFloat" example:"0.1"`\n}',
        'golden 12（带 example）：float hack 把 0.00 改成 0.1');

      // 13
      assert.eq(jsonToGo('{"positiveFloat": 1.00}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tPositiveFloat float64 `json:"positiveFloat"`\n}', 'golden 13：小数 → float64');
      assert.eq(jsonToGo('{"positiveFloat": 1.00}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tPositiveFloat float64 `json:"positiveFloat" example:"1.1"`\n}',
        'golden 13（带 example）：float hack 把 1.00 改成 1.1');

      // 14
      assert.eq(jsonToGo('{"negativeFloats": [-1.00, -2.00, -3.00]}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tNegativeFloats []float64 `json:"negativeFloats"`\n}', 'golden 14：负小数数组');
      assert.eq(jsonToGo('{"negativeFloats": [-1.00, -2.00, -3.00]}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tNegativeFloats []float64 `json:"negativeFloats"`\n}',
        'golden 14（带 example）：数组没有示例值');

      // 15
      assert.eq(jsonToGo('{"zeroFloats": [0.00, 0.00, 0.00]}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tZeroFloats []float64 `json:"zeroFloats"`\n}', 'golden 15：零小数数组');
      assert.eq(jsonToGo('{"zeroFloats": [0.00, 0.00, 0.00]}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tZeroFloats []float64 `json:"zeroFloats"`\n}',
        'golden 15（带 example）：数组没有示例值');

      // 16
      assert.eq(jsonToGo('{"positiveFloats": [1.00, 2.00, 3.00]}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tPositiveFloats []float64 `json:"positiveFloats"`\n}', 'golden 16：小数数组');
      assert.eq(jsonToGo('{"positiveFloats": [1.00, 2.00, 3.00]}', '', false, true, false).go,
        'type AutoGenerated struct {\n\tPositiveFloats []float64 `json:"positiveFloats"`\n}',
        'golden 16（带 example）：数组没有示例值');

      // 17
      assert.eq(jsonToGo('{"topLevel": { "secondLevel": "exampleDataHere"} }', '', false, false, false).go,
        'type AutoGenerated struct {\n\tTopLevel struct {\n\t\tSecondLevel string `json:"secondLevel"`\n\t} `json:"topLevel"`\n}',
        'golden 17：嵌套对象内联');
      assert.eq(jsonToGo('{"topLevel": { "secondLevel": "exampleDataHere"} }', '', false, true, false).go,
        'type AutoGenerated struct {\n\tTopLevel struct {\n\t\tSecondLevel string `json:"secondLevel" example:"exampleDataHere"`\n\t} `json:"topLevel"`\n}',
        'golden 17（带 example）');

      // 18
      assert.eq(jsonToGo('{"people": [{ "name": "Frank"}, {"name": "Dennis"}, {"name": "Dee"}, {"name": "Charley"}, {"name":"Mac"}] }', '', false, false, false).go,
        'type AutoGenerated struct {\n\tPeople []struct {\n\t\tName string `json:"name"`\n\t} `json:"people"`\n}',
        'golden 18：对象数组');
      assert.eq(jsonToGo('{"people": [{ "name": "Frank"}, {"name": "Dennis"}, {"name": "Dee"}, {"name": "Charley"}, {"name":"Mac"}] }', '', false, true, false).go,
        'type AutoGenerated struct {\n\tPeople []struct {\n\t\tName string `json:"name" example:"Frank"`\n\t} `json:"people"`\n}',
        'golden 18（带 example）');

      /* ================================================================
         边界情况
         ================================================================ */

      // 空输入 / 空对象 / 空数组
      assert.eq(jsonToGo('', '', false, false, false).go, '', '空输入输出空串');
      assert.eq(jsonToGo('   ', '', false, false, false).go, '', '纯空白输出空串');
      assert.eq(jsonToGo('{}', '', false, false, false).go, 'type AutoGenerated struct {\n}', '空对象 → 空 struct');
      assert.eq(jsonToGo('{"a":[]}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA []any `json:"a"`\n}', '空数组 → []any');
      assert.eq(jsonToGo('[]', '', false, false, false).go, 'type AutoGenerated []any', '顶层空数组');
      assert.eq(jsonToGo('{"a":{}}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA struct {\n\t} `json:"a"`\n}', '空对象字段 → 空 struct');

      // 深层嵌套
      assert.eq(jsonToGo('{"a":{"b":{"c":{"d":"e"}}}}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA struct {\n\t\tB struct {\n\t\t\tC struct {\n\t\t\t\tD string `json:"d"`\n\t\t\t} `json:"c"`\n\t\t} `json:"b"`\n\t} `json:"a"`\n}',
        '四层嵌套');

      // 特殊字符键
      assert.eq(jsonToGo('{"a-b":"x"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tAB string `json:"a-b"`\n}', '连字符被删掉');
      assert.eq(jsonToGo('{"a b":"x"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tAB string `json:"a b"`\n}', '空格被删掉');
      assert.eq(jsonToGo('{"!@#$":"x"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tField string `json:"!@#$"`\n}', '全是符号 → Field');
      assert.eq(jsonToGo('{"名字":"x"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\t名字 string `json:"名字"`\n}', '中文键保留（上游是 NAMING_FAILED）');
      assert.eq(jsonToGo('{"a\\"b":"x"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tAB string `json:"a\\"b"`\n}', '键里的引号被转义');

      // 保留字键（Go 关键字全是小写，ProperCase 之后就不是关键字了）
      assert.eq(jsonToGo('{"type":"a","func":"b","range":"c","string":"d"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tType string `json:"type"`\n\tFunc string `json:"func"`\n\tRange string `json:"range"`\n\tString string `json:"string"`\n}',
        'Go 关键字做键名');

      // null 值
      assert.eq(jsonToGo('{"a":null}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA any `json:"a"`\n}', 'null → any');
      assert.eq(jsonToGo('{"a":null,"b":1}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA any `json:"a"`\n\tB int `json:"b"`\n}', 'null 旁边还有别的字段');

      // 类型推断
      assert.eq(jsonToGo('{"a":true,"b":1,"c":1.5,"d":"x"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA bool `json:"a"`\n\tB int `json:"b"`\n\tC float64 `json:"c"`\n\tD string `json:"d"`\n}',
        'bool / int / float64 / string');
      assert.eq(jsonToGo('{"a":2147483647}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA int `json:"a"`\n}', 'int32 上界仍是 int');
      assert.eq(jsonToGo('{"a":-2147483648}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA int `json:"a"`\n}', 'int32 下界仍是 int');
      assert.eq(jsonToGo('{"a":2147483648}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA int64 `json:"a"`\n}', '超出 int32 → int64');
      assert.eq(jsonToGo('{"a":1e19}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA uint64 `json:"a"`\n}', '超出 int64 → uint64');
      assert.eq(jsonToGo('{"a":"2024-01-02T03:04:05Z"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA time.Time `json:"a"`\n}', 'ISO 时间戳 → time.Time');
      assert.eq(jsonToGo('{"a":"2024-01-02T03:04:05.123+08:00"}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA time.Time `json:"a"`\n}', '带时区偏移的时间戳 → time.Time');
      assert.eq(jsonToGo('{"a":["x",1]}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tA []any `json:"a"`\n}', '数组里类型不一致 → []any');

      // 开关
      assert.eq(jsonToGo('{"a":"x"}', '', false, false, true).go,
        'type AutoGenerated struct {\n\tA string `json:"a,omitempty"`\n}', 'Omit empty 开关');
      assert.eq(jsonToGo('[{"a":1},{"b":2}]', '', false, false, true).go,
        'type AutoGenerated []struct {\n\tA int `json:"a,omitempty"`\n\tB int `json:"b,omitempty"`\n}',
        '数组里只有部分元素有的字段 → omitempty');

      // flatten（上游界面上的 "Inline type definitions" 关掉时走这条）
      assert.eq(jsonToGo('{"topLevel": { "secondLevel": "exampleDataHere"} }', '', true, false, false).go,
        'type AutoGenerated struct {\n\tTopLevel TopLevel `json:"topLevel"`\n}\ntype TopLevel struct {\n\tSecondLevel string `json:"secondLevel"`\n}',
        'flatten 模式：嵌套结构体拆成独立的 type');
      assert.eq(jsonToGo('{"people": [{"name":"Frank"}]}', '', true, false, false).go,
        'type AutoGenerated struct {\n\tPeople []People `json:"people"`\n}\ntype People struct {\n\tName string `json:"name"`\n}',
        'flatten 模式：对象数组');
      assert.eq(jsonToGo('{"a":[[1,2],[3]]}', '', true, false, false).go,
        'type AutoGenerated struct {\n\tA [][]int `json:"a"`\n}',
        'flatten 模式：数组套数组不再是非法的 []A[]int');

      // 顶层类型名
      assert.eq(jsonToGo('{"a":1}', 'User', false, false, false).go,
        'type User struct {\n\tA int `json:"a"`\n}', '自定义顶层类型名');

      // 非法 JSON
      var bad = jsonToGo('{"a":', '', false, false, false);
      assert(bad.go === '' && bad.error !== null, '非法 JSON 返回错误而不是输出');
      assert(jsonToGo('not json', '', false, false, false).error !== null, '不是 JSON 的输入返回错误');

      /* ================================================================
         键顺序：JS 语义（整数键升序在前，其余按插入顺序）
         ================================================================ */
      assert.eq(jsonToGo('{"b":1,"2":2,"a":3,"1":4}', '', false, false, false).go,
        'type AutoGenerated struct {\n\tNum1 int `json:"1"`\n\tNum2 int `json:"2"`\n\tB int `json:"b"`\n\tA int `json:"a"`\n}',
        '整数型键排前面且按数值升序，字符串键按插入顺序');

      /* ================================================================
         float hack 的边界
         ================================================================ */
      assert.eq(hackFloats('{"a": 1.00}'), '{"a": 1.10}', 'float hack 把 .0 改成 .1');
      assert.eq(hackFloats('{"a": "x: 1.00"}'), '{"a": "x: 1.00"}', '字符串里的内容不被改');
      assert.eq(hackFloats('{"a": 1.5}'), '{"a": 1.5}', '小数不以 0 开头就不动');
      assert.eq(hackFloats('{"a": 1.05}'), '{"a": 1.15}', '小数以 0 开头就把 0 换成 1');
      assert.eq(hackFloats('{"a": [1.00, 2.00]}'), '{"a": [1.10, 2.00]}',
        '只有冒号后面紧跟的那个数会被改（与上游一致）');
    }
  };
})();
