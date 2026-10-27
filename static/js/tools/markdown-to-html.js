/* ==========================================================================
   Markdown 转 HTML（markdown-to-html）

   左边写 Markdown，右边同时给「渲染后的实时预览」和「HTML 源码」，
   还可以直接调系统打印（打印成 PDF）。
   参考实现：src/tools/markdown-to-html/（it-tools, GPLv3）

   ---- XSS 取舍 ----
   任务书里写的是「参考实现就是 markdownit({html:true})」—— 实际不是，
   翻遍 markdown-to-html.vue 它调的是**无参的 markdownit()**，也就是
   markdown-it 的默认 html:false。这里跟参考实现一致，也跟「行为以参考实现为准」一致：
   用户写的原始 HTML 一律转义输出，不会当成标记解析。
   这一点在把结果塞进 innerHTML 之前非常关键，下面每条注入路径都实测过
   （见 __cases）：
     · <script>alert(1)</script> / <img src=x onerror=...> / <svg onload=...>
       / <iframe src="javascript:...">   —— 全部被转义成文本
     · [x](javascript:alert(1))         —— markdown-it 的 validateLink 拒绝，
       整个链接语法原样当文本输出（连 href 都不会生成）
     · [x](http://a " onmouseover="...)  —— title 里的引号被转义，
       注不进新属性
     · 行内代码 / 围栏代码块里的 HTML     —— 同样转义
   补充一句：就算开着 html:true，innerHTML 赋值也不会执行 <script>（浏览器规范如此），
   真正危险的是 <img onerror> 这类事件属性。所以只要 html:false 就够了；
   真要开 html:true 还得再套一层 DOMPurify，而本项目没有构建步骤、加不了新库。
   ------------------------------------------------------------------------ */

(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('markdown-to-html');

  /** markdown-it 实例。整个进程一个就够，构造一次省掉每次按键都重新建。 */
  var md = null;
  function renderer() {
    // 显式写 html:false 而不是靠默认值 —— 安全相关的开关不留给「升级之后默认值变了」
    // 上面那段注释解释了为什么这里必须是 false。
    if (md === null) md = markdownit({ html: false, linkify: false, breaks: false, typographer: false });
    return md;
  }

  /**
   * 主函数：Markdown 文本 → HTML 文本。
   * 空输入返回空串；非字符串（null / 数字）按空串处理，
   * 因为 markdown-it 的 render() 收到非字符串会抛 "Input data should be a String"。
   *
   * @param {string} src
   * @returns {string}
   */
  function renderMarkdown(src) {
    if (src === null || src === undefined) return '';
    var text = String(src);
    if (text === '') return '';
    var out = renderer().render(text);
    return typeof out === 'string' ? out : '';
  }

  /**
   * 开一个新窗口把 HTML 放进去并调打印（用户在打印对话框里选「另存为 PDF」）。
   * 弹窗被拦时返回 false，让调用方给提示。
   *
   * 拦下来的窗口不一定就是 null —— window.open() 拿不到窗口时也可能给 undefined，
   * 所以这里用「假值」判断，把两种都当成「没打开」。
   *
   * @param {string} html
   * @returns {boolean} 是否成功打开
   */
  function printHtml(html) {
    var w = window.open();
    if (!w) return false;
    w.document.body.innerHTML = html === null || html === undefined ? '' : String(html);
    w.print();
    return true;
  }

  /* ---------- UI ---------- */

  window.ItTools.register('markdown-to-html', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 8, spellcheck: 'false', placeholder: t('input_ph', 'Your Markdown content...')
    });
    input.value = '# Hello\n\nSome **bold** text.\n';

    var source = U.codeBlock();

    // 预览区不能复用 .output-body：那个类是给纯文本输出用的
    // （等宽字体 + white-space:pre-wrap + word-break:break-all），塞渲染后的 HTML 会很难看。
    // 只能用 app.css 里已有的类 + 内联样式，不新增 class（app.css 不归本子任务管）。
    var preview = D.h('div', { style: { fontSize: '14px', lineHeight: '1.6', overflowWrap: 'anywhere' } });

    var status = D.h('p.field-hint');
    var printBtn = D.h('button.layui-btn', { type: 'button', text: t('print_pdf', 'Print as PDF') });

    function render() {
      var html;
      try { html = renderMarkdown(input.value); }
      catch (e) {
        D.clear(status);
        D.clear(source).value = '';
        D.clear(preview);
        status.textContent = t('err_render', 'Markdown rendering failed.') + ' ' + (e && e.message ? e.message : e);
        return;
      }
      source.value = html;
      // 头文件里的 XSS 分析：html:false 下产物里没有任何可执行的标记，
      // 这句 innerHTML 是安全的；真要改成 html:true 之前先加 DOMPurify。
      preview.innerHTML = html;
      D.clear(status);
    }

    printBtn.addEventListener('click', function () {
      D.clear(status);
      if (!printHtml(source.value)) {
        status.textContent = t('err_popup',
          'The print window was blocked by the browser. Allow pop-ups for this site and try again.');
      }
    });

    var off = D.on(input, 'input', render);

    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    // 原版这一页没有卡片外壳，是「输入 → 分隔线 → 输出」一整条。
    // 我们收进同一张卡，把分隔线放在输入与输出之间。
    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your Markdown to convert:'), input),
      D.h('div.form-actions', null, printBtn),
      status,
      U.divider(),
      D.h('div.output-head', null, D.h('span.output-label', { text: t('preview', 'Preview') })),
      preview,
      D.h('div.code-label', { text: t('output', 'Output HTML:') }),
      source.card
    ));
    render();

    return { destroy: function () { off(); D.clear(root); } };
  });

  window.ItTools.logic['markdown-to-html'] = {
    renderMarkdown: renderMarkdown,
    printHtml: printHtml,
    __cases: function (assert) {
      /* ---- 正常值 ---- */
      assert.eq(renderMarkdown('# hi'), '<h1>hi</h1>\n', '一级标题');
      assert.eq(renderMarkdown('hello'), '<p>hello</p>\n', '一段纯文本');
      assert.eq(renderMarkdown('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n', '无序列表');
      assert.eq(renderMarkdown('**bold**'), '<p><strong>bold</strong></p>\n', '粗体');
      assert.eq(renderMarkdown('[a](http://x.y)'), '<p><a href="http://x.y">a</a></p>\n', '链接');
      assert.eq(renderMarkdown('![i](http://z/i.png)'), '<p><img src="http://z/i.png" alt="i"></p>\n', '图片');
      assert.eq(renderMarkdown('```js\nvar a=1;\n```'),
        '<pre><code class="language-js">var a=1;\n</code></pre>\n', '围栏代码块带语言');
      assert.eq(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'),
        '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n',
        '表格');

      /* ---- 边界 ---- */
      assert.eq(renderMarkdown(''), '', '空串');
      assert.eq(renderMarkdown(null), '', 'null —— 直接透传给 markdown-it 会抛 Input data should be a String');
      assert.eq(renderMarkdown(undefined), '', 'undefined');
      assert.eq(renderMarkdown(42), '<p>42</p>\n', '数字按字符串处理');
      assert.eq(renderMarkdown('   '), '', '纯空白不产生任何标签');
      assert.eq(renderMarkdown('\n\n\n'), '', '只有换行');

      /* ---- XSS：html:false 之下这些必须全部失效 ---- */
      assert.eq(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n', 'script 标签被转义');
      assert.eq(renderMarkdown('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>\n', '事件属性注入被转义');
      assert.eq(renderMarkdown('<svg onload=alert(1)>'), '<p>&lt;svg onload=alert(1)&gt;</p>\n', 'svg 事件属性被转义');
      assert.eq(renderMarkdown('<iframe src="javascript:alert(1)">'),
        '<p>&lt;iframe src=&quot;javascript:alert(1)&quot;&gt;</p>\n', 'iframe 被转义');
      assert.eq(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>\n',
        'javascript: 链接被 validateLink 拒掉，整个语法当文本');
      assert.eq(renderMarkdown('[x][1]\n\n[1]: javascript:alert(1)'),
        '<p>[x][1]</p>\n<p>[1]: javascript:alert(1)</p>\n', '引用式链接同样被拒');
      assert.eq(renderMarkdown('[x](http://a " onmouseover="alert(1))'),
        '<p>[x](http://a &quot; onmouseover=&quot;alert(1))</p>\n', 'title 里的引号被转义，注不进新属性');
      assert.eq(renderMarkdown('`<script>alert(1)</script>`'),
        '<p><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></p>\n', '行内代码里的 HTML 也转义');
      assert.eq(renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```'),
        '<pre><code class="language-html">&lt;img src=x onerror=alert(1)&gt;\n</code></pre>\n',
        '围栏代码块里的 HTML 不会变成真标签（language class 只是标记，不是执行）');
      assert.eq(renderMarkdown('visit http://x.com/a<b'), '<p>visit http://x.com/a&lt;b</p>\n', 'linkify:false，裸 URL 不自动成标签');
      assert.eq(markdownit().options.html, false, '确认 markdown-it 的默认 html 就是 false（任务书里说的 html:true 是误记）');

      /* ---- 错误输入 ---- */
      // markdown-it 本身几乎不抛错（它设计成永不失败），所以这里断言的是：
      // 渲染结果永远是一个字符串，不会返回 undefined/null 让 UI 崩。
      ['', ' ', '\u0000', '\u0000', '￿', 'x'.repeat(5000)].forEach(function (weird) {
        assert.eq(typeof renderMarkdown(weird), 'string', '任意输入都返回字符串：' + JSON.stringify(String(weird).slice(0, 20)));
      });

      /* ---- 打印窗口被拦 ---- */
      // window.open() 拿不到窗口时可能给 null，也可能给 undefined ——
      // 两种都得当成「没打开」：早先只判 null，碰到 undefined 就一路走到
      // w.document，抛 TypeError 把整个工具炸掉。
      var realOpen = window.open;
      try {
        window.open = function () { return null; };
        assert.eq(printHtml('<p>x</p>'), false, '弹窗被拦（null）时返回 false，不去碰 w.document');
        window.open = function () { return undefined; };
        assert.eq(printHtml('<p>x</p>'), false, '弹窗被拦（undefined）时同样返回 false');
        var printed = null;
        var fakeBody = {};
        window.open = function () {
          return { document: { body: fakeBody }, print: function () { printed = 'printed'; } };
        };
        assert.eq(printHtml('<p>x</p>'), true, '窗口开成了就返回 true');
        assert.eq(printed, 'printed', '开成之后会调 print()');
        assert.eq(fakeBody.innerHTML, '<p>x</p>', 'HTML 放进了新窗口的 body 里');
      } finally {
        window.open = realOpen;
      }
    }
  };
})();