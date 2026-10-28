/* ==========================================================================
   目录结构图（folder-structure-diagram）

   把一份缩进式的目录结构（或者一份 a/b/c 这样的路径列表）画成树状图。

   参考实现：src/tools/folder-structure-diagram/（it-tools, GPLv3）
   与上游的差别：
   1. 上游的 parseInput 把「前导空白的**字符个数**」当缩进量 ——
      一个制表符算 1、四个空格算 4。缩进用 tab 和用空格的文件混在一起时，
      层级会整个乱掉。这里按**列数**算缩进（制表位每 4 列），
      tab 缩进与 4 空格缩进算出来是一回事。
   2. 上游只吃缩进式输入；这里多认一种：a/b/c 这样的路径列表
      （一行一个路径，按 / 拆成层级）。
   3. 上游是双向的（树 ⇄ 缩进文本，两个编辑器加两个输出框）；
      这里只做「输入 → 树」这一个方向，一张输入卡 + 一张结果卡。
   4. 上游的输出是一个 textarea；等宽的 ASCII 图放在 textarea 里
      会被浏览器的软换行搞乱。这里用 pre（不折行、横向滚动），
      并调 U.monoCjk —— 目录名里有中文时不调，汉字的字宽跟等宽格对不上。
   5. 上游的 parseInput 在解析不出来时直接 throw；这里任何输入都出一棵树
      （空输入就是空树），不往用户脸上抛异常。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('folder-structure-diagram');

  /** 制表位宽度：一个制表符推进到下一个 4 的倍数 */
  var TAB_STOP = 4;

  /** 树的三种连接符（每个都是 4 格宽） */
  var CHILD = '├── ';
  var LAST_CHILD = '└── ';
  var PIPE = '│   ';
  var BLANK = '    ';

  /** 上游那份样例的精简版 */
  var SAMPLE = [
    'my-app',
    '  src',
    '    index.html',
    '    main.ts',
    '  build',
    '    main.js',
    '  README.md'
  ].join('\n');

  /**
   * 宽字符区间 —— 「算两格」与「渲染两格」必须落在同一批码点上。
   * 详见 _docs/js-tool-conventions.md。
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

  function str(v) {
    return v == null ? '' : String(v);
  }

  /**
   * 前导空白占了多少**列**。
   *
   * 制表符推进到下一个制表位（4 的倍数），空格算一列。
   * 上游按「空白字符个数」算 —— 一个 tab 算 1、四个空格算 4，
   * tab 缩进和空格缩进混用时层级会乱。
   */
  function indentColumns(ws) {
    var col = 0;
    for (var i = 0; i < ws.length; i++) {
      if (ws.charAt(i) === '\t') col += TAB_STOP - (col % TAB_STOP);
      else col++;
    }
    return col;
  }

  /**
   * 拆一行：缩进列数 + 名字。
   *
   * markdown 的项目符号（`- name`）也剥掉 —— 上游的样例里就有，
   * 少了这一层，"- test" 会变成一个叫 "- test" 的目录。
   */
  function parseLine(content) {
    var m = /^(\s*)([\s\S]*)$/.exec(str(content));
    var ws = m[1];
    var name = m[2].replace(/^-\s+/, '');
    return { indent: indentColumns(ws), name: name };
  }

  /**
   * 拆一整段文本：空行扔掉，剩下的按顺序返回。
   * @returns {Array<{indent: number, name: string}>}
   */
  function parseInput(text) {
    return str(text)
      .split(/\r\n|\n|\r/)
      .map(parseLine)
      .filter(function (item) { return item.name !== ''; });
  }

  /**
   * 这一行是不是「路径」：中间有斜杠。
   *
   * 末尾的斜杠不算 —— `src/` 是「叫 src 的目录」，不是一条路径。
   */
  function isPathName(name) {
    return /\/.*[^\s/]/.test(str(name));
  }

  /** 整段输入按路径列表处理吗？（只要有一行是路径就算） */
  function isPathInput(items) {
    return items.some(function (item) { return isPathName(item.name); });
  }

  /**
   * 按缩进建树。
   *
   * 栈里存着「当前的祖先链」：新的一行缩进比栈顶大就是栈顶的孩子，
   * 不大就往上弹，弹到第一个缩进比它小的祖先那儿。
   */
  function buildFromIndents(items) {
    var root = { name: '.', children: [] };
    var stack = [{ node: root, indent: -1 }];
    items.forEach(function (item) {
      while (stack.length > 1 && stack[stack.length - 1].indent >= item.indent) stack.pop();
      var parent = stack[stack.length - 1].node;
      var node = { name: item.name, children: [] };
      parent.children.push(node);
      stack.push({ node: node, indent: item.indent });
    });
    return root;
  }

  /**
   * 按路径建树：a/b/c 与 a/b/d 合成同一个 a → b，下面挂 c 和 d。
   */
  function buildFromPaths(items) {
    var root = { name: '.', children: [] };
    items.forEach(function (item) {
      var segments = item.name.split('/')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s !== ''; });
      var node = root;
      segments.forEach(function (seg) {
        var found = null;
        for (var i = 0; i < node.children.length; i++) {
          if (node.children[i].name === seg) { found = node.children[i]; break; }
        }
        if (!found) {
          found = { name: seg, children: [] };
          node.children.push(found);
        }
        node = found;
      });
    });
    return root;
  }

  /**
   * 画树。
   *
   * 两条规矩：
   *   1. 同一批兄弟里，**最后一个**用 └──，其余用 ├──；
   *   2. 子树的缩进前缀跟着父亲走：父亲是最后一个兄弟（└──）就用空格，
   *      否则用 │（竖线只在确实还有兄弟的时候画）。
   */
  function renderTree(root) {
    var lines = [root.name];
    walk(root, '', lines);
    return lines.join('\n');
  }

  function walk(node, prefix, lines) {
    node.children.forEach(function (child, i) {
      var last = i === node.children.length - 1;
      lines.push(prefix + (last ? LAST_CHILD : CHILD) + child.name);
      walk(child, prefix + (last ? BLANK : PIPE), lines);
    });
  }

  /** 树里一共有多少个节点（不含根） */
  function countNodes(node) {
    var n = 0;
    node.children.forEach(function (c) { n += 1 + countNodes(c); });
    return n;
  }

  /**
   * 输入 → 树。
   *
   * @param {string} input
   * @returns {{text: string, mode: string, count: number, root: object}}
   */
  function generateTree(input) {
    var items = parseInput(input);
    if (!items.length) return { text: '', mode: 'empty', count: 0, root: { name: '.', children: [] } };
    var mode = isPathInput(items) ? 'path' : 'indent';
    var root = mode === 'path' ? buildFromPaths(items) : buildFromIndents(items);
    return { text: renderTree(root), mode: mode, count: countNodes(root), root: root };
  }

  window.ItTools.register('folder-structure-diagram', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 14,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste the indented structure or the list of paths here...')
    });
    input.value = SAMPLE;

    var statusEl = D.h('p.form-status');
    var outPre = D.h('pre.code-body.mono');

    function render() {
      var result = generateTree(input.value);
      outPre.textContent = result.text;
      if (!result.count) {
        statusEl.classList.remove('is-error');
        statusEl.textContent = t('status_empty', 'Nothing to draw: the input is empty.');
        return;
      }
      statusEl.classList.remove('is-error');
      statusEl.textContent = t('status_count', '{n} entries')
        .replace('{n}', function () { return String(result.count); });
    }

    var offs = [
      D.on(input, 'input', render)
    ];

    root.appendChild(D.h('div.card', null,
      U.field(t('input_label', 'Folder structure:'), input, { wide: true }),
      D.h('p.field-hint', {
        text: t('hint', 'Indent each level by two or four spaces (or use tabs), or list the paths one per line (a/b/c). The tree is drawn with the box-drawing characters.')
      })
    ));

    root.appendChild(D.h('div.card.code-card', null,
      D.h('div.form-actions', null,
        D.h('span.output-label', { text: t('output_label', 'Tree diagram') }),
        U.copyButton(function () { return outPre.textContent; })
      ),
      statusEl,
      outPre
    ));

    render();

    // 让屏幕上的汉字正好占两格（详见 _docs/js-tool-conventions.md）。
    // 目录名里常有中文：不调的话汉字的字宽跟等宽格对不上，画出来的树是歪的。
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

  window.ItTools.logic['folder-structure-diagram'] = {
    TAB_STOP: TAB_STOP,
    CHILD: CHILD,
    LAST_CHILD: LAST_CHILD,
    PIPE: PIPE,
    BLANK: BLANK,
    indentColumns: indentColumns,
    parseLine: parseLine,
    parseInput: parseInput,
    isPathName: isPathName,
    isPathInput: isPathInput,
    buildFromIndents: buildFromIndents,
    buildFromPaths: buildFromPaths,
    renderTree: renderTree,
    countNodes: countNodes,
    generateTree: generateTree,
    __cases: function (assert) {
      /* ---- 缩进按列数算，不按空白字符个数 ---- */
      assert.eq(indentColumns(''), 0, '没有缩进');
      assert.eq(indentColumns('  '), 2, '两个空格是两列');
      assert.eq(indentColumns('    '), 4, '四个空格是四列');
      assert.eq(indentColumns('\t'), 4, '一个制表符推进到第四列');
      assert.eq(indentColumns('  \t'), 4, '两列之后一个制表符停在第四列');
      assert.eq(indentColumns('\t  '), 6, '一个制表符之后两个空格是六列');
      assert.eq(indentColumns(' \t'), 4, '第一列之后制表符停在第四列');

      /* ---- 拆行 ---- */
      assert.eq(parseLine('  src').indent, 2, '缩进两列');
      assert.eq(parseLine('  src').name, 'src', '名字是 src');
      assert.eq(parseLine('  - test').name, 'test', 'markdown 项目符号被剥掉');
      assert.eq(parseLine('-main.js').name, '-main.js', '横杠后面不是空白就不剥');
      assert.eq(parseInput('a\n\n  b\n').length, 2, '空行被丢掉');
      assert.eq(parseInput('   \n').length, 0, '只有空白的行被丢掉');
      assert.eq(parseInput('').length, 0, '空串没有条目');

      /* ---- 路径行 ---- */
      assert.eq(isPathName('a/b'), true, '中间有斜杠是路径');
      assert.eq(isPathName('src/'), false, '末尾的斜杠不算路径');
      assert.eq(isPathName('src'), false, '没有斜杠不是路径');
      assert.eq(isPathName('a/b/'), true, 'a/b/ 是路径');

      /* ---- 缩进式建树 ---- */
      var tree = generateTree([
        'my-app',
        '  src',
        '    index.html',
        '    main.ts',
        '  build',
        '    main.js',
        '  README.md'
      ].join('\n'));
      assert.eq(tree.mode, 'indent', '缩进输入走缩进模式');
      assert.eq(tree.text, [
        '.',
        '└── my-app',
        '    ├── src',
        '    │   ├── index.html',
        '    │   └── main.ts',
        '    ├── build',
        '    │   └── main.js',
        '    └── README.md'
      ].join('\n'), '缩进式输入画出的树');
      assert.eq(tree.count, 7, '七个条目');

      /* ---- 兄弟节点的最后一个用 └── ---- */
      assert.eq(generateTree('a\nb\nc').text, [
        '.',
        '├── a',
        '├── b',
        '└── c'
      ].join('\n'), '三个兄弟：最后一个是 └──');
      assert.eq(generateTree('a').text, [
        '.',
        '└── a'
      ].join('\n'), '只有一个兄弟：它就是最后一个');

      /* ---- 竖线只在确实还有兄弟的时候画 ---- */
      assert.eq(generateTree([
        'root',
        '  a',
        '    x',
        '  b'
      ].join('\n')).text, [
        '.',
        '└── root',
        '    ├── a',
        '    │   └── x',
        '    └── b'
      ].join('\n'), 'a 下面还有兄弟 b，所以 a 的子树带竖线');
      assert.eq(generateTree([
        'root',
        '  a',
        '    x',
        '    y'
      ].join('\n')).text, [
        '.',
        '└── root',
        '    └── a',
        '        ├── x',
        '        └── y'
      ].join('\n'), 'a 是最后一个兄弟，它的子树没有竖线');

      /* ---- 路径式建树 ---- */
      var paths = generateTree([
        'a/b/c',
        'a/b/d',
        'a/e'
      ].join('\n'));
      assert.eq(paths.mode, 'path', '路径输入走路径模式');
      assert.eq(paths.text, [
        '.',
        '└── a',
        '    ├── b',
        '    │   ├── c',
        '    │   └── d',
        '    └── e'
      ].join('\n'), '路径列表合成一棵树');
      assert.eq(generateTree('a/b/c').text, [
        '.',
        '└── a',
        '    └── b',
        '        └── c'
      ].join('\n'), '一条路径就是一条链');

      /* ---- 空输入不炸 ---- */
      assert.eq(generateTree('').text, '', '空输入画不出东西');
      assert.eq(generateTree('').count, 0, '空输入没有条目');
      assert.eq(generateTree('   \n\n  ').count, 0, '只有空白也没有条目');

      /* ---- 制表符缩进跟四空格缩进是一回事 ---- */
      assert.eq(generateTree('a\n\tb\n\t\tc').text, generateTree('a\n    b\n        c').text,
        '制表符缩进画出来的树跟四空格缩进一样');
    }
  };
})();
