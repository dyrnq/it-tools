/* ==========================================================================
   编辑距离计算器（levenshtein-calculator）

   算两个字符串的 Levenshtein 距离（插入 / 删除 / 替换各算 1），
   给出相似度百分比、最长公共子序列的长度，以及把两串对齐后的对照。

   参考实现：src/tools/levenshtein-calculator/（it-tools2，Vue）
   与上游那版的差别：
   1. 上游用的是 damerau-levenshtein —— 那是 **Damerau** 距离，
      相邻两个字符对调算 1 次（"ca" vs "ac" = 1），
      而工具名字叫「Levenshtein」，任务书也写明「插入/删除/替换各算 1」。
      这里按**纯 Levenshtein** 算（"ca" vs "ac" = 2），
      跟工具名和任务书对得上；不要照抄上游的库。
   2. 上游的结果卡是 `v-if="result"` —— 两个空串时距离是 0，
      0 是假值，整张结果卡**根本不显示**。空串在这里是合法输入
      （距离就是另一串的长度），所以结果永远显示。
   3. 上游只给距离、相对距离、相似度三个数。**最长公共子序列的长度**
      和**对齐后的对照**是这里补的（上游没有）——
      只给一个距离数字，对「到底哪里不一样」没有任何帮助。
      对照按侧栏排：左边第一串、右边第二串，中间用 | 分栏，
      某一侧没有对应字符的位置用 - 补空缺。

   字符按**码点**算（一个 emoji 是一个字符），宽度按「东亚宽字符占两格」
   算 —— 对齐要排成表，CJK / emoji 算一格的话竖线会歪。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('levenshtein-calculator');

  /* 东亚宽字符（占两格）的码点区间 —— 跟下面 charWidth 用的是同一份表，
     渲染时 U.monoCjk 用的也是这一份，「算两格」和「渲染两格」必须一致。 */
  var WIDE_CJK_RANGES = [
    [0x1100, 0x115f],   // 谚文字母
    [0x2e80, 0x303e],   // CJK 部首、康熙部首、CJK 符号与标点
    [0x3041, 0x33ff],   // 假名、注音、兼容汉字、韩文兼容
    [0x3400, 0x4dbf],   // CJK 扩展 A
    [0x4e00, 0x9fff],   // CJK 统一表意文字
    [0xa000, 0xa4cf],   // 彝文
    [0xac00, 0xd7a3],   // 韩文音节
    [0xf900, 0xfaff],   // CJK 兼容表意文字
    [0xfe10, 0xfe19],   // 竖排标点
    [0xfe30, 0xfe6f],   // CJK 兼容形式
    [0xff00, 0xff60],   // 全角形式
    [0xffe0, 0xffe6],
    [0x20000, 0x3fffd]  // CJK 扩展 B 及以后
  ];
  var WIDE_EMOJI_RANGES = [
    [0x1f300, 0x1f64f],
    [0x1f680, 0x1f6ff],
    [0x1f900, 0x1f9ff]
  ];

  /** 超过这个格子数就不做对齐了（对齐要开整张 DP 表） */
  var MAX_ALIGN_CELLS = 1000000;

  function inRanges(code, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (code >= ranges[i][0] && code <= ranges[i][1]) return true;
    }
    return false;
  }

  /** 一个码点占几格（东亚宽字符占两格） */
  function charWidth(code) {
    if (code < 0x1100) return 1;
    return (inRanges(code, WIDE_CJK_RANGES) || inRanges(code, WIDE_EMOJI_RANGES)) ? 2 : 1;
  }

  /** 一段文字的显示宽度（几格） */
  function displayWidth(text) {
    var chars = Array.from(String(text == null ? '' : text));
    var width = 0;
    for (var i = 0; i < chars.length; i++) width += charWidth(chars[i].codePointAt(0));
    return width;
  }

  /** 补空格到指定宽度（宽度按显示宽度算，CJK 占两格） */
  function padTo(text, width) {
    var pad = width - displayWidth(text);
    return pad > 0 ? text + ' '.repeat(pad) : text;
  }

  /** 码点数组：一个 emoji 是一个字符（不是 UTF-16 的两个码元） */
  function chars(text) {
    return Array.from(String(text == null ? '' : text));
  }

  /**
   * Levenshtein 距离：插入 / 删除 / 替换各算 1。
   *
   * 只用两行 DP（空间 O(min(n, m))）—— 距离本身不需要整张表。
   */
  function levenshtein(a, b) {
    var s = chars(a);
    var u = chars(b);
    var n = s.length;
    var m = u.length;
    if (!n) return m;
    if (!m) return n;
    var prev = new Array(m + 1);
    var cur = new Array(m + 1);
    for (var j = 0; j <= m; j++) prev[j] = j;
    for (var i = 1; i <= n; i++) {
      cur[0] = i;
      for (j = 1; j <= m; j++) {
        var cost = s[i - 1] === u[j - 1] ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[m];
  }

  /**
   * 最长公共子序列的长度（**这里补的**，上游只给距离）。
   * 同样只用两行 DP。
   */
  function lcsLength(a, b) {
    var s = chars(a);
    var u = chars(b);
    var n = s.length;
    var m = u.length;
    if (!n || !m) return 0;
    var prev = new Array(m + 1).fill(0);
    var cur = new Array(m + 1).fill(0);
    for (var i = 1; i <= n; i++) {
      cur[0] = 0;
      for (var j = 1; j <= m; j++) {
        if (s[i - 1] === u[j - 1]) cur[j] = prev[j - 1] + 1;
        else cur[j] = Math.max(prev[j], cur[j - 1]);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[m];
  }

  /**
   * 对齐用的操作序列。
   *
   * 每一步是 {type, a, b}：type 是 match / sub / del / ins，
   * a 是第一串的字符、b 是第二串的字符，没有的那边是 null。
   * 回溯时优先取「匹配」，其次「替换」，再「删除」，最后「插入」。
   */
  function alignOps(a, b) {
    var s = chars(a);
    var u = chars(b);
    var n = s.length;
    var m = u.length;
    var d = [];
    var i;
    var j;
    for (i = 0; i <= n; i++) {
      d.push(new Array(m + 1).fill(0));
      d[i][0] = i;
    }
    for (j = 0; j <= m; j++) d[0][j] = j;
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        var cost = s[i - 1] === u[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      }
    }
    var ops = [];
    i = n; j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && s[i - 1] === u[j - 1] && d[i][j] === d[i - 1][j - 1]) {
        ops.push({ type: 'match', a: s[i - 1], b: u[j - 1] }); i--; j--;
      } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
        ops.push({ type: 'sub', a: s[i - 1], b: u[j - 1] }); i--; j--;
      } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
        ops.push({ type: 'del', a: s[i - 1], b: null }); i--;
      } else {
        ops.push({ type: 'ins', a: null, b: u[j - 1] }); j--;
      }
    }
    ops.reverse();
    return ops;
  }

  /**
   * 把操作序列切成行：一行 = 一段匹配 + 紧跟其后的一次编辑。
   * 这样「改掉了一个字」跟它前后的上下文在同一行里，读起来像 diff。
   */
  function alignmentRows(ops) {
    var rows = [];
    var current = [];
    for (var i = 0; i < ops.length; i++) {
      current.push(ops[i]);
      if (ops[i].type !== 'match') { rows.push(current); current = []; }
    }
    if (current.length) rows.push(current);
    return rows;
  }

  /** 一行里两边的文字：没有对应字符的位置补 - （空缺） */
  function rowParts(row) {
    var a = '';
    var b = '';
    for (var i = 0; i < row.length; i++) {
      a += row[i].a === null ? '-' : row[i].a;
      b += row[i].b === null ? '-' : row[i].b;
    }
    return { a: a, b: b };
  }

  /**
   * 对齐后的对照文本（**这里补的**）。
   * 每行是「第一串 | 第二串」，左边补齐到同一宽度，竖线才对得齐。
   */
  function alignmentText(a, b) {
    var rows = alignmentRows(alignOps(a, b)).map(rowParts);
    var width = 0;
    for (var i = 0; i < rows.length; i++) {
      width = Math.max(width, displayWidth(rows[i].a));
    }
    var lines = [];
    for (i = 0; i < rows.length; i++) {
      lines.push(padTo(rows[i].a, width) + ' | ' + rows[i].b);
    }
    return lines.join('\n');
  }

  /**
   * 相似度：1 - 距离 / max(len1, len2)。
   * 两个空串时 max 是 0 —— 它们本来就是一样的，算 1（100%）。
   */
  function similarity(a, b) {
    var max = Math.max(chars(a).length, chars(b).length);
    if (max === 0) return 1;
    return 1 - levenshtein(a, b) / max;
  }

  /** 相似度的显示形式：两位小数的百分比 */
  function similarityPercent(a, b) {
    return (similarity(a, b) * 100).toFixed(2) + '%';
  }

  window.ItTools.register('levenshtein-calculator', function (root) {
    var textA = D.h('textarea.layui-textarea.mono', {
      rows: 6, spellcheck: 'false', placeholder: t('string_ph', 'Type something...')
    });
    var textB = D.h('textarea.layui-textarea.mono', {
      rows: 6, spellcheck: 'false', placeholder: t('string_ph', 'Type something...')
    });
    textA.value = 'kitten';
    textB.value = 'sitting';

    var statsBody = D.h('tbody');
    var alignPre = D.h('pre.code-body');
    var alignNote = D.h('p.field-hint');

    /** 复制用的一整段结果 */
    function resultText() {
      var a = textA.value;
      var b = textB.value;
      var lines = [
        t('distance', 'Levenshtein distance') + ': ' + levenshtein(a, b),
        t('similarity', 'Similarity') + ': ' + similarityPercent(a, b),
        t('lcs_length', 'Longest common subsequence') + ': ' + lcsLength(a, b)
      ];
      var align = alignmentFor(a, b);
      if (align === null) return lines.join('\n');
      return lines.join('\n') + '\n\n' + align;
    }

    /** 太长就不做对齐（要开整张 DP 表） */
    function alignmentFor(a, b) {
      var n = chars(a).length;
      var m = chars(b).length;
      if (n * m > MAX_ALIGN_CELLS) return null;
      return alignmentText(a, b);
    }

    function render() {
      var a = textA.value;
      var b = textB.value;
      var distance = levenshtein(a, b);

      D.clear(statsBody);
      statsBody.appendChild(D.h('tr', null,
        D.h('td', { text: t('distance', 'Levenshtein distance') }),
        D.h('td.val', { text: String(distance) })
      ));
      statsBody.appendChild(D.h('tr', null,
        D.h('td', { text: t('similarity', 'Similarity') }),
        D.h('td.val', { text: similarityPercent(a, b) })
      ));
      statsBody.appendChild(D.h('tr', null,
        D.h('td', { text: t('lcs_length', 'Longest common subsequence') }),
        D.h('td.val', { text: String(lcsLength(a, b)) })
      ));

      var align = alignmentFor(a, b);
      alignPre.textContent = align === null ? '' : align;
      if (align === null) {
        alignNote.textContent = t('align_too_long', 'The strings are too long to align — only the distance is shown.');
      } else if (!a && !b) {
        alignNote.textContent = t('both_empty', 'Both strings are empty, so they are identical.');
      } else {
        alignNote.textContent = t('align_hint', 'A gap is written as -, the two columns are separated by |.');
      }
    }

    // 距离与对齐都是 O(n·m) 的计算，粘一大段文本进来时每敲一个字都算一遍
    // 会把页面卡住 —— 跟 text-diff 一样防抖 150ms。
    var timer = null;
    function scheduleRender() {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () { timer = null; render(); }, 150);
    }

    var offs = [
      D.on(textA, 'input', scheduleRender),
      D.on(textB, 'input', scheduleRender)
    ];

    // 输入卡
    root.appendChild(D.h('div.card', null,
      U.field(t('string_a', 'First string'), textA, { wide: true }),
      U.field(t('string_b', 'Second string'), textB, { wide: true })
    ));

    // 结果卡
    root.appendChild(D.h('div.card.code-card', null,
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('result', 'Result') }),
        U.copyButton(function () { return resultText(); }, t('copy_result', 'Copy result'))
      ),
      D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_metric', 'Metric') }),
          D.h('th', { text: t('col_value', 'Value') })
        )),
        statsBody
      ),
      D.h('div.code-label', { text: t('alignment', 'Alignment') }),
      alignPre,
      alignNote,
      D.h('div.form-actions', null,
        U.copyButton(function () { return alignPre.textContent; }, t('copy_alignment', 'Copy alignment'))
      )
    ));

    // 让屏幕上的汉字/emoji 正好占两格，跟上面算宽度用的是同一批码点
    U.monoCjk(alignPre, [
      { kind: 'cjk', ranges: WIDE_CJK_RANGES },
      { kind: 'emoji', ranges: WIDE_EMOJI_RANGES }
    ]);
    U.monoCjk(textA, [
      { kind: 'cjk', ranges: WIDE_CJK_RANGES },
      { kind: 'emoji', ranges: WIDE_EMOJI_RANGES }
    ]);
    U.monoCjk(textB, [
      { kind: 'cjk', ranges: WIDE_CJK_RANGES },
      { kind: 'emoji', ranges: WIDE_EMOJI_RANGES }
    ]);

    render();

    return {
      destroy: function () {
        if (timer) { window.clearTimeout(timer); timer = null; }
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['levenshtein-calculator'] = {
    levenshtein: levenshtein,
    lcsLength: lcsLength,
    similarity: similarity,
    similarityPercent: similarityPercent,
    alignOps: alignOps,
    alignmentRows: alignmentRows,
    alignmentText: alignmentText,
    displayWidth: displayWidth,
    __cases: function (assert) {
      /* ---- 距离 ---- */
      assert.eq(levenshtein('', ''), 0, '两个空串');
      assert.eq(levenshtein('abc', ''), 3, '空串是合法输入：距离就是另一串的长度');
      assert.eq(levenshtein('', 'abc'), 3, '反过来也一样');
      assert.eq(levenshtein('abc', 'abc'), 0, '相同');
      assert.eq(levenshtein('abc', 'abd'), 1, '换一个字符');
      assert.eq(levenshtein('abc', 'ab'), 1, '删一个');
      assert.eq(levenshtein('ab', 'abc'), 1, '插一个');
      assert.eq(levenshtein('kitten', 'sitting'), 3, '经典例子');
      assert.eq(levenshtein('flaw', 'lawn'), 2, '经典例子 2');
      // 纯 Levenshtein：相邻字符对调算两次（上游的 Damerau 距离算一次）
      assert.eq(levenshtein('ca', 'ac'), 2, '对调算两次（不是 Damerau 距离）');
      assert.eq(levenshtein('ab', 'ba'), 2, 'ab vs ba 是 2');

      /* ---- 相似度 ---- */
      assert.eq(similarityPercent('abc', 'abc'), '100.00%', '相同是 100%');
      assert.eq(similarityPercent('', ''), '100.00%', '两个空串也是 100%（不报 NaN）');
      assert.eq(similarityPercent('abc', ''), '0.00%', '跟空串没有共同');
      assert.eq(similarityPercent('abc', 'abd'), '66.67%', '两位小数');
      assert.eq(similarity('abc', 'abc'), 1, 'similarity 返回 0..1 的数');

      /* ---- 最长公共子序列 ---- */
      assert.eq(lcsLength('', ''), 0, '空串');
      assert.eq(lcsLength('abc', 'abc'), 3, '相同');
      assert.eq(lcsLength('abc', ''), 0, '跟空串没有公共');
      assert.eq(lcsLength('kitten', 'sitting'), 4, 'kitten 与 sitting 的公共子序列长度是 4');
      assert.eq(lcsLength('abc', 'axc'), 2, 'ac');
      assert.eq(lcsLength('AGGA', 'AGA'), 3, 'AGA');

      /* ---- 对齐 ---- */
      var rows = alignmentRows(alignOps('abc', 'axc'));
      assert.eq(rows.length, 2, 'abc vs axc 分成两行');
      assert.eq(rows[0][0].type, 'match', '第一行开头是匹配');
      assert.eq(rows[0][1].type, 'sub', '跟着的是替换');
      assert.eq(rows[0][1].a, 'b', '被换掉的是 b');
      assert.eq(rows[0][1].b, 'x', '换成了 x');
      assert.eq(rows[1][0].a, 'c', '最后一行是 c');

      assert.eq(alignmentText('abc', 'axc'), 'ab | ax\nc  | c', '对照：竖线分栏、左列补齐');

      // 空缺：一边多一个字符，那边补 -
      assert.eq(alignmentText('abc', 'abxc'), 'ab- | abx\nc   | c', '多出来的位置补 -');
      assert.eq(alignmentText('abxc', 'abc'), 'abx | ab-\nc   | c', '反过来也一样');

      // 两边都空
      assert.eq(alignmentText('', ''), '', '两个空串没有对照');
      assert.eq(alignmentText('abc', ''), 'a | -\nb | -\nc | -', '一整列都是空缺');

      // 经典例子的对照
      assert.eq(alignmentText('kitten', 'sitting'), 'k    | s\nitte | itti\nn-   | ng', 'kitten vs sitting');

      // 距离与对齐一致：对齐里非 match 的步数就是距离
      [
        ['kitten', 'sitting'], ['abc', 'xyz'], ['abcdef', 'azced'], ['', 'abc'],
        ['abc', ''], ['same', 'same'], ['a', 'b']
      ].forEach(function (pair) {
        var ops = alignOps(pair[0], pair[1]);
        var edits = ops.filter(function (op) { return op.type !== 'match'; }).length;
        assert.eq(edits, levenshtein(pair[0], pair[1]),
          '对齐的编辑步数等于距离：' + JSON.stringify(pair));
      });

      /* ---- 显示宽度：CJK 与 emoji 占两格 ---- */
      assert.eq(displayWidth('abc'), 3, '拉丁字符一格');
      assert.eq(displayWidth('中文'), 4, '两个汉字四格');
      assert.eq(displayWidth('😀'), 2, 'emoji 两格');
      assert.eq(padTo('ab', 5), 'ab   ', '补空格到指定宽度');
    }
  };
})();
