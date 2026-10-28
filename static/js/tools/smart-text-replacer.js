/* ==========================================================================
   智能文本替换（smart-text-replacer）

   在一段文本里查找并替换：可以开正则（替换串里的 $1 / $& 由引擎展开），
   可以按行拆开搜（命中不会跨行），可以「全部替换」，也可以「逐个替换」——
   后者把每一处命中的上下文列出来，每一处一个替换按钮，替换完再点下一处。

   参考实现：src/tools/smart-text-replacer/（it-tools, GPLv3）
   与上游的差别（都是上游的毛病，不是我们的偏好）：
   1. 上游把命中结果拼成 **HTML 字符串**再用 v-html 渲染
      （`<span class="highlight">…</span>`）。原文里的 < & " 会把这段 HTML 拆坏
      —— 搜 "<b>" 就能看见标签被吃掉；更要命的是上游的复制按钮复制的是
      `highlightedText`（**带标签的 HTML**），粘出来是
      `<span class="outline">foo</span>`，根本不是文本。
      这里改成：命中位置用 DOM 节点标出来，复制取 textContent（纯文本）。
   2. 上游 `new RegExp(findWhatValue, …)` 没有任何保护，输入非法正则时
      整个 computed 抛异常，页面直接白掉。这里 try/catch，
      非法正则只显示一行提示，工具照常能用。
   3. 上游的「替换选中项」是直接改 DOM 里那个 span 的 textContent，
      命中数、上下文都跟着失真（totalMatches 是拿 DOM 节点数出来的）。
      这里所有替换都在字符串上做，命中列表每渲染一次都是重新算的。
   4. 上游用 `document.querySelectorAll('.outline, .highlight')` 全局查节点，
      页面上别的工具用同样的 class 名就会互相干扰；
      这里每个工具只在自己的 root 里查。
   5. 上游的「逐个替换」只能一个一个点，没有「剩下的全替」；
      这里补上（一次把剩下的命中全替掉）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('smart-text-replacer');

  /** 命中列表里，每处命中的前后各带多少个字符的上下文 */
  var CONTEXT_CHARS = 24;

  /** 上游给的样例文本 */
  var SAMPLE = 'Lorem ipsum dolor sit amet DOLOR Lorem ipsum dolor sit amet DOLOR';

  /** 命中的底色（深浅主题都能看清：浅底 + 深字） */
  var HIT_BG = '#ffe9a8';
  var HIT_FG = '#7a5b00';

  function str(v) {
    return v == null ? '' : String(v);
  }

  /**
   * 转义正则元字符。
   *
   * 字面量模式也走同一套正则匹配逻辑（只是把元字符转义掉），
   * 这样「查找 / 替换」只有一条代码路径，命中位置、上下文、计数
   * 在两种模式下是同一套代码算出来的，不会出现两边对不上。
   */
  function escapeRegExp(s) {
    return str(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 造搜索用的正则。
   *
   * @param {string} find 查找串
   * @param {boolean} useRegex false → 按字面量找
   * @param {boolean} caseSensitive
   * @returns {{re: RegExp|null, error: string|null}} error 非空时 re 为 null
   */
  function buildRegex(find, useRegex, caseSensitive) {
    var source = useRegex ? str(find) : escapeRegExp(find);
    var flags = 'g' + (caseSensitive ? '' : 'i');
    try {
      return { re: new RegExp(source, flags), error: null };
    } catch (e) {
      return { re: null, error: e && e.message ? e.message : String(e) };
    }
  }

  /**
   * 把文本切成行，同时记住每行的行首位置和行尾分隔符。
   *
   * 分隔符原样留着：拆行再拼回去时 CRLF 不能变成 LF，
   * 否则「按行拆分」这个开关会顺手把用户的换行符改掉。
   */
  function splitLines(text) {
    var parts = str(text).split(/(\r\n|\n|\r)/);
    var lines = [];
    var offset = 0;
    for (var i = 0; i < parts.length; i += 2) {
      var content = parts[i];
      var sep = parts[i + 1] === undefined ? '' : parts[i + 1];
      lines.push({ content: content, sep: sep, start: offset });
      offset += content.length + sep.length;
    }
    return lines;
  }

  /**
   * 在一段文本里找出全部命中。
   *
   * 零长命中（比如查找串是 "a*"）会让 exec 的 lastIndex 不动，
   * 不手动往前挪一格就是死循环。
   */
  function execAll(re, text, baseIndex) {
    var out = [];
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      out.push({
        index: (baseIndex || 0) + m.index,
        length: m[0].length,
        matched: m[0]
      });
      if (m[0].length === 0) re.lastIndex++;
    }
    return out;
  }

  /**
   * 找出所有命中。
   *
   * @param {string} text
   * @param {object} o {find, useRegex, caseSensitive, splitLines}
   * @returns {{ok: boolean, error: string|null, matches: Array}}
   */
  function findMatches(text, o) {
    var built = buildRegex(o.find, o.useRegex, o.caseSensitive);
    if (!built.re) return { ok: false, error: built.error, matches: [] };
    if (!str(o.find)) return { ok: true, error: null, matches: [] };

    var matches = [];
    if (o.splitLines) {
      splitLines(text).forEach(function (line, li) {
        execAll(built.re, line.content, line.start).forEach(function (m) {
          m.line = li;
          m.lineStart = line.start;
          matches.push(m);
        });
      });
    } else {
      execAll(built.re, str(text), 0).forEach(function (m) {
        m.line = -1;
        m.lineStart = 0;
        matches.push(m);
      });
    }
    return { ok: true, error: null, matches: matches };
  }

  /**
   * 在一段文本里做替换，返回 {text, count}。
   *
   * 正则模式：替换串直接交给 String.replace —— $1、$2、$& 的展开
   * 由引擎来做，我们不自己实现替换串的语义（自己实现必然对不上
   * 边界情况，比如 $ 后面跟数字但组号不存在）。
   * 字面量模式：用函数形式返回替换串，$ 不会被当成替换模式。
   */
  function replaceInString(text, re, rep, useRegex) {
    var hits = execAll(re, text, 0);
    if (!hits.length) return { text: text, count: 0 };
    var out = useRegex ? text.replace(re, rep) : text.replace(re, function () { return rep; });
    return { text: out, count: hits.length };
  }

  /**
   * 全部替换。
   *
   * @returns {{ok: boolean, error: string|null, text: string, count: number}}
   */
  function replaceAll(text, o) {
    var built = buildRegex(o.find, o.useRegex, o.caseSensitive);
    if (!built.re) return { ok: false, error: built.error, text: str(text), count: 0 };
    if (!str(o.find)) return { ok: true, error: null, text: str(text), count: 0 };

    var rep = str(o.replaceWith);
    var count = 0;
    var out;
    if (o.splitLines) {
      out = splitLines(text).map(function (line) {
        var res = replaceInString(line.content, built.re, rep, o.useRegex);
        count += res.count;
        return res.text + line.sep;
      }).join('');
    } else {
      var res = replaceInString(str(text), built.re, rep, o.useRegex);
      count = res.count;
      out = res.text;
    }
    return { ok: true, error: null, text: out, count: count };
  }

  /**
   * 只替换第 n 处命中（n 从 0 起）。
   *
   * 用**粘性**正则（y 标志）把 lastIndex 定到那一处：String.replace
   * 对粘性正则只动 lastIndex 指向的那个匹配，而且 $1 / $& 的展开规则
   * 跟「全部替换」完全一样 —— 不用自己实现替换串的语义。
   *
   * 按行拆分时要注意：正则里的 ^ / $ 是**按行**算的，粘性正则必须落在
   * 那一行里面 —— 直接对整段文本用粘性正则的话，^ 会因为「不在整段的开头」
   * 而失配（这一处就替换不掉了）。
   */
  function replaceOccurrence(text, o, n) {
    var built = buildRegex(o.find, o.useRegex, o.caseSensitive);
    if (!built.re) return { ok: false, error: built.error, text: str(text), count: 0 };

    var found = findMatches(text, o);
    if (!found.ok) return { ok: false, error: found.error, text: str(text), count: 0 };
    if (n < 0 || n >= found.matches.length) return { ok: false, error: null, text: str(text), count: 0 };

    var m = found.matches[n];
    var rep = str(o.replaceWith);
    var out;

    if (o.useRegex) {
      var sticky = new RegExp(built.re.source, built.re.flags.replace(/g/g, '') + 'y');
      if (o.splitLines) {
        var line = splitLines(text)[m.line];
        sticky.lastIndex = m.index - line.start;
        out = str(text).slice(0, line.start) +
          line.content.replace(sticky, rep) +
          str(text).slice(line.start + line.content.length);
      } else {
        sticky.lastIndex = m.index;
        out = str(text).replace(sticky, rep);
      }
    } else {
      // 字面量模式：替换串按字面量处理，直接切片拼回去。
      out = str(text).slice(0, m.index) + rep + str(text).slice(m.index + m.length);
    }
    return { ok: true, error: null, text: out, count: 1 };
  }

  /** 别把代理对（emoji 之类）切成两半。 */
  function alignStart(text, i) {
    if (i > 0 && i < text.length) {
      var code = text.charCodeAt(i);
      var prev = text.charCodeAt(i - 1);
      if (code >= 0xDC00 && code <= 0xDFFF && prev >= 0xD800 && prev <= 0xDBFF) return i - 1;
    }
    return i;
  }

  /** 同上：结尾别停在代理对中间。 */
  function alignEnd(text, i) {
    if (i > 0 && i < text.length) {
      var prev = text.charCodeAt(i - 1);
      var code = text.charCodeAt(i);
      if (prev >= 0xD800 && prev <= 0xDBFF && code >= 0xDC00 && code <= 0xDFFF) return i + 1;
    }
    return i;
  }

  /**
   * 某处命中的上下文（前后各 CONTEXT_CHARS 个字符）。
   * 截断了就在两头加省略号。
   */
  function contextFor(text, m) {
    var from = Math.max(0, m.index - CONTEXT_CHARS);
    var to = Math.min(text.length, m.index + m.length + CONTEXT_CHARS);
    from = alignStart(text, from);
    to = alignEnd(text, to);
    return {
      before: (from > 0 ? '…' : '') + text.slice(from, m.index),
      matched: text.slice(m.index, m.index + m.length),
      after: text.slice(m.index + m.length, to) + (to < text.length ? '…' : '')
    };
  }

  /**
   * 浏览器抛的正则错误自带一句 "Invalid regular expression: /…/gi: …"，
   * 跟界面上那句前缀重复了 —— 把重复的那截去掉，只留后半句。
   */
  function cleanRegexError(message) {
    return str(message).replace(/^invalid regular expression:?\s*/i, '');
  }

  window.ItTools.register('smart-text-replacer', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 8,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste the text you want to search in...')
    });
    input.value = SAMPLE;

    var findInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('find_ph', 'Text or regular expression to look for')
    });
    findInput.value = 'DOLOR';

    var replaceInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('replace_ph', 'Replacement text')
    });
    replaceInput.value = 'dolor';

    var regexBox = D.h('input', { type: 'checkbox' });
    var caseBox = D.h('input', { type: 'checkbox' });
    var linesBox = D.h('input', { type: 'checkbox' });

    var modeSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'all', text: t('mode_all', 'Replace all at once') }),
      D.h('option', { value: 'one', text: t('mode_one', 'Replace one by one') })
    );
    modeSelect.value = 'all';

    var statusEl = D.h('p.form-status');
    var listHost = D.h('div');
    var outPre = D.h('pre.code-body.mono');

    // 按钮只建一次，之后按模式显示/隐藏 ——
    // 每渲染一次就重建按钮，点下去的那个按钮会被换掉（焦点也会丢）。
    var replaceAllBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: t('btn_replace_all', 'Replace all')
    });
    replaceAllBtn.addEventListener('click', function () {
      var res = replaceAll(state.working, options());
      if (!res.ok) return;
      state.working = res.text;
      render();
    });
    var resetBtn = D.h('button.layui-btn', { type: 'button', text: t('btn_reset', 'Reset') });
    resetBtn.addEventListener('click', function () {
      state.working = input.value;
      render();
    });
    var actions = D.h('div.form-actions', null, replaceAllBtn, resetBtn);

    /** working 是「正在被编辑的那份文本」。 */
    var state = { mode: 'all', working: SAMPLE };

    function options() {
      return {
        find: findInput.value,
        replaceWith: replaceInput.value,
        useRegex: regexBox.checked,
        caseSensitive: caseBox.checked,
        splitLines: linesBox.checked
      };
    }

    /** 结果区里的文本：普通文本直接铺上去，命中的地方套一个 span 标出来。 */
    function renderOutput(text, matches) {
      D.clear(outPre);
      if (!matches || !matches.length) {
        outPre.textContent = text;
        return;
      }
      var pos = 0;
      matches.forEach(function (m) {
        if (m.index > pos) outPre.appendChild(document.createTextNode(text.slice(pos, m.index)));
        outPre.appendChild(D.h('span', {
          style: { backgroundColor: HIT_BG, color: HIT_FG, fontWeight: '600' }
        }, text.slice(m.index, m.index + m.length)));
        pos = m.index + m.length;
      });
      if (pos < text.length) outPre.appendChild(document.createTextNode(text.slice(pos)));
    }

    /** 命中列表：每一处一行，带上下文和一个替换按钮。 */
    function renderMatches(text, matches) {
      D.clear(listHost);
      if (!matches.length) return;
      var tbody = D.h('tbody');
      matches.forEach(function (m, i) {
        var ctx = contextFor(text, m);
        var btn = D.h('button.layui-btn.layui-btn-sm', {
          type: 'button', text: t('btn_replace_one', 'Replace')
        });
        btn.addEventListener('click', function () { applyOne(m); });
        tbody.appendChild(D.h('tr', null,
          D.h('td.val.nowrap', { text: String(i + 1) }),
          D.h('td.val', null,
            D.h('span', { text: ctx.before }),
            D.h('span', { style: { backgroundColor: HIT_BG, color: HIT_FG, fontWeight: '600' }, text: ctx.matched }),
            D.h('span', { text: ctx.after })
          ),
          D.h('td.val.nowrap', null, btn)
        ));
      });
      listHost.appendChild(D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_index', 'No.') }),
          D.h('th', { text: t('col_context', 'Context') }),
          D.h('th', { text: t('col_action', 'Action') })
        )),
        tbody
      ));
    }

    /**
     * 替换某一处命中。
     *
     * 按「位置 + 长度」重新找一次，而不是直接用按钮上记的序号 ——
     * 列表每替换一次就会重画，按钮上的序号立刻就过期了
     * （harness 会把页面上所有按钮挨个点一遍，点到的可能是已经脱树的旧按钮）。
     */
    function applyOne(m) {
      var o = options();
      var found = findMatches(state.working, o);
      if (!found.ok) return;
      var idx = -1;
      for (var i = 0; i < found.matches.length; i++) {
        if (found.matches[i].index === m.index && found.matches[i].length === m.length) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return;
      var res = replaceOccurrence(state.working, o, idx);
      if (!res.ok) return;
      state.working = res.text;
      render();
    }

    /** 按钮条随模式变：「全部替换」模式下结果本来就是实时的，没有按钮。 */
    function renderActions() {
      var show = state.mode === 'one';
      replaceAllBtn.style.display = show ? '' : 'none';
      resetBtn.style.display = show ? '' : 'none';
    }

    function render() {
      var o = options();
      var built = buildRegex(o.find, o.useRegex, o.caseSensitive);

      D.clear(listHost);

      if (!built.re) {
        statusEl.classList.add('is-error');
        statusEl.textContent = t('err_invalid_regex', 'Invalid regular expression: {message}')
          .replace('{message}', function () { return cleanRegexError(built.error); });
        renderOutput(state.working, null);
        renderActions();
        return;
      }
      statusEl.classList.remove('is-error');

      if (state.mode === 'all') {
        var res = replaceAll(state.working, o);
        renderOutput(res.text, null);
        statusEl.textContent = res.count === 1
          ? t('status_matches_one', '1 match found')
          : t('status_matches', '{n} matches found')
              .replace('{n}', function () { return String(res.count); });
      } else {
        var found = findMatches(state.working, o);
        renderOutput(state.working, found.matches);
        renderMatches(state.working, found.matches);
        statusEl.textContent = found.matches.length === 1
          ? t('status_pending_one', '1 match left to replace')
          : t('status_pending', '{n} matches left to replace')
              .replace('{n}', function () { return String(found.matches.length); });
      }
      renderActions();
    }

    var offs = [
      D.on(input, 'input', function () {
        state.working = input.value;
        render();
      }),
      D.on(findInput, 'input', render),
      D.on(replaceInput, 'input', render),
      D.on(regexBox, 'change', render),
      D.on(caseBox, 'change', render),
      D.on(linesBox, 'change', render),
      D.on(modeSelect, 'change', function () {
        state.mode = modeSelect.value === 'one' ? 'one' : 'all';
        state.working = input.value;
        render();
      })
    ];

    root.appendChild(D.h('div.card', null,
      U.field(t('input_label', 'Text to search and replace:'), input, { wide: true }),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('find_label', 'Find what:') }),
        findInput
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('replace_label', 'Replace with:') }),
        replaceInput
      ),
      D.h('div.switch-grid', null,
        D.h('label.switch', null, regexBox,
          D.h('span', { text: t('opt_regex', 'Regular expression') })),
        D.h('label.switch', null, caseBox,
          D.h('span', { text: t('opt_match_case', 'Match case') })),
        D.h('label.switch', null, linesBox,
          D.h('span', { text: t('opt_split_lines', 'Split into lines') }))
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('mode_label', 'Replace mode:') }),
        modeSelect
      ),
      D.h('p.field-hint', { text: t('hint_regex', 'In regular expression mode the replacement may use $1, $2 and $& to refer to the captured groups. With the switch off the replacement is taken literally.') }),
      D.h('p.field-hint', { text: t('hint_split_lines', 'Split into lines searches the text line by line: a match never spans two lines, and ^ and $ match at the start and the end of every line.') }),
      D.h('p.field-hint', { text: t('hint_mode', 'Replace all at once rewrites the whole text as you type. Replace one by one lists every match with its surroundings, and each one gets its own Replace button.') }),
      actions
    ));

    root.appendChild(D.h('div.card.code-card', null,
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('output_label', 'Result') }),
        U.copyButton(function () { return outPre.textContent; })
      ),
      statusEl,
      listHost,
      outPre
    ));

    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['smart-text-replacer'] = {
    escapeRegExp: escapeRegExp,
    buildRegex: buildRegex,
    splitLines: splitLines,
    execAll: execAll,
    findMatches: findMatches,
    replaceAll: replaceAll,
    replaceOccurrence: replaceOccurrence,
    contextFor: contextFor,
    __cases: function (assert) {
      /* ---- 正则的构造 ---- */
      assert.eq(escapeRegExp('a.b*c'), 'a\\.b\\*c', '元字符被转义');
      assert.eq(escapeRegExp('(x)'), '\\(x\\)', '括号也被转义');
      assert(buildRegex('[', true, false).re === null, '非法正则返回 null');
      assert(buildRegex('[', true, false).error !== null, '非法正则给出错误信息');
      assert(buildRegex('a', true, true).re.flags.indexOf('i') < 0, '区分大小写时不带 i 标志');
      assert(buildRegex('a', true, false).re.flags.indexOf('i') >= 0, '不区分大小写时带 i 标志');

      /* ---- 拆行 ---- */
      assert.eq(splitLines('a\nb').length, 2, '两行');
      assert.eq(splitLines('a\nb')[0].content, 'a', '第一行的内容');
      assert.eq(splitLines('a\nb')[0].sep, '\n', '行尾分隔符单独记着');
      assert.eq(splitLines('a\r\nb')[0].sep, '\r\n', 'CRLF 原样保留');
      assert.eq(splitLines('a\n').length, 2, '结尾的换行算一行空行');
      assert.eq(splitLines('').length, 1, '空串是一行');

      /* ---- 查找 ---- */
      var m = findMatches('foo bar foo', { find: 'foo', useRegex: false, caseSensitive: true });
      assert.eq(m.matches.length, 2, '两处命中');
      assert.eq(m.matches[0].index, 0, '第一处在 0');
      assert.eq(m.matches[1].index, 8, '第二处在 8');
      assert.eq(m.matches[0].length, 3, '命中长度 3');
      assert.eq(findMatches('foo', { find: '', useRegex: false, caseSensitive: true }).matches.length, 0,
        '查找串为空时没有命中');
      assert.eq(findMatches('Foo', { find: 'foo', useRegex: false, caseSensitive: false }).matches.length, 1,
        '不区分大小写时能命中');
      assert.eq(findMatches('Foo', { find: 'foo', useRegex: false, caseSensitive: true }).matches.length, 0,
        '区分大小写时命不中');
      assert.eq(findMatches('a.b', { find: 'a.b', useRegex: false, caseSensitive: true }).matches.length, 1,
        '字面量模式下 . 不是通配符');
      assert.eq(findMatches('axb', { find: 'a.b', useRegex: true, caseSensitive: true }).matches.length, 1,
        '正则模式下 . 是通配符');
      assert.eq(findMatches('[', { find: '[', useRegex: true, caseSensitive: true }).ok, false,
        '非法正则不抛异常，只是 ok=false');

      /* ---- 全部替换 ---- */
      var o1 = { find: 'foo', replaceWith: 'bar', useRegex: false, caseSensitive: true };
      var r1 = replaceAll('foo bar foo', o1);
      assert.eq(r1.ok, true, '替换成功');
      assert.eq(r1.text, 'bar bar bar', '全部替换');
      assert.eq(r1.count, 2, '命中两次');

      // 字面量模式：替换串里的 $1 是字面量
      assert.eq(replaceAll('foo', { find: 'foo', replaceWith: '$1', useRegex: false, caseSensitive: true }).text,
        '$1', '字面量模式下 $1 不展开');
      // 正则模式：替换串里的 $1 / $& 由引擎展开
      assert.eq(replaceAll('John Smith', { find: '(\\w+) (\\w+)', replaceWith: '$2 $1', useRegex: true, caseSensitive: true }).text,
        'Smith John', '正则模式下 $1 $2 交换');
      assert.eq(replaceAll('abc', { find: 'b', replaceWith: '[$&]', useRegex: true, caseSensitive: true }).text,
        'a[b]c', '正则模式下 $& 是整个命中');
      // 正则模式下 $1 是字面量（没有捕获组）
      assert.eq(replaceAll('abc', { find: 'b', replaceWith: '$1', useRegex: true, caseSensitive: true }).text,
        'a$1c', '没有捕获组时 $1 原样保留');

      /* ---- 按行拆分 ---- */
      var ol = { find: 'x', replaceWith: 'y', useRegex: false, caseSensitive: true, splitLines: true };
      assert.eq(replaceAll('x\nx', ol).text, 'y\ny', '按行拆分：每行各自替换');
      assert.eq(replaceAll('x\nx', ol).count, 2, '按行拆分：命中两次');
      assert.eq(findMatches('ab\ncd', { find: 'b', useRegex: false, caseSensitive: true, splitLines: true }).matches[0].index,
        1, '按行拆分：命中位置是整段里的位置');
      // 不按行拆分时，命中可以跨行
      assert.eq(findMatches('a\nb', { find: 'a\\nb', useRegex: true, caseSensitive: true }).matches.length, 1,
        '不按行拆分时命中可以跨行');
      assert.eq(findMatches('a\nb', { find: 'a\\nb', useRegex: true, caseSensitive: true, splitLines: true }).matches.length, 0,
        '按行拆分时命中不会跨行');
      // CRLF 不被改掉
      assert.eq(replaceAll('x\r\nx', ol).text, 'y\r\ny', '按行拆分：CRLF 原样保留');

      /* ---- 逐个替换 ---- */
      var oo = { find: 'foo', replaceWith: 'X', useRegex: false, caseSensitive: true };
      assert.eq(replaceOccurrence('foo bar foo', oo, 0).text, 'X bar foo', '替换第一处');
      assert.eq(replaceOccurrence('foo bar foo', oo, 1).text, 'foo bar X', '替换第二处');
      assert.eq(replaceOccurrence('foo', oo, 5).ok, false, '序号越界时不改文本');
      assert.eq(replaceOccurrence('foo', oo, -1).ok, false, '负序号不改文本');
      // 逐个替换也保留 $ 的语义
      assert.eq(replaceOccurrence('John Smith', {
        find: '(\\w+) (\\w+)', replaceWith: '$2 $1', useRegex: true, caseSensitive: true
      }, 0).text, 'Smith John', '逐个替换时 $1 $2 也展开');
      // 按行拆分时粘性正则必须落在那一行里（否则 ^ 会失配）
      assert.eq(replaceOccurrence('abc\nabc', {
        find: '^abc', replaceWith: 'X', useRegex: true, caseSensitive: true, splitLines: true
      }, 1).text, 'abc\nX', '按行拆分时替换第二行的行首');

      /* ---- 上下文 ---- */
      var ctx = contextFor('hello world', { index: 6, length: 5 });
      assert.eq(ctx.before, 'hello ', '上下文前半段');
      assert.eq(ctx.matched, 'world', '上下文命中段');
      assert.eq(ctx.after, '', '上下文后半段');
      var ctx2 = contextFor('abc', { index: 0, length: 1 });
      assert.eq(ctx2.before, '', '开头的上下文为空');
      assert.eq(ctx2.after, 'bc', '结尾的上下文');
    }
  };
})();
