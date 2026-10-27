/* ==========================================================================
   Markdown 表格格式化（markdown-table-formatter）

   把 Markdown 表格的列排整齐：每一列按最宽的那一格补空格，
   分隔行按新的列宽重建，列的对齐标记（`:---` / `---:` / `:---:`）保留。

   参考实现：markdowntable.com 的 "Markdown Table Formatter"。
   那个页面没有公开源码，这里是照着它的行为复刻的 ——
   网上有若干 Rust / Python 移植版，行为一致，要点是：
     · 每一列按最宽的格子补空格，竖线对齐；
     · 分隔行按新的列宽重建（不是照抄原来那行 `---`）；
     · 行首行尾的竖线补上，格子里的首尾空白去掉；
     · 列的对齐标记保留；
     · 表格之外的文字原样不动。

   ---- 与别的工具的分工 ----
   markdown-table-generator 是「填格子 → 生成表格」，
   这里是「已经有表格了 → 把它排整齐」，两个方向不重叠。

   ---- 宽字符 ----
   中日韩文字与 emoji 在等宽字体里占**两格**。按字符数补空格的话，
   一张全是中文的表格在编辑器里还是歪的 —— 竖线对不上。
   所以宽度按**显示宽度**算：CJK 与 emoji 算两格，其余算一格。

   ---- 什么算「一张表」 ----
   照 GitHub 的规矩（GFM）：表头行 + 分隔行，**两行的格子数一样**。
   少一个格子就不是表（GFM 也不认），那种行我们不碰 ——
   格式化器只负责排版，不负责把坏数据改成另一种坏数据。

   ---- 输出区为什么是 pre 而不是 textarea ----
   两个原因，都是 css-js-formatter 那条注释里说过的：
     · textarea 的 value 按 HTML 规范会把 CRLF 归一成 LF，
       「保留原来的换行符」在输出区就看不出差别；
     · 共用的 outputCard 里是 `.output-body`，它带着
       `word-break: break-all` —— 宽表格会被从中间折断，
       而这个工具的全部意义就是「列要对齐」。
   `pre.code-body` 是不折行、横向滚动的等宽块，正好。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('markdown-table-formatter');

  /* ======================================================================
     纯逻辑
     ====================================================================== */

  /** 分隔格里允许的写法：`:---` / `---:` / `:---:` / `---`。 */
  var DELIMITER_CELL = /^:?-+:?$/;

  /** 样例输入：一张歪歪扭扭的表（各列没对齐）。 */
  var SAMPLE = [
    '| Tool |What it does| Notes |',
    '|---|---|---|',
    '| hash-text |Hash a string|ok|',
    '| uuid-generator |Generate a UUID v4|needs entropy|'
  ].join('\n');

  /**
   * 宽字符（东亚宽字符 + emoji）的码位区间。
   *
   * 判的是「东亚宽字符」那几段区间（East Asian Wide / Fullwidth），
   * 外加 emoji —— 它们在等宽字体里都是两格宽。
   * 范围按 Unicode 的 East_Asian_Width 属性取常用的那些段：
   * 谚文字母、CJK 部首与符号、假名、注音、CJK 兼容汉字、
   * CJK 统一表意文字（以及扩展 A 与扩展 B 以后）、彝文、韩文音节、
   * 全角形式、竖排标点，再加三段 emoji。
   *
   * 这张表有**两个**用处：算列宽，以及给 CSS 的 unicode-range ——
   * 「算两格」跟「渲染两格」必须落在同一批码点上，否则表照样歪。
   * emoji 单列一张：它要用彩色 emoji 字体，不能跟 CJK 字体混。
   */
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

  function inRanges(code, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (code >= ranges[i][0] && code <= ranges[i][1]) return true;
    }
    return false;
  }

  /**
   * 这个码位占几格。
   *
   * @param {number} code 码位
   * @returns {number} 1 或 2
   */
  function charWidth(code) {
    if (code < 0x1100) return 1;
    return (inRanges(code, WIDE_CJK_RANGES) || inRanges(code, WIDE_EMOJI_RANGES)) ? 2 : 1;
  }

  /**
   * 一段文字的显示宽度（几格）。
   *
   * 代理对算**一个**字符 —— 一个 emoji 在 UTF-16 里是两个码元，
   * 逐码元数的话会把它算成两格，表格就多出半个格子。
   *
   * 还认得两种 Markdown 转义：`\|` 与 `\\`。
   * 渲染出来它们各是一根字符（竖线 / 反斜杠），源文本里却是两根 ——
   * 按源文本算宽度，那一列就会宽两格，竖线对不齐。
   * 别的反斜杠（`\x`）是**原样渲染**的，按两格算。
   *
   * @param {string} text
   * @returns {number}
   */
  function displayWidth(text) {
    var str = text === null || text === undefined ? '' : String(text);
    var width = 0;
    var i = 0;
    var n = str.length;
    while (i < n) {
      var c = str.charAt(i);
      if (c === '\\' && i + 1 < n) {
        var next = str.charAt(i + 1);
        if (next === '|' || next === '\\') { width += 1; i += 2; continue; }
      }
      var code = str.codePointAt(i);
      width += charWidth(code);
      i += code > 0xffff ? 2 : 1;   // 代理对的后半个码元，跳过
    }
    return width;
  }

  /**
   * 一行表格 → 各个格子。
   *
   * 转义过的竖线（`\|`）是**格子里的一部分**，不是分隔符 ——
   * GFM 规定竖线在行内结构里也要转义，所以表格里出现 `a\|b` 是一格，不是两格。
   * 反斜杠连着竖线一起留在格子里（输出还是合法的转义写法）。
   *
   * `\\` 是转义过的反斜杠：渲染出来一根反斜杠，
   * 它**后面**的竖线就又变成分隔符了。
   *
   * 行首 / 行尾的竖线会切出空的格子，那两个空格子是「边框」不是「列」，去掉。
   *
   * @param {string} line
   * @returns {{cells: string[], hasPipe: boolean}} 格子 + 这一行里有没有竖线
   */
  function splitRow(line) {
    var cells = [];
    var cur = '';
    var hasPipe = false;
    var i = 0;
    var n = line.length;
    while (i < n) {
      var c = line.charAt(i);
      if (c === '\\' && i + 1 < n) {
        var next = line.charAt(i + 1);
        if (next === '|' || next === '\\') {
          cur += c + next;
          i += 2;
          continue;
        }
      }
      if (c === '|') {
        hasPipe = true;
        cells.push(cur);
        cur = '';
        i++;
        continue;
      }
      cur += c;
      i++;
    }
    cells.push(cur);
    if (cells.length > 1 && cells[0].trim() === '') cells.shift();
    if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
    return {
      cells: cells.map(function (cell) { return cell.trim(); }),
      hasPipe: hasPipe
    };
  }

  /**
   * 这一行是不是分隔行？不像就返回 null。
   *
   * @param {string} line
   * @returns {string[]|null} 每列的对齐：'left' | 'right' | 'center' | 'none'
   */
  function parseDelimiter(line) {
    var row = splitRow(line);
    if (!row.hasPipe || row.cells.length === 0) return null;
    var aligns = [];
    for (var i = 0; i < row.cells.length; i++) {
      var cell = row.cells[i];
      if (!DELIMITER_CELL.test(cell)) return null;
      var left = cell.charAt(0) === ':';
      var right = cell.charAt(cell.length - 1) === ':';
      aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : 'none');
    }
    return aligns;
  }

  /**
   * 分隔行的那几格：按列宽填横线，对齐标记放在两头。
   *
   * @param {string[]} aligns 每列的对齐
   * @param {number[]} widths 每列的宽度
   * @param {boolean} keepAlign 保留对齐标记？
   * @returns {string[]}
   */
  function delimiterCells(aligns, widths, keepAlign) {
    var out = [];
    for (var i = 0; i < widths.length; i++) {
      var len = widths[i];
      var align = keepAlign ? (aligns[i] || 'none') : 'none';
      if (align === 'left') out.push(':' + '-'.repeat(len - 1));
      else if (align === 'right') out.push('-'.repeat(len - 1) + ':');
      else if (align === 'center') out.push(':' + '-'.repeat(len - 2) + ':');
      else out.push('-'.repeat(len));
    }
    return out;
  }

  /**
   * 一行 → `| a | b |`，每格补空格补到该列的宽度。
   *
   * @param {string[]} cells
   * @param {number[]} widths
   * @returns {string}
   */
  function formatRow(cells, widths) {
    var parts = [];
    for (var i = 0; i < widths.length; i++) {
      var cell = i < cells.length ? cells[i] : '';
      var pad = widths[i] - displayWidth(cell);
      parts.push(pad > 0 ? cell + ' '.repeat(pad) : cell);
    }
    return '| ' + parts.join(' | ') + ' |';
  }

  /**
   * 一张表 → 排整齐的几行。
   *
   * 列数取「表头 / 分隔行 / 各数据行」里最宽的那个 ——
   * 数据行多出来的格子不丢（表头与分隔行会补空格跟上），
   * 少掉的格子补空。
   *
   * 这里跟 GFM 有出入：GFM 是以表头的列数为准、多出来的格子**丢掉**。
   * 格式化器宁可把列补宽也不丢数据 —— 丢一个格子是数据没了，
   * 补宽一列只是看着宽了一点。
   *
   * 每列的宽度至少是 3：GFM 的分隔行至少要三个字符，
   * 一列只有一格宽的话分隔行会撑长，竖线就对不齐了。
   *
   * @param {string[]} header 表头那一行的格子
   * @param {string[]} aligns 每列的对齐
   * @param {string[][]} rows 数据行
   * @param {boolean} keepAlign 保留对齐标记？
   * @returns {string[]}
   */
  function formatTable(header, aligns, rows, keepAlign) {
    var columns = Math.max(header.length, aligns.length);
    rows.forEach(function (row) {
      if (row.length > columns) columns = row.length;
    });
    if (columns === 0) return [];

    var widths = [];
    for (var i = 0; i < columns; i++) widths.push(3);
    [header].concat(rows).forEach(function (row) {
      for (var j = 0; j < row.length && j < columns; j++) {
        var w = displayWidth(row[j]);
        if (w > widths[j]) widths[j] = w;
      }
    });

    var out = [formatRow(header, widths), formatRow(delimiterCells(aligns, widths, keepAlign), widths)];
    rows.forEach(function (row) { out.push(formatRow(row, widths)); });
    return out;
  }

  /**
   * 整篇文档 → 表格排整齐的文档。
   *
   * 只动**表格**：表格之外的段落、列表、代码块原样保留。
   * 围栏代码块（``` 或 ~~~）里的 `|---|` 是示例代码，不是表格 —— 那里不动。
   *
   * 换行符按原文来：出现过 CRLF 就全用 CRLF，否则全用 LF。
   *
   * @param {string} text
   * @param {{keepAlign?: boolean}} [opts]
   * @returns {{text: string, tables: number}} 排好的文本 + 排了几张表
   */
  function formatMarkdownTables(text, opts) {
    opts = opts || {};
    var keepAlign = opts.keepAlign !== false;
    if (text === null || text === undefined) return { text: '', tables: 0 };
    var src = String(text);
    if (src === '') return { text: '', tables: 0 };

    var eol = src.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var lines = src.split(/\r\n|\r|\n/);
    var out = [];
    var tables = 0;
    var fence = null;   // 围栏代码块的定界符（``` 或 ~~~）
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块：整块原样留着
      var fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        out.push(line);
        if (fenceMatch
            && fenceMatch[1].charAt(0) === fence.charAt(0)
            && fenceMatch[1].length >= fence.length) {
          fence = null;
        }
        i++;
        continue;
      }
      if (fenceMatch) {
        fence = fenceMatch[1];
        out.push(line);
        i++;
        continue;
      }

      // 表头 + 分隔行 → 一张表
      var header = splitRow(line);
      var aligns = (i + 1 < lines.length) ? parseDelimiter(lines[i + 1]) : null;
      if (header.hasPipe && aligns && aligns.length === header.cells.length) {
        var body = [];
        var j = i + 2;
        while (j < lines.length) {
          var row = splitRow(lines[j]);
          // 没有竖线的行不是表格的一部分（GFM 里表格到空行为止）
          if (!row.hasPipe || row.cells.length === 0) break;
          body.push(row.cells);
          j++;
        }
        out = out.concat(formatTable(header.cells, aligns, body, keepAlign));
        tables++;
        i = j;
        continue;
      }

      out.push(line);
      i++;
    }

    return { text: out.join(eol), tables: tables };
  }

  /* ======================================================================
     界面
     ====================================================================== */

  window.ItTools.register('markdown-table-formatter', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 10,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste a Markdown table (or a whole document that contains one)...')
    });
    input.value = SAMPLE;

    var keepAlignInput = D.h('input', { type: 'checkbox', checked: 'checked' });

    var outPre = D.h('pre.code-body.mono');
    var status = D.h('p.form-status');

    function render() {
      var result;
      try {
        result = formatMarkdownTables(input.value, { keepAlign: keepAlignInput.checked });
      } catch (e) {
        outPre.textContent = '';
        status.textContent = t('err_format', 'Formatting failed.');
        status.classList.add('is-error');
        return;
      }
      outPre.textContent = result.text;
      if (result.tables === 0) {
        status.textContent = t('no_table', 'No Markdown table found.');
      } else if (result.tables === 1) {
        status.textContent = t('table_one', '1 table formatted.');
      } else {
        status.textContent = t('tables_count', '{n} tables formatted.')
          .replace('{n}', function () { return String(result.tables); });
      }
      status.classList.remove('is-error');
    }

    var formatBtn = D.h('button.layui-btn', { type: 'button', text: t('format', 'Format') });

    var offs = [
      D.on(formatBtn, 'click', render),
      D.on(input, 'input', render),
      D.on(keepAlignInput, 'change', render)
    ];

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Markdown to format:'), input, {
        wide: true,
        hint: t('hint',
          'Each column is padded to its widest cell, so the pipes line up. Wide characters (Chinese, Japanese, emoji) count as two columns. The alignment markers (:---, ---:, :---:) are kept as they are.')
      }),
      D.h('div.switch-grid', null,
        D.h('label.switch', null, keepAlignInput,
          D.h('span', { text: t('keep_align', 'Keep the column alignment') }))),
      D.h('div.form-actions', null, formatBtn)
    ));

    // 输出区是 pre.code-body：不折行、横向滚动。
    // 共用的 outputCard 用的是 .output-body（word-break: break-all），
    // 宽表格会被从中间折断 —— 而这个工具的全部意义就是「列要对齐」。
    root.appendChild(D.h('div.card.code-card', null,
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('output', 'Formatted Markdown') }),
        U.copyButton(function () { return outPre.textContent; }, t('copy_md', 'Copy Markdown'))
      ),
      outPre,
      status
    ));

    render();

    // 让屏幕上的汉字/假名正好占两格。
    //
    // 表格是按「CJK 占两格」算宽度的（Unicode 的东亚宽度约定），
    // 但等宽字体的等宽只对拉丁部分成立 —— CJK 走的是系统回退字体，
    // 字宽跟正文对不上。本机实测：拉丁一格 8.44px，汉字 14px，
    // 差出来的 2.86px 会让每列的竖线按汉字个数往下歪。
    // U.monoCjk 把回退字体缩放到正好两格 —— 字符串的算法不动，
    // 只让屏幕跟算法对得上。宽字符的码点区间就是上面那两张表，
    // 跟算宽度用的是同一份，不会「算两格、渲染一格」。
    U.monoCjk(input, [
      { kind: 'cjk', ranges: WIDE_CJK_RANGES },
      { kind: 'emoji', ranges: WIDE_EMOJI_RANGES }
    ]);
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

  /* ======================================================================
     导出与自测
     ====================================================================== */

  window.ItTools.logic['markdown-table-formatter'] = {
    SAMPLE: SAMPLE,
    charWidth: charWidth,
    displayWidth: displayWidth,
    splitRow: splitRow,
    parseDelimiter: parseDelimiter,
    delimiterCells: delimiterCells,
    formatRow: formatRow,
    formatTable: formatTable,
    formatMarkdownTables: formatMarkdownTables,
    __cases: function (assert) {
      /* ---- 拆行 ---- */
      assert.eq(splitRow('| a | b |'), { cells: ['a', 'b'], hasPipe: true },
        'splitRow：行首行尾的竖线切出来的空格子不算列');
      assert.eq(splitRow('a | b'), { cells: ['a', 'b'], hasPipe: true },
        'splitRow：没有行首竖线也能拆');
      assert.eq(splitRow('|  a  |  b  |'), { cells: ['a', 'b'], hasPipe: true },
        'splitRow：格子里的首尾空白去掉');
      assert.eq(splitRow('| a \\| b | c |'), { cells: ['a \\| b', 'c'], hasPipe: true },
        'splitRow：转义过的竖线是格子里的字，不是分隔符');
      assert.eq(splitRow('no pipe here'), { cells: ['no pipe here'], hasPipe: false },
        'splitRow：没有竖线的行只有一格');

      /* ---- 分隔行 ---- */
      assert.eq(parseDelimiter('| --- | --- |'), ['none', 'none'], '分隔行：两边都没冒号');
      assert.eq(parseDelimiter('| :--- | ---: | :---: |'), ['left', 'right', 'center'],
        '分隔行：三种对齐标记');
      assert.eq(parseDelimiter('| a | b |'), null, '不是分隔行就返回 null');
      assert.eq(parseDelimiter('no pipe'), null, '没有竖线的行不是分隔行');

      /* ---- 对齐 ----
         期望值里每列至少 3 格宽 —— 列宽的下限是 3，
         分隔行至少要三个字符才合法（GFM）。 */
      assert.eq(formatMarkdownTables('|a|b|\n|-|-|\n|1|2|').text,
        '| a   | b   |\n| --- | --- |\n| 1   | 2   |',
        '最基本的对齐：每列补到最宽的那一格');
      assert.eq(formatMarkdownTables('|a|b|\n|-|-|\n|1|2|').tables, 1, '排了一张表');
      assert.eq(formatMarkdownTables('| Name | Description |\n|---|---|\n| a | longer text |').text,
        '| Name | Description |\n| ---- | ----------- |\n| a    | longer text |',
        '列宽按最宽的格子算，分隔行跟着变长');
      assert.eq(formatMarkdownTables('|a|b|c|\n|:-|-:|:-:|\n|1|2|3|').text,
        '| a   | b   | c   |\n| :-- | --: | :-: |\n| 1   | 2   | 3   |',
        '对齐标记保留，宽度变了标记也跟着变长');
      assert.eq(formatMarkdownTables('|a|b|c|\n|:-|-:|:-:|\n|1|2|3|', { keepAlign: false }).text,
        '| a   | b   | c   |\n| --- | --- | --- |\n| 1   | 2   | 3   |',
        '关掉「保留对齐」之后分隔行全是横线');
      assert.eq(formatMarkdownTables('|a|b|\n|-|-|\n|1|').text,
        '| a   | b   |\n| --- | --- |\n| 1   |     |',
        '少一格的行补空格');
      assert.eq(formatMarkdownTables('|a|b|\n|-|-|\n|1|2|3|').text,
        '| a   | b   |     |\n| --- | --- | --- |\n| 1   | 2   | 3   |',
        '多一格的行不丢：表头补一格空位跟上（GFM 是把多出来的格子丢掉，' +
        '格式化器宁可补宽也不丢数据）');

      /* ---- 宽字符 ---- */
      assert.eq(displayWidth('abc'), 3, '三个 ASCII 字符三格');
      assert.eq(displayWidth('中文'), 4, '两个汉字四格');
      assert.eq(displayWidth('a中'), 3, 'ASCII 一格 + 汉字两格');
      assert.eq(displayWidth('😀'), 2, '一个 emoji 两格');
      assert.eq(displayWidth('中😀a'), 5, '汉字两格 + emoji 两格 + ASCII 一格');
      assert.eq(formatMarkdownTables('|名字|值|\n|-|-|\n|甲|1|').text,
        '| 名字 | 值  |\n| ---- | --- |\n| 甲   | 1   |',
        '中文按两格算，竖线照样对齐');

      /* ---- 转义 ---- */
      assert.eq(displayWidth('a \\| b'), 5, '转义的竖线按一根字符算：a、空格、竖线、空格、b');
      assert.eq(formatMarkdownTables('|a|b|\n|-|-|\n|x \\| y|z|').text,
        '| a     | b   |\n| ----- | --- |\n| x \\| y | z   |',
        '格子里转义过的竖线按一根算，列宽不会被撑大');

      /* ---- 表格之外的东西不动 ---- */
      assert.eq(formatMarkdownTables('前面一段话\n\n|a|b|\n|-|-|\n|1|2|\n\n后面一段话').text,
        '前面一段话\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\n后面一段话',
        '表格之外的段落原样保留');
      assert.eq(formatMarkdownTables('```\n|a|b|\n|-|-|\n```').text,
        '```\n|a|b|\n|-|-|\n```',
        '围栏代码块里的表头不是表格，不动');
      assert.eq(formatMarkdownTables('```\n|a|b|\n|-|-|\n```\n\n|a|b|\n|-|-|\n|1|2|').text,
        '```\n|a|b|\n|-|-|\n```\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |',
        '围栏代码块外面那张表照样排');
      assert.eq(formatMarkdownTables('no table here').text, 'no table here',
        '没有表格就原样返回');
      assert.eq(formatMarkdownTables('no table here').tables, 0, '没有表格就报 0 张');
      assert.eq(formatMarkdownTables('|a|b|\n|---|---|\n|1|2|').text,
        '| a   | b   |\n| --- | --- |\n| 1   | 2   |',
        '表头与分隔行的格子数一样才算表');
      assert.eq(formatMarkdownTables('|a|b|\n|---|\n|1|2|').text,
        '|a|b|\n|---|\n|1|2|',
        '分隔行的格子数跟表头对不上就不是表（GFM 的规矩），不碰');

      /* ---- 多张表 ---- */
      assert.eq(formatMarkdownTables('|a|\n|-|\n|1|\n\n|b|\n|-|\n|2|').text,
        '| a   |\n| --- |\n| 1   |\n\n| b   |\n| --- |\n| 2   |',
        '一篇里有多张表，每张都排');

      /* ---- 边界 ---- */
      assert.eq(formatMarkdownTables('').text, '', '空串');
      assert.eq(formatMarkdownTables(null).text, '', 'null');
      assert.eq(formatMarkdownTables(undefined).text, '', 'undefined');
      assert.eq(formatMarkdownTables('|a|b|\r\n|-|-|\r\n|1|2|').text,
        '| a   | b   |\r\n| --- | --- |\r\n| 1   | 2   |',
        'CRLF 换行原样保留');
      assert.eq(formatMarkdownTables('|a|b|\n|-|-|\n|1|2|').text.indexOf('\r'), -1,
        'LF 换行的文档里不会混进 CRLF');
    }
  };
})();
