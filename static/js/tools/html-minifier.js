/* ==========================================================================
   HTML 压缩器（html-minifier）

   把一段 HTML 压成一行：去注释、收空白、去掉多余的引号与空格。

   ---- 为什么自己写 ----
   上游 it-tools 的 html-minifier 用的是 npm 的 `htmlfy`，它的 minify 是
   纯正则的，其中有两条会改坏内容：

     · `html.replace(/\n|\t/g, '')` —— 把**整个文档**里的换行与制表符删掉，
       包括 `<pre>` 里的、`<textarea>` 里的、属性值里的、`<script>` 里的。
       `<pre>line1\nline2</pre>` 会变成 `<pre>line1line2</pre>`。
     · `html.replace(/\s+/g, ' ')` 与几条「保护空格」的正则互相打架 ——
       字符串字面量里的多个空格会被折成一个，`<pre>` 里的缩进也没了。

   所以这里改成**先切词、再拼**：

     · `<script>` / `<style>` / `<textarea>` / `<title>` 的内容按原样搬走
       （它们在 HTML 里不是标签，是「原样文本」）；
     · `<pre>` 里的空白原样保留（那里空白是有意义的）；
     · 标签之间的空白**看两边的标签**决定去留 ——
       两边都是块级元素就删掉，只有一边是行内元素就留一个空格
       （`<span>a</span> <span>b</span>` 那个空格是渲染出来的，
        删了就成了「ab」）。

   ---- 压到什么程度 ----
   · 注释删掉（没闭合的注释留着 —— 删掉等于把一段用户以为还在的代码变成正文）。
   · 标签之间的空白按上面的规则收。
   · 标签内部的空白收成一个空格（`<div  a="1"   b="2">` → `<div a=1 b=2>`）。
   · 属性值上不必要的引号去掉（值里有空白 / 引号 / `=` / `<` / `>` 就留着）。
   · `<br />` → `<br/>`。

   ---- 故意不做的事 ----
   · 不删标签（`<p></p>` 留着）—— 删掉会改语义。
   · 不改标签名的大小写 —— SVG 里 `viewBox`、`linearGradient` 是大小写敏感的。
   · 不动属性值的**内容**（含空白）—— 那是数据，不是格式。
   · 不动 `</pre>` 与 `</textarea>` 里的空白 —— 那里空白有意义。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('html-minifier');

  /** 内容是「原样文本」的标签：里面的内容不是标签，整段照搬。 */
  var RAW_TEXT = { script: 1, style: 1, textarea: 1, title: 1 };

  /** 空白敏感的标签：里面的空白原样留着。 */
  var PRESERVE_WS = { pre: 1, textarea: 1, listing: 1, plaintext: 1 };

  /** 空元素：没有结束标签。 */
  var VOID = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1,
    input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
  };

  /**
   * 块级元素。
   *
   * 标签之间只有空白时，如果有一边是块级元素，那段空白可以不输出 ——
   * 块级元素自己另起一行，浏览器渲染时本来就把那段空白折掉了。
   * 两边都是行内元素（`<span>a</span> <span>b</span>`）时那个空格是
   * **看得见的**，必须留着。
   */
  var BLOCK = {
    address: 1, applet: 1, area: 1, article: 1, aside: 1, audio: 1, base: 1,
    blockquote: 1, body: 1, canvas: 1, caption: 1, center: 1, col: 1,
    colgroup: 1, dd: 1, details: 1, dialog: 1, dir: 1, div: 1, dl: 1, dt: 1,
    embed: 1, fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1,
    frame: 1, frameset: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, head: 1,
    header: 1, hgroup: 1, hr: 1, html: 1, iframe: 1, legend: 1, li: 1,
    listing: 1, main: 1, map: 1, marquee: 1, menu: 1, meta: 1, nav: 1,
    noframes: 1, noscript: 1, object: 1, ol: 1, optgroup: 1, option: 1,
    output: 1, p: 1, param: 1, plaintext: 1, pre: 1, progress: 1, script: 1,
    search: 1, section: 1, source: 1, style: 1, summary: 1, table: 1,
    tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, title: 1, tr: 1, track: 1,
    ul: 1, video: 1, xmp: 1
  };

  /** HTML 里的空白。 */
  function isWs(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  }

  /** 标签名的合法字符。 */
  function isNameChar(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
      || c === '-' || c === '_' || c === ':';
  }

  /** 标签名必须以字母开头。 */
  function isNameStart(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }

  /**
   * 找一个原样文本标签的结束位置。
   *
   * 按 HTML 规范，`</script` 之后只要不是空白 / `>` / `/` 就**不是**这个标签
   * 的结束（`</scripty>` 是另一个标签）。
   *
   * @param {string} src
   * @param {number} from
   * @param {string} name 小写的标签名
   * @returns {number}
   */
  function findRawEnd(src, from, name) {
    var lower = src.toLowerCase();
    var needle = '</' + name;
    var at = from;
    while (true) {
      var idx = lower.indexOf(needle, at);
      if (idx < 0) return src.length;
      var after = src.charAt(idx + needle.length);
      if (after === '' || after === '>' || after === '/' || isWs(after)) return idx;
      at = idx + 1;
    }
  }

  /**
   * 解析一个标签。
   *
   * @param {string} src
   * @param {number} start '<' 的位置
   * @returns {{name: string, closing: boolean, attrs: Array, selfClosing: boolean, end: number}}
   */
  function parseTag(src, start) {
    var i = start + 1;
    var closing = false;
    if (src.charAt(i) === '/') { closing = true; i++; }

    var nameStart = i;
    while (i < src.length && isNameChar(src.charAt(i))) i++;
    var name = src.slice(nameStart, i);

    var attrs = [];
    var selfClosing = false;

    if (!closing) {
      while (i < src.length) {
        while (i < src.length && isWs(src.charAt(i))) i++;
        var c = src.charAt(i);
        if (c === '') break;
        if (c === '>') { i++; break; }
        if (c === '/' && src.charAt(i + 1) === '>') { selfClosing = true; i += 2; break; }

        var aStart = i;
        while (i < src.length) {
          var ch = src.charAt(i);
          if (isWs(ch) || ch === '=' || ch === '>' || ch === '/' || ch === '"' || ch === "'") break;
          i++;
        }
        if (i === aStart) { i++; continue; }   // 保险：跳过非法字符，别把循环卡住
        var aName = src.slice(aStart, i);

        // '=' 前面允许有空格（`class = "x"`），属性值前面也允许
        var j = i;
        while (j < src.length && isWs(src.charAt(j))) j++;
        if (src.charAt(j) === '=') {
          j++;
          while (j < src.length && isWs(src.charAt(j))) j++;
          var q = src.charAt(j);
          if (q === '"' || q === "'") {
            var vEnd = src.indexOf(q, j + 1);
            if (vEnd < 0) vEnd = src.length;
            attrs.push({ name: aName, value: src.slice(j + 1, vEnd), quote: q });
            i = Math.min(vEnd + 1, src.length);
          } else {
            var vStart = j;
            while (j < src.length && !isWs(src.charAt(j)) && src.charAt(j) !== '>') j++;
            attrs.push({ name: aName, value: src.slice(vStart, j), quote: '' });
            i = j;
          }
        } else {
          // 没有值的属性（`disabled`）
          attrs.push({ name: aName, value: null, quote: '' });
          i = j;
        }
      }
    } else {
      while (i < src.length && src.charAt(i) !== '>') i++;
      if (i < src.length) i++;
    }

    return { name: name, closing: closing, attrs: attrs, selfClosing: selfClosing, end: i };
  }

  /**
   * 把 HTML 切成 token。
   *
   * token 有六种：
   *   text     文本
   *   comment  注释
   *   doctype  `<!DOCTYPE …>` 与 `<?…>` 这类「不是标签」的东西
   *   open     开始标签
   *   close    结束标签
   *   raw      原样文本标签（script / style / textarea / title）的内容
   *
   * @param {string} src
   * @returns {Array<object>}
   */
  function tokenizeHtml(src) {
    var tokens = [];
    var i = 0;
    var n = src.length;
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) {
        tokens.push({ type: 'text', text: src.slice(i) });
        break;
      }
      if (lt > i) {
        tokens.push({ type: 'text', text: src.slice(i, lt) });
        i = lt;
      }

      var c1 = src.charAt(i + 1);

      if (c1 === '!') {
        if (src.charAt(i + 2) === '-' && src.charAt(i + 3) === '-') {
          var end = src.indexOf('-->', i + 4);
          if (end < 0) {
            // 没闭合的注释：原样留着。浏览器把它后面全当注释 ——
            // 删掉等于把一段用户以为还被注释掉的代码变成正文。
            tokens.push({ type: 'comment', text: src.slice(i), unterminated: true });
            i = n;
          } else {
            tokens.push({ type: 'comment', text: src.slice(i, end + 3) });
            i = end + 3;
          }
          continue;
        }
        var gt = src.indexOf('>', i);
        if (gt < 0) {
          tokens.push({ type: 'doctype', text: src.slice(i) });
          i = n;
        } else {
          tokens.push({ type: 'doctype', text: src.slice(i, gt + 1) });
          i = gt + 1;
        }
        continue;
      }

      if (c1 === '?') {
        var q = src.indexOf('>', i);
        if (q < 0) {
          tokens.push({ type: 'doctype', text: src.slice(i) });
          i = n;
        } else {
          tokens.push({ type: 'doctype', text: src.slice(i, q + 1) });
          i = q + 1;
        }
        continue;
      }

      if (c1 === '/') {
        if (isNameStart(src.charAt(i + 2))) {
          var close = parseTag(src, i);
          tokens.push({ type: 'close', name: close.name });
          i = close.end;
          continue;
        }
        tokens.push({ type: 'text', text: '<' });
        i++;
        continue;
      }

      if (isNameStart(c1)) {
        var tag = parseTag(src, i);
        tokens.push({
          type: 'open', name: tag.name, attrs: tag.attrs, selfClosing: tag.selfClosing
        });
        i = tag.end;
        var lname = tag.name.toLowerCase();
        if (RAW_TEXT[lname] && !tag.selfClosing) {
          var rawEnd = findRawEnd(src, i, lname);
          tokens.push({ type: 'raw', text: src.slice(i, rawEnd) });
          i = rawEnd;
        }
        continue;
      }

      // '<' 后面不是标签名：它就是文本（`a < b`）
      tokens.push({ type: 'text', text: '<' });
      i++;
    }
    return tokens;
  }

  /**
   * 属性值怎么输出。
   *
   * 不必要的引号去掉 —— 但值里有空白 / 引号 / `=` / `<` / `>` / 反引号时
   * 必须留着（不加引号的属性值按 HTML 规范不允许含这些字符）。
   *
   * 还有一个坑：**值不能以 `/` 结尾**。不加引号的属性值一直读到空白或 `>`
   * 才停，`/` 是合法的一部分 —— `<div class=a/>` 的 class 是 `a/` 而不是 `a`，
   * 那个自闭合的斜杠被值吃掉了。所以以 `/` 结尾的值保留引号。
   *
   * @param {{value: string, quote: string}} a
   * @returns {string}
   */
  function renderAttrValue(a) {
    var v = a.value;
    if (v === '') return '""';
    if (/[\s"'=<>`]/.test(v)) {
      if (v.indexOf('"') < 0) return '"' + v + '"';
      if (v.indexOf("'") < 0) return "'" + v + "'";
      return '"' + v.replace(/"/g, '&quot;') + '"';
    }
    if (v.charAt(v.length - 1) === '/') return '"' + v + '"';
    return v;
  }

  /**
   * 开始标签怎么输出。
   *
   * 自闭合的那个斜杠前面可能要补个空格：HTML 解析器读「不加引号的属性值」时
   * 一直读到空白或 `>` 才停，`/` 是值的一部分 —— `<img src=a.png/>` 会被解析成
   * `src="a.png/"`，斜杠被值吃掉了，标签也不再是自闭合。所以上一个属性值
   * 没加引号时补个空格。
   *
   * @param {{name: string, attrs: Array, selfClosing: boolean}} tok
   * @returns {string}
   */
  function renderOpenTag(tok) {
    var s = '<' + tok.name;
    var lastUnquoted = false;
    for (var i = 0; i < tok.attrs.length; i++) {
      var a = tok.attrs[i];
      s += ' ' + a.name;
      if (a.value !== null) {
        var v = renderAttrValue(a);
        s += '=' + v;
        lastUnquoted = v.charAt(0) !== '"' && v.charAt(0) !== "'";
      } else {
        lastUnquoted = false;   // 没有值的属性后面直接跟 / 是安全的
      }
    }
    if (tok.selfClosing) {
      if (lastUnquoted) s += ' ';
      s += '/';
    }
    return s + '>';
  }

  /**
   * 一段只有空白的文本能不能删掉。
   *
   * @param {Array<object>} list 不含注释的 token 列表
   * @param {number} i 那段空白的位置
   * @returns {boolean}
   */
  function canDropBlank(list, i) {
    var prev = list[i - 1];
    var next = list[i + 1];
    if (!prev || !next) return true;          // 文档开头 / 结尾的空白
    if ((prev.type === 'open' || prev.type === 'close') && BLOCK[prev.name.toLowerCase()]) return true;
    if ((next.type === 'open' || next.type === 'close') && BLOCK[next.name.toLowerCase()]) return true;
    return false;
  }

  /**
   * 压缩 HTML。
   *
   * @param {string} src
   * @returns {string}
   */
  function minifyHtml(src) {
    if (src === null || src === undefined) return '';
    var text = String(src);
    if (text === '') return '';

    var tokens = tokenizeHtml(text);
    // 注释先摘出去 —— 后面找「左右邻居」时它们不算存在
    var list = [];
    for (var k = 0; k < tokens.length; k++) {
      var tk = tokens[k];
      if (tk.type === 'comment') {
        if (tk.unterminated) list.push(tk);   // 没闭合的注释留着
        continue;
      }
      list.push(tk);
    }

    var out = [];
    var preserve = 0;   // <pre> 的层数：里面的空白原样留着

    for (var i = 0; i < list.length; i++) {
      var t = list[i];

      if (t.type === 'comment') { out.push(t.text); continue; }
      if (t.type === 'doctype') { out.push(t.text); continue; }
      if (t.type === 'raw') { out.push(t.text); continue; }

      if (t.type === 'open') {
        out.push(renderOpenTag(t));
        if (PRESERVE_WS[t.name.toLowerCase()]) preserve++;
        continue;
      }

      if (t.type === 'close') {
        out.push('</' + t.name + '>');
        if (PRESERVE_WS[t.name.toLowerCase()] && preserve > 0) preserve--;
        continue;
      }

      // 文本
      if (preserve > 0) { out.push(t.text); continue; }
      if (/^\s*$/.test(t.text)) {
        if (canDropBlank(list, i)) continue;
        out.push(' ');
        continue;
      }
      out.push(t.text.replace(/\s+/g, ' '));
    }

    return out.join('');
  }

  /* ---------- UI ---------- */

  /** 打开页面时先放一份样例，省得对着空白框发呆。 */
  var SAMPLE_HTML = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '    <meta charset="utf-8">',
    '    <title>Sample page</title>',
    '</head>',
    '<body>',
    '    <!-- a comment that goes away -->',
    '    <h1>Hello</h1>',
    '    <p>This is a <strong>sample</strong> document.</p>',
    '    <ul>',
    '        <li>One</li>',
    '        <li>Two</li>',
    '    </ul>',
    '    <pre>  keep    this',
    'spacing</pre>',
    '</body>',
    '</html>'
  ].join('\n');

  window.ItTools.register('html-minifier', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 14, spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your HTML here...')
    });
    input.value = SAMPLE_HTML;

    var status = D.h('p.form-status');
    var outCard = D.outputCard(t('output', 'Minified HTML'));
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
        setStatus(t('hint_empty', 'Paste some HTML to minify.'));
        return;
      }
      var minified;
      try {
        minified = minifyHtml(src);
      } catch (e) {
        output.textContent = '';
        setStatus(t('err_minify', 'HTML minification failed: {error}')
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
        input.value = SAMPLE_HTML;
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
      D.on(input, 'input', scheduleRender)
    ];

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your HTML to minify'), input, {
        wide: true,
        hint: t('input_hint', 'Comments are removed and whitespace is collapsed. The content of script, style, textarea and pre blocks is kept as it is.')
      }),
      D.h('div.form-actions', null, minifyBtn, sampleBtn, clearBtn)
    ));

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

  window.ItTools.logic['html-minifier'] = {
    tokenizeHtml: tokenizeHtml,
    minifyHtml: minifyHtml,
    __cases: function (assert) {
      /* ---- 注释 ---- */
      assert.eq(minifyHtml('<p>a</p><!-- 注释 --><p>b</p>'), '<p>a</p><p>b</p>', '注释删掉');
      assert.eq(minifyHtml('<p>a</p><!-- 未闭合'), '<p>a</p><!-- 未闭合',
        '没闭合的注释留着（删掉等于把注释里的代码变成正文）');

      /* ---- 标签之间的空白：块级 vs 行内 ---- */
      assert.eq(minifyHtml('<div>\n  <p>hello</p>\n</div>'), '<div><p>hello</p></div>',
        '两边都是块级元素时，中间的空白删掉');
      assert.eq(minifyHtml('<span>a</span> <span>b</span>'), '<span>a</span> <span>b</span>',
        '两边都是行内元素时，那个空格是看得见的，必须留着');
      assert.eq(minifyHtml('<p>a</p> <p>b</p>'), '<p>a</p><p>b</p>',
        '块级元素后面的空白删掉');
      assert.eq(minifyHtml('<p>hello   world</p>'), '<p>hello world</p>',
        '文本里的连续空白折成一个');
      assert.eq(minifyHtml('<p>hello <b>world</b></p>'), '<p>hello <b>world</b></p>',
        '文本与标签之间的空格留着（那个空格是渲染出来的）');

      /* ---- 标签内部 ---- */
      assert.eq(minifyHtml('<div  class="a"   id="b"  >'), '<div class=a id=b>',
        '标签内部的空白收成一个空格，多余的引号去掉');
      assert.eq(minifyHtml('<br />'), '<br/>', '自闭合标签里 / 前面的空格去掉');
      assert.eq(minifyHtml('<img src="a.png" alt="a b">'), '<img src=a.png alt="a b">',
        '值里有空格的属性保留引号');
      assert.eq(minifyHtml('<div title="a > b">'), '<div title="a > b">',
        '属性值里的 > 不会被当成标签结束（值是带引号的）');
      assert.eq(minifyHtml('<input disabled>'), '<input disabled>', '没有值的属性原样');
      assert.eq(minifyHtml('<div data-x=\'y\'>'), '<div data-x=y>', '单引号换成双引号');

      /* ---- 属性值与自闭合斜杠的坑 ----
       * 浏览器读「不加引号的属性值」时一直读到空白或 `>` 才停，`/` 是值的一部分。
       * `<img src=a.png/>` 会被解析成 `src="a.png/"`，斜杠被值吃掉，标签也不再自闭合。 */
      assert.eq(minifyHtml('<img src="a.png" />'), '<img src=a.png />',
        '自闭合标签的最后一个属性值没加引号时，斜杠前面留个空格（不然斜杠会被值吃掉）');
      assert.eq(minifyHtml('<icon icon_name="heart" size="22" />'), '<icon icon_name=heart size=22 />',
        '同上');
      assert.eq(minifyHtml('<img src=a.png />'), '<img src=a.png />', '原来就没引号的也一样');
      assert.eq(minifyHtml('<div class=a/>'), '<div class="a/">',
        '值本来就以 / 结尾时保留引号（不加引号的话 / 会被算进值里）');
      assert.eq(minifyHtml('<input disabled />'), '<input disabled/>',
        '没有值的属性后面直接跟 / 是安全的，不用补空格');

      /* ---- 原样文本的内容不能动 ---- */
      assert.eq(minifyHtml('<script>var a = 1;\nvar b = 2;</script>'),
        '<script>var a = 1;\nvar b = 2;</script>', 'script 里的内容原样（换行不能删）');
      assert.eq(minifyHtml('<script>if (a < b) { x(); }</script>'),
        '<script>if (a < b) { x(); }</script>', 'script 里的 < 不是标签');
      assert.eq(minifyHtml('<style>.a { color : red }</style>'),
        '<style>.a { color : red }</style>', 'style 里的内容原样');
      assert.eq(minifyHtml('<textarea>  a  b  </textarea>'),
        '<textarea>  a  b  </textarea>', 'textarea 里的空白原样');
      assert.eq(minifyHtml('<title>  My  Page </title>'), '<title>  My  Page </title>',
        'title 里的内容原样');

      /* ---- pre 里的空白原样 ---- */
      assert.eq(minifyHtml('<pre>  a\n  b</pre>'), '<pre>  a\n  b</pre>', 'pre 里的空白原样');

      /* ---- 标签名的大小写不动 ---- */
      assert.eq(minifyHtml('<svg viewBox="0 0 1 1"><linearGradient/></svg>'),
        '<svg viewBox="0 0 1 1"><linearGradient/></svg>', 'SVG 的标签名与属性名大小写敏感，原样');

      /* ---- DOCTYPE ---- */
      assert.eq(minifyHtml('<!DOCTYPE html>\n<html></html>'), '<!DOCTYPE html><html></html>',
        'DOCTYPE 原样（换行是它后面的空白，删掉）');

      /* ---- 不是标签的 '<' ---- */
      assert.eq(minifyHtml('<p>a < b</p>'), '<p>a < b</p>', "'<' 后面不是字母就不是标签");

      /* ---- 边界 ---- */
      assert.eq(minifyHtml(''), '', '空输入');
      assert.eq(minifyHtml(null), '', 'null 输入');
      assert.eq(minifyHtml(undefined), '', 'undefined 输入');
      assert.eq(typeof minifyHtml('<p>x</p>'), 'string', '结果永远是字符串');

      /* ---- 切词 ---- */
      var list = tokenizeHtml('<p class="a">x</p>');
      assert(list.length >= 3, '切词有结果');
      assert.eq(list.filter(function (t) { return t.type === 'open'; }).length, 1, '一个开始标签');
      assert.eq(list.filter(function (t) { return t.type === 'close'; }).length, 1, '一个结束标签');
    }
  };
})();
