/* ==========================================================================
   Shell 命令单行化（shell-linearizer）

   把多行的 shell 命令压成一行。

   ---- 上游那版是什么 ----
   上游（it-tools2 的 shell-linearizer）直接调用 `collapseBackslashLines`：
   ```ts
   const lines = input.trim().split(/\r?\n/);
   for (const raw of lines) {
     const line = raw.trimEnd();
     if (line.endsWith('\\')) buffer.push(line.slice(0, -1).trim());
     else { ... out.push(buffer.join(' ').trim()); ... }
   }
   return out.join('\n');
   ```

   ---- 差在哪 ----
   1. **上游按行硬切，完全不懂引号** —— `split(/\r?\n/)` 会把引号里的换行
      也当成换行，于是
      ```
      echo "hello
      world"
      ```
      被压成 `echo "hello world"`：**引号里的换行变成了空格，内容被改了**。
      这一版是带引号感知的扫描器：单引号、双引号里的换行**原样保留**
      （引号里本来就可以有换行，删掉就变了意思）。
   2. **上游每接一段就塞一个空格**（`buffer.join(' ')`），
      所以 `foo\<换行>bar` 会被压成 `foo bar` —— **一个词被拆成了两个**。
      这一版去掉续行符时不补空格：`foo\<换行>bar` → `foobar`。
   3. **上游用 `line.endsWith('\\')` 判断续行** —— 以 `\\` 结尾的行
      （比如 `echo "a\\"`）会被当成续行，反斜杠被吃掉。
      这一版是真的按 shell 规则扫：`\` 只转义它后面的那一个字符。
   4. **上游把每行 `trimEnd()` 再 `trim()`** —— 续行符**前面**的空白被丢掉了，
      接下一行时再补一个空格。引号外面的连续空白这一版只折成一个空格
      （shell 里连续的空白本来就是一个分隔符，折了不影响意思）；
      引号里面的空白一个字都不动。
   5. **上游压完还是多行**（`out.join('\n')`）—— 它只合并了带续行符的行，
      两条独立命令之间的换行原样留着，根本不是「单行」。
      这一版把命令之间的换行也处理掉（折成空格，或者换成 `;`）。
   6. **上游不认注释**：`# 注释` 后面接一条命令，压成一行之后
      **整条命令都成了注释**。这一版把注释删掉，并说明删了什么。
   7. **上游不认 heredoc**（`<<EOF`）：正文被折成一行，脚本直接坏掉。
      这一版把 heredoc 的正文**原样保留**（结果因此仍是多行，并会说明）。

   ---- 依赖 ----
   无。纯字符串处理。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('shell-linearizer');

  /** shell 的操作符字符（这些字符后面如果出现 `#`，算注释）。 */
  var OP_CHARS = '<>|&;()';

  /**
   * 把多行命令压成一行。
   *
   * @param {*} src
   * @param {{sep?: string}} [opts] sep: 'space'（默认，命令之间折成空格）| ';'
   * @returns {{text: string, warning: string|null, notes: Array<string>}}
   */
  function linearize(src, opts) {
    opts = opts || {};
    var s = String(src == null ? '' : src);
    var n = s.length;
    var i = 0;
    var out = [];
    var pendingSpace = false;      // 有空白待输出（还没遇到下一个词）
    var pendingHeredoc = [];        // 当前逻辑行里声明的 heredoc 结束标记
    var warning = null;
    var notes = [];                 // 'comment' / 'heredoc'
    var atWordStart = true;         // 是否在词首（决定 `#` 是不是注释）

    /** 直接追加（不处理待输出的空白）。 */
    function push(text) {
      out.push(text);
    }

    /** 追加一个词：先把待输出的空白补上。 */
    function emit(text) {
      if (pendingSpace) {
        if (out.length) push(' ');
        pendingSpace = false;
      }
      push(text);
    }

    /** 单引号串：内容全是字面量，换行原样保留。 */
    function emitSingle() {
      if (pendingSpace) {
        if (out.length) push(' ');
        pendingSpace = false;
      }
      var start = i;
      i++;
      while (i < n && s.charAt(i) !== "'") i++;
      if (i >= n) {
        warning = warning || 'unterminated_single_quote';
        push(s.slice(start, n));
        return;
      }
      i++;
      push(s.slice(start, i));
    }

    /** 双引号串：`\` 转义下一个字符；`$( )` 里的内容另算。 */
    function emitDouble() {
      if (pendingSpace) {
        if (out.length) push(' ');
        pendingSpace = false;
      }
      push('"');
      i++;
      var closed = false;
      while (i < n) {
        var c = s.charAt(i);
        if (c === '\\') {
          if (s.charAt(i + 1) === '\n') { i += 2; continue; }   // 双引号里的续行符去掉
          push(s.slice(i, i + 2));
          i += 2;
          continue;
        }
        if (c === '"') { push('"'); i++; closed = true; break; }
        if (c === '$' && s.charAt(i + 1) === '(') { push('$('); i += 2; emitSubstBody(); continue; }
        push(c);
        i++;
      }
      if (!closed) warning = warning || 'unterminated_double_quote';
    }

    /** 反引号串。 */
    function emitBacktick() {
      if (pendingSpace) {
        if (out.length) push(' ');
        pendingSpace = false;
      }
      push('`');
      i++;
      var closed = false;
      while (i < n) {
        var c = s.charAt(i);
        if (c === '\\') {
          if (s.charAt(i + 1) === '\n') { i += 2; continue; }
          push(s.slice(i, i + 2));
          i += 2;
          continue;
        }
        if (c === '`') { push('`'); i++; closed = true; break; }
        if (c === '$' && s.charAt(i + 1) === '(') { push('$('); i += 2; emitSubstBody(); continue; }
        if (c === '\n' || c === ' ' || c === '\t') { pendingSpace = true; i++; continue; }
        push(c);
        i++;
      }
      if (!closed) warning = warning || 'unterminated_backtick';
    }

    /** `$( ... )` 的内容：括号要配平，里面的引号各自成对。 */
    function emitSubstBody() {
      var depth = 1;
      while (i < n) {
        var c = s.charAt(i);
        if (c === '\\') {
          if (s.charAt(i + 1) === '\n') { i += 2; continue; }
          emit(s.slice(i, i + 2));
          i += 2;
          continue;
        }
        if (c === "'") { emitSingle(); continue; }
        if (c === '"') { emitDouble(); continue; }
        if (c === '`') { emitBacktick(); continue; }
        if (c === '$' && s.charAt(i + 1) === '(') {
          emit('$(');
          i += 2;
          emitSubstBody();
          i++;                 // 吃掉内层那个 ')'
          push(')');
          continue;
        }
        if (c === '(') { depth++; emit(c); i++; continue; }
        if (c === ')') {
          depth--;
          if (depth === 0) return;
          emit(c);
          i++;
          continue;
        }
        if (c === '\n' || c === ' ' || c === '\t') { pendingSpace = true; i++; continue; }
        emit(c);
        i++;
      }
      warning = warning || 'unterminated_substitution';
    }

    /**
     * heredoc 的正文：从当前行开始，一行一行原样复制，直到结束标记那一行。
     * 正文不能折行 —— 折了就坏掉了。
     */
    function copyHeredocBodies() {
      if (notes.indexOf('heredoc') < 0) notes.push('heredoc');
      while (pendingHeredoc.length) {
        var delim = pendingHeredoc.shift();
        var found = false;
        while (i < n) {
          var le = s.indexOf('\n', i);
          if (le < 0) le = n;
          var lineText = s.slice(i, le);
          push(lineText);
          if (le < n) push('\n');
          i = (le < n) ? le + 1 : le;
          // `<<-` 允许结束标记前有制表符
          if (lineText.replace(/^\t+/, '') === delim) { found = true; break; }
        }
        if (!found) {
          warning = warning || 'unterminated_heredoc';
          break;
        }
      }
    }

    while (i < n) {
      var c = s.charAt(i);

      if (c === ' ' || c === '\t') { pendingSpace = true; i++; atWordStart = true; continue; }
      if (c === '\r') { i++; continue; }

      if (c === '\n') {
        if (pendingHeredoc.length) {
          // 逻辑行到此结束：正文从下一行开始，原样保留
          push('\n');
          i++;
          copyHeredocBodies();
          atWordStart = true;
          continue;
        }
        // 命令之间的换行
        if (opts.sep === ';') {
          emit(';');
          pendingSpace = true;
        } else {
          pendingSpace = true;
        }
        i++;
        atWordStart = true;
        continue;
      }

      if (c === '\\') {
        var nx = s.charAt(i + 1);
        if (nx === '\n') { i += 2; continue; }                       // 续行符：直接去掉，不补空格
        if (nx === '\r' && s.charAt(i + 2) === '\n') { i += 3; continue; }
        emit(s.slice(i, i + 2));                                    // 转义：两个字符原样
        i += 2;
        atWordStart = false;
        continue;
      }

      // heredoc 声明：`<<` 后面那个词就是结束标记
      if (c === '<' && s.startsWith('<<', i) && !s.startsWith('<<<', i)) {
        emit('<<');
        i += 2;
        while (i < n && (s.charAt(i) === ' ' || s.charAt(i) === '\t')) { pendingSpace = true; i++; }
        var dStart = i;
        while (i < n && !/[\s]/.test(s.charAt(i)) && OP_CHARS.indexOf(s.charAt(i)) < 0) i++;
        var delim = s.slice(dStart, i).replace(/^['"]/, '').replace(/['"]$/, '');
        if (delim) {
          pendingHeredoc.push(delim);
          push(s.slice(dStart, i));
          atWordStart = false;
        }
        continue;
      }

      if (c === "'") { emitSingle(); atWordStart = false; continue; }
      if (c === '"') { emitDouble(); atWordStart = false; continue; }
      if (c === '`') { emitBacktick(); atWordStart = false; continue; }
      if (c === '$' && s.charAt(i + 1) === '(') {
        emit('$(');
        i += 2;
        emitSubstBody();
        i++;                 // 吃掉 ')'
        push(')');
        atWordStart = false;
        continue;
      }

      if (c === '#' && atWordStart) {
        // 注释：压成一行之后它会把后面的内容一起吃掉，只能删掉
        while (i < n && s.charAt(i) !== '\n') i++;
        if (notes.indexOf('comment') < 0) notes.push('comment');
        atWordStart = true;
        continue;
      }

      emit(c);
      i++;
      atWordStart = (OP_CHARS.indexOf(c) >= 0);
    }

    if (pendingHeredoc.length) warning = warning || 'unterminated_heredoc';

    return { text: out.join(''), warning: warning, notes: notes };
  }

  /* ======================================================================
     UI
     ====================================================================== */

  var DEFAULT_COMMAND = [
    'docker run -p 80:80 -v /var/run/docker.sock:/tmp/docker.sock:ro \\',
    '  --restart always \\',
    '  --log-opt max-size=1g \\',
    '  nginx'
  ].join('\n');

  window.ItTools.register('shell-linearizer', function (root) {
    var sepSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'space', text: t('sep_space', 'A single space') }),
      D.h('option', { value: ';', text: t('sep_semicolon', 'A semicolon (;)') })
    );

    var input = D.h('textarea.layui-textarea', {
      rows: 8,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste a multiline shell command here...')
    });
    input.value = DEFAULT_COMMAND;

    var outCard = D.outputCard(t('output_title', 'Linearized command'));
    var outBody = outCard.outputBody;
    var status = D.h('p.form-status');
    outCard.appendChild(status);

    var NOTES = {
      comment: t('note_comment', 'The comments were removed: on a single line a comment would comment out the rest of the command.'),
      heredoc: t('note_heredoc', 'The heredoc body is kept as it is, so the result still spans several lines.')
    };
    var WARNINGS = {
      unterminated_single_quote: t('warn_single_quote', 'There is an unclosed single quote in the input.'),
      unterminated_double_quote: t('warn_double_quote', 'There is an unclosed double quote in the input.'),
      unterminated_backtick: t('warn_backtick', 'There is an unclosed backquote in the input.'),
      unterminated_substitution: t('warn_substitution', 'There is an unclosed $( ) in the input.'),
      unterminated_heredoc: t('warn_heredoc', 'There is an unclosed heredoc in the input: its ending marker is missing.')
    };

    function render() {
      var res = linearize(input.value, { sep: sepSelect.value });
      outBody.textContent = res.text;
      var messages = [];
      if (res.warning) messages.push(WARNINGS[res.warning] || '');
      for (var k = 0; k < res.notes.length; k++) {
        messages.push(NOTES[res.notes[k]] || '');
      }
      if (messages.length) {
        status.classList.add('is-error');
        status.textContent = messages.join(' ');
      } else {
        status.classList.remove('is-error');
        status.textContent = res.text
          ? t('note_ok', 'The line continuations are gone and the quotes are kept as they are.')
          : '';
      }
    }

    var linearizeBtn = D.h('button.layui-btn', {
      type: 'button',
      text: t('btn_linearize', 'Linearize')
    });

    var offs = [
      D.on(linearizeBtn, 'click', render),
      D.on(input, 'input', render),
      D.on(sepSelect, 'change', render)
    ];

    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('label_sep', 'Between two commands') }),
        sepSelect
      ),
      U.field(t('label_command', 'Shell command'), input, {
        wide: true,
        hint: t('hint_command', 'The backslash line continuations are removed and the whitespace between the lines is folded into a single space. Newlines inside quotes are kept: they are part of the text.')
      }),
      D.h('div.form-actions', null, linearizeBtn)
    ));
    root.appendChild(outCard);

    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  /* ======================================================================
     导出与自测
     ====================================================================== */

  window.ItTools.logic['shell-linearizer'] = {
    DEFAULT_COMMAND: DEFAULT_COMMAND,
    linearize: linearize,
    __cases: function (assert) {
      /* ---- 基本 ---- */
      assert.eq(linearize('ls', {}).text, 'ls', '单行命令原样输出');
      assert.eq(linearize('', {}).text, '', '空输入');
      assert.eq(linearize(null, {}).text, '', 'null 不炸');
      assert.eq(linearize('  ls  ', {}).text, 'ls', '两头的空白去掉');

      /* ---- 续行符 ---- */
      assert.eq(linearize('docker run \\\n  -p 80:80 \\\n  nginx', {}).text,
        'docker run -p 80:80 nginx', '续行符去掉，行间折成一个空格');
      assert.eq(linearize('foo\\\nbar', {}).text, 'foobar', '续行符后面不补空格');
      assert.eq(linearize('foo   \\\nbar', {}).text, 'foo bar', '引号外的连续空白折成一个空格');
      assert.eq(linearize('foo\\\nbar', { sep: ';' }).text, 'foobar', '续行符不是命令分隔');

      /* ---- 折行 ---- */
      assert.eq(linearize('ls\npwd', {}).text, 'ls pwd', '换行折成空格');
      assert.eq(linearize('ls\npwd', { sep: ';' }).text, 'ls; pwd', '换行可以换成 ;');
      assert.eq(linearize('ls   \n   pwd', {}).text, 'ls pwd', '连续空白折成一个空格');

      /* ---- 引号里的换行必须保留（上游那版就是错在这）---- */
      assert.eq(linearize('echo "hello\nworld"', {}).text, 'echo "hello\nworld"',
        '双引号里的换行原样保留');
      assert.eq(linearize("echo 'hello\nworld'", {}).text, "echo 'hello\nworld'",
        '单引号里的换行原样保留');
      assert.eq(linearize('echo "a\\\nb"', {}).text, 'echo "ab"',
        '双引号里的续行符按 POSIX 规则去掉');
      assert.eq(linearize("echo 'a\\\nb'", {}).text, "echo 'a\\\nb'",
        '单引号里的反斜杠是字面量');
      assert.eq(linearize('echo "a $VAR b"', {}).text, 'echo "a $VAR b"', '双引号里的 $VAR 保留');

      /* ---- 命令替换 ---- */
      assert.eq(linearize('echo $(date +%s)', {}).text, 'echo $(date +%s)', '$( ) 保留');
      assert.eq(linearize('echo $(echo $(date))', {}).text, 'echo $(echo $(date))', '嵌套的 $( ) 保留');
      assert.eq(linearize('echo `date`', {}).text, 'echo `date`', '反引号保留');

      /* ---- 注释 ---- */
      assert.eq(linearize('# note\nls', {}).text, 'ls', '注释被删掉');
      assert.eq(linearize('echo a#b', {}).text, 'echo a#b', '词中间的 # 不是注释');
      assert.eq(linearize('# note\nls', {}).notes.indexOf('comment') >= 0, true, '并说明删了注释');
      assert.eq(linearize('cat <<EOF\nbody\nEOF', {}).notes.indexOf('heredoc') >= 0, true,
        '并说明 heredoc 的正文保留着');

      /* ---- heredoc ---- */
      var hd = linearize('cat <<EOF\nbody\nEOF', {});
      assert(hd.text.indexOf('body\nEOF') >= 0, 'heredoc 正文原样保留：' + hd.text);
      assert.eq(linearize('cat <<EOF\nbody', {}).warning, 'unterminated_heredoc',
        '没闭合的 heredoc 有告警');

      /* ---- 告警 ---- */
      assert.eq(linearize("echo 'x", {}).warning, 'unterminated_single_quote', '单引号没闭合');
      assert.eq(linearize('echo "x', {}).warning, 'unterminated_double_quote', '双引号没闭合');
      assert.eq(linearize('echo `x', {}).warning, 'unterminated_backtick', '反引号没闭合');
      assert.eq(linearize('echo $(x', {}).warning, 'unterminated_substitution', '$( ) 没闭合');
      assert.eq(linearize('echo ok', {}).warning, null, '正常输入没有告警');

      /* ---- 往返：单行化 → 格式化 → 单行化（词不能变）---- */
      var one = 'docker run --label "some label" -p 80:80 nginx';
      assert.eq(linearize(one, {}).text, one, '已经是单行的命令不会被改动');
    }
  };
})();
