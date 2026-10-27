/* ==========================================================================
   堆栈追踪格式化（stacktrace-formatter）

   把一段堆栈（V8 / Firefox / Java / Python / .NET）解析成帧，再输出成
   表格 / 缩进对齐的纯文本 / 带颜色高亮的 HTML。

   ---- 与上游 PR #1307 的差别（上游是 it-tools 的 stacktrace-prettier）----
   上游靠四个第三方库解析（jsstack / javastack / netstack / pythonstack），
   那些库本身有正则边界问题（见下），而且只认「一种语言一种写法」，
   靠一个单选框切换，**默认选的是 .NET** —— 于是贴一段 JS 堆栈进去，
   上游会拿 .NET 的解析器去啃它，结果是一片原样输出。这里改成自己写解析器、
   自动识别格式、识别不了就按最通用的 V8 格式试。

   ---- 为什么不做 PNG 导出 ----
   上游的「Download as PNG」用的是 dom-to-image-more：把 DOM 塞进 SVG 的
   foreignObject 再画到 canvas 上。这条路有三个硬伤：
     1) foreignObject 在 Safari 上渲染是空白的（各浏览器实现不一致）；
     2) canvas 一旦被画布上的外部资源污染就会变成 tainted，toDataURL 直接抛错；
     3) 出来的只是一张**文字的截图**，贴到 issue 里既不能搜索也不能复制 ——
        而堆栈最常见的用途恰恰是贴进 issue 让别人搜到某个函数名。
   所以这里把「拿一张图」换成三份**还能再加工**的文本：表格（给人看）、
   纯文本（给终端和日志）、HTML（贴到 issue / 聊天里，函数名还能被搜到）。

   ---- 为什么解析不出来的行要留着 ----
   堆栈里除了帧还有别的行：错误消息（`Error: boom`）、Python 的
   `Traceback (most recent call last):` 与最后的异常行、Java 的
   `Caused by: ...`、.NET 的 `--- End of stack trace ---`。
   这些行**不是帧，但也不是噪音** —— 异常消息往往才是排查的起点。
   所以每一行都进结果：解析不出来的标成「无法解析」，原文照留。
   悄悄裁掉的栈比没有栈更坑人。

   ---- 顺序不排序 ----
   帧的顺序就是原文的顺序。上游那套库是照原序的，但很容易被「顺手排一下」
   的冲动改掉 —— 一排序，「谁调用了谁」这条最关键的信息就没了。
   ========================================================================== */

(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('stacktrace-formatter');

  /* ---------- 逐格式的解析器 ----------

     每种格式一个正则 + 一个函数。函数返回 null 表示「这行不是这种格式」，
     交给下一个格式试 —— 一次只认一种格式的话，混着两种写法的栈就废了。 */

  /**
   * 把「文件名:行:列」拆开。
   *
   * 三个数字都是**可选**的，而且这里必须用「懒惰 + 结尾锚定」的写法：
   * 文件名里本来就可能有冒号（`node:internal/modules/cjs/loader`、
   * `http://example.com:8080/app.js`），只有「最后一个 :数字」才是行号。
   * 用贪婪的写法会在 `node:internal/...:1105:14` 上把 `node` 当成文件名、
   * 把 `internal` 当成行号 —— 上游的 jsstack 就是这么把 Node 内部帧解错的。
   */
  function splitLocation(loc) {
    var m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(loc);
    if (!m) return { file: loc, line: null, column: null };
    return {
      file: m[1] === '' ? null : m[1],
      line: m[2] === undefined ? null : Number(m[2]),
      column: m[3] === undefined ? null : Number(m[3])
    };
  }

  /**
   * V8 / Chrome / Node：`    at fnName (/path/to/file.js:10:15)`
   *
   * 拆成两个正则而不是一个：带函数名的写法里函数名和路径之间**有空格**
   * （`at fnName (…`），不带函数名的写法里没有括号（`at file.js:1:1`）。
   * 一个正则里用 `[^()]*?` 同时兼容两者的话，Java 的
   * `at com.example.Foo.bar(Foo.java:42)` 会被当成「文件名 = 整行」。
   */
  var RE_V8_NAMED = /^\s*at\s+(.+?)\s+\(([^()]*)\)\s*$/;
  var RE_V8_ANON = /^\s*at\s+([^\s()]+?)(?::(\d+))?(?::(\d+))?\s*$/;

  function parseV8(line) {
    var m = RE_V8_NAMED.exec(line);
    if (m) {
      var loc = splitLocation(m[2]);
      return { functionName: m[1], file: loc.file, line: loc.line, column: loc.column };
    }
    m = RE_V8_ANON.exec(line);
    if (m) {
      return {
        functionName: null,
        file: m[1],
        line: m[2] === undefined ? null : Number(m[2]),
        column: m[3] === undefined ? null : Number(m[3])
      };
    }
    return null;
  }

  /**
   * Firefox / Safari：`fnName@file.js:10:15`、`@file.js:10:15`
   *
   * 函数名与文件名之间是 `@`，跟 V8 的 `at (…` 完全是两套记法。
   * 函数名本身允许为空（Safari 的顶层帧就是 `@file.js:10:15`）。
   * 文件名可以是 URL（`fnName@http://example.com/app.js:10:15`），
   * 所以行号同样要靠「结尾锚定 + 懒惰」才能取到最后那对数字。
   */
  var RE_FIREFOX = /^(.*?)@(.+?):(\d+)(?::(\d+))?$/;

  function parseFirefox(line) {
    var m = RE_FIREFOX.exec(line);
    if (!m) return null;
    return {
      functionName: m[1] === '' ? null : m[1],
      file: m[2],
      line: Number(m[3]),
      column: m[4] === undefined ? null : Number(m[4])
    };
  }

  /**
   * Java：`    at com.example.Foo.bar(Foo.java:42)`
   *
   * Java 的括号里**可以没有行号**（`at com.example.Foo.bar(Foo.java)`），
   * 也可以是 `Unknown Source`；Java 9+ 还会在方法名前带模块前缀
   * （`at java.base/java.lang.Thread.run(Thread.java:833)`），
   * 所以方法名用「非空白非括号」而不是逐个字符白名单。
   */
  var RE_JAVA = /^\s*at\s+([^\s(]+)\s*\(([^()]+)\)\s*$/;

  function parseJava(line) {
    var m = RE_JAVA.exec(line);
    if (!m) return null;
    var loc = splitLocation(m[2]);
    return { functionName: m[1], file: loc.file, line: loc.line, column: loc.column };
  }

  /**
   * Python：`  File "app.py", line 12, in <module>`
   *
   * Python 的帧长得跟别的都不一样：`File` 后面是**带引号的路径**，
   * 行号前面是字面量 `line`，函数名在 `in` 后面（顶层帧是 `<module>`）。
   */
  var RE_PYTHON = /^\s*File\s+"([^"]*)",\s*line\s+(\d+)(?:,\s*in\s+(.+?))?\s*$/;

  function parsePython(line) {
    var m = RE_PYTHON.exec(line);
    if (!m) return null;
    return {
      functionName: m[3] === undefined ? null : m[3],
      file: m[1],
      line: Number(m[2]),
      column: null
    };
  }

  /**
   * .NET：`   at Namespace.Class.Method() in C:\path\File.cs:line 42`
   *
   * .NET 特有的 ` in ` 分隔符，`:line 42` 里的 `line` 是字面量。
   * 方法名末尾的 `()` 是签名的一部分不是名字的一部分，去掉。
   * 有些裁剪过的日志只有 `at Namespace.Class.Method()`（没有文件），
   * 单开一条规则认它 —— 但要求括号里是空的，免得把 Java 的帧抢过来。
   */
  var RE_DOTNET = /^\s*at\s+(.+?)\s+in\s+(.+?)(?::line\s+(\d+))?\s*$/;
  var RE_DOTNET_NOFILE = /^\s*at\s+([^\s(]+)\(\)\s*$/;

  function parseDotNet(line) {
    var m = RE_DOTNET.exec(line);
    if (m) {
      return {
        functionName: m[1].replace(/\(\)$/, ''),
        file: m[2],
        line: m[3] === undefined ? null : Number(m[3]),
        column: null
      };
    }
    m = RE_DOTNET_NOFILE.exec(line);
    if (m) {
      return { functionName: m[1].replace(/\(\)$/, ''), file: null, line: null, column: null };
    }
    return null;
  }

  /** 所有格式。顺序也是**平手时的优先级**：V8 最通用，排第一。 */
  var FORMATS = [
    { id: 'v8', parse: parseV8 },
    { id: 'firefox', parse: parseFirefox },
    { id: 'java', parse: parseJava },
    { id: 'python', parse: parsePython },
    { id: 'dotnet', parse: parseDotNet }
  ];

  /**
   * 格式的名字。
   *
   * 这里必须把 t() 一条条写死 —— 键要是拼出来的（`t('format_' + id)`），
   * Rust 侧扫 t() 调用的那个扫描器认不出来，语言包里有没有这一条就再也查不到了。
   */
  function formatLabel(id) {
    if (id === 'v8') return t('format_v8', 'V8 / Chrome / Node');
    if (id === 'firefox') return t('format_firefox', 'Firefox / Safari');
    if (id === 'java') return t('format_java', 'Java');
    if (id === 'python') return t('format_python', 'Python');
    if (id === 'dotnet') return t('format_dotnet', '.NET');
    return t('format_unknown', 'Unknown');
  }

  /**
   * 猜格式：谁的规则命中的行多，就是那种格式。
   *
   * 认不出来（谁都命中 0 行）时返回 null —— 调用方会退回最通用的 V8 去试，
   * 但**不要**假装它是 V8：面板上要如实告诉用户「没认出来」。
   * @param {string[]} lines
   * @returns {string|null}
   */
  function detectFormat(lines) {
    var counts = {};
    FORMATS.forEach(function (f) { counts[f.id] = 0; });
    lines.forEach(function (line) {
      if (!line.trim()) return;
      FORMATS.forEach(function (f) {
        if (f.parse(line)) counts[f.id]++;
      });
    });
    var best = null;
    var bestCount = 0;
    FORMATS.forEach(function (f) {
      if (counts[f.id] > bestCount) { bestCount = counts[f.id]; best = f.id; }
    });
    return best;
  }

  /** 逐行试解析时的顺序：认出来的格式先试，其余按通用程度兜底。 */
  function parseOrder(detected) {
    var order = [];
    FORMATS.forEach(function (f) { if (f.id === detected) order.push(f); });
    FORMATS.forEach(function (f) { if (f.id !== detected) order.push(f); });
    return order;
  }

  /** 试一遍所有格式，返回 {format, data} 或 null。 */
  function tryParse(order, line) {
    for (var i = 0; i < order.length; i++) {
      var data = order[i].parse(line);
      if (data) return { format: order[i].id, data: data };
    }
    return null;
  }

  /* ---------- 文本小工具 ---------- */

  /** 切行。末尾换行不额外造出一个空行，CRLF 的 CR 吃掉。 */
  function splitLines(text) {
    if (text === null || text === undefined) return [];
    var s = String(text);
    if (s === '') return [];
    if (s.charAt(s.length - 1) === '\n') s = s.slice(0, -1);
    return s.split('\n').map(function (l) {
      return l.charAt(l.length - 1) === '\r' ? l.slice(0, -1) : l;
    });
  }

  /** 一行开头的缩进宽度（按空白字符个数算，制表符当 1 个）。 */
  function indentWidth(line) {
    var m = /^[ \t]*/.exec(line);
    return m ? m[0].length : 0;
  }

  /**
   * 文件名（不含目录）。
   *
   * Windows 的路径用反斜杠，所以两个分隔符都要认 —— 只按 `/` 切的话
   * `C:\path\File.cs` 的「文件名」会变成整个路径。
   */
  function baseName(file) {
    if (file === null || file === undefined || file === '') return null;
    var s = String(file);
    var m = /([^\\/]+)$/.exec(s);
    return m ? m[1] : s;
  }

  /* ---------- 主解析 ---------- */

  /**
   * 解析一整段堆栈。
   *
   * 返回 { format, frames }，frames 里**每一行**都有一项，
   * 解析不出来的那些 parsed 为 false 但原文照留。
   *
   * @param {string} text
   * @returns {{format: string|null, frames: Array}}
   */
  function parseStack(text) {
    var lines = splitLines(text);
    var detected = detectFormat(lines);
    var order = parseOrder(detected);
    var frames = [];
    var prev = null;   // 上一帧的上下文（用来接 Python 的源码行）

    lines.forEach(function (line) {
      if (!line.trim()) return;   // 空行没有信息，跳过
      var indent = indentWidth(line);

      // Python 的源码行：`File "x.py", line 3, in f` 的**下一行**是那行代码本身。
      // 判据是「缩进比 File 行深」—— CPython 的源码行一定比 File 行缩进更深，
      // 而栈末尾的异常行（`ZeroDivisionError: …`）不缩进，所以不会被误认。
      // 连续几行缩进代码（一条语句被拆成多行）要**都留着**：只留第一行的话
      // 后面的行就凭空消失了。
      if (prev && prev.isPython && indent > prev.indent) {
        if (!tryParse(order, line)) {
          // 去掉**第一行源码**的缩进，但行与行之间多出来的缩进要留着 ——
          // 那是代码自己的缩进结构（一条语句被拆成多行时尤其重要）。
          if (prev.sourceIndent === undefined) prev.sourceIndent = indent;
          var piece = line.slice(prev.sourceIndent).replace(/\s+$/, '');
          prev.frame.source = prev.frame.source ? prev.frame.source + '\n' + piece : piece;
          return;
        }
      }

      var hit = tryParse(order, line);
      var frame = {
        functionName: null,
        file: null,
        line: null,
        column: null,
        raw: line,
        parsed: !!hit,
        format: hit ? hit.format : null,
        source: null,
        basename: null
      };
      if (hit) {
        frame.functionName = hit.data.functionName;
        frame.file = hit.data.file;
        frame.line = hit.data.line;
        frame.column = hit.data.column;
        frame.basename = baseName(frame.file);
      }
      frames.push(frame);
      prev = { indent: indent, isPython: !!(hit && hit.format === 'python'), frame: frame };
    });

    return { format: detected, frames: frames };
  }

  /* ---------- 输出 ---------- */

  /** 帧的「位置」文字：`file.js:10:15`，缺哪段省哪段。 */
  function locationText(frame) {
    var out = '';
    if (frame.file) out += frame.file;
    if (frame.line !== null && frame.line !== undefined) out += ':' + frame.line;
    if (frame.column !== null && frame.column !== undefined) out += ':' + frame.column;
    return out;
  }

  /**
   * 缩进对齐的纯文本，一行一帧。
   *
   * 对齐是这里唯一值得做的事：栈要被人**横向对比**（两个栈差在哪一帧），
   * 不对齐的话只能一行行数字符。
   *
   * @param {Array} frames
   * @param {{unparsedLabel?: string}} [opts]
   * @returns {string}
   */
  function formatFrames(frames, opts) {
    opts = opts || {};
    var label = opts.unparsedLabel || '<unparsed>';
    var rows = [];
    var idxWidth = 0;
    var fnWidth = 0;

    frames.forEach(function (f, i) {
      var fn = f.parsed ? (f.functionName || '') : label;
      var loc = f.parsed ? locationText(f) : String(f.raw || '').trim();
      rows.push({ idx: '#' + i, fn: fn, loc: loc });
      if (rows[rows.length - 1].idx.length > idxWidth) idxWidth = rows[rows.length - 1].idx.length;
      if (fn.length > fnWidth) fnWidth = fn.length;
    });

    return rows.map(function (r) {
      return r.idx.padEnd(idxWidth) + '  ' + r.fn.padEnd(fnWidth) + '   ' + r.loc;
    }).join('\n');
  }

  /**
   * 把一帧拆成「带类别的小段」。
   *
   * 页面上渲染的那份与复制出去的那份**都从这一份数据出发**，
   * 这样就不会出现「屏幕上是一种颜色、复制出来是另一种」的怪事。
   */
  function frameSegments(frame, index, unparsedLabel) {
    var segs = [{ kind: 'index', text: '#' + index }];
    if (!frame.parsed) {
      segs.push({ kind: 'sep', text: '  ' });
      segs.push({ kind: 'label', text: unparsedLabel || '<unparsed>' });
      segs.push({ kind: 'sep', text: ' ' });
      segs.push({ kind: 'raw', text: String(frame.raw || '').trim() });
      return segs;
    }
    segs.push({ kind: 'sep', text: '  ' });
    if (frame.functionName) segs.push({ kind: 'fn', text: frame.functionName });
    if (frame.file) {
      if (frame.functionName) segs.push({ kind: 'sep', text: ' ' });
      segs.push({ kind: 'file', text: frame.file });
    }
    if (frame.line !== null && frame.line !== undefined) segs.push({ kind: 'pos', text: ':' + frame.line });
    if (frame.column !== null && frame.column !== undefined) segs.push({ kind: 'pos', text: ':' + frame.column });
    return segs;
  }

  /**
   * 高亮的配色。
   *
   * 页面上的那份用 CSS 变量（跟着站点主题走，深色模式下也不会瞎）；
   * 复制出去的那份用**字面色** —— 贴到 issue / 聊天里时，那些站点既没有我们的
   * 变量表也会剥掉 <style>，`var(--primary)` 只会变成一团黑。
   */
  var COLORS_VARS = {
    index: 'var(--text-muted)',
    fn: 'var(--primary)',
    file: 'var(--text-title)',
    pos: 'var(--text-muted)',
    label: 'var(--text-muted)',
    raw: 'var(--text-base)'
  };
  var COLORS_LITERAL = {
    index: '#6b7280',
    fn: '#0f766e',
    file: '#1f2933',
    pos: '#6b7280',
    label: '#6b7280',
    raw: '#1f2933'
  };

  /**
   * 生成高亮 HTML（字符串）。
   *
   * 用户输入**逐段转义**后再拼进去 —— 堆栈里出现的文件名、函数名都是
   * 从粘贴内容里来的，直接塞进 innerHTML 就是一个现成的 XSS 入口
   *（`at <img src=x onerror=alert(1)> (x.js:1:1)` 就够）。
   *
   * @param {Array} frames
   * @param {{colors?: Object, unparsedLabel?: string}} [opts]
   * @returns {string}
   */
  function buildHtml(frames, opts) {
    opts = opts || {};
    var colors = opts.colors || COLORS_LITERAL;
    var label = opts.unparsedLabel || '<unparsed>';
    var rows = frames.map(function (f, i) {
      var html = frameSegments(f, i, label).map(function (s) {
        if (s.kind === 'sep') return U.escapeHtml(s.text);
        return '<span style="color:' + (colors[s.kind] || colors.raw) + '">' + U.escapeHtml(s.text) + '</span>';
      }).join('');
      return '<div>' + html + '</div>';
    });
    return '<div class="output-body">' + rows.join('') + '</div>';
  }

  /**
   * 生成高亮 HTML（DOM 节点）。
   *
   * 与 buildHtml 的区别只有一个：**用 textContent 逐段拼**，
   * 不走 innerHTML —— 页面上的那份更不该有 XSS。
   *
   * @param {Array} frames
   * @param {{colors?: Object, unparsedLabel?: string}} [opts]
   * @returns {HTMLElement}
   */
  function renderHighlighted(frames, opts) {
    opts = opts || {};
    var colors = opts.colors || COLORS_VARS;
    var label = opts.unparsedLabel || '<unparsed>';
    var wrap = D.h('div.output-body');
    frames.forEach(function (f, i) {
      var row = D.h('div');
      frameSegments(f, i, label).forEach(function (s) {
        if (s.kind === 'sep') {
          row.appendChild(document.createTextNode(s.text));
          return;
        }
        row.appendChild(D.h('span', { style: { color: colors[s.kind] || colors.raw }, text: s.text }));
      });
      wrap.appendChild(row);
    });
    return wrap;
  }

  /* ---------- UI ---------- */

  window.ItTools.register('stacktrace-formatter', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 8,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your stack trace here...')
    });

    var formatBadge = D.h('span.badge-note');
    var countBadge = D.h('span.badge-note');
    var tableBody = D.h('tbody');
    var textOut = D.h('pre.mono-output');
    var htmlOut = D.h('div.output-body');

    // 复制按钮要拿到「当前这一版」的结果，所以结果放在闭包里，
    // 渲染时更新，而不是让按钮回头去读 DOM。
    var current = { frames: [], format: null, text: '', html: '' };

    function render() {
      var result = parseStack(input.value);
      var frames = result.frames;
      current.frames = frames;
      current.format = result.format;
      current.text = formatFrames(frames, { unparsedLabel: t('unparsed', 'Unparsed') });
      current.html = buildHtml(frames, { colors: COLORS_LITERAL, unparsedLabel: t('unparsed', 'Unparsed') });

      var unparsedCount = frames.filter(function (f) { return !f.parsed; }).length;

      formatBadge.textContent = t('detected_format', 'Detected format: {format}')
        .replace('{format}', function () { return formatLabel(result.format); });
      countBadge.textContent = unparsedCount
        ? t('frame_count', '{n} frames, {u} unparsed')
          .replace('{n}', function () { return String(frames.length); })
          .replace('{u}', function () { return String(unparsedCount); })
        : t('frame_count_simple', '{n} frames')
          .replace('{n}', function () { return String(frames.length); });

      // 表格
      D.clear(tableBody);
      if (!frames.length) {
        tableBody.appendChild(D.h('tr', null,
          D.h('td', { colspan: '5' },
            D.h('span.muted', { text: t('empty_input', 'Paste a stack trace to see the parsed frames.') }))));
      }
      frames.forEach(function (f, i) {
        var fnCell = D.h('td');
        if (f.parsed) {
          fnCell.appendChild(D.h('span', { text: f.functionName || '—' }));
          // Python 的源码行挂在函数名下面 —— 它就是这一帧在干的事
          if (f.source) {
            fnCell.appendChild(D.h('div.muted', { style: { whiteSpace: 'pre-wrap' }, text: f.source }));
          }
        } else {
          fnCell.appendChild(D.h('span.muted', { text: t('unparsed', 'Unparsed') }));
          // 解析不出来的行**原文照留**：用户要看到完整的东西
          fnCell.appendChild(D.h('div', { text: String(f.raw || '').trim() }));
        }

        var fileCell = D.h('td');
        if (f.file) {
          fileCell.appendChild(D.h('span', { text: f.file }));
          // 绝对路径额外给出文件名，省得用户自己从长路径里扒
          if (f.basename && f.basename !== f.file) {
            fileCell.appendChild(D.h('div.muted', { text: f.basename }));
          }
        } else {
          fileCell.appendChild(D.h('span.muted', { text: '—' }));
        }

        tableBody.appendChild(D.h('tr', null,
          D.h('td', { text: String(i) }),
          fnCell,
          fileCell,
          D.h('td', { text: f.line === null || f.line === undefined ? '—' : String(f.line) }),
          D.h('td', { text: f.column === null || f.column === undefined ? '—' : String(f.column) })
        ));
      });

      // 纯文本
      textOut.textContent = current.text;

      // 高亮 HTML
      D.clear(htmlOut);
      var rendered = renderHighlighted(frames, { colors: COLORS_VARS, unparsedLabel: t('unparsed', 'Unparsed') });
      while (rendered.firstChild) htmlOut.appendChild(rendered.firstChild);
    }

    var off = D.on(input, 'input', render);

    // 面板：直属子元素必须全都是 .card，否则 .tool-content 的 flex
    // 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Stack trace'), input, { wide: true }),
      D.h('div.field-row', null, formatBadge, countBadge)
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null, D.h('span.output-label', { text: t('frames_title', 'Parsed frames') })),
      D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_index', '#') }),
          D.h('th', { text: t('col_function', 'Function') }),
          D.h('th', { text: t('col_file', 'File') }),
          D.h('th', { text: t('col_line', 'Line') }),
          D.h('th', { text: t('col_column', 'Column') })
        )),
        tableBody
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null, D.h('span.output-label', { text: t('formatted_title', 'Formatted output') })),
      textOut,
      D.h('div.form-actions', null,
        U.copyButton(function () { return input.value; }, t('copy_raw', 'Copy raw')),
        U.copyButton(function () { return current.text; }, t('copy_formatted', 'Copy formatted text')),
        U.copyButton(function () { return current.html; }, t('copy_html', 'Copy HTML'))
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null, D.h('span.output-label', { text: t('html_title', 'Highlighted HTML') })),
      htmlOut,
      D.h('p.field-hint', { text: t('html_hint', 'The copied HTML uses literal colors so it stays readable outside this site.') })
    ));

    render();

    return { destroy: function () { off(); D.clear(root); } };
  });

  /* ---------- 纯逻辑（单测直接调这些） ---------- */

  window.ItTools.logic['stacktrace-formatter'] = {
    parseStack: parseStack,
    detectFormat: detectFormat,
    formatFrames: formatFrames,
    buildHtml: buildHtml,
    renderHighlighted: renderHighlighted,
    splitLocation: splitLocation,
    baseName: baseName,
    splitLines: splitLines,
    __cases: function (assert) {
      /* ---- V8 / Chrome / Node ---- */
      var v8 = parseStack([
        'Error: boom',
        '    at fnName (/path/to/file.js:10:15)',
        '    at Object.<anonymous> (/path/file.js:1:1)',
        '    at async fn (file.js:3:5)',
        'at file.js:1:1'
      ].join('\n'));
      assert.eq(v8.format, 'v8', 'V8：识别出格式');
      assert.eq(v8.frames.length, 5, 'V8：每一行都留下一项（含无法解析的 Error 行）');
      assert.eq(v8.frames[0].parsed, false, 'V8：错误消息行无法解析');
      assert.eq(v8.frames[0].raw, 'Error: boom', 'V8：无法解析的行原文照留');
      assert.eq(v8.frames[1].functionName, 'fnName', 'V8：函数名');
      assert.eq(v8.frames[1].file, '/path/to/file.js', 'V8：文件路径');
      assert.eq(v8.frames[1].line, 10, 'V8：行号');
      assert.eq(v8.frames[1].column, 15, 'V8：列号');
      assert.eq(v8.frames[1].basename, 'file.js', 'V8：文件名');
      assert.eq(v8.frames[2].functionName, 'Object.<anonymous>', 'V8：Object.<anonymous>');
      assert.eq(v8.frames[2].file, '/path/file.js', 'V8：路径');
      assert.eq(v8.frames[2].line, 1, 'V8：行');
      assert.eq(v8.frames[2].column, 1, 'V8：列');
      assert.eq(v8.frames[3].functionName, 'async fn', 'V8：async 前缀留着');
      assert.eq(v8.frames[3].file, 'file.js', 'V8：相对路径');
      assert.eq(v8.frames[3].line, 3, 'V8：行');
      assert.eq(v8.frames[3].column, 5, 'V8：列');
      assert.eq(v8.frames[4].functionName, null, 'V8：没有函数名');
      assert.eq(v8.frames[4].file, 'file.js', 'V8：无函数名时文件照样解出来');
      assert.eq(v8.frames[4].line, 1, 'V8：行');
      assert.eq(v8.frames[4].column, 1, 'V8：列');

      // Node 的内部帧：路径里带冒号（node:internal/...），行号必须是最后那对数字
      var nodeFrame = parseStack('    at Module._compile (node:internal/modules/cjs/loader:1105:14)').frames[0];
      assert.eq(nodeFrame.file, 'node:internal/modules/cjs/loader', 'V8：路径里的冒号不吃掉行号');
      assert.eq(nodeFrame.line, 1105, 'V8：Node 内部帧的行号');
      assert.eq(nodeFrame.column, 14, 'V8：Node 内部帧的列号');

      // 原生帧：没有路径也没有行号
      var nativeFrame = parseStack('    at Array.forEach (<anonymous>)').frames[0];
      assert.eq(nativeFrame.functionName, 'Array.forEach', 'V8：原生帧的函数名');
      assert.eq(nativeFrame.file, '<anonymous>', 'V8：原生帧的占位路径');
      assert.eq(nativeFrame.line, null, 'V8：原生帧没有行号');

      /* ---- Firefox / Safari ---- */
      var ff = parseStack([
        'fnName@file.js:10:15',
        '@file.js:12:3',
        'global code@file.js:1:1'
      ].join('\n'));
      assert.eq(ff.format, 'firefox', 'Firefox：识别出格式');
      assert.eq(ff.frames.length, 3, 'Firefox：三行都是帧');
      assert.eq(ff.frames[0].functionName, 'fnName', 'Firefox：函数名');
      assert.eq(ff.frames[0].file, 'file.js', 'Firefox：文件');
      assert.eq(ff.frames[0].line, 10, 'Firefox：行');
      assert.eq(ff.frames[0].column, 15, 'Firefox：列');
      assert.eq(ff.frames[1].functionName, null, 'Firefox：@ 开头的顶层帧没有函数名');
      assert.eq(ff.frames[1].file, 'file.js', 'Firefox：@ 开头的帧文件');
      assert.eq(ff.frames[1].line, 12, 'Firefox：@ 开头的帧行号');
      assert.eq(ff.frames[2].functionName, 'global code', 'Safari：global code');

      // Firefox 的 URL 帧：路径里的冒号不能被当行号
      var ffUrl = parseStack('fnName@http://example.com/app.js:10:15').frames[0];
      assert.eq(ffUrl.file, 'http://example.com/app.js', 'Firefox：URL 帧的路径');
      assert.eq(ffUrl.line, 10, 'Firefox：URL 帧的行号');
      assert.eq(ffUrl.column, 15, 'Firefox：URL 帧的列号');

      /* ---- Java ---- */
      var java = parseStack([
        'java.lang.RuntimeException: boom',
        '    at com.example.Foo.bar(Foo.java:42)',
        'at com.example.Foo.bar(Foo.java)',
        '    at java.base/java.lang.Thread.run(Thread.java:833)'
      ].join('\n'));
      assert.eq(java.format, 'java', 'Java：识别出格式');
      assert.eq(java.frames[0].parsed, false, 'Java：异常消息行不是帧');
      assert.eq(java.frames[0].raw, 'java.lang.RuntimeException: boom', 'Java：异常消息原文照留');
      assert.eq(java.frames[1].functionName, 'com.example.Foo.bar', 'Java：全限定方法名');
      assert.eq(java.frames[1].file, 'Foo.java', 'Java：文件');
      assert.eq(java.frames[1].line, 42, 'Java：行号');
      assert.eq(java.frames[1].column, null, 'Java：没有列号');
      assert.eq(java.frames[2].file, 'Foo.java', 'Java：括号里没有行号时文件照样解出来');
      assert.eq(java.frames[2].line, null, 'Java：括号里没有行号时行号为空');
      assert.eq(java.frames[3].functionName, 'java.base/java.lang.Thread.run', 'Java：模块前缀留着');
      assert.eq(java.frames[3].file, 'Thread.java', 'Java：模块前缀的帧文件');
      assert.eq(java.frames[3].line, 833, 'Java：模块前缀的帧行号');

      /* ---- Python ---- */
      var py = parseStack([
        'Traceback (most recent call last):',
        '  File "app.py", line 12, in <module>',
        '    return x',
        '  File "/app/lib.py", line 5, in compute',
        '    return 1 / 0',
        'ZeroDivisionError: division by zero'
      ].join('\n'));
      assert.eq(py.format, 'python', 'Python：识别出格式');
      assert.eq(py.frames.length, 4, 'Python：源码行挂在帧上，不单独占一行');
      assert.eq(py.frames[0].parsed, false, 'Python：Traceback 头不是帧');
      assert.eq(py.frames[1].functionName, '<module>', 'Python：顶层帧的函数名');
      assert.eq(py.frames[1].file, 'app.py', 'Python：文件');
      assert.eq(py.frames[1].line, 12, 'Python：行号');
      assert.eq(py.frames[1].source, 'return x', 'Python：源码行挂在帧上');
      assert.eq(py.frames[2].functionName, 'compute', 'Python：函数名');
      assert.eq(py.frames[2].file, '/app/lib.py', 'Python：绝对路径');
      assert.eq(py.frames[2].line, 5, 'Python：行号');
      assert.eq(py.frames[2].source, 'return 1 / 0', 'Python：源码行');
      assert.eq(py.frames[3].parsed, false, 'Python：末尾的异常行不是帧');
      assert.eq(py.frames[3].raw, 'ZeroDivisionError: division by zero', 'Python：异常行原文照留');

      // 一条语句被拆成多行时，后面的行也要留着
      var pyMulti = parseStack([
        '  File "app.py", line 12, in <module>',
        '    result = compute(',
        '        arg)'
      ].join('\n'));
      assert.eq(pyMulti.frames.length, 1, 'Python：拆成多行的语句仍算一帧');
      assert.eq(pyMulti.frames[0].source, 'result = compute(\n    arg)', 'Python：多行源码都留着（相对缩进保留）');

      /* ---- .NET ---- */
      var net = parseStack([
        'System.InvalidOperationException: boom',
        '   at Namespace.Class.Method() in C:\\path\\File.cs:line 42',
        '   at Namespace.Class.Other() in /path/File.cs:line 7',
        '--- End of stack trace from previous location ---'
      ].join('\n'));
      assert.eq(net.format, 'dotnet', '.NET：识别出格式');
      assert.eq(net.frames[0].parsed, false, '.NET：异常消息行不是帧');
      assert.eq(net.frames[1].functionName, 'Namespace.Class.Method', '.NET：方法名去掉末尾的 ()');
      assert.eq(net.frames[1].file, 'C:\\path\\File.cs', '.NET：Windows 路径');
      assert.eq(net.frames[1].line, 42, '.NET：行号');
      assert.eq(net.frames[1].basename, 'File.cs', '.NET：Windows 路径的文件名');
      assert.eq(net.frames[2].file, '/path/File.cs', '.NET：Linux 路径');
      assert.eq(net.frames[2].line, 7, '.NET：行号');
      assert.eq(net.frames[3].parsed, false, '.NET：End of stack trace 行不是帧');
      assert.eq(net.frames[3].raw, '--- End of stack trace from previous location ---', '.NET：原文照留');

      // 只有方法名没有文件信息的 .NET 帧
      var netNoFile = parseStack('   at Namespace.Class.Method()').frames[0];
      assert.eq(netNoFile.functionName, 'Namespace.Class.Method', '.NET：没有文件信息时方法名照解');
      assert.eq(netNoFile.file, null, '.NET：没有文件信息时文件为空');

      /* ---- 无法解析的行要保留 ---- */
      var mixed = parseStack([
        '随便一行谁也不认识',
        '    at fnName (/a.js:1:2)',
        '还有一行不认识'
      ].join('\n'));
      assert.eq(mixed.frames.length, 3, '不认识的行不会被丢掉');
      assert.eq(mixed.frames[0].parsed, false, '第一行无法解析');
      assert.eq(mixed.frames[0].raw, '随便一行谁也不认识', '原文照留');
      assert.eq(mixed.frames[1].parsed, true, '中间那行是帧');
      assert.eq(mixed.frames[2].parsed, false, '最后一行无法解析');
      assert.eq(mixed.frames[2].raw, '还有一行不认识', '原文照留');
      // 顺序保持原样，不排序
      assert.eq(mixed.frames.map(function (f) { return f.raw; }),
        ['随便一行谁也不认识', '    at fnName (/a.js:1:2)', '还有一行不认识'], '帧的顺序就是原文顺序');

      /* ---- 空输入不抛异常 ---- */
      var empty = parseStack('');
      assert.eq(empty.frames, [], '空输入没有帧');
      assert.eq(empty.format, null, '空输入认不出格式');
      assert.eq(parseStack(null).frames, [], 'null 输入没有帧');
      assert.eq(parseStack(undefined).frames, [], 'undefined 输入没有帧');
      assert.eq(parseStack('   \n  \n').frames, [], '纯空白的输入没有帧');
      assert.eq(formatFrames([], {}), '', '空帧列表格式化出空串');
      assert.eq(buildHtml([], {}), '<div class="output-body"></div>', '空帧列表的 HTML 是空容器');

      /* ---- 识别不出来时按 V8 试 ---- */
      var unknown = parseStack('这不是任何一种堆栈');
      assert.eq(unknown.format, null, '认不出格式就说认不出');
      assert.eq(unknown.frames.length, 1, '认不出时这一行仍然保留');
      assert.eq(unknown.frames[0].parsed, false, '认不出时这一行无法解析');

      /* ---- 混着两种写法也要能解 ---- */
      var mixedFormats = parseStack([
        '    at fnName (/a.js:1:2)',
        'other@/b.js:3:4'
      ].join('\n'));
      assert.eq(mixedFormats.frames.length, 2, '两种格式混着时行数不变');
      assert.eq(mixedFormats.frames[0].file, '/a.js', '混排时 V8 帧照解');
      assert.eq(mixedFormats.frames[1].file, '/b.js', '混排时 Firefox 帧照解');
      assert.eq(mixedFormats.frames[1].functionName, 'other', '混排时 Firefox 帧的函数名');

      /* ---- 格式化文本 ---- */
      var text = formatFrames([
        { functionName: 'fnName', file: '/path/file.js', line: 10, column: 15, raw: 'x', parsed: true },
        { functionName: 'Object.<anonymous>', file: '/path/file.js', line: 1, column: 1, raw: 'y', parsed: true }
      ], {});
      assert.eq(text,
        '#0  fnName               /path/file.js:10:15\n#1  Object.<anonymous>   /path/file.js:1:1',
        '格式化文本：索引与函数名对齐');

      // 无法解析的行在格式化文本里也要在（原文）
      var textWithUnparsed = formatFrames([
        { functionName: 'fnName', file: 'a.js', line: 1, column: 2, raw: 'x', parsed: true },
        { functionName: null, file: null, line: null, column: null, raw: 'Error: boom', parsed: false }
      ], { unparsedLabel: 'Unparsed' });
      assert.eq(textWithUnparsed,
        '#0  fnName     a.js:1:2\n#1  Unparsed   Error: boom',
        '格式化文本：无法解析的行带标记和原文');

      /* ---- HTML：用户输入必须转义 ---- */
      var evil = parseStack('    at <img src=x onerror=alert(1)> (</span><script>alert(2)</script>:1:2)');
      var evilHtml = buildHtml(evil.frames, {});
      assert(evilHtml.indexOf('<script>') < 0, 'HTML 里不能出现真的 <script> 标签');
      assert(evilHtml.indexOf('<img') < 0, 'HTML 里不能出现真的 <img> 标签');
      assert(evilHtml.indexOf('&lt;script&gt;') >= 0, '尖括号被转义');
      assert(evilHtml.indexOf('&lt;img') >= 0, '尖括号被转义（img）');
      assert(evilHtml.indexOf('onerror=alert(1)') >= 0, '文本内容本身保留（只是不再是标签）');

      // & 与引号也要转义，否则拼出来的 HTML 是坏的
      var amp = buildHtml([
        { functionName: 'a&b', file: 'c"d\'e.js', line: null, column: null, raw: 'x', parsed: true }
      ], {});
      assert(amp.indexOf('a&amp;b') >= 0, '& 被转义');
      assert(amp.indexOf('c&quot;d&#39;e.js') >= 0, '引号被转义');

      // 高亮的 span 用的是不同的颜色，且都套在转义后的文本上
      var html = buildHtml([
        { functionName: 'fnName', file: 'a.js', line: 10, column: 15, raw: 'x', parsed: true }
      ], { colors: { index: '#111111', fn: '#222222', file: '#333333', pos: '#444444', label: '#555555', raw: '#666666' } });
      assert(html.indexOf('<span style="color:#222222">fnName</span>') >= 0, '函数名单独一段且有自己的颜色');
      assert(html.indexOf('<span style="color:#333333">a.js</span>') >= 0, '文件名单独一段且有自己的颜色');
      assert(html.indexOf('<span style="color:#444444">:10</span>') >= 0, '行号单独一段');
      assert(html.indexOf('<span style="color:#444444">:15</span>') >= 0, '列号单独一段');
      assert(html.indexOf('#111111') >= 0, '索引也有自己的颜色');

      /* ---- 页面上的那份用 textContent 拼，不走 innerHTML ---- */
      var node = renderHighlighted([
        { functionName: '<b>fn</b>', file: 'a.js', line: 1, column: 2, raw: 'x', parsed: true }
      ], {});
      assert(node.querySelector('b') === null, '页面上的高亮里没有真的标签');
      assert(node.textContent.indexOf('<b>fn</b>') >= 0, '文本内容原样保留');
      assert(node.querySelectorAll('span').length >= 3, '函数名 / 文件 / 行列各自是 span');

      /* ---- 小工具 ---- */
      assert.eq(baseName('/path/to/file.js'), 'file.js', 'POSIX 路径的文件名');
      assert.eq(baseName('C:\\path\\File.cs'), 'File.cs', 'Windows 路径的文件名');
      assert.eq(baseName('file.js'), 'file.js', '只有文件名');
      assert.eq(baseName(null), null, '空路径没有文件名');
      assert.eq(splitLocation('/a/b.js:10:15'), { file: '/a/b.js', line: 10, column: 15 }, '位置三元组');
      assert.eq(splitLocation('a.js'), { file: 'a.js', line: null, column: null }, '只有文件名');
      assert.eq(splitLocation('a.js:10'), { file: 'a.js', line: 10, column: null }, '没有列号');
      assert.eq(splitLocation('node:internal/x:1105:14'),
        { file: 'node:internal/x', line: 1105, column: 14 }, '路径里的冒号不当行号');
      assert.eq(splitLines('a\nb\n'), ['a', 'b'], '末尾换行不造出空行');
      assert.eq(splitLines('a\r\nb'), ['a', 'b'], 'CRLF 的 CR 吃掉');
    }
  };
})();
