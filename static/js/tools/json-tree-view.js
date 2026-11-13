/* ==========================================================================
   JSON 树形视图（json-tree-view）

   把一段 JSON 变成可折叠的树：展开/收起、按关键字搜索、看某个节点的路径与值。

   为什么做这个：json-viewer.js 的文件头写着，上游原版本来也只有
   「排序 + 缩进 + 两个文本框」，树形视图 / 折叠 / 搜索 / 键名大小写转换
   **从来没被移植过来**（见 static/js/tools/json-viewer.js:16-36）。
   原版那边也没有单独的工具 —— 所以这个是实打实的增量。

   与 json-viewer 的分工：那边管的是「把一段文本整理成漂亮的 JSON」
   （还要管反转义、坏 JSON 修复、重复键、隐藏字符），
   这边管的是「看清一份 JSON 的结构」——
   解析走共用的 ItTools.jsonParse（剥注释 → 标准 JSON → JSON5），
   两边各管各的，不合并、不互相重构。

   几处刻意的做法：
     - 超范围整数（超过 2^53-1）在解析前换成哨兵，显示与复制时还原 ——
       裸 JSON.parse 会把 9223372036854775807 悄悄舍成 9223372036854776000，
       看一个订单号等于把它改掉。
     - 键名大小写转换只改**显示**与**复制出来的 JSON**，输入框里的原文不动。
     - 树是懒渲染的：收起的子树一行都不画，展开时才画。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var JP = window.ItTools.jsonParse;
  var INFER = window.ItTools.jsonInfer;
  var t = window.ItTools.t('json-tree-view');

  /** 节点数上限：再大的文档只索引前这么多，免得一个几百 MB 的 JSON 把页面卡死。 */
  var MAX_NODES = 200000;
  /** 「展开到第 N 层」的上限。 */
  var MAX_DEPTH = 50;
  /** 默认展开到第几层。 */
  var DEFAULT_DEPTH = 3;
  /** 值预览最多显示多少个字符。 */
  var PREVIEW_LIMIT = 120;

  /* ---------- 纯逻辑 ---------- */

  /**
   * 值的结构类型。null 单独一类（它没有子项）。
   * @param {*} value
   * @returns {'object'|'array'|'string'|'number'|'boolean'|'null'}
   */
  function nodeType(value) {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    var ty = typeof value;
    if (ty === 'object') return 'object';
    if (ty === 'number' || ty === 'boolean' || ty === 'string') return ty;
    return 'null';
  }

  /**
   * 这个字符串是不是「超范围整数」的哨兵。
   *
   * 哨兵是 util.guardBigIntegers 换上去的（见 app.js）：
   * 超过 2^53-1 的整数字面量一进 JSON.parse 就被舍成相邻的浮点值，
   * 所以先换成字符串让解析器绕开数值路径，输出时再还原。
   * 还原后是原来的整数字面量 —— 所以它在界面上要**当数字显示**，不当字符串。
   */
  function isBigInt(value) {
    return typeof value === 'string' && U.restoreBigIntegerValue(value) !== value;
  }

  /**
   * 类型徽章。用 JSON 字面量的样子（{} / [] / "" / # / true / null），
   * 不另造一套词 —— 这样七种语言都不用为它翻译。
   */
  function typeBadge(type, value) {
    if (type === 'object') return '{}';
    if (type === 'array') return '[]';
    if (type === 'string') return isBigInt(value) ? '#' : '""';
    if (type === 'number') return '#';
    if (type === 'boolean') return value ? 'true' : 'false';
    return 'null';
  }

  /** 叶子值的显示文本：字符串去掉引号，哨兵还原成整数。 */
  function valueText(value) {
    if (typeof value === 'string') return U.restoreBigIntegerValue(value);
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'object') return '';
    return String(value);
  }

  /**
   * 走一遍整棵树，给每个节点建索引。
   *
   * 索引里存的是**原始值**，改名不碰它 —— 显示时再按需要改名，
   * 这样「切一次键名写法」不用重新解析一遍文档。
   *
   * @param {*} rootValue
   * @param {{max?: number}} [opts]
   * @returns {{nodes: Array, truncated: boolean}}
   */
  function buildIndex(rootValue, opts) {
    opts = opts || {};
    var max = opts.max || MAX_NODES;
    var nodes = [];
    var truncated = false;

    function visit(value, key, parentId, depth, segs) {
      if (nodes.length >= max) { truncated = true; return; }
      var id = nodes.length;
      var type = nodeType(value);
      nodes.push({
        id: id,
        key: key,
        parentId: parentId,
        childIds: [],
        type: type,
        value: value,
        depth: depth,
        segs: segs
      });
      if (parentId >= 0) nodes[parentId].childIds.push(id);

      if (type === 'object') {
        var keys = Object.keys(value);
        for (var i = 0; i < keys.length; i++) {
          visit(value[keys[i]], keys[i], id, depth + 1, segs.concat([keys[i]]));
        }
      } else if (type === 'array') {
        for (var j = 0; j < value.length; j++) {
          visit(value[j], String(j), id, depth + 1, segs.concat([j]));
        }
      }
    }

    visit(rootValue, '', -1, 0, []);
    return { nodes: nodes, truncated: truncated };
  }

  /**
   * 这个键名要不要写成 ["…"] 的引用形式？
   *
   * 含分隔符、空白或方括号就必须写 —— 否则拆路径时会在键名中间断开。
   * 空键名也写（不然路径里就少了一段）。
   */
  function needsQuote(name, sep) {
    if (!name) return true;
    if (name.indexOf(sep) >= 0) return true;
    return /[\s\[\]"']/.test(name);
  }

  function quoteIfNeeded(name, sep) {
    if (!needsQuote(name, sep)) return name;
    return '[' + JSON.stringify(String(name)) + ']';
  }

  /**
   * 路径 → 点号写法（给人看）：a.b[0].c
   *
   * 规则只有两条：
   *   - 数组下标写成 [i]，引用形式的键写成 ["…"] —— 这两种自带边界，
   *     前面不用加分隔符（a[0].b、a["b.c"] 都是对的）；
   *   - 普通键名前面加分隔符，第一个除外。
   */
  function pathToDot(segs, sep) {
    sep = sep || '.';
    var out = '';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (typeof s === 'number') {
        out += '[' + s + ']';
        continue;
      }
      var name = String(s);
      if (needsQuote(name, sep)) {
        out += quoteIfNeeded(name, sep);
        continue;
      }
      out += (i > 0 ? sep : '') + name;
    }
    return out;
  }

  /**
   * 路径 → JSONPath（给脚本用）：$.a.b[0].c
   *
   * 跟点号写法同一套语法，只是根固定是 $、分隔符固定是 . ——
   * 于是它跟「JSON 扁平化」工具用 . 分隔时产出的路径**逐字相同**，
   * 两边抄来抄去不会抄错。
   */
  function pathToJsonPath(segs) {
    var out = '$';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (typeof s === 'number') {
        out += '[' + s + ']';
        continue;
      }
      var name = String(s);
      if (needsQuote(name, '.')) {
        out += quoteIfNeeded(name, '.');
        continue;
      }
      out += '.' + name;
    }
    return out;
  }

  /**
   * 键名换成另一种写法。
   *
   * camelCase / PascalCase 直接用共用的类型推断内核 ——
   * 「JSON 转某种语言」那几个工具也用同一套，转换结果跟那边一致。
   * snake_case / kebab-case / SCREAMING_SNAKE_CASE 用同一个切词结果自己拼。
   *
   * 切词后一个词都不剩（键全是符号或数字）时**保留原键** ——
   * 把 "★" 换成空字符串等于把数据改了。
   */
  function renameKey(key, style) {
    if (!key || style === 'keep') return key;
    if (style === 'camel') return INFER.toCamelCase(key) || key;
    if (style === 'pascal') return INFER.toPascalCase(key) || key;
    var words = INFER.splitWords(key);
    if (!words.length) return key;
    if (style === 'snake') {
      return words.map(function (w) { return w.toLowerCase(); }).join('_');
    }
    if (style === 'kebab') {
      return words.map(function (w) { return w.toLowerCase(); }).join('-');
    }
    if (style === 'screaming') {
      return words.map(function (w) { return w.toUpperCase(); }).join('_');
    }
    return key;
  }

  /** 整份文档按新的键名写法重新组装一份（只用来显示与复制，原文不动）。 */
  function renameKeys(value, style) {
    if (style === 'keep') return value;
    if (Array.isArray(value)) {
      return value.map(function (v) { return renameKeys(v, style); });
    }
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) {
        out[renameKey(k, style)] = renameKeys(value[k], style);
      });
      return out;
    }
    return value;
  }

  /**
   * 找命中的节点：键名里有关键字，或叶子值的文本里有关键字。
   * 返回 null 表示「没在搜索」——调用方据此回到普通的展开逻辑。
   *
   * @param {{nodes: Array}} index
   * @param {string} term
   * @returns {number[]|null} 命中的节点 id
   */
  function searchMatches(index, term) {
    var q = String(term === null || term === undefined ? '' : term).trim().toLowerCase();
    if (!q) return null;
    var hits = [];
    var nodes = index.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var hit = false;
      if (n.key && String(n.key).toLowerCase().indexOf(q) >= 0) hit = true;
      if (!hit && n.type !== 'object' && n.type !== 'array') {
        if (valueText(n.value).toLowerCase().indexOf(q) >= 0) hit = true;
      }
      if (hit) hits.push(n.id);
    }
    return hits;
  }

  /**
   * 命中的节点 + 它们的祖先链，算成一个集合。
   * 搜索时只画这个集合里的节点 —— 命中之外的一律不画。
   */
  function hitSet(index, hits) {
    var set = {};
    var nodes = index.nodes;
    for (var i = 0; i < hits.length; i++) {
      set[hits[i]] = true;
      var p = nodes[hits[i]].parentId;
      while (p >= 0) {
        set[p] = true;
        p = nodes[p].parentId;
      }
    }
    return set;
  }

  /**
   * 当前该显示哪些行。
   *
   * 平时：只显示展开着的分支（懒渲染 —— 收起的一整棵子树一行都不画）。
   * 搜索时：命中的节点 + 它们的祖先链，其余一律不画。
   *
   * @param {{nodes: Array}} index
   * @param {Object} expanded  id → true
   * @param {number[]|null} hits
   * @param {Object} keep      命中 + 祖先链的集合（搜索时用）
   * @returns {Array} 节点数组，顺序是文档顺序（建索引时就是深度优先）
   */
  function visibleNodes(index, expanded, hits, keep) {
    var nodes = index.nodes;
    if (!nodes.length) return [];
    if (hits) {
      return nodes.filter(function (n) { return !!keep[n.id]; });
    }
    var out = [];
    (function walk(id) {
      var n = nodes[id];
      out.push(n);
      if (!expanded[id]) return;
      for (var j = 0; j < n.childIds.length; j++) walk(n.childIds[j]);
    })(0);
    return out;
  }

  /* ---------- UI ---------- */

  window.ItTools.register('json-tree-view', function (root) {
    var textarea = D.h('textarea.layui-textarea.mono', {
      rows: 10,
      spellcheck: 'false',
      placeholder: t('ph_json', '{ "foo": "bar" }')
    });

    var caseSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'keep', text: t('case_keep', 'Keep as is') }),
      D.h('option', { value: 'camel', text: t('case_camel', 'camelCase') }),
      D.h('option', { value: 'snake', text: t('case_snake', 'snake_case') }),
      D.h('option', { value: 'kebab', text: t('case_kebab', 'kebab-case') }),
      D.h('option', { value: 'pascal', text: t('case_pascal', 'PascalCase') }),
      D.h('option', { value: 'screaming', text: t('case_screaming', 'SCREAMING_SNAKE_CASE') })
    );

    var depthInput = D.h('input.layui-input', {
      type: 'number', min: '0', max: String(MAX_DEPTH), value: String(DEFAULT_DEPTH)
    });

    var searchInput = D.h('input.layui-input', {
      type: 'search',
      placeholder: t('search_ph', 'Search keys and values')
    });

    // 三行提示各带一个自己的类名：端到端脚本要分别读它们，
    // 全是 .field-hint 的话只能靠出现顺序猜（字段说明里也有 .field-hint）。
    var statusLine = D.h('p.field-hint.tree-status');
    var searchInfo = D.h('p.field-hint.tree-search-info');
    var selectedHint = D.h('p.field-hint.tree-selected-hint');
    var treeBox = D.h('div.tree-box');
    var selDot = D.h('code.tree-path');
    var selJsonPath = D.h('code.tree-path');
    var valuePre = D.h('pre.tree-pre.mono');

    var state = {
      index: null,      // buildIndex 的结果
      value: undefined, // 解析出来的原始值
      expanded: {},     // 节点 id → true
      selectedId: -1,
      hits: null,
      searchTerm: ''
    };

    var parseTimer = null;
    var searchTimer = null;

    function currentStyle() {
      return caseSelect.value || 'keep';
    }

    /** 显示用的路径分段（键名按当前写法换过）。 */
    function displaySegs(node) {
      var style = currentStyle();
      if (style === 'keep') return node.segs;
      return node.segs.map(function (s) {
        return typeof s === 'number' ? s : renameKey(String(s), style);
      });
    }

    /** 「展开到第 N 层」的值，夹在 0 到 MAX_DEPTH 之间。 */
    function clampDepth() {
      var v = parseInt(depthInput.value, 10);
      if (isNaN(v)) return DEFAULT_DEPTH;
      if (v < 0) return 0;
      if (v > MAX_DEPTH) return MAX_DEPTH;
      return v;
    }

    /** 展开前 N 层（深度小于 level 的容器节点都展开）。 */
    function expandToDepth(level) {
      state.expanded = {};
      var nodes = state.index ? state.index.nodes : [];
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].childIds.length && nodes[i].depth < level) {
          state.expanded[nodes[i].id] = true;
        }
      }
    }

    function renderStatus() {
      D.clear(statusLine);
      if (!state.index) return;   // 出错时错误信息已经写在 statusLine 上了
      var n = state.index.nodes.length;
      statusLine.textContent = t('status_nodes', '{count} nodes')
        .replace('{count}', function () { return String(n); });
      if (state.index.truncated) {
        statusLine.appendChild(D.h('span.tree-warn', {
          text: ' · ' + t('err_too_many_nodes', 'The document has more than {max} nodes; only the first {shown} are shown.')
            .replace('{max}', function () { return String(MAX_NODES); })
            .replace('{shown}', function () { return String(n); })
        }));
      }
    }

    function renderSearchInfo(hits) {
      D.clear(searchInfo);
      if (!state.searchTerm) return;
      if (!hits || !hits.length) {
        searchInfo.textContent = t('search_none', 'No match');
        return;
      }
      searchInfo.textContent = t('search_hits', '{count} matches')
        .replace('{count}', function () { return String(hits.length); });
    }

    function previewOf(node) {
      var text = valueText(node.value);
      if (text.length > PREVIEW_LIMIT) text = text.slice(0, PREVIEW_LIMIT) + '…';
      return text;
    }

    function renderRow(node, hitIds, keep) {
      var isHit = !!hitIds[node.id];
      var row = D.h('div.tree-row', {
        style: { paddingLeft: (node.depth * 16 + 4) + 'px' },
        'data-node': String(node.id)
      });
      if (state.selectedId === node.id) row.classList.add('is-selected');
      if (isHit) row.classList.add('is-hit');
      else if (keep && keep[node.id]) row.classList.add('is-ancestor');

      // 展开三角：没有子节点时放一个等宽的空位，键名才对得齐
      if (node.childIds.length) {
        var open = !!state.expanded[node.id];
        var btn = D.h('button.tree-toggle', {
          type: 'button',
          text: open ? '▾' : '▸',
          title: open ? t('btn_collapse', 'Collapse') : t('btn_expand', 'Expand')
        });
        btn.addEventListener('click', function (e) {
          e.stopPropagation();     // 别顺带把这一行也选了
          if (state.expanded[node.id]) delete state.expanded[node.id];
          else state.expanded[node.id] = true;
          renderTree();
        });
        row.appendChild(btn);
      } else {
        row.appendChild(D.h('span.tree-toggle.is-empty'));
      }

      var segs = displaySegs(node);
      var keyText = node.parentId < 0
        ? t('root_label', '(root)')
        : String(segs[segs.length - 1]);
      row.appendChild(D.h('span.tree-key', { text: keyText }));
      row.appendChild(D.h('span.tree-type', { text: typeBadge(node.type, node.value) }));

      if (node.type === 'object' || node.type === 'array') {
        row.appendChild(D.h('span.tree-count', { text: String(node.childIds.length) }));
      } else {
        row.appendChild(D.h('span.tree-value', { text: previewOf(node) }));
      }

      row.addEventListener('click', function () {
        state.selectedId = node.id;
        renderTree();
        renderSelected();
      });
      return row;
    }

    function renderTree() {
      D.clear(treeBox);
      if (!state.index) return;

      var hits = state.searchTerm ? searchMatches(state.index, state.searchTerm) : null;
      state.hits = hits;
      var keep = hits ? hitSet(state.index, hits) : null;
      // 命中 id 也做成一张表：每行都查一次数组的话，命中多了就是平方级的
      var hitIds = {};
      if (hits) {
        for (var h = 0; h < hits.length; h++) hitIds[hits[h]] = true;
      }
      var visible = visibleNodes(state.index, state.expanded, hits, keep);

      if (!visible.length) {
        treeBox.appendChild(D.h('p.field-hint', {
          text: hits
            ? t('search_none', 'No match')
            : t('hint_empty', 'Paste a JSON document to see it as a tree.')
        }));
        renderSearchInfo(hits);
        return;
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < visible.length; i++) {
        frag.appendChild(renderRow(visible[i], hitIds, keep));
      }
      treeBox.appendChild(frag);
      renderSearchInfo(hits);
    }

    function renderSelected() {
      var node = (state.index && state.selectedId >= 0) ? state.index.nodes[state.selectedId] : null;
      if (!node) {
        selDot.textContent = '';
        selJsonPath.textContent = '';
        valuePre.textContent = '';
        selectedHint.textContent = t('no_selection', 'Click a node in the tree to see its path and value.');
        return;
      }
      selectedHint.textContent = '';
      var segs = displaySegs(node);
      selDot.textContent = pathToDot(segs, '.');
      selJsonPath.textContent = pathToJsonPath(segs);
      // 先序列化再还原哨兵：还原函数会把哨兵两侧的引号一起吃掉，
      // 于是超范围整数还原成裸数字字面量（跟 json-viewer 同一口径）。
      valuePre.textContent = U.restoreBigIntegers(JSON.stringify(node.value, null, 2));
    }

    function renderAll() {
      renderStatus();
      renderTree();
      renderSelected();
    }

    function reparse() {
      var res = JP.parse(textarea.value);
      if (!res.ok) {
        state.index = null;
        state.value = undefined;
        state.hits = null;
        state.selectedId = -1;
        D.clear(treeBox);
        valuePre.textContent = '';
        selDot.textContent = '';
        selJsonPath.textContent = '';
        selectedHint.textContent = t('no_selection', 'Click a node in the tree to see its path and value.');
        D.clear(statusLine);
        if (res.error === 'empty') {
          statusLine.textContent = t('hint_empty', 'Paste a JSON document to see it as a tree.');
        } else if (res.error === 'unclosed_comment') {
          statusLine.textContent = t('err_unclosed_comment', 'Unclosed block comment.');
        } else if (res.error === 'no_json5') {
          statusLine.textContent = t('err_no_json5', 'This page is missing the JSON5 parser.');
        } else {
          statusLine.textContent = t('err_parse', 'Could not parse the JSON: {message}')
            .replace('{message}', function () { return res.message || ''; });
        }
        return;
      }
      state.value = res.value;
      state.index = buildIndex(res.value);
      state.selectedId = -1;
      expandToDepth(clampDepth());
      renderAll();
    }

    /* ---------- 事件 ---------- */

    function scheduleReparse() {
      if (parseTimer) clearTimeout(parseTimer);
      parseTimer = setTimeout(function () { parseTimer = null; reparse(); }, 250);
    }

    function scheduleSearch() {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = null;
        state.searchTerm = searchInput.value;
        renderTree();
      }, 150);
    }

    var offText = D.on(textarea, 'input', scheduleReparse);
    var offSearch = D.on(searchInput, 'input', scheduleSearch);
    var offCase = D.on(caseSelect, 'change', function () {
      renderTree();
      renderSelected();
    });
    var offDepth = D.on(depthInput, 'change', function () {
      if (!state.index) return;
      expandToDepth(clampDepth());
      renderTree();
    });

    /* ---------- 组装 ---------- */

    function pathRow(label, node) {
      return D.h('div.tree-path-row', null,
        D.h('span.field-label', { text: label }),
        node,
        U.copyButton(function () { return node.textContent; })
      );
    }

    var copyJsonBtn = U.copyButton(function () {
      if (!state.index) return '';
      var renamed = renameKeys(state.value, currentStyle());
      return U.restoreBigIntegers(JSON.stringify(renamed, null, 2));
    }, t('btn_copy_json', 'Copy JSON'));

    var expandAllBtn = D.h('button.layui-btn.layui-btn-sm', {
      type: 'button', text: t('btn_expand_all', 'Expand all')
    });
    expandAllBtn.addEventListener('click', function () {
      if (!state.index) return;
      var nodes = state.index.nodes;
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].childIds.length) state.expanded[nodes[i].id] = true;
      }
      renderTree();
    });

    var collapseAllBtn = D.h('button.layui-btn.layui-btn-sm', {
      type: 'button', text: t('btn_collapse_all', 'Collapse all')
    });
    collapseAllBtn.addEventListener('click', function () {
      // 全收起的话树只剩一行，什么也看不见 —— 留根节点展开，至少能看到顶层键
      state.expanded = {};
      if (state.index && state.index.nodes.length) state.expanded[0] = true;
      renderTree();
    });

    var inputCard = D.h('div.card', null,
      U.field(t('json_input', 'JSON document'), textarea, { wide: true }),
      D.h('div.field-row', null,
        U.field(t('key_case', 'Key name style'), caseSelect, {
          hint: t('hint_case', 'Only the display and the copied JSON change. Keys that collide after renaming end up as one.')
        }),
        U.field(t('expand_depth', 'Expand to level'), depthInput, {
          hint: t('hint_depth', 'Level 1 shows the root node only.')
        })
      ),
      statusLine
    );
    // 卡片里的大标题用动作句（侧边栏里的名字是名词短语，两处不是同一句）
    inputCard.insertBefore(D.h('h3', { text: t('title', 'Browse a JSON document as a collapsible tree') }), inputCard.firstChild);
    root.appendChild(inputCard);

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('tree_title', 'Tree') })
      ),
      D.h('div.form-actions', null, expandAllBtn, collapseAllBtn, copyJsonBtn),
      U.field(t('search_ph', 'Search keys and values'), searchInput, { wide: true }),
      searchInfo,
      treeBox
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null,
        D.h('span.output-label', { text: t('selected_title', 'Selected node') })
      ),
      pathRow(t('path_title', 'Path'), selDot),
      pathRow(t('jsonpath_title', 'JSONPath'), selJsonPath),
      selectedHint,
      D.h('div.tree-value-head', null,
        D.h('span.field-label', { text: t('value_title', 'Value') }),
        U.copyButton(function () { return valuePre.textContent; })
      ),
      valuePre
    ));

    reparse();

    return {
      destroy: function () {
        offText();
        offSearch();
        offCase();
        offDepth();
        if (parseTimer) clearTimeout(parseTimer);
        if (searchTimer) clearTimeout(searchTimer);
        D.clear(root);
      }
    };
  });

  /* ---------- 单测用的纯逻辑 ---------- */

  window.ItTools.logic['json-tree-view'] = {
    nodeType: nodeType,
    typeBadge: typeBadge,
    isBigInt: isBigInt,
    valueText: valueText,
    buildIndex: buildIndex,
    needsQuote: needsQuote,
    quoteIfNeeded: quoteIfNeeded,
    pathToDot: pathToDot,
    pathToJsonPath: pathToJsonPath,
    renameKey: renameKey,
    renameKeys: renameKeys,
    searchMatches: searchMatches,
    hitSet: hitSet,
    visibleNodes: visibleNodes,
    __cases: function (assert) {
      /* ---- nodeType ---- */
      assert.eq(nodeType({}), 'object', '对象');
      assert.eq(nodeType([]), 'array', '数组');
      assert.eq(nodeType('x'), 'string', '字符串');
      assert.eq(nodeType(1), 'number', '数字');
      assert.eq(nodeType(true), 'boolean', '布尔');
      assert.eq(nodeType(null), 'null', 'null');
      assert.eq(nodeType(undefined), 'null', 'undefined 当 null');

      /* ---- buildIndex ---- */
      var idx = buildIndex({ a: { b: [1, { c: 2 }] }, d: 'x' });
      assert.eq(idx.truncated, false, '没超上限');
      // 根 + a + b + 1 + c + 2 + d = 7 个节点
      assert.eq(idx.nodes.length, 7, '节点数');
      assert.eq(idx.nodes[0].key, '', '根节点没有键');
      assert.eq(idx.nodes[0].parentId, -1, '根节点没有父');
      assert.eq(idx.nodes[0].depth, 0, '根节点深度 0');
      assert.eq(idx.nodes[1].key, 'a', '第二个节点是 a');
      assert.eq(idx.nodes[1].parentId, 0, 'a 的父是根');
      assert.eq(idx.nodes[1].depth, 1, 'a 的深度是 1');
      assert.eq(idx.nodes[2].key, 'b', '第三个节点是 b');
      assert.eq(idx.nodes[2].childIds.length, 2, 'b 有两个子节点');
      assert.eq(idx.nodes[2].childIds[0], 3, 'b 的第一个子节点是数组第 0 项');
      assert.eq(idx.nodes[3].segs, ['a', 'b', 0], '数组下标是数字段');
      assert.eq(idx.nodes[4].segs, ['a', 'b', 1], '数组里那个对象的分段');
      assert.eq(idx.nodes[5].segs, ['a', 'b', 1, 'c'], '嵌套对象的分段');
      assert.eq(idx.nodes[5].depth, 4, '最深那个节点的深度');
      assert.eq(buildIndex({ a: 1 }, { max: 1 }).truncated, true, '超上限要标出来');

      /* ---- 路径 ---- */
      var deep = idx.nodes[5];
      assert.eq(pathToDot(deep.segs, '.'), 'a.b[1].c', '点号路径');
      assert.eq(pathToJsonPath(deep.segs), '$.a.b[1].c', 'JSONPath');
      assert.eq(pathToDot([], '.'), '', '根没有路径');
      assert.eq(pathToJsonPath([]), '$', '根的 JSONPath 就是 $');
      assert.eq(pathToDot(['a', 0], '.'), 'a[0]', '数组下标');
      assert.eq(pathToJsonPath(['a', 0]), '$.a[0]', '根下的数组下标');
      assert.eq(pathToDot(['a.b'], '.'), '["a.b"]', '键里有点号要加引号');
      assert.eq(pathToJsonPath(['a.b']), '$["a.b"]', 'JSONPath 里也一样');
      assert.eq(pathToDot(['a b'], '.'), '["a b"]', '键里有空格要加引号');
      assert.eq(pathToDot([''], '.'), '[""]', '空键名也要加引号');
      assert.eq(pathToDot(['a', 'b'], '_'), 'a_b', '分隔符可以换');
      assert.eq(pathToDot(['a', 'b.c'], '.'), 'a["b.c"]', '中间的键要引号时前后都不用分隔符');
      assert.eq(pathToJsonPath(['a', 'b.c']), '$.a["b.c"]', 'JSONPath 里也一样');

      /* ---- renameKey ---- */
      assert.eq(renameKey('user_id', 'camel'), 'userId', 'snake → camel');
      assert.eq(renameKey('userId', 'snake'), 'user_id', 'camel → snake');
      assert.eq(renameKey('user-id', 'kebab'), 'user-id', 'kebab 保持');
      assert.eq(renameKey('UserID', 'pascal'), 'UserId', '缩写边界');
      assert.eq(renameKey('userID', 'camel'), 'userId', '缩写边界（camel）');
      assert.eq(renameKey('http_server', 'screaming'), 'HTTP_SERVER', '大写');
      assert.eq(renameKey('user_id', 'keep'), 'user_id', '不改');
      assert.eq(renameKey('★', 'camel'), '★', '切不出词就保留原键');
      assert.eq(renameKey('', 'camel'), '', '空键名不动');

      /* ---- renameKeys ---- */
      assert.eq(renameKeys({ user_id: { a_b: 1 } }, 'camel'), { userId: { aB: 1 } }, '整份换');
      assert.eq(renameKeys([{ user_id: 1 }], 'camel'), [{ userId: 1 }], '数组里的对象也换');
      assert.eq(renameKeys({ a: 1 }, 'keep'), { a: 1 }, '不改时原样返回');

      /* ---- searchMatches ---- */
      var sidx = buildIndex({ user: { id: 1, name: 'bob' }, tag: 'user' });
      assert.eq(searchMatches(sidx, 'user'), [1, 4], '键名命中 + 值命中');
      assert.eq(searchMatches(sidx, 'bob'), [3], '叶子值命中');
      assert.eq(searchMatches(sidx, ''), null, '空关键词不算在搜索');
      assert.eq(searchMatches(sidx, 'zzz'), [], '搜不到就是空数组');

      /* ---- hitSet / visibleNodes ---- */
      var keep = hitSet(sidx, searchMatches(sidx, 'bob'));
      assert.eq(!!keep[0], true, '根在祖先链上');
      assert.eq(!!keep[1], true, '中间的 user 在祖先链上');
      assert.eq(!!keep[3], true, '命中本身在里面');
      assert.eq(!!keep[5], false, '不相干的节点不在里面');
      assert.eq(visibleNodes(sidx, {}, null, null).length, 1, '全收起只剩根');
      assert.eq(visibleNodes(sidx, { 0: true }, null, null).length, 3, '根展开后是三个顶层键');
      assert.eq(visibleNodes(sidx, {}, searchMatches(sidx, 'bob'), keep).length, 3, '搜索时只画命中与祖先');

      /* ---- 超范围整数 ---- */
      var big = JP.parse('{"id":9223372036854775807}');
      assert.eq(big.ok, true, '大整数能解开');
      assert.eq(isBigInt(big.value.id), true, '大整数换成了哨兵');
      assert.eq(valueText(big.value.id), '9223372036854775807', '显示时还原成原来的位数');
      assert.eq(U.restoreBigIntegers(JSON.stringify(big.value)), '{"id":9223372036854775807}', '序列化后还原成裸数字');
      var small = JP.parse('{"id":42}');
      assert.eq(isBigInt(small.value.id), false, '普通数字不是哨兵');
      assert.eq(valueText(small.value.id), '42', '普通数字原样显示');
    }
  };
})();
