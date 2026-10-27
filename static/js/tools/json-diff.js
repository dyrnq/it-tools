/* ==========================================================================
   JSON 对比（json-diff）

   逐层对比两份 JSON，标出新增 / 删除 / 变更 / 子项变更。

   参考实现：src/tools/json-diff/（it-tools, GPLv3）
   与原版的差别 —— **原版会崩**。它的 createDifference 只看旧值的类型：
       const type = getType(value);        // 只看 value，不看 newValue
   于是旧值是对象、新值是字符串时，它会走进 diffObjects，而 Object.keys("abc")
   返回 ['0','1','2'] —— 把字符串的每个字符当成键去比，页面输出的是垃圾。
   这里改成**两侧类型一致才递归**，否则一律按「值变了」处理。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('json-diff');

  /**
   * JSON 值的结构类型。null 归到 'value' —— 它没有子项可比。
   * @param {*} value
   * @returns {'object'|'array'|'value'}
   */
  function getType(value) {
    if (value === null || value === undefined) return 'value';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    return 'value';
  }

  /** 深相等。lodash.isEqual 的等价实现（键顺序不影响结果）。 */
  function deepEqual(a, b) {
    if (a === b) return true;
    // NaN === NaN 在这里应视为相等，和 lodash 一致
    if (typeof a === 'number' && typeof b === 'number') return a !== a && b !== b;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

    var aIsArr = Array.isArray(a), bIsArr = Array.isArray(b);
    if (aIsArr !== bIsArr) return false;
    if (aIsArr) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[j])) return false;
      if (!deepEqual(a[ka[j]], b[ka[j]])) return false;
    }
    return true;
  }

  /**
   * 状态判定。顺序有讲究：先看「某一侧压根不存在」，再看是否相等，
   * 最后才区分「容器内部变了」与「值直接变了」。
   */
  function getStatus(value, newValue) {
    if (value === undefined) return 'added';
    if (newValue === undefined) return 'removed';
    if (deepEqual(value, newValue)) return 'unchanged';
    var t1 = getType(value), t2 = getType(newValue);
    if (t1 === t2 && (t1 === 'object' || t1 === 'array')) return 'children-updated';
    return 'updated';
  }

  /**
   * 比较某个键上的两个值。
   *
   * 与原版的实质差别：**只有两侧都是同一种容器才递归**。
   * 原版只看旧值类型，{a:1} 对 "abc" 会走进对象分支，把字符串拆成字符键。
   */
  function createDifference(value, newValue, key, opts) {
    opts = opts || {};
    var t1 = getType(value), t2 = getType(newValue);
    var status = getStatus(value, newValue);
    var base = { key: key, status: status, value: newValue, oldValue: value };

    // 两侧都是对象，且至少有一侧存在 —— 递归比子项
    if (t1 === 'object' && t2 === 'object' && (value !== undefined || newValue !== undefined)) {
      var oldObj = value && typeof value === 'object' ? value : {};
      var newObj = newValue && typeof newValue === 'object' ? newValue : {};
      base.type = 'object';
      base.children = diffObjects(oldObj, newObj, opts);
      return base;
    }
    // 同理，两侧都是数组
    if (t1 === 'array' && t2 === 'array' && (value !== undefined || newValue !== undefined)) {
      base.type = 'array';
      base.children = diffArrays(value || [], newValue || [], opts);
      return base;
    }
    // 类型不一致（一侧对象一侧标量、一侧 null 一侧对象……）一律按值处理
    base.type = 'value';
    return base;
  }

  /** 对象逐键比较。键取两侧并集，按旧对象在前、新对象追加的顺序。 */
  function diffObjects(obj, newObj, opts) {
    opts = opts || {};
    var keys = Object.keys(obj);
    Object.keys(newObj).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    return keys
      .map(function (key) { return createDifference(obj[key], newObj[key], key, opts); })
      .filter(function (d) { return !opts.onlyShowDifferences || d.status !== 'unchanged'; });
  }

  /** 数组按下标比较，长度取两者较大值。 */
  function diffArrays(arr, newArr, opts) {
    opts = opts || {};
    var maxLength = Math.max(arr.length, newArr.length);
    var out = [];
    for (var i = 0; i < maxLength; i++) {
      out.push(createDifference(arr[i], newArr[i], i, opts));
    }
    return out.filter(function (d) { return !opts.onlyShowDifferences || d.status !== 'unchanged'; });
  }

  /**
   * 主函数：返回根 Difference。
   * @param {*} obj
   * @param {*} newObj
   * @param {{onlyShowDifferences?: boolean}} [opts]
   */
  function diff(obj, newObj, opts) {
    opts = opts || {};
    if (getType(obj) === getType(newObj)) {
      return createDifference(obj, newObj, '', opts);
    }
    // 顶层类型就不同（比如对象 vs 数组），只能整体当「值」处理
    return { key: '', type: 'value', value: newObj, oldValue: obj, status: getStatus(obj, newObj) };
  }

  /** 统计各状态的数量，用于结果区标题。 */
  function summarize(node) {
    var counts = { added: 0, removed: 0, updated: 0, unchanged: 0, 'children-updated': 0 };
    (function walk(n) {
      counts[n.status] = (counts[n.status] || 0) + 1;
      (n.children || []).forEach(walk);
    })(node);
    return counts;
  }

  /** 差异树里是否真的有变化（unchanged 不算）。 */
  function hasChanges(node) {
    if (node.status !== 'unchanged') return true;
    return (node.children || []).some(hasChanges);
  }

  /** 状态徽章上的显示名（状态本身是数据，getStatus 返回的值不动）。 */
  var STATUS_LABEL = {
    added: t('status_added', 'added'),
    removed: t('status_removed', 'removed'),
    updated: t('status_updated', 'updated'),
    unchanged: t('status_unchanged', 'unchanged'),
    'children-updated': t('status_changed', 'changed')
  };

  /** 把一棵差异树渲染成 DOM。 */
  function renderNode(node, depth) {
    var row = D.h('div.diff-line', {
      style: { paddingLeft: (depth * 16) + 'px' }
    });
    row.appendChild(D.h('span.badge-note', {
      text: STATUS_LABEL[node.status] || node.status,
      style: { marginRight: '8px' }
    }));
    row.appendChild(D.h('span', { text: node.key === '' ? t('root', '(root)') : String(node.key) }));

    // 哨兵值是字符串，JSON.stringify 会连引号一起打出来；先逐值还原成数字文本
    var showValue = function (v) {
      return JSON.stringify(U.restoreBigIntegerValue(v));
    };
    if (node.status === 'updated') {
      row.appendChild(D.h('span', {
        text: ': ' + showValue(node.oldValue) + ' → ' + showValue(node.value)
      }));
    } else if (node.status === 'added' && node.type === 'value') {
      row.appendChild(D.h('span', { text: ': ' + showValue(node.value) }));
    } else if (node.status === 'removed' && node.type === 'value') {
      row.appendChild(D.h('span', { text: ': ' + showValue(node.oldValue) }));
    }

    (node.children || []).forEach(function (child) {
      row.appendChild(renderNode(child, depth + 1));
    });
    return row;
  }

  window.ItTools.register('json-diff', function (root) {
    // 原版这两个框是 monospace 的
    var left = D.h('textarea.layui-textarea.mono', { rows: 9, spellcheck: 'false', placeholder: t('left_ph', '{ "foo": "bar" }') });
    var right = D.h('textarea.layui-textarea.mono', { rows: 9, spellcheck: 'false', placeholder: t('right_ph', '{ "foo": "baz" }') });
    var output = D.h('div');
    var onlyDiff = false;

    function switchRow(labelText, initial, onChange) {
      var input = D.h('input', { type: 'checkbox', checked: initial });
      input.addEventListener('change', function () { onChange(input.checked); render(); });
      return D.h('label.switch', null, input, D.h('span', { text: labelText }));
    }

    function render() {
      D.clear(output);
      var lt = left.value.trim(), rt = right.value.trim();
      if (!lt && !rt) { output.appendChild(D.h('p.field-hint', { text: t('hint_paste_two', 'Paste two JSON documents to compare.') })); return; }

      var a, b;
      // 保护超范围整数：JSON.parse 会把 9223372036854775807 舍成 …776000，
      // 于是「两边其实一样」会被误判成有差异
      try { a = JSON.parse(U.guardBigIntegers(lt) || 'null'); }
      catch (e) { output.appendChild(D.h('p.field-hint', { text: t('err_left_invalid', 'Left JSON is invalid: ') + e.message })); return; }
      try { b = JSON.parse(U.guardBigIntegers(rt) || 'null'); }
      catch (e) { output.appendChild(D.h('p.field-hint', { text: t('err_right_invalid', 'Right JSON is invalid: ') + e.message })); return; }

      var tree = diff(a, b, { onlyShowDifferences: onlyDiff });
      if (!hasChanges(tree)) {
        output.appendChild(D.h('p.field-hint', { text: t('hint_same', 'The provided JSONs are the same.') }));
        return;
      }
      var c = summarize(tree);
      output.appendChild(D.h('p.field-hint', {
        text: t('summary', '+{added} added · −{removed} removed · ~{updated} changed · {containers} containers')
          .replace('{added}', c.added)
          .replace('{removed}', c.removed)
          .replace('{updated}', c.updated)
          .replace('{containers}', c['children-updated'])
      }));
      output.appendChild(renderNode(tree, 0));
    }

    var offLeft = D.on(left, 'input', render);
    var offRight = D.on(right, 'input', render);
    // 原版是两个 c-input-text **上下排**（不是左右并排），
    // 标签在各自框的**上面**一行 —— c-label 的默认 label-position="top"。
    //
    // 两块面板：左边输入、右边差异结果。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      U.field(t('left_json', 'Left JSON'), left, { wide: true }),
      U.field(t('right_json', 'Right JSON'), right, { wide: true }),
      D.h('div.switch-grid', null,
        switchRow(t('only_show_differences', 'Only show differences'), false, function (v) { onlyDiff = v; })
      )
    ));
    root.appendChild(D.h('div.card', null, output));
    render();

    return {
      destroy: function () {
        offLeft(); offRight();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['json-diff'] = {
    diff: diff,
    createDifference: createDifference,
    diffObjects: diffObjects,
    diffArrays: diffArrays,
    getType: getType,
    getStatus: getStatus,
    deepEqual: deepEqual,
    summarize: summarize,
    hasChanges: hasChanges,
    __cases: function (assert) {
      // getType
      assert.eq(getType(null), 'value', 'null 归为 value');
      assert.eq(getType(undefined), 'value', 'undefined 归为 value');
      assert.eq(getType([]), 'array', '数组');
      assert.eq(getType({}), 'object', '对象');
      assert.eq(getType(1), 'value', '数字');

      // deepEqual：键顺序无关，NaN 相等
      assert(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), '键顺序不影响相等');
      assert(deepEqual([1, [2, 3]], [1, [2, 3]]), '嵌套数组');
      assert(!deepEqual([1, 2], [2, 1]), '数组按位置比');
      assert(!deepEqual([1, 2], [1, 2, 3]), '长度不同');
      assert(!deepEqual({ a: 1 }, { a: 1, b: undefined }), '多一个键就不相等');
      assert(deepEqual(NaN, NaN), 'NaN 与 lodash 一致视为相等');
      assert(!deepEqual({ a: 1 }, { a: '1' }), '1 与 "1" 不相等');

      // 基本状态
      assert.eq(getStatus(undefined, 1), 'added', '新增的键');
      assert.eq(getStatus(1, undefined), 'removed', '消失的键');
      assert.eq(getStatus(1, 1), 'unchanged', '相同');
      assert.eq(getStatus(1, 2), 'updated', '标量变化');
      assert.eq(getStatus({ a: 1 }, { a: 2 }), 'children-updated', '对象内部变化');
      assert.eq(getStatus([1], [2]), 'children-updated', '数组内部变化');

      // 对象对比
      var r = diff({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 });
      assert.eq(r.type, 'object', '根是对象');
      assert.eq(r.children.length, 3, '三个键');
      assert.eq(r.children[0].status, 'unchanged', 'a 未变');
      assert.eq(r.children[2].status, 'added', 'c 是新增');
      assert.eq(r.children[2].key, 'c', '新增键名');

      // 只显示差异
      var only = diff({ foo: 'bar' }, { foo: 'bar', baz: 'qux' }, { onlyShowDifferences: true });
      assert.eq(only.children.length, 1, '未变的 foo 被滤掉');
      assert.eq(only.children[0].key, 'baz', '只剩 baz');

      // 数组按下标
      var arr = diff([1, 2, 3], [1, 9, 3]);
      assert.eq(arr.children.length, 3, '按下标三项');
      assert.eq(arr.children[1].status, 'updated', '第二项变了');
      assert.eq(arr.children[1].oldValue, 2, '保留旧值');
      assert.eq(arr.children[1].value, 9, '保留新值');

      // 数组变长：多出来的算新增
      var grown = diff([1], [1, 2]);
      assert.eq(grown.children[1].status, 'added', '新下标是新增');

      // === 原版的崩溃点：类型不一致时不能递归 ===
      var clash = diff({ a: 1 }, 'abc');
      assert.eq(clash.type, 'value', '对象 vs 字符串 -> 整体当值');
      assert.eq(clash.status, 'updated', '状态是变更');
      assert(!clash.children, '不该产生子项');

      var clash2 = diff({ a: 1 }, [1, 2, 3]);
      assert.eq(clash2.type, 'value', '对象 vs 数组 -> 整体当值');

      var clash3 = diff([1, 2], null);
      assert.eq(clash3.type, 'value', '数组 vs null -> 整体当值');
      assert.eq(clash3.status, 'updated', 'null 一侧不算 undefined');

      // 嵌套里的类型冲突同样不能炸
      var nested = diff({ o: { a: 1 } }, { o: 'str' });
      assert.eq(nested.children[0].type, 'value', '嵌套类型冲突按值处理');
      assert.eq(nested.children[0].status, 'updated', '嵌套冲突状态是变更');

      // null 与对象互转
      assert.eq(diff({ a: null }, { a: { x: 1 } }).children[0].type, 'value', 'null -> 对象按值');
      assert.eq(diff({ a: { x: 1 } }, { a: null }).children[0].type, 'value', '对象 -> null 按值');

      // summarize / hasChanges
      assert(hasChanges(diff({ a: 1 }, { a: 2 })), '有变化');
      assert(!hasChanges(diff({ a: 1 }, { a: 1 })), '无变化');
      assert(!hasChanges(diff({ a: { b: 1 } }, { a: { b: 1 } })), '深层相同也算无变化');
      var s = summarize(diff({ a: 1 }, { a: 2, b: 3 }));
      assert.eq(s.updated, 1, '一个变更');
      assert.eq(s.added, 1, '一个新增');
    }
  };
})();