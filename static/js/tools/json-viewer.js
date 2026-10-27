/* ==========================================================================
   JSON 美化 / 查看器（json-viewer，路由 /json-prettify）

   把一段 JSON5 文本解析后重新缩进输出，可选按字母序排序对象的键。
   参考实现：src/tools/json-viewer/（it-tools, GPLv3）

   ---- 必做的 workaround：JSON5@2.2.3 的两个坑 ----
   1) 「块注释紧跟逗号就报错」。行注释没事，压缩版/非压缩版行为一致。
      所以解析前先自己把注释剥掉（stripJsonComments）。
   2) 这个 build 根本不支持 elision（两个连续逗号）—— `[1,,2]`、
      `[1, ,2]` 一律报 invalid character ','，跟有没有注释无关。
      坑 1 那个例子剥完注释正好变成双逗号，光删注释还是过不了。
      所以 stripJsonComments 里顺带把「两个逗号中间只隔着空白/注释」
      时多出来的那个逗号吃掉（见 push()）。

   ---- 与参考实现的差别 ----
   - sortObjectKeys 用 Object.defineProperty 而不是 `sortedObj[k] = v`。
     `__proto__` 是合法的 JSON 键，JSON.parse 用的是 define 语义，会把它
     建成普通自有属性；换成赋值就会写到原型上，键凭空消失。参考实现会丢数据。
   - 参考实现的 formatJson 内部直接 JSON5.parse 并在 computed 里用
     withDefaultOnError 吞掉异常（失败时输出空串，看不出错在哪）。这里改成
     解析失败时抛错，由 UI 显示 JSON5 的原始报错（含行列号），失败时输出清空。
   - 没有移植树形视图 / 折叠 / 搜索 / 大小写转换：参考实现（json-viewer.vue）
     本来也只有「排序 + 缩进 + 两个文本框」，工具名带 viewer 但实际是 prettifier
     （路由 /json-prettify、name_key 也是 tools.json-prettify.title）。
   - 补了自动反转义（上游 #1643）：日志和 API 返回里经常是「JSON 字符串里套着
     JSON」（"{\"a\":1}"），直接美化只会把它当成一个普通字符串输出。
     上游的做法是「无条件反转义」，那对已经合法的 JSON 是有损的
     （{"s":"a\"b"} 反转义后反而解析不了）。这里改成逐层试：哪一层能解出
     对象/数组就用那一层，解不出就退回原样，绝不丢数据。
   - 补了「修复 JSON」开关（上游 #1539）：见下面 repairJsonText 的注释。

   ---- 修复 JSON（上游 #1539）----
   上游的做法是：开关一开，**先把原文整个丢给 jsonrepair**，再用 JSON5.parse
   解析修好的文本。我们没有照抄 —— 理由与做法见 repairJsonText 的注释。
   ========================================================================== */

// 上面两个坑的实测样例（放块注释外面：块注释里不能出现注释符号本身）：
//   JSON5.parse('[1,/*x*/,2]')  → SyntaxError: invalid character ','
//   JSON5.parse('[1,,2]')       → SyntaxError: invalid character ','
//   JSON5.parse('[1,/*x*/2]')   → [1,2]   ← 逗号后面没第二个逗号才没事

(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-viewer');

  var DEFAULT_INDENT = 3;
  var MAX_INDENT = 10;

  /**
   * 剥掉 JSON / JSON5 里的注释：两个斜杠到行尾，或 斜杠+星号 到 星号+斜杠。
   *
   * 必须自己扫而不能用正则，因为字符串字面量里完全可能出现这些字符：
   *   {"url":"http://a[两个斜杠]b"}   {"s":"x[斜杠星]y[星斜杠]z"}
   * JSON5 还多一种单引号字符串。字符串里 `\` 会转义下一个字符（`\"` 不算
   * JSON5 还多一种单引号字符串。字符串里 `\` 会转义下一个字符（`\"` 不算
   * 字符串结束、`\\` 后面的引号才是），所以要带一个 escaped 标志。
   *
   * 顺带修 json5@2.2.3 不支持 elision 的问题（见文件头说明）。
   *
   * @param {string} src
   * @returns {string}
   */
  function stripJsonComments(src) {
    var s = src === null || src === undefined ? '' : String(src);
    var out = '';
    var n = s.length;
    var i = 0;
    var quote = '';       // '"' / '\''，空表示当前不在字符串里
    var escaped = false;  // 刚吃过一个反斜杠，下一个字符是字符串内容
    var inBlock = false;  // 在 /* */ 里

    function lastNonSpace(str) {
      for (var j = str.length - 1; j >= 0; j--) {
        var c = str.charAt(j);
        if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return c;
      }
      return '';
    }

    function push(ch) {
      if (ch === ',' && lastNonSpace(out) === ',') {
        // [1,/*c*/,2] 剥完是 [1,,2]，json5@2.2.3 不认 elision，丢掉第二个逗号
        return;
      }
      out += ch;
    }

    while (i < n) {
      var ch = s.charAt(i);

      if (inBlock) {
        if (ch === '*' && s.charAt(i + 1) === '/') { inBlock = false; i += 2; continue; }
        // 块注释里的换行要留着，不然 JSON5 报的行列号整体错位
        if (ch === '\n' || ch === '\r') out += ch;
        i++;
        continue;
      }

      if (quote) {
        out += ch;
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        i++;
        continue;
      }

      if (ch === '"' || ch === "'") { quote = ch; out += ch; i++; continue; }

      if (ch === '/' && s.charAt(i + 1) === '/') {
        i += 2;
        while (i < n && s.charAt(i) !== '\n' && s.charAt(i) !== '\r') i++;
        continue;
      }
      if (ch === '/' && s.charAt(i + 1) === '*') { inBlock = true; i += 2; continue; }

      push(ch);
      i++;
    }

    if (inBlock) throw new Error(t('err_unclosed_comment', 'Unclosed block comment'));
    return out;
  }

  /**
   * JSON5 解析入口：先剥注释，再交给 JSON5。
   *
   * 剥完注释还要过一遍 `guardBigIntegers`：超过 2^53-1 的整数字面量一进
   * JSON5 就被舍成相邻的浮点值（9223372036854775807 → 9223372036854776000），
   * 而且没有任何一步会报错 —— 美化一个订单号等于悄悄把它改掉。换成哨兵字符串
   * 让解析器绕开数值路径，格式化完再由 `formatJson` 还原回去。
   *
   * @param {string} raw
   * @returns {*} 解析结果
   */
  function parseJson(raw) {
    return JSON5.parse(U.guardBigIntegers(stripJsonComments(raw)));
  }

  /**
   * 反转义：把「JSON 字符串里套着 JSON」解开一层（上游 #1643）。
   *
   * 两种形态都处理：
   *   - 带外层引号：`"{\"a\":1}"` —— 直接按 JSON 字符串解析（JSON.parse）。
   *     这样 `\\`、`\uXXXX` 这些嵌套转义能一层层正确解开。
   *   - 不带外层引号：`{\"a\":1}` —— 手工单遍扫描。
   *
   * 手工扫描必须单遍：上游那种「先 replace(/\\"/g,'"') 再 replace(/\\\\/g,'\\')」
   * 的顺序会算错嵌套的情况（`\\"` 应当解成 `\"`，而不是 `"`）。
   *
   * 注意 `\n` 这类控制字符**不**换成真字符，而是保持两字符的转义序列 ——
   * 最终交给 JSON5.parse 解，它本来就能解。这样解开后的文本仍是一段合法 JSON。
   *
   * @param {string} src
   * @returns {string}
   */
  function unescapeJson(src) {
    var s = src === null || src === undefined ? '' : String(src).trim();
    if (!s) return s;

    // 1) 带外层引号：按 JSON 字符串解析，最准（能正确处理嵌套转义）
    var first = s.charAt(0);
    var last = s.charAt(s.length - 1);
    if (s.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
      var decoded = null;
      var ok = true;
      try { decoded = JSON.parse(s); } catch (e) { ok = false; }
      if (!ok) {
        try { decoded = JSON5.parse(s); } catch (e2) { decoded = null; }
      }
      if (typeof decoded === 'string') return decoded;
    }

    // 2) 不带外层引号：单遍扫描，只解「会影响字符串边界」的那些转义
    return s.replace(/\\([\s\S])/g, function (m, ch) {
      switch (ch) {
        case '"': return '"';
        case "'": return "'";
        case '\\': return '\\';
        case '/': return '/';
        default: return m;   // \n \t \uXXXX …… 交给 JSON5 自己解
      }
    });
  }

  /** 自动反转义最多解几层（双层转义的日志解两层就够，留一层余量）。 */
  var MAX_UNESCAPE_LEVELS = 3;

  /**
   * 反转义层级：第 0 层是原文，第 n 层是原文反转义 n 次的结果。
   * 解到「不再变化」为止 —— 再解也不会有新东西。
   *
   * @param {string} s
   * @returns {string[]}
   */
  function unescapeLevels(s) {
    var levels = [s];
    for (var i = 1; i <= MAX_UNESCAPE_LEVELS; i++) {
      var next = unescapeJson(levels[i - 1]);
      if (next === levels[i - 1]) break;   // 不再变化了，再解也没用
      levels.push(next);
    }
    return levels;
  }

  /**
   * 带自动反转义的解析（上游 #1643）。
   *
   * 逐层试：第 0 层是原文，第 n 层是原文反转义 n 次的结果。
   * 哪一层能解出**对象或数组**就用那一层；一层都解不出来就退回第 0 层
   * （它可能解出一个普通字符串，比如 "hello"），再不行就抛错。
   *
   * 这样既解决了「JSON 字符串里套着 JSON」，又不会像上游那样把已经合法的
   * JSON 反转义成解析不了的形态（{"s":"a\"b"} 就是这种）。
   *
   * @param {string} raw
   * @returns {*} 解析结果
   */
  function parseJsonAuto(raw) {
    var s = raw === null || raw === undefined ? '' : String(raw);
    if (s.trim() === '') return parseJson(s);

    var levels = unescapeLevels(s);

    var haveFallback = false;
    var fallbackValue = null;
    var fallbackError = null;

    for (var j = 0; j < levels.length; j++) {
      try {
        var parsed = parseJson(levels[j]);
        if (parsed !== null && typeof parsed === 'object') return parsed;   // 对象 / 数组
        if (j === 0) { haveFallback = true; fallbackValue = parsed; }
      } catch (e) {
        if (j === 0) fallbackError = e;
      }
    }
    if (haveFallback) return fallbackValue;
    throw fallbackError || new Error(t('err_not_valid', 'JSON is not valid'));
  }

  /* ---------- 修复 JSON（上游 #1539）---------- */

  /**
   * 用 jsonrepair 修一段坏 JSON。
   *
   * **为什么不照抄上游**：上游是「开关一开就把原文整个丢给 jsonrepair，
   * 再解析修好的文本」。可 jsonrepair 只认**严格 JSON**，它会把 JSON5 的
   * 十六进制数字 `0xFF` 当成**字符串** "0xFF"，把 `NaN` / `Infinity` 也当成
   * 字符串 —— 于是用户开了这个开关，本来好好的 JSON5 就被改坏了
   * （`{"a":0xFF}` 变成 `{"a":"0xFF"}`，数字悄悄变成了文本）。
   *
   * 所以这里的顺序是**反过来的**：先按平常的路子解析，**只有解析失败**了
   * 才拿 jsonrepair 修一遍。这样开关只在该生效的时候生效，
   * 合法输入一个字节都不会被改。
   *
   * @param {string} src
   * @returns {string} 修好的 JSON 文本
   */
  function repairJsonText(src) {
    var lib = window.JSONRepair;
    if (!lib || typeof lib.jsonrepair !== 'function') {
      throw new Error(t('err_repair_unavailable', 'The JSON repair library is not loaded'));
    }
    return lib.jsonrepair(src === null || src === undefined ? '' : String(src));
  }

  /**
   * 这段文本能不能被修好（用来决定要不要提示用户「试试修复 JSON」）。
   * 修不好就别提示 —— 提示了也白搭。
   *
   * @param {string} src
   * @returns {boolean}
   */
  function canRepair(src) {
    try {
      repairJsonText(src);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 修好再解析。修不好的文本抛错（错误信息来自 jsonrepair，带位置）。
   *
   * @param {string} raw
   * @param {boolean} [autoUnescape] 是否也逐层试反转义
   * @returns {*} 解析结果
   */
  function parseJsonRepaired(raw, autoUnescape) {
    var s = raw === null || raw === undefined ? '' : String(raw);
    var levels = autoUnescape ? unescapeLevels(s) : [s];

    var haveFallback = false;
    var fallbackValue = null;
    var lastError = null;

    for (var i = 0; i < levels.length; i++) {
      try {
        var fixed = repairJsonText(levels[i]);
        var parsed = parseJson(fixed);
        if (parsed !== null && typeof parsed === 'object') return parsed;   // 对象 / 数组
        if (i === 0) { haveFallback = true; fallbackValue = parsed; }
      } catch (e) {
        if (i === 0) lastError = e;
      }
    }
    if (haveFallback) return fallbackValue;
    throw lastError || new Error(t('err_not_valid', 'JSON is not valid'));
  }

  /**
   * 递归按字母序排对象的键；数组保持原顺序。
   * @param {*} obj
   */
  function sortObjectKeys(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(sortObjectKeys);

    var sorted = {};
    Object.keys(obj)
      .sort(function (a, b) { return a.localeCompare(b); })
      .forEach(function (key) {
        // 不能写 sorted[key] = ...：__proto__ 会被 set 语义写到原型上，键就没了
        Object.defineProperty(sorted, key, {
          value: sortObjectKeys(obj[key]),
          writable: true, enumerable: true, configurable: true
        });
      });
    return sorted;
  }

  /**
   * 主函数：原始 JSON5 文本 → 美化后的 JSON 文本。
   * 非法输入抛错（JSON5 的报错带行列号），空输入返回空串。
   *
   * @param {string} rawJson
   * @param {{sortKeys?: boolean, indentSize?: number, autoUnescape?: boolean, repair?: boolean}} [opts]
   * @returns {string}
   */
  function formatJson(rawJson, opts) {
    return formatJsonResult(rawJson, opts).json;
  }

  /**
   * 主函数（带「这次是不是修过的」）。
   *
   * repaired 用来在界面上说明「你贴进来的不是合法 JSON，已经替你修好了」——
   * 少了这一句，用户会以为自己的原文本来就是那样。
   *
   * @param {string} rawJson
   * @param {{sortKeys?: boolean, indentSize?: number, autoUnescape?: boolean, repair?: boolean}} [opts]
   * @returns {{json: string, repaired: boolean}}
   */
  function formatJsonResult(rawJson, opts) {
    opts = opts || {};
    var src = rawJson === null || rawJson === undefined ? '' : String(rawJson);
    if (src.trim() === '') return { json: '', repaired: false };

    var sortKeys = opts.sortKeys !== false;                       // 参考实现默认 true
    var indentSize = opts.indentSize === undefined ? DEFAULT_INDENT : opts.indentSize;
    if (!(indentSize >= 0) || indentSize > MAX_INDENT) indentSize = DEFAULT_INDENT;

    // autoUnescape 时走 parseJsonAuto —— 反转义发生在 stripJsonComments **之前**，
    // 否则新注入的引号会打断注释扫描时的字符串边界判断。
    var parsed;
    var repaired = false;
    try {
      parsed = opts.autoUnescape ? parseJsonAuto(src) : parseJson(src);
    } catch (e) {
      // 平常的路子走不通 —— 开了「修复 JSON」才拿 jsonrepair 兜底（见 repairJsonText）
      if (!opts.repair) throw e;
      parsed = parseJsonRepaired(src, opts.autoUnescape);
      repaired = true;
    }
    if (sortKeys) parsed = sortObjectKeys(parsed);

    var out = JSON.stringify(parsed, null, indentSize);
    // JSON.stringify(undefined) 返回 undefined 而不是串，这里统一成空串
    return { json: out === undefined ? '' : U.restoreBigIntegers(out), repaired: repaired };
  }


  /* ---------- Lint：重复键与隐藏字符（上游 #1015 的 JSON Linter） ----------

     上游 #1015 是个独立工具，**核心是 Monaco**（monaco-linter + 自定义 worker）。
     但把它剥掉之后，剩下的真逻辑只有两件：
       1. 重复键检测 —— JSON.parse 对重复键是「后者覆盖前者」，不报错也不提示，
          `{"a":1,"a":2}` 悄悄变成 `{"a":2}`，日志里排查时极难发现；
       2. 隐藏字符检测 —— 零宽空格、BOM、双向覆盖符（Trojan Source）这类字符
          在编辑器里看不见，却会改变程序读到的字符串。
     两件都是**文本层**的事，跟「格式化」是两条路，所以没有单开一个工具，
     而是做成 json-viewer 的两个开关（上游那份的 Monaco 在我们这套栈里也用不了）。

     Monaco 带来的那部分（行号、悬浮提示、波浪线）不做 —— 我们不做代码编辑器。 */

  /**
   * 扫出 JSON/JSON5 里**同一个对象内重复出现的键**。
   *
   * 必须在文本层扫：解析器已经把重复键吞掉了（后者覆盖前者），
   * 等拿到解析结果就看不出来了。
   *
   * 扫描器是字面量级的：字符串认转义（`\"` 不结束字符串），键认 JSON5 的
   * 三种写法（双引号、单引号、不带引号的标识符）。对象与数组各压一层栈，
   * 键只在**当前层是对象**时才算数 —— 数组里的对象互不相干。
   *
   * @param {string} src
   * @returns {Array<{key: string, count: number, line: number, column: number}>}
   */
  function findDuplicateKeys(src) {
    var s = src === null || src === undefined ? '' : String(src);
    var n = s.length;
    var out = [];
    var stack = [{ type: 'root', keys: Object.create(null) }];
    var i = 0, line = 1, col = 1;

    function adv() {
      if (s.charAt(i) === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
    function peekNonSpace() {
      var j = i;
      while (j < n && /\s/.test(s.charAt(j))) j++;
      return j;
    }
    /** 读一段字符串字面量，返回**解码后**的内容与起始位置。 */
    function readString() {
      var quote = s.charAt(i);
      var startLine = line, startCol = col;
      var raw = '';
      adv();                                   // 开引号
      while (i < n) {
        var c = s.charAt(i);
        if (c === '\\') {
          raw += c;
          adv();
          if (i < n) { raw += s.charAt(i); adv(); }
          continue;
        }
        if (c === quote) { adv(); break; }
        raw += c; adv();
      }
      return { value: unescapeStringLiteral(raw), line: startLine, column: startCol };
    }
    /** 读一段标识符（JSON5 的无引号键），也认 JSON5 的点号键 `a.b`。 */
    function readIdentifier() {
      var startLine = line, startCol = col;
      var buf = '';
      while (i < n && /[A-Za-z0-9_$]/.test(s.charAt(i))) { buf += s.charAt(i); adv(); }
      while (i < n && s.charAt(i) === '.' && i + 1 < n && /[A-Za-z_$]/.test(s.charAt(i + 1))) {
        buf += '.'; adv();
        while (i < n && /[A-Za-z0-9_$]/.test(s.charAt(i))) { buf += s.charAt(i); adv(); }
      }
      return { value: buf, line: startLine, column: startCol };
    }
    function addKey(frame, key, kLine, kCol) {
      if (Object.prototype.hasOwnProperty.call(frame.keys, key)) {
        frame.keys[key].count++;
      } else {
        frame.keys[key] = { key: key, count: 1, line: kLine, column: kCol };
      }
    }
    function collect(frame) {
      Object.keys(frame.keys).forEach(function (k) {
        var e = frame.keys[k];
        if (e.count > 1) out.push({ key: e.key, count: e.count, line: e.line, column: e.column });
      });
    }

    while (i < n) {
      var c = s.charAt(i);
      if (c === '"' || c === "'") {
        var str = readString();
        if (stack[stack.length - 1].type === 'obj' && s.charAt(peekNonSpace()) === ':') {
          addKey(stack[stack.length - 1], str.value, str.line, str.column);
        }
        continue;
      }
      if (c === '{') { stack.push({ type: 'obj', keys: Object.create(null) }); adv(); continue; }
      if (c === '[') { stack.push({ type: 'arr', keys: Object.create(null) }); adv(); continue; }
      if (c === '}' || c === ']') {
        var frame = stack.pop();
        if (frame && frame.type === 'obj') collect(frame);
        adv();
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        var id = readIdentifier();
        if (stack[stack.length - 1].type === 'obj' && s.charAt(peekNonSpace()) === ':') {
          addKey(stack[stack.length - 1], id.value, id.line, id.column);
        }
        continue;
      }
      adv();
    }
    if (stack.length) collect(stack[0]);
    return out;
  }

  /** 解一段 JSON 字符串字面量的内容（不含引号）。 */
  function unescapeStringLiteral(raw) {
    return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, function (m, g) {
      switch (g.charAt(0)) {
        case 'u': return String.fromCharCode(parseInt(g.slice(1), 16));
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'v': return '\v';
        case '0': return '\0';
        default: return g;
      }
    });
  }

  /**
   * 肉眼看不见、但会改变程序读到的内容的字符。
   *
   * 分三类：
   *   · 控制字符 —— 除了 \t \n \r，其余 C0 与 C1 都算（JSON 字符串里直接写是非法的）
   *   · 零宽与不可见格式字符 —— 零宽空格 / 连接符、BOM、软连字符
   *   · 双向文本控制符 —— U+202A..U+202E 与 U+2066..U+2069（Trojan Source：
   *     源码看着是 `if (a > b)`，真执行起来可能是 `a < b`）
   * 另外把各种 Unicode 空格也算上 —— 它们在 JSON 字符串里合法，但拼写检查
   * 与肉眼都会漏掉。
   */
  var HIDDEN_CHARS = [
    { code: 0x00A0, name: 'NO-BREAK SPACE' },
    { code: 0x00AD, name: 'SOFT HYPHEN' },
    { code: 0x1680, name: 'OGHAM SPACE MARK' },
    { code: 0x2000, name: 'EN QUAD' },
    { code: 0x2001, name: 'EM QUAD' },
    { code: 0x2002, name: 'EN SPACE' },
    { code: 0x2003, name: 'EM SPACE' },
    { code: 0x2004, name: 'THREE-PER-EM SPACE' },
    { code: 0x2005, name: 'FOUR-PER-EM SPACE' },
    { code: 0x2006, name: 'SIX-PER-EM SPACE' },
    { code: 0x2007, name: 'FIGURE SPACE' },
    { code: 0x2008, name: 'PUNCTUATION SPACE' },
    { code: 0x2009, name: 'THIN SPACE' },
    { code: 0x200A, name: 'HAIR SPACE' },
    { code: 0x200B, name: 'ZERO WIDTH SPACE' },
    { code: 0x200C, name: 'ZERO WIDTH NON-JOINER' },
    { code: 0x200D, name: 'ZERO WIDTH JOINER' },
    { code: 0x200E, name: 'LEFT-TO-RIGHT MARK' },
    { code: 0x200F, name: 'RIGHT-TO-LEFT MARK' },
    { code: 0x2028, name: 'LINE SEPARATOR' },
    { code: 0x2029, name: 'PARAGRAPH SEPARATOR' },
    { code: 0x202A, name: 'LEFT-TO-RIGHT EMBEDDING' },
    { code: 0x202B, name: 'RIGHT-TO-LEFT EMBEDDING' },
    { code: 0x202C, name: 'POP DIRECTIONAL FORMATTING' },
    { code: 0x202D, name: 'LEFT-TO-RIGHT OVERRIDE' },
    { code: 0x202E, name: 'RIGHT-TO-LEFT OVERRIDE' },
    { code: 0x202F, name: 'NARROW NO-BREAK SPACE' },
    { code: 0x205F, name: 'MEDIUM MATHEMATICAL SPACE' },
    { code: 0x2060, name: 'WORD JOINER' },
    { code: 0x2066, name: 'LEFT-TO-RIGHT ISOLATE' },
    { code: 0x2067, name: 'RIGHT-TO-LEFT ISOLATE' },
    { code: 0x2068, name: 'FIRST STRONG ISOLATE' },
    { code: 0x2069, name: 'POP DIRECTIONAL ISOLATE' },
    { code: 0x3000, name: 'IDEOGRAPHIC SPACE' },
    { code: 0xFEFF, name: 'ZERO WIDTH NO-BREAK SPACE (BOM)' }
  ];

  var HIDDEN_NAMES = (function () {
    var map = Object.create(null);
    HIDDEN_CHARS.forEach(function (h) { map[h.code] = h.name; });
    return map;
  })();

  /** 一个码位是不是「看不见但有影响」的字符。返回名字，不是就返回空串。 */
  function hiddenCharName(code) {
    // C0 控制字符：\t \n \r 放行，其余都算
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) return 'CONTROL CHARACTER';
    if (code === 0x7F) return 'DELETE CHARACTER';
    if (code >= 0x80 && code <= 0x9F) return 'C1 CONTROL CHARACTER';
    return HIDDEN_NAMES[code] || '';
  }

  /**
   * 扫出文本里的隐藏字符。
   *
   * @param {string} src
   * @returns {Array<{code: number, name: string, line: number, column: number}>}
   */
  function findHiddenCharacters(src) {
    var s = src === null || src === undefined ? '' : String(src);
    var out = [];
    var line = 1, col = 1;
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      var name = hiddenCharName(code);
      if (name) out.push({ code: code, name: name, line: line, column: col });
      if (s.charAt(i) === '\n') { line++; col = 1; } else { col++; }
    }
    return out;
  }

  /* ---------- UI ---------- */

  /** 「修复 JSON」开关记在 localStorage 里（对应上游的 useStorage）。 */
  var REPAIR_KEY = 'json-prettify:repair-json';

  function readStored(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : raw;
    } catch (e) {
      return fallback;   // 隐私模式下 localStorage 直接抛
    }
  }

  function writeStored(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式 */ }
  }

  window.ItTools.register('json-viewer', function (root) {
    var DEFAULT_RAW = '{"hello": "world", "foo": "bar"}';

    // 原版这两个框是 monospace 的
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 10, spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your raw JSON here... Enable "Auto-unescape" for escaped JSON strings')
    });
    input.value = DEFAULT_RAW;

    var output = U.codeBlock();
    var error = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });
    // 「试试修复 JSON」是**建议**，不是错误 —— 单独一行，不跟报错挤在一起
    var hint = D.h('p.field-hint');
    // 「已经替你修好了」是提醒，不是错误 —— 单独一行，颜色也跟错误不一样
    var notice = D.h('p.field-hint', { style: { color: 'var(--warning, #fa8c16)' } });

    var sortInput = D.h('input', { type: 'checkbox', checked: 'checked' });
    var unescapeInput = D.h('input', { type: 'checkbox' });
    var dupInput = D.h('input', { type: 'checkbox' });
    var hiddenInput = D.h('input', { type: 'checkbox' });
    var repairInput = D.h('input', { type: 'checkbox' });
    repairInput.checked = readStored(REPAIR_KEY, 'false') === 'true';
    // 原版这个是 n-input-number，宽度 100px（不是撑满）
    var indentSelect = D.h('select.layui-select', { style: { width: '100px', flex: '0 0 100px' } });
    for (var n = 0; n <= MAX_INDENT; n++) {
      indentSelect.appendChild(D.h('option', { value: String(n), text: String(n) }));
    }
    indentSelect.value = String(DEFAULT_INDENT);

    // Lint 的结果单独一块卡：两个开关都没开时整块藏起来（display:none），
    // 开着却有话要说时才占地方。
    var lintBody = D.h('div.output-body');
    var lintCard = D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('lint_title', 'Lint results') })),
      lintBody
    );

    function render() {
      D.clear(error);
      D.clear(hint);
      D.clear(notice);
      try {
        var result = formatJsonResult(input.value, {
          sortKeys: sortInput.checked,
          indentSize: Number(indentSelect.value),
          autoUnescape: unescapeInput.checked,
          repair: repairInput.checked
        });
        output.value = result.json;
        if (result.repaired) {
          notice.textContent = t('repaired_notice', 'The input was not valid JSON — it has been repaired.');
        }
      } catch (e) {
        output.value = '';
        error.textContent = t('err_invalid', 'Provided JSON is not valid. {message}')
          // 用函数形式回填：解析器的报错里可能有 '$'，字符串替换会把它当替换模式
          .replace('{message}', function () { return e && e.message ? e.message : e; });
        // 修不好的就别提示「试试修复」—— 提示了也白搭
        if (!repairInput.checked && canRepair(input.value)) {
          hint.textContent = t('err_try_repair', 'Try again with "Repair JSON".');
        }
      }
      renderLint();
    }

    /** 两项检查的结果。重复键与隐藏字符都是**文本层**的事，与格式化无关。 */
    function renderLint() {
      if (!dupInput.checked && !hiddenInput.checked) {
        lintCard.style.display = 'none';
        return;
      }
      lintCard.style.display = '';
      D.clear(lintBody);

      var items = [];
      if (dupInput.checked) {
        findDuplicateKeys(input.value).forEach(function (d) {
          items.push(t('lint_duplicate_key', 'Duplicate key `{key}` ({count} times), first at line {line}, column {column}')
            .replace('{key}', function () { return d.key; })
            .replace('{count}', function () { return String(d.count); })
            .replace('{line}', function () { return String(d.line); })
            .replace('{column}', function () { return String(d.column); }));
        });
      }
      if (hiddenInput.checked) {
        findHiddenCharacters(input.value).forEach(function (h) {
          items.push(t('lint_hidden_char', '{name} (U+{code}) at line {line}, column {column}')
            .replace('{name}', function () { return h.name; })
            .replace('{code}', function () { return h.code.toString(16).toUpperCase().padStart(4, '0'); })
            .replace('{line}', function () { return String(h.line); })
            .replace('{column}', function () { return String(h.column); }));
        });
      }

      if (!items.length) {
        lintBody.appendChild(D.h('p.field-hint', { text: t('lint_ok', 'No problems found.') }));
        return;
      }
      var list = D.h('ul');
      items.forEach(function (msg) { list.appendChild(D.h('li', { text: msg })); });
      lintBody.appendChild(list);
    }

    sortInput.addEventListener('change', render);
    unescapeInput.addEventListener('change', render);
    dupInput.addEventListener('change', render);
    hiddenInput.addEventListener('change', render);
    indentSelect.addEventListener('change', render);
    repairInput.addEventListener('change', function () {
      writeStored(REPAIR_KEY, repairInput.checked ? 'true' : 'false');
      render();
    });
    var off = D.on(input, 'input', render);

    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      // 原版顶部是两个 n-form-item：label-placement="left" label-width="100"，
      // 摆在一条居中的 flex 行里（gap 3）。开关在标签右边那一列。
      // 标签在左、右对齐、100px 宽 —— 与原版 naive-ui 的 label-placement="left" 一致。
      D.h('div', { style: { display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '14px' } },
        D.h('div.field-row', { style: { '--field-label-width': '100px', '--field-label-align': 'right', marginBottom: '0', flex: '0 1 auto' } },
          D.h('label.field-label', { text: t('sort_keys', 'Sort keys') }),
          D.h('label.switch', null, sortInput, D.h('span'))),
        D.h('div.field-row', { style: { '--field-label-width': '100px', '--field-label-align': 'right', marginBottom: '0', flex: '0 1 auto' } },
          D.h('label.field-label', { text: t('indent_size', 'Indent size:') }),
          indentSelect)
      ),
      // 这四个开关是本移植版自己加的（原版 json-viewer 没有），排在下面一行。
      D.h('div.switch-grid', null,
        D.h('label.switch', null, unescapeInput, D.h('span', { text: t('auto_unescape', 'Auto-unescape') })),
        D.h('label.switch', null, repairInput, D.h('span', { text: t('repair_json', 'Repair JSON') })),
        D.h('label.switch', null, dupInput, D.h('span', { text: t('check_duplicate_keys', 'Detect duplicate keys') })),
        D.h('label.switch', null, hiddenInput, D.h('span', { text: t('check_hidden_chars', 'Detect hidden characters') }))
      ),
      U.field(t('input', 'Your raw JSON'), input),
      error,
      hint,
      notice
    ));
    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('result', 'Prettified version of your JSON') }),
      output.card
    ));
    root.appendChild(lintCard);
    render();

    return { destroy: function () { off(); D.clear(root); } };
  });

  window.ItTools.logic['json-viewer'] = {
    findDuplicateKeys: findDuplicateKeys,
    findHiddenCharacters: findHiddenCharacters,
    hiddenCharName: hiddenCharName,
    stripJsonComments: stripJsonComments,
    parseJson: parseJson,
    unescapeJson: unescapeJson,
    unescapeLevels: unescapeLevels,
    parseJsonAuto: parseJsonAuto,
    repairJsonText: repairJsonText,
    canRepair: canRepair,
    parseJsonRepaired: parseJsonRepaired,
    sortObjectKeys: sortObjectKeys,
    formatJson: formatJson,
    formatJsonResult: formatJsonResult,
    __cases: function (assert) {
      /* ---- findDuplicateKeys：重复键（上游 #1015 的核心逻辑）---- */
      assert.eq(findDuplicateKeys('{"a":1,"a":2}'),
        [{ key: 'a', count: 2, line: 1, column: 2 }], '同一个对象里重复的键');
      assert.eq(findDuplicateKeys('{"a":1,"a":2,"a":3}'),
        [{ key: 'a', count: 3, line: 1, column: 2 }], '出现三次');
      assert.eq(findDuplicateKeys('{"a":1,"b":2}'), [], '没有重复');
      assert.eq(findDuplicateKeys('{"a":1,"A":2}'), [], '键是大小写敏感的');
      assert.eq(findDuplicateKeys(''), [], '空串');
      assert.eq(findDuplicateKeys('{"a":1}'), [], '单键');
      // 重复的键在**不同的对象**里不算重复
      assert.eq(findDuplicateKeys('{"x":{"a":1},"y":{"a":2}}'), [], '不同对象里的同名键');
      assert.eq(findDuplicateKeys('{"x":{"a":1,"a":2}}'),
        [{ key: 'a', count: 2, line: 1, column: 7 }], '嵌套对象里的重复键');
      assert.eq(findDuplicateKeys('[{"a":1,"a":2}]'),
        [{ key: 'a', count: 2, line: 1, column: 3 }], '数组元素对象里的重复键');
      // JSON5 的三种键写法都要认
      assert.eq(findDuplicateKeys('{a:1,a:2}'),
        [{ key: 'a', count: 2, line: 1, column: 2 }], 'JSON5 无引号键');
      assert.eq(findDuplicateKeys("{'a':1,'a':2}"),
        [{ key: 'a', count: 2, line: 1, column: 2 }], 'JSON5 单引号键');
      // 转义过的引号不是字符串的结束 —— 键名要按**解码后**的样子比
      assert.eq(findDuplicateKeys('{"a\\"b":1,"a\\"b":2}'),
        [{ key: 'a"b', count: 2, line: 1, column: 2 }], '键里有转义引号');
      assert.eq(findDuplicateKeys('{"a\\"b":1,"a\"c":2}'), [], '解码后不同的两个键');
      // __proto__ 是合法的 JSON 键，不能被 set 语义弄丢
      assert.eq(findDuplicateKeys('{"__proto__":1,"__proto__":2}'),
        [{ key: '__proto__', count: 2, line: 1, column: 2 }], '__proto__ 是普通键');
      // 位置：第一次出现的位置
      assert.eq(findDuplicateKeys('{\n  "a": 1,\n  "a": 2\n}'),
        [{ key: 'a', count: 2, line: 2, column: 3 }], '第一次出现的行与列');
      assert.eq(findDuplicateKeys('{"x":1,\n"a":2,\n"a":3}'),
        [{ key: 'a', count: 2, line: 2, column: 1 }], '多行里的行号');

      /* ---- findHiddenCharacters：隐藏字符（上游 #1015 的第二件事）---- */
      assert.eq(findHiddenCharacters('{"a":"x"}'), [], '干净文本');
      assert.eq(findHiddenCharacters(''), [], '空串');
      assert.eq(findHiddenCharacters('\t\n\r'), [], '制表 / 换行 / 回车不算隐藏');
      assert.eq(findHiddenCharacters('{"a":"\u200b"}').length, 1, '零宽空格被找到');
      assert.eq(findHiddenCharacters('{"a":"\u200b"}')[0].name, 'ZERO WIDTH SPACE', '零宽空格的名字');
      assert.eq(findHiddenCharacters('\ufeff'), [
        { code: 0xFEFF, name: 'ZERO WIDTH NO-BREAK SPACE (BOM)', line: 1, column: 1 }
      ], 'BOM');
      assert.eq(findHiddenCharacters('\u202e')[0].name, 'RIGHT-TO-LEFT OVERRIDE', 'RLO');
      assert.eq(findHiddenCharacters('\u202d')[0].name, 'LEFT-TO-RIGHT OVERRIDE', 'LRO');
      assert.eq(findHiddenCharacters('\u00a0')[0].name, 'NO-BREAK SPACE', '不换行空格');
      assert.eq(findHiddenCharacters('\u00ad')[0].name, 'SOFT HYPHEN', '软连字符');
      assert.eq(findHiddenCharacters('\u3000')[0].name, 'IDEOGRAPHIC SPACE', '全角空格');
      assert.eq(findHiddenCharacters('\u0001')[0].name, 'CONTROL CHARACTER', 'C0 控制字符');
      assert.eq(findHiddenCharacters('\u007f')[0].name, 'DELETE CHARACTER', 'DEL');
      assert.eq(findHiddenCharacters('\u0085')[0].name, 'C1 CONTROL CHARACTER', 'C1 控制字符');
      // 位置：行列从 1 开始
      assert.eq(findHiddenCharacters('ab\u200b')[0].column, 3, '同一行里的列号');
      assert.eq(findHiddenCharacters('a\nb\u200b')[0].line, 2, '换行之后的行号');
      assert.eq(findHiddenCharacters('a\nb\u200b')[0].column, 2, '换行之后的列号');
      assert.eq(findHiddenCharacters('\u200b\u200c').length, 2, '两个都找出来');

      /* ---- stripJsonComments：注释本体 ---- */
      assert.eq(stripJsonComments('[1,/*x*/,2]'), '[1,2]', '块注释紧跟逗号 —— json5 的 bug 场景，剥完还得能过');
      assert.eq(stripJsonComments('{a:1,/*c*/b:2}'), '{a:1,b:2}', '块注释在逗号后、键名前');
      assert.eq(stripJsonComments('{"a":1,/*c*/"b":2}'), '{"a":1,"b":2}', '双引号键之间的块注释');
      assert.eq(stripJsonComments('[1,//x\n2]'), '[1,\n2]', '行注释：换成换行，换行本身要留着');
      assert.eq(stripJsonComments('[1, //x\r\n2]'), '[1, \r\n2]', 'CRLF 也要留着');
      assert.eq(stripJsonComments('/*a\nb*/[1]'), '\n[1]', '跨行块注释的换行保留，报错的行列号才对得上');
      assert.eq(stripJsonComments('/**/[1]'), '[1]', '空块注释');
      assert.eq(stripJsonComments('/*a*//*b*/1'), '1', '两个相邻的块注释');
      assert.eq(stripJsonComments('[1,/**/,2]'), '[1,2]', '空块注释在两个逗号中间');
      assert.eq(stripJsonComments('[1//c\n]'), '[1\n]', '行注释到行尾，闭合括号在下一行');
      assert.eq(stripJsonComments('[1//c]'), '[1', '行注释吃到 EOF —— ] 确实在注释里');
      assert.eq(stripJsonComments('1/2'), '1/2', '单独的斜杠不是注释');
      assert.eq(stripJsonComments(''), '', '空串');
      assert.eq(stripJsonComments('{"a":1}'), '{"a":1}', '没有注释就原样返回');

      /* ---- stripJsonComments：不能碰字符串 ---- */
      assert.eq(stripJsonComments('{"u":"http://a//b"}'), '{"u":"http://a//b"}', '字符串里的 //');
      assert.eq(stripJsonComments('{"u":"a/*b*/c"}'), '{"u":"a/*b*/c"}', '字符串里的 /* */');
      assert.eq(stripJsonComments("{'q':'//x'}"), "{'q':'//x'}", 'JSON5 单引号字符串里的 //');
      assert.eq(stripJsonComments('["//","/*"]'), '["//","/*"]', '整串就是两个伪注释');
      // 源码 ["a\"/*x*/b"] → 字符串内容是 a"/*x*/b，\" 不结束字符串
      assert.eq(stripJsonComments('["a\\"/*x*/b"]'), '["a\\"/*x*/b"]', '转义引号后面的 /* 不算注释');
      // 源码 ["a\\"] → 字符串内容是 a\\（结尾那个 \ 是内容），后面的引号才是结束符
      assert.eq(stripJsonComments('["a\\\\"]'), '["a\\\\"]', '转义反斜杠：引号仍然正确闭合');
      assert.eq(stripJsonComments('["a\\\\", 1]'), '["a\\\\", 1]', '转义反斜杠后还有元素');
      assert.eq(stripJsonComments('{"a":"b\\\\","c":"//x"}'), '{"a":"b\\\\","c":"//x"}', '转义反斜杠 + 伪注释混排');

      /* ---- stripJsonComments：json5 不支持的 elision ---- */
      assert.eq(stripJsonComments('[1,/*c*/,2]'), '[1,2]', '剥完是 [1,,2]，第二个逗号被吃掉');
      assert.eq(stripJsonComments('[1, /*c*/ , 2]'), '[1,   2]', '两个逗号之间隔着空白也照吃');
      assert.eq(stripJsonComments('{"a":1,/*c*/,/*d*/,"b":2}'), '{"a":1,"b":2}', '连续两个块注释夹在逗号间');
      assert.eq(stripJsonComments('[1,2,,3]'), '[1,2,3]', '裸写的双逗号也归一（json5 本来就解不了）');
      assert.eq(stripJsonComments('[,1]'), '[,1]', '开头的 elision 不归一，交给 JSON5 报错');

      /* ---- stripJsonComments：错误输入 ---- */
      var threw = false;
      try { stripJsonComments('[1,/*没写完,2]'); } catch (e) { threw = true; }
      assert(threw, '未闭合的块注释应抛错');
      assert.eq(stripJsonComments(null), '', 'null 当空串处理');
      assert.eq(stripJsonComments(undefined), '', 'undefined 当空串处理');

      /* ---- sortObjectKeys ---- */
      assert.eq(sortObjectKeys({ b: 2, a: 1 }), { a: 1, b: 2 }, '顶层键排序');
      assert.eq(Object.keys(sortObjectKeys({ b: 1, a: 2 })), ['a', 'b'], '键顺序真的变了');
      assert.eq(sortObjectKeys({ b: 2, a: 1, d: { j: 7, a: [{ z: 9, y: 8 }] }, c: 3 }),
        { a: 1, b: 2, c: 3, d: { a: [{ y: 8, z: 9 }], j: 7 } }, '递归排序');
      assert.eq(sortObjectKeys([3, 1, 2]), [3, 1, 2], '数组保持原顺序');
      assert.eq(sortObjectKeys('x'), 'x', '标量原样返回');
      assert.eq(sortObjectKeys(null), null, 'null 原样返回');
      assert.eq(JSON.stringify(sortObjectKeys(JSON5.parse('{"__proto__":{"x":1},"a":2}'))),
        '{"__proto__":{"x":1},"a":2}', '__proto__ 是普通键，不能被 set 语义写到原型上弄丢');

      /* ---- formatJson：正常值 ---- */
      assert.eq(formatJson('{"hello":"world","foo":"bar"}'), '{\n   "foo": "bar",\n   "hello": "world"\n}', '默认缩进 3 + 默认排序键');
      assert.eq(formatJson('{"b":2,"a":1}'), '{\n   "a": 1,\n   "b": 2\n}', '默认排序键');
      assert.eq(formatJson('{"b":2,"a":1}', { sortKeys: false }), '{\n   "b": 2,\n   "a": 1\n}', '关掉排序就保留原序');
      assert.eq(formatJson('{"a":{"c":1,"b":2}}', { indentSize: 2 }), '{\n  "a": {\n    "b": 2,\n    "c": 1\n  }\n}', '缩进 2 + 递归排序');
      assert.eq(formatJson('{"a":1}', { indentSize: 0 }), '{"a":1}', '缩进 0 等于压成一行');
      assert.eq(formatJson('{"a":1}', { indentSize: 99 }), '{\n   "a": 1\n}', '越界的缩进回落到默认 3');
      assert.eq(formatJson('[1,2,3]'), '[\n   1,\n   2,\n   3\n]', '数组');
      assert.eq(formatJson('42'), '42', '顶层标量');
      assert.eq(formatJson('null'), 'null', '顶层 null');

      /* ---- formatJson：JSON5 特性 + 注释 ---- */
      assert.eq(formatJson('{a:1}', { indentSize: 0 }), '{"a":1}', '无引号键');
      assert.eq(formatJson("{'a':'b'}", { indentSize: 0 }), '{"a":"b"}', '单引号字符串');
      assert.eq(formatJson('{"a":1,}', { indentSize: 0 }), '{"a":1}', '尾逗号');
      assert.eq(formatJson('[1,/*x*/,2]', { indentSize: 0 }), '[1,2]', 'JSON5 bug 那个例子最终能解析');
      assert.eq(formatJson('{"a":1,//x\n"b":2}', { indentSize: 0 }), '{"a":1,"b":2}', '带行注释');
      assert.eq(formatJson('{"s":"//not a comment"}', { indentSize: 0 }), '{"s":"//not a comment"}', '字符串里的 // 不受影响');
      assert.eq(formatJson('{"a":.5,"b":+1,"c":0xFF}', { indentSize: 0 }), '{"a":0.5,"b":1,"c":255}', 'JSON5 数字字面量');

      /* ---- formatJson：边界 ---- */
      assert.eq(formatJson(''), '', '空串输入得到空输出');
      assert.eq(formatJson('   '), '', '纯空白也当空');
      assert.eq(formatJson(null), '', 'null 输入得到空输出');
      assert.eq(formatJson('{}', { indentSize: 2 }), '{}', '空对象');
      assert.eq(formatJson('[]', { indentSize: 2 }), '[]', '空数组');

      /* ---- formatJson：错误输入 ---- */
      ['', '   '].forEach(function () { /* 空串走上面那条，这里只测非空非法 */ });
      ['{a:}', '[1,2', '{"a":1} {"b":2}', '[,1]', '{'].forEach(function (bad) {
        var threw = false;
        try { formatJson(bad); } catch (e) { threw = true; }
        assert(threw, '非法输入 ' + JSON.stringify(bad) + ' 应抛错');
      });
      var unterminated = false;
      try { formatJson('[1,/*没闭合'); } catch (e) { unterminated = true; }
      assert(unterminated, '未闭合块注释经 stripJsonComments 抛错');

      /* ---- unescapeJson：反转义（上游 #1643）---- */
      // 带外层引号：整体是一个 JSON 字符串，解开后拿到里面的内容
      assert.eq(unescapeJson('"{\\"a\\":1}"'), '{"a":1}', '带外层双引号');
      assert.eq(unescapeJson("'{\\\"a\\\":1}'"), '{"a":1}', '带外层单引号');
      // 不带外层引号：手工单遍扫描
      assert.eq(unescapeJson('{\\"a\\":1}'), '{"a":1}', '不带外层引号');
      assert.eq(unescapeJson('{\\\\"a\\\\":1}'), '{\\"a\\":1}', '双层转义只解一层');
      // 嵌套转义必须算对：`\\"` 是「一个反斜杠 + 一个引号」，不是「两个引号」
      assert.eq(unescapeJson('"{\\"s\\":\\"a\\\\\\"b\\"}"'), '{"s":"a\\"b"}', '嵌套转义');
      // 控制字符保持两字符的转义序列，交给 JSON5 自己解
      assert.eq(unescapeJson('{\\"a\\":\\"x\\\\ny\\"}'), '{"a":"x\\ny"}', '\\n 保持转义序列');
      // 没有反斜杠就原样返回
      assert.eq(unescapeJson('{"a":1}'), '{"a":1}', '没有转义就原样');
      assert.eq(unescapeJson('  {"a":1}  '), '{"a":1}', '首尾空白先 trim');
      assert.eq(unescapeJson(''), '', '空串');
      assert.eq(unescapeJson(null), '', 'null');

      /* ---- parseJsonAuto：逐层试 ---- */
      assert.eq(parseJsonAuto('"{\\"a\\":1}"').a, 1, '外层引号里的 JSON 被解开');
      assert.eq(parseJsonAuto('{\\"a\\":1}').a, 1, '无外层引号也解开');
      assert.eq(parseJsonAuto('{\\\\"a\\\\":1}').a, 1, '双层转义也能解开');
      assert.eq(parseJsonAuto('{"a":1}').a, 1, '本来就合法的 JSON 原样');
      assert.eq(parseJsonAuto('[1,2]').length, 2, '数组');
      assert.eq(parseJsonAuto('"hello"'), 'hello', '解出来只是字符串就保持字符串');
      assert.eq(parseJsonAuto('"not json"'), 'not json', '内层不是 JSON 就保持字符串');

      /* ---- formatJson + autoUnescape ---- */
      assert.eq(formatJson('"{\\"a\\":1}"'), '"{\\"a\\":1}"', '默认不开自动反转义');
      assert.eq(formatJson('"{\\"a\\":1}"', { autoUnescape: true, indentSize: 0 }), '{"a":1}', '开了就解开');
      assert.eq(formatJson('{\\"a\\":1}', { autoUnescape: true, indentSize: 0 }), '{"a":1}', '无外层引号也解开');
      assert.eq(formatJson('{\\"b\\":2,\\"a\\":1}', { autoUnescape: true, indentSize: 0 }), '{"a":1,"b":2}', '解开后照常排序键');
      assert.eq(formatJson('{\\"users\\":[{\\"id\\":\\"1\\"}]}', { autoUnescape: true, indentSize: 0 }),
        '{"users":[{"id":"1"}]}', '嵌套结构');
      // 已经合法的 JSON 不能被反转义弄坏 —— 上游就是在这里丢数据的
      assert.eq(formatJson('{"s":"a\\"b"}', { autoUnescape: true, indentSize: 0 }), '{"s":"a\\"b"}', '合法 JSON 不受损');
      assert.eq(formatJson('{"s":"a\\\\nb"}', { autoUnescape: true, indentSize: 0 }), '{"s":"a\\\\nb"}', '合法 JSON 里的 \\n 不受损');
      assert.eq(formatJson('{"a":1}', { autoUnescape: true, indentSize: 2 }), '{\n  "a": 1\n}', '开着也不影响正常输入');
      assert.eq(formatJson('"hello"', { autoUnescape: true, indentSize: 0 }), '"hello"', '普通字符串保持字符串');
      // 非法输入照样报错
      var autoThrew = false;
      try { formatJson('{"incomplete', { autoUnescape: true }); } catch (e) { autoThrew = true; }
      assert(autoThrew, '非法输入经自动反转义后仍应抛错');

      /* ---- 修复 JSON（上游 #1539）---- */
      // jsonrepair 修的是常见手误
      assert.eq(repairJsonText('{"a":1 "b":2}'), '{"a":1, "b":2}', '补上漏掉的逗号');
      assert.eq(repairJsonText('[1,2,3'), '[1,2,3]', '补上没闭合的方括号');
      assert.eq(repairJsonText('{"a":1,}'), '{"a":1}', '去掉尾逗号');
      assert.eq(repairJsonText('{"a":1,"b":}'), '{"a":1,"b":null}', '缺的值补成 null');
      assert.eq(repairJsonText("{'a':'b'}"), '{"a":"b"}', '单引号换成双引号');
      assert.eq(repairJsonText('{"a":1}'), '{"a":1}', '本来就合法的不动');
      // 修不好的要抛错（错误信息带位置）
      var repairThrew = false;
      try { repairJsonText('{"a":1} 还有别的东西'); } catch (e) { repairThrew = true; }
      assert(repairThrew, '修不好的文本应抛错');
      assert.eq(canRepair('{"a":1 "b":2}'), true, '能修的文本 canRepair 为真');
      assert.eq(canRepair('{"a":1} 还有别的东西'), false, '修不了的文本 canRepair 为假');

      // 上游那个用例：'{"foo": "bar", "baz":}' 修好后 baz 变成 null
      assert.eq(formatJson('{"foo": "bar", "baz":}', { sortKeys: false, repair: true, indentSize: 0 }),
        '{"foo":"bar","baz":null}', '上游的用例：缺的值补成 null');
      // 修不好又没开开关 —— 照样抛错
      var noRepairThrew = false;
      try { formatJson('{"foo": "bar", "baz":}', { repair: false }); } catch (e) { noRepairThrew = true; }
      assert(noRepairThrew, '没开修复开关时坏 JSON 仍应抛错');

      // **关键差异**：开关开着也不能把本来合法的 JSON5 改坏
      // （上游是「开关一开就把原文整个丢给 jsonrepair」，十六进制数字会变成字符串）
      assert.eq(formatJson('{"a":0xFF}', { repair: true, indentSize: 0 }), '{"a":255}',
        '十六进制数字不能被改成字符串（上游会变成 "0xFF"）');
      assert.eq(formatJson('{"a":NaN}', { repair: true, indentSize: 0 }), '{"a":null}',
        'NaN 不能被改成字符串');
      assert.eq(formatJson('{"a":1}', { repair: true, indentSize: 0 }), '{"a":1}', '合法 JSON 不受影响');
      assert.eq(formatJson('{a:1}', { repair: true, indentSize: 0 }), '{"a":1}', 'JSON5 的无引号键不受影响');
      assert.eq(formatJson('{"a":1 /*注释*/}', { repair: true, indentSize: 0 }), '{"a":1}', '注释不受影响');

      // repaired 标记：只有真的动过手才是 true
      assert.eq(formatJsonResult('{"a":1}', { repair: true }).repaired, false, '合法输入不算修过');
      assert.eq(formatJsonResult('{"a":1 "b":2}', { repair: true }).repaired, true, '坏输入算修过');
      assert.eq(formatJsonResult('{"a":1 "b":2}', { repair: true, indentSize: 0 }).json, '{"a":1,"b":2}',
        '修好之后照样排序、缩进');
      assert.eq(formatJsonResult('{"a":1 "b":2}', { repair: true, sortKeys: false, indentSize: 2 }).json,
        '{\n  "a": 1,\n  "b": 2\n}', '修好之后按缩进输出');
      assert.eq(formatJsonResult('{"a":1}', { repair: true }).json, '{\n   "a": 1\n}', '默认缩进 3');

      // 修好之后大整数还是大整数（jsonrepair 保留了原文，但解析仍要过哨兵那一关）
      assert.eq(formatJson('{"a":9223372036854775807 "b":2}', { repair: true, indentSize: 0 }),
        '{"a":9223372036854775807,"b":2}', '修好之后大整数不丢精度');

      // parseJsonRepaired 直接用
      assert.eq(parseJsonRepaired('{"a":1 "b":2}').b, 2, 'parseJsonRepaired 修好后能取值');
      var repairedThrew = false;
      try { parseJsonRepaired('{"a":1} 还有别的东西'); } catch (e) { repairedThrew = true; }
      assert(repairedThrew, 'parseJsonRepaired 修不好时抛错');
    }
  };
})();