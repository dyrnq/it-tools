/* ==========================================================================
   Shell 命令格式化（shell-formatter）

   把一条 shell 命令拆成多行，每行一个参数（或只按操作符拆），行尾用 `\` 续行。

   ---- 上游那版是什么 ----
   上游（it-tools2 的 shell-formatter）用一个正则分词：
   `command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)`，
   然后按「以 `-` 开头就把下一个词并进来」的规则分组。

   ---- 差在哪（这一版最容易错的地方，全在这儿）----
   1. **上游的正则只认三种东西**：普通词、`"..."`、`'...'`。
      它**不认识操作符**，所以 `|`、`&&`、`;`、`>`、`$(...)` 全都被当成普通词。
      后果是管道和重定向会被并到前一个词后面 ——
      `docker run -d | grep x` 被上游排成
          docker run \
            -d | \
            grep \
            x
      `-d |` 看着像 `-d` 的参数，其实 `|` 是操作符。上游的分组规则
      （「`-` 开头的词把下一个非 `-` 开头的词吃掉」）把管道吃掉了。
   2. **上游逐行处理**（`.split(/\r?\n/).map(...)`）：输入里的换行会把命令
      切成几段分别格式化，段与段之间的关系（管道、&&）就没了。
      这里先做一次真正的词法分析，整条命令作为一个整体排版。
   3. **上游不认 `$(...)`**：`--name $(date)` 会被切成 `--name`、`$(date)`
      两个词 —— 而 `$(date)` 里要是带空格（`$(date +%s)`），会被切成三截，
      拼回去就不是原来那条命令了。这里 `$(...)`（含嵌套括号与引号）整体算一个词。
   4. **上游会把 `--name value` 合并成一行**（它自己的 groupArgs 设计）。
      这里给两种粒度让用户选：**按参数拆**（一个词一行）与
      **只按操作符拆**（`| && ; >` 之类才换行）。
   5. **上游不认 heredoc**（`<<EOF`），正文会被当成普通词拆散 ——
      拆完的脚本已经不是原来那个脚本了。这里 `<<` 的正文原样保留。

   引号的处理是这一版的底线：
   · 单引号里的内容是**字面量**（连 `\` 都不是转义）；
   · 双引号里的 `$VAR`、`$(...)` 原样保留；
   · 引号里的空格**不拆**（这是上游那个正则做对的地方，这里保持）；
   · 输出用的是**原样的源码切片**，所以引号、转义一个字符都不改。

   ---- 依赖 ----
   无。纯字符串处理。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('shell-formatter');

  /* ======================================================================
     词法分析
     ====================================================================== */

  /**
   * 操作符：长的排前面（`<<<` 必须排在 `<<` 前面，`&>>` 排在 `&` 前面）。
   * 不含 `{` `}` —— 它们是 shell 的保留字，只有独立成词时才有特殊含义，
   * 混在词里（`{a,b}`）就当普通字符。
   */
  var OP_CHARS = '<>|&;()';

  /**
   * 在 i 处匹配一个操作符。
   * @param {string} src
   * @param {number} i
   * @returns {{text: string, end: number}|null}
   */
  function matchOperator(src, i) {
    var n = src.length;
    var c = src.charAt(i);

    // 数字 fd 前缀：2>、2>>、2>&1 —— 只有紧挨着 < 或 > 时才算 fd
    if (c >= '0' && c <= '9') {
      var j = i;
      while (j < n && src.charAt(j) >= '0' && src.charAt(j) <= '9') j++;
      if (j < n && (src.charAt(j) === '<' || src.charAt(j) === '>')) {
        var red = matchRedirect(src, j);
        if (red) return { text: src.slice(i, j) + red.text, end: red.end };
      }
      return null;   // 纯数字不是操作符（走词法）
    }

    if (c === '<') {
      if (src.startsWith('<<<', i)) return { text: '<<<', end: i + 3 };
      if (src.startsWith('<<', i)) return { text: '<<', end: i + 2 };
      if (src.startsWith('<&', i)) {
        var k = i + 2;
        while (k < n && src.charAt(k) >= '0' && src.charAt(k) <= '9') k++;
        return { text: src.slice(i, k), end: k };
      }
      if (src.startsWith('<>', i)) return { text: '<>', end: i + 2 };
      return { text: '<', end: i + 1 };
    }

    if (c === '>') {
      if (src.startsWith('>>', i)) return { text: '>>', end: i + 2 };
      if (src.startsWith('>&', i)) {
        var k2 = i + 2;
        while (k2 < n && src.charAt(k2) >= '0' && src.charAt(k2) <= '9') k2++;
        return { text: src.slice(i, k2), end: k2 };
      }
      return { text: '>', end: i + 1 };
    }

    if (c === '&') {
      if (src.startsWith('&&', i)) return { text: '&&', end: i + 2 };
      if (src.startsWith('&>>', i)) return { text: '&>>', end: i + 3 };
      if (src.startsWith('&>', i)) return { text: '&>', end: i + 2 };
      return { text: '&', end: i + 1 };
    }

    if (c === '|') {
      if (src.startsWith('||', i)) return { text: '||', end: i + 2 };
      if (src.startsWith('|&', i)) return { text: '|&', end: i + 2 };
      return { text: '|', end: i + 1 };
    }

    if (c === ';') {
      if (src.startsWith(';;', i)) return { text: ';;', end: i + 2 };
      return { text: ';', end: i + 1 };
    }

    if (c === '(' || c === ')') return { text: c, end: i + 1 };

    return null;
  }

  /**
   * 匹配重定向操作符（位置在 `<` 或 `>` 上）。
   * @param {string} src
   * @param {number} i
   * @returns {{text: string, end: number}|null}
   */
  function matchRedirect(src, i) {
    var n = src.length;
    var c = src.charAt(i);
    if (c === '<') {
      if (src.startsWith('<<<', i)) return { text: '<<<', end: i + 3 };
      if (src.startsWith('<<', i)) return { text: '<<', end: i + 2 };
      if (src.startsWith('<&', i)) {
        var k = i + 2;
        while (k < n && src.charAt(k) >= '0' && src.charAt(k) <= '9') k++;
        return { text: src.slice(i, k), end: k };
      }
      if (src.startsWith('<>', i)) return { text: '<>', end: i + 2 };
      return { text: '<', end: i + 1 };
    }
    if (c === '>') {
      if (src.startsWith('>>', i)) return { text: '>>', end: i + 2 };
      if (src.startsWith('>&', i)) {
        var k2 = i + 2;
        while (k2 < n && src.charAt(k2) >= '0' && src.charAt(k2) <= '9') k2++;
        return { text: src.slice(i, k2), end: k2 };
      }
      return { text: '>', end: i + 1 };
    }
    return null;
  }

  /**
   * 扫描器状态：源码 + 告警。
   * @param {*} src
   * @returns {{src: string, n: number, warning: string|null}}
   */
  function scanner(src) {
    var s = String(src == null ? '' : src);
    return { src: s, n: s.length, warning: null };
  }

  /** 记一条告警（只记第一条）。 */
  function warn(st, code) {
    if (!st.warning) st.warning = code;
  }

  /** 跳过单引号串（内容全是字面量，反斜杠也不是转义）。 */
  function skipSingle(st, p) {
    var src = st.src;
    var n = st.n;
    p++;
    while (p < n && src.charAt(p) !== "'") p++;
    if (p >= n) { warn(st, 'unterminated_single_quote'); return n; }
    return p + 1;
  }

  /** 跳过双引号串（`\` 转义下一个字符，`$(` 里的括号要配平）。 */
  function skipDouble(st, p) {
    var src = st.src;
    var n = st.n;
    p++;
    while (p < n) {
      var c = src.charAt(p);
      if (c === '\\') { p += 2; continue; }
      if (c === '"') return p + 1;
      if (c === '$' && src.charAt(p + 1) === '(') { p = skipSubst(st, p); continue; }
      p++;
    }
    warn(st, 'unterminated_double_quote');
    return n;
  }

  /** 跳过反引号串。 */
  function skipBacktick(st, p) {
    var src = st.src;
    var n = st.n;
    p++;
    while (p < n) {
      var c = src.charAt(p);
      if (c === '\\') { p += 2; continue; }
      if (c === '`') return p + 1;
      p++;
    }
    warn(st, 'unterminated_backtick');
    return n;
  }

  /** 跳过 `$(...)`（括号要配平，里面的引号各自成对）。 */
  function skipSubst(st, p) {
    var src = st.src;
    var n = st.n;
    var depth = 0;
    p += 1;   // 指向 '('
    while (p < n) {
      var c = src.charAt(p);
      if (c === '\\') { p += 2; continue; }
      if (c === "'") { p = skipSingle(st, p); continue; }
      if (c === '"') { p = skipDouble(st, p); continue; }
      if (c === '`') { p = skipBacktick(st, p); continue; }
      if (c === '$' && src.charAt(p + 1) === '(') { p = skipSubst(st, p); continue; }
      if (c === '(') { depth++; p++; continue; }
      if (c === ')') {
        depth--;
        p++;
        if (depth === 0) return p;
        continue;
      }
      p++;
    }
    warn(st, 'unterminated_substitution');
    return n;
  }

  /**
   * 从 p 开始扫一个词，碰到空白或操作符为止。
   * 词里的 `\`+换行会把词断开（后半截用 glue 标记接回去）。
   * @param {Object} st
   * @param {number} p
   * @returns {number} 词的结束位置
   */
  function scanWord(st, p) {
    var src = st.src;
    var n = st.n;
    while (p < n) {
      var c = src.charAt(p);
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') break;
      if (c === '\\') {
        // 行尾续行符：词在这里断开（后半截不能跟空格）
        if (src.charAt(p + 1) === '\n') { p += 2; break; }
        p += 2;
        continue;
      }
      if (c === "'") { p = skipSingle(st, p); continue; }
      if (c === '"') { p = skipDouble(st, p); continue; }
      if (c === '`') { p = skipBacktick(st, p); continue; }
      if (c === '$' && src.charAt(p + 1) === '(') { p = skipSubst(st, p); continue; }
      if (OP_CHARS.indexOf(c) >= 0) break;
      p++;
    }
    return p;
  }

  /** 去掉词外面的引号（heredoc 的结束标记可以是带引号的）。 */
  function bare(text) {
    var s = String(text);
    if (s.length >= 2 && (s.charAt(0) === "'" || s.charAt(0) === '"') &&
        s.charAt(s.length - 1) === s.charAt(0)) {
      return s.slice(1, -1);
    }
    return s;
  }

  /** 每行的起始偏移。 */
  function lineStartsOf(src) {
    var starts = [0];
    for (var i = 0; i < src.length; i++) {
      if (src.charAt(i) === '\n') starts.push(i + 1);
    }
    return starts;
  }

  /** 偏移量落在第几行（行号从 0 开始）。 */
  function lineIndexOf(starts, offset) {
    var lo = 0;
    var hi = starts.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * 找出 heredoc 的正文区间。
   *
   * heredoc 的正文**必须整段原样保留** —— 拆行的时候动它一下，
   * 脚本就不是原来那个脚本了（上游那版把正文当普通词拆散了）。
   *
   * @param {Object} st
   * @param {Array<number>} starts
   * @returns {{regions: Array, delimStarts: Object}}
   */
  function findHeredocs(st, starts) {
    var src = st.src;
    var n = st.n;
    var decls = [];
    var i = 0;

    while (i < n) {
      var c = src.charAt(i);
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '\\') { i += 2; continue; }
      if (c === "'") { i = skipSingle(st, i); continue; }
      if (c === '"') { i = skipDouble(st, i); continue; }
      if (c === '`') { i = skipBacktick(st, i); continue; }
      if (c === '$' && src.charAt(i + 1) === '(') { i = skipSubst(st, i); continue; }
      if (c === '#') { while (i < n && src.charAt(i) !== '\n') i++; continue; }

      if (c === '<' && src.startsWith('<<', i) && !src.startsWith('<<<', i)) {
        var j = i + 2;
        if (src.charAt(j) === '-') j++;          // `<<-` 允许结束标记前有制表符
        while (j < n && (src.charAt(j) === ' ' || src.charAt(j) === '\t' || src.charAt(j) === '\r')) j++;
        if (src.charAt(j) === '\n') {            // 结束标记可以写在下一行
          j++;
          while (j < n && (src.charAt(j) === ' ' || src.charAt(j) === '\t' || src.charAt(j) === '\r')) j++;
        }
        var dEnd = scanWord(st, j);
        if (dEnd > j && src.charAt(j) !== '#') {
          var delim = bare(src.slice(j, dEnd));
          if (delim) {
            decls.push({ delim: delim, line: lineIndexOf(starts, j), start: j, end: dEnd });
            i = dEnd;
            continue;
          }
        }
        i += 2;
        continue;
      }

      var wEnd = scanWord(st, i);
      i = (wEnd > i) ? wEnd : i + 1;
    }

    // 按声明所在的行分组：同一行声明的多个 heredoc，正文按顺序跟在后面
    var regions = [];
    var delimStarts = {};
    var idx = 0;
    while (idx < decls.length) {
      var line = decls[idx].line;
      var group = [];
      while (idx < decls.length && decls[idx].line === line) {
        group.push(decls[idx]);
        idx++;
      }
      var bodyStart = (line + 1 < starts.length) ? starts[line + 1] : n;
      for (var g = 0; g < group.length; g++) {
        var textEnd = -1;
        for (var li = lineIndexOf(starts, bodyStart); li < starts.length; li++) {
          var ls = starts[li];
          if (ls < bodyStart) continue;
          var le = src.indexOf('\n', ls);
          if (le < 0) le = n;
          if (src.slice(ls, le).replace(/^\t+/, '') === group[g].delim) {
            textEnd = le;
            break;
          }
        }
        if (textEnd < 0) {
          warn(st, 'unterminated_heredoc');
          break;
        }
        regions.push({ start: bodyStart, textEnd: textEnd, end: Math.min(textEnd + 1, n) });
        delimStarts[group[g].start] = true;
        bodyStart = textEnd + 1;
      }
    }
    return { regions: regions, delimStarts: delimStarts };
  }

  /**
   * 词法分析：把一段 shell 源码切成 token。
   *
   * 每个 item：
   *   { kind: 'word',    text, start, end }
   *       一个词。text 是**原样的源码切片** —— 引号、转义、`$(...)` 一个字符不改。
   *   { kind: 'op',      text, start, end }
   *       一个操作符（`|` `&&` `;` `>` `2>&1` …）。
   *   { kind: 'sep',     text, start, end }
   *       一个**真正的换行**。它不是空白，是命令分隔符。
   *   { kind: 'comment', text, start, end }
   *       一行注释（`#` 到行尾）。
   *   { kind: 'body',    text, start, end }
   *       heredoc 的正文，原样保留。
   *
   * @param {*} src
   * @returns {{items: Array, warning: string|null}}
   */
  function tokenize(src) {
    var st = scanner(src);
    var n = st.n;
    var i = 0;
    var items = [];
    var starts = lineStartsOf(st.src);
    var hd = findHeredocs(st, starts);
    var regionIdx = 0;
    var wordStart = true;   // 是否处在「词首」位置（决定 `#` 是不是注释）

    while (i < n) {
      // heredoc 正文：整段跳过，原样保留
      if (regionIdx < hd.regions.length && i >= hd.regions[regionIdx].start) {
        var rg = hd.regions[regionIdx];
        items.push({
          kind: 'body',
          text: st.src.slice(rg.start, rg.textEnd),
          start: rg.start,
          end: rg.textEnd
        });
        i = rg.end;
        regionIdx++;
        wordStart = true;
        continue;
      }

      var c = st.src.charAt(i);

      if (c === ' ' || c === '\t' || c === '\r') { i++; wordStart = true; continue; }

      if (c === '\n') {
        items.push({ kind: 'sep', text: '\n', start: i, end: i + 1 });
        i++;
        wordStart = true;
        continue;
      }

      // 续行符：反斜杠 + 换行（行尾的空白已经在上面被吃掉了）
      if (c === '\\' && st.src.charAt(i + 1) === '\n') {
        i += 2;
        wordStart = true;
        continue;
      }

      if (c === '#' && wordStart) {
        var cEnd = i;
        while (cEnd < n && st.src.charAt(cEnd) !== '\n') cEnd++;
        items.push({ kind: 'comment', text: st.src.slice(i, cEnd), start: i, end: cEnd });
        i = cEnd;
        wordStart = true;
        continue;
      }

      var op = matchOperator(st.src, i);
      if (op) {
        items.push({ kind: 'op', text: op.text, start: i, end: op.end });
        i = op.end;
        wordStart = true;
        continue;
      }

      var wEnd = scanWord(st, i);
      if (wEnd <= i) { i++; continue; }   // 安全阀：不该走到这
      var text = st.src.slice(i, wEnd);
      // 词里含续行符 → 拆成两段，后一段用 glue 接回去（中间不能有空格）
      var brk = text.indexOf('\\\n');
      if (brk >= 0) {
        var head = text.slice(0, brk + 1);
        var tail = text.slice(brk + 2);
        items.push({ kind: 'word', text: head, start: i, end: i + head.length, hardEnd: true });
        if (tail) {
          items.push({ kind: 'word', text: tail, start: i + brk + 2, end: wEnd, glue: true });
        }
      } else {
        items.push({
          kind: 'word', text: text, start: i, end: wEnd, heredoc: !!hd.delimStarts[i]
        });
      }
      i = wEnd;
      wordStart = false;
    }

    return { items: items, warning: st.warning };
  }

  /* ======================================================================
     排版
     ====================================================================== */

  /**
   * 把 token 排成物理行。
   *
   * @param {Array} items
   * @param {{mode: string, indent: number}} opts mode: 'args' | 'operators'
   * @returns {Array<{text: string, cont: boolean}>} cont = 行尾要不要加 `\`
   */
  function layout(items, opts) {
    var byArg = (opts.mode || 'args') !== 'operators';
    var indent = new Array((opts.indent || 2) + 1).join(' ');
    var lines = [];
    var cur = [];
    var lineIndent = false;   // 当前行要不要缩进
    var glueNext = false;     // 下一个片段与当前片段之间不留空格

    function flush(cont) {
      if (!cur.length) return;
      var text = cur.join('');
      if (lineIndent) text = indent + text;
      lines.push({ text: text, cont: cont });
      cur = [];
      lineIndent = true;
      glueNext = false;
    }

    function push(text) {
      if (cur.length && !glueNext) cur.push(' ');
      cur.push(text);
      glueNext = false;
    }

    /** 结束当前命令（`;` `&` 或真换行）—— 下一行是新命令，不缩进、不续行。 */
    function endCommand() {
      flush(false);
      lineIndent = false;
    }

    for (var i = 0; i < items.length; i++) {
      var it = items[i];

      if (it.kind === 'word') {
        if (byArg) {
          flush(true);
          if (it.glue) { lineIndent = false; glueNext = true; }
          push(it.text);
        } else {
          if (it.glue) { lineIndent = false; glueNext = true; }
          push(it.text);
        }
        if (it.hardEnd) { flush(false); lineIndent = false; }
        else if (it.heredoc) { flush(false); lineIndent = false; }
        continue;
      }

      if (it.kind === 'op') {
        if (it.text === ';' || it.text === ';;' || it.text === '&') {
          // 结尾符：接在当前行末尾，这一行就此结束
          cur.push(it.text);
          endCommand();
        } else {
          // 管道、&&、重定向：另起一行
          flush(true);
          push(it.text);
        }
        continue;
      }

      if (it.kind === 'sep') {
        endCommand();
        continue;
      }

      if (it.kind === 'comment') {
        // 注释必须独占一行的末尾：前面有内容就先收尾（带续行符）
        if (cur.length) flush(true);
        push(it.text);
        endCommand();
        continue;
      }

      if (it.kind === 'body') {
        // heredoc 正文：原样输出，不缩进、不续行
        flush(false);
        lines.push({ text: it.text, cont: false });
        lineIndent = false;
        continue;
      }
    }
    flush(false);
    return lines;
  }

  /**
   * 把一条命令排成多行。
   *
   * @param {*} src
   * @param {{mode?: string, indent?: number}} [opts]
   * @returns {{text: string, warning: string|null}}
   */
  function formatShell(src, opts) {
    opts = opts || {};
    var res = tokenize(String(src == null ? '' : src));
    var lines = layout(res.items, opts);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      out.push(lines[i].text + (lines[i].cont ? ' \\' : ''));
    }
    return { text: out.join('\n'), warning: res.warning };
  }

  /* ======================================================================
     UI
     ====================================================================== */

  var DEFAULT_COMMAND =
    'docker run -p 80:80 -v /var/run/docker.sock:/tmp/docker.sock:ro --restart always --log-opt max-size=1g nginx';

  window.ItTools.register('shell-formatter', function (root) {
    var modeSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'args', text: t('mode_args', 'One argument per line') }),
      D.h('option', { value: 'operators', text: t('mode_operators', 'Split on operators only') })
    );
    var indentSelect = D.h('select.layui-select', null,
      D.h('option', { value: '2', text: t('indent_2', '2 spaces') }),
      D.h('option', { value: '4', text: t('indent_4', '4 spaces') })
    );

    var input = D.h('textarea.layui-textarea', {
      rows: 8,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste a shell command here...')
    });
    input.value = DEFAULT_COMMAND;

    var outCard = D.outputCard(t('output_title', 'Formatted command'));
    var outBody = outCard.outputBody;
    var status = D.h('p.form-status');
    outCard.appendChild(status);

    var WARNINGS = {
      unterminated_single_quote: t('warn_single_quote', 'There is an unclosed single quote in the input.'),
      unterminated_double_quote: t('warn_double_quote', 'There is an unclosed double quote in the input.'),
      unterminated_backtick: t('warn_backtick', 'There is an unclosed backquote in the input.'),
      unterminated_substitution: t('warn_substitution', 'There is an unclosed $( ) in the input.'),
      unterminated_heredoc: t('warn_heredoc', 'There is an unclosed heredoc in the input: its ending marker is missing.')
    };

    function render() {
      var res = formatShell(input.value, {
        mode: modeSelect.value,
        indent: Number(indentSelect.value)
      });
      outBody.textContent = res.text;
      if (res.warning) {
        status.classList.add('is-error');
        status.textContent = WARNINGS[res.warning] || '';
      } else {
        status.classList.remove('is-error');
        status.textContent = res.text
          ? t('note_ok', 'The quotes and the operators are kept as they are: the result runs the same command.')
          : '';
      }
    }

    var formatBtn = D.h('button.layui-btn', {
      type: 'button',
      text: t('btn_format', 'Format')
    });

    var offs = [
      D.on(formatBtn, 'click', render),
      D.on(input, 'input', render),
      D.on(modeSelect, 'change', render),
      D.on(indentSelect, 'change', render)
    ];

    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('label_mode', 'Splitting') }),
        modeSelect
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('label_indent', 'Indentation') }),
        indentSelect
      ),
      U.field(t('label_command', 'Shell command'), input, {
        wide: true,
        hint: t('hint_command', 'Quotes, pipes, redirections and $( ) are understood: the result is the same command, only laid out over several lines.')
      }),
      D.h('div.form-actions', null, formatBtn)
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

  window.ItTools.logic['shell-formatter'] = {
    DEFAULT_COMMAND: DEFAULT_COMMAND,
    tokenize: tokenize,
    layout: layout,
    formatShell: formatShell,
    __cases: function (assert) {
      /* ---- 词法分析：词 ---- */
      var tk = tokenize('docker run -p 80:80');
      assert.eq(tk.items.length, 4, '四个词');
      assert.eq(tk.items[0].text, 'docker', '第一个词');
      assert.eq(tk.items[3].text, '80:80', '带冒号的词');

      tk = tokenize('echo "a b" \'c d\'');
      assert.eq(tk.items.length, 3, '引号里的空格不拆词');
      assert.eq(tk.items[1].text, '"a b"', '双引号原样保留');
      assert.eq(tk.items[2].text, "'c d'", '单引号原样保留');

      tk = tokenize('echo $VAR "pre $VAR post"');
      assert.eq(tk.items[2].text, '"pre $VAR post"', '双引号里的 $VAR 保留');

      tk = tokenize('echo $(date +%s)');
      assert.eq(tk.items.length, 2, '$( ) 整体算一个词');
      assert.eq(tk.items[1].text, '$(date +%s)', '$( ) 里的空格不拆');

      tk = tokenize('echo $(echo $(date))');
      assert.eq(tk.items[1].text, '$(echo $(date))', '嵌套的 $( ) 配平');

      /* ---- 词法分析：操作符 ---- */
      tk = tokenize('a | b');
      assert.eq(tk.items.map(function (x) { return x.text; }).join(' '), 'a | b', '管道是操作符');
      tk = tokenize('a && b || c ; d');
      assert.eq(tk.items.map(function (x) { return x.text; }).join(' '), 'a && b || c ; d', '逻辑连接符');
      tk = tokenize('cmd > out 2>&1 >> log');
      assert.eq(tk.items.map(function (x) { return x.text; }).join(' '),
        'cmd > out 2>&1 >> log', '重定向与 fd');
      tk = tokenize('cmd 2>err');
      assert.eq(tk.items[1].text, '2>', 'fd 前缀跟着重定向符');

      /* ---- 词法分析：注释与换行 ---- */
      tk = tokenize('# comment\nls');
      assert.eq(tk.items[0].kind, 'comment', '行首的 # 是注释');
      assert.eq(tk.items[1].kind, 'sep', '换行是命令分隔符');
      tk = tokenize('echo a#b');
      assert.eq(tk.items.filter(function (x) { return x.kind === 'comment'; }).length, 0,
        '词中间的 # 不是注释');
      assert.eq(formatShell('echo x # note', { mode: 'args' }).text,
        'echo \\\n  x \\\n  # note', '注释在行尾，不能带续行符');

      /* ---- 词法分析：告警 ---- */
      assert.eq(tokenize("echo 'x").warning, 'unterminated_single_quote', '单引号没闭合');
      assert.eq(tokenize('echo "x').warning, 'unterminated_double_quote', '双引号没闭合');
      assert.eq(tokenize('echo `x').warning, 'unterminated_backtick', '反引号没闭合');
      assert.eq(tokenize('echo $(x').warning, 'unterminated_substitution', '$( ) 没闭合');
      assert.eq(tokenize('echo ok').warning, null, '正常输入没有告警');

      /* ---- 排版：按参数拆 ---- */
      assert.eq(formatShell('docker run -p 80:80 nginx', { mode: 'args' }).text,
        'docker \\\n  run \\\n  -p \\\n  80:80 \\\n  nginx', '一个词一行');
      assert.eq(formatShell('echo hello', { mode: 'args' }).text, 'echo \\\n  hello', '命令也占一行');
      assert.eq(formatShell('echo hello', { mode: 'args', indent: 4 }).text,
        'echo \\\n    hello', '缩进宽度可调');
      assert.eq(formatShell('', { mode: 'args' }).text, '', '空输入');
      assert.eq(formatShell(null, { mode: 'args' }).text, '', 'null 不炸');

      /* ---- 排版：只按操作符拆 ---- */
      assert.eq(formatShell('docker run -p 80:80 nginx', { mode: 'operators' }).text,
        'docker run -p 80:80 nginx', '没有操作符就一行');
      assert.eq(formatShell('a | b', { mode: 'operators' }).text,
        'a \\\n  | b', '管道另起一行');
      assert.eq(formatShell('a && b', { mode: 'operators' }).text,
        'a \\\n  && b', '&& 另起一行');
      assert.eq(formatShell('cmd > out.txt', { mode: 'operators' }).text,
        'cmd \\\n  > out.txt', '重定向的目标跟着重定向符');

      /* ---- 排版：引号里的空格不拆（上游那版就是错在这）---- */
      assert.eq(formatShell('docker run --label "some label with spaces" myimage', { mode: 'args' }).text,
        'docker \\\n  run \\\n  --label \\\n  "some label with spaces" \\\n  myimage',
        '双引号里的空格原样保留');
      assert.eq(formatShell("echo 'a  b'", { mode: 'args' }).text,
        "echo \\\n  'a  b'", '单引号里的空格原样保留');

      /* ---- 排版：$( ) 单独成行 ---- */
      assert.eq(formatShell('echo $(date) x', { mode: 'args' }).text,
        'echo \\\n  $(date) \\\n  x', '$( ) 自己一行');

      /* ---- 排版：命令分隔符不吞掉 ---- */
      assert.eq(formatShell('ls\npwd', { mode: 'args' }).text,
        'ls\npwd', '两条命令各一行，不加续行符');
      assert.eq(formatShell('ls; pwd', { mode: 'args' }).text,
        'ls;\npwd', '分号保留在行尾');

      /* ---- 排版：续行符（上游那版会把引号里的换行吃掉）---- */
      assert.eq(formatShell('docker run \\\n  -p 80:80 \\\n  nginx', { mode: 'args' }).text,
        'docker \\\n  run \\\n  -p \\\n  80:80 \\\n  nginx', '输入里的续行符被规范化');
      assert.eq(formatShell('foo\\\nbar', { mode: 'args' }).text,
        'foo\\\nbar', '词中间的续行符不把一个词拆成两个');

      /* ---- 排版：heredoc 的正文原样保留 ---- */
      var hd = formatShell('cat <<EOF\nline one\nEOF', { mode: 'args' });
      assert(hd.text.indexOf('line one') >= 0, 'heredoc 正文还在：' + hd.text);
      assert(hd.text.indexOf('EOF') >= 0, 'heredoc 的结束标记还在：' + hd.text);
      assert.eq(hd.text.split('line one').length - 1, 1, 'heredoc 正文只出现一次');
      assert.eq(formatShell('cat <<EOF\nEOF', { mode: 'args' }).text.indexOf('EOF\nEOF') >= 0, true,
        '空正文的 heredoc 也要留下结束标记');
      assert.eq(tokenize('cat <<EOF\nbody\nEOF').items.filter(function (x) {
        return x.kind === 'body';
      }).length, 1, 'heredoc 正文是一个整体，不拆成词');
      assert.eq(tokenize('cat <<EOF\nbody\nEOF').warning, null, '闭合的 heredoc 没有告警');
      assert.eq(tokenize('cat <<EOF\nbody').warning, 'unterminated_heredoc', '没闭合的 heredoc 有告警');

      /* ---- 往返：格式化 → 单行化（这里只验证「词没变」）---- */
      var one = 'docker run --label "some label" -p 80:80 nginx';
      var back = formatShell(one, { mode: 'args' }).text.replace(/ \\\n\s*/g, ' ');
      assert.eq(back, one, '拆开再拼回去是同一条命令');

      /* ---- 出错不抛 ---- */
      var res = formatShell("echo 'unclosed", { mode: 'args' });
      assert(typeof res.text === 'string', '引号没闭合也给出结果，不抛异常');
      assert(res.warning === 'unterminated_single_quote', '并说明哪里不对');
    }
  };
})();
