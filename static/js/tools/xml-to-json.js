/* ==========================================================================
   XML 转 JSON（xml-to-json）

   把 XML 转成 JSON，用的是 xml-js 的 **compact** 结构（和参考实现一致）：
     · 属性      → `_attributes`
     · 文本      → `_text`
     · CDATA     → `_cdata`
     · 注释      → `_comment`
     · 声明 / 文档类型 → `_declaration` / `_doctype`
     · 同名兄弟元素 → 数组
   （compact 与之相对的是 non-compact 的 `elements: [{type, name, attributes…}]`
   AST，见下面「关于 xml-js 的几个函数」一节。）

   参考实现：src/tools/xml-to-json/（it-tools, GPLv3）
   与原版的两处差别：

   1. **未闭合的标签会被抓出来**。这是本模块最主要的一个坑。实测 xml-js 的
      sax 解析器在 compact 模式下**不校验标签配对**：`<a>`（缺 `</a>`）会正常
      返回一个对象，只是给这个元素塞了一个 `_parent` 指针，于是整棵树变成
      循环引用。随后 `JSON.stringify` 抛
      `TypeError: Converting circular structure to JSON` —— 用户看到的是一句
      完全不知所云的报错。这里主动扫一遍 compact 结构，把所有带 `_parent` 的
      位置找出来，取最深的那一个报成「标签 <x> 没有闭合」。

   2. **错误信息**。原版的校验规则借用 `xml-formatter`（见下面「关于 xml-js
      的几个函数」），页面上只显示一句 "Provided XML is not valid."；转换本身
      又走 `withDefaultOnError` 吞成空串。xml-js 自己的错误其实很具体
      （`Unmatched closing tag: b`，并带 `Line` / `Column`），这里直接用。

   ------------------------------------------------------------------------
   关于 xml-js 的几个函数（实测结论，写下来免得以后再踩一遍）：

   · `xml2js(str, opts)`  → **返回对象**。`{compact:true}` 出 compact 结构，
     不给（或给 false）出 non-compact 的完整 AST。
   · `xml2json(str, opts)` → **返回 JSON 文本字符串**，等价于
     `JSON.stringify(xml2js(str, opts), null, opts.spaces)`。也就是说它比
     `xml2js` 只多一个 stringify，多写一次没有任何好处 —— 所以本模块用
     `xml2js`。（注意 compact 模式下它对带 `_parent` 的结构同样会炸。）
   · `js2xml(obj, opts)`   → 对象 → XML 文本。
   · `json2xml(str, opts)` → **JSON 文本** → XML 文本，内部就是
     `JSON.parse(str)` 再交给 js2xml；喂给它 XML 会抛
     `The JSON structure is invalid`。json-to-xml 那侧同理用 `js2xml`。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('xml-to-json');
  var XML2JS = window.xml2js;

  /** 与参考实现一致：JSON.stringify(obj, null, 2)。 */
  var JSON_INDENT = 2;

  /**
   * 把 xml-js 的异常压成一行可读的说明。
   * 它的 message 形如 `Unmatched closing tag: b\nLine: 0\nColumn: 7\nChar: >`，
   * 而 **Line / Column 都是 0 起的**，这里 +1 再报。
   * @param {*} err
   * @returns {string}
   */
  function describeError(err) {
    var msg = String((err && err.message) || err);
    var reason = msg.split('\n')[0];
    var line = /Line: (\d+)/.exec(msg);
    var col = /Column: (\d+)/.exec(msg);
    if (line && col) {
      // 空格放在代码里，不放在语言包的值里 —— 值的前后空白靠不住
      return reason + ' ' + t('err_pos', '(line {line}, column {col})')
        .replace('{line}', String(Number(line[1]) + 1))
        .replace('{col}', String(Number(col[1]) + 1));
    }
    return reason;
  }

  /**
   * 找出 compact 结构里所有「开了但没关」的元素位置。
   *
   * xml-js 的 sax 在 compact 模式下不校验配对：遇到没闭合的元素时，
   * 它会往这个元素上挂一个指向根的 `_parent`，结果是循环引用。所以
   * **凡是带 `_parent` 的元素就是没闭合的**，扫一遍就够了。
   *
   * @param {*} node
   * @param {string} [path] 形如 `/a/b[0]` 的定位路径
   * @param {Array<string>} [out]
   * @returns {Array<string>}
   */
  function findUnclosedPaths(node, path, out) {
    path = path || '';
    out = out || [];
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      node.forEach(function (v, i) { findUnclosedPaths(v, path + '[' + i + ']', out); });
      return out;
    }
    var keys = Object.keys(node);
    if (keys.indexOf('_parent') >= 0) out.push(path);
    keys.forEach(function (k) {
      if (k !== '_parent') findUnclosedPaths(node[k], path + '/' + k, out);
    });
    return out;
  }

  /** 路径深度（`/a/b[0]` 算 2 段）。 */
  function pathDepth(p) {
    return p.split('/').length;
  }

  /**
   * 从 compact 结构里找出最深的那个未闭合标签名；没有就返回 null。
   *
   * 取「最深」而不是「第一个」：`<a><b>` 里 a 和 b 都没关，但 b 才是用户
   * 手滑漏掉的那个，通常也是他真正要找的位置。路径里的数组下标（`[0]`）
   * 会被剥掉，因为 XML 标签名里不可能有方括号。
   *
   * @param {*} node
   * @returns {string|null}
   */
  function findUnclosedTag(node) {
    var hits = findUnclosedPaths(node, '');
    if (!hits.length) return null;
    var deepest = hits[0];
    hits.forEach(function (p) { if (pathDepth(p) > pathDepth(deepest)) deepest = p; });
    var segs = deepest.split('/').filter(Boolean);
    return (segs[segs.length - 1] || '').replace(/\[.*\]$/, '');
  }

  /**
   * 主函数：XML 文本 → JSON 文本（compact 结构）。
   * @param {string} text
   * @returns {string} 空输入返回空串
   */
  function xmlToJson(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return '';

    var obj = XML2JS(src, { compact: true });

    var unclosed = findUnclosedTag(obj);
    if (unclosed) {
      var err = new Error(t('err_unclosed', 'Tag <{tag}> has no matching </{tag}> closing tag')
        .replace(/\{tag\}/g, unclosed));
      err.friendly = true;
      throw err;
    }

    try {
      return JSON.stringify(obj, null, JSON_INDENT);
    } catch (e) {
      if (e && /circular/i.test(e.message || '')) {
        throw new Error(t('err_circular', 'The XML structure contains a cycle and cannot be converted to JSON'));
      }
      throw e;
    }
  }

  window.ItTools.register('xml-to-json', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your XML content here...')
    });
    input.value = '<a x="1.234" y="It\'s"/>';   // 参考实现的默认输入
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
        output.value = xmlToJson(raw);
        status.textContent = '';
        status.className = 'form-status';
      } catch (e) {
        output.value = '';
        status.className = 'form-status is-error';
        status.textContent = e.friendly ? e.message
          : t('err_parse', 'XML parse failed: {msg}').replace('{msg}', describeError(e));
      }
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      D.h('label.field-label', { text: t('input', 'Your XML content') }),
      input,
      status,
      D.h('p.field-hint', {
        text: t('hint',
          'Compact structure: attributes in _attributes, text in _text, CDATA in _cdata, comments in _comment; sibling elements with the same name become an array.')
      })
    ));

    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'Converted JSON') }),
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

  window.ItTools.logic['xml-to-json'] = {
    xmlToJson: xmlToJson,
    findUnclosedPaths: findUnclosedPaths,
    findUnclosedTag: findUnclosedTag,
    describeError: describeError,
    __cases: function (assert) {
      /* ---- 基本转换（与参考实现的默认样例一致） ---- */
      assert.eq(xmlToJson('<a x="1.234" y="It\'s"/>'),
        '{\n  "a": {\n    "_attributes": {\n      "x": "1.234",\n      "y": "It\'s"\n    }\n  }\n}',
        '带属性的空元素');

      assert.eq(xmlToJson('<a k="1">v</a>'),
        '{\n  "a": {\n    "_attributes": {\n      "k": "1"\n    },\n    "_text": "v"\n  }\n}',
        '属性与文本并存');
      assert.eq(xmlToJson('<a/>'), '{\n  "a": {}\n}', '空元素是空对象');
      assert.eq(xmlToJson('<a>&lt;&amp;&gt;</a>'), '{\n  "a": {\n    "_text": "<&>"\n  }\n}', '实体被解码');
      assert.eq(xmlToJson('<a><![CDATA[<x>]]></a>'), '{\n  "a": {\n    "_cdata": "<x>"\n  }\n}', 'CDATA 单独放 _cdata');

      /* ---- 结构性内容 ---- */
      assert.eq(xmlToJson('<root><item>1</item><item>2</item></root>'),
        '{\n  "root": {\n    "item": [\n      {\n        "_text": "1"\n      },\n      {\n        "_text": "2"\n      }\n    ]\n  }\n}',
        '同名兄弟元素变成数组');
      assert.eq(xmlToJson('<?xml version="1.0"?><r/>'),
        '{\n  "_declaration": {\n    "_attributes": {\n      "version": "1.0"\n    }\n  },\n  "r": {}\n}',
        'XML 声明');
      assert.eq(xmlToJson('<!DOCTYPE r SYSTEM "r.dtd"><r/>'),
        '{\n  "_doctype": "r SYSTEM \\"r.dtd\\"",\n  "r": {}\n}',
        'DOCTYPE');
      assert.eq(xmlToJson('<!-- c --><r/>'), '{\n  "_comment": " c ",\n  "r": {}\n}', '注释');
      assert.eq(xmlToJson('<ns:a xmlns:ns="urn:x"><ns:b>t</ns:b></ns:a>'),
        '{\n  "ns:a": {\n    "_attributes": {\n      "xmlns:ns": "urn:x"\n    },\n    "ns:b": {\n      "_text": "t"\n    }\n  }\n}',
        '带命名空间前缀的标签名原样保留');
      assert.eq(xmlToJson('<a>hello <b>world</b> tail</a>'),
        '{\n  "a": {\n    "_text": [\n      "hello ",\n      " tail"\n    ],\n    "b": {\n      "_text": "world"\n    }\n  }\n}',
        '子元素前后的文本合并成 _text 数组（xml-js 的既定行为，不做改写）');

      /* ---- 空输入 ---- */
      assert.eq(xmlToJson(''), '', '空输入输出空串');
      assert.eq(xmlToJson('   \n '), '', '纯空白算空（库会返回 {}，不该凭空冒出空对象）');

      /* ---- 未闭合的标签：原版会甩一句 circular，这里指名道姓 ---- */
      var unclosed = null;
      try { xmlToJson('<a>'); } catch (e) { unclosed = e; }
      assert(unclosed !== null && /<a>.*<\/a>/.test(unclosed.message), '未闭合的 a 被点名：' + (unclosed && unclosed.message));
      // <a><b> 两层都没关，要报最深的那个
      var nested = null;
      try { xmlToJson('<a><b>'); } catch (e) { nested = e; }
      assert(nested !== null && /<b>/.test(nested.message), '多层未闭合报最深的一个：' + (nested && nested.message));
      // <a><b></b>：b 关了，只有 a 没关
      var outerOnly = null;
      try { xmlToJson('<a><b></b>'); } catch (e) { outerOnly = e; }
      assert(outerOnly !== null && /<a>/.test(outerOnly.message), '只有外层没关时报外层');
      // 数组元素里的未闭合也不能漏
      var inArray = null;
      try { xmlToJson('<a><b/><c>'); } catch (e) { inArray = e; }
      assert(inArray !== null && /<c>/.test(inArray.message), '数组 / 兄弟元素里的未闭合也能找到');
      assert.eq(findUnclosedPaths({ a: { _parent: {}, b: {} } }, ''), ['/a'], 'findUnclosedPaths 只认 _parent');
      assert.eq(findUnclosedTag({ a: { b: {} } }), null, '结构完整时返回 null');

      /* ---- 非法 XML：保留库的英文原因 + 中文行列 ---- */
      var unmatched = null;
      try { xmlToJson('<a></b>'); } catch (e) { unmatched = e; }
      assert(unmatched !== null, '标签不配对报错');
      assert.eq(describeError(unmatched), 'Unmatched closing tag: b (line 1, column 8)', '错误带行列（库的行列是 0 起的）');

      var stray = null;
      try { xmlToJson('plain'); } catch (e) { stray = e; }
      assert(/Text data outside of root node/.test(describeError(stray)), '根节点之外的文本报错');

      var quote = null;
      try { xmlToJson('<a x=1/>'); } catch (e) { quote = e; }
      assert(/Unquoted attribute value/.test(describeError(quote)), '属性没加引号报错');

      var entity = null;
      try { xmlToJson('<a>&bad;</a>'); } catch (e) { entity = e; }
      assert(/Invalid character entity/.test(describeError(entity)), '非法实体报错');

      var multiline = null;
      try { xmlToJson('<a>\n  <b>\n</a>'); } catch (e) { multiline = e; }
      assert.eq(describeError(multiline), 'Unexpected close tag (line 3, column 5)', '多行输入的行列也算对');

      assert.eq(describeError(new Error('boom\nLine: 2\nColumn: 3\nChar: >')), 'boom (line 3, column 4)',
        'describeError 单独用也正确');
    }
  };
})();