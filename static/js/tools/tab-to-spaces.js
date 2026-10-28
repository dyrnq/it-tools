/* ==========================================================================
   制表符转空格（tab-to-spaces）

   在制表符与空格之间互转，宽度可调。方向：Tab → 空格、空格 → Tab。

   参考实现：src/tools/tab-to-spaces/（it-tools2，Vue）
   与上游那版的差别：
   1. 上游只有「Tab → 空格」一个方向，这里补上「空格 → Tab」。
   2. 上游按**显示宽度**算列（CJK 算两格，还带一张手工维护的半角/全角表）。
      那张表把 0xF8F0、0xF8F1-0xF8F3 这些私用区码位当成半角，
      也没处理代理对（emoji 会被算成两个字符）。
      这里按**码点**算列：一个字符一列，规则简单、可预期。
   3. 上游的「规整内部空白」会把行内的连续空白压成一个空格 ——
      那是排版对齐用的空白（ASCII 图、表格），压掉就毁了。
      这一版没有这个功能。

   ---- 两处最容易做错的地方（这里写清楚）----
   A. Tab → 空格是**按制表位**算的，不是「一个 tab 换 N 个空格」：
      tab 走到下一个 N 的倍数。所以 "a\tb"（a 后面已经占了 1 列）
      在宽度 4 时是 "a   b"（3 个空格），不是 "a    b"。
      行首的 tab 正好占满一整级（4 列）。
   B. 空格 → Tab：**按当前列**算，不是按空格的个数算。
      一段空格能换成几个 tab，取决于它从第几列开始、结束在第几列 ——
      这样换完之后**每一列的位置都不变**。
      按个数算有两个毛病：一是把行内对齐用的空白也换掉
      （"hello world" 会变成 "hello\tworld"），二是列会挪动
      （"abc  d" 里 d 本来在第 5 列，换成 tab 之后跑到第 4 列去了）。
      这里只换「塞得下」的那部分：能整除的换成 tab，剩下的零头仍然是空格
      （跟 VS Code 的「Convert Indentation to Tabs」一个做法）；
      任务书给的两个选项里这里选「保留原样」—— 要是按「向上取整」补成 tab，
      缩进会凭空多出几列，代码整体右移。
      代价是行内的空格换完可能是「一个 tab + 几个空格」
      （"abc  d" → "abc\t d"）：从第 3 列开始的两个空格，
      一个 tab 只盖得住第 3、4 列，第 5 列还得留一个空格。
      列没动，渲染出来跟原来一模一样。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('tab-to-spaces');

  var DEFAULT_WIDTH = 4;
  var MIN_WIDTH = 1;
  var MAX_WIDTH = 16;

  var DIR_TABS_TO_SPACES = 'tabs-to-spaces';
  var DIR_SPACES_TO_TABS = 'spaces-to-tabs';

  /** 宽度取整并夹到合法范围；非法输入退回默认值 */
  function clampWidth(value) {
    if (value === null || value === undefined || String(value).trim() === '') return DEFAULT_WIDTH;
    var n = Math.floor(Number(value));
    if (!isFinite(n) || isNaN(n)) return DEFAULT_WIDTH;
    if (n < MIN_WIDTH) return MIN_WIDTH;
    if (n > MAX_WIDTH) return MAX_WIDTH;
    return n;
  }

  /** 码点数组（一个 emoji 是一个字符） */
  function chars(text) {
    return Array.from(String(text == null ? '' : text));
  }

  /**
   * Tab → 空格：**按制表位**算。
   *
   * 一个 tab 走到下一个 width 的倍数：当前列是 col，
   * 就补 width - (col % width) 个空格（col 正好在制表位上时补满一整级）。
   * 换行后列号归零 —— 制表位是**每行**重算的。
   */
  function tabsToSpaces(text, width) {
    var w = clampWidth(width);
    var list = chars(text);
    var out = '';
    var col = 0;
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if (ch === '\t') {
        var n = w - (col % w);
        out += ' '.repeat(n);
        col += n;
      } else if (ch === '\n' || ch === '\r') {
        out += ch;
        col = 0;
      } else {
        out += ch;
        col += 1;
      }
    }
    return out;
  }

  /**
   * 空格 → Tab：**按当前列**算，保证换完之后列位置不变。
   *
   * 一段连续空格从第 col 列开始、占 n 列（结束于 col + n）：
   *   - 先看能塞进几个 tab：从 col 出发，第一个 tab 落在下一个制表位上，
   *     所以能塞 floor(n / w) 个（col 正好在制表位上时）
   *     或 floor((n + col % w) / w) 个（col 不在制表位上时）；
   *   - 剩下的零头保持成空格。
   *
   * 只换「塞得下」的那部分，列不会动。一个 tab 从第 col 列出发只能盖住
   * 到下一个制表位为止的那几列，所以行内的一小段空格通常塞不下 tab ——
   * 词与词之间的一个空格就是这么保住了。
   */
  function spacesToTabs(text, width) {
    var w = clampWidth(width);
    var list = chars(text);
    var out = '';
    var col = 0;
    var i = 0;
    while (i < list.length) {
      var ch = list[i];
      if (ch === ' ') {
        var start = i;
        while (i < list.length && list[i] === ' ') i++;
        var n = i - start;
        var endCol = col + n;
        var rest = col % w;                       // 当前列离制表位有多远
        // 这一段里塞得下几个 tab：从 col 出发，第一个 tab 落在下一个制表位上
        var tabs = rest === 0 ? Math.floor(n / w) : Math.floor((n + rest) / w);
        // 换完这些 tab 之后所在的列。
        // 注意 tabs === 0 时列**不动** —— 一个 tab 都塞不下，
        // 这时候要是也按「减去 rest」算，列会凭空倒退，整段空白反而变长了。
        var afterTabs = (rest !== 0 && tabs > 0) ? col - rest + tabs * w : col + tabs * w;
        out += '\t'.repeat(tabs) + ' '.repeat(endCol - afterTabs);
        col = endCol;
        continue;
      }
      out += ch;
      if (ch === '\n' || ch === '\r') col = 0; else col += 1;
      i++;
    }
    return out;
  }

  /** 按方向转换 */
  function convert(text, width, direction) {
    return direction === DIR_SPACES_TO_TABS
      ? spacesToTabs(text, width)
      : tabsToSpaces(text, width);
  }

  window.ItTools.register('tab-to-spaces', function (root) {
    var dirSelect = D.h('select.layui-select', null,
      D.h('option', { value: DIR_TABS_TO_SPACES, text: t('dir_tabs_to_spaces', 'Tabs to spaces') }),
      D.h('option', { value: DIR_SPACES_TO_TABS, text: t('dir_spaces_to_tabs', 'Spaces to tabs') })
    );
    var widthInput = D.h('input.layui-input', {
      type: 'number', min: String(MIN_WIDTH), max: String(MAX_WIDTH), value: String(DEFAULT_WIDTH)
    });
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 10, spellcheck: 'false', placeholder: t('input_ph', 'Paste text with tabs (or spaces) here...')
    });
    input.value = 'if (x) {\n\treturn 1;\n}';

    var outPre = D.h('pre.code-body');
    var status = D.h('div.form-status');

    function render() {
      var raw = widthInput.value;
      var n = Number(raw);
      var valid = raw !== '' && isFinite(n) && n === Math.floor(n) && n >= MIN_WIDTH && n <= MAX_WIDTH;
      if (valid) {
        status.textContent = '';
        status.classList.remove('is-error');
      } else {
        // 输入不合法时不抛异常，只提示一行 —— 页面不能因为一个空输入框就白掉
        status.textContent = t('err_width', 'The indent width must be a whole number between 1 and 16.');
        status.classList.add('is-error');
      }

      var width = clampWidth(raw);
      // 预览里的 tab 按我们选的宽度渲染（浏览器默认是 8）
      input.style.tabSize = String(width);
      outPre.style.tabSize = String(width);
      outPre.textContent = convert(input.value, width, dirSelect.value);
    }

    var offs = [
      D.on(input, 'input', render),
      D.on(dirSelect, 'change', render),
      D.on(widthInput, 'input', render)
    ];

    // 输入卡
    root.appendChild(D.h('div.card', null,
      D.h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
        D.h('div', { style: { flex: '0 1 220px', minWidth: '0' } },
          U.field(t('direction', 'Direction'), dirSelect, { wide: true })),
        D.h('div', { style: { flex: '0 1 220px', minWidth: '0' } },
          U.field(t('width', 'Spaces per indent level'), widthInput, { wide: true }))
      ),
      U.field(t('input', 'Text to convert'), input, {
        wide: true,
        hint: t('input_hint', 'A tab advances to the next multiple of the indent width, so a tab after one character at width 4 becomes three spaces.')
      }),
      status
    ));

    // 结果卡
    root.appendChild(D.h('div.card.code-card', null,
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('output', 'Converted text') }),
        U.copyButton(function () { return outPre.textContent; }, t('copy', 'Copy')),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download', 'Download'),
          onclick: function () {
            window.ItTools.download('output.txt', outPre.textContent, 'text/plain;charset=utf-8');
          }
        })
      ),
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

  window.ItTools.logic['tab-to-spaces'] = {
    DEFAULT_WIDTH: DEFAULT_WIDTH,
    MIN_WIDTH: MIN_WIDTH,
    MAX_WIDTH: MAX_WIDTH,
    DIR_TABS_TO_SPACES: DIR_TABS_TO_SPACES,
    DIR_SPACES_TO_TABS: DIR_SPACES_TO_TABS,
    clampWidth: clampWidth,
    tabsToSpaces: tabsToSpaces,
    spacesToTabs: spacesToTabs,
    convert: convert,
    __cases: function (assert) {
      /* ---- Tab → 空格：按制表位，不是一个 tab 换 N 个空格 ---- */
      assert.eq(tabsToSpaces('a\tb', 4), 'a   b', 'a 后面已有 1 列，tab 补 3 个空格');
      assert.eq(tabsToSpaces('\tb', 4), '    b', '行首的 tab 占满一整级');
      assert.eq(tabsToSpaces('\t\tb', 4), '        b', '两个行首 tab 是 8 列');
      assert.eq(tabsToSpaces('a\t\tb', 4), 'a       b', '第二个 tab 从第 4 列走到第 8 列');
      assert.eq(tabsToSpaces('abc\tdef', 4), 'abc def', 'abc 之后还差 1 列');
      assert.eq(tabsToSpaces('abcd\tef', 4), 'abcd    ef', '正好在制表位上就补满一整级');
      assert.eq(tabsToSpaces('abcde\tf', 4), 'abcde   f', '超过一格就走到下一个制表位');
      assert.eq(tabsToSpaces('a\tb', 2), 'a b', '宽度 2');
      assert.eq(tabsToSpaces('a\tb', 8), 'a       b', '宽度 8');
      assert.eq(tabsToSpaces('a\n\tb', 4), 'a\n    b', '换行后列号归零');
      assert.eq(tabsToSpaces('a\r\n\tb', 4), 'a\r\n    b', 'CRLF 也算换行');
      assert.eq(tabsToSpaces('', 4), '', '空输入');
      assert.eq(tabsToSpaces('no tabs here', 4), 'no tabs here', '没有 tab 就不动');
      assert.eq(tabsToSpaces('\t', 4), '    ', '只有一个 tab');

      /* ---- 空格 → Tab ---- */
      assert.eq(spacesToTabs('    x', 4), '\tx', '4 个空格（整除）换成一个 tab');
      assert.eq(spacesToTabs('        x', 4), '\t\tx', '8 个空格换成两个 tab');
      assert.eq(spacesToTabs('  x', 4), '  x', '不足一级的部分保留成空格');
      assert.eq(spacesToTabs('      x', 4), '\t  x', '6 个空格：1 个 tab + 2 个空格，列不变');
      // 行内的空格从第几列开始是有讲究的：x 占了第 0 列，
      // 后面那 4 个空格从第 1 列开始 —— 一个 tab 只能盖住第 1~3 列，
      // 第 4 列还得留一个空格，所以是 "x\t y" 而不是 "x\ty"。
      // 换成 tab 之后 y 仍在第 5 列：列位置一点没动。
      assert.eq(spacesToTabs('x    y', 4), 'x\t y', '行内的空格按列换，列不变');
      assert.eq(spacesToTabs('hello world', 4), 'hello world', '词间的一个空格塞不下 tab，原样不动');
      assert.eq(spacesToTabs('a  b', 4), 'a  b', '两个空格的零头保留');
      assert.eq(spacesToTabs('', 4), '', '空输入');
      assert.eq(spacesToTabs('no spaces', 4), 'no spaces', '没有空格就不动');
      assert.eq(spacesToTabs('a\n    b', 4), 'a\n\tb', '换行后列号归零');
      assert.eq(spacesToTabs('  a', 2), '\ta', '宽度 2');

      /* ---- 两个方向互逆（制表符展开出来的缩进能原样变回去） ---- */
      ['\tx', '\t\tx', 'a\tb', 'a\t\tb', '\ta\tb', '\t\tx\ty'].forEach(function (src) {
        assert.eq(spacesToTabs(tabsToSpaces(src, 4), 4), src,
          '往返不变：' + JSON.stringify(src));
      });

      /* ---- 换完之后列位置不变 ---- */
      // "abc  d"：d 在第 5 列。两个空格从第 3 列开始，
      // 一个 tab 盖住第 3、4 列，第 5 列还得留一个空格 → "abc\t d"，d 仍在第 5 列
      assert.eq(spacesToTabs('abc  d', 4), 'abc\t d', 'abc 之后的两个空格换成一个 tab 加一个空格');
      assert.eq(tabsToSpaces('abc\t d', 4), 'abc  d', '……再换回来是原来的样子');

      /* ---- 宽度夹取 ---- */
      assert.eq(clampWidth(4), 4, '正常宽度');
      assert.eq(clampWidth(0), MIN_WIDTH, '0 夹到下限');
      assert.eq(clampWidth(-3), MIN_WIDTH, '负数夹到下限');
      assert.eq(clampWidth(99), MAX_WIDTH, '太大夹到上限');
      assert.eq(clampWidth('abc'), DEFAULT_WIDTH, '不是数字退回默认值');
      assert.eq(clampWidth(''), DEFAULT_WIDTH, '空串退回默认值');
      assert.eq(clampWidth('2.7'), 2, '小数取整');

      /* ---- 按方向转换 ---- */
      assert.eq(convert('a\tb', 4, DIR_TABS_TO_SPACES), 'a   b', 'tab → 空格');
      assert.eq(convert('a   b', 4, DIR_SPACES_TO_TABS), 'a\tb', '空格 → tab');
    }
  };
})();
