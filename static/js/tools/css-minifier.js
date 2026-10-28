/* ==========================================================================
   CSS 压缩器（css-minifier）

   把一段 CSS 压成一行：去注释、收空白、去掉多余的符号与引号。

   ---- 为什么自己写，不用现成的库 ----
   上游 it-tools 的 css-js-prettify-minify 的 minify 部分是四条正则：

       .replace(/\/\*[\s\S]*?\*\//g, '')            去注释
       .replace(/\s+/g, ' ')                        空白折成一个空格
       .replace(/ ?([{}();,=:+\-*\/<>!&|?]) ?/g, '$1')  去掉符号两边的空格
       .replaceAll(';}', '}')

   这四条各有一处真 bug（_docs/new-tool-candidates.md 里记着同样的账）：

     · 「去注释」那条把 URL 里的 `//` 也当注释 ——
       `background: url(http://x/a.png)` 会被从 `//` 处截断。
     · 「空白折成一个空格」把字符串字面量里的空格也吃掉 ——
       `content: "a  b"` 变成 `content: "a b"`。
     · 「去掉符号两边的空格」把 `calc(1px + 2px)` 压成 `calc(1px+2px)` ——
       CSS 规范里 `+` / `-` 两侧的空格是**必须**有的，压掉就是语法错误。
     · 「去注释」那条还会把 `/*` 出现在字符串里的情况吃掉。

   所以这里不用正则，改成**先切词、再拼**：

     · 字符串、注释按原样搬走，正则碰不到它们；
     · 空白折成一个空格时，符号两侧的空格**按上下文**决定去留；
     · `:` 是不是「属性名 : 值」里的分隔符，要看它后面先遇到 `;` / `}`
       还是 `{`（后者说明这是嵌套规则的**选择器**，`& a :hover` 里的那个
       空格动了就把「a 的后代里的 hover」变成了「a 自己」）；
     * `+` / `-` 两侧的空格**永远留着** —— `calc()` 靠它。

   ---- 输出的是「安全」的压缩 ----
   压完的 CSS 语义与原文一致（前提是原文本身没有 `white-space: pre`
   之类靠空白活着的东西 —— CSS 里没有这种写法，HTML 里才有）。

   ---- 保留什么 ----
   · 字符串原样（含引号与转义）。
   · `url(...)` 的内容原样（它整体是一个 token，正则碰不到）。
   · `@media` 的条件里 `:` 两边的空格留着 —— 那是特性名与值的分隔符。
   · `!important` 前面的空格去掉（`red !important` → `red!important`）。
   · 块末尾那个多余的分号去掉（`a{color:red;}` → `a{color:red}`）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('css-minifier');

  /* ==================================================================
     一、切词
     ================================================================== */

  /** CSS 里的空白字符就这五个。 */
  function isWs(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  }

  /**
   * 单独成 token 的标点。
   *
   * 其余字符（字母、数字、`-`、`_`、`%`、`#`、`&`…）成 word ——
   * 标识符与数字本来就不该被拆开。
   */
  var PUNCT = '{}();:,>~+*!=/[]@';

  /**
   * 把 CSS 切成 token 序列。
   *
   * token 有五种：
   *   ws      空白（一整段合成一个）
   *   comment 注释（含 `/* … *\/` 的原样文本）
   *   string  字符串（含引号的原样文本）
   *   punct   单个标点
   *   word    标识符 / 数字 / 其它成串的字符
   *
   * 字符串与注释**原样保留** —— 压缩器不该碰它们里面的内容。
   *
   * @param {string} src
   * @returns {Array<{type: string, text: string}>}
   */
  function tokenize(src) {
    var tokens = [];
    var i = 0;
    var n = src.length;
    while (i < n) {
      var c = src.charAt(i);

      if (isWs(c)) {
        var wsEnd = i;
        while (wsEnd < n && isWs(src.charAt(wsEnd))) wsEnd++;
        tokens.push({ type: 'ws', text: src.slice(i, wsEnd) });
        i = wsEnd;
        continue;
      }

      if (c === '/' && src.charAt(i + 1) === '*') {
        var close = src.indexOf('*/', i + 2);
        if (close < 0) {
          // 没闭合的注释：原样留着。
          // 浏览器会把 `/*` 之后的内容整个当注释 —— 删掉它等于把一段
          // 用户以为还在的代码**变成生效的 CSS**，那是比保留更糟的结果。
          tokens.push({ type: 'comment', text: src.slice(i, n), unterminated: true });
          i = n;
          continue;
        }
        tokens.push({ type: 'comment', text: src.slice(i, close + 2) });
        i = close + 2;
        continue;
      }

      if (c === '"' || c === "'") {
        var j = i + 1;
        while (j < n) {
          var d = src.charAt(j);
          if (d === '\\') { j += 2; continue; }
          if (d === c) { j++; break; }
          j++;
        }
        if (j > n) j = n;
        tokens.push({ type: 'string', text: src.slice(i, j) });
        i = j;
        continue;
      }

      if (PUNCT.indexOf(c) >= 0) {
        tokens.push({ type: 'punct', text: c });
        i++;
        continue;
      }

      var k = i;
      while (k < n) {
        var e = src.charAt(k);
        if (isWs(e) || e === '"' || e === "'" || PUNCT.indexOf(e) >= 0) break;
        if (e === '/' && src.charAt(k + 1) === '*') break;
        k++;
      }
      if (k === i) k = i + 1;   // 保险：不让循环卡住
      tokens.push({ type: 'word', text: src.slice(i, k) });
      i = k;
    }
    return tokens;
  }

  /* ==================================================================
     二、拼回去
     ================================================================== */

  /** 内容是「规则」（里面是选择器）的 at-rule。 */
  var RULE_AT = [
    'media', 'supports', 'document', '-moz-document',
    'layer', 'container', 'scope', 'when', 'else'
  ];
  /** 内容是「声明」的 at-rule。 */
  var DECL_AT = [
    'font-face', 'page', 'viewport', '-ms-viewport', 'counter-style',
    'property', 'font-palette-values', 'font-feature-values'
  ];
  /** keyframes：里面的块是「关键帧块」，块里是声明。 */
  var KEYFRAMES_AT = [
    'keyframes', '-webkit-keyframes', '-moz-keyframes', '-o-keyframes'
  ];

  /**
   * 压缩 CSS。
   *
   * @param {string} src
   * @returns {string}
   */
  function minifyCss(src) {
    if (src === null || src === undefined) return '';
    var text = String(src);
    if (text === '') return '';

    var tokens = tokenize(text);
    var out = [];
    var stack = [];          // 块的上下文栈
    var paren = 0;           // 当前块里圆括号的深度
    var inValue = false;     // 当前是不是在一条声明的值里
    var lastChar = '';       // 上一个吐出去的字符
    var pendingSpace = false;// 前面有一段空白，等着看要不要留
    var lastColonWasProperty = false;
    var atName = '';         // 最近一个 at-rule 的名字
    var atPending = false;   // 刚看见 '@'，下一个 word 就是 at-rule 的名字

    function ctx() {
      return stack.length ? stack[stack.length - 1] : 'top';
    }

    function emit(s) {
      out.push(s);
      lastChar = s.slice(-1);
    }

    /** 去掉最后吐出去的那个字符（用来删块末尾多余的分号）。 */
    function trimLastChar() {
      if (!out.length) return;
      var last = out.pop();
      if (last.length > 1) {
        out.push(last.slice(0, -1));
        lastChar = last.charAt(last.length - 2);
      } else {
        lastChar = out.length ? out[out.length - 1].slice(-1) : '';
      }
    }

    /**
     * 这个 ':' 是不是「属性名 : 值」里的那个分隔符。
     *
     * 只有在**声明块**里、括号外、还没进值的时候才算。
     * 还要看后面：先遇到 '{' 说明这是嵌套规则的**选择器**
     * （`& a :hover { … }` 里那个 ':' 是伪类，那个空格不能动 ——
     *  `a :hover` 是「a 的后代里的 hover」，`a:hover` 是「a 自己」）。
     *
     * @param {number} idx ':' 那个 token 的下标
     * @returns {boolean}
     */
    function colonIsProperty(idx) {
      if (ctx() !== 'declarations') return false;
      if (paren !== 0) return false;
      if (inValue) return false;
      var depth = 0;
      for (var j = idx + 1; j < tokens.length; j++) {
        var tk = tokens[j];
        if (tk.type === 'ws' || tk.type === 'comment') continue;
        if (tk.type !== 'punct') continue;
        if (tk.text === '(') { depth++; continue; }
        if (tk.text === ')') { depth--; continue; }
        if (depth > 0) continue;
        if (tk.text === '{') return false;
        if (tk.text === ';' || tk.text === '}') return true;
      }
      return true;
    }

    /**
     * 前面的空白要不要留一个。
     *
     * @param {string} prevCh 上一个吐出去的字符
     * @param {string} nextCh 马上要吐的字符
     * @param {boolean} nextIsPropertyColon 马上要吐的是不是属性分隔符
     * @returns {boolean}
     */
    function keepSpace(prevCh, nextCh, nextIsPropertyColon) {
      if (prevCh === '') return false;                 // 文档开头不留空白
      // 这些符号两侧的空格一律去掉
      if ('{};,>~)]'.indexOf(nextCh) >= 0) return false;
      if ('{};,>~!('.indexOf(prevCh) >= 0) return false;
      if (nextCh === '!') return false;
      // ':' 两侧：属性分隔符去掉，伪类保留
      if (nextCh === ':') return !nextIsPropertyColon;
      if (prevCh === ':') return !lastColonWasProperty;
      // 其余保留一个空格（`+` / `-` / `(` 前面必须留 —— `calc(1px + 2px)`、
      // `@media screen and (max-width: 100px)` 都靠它）
      return true;
    }

    for (var idx = 0; idx < tokens.length; idx++) {
      var tk = tokens[idx];
      // 注释整个丢掉 —— 除非它没闭合（那样删掉等于把代码变成生效的 CSS）
      if (tk.type === 'comment') {
        if (tk.unterminated) {
          if (pendingSpace) { pendingSpace = false; }
          emit(tk.text);
        }
        continue;
      }
      if (tk.type === 'ws') { pendingSpace = true; continue; }

      var ch = tk.text.charAt(0);
      var isColon = tk.type === 'punct' && ch === ':';
      var colonProp = isColon ? colonIsProperty(idx) : false;

      if (pendingSpace) {
        pendingSpace = false;
        if (keepSpace(lastChar, ch, colonProp)) emit(' ');
      }

      if (tk.type === 'punct') {
        if (ch === '@') {
          atPending = true;
          atName = '';
        } else {
          atPending = false;
        }

        if (ch === '(') {
          paren++;
        } else if (ch === ')') {
          if (paren > 0) paren--;
        } else if (ch === ':') {
          lastColonWasProperty = colonProp;
          if (colonProp) inValue = true;
        } else if (ch === ';') {
          inValue = false;
          atName = '';
          // 连续的分号、空块里的分号都没有意义
          if (lastChar === ';' || lastChar === '{' || lastChar === '') continue;
        } else if (ch === '{') {
          var newCtx;
          if (atName) {
            if (KEYFRAMES_AT.indexOf(atName) >= 0) newCtx = 'keyframes';
            else if (RULE_AT.indexOf(atName) >= 0) newCtx = 'rules';
            else if (DECL_AT.indexOf(atName) >= 0) newCtx = 'declarations';
            else newCtx = 'rules';   // 没见过的 at-rule：保守地当「里面是规则」
          } else {
            newCtx = 'declarations';
          }
          stack.push(newCtx);
          atName = '';
          atPending = false;
          paren = 0;
          inValue = false;
        } else if (ch === '}') {
          if (lastChar === ';') trimLastChar();
          if (stack.length) stack.pop();
          paren = 0;
          inValue = false;
        }
      } else if (tk.type === 'word') {
        if (atPending) {
          atName = tk.text.toLowerCase();
          atPending = false;
        }
      }

      emit(tk.text);
    }

    return out.join('');
  }

  /* ---------- UI ---------- */

  /** 打开页面时先放一份样例，省得对着空白框发呆。 */
  var SAMPLE_CSS = [
    '/* A small sample stylesheet */',
    '.card {',
    '    color : #333 ;',
    '    padding: 8px 16px;',
    '    font-family: "Helvetica Neue", sans-serif;',
    '    background: url(https://example.com/a.png) no-repeat;',
    '}',
    '',
    '@media (max-width: 600px) {',
    '    .card { padding: 4px 8px; }',
    '}',
    '',
    '.box {',
    '    width: calc(100% - 20px);',
    '    margin: 0 auto !important;',
    '}'
  ].join('\n');

  window.ItTools.register('css-minifier', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 14, spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your CSS here...')
    });
    input.value = SAMPLE_CSS;

    var status = D.h('p.form-status');
    var outCard = D.outputCard(t('output', 'Minified CSS'));
    var output = outCard.outputBody;
    // 提示行放在结果上面：先看到「出了什么事」，再看结果
    outCard.insertBefore(status, output);

    /**
     * 写状态行。cls 为空表示普通说明，'is-error' 是出错。
     * @param {string} text
     * @param {string} [cls]
     */
    function setStatus(text, cls) {
      status.textContent = text;
      status.classList.remove('is-error');
      if (cls) status.classList.add(cls);
    }

    /** 压一次。 */
    function render() {
      var src = input.value;
      if (src.trim() === '') {
        output.textContent = '';
        setStatus(t('hint_empty', 'Paste some CSS to minify.'));
        return;
      }
      var minified;
      try {
        minified = minifyCss(src);
      } catch (e) {
        output.textContent = '';
        setStatus(t('err_minify', 'CSS minification failed: {error}')
          .replace('{error}', function () { return e && e.message ? e.message : String(e); }), 'is-error');
        return;
      }
      output.textContent = minified;

      var before = src.length;
      var after = minified.length;
      var percent = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      setStatus(t('status_size', 'Shrunk from {before} to {after} characters ({percent}% smaller).')
        .replace('{before}', function () { return String(before); })
        .replace('{after}', function () { return String(after); })
        .replace('{percent}', function () { return String(percent); }));
    }

    /** 防抖：连续输入时只在停下来之后压一次。 */
    var timer = null;
    function scheduleRender() {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        timer = null;
        render();
      }, 200);
    }

    var minifyBtn = D.h('button.layui-btn', { type: 'button', text: t('minify', 'Minify') });
    var sampleBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: t('sample', 'Load sample'), onclick: function () {
        input.value = SAMPLE_CSS;
        render();
      }
    });
    var clearBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: t('clear', 'Clear'), onclick: function () {
        input.value = '';
        render();
      }
    });

    var offs = [
      D.on(minifyBtn, 'click', render),
      D.on(input, 'input', scheduleRender),
      D.on(sampleBtn, 'click', function () { /* onclick 已经处理 */ }),
      D.on(clearBtn, 'click', function () { /* onclick 已经处理 */ })
    ];

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your CSS to minify'), input, {
        wide: true,
        hint: t('input_hint', 'Comments are removed and whitespace is collapsed. Strings, urls and !important are kept intact.')
      }),
      D.h('div.form-actions', null, minifyBtn, sampleBtn, clearBtn)
    ));

    outCard.appendChild(D.h('div.form-actions', null,
      U.copyButton(function () { return output.textContent; }, t('copy_css', 'Copy CSS')),
      D.h('button.layui-btn.layui-btn-primary', {
        type: 'button', text: t('download_css', 'Download .css'), onclick: function () {
          var text = output.textContent;
          if (!text) return;
          window.ItTools.download('output.css', text, 'text/css;charset=utf-8');
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

  window.ItTools.logic['css-minifier'] = {
    tokenize: tokenize,
    minifyCss: minifyCss,
    __cases: function (assert) {
      /* ---- 空白与注释 ---- */
      assert.eq(minifyCss('  .a   {  }  '), '.a{}', '两头的空白与块里的空白都去掉');
      assert.eq(minifyCss('/* 注释 */ .a { color: red; }'), '.a{color:red}',
        '注释整个去掉（连同它后面的空白）');
      assert.eq(minifyCss('/* 未闭合的注释'), '/* 未闭合的注释',
        '没闭合的注释原样留着（丢掉会让人以为内容没了）');

      /* ---- 属性 ---- */
      assert.eq(minifyCss('.a { color : red ; }'), '.a{color:red}',
        '属性名与值两侧的空格去掉，末尾多余的分号也去掉');
      assert.eq(minifyCss('.a{color:red;}'), '.a{color:red}', '块末尾的分号去掉');
      assert.eq(minifyCss('.a{color:red;;}'), '.a{color:red}', '连续的分号只留一个');
      assert.eq(minifyCss('.a{;}'), '.a{}', '空块里的分号去掉');
      assert.eq(minifyCss('.a { color: red !important; }'), '.a{color:red!important}',
        '!important 前面的空格去掉');
      assert.eq(minifyCss('.a { margin: 0 auto; }'), '.a{margin:0 auto}',
        '值里的空格保留（两个值之间的空格是有意义的）');

      /* ---- 字符串不能动 ---- */
      assert.eq(minifyCss('.a { content: "a  b"; }'), '.a{content:"a  b"}',
        '字符串里的两个空格原样留着（上游那条 \\s+ 正则会吃掉一个）');
      assert.eq(minifyCss(".a { content: 'x  y'; }"), ".a{content:'x  y'}", '单引号字符串同理');
      assert.eq(minifyCss('.a { content: "a\\"b"; }'), '.a{content:"a\\"b"}',
        '字符串里的转义引号原样留着');

      /* ---- url() 里的 // 不能当注释 ---- */
      assert.eq(minifyCss('.a { background: url(http://example.com/a.png); }'),
        '.a{background:url(http://example.com/a.png)}',
        'url() 里的 // 不当注释（上游那条 /* … */ 正则会从这里截断）');

      /* ---- calc() 里的 + 与 - 两侧必须留空格 ---- */
      assert.eq(minifyCss('.a { width: calc(100% - 20px); }'), '.a{width:calc(100% - 20px)}',
        'calc() 里 - 两侧的空格留着（去掉就是语法错误）');
      assert.eq(minifyCss('.a { width: calc( 100px + 2px ); }'), '.a{width:calc(100px + 2px)}',
        'calc() 里 + 两侧的空格留着，括号内侧的空格去掉');

      /* ---- 选择器 ---- */
      assert.eq(minifyCss('.a  >  .b { color: red; }'), '.a>.b{color:red}', '子代选择符两侧的空格去掉');
      assert.eq(minifyCss('.a , .b { color: red; }'), '.a,.b{color:red}', '逗号两侧的空格去掉');
      assert.eq(minifyCss('.a  .b { color: red; }'), '.a .b{color:red}',
        '后代选择器中间的空格留着（去掉就变成另一个意思）');
      assert.eq(minifyCss('.a ~ .b { color: red; }'), '.a~.b{color:red}', '兄弟选择符两侧的空格去掉');
      assert.eq(minifyCss('a:hover { color: red; }'), 'a:hover{color:red}',
        '伪类里的冒号两侧没有空格，本来就不动');
      assert.eq(minifyCss('[type="text"] { color: red; }'), '[type="text"]{color:red}',
        '属性选择器原样');

      /* ---- 嵌套规则里的伪类：那个空格不能动 ---- */
      assert.eq(minifyCss('.p { & a :hover { color: red; } }'), '.p{& a :hover{color:red}}',
        '嵌套选择器里 :hover 前面的空格留着（a :hover 与 a:hover 不是一回事）');

      /* ---- at-rule ---- */
      assert.eq(minifyCss('@media (max-width: 600px) { .a { color: red; } }'),
        '@media (max-width: 600px){.a{color:red}}',
        '媒体查询里的冒号两侧的空格留着 —— 那里是特性名与值的分隔符，'
        + '跟选择器里的伪类长得一样，认错了就把 @supports selector(a :hover) 压坏');
      assert.eq(minifyCss('@media screen and (max-width: 600px) { .a { color: red; } }'),
        '@media screen and (max-width: 600px){.a{color:red}}',
        'and 后面的括号前要留空格（and( 是语法错误）');
      assert.eq(minifyCss('@import url("a.css");'), '@import url("a.css");', '@import 原样');
      assert.eq(minifyCss('@font-face { font-family: "X"; src: url(a.woff); }'),
        '@font-face{font-family:"X";src:url(a.woff)}', '@font-face 里的声明照常压');
      assert.eq(minifyCss('@keyframes spin { from { opacity: 0; } to { opacity: 1; } }'),
        '@keyframes spin{from{opacity:0}to{opacity:1}}', 'keyframes 里的块照常压');

      /* ---- 边界 ---- */
      assert.eq(minifyCss(''), '', '空输入');
      assert.eq(minifyCss(null), '', 'null 输入');
      assert.eq(minifyCss(undefined), '', 'undefined 输入');
      assert.eq(typeof minifyCss('.a{}'), 'string', '结果永远是字符串');
      assert.eq(minifyCss('.a{}'), '.a{}', '空规则保留');

      /* ---- 切词 ---- */
      var tk = tokenize('a{content:"x"}');
      assert(tk.length > 0, '切词有结果');
      assert.eq(tk.filter(function (x) { return x.type === 'string'; }).length, 1,
        '字符串是一个 token');
      assert.eq(tk.filter(function (x) { return x.type === 'comment'; }).length, 0, '没有注释');
    }
  };
})();
