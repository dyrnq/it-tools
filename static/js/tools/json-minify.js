/* ==========================================================================
   JSON 压缩（json-minify）

   把一段 JSON5 文本解析后压成单行 JSON。
   参考实现：src/tools/json-minify/（it-tools, GPLv3）

   ---- 为什么这里又写了一份剥注释 ----
   json-viewer.js 里已经有一份 stripJsonComments 了，但这个项目**没有构建步骤**，
   所有工具模块都是浏览器里顺序执行的独立 <script>，互相 import 不到；
   而 app.js（放共用工具的地方）不属于本子任务，不能改。
   所以只能复制一份。这份只保留 minify 真正需要的部分：
     · 两种注释都处理（不然 `[1, //x\n2]` 这种用户很常见的写法过不去）
     · 字符串感知（必须，否则 {"url":"http://a//b"} 会被砍掉后半截）
     · JSON5 单引号字符串
     · 吃掉 json5@2.2.3 不支持的 elision（两个连续逗号）
   省掉的是 json-viewer 那份里的「保留注释里的换行以对齐报错行列号」——
   minify 的报错来自 JSON5 自己，剥完的中间结果又不给人看，不需要。

   ---- 与参考实现的差别 ----
   - 参考实现的 transformer 用 withDefaultOnError 把异常吞成空串，
     用户看到的是「输入没反应」而不是「哪里错了」。这里解析失败时抛错，
     UI 直接显示 JSON5 的原始报错（带行列号）。
   - 补了下载按钮（上游 #1169）：输出区多一个 Download 按钮，把结果存成
     output.json。下载用的是 app.js 里早就写好的 ItTools.download，
     这里只是把按钮补上（文件名与上游一致）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-minify');

  /**
   * 剥掉 JSON / JSON5 里的注释（两个斜杠到行尾；斜杠+星号 到 星号+斜杠）。
   * @param {string} src
   * @returns {string}
   */
  function stripComments(src) {
    var s = src === null || src === undefined ? '' : String(src);
    var out = '';
    var n = s.length;
    var i = 0;
    var quote = '';
    var escaped = false;
    var inBlock = false;

    function lastNonSpace(str) {
      for (var j = str.length - 1; j >= 0; j--) {
        var c = str.charAt(j);
        if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return c;
      }
      return '';
    }

    function push(ch) {
      // 两个逗号中间只隔着空白/注释时，多出来的是 elision，json5@2.2.3 解不了
      if (ch === ',' && lastNonSpace(out) === ',') return;
      out += ch;
    }

    while (i < n) {
      var ch = s.charAt(i);

      if (inBlock) {
        if (ch === '*' && s.charAt(i + 1) === '/') { inBlock = false; i += 2; continue; }
        i++;                        // 换行也一并丢掉，本来就是要压成一行
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
    return out;
  }

  /**
   * 解析（含剥注释 + 超范围整数保护）。
   *
   * 压掉空白不会让整数变回原样：9223372036854775807 一进 JSON5 就已经是
   * 9223372036854776000 了，压完只是把错值写得更紧凑。保护在解析**之前**做，
   * 还原在序列化之后做，详见 `ItTools.util.guardBigIntegers`。
   *
   * @param {string} raw
   */
  function parseJson(raw) {
    return JSON5.parse(U.guardBigIntegers(stripComments(raw)));
  }

  /**
   * 主函数：原始 JSON5 文本 → 压缩后的单行 JSON。空输入返回空串，非法输入抛错。
   * @param {string} rawJson
   * @returns {string}
   */
  function minifyJson(rawJson) {
    var src = rawJson === null || rawJson === undefined ? '' : String(rawJson);
    if (src.trim() === '') return '';
    var out = JSON.stringify(parseJson(src), null, 0);
    return out === undefined ? '' : U.restoreBigIntegers(out);
  }

  /* ---------- UI ---------- */

  window.ItTools.register('json-minify', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20, spellcheck: 'false', placeholder: t('input_ph', 'Paste your raw JSON here...')
    });
    input.value = '{\n\t"hello": [\n\t\t"world"\n\t]\n}';   // 参考实现的默认输入
    var output = U.codeBlock();
    var error = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });

    function render() {
      D.clear(error);
      try {
        output.value = minifyJson(input.value);
      } catch (e) {
        output.value = '';
        error.textContent = t('error_invalid', 'Provided JSON is not valid.') + ' ' + (e && e.message ? e.message : e);
      }
    }

    var off = D.on(input, 'input', render);
    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your raw JSON'), input),
      error
    ));
    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'Minified version of your JSON') }),
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

    return { destroy: function () { off(); D.clear(root); } };
  });

  window.ItTools.logic['json-minify'] = {
    stripComments: stripComments,
    parseJson: parseJson,
    minifyJson: minifyJson,
    __cases: function (assert) {
      /* ---- 剥注释 ---- */
      assert.eq(stripComments('{\n\t"a": 1,\t/*c*/\t"b": 2\n}'), '{\n\t"a": 1,\t\t"b": 2\n}', '块注释本身消失，周围的空白原样留着（压掉的是 JSON.stringify 那一步）');
      assert.eq(stripComments('{"a":1,//x\n"b":2}'), '{"a":1,\n"b":2}', '行注释到行尾，换行留下');
      assert.eq(stripComments('/*a\nb*/[1]'), '[1]', '跨行块注释连换行一起丢掉');
      assert.eq(stripComments('{"u":"http://a//b"}'), '{"u":"http://a//b"}', '字符串里的两个斜杠');
      assert.eq(stripComments('{"u":"a..b"}'), '{"u":"a..b"}', '字符串里的斜杠星');
      assert.eq(stripComments("{'q':'//x'}"), "{'q':'//x'}", 'JSON5 单引号字符串');
      assert.eq(stripComments('[1,/*c*/,2]'), '[1,2]', 'elision 归一');
      assert.eq(stripComments('1/2'), '1/2', '单个斜杠不是注释');
      assert.eq(stripComments(''), '', '空串');

      /* ---- 压缩：正常值 ---- */
      assert.eq(minifyJson('{\n\t"hello": [\n\t\t"world"\n\t]\n}'), '{"hello":["world"]}', '参考实现的默认输入');
      assert.eq(minifyJson('{ "a" : 1 , "b" : [ 1 , 2 ] }'), '{"a":1,"b":[1,2]}', '空白全部去掉');
      assert.eq(minifyJson('{\n  "a": {\n    "b": 1\n  }\n}'), '{"a":{"b":1}}', '嵌套');
      assert.eq(minifyJson('[1,2,3]'), '[1,2,3]', '数组');
      assert.eq(minifyJson('42'), '42', '顶层标量');
      assert.eq(minifyJson('true'), 'true', '顶层布尔');
      assert.eq(minifyJson('null'), 'null', '顶层 null');
      assert.eq(minifyJson('{a:1}'), '{"a":1}', 'JSON5 无引号键');
      assert.eq(minifyJson("{'a':'b'}"), '{"a":"b"}', 'JSON5 单引号');
      assert.eq(minifyJson('{"a":1,}'), '{"a":1}', 'JSON5 尾逗号');
      assert.eq(minifyJson('[1,/*c*/,2]'), '[1,2]', 'JSON5 bug 场景：块注释 + 逗号');
      assert.eq(minifyJson('[1,//c\n2]'), '[1,2]', '行注释');
      assert.eq(minifyJson('{"s":"//not a comment"}'), '{"s":"//not a comment"}', '字符串里的两个斜杠不受影响');
      assert.eq(minifyJson('{"a":.5,"b":+1,"c":0xFF}'), '{"a":0.5,"b":1,"c":255}', 'JSON5 数字');

      /* ---- 压缩：边界 ---- */
      assert.eq(minifyJson(''), '', '空输入');
      assert.eq(minifyJson('   \n '), '', '纯空白');
      assert.eq(minifyJson(null), '', 'null 输入');
      assert.eq(minifyJson('{}'), '{}', '空对象');
      assert.eq(minifyJson('[]'), '[]', '空数组');
      assert.eq(minifyJson('{"a":"//"}'), '{"a":"//"}', '值恰好是两个斜杠');

      /* ---- 压缩：错误输入 ---- */
      ['{a:}', '[1,2', '{"a":1}{"b":2}', '{', '[,1]'].forEach(function (bad) {
        var threw = false;
        try { minifyJson(bad); } catch (e) { threw = true; }
        assert(threw, '非法输入 ' + JSON.stringify(bad) + ' 应抛错');
      });
      // 未闭合块注释：这份拷贝选择让它原样流到 JSON5，由 JSON5 报错
      var threw2 = false;
      try { minifyJson('[1,/*没闭合'); } catch (e) { threw2 = true; }
      assert(threw2, '未闭合块注释最终被 JSON5 拒掉');
    }
  };
})();