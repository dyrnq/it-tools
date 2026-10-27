/* ==========================================================================
   YAML 美化 / 查看器（yaml-viewer，路由 /yaml-prettify）

   把一段 YAML 解析后按固定缩进重新输出，可选把映射的键按字母序排序。
   参考实现：src/tools/yaml-viewer/（it-tools, GPLv3）

   ---- 库里核到的 API 形状 ----
   - 全局 YAML（eemeli 的 `yaml` 包）：YAML.parse(str) / YAML.stringify(obj, opts)。
   - opts 里排序键是 `sortMapEntries`（不是 json-viewer 那种手工排），
     缩进是 `indent`，**必须是正整数**：传 0 或负数会抛
     `"indent" option must be a positive integer`。
   - YAML.parse('') 返回 null，YAML.stringify(undefined) 返回 undefined（不是串），
     所以空输入和 undefined 要在这里就挡掉，不然输出区会显示 "null"。
   - 多文档（`---` 分隔）YAML.parse 会抛，提示改用 parseAllDocuments；
     本工具是单文档 prettifier，原样把这条报错透出去。

   ---- 与参考实现的差别 ----
   - 参考实现的 formatYaml 对空输入返回 "null\n"（yaml.parse('')===null，
     yaml.stringify(null) 恰好不报错），对着空输入框会凭空冒出一行 null。这里
     空输入返回空串。
   - 参考实现用 withDefaultOnError 把异常吞成空串，解析失败时输出区悄悄变空白。
     这里改成抛错并把库报的行列位置显示出来。
   - 参考实现的缩进下拉最小值是 1（因为 0 会抛），这里保持一致，并在
     normalizeIndent 里兜住非数字 / NaN。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('yaml-viewer');

  var DEFAULT_INDENT = 2;
  var MAX_INDENT = 10;

  /**
   * 缩进归一化。yaml 的 indent 只收正整数（0 会抛），范围外的回落默认值。
   * @param {*} n
   * @returns {number}
   */
  function normalizeIndent(n) {
    if (n === undefined) return DEFAULT_INDENT;
    var v = typeof n === 'number' ? n : Number(n);
    if (!(v >= 1) || v > MAX_INDENT) return DEFAULT_INDENT;   // !(v >= 1) 顺带挡掉 NaN
    return Math.floor(v);
  }

  /**
   * 主函数：原始 YAML → 美化后的 YAML 文本。
   * 空输入返回空串，非法输入抛错（带库的行列信息）。
   *
   * @param {string} rawYaml
   * @param {{sortKeys?: boolean, indentSize?: number}} [opts]
   * @returns {string}
   */
  function formatYaml(rawYaml, opts) {
    opts = opts || {};
    var src = rawYaml === null || rawYaml === undefined ? '' : String(rawYaml);
    if (src.trim() === '') return '';

    // 解析前保住超范围整数，YAML 会把它无声地舍成相邻的浮点值
    var parsed = YAML.parse(U.guardBigIntegers(src, { hashComment: true }));  // 解析失败在这里抛，不吞
    if (parsed === undefined) return '';

    var out = YAML.stringify(parsed, {
      sortMapEntries: opts.sortKeys === true,   // 参考实现默认 false
      indent: normalizeIndent(opts.indentSize)
    });
    // stringify(undefined) 返回 undefined
    return typeof out === 'string' ? U.restoreBigIntegers(out) : '';
  }

  /**
   * 是否是能被格式化的 YAML。空串算合法（对应什么都没填）。
   * @param {string} rawYaml
   * @returns {boolean}
   */
  function isValidYaml(rawYaml) {
    var src = rawYaml === null || rawYaml === undefined ? '' : String(rawYaml);
    if (src.trim() === '') return true;
    try { formatYaml(src); return true; } catch (e) { return false; }
  }

  /* ---------- UI ---------- */

  window.ItTools.register('yaml-viewer', function (root) {
    // 原版这两个框是 monospace 的
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 12, spellcheck: 'false', placeholder: t('input_ph', 'Paste your raw YAML here...')
    });
    input.value = 'key: value\nlist:\n  - a\n  - b\n';

    var output = U.codeBlock();
    var error = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });

    var sortInput = D.h('input', { type: 'checkbox' });
    // 原版的缩进框是 n-input-number，宽度写死 100px（style="width: 100px"），
    // 放在左标签那一列里 —— 这里跟着给 select 同样的宽度。
    var indentSelect = D.h('select.layui-select', { style: { width: '100px', flex: '0 0 100px' } });
    for (var n = 1; n <= MAX_INDENT; n++) {       // 从 1 起：yaml 的 indent 不收 0
      indentSelect.appendChild(D.h('option', { value: String(n), text: String(n) }));
    }
    indentSelect.value = String(DEFAULT_INDENT);

    function render() {
      D.clear(error);
      try {
        output.value = formatYaml(input.value, {
          sortKeys: sortInput.checked,
          indentSize: Number(indentSelect.value)
        });
      } catch (e) {
        output.value = '';
        // YAML 的报错是多行的，带 ^ 指示位置，直接取第一行显示，别糊满整个页面
        var msg = e && e.message ? String(e.message).split('\n')[0] : String(e);
        error.textContent = t('err_invalid', 'Provided YAML is not valid.') + ' ' + msg;
      }
    }

    sortInput.addEventListener('change', render);
    indentSelect.addEventListener('change', render);
    var off = D.on(input, 'input', render);

    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      // 原版顶部是两个 n-form-item，都是 label-placement="left"（标签在左、右对齐）
      // 且 label-width="100"，摆在一条居中的 flex 行里（gap 12px = gap-3）。
      D.h('div', { style: { display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '14px' } },
        D.h('div.field-row', { style: { '--field-label-width': '100px', '--field-label-align': 'right', marginBottom: '0', flex: '0 1 auto' } },
          D.h('label.field-label', { text: t('sort_keys', 'Sort keys') }),
          D.h('label.switch', null, sortInput, D.h('span'))),
        D.h('div.field-row', { style: { '--field-label-width': '100px', '--field-label-align': 'right', marginBottom: '0', flex: '0 1 auto' } },
          D.h('label.field-label', { text: t('indent_size', 'Indent size:') }),
          indentSelect)
      ),
      U.field(t('input', 'Your raw YAML'), input),
      error
    ));
    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'Prettified version of your YAML') }),
      output.card
    ));
    render();

    return { destroy: function () { off(); D.clear(root); } };
  });

  window.ItTools.logic['yaml-viewer'] = {
    normalizeIndent: normalizeIndent,
    formatYaml: formatYaml,
    isValidYaml: isValidYaml,
    __cases: function (assert) {
      /* ---- 正常值 ---- */
      assert.eq(formatYaml('a: 1'), 'a: 1\n', '最简单的一条');
      assert.eq(formatYaml('key: value\nlist:\n  - a\n  - b\n'),
        'key: value\nlist:\n  - a\n  - b\n', '缩进本来就是对的，原样输出');
      assert.eq(formatYaml('a:\n    b: 1'), 'a:\n  b: 1\n', '缩进从 4 变成 2');
      assert.eq(formatYaml('a:\n  b: 1', { indentSize: 4 }), 'a:\n    b: 1\n', '缩进 4');
      assert.eq(formatYaml('a:\n  b: 1', { indentSize: 1 }), 'a:\n b: 1\n', '缩进 1');
      assert.eq(formatYaml('- 1\n- a\n'), '- 1\n- a\n', '顶层数组');
      assert.eq(formatYaml('b: 2\na: 1'), 'b: 2\na: 1\n', '默认不排序，保留原序');
      assert.eq(formatYaml('b: 2\na: 1', { sortKeys: true }), 'a: 1\nb: 2\n', '打开排序');
      assert.eq(formatYaml('b: 2\na: 1\nc:\n  z: 1\n  y: 2\n', { sortKeys: true }),
        'a: 1\nb: 2\nc:\n  y: 2\n  z: 1\n', '递归排序嵌套映射');
      assert.eq(formatYaml('a: &x 1\nb: *x'), 'a: 1\nb: 1\n', '锚点/别名被展开成实际值');
      assert.eq(formatYaml('a: |\n  l1\n  l2\n'), 'a: |\n  l1\n  l2\n', '块标量');
      assert.eq(formatYaml('"": empty\n"null": x\na b: 1\nyes: true\n'),
        '"": empty\n"null": x\na b: 1\nyes: true\n', '会被误读的键自动加引号');
      assert.eq(formatYaml('# 只是注释\na: 1'), 'a: 1\n', '注释不会被保留');
      assert.eq(formatYaml('a: 1 # 行尾注释'), 'a: 1\n', '行尾注释不会被保留');

      /* ---- 边界 ---- */
      assert.eq(formatYaml(''), '', '空输入 —— 参考实现这里会吐一行 "null"');
      assert.eq(formatYaml('   \n '), '', '纯空白');
      assert.eq(formatYaml(null), '', 'null 输入');
      assert.eq(formatYaml('~'), 'null\n', 'YAML 的 null 写法');
      assert.eq(formatYaml('# 只有注释'), 'null\n', '只有注释 → 文档是空的 → 输出 null（这是 yaml 库的行为）');
      assert.eq(formatYaml('a: 1', { indentSize: 0 }), 'a: 1\n', '缩进 0 被挡在函数外，不会抛库那个错');
      assert.eq(formatYaml('a: 1', { indentSize: 99 }), 'a: 1\n', '越界缩进回落到 2');
      assert.eq(formatYaml('a: 1', { indentSize: 'x' }), 'a: 1\n', '非数字缩进回落到 2');
      assert.eq(formatYaml('a: 1', { indentSize: 3.7 }), 'a: 1\n', '小数缩进取整后仍合法');

      /* ---- normalizeIndent ---- */
      assert.eq(normalizeIndent(undefined), 2, '默认 2');
      assert.eq(normalizeIndent(4), 4, '4 原样');
      assert.eq(normalizeIndent('6'), 6, '数字字符串也认');
      assert.eq(normalizeIndent(0), 2, '0 会让 yaml 的 stringify 抛错，挡掉');
      assert.eq(normalizeIndent(-1), 2, '负数挡掉');
      assert.eq(normalizeIndent(11), 2, '越界挡掉');
      assert.eq(normalizeIndent(NaN), 2, 'NaN 挡掉');
      assert.eq(normalizeIndent('abc'), 2, '非数字挡掉');

      /* ---- isValidYaml ---- */
      assert(isValidYaml('a: 1'), '合法 YAML');
      assert(isValidYaml(''), '空串算合法');
      assert(isValidYaml('   '), '纯空白算合法');
      assert(!isValidYaml('a: [1, 2'), '流式序列没闭合');
      assert(!isValidYaml('a: 1\n---\nb: 2'), '多文档：库建议改用 parseAllDocuments');

      /* ---- 错误输入必须抛错（参考实现是吞成空串）---- */
      ['a: [1, 2', 'a:\n\tb: 1', '{a: 1', 'a: 1\n---\nb: 2'].forEach(function (bad) {
        var threw = false;
        try { formatYaml(bad); } catch (e) { threw = true; }
        assert(threw, '非法输入 ' + JSON.stringify(bad) + ' 应抛错');
      });
      // 报错里带行列，UI 至少要能显示第一行
      var msg = '';
      try { formatYaml('a: [1, 2'); } catch (e) { msg = e.message; }
      assert(/YAMLParseError|line/.test(msg), '报错里有行列信息，实际：' + JSON.stringify(msg.split('\n')[0]));
    }
  };
})();