/* ==========================================================================
   JSON 转 TOML（json-to-toml）

   把一份 JSON 转成 TOML 文档。

   参考实现：src/tools/json-to-toml/（it-tools, GPLv3）
   与原版的四处差别（和 yaml-to-toml 完全同源，只是输入端换成 JSON）：

   1. **多了一层输入预处理：去注释 + 去 elision**。原版直接把文本丢给
      `JSON5.parse`，所以注释、尾逗号、单引号、无引号键都能白拿。manifest
      后来给本工具补上了 json5，这里恢复成 `JSON5.parse`；但 json5@2.x
      不认「两个连续逗号」，而这恰恰是「逗号 + 注释 + 逗号」剥完注释之后的
      形状（照原版直接调会在用户身上炸）。所以交给 JSON5 之前先跑一遍
      `normalizeJson5` —— 两步都在这个函数里，详见它的注释。

   2. **顶层不是表时报错**。`TOML.stringify` 只接受对象，传数组 / 标量会抛
      `Can only stringify objects, not array`；原版靠 `withDefaultOnError` 把它
      吞成空串，页面上什么都看不见。这里提前判掉并说明原因 —— TOML 的根本来
      就必须是表，这是格式的限制而不是工具的限制。

   3. **null 不再被静默丢掉**。实测 `@iarna/toml` 遇到值为 `null` 的键会直接
      **不输出这个键**（数组里的 null 也会被滤掉）：
          TOML.stringify({a: null, b: 1})  →  'b = 1\n'
      丢数据不该是转换的代价，这里改成报错并点名是哪几条路径。

   4. **错误信息**：JSON 解析失败与 TOML 生成失败分开报，位置信息保留。

   输出去掉了库结果自带的结尾换行（与原版的 `.trim()` 一致）。
   - 补了下载按钮（上游 #1169）：输出区多一个 Download 按钮，把结果存成
     output.toml。下载用的是 app.js 里早就写好的 ItTools.download，
     这里只是把按钮补上（文件名与上游一致）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-to-toml');
  var TOML_LIB = window.TOML;
  var JSON5_LIB = window.JSON5;

  /** null 路径最多列这么多条，剩下的只报个数 —— 免得一行错误刷屏。 */
  var MAX_REPORTED_PATHS = 5;

  /**
   * 抛一条已经是中文、不需要再翻译的错误。
   * @param {string} msg
   */
  function fail(msg) {
    var err = new Error(msg);
    err.friendly = true;
    throw err;
  }

  /* ---- 输入预处理：去注释 + 去 elision，再交给 JSON5 ---- */

  /**
   * 从 src[i]（必须是引号）开始读一个字符串字面量，返回结束引号之后的下标；
   * 没闭合就返回 src.length。
   *
   * 去注释和去 elision 都靠它跳过字符串 —— 字符串里的双斜杠、逗号都不是语法。
   * JSON5 允许单引号，所以两种引号都要认；反斜杠转义把后一个字符无条件带走
   * （哪怕它就是引号本身）。
   *
   * @param {string} src
   * @param {number} i 引号所在下标
   * @returns {number}
   */
  function skipStringLiteral(src, i) {
    var quote = src.charAt(i);
    var n = src.length;
    var j = i + 1;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      j++;
      if (c === quote) return j;
    }
    return n;
  }

  /**
   * 剥掉注释：双斜杠行注释、斜杠星号块注释。
   *
   * 块注释换成**一个空格**而不是空串，否则两个数字会被粘成另一个数字。
   * 未闭合的块注释一路吃到结尾 —— 留给 JSON5 只会得到一句更难懂的报错。
   *
   * @param {string} src
   * @returns {string}
   */
  function stripJsonComments(src) {
    var s = String(src == null ? '' : src);
    var out = '';
    var i = 0;
    var n = s.length;
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === '"' || ch === "'") {
        var end = skipStringLiteral(s, i);
        out += s.slice(i, end);
        i = end;
        continue;
      }
      if (ch === '/' && s.charAt(i + 1) === '*') {
        i += 2;
        while (i < n && !(s.charAt(i) === '*' && s.charAt(i + 1) === '/')) i++;
        i = i < n ? i + 2 : n;
        out += ' ';
        continue;
      }
      if (ch === '/' && s.charAt(i + 1) === '/') {
        while (i < n && s.charAt(i) !== '\n') i++;
        continue;                 // 换行留给下一轮，这样行号才对得上
      }
      out += ch;
      i++;
    }
    return out;
  }

  /**
   * 去掉 elision —— 两个连续逗号之间的空洞。
   *
   * json5@2.x（这个 bundle 是 2.6.5）**不支持 elision**，而 JSON / JSON5 里
   * 本来也没有「空洞数组」这种东西。最典型的踩雷姿势是「逗号 + 注释 + 逗号」：
   * 数组第 1 项后面先逗号、再一段注释、再一个逗号就挂了，行注释同理。
   * 病根是逗号不是注释：把注释剥掉只会让它变成两个连续逗号，照样抛。
   * （最早记的诊断是「块注释紧跟逗号时分词器就挂了」，实测是错的 ——
   *   `[1,` + 块注释 + `2]`、`{a:1,` + 块注释 + `b:2,}` 都是正常的。
   *   test/js/check-vendor.js 里存着更正后的对照。）
   *
   * 所以这里直接把多余的逗号删掉，不存在改坏的可能；字符串里的连续逗号原样留着。
   *
   * @param {string} src
   * @returns {string}
   */
  function stripElisions(src) {
    var s = String(src == null ? '' : src);
    var out = '';
    var i = 0;
    var n = s.length;
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === '"' || ch === "'") {
        var end = skipStringLiteral(s, i);
        out += s.slice(i, end);
        i = end;
        continue;
      }
      if (ch === ',') {
        // 往后跳过空白；下一个有效字符还是逗号的话，这个就是多余的。
        // 让位给第二个逗号（保留它当分隔符），而不是两个一起删。
        var j = i + 1;
        while (j < n && /\s/.test(s.charAt(j))) j++;
        if (s.charAt(j) === ',') { i = j; continue; }
      }
      out += ch;
      i++;
    }
    return out;
  }

  /**
   * 规范化：去注释 + 去 elision。工具侧只有这一个纯文本入口。
   *
   * 这一整段在三个模块里各存了一份：**没有构建步骤**，跨文件共享只能挂 window，
   * 而 window 上的东西在单独跑 harness 时加载顺序不可靠 —— 复制是这里唯一
   * 稳妥的做法。
   *
   * @param {string} src
   * @returns {string}
   */
  function normalizeJson5(src) {
    return stripElisions(stripJsonComments(src));
  }

  /**
   * 把 JSON5 自己的 SyntaxError 压成一行中文。
   * message 形如「JSON5: invalid character ',' at 1:9」（列号从 0 起），
   * 原因和行列都在里面，去掉冗余的 JSON5 前缀即可。
   *
   * @param {*} err
   * @returns {Error} 带 friendly 标记
   */
  function json5Failure(err) {
    var wrapped = new Error('JSON5 解析失败：' +
      String((err && err.message) || err).replace(/^JSON5:\s*/, ''));
    wrapped.friendly = true;
    return wrapped;
  }

  /**
   * 工具侧唯一的解析入口：文本 → JS 值。
   *
   * 先把**原文**直接喂给 JSON5：它能吃就吃掉，这样万一还有别的语法错，
   * 报出来的行列指的是用户真正写的东西。只有它拒绝了才走规范化那一遍 ——
   * 代价是那种情况下行列是规范化之后的位置（原因本身仍然准）。
   *
   * 返回 undefined 表示「空文档」：原输入是空白，或者整段都是注释。
   *
   * @param {string} src
   * @returns {*}
   */
  function parseJsonInput(src) {
    var raw = String(src == null ? '' : src);
    if (raw.trim()) {
      // 先保住超范围整数再解析：JSON5 会把它舍成相邻的浮点值，而且一声不吭
      try { return JSON5_LIB.parse(U.guardBigIntegers(raw)); } catch (e) { /* 走规范化那一遍 */ }
    }
    var normalized = normalizeJson5(raw);
    if (!normalized.trim()) return undefined;
    try {
      return JSON5_LIB.parse(U.guardBigIntegers(normalized));
    } catch (e) {
      throw json5Failure(e);
    }
  }

  /** 是不是一个「表」（TOML 的根能挂的对象）。数组和标量都不算。 */
  function isTable(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * 找出所有值为 null 的字段，返回形如 `a.b[0].c` 的路径列表。
   * @param {*} value
   * @param {string} [prefix]
   * @param {Array<string>} [out]
   * @returns {Array<string>}
   */
  function findNullPaths(value, prefix, out) {
    prefix = prefix || '';
    out = out || [];
    if (value === null) { out.push(prefix || '(顶层)'); return out; }
    if (Array.isArray(value)) {
      value.forEach(function (v, i) { findNullPaths(v, prefix + '[' + i + ']', out); });
      return out;
    }
    if (isTable(value)) {
      Object.keys(value).forEach(function (k) {
        findNullPaths(value[k], prefix + (prefix ? '.' : '') + k, out);
      });
    }
    return out;
  }

  /**
   * 把 null 路径列表压成一句提示。
   * @param {Array<string>} paths
   * @returns {string}
   */
  function describeNullPaths(paths) {
    var head = paths.slice(0, MAX_REPORTED_PATHS).join('、');
    var tail = paths.length > MAX_REPORTED_PATHS
      ? ' 等共 ' + paths.length + ' 处'
      : '';
    return 'TOML 没有 null 值，下列字段会被直接丢弃：' + head + tail +
           '。请删掉这些字段，或给它们填上实际值（空字符串写成 ""）。';
  }

  /**
   * 主函数：JSON 文本 → TOML 文本。
   * @param {string} text
   * @returns {string} 空输入返回空串
   */
  function jsonToToml(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return '';

    var value = parseJsonInput(src);
    if (value === undefined || value === null) return '';   // 整段都是注释 / null
    if (!isTable(value)) {
      fail('TOML 的顶层必须是一张表（key: value），而这份 JSON 的顶层是' +
        (Array.isArray(value) ? '一个数组' : '一个标量'));
    }

    var nulls = findNullPaths(value);
    if (nulls.length) fail(describeNullPaths(nulls));

    try {
      // 哨兵被 @iarna/toml 当字符串写出来（它带引号），还原成裸十进制整数
      return U.restoreBigIntegers(TOML_LIB.stringify(value)).trim();
    } catch (e) {
      // stringify 只接受对象，这一步理论上到不了；留着是为了库改行为时也不至于
      // 把英文异常直接甩到页面上。
      fail('TOML 生成失败：' + String((e && e.message) || e));
    }
  }

  window.ItTools.register('json-to-toml', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your JSON here...')
    });
    var output = U.codeBlock();
    var status = D.h('p.form-status');

    function render() {
      var raw = input.value;
      if (!raw.trim()) {
        output.value = '';
        status.textContent = '';
        status.className = 'form-status';
        return;
      }
      try {
        output.value = jsonToToml(raw);
        status.textContent = '';
        status.className = 'form-status';
      } catch (e) {
        output.value = '';
        status.className = 'form-status is-error';
        status.textContent = e.friendly ? e.message : '转换失败：' + String((e && e.message) || e);
      }
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      D.h('label.field-label', { text: t('input', 'Your JSON') }),
      input,
      status,
      D.h('p.field-hint', { text: t('hint', 'Accepts JSON and JSON5: comments, trailing commas, single quotes and unquoted keys are all fine. The top level of a TOML document must be a table, and values cannot be null (TOML has no null).') })
    ));

    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'TOML from your JSON') }),
      output.card,
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download', 'Download'), onclick: function () {
            if (output.value) {
              window.ItTools.download('output.toml', output.value, 'application/toml;charset=utf-8');
            }
          }
        })
      )
    ));

    render();

    return {
      destroy: function () {
        off();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['json-to-toml'] = {
    jsonToToml: jsonToToml,
    findNullPaths: findNullPaths,
    describeNullPaths: describeNullPaths,
    isTable: isTable,
    parseJsonInput: parseJsonInput,
    skipStringLiteral: skipStringLiteral,
    stripJsonComments: stripJsonComments,
    stripElisions: stripElisions,
    normalizeJson5: normalizeJson5,
    json5Failure: json5Failure,
    __cases: function (assert) {
      /* ---- 基本转换（与参考实现的 e2e 期望一致） ---- */
      assert.eq(
        jsonToToml('{\n   "foo": "bar",\n   "list": {\n      "name": "item",\n      "another": {\n         "key": "value"\n      }\n   }\n}'),
        'foo = "bar"\n\n[list]\nname = "item"\n\n  [list.another]\n  key = "value"',
        '嵌套对象转成 TOML 表'
      );

      /* ---- 各种标量与容器 ---- */
      assert.eq(jsonToToml('{"a":1,"b":1.5,"c":true}'), 'a = 1\nb = 1.5\nc = true', '数字与布尔不加引号');
      assert.eq(jsonToToml('{"list":[1,2]}'), 'list = [ 1, 2 ]', '标量数组走行内数组');
      assert.eq(jsonToToml('{"servers":[{"host":"a"},{"host":"b"}]}'),
        '[[servers]]\nhost = "a"\n\n[[servers]]\nhost = "b"', '对象数组转成表数组');
      // 注意 JS 源码里要写 \" 两个反斜杠：单引号字符串里的 \" 只是普通的 "
      assert.eq(jsonToToml('{"a":"it\'s","b":"x\\"y"}'), 'a = "it\'s"\nb = \'x"y\'', '引号按 TOML 规则选字面串 / 基本串');
      assert.eq(jsonToToml('{"d":{"nested":{"deep":1}}}'), '[d.nested]\ndeep = 1',
        '空的外层表不单独输出，直接用带前缀的表头');
      assert.eq(jsonToToml('{}'), '', '空对象得到空 TOML');
      assert.eq(jsonToToml('{"a.b":1}'), '"a.b" = 1', '键里的点会被引起来，不会变成嵌套表');

      /* ---- 空输入 / null ---- */
      assert.eq(jsonToToml(''), '', '空输入输出空串');
      assert.eq(jsonToToml('   \n '), '', '纯空白也算空');
      assert.eq(jsonToToml('// 全是注释'), '', '整段都是注释 → 空文档');
      assert.eq(jsonToToml('null'), '', '顶层 null 相当于空文档');

      /* ---- null 必须报错，而不是被静默丢弃 ---- */
      var nullErr = null;
      try { jsonToToml('{"a":1,"b":null}'); } catch (e) { nullErr = e; }
      assert(nullErr !== null && /b/.test(nullErr.message), 'null 字段报错并点名：' + (nullErr && nullErr.message));
      assert.eq(findNullPaths({ a: null, b: { c: null } }), ['a', 'b.c'], '找出嵌套的 null 路径');
      assert.eq(findNullPaths({ a: [1, { b: null }] }), ['a[1].b'], '数组里的 null 也算');
      assert.eq(findNullPaths({ a: 1, b: false, c: 0 }), [], '0 / false 不是 null，不会被误报');
      assert(/共 6 处/.test(describeNullPaths(['a', 'b', 'c', 'd', 'e', 'f'])), '超过 5 条只报个数');

      /* ---- 顶层不是表 ---- */
      var arrErr = null;
      try { jsonToToml('[1,2]'); } catch (e) { arrErr = e; }
      assert(arrErr !== null && /数组/.test(arrErr.message), '顶层是数组时报错：' + (arrErr && arrErr.message));
      var scalarErr = null;
      try { jsonToToml('42'); } catch (e) { scalarErr = e; }
      assert(scalarErr !== null && /标量/.test(scalarErr.message), '顶层是标量时报错');

      /* ---- JSON5：参考实现能白拿的这些，这里也得能拿 ---- */
      assert.eq(jsonToToml('{a:1}'), 'a = 1', '无引号键');
      assert.eq(jsonToToml("{'a':'b'}"), 'a = "b"', '单引号');
      assert.eq(jsonToToml('{"a":1,}'), 'a = 1', '尾逗号');
      assert.eq(jsonToToml('// 头\n{"a":1} // 尾'), 'a = 1', '行注释');
      assert.eq(jsonToToml('{"a":1,/*x*/"b":2}'), 'a = 1\nb = 2', '块注释');
      assert.eq(jsonToToml('{"url":"http://a.com"}'), 'url = "http://a.com"', '字符串里的双斜杠不是注释');

      /* ---- elision：json5 自己不认，工具侧补掉 ---- */
      assert.eq(jsonToToml('{"a":1,,b:2}'), 'a = 1\nb = 2', '对象里的空洞');
      assert.eq(jsonToToml('{"list":[1,,2]}'), 'list = [ 1, 2 ]', '数组里的空洞');
      assert.eq(jsonToToml('{"list":[1, ,2]}'), 'list = [ 1, 2 ]', '逗号之间夹空白');
      assert.eq(jsonToToml('{"list":[1,,,2]}'), 'list = [ 1, 2 ]', '一串逗号只留一个');
      assert.eq(jsonToToml('{"list":[1,/*x*/,2]}'), 'list = [ 1, 2 ]',
        '注释夹在两个逗号中间 —— 照参考实现直接调 JSON5 就是在这里炸的');
      assert.eq(jsonToToml('{"a":"x,,y"}'), 'a = "x,,y"', '字符串里的连续逗号原样保留');

      /* ---- 非法输入 ---- */
      var truncated = null;
      try { jsonToToml('{"a":'); } catch (e) { truncated = e; }
      assert(truncated !== null && /JSON5 解析失败/.test(truncated.message),
        '截断的输入被拒：' + (truncated && truncated.message));

      var badChar = null;
      try { jsonToToml('{"a":@}'); } catch (e) { badChar = e; }
      assert(badChar !== null && badChar.friendly === true, '带 friendly 标记');
      assert(badChar !== null && /@/.test(badChar.message), '出错字符仍然点名');
      assert(badChar !== null && /at \d+:\d+/.test(badChar.message), '行列信息保留：' + (badChar && badChar.message));

      assert.eq(json5Failure(new Error('JSON5: invalid character \',\' at 1:9')).message,
        "JSON5 解析失败：invalid character ',' at 1:9", 'json5Failure 去掉冗余前缀');

      /* ================= 输入预处理（三个模块里同一份代码） ================= */
      /* ---- skipStringLiteral ---- */
      assert.eq(skipStringLiteral('"ab" x', 0), 4, '普通字符串');
      assert.eq(skipStringLiteral('"a\\"b" x', 0), 6, '转义引号不算结束');
      assert.eq(skipStringLiteral("'a''b'", 0), 3, '单引号字符串到下一个单引号为止（JSON5 不像 JS 那样把两个连续单引号当转义）');
      assert.eq(skipStringLiteral('"unclosed', 0), 9, '没闭合就一路到结尾');

      /* ---- stripJsonComments ---- */
      assert.eq(stripJsonComments('{"url":"http://a.com"}'), '{"url":"http://a.com"}',
        '字符串里的双斜杠不是注释');
      assert.eq(stripJsonComments('{"a":"/* x */"}'), '{"a":"/* x */"}',
        '字符串里的块注释起始符不是注释');
      assert.eq(stripJsonComments('{"a":"x\\"//y\\""}'), '{"a":"x\\"//y\\""}',
        '转义引号不会提前结束字符串，后面的双斜杠仍然是内容');
      assert.eq(stripJsonComments("{'url':'http://a.com'}"), "{'url':'http://a.com'}",
        'JSON5 的单引号字符串里的双斜杠同样不是注释');
      assert.eq(stripJsonComments('{"a":1, // 尾注\n"b":2}'), '{"a":1, \n"b":2}',
        '行注释吃到行尾，换行保留（行号才对得上）');
      assert.eq(stripJsonComments('{"a":1,/*c*/"b":2}'), '{"a":1, "b":2}', '块注释变成一个空格');
      assert.eq(stripJsonComments('[1/*x*/,2]'), '[1 ,2]', '块注释不会把前后两个数字粘成一个');
      assert.eq(stripJsonComments('/*头*/\n{"a":1}//尾'), ' \n{"a":1}', '文件级的注释');
      assert.eq(stripJsonComments('{"a":1/*没闭合'), '{"a":1 ', '未闭合的块注释吃到结尾，不抛错');
      assert.eq(stripJsonComments('// 只有注释'), '', '整段都是行注释 → 空串');
      assert.eq(stripJsonComments('/* 只有注释 */'), ' ', '整段都是块注释 → 只剩一个空格');
      assert.eq(stripJsonComments(''), '', '空串');
      assert.eq(stripJsonComments(null), '', 'null 输入');

      /* ---- stripElisions ---- */
      assert.eq(stripElisions('[1,,2]'), '[1,2]', '两个连续逗号 → 留一个');
      assert.eq(stripElisions('[1, ,2]'), '[1,2]', '逗号之间夹空白也吃');
      assert.eq(stripElisions('[1,,,2]'), '[1,2]', '一串逗号只留一个');
      assert.eq(stripElisions('[1,,]'), '[1,]', '尾部多逗号留一个（JSON5 认尾逗号）');
      assert.eq(stripElisions('{a:1,,b:2}'), '{a:1,b:2}', '对象里的空洞');
      assert.eq(stripElisions('["a,,b"]'), '["a,,b"]', '字符串里的连续逗号不能被吃');
      assert.eq(stripElisions('["a\\",,b"]'), '["a\\",,b"]', '转义引号里的连续逗号同样不能被吃');
      assert.eq(stripElisions("{'a,,':1}"), "{'a,,':1}", '单引号字符串里的连续逗号同样不能被吃');
      assert.eq(stripElisions('[1, 2]'), '[1, 2]', '正常逗号原样保留');
      assert.eq(stripElisions(''), '', '空串');

      /* ---- normalizeJson5：注释 + elision 一起 ---- */
      assert.eq(normalizeJson5('[1,/*x*/,2]'), '[1,2]',
        '注释夹在两个逗号中间 —— 这正是 json5 自己会挂的形状');
      assert.eq(normalizeJson5('[1,//x\n,2]'), '[1,2]', '行注释夹在两个逗号中间');
      assert.eq(normalizeJson5('{a:1,/*x*/,b:2}'), '{a:1,b:2}', '对象里的注释 + 空洞');
      assert.eq(normalizeJson5('/*a*/{/*b*/x/*c*/:/*d*/1/*e*/,/*f*/}'), ' { x : 1 , }',
        '注释密到只剩空格');
      assert.eq(normalizeJson5('["a,,b"]'), '["a,,b"]', '字符串里的连续逗号原样保留');

      /* ---- 幂等：跑两遍结果必须一样 ---- */
      ['[1,/*x*/,2]', '{a:1,,b:2}', '[1, ,2]', '["a,,b"]', '{"a":1,//c\n"b":2}',
       '[1,,,2]', '{a:1,/*x*/}', '// 全部注释', ''].forEach(function (src) {
        var once = normalizeJson5(src);
        assert.eq(normalizeJson5(once), once, 'normalizeJson5 幂等：' + JSON.stringify(src));
      });
    }
  };
})();
