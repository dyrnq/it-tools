/* ==========================================================================
   TOML 转 YAML（toml-to-yaml）

   把一份 TOML 转成 YAML。表数组、行内表、日期时间这些 TOML 结构都会被如实
   转成对应的 YAML 结构。

   参考实现：src/tools/toml-to-yaml/（it-tools, GPLv3）
   与原版的两处差别：

   1. **错误信息**。原版校验用 `isValidToml`（只回布尔），转换走
      `withDefaultOnError` 吞成空串，页面上写死一句 "Provided TOML is not
      valid." —— 用户看不到错在哪。这里把 `TomlError` 的第一行原因留下来并补上
      中文行列（message 形如 `Key without value at row 1, col 6, pos 5:\n…`）。

   2. **空输入的判断**。原版判 `value.trim() === ''`，但 `TOML.parse('')` 返回
      `{}`，走到底会输出 `'{}'`；这里跟原版一样按 trim 后为空直接返回空串，
      空输入不该凭空冒出一个空对象。

   注：TOML 的 `nan` / `inf` 会被 `@iarna/toml` 解析成 JS 的 NaN / Infinity，
   而 YAML 能表示它们（`.nan` / `.inf`），所以这一路转过去是无损的 ——
   和 toml-to-json 那条路（JSON 里没有这两种类型，只能变 null）不一样。
   - 补了下载按钮（上游 #1169）：输出区多一个 Download 按钮，把结果存成
     output.yaml。下载用的是 app.js 里早就写好的 ItTools.download，
     这里只是把按钮补上（文件名与上游一致）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('toml-to-yaml');
  var TOML_LIB = window.TOML;
  var YAML_LIB = window.YAML;

  /**
   * 把 `TomlError` 压成一行可读的中文说明。
   * @param {*} err
   * @returns {string}
   */
  function describeError(err) {
    var msg = String((err && err.message) || err);
    var m = /^(.*?) at row (\d+), col (\d+)/.exec(msg);
    if (m) return m[1] + '（第 ' + m[2] + ' 行第 ' + m[3] + ' 列）';
    return msg.split('\n')[0].trim();
  }

  /**
   * 校验用：这份文本能不能被 TOML 解析。空文本算合法（对应空文档）。
   * @param {string} text
   * @returns {boolean}
   */
  function isValidToml(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return true;
    try { TOML_LIB.parse(src); return true; } catch (e) { return false; }
  }

  /**
   * 主函数：TOML 文本 → YAML 文本。
   * @param {string} text
   * @returns {string} 空输入返回空串
   */
  function tomlToYaml(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return '';
    // @iarna/toml 对超范围整数的还原本身就是错的：
    // `a = 17478252242305210114` 会被它读成 -968491831404341502（符号位都反了）。
    // 保护之后解析器压根见不到这个大整数，问题从源头绕开。
    var out = YAML_LIB.stringify(TOML_LIB.parse(U.guardBigIntegers(src, { hashComment: true })));
    // stringify(undefined) 返回 undefined 而不是字符串，兜一层。
    return out === undefined ? '' : U.restoreBigIntegers(out);
  }

  window.ItTools.register('toml-to-yaml', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your TOML here...')
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
        output.value = tomlToYaml(raw);
        status.textContent = '';
        status.className = 'form-status';
      } catch (e) {
        output.value = '';
        status.className = 'form-status is-error';
        status.textContent = 'TOML 解析失败：' + describeError(e);
      }
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      D.h('label.field-label', { text: t('input', 'Your TOML') }),
      input,
      status,
      D.h('p.field-hint', { text: t('hint', 'nan / inf are represented as .nan / .inf in YAML, so this conversion is lossless.') })
    ));

    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'YAML from your TOML') }),
      output.card,
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download', 'Download'), onclick: function () {
            if (output.value) {
              window.ItTools.download('output.yaml', output.value, 'application/yaml;charset=utf-8');
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

  window.ItTools.logic['toml-to-yaml'] = {
    tomlToYaml: tomlToYaml,
    isValidToml: isValidToml,
    describeError: describeError,
    __cases: function (assert) {
      /* ---- 基本转换（与参考实现的 e2e 期望一致） ---- */
      assert.eq(
        tomlToYaml('foo = "bar"\n\n# This is a comment\n\n[list]\n  name = "item"\n[list.another]\n  key = "value"\n'),
        'foo: bar\nlist:\n  name: item\n  another:\n    key: value\n',
        '注释被吃掉，表与子表变成嵌套映射'
      );

      /* ---- 标量 ---- */
      assert.eq(tomlToYaml('a = 1\nb = 1.5\nc = true\nd = false'), 'a: 1\nb: 1.5\nc: true\nd: false\n', '标量');
      assert.eq(tomlToYaml('a = 0x1F\nb = 1_000'), 'a: 31\nb: 1000\n', '进制与下划线');
      assert.eq(tomlToYaml('a = "it\'s"\nb = \'x"y\''), 'a: it\'s\nb: x"y\n', '基本串与字面串');
      assert.eq(tomlToYaml('a = "123"\nb = "true"'), 'a: "123"\nb: "true"\n',
        '像数字 / 布尔的字符串必须加引号，否则读回去就变类型了');

      /* ---- 容器 ---- */
      assert.eq(tomlToYaml('a = [1, 2, 3]'), 'a:\n  - 1\n  - 2\n  - 3\n', '数组');
      assert.eq(tomlToYaml('[[servers]]\nhost = "a"\n\n[[servers]]\nhost = "b"'),
        'servers:\n  - host: a\n  - host: b\n', '表数组变成对象列表');
      assert.eq(tomlToYaml('a = { b = 1 }'), 'a:\n  b: 1\n', '行内表展开成嵌套映射');
      assert.eq(tomlToYaml('a.b.c = 1'), 'a:\n  b:\n    c: 1\n', '带点的键拆成嵌套');

      /* ---- TOML 特有类型 ---- */
      assert.eq(tomlToYaml('a = nan\nb = inf'), 'a: .nan\nb: .inf\n', 'nan / inf 用 YAML 的写法表示，无损');
      assert.eq(tomlToYaml('a = 1979-05-27T07:32:00Z'), 'a: 1979-05-27T07:32:00.000Z\n', '日期时间');
      assert.eq(tomlToYaml('a = 1979-05-27'), 'a: 1979-05-27\n', '日期');

      /* ---- 空输入 ---- */
      assert.eq(tomlToYaml(''), '', '空输入输出空串');
      assert.eq(tomlToYaml('   \n  '), '', '纯空白也算空（不该凭空冒出 {}）');

      /* ---- 非法 TOML ---- */
      var noValue = null;
      try { tomlToYaml('a = '); } catch (e) { noValue = e; }
      assert(noValue !== null, '缺值报错');
      assert.eq(describeError(noValue), 'Key without value（第 1 行第 6 列）', '错误带行列');

      var dup = null;
      try { tomlToYaml('a = 1\na = 2'); } catch (e) { dup = e; }
      assert(/redefine/i.test(describeError(dup)), '重复键报错：' + describeError(dup));

      var openTable = null;
      try { tomlToYaml('[unclosed'); } catch (e) { openTable = e; }
      assert(openTable !== null && describeError(openTable).length > 0, '未闭合的表头报错');

      /* ---- isValidToml ---- */
      assert(isValidToml(''), '空文本算合法');
      assert(isValidToml('a = 1\n[b]\nc = 2'), '正常 TOML 合法');
      assert(!isValidToml('a = '), '缺值不合法');
      assert(!isValidToml('= 1'), '非法字符不合法');

      assert.eq(describeError(new Error('boom\nat row 2, col 3:')), 'boom', '没有行列信息时只取第一行');
    }
  };
})();