/* ==========================================================================
   Markdown 表格生成器（markdown-table-generator）

   在一个能增删行列的表格编辑器里填内容 → 生成 GitHub 风格的 Markdown 表格。
   单元格里的内容按**纯文本**处理：Markdown 会认的那些字符自动加反斜杠，
   渲染出来跟你填的一模一样。

   参考实现：src/tools/markdown-table-generator/（it-tools, GPLv3）
   与原版的差别：
   1. 单元格转义：原版只转义 `|` 与换行，`*` `_` `` ` `` `<` `>` `[` `#` 全都不管，
      所以 `*斜体*` 这种格子会被 GFM 当成强调吃掉 —— 渲染出来跟原文对不上。
      这里按 CommonMark / GFM 的行内规则补全了转义，规则见 escapeMarkdownTableCell。
   2. 未知对齐值：原版是 alignmentSeparators[table.alignments[index] ?? 'left']，
      对齐值是个不认识的字符串时（只有直接调纯函数才会遇到）查表得到 undefined，
      会往输出里塞字面量 "undefined"，这里退回左对齐。
   3. 界面：原版用 naive-ui 的 n-table + n-scrollbar，这里换成 layui 的
      input / select / button，能力一一对应（表头可编辑、数据行可编辑、
      增删行列、每列设对齐），另外补了复制按钮，默认表头文案也做了本地化。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('markdown-table-generator');

  /* ======================================================================
     纯逻辑
     ====================================================================== */

  /** 对齐方式 → 分隔行里那一段的写法。 */
  var ALIGNMENT_SEPARATORS = {
    left: ':---',
    center: ':---:',
    right: '---:'
  };

  /**
   * 新建一张空表：表头写「Column N」，对齐默认左对齐，格子全空。
   *
   * @param {{rows?: number, columns?: number}} [opts]
   * @returns {{headers: string[], alignments: string[], rows: string[][]}}
   */
  function createMarkdownTable(opts) {
    opts = opts || {};
    var rows = opts.rows === undefined ? 2 : opts.rows;
    var columns = opts.columns === undefined ? 3 : opts.columns;
    return {
      headers: Array.from({ length: columns }, function (_, i) { return 'Column ' + (i + 1); }),
      alignments: Array.from({ length: columns }, function () { return 'left'; }),
      rows: Array.from({ length: rows }, function () {
        return Array.from({ length: columns }, function () { return ''; });
      })
    };
  }

  /* ----------------------------------------------------------------------
     单元格转义

     GFM 的表格单元格是**行内解析**的：格子里写的 `*`、`[]`、`` ` ``、`<b>`
     会被当成强调 / 链接 / 代码段 / HTML，渲染出来就不是用户填的那几个字了。
     加一个反斜杠，渲染器就当普通字符处理，显示的就是原文。

     但**不是无脑加**：GFM 里行内代码（`` `x` ``）的内容本来就是字面量，
     不会再解析任何标记 —— 那里再加反斜杠，屏幕上只会多出几个 `\`。
     所以规则是「该挡的地方挡，不该挡的地方别挡」。
     ---------------------------------------------------------------------- */

  /**
   * 普通文本里要加反斜杠的东西。
   *
   * 反斜杠自己也在表里，而且必须第一个处理：用户输入的字面量 `\*`
   * 应该原样显示成 `\*`，不先把 `\` 转义掉的话，它会被当成「转义后的 *」
   * 而丢掉反斜杠。
   *
   * 逐个字符解释：
   *   \  反斜杠本身
   *   `  行内代码的定界符，成对出现时会吃掉后面的内容
   *   *  强调 / 粗体（词中间的 * 也会成对，强调跟 _ 不一样）
   *   _  强调 / 粗体
   *   ~  GFM 的删除线（~~删除~~）
   *   <  行内 HTML 与自动链接的开关（<b>、<https://…>）
   *   >  行内 HTML 的收尾
   *   [  链接 / 图片的开口（[文字](地址)）
   *   #  ATX 标题的井号
   *
   * `&` 只在**长得像一个 HTML 实体**时才加反斜杠：
   * `AT&T` 里的 `&` 不是实体（`&T` 没有分号、也不是实体名），转义它纯属制造噪声；
   * 但 `&amp;` / `&#65;` / `&nbsp;` 会被渲染成 &、A、不换行空格，那就得挡住。
   *
   * 两条合成**一个**正则、一趟扫完，不是图省事，是必须的：
   * `&#65;` 这种数字实体里的 `#` 本身也在加反斜杠的名单上。分两趟扫的话，
   * 第一趟先把 `#` 变成 `\#`，第二趟就认不出 `&#65;` 是个实体了，`&` 漏网 →
   * 渲染出来是个 A，而不是原文的 `&#65;`。一趟扫里，`&` 开头的整段实体
   * 先被匹配掉，里面的 `#` 不会被单独处理 ✓
   */
  var ESCAPE_RE = /[\\`*_~<>\[\]#]|&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{1,31};)/g;

  /**
   * 把单元格文本切成「普通段」与「代码段」。
   *
   * 代码段 = 用户自己写的一对等长反引号（`x` / ``x``）。
   * CommonMark 的规矩：
   *   · 收尾的反引号串必须跟开头一样长，长度不同的跳过；
   *   · 找不到配对时，这串反引号就是普通文字（不当代码段）。
   *
   * @param {string} text
   * @returns {{code: boolean, value: string, fence: string}[]}
   *   code 段：value 是正文（不含两端的反引号），fence 是那串反引号
   *   普通段：value 是原文，fence 为空串
   */
  function splitCodeSpans(text) {
    var segments = [];
    var plain = '';
    var i = 0;
    var n = text.length;

    function flush() {
      if (plain) { segments.push({ code: false, value: plain, fence: '' }); plain = ''; }
    }

    while (i < n) {
      if (text.charAt(i) !== '`') { plain += text.charAt(i); i++; continue; }

      // 开头这一串反引号有多长
      var open = 0;
      while (i + open < n && text.charAt(i + open) === '`') open++;

      // 往后找同样长度的收尾串；长度不同的按普通字符跳过
      var j = i + open;
      var close = -1;
      while (j < n) {
        if (text.charAt(j) === '`') {
          var len = 0;
          while (j + len < n && text.charAt(j + len) === '`') len++;
          if (len === open) { close = j; break; }
          j += len;
        } else {
          j++;
        }
      }

      if (close < 0) {
        // 没有配对 —— 这串反引号是普通文字
        plain += text.substr(i, open);
        i += open;
        continue;
      }

      flush();
      segments.push({
        code: true,
        value: text.substring(i + open, close),
        fence: text.substr(i, open)
      });
      i = close + open;
    }

    flush();
    return segments;
  }

  /**
   * 单元格内容 → 可以直接放进表格里的文本。
   *
   * 顺序：
   *   1. 按段转义（普通段加反斜杠、代码段原样保留）；
   *   2. 换行换成 `<br>`；
   *   3. 去掉首尾空白。
   *
   * 第 2 步必须排在第 1 步后面：我们插入的 `<br>` 是货真价实的 HTML，
   * 要是先换行再统一转义，它自己就被转义成文字「&lt;br&gt;」了。
   * 第 3 步跟上游一致（上游是「转义 → 换行 → trim」）。
   *
   * @param {string} value
   * @returns {string}
   */
  function escapeMarkdownTableCell(value) {
    var raw = String(value == null ? '' : value);

    var out = splitCodeSpans(raw).map(function (seg) {
      if (seg.code) {
        // 代码段里原样保留（内容本来就是字面量），但两件事例外：
        //   · `|` 必须转义 —— GFM 规定即使在行内结构里也要转义竖线，
        //     否则这一格会被从中间劈开；
        //   · 换行得把代码段断开 —— `<br>` 落在代码段里会被当成普通文字显示，
        //     断开来它才能真的换行。
        return seg.value.split(/(\r\n|\r|\n)/).map(function (part) {
          if (part === '') return '';
          if (part === '\r\n' || part === '\r' || part === '\n') return '<br>';
          return seg.fence + part.replace(/\|/g, '\\|') + seg.fence;
        }).join('');
      }
      return seg.value
        .replace(ESCAPE_RE, '\\$&')
        .replace(/\|/g, '\\|');
    }).join('');

    out = out.replace(/\r\n|\r|\n/g, '<br>');
    return out.trim();
  }

  /**
   * 列数 = max(表头数, 对齐数, 各行的长度)。
   * 行短了补空格，短的那几列照样对齐得上。
   *
   * @param {{headers: string[], alignments: string[], rows: string[][]}} table
   * @returns {number}
   */
  function getColumnCount(table) {
    var rows = table && table.rows ? table.rows : [];
    var max = Math.max(
      (table && table.headers ? table.headers.length : 0),
      (table && table.alignments ? table.alignments.length : 0)
    );
    rows.forEach(function (row) {
      if (row && row.length > max) max = row.length;
    });
    return max;
  }

  /**
   * 取一行的格子，缺的补空串，多余的截掉 —— 再逐个转义。
   *
   * @param {string[]} cells
   * @param {number} columns
   * @returns {string[]}
   */
  function getCells(cells, columns) {
    var src = cells || [];
    var out = [];
    for (var i = 0; i < columns; i++) {
      out.push(escapeMarkdownTableCell(src[i] === undefined || src[i] === null ? '' : src[i]));
    }
    return out;
  }

  /**
   * 一行 → `| a | b |`。
   *
   * @param {string[]} cells
   * @returns {string}
   */
  function formatRow(cells) {
    return '| ' + cells.join(' | ') + ' |';
  }

  /**
   * 整张表 → Markdown。
   *
   * @param {{headers: string[], alignments: string[], rows: string[][]}} table
   * @returns {string}
   */
  function generateMarkdownTable(table) {
    var columns = getColumnCount(table);
    if (columns === 0) return '';

    var headers = getCells(table.headers || [], columns);
    var alignments = table.alignments || [];
    var separators = [];
    for (var i = 0; i < columns; i++) {
      // 对不上号的（含不认识的值）一律按左对齐算，
      // 免得输出里出现字面量 "undefined"。
      separators.push(ALIGNMENT_SEPARATORS[alignments[i]] || ALIGNMENT_SEPARATORS.left);
    }
    var rows = (table.rows || []).map(function (row) {
      return formatRow(getCells(row, columns));
    });

    return [formatRow(headers), formatRow(separators)].concat(rows).join('\n');
  }

  /* ======================================================================
     界面
     ====================================================================== */

  window.ItTools.register('markdown-table-generator', function (root) {
    var model = createMarkdownTable({ rows: 2, columns: 3 });
    // createMarkdownTable 里的默认表头写死英文（上游就是这样，单测也盯着它），
    // 界面上换成当前语言的写法。
    model.headers = model.headers.map(function (_, i) {
      return t('col_default', 'Column {n}').replace('{n}', i + 1);
    });

    var tableBox = D.h('div');
    var output = D.h('textarea.layui-textarea', {
      rows: 10, readonly: 'readonly', spellcheck: 'false'
    });

    function render() {
      output.value = generateMarkdownTable(model);
    }

    /* ---- 表头一格：文字 + 对齐 + 删列 ---- */
    function headerCell(colIndex) {
      var input = D.h('input.layui-input', {
        type: 'text',
        value: model.headers[colIndex] || '',
        placeholder: t('ph_header', 'Column {n}').replace('{n}', colIndex + 1),
        spellcheck: 'false'
      });
      input.addEventListener('input', function () {
        model.headers[colIndex] = input.value;
        render();
      });

      var align = D.h('select.layui-select', { style: { flex: '1 1 auto', minWidth: '0' } }, [
        { value: 'left', label: t('align_left', 'Left') },
        { value: 'center', label: t('align_center', 'Center') },
        { value: 'right', label: t('align_right', 'Right') }
      ].map(function (opt) {
        return D.h('option', {
          value: opt.value,
          text: opt.label,
          selected: opt.value === (model.alignments[colIndex] || 'left')
        });
      }));
      align.addEventListener('change', function () {
        model.alignments[colIndex] = align.value;
        render();
      });

      var del = D.h('button.icon-btn', {
        type: 'button',
        text: '×',
        title: t('del_column', 'Delete this column'),
        'aria-label': t('del_column', 'Delete this column'),
        onclick: function () { removeColumn(colIndex); }
      });
      if (model.headers.length <= 1) del.disabled = true;

      return D.h('th', null,
        D.h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '150px' } },
          input,
          D.h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, align, del)
        )
      );
    }

    /* ---- 数据行的一格 ---- */
    function bodyCell(rowIndex, colIndex) {
      var cell = D.h('textarea.layui-textarea', {
        rows: 2,
        value: model.rows[rowIndex][colIndex] || '',
        placeholder: t('ph_cell', 'Row {r}, column {c}')
          .replace('{r}', rowIndex + 1).replace('{c}', colIndex + 1),
        spellcheck: 'false'
      });
      cell.addEventListener('input', function () {
        model.rows[rowIndex][colIndex] = cell.value;
        render();
      });
      return D.h('td', null, cell);
    }

    /* ---- 数据行（含删行按钮） ---- */
    function rowEl(rowIndex) {
      var cells = model.headers.map(function (_, colIndex) {
        return bodyCell(rowIndex, colIndex);
      });
      var del = D.h('button.icon-btn', {
        type: 'button',
        text: '×',
        title: t('del_row', 'Delete this row'),
        'aria-label': t('del_row', 'Delete this row'),
        onclick: function () { removeRow(rowIndex); }
      });
      // 只剩一行时不给删 —— 全删光了就没东西可生成的了
      if (model.rows.length <= 1) del.disabled = true;
      return D.h('tr', null, cells.concat([D.h('td', null, del)]));
    }

    /* ---- 整张编辑表 ---- */
    function draw() {
      D.clear(tableBox);
      var headCells = model.headers.map(function (_, colIndex) { return headerCell(colIndex); });
      headCells.push(D.h('th', { text: '' }));
      var bodyRows = model.rows.map(function (_, rowIndex) { return rowEl(rowIndex); });

      tableBox.appendChild(D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null, headCells)),
        D.h('tbody', null, bodyRows)
      ));
      render();
    }

    /* ---- 增删行列 ---- */
    function addColumn() {
      var n = model.headers.length + 1;
      model.headers.push(t('col_default', 'Column {n}').replace('{n}', n));
      model.alignments.push('left');
      model.rows.forEach(function (row) { row.push(''); });
      draw();
    }

    function removeColumn(index) {
      if (model.headers.length <= 1) return;
      model.headers.splice(index, 1);
      model.alignments.splice(index, 1);
      model.rows.forEach(function (row) { row.splice(index, 1); });
      draw();
    }

    function addRow() {
      model.rows.push(model.headers.map(function () { return ''; }));
      draw();
    }

    function removeRow(index) {
      if (model.rows.length <= 1) return;
      model.rows.splice(index, 1);
      draw();
    }

    var addRowBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: t('add_row', 'Add row'), onclick: addRow
    });
    var addColBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: t('add_column', 'Add column'), onclick: addColumn
    });

    root.appendChild(D.h('div.card', null,
      D.h('div.form-actions', null, addRowBtn, addColBtn),
      tableBox,
      D.h('p.field-hint', { text: t('hint_escape',
        'Cell content is plain text: the characters Markdown would read as markup get a backslash, so the table shows exactly what you typed. Put a part between backticks to keep it as inline code.') })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('output', 'Generated Markdown table') }),
        U.copyButton(function () { return output.value; }, t('copy_md', 'Copy Markdown'))
      ),
      output
    ));

    draw();

    return { destroy: function () { D.clear(root); } };
  });

  /* ======================================================================
     导出与自测
     ====================================================================== */

  window.ItTools.logic['markdown-table-generator'] = {
    createMarkdownTable: createMarkdownTable,
    escapeMarkdownTableCell: escapeMarkdownTableCell,
    splitCodeSpans: splitCodeSpans,
    getColumnCount: getColumnCount,
    getCells: getCells,
    formatRow: formatRow,
    generateMarkdownTable: generateMarkdownTable,
    __cases: function (assert) {
      /* ---- 与参考实现的 vitest 用例逐条对齐（期望值逐字节照抄上游的 inline snapshot） ---- */
      assert.eq(createMarkdownTable({ rows: 1, columns: 2 }), {
        headers: ['Column 1', 'Column 2'],
        alignments: ['left', 'left'],
        rows: [['', '']]
      }, 'createMarkdownTable：1 行 2 列，表头是 Column N、对齐默认左对齐、格子全空');

      assert.eq(escapeMarkdownTableCell(' foo | bar\nbaz '), 'foo \\| bar<br>baz',
        'escapeMarkdownTableCell：竖线转义、换行换 <br>、首尾空白去掉');

      assert.eq(generateMarkdownTable({
        headers: ['Name', 'Count', 'Notes'],
        alignments: ['left', 'right', 'center'],
        rows: [
          ['Alpha', '10', 'Ready'],
          ['Beta', '3', 'Needs review']
        ]
      }), '| Name | Count | Notes |\n| :--- | ---: | :---: |\n| Alpha | 10 | Ready |\n| Beta | 3 | Needs review |',
        'generateMarkdownTable：带列对齐的表格（上游 inline snapshot 逐字节照抄）');

      assert.eq(generateMarkdownTable({
        headers: ['Name'],
        alignments: ['left'],
        rows: [['Alpha', 'Extra']]
      }), '| Name |  |\n| :--- | :--- |\n| Alpha | Extra |',
        'generateMarkdownTable：列数取各行长度的最大值，短的那一列补空格（上游 inline snapshot 逐字节照抄）');

      /* ---- 上游没覆盖的边界 ---- */
      assert.eq(createMarkdownTable(), {
        headers: ['Column 1', 'Column 2', 'Column 3'],
        alignments: ['left', 'left', 'left'],
        rows: [['', '', ''], ['', '', '']]
      }, 'createMarkdownTable：不带参数时是 2 行 3 列');
      assert.eq(generateMarkdownTable({ headers: [], alignments: [], rows: [] }), '',
        'generateMarkdownTable：一列都没有时返回空串');
      assert.eq(generateMarkdownTable({
        headers: ['A', 'B'], alignments: ['left'], rows: [['x']]
      }), '| A | B |\n| :--- | :--- |\n| x |  |',
        '对齐标记比表头少时按左对齐补齐');
      assert.eq(generateMarkdownTable({
        headers: ['A'], alignments: ['middle'], rows: [['x']]
      }), '| A |\n| :--- |\n| x |',
        '不认识的对齐值按左对齐算，不往输出里塞 undefined');
      assert.eq(generateMarkdownTable({
        headers: ['A'], alignments: ['left', 'right'], rows: [['x']]
      }), '| A |  |\n| :--- | ---: |\n| x |  |',
        '对齐标记比表头多时按上游的规则多出一列（列数取三者最大值）');
      assert.eq(getColumnCount({ headers: ['a', 'b', 'c'], alignments: ['left'], rows: [] }), 3,
        'getColumnCount：取表头、对齐、各行长度里的最大值');

      /* ---- 补上的转义：上游漏掉的那几个字符 ---- */
      assert.eq(escapeMarkdownTableCell('*斜体*'), '\\*斜体\\*',
        '星号加反斜杠 —— 上游不管它，GFM 会把 *斜体* 吃成强调');
      assert.eq(escapeMarkdownTableCell('_下划线_'), '\\_下划线\\_',
        '下划线加反斜杠');
      assert.eq(escapeMarkdownTableCell('**粗体**'), '\\*\\*粗体\\*\\*',
        '粗体的两个星号也挡掉');
      assert.eq(escapeMarkdownTableCell('<b>粗</b>'), '\\<b\\>粗\\</b\\>',
        '尖括号加反斜杠 —— 不挡的话这段会被当成内联 HTML');
      assert.eq(escapeMarkdownTableCell('[链接](http://x)'), '\\[链接\\](http://x)',
        '方括号加反斜杠 —— 不挡的话这段会变成真的链接');
      assert.eq(escapeMarkdownTableCell('# 标题'), '\\# 标题',
        '井号加反斜杠');
      assert.eq(escapeMarkdownTableCell('~~删除~~'), '\\~\\~删除\\~\\~',
        '波浪号加反斜杠 —— GFM 的删除线');
      assert.eq(escapeMarkdownTableCell('a`b'), 'a\\`b',
        '没有配对的反引号按普通文字处理，但要挡住');
      assert.eq(escapeMarkdownTableCell('`code`'), '`code`',
        '用户自己写的行内代码原样保留 —— 代码段里的内容本来就是字面量，加反斜杠只会多出几个斜杠');
      assert.eq(escapeMarkdownTableCell('``a`b``'), '``a`b``',
        '两个反引号的代码段也原样保留');
      assert.eq(escapeMarkdownTableCell('`未闭合'), '\\`未闭合',
        '没配上的反引号不算代码段');
      assert.eq(escapeMarkdownTableCell('`a|b`'), '`a\\|b`',
        '竖线即使在代码段里也要转义 —— GFM 规定行内结构里的竖线照样分隔格子');
      assert.eq(escapeMarkdownTableCell('`a\nb`'), '`a`<br>`b`',
        '代码段里的换行把代码段断开 —— <br> 落在代码段里会显示成四个字');
      assert.eq(escapeMarkdownTableCell('\\*'), '\\\\\\*',
        '反斜杠自己也要转义 —— 用户输入的字面量 \\* 得原样显示');
      assert.eq(escapeMarkdownTableCell('AT&T'), 'AT&T',
        '不是实体的 & 不动 —— AT&T 里的 & 渲染出来就是 &');
      assert.eq(escapeMarkdownTableCell('&amp;'), '\\&amp;',
        '长得像 HTML 实体的 & 要挡住 —— &amp; 会被渲染成 &');
      assert.eq(escapeMarkdownTableCell('&#65;'), '\\&#65;',
        '数字实体也要挡住');
      assert.eq(escapeMarkdownTableCell('a|b'), 'a\\|b',
        '竖线加反斜杠');
      assert.eq(escapeMarkdownTableCell('a\r\nb'), 'a<br>b',
        'Windows 换行也换 <br>');
      assert.eq(escapeMarkdownTableCell('  x  '), 'x',
        '首尾空白去掉');
      assert.eq(escapeMarkdownTableCell(''), '', '空串');
      assert.eq(escapeMarkdownTableCell(null), '', 'null 当空串');
      assert.eq(escapeMarkdownTableCell(undefined), '', 'undefined 当空串');
      assert.eq(escapeMarkdownTableCell(42), '42', '数字按字符串处理');

      /* ---- 转义之后的整张表 ---- */
      assert.eq(generateMarkdownTable({
        headers: ['列 *A*', 'B'],
        alignments: ['left', 'center'],
        rows: [['a | b', '`code`']]
      }), '| 列 \\*A\\* | B |\n| :--- | :---: |\n| a \\| b | `code` |',
        '整张表里每一格都走同一套转义');
    }
  };
})();
