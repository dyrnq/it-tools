/* ==========================================================================
   YAML 转 TOML（yaml-to-toml）

   把一份 YAML 转成 TOML 文档。锚点 / 别名与 merge key（`<<`）按 YAML 1.2 解析。

   参考实现：src/tools/yaml-to-toml/（it-tools, GPLv3）
   与原版的四处差别：

   1. **顶层不是表时报错**。`TOML.stringify` 只接受对象，传数组 / 标量会抛
      `Can only stringify objects, not array`。原版靠 `withDefaultOnError` 把它
      吞成空串，页面上一片空白。这里提前判掉并说明原因。
      （顺带一提：TOML 的根**必须**是表 —— 文档里不存在「顶层数组」这种东西，
      所以这不是工具的限制，是格式本身的限制。）

   2. **null 不再被静默丢掉**。实测 `@iarna/toml` 遇到值为 `null` 的键会直接
      **不输出这个键**，数组里的 null 也会被过滤掉：
          TOML.stringify({a: null, b: 1})  →  'b = 1\n'
      YAML 里 `key:`（没有值）正好解析成 null，所以这个坑很容易踩 ——
      用户看到的是「我明明写了这个字段，TOML 里怎么没了」。
      丢数据不该是转换的代价，这里改成报错，并列出到底是哪几条路径出的问题。

   3. **多文档不支持但说清楚**。TOML 没有「多文档」这个概念（一个文件就是一个
      表），把多份 YAML 拼在一起遇到重复键就会产出**非法 TOML**。原版只会在
      这里收到库的 MULTIPLE_DOCS 错误然后什么都不显示；这里直接把原版
      yaml-to-json-converter 里那套多文档处理搬过来认这个错误码，
      转成一句「TOML 不支持多文档」。

   4. **错误信息**。同 yaml-to-json-converter：保留库的英文原因 + 中文行列。

   输出去掉了库结果自带的结尾换行（与原版的 `.trim()` 一致），免得输出框底部
   多一行空行。
   - 补了下载按钮（上游 #1169）：输出区多一个 Download 按钮，把结果存成
     output.toml。下载用的是 app.js 里早就写好的 ItTools.download，
     这里只是把按钮补上（文件名与上游一致）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('yaml-to-toml');
  var YAML_LIB = window.YAML;
  var TOML_LIB = window.TOML;

  /** null 路径最多列这么多条，剩下的只报个数 —— 免得一行错误刷屏。 */
  var MAX_REPORTED_PATHS = 5;

  /**
   * 抛一条已经是中文、不需要再翻译的错误。
   * 打个 friendly 标记，界面据此决定是直接显示还是先套上「转换失败：」+ 行列。
   * @param {string} msg
   */
  function fail(msg) {
    var err = new Error(msg);
    err.friendly = true;
    throw err;
  }

  /**
   * 把库的异常压成一行可读的中文说明。
   * 这个工具同时会碰两个库，两边的定位格式不一样：
   *   - TOML：`Key without value at row 1, col 6, pos 5:\n…`
   *   - YAML：`Flow map must end with a } at line 1, column 10:\n…`
   * @param {*} err
   * @returns {string}
   */
  function describeError(err) {
    var msg = String((err && err.message) || err);
    var m = /^(.*?) at row (\d+), col (\d+)/.exec(msg) ||
            /^(.*?) at line (\d+), column (\d+)/.exec(msg);
    if (m) return m[1] + '（第 ' + m[2] + ' 行第 ' + m[3] + ' 列）';
    return msg.split('\n')[0].trim();
  }

  /** 是不是一个「表」（TOML 的根 / 表头下能挂键的对象）。数组和标量都不算。 */
  function isTable(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * 找出所有值为 null 的字段，返回形如 `a.b[0].c` 的路径列表。
   *
   * TOML 没有 null，库会静默丢弃这些键 —— 与其悄悄丢，不如告诉用户在哪。
   * Date 单独排除：万一上游换成会产出 Date 的 schema，Date 不是 null，
   * 而且库里会把它正确写成 TOML 日期时间，不该被这条规则误伤。
   *
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
    if (isTable(value) && !(value instanceof Date)) {
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
   * 解析成可交给 TOML.stringify 的值。
   * @param {string} src
   * @throws 语法错误 / 多文档
   */
  function parseYaml(src) {
    try {
      // 超范围整数保护：YAML 解析成 JS Number 时会被无声地舍掉
      return YAML_LIB.parse(U.guardBigIntegers(src, { hashComment: true }), { merge: true });
    } catch (err) {
      if (err && err.code === 'MULTIPLE_DOCS') {
        fail('输入含多份 YAML 文档（--- 分隔），而 TOML 一个文件只能有一份文档；请拆开分别转换');
      }
      throw err;
    }
  }

  /**
   * 主函数：YAML 文本 → TOML 文本。
   * @param {string} text
   * @returns {string} 空输入返回空串
   */
  function yamlToToml(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return '';

    var value = parseYaml(src);
    // 空文档（只有注释 / 只有 `---`）解析出来是 null，对应空 TOML。
    if (value === null || value === undefined) return '';
    if (!isTable(value)) {
      fail('TOML 的顶层必须是一张表（key: value），而这份 YAML 顶层是 ' +
        (Array.isArray(value) ? '一个列表' : '一个标量'));
    }

    var nulls = findNullPaths(value);
    if (nulls.length) fail(describeNullPaths(nulls));

    return U.restoreBigIntegers(TOML_LIB.stringify(value)).trim();
  }

  window.ItTools.register('yaml-to-toml', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your YAML here...')
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
        output.value = yamlToToml(raw);
        status.textContent = '';
        status.className = 'form-status';
      } catch (e) {
        output.value = '';
        status.className = 'form-status is-error';
        // 自己抛的错已经是中文了，库抛的要翻译成带行列的中文说明。
        status.textContent = e.friendly ? e.message : '转换失败：' + describeError(e);
      }
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      D.h('label.field-label', { text: t('input', 'Your YAML') }),
      input,
      status,
      D.h('p.field-hint', { text: t('hint', 'The top level of a TOML document must be a table; values cannot be null (TOML has no null).') })
    ));

    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'TOML from your YAML') }),
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

  window.ItTools.logic['yaml-to-toml'] = {
    parseYaml: parseYaml,
    yamlToToml: yamlToToml,
    findNullPaths: findNullPaths,
    describeNullPaths: describeNullPaths,
    describeError: describeError,
    isTable: isTable,
    __cases: function (assert) {
      /* ---- 基本转换（与参考实现的 e2e 期望一致） ---- */
      assert.eq(
        yamlToToml('foo: bar\nlist:\n  name: item\n  another:\n    key: value\n    number: 1'),
        'foo = "bar"\n\n[list]\nname = "item"\n\n  [list.another]\n  key = "value"\n  number = 1',
        '嵌套表转 TOML'
      );

      /* ---- 各种标量与容器 ---- */
      assert.eq(yamlToToml('a: 1\nb: 1.5\nc: true'), 'a = 1\nb = 1.5\nc = true', '数字与布尔不加引号');
      assert.eq(yamlToToml('list:\n  - 1\n  - 2'), 'list = [ 1, 2 ]', '标量列表走行内数组');
      assert.eq(yamlToToml('servers:\n  - host: a\n  - host: b'),
        '[[servers]]\nhost = "a"\n\n[[servers]]\nhost = "b"', '对象列表转成表数组');
      assert.eq(yamlToToml('a: "it\'s"\nb: \'x"y\''), 'a = "it\'s"\nb = \'x"y\'', '引号按 TOML 规则选字面串 / 基本串');
      // YAML 的默认 schema 是 core，不含 timestamp 类型，所以 2020-01-01T00:00:00Z
      // 仍是字符串，输出时 TOML 会给它加引号 —— 保真，不该被当成日期改写。
      assert.eq(yamlToToml('a: 2020-01-01T00:00:00Z'), 'a = "2020-01-01T00:00:00Z"', '时间戳按字符串原样保留');
      assert.eq(yamlToToml('a: 0x10'), 'a = 16', 'YAML 的十六进制先解成数字');

      /* ---- merge key ---- */
      assert.eq(yamlToToml('base: &b\n  n: 1\nchild:\n  <<: *b\n  n: 2'),
        '[base]\nn = 1\n\n[child]\nn = 2', 'merge key 在进 TOML 前已经展开');

      /* ---- 空输入 / 空文档 ---- */
      assert.eq(yamlToToml(''), '', '空输入输出空串');
      assert.eq(yamlToToml('   '), '', '纯空白也算空');
      assert.eq(yamlToToml('# 只有一行注释\n'), '', '只有注释等于空文档');
      assert.eq(yamlToToml('---\n'), '', '只有一个空文档等于空文档');

      /* ---- null 必须报错，而不是被静默丢弃 ---- */
      var nullErr = null;
      try { yamlToToml('a: 1\nb:\n'); } catch (e) { nullErr = e; }
      assert(nullErr !== null, '空值（YAML 的 null）会报错而不是丢字段');
      assert(/b/.test(nullErr.message) && /null/.test(nullErr.message), '错误里点名了出问题的字段：' + (nullErr && nullErr.message));
      assert.eq(findNullPaths({ a: null, b: { c: null } }), ['a', 'b.c'], '找出嵌套的 null 路径');
      assert.eq(findNullPaths({ a: [1, { b: null }] }), ['a[1].b'], '数组里的 null 也算');
      assert.eq(findNullPaths({ a: 1, b: 'x', c: [] }), [], '没有 null 时返回空数组');
      assert.eq(findNullPaths({ d: new Date(0) }), [], 'Date 不是 null，不算');
      assert(/共 6 处/.test(describeNullPaths(['a', 'b', 'c', 'd', 'e', 'f'])), '超过 5 条只报个数');
      assert.eq(describeNullPaths(['a', 'b']), 'TOML 没有 null 值，下列字段会被直接丢弃：a、b。请删掉这些字段，或给它们填上实际值（空字符串写成 ""）。',
        'null 提示文案');

      /* ---- 顶层不是表 ---- */
      var arrErr = null;
      try { yamlToToml('- a\n- b'); } catch (e) { arrErr = e; }
      assert(arrErr !== null && /列表/.test(arrErr.message), '顶层是列表时报错：' + (arrErr && arrErr.message));
      var scalarErr = null;
      try { yamlToToml('42'); } catch (e) { scalarErr = e; }
      assert(scalarErr !== null && /标量/.test(scalarErr.message), '顶层是标量时报错');

      /* ---- 多文档 ---- */
      var multiErr = null;
      try { yamlToToml('a: 1\n---\nb: 2'); } catch (e) { multiErr = e; }
      assert(multiErr !== null && /多份 YAML 文档/.test(multiErr.message), '多文档给专门的提示：' + (multiErr && multiErr.message));

      /* ---- 非法 YAML：保留英文原因 + 中文行列 ---- */
      var unclosed = null;
      try { yamlToToml('{unclosed'); } catch (e) { unclosed = e; }
      assert.eq(describeError(unclosed), 'Flow map must end with a }（第 1 行第 10 列）', 'YAML 语法错误可读');
      assert.eq(describeError(new Error('boom\nat row 2, col 3:')), 'boom', '没有行列信息时只取第一行');
    }
  };
})();