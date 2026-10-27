/* ==========================================================================
   XML 差异对比（xml-diff）

   并排对比两份 XML 文档，标出新增 / 删除 / 修改的元素与属性。

   参考实现：上游 it-tools PR #1840（src/tools/xml-diff/，GPLv3）
   与上游的差别（逐条）：

   1. **数组按内容多重集比较，不按下标。**
      上游的 diff 核心复用仓库里的 json-diff，而 json-diff 的数组是**按下标**
      比的（diffArrays 里 `createDifference(arr[i], newArr[i], i)`）。
      XML 里同名元素可以任意重复，按下标比几乎必然误报：中间插一个元素，
      后面每一个都会显示成 updated。这里改成：先按内容配对相同的项
      （多重集语义），配不上的再按顺序两两配成「修改」，剩下的一边是新增、
      一边是删除。

   2. **解析失败会报错，不会静默。**
      上游的 parseXml 对畸形 XML 返回 undefined，页面上就什么都不显示 ——
      用户分不清是「没填」还是「填错了」。这里抛异常，界面把 DOMParser
      的原始报错（带行列）显示出来。

   3. **不需要按下标对齐的全树预处理。**
      上游有一个 xml-diff.reconcile.ts：因为 XML 无法从单份文档判断元素是否
      可重复，解析出来「出现一次」是标量、「出现多次」是数组，同一个键两侧
      形状可能不同，于是先把标量包成数组再比。这里把这个对齐收进比较函数
      （reconcileArrayShapes）—— 多重集比较本来就与下标无关，按下标对齐的
      全树走一遍反而会配错。

   4. **根元素的名字参与比较。**
      上游的 parseXml 返回的是根元素**的内容**，根元素自己叫什么名字被丢掉
      了。于是 `<a/>` 和 `<b/>` 比出来是「完全一样」—— 显然不对。
      这里把根标签名一起带进结果树，标签不同就在最上面标出来。

   5. **界面用 layui + 原生 DOM 重写**，左右并排显示并高亮差异。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('xml-diff');

  /* DOMParser 造出来的 parsererror 元素的命名空间。 */
  var PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

  /* nodeType 常量：写死数字，免得依赖 Node 全局（模块可能被塞进别的上下文）。 */
  var NODE_TEXT = 3;
  var NODE_CDATA = 4;

  /* ---------- 解析 ---------- */

  /**
   * 取元素的**直接**文本（子元素之外的文字），CDATA 也算，CDATA 之外
   * 的注释 / 处理指令不算。首尾空白去掉。
   * @param {Element} element
   * @returns {string}
   */
  function getDirectText(element) {
    var nodes = Array.prototype.slice.call(element.childNodes || []);
    var out = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType === NODE_TEXT || node.nodeType === NODE_CDATA) {
        out += node.textContent == null ? '' : node.textContent;
      }
    }
    return out.trim();
  }

  /**
   * 元素 → JSON 形状（与上游 xml-diff.parser 一致）：
   *   · 属性        → `@名字`
   *   · 直接文本    → `#text`（空文本不出现）
   *   · 子元素      → 键就是标签名；**只有一个**时存裸值，**两个及以上**才存数组
   *
   * 「只有一个存裸值」这条是 XML 特有的：光看一份文档没法知道某个元素
   * 是不是可重复的，所以要么两边都当成数组（就看不出「原来只有一个」），
   * 要么按出现次数决定 —— 上游选了后者，这里沿用。
   *
   * @param {Element} element
   * @returns {*}
   */
  function elementToValue(element) {
    var attributes = Array.prototype.slice.call(element.attributes || []);
    var childElements = Array.prototype.slice.call(element.children || []);
    var text = getDirectText(element);

    if (attributes.length === 0 && childElements.length === 0) {
      return text;
    }

    var value = {};
    var i;
    for (i = 0; i < attributes.length; i++) {
      value['@' + attributes[i].name] = attributes[i].value;
    }

    // 按标签名分组，但保留**首次出现的顺序**（Object.create(null) 是为了
    // 防 'constructor' / '__proto__' 这种标签名撞上原型上的属性）
    var order = [];
    var groups = Object.create(null);
    for (i = 0; i < childElements.length; i++) {
      var tag = childElements[i].tagName;
      if (!groups[tag]) { groups[tag] = []; order.push(tag); }
      groups[tag].push(childElements[i]);
    }
    for (i = 0; i < order.length; i++) {
      var same = groups[order[i]];
      value[order[i]] = same.length === 1
        ? elementToValue(same[0])
        : same.map(function (child) { return elementToValue(child); });
    }

    if (text !== '') value['#text'] = text;
    return value;
  }

  /**
   * 找出 DOMParser 造出来的 parsererror 元素。
   *
   * 判据是命名空间而不是标签名 —— 用户完全可以写一个真的叫
   * `<parsererror/>` 的元素，那就不是解析错误了。Chrome / Firefox / jsdom
   * 都用 Mozilla 那个命名空间。
   *
   * @param {Document} doc
   * @returns {Element|null}
   */
  function findParserError(doc) {
    if (!doc) return null;
    var root = doc.documentElement;
    if (root && root.localName === 'parsererror' && isParserErrorNs(root.namespaceURI)) return root;
    var list = doc.getElementsByTagName('parsererror');
    for (var i = 0; i < list.length; i++) {
      if (isParserErrorNs(list[i].namespaceURI)) return list[i];
    }
    return null;
  }

  function isParserErrorNs(ns) {
    return ns === PARSERERROR_NS || ns === null || ns === undefined;
  }

  /**
   * parsererror 元素 → 一行可读的报错。
   * Firefox 的 parsererror 里塞的是 HTML，标签要先剥掉。
   * @param {Element} err
   * @returns {string}
   */
  function extractParserErrorMessage(err) {
    var raw = err && err.textContent ? err.textContent : '';
    raw = raw.replace(/<[^>]*>/g, ' ');
    raw = raw.replace(/\s+/g, ' ').trim();
    if (!raw) return t('err_unknown', 'Unknown XML parse error');
    return raw;
  }

  /**
   * 解析 XML 文本 → Document。**畸形 XML 抛异常**（上游是静默返回 undefined）。
   * @param {string} xml
   * @returns {Document}
   */
  function parseXmlDocument(xml) {
    var doc = new window.DOMParser().parseFromString(xml, 'application/xml');
    var err = findParserError(doc);
    if (err) {
      var e = new Error(extractParserErrorMessage(err));
      e.friendly = true;
      throw e;
    }
    if (!doc.documentElement) {
      var e2 = new Error(t('err_no_root', 'The XML document has no root element.'));
      e2.friendly = true;
      throw e2;
    }
    return doc;
  }

  /**
   * 解析 XML 文本 → { tag, value }。
   * tag 是根元素的名字（上游把它丢了 —— 那样 `<a/>` 和 `<b/>` 会比成一样）。
   * 空输入返回 undefined。
   * @param {string} rawXml
   * @returns {{tag: string, value: *}|undefined}
   */
  function parseXmlDoc(rawXml) {
    var src = rawXml === null || rawXml === undefined ? '' : String(rawXml).trim();
    if (src === '') return undefined;
    var doc = parseXmlDocument(src);
    return { tag: doc.documentElement.tagName, value: elementToValue(doc.documentElement) };
  }

  /**
   * 解析 XML 文本 → JSON 形状（上游 parseXml 的等价物）。
   * 空输入返回 undefined；畸形 XML 抛异常。
   * @param {string} rawXml
   * @returns {*}
   */
  function parseXml(rawXml) {
    var parsed = parseXmlDoc(rawXml);
    return parsed ? parsed.value : undefined;
  }

  /**
   * XML 文本是否合法。空串算合法（对应「什么都没填」）。
   * @param {string} rawXml
   * @returns {boolean}
   */
  function isValidXml(rawXml) {
    var src = rawXml === null || rawXml === undefined ? '' : String(rawXml).trim();
    if (src === '') return true;
    try { parseXmlDocument(src); return true; } catch (e) { return false; }
  }

  /* ---------- 值的基本判定 ---------- */

  /** JSON 值的结构类型。null 归到 'value' —— 它没有子项可比。 */
  function typeOf(value) {
    if (value === null || value === undefined) return 'value';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    return 'value';
  }

  /** 子节点是不是全都原封不动。 */
  function allUnchanged(children) {
    for (var i = 0; i < children.length; i++) {
      if (children[i].status !== 'unchanged') return false;
    }
    return true;
  }

  /** 只保留有变化的子节点（「仅显示差异」开关用）。 */
  function filterUnchanged(children) {
    return children.filter(function (child) { return child.status !== 'unchanged'; });
  }

  /**
   * 规范化后的 JSON 文本，用作**内容指纹**：键排序，所以键顺序不影响结果。
   * 数组的指纹就是逐项指纹拼起来 —— 于是「内容相同但顺序不同」的数组
   * 指纹不同（顺序在 XML 里是有意义的）。
   * @param {*} value
   * @returns {string}
   */
  function stableKey(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) parts.push(stableKey(value[i]));
      return '[' + parts.join(',') + ']';
    }
    if (typeof value === 'object') {
      var keys = Object.keys(value).sort();
      var out = [];
      for (var j = 0; j < keys.length; j++) {
        out.push(JSON.stringify(keys[j]) + ':' + stableKey(value[keys[j]]));
      }
      return '{' + out.join(',') + '}';
    }
    return JSON.stringify(value);
  }

  /** 深相等（键顺序无关）。 */
  function deepEqual(a, b) {
    return stableKey(a) === stableKey(b);
  }

  /* ---------- 形状对齐 ---------- */

  /**
   * 形状对齐：只有一侧是数组时，把另一侧包成**单元素**数组。
   *
   * XML 无法从单份文档判断某个元素是否可重复，于是同一个键在两侧可能
   * 一边是标量（「出现了一次」）一边是数组（「出现了两次」）。不先对齐，
   * 拿对象去比数组只会得到一句废话。
   *
   * 与上游 xml-diff.reconcile.ts 的差别：上游是**按下标对齐**的全树预处理，
   * 还会把短的一侧补上一串 undefined。补 undefined 是按下标比较的产物 ——
   * 多重集比较不需要它，而且补了会把「新增」误判成「修改」。
   *
   * @param {*} left
   * @param {*} right
   * @returns {[*, *]}
   */
  function reconcileArrayShapes(left, right) {
    var lIsArr = Array.isArray(left);
    var rIsArr = Array.isArray(right);
    if (lIsArr && rIsArr) return [left, right];
    if (lIsArr) return [left, rIsArr ? right : [right]];
    if (rIsArr) return [lIsArr ? left : [left], right];
    return [left, right];
  }

  /* ---------- 差异树 ---------- */

  /**
   * 造一个「只有一侧存在」的节点（新增 / 删除）。子节点全部同状态，
   * 这样渲染时整棵子树都会落在同一侧。
   * @param {*} value
   * @param {string|number} key
   * @param {'left'|'right'} side
   * @returns {Object}
   */
  function nodeForSingle(value, key, side) {
    var type = typeOf(value);
    var node = {
      key: key,
      type: type,
      status: side === 'left' ? 'removed' : 'added',
      oldValue: side === 'left' ? value : undefined,
      value: side === 'right' ? value : undefined,
      children: []
    };
    if (type === 'object') {
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        node.children.push(nodeForSingle(value[keys[i]], keys[i], side));
      }
    } else if (type === 'array') {
      for (var j = 0; j < value.length; j++) {
        var child = nodeForSingle(value[j], j, side);
        child.inArray = true;
        child.leftIndex = side === 'left' ? j : null;
        child.rightIndex = side === 'right' ? j : null;
        node.children.push(child);
      }
    }
    return node;
  }

  /**
   * 比较两个值，产出差异节点。
   * @param {*} left
   * @param {*} right
   * @param {string|number} key
   * @param {{onlyShowDifferences?: boolean}} [opts]
   * @returns {Object}
   */
  function diffValues(left, right, key, opts) {
    opts = opts || {};
    var hasLeft = left !== undefined;
    var hasRight = right !== undefined;
    if (!hasLeft && !hasRight) {
      return { key: key, type: 'value', status: 'unchanged', oldValue: undefined, value: undefined, children: [] };
    }
    if (!hasLeft) return nodeForSingle(right, key, 'right');
    if (!hasRight) return nodeForSingle(left, key, 'left');

    var pair = reconcileArrayShapes(left, right);
    var l = pair[0], r = pair[1];
    var lt = typeOf(l), rt = typeOf(r);

    if (lt === 'array' && rt === 'array') {
      var arrayKids = diffArrays(l, r, opts);
      return {
        key: key, type: 'array',
        status: allUnchanged(arrayKids) ? 'unchanged' : 'children-updated',
        oldValue: l, value: r,
        children: opts.onlyShowDifferences ? filterUnchanged(arrayKids) : arrayKids
      };
    }
    if (lt === 'object' && rt === 'object') {
      var objectKids = diffObjects(l, r, opts);
      return {
        key: key, type: 'object',
        status: allUnchanged(objectKids) ? 'unchanged' : 'children-updated',
        oldValue: l, value: r,
        children: opts.onlyShowDifferences ? filterUnchanged(objectKids) : objectKids
      };
    }
    // 类型不一致（对象 vs 标量）→ 当成一个值整体比较
    return {
      key: key, type: 'value',
      status: deepEqual(l, r) ? 'unchanged' : 'updated',
      oldValue: l, value: r,
      children: []
    };
  }

  /**
   * 对象逐键比较。键取两侧并集，左侧的键在前。
   * @param {Object} left
   * @param {Object} right
   * @param {{onlyShowDifferences?: boolean}} [opts]
   * @returns {Object[]}
   */
  function diffObjects(left, right, opts) {
    opts = opts || {};
    var keys = Object.keys(left);
    var rightKeys = Object.keys(right);
    for (var i = 0; i < rightKeys.length; i++) {
      if (keys.indexOf(rightKeys[i]) < 0) keys.push(rightKeys[i]);
    }
    var out = [];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var lHas = Object.prototype.hasOwnProperty.call(left, key);
      var rHas = Object.prototype.hasOwnProperty.call(right, key);
      var child;
      if (!lHas) child = nodeForSingle(right[key], key, 'right');
      else if (!rHas) child = nodeForSingle(left[key], key, 'left');
      else child = diffValues(left[key], right[key], key, opts);
      out.push(child);
    }
    return out;
  }

  /**
   * 数组比较 —— **按内容多重集**，不按下标。
   *
   * 步骤：
   *   1. 按内容指纹把两侧相同的项配成对（未变）；
   *   2. 剩下的左侧项与右侧项**按顺序**两两配对 → 变更；
   *   3. 配不上的左侧项 → 删除，配不上的右侧项 → 新增。
   *
   * 这样 `<a/><b/><c/>` 对 `<a/><x/><b/><c/>` 只多出一个 x，
   * 而按下标比会把 b、c 全报成「变了」。
   *
   * @param {Array} left
   * @param {Array} right
   * @param {{onlyShowDifferences?: boolean}} [opts]
   * @returns {Object[]}
   */
  function diffArrays(left, right, opts) {
    opts = opts || {};
    var i, j;

    // 1. 按内容配对
    var buckets = Object.create(null);
    for (j = 0; j < right.length; j++) {
      var rk = stableKey(right[j]);
      if (!buckets[rk]) buckets[rk] = [];
      buckets[rk].push(j);
    }
    var leftToRight = Object.create(null);
    var rightToLeft = Object.create(null);
    var unmatchedLeft = [];
    for (i = 0; i < left.length; i++) {
      var lk = stableKey(left[i]);
      var bucket = buckets[lk];
      if (bucket && bucket.length) {
        var hit = bucket.shift();
        leftToRight[i] = hit;
        rightToLeft[hit] = i;
      } else {
        unmatchedLeft.push(i);
      }
    }
    var unmatchedRight = [];
    for (j = 0; j < right.length; j++) {
      if (!(j in rightToLeft)) unmatchedRight.push(j);
    }

    // 2. 剩下的按顺序配成「变更」
    var pairs = Math.min(unmatchedLeft.length, unmatchedRight.length);
    var removed = [];
    var added = [];
    for (i = pairs; i < unmatchedLeft.length; i++) removed.push(unmatchedLeft[i]);
    for (j = pairs; j < unmatchedRight.length; j++) added.push(unmatchedRight[j]);

    var children = [];
    var mark = function (child, leftIndex, rightIndex) {
      child.inArray = true;
      child.leftIndex = leftIndex === undefined ? null : leftIndex;
      child.rightIndex = rightIndex === undefined ? null : rightIndex;
      return child;
    };

    // 未变的（内容配对成功）
    for (i = 0; i < left.length; i++) {
      if (!(i in leftToRight)) continue;
      j = leftToRight[i];
      children.push(mark(diffValues(left[i], right[j], i, opts), i, j));
    }
    // 变更的（配不上的按顺序两两配对）
    for (i = 0; i < pairs; i++) {
      var li = unmatchedLeft[i], ri = unmatchedRight[i];
      children.push(mark(diffValues(left[li], right[ri], li, opts), li, ri));
    }
    // 删除的
    for (i = 0; i < removed.length; i++) {
      children.push(mark(nodeForSingle(left[removed[i]], removed[i], 'left'), removed[i], null));
    }
    // 新增的
    for (j = 0; j < added.length; j++) {
      children.push(mark(nodeForSingle(right[added[j]], added[j], 'right'), null, added[j]));
    }

    // 排序：以**右侧下标**为锚（右侧是「新的那份」，是读者看的主线），
    // 右侧没有的（纯删除）按左侧下标接在后面。
    children.sort(function (a, b) {
      var ka = a.rightIndex !== null ? a.rightIndex : a.leftIndex;
      var kb = b.rightIndex !== null ? b.rightIndex : b.leftIndex;
      if (ka !== kb) return ka - kb;
      var la = a.leftIndex === null ? Infinity : a.leftIndex;
      var lb = b.leftIndex === null ? Infinity : b.leftIndex;
      return la - lb;
    });

    return children;
  }

  /**
   * 主函数：比较两份 JSON 形状，返回差异树。
   * @param {*} left
   * @param {*} right
   * @param {{onlyShowDifferences?: boolean}} [opts]
   * @returns {Object}
   */
  function diff(left, right, opts) {
    opts = opts || {};
    return diffValues(left, right, '', opts);
  }
  /* ---------- 统计 ---------- */

  /**
   * 统计各类变化的条数。
   *
   * 「新增 / 删除」只数**最外层**的那一处，不往新增 / 删除的子树里再钻 ——
   * 删掉一个带 5 个子元素的节点，算「删了 1 个」而不是「删了 6 个」。
   * 属性单独数一遍（键以 @ 开头），界面上可以另外提示一句。
   *
   * @param {Object} tree
   * @returns {{added:number, removed:number, updated:number, unchanged:number, containers:number, attributes:number}}
   */
  function summarize(tree) {
    var counts = { added: 0, removed: 0, updated: 0, unchanged: 0, containers: 0, attributes: 0 };
    (function walk(node) {
      var status = node.status;
      if (status === 'added' || status === 'removed') {
        counts[status]++;
        if (isAttributeKey(node.key)) counts.attributes++;
        return;   // 不再往子树里钻
      }
      counts[status]++;
      if (status === 'updated' && isAttributeKey(node.key)) counts.attributes++;
      (node.children || []).forEach(walk);
    })(tree);
    // 根标签名变了也算一处变更（`<a/>` 对 `<b/>` 的内容其实是一样的）
    if (tree.tagChanged && tree.status !== 'updated') counts.updated++;
    return counts;
  }

  /** 键是不是属性（解析时属性带 @ 前缀）。 */
  function isAttributeKey(key) {
    return typeof key === 'string' && key.charAt(0) === '@';
  }

  /** 差异树里是否真的有变化（unchanged 不算）。 */
  function hasChanges(tree) {
    if (!tree) return false;
    if (tree.status !== 'unchanged') return true;
    return (tree.children || []).some(hasChanges);
  }

  /* ---------- 渲染用的行模型 ---------- */

  /** 值的显示文本。字符串加引号（它多半来自 XML 文本节点）。 */
  function formatValue(value) {
    if (value === undefined) return '';
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  }

  /** 节点前缀：数组项是 `[下标] `，对象成员是 `键: `，根节点没有前缀。 */
  function prefixFor(node, side) {
    var idx = side === 'left' ? node.leftIndex : node.rightIndex;
    if (idx !== null && idx !== undefined) return '[' + idx + '] ';
    if (node.key === '' || node.key === undefined || node.key === null) return '';
    return node.key + ': ';
  }

  /**
   * 一个单元格的样式类。
   *
   *   · left-only（整块被删）→ 左侧 del，右侧不出单元格
   *   · right-only（整块新增）→ 右侧 add
   *   · updated（值变了）    → 左 del、右 add
   *   · 其余                 → same（容器本身不着色，变化由子节点标出来）
   */
  function clsFor(status, side, mode) {
    if (mode === 'left-only') return side === 'left' ? 'del' : 'same';
    if (mode === 'right-only') return side === 'right' ? 'add' : 'same';
    if (status === 'updated') return side === 'left' ? 'del' : 'add';
    return 'same';
  }

  /**
   * 把差异树拆成「左右并排」的行。每行左右各一个单元格，内容对得上。
   *
   * @param {Object} node
   * @param {number} depth
   * @param {Array} rows
   * @param {'both'|'left-only'|'right-only'} mode
   */
  function walkRows(node, depth, rows, mode) {
    var m = mode;
    if (node.status === 'removed') m = 'left-only';
    else if (node.status === 'added') m = 'right-only';

    var isContainer = node.type === 'object' || node.type === 'array';

    // 根节点带上标签名 —— 标签不同的话，这一行整体标成变更
    if (node.leftTag !== undefined || node.rightTag !== undefined) {
      var rootOpen = '<' + (node.leftTag || '') + '>';
      var rootOpenRight = '<' + (node.rightTag || '') + '>';
      if (isContainer) {
        rootOpen += ' ' + (node.type === 'array' ? '[' : '{');
        rootOpenRight += ' ' + (node.type === 'array' ? '[' : '{');
      } else {
        // 根是个标量（`<a/>`、`<a>text</a>`）：把值也带上
        // 空文本不显示 —— `<a/>` 就显示成 <a>，不是 <a> ""
        var lv = node.oldValue === '' ? '' : formatValue(node.oldValue);
        var rv = node.value === '' ? '' : formatValue(node.value);
        if (lv) rootOpen += ' ' + lv;
        if (rv) rootOpenRight += ' ' + rv;
      }
      rows.push({
        depth: depth,
        left: m === 'right-only' ? null : {
          text: rootOpen,
          cls: node.tagChanged ? 'del' : clsFor(node.status, 'left', m)
        },
        right: m === 'left-only' ? null : {
          text: rootOpenRight,
          cls: node.tagChanged ? 'add' : clsFor(node.status, 'right', m)
        }
      });
      if (!isContainer) return;
      (node.children || []).forEach(function (child) { walkRows(child, depth + 1, rows, m); });
      rows.push({
        depth: depth,
        left: m === 'right-only' ? null : { text: '}', cls: node.tagChanged ? 'del' : clsFor(node.status, 'left', m) },
        right: m === 'left-only' ? null : { text: '}', cls: node.tagChanged ? 'add' : clsFor(node.status, 'right', m) }
      });
      return;
    }

    if (!isContainer) {
      rows.push({
        depth: depth,
        left: m === 'right-only' ? null : {
          text: prefixFor(node, 'left') + formatValue(node.oldValue),
          cls: clsFor(node.status, 'left', m)
        },
        right: m === 'left-only' ? null : {
          text: prefixFor(node, 'right') + formatValue(node.value),
          cls: clsFor(node.status, 'right', m)
        }
      });
      return;
    }

    var open = node.type === 'array' ? '[' : '{';
    var close = node.type === 'array' ? ']' : '}';
    rows.push({
      depth: depth,
      left: m === 'right-only' ? null : { text: prefixFor(node, 'left') + open, cls: clsFor(node.status, 'left', m) },
      right: m === 'left-only' ? null : { text: prefixFor(node, 'right') + open, cls: clsFor(node.status, 'right', m) }
    });
    (node.children || []).forEach(function (child) { walkRows(child, depth + 1, rows, m); });
    rows.push({
      depth: depth,
      left: m === 'right-only' ? null : { text: close, cls: clsFor(node.status, 'left', m) },
      right: m === 'left-only' ? null : { text: close, cls: clsFor(node.status, 'right', m) }
    });
  }

  /**
   * 差异树 → 并排显示的行。
   * @param {Object} tree
   * @returns {Array<{depth:number, left:Object|null, right:Object|null}>}
   */
  function buildRows(tree) {
    var rows = [];
    walkRows(tree, 0, rows, 'both');
    return rows;
  }

  /* ---------- 文字版差异 ---------- */

  /** 节点的路径（JSON Pointer 风格）。 */
  function pathOf(parentPath, node) {
    if (node.inArray) {
      var idx = node.leftIndex !== null && node.leftIndex !== undefined ? node.leftIndex : node.rightIndex;
      return parentPath + '/' + idx;
    }
    if (node.key === '' || node.key === undefined || node.key === null) return parentPath;
    return parentPath + '/' + node.key;
  }

  /**
   * 把差异树摊平成一张「改了什么」的清单。
   * @param {Object} tree
   * @returns {Array<{path:string, status:string, oldValue:*, newValue:*}>}
   */
  function describeChanges(tree) {
    var out = [];
    (function walk(node, path) {
      if (node.status === 'unchanged') return;
      if (node.type === 'object' || node.type === 'array') {
        if (node.status === 'added' || node.status === 'removed') {
          out.push({ path: path, status: node.status, oldValue: node.oldValue, newValue: node.value });
          return;
        }
        (node.children || []).forEach(function (child) { walk(child, pathOf(path, child)); });
        return;
      }
      out.push({ path: path, status: node.status, oldValue: node.oldValue, newValue: node.value });
    })(tree, '');
    return out;
  }

  /**
   * 差异树 → 文字（可以复制走）。
   * @param {Object} tree
   * @returns {string}
   */
  function toTextDiff(tree) {
    var lines = [];
    if (tree.tagChanged) {
      lines.push('- <' + tree.leftTag + '>');
      lines.push('+ <' + tree.rightTag + '>');
    }
    describeChanges(tree).forEach(function (change) {
      if (change.status === 'added') {
        lines.push('+ ' + change.path + ': ' + formatValue(change.newValue));
      } else if (change.status === 'removed') {
        lines.push('- ' + change.path + ': ' + formatValue(change.oldValue));
      } else {
        lines.push('~ ' + change.path + ': ' + formatValue(change.oldValue) + ' → ' + formatValue(change.newValue));
      }
    });
    return lines.join('\n');
  }

  /* ---------- 顶层入口 ---------- */

  /**
   * 解析并比较两份 XML。任一侧为空返回 null；任一侧畸形会抛异常。
   * @param {string} leftRaw
   * @param {string} rightRaw
   * @param {{onlyShowDifferences?: boolean}} [opts]
   * @returns {Object|null} 差异树（根节点上带 leftTag / rightTag / tagChanged）
   */
  function diffXml(leftRaw, rightRaw, opts) {
    opts = opts || {};
    var left = parseXmlDoc(leftRaw);
    var right = parseXmlDoc(rightRaw);
    if (!left || !right) return null;
    var tree = diff(left.value, right.value, opts);
    tree.leftTag = left.tag;
    tree.rightTag = right.tag;
    tree.tagChanged = left.tag !== right.tag;
    return tree;
  }

  /* ---------- UI ---------- */

  window.ItTools.register('xml-diff', function (root) {
    var left = D.h('textarea.layui-textarea', {
      rows: 12, spellcheck: 'false',
      placeholder: t('left_ph', 'Paste your first XML here...')
    });
    var right = D.h('textarea.layui-textarea', {
      rows: 12, spellcheck: 'false',
      placeholder: t('right_ph', 'Paste your XML to compare here...')
    });
    var leftErr = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });
    var rightErr = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });
    var output = D.h('div');
    var onlyDiff = false;
    var timer = null;

    function clearErrors() {
      leftErr.textContent = '';
      rightErr.textContent = '';
    }

    function render() {
      D.clear(output);
      clearErrors();

      var lt = left.value.trim(), rt = right.value.trim();
      if (!lt && !rt) {
        output.appendChild(D.h('p.field-hint', { text: t('hint_paste_two', 'Paste two XML documents to compare.') }));
        return;
      }

      var tree = null;
      try {
        tree = diffXml(left.value, right.value, { onlyShowDifferences: onlyDiff });
      } catch (e) {
        var message = e && e.message ? e.message : String(e);
        // 哪一侧坏了要说清楚 —— 只说「XML 无效」用户得自己猜
        var leftBad = false;
        try { parseXml(left.value); } catch (e2) { leftBad = true; }
        if (leftBad) {
          leftErr.textContent = t('err_left_invalid', 'Left XML is invalid: {message}')
            .replace('{message}', function () { return message; });
        } else {
          rightErr.textContent = t('err_right_invalid', 'Right XML is invalid: {message}')
            .replace('{message}', function () { return message; });
        }
        output.appendChild(D.h('p.field-hint', {
          style: { color: 'var(--danger, #d93025)' },
          text: leftBad
            ? t('err_left_invalid', 'Left XML is invalid: {message}').replace('{message}', function () { return message; })
            : t('err_right_invalid', 'Right XML is invalid: {message}').replace('{message}', function () { return message; })
        }));
        return;
      }

      if (!tree) {
        output.appendChild(D.h('p.field-hint', { text: t('hint_paste_two', 'Paste two XML documents to compare.') }));
        return;
      }

      if (!hasChanges(tree) && !tree.tagChanged) {
        output.appendChild(D.h('p.field-hint', { text: t('same', 'The provided XMLs are the same.') }));
        return;
      }

      var counts = summarize(tree);
      var badges = D.h('div.form-actions', null,
        D.h('span.badge-note', {
          text: t('summary', '+{added} added · −{removed} removed · ~{updated} changed')
            .replace('{added}', String(counts.added))
            .replace('{removed}', String(counts.removed))
            .replace('{updated}', String(counts.updated))
        })
      );
      if (counts.attributes > 0) {
        badges.appendChild(D.h('span.badge-note', {
          text: t('summary_attrs', '{n} attribute changes').replace('{n}', String(counts.attributes))
        }));
      }
      output.appendChild(badges);

      var rows = buildRows(tree);
      output.appendChild(D.h('div', { style: { display: 'flex', gap: '8px', alignItems: 'stretch' } },
        D.h('div.diff-line.same', { style: { flex: '1 1 50%', minWidth: '0', fontWeight: '600' } },
          D.h('span', { text: t('left_label', 'Left') })),
        D.h('div.diff-line.same', { style: { flex: '1 1 50%', minWidth: '0', fontWeight: '600' } },
          D.h('span', { text: t('right_label', 'Right') }))
      ));
      rows.forEach(function (row) {
        output.appendChild(D.h('div', { style: { display: 'flex', gap: '8px', alignItems: 'stretch' } },
          cell(row.left, row.depth), cell(row.right, row.depth)));
      });
    }

    function cell(info, depth) {
      if (!info) return D.h('div.diff-line.same', { style: { flex: '1 1 50%', minWidth: '0' } });
      return D.h('div.diff-line.' + info.cls, { style: { flex: '1 1 50%', minWidth: '0' } },
        D.h('span', { style: { paddingLeft: (depth * 14) + 'px' }, text: info.text }));
    }

    function scheduleRender() {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () { timer = null; render(); }, 150);
    }

    var offLeft = D.on(left, 'input', scheduleRender);
    var offRight = D.on(right, 'input', scheduleRender);

    var onlyDiffInput = D.h('input', { type: 'checkbox' });
    onlyDiffInput.addEventListener('change', function () {
      onlyDiff = onlyDiffInput.checked;
      render();
    });

    root.appendChild(D.h('div.card', null,
      D.h('div', { style: { display: 'flex', gap: '12px', alignItems: 'stretch' } },
        D.h('div', { style: { flex: '1 1 0', minWidth: '0' } },
          U.field(t('left_xml', 'Your first XML'), left, { wide: true }),
          leftErr),
        D.h('div', { style: { flex: '1 1 0', minWidth: '0' } },
          U.field(t('right_xml', 'Your XML to compare'), right, { wide: true }),
          rightErr)
      ),
      D.h('div.switch-grid', null,
        D.h('label.switch', null, onlyDiffInput,
          D.h('span', { text: t('only_show_differences', 'Only show differences') }))
      ),
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('swap_sides', 'Swap sides'), onclick: function () {
            var a = left.value;
            left.value = right.value;
            right.value = a;
            render();
          }
        }),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('clear', 'Clear'), onclick: function () {
            left.value = '';
            right.value = '';
            render();
          }
        }),
        U.copyButton(function () {
          try {
            var tree = diffXml(left.value, right.value, {});
            return tree ? toTextDiff(tree) : '';
          } catch (e) { return ''; }
        }, t('copy_diff', 'Copy as text'))
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('result', 'Differences') })
      ),
      output
    ));

    render();

    return {
      destroy: function () {
        if (timer) { window.clearTimeout(timer); timer = null; }
        offLeft(); offRight();
        D.clear(root);
      }
    };
  });
  window.ItTools.logic['xml-diff'] = {
    parseXml: parseXml,
    parseXmlDoc: parseXmlDoc,
    isValidXml: isValidXml,
    elementToValue: elementToValue,
    getDirectText: getDirectText,
    stableKey: stableKey,
    deepEqual: deepEqual,
    typeOf: typeOf,
    reconcileArrayShapes: reconcileArrayShapes,
    diff: diff,
    diffValues: diffValues,
    diffObjects: diffObjects,
    diffArrays: diffArrays,
    diffXml: diffXml,
    summarize: summarize,
    hasChanges: hasChanges,
    buildRows: buildRows,
    describeChanges: describeChanges,
    toTextDiff: toTextDiff,
    formatValue: formatValue,
    __cases: function (assert) {
      /* ================= 解析 ================= */
      assert.eq(parseXml(''), undefined, '空串解析成 undefined');
      assert.eq(parseXml('   \n '), undefined, '纯空白也是 undefined');
      assert.eq(parseXml(null), undefined, 'null 输入');
      assert.eq(parseXml('<foo>bar</foo>'), 'bar', '叶子元素就是它的文本');
      assert.eq(parseXml('<foo/>'), '', '空元素是空串');
      assert.eq(parseXml('<foo a="1" b="2"/>'), { '@a': '1', '@b': '2' }, '属性带 @ 前缀');
      assert.eq(parseXml('<root><item>A</item></root>'), { item: 'A' }, '只有一个子元素时存裸值');
      assert.eq(parseXml('<root><item>A</item><item>B</item></root>'), { item: ['A', 'B'] }, '重复子元素变数组');
      assert.eq(parseXml('<root id="1">hello<child>world</child></root>'),
        { '@id': '1', child: 'world', '#text': 'hello' }, '属性 + 子元素 + 文本（键序：属性、子元素、#text）');
      assert.eq(parseXml('<foo>\n  <bar>baz</bar>\n</foo>'), { bar: 'baz' }, '标签之间的空白不算文本');
      assert.eq(parseXml('<a><b><![CDATA[x]]></b></a>'), { b: 'x' }, 'CDATA 当文本');
      assert.eq(parseXml('<?xml version="1.0"?><a/>'), '', 'XML 声明不影响结果');
      assert.eq(parseXml('<a><!-- 注释 --><b>1</b></a>'), { b: '1' }, '注释不进结果');
      assert.eq(parseXml('<root><a>1</a><b>2</b><a>3</a></root>'),
        { a: ['1', '3'], b: '2' }, '同名元素聚成数组，别的标签不受影响');

      /* 畸形 XML 必须报错，不能静默 */
      var threw = false;
      try { parseXml('<a><b></a>'); } catch (e) { threw = true; }
      assert(threw, '畸形 XML 抛错，而不是静默返回 undefined');
      assert(!isValidXml('<a><b></a>'), 'isValidXml 认出畸形 XML');
      assert(!isValidXml('plain text'), '不是 XML 的文本');
      assert(isValidXml('<foo>bar</foo>'), '合法 XML');
      assert(isValidXml(''), '空串算合法');
      assert(isValidXml('   '), '纯空白算合法');
      var err = null;
      try { parseXml('<a><b></a>'); } catch (e2) { err = e2; }
      assert(err && err.message.length > 0, '报错带得上原因：' + (err && err.message));

      /* 根标签名要留住 —— 上游把它丢了，`<a/>` 和 `<b/>` 会比成「一样」 */
      assert.eq(parseXmlDoc('<a/>').tag, 'a', '根标签名被保留');
      assert.eq(parseXmlDoc('<a/>').value, '', '根元素的内容');
      assert.eq(parseXmlDoc(''), undefined, '空输入没有根元素');

      /* ================= 值判定 ================= */
      assert.eq(typeOf(null), 'value', 'null 归为 value');
      assert.eq(typeOf([]), 'array', '数组');
      assert.eq(typeOf({}), 'object', '对象');
      assert.eq(typeOf(1), 'value', '数字');
      assert(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), '键顺序不影响相等');
      assert(deepEqual([1, [2, 3]], [1, [2, 3]]), '嵌套数组');
      assert(!deepEqual([1, 2], [2, 1]), '数组顺序影响相等');
      assert(!deepEqual({ a: 1 }, { a: '1' }), '1 与 "1" 不相等');

      /* ================= 形状对齐 ================= */
      assert.eq(reconcileArrayShapes('A', ['A', 'B']), [['A'], ['A', 'B']], '标量被包成单元素数组');
      assert.eq(reconcileArrayShapes(['A'], 'A'), [['A'], ['A']], '反向也一样');
      assert.eq(reconcileArrayShapes(['A'], ['B']), [['A'], ['B']], '两侧都是数组时不动');
      assert.eq(reconcileArrayShapes({ a: 1 }, { a: 1 }), [{ a: 1 }, { a: 1 }], '非数组不动');

      /* ================= 基本差异 ================= */
      var d = diff({ a: 1 }, { a: 2 });
      assert.eq(d.type, 'object', '根是对象');
      assert.eq(d.status, 'children-updated', '对象内部有变化');
      assert.eq(d.children[0].key, 'a', '键名');
      assert.eq(d.children[0].status, 'updated', '值变了');
      assert.eq(d.children[0].oldValue, 1, '保留旧值');
      assert.eq(d.children[0].value, 2, '保留新值');

      var added = diff({ a: 1 }, { a: 1, b: 2 });
      assert.eq(added.children.length, 2, '两个键');
      assert.eq(added.children[0].status, 'unchanged', 'a 没变');
      assert.eq(added.children[1].status, 'added', 'b 是新增');
      assert.eq(added.children[1].key, 'b', '新增键名');
      var removed = diff({ a: 1, b: 2 }, { a: 1 });
      assert.eq(removed.children[1].status, 'removed', 'b 是删除');
      assert.eq(diff({ a: 1 }, { a: 1 }).status, 'unchanged', '完全一样');
      assert(!hasChanges(diff({ a: 1 }, { a: 1 })), '没变化');
      assert(hasChanges(diff({ a: 1 }, { a: 2 })), '有变化');

      /* 属性也算键 */
      var attr = diff({ '@foo': 'bar' }, { '@foo': 'baz' });
      assert.eq(attr.children[0].key, '@foo', '属性的键带 @');
      assert.eq(attr.children[0].status, 'updated', '属性值变了');
      assert.eq(summarize(attr).attributes, 1, '属性变化单独计数');

      /* ================= 数组：多重集比较（核心改进） ================= */
      // 中间插一个元素 —— 按下标比会把后面每一个都误报成「变了」
      var ins = diff({ item: ['A', 'B', 'C'] }, { item: ['A', 'X', 'B', 'C'] });
      var insKids = ins.children[0].children;
      assert.eq(insKids.length, 4, '四项');
      assert.eq(insKids.filter(function (c) { return c.status === 'updated'; }).length, 0,
        '中间插入元素不会把后面的元素误报成变更');
      assert.eq(insKids.filter(function (c) { return c.status === 'added'; }).length, 1, '只多出一个新增');
      assert.eq(insKids.filter(function (c) { return c.status === 'unchanged'; }).length, 3, '三个没变');
      assert.eq(insKids[1].value, 'X', '新增的是 X');
      assert.eq(insKids[1].rightIndex, 1, '新增项的右侧下标');

      // 只调换顺序：多重集比较认为没变
      var reorder = diff({ item: ['A', 'B'] }, { item: ['B', 'A'] });
      assert(!hasChanges(reorder), '只是顺序不同 —— 多重集比较认为没变（取舍见文件头）');

      // 内容变了：配成「修改」而不是「一删一增」
      var changed = diff({ item: ['A'] }, { item: ['B'] });
      assert.eq(changed.children[0].children.length, 1, '一项');
      assert.eq(changed.children[0].children[0].status, 'updated', '内容变了算修改');
      assert.eq(changed.children[0].children[0].oldValue, 'A', '旧值');
      assert.eq(changed.children[0].children[0].value, 'B', '新值');

      // 重复项按多重集算：多出来的那一个算删除
      var dup = diff({ item: ['A', 'A'] }, { item: ['A'] });
      assert.eq(dup.children[0].children.length, 2, '两项');
      assert.eq(dup.children[0].children.filter(function (c) { return c.status === 'removed'; }).length, 1,
        '多出来的那个 A 算删除');
      assert.eq(dup.children[0].children.filter(function (c) { return c.status === 'unchanged'; }).length, 1,
        '配对上的那个 A 没变');

      // 一边是标量一边是数组（XML 的可重复性判断不了）—— 形状对齐后按多重集比
      var shape = diff({ item: 'A' }, { item: ['A', 'B'] });
      assert.eq(shape.children[0].type, 'array', '对齐后是数组');
      assert.eq(shape.children[0].status, 'children-updated', '里面确实变了');
      assert.eq(shape.children[0].children.length, 2, '两项');
      assert.eq(shape.children[0].children[0].status, 'unchanged', 'A 没变');
      assert.eq(shape.children[0].children[1].status, 'added', 'B 是新增');
      var shape2 = diff({ item: ['A', 'B'] }, { item: 'A' });
      assert.eq(shape2.children[0].children.filter(function (c) { return c.status === 'removed'; }).length, 1,
        '反方向：B 是删除');

      // 数组里的对象按内容配对
      var objs = diff({ item: [{ x: 1 }, { y: 2 }] }, { item: [{ y: 2 }, { x: 1 }] });
      assert(!hasChanges(objs), '对象项也按内容配对');

      /* ================= 顶层入口 ================= */
      var tree = diffXml('<root><item>A</item></root>', '<root><item>A</item><item>B</item></root>');
      assert(tree !== null, '两份都有内容时返回差异树');
      assert.eq(tree.leftTag, 'root', '左标签');
      assert(!tree.tagChanged, '标签一样');
      assert.eq(tree.children[0].children.length, 2, 'item 下两项');
      assert.eq(tree.children[0].children[1].status, 'added', '多出来的 B 是新增');
      assert.eq(diffXml('', '<a/>'), null, '一边为空时没有结果');

      var tagTree = diffXml('<a/>', '<b/>');
      assert(tagTree.tagChanged, '根标签不同');
      assert.eq(tagTree.leftTag, 'a', '左标签');
      assert.eq(tagTree.rightTag, 'b', '右标签');
      assert(hasChanges(tagTree) || tagTree.tagChanged, '标签变了也算差异');
      assert.eq(summarize(tagTree).updated, 1, '标签变化算一处修改');

      /* ================= 并排行 ================= */
      var rows = buildRows(diff({ '@foo': 'bar' }, { '@foo': 'baz' }));
      assert.eq(rows.length, 3, '大括号 + 一行内容 + 收尾');
      assert.eq(rows[1].left.text, '@foo: "bar"', '左侧是旧值');
      assert.eq(rows[1].right.text, '@foo: "baz"', '右侧是新值');
      assert.eq(rows[1].left.cls, 'del', '旧值标红');
      assert.eq(rows[1].right.cls, 'add', '新值标绿');
      assert.eq(rows[1].depth, 1, '缩进一级');

      var rowsAdded = buildRows(diff({ a: 1 }, { a: 1, b: 2 }));
      assert.eq(rowsAdded[2].left, null, '新增的元素左侧没有内容');
      assert.eq(rowsAdded[2].right.text, 'b: 2', '新增的元素在右侧');
      assert.eq(rowsAdded[2].right.cls, 'add', '新增标绿');

      var rowsRemoved = buildRows(diff({ a: 1, b: 2 }, { a: 1 }));
      assert.eq(rowsRemoved[2].left.text, 'b: 2', '删除的元素在左侧');
      assert.eq(rowsRemoved[2].right, null, '删除的元素右侧没有内容');
      assert.eq(rowsRemoved[2].left.cls, 'del', '删除标红');

      // 根标签出现在最上面一行
      var tagRows = buildRows(tagTree);
      assert.eq(tagRows[0].left.text, '<a>', '左列显示根标签');
      assert.eq(tagRows[0].right.text, '<b>', '右列显示根标签');
      assert.eq(tagRows[0].left.cls, 'del', '标签不同标红');
      assert.eq(tagRows[0].right.cls, 'add', '标签不同标绿');

      /* ================= 文字版差异 ================= */
      var changes = describeChanges(diff({ '@foo': 'bar' }, { '@foo': 'baz' }));
      assert.eq(changes.length, 1, '一处变更');
      assert.eq(changes[0].path, '/@foo', '路径带 @ 前缀');
      assert.eq(changes[0].status, 'updated', '状态是变更');
      assert.eq(changes[0].oldValue, 'bar', '旧值');
      assert.eq(changes[0].newValue, 'baz', '新值');
      assert.eq(toTextDiff(diff({ '@foo': 'bar' }, { '@foo': 'baz' })),
        '~ /@foo: "bar" → "baz"', '文字版差异');
      assert.eq(toTextDiff(diff({ a: 1 }, { a: 1, b: 2 })), '+ /b: 2', '新增的文字版');
      assert.eq(toTextDiff(diff({ a: 1, b: 2 }, { a: 1 })), '- /b: 2', '删除的文字版');

      /* ================= 统计 ================= */
      var counts = summarize(diff({ '@foo': 'bar' }, { '@foo': 'baz' }));
      assert.eq(counts.updated, 1, '一个修改');
      assert.eq(counts.added, 0, '没有新增');
      assert.eq(counts.removed, 0, '没有删除');
      var counts2 = summarize(diff({ a: 1 }, { a: 1, b: 2 }));
      assert.eq(counts2.added, 1, '一个新增');
      var counts3 = summarize(diff({ a: 1, b: 2 }, { a: 1 }));
      assert.eq(counts3.removed, 1, '一个删除');
      // 删掉一整块只算一处，不往子树里钻
      var counts4 = summarize(diff({ x: { a: { b: 1 } } }, { x: {} }));
      assert.eq(counts4.removed, 1, '删掉一整块子树算一处删除，不往里钻');
      var counts5 = summarize(diff({ x: { a: 1, b: 2 } }, { x: {} }));
      assert.eq(counts5.removed, 2, '被删的两个子元素各算一处');

      /* ================= 「仅显示差异」 ================= */
      var only = diff({ foo: 'bar', baz: 'qux' }, { foo: 'bar', baz: 'quux' }, { onlyShowDifferences: true });
      assert.eq(only.children.length, 1, '没变的被滤掉');
      assert.eq(only.children[0].key, 'baz', '只剩变了的那一个');
      var onlyArr = diff({ item: ['A', 'B'] }, { item: ['A', 'C'] }, { onlyShowDifferences: true });
      assert.eq(onlyArr.children[0].children.length, 1, '数组里没变的项被滤掉');
      assert.eq(onlyArr.children[0].children[0].status, 'updated', '只剩变了的那一项');
    }
  };
})();
