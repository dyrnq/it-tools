/* ==========================================================================
   重复行查找（duplicate-line-finder）

   找出一段文本里出现两次以上的行，列出每一行和它出现的次数。

   参考实现：src/tools/duplicate-line-finder/（it-tools2 的 fork，Vue 写的）
   与上游的差别：
   1. 上游的第二个输入框是「清理用的正则」，而计算那一层把这个正则**原样**
      交给 new RegExp()：正则写错时整块工具的计算会抛异常（上游只在表单层
      做了校验，计算层没有兜底 —— 校验过了不代表计算层不会再炸）。
      这里没有正则，改成两个明确的开关（忽略首尾空白 / 忽略大小写）：
      想按正则清理的用户可以自己先清理好再贴进来。
   2. 上游的输出只是「重复行的清单」（uniq 之后按首次出现顺序 join），
      没有次数，也没有排序。这里给的是「行 + 出现次数」的表：按次数降序，
      次数相同按首次出现的先后排 —— 结果可复现。
   3. 上游按 '\n' 切行，CRLF 的文本会把 '\r' 留在每行行尾（"a\r" 和 "a"
      于是算两行）。这里 CRLF / CR / LF 都算换行。
   4. 上游用 filter(val => val && …) 排除空行，但**纯空白行**（只有一个空格）
      会被算进去；这里空行和纯空白行都不参与统计。
   5. 上游的正则清理是「从行里删掉匹配到的字符」（replace），跟本工具
      「按首尾空白 / 大小写归并」不是一回事；上游那套能力没有照搬。

   不依赖任何第三方库。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('duplicate-line-finder');

  /**
   * 切行：CRLF / CR / LF 都算换行；末尾那个换行不额外造出一行。
   * 空文本没有行。
   */
  function splitLines(text) {
    var s = text == null ? '' : String(text);
    if (!s) return [];
    s = s.replace(/\r\n$|\r$|\n$/, '');
    if (!s) return [];
    return s.split(/\r\n|\r|\n/);
  }

  /**
   * 一行参与比较时用的键。展示用的原文不受影响 —— 打开开关时仍然显示
   * 第一次出现的那一行的原文（复制出去的内容跟输入里一模一样）。
   */
  function lineKey(line, opts) {
    opts = opts || {};
    var s = String(line);
    if (opts.ignoreWhitespace) s = s.trim();
    if (opts.ignoreCase) s = s.toLowerCase();
    return s;
  }

  /**
   * 找出重复的行。
   *
   * @param {string} text
   * @param {{ignoreWhitespace?:boolean, ignoreCase?:boolean}} [opts]
   * @returns {{rows: {line:string,count:number,first:number}[], lines:number, counted:number}}
   *   rows    出现次数 ≥ 2 的行，按次数降序、次数相同按首次出现先后
   *   lines   切出来的总行数
   *   counted 参与统计的行数（去掉空行和纯空白行之后）
   */
  function findDuplicates(text, opts) {
    opts = opts || {};
    var lines = splitLines(text);
    var groups = new Map();
    var counted = 0;
    var i;
    for (i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (!/\S/.test(raw)) continue;      // 空行、纯空白行不参与统计
      counted++;
      var key = lineKey(raw, opts);
      var g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { line: raw, count: 1, first: i });
    }
    var rows = [];
    groups.forEach(function (g) {
      if (g.count >= 2) rows.push(g);
    });
    rows.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.first - b.first;
    });
    return { rows: rows, lines: lines.length, counted: counted };
  }

  /** 重复行的清单（一行一个）—— 复制 / 下载用的就是它。 */
  function duplicatesToText(result) {
    return result.rows.map(function (r) { return r.line; }).join('\n');
  }

  window.ItTools.register('duplicate-line-finder', function (root) {
    var opts = { ignoreWhitespace: false, ignoreCase: false };

    var textarea = D.h('textarea.layui-textarea', {
      rows: 10,
      placeholder: t('input_ph', 'Paste the text whose lines you want to check for duplicates.'),
      spellcheck: 'false'
    });

    var status = D.h('p.field-hint');
    var tbody = D.h('tbody');
    var table = D.h('table.result-table', null,
      D.h('thead', null, D.h('tr', null,
        D.h('th', { text: t('col_line', 'Line') }),
        D.h('th', { text: t('col_count', 'Occurrences') })
      )),
      tbody
    );

    function currentResult() {
      return findDuplicates(textarea.value, opts);
    }

    function render() {
      var result = currentResult();
      D.clear(tbody);
      result.rows.forEach(function (row) {
        tbody.appendChild(D.h('tr', null,
          D.h('td', null,
            // 行内容原样显示：默认的 white-space: normal 会把行首行尾的空白
            // 和中间的连续空格吃掉，而「哪一行重复了」正是这个工具要回答的，
            // 显示出来的必须跟输入里一模一样。
            D.h('span', {
              style: {
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
              },
              text: row.line
            }),
            ' ',
            U.copyButton(function () { return row.line; })
          ),
          D.h('td', { text: String(row.count) })
        ));
      });

      // 空表只剩一个表头，看着像出错了 —— 没有重复行时干脆把表收起来。
      table.style.display = result.rows.length ? '' : 'none';

      if (!result.lines) {
        status.textContent = t('status_empty', 'Type or paste some text to find duplicated lines.');
      } else if (!result.rows.length) {
        status.textContent = t('status_none', 'No duplicated line found.');
      } else {
        status.textContent = t('status_found', '{count} duplicated line(s) found.')
          .replace('{count}', String(result.rows.length));
      }
    }

    textarea.addEventListener('input', render);

    var toggles = [
      { key: 'ignoreWhitespace', label: t('ignore_whitespace', 'Ignore leading and trailing whitespace') },
      { key: 'ignoreCase', label: t('ignore_case', 'Ignore case') }
    ].map(function (tg) {
      var input = D.h('input', { type: 'checkbox' });
      input.addEventListener('change', function () {
        opts[tg.key] = input.checked;
        render();
      });
      return D.h('label.switch', null, input, D.h('span', { text: tg.label }));
    });

    var copyAll = U.copyButton(function () {
      return duplicatesToText(currentResult());
    }, t('copy_all', 'Copy all lines'));

    var downloadBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button',
      text: t('download', 'Download'),
      onclick: function () {
        var text = duplicatesToText(currentResult());
        if (!text) return;
        window.ItTools.download('duplicate-lines.txt', text, 'text/plain;charset=utf-8');
      }
    });

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your text:'), textarea, { wide: true }),
      D.h('div.switch-grid', null, toggles),
      D.h('p.field-hint', {
        text: t('note_options', 'Empty lines are ignored. With the options on, lines that differ only by surrounding whitespace or letter case count as the same line; the first occurrence is the one listed.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.code-label', { style: { marginBottom: '8px' }, text: t('result', 'Duplicated lines') }),
      status,
      table,
      D.h('div.form-actions', null, copyAll, downloadBtn)
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['duplicate-line-finder'] = {
    splitLines: splitLines,
    lineKey: lineKey,
    findDuplicates: findDuplicates,
    duplicatesToText: duplicatesToText,
    __cases: function (assert) {
      /* ---- 切行 ---- */
      assert.eq(splitLines(''), [], '空文本没有行');
      assert.eq(splitLines('a'), ['a'], '单行');
      assert.eq(splitLines('a\nb'), ['a', 'b'], '按换行切');
      assert.eq(splitLines('a\n'), ['a'], '末尾换行不造出空行');
      assert.eq(splitLines('a\r\nb'), ['a', 'b'], 'CRLF 算一个换行（上游会留下 \\r）');
      assert.eq(splitLines('a\r\nb\r\n'), ['a', 'b'], 'CRLF 结尾也不造空行');
      assert.eq(splitLines('a\rb'), ['a', 'b'], '单独的 CR 也算换行');
      assert.eq(splitLines('a\n\nb'), ['a', '', 'b'], '中间的空行保留');

      /* ---- 比较键 ---- */
      assert.eq(lineKey('  Foo  ', {}), '  Foo  ', '默认原样比较');
      assert.eq(lineKey('  Foo  ', { ignoreWhitespace: true }), 'Foo', '忽略首尾空白');
      assert.eq(lineKey('a b', { ignoreWhitespace: true }), 'a b', '只忽略首尾，不动中间的空白');
      assert.eq(lineKey('Foo', { ignoreCase: true }), 'foo', '忽略大小写');
      assert.eq(lineKey('  Foo  ', { ignoreWhitespace: true, ignoreCase: true }), 'foo', '两个开关一起开');

      /* ---- 找重复行 ---- */
      var r = findDuplicates('a\nb\na\nb\nc');
      assert.eq(r.rows.map(function (x) { return x.line + ':' + x.count; }), ['a:2', 'b:2'], '两行各出现两次');
      assert.eq(r.lines, 5, '一共 5 行');
      assert.eq(r.counted, 5, '5 行都参与统计');

      r = findDuplicates('a\na\na');
      assert.eq(r.rows.map(function (x) { return x.line + ':' + x.count; }), ['a:3'], '出现三次算一行');
      assert.eq(r.rows[0].first, 0, '记下首次出现的位置');

      r = findDuplicates('x\na\na\nx');
      assert.eq(r.rows.map(function (x) { return x.line + ':' + x.count; }), ['x:2', 'a:2'], '次数相同按首次出现先后排');
      assert.eq(r.rows[0].first, 0, 'x 先出现');
      assert.eq(r.rows[1].first, 1, 'a 后出现');

      r = findDuplicates('a\nb\nb');
      assert.eq(r.rows.map(function (x) { return x.line + ':' + x.count; }), ['b:2'], '只出现一次的行不列');
      assert.eq(findDuplicates('a\nb').rows, [], '没有重复行时结果为空');
      assert.eq(findDuplicates('').rows, [], '空文本没有重复行');

      /* ---- 次数不同按次数降序 ---- */
      r = findDuplicates('a\na\nb\nb\nb');
      assert.eq(r.rows.map(function (x) { return x.line + ':' + x.count; }), ['b:3', 'a:2'], '次数多的排前面');

      /* ---- 空行不参与统计 ---- */
      r = findDuplicates('a\n\na');
      assert.eq(r.rows.map(function (x) { return x.line + ':' + x.count; }), ['a:2'], '空行不算一次出现');
      assert.eq(r.counted, 2, '空行不计入参与统计的行数');
      r = findDuplicates('a\n   \na');
      assert.eq(r.rows.map(function (x) { return x.line + ':' + x.count; }), ['a:2'], '纯空白行也不参与');
      assert.eq(findDuplicates('\n\n\n').rows, [], '全是空行时没有重复行');

      /* ---- 开关 ---- */
      assert.eq(findDuplicates('a\nA').rows, [], '默认区分大小写，a 与 A 是两行');
      assert.eq(findDuplicates('a\nA', { ignoreCase: true }).rows.map(function (x) { return x.line + ':' + x.count; }),
        ['a:2'], '忽略大小写后算一行，显示的是第一次出现的那一行');
      assert.eq(findDuplicates('  a  \na', { ignoreWhitespace: true }).rows.map(function (x) { return x.line + ':' + x.count; }),
        ['  a  :2'], '忽略首尾空白后算一行，原文照样保留');
      assert.eq(findDuplicates('a b\na b', { ignoreWhitespace: true }).rows.length, 1, '中间的空白不动');

      /* ---- 复制 / 下载用的文本 ---- */
      assert.eq(duplicatesToText(findDuplicates('a\nb\na\nb\nc')), 'a\nb', '清单是一行一个');
      assert.eq(duplicatesToText(findDuplicates('a')), '', '没有重复行时是空串');
    }
  };
})();
