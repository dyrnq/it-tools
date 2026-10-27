/* ==========================================================================
   CSS / JavaScript 格式化器（css-js-formatter）

   把一段 CSS 或 JavaScript 重新排版（beautify）。上游 it-tools 的 PR #958
   把这件事拆成了三个工具（css-prettifier / javascript-prettifier /
   html-prettifier），这里合成一个，只保留 CSS + JavaScript 两个方向。

   ---- 库（js-beautify）----
   vendor 的是 npm 包里的 `js/lib/beautifier.js`（自包含 webpack UMD），
   <script> 加载后挂在 window 上的全局名是 **beautifier**：

       window.beautifier.js(src, opts)   → 格式化 JavaScript
       window.beautifier.css(src, opts)  → 格式化 CSS
       window.beautifier.html(src, opts) → 格式化 HTML（本工具不用）

   注意 `beautifier` **本身不是一个可直接调用的函数** —— 上游 it-tools 里
   `import beautify from 'js-beautify'` 拿到的是 js/index.js 那个包过的
   可调用对象（它会去拉 glob / nopt / editorconfig，浏览器里用不了），
   裸 UMD 只挂出上面这三个入口。所以这里一律走 `.js()` / `.css()`。

   ---- 与上游的差别 ----
   - 上游只有 beautify，本工具也**不做** minify：上游那套压缩在 `//` 注释
     正则、`\s+` → 空格、`a + b` → `a+b` 三处都会破坏代码（字符串字面量里
     的空格会被吃掉，URL 里的 `//` 会被当成注释）。
   - 上游三张表单都在 computed 里直接调库，畸形输入时 js-beautify 抛异常，
     computed 被打挂 → 输出区空白、控制台报错，用户什么都看不到。
     这里把异常抓住，**原始错误信息直接写进输出区**。
   - 上游的 HTML 方向是一套约 1200 行的状态机，这里不做。
   - 上游只有 indent_char / indent_size / eol 三个写死的选项；这里把缩进
     宽度、缩进字符、换行符、保留空行都做成可选。
   - 输出区用的是共用的 outputCard（一个 div），不是一个只读的 textarea：
     textarea 的「API value」按 HTML 规范会把 CR LF 归一成 LF，那样
     「换行符选 CRLF」在输出区和剪贴板里都看不出来，选项等于摆设。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('css-js-formatter');

  /** 支持的两个方向。 */
  var MODES = ['css', 'js'];

  /** 缩进宽度候选。 */
  var INDENT_SIZES = [2, 4, 8];

  /** 换行符候选：LF（Unix）/ CRLF（Windows）。 */
  var EOLS = ['\n', '\r\n'];

  /** 两个方向各自的样例输入，切方向时跟着换。 */
  var SAMPLES = {
    css: 'body{margin:0;font-family:sans-serif}\n.card{padding:16px;border:1px solid #ddd}',
    js: 'function greet(name){if(!name){return "hi"}return "hi "+name;}'
  };

  /**
   * 拿到 vendor 的 js-beautify 库。
   * 库没挂上时（vendor 清单漏了一行）给一句人话，而不是让调用方看到
   * "Cannot read properties of undefined"。
   * @returns {object} window.beautifier
   */
  function beautifyLib() {
    var lib = window.beautifier;
    if (!lib || typeof lib.css !== 'function' || typeof lib.js !== 'function') {
      throw new Error('js-beautify library is not loaded');
    }
    return lib;
  }

  /**
   * 归一化选项。非法值一律回落到默认值 —— 库的默认缩进是 4 空格，
   * 与界面上的默认值（2）不一致，静默降级会让用户对着输出猜。
   *
   * @param {{indent_size?: number, indent_char?: string, eol?: string,
   *          preserve_newlines?: boolean}} [opts]
   * @returns {{indent_char: string, indent_size: number, eol: string, preserve_newlines: boolean}}
   */
  function buildOptions(opts) {
    opts = opts || {};
    var size = opts.indent_size === undefined ? 2 : Number(opts.indent_size);
    if (!isFinite(size) || size < 1 || size > 10) size = 2;
    return {
      indent_char: opts.indent_char === '\t' ? '\t' : ' ',
      indent_size: Math.floor(size),
      eol: opts.eol === '\r\n' ? '\r\n' : '\n',
      preserve_newlines: opts.preserve_newlines !== false
    };
  }

  /**
   * 格式化 CSS。
   *
   * 非字符串输入不去拦 —— 让库自己抛，输出区里显示的就是库的原始报错，
   * 比我们自己编一句「输入不合法」有用。
   *
   * @param {string} source
   * @param {object} [opts]
   * @returns {string}
   */
  function formatCss(source, opts) {
    var src = source === null || source === undefined ? '' : source;
    if (src === '') return '';
    return beautifyLib().css(src, buildOptions(opts));
  }

  /**
   * 格式化 JavaScript。
   * @param {string} source
   * @param {object} [opts]
   * @returns {string}
   */
  function formatJs(source, opts) {
    var src = source === null || source === undefined ? '' : source;
    if (src === '') return '';
    return beautifyLib().js(src, buildOptions(opts));
  }

  /**
   * 按方向分发。
   * @param {string} source
   * @param {string} mode 'css' | 'js'
   * @param {object} [opts]
   * @returns {string}
   */
  function format(source, mode, opts) {
    if (mode === 'css') return formatCss(source, opts);
    if (mode === 'js') return formatJs(source, opts);
    throw new Error('Unknown mode: ' + mode);
  }

  /* ---------- UI ---------- */

  /**
   * 下拉框。
   * @param {Array<[string, string]>} options [值, 显示名]
   * @param {string} initial
   * @returns {HTMLSelectElement}
   */
  function selectOf(options, initial) {
    var sel = D.h('select.layui-select');
    options.forEach(function (opt) {
      sel.appendChild(D.h('option', { value: opt[0], text: opt[1] }));
    });
    sel.value = initial;
    return sel;
  }

  window.ItTools.register('css-js-formatter', function (root) {
    var modeSelect = selectOf([
      [MODES[0], t('mode_css', 'CSS')],
      [MODES[1], t('mode_js', 'JavaScript')]
    ], MODES[0]);
    modeSelect.dataset.prev = MODES[0];
    var sizeSelect = selectOf(INDENT_SIZES.map(function (n) {
      return [String(n), String(n)];
    }), '2');
    var eolSelect = selectOf(EOLS.map(function (eol) {
      return [
        eol,
        eol === '\r\n' ? t('line_ending_crlf', 'CRLF (Windows)') : t('line_ending_lf', 'LF (Unix)')
      ];
    }), EOLS[0]);
    var tabsInput = D.h('input', { type: 'checkbox' });
    var preserveInput = D.h('input', { type: 'checkbox', checked: 'checked' });

    var input = D.h('textarea.layui-textarea', {
      rows: 12, spellcheck: 'false', placeholder: t('input_ph', 'Paste your CSS or JavaScript here...')
    });
    input.value = SAMPLES[MODES[0]];
    var status = D.h('p.form-status');

    /* 输出区用共用的 outputCard，而不是一个只读的 textarea ——
       textarea 的「API value」会把 CR LF 归一成 LF（HTML 规范如此），
       于是「换行符选 CRLF」这个选项在输出区根本看不出来，复制出去的
       也还是 LF。div 的 textContent 不做这个归一，CRLF 能原样留住。
       （输入框还是 textarea：它得能编辑，而浏览器把粘贴进来的 CRLF
       归一成 LF 是所有浏览器的统一行为，绕不开。） */
    var outCard = D.outputCard(t('output', 'Formatted code'));
    var output = outCard.outputBody;

    /** 当前界面上的选项。 */
    function currentOptions() {
      return {
        indent_size: Number(sizeSelect.value),
        indent_char: tabsInput.checked ? '\t' : ' ',
        eol: eolSelect.value,
        preserve_newlines: preserveInput.checked
      };
    }

    /**
     * 排一次版。出错时把**原始错误信息**写进输出区 —— 上游就是死在这一步：
     * 库里一抛，输出区空白、控制台报错，用户完全不知道发生了什么。
     */
    function render() {
      try {
        output.textContent = format(input.value, modeSelect.value, currentOptions());
        status.textContent = '';
        status.classList.remove('is-error');
      } catch (e) {
        output.textContent = e && e.message ? e.message : String(e);
        status.textContent = t('error', 'Formatting failed');
        status.classList.add('is-error');
      }
    }

    /** 切方向：输入框里还是上一个方向的样例时，跟着换成新方向的样例。 */
    function onModeChange() {
      var prev = modeSelect.dataset.prev;
      var next = modeSelect.value;
      modeSelect.dataset.prev = next;
      if (input.value === '' || input.value === SAMPLES[prev]) input.value = SAMPLES[next];
      render();
    }

    var formatBtn = D.h('button.layui-btn', { type: 'button', text: t('format', 'Format') });

    var offs = [
      D.on(formatBtn, 'click', render),
      D.on(input, 'input', render),
      D.on(modeSelect, 'change', onModeChange),
      D.on(sizeSelect, 'change', render),
      D.on(eolSelect, 'change', render),
      D.on(tabsInput, 'change', render),
      D.on(preserveInput, 'change', render)
    ];

    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', null, D.h('label.field-label', { text: t('mode', 'Language') }), modeSelect),
      D.h('div.field-row', null, D.h('label.field-label', { text: t('indent_size', 'Indent size') }), sizeSelect),
      D.h('div.field-row', null, D.h('label.field-label', { text: t('line_ending', 'Line ending') }), eolSelect),
      D.h('div.switch-grid', null,
        D.h('label.switch', null, tabsInput, D.h('span', { text: t('indent_with_tabs', 'Indent with tabs') }))),
      D.h('div.switch-grid', null,
        D.h('label.switch', null, preserveInput, D.h('span', { text: t('preserve_newlines', 'Preserve blank lines') }))),
      U.field(t('input', 'Your code to format'), input),
      D.h('div.form-actions', null, formatBtn)
    ));
    // 输出卡片自带标题和复制按钮（复制的是 outputBody.textContent，
    // CRLF 不会被 textarea 那样归一成 LF）
    outCard.appendChild(status);
    root.appendChild(outCard);
    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['css-js-formatter'] = {
    MODES: MODES,
    INDENT_SIZES: INDENT_SIZES,
    EOLS: EOLS,
    buildOptions: buildOptions,
    formatCss: formatCss,
    formatJs: formatJs,
    format: format,
    __cases: function (assert) {
      /* ---- 库在不在 ----
         库没挂上时（static/lib/manifest.tsv 少了一行）后面每一条都要真的调库，
         一起报「undefined is not a function」什么也看不出。先给一条能指到
         根因的，剩下的就别跑了。 */
      var libReady = !!(window.beautifier
        && typeof window.beautifier.js === 'function'
        && typeof window.beautifier.css === 'function');
      assert(libReady, 'js-beautify 库没挂上：static/lib/manifest.tsv 里缺 css-js-formatter 那一行'
        + '（vendor 的事见 new-tool/css-js-formatter.vendor.txt）');
      if (!libReady) return;

      /* ---- 库的形状：全局名是 beautifier，入口是 .js() / .css() ---- */
      assert(typeof window.beautifier === 'object',
        'window.beautifier 应该是对象（js/lib/beautifier.js 挂出来的 UMD 命名空间）');
      assert(typeof window.beautifier.js === 'function', 'beautifier.js 是格式化 JavaScript 的入口');
      assert(typeof window.beautifier.css === 'function', 'beautifier.css 是格式化 CSS 的入口');
      assert(typeof window.beautifier !== 'function',
        'beautifier 本身不可调用 —— 上游 import 的那个可调用包装是 js/index.js，浏览器里没有');

      /* ---- CSS ---- */
      assert.eq(formatCss('a{color:red;background:blue}'), 'a {\n  color: red;\n  background: blue\n}',
        'CSS：选择器与各条声明各占一行');
      assert.eq(formatCss('.a , .b{color:red}'), '.a,\n.b {\n  color: red\n}',
        'CSS：逗号分隔的选择器拆成多行');
      assert.eq(formatCss('@media (max-width: 100px) { a { color: red } }'),
        '@media (max-width: 100px) {\n  a {\n    color: red\n  }\n}',
        'CSS：媒体查询里的嵌套选择器');
      assert.eq(formatCss('a{color:red}', { indent_size: 4 }), 'a {\n    color: red\n}', 'CSS：缩进 4');
      assert.eq(formatCss('a{color:red}', { indent_char: '\t' }), 'a {\n\tcolor: red\n}', 'CSS：用制表符缩进');
      assert.eq(formatCss('a{color:red}', { eol: '\r\n' }), 'a {\r\n  color: red\r\n}', 'CSS：CRLF 换行');
      assert.eq(formatCss('a{color:red}\n\n\n\n\nb{color:blue}'), 'a {\n  color: red\n}\n\n\n\n\nb {\n  color: blue\n}',
        'CSS：默认保留原有空行');
      assert.eq(formatCss('a{color:red}\n\n\n\n\nb{color:blue}', { preserve_newlines: false }),
        'a {\n  color: red\n}\n\nb {\n  color: blue\n}',
        'CSS：关掉「保留空行」后多余空行被压掉');
      assert.eq(formatCss(''), '', 'CSS：空输入');
      assert.eq(formatCss(null), '', 'CSS：null 输入');
      assert.eq(formatCss('   \n '), '', 'CSS：纯空白');

      /* ---- JavaScript ---- */
      assert.eq(formatJs('function  foo( a,b ){return a+b;}'), 'function foo(a, b) {\n  return a + b;\n}',
        'JS：函数体缩进，参数逗号后补空格');
      assert.eq(formatJs('const x={a:1,b:[1,2]};'), 'const x = {\n  a: 1,\n  b: [1, 2]\n};',
        'JS：对象字面量拆行');
      assert.eq(formatJs('if(a){b()}else{c()}'), 'if (a) {\n  b()\n} else {\n  c()\n}', 'JS：if/else');
      assert.eq(formatJs('const s = "a  b";'), 'const s = "a  b";', 'JS：字符串字面量里的空格不动');
      assert.eq(formatJs('// hi\nconst a=1;'), '// hi\nconst a = 1;', 'JS：行注释保留');
      assert.eq(formatJs('function f(){if(a){b()}}', { indent_size: 4 }),
        'function f() {\n    if (a) {\n        b()\n    }\n}', 'JS：缩进 4');
      assert.eq(formatJs('function f(){if(a){b()}}', { indent_char: '\t' }),
        'function f() {\n\tif (a) {\n\t\tb()\n\t}\n}', 'JS：用制表符缩进');
      assert.eq(formatJs('function f(){if(a){b()}}', { eol: '\r\n' }),
        'function f() {\r\n  if (a) {\r\n    b()\r\n  }\r\n}', 'JS：CRLF 换行');
      assert.eq(formatJs(''), '', 'JS：空输入');
      assert.eq(formatJs(null), '', 'JS：null 输入');
      assert.eq(formatJs('   \n '), '', 'JS：纯空白');

      /* ---- 按方向分发 ---- */
      assert.eq(format('a{color:red}', 'css'), formatCss('a{color:red}'), 'format(..., "css") 走 CSS');
      assert.eq(format('const a=1;', 'js'), formatJs('const a=1;'), 'format(..., "js") 走 JavaScript');
      var badMode = false;
      try { format('x', 'xml'); } catch (e) { badMode = true; }
      assert(badMode, '未知方向应抛错');
      assert.eq(MODES.join(','), 'css,js', '只有 CSS 与 JavaScript 两个方向（上游的 HTML 方向不做）');

      /* ---- 错误输入：异常要能冒出来，UI 才有机会把它显示在输出区 ---- */
      var threwCss = false;
      try { formatCss(123); } catch (e) { threwCss = true; }
      assert(threwCss, 'CSS：非字符串输入应抛错（库自己的 TypeError）');
      var threwJs = false;
      try { formatJs({}); } catch (e) { threwJs = true; }
      assert(threwJs, 'JS：非字符串输入应抛错');

      /* ---- buildOptions ---- */
      assert.eq(buildOptions(), { indent_char: ' ', indent_size: 2, eol: '\n', preserve_newlines: true }, '默认选项');
      assert.eq(buildOptions({ indent_size: 4 }).indent_size, 4, '缩进宽度透传');
      assert.eq(buildOptions({ indent_size: 0 }).indent_size, 2, '非法缩进宽度（0）回落到 2');
      assert.eq(buildOptions({ indent_size: 99 }).indent_size, 2, '越界缩进宽度回落到 2');
      assert.eq(buildOptions({ indent_char: '\t' }).indent_char, '\t', '制表符透传');
      assert.eq(buildOptions({ indent_char: 'x' }).indent_char, ' ', '非法缩进字符回落到空格');
      assert.eq(buildOptions({ eol: '\r\n' }).eol, '\r\n', 'CRLF 透传');
      assert.eq(buildOptions({ eol: 'x' }).eol, '\n', '非法换行符回落到 LF');
      assert.eq(buildOptions({ preserve_newlines: false }).preserve_newlines, false, 'preserve_newlines 透传');
    }
  };
})();
