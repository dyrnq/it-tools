/* ==========================================================================
   HTML 转 Markdown（html-to-markdown）

   把一段 HTML 转成 Markdown：标题、段落、链接、列表、引用、代码块、图片、
   表格、删除线、任务列表都认（GFM 那一套由 turndown 的 GFM 插件提供）。
   从网页上复制一段内容粘进来就能用 —— 剪贴板里的 text/html 版本会被保留下来，
   标签不会丢。

   参考实现：src/tools/html-to-markdown/（it-tools, GPLv3）
   与原版的差别：
   1. **异常不再被当成输出渲染**（原版的 bug）：原版的 computed 里
      `catch (e) { return e.toString() }` —— 转换出错时，异常字符串被原样
      放进输出框，看起来像是「HTML 被转成了这段文字」。这里改成：出错时输出框
      清空，错误显示在输出框上方的红色提示行里，跟正常输出区分得开。
   2. **大文档不再卡顿**（原版的 bug）：原版的 computed 每敲一个键就同步跑一遍
      完整转换，几百 KB 的文档会明显卡住（DOMParser + 全文遍历都在主线程上）。
      这里加了 200ms 的 debounce —— 连续输入时只在停下来之后转换一次。
   3. 原版的输入框带 `paste-html`：粘贴时优先取剪贴板里的 text/html。
      这条保留（从网页复制一段再粘贴，正是这个工具的主要用法），
      但改成「插到光标处」而不是「清空整个输入框」，半路插一段也不会把前面写的抹掉。
   4. 原版没有任何转换选项，也没有下载按钮；这里保持转换行为与原版一致
      （同样的 turndown 默认参数），另外加了个「下载 .md」。
   5. 原版用 `@guyplusplus/turndown-plugin-gfm`（社区 fork），不是 npm 上的
      `turndown-plugin-gfm` —— fork 的表格规则更强（支持 colspan、没有表头的
      表格也会转、单元格里的竖线会转义），这里 vendor 的就是这个 fork 的产物。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('html-to-markdown');

  /** 输入停顿多久才真的去转换（毫秒）。跟 text-diff 用的是同一套写法。 */
  var DEBOUNCE_MS = 200;

  /**
   * turndown 实例。整个进程一个就够，构造一次省掉每次转换都重建。
   * null = 还没建；建过之后一直复用。
   */
  var service = null;

  /**
   * 造一个「库没加载上」的错误。
   *
   * 界面上要把这种情况跟别的转换错误分开：前者是页面自己的问题
   * （刷新一下就好），后者多半是用户输入的问题。用一个标记字段区分，
   * 免得界面上只能显示一句英文的库名。
   *
   * @param {string} message
   * @returns {Error}
   */
  function libError(message) {
    var e = new Error(message);
    e.libMissing = true;
    return e;
  }

  /**
   * 取（并按需初始化）turndown 服务。
   *
   * 两个库都是 vendor 进来的 UMD/IIFE 产物：
   *   · TurndownService             —— turndown 本体
   *   · TurndownPluginGfmService    —— GFM 插件（表格 / 删除线 / 任务列表 /
   *                                     高亮代码块）
   * 插件的函数都把 turndown 服务当参数收，不需要自己 require('turndown')。
   *
   * @returns {object} turndown 服务实例
   * @throws {Error} 库没加载上时抛（界面上会显示成一行错误提示）
   */
  function getService() {
    if (service) return service;
    if (typeof window.TurndownService !== 'function') {
      throw libError('TurndownService is not available');
    }
    if (!window.TurndownPluginGfmService || typeof window.TurndownPluginGfmService.gfm !== 'function') {
      throw libError('TurndownPluginGfmService is not available');
    }
    service = new window.TurndownService();
    // GFM 扩展：表格、删除线、任务列表、带语言标注的高亮代码块。
    window.TurndownPluginGfmService.gfm(service);
    return service;
  }

  /**
   * 主函数：HTML 文本 → Markdown 文本。
   *
   * 参数用参考实现那套 turndown 默认值：setext 标题（`标题` 下面加一行 `===`）、
   * `*` 无序列表、`**` 粗体、`_` 斜体、缩进式代码块、行内链接。
   *
   * @param {string} html HTML 源码
   * @returns {string} Markdown 文本
   */
  function htmlToMarkdown(html) {
    if (html === null || html === undefined) return '';
    return getService().turndown(String(html));
  }

  /**
   * 从一次粘贴事件里挑出 HTML。
   *
   * 从网页复制一段内容，剪贴板里同时有 text/plain 和 text/html 两个版本：
   * 默认粘进来的是纯文本（标签全没了），这里要的是 text/html。
   * 剪贴板里没有 HTML 版本时返回空串 —— 调用方据此放行默认粘贴行为。
   *
   * @param {{getData: function(string): string}} [data] 剪贴板数据（ClipboardEvent.clipboardData）
   * @returns {string} HTML 文本；没有 HTML 版本时是空串
   */
  function pickClipboardHtml(data) {
    if (!data || typeof data.getData !== 'function') return '';
    var html = '';
    try {
      html = data.getData('text/html');
    } catch (e) {
      // 某些浏览器在无权限时 getData 会抛；当作「没有 HTML 版本」处理
      return '';
    }
    return typeof html === 'string' ? html : '';
  }

  /* ---------- UI ---------- */

  window.ItTools.register('html-to-markdown', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 8, spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your HTML here...')
    });

    var output = D.h('textarea.layui-textarea.mono-output', {
      rows: 12, readonly: 'readonly', spellcheck: 'false',
      placeholder: t('output_ph', 'The converted Markdown will appear here.')
    });

    var error = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });

    /** 真正跑一次转换。出错时输出框清空，错误另起一行显示。 */
    function convert() {
      var markdown;
      try {
        markdown = htmlToMarkdown(input.value);
      } catch (e) {
        output.value = '';
        // 库没加载上是页面自己的问题，单独给一句话；别的错误把原始信息带上
        error.textContent = e && e.libMissing
          ? t('err_lib', 'The HTML-to-Markdown library failed to load. Please refresh the page and try again.')
          : t('err_convert', 'Conversion failed:') + ' ' + (e && e.message ? e.message : e);
        return;
      }
      error.textContent = '';
      output.value = markdown;
    }

    /**
     * 防抖：连续输入时只在停下来 200ms 之后转换一次。
     * 原版每次按键都同步转一遍，大文档下会明显卡顿。
     */
    var timer = null;
    function scheduleConvert() {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        timer = null;
        convert();
      }, DEBOUNCE_MS);
    }

    /**
     * 粘贴时优先用剪贴板里的 text/html 版本（插到光标处，不是清空整个框）。
     * 剪贴板里没有 HTML 版本就放行默认粘贴。
     */
    function onPaste(e) {
      var html = pickClipboardHtml(e.clipboardData);
      if (!html) return;
      e.preventDefault();
      var start = input.selectionStart;
      var end = input.selectionEnd;
      if (typeof start !== 'number' || typeof end !== 'number') {
        start = end = input.value.length;
      }
      input.value = input.value.slice(0, start) + html + input.value.slice(end);
      var caret = start + html.length;
      try { input.setSelectionRange(caret, caret); } catch (err) { /* 老浏览器没有这个方法 */ }
      scheduleConvert();
    }

    var offInput = D.on(input, 'input', scheduleConvert);
    var offPaste = D.on(input, 'paste', onPaste);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your HTML to convert:'), input, {
        wide: true,
        hint: t('input_hint', 'Tip: copy a part of a web page and paste it here — the clipboard keeps the HTML, so the tags are preserved. Tables, strikethrough and task lists are supported (GFM).')
      })
    ));

    root.appendChild(D.h('div.card', null,
      error,
      U.field(t('output', 'Output Markdown:'), output, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return output.value; }, t('copy_md', 'Copy Markdown')),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download_md', 'Download .md'), onclick: function () {
            if (output.value) {
              window.ItTools.download('output.md', output.value, 'text/markdown;charset=utf-8');
            }
          }
        })
      )
    ));

    convert();

    return {
      destroy: function () {
        offInput();
        offPaste();
        if (timer) window.clearTimeout(timer);
        timer = null;
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['html-to-markdown'] = {
    htmlToMarkdown: htmlToMarkdown,
    pickClipboardHtml: pickClipboardHtml,
    libError: libError,
    __cases: function (assert) {
      /* ---- 标题 ---- */
      assert.eq(htmlToMarkdown('<h1>Title</h1>'), 'Title\n=====', '一级标题：turndown 默认用 setext（下面一行 ===）');
      assert.eq(htmlToMarkdown('<h2>Sub</h2>'), 'Sub\n---', '二级标题：下面一行 ---');
      assert.eq(htmlToMarkdown('<h3>Deep</h3>'), '### Deep', '三级标题：更深的标题用 ATX（### 前缀）');

      /* ---- 段落与强调 ---- */
      assert.eq(htmlToMarkdown('<p>Hello <strong>bold</strong> and <em>italic</em></p>'),
        'Hello **bold** and _italic_', '粗体是 **，斜体是 _（turndown 默认用下划线）');
      assert.eq(htmlToMarkdown('<p>plain</p>'), 'plain', '普通段落');

      /* ---- 链接 ---- */
      assert.eq(htmlToMarkdown('<a href="https://x.y">link</a>'), '[link](https://x.y)', '行内链接');
      assert.eq(htmlToMarkdown('<a href="https://x.y" title="t">link</a>'),
        '[link](https://x.y "t")', '带 title 的链接');
      assert.eq(htmlToMarkdown('<a href="https://x.y">https://x.y</a>'),
        '[https://x.y](https://x.y)', '链接文字与地址相同时照样写成行内链接');

      /* ---- 列表 ---- */
      assert.eq(htmlToMarkdown('<ul><li>a</li><li>b</li></ul>'), '*   a\n*   b', '无序列表用 * 作项目符号');
      assert.eq(htmlToMarkdown('<ol><li>one</li><li>two</li></ol>'), '1.  one\n2.  two', '有序列表用数字加点');

      /* ---- 行内代码与代码块 ---- */
      assert.eq(htmlToMarkdown('<code>inline()</code>'), '`inline()`', '行内代码用反引号');
      assert.eq(htmlToMarkdown('<pre><code>block()</code></pre>'), '    block()', '代码块用四空格缩进（turndown 默认 codeBlockStyle: indented）');

      /* ---- 引用 ---- */
      assert.eq(htmlToMarkdown('<blockquote>quoted</blockquote>'), '> quoted', '引用用 > 前缀');

      /* ---- 图片 ---- */
      assert.eq(htmlToMarkdown('<img src="a.png" alt="pic">'), '![pic](a.png)', '图片转成 ![]() 语法，alt 写在里面');
      assert.eq(htmlToMarkdown('<img src="a.png">'), '![](a.png)', '没有 alt 的图片留空');

      /* ---- GFM 扩展（上游 fork 的 turndown-plugin-gfm）---- */
      assert.eq(htmlToMarkdown('<del>gone</del>'), '~gone~', '删除线（GFM）');
      assert.eq(htmlToMarkdown('<s>gone</s>'), '~gone~', 's 标签也算删除线（GFM）');
      assert.eq(htmlToMarkdown('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'),
        '| A | B |\n| --- | --- |\n| 1 | 2 |', '表格转成 GFM 管道表格（GFM）');
      assert.eq(htmlToMarkdown('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>'),
        '*   [x]  done\n*   [ ]  todo', '任务列表转成 [x] / [ ]（GFM）');

      /* ---- HTML 实体 ---- */
      assert.eq(htmlToMarkdown('<p>&amp; &lt; &gt;</p>'), '& < >', '命名实体解成字符');
      assert.eq(htmlToMarkdown('<p>&#65;&#x42;</p>'), 'AB', '数字实体（十进制与十六进制）都解开');

      /* ---- 非法 / 不完整的 HTML ---- */
      assert.eq(htmlToMarkdown('<p>unclosed <b>bold'), 'unclosed **bold**', '没闭合的标签由解析器补上，不报错');
      assert.eq(htmlToMarkdown('<ul><li>a</ul>'), '*   a', '列表没闭合也能转');
      assert.eq(htmlToMarkdown('<h1>a</h2>'), 'a\n=', '结束标签与开始标签对不上时按开始标签算（setext 的下划线长度跟标题文字一样长）');
      assert.eq(htmlToMarkdown('<p>a</p><p>b</p>'), 'a\n\nb', '两个段落之间空一行');

      /* ---- 边界 ---- */
      assert.eq(htmlToMarkdown(''), '', '空串');
      assert.eq(htmlToMarkdown(null), '', 'null 当空串');
      assert.eq(htmlToMarkdown(undefined), '', 'undefined 当空串');
      assert.eq(htmlToMarkdown('just text'), 'just text', '纯文本原样输出');
      assert.eq(typeof htmlToMarkdown('<p>x</p>'), 'string', '转换结果永远是字符串');

      /* ---- 剪贴板里挑 HTML ---- */
      assert.eq(pickClipboardHtml({ getData: function (type) { return type === 'text/html' ? '<b>x</b>' : 'x'; } }),
        '<b>x</b>', '剪贴板里有 text/html 时取它');
      assert.eq(pickClipboardHtml({ getData: function () { return ''; } }), '', '没有 HTML 版本时返回空串（放行默认粘贴）');
      assert.eq(pickClipboardHtml(null), '', '没有剪贴板数据时返回空串');
      assert.eq(pickClipboardHtml({ getData: function () { throw new Error('denied'); } }), '',
        '剪贴板读取被拒时返回空串，不抛异常');

      /* ---- 错误分类 ---- */
      assert(libError('x') instanceof Error, 'libError 返回的是 Error');
      assert.eq(libError('x').libMissing, true,
        '「库没加载上」的错误带 libMissing 标记 —— 界面上据此显示「刷新页面」那句，而不是转换失败');
    }
  };
})();
