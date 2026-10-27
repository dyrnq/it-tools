/* ==========================================================================
   TOML 转 JSON（toml-to-json）

   把一份 TOML 转成 JSON。日期时间、nan / inf 这些 TOML 特有类型也会被如实
   转成 JSON 值（见下面「与参考实现不同的地方」第 2 条）。

   参考实现：src/tools/toml-to-json/（it-tools, GPLv3）
   与原版的三处差别：

   1. **错误信息**。原版的校验规则是 `isNotThrowing(() => parseToml(v))`，
      只回一个布尔值，页面上写死一句 "Provided TOML is not valid."；转换本身
      又走 `withDefaultOnError`，出错也是空串。于是用户完全看不到「错在哪」。
      这里把库的异常留下来：`@iarna/toml` 抛的 `TomlError` 的 message 形如
          Key without value at row 1, col 6, pos 5:\n1> a = \n        ^\n\n
      也就是「原因 + 行列 + 原文片段 + 指示符」。这里只取第一行的原因并补上中文
      行列 —— 整段甩出来反而更难读，但原因一个字不丢。

   2. **nan / inf 会变成 null，这是格式的固有限制，不是 bug**。JSON 没有
      NaN / Infinity，`JSON.stringify` 会把它们写成 `null`。这里保留这个行为
      （换成字符串会凭空造出 TOML 里没有的类型），但在 UI 上写清楚，免得用户
      以为转换丢了东西。日期时间不受影响：`@iarna/toml` 把它们解析成 JS 的
      Date / 字符串，JSON.stringify 会输出 ISO 字符串。

   3. **空输入的判断**。原版判的是 `value === ''`，只覆盖了「一个字都没有」；
      `'   '` 这种纯空白会掉进 `JSON.stringify(parse(...))`。这里统一按
      `trim()` 后是否为空来判断。注意只有注释的输入（`# hi`）不算空 ——
      它是**一份空文档**，正确的结果就是 `{}`，不是空串。

   缩进用 3 空格，与原版一致。
   - 补了下载按钮（上游 #1169）：输出区多一个 Download 按钮，把结果存成
     output.json。下载用的是 app.js 里早就写好的 ItTools.download，
     这里只是把按钮补上（文件名与上游一致）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('toml-to-json');
  var TOML_LIB = window.TOML;

  /** 与参考实现一致：JSON.stringify(obj, null, 3)。 */
  var JSON_INDENT = 3;

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

  /** 校验用：这份文本能不能被 TOML 解析。空文本算合法（对应空文档）。 */
  function isValidToml(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return true;
    try { TOML_LIB.parse(src); return true; } catch (e) { return false; }
  }

  /**
   * 主函数：TOML 文本 → JSON 文本。
   * @param {string} text
   * @returns {string} 空输入返回空串
   */
  function tomlToJson(text) {
    var src = String(text == null ? '' : text);
    if (!src.trim()) return '';
    // 这里必须先保护，不能指望 JSON.stringify：
    // @iarna/toml 遇到超出 2^53-1 的整数会返回 BigInt，JSON.stringify 不认识
    // BigInt，直接抛 `TypeError: Do not know how to serialize a BigInt`，
    // 整个工具对着一份完全合法的 TOML 直接罢工。保护之后解析器看到的是字符串，
    // BigInt 这条路根本走不到。
    return U.restoreBigIntegers(JSON.stringify(
      TOML_LIB.parse(U.guardBigIntegers(src, { hashComment: true })), null, JSON_INDENT
    ));
  }

  window.ItTools.register('toml-to-json', function (root) {
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
        output.value = tomlToJson(raw);
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
      D.h('p.field-hint', { text: t('hint', 'nan / inf have no counterpart in JSON, so they are output as null; date-times are output as ISO strings.') })
    ));

    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'JSON from your TOML') }),
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

  window.ItTools.logic['toml-to-json'] = {
    tomlToJson: tomlToJson,
    isValidToml: isValidToml,
    describeError: describeError,
    __cases: function (assert) {
      /* ---- 基本转换（与参考实现的 e2e 期望一致） ---- */
      assert.eq(
        tomlToJson('foo = "bar"\n\n# This is a comment\n\n[list]\n  name = "item"\n[list.another]\n  key = "value"\n'),
        '{\n   "foo": "bar",\n   "list": {\n      "name": "item",\n      "another": {\n         "key": "value"\n      }\n   }\n}',
        '注释被吃掉，表与子表变成嵌套对象'
      );

      /* ---- 各种标量 ---- */
      assert.eq(tomlToJson('a = 1\nb = 1.5\nc = true\nd = false'), '{\n   "a": 1,\n   "b": 1.5,\n   "c": true,\n   "d": false\n}', '标量');
      assert.eq(tomlToJson('a = 0x1F\nb = 1_000\nc = 1e3'), '{\n   "a": 31,\n   "b": 1000,\n   "c": 1000\n}', '进制与下划线');
      assert.eq(tomlToJson('a = "it\'s"\nb = \'x"y\''),
        '{\n   "a": "it\'s",\n   "b": "x\\"y"\n}', '基本串与字面串');
      assert.eq(tomlToJson('a = """\nline1\nline2"""'), '{\n   "a": "line1\\nline2"\n}', '多行基本串');

      /* ---- 容器 ---- */
      assert.eq(tomlToJson('a = [1, 2, 3]'), '{\n   "a": [\n      1,\n      2,\n      3\n   ]\n}', '数组');
      assert.eq(tomlToJson('a = [[1, 2], [3]]'), '{\n   "a": [\n      [\n         1,\n         2\n      ],\n      [\n         3\n      ]\n   ]\n}', '嵌套数组');
      assert.eq(tomlToJson('[[servers]]\nhost = "a"\n\n[[servers]]\nhost = "b"'),
        '{\n   "servers": [\n      {\n         "host": "a"\n      },\n      {\n         "host": "b"\n      }\n   ]\n}', '表数组');
      assert.eq(tomlToJson('a = { b = 1 }'), '{\n   "a": {\n      "b": 1\n   }\n}', '行内表');
      assert.eq(tomlToJson('a.b.c = 1'), '{\n   "a": {\n      "b": {\n         "c": 1\n      }\n   }\n}', '带点的键拆成嵌套');

      /* ---- TOML 特有类型 ---- */
      // nan / inf 在 JSON 里没有对应类型，只能变成 null —— 格式的固有限制。
      assert.eq(tomlToJson('a = nan\nb = inf'), '{\n   "a": null,\n   "b": null\n}', 'nan / inf 输出成 null');
      assert.eq(tomlToJson('a = 1979-05-27T07:32:00Z'), '{\n   "a": "1979-05-27T07:32:00.000Z"\n}', '日期时间输出成 ISO 字符串');
      assert.eq(tomlToJson('a = 1979-05-27'), '{\n   "a": "1979-05-27"\n}', '日期输出成字符串');

      /* ---- 空输入 ---- */
      assert.eq(tomlToJson(''), '', '空输入输出空串');
      assert.eq(tomlToJson('   \n  # 只有注释\n'), '{}', '只有注释是一份空文档，得到 {} 而不是空串');

      /* ---- 非法 TOML ---- */
      var noValue = null;
      try { tomlToJson('a = '); } catch (e) { noValue = e; }
      assert(noValue !== null, '缺值报错');
      assert.eq(describeError(noValue), 'Key without value（第 1 行第 6 列）', '错误带行列');

      var dup = null;
      try { tomlToJson('a = 1\na = 2'); } catch (e) { dup = e; }
      assert(/redefine/i.test(describeError(dup)), '重复键报错：' + describeError(dup));

      var badChar = null;
      try { tomlToJson('= 1'); } catch (e) { badChar = e; }
      assert(/Unknown character/.test(describeError(badChar)), '非法字符报错');

      var trailing = null;
      try { tomlToJson('a = 1 2'); } catch (e) { trailing = e; }
      assert(/Unexpected character/.test(describeError(trailing)), '值后面还有东西时报错');

      /* ---- isValidToml ---- */
      assert(isValidToml(''), '空文本算合法');
      assert(isValidToml('   '), '纯空白算合法');
      assert(isValidToml('a = 1'), '正常 TOML 合法');
      assert(!isValidToml('a = '), '缺值不合法');
      assert(!isValidToml('not toml = ='), '乱输入不合法');

      assert.eq(describeError(new Error('boom\nat row 2, col 3:')), 'boom', '没有行列信息时只取第一行');
    }
  };
})();