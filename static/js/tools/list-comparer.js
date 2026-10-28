/* ==========================================================================
   列表对比（list-comparer）

   两栏各一行一个条目，比出「只在第一份」「只在第二份」「两份都有」三组，
   每组给出条目数与条目列表，可以单独复制。

   参考实现：src/tools/list-comparer/（it-tools2，Vue）
   与上游那版的差别（上游那版有几处真问题，这里逐条绕开）：
   1. 上游的「忽略大小写」是**先把两边整体转成小写再比**，所以结果里显示的
      永远是小写 —— A 里写的是 "Apple"、B 里写的是 "apple"，
      「两份都有」那组显示的是 "apple"，A 的原始写法丢了。
      这里把「比较用的键」和「显示用的原文」分开：键归一化（trim + 小写），
      显示用原文；两份都有时显示 **A 的写法**。
   2. 上游组件里有个 noDuplicate（去重）开关，但它**从没传给 service** ——
      service 的三个结果各自套了 new Set，等于去重永远开着、那个开关是死的。
      这里把去重做成真的开关（默认开），关掉时重复条目会原样留在结果里。
   3. 上游的「额外分隔符」是直接拼进正则的（new RegExp(`(?:${sep}|\\n)`)）：
      填 "." 会变成「匹配任意字符」，填 "(" 直接抛 SyntaxError。
      这一版不做这个功能 —— 一行一个条目就够了，也就没有正则可拼。
   4. 上游不丢空行：文本末尾多打一个换行，结果里就会多出一个空条目。
      这里把归一化后为空的行丢掉（trim 开着时纯空白行也丢）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('list-comparer');

  var DEFAULTS = {
    /** 去重（同一份列表里重复的条目只留第一次出现的） */
    dedupe: true,
    /** 忽略大小写（只影响比较，显示仍是原文） */
    ignoreCase: false,
    /** 忽略首尾空白 */
    trim: true
  };

  /** 合并默认配置，调用方只写自己关心的字段即可 */
  function withDefaults(options) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    if (options) {
      Object.keys(options).forEach(function (k) {
        if (options[k] !== undefined && options[k] !== null) out[k] = !!options[k];
      });
    }
    return out;
  }

  /** 按行切。\r\n / \r / \n 都算换行。 */
  function splitLines(text) {
    return String(text == null ? '' : text).split(/\r\n|\r|\n/);
  }

  /**
   * 整理一份列表。
   *
   * 每一项记两样东西：
   *   text —— 显示用的写法（按 trim 开关决定要不要去掉首尾空白，大小写原样保留）
   *   key  —— 比较用的键（text 再按 ignoreCase 开关转小写）
   */
  function prepareList(text, opts) {
    var lines = splitLines(text);
    var out = [];
    var seen = new Set();
    for (var i = 0; i < lines.length; i++) {
      var value = opts.trim ? lines[i].trim() : lines[i];
      if (value === '') continue;            // 空行不算条目
      var key = opts.ignoreCase ? value.toLowerCase() : value;
      if (opts.dedupe) {
        if (seen.has(key)) continue;          // 去重：留第一次出现的
        seen.add(key);
      }
      out.push({ text: value, key: key });
    }
    return out;
  }

  /**
   * 比两份列表。
   *
   * @param {string} list1 第一份（多行文本）
   * @param {string} list2 第二份（多行文本）
   * @param {object} [options] {dedupe, ignoreCase, trim}
   * @returns {{onlyA: string[], onlyB: string[], both: string[]}}
   */
  function compareLists(list1, list2, options) {
    var opts = withDefaults(options);
    var a = prepareList(list1, opts);
    var b = prepareList(list2, opts);
    var keysA = new Set(a.map(function (x) { return x.key; }));
    var keysB = new Set(b.map(function (x) { return x.key; }));
    return {
      // 只在 A：B 里没有这个键
      onlyA: a.filter(function (x) { return !keysB.has(x.key); }).map(function (x) { return x.text; }),
      // 只在 B：A 里没有这个键
      onlyB: b.filter(function (x) { return !keysA.has(x.key); }).map(function (x) { return x.text; }),
      // 两份都有：显示 **A 的写法**（忽略大小写时 B 的写法不重复列出来）
      both: a.filter(function (x) { return keysB.has(x.key); }).map(function (x) { return x.text; })
    };
  }

  window.ItTools.register('list-comparer', function (root) {
    var opts = withDefaults(null);

    var textA = D.h('textarea.layui-textarea.mono', {
      rows: 12, spellcheck: 'false', placeholder: t('list_ph', 'One item per line')
    });
    var textB = D.h('textarea.layui-textarea.mono', {
      rows: 12, spellcheck: 'false', placeholder: t('list_ph', 'One item per line')
    });
    // 自带一份例子，打开就能看到三组结果（跟 list-converter 的做法一样）
    textA.value = 'apple\nbanana\ncherry\ndate';
    textB.value = 'banana\ncherry\nelderberry';

    var resultBody = D.h('div');

    /** 一个开关 */
    function toggle(key, labelText) {
      var box = D.h('input', { type: 'checkbox' });
      box.checked = !!opts[key];
      D.on(box, 'change', function () {
        opts[key] = box.checked;
        render();
      });
      return D.h('label.switch', null, box, D.h('span', { text: labelText }));
    }

    /** 一组结果：标题 + 条目数 + 复制按钮 + 条目列表 */
    function groupBlock(title, items) {
      var count = items.length;
      var countText = count === 1
        ? t('count_item', '{n} item').replace('{n}', function () { return '1'; })
        : t('count_items', '{n} items').replace('{n}', function () { return String(count); });
      return D.h('div', { style: { marginBottom: '18px' } },
        D.h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' } },
          D.h('span', { style: { fontWeight: '500' }, text: title }),
          D.h('span.muted', { style: { fontSize: '13px' }, text: countText }),
          U.copyButton(function () { return items.join('\n'); }, t('copy', 'Copy'))
        ),
        // .output-body：等宽、按词换行、条目长了会滚动
        D.h('pre.output-body', {
          style: { margin: '0' },
          text: items.length ? items.join('\n') : t('none', '(none)')
        })
      );
    }

    function render() {
      var res = compareLists(textA.value, textB.value, opts);
      D.clear(resultBody);
      resultBody.appendChild(groupBlock(t('group_only_a', 'Only in the first list'), res.onlyA));
      resultBody.appendChild(groupBlock(t('group_only_b', 'Only in the second list'), res.onlyB));
      resultBody.appendChild(groupBlock(t('group_both', 'In both lists'), res.both));
    }

    var offs = [
      D.on(textA, 'input', render),
      D.on(textB, 'input', render)
    ];

    // 输入卡：开关 + 两栏文本
    root.appendChild(D.h('div.card', null,
      D.h('div.switch-grid', null,
        toggle('dedupe', t('opt_dedupe', 'Remove duplicates')),
        toggle('ignoreCase', t('opt_ignore_case', 'Ignore case')),
        toggle('trim', t('opt_trim', 'Trim whitespace'))
      ),
      D.h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
        D.h('div', { style: { flex: '1 1 260px', minWidth: '0' } },
          U.field(t('list_a', 'First list'), textA, {
            wide: true,
            hint: t('hint_case', 'When case is ignored, the spelling of the first list is shown.')
          })),
        D.h('div', { style: { flex: '1 1 260px', minWidth: '0' } },
          U.field(t('list_b', 'Second list'), textB, { wide: true }))
      )
    ));

    // 结果卡：三组
    root.appendChild(D.h('div.card', null, resultBody));

    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['list-comparer'] = {
    DEFAULTS: DEFAULTS,
    compareLists: compareLists,
    prepareList: prepareList,
    splitLines: splitLines,
    __cases: function (assert) {
      /* ---- 基本分组 ---- */
      var r = compareLists('a\nb\nc', 'b\nc\nd');
      assert.eq(r.onlyA, ['a'], '只在第一份');
      assert.eq(r.onlyB, ['d'], '只在第二份');
      assert.eq(r.both, ['b', 'c'], '两份都有');

      assert.eq(compareLists('', '').both, [], '两个空串');
      assert.eq(compareLists('a', '').onlyA, ['a'], '第二份为空');
      assert.eq(compareLists('', 'a').onlyB, ['a'], '第一份为空');

      /* ---- 忽略大小写：显示 A 的写法 ---- */
      r = compareLists('Apple\nbanana', 'apple\nBANANA', { ignoreCase: true });
      assert.eq(r.both, ['Apple', 'banana'], '忽略大小写时显示第一份的写法');
      assert.eq(r.onlyA, [], '忽略大小写时没有只在第一份的');
      assert.eq(r.onlyB, [], '忽略大小写时没有只在第二份的');

      // 不忽略大小写：Apple 与 apple 是两个条目
      r = compareLists('Apple\nbanana', 'apple\nBANANA');
      assert.eq(r.onlyA, ['Apple', 'banana'], '不忽略大小写时 A 的两个都在 A 独有');
      assert.eq(r.onlyB, ['apple', 'BANANA'], '不忽略大小写时 B 的两个都在 B 独有');
      assert.eq(r.both, [], '不忽略大小写时没有共同的');

      /* ---- 忽略首尾空白 ---- */
      r = compareLists('  a  \nb', 'a\nb', { trim: true });
      assert.eq(r.both, ['a', 'b'], 'trim 后两边一样');
      assert.eq(r.onlyA, [], 'trim 后 A 没有独有');

      r = compareLists('  a  \nb', 'a\nb', { trim: false });
      assert.eq(r.onlyA, ['  a  '], '不 trim 时带空白的条目算不同');
      assert.eq(r.onlyB, ['a'], '不 trim 时 B 的写法原样');
      assert.eq(r.both, ['b'], '不 trim 时只有 b 是共同的');

      /* ---- 去重 ---- */
      r = compareLists('a\na\nb', 'b', { dedupe: true });
      assert.eq(r.onlyA, ['a'], '去重后 A 只有一个 a');
      assert.eq(r.both, ['b'], 'b 在两份里都有');

      r = compareLists('a\na\nb', 'b', { dedupe: false });
      assert.eq(r.onlyA, ['a', 'a'], '不去重时重复的 a 都留着');
      assert.eq(r.both, ['b'], 'b 仍然只有一份里各一个');

      // 去重是按「归一化后的键」去重的：忽略大小写时 A 与 a 算同一个
      r = compareLists('A\na', 'b', { dedupe: true, ignoreCase: true });
      assert.eq(r.onlyA, ['A'], '忽略大小写时 A 与 a 只留第一个');
      r = compareLists('A\na', 'b', { dedupe: true, ignoreCase: false });
      assert.eq(r.onlyA, ['A', 'a'], '不忽略大小写时 A 与 a 是两个');

      /* ---- 空行不算条目（上游会多出一个空条目） ---- */
      r = compareLists('a\n', 'a');
      assert.eq(r.onlyA, [], '末尾多一个换行不多出空条目');
      assert.eq(r.both, ['a'], 'a 还是共同的');
      r = compareLists('a\n\n\nb', 'a\nb');
      assert.eq(r.both, ['a', 'b'], '中间的空行不算条目');

      // trim 开着时纯空白行也不算；关掉时它是正经条目
      assert.eq(compareLists('a\n   ', 'a').onlyA, [], 'trim 时纯空白行不算条目');
      assert.eq(compareLists('a\n   ', 'a', { trim: false }).onlyA, ['   '], '不 trim 时空白行是条目');

      /* ---- 顺序：按各自列表里第一次出现的顺序 ---- */
      r = compareLists('z\ny\nx', 'y\nx\nz');
      assert.eq(r.onlyA, [], '顺序不同不影响分组');
      r = compareLists('z\ny\nx', 'q');
      assert.eq(r.onlyA, ['z', 'y', 'x'], 'A 独有按 A 的顺序');
      r = compareLists('q', 'z\ny\nx');
      assert.eq(r.onlyB, ['z', 'y', 'x'], 'B 独有按 B 的顺序');

      /* ---- 换行符：\r\n 与 \r 也算换行 ---- */
      assert.eq(compareLists('a\r\nb', 'a\nb').both, ['a', 'b'], 'CRLF 当换行');
      assert.eq(compareLists('a\rb', 'a\nb').both, ['a', 'b'], 'CR 当换行');
    }
  };
})();
