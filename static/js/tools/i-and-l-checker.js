/* ==========================================================================
   形近字符检查（i-and-l-checker）

   把一段文本里容易看错的字符（1 / l / I / 0 / O，以及 | {} [] ()）逐个标出来，
   给出每一类出现了几次，并给一句结论 —— 这东西是给密码、标识符看的：
   「这段文本里有 3 处形近字符」比「密码强度：中」有用得多。

   参考实现：src/tools/i-and-l-checker/（it-tools, GPLv3）
   与上游的差别：
   1. 上游只认 5 个字符（I l 1 0 O），这里多给 | {} [] () 四类，
      而且每一类都能单独开关（上游没有开关）。
   2. 上游的配色是纯饱和底色（#0040f3 / #e74c3c 这种）且不改字色 ——
      深蓝底上的黑字、深紫底上的黑字基本看不清。
      这里改成「浅底 + 深字」，亮色主题和暗色主题下都读得清。
   3. 上游用 `inputText.split('')` 逐**码元**切：一个 emoji 会被切成两个
      代理项，渲染成两个格子（还多一个空 span）。这里按**码点**切
      （Array.from），emoji 是一个整体。
   4. 上游给每个字符都套两层 span（外层一个、内层高亮一个），
      这里只给高亮的字符加底色，DOM 小一半，复制出来的文本一样。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('i-and-l-checker');

  /**
   * 宽字符区间。
   *
   * 这张表有两个用处：算显示宽度，以及给 CSS 的 unicode-range ——
   * 「算两格」跟「渲染两格」必须落在同一批码点上，否则照样歪。
   * emoji 单列一张：它要用彩色 emoji 字体，不能跟 CJK 字体混。
   */
  var WIDE_CJK_RANGES = [
    [0x1100, 0x115f],   // 谚文字母
    [0x2e80, 0x303e],   // CJK 部首、康熙部首、CJK 符号与标点
    [0x3041, 0x33ff],   // 假名、注音、兼容汉字、韩文兼容
    [0x3400, 0x4dbf],   // CJK 扩展 A
    [0x4e00, 0x9fff],   // CJK 统一表义文字
    [0xa000, 0xa4cf],   // 彝文
    [0xac00, 0xd7a3],   // 韩文音节
    [0xf900, 0xfaff],   // CJK 兼容表义文字
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

  /**
   * 形近字符的分组。
   *
   * chars 是这一类包含的**字符**（不是「组合」）：{} 这一类管 { 和 } 两个字符，
   * 各自单独出现也算 —— 一个没配对的 { 一样值得标出来。
   * 各类互不重叠，一个字符最多落进一类。
   */
  var GROUPS = [
    { id: 'one', sample: '1', chars: '1', bg: '#ffe3e0', fg: '#b3261e' },
    { id: 'lower_l', sample: 'l', chars: 'l', bg: '#fff0d4', fg: '#8a5300' },
    { id: 'upper_i', sample: 'I', chars: 'I', bg: '#e2ecff', fg: '#1b4fbd' },
    { id: 'zero', sample: '0', chars: '0', bg: '#ddf3ea', fg: '#0a6b58' },
    { id: 'upper_o', sample: 'O', chars: 'O', bg: '#f1e4ff', fg: '#6b2fb3' },
    { id: 'pipe', sample: '|', chars: '|', bg: '#e6e6e6', fg: '#3d3d3d' },
    { id: 'braces', sample: '{}', chars: '{}', bg: '#ffe8f0', fg: '#a3165b' },
    { id: 'brackets', sample: '[]', chars: '[]', bg: '#e6f6ff', fg: '#0b6ea8' },
    { id: 'parens', sample: '()', chars: '()', bg: '#f0f4dd', fg: '#5d6b1f' }
  ];

  /** 每一类的显示名（走 i18n，键是字面量） */
  function groupLabel(id) {
    switch (id) {
      case 'one': return t('opt_one', 'Number 1 (1)');
      case 'lower_l': return t('opt_lower_l', 'Lowercase L (l)');
      case 'upper_i': return t('opt_upper_i', 'Uppercase I (I)');
      case 'zero': return t('opt_zero', 'Number 0 (0)');
      case 'upper_o': return t('opt_upper_o', 'Uppercase O (O)');
      case 'pipe': return t('opt_pipe', 'Vertical bar (|)');
      case 'braces': return t('opt_braces', 'Curly braces ({ })');
      case 'brackets': return t('opt_brackets', 'Square brackets ([ ])');
      case 'parens': return t('opt_parens', 'Round brackets (( ))');
      default: return id;
    }
  }

  /**
   * 某个字符属于哪一类（只算开着的类）。
   * @returns {object|null} 所属的组，不属于任何一类时返回 null
   */
  function groupOf(ch, enabled) {
    for (var i = 0; i < GROUPS.length; i++) {
      var g = GROUPS[i];
      if (!enabled[g.id]) continue;
      if (g.chars.indexOf(ch) >= 0) return g;
    }
    return null;
  }

  /**
   * 各类出现了几次。
   * 按**码点**数，不按 UTF-16 码元 —— 一个 emoji 算一个字符。
   */
  function countGroups(text, enabled) {
    var counts = {};
    GROUPS.forEach(function (g) { counts[g.id] = 0; });
    Array.from(String(text == null ? '' : text)).forEach(function (ch) {
      var g = groupOf(ch, enabled);
      if (g) counts[g.id]++;
    });
    return counts;
  }

  /** 各类加起来一共多少处 */
  function totalCount(counts) {
    var n = 0;
    Object.keys(counts).forEach(function (k) { n += counts[k]; });
    return n;
  }

  window.ItTools.register('i-and-l-checker', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 6,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste the text to check here...')
    });

    /** 每一类一个开关，默认全开 */
    var enabled = {};
    var boxes = {};
    GROUPS.forEach(function (g) {
      enabled[g.id] = true;
      var box = D.h('input', { type: 'checkbox' });
      box.checked = true;
      boxes[g.id] = box;
    });

    var summaryHost = D.h('div');
    var outPre = D.h('pre.code-body.mono');
    var tbody = D.h('tbody');

    /** 逐字符渲染：每个字符一个 span，高亮的那些带上底色。 */
    function renderHighlighted(text) {
      D.clear(outPre);
      Array.from(text).forEach(function (ch) {
        var g = groupOf(ch, enabled);
        if (g) {
          outPre.appendChild(D.h('span', {
            style: { backgroundColor: g.bg, color: g.fg, fontWeight: '700' }
          }, ch));
        } else {
          outPre.appendChild(D.h('span', null, ch));
        }
      });
    }

    function renderSummary(total) {
      D.clear(summaryHost);
      if (!total) {
        summaryHost.appendChild(U.alert('info', null,
          t('summary_none', 'No confusable character found in this text.')));
        return;
      }
      var text = total === 1
        ? t('summary_one', 'This text contains 1 confusable character.')
        : t('summary_many', 'This text contains {n} confusable characters.')
            .replace('{n}', function () { return String(total); });
      summaryHost.appendChild(U.alert('warning', null, text));
    }

    function renderCounts(counts) {
      D.clear(tbody);
      GROUPS.forEach(function (g) {
        if (!enabled[g.id]) return;
        tbody.appendChild(D.h('tr', null,
          D.h('td', null,
            D.h('span', {
              style: {
                backgroundColor: g.bg, color: g.fg, fontWeight: '700',
                padding: '0 6px', borderRadius: '3px', marginRight: '8px'
              },
              text: g.sample
            }),
            D.h('span', { text: groupLabel(g.id) })
          ),
          D.h('td.val', { text: String(counts[g.id]) })
        ));
      });
      tbody.appendChild(D.h('tr', null,
        D.h('td', { text: t('total', 'Total') }),
        D.h('td.val', { text: String(totalCount(counts)) })
      ));
    }

    function render() {
      var text = input.value;
      var counts = countGroups(text, enabled);
      renderSummary(totalCount(counts));
      renderHighlighted(text);
      renderCounts(counts);
    }

    var offs = [
      D.on(input, 'input', render)
    ];
    GROUPS.forEach(function (g) {
      offs.push(D.on(boxes[g.id], 'change', function () {
        enabled[g.id] = boxes[g.id].checked;
        render();
      }));
    });

    var switchGrid = D.h('div.switch-grid');
    GROUPS.forEach(function (g) {
      switchGrid.appendChild(D.h('label.switch', null, boxes[g.id],
        D.h('span', { text: groupLabel(g.id) })));
    });

    root.appendChild(D.h('div.card', null,
      U.field(t('input_label', 'Text to check:'), input, { wide: true }),
      switchGrid,
      D.h('p.field-hint', {
        text: t('hint', 'Every character is rendered on its own, so the text stays selectable and copyable. Turn a category off to leave its characters alone.')
      })
    ));

    // 结果卡用 .code-card：.code-body 的样式（不折行、横向滚动、等宽）
    // 只对 .code-card 的**直属**子元素生效 —— 少了这一层，
    // 长文本会从卡片里横着溢出去。
    root.appendChild(D.h('div.card.code-card', null,
      summaryHost,
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('output_label', 'Highlighted text') }),
        U.copyButton(function () { return outPre.textContent; })
      ),
      outPre,
      D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_class', 'Character') }),
          D.h('th', { text: t('col_count', 'Occurrences') })
        )),
        tbody
      )
    ));

    render();

    // 让屏幕上的汉字/假名正好占两格 —— 详见 _docs/js-tool-conventions.md。
    U.monoCjk(outPre, [
      { kind: 'cjk', ranges: WIDE_CJK_RANGES },
      { kind: 'emoji', ranges: WIDE_EMOJI_RANGES }
    ]);

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['i-and-l-checker'] = {
    GROUPS: GROUPS,
    groupLabel: groupLabel,
    groupOf: groupOf,
    countGroups: countGroups,
    totalCount: totalCount,
    __cases: function (assert) {
      var all = {};
      GROUPS.forEach(function (g) { all[g.id] = true; });

      /* ---- 归类 ---- */
      assert.eq(groupOf('1', all).id, 'one', '数字 1 归到第一类');
      assert.eq(groupOf('l', all).id, 'lower_l', '小写 l 归到第二类');
      assert.eq(groupOf('I', all).id, 'upper_i', '大写 I 归到第三类');
      assert.eq(groupOf('0', all).id, 'zero', '数字 0 归到第四类');
      assert.eq(groupOf('O', all).id, 'upper_o', '大写 O 归到第五类');
      assert.eq(groupOf('|', all).id, 'pipe', '竖线归到第六类');
      assert.eq(groupOf('{', all).id, 'braces', '花括号归到第七类');
      assert.eq(groupOf('}', all).id, 'braces', '右花括号也是第七类');
      assert.eq(groupOf('[', all).id, 'brackets', '方括号归到第八类');
      assert.eq(groupOf('(', all).id, 'parens', '圆括号归到第九类');
      assert.eq(groupOf('a', all), null, '普通字母不属于任何一类');
      assert.eq(groupOf('1', {}), null, '关掉之后就不再归类');

      /* ---- 计数 ---- */
      var c = countGroups('lI1O0', all);
      assert.eq(c.lower_l, 1, '一个 l');
      assert.eq(c.upper_i, 1, '一个 I');
      assert.eq(c.one, 1, '一个 1');
      assert.eq(c.upper_o, 1, '一个 O');
      assert.eq(c.zero, 1, '一个 0');
      assert.eq(totalCount(c), 5, '一共 5 处');

      assert.eq(totalCount(countGroups('', all)), 0, '空串没有形近字符');
      assert.eq(totalCount(countGroups('sun', all)), 0, '普通单词没有形近字符');
      assert.eq(totalCount(countGroups('hello', all)), 2, 'hello 里有两个小写 l');
      assert.eq(totalCount(countGroups('Password1', all)), 1, 'Password1 里只有那个 1');
      assert.eq(totalCount(countGroups('{}[]()', all)), 6, '六个括号字符各算一处');

      // 关掉一类之后就不再计入
      var off = { one: false };
      GROUPS.forEach(function (g) { if (g.id !== 'one') off[g.id] = true; });
      assert.eq(countGroups('lI1O0', off).one, 0, '关掉的类别不计数');
      assert.eq(totalCount(countGroups('lI1O0', off)), 4, '关掉数字 1 之后还剩 4 处');

      // 按码点计数，不按 UTF-16 码元
      assert.eq(totalCount(countGroups('😀', all)), 0, 'emoji 不算形近字符');
      assert.eq(totalCount(countGroups('a😀b', all)), 0, 'emoji 夹在中间也不算');
    }
  };
})();
