/* ==========================================================================
   列表转换器（list-converter）

   一行一个的列表，按开关与前后缀重新拼接：去重、排序、反转、大小写、
   条目前后缀、列表前后缀、自定义分隔符、是否保留换行。

   参考实现：src/tools/list-converter/（it-tools, GPLv3）
   移植说明：原版是一串 lodash chain（uniq → reverse → sort → trim → without('')），
   这里用原生数组方法按同样的顺序重写，行为与原版逐条对齐（去重发生在 trim 之前、
   空串在 trim 之后剔除，都是原版的语义，不是 bug，照搬）。原版 lodash 是外部依赖，
   一律换成 Set / sort / filter / map / join。
   - 补了下载按钮（上游 #1169）：输出区多一个 Download 按钮，把结果存成
     output.txt。下载用的是 app.js 里早就写好的 ItTools.download，
     这里只是把按钮补上（文件名与上游一致）。
   - 补了数值排序（上游 #1302 的「六行那半」）：上游给排序加了 8 种档位
     （asc/desc 之外还有 asc-num / desc-num / asc-bin / desc-bin /
     asc-upper / desc-upper），这里只取其中的数值排序：
     `localeCompare` 带 `{ numeric: true }` 时把字符串里的连续数字当成一个数，
     于是 "2" 排在 "10" 前面，而不是字典序那样 "10" 在前。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('list-converter');

  /** 与参考实现 useStorage 里的初始配置一致 */
  var DEFAULTS = {
    lowerCase: false,
    trimItems: true,
    removeDuplicates: true,
    keepLineBreaks: false,
    itemPrefix: '',
    itemSuffix: '',
    listPrefix: '',
    listSuffix: '',
    reverseList: false,
    sortList: null,
    separator: ', '
  };

  /** 合并默认配置，调用方只写自己关心的字段即可 */
  function withDefaults(options) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    if (options) {
      Object.keys(options).forEach(function (k) {
        if (options[k] !== undefined && options[k] !== null) out[k] = options[k];
      });
    }
    return out;
  }

  /** 保留首次出现（等价于 lodash 的 uniq） */
  function uniq(list) {
    var seen = new Set();
    return list.filter(function (item) {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  /**
   * 排序比较器。上游 #1302 把排序扩成了 8 种档位，这里只取其中的**数值排序**那半
   * （`asc-num` / `desc-num`）：`localeCompare` 带 `{ numeric: true }` 时会把字符串
   * 里的连续数字当成一个数来比，于是 "2" 排在 "10" 前面，而不是字典序那样
   * "10" 在前。其余档位（bin / upper）没做 —— 那是另一件事，不在这次的范围里。
   * @param {string} order 'asc' | 'desc' | 'asc-num' | 'desc-num'
   * @returns {function(string, string): number}
   */
  function byOrder(order) {
    if (order === 'asc-num' || order === 'desc-num') {
      return function (a, b) {
        var compare = a.localeCompare(b, undefined, { numeric: true });
        return order === 'asc-num' ? compare : -compare;
      };
    }
    return function (a, b) {
      return order === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
    };
  }

  /**
   * 把多行列表按配置拼成一行（或保留换行）。
   * 步骤与参考实现完全一致：整体小写 → 按行切 → 去重 → 反转 → 排序 →
   * 逐项 trim → 丢弃空串 → 加条目前后缀 → 用分隔符连接 → 加列表前后缀。
   * @param {string} list 原始多行文本
   * @param {object} options 见 DEFAULTS
   * @returns {string}
   */
  function convert(list, options) {
    var o = withDefaults(options);
    var lineBreak = o.keepLineBreaks ? '\n' : '';

    var items = (o.lowerCase ? String(list).toLowerCase() : String(list)).split('\n');
    if (o.removeDuplicates) items = uniq(items);
    if (o.reverseList) items = items.slice().reverse();
    if (o.sortList) {
      items.sort(byOrder(o.sortList));
    }
    items = items
      .map(function (item) { return o.trimItems ? item.trim() : item; })
      .filter(function (item) { return item !== ''; })
      .map(function (item) { return o.itemPrefix + item + o.itemSuffix; });

    return [o.listPrefix, items.join(o.separator + lineBreak), o.listSuffix].join(lineBreak);
  }

  window.ItTools.register('list-converter', function (root) {
    var opts = withDefaults(null);

    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20, spellcheck: 'false', placeholder: t('input_ph', 'Paste your input data here...')
    });
    input.value = 'apple\nbanana\ncherry\nbanana';
    var output = U.codeBlock();

    /**
     * 一行「开关 / 控件」。
     *
     * 标签列的宽度是**按这一行**定的 —— 原版这一页有两种：
     *   Sort list / Separator   c-select / c-input-text 显式写的
     *                            label-width="120px" label-align="right"
     *   Wrap item / Wrap list   n-form-item label-placement="left" label-width="120"
     *                            （实测 naive-ui 的 n-form-item 标签也是右对齐）
     * 对齐两边都是右对齐。
     */
    function optionRow(labelText, control, hint, rowOpts) {
      rowOpts = rowOpts || {};
      var style = { '--field-label-width': rowOpts.width || '120px' };
      style['--field-label-align'] = rowOpts.align || 'right';
      return D.h('div.field-row', { style: style },
        D.h('label.field-label', { text: labelText }),
        control,
        hint ? D.h('span.field-hint', { text: hint }) : null
      );
    }

    /**
     * 一个开关。原版是 n-form-item label-placement="left" label-width="150"
     * 包着 n-switch —— 标签在左、150px、**右对齐**（实测原版 naive-ui 的
     * n-form-item 标签一律右对齐）。所以这里标签和开关要分成两个元素。
     */
    function toggle(key, labelText) {
      var box = D.h('input', { type: 'checkbox', checked: opts[key] });
      box.checked = !!opts[key];
      box.id = 'lc-' + key;
      box.addEventListener('change', function () {
        opts[key] = box.checked;
        if (key === 'reverseList') sortSelect.disabled = opts.reverseList;
        render();
      });
      return D.h('div.field-row', {
        style: { '--field-label-width': '150px', '--field-label-align': 'right' }
      },
        D.h('label.field-label', { for: box.id, text: labelText }),
        D.h('label.switch', null, box, D.h('span'))
      );
    }

    function text(key, placeholder) {
      var el = D.h('input.layui-input', { type: 'text', value: opts[key], placeholder: placeholder || '' });
      el.addEventListener('input', function () { opts[key] = el.value; render(); });
      return el;
    }

    var toggles = [
      toggle('trimItems', t('trim_items', 'Trim list items')),
      toggle('removeDuplicates', t('remove_duplicates', 'Remove duplicates')),
      toggle('lowerCase', t('lower_case', 'Convert to lowercase')),
      toggle('keepLineBreaks', t('keep_line_breaks', 'Keep line breaks')),
      toggle('reverseList', t('reverse_list', 'Reverse list'))
    ];

    var sortSelect = D.h('select.layui-select', null,
      D.h('option', { value: '', text: t('sort_none', 'Sort: none') }),
      D.h('option', { value: 'asc', text: t('sort_asc', 'Sort ascending') }),
      D.h('option', { value: 'desc', text: t('sort_desc', 'Sort descending') }),
      D.h('option', { value: 'asc-num', text: t('sort_asc_num', 'Sort ascending (numeric)') }),
      D.h('option', { value: 'desc-num', text: t('sort_desc_num', 'Sort descending (numeric)') })
    );
    sortSelect.addEventListener('change', function () {
      opts.sortList = sortSelect.value || null;
      render();
    });

    function render() {
      output.value = convert(input.value, opts);
    }
    input.addEventListener('input', render);
    input.id = 'lc-input';

    // 原版把选项排成**两列**：左边一列是几个开关，右边一列是下拉框、
    // 分隔符和两个「前后缀」输入框。
    //
    // 两列的宽度也是照着原版来的：原版是 `<div flex>` 里一个**内容宽**的
    // 左边列（实测 190px = 150px 标签 + 开关）加一个 `flex-1` 的右边列
    // （实测 360px），两列之间**没有间隙**。我们的 .option-columns 默认把
    // 两列均分（各自 263px、中间留 24px），右列的标签会被推到 x=852，
    // 比原版的 x=755 偏了将近 100px —— 表格宽度和控件宽度也跟着不对。
    // 所以这里显式写成「左列内容宽、右列占满剩余」。
    root.appendChild(D.h('div.card', null,
      D.h('div.option-columns', { style: { columnGap: '0' } },
        D.h('div.option-column', { style: { flex: '0 1 auto' } }, toggles),
        // 右列的 basis 不能是 0：basis 0 的话「假设主尺寸」就是 0，
        // 排版时这一列会被当成「不占地方」，于是跟左列（内容宽 192px）
        // 挤在同一行里，右列只剩几十像素 —— 它那几行的标签
        // （120px，右对齐）就这么顶出卡片，320px 下整页横向溢出 33px。
        // basis 给成标签的宽度（120 + 12px 内边距），放不下时这一列
        // 自动换到下一行、自己占满整行，标签就放得下了。
        D.h('div.option-column', { style: { flex: '1 1 132px' } },
          optionRow(t('sort_list', 'Sort list'), sortSelect, t('sort_hint', 'Sorting has no effect while reverse is on')),
          optionRow(t('separator', 'Separator'), text('separator', ', ')),
          optionRow(t('wrap_item', 'Wrap item'), D.h('div.input-group', null, text('itemPrefix', t('prefix_ph', 'prefix')), text('itemSuffix', t('suffix_ph', 'suffix'))), null, { width: '120px' }),
          optionRow(t('wrap_list', 'Wrap list'), D.h('div.input-group', null, text('listPrefix', t('prefix_ph', 'prefix')), text('listSuffix', t('suffix_ph', 'suffix'))), null, { width: '120px' })
        )
      )
    ));

    root.appendChild(D.h('div', null,
      D.h('div.field', null,
        D.h('label.field-label', { for: 'lc-input', text: t('input_data', 'Your input data') }),
        input,
        D.h('p.field-hint', { text: t('input_hint', 'One list item per line.') })
      ),
      D.h('div.code-label', { text: t('output_data', 'Your transformed data') }),
      output.card,
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download', 'Download'), onclick: function () {
            if (output.value) {
              window.ItTools.download('output.txt', output.value, 'text/plain;charset=utf-8');
            }
          }
        })
      )
    ));

    render();
    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['list-converter'] = {
    DEFAULTS: DEFAULTS,
    convert: convert,
    uniq: uniq,
    byOrder: byOrder,
    __cases: function (assert) {
      // 与参考实现 vitest 用例一致
      var base = {
        separator: ', ', trimItems: true, removeDuplicates: true,
        itemPrefix: '"', itemSuffix: '"', listPrefix: '', listSuffix: '',
        reverseList: false, sortList: null, lowerCase: false, keepLineBreaks: false
      };
      assert.eq(
        convert('\n        1\n        2\n        \n        3\n        3\n        4\n        ', base),
        '"1", "2", "3", "4"',
        '去重 + 引号包裹'
      );
      assert.eq(convert('', base), '', '空输入');

      var htmlOpts = {
        separator: '', trimItems: true, itemPrefix: '<li>', itemSuffix: '</li>',
        listPrefix: '<ul>', listSuffix: '</ul>', keepLineBreaks: true,
        lowerCase: false, removeDuplicates: false, reverseList: false, sortList: null
      };
      assert.eq(
        convert('\n        1\n        2\n        3\n        ', htmlOpts),
        '<ul>\n<li>1</li>\n<li>2</li>\n<li>3</li>\n</ul>',
        '保留换行 + 列表包裹'
      );

      // 与参考实现 e2e 用例一致（options 传 null 时用默认配置）
      assert.eq(convert('1\n    2\n    3\n    4\n    5', null), '1, 2, 3, 4, 5', '默认配置');
      assert.eq(
        convert('1\n    2\n    2\n    4\n    4\n    3\n    5', {
          removeDuplicates: true, trimItems: true, itemPrefix: "'", itemSuffix: "'", separator: ', '
        }),
        "'1', '2', '4', '3', '5'",
        '去重保持首次出现的顺序'
      );

      // 排序 / 反转
      // 排序用 localeCompare（和原版一致），它按语言习惯排序，
      // 所以 'a' 排在 'A' 前面，不同平台的 ICU 版本可能不同，这里只断言字母序
      assert.eq(convert('b\nA\na', { sortList: 'asc' }), 'a, A, b', '升序');
      assert.eq(convert('b\nA\na', { sortList: 'desc' }), 'b, A, a', '降序');
      assert.eq(convert('c\nb\na', { sortList: 'asc' }), 'a, b, c', '纯小写升序');
      assert.eq(convert('a\nb\nc', { sortList: 'desc' }), 'c, b, a', '纯小写降序');
      assert.eq(convert('1\n2\n3', { reverseList: true, sortList: null }), '3, 2, 1', '反转');
      assert.eq(convert('x\ny', { lowerCase: true, itemPrefix: '' }), 'x, y', '整体小写');
      assert.eq(convert('X\nY', { lowerCase: true, sortList: null }), 'x, y', '小写后去重键也变了');
      assert.eq(convert('  a  \nb', { trimItems: false }), '  a  , b', '不 trim 时保留缩进');
      assert.eq(convert('a\nb', { separator: '' }), 'ab', '空分隔符');
      assert.eq(convert('a\nb', { separator: ' | ' }), 'a | b', '自定义分隔符');
      assert.eq(convert('a', { listPrefix: '[', listSuffix: ']' }), '[a]', '列表前后缀');

      // uniq 保留首次出现
      assert.eq(uniq(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c'], 'uniq');

      // 数值排序（上游 #1302）
      assert.eq(convert('3\n20\n1', { sortList: 'asc-num' }), '1, 3, 20', '数值升序：2 排在 10 前面');
      assert.eq(convert('1\n20\n3', { sortList: 'desc-num' }), '20, 3, 1', '数值降序');
      assert.eq(
        convert('img10\nimg2\nimg1', { sortList: 'asc-num' }),
        'img1, img2, img10',
        '带前缀的数值排序：只比数字部分'
      );
      // 字典序会把 "10" 排在 "2" 前面，数值排序才反过来 —— 这正是这一档的用处
      assert.eq(convert('10\n2', { sortList: 'asc' }), '10, 2', '字典序：10 在 2 前面');
      assert.eq(convert('10\n2', { sortList: 'asc-num' }), '2, 10', '数值序：2 在 10 前面');
      // 混排：数字在前，字母按 localeCompare 兜底
      assert.eq(
        convert('a\nA\ná\n1\n2\n10\n一\n阿', { sortList: 'asc-num' }),
        '1, 2, 10, a, A, á, 一, 阿',
        '数值排序里的字母部分仍是 localeCompare'
      );
      // 缩进不影响数值比较（工具自带的示例输入就是带缩进的；
      // 默认 trimItems 为 true，所以输出里没有缩进）
      assert.eq(convert(' 3\n 20\n 1', { sortList: 'asc-num' }), '1, 3, 20', '带缩进也按数值排');
      // byOrder 直接可用
      assert.eq(
        ['1', '10', '2'].sort(byOrder('asc-num')),
        ['1', '2', '10'],
        'byOrder 的数值升序'
      );
    }
  };
})();