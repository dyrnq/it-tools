/* ==========================================================================
   JSON 转 XML（json-to-xml）

   把一份 JSON（compact 结构）转成 XML：
     · `_attributes` → 属性
     · `_text` / 直接给标量 → 文本
     · `_cdata` / `_comment` / `_doctype` / `_declaration` → 各自的特殊内容
     · 同名元素的值是数组 → 重复输出该标签
   输出的 XML 再喂回 xml-to-json 能得到原来那份 JSON。

   参考实现：src/tools/json-to-xml/（it-tools, GPLv3）
   与原版的三处差别：

   1. **多了一层输入预处理：去注释 + 去 elision**。原版直接把文本丢给
      `JSON5.parse`，所以注释、尾逗号、单引号、无引号键都能白拿。manifest
      后来给本工具补上了 json5，这里恢复成 `JSON5.parse`；但 json5@2.x
      不认「两个连续逗号」，而这恰恰是「逗号 + 注释 + 逗号」剥完注释之后的
      形状（照原版直接调会在用户身上炸）。所以交给 JSON5 之前先跑一遍
      `normalizeJson5` —— 两步都在这个函数里，详见它的注释。

   2. **顶层形状要报错**。xml-js 的 compact 序列化器要求根是一个对象。
      喂数组或标量它不会报错，而是按数组下标硬编出标签名：
          js2xml([1, 2], {compact:true})      →  '<0>1</0><1>2</1>'
          js2xml('str',  {compact:true})      →  '<0>s</0><1>t</0>…'
      也就是把 JSON 的每个字符变成一个标签 —— 一份完全看不懂、也解析不回去的
      XML。喂 null / true 更是静默返回空串，用户只会觉得「工具没反应」。
      XML 规范要求恰好一个根元素，所以这里提前判掉并说明该包一层什么。

   3. **错误信息**。原版靠 `withDefaultOnError` 吞成空串。这里把 JSON 解析失败
      和 XML 生成失败分开报。

   ------------------------------------------------------------------------
   关于 xml-js 的几个函数（实测结论，写下来免得以后再踩一遍）：

   · `js2xml(obj, opts)`   → **对象** → XML 文本，本模块用它。
   · `json2xml(str, opts)` → **JSON 文本** → XML 文本，内部就是
     `JSON.parse(str)` 再交给 js2xml；喂给它 XML 会抛
     `The JSON structure is invalid`。我们已经拿到对象了，再序列化成字符串
     喂回去纯属浪费，所以走 `js2xml`。
   · `xml2js(str, opts)`  → 返回**对象**（compact 或 non-compact AST）。
   · `xml2json(str, opts)` → 返回 **JSON 文本字符串**。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-to-xml');
  var JS2XML = window.js2xml;
  var JSON5_LIB = window.JSON5;

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
   * 把 JSON5 自己的 SyntaxError 压成一行可读的说明。
   * message 形如「JSON5: invalid character ',' at 1:9」（列号从 0 起），
   * 原因和行列都在里面，去掉冗余的 JSON5 前缀即可。
   *
   * @param {*} err
   * @returns {Error} 带 friendly 标记
   */
  function json5Failure(err) {
    var wrapped = new Error(t('err_json5', 'JSON5 parse failed: {msg}')
      .replace('{msg}', String((err && err.message) || err).replace(/^JSON5:\s*/, '')));
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

  /**
   * 主函数：JSON 文本 → XML 文本。
   * @param {string} text
   * @returns {string} 空输入返回空串
   */
  function jsonToXml(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return '';

    var value = parseJsonInput(src);
    if (value === undefined) return '';   // 整段都是注释，等价于空文档

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      var what = Array.isArray(value) ? t('shape_array', 'an array')
        : value === null ? 'null'
        : t('shape_scalar', 'a scalar');
      // 数组给个更具体的建议（包成 items），其它一律 root。
      var tag = Array.isArray(value) ? 'items' : 'root';
      var shapeErr = new Error(t('err_shape',
        'The top level of the JSON must be an object, because an XML document can only have one root element; the current top level is {what}. Please wrap it first: {"{tag}": …}')
        .replace('{what}', what)
        .replace('{tag}', tag));
      shapeErr.friendly = true;
      throw shapeErr;
    }

    try {
      // XML 没有数字这个类型，哨兵只能还原成文本节点 —— 但至少数字本身还在
      return U.restoreBigIntegers(JS2XML(value, { compact: true }));
    } catch (e) {
      var genErr = new Error(t('err_xml_gen', 'XML generation failed: {msg}')
        .replace('{msg}', String((e && e.message) || e)));
      genErr.friendly = true;
      throw genErr;
    }
  }

  window.ItTools.register('json-to-xml', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your JSON content here...')
    });
    input.value = '{"a":{"_attributes":{"x":"1.234","y":"It\'s"}}}';   // 参考实现的默认输入
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
        output.value = jsonToXml(raw);
        status.textContent = '';
        status.className = 'form-status';
      } catch (e) {
        output.value = '';
        status.className = 'form-status is-error';
        status.textContent = e.friendly ? e.message
          : t('err_convert', 'Conversion failed: {msg}').replace('{msg}', String((e && e.message) || e));
      }
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      D.h('label.field-label', { text: t('input', 'Your JSON content') }),
      input,
      status,
      D.h('p.field-hint', {
        text: t('hint',
          'Accepts JSON and JSON5: comments, trailing commas, single quotes and unquoted keys are all fine. Compact structure: attributes go into _attributes, text into _text (a plain scalar works too), and arrays become repeated tags with the same name.')
      })
    ));

    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'Converted XML') }),
      output.card,
    ));

    render();

    return {
      destroy: function () {
        off();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['json-to-xml'] = {
    jsonToXml: jsonToXml,
    parseJsonInput: parseJsonInput,
    skipStringLiteral: skipStringLiteral,
    stripJsonComments: stripJsonComments,
    stripElisions: stripElisions,
    normalizeJson5: normalizeJson5,
    json5Failure: json5Failure,
    __cases: function (assert) {
      /* ---- 基本转换（与参考实现的默认样例一致） ---- */
      assert.eq(jsonToXml('{"a":{"_attributes":{"x":"1.234","y":"It\'s"}}}'),
        '<a x="1.234" y="It\'s"/>', '带属性的空元素');

      /* ---- 各种形状 ---- */
      assert.eq(jsonToXml('{"a":"text"}'), '<a>text</a>', '标量直接当文本');
      assert.eq(jsonToXml('{"a":{"_text":"hi"}}'), '<a>hi</a>', '显式 _text');
      assert.eq(jsonToXml('{"a":null}'), '<a/>', 'null 变成空元素');
      assert.eq(jsonToXml('{"a":true}'), '<a>true</a>', '布尔');
      assert.eq(jsonToXml('{"a":{}}'), '<a/>', '空对象是空元素');
      assert.eq(jsonToXml('{"a":{"b":{"c":"d"}}}'), '<a><b><c>d</c></b></a>', '嵌套');
      assert.eq(jsonToXml('{"root":{"item":[{"_text":"1"},{"_text":"2"}]}}'),
        '<root><item>1</item><item>2</item></root>', '数组变成重复标签');
      assert.eq(jsonToXml('{"a":[1,2]}'), '<a>1</a><a>2</a>', '标量数组同样重复标签');
      assert.eq(jsonToXml('{"a":{"_attributes":{"k":"v"},"_text":"x"}}'), '<a k="v">x</a>', '属性与文本并存');
      assert.eq(jsonToXml('{"a":{"_cdata":"<raw>"}}'), '<a><![CDATA[<raw>]]></a>', 'CDATA');
      assert.eq(jsonToXml('{"_comment":" c ","r":{}}'), '<!-- c --><r/>', '注释');
      assert.eq(jsonToXml('{"_declaration":{"_attributes":{"version":"1.0"}},"r":{}}'),
        '<?xml version="1.0"?><r/>', 'XML 声明');
      // JS 源码里要写 \" 两个反斜杠：单引号字符串里的 \" 只是普通的 "
      assert.eq(jsonToXml('{"a":{"_text":"<x> & \\"y\\""}}'),
        '<a>&lt;x&gt; &amp; "y"</a>', '文本里的 < > & 被转义');
      assert.eq(jsonToXml('{}'), '', '空对象没有根元素，输出空串');

      /* ---- 空输入 ---- */
      assert.eq(jsonToXml(''), '', '空输入输出空串');
      assert.eq(jsonToXml('   \n '), '', '纯空白也算空');
      assert.eq(jsonToXml('// 全是注释'), '', '整段都是注释 → 空文档');
      assert.eq(jsonToXml('/* 全是注释 */'), '', '整段都是块注释 → 空文档');

      /* ---- 顶层形状：必须报错而不是编出 <0>1</0> 这种垃圾 ---- */
      var arrErr = null;
      try { jsonToXml('[1,2]'); } catch (e) { arrErr = e; }
      assert(arrErr !== null && /one root element/.test(arrErr.message), '顶层是数组时报错：' + (arrErr && arrErr.message));
      assert(arrErr !== null && /"items"/.test(arrErr.message), '错误里直接给出建议的包一层写法');

      var scalarErr = null;
      try { jsonToXml('42'); } catch (e) { scalarErr = e; }
      assert(scalarErr !== null && /scalar/.test(scalarErr.message), '顶层是标量时报错');

      var nullErr = null;
      try { jsonToXml('null'); } catch (e) { nullErr = e; }
      assert(nullErr !== null && /null/.test(nullErr.message), '顶层是 null 时报错（库会静默返回空串）');

      /* ---- JSON5：参考实现能白拿的这些，这里也得能拿 ---- */
      assert.eq(jsonToXml('{a:"text"}'), '<a>text</a>', '无引号键');
      assert.eq(jsonToXml("{'a':'text'}"), '<a>text</a>', '单引号');
      assert.eq(jsonToXml('{"a":"x",}'), '<a>x</a>', '尾逗号');
      assert.eq(jsonToXml('// 头\n{"a":"x"} // 尾'), '<a>x</a>', '行注释');
      assert.eq(jsonToXml('{"a":/*c*/"x"}'), '<a>x</a>', '块注释');
      assert.eq(jsonToXml('{"a":"http://a.com"}'), '<a>http://a.com</a>', '字符串里的双斜杠不是注释');

      /* ---- elision：json5 自己不认，工具侧补掉 ---- */
      assert.eq(jsonToXml('{"a":"x",,"b":"y"}'), '<a>x</a><b>y</b>', '对象里的空洞');
      assert.eq(jsonToXml('{"r":{"i":[1,,2]}}'), '<r><i>1</i><i>2</i></r>', '数组里的空洞');
      assert.eq(jsonToXml('{"r":{"i":[1, ,2]}}'), '<r><i>1</i><i>2</i></r>', '逗号之间夹空白');
      assert.eq(jsonToXml('{"r":{"i":[1,,,2]}}'), '<r><i>1</i><i>2</i></r>', '一串逗号只留一个');
      assert.eq(jsonToXml('{"r":{"i":[1,/*x*/,2]}}'), '<r><i>1</i><i>2</i></r>',
        '注释夹在两个逗号中间 —— 照参考实现直接调 JSON5 就是在这里炸的');
      assert.eq(jsonToXml('{"a":"x,,y"}'), '<a>x,,y</a>', '字符串里的连续逗号原样保留');

      /* ---- 非法输入 ---- */
      var truncated = null;
      try { jsonToXml('{"a":'); } catch (e) { truncated = e; }
      assert(truncated !== null && /JSON5 parse failed/.test(truncated.message),
        '截断的输入被拒：' + (truncated && truncated.message));

      var badChar = null;
      try { jsonToXml('{"a":@}'); } catch (e) { badChar = e; }
      assert(badChar !== null && badChar.friendly === true, '带 friendly 标记');
      assert(badChar !== null && /@/.test(badChar.message), '出错字符仍然点名');
      assert(badChar !== null && /at \d+:\d+/.test(badChar.message), '行列信息保留：' + (badChar && badChar.message));

      assert.eq(json5Failure(new Error('JSON5: invalid character \',\' at 1:9')).message,
        "JSON5 parse failed: invalid character ',' at 1:9", 'json5Failure 去掉冗余前缀');

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
