/* ==========================================================================
   YAML 转 JSON（yaml-to-json-converter）

   把 YAML 文本转成 JSON。锚点 / 别名（`&a` `*a`）与 merge key（`<<`）都按
   YAML 1.2 的语义解析，多文档输入（`---` 分隔）会转成一个文档数组。

   参考实现：src/tools/yaml-to-json-converter/（it-tools, GPLv3）
   与原版的三处差别：

   1. **支持多文档**。实测这个 bundle 里的 `YAML.parse()` 遇到第二个 `---`
      会抛 `YAMLParseError`，code 是 `MULTIPLE_DOCS`（"Source contains
      multiple documents; please use YAML.parseAllDocuments()"），
      原版就这么罢工了。而 `YAML.parseAllDocuments` 是存在的，于是这里接住这个
      错误码改走它，多文档时输出**文档数组**：
          `a: 1\n---\nb: 2`  →  `[{"a":1},{"b":2}]`
      只有一份文档时仍然输出单个值，形状和原版一致。
      注意 `parseAllDocuments` 是把错误**收集**进 `doc.errors` 而不是抛出来的，
      `doc.toJS()` 照样会给出一个残缺的值 —— 所以这里必须自己检查 `doc.errors`，
      否则语法错误会被静默转成半截 JSON。

   2. **假值不再被吞掉**。原版是 `obj ? JSON.stringify(obj, null, 3) : ''`，
      于是 `0` / `false` / `null` / `''` 都会得到空串 —— 粘个 `0` 进去输出空白，
      看着像工具坏了。这里统一走 JSON.stringify，输出 `0` / `false` / `null`。
      （输入框为空时仍然什么都不输出。）

   3. **错误信息**。原版靠 `withDefaultOnError` 把异常吞成空串，页面上只剩一个
      「没结果」，用户根本不知道错在哪。这里把库给的英文原因保留，前面加中文前缀
      并补上行列号 —— 只留第一行，库的原始 message 里还带原文片段和 ^ 指示符，
      整段甩给用户反而更难读。

   缩进用 3 空格，与原版一致。
   - 补了下载按钮（上游 #1169）：输出区多一个 Download 按钮，把结果存成
     output.json。下载用的是 app.js 里早就写好的 ItTools.download，
     这里只是把按钮补上（文件名与上游一致）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('yaml-to-json-converter');
  var YAML_LIB = window.YAML;

  /** 与参考实现一致：JSON.stringify(obj, null, 3)。 */
  var JSON_INDENT = 3;

  /**
   * 把库的异常压成一行可读的中文说明：`<英文原因>（第 N 行第 M 列）`。
   * 库里不带位置的错误（比如未定义的别名 "Unresolved alias ..."）原样返回第一行。
   * @param {*} err
   * @returns {string}
   */
  function describeError(err) {
    var msg = String((err && err.message) || err);
    var m = /^(.*?) at line (\d+), column (\d+)/.exec(msg);
    if (m) return m[1] + '（第 ' + m[2] + ' 行第 ' + m[3] + ' 列）';
    return msg.split('\n')[0];
  }

  /**
   * 解析 YAML，返回**文档数组**（长度 1 表示单文档）。
   *
   * 先按常规走 `YAML.parse`；只有它报了 MULTIPLE_DOCS 才退回
   * `parseAllDocuments` —— 后者对单文档输入也能用，但没有前者严格
   * （它不抛错，只把问题挂到 doc.errors 上）。
   *
   * @param {string} src
   * @returns {Array} 每个元素是一个文档的 JS 值
   */
  function parseDocs(src) {
    // 超范围整数在 YAML 解析器里同样会被舍成浮点（YAML 的整数走 JS Number），
    // 而且 `merge` 展开锚点时更容易把它当成普通标量。保护放在解析之前。
    var guarded = U.guardBigIntegers(src, { hashComment: true });
    try {
      return [YAML_LIB.parse(guarded, { merge: true })];
    } catch (err) {
      if (!err || err.code !== 'MULTIPLE_DOCS') throw err;
    }
    var docs = YAML_LIB.parseAllDocuments(guarded, { merge: true });
    var values = [];
    for (var i = 0; i < docs.length; i++) {
      // parseAllDocuments 只收集不抛；不检查的话语法错误会被转成残缺的 JSON。
      if (docs[i].errors && docs[i].errors.length) throw docs[i].errors[0];
      values.push(docs[i].toJS());
    }
    return values;
  }

  /**
   * 主函数：YAML 文本 → JSON 文本。
   * @param {string} text
   * @returns {string} 空输入返回空串
   */
  function yamlToJson(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return '';
    var docs = parseDocs(src);
    try {
      return U.restoreBigIntegers(
        JSON.stringify(docs.length === 1 ? docs[0] : docs, null, JSON_INDENT)
      );
    } catch (e) {
      // 别名自引用（&a 里 *a 指回自己）会造出循环对象，JSON 表示不了。
      if (e && /circular/i.test(e.message || '')) {
        throw new Error('存在循环引用：锚点 / 别名（&a、*a）指回了自己，JSON 表示不了这种结构');
      }
      throw e;
    }
  }

  window.ItTools.register('yaml-to-json-converter', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your yaml here...')
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
        output.value = yamlToJson(raw);
        status.textContent = '';
        status.className = 'form-status';
      } catch (e) {
        output.value = '';
        status.className = 'form-status is-error';
        status.textContent = 'YAML 解析失败：' + describeError(e);
      }
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      D.h('label.field-label', { text: t('input', 'Your YAML') }),
      input,
      status,
      D.h('p.field-hint', { text: t('hint', 'Supports anchors / aliases (&a, *a), merge keys (<<) and multiple documents (separated by ---, output as a JSON array).') })
    ));

    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'JSON from your YAML') }),
      output.card,
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download', 'Download'), onclick: function () {
            if (output.value) {
              window.ItTools.download('output.json', output.value, 'application/json;charset=utf-8');
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

  window.ItTools.logic['yaml-to-json-converter'] = {
    parseDocs: parseDocs,
    yamlToJson: yamlToJson,
    describeError: describeError,
    __cases: function (assert) {
      /* ---- 基本转换（与参考实现的 e2e 期望一致） ---- */
      assert.eq(
        yamlToJson('foo: bar\nlist:\n  - item\n  - key: value'),
        '{\n   "foo": "bar",\n   "list": [\n      "item",\n      {\n         "key": "value"\n      }\n   ]\n}',
        '嵌套列表转 JSON，3 空格缩进'
      );

      /* ---- merge key：原版开的就是 merge: true ---- */
      var merged = yamlToJson(
        'default: &default\n  name: \'\'\n  age: 0\n' +
        'person:\n  *default\n' +
        'persons:\n- <<: *default\n  age: 1\n- <<: *default\n  name: John\n- { age: 3, <<: *default }\n'
      );
      assert.eq(
        merged,
        '{\n   "default": {\n      "name": "",\n      "age": 0\n   },\n' +
        '   "person": {\n      "name": "",\n      "age": 0\n   },\n' +
        '   "persons": [\n      {\n         "name": "",\n         "age": 1\n      },\n' +
        '      {\n         "name": "John",\n         "age": 0\n      },\n' +
        '      {\n         "age": 3,\n         "name": ""\n      }\n   ]\n}',
        '<< 合并进父级键而不是留成字面量键'
      );

      /* ---- 普通锚点 / 别名 ---- */
      assert.eq(yamlToJson('a: &x 1\nb: *x'), '{\n   "a": 1,\n   "b": 1\n}', '锚点与别名展开成值');

      /* ---- 多文档（本模块对原版的实质性增强） ---- */
      assert.eq(yamlToJson('a: 1\n---\nb: 2'), '[\n   {\n      "a": 1\n   },\n   {\n      "b": 2\n   }\n]',
        '多文档转成 JSON 数组');
      assert.eq(parseDocs('a: 1\n---\nb: 2').length, 2, 'parseDocs 返回文档数组');
      assert.eq(parseDocs('a: 1').length, 1, '单文档时长度是 1');
      assert.eq(parseDocs('a: 1\n---\nb: 2'), [{ a: 1 }, { b: 2 }], '文档内容正确');
      // 多文档里第二份语法坏了 —— parseAllDocuments 不抛，得自己检查 doc.errors
      var broke = false;
      try { yamlToJson('a: 1\n---\n{unclosed'); } catch (e) { broke = /Flow map/.test(e.message); }
      assert(broke, '多文档里的语法错误不会被静默吞掉');

      /* ---- 空输入 ---- */
      assert.eq(yamlToJson(''), '', '空输入输出空串');
      assert.eq(yamlToJson('   \n  '), '', '纯空白也算空');
      assert.eq(yamlToJson('---'), 'null', '只有一个空文档时输出 null');

      /* ---- 假值：原版在这里会返回空串 ---- */
      assert.eq(yamlToJson('0'), '0', '0 不再被吞成空串');
      assert.eq(yamlToJson('false'), 'false', 'false 不再被吞成空串');
      assert.eq(yamlToJson('null'), 'null', 'null 不再被吞成空串');
      assert.eq(yamlToJson('~'), 'null', '~ 是 null');
      assert.eq(yamlToJson('""'), '""', '空字符串是空字符串');

      /* ---- YAML 的隐式类型 ---- */
      assert.eq(yamlToJson('a: 0x10\nb: 1e3\nc: 2020-01-01'), '{\n   "a": 16,\n   "b": 1000,\n   "c": "2020-01-01"\n}',
        '十六进制 / 科学计数按 YAML 解析，日期保持字符串');
      assert.eq(yamlToJson('a: yes'), '{\n   "a": "yes"\n}', 'YAML 1.2 里 yes 是字符串不是布尔');
      assert.eq(yamlToJson('a: [1, 2]'), '{\n   "a": [\n      1,\n      2\n   ]\n}', '流式序列');

      /* ---- 非法输入：必须抛错，且信息可读 ---- */
      var unclosed = null;
      try { yamlToJson('{unclosed'); } catch (e) { unclosed = e; }
      assert(unclosed !== null, '未闭合的流式映射应抛错');
      assert.eq(describeError(unclosed), 'Flow map must end with a }（第 1 行第 10 列）',
        '错误信息保留英文原因并补上行列');

      var badIndent = null;
      try { yamlToJson('a: 1\n b: 2'); } catch (e) { badIndent = e; }
      assert(/Nested mappings/.test(describeError(badIndent)), '缩进错误也有原因');

      var alias = null;
      try { yamlToJson('a: *nope'); } catch (e) { alias = e; }
      assert(/Unresolved alias/.test(describeError(alias)), '未定义的别名报得出来');

      var tab = null;
      try { yamlToJson('key:\n\t- x'); } catch (e) { tab = e; }
      assert(/Tabs are not allowed/.test(describeError(tab)), 'Tab 缩进报错');

      // describeError 对没有位置的错误要退化成只留第一行
      assert.eq(describeError(new Error('boom\nstack line 1\nstack line 2')), 'boom', '无位置信息时只取第一行');
    }
  };
})();