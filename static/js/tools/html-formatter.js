/* ==========================================================================
   HTML 格式化（html-formatter）

   把一段 HTML 重新缩进排版，输出仍然是 HTML。

   ---- 依赖 ----
   跟 css-js-formatter 用的是同一个库、同一份产物：npm 的 js-beautify
   （static/lib/js-beautify/js/lib/beautifier.js，自包含的 webpack UMD）。
   它挂在 window 上的是**对象** beautifier，不是可调用的函数 ——
   上游 it-tools 里 `import beautify from 'js-beautify'` 拿到的那个可调用包装
   来自 js/index.js（Node 入口，要拉 glob / nopt / editorconfig），浏览器里用不了。
   所以这里一律走 window.beautifier.html(src, opts)。

   ---- 与上游（src/tools/html-prettifier/）的差别 ----
   上游只有一个 computed：
       beautify.html(inputHtml.value, {
         unformatted: ['code','pre','em','strong','span'],
         indent_inner_html: true, indent_char: ' ', indent_size: 2, eol: '\n'
       })
   差别：
   1. 上游把缩进写死成 2，行宽 / 空行 / extra_liners 全吃库的默认值。
      这里把 indent_size / wrap_line_length / preserve_newlines /
      indent_inner_html / extra_liners 做成可调。缩进默认 **4**
      （js-beautify 自己的默认也是 4；上游那个 2 是个例外）。
   2. indent_inner_html 这里默认**开**（跟上游一致）。js-beautify 自己的默认是关，
      差别在完整文档上很明显：<head> / <body> 要不要缩进到 <html> 里面。
   3. 上游不传 wrap_line_length，一行的长度完全由输入决定；这里能设上限。
   4. 上游的 computed 直接调库，异常一抛整块工具就白掉，用户什么都看不到；
      这里把异常抓住写进状态行。
   5. 上游对「根本不是 HTML 的输入」（一段纯文本）照常输出，用户会对着一个
      原样返回的结果发呆；这里多给一行提示：这段输入里没有标签。
   6. 上游固定传 unformatted: [...]，那会让这些行内元素在换行时不拆开。
      这里不传（用库的默认值）：行宽默认 0（不换行）时它看不出差别，
      而它一旦生效又跟行宽选项互相牵扯。想要上游那种行为，把这个选项加回去即可。

   ---- 库的脾气（都是实测的）----
   - 对**畸形**输入很宽容：标签没闭合照样排出一段结果，不抛异常。
   - 对**非字符串**输入会抛 TypeError（source_text.replace is not a function）。
   - indent_size 的默认是 4；extra_liners 的默认是 ['head','body','/html']；
     wrap_line_length 的默认是 0（= 不换行）；eol 的默认是 'auto'（跟着输入走），
     这里固定成 '\n'，输出才稳定。
   - <script> / <style> 里的内容是库自己交给 js / css 格式化器排的，
     不要在外面再套一层转义 —— 套了反而会把标签吃掉。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('html-formatter');

  /** 缩进宽度默认值（js-beautify 自己的默认也是 4）。 */
  var DEFAULT_INDENT_SIZE = 4;
  /** 行宽上限默认值：0 = 不换行。 */
  var DEFAULT_WRAP_LINE_LENGTH = 0;
  /** 默认在这些标签前另起一行（js-beautify 的默认值）。 */
  var DEFAULT_EXTRA_LINERS = 'head,body,/html';

  /** 缩进宽度的取值范围。 */
  var MIN_INDENT_SIZE = 1;
  var MAX_INDENT_SIZE = 10;
  /** 行宽上限的取值范围。 */
  var MAX_WRAP_LINE_LENGTH = 1000;

  /** 输入停顿多久才真的排一次版（毫秒）。大段 HTML 每敲一个键就同步排一次会卡。 */
  var DEBOUNCE_MS = 200;

  /** 打开页面时先放一份样例，省得对着空白框发呆。 */
  var SAMPLE_HTML = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>Sample page</title>',
    '</head>',
    '<body>',
    '  <h1>Hello</h1>',
    '  <p>This is a <strong>sample</strong> document.</p>',
    '  <ul>',
    '    <li>One</li>',
    '    <li>Two</li>',
    '  </ul>',
    '</body>',
    '</html>'
  ].join('\n');

  /**
   * 「这段输入里有没有标签」的粗判。
   *
   * 库对纯文本是**原样返回**的（不报错、也不提示），用户会以为工具没干活。
   * 这里自己判一下，好歹给一行提示。判据只认 `<` 后面跟着字母 / `!` / `/`
   * 的情况 —— `<3`、`a < b` 这种不算标签。
   *
   * @param {string} source
   * @returns {boolean}
   */
  var TAG_RE = /<(\/|!|[a-zA-Z])/;

  /**
   * 取 vendor 的 js-beautify 库。
   *
   * 库没挂上时（vendor 清单漏了一行）给一句人话，而不是让调用方看到
   * "Cannot read properties of undefined"。
   *
   * @returns {object} window.beautifier
   * @throws {Error} 库没加载上时抛（带 libMissing 标记，界面上单独显示）
   */
  function beautifyLib() {
    var lib = window.beautifier;
    if (!lib || typeof lib.html !== 'function') {
      var e = new Error('js-beautify library is not loaded');
      e.libMissing = true;
      throw e;
    }
    return lib;
  }

  /**
   * 「另起一行」的标签列表 → 数组。
   * 空字符串 / 空数组 = 一个都不要（不是「回到库的默认」——
   * 那个默认是 head,body,/html，清空输入框的人多半是想全都去掉）。
   *
   * @param {string|string[]} value
   * @returns {string[]}
   */
  function parseExtraLiners(value) {
    var list;
    if (Array.isArray(value)) {
      list = value.slice();
    } else if (value === null || value === undefined) {
      list = DEFAULT_EXTRA_LINERS.split(',');
    } else {
      list = String(value).split(',');
    }
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var tag = String(list[i]).trim();
      if (tag) out.push(tag);
    }
    return out;
  }

  /**
   * 归一化选项。非法值一律回落到默认值 —— 静默降级会让用户对着输出猜。
   *
   * @param {{indent_size?: number, wrap_line_length?: number,
   *          preserve_newlines?: boolean, indent_inner_html?: boolean,
   *          extra_liners?: string|string[]}} [opts]
   * @returns {{indent_char: string, indent_size: number, eol: string,
   *            preserve_newlines: boolean, indent_inner_html: boolean,
   *            wrap_line_length: number, extra_liners: string[]}}
   */
  function buildOptions(opts) {
    opts = opts || {};
    var size = opts.indent_size === undefined ? DEFAULT_INDENT_SIZE : Number(opts.indent_size);
    if (!isFinite(size) || size < MIN_INDENT_SIZE || size > MAX_INDENT_SIZE) size = DEFAULT_INDENT_SIZE;
    var wrap = opts.wrap_line_length === undefined ? DEFAULT_WRAP_LINE_LENGTH : Number(opts.wrap_line_length);
    if (!isFinite(wrap) || wrap < 0) wrap = DEFAULT_WRAP_LINE_LENGTH;
    if (wrap > MAX_WRAP_LINE_LENGTH) wrap = MAX_WRAP_LINE_LENGTH;
    return {
      indent_char: ' ',
      indent_size: Math.floor(size),
      eol: '\n',
      preserve_newlines: opts.preserve_newlines !== false,
      indent_inner_html: opts.indent_inner_html !== false,
      wrap_line_length: Math.floor(wrap),
      extra_liners: parseExtraLiners(opts.extra_liners)
    };
  }

  /**
   * 格式化 HTML。
   *
   * 非字符串输入不去拦 —— 让库自己抛，输出区里显示的就是库的原始报错，
   * 比我们自己编一句「输入不合法」有用。
   *
   * @param {string} source
   * @param {object} [opts] 见 buildOptions
   * @returns {string}
   */
  function formatHtml(source, opts) {
    var src = source === null || source === undefined ? '' : source;
    if (src === '') return '';
    return beautifyLib().html(src, buildOptions(opts));
  }

  /**
   * 输入里有没有 HTML 标签（粗判，见 TAG_RE 处的说明）。
   * @param {string} source
   * @returns {boolean}
   */
  function looksLikeHtml(source) {
    if (source === null || source === undefined) return false;
    var s = String(source);
    if (s.trim() === '') return false;
    return TAG_RE.test(s);
  }

  /* ---------- UI ---------- */

  window.ItTools.register('html-formatter', function (root) {
    var indentInput = D.h('input.layui-input', {
      type: 'number', min: String(MIN_INDENT_SIZE), max: String(MAX_INDENT_SIZE),
      step: '1', value: String(DEFAULT_INDENT_SIZE)
    });
    var wrapInput = D.h('input.layui-input', {
      type: 'number', min: '0', max: String(MAX_WRAP_LINE_LENGTH),
      step: '10', value: String(DEFAULT_WRAP_LINE_LENGTH)
    });
    var linersInput = D.h('input.layui-input', {
      type: 'text', value: DEFAULT_EXTRA_LINERS, spellcheck: 'false'
    });
    var preserveInput = D.h('input', { type: 'checkbox', checked: 'checked' });
    var innerInput = D.h('input', { type: 'checkbox', checked: 'checked' });

    var input = D.h('textarea.layui-textarea.mono', {
      rows: 14, spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your HTML here...')
    });
    input.value = SAMPLE_HTML;

    var status = D.h('p.form-status');
    var outCard = D.outputCard(t('output', 'Formatted HTML'));
    var output = outCard.outputBody;
    // 提示行放在结果上面：先看到「出了什么事」，再看结果
    outCard.insertBefore(status, output);

    /** 当前界面上的选项。 */
    function currentOptions() {
      return {
        indent_size: Number(indentInput.value),
        wrap_line_length: Number(wrapInput.value),
        preserve_newlines: preserveInput.checked,
        indent_inner_html: innerInput.checked,
        extra_liners: linersInput.value
      };
    }

    /**
     * 写状态行。cls 为空表示普通说明，'is-error' 是出错，'is-warn' 是提醒。
     * @param {string} text
     * @param {string} [cls]
     */
    function setStatus(text, cls) {
      status.textContent = text;
      status.classList.remove('is-error');
      status.classList.remove('is-warn');
      if (cls) status.classList.add(cls);
    }

    /**
     * 排一次版。
     *
     * 三种结果分开说清楚：
     *   · 空输入      → 提示「粘点东西进来」；
     *   · 不是 HTML   → 照样给结果，但多一行提醒（库是原样返回的）；
     *   · 出错        → 结果清空，错误写进状态行（不把异常抛给用户）。
     */
    function render() {
      var src = input.value;
      if (src.trim() === '') {
        output.textContent = '';
        setStatus(t('hint_empty', 'Paste some HTML to format.'));
        return;
      }
      var html;
      try {
        html = formatHtml(src, currentOptions());
      } catch (e) {
        output.textContent = '';
        if (e && e.libMissing) {
          setStatus(t('err_lib', 'The HTML formatter library failed to load. Please refresh the page and try again.'), 'is-error');
        } else {
          setStatus(t('err_format', 'HTML formatting failed: {error}')
            .replace('{error}', function () { return e && e.message ? e.message : String(e); }), 'is-error');
        }
        return;
      }
      output.textContent = html;
      if (!looksLikeHtml(src)) {
        setStatus(t('warn_not_html', 'This does not look like HTML — the text was passed through unchanged.'), 'is-warn');
      } else {
        setStatus('');
      }
    }

    /** 防抖：连续输入时只在停下来之后排一次版。 */
    var timer = null;
    function scheduleRender() {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        timer = null;
        render();
      }, DEBOUNCE_MS);
    }

    /** 「格式化」按钮：立刻排一次（把还挂着的防抖也一起取消）。 */
    function formatNow() {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      render();
    }

    var formatBtn = D.h('button.layui-btn', { type: 'button', text: t('format', 'Format') });
    var sampleBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: t('sample', 'Load sample'), onclick: function () {
        input.value = SAMPLE_HTML;
        formatNow();
      }
    });
    var clearBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: t('clear', 'Clear'), onclick: function () {
        input.value = '';
        formatNow();
      }
    });

    var offs = [
      D.on(formatBtn, 'click', formatNow),
      D.on(input, 'input', scheduleRender),
      D.on(indentInput, 'input', scheduleRender),
      D.on(indentInput, 'change', scheduleRender),
      D.on(wrapInput, 'input', scheduleRender),
      D.on(wrapInput, 'change', scheduleRender),
      D.on(linersInput, 'input', scheduleRender),
      D.on(linersInput, 'change', scheduleRender),
      D.on(preserveInput, 'change', scheduleRender),
      D.on(innerInput, 'change', scheduleRender)
    ];

    /** 一列选项：标签在上、控件在下。 */
    function optionColumn(labelText, control, hintText) {
      return D.h('div.option-column', null,
        U.field(labelText, control, hintText ? { hint: hintText } : null));
    }

    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      D.h('div.option-columns', null,
        optionColumn(t('indent_size', 'Indent size'), indentInput),
        optionColumn(t('wrap_line_length', 'Wrap line length'), wrapInput,
          t('wrap_line_length_hint', '0 = no wrapping')),
        optionColumn(t('extra_liners', 'Extra line before tags'), linersInput,
          t('extra_liners_hint', 'Comma-separated tag names; empty = none'))),
      D.h('div.switch-grid', null,
        D.h('label.switch', null, preserveInput, D.h('span', { text: t('preserve_newlines', 'Preserve blank lines') })),
        D.h('label.switch', null, innerInput, D.h('span', { text: t('indent_inner_html', 'Indent inner HTML') }))),
      U.field(t('input', 'Your HTML to format'), input, {
        wide: true,
        hint: t('input_hint', 'The content of script and style blocks is formatted too.')
      }),
      D.h('div.form-actions', null, formatBtn, sampleBtn, clearBtn)
    ));

    // 输出卡片自带复制按钮（复制的是 outputBody.textContent）
    outCard.appendChild(D.h('div.form-actions', null,
      U.copyButton(function () { return output.textContent; }, t('copy_html', 'Copy HTML')),
      D.h('button.layui-btn.layui-btn-primary', {
        type: 'button', text: t('download_html', 'Download .html'), onclick: function () {
          var text = output.textContent;
          if (!text) return;
          window.ItTools.download('output.html', text, 'text/html;charset=utf-8');
        }
      })
    ));
    root.appendChild(outCard);
    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        if (timer) window.clearTimeout(timer);
        timer = null;
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['html-formatter'] = {
    DEFAULT_INDENT_SIZE: DEFAULT_INDENT_SIZE,
    DEFAULT_WRAP_LINE_LENGTH: DEFAULT_WRAP_LINE_LENGTH,
    DEFAULT_EXTRA_LINERS: DEFAULT_EXTRA_LINERS,
    MIN_INDENT_SIZE: MIN_INDENT_SIZE,
    MAX_INDENT_SIZE: MAX_INDENT_SIZE,
    buildOptions: buildOptions,
    parseExtraLiners: parseExtraLiners,
    formatHtml: formatHtml,
    looksLikeHtml: looksLikeHtml,
    __cases: function (assert) {
      /* ---- 库在不在 ----
         库没挂上时（static/lib/manifest.tsv 少了一行）后面每一条都要真的调库，
         一起报「undefined is not a function」什么也看不出。先给一条能指到
         根因的，剩下的就别跑了。 */
      var libReady = !!(window.beautifier && typeof window.beautifier.html === 'function');
      assert(libReady, 'js-beautify 库没挂上：static/lib/manifest.tsv 里缺 html-formatter 那一行'
        + '（vendor 的事见 new-tool/css-js-formatter.vendor.txt）');
      if (!libReady) return;

      /* ---- 库的形状：全局名是 beautifier，HTML 入口是 .html() ---- */
      assert(typeof window.beautifier === 'object',
        'window.beautifier 应该是对象（js/lib/beautifier.js 挂出来的 UMD 命名空间）');
      assert(typeof window.beautifier.html === 'function', 'beautifier.html 是格式化 HTML 的入口');
      assert(typeof window.beautifier.js === 'function' && typeof window.beautifier.css === 'function',
        '同一份产物里还有 .js() / .css()（跟 css-js-formatter 共用一个库）');

      /* ---- 基本缩进 ---- */
      assert.eq(formatHtml('<div><p>hello</p></div>'), '<div>\n    <p>hello</p>\n</div>',
        '默认缩进 4（js-beautify 自己的默认也是 4，上游 it-tools 那个 2 是个例外）');
      assert.eq(formatHtml('<div><p>hello</p></div>', { indent_size: 2 }), '<div>\n  <p>hello</p>\n</div>',
        '缩进 2');
      assert.eq(formatHtml('<div><p>hello</p></div>', { indent_size: 8 }), '<div>\n        <p>hello</p>\n</div>',
        '缩进 8');

      /* ---- 完整文档 ---- */
      assert.eq(formatHtml('<!DOCTYPE html><html><head><title>T</title></head><body><h1>Hi</h1></body></html>'),
        '<!DOCTYPE html>\n<html>\n\n    <head>\n        <title>T</title>\n    </head>\n\n    <body>\n        <h1>Hi</h1>\n    </body>\n\n</html>',
        'DOCTYPE 单独一行；head / body 缩进到 html 里面（indent_inner_html 默认开），'
        + 'head / body / /html 前各空一行（库的 extra_liners 默认值）');
      assert.eq(formatHtml('<!DOCTYPE html><html><head><title>T</title></head><body><h1>Hi</h1></body></html>',
        { indent_inner_html: false }),
        '<!DOCTYPE html>\n<html>\n\n<head>\n    <title>T</title>\n</head>\n\n<body>\n    <h1>Hi</h1>\n</body>\n\n</html>',
        'indent_inner_html 关掉：head / body 与 html 平级');

      /* ---- script / style 里的内容由库自己排 ---- */
      assert.eq(formatHtml('<script>var a=1;function f(){return 2}</script>'),
        '<script>\n    var a = 1;\n\n    function f() {\n        return 2\n    }\n</script>',
        'script 里的内容走 js 格式化器');
      assert.eq(formatHtml('<style>body{color:red}</style>'),
        '<style>\n    body {\n        color: red\n    }\n</style>',
        'style 里的内容走 css 格式化器');

      /* ---- preserve_newlines ---- */
      assert.eq(formatHtml('<div>\n\n\n<p>a</p>\n\n\n<p>b</p>\n</div>'),
        '<div>\n\n\n    <p>a</p>\n\n\n    <p>b</p>\n</div>',
        '默认保留原有空行');
      assert.eq(formatHtml('<div>\n\n\n<p>a</p>\n\n\n<p>b</p>\n</div>', { preserve_newlines: false }),
        '<div>\n    <p>a</p>\n    <p>b</p>\n</div>',
        '关掉「保留空行」后空行被压掉');

      /* ---- wrap_line_length ---- */
      assert.eq(formatHtml('<div><p>this is a fairly long line of text that will need to be wrapped somewhere</p></div>'),
        '<div>\n    <p>this is a fairly long line of text that will need to be wrapped somewhere</p>\n</div>',
        '行宽默认 0 = 不换行');
      assert.eq(formatHtml('<div><p>this is a fairly long line of text that will need to be wrapped somewhere</p></div>',
        { wrap_line_length: 40 }),
        '<div>\n    <p>this is a fairly long line of\n        text that will need to be\n        wrapped somewhere</p>\n</div>',
        '给了行宽上限之后长行被折开');

      /* ---- extra_liners ---- */
      assert.eq(formatHtml('<html><head></head><body><p>x</p></body></html>', { extra_liners: [] }),
        '<html>\n    <head></head>\n    <body>\n        <p>x</p>\n    </body>\n</html>',
        'extra_liners 清空：标签前不再空行');
      assert.eq(formatHtml('<html><body><div>x</div></body></html>', { extra_liners: ['div'] }),
        '<html>\n    <body>\n\n        <div>x</div>\n    </body>\n</html>',
        'extra_liners 指定 div：div 前空一行');

      /* ---- 畸形输入：库很宽容，不抛 ---- */
      assert.eq(formatHtml('<div><p>unclosed'), '<div>\n    <p>unclosed',
        '标签没闭合照样排出一段结果，不报错');
      assert(typeof formatHtml('<p>a</h2><b>x') === 'string',
        '结束标签与开始标签对不上也不报错');

      /* ---- 纯文本：库原样返回 ---- */
      assert.eq(formatHtml('just some text'), 'just some text', '完全不是 HTML：原样返回，不报错');

      /* ---- 边界 ---- */
      assert.eq(formatHtml(''), '', '空输入');
      assert.eq(formatHtml(null), '', 'null 输入');
      assert.eq(formatHtml(undefined), '', 'undefined 输入');
      assert.eq(typeof formatHtml('<p>x</p>'), 'string', '结果永远是字符串');

      /* ---- 错误输入：异常要能冒出来，UI 才有机会把它显示在状态行 ---- */
      var threw = false;
      try { formatHtml(123); } catch (e) { threw = true; }
      assert(threw, '非字符串输入应抛错（库自己的 TypeError）');
      var libThrew = false;
      try {
        var saved = window.beautifier;
        window.beautifier = undefined;
        try { formatHtml('<p>x</p>'); } catch (e) { libThrew = !!(e && e.libMissing); }
        window.beautifier = saved;
      } catch (e) { libThrew = false; }
      assert(libThrew, '库没挂上时抛的是带 libMissing 标记的错误（界面上据此显示「刷新页面」那句）');

      /* ---- looksLikeHtml ---- */
      assert(looksLikeHtml('<div>x</div>'), '有标签');
      assert(looksLikeHtml('<!DOCTYPE html>'), 'DOCTYPE 也算标签');
      assert(looksLikeHtml('</div>'), '只有结束标签也算');
      assert(!looksLikeHtml('just some text'), '纯文本不算');
      assert(!looksLikeHtml('a < b and 3<4'), '「<」后面不是字母 / ! / / 的不算标签');
      assert(!looksLikeHtml(''), '空串不算');
      assert(!looksLikeHtml('   \n '), '纯空白不算');
      assert(!looksLikeHtml(null), 'null 不算');

      /* ---- parseExtraLiners ---- */
      assert.eq(parseExtraLiners('head,body,/html'), ['head', 'body', '/html'], '逗号分隔');
      assert.eq(parseExtraLiners(' head , body '), ['head', 'body'], '空格被去掉');
      assert.eq(parseExtraLiners(''), [], '空串 = 一个都不要');
      assert.eq(parseExtraLiners('head,,body'), ['head', 'body'], '空项被丢掉');
      assert.eq(parseExtraLiners(['a', ' b ']), ['a', 'b'], '数组也能给');
      assert.eq(parseExtraLiners(), ['head', 'body', '/html'], '不给值时用库的默认值');

      /* ---- buildOptions ---- */
      assert.eq(buildOptions(), {
        indent_char: ' ', indent_size: 4, eol: '\n', preserve_newlines: true,
        indent_inner_html: true, wrap_line_length: 0, extra_liners: ['head', 'body', '/html']
      }, '默认选项');
      assert.eq(buildOptions({ indent_size: 2 }).indent_size, 2, '缩进宽度透传');
      assert.eq(buildOptions({ indent_size: 0 }).indent_size, 4, '非法缩进宽度（0）回落到 4');
      assert.eq(buildOptions({ indent_size: 99 }).indent_size, 4, '越界缩进宽度回落到 4');
      assert.eq(buildOptions({ indent_size: 'x' }).indent_size, 4, '非数字缩进宽度回落到 4');
      assert.eq(buildOptions({ wrap_line_length: 80 }).wrap_line_length, 80, '行宽上限透传');
      assert.eq(buildOptions({ wrap_line_length: -5 }).wrap_line_length, 0, '负的行宽回落到 0');
      assert.eq(buildOptions({ wrap_line_length: 99999 }).wrap_line_length, 1000, '越界行宽被截到 1000');
      assert.eq(buildOptions({ preserve_newlines: false }).preserve_newlines, false, 'preserve_newlines 透传');
      assert.eq(buildOptions({ indent_inner_html: false }).indent_inner_html, false, 'indent_inner_html 透传');
      assert.eq(buildOptions({ extra_liners: 'div' }).extra_liners, ['div'], 'extra_liners 透传');
      assert.eq(buildOptions({ extra_liners: '' }).extra_liners, [], 'extra_liners 清空 = 空的数组');
    }
  };
})();
