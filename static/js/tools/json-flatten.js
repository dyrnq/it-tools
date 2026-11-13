/* ==========================================================================
   JSON 扁平化 / 还原（json-flatten）

   把一份 JSON 摊平成一串「路径 → 值」，或者把这样的一串再还原回嵌套结构。

   为什么要做成一对：单独做扁平化的话，摊出来的表没人能保证能还原回去；
   做成一对就能自己验自己 —— 摊平 → 还原，结果必须跟原文一样。
   路径语法就是两边共同的契约（见下面的「路径语法」）。

   路径语法
     路径 := '$' 段*
     段  := <分隔符>名字 | '[' 名字 ']' | '[' 下标 ']'
     名字 := 不能是分隔符 / 空白 / [ ] 的连续字符；
             含分隔符或空白时写成 ["带引号的名字"]

     {"user":{"id":1,"tags":["a","b"]}}  →  $.user.id = 1
                                            $.user.tags[0] = "a"
                                            $.user.tags[1] = "b"
     [1,2]                                 →  $[0] = 1
     5                                     →  $ = 5

     为什么键名要写成 ["…"]：键里本来就有分隔符的时候，
     直接用分隔符拼起来就分不清是「一个键」还是「两个键」。
     写成引用形式就一定分得清 —— 拆路径时按括号配对走，
     不会在键名中间断开。

   几种刻意做法：
     - 文本列表的行格式定死成「路径 + 一个空格 + 值」，
       值是 JSON 文本（字符串带引号）—— 于是还原时能原样读回类型。
     - 还原的输入形态自动认：整段是 JSON 数组 → 数组对；
       整段是 JSON 对象 → 每个键是一条路径；否则按行读。
     - 超范围整数（超过 2^53-1）解析前换哨兵、输出时还原，
       跟「JSON 树形视图」同一口径（见 app.js 的 ItTools.jsonParse）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var JP = window.ItTools.jsonParse;
  var t = window.ItTools.t('json-flatten');

  /** 可以当分隔符的字符：不能是空白、方括号、$。 */
  var SEPARATORS = ['.', '_', '-', '/', ':', '|'];
  /** 默认分隔符。 */
  var DEFAULT_SEP = '.';

  /* ---------- 纯逻辑 ---------- */

  /** 值的结构类型。null 单独一类（它没有子项）。 */
  function nodeType(value) {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    var ty = typeof value;
    if (ty === 'object') return 'object';
    if (ty === 'number' || ty === 'boolean' || ty === 'string') return ty;
    return 'null';
  }

  /**
   * 这个键名要不要写成 ["…"] 的引用形式？
   *
   * 含分隔符、空白或方括号就必须写 —— 否则拆路径时会在键名中间断开。
   * 默认分隔符（.）也算 —— 换个分隔符摊出来的表，切回 . 时也得能读回去。
   */
  function needsQuote(name, sep) {
    if (!name) return true;
    if (name.indexOf(sep) >= 0) return true;
    if (name.indexOf(DEFAULT_SEP) >= 0) return true;
    return /[\s\[\]"']/.test(name);
  }

  function quoteIfNeeded(name, sep) {
    if (!needsQuote(name, sep)) return name;
    return '[' + JSON.stringify(String(name)) + ']';
  }

  /**
   * 路径分段 → 路径文本。
   *
   * 规则只有两条：
   *   - 数组下标写成 [i]，引用形式的键写成 ["名字"] —— 这两种自带边界，
   *     前面不用加分隔符；
   *   - 普通键名前面加分隔符（根是 $，所以第一段前面也有）。
   *
   * 跟「JSON 树形视图」的 JSONPath 写法是同一套语法（分隔符取 . 时逐字相同），
   * 两边抄路径不会抄错。
   *
   * @param {Array} segs 分段：对象键是字符串，数组下标是数字
   * @param {string} sep
   * @returns {string}
   */
  function formatPath(segs, sep) {
    sep = sep || DEFAULT_SEP;
    var out = '$';
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
      out += sep + name;
    }
    return out;
  }

  /**
   * 扫一段路径文本，取出分段。
   *
   * 返回的 end 是「路径到哪为止」—— 文本列表里路径后面跟着空格和值，
   * 调用方靠它把两者分开。
   *
   * @param {string} text
   * @param {string} sep
   * @returns {{ok: boolean, segs: Array, end: number, error: string}}
   */
  function scanPath(text, sep) {
    sep = sep || DEFAULT_SEP;
    var s = String(text === null || text === undefined ? '' : text);
    var n = s.length;
    var segs = [];
    var i = 0;

    // 有 $ 就是绝对路径（从根开始）；没有就是相对路径（第一段直接是名字）
    if (s.charAt(0) === '$') {
      i = 1;
    } else {
      var start = i;
      while (i < n) {
        var c0 = s.charAt(i);
        if (c0 === sep || c0 === '[' || c0 === ']' || /\s/.test(c0)) break;
        i++;
      }
      if (i > start) {
        segs.push(s.slice(start, i));
      } else if (s.charAt(0) !== '[') {
        return { ok: false, segs: segs, end: 0, error: 'bad_path' };
      }
    }

    while (i < n) {
      var ch = s.charAt(i);

      if (ch === '[') {
        // 找配对的 ]（引号里的 ] 不算）
        var j = i + 1;
        var quote = '';
        while (j < n) {
          var c = s.charAt(j);
          if (quote) {
            if (c === '\\') { j += 2; continue; }
            if (c === quote) quote = '';
          } else if (c === '"' || c === "'") {
            quote = c;
          } else if (c === ']') {
            break;
          }
          j++;
        }
        if (j >= n) return { ok: false, segs: segs, end: i, error: 'unclosed_bracket' };

        var inner = s.slice(i + 1, j);
        if (inner.charAt(0) === '"') {
          var key;
          try {
            key = JSON.parse(inner);
          } catch (e) {
            return { ok: false, segs: segs, end: i, error: 'bad_path' };
          }
          segs.push(String(key));
        } else if (inner.charAt(0) === "'") {
          // 单引号键：JSON.parse 不认，手工去掉引号
          if (inner.length < 2 || inner.charAt(inner.length - 1) !== "'") {
            return { ok: false, segs: segs, end: i, error: 'bad_path' };
          }
          segs.push(inner.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
        } else if (/^[0-9]+$/.test(inner)) {
          segs.push(parseInt(inner, 10));
        } else {
          return { ok: false, segs: segs, end: i, error: 'bad_path' };
        }
        i = j + 1;
        continue;
      }

      if (ch === sep) {
        i++;
        var from = i;
        while (i < n) {
          var c1 = s.charAt(i);
          if (c1 === sep || c1 === '[' || c1 === ']' || /\s/.test(c1)) break;
          i++;
        }
        if (i === from) return { ok: false, segs: segs, end: from, error: 'bad_path' };
        segs.push(s.slice(from, i));
        continue;
      }

      // 既不是括号也不是分隔符 → 路径到此为止（后面应该是空白 + 值）
      break;
    }

    return { ok: true, segs: segs, end: i, error: '' };
  }

  /**
   * 把一份 JSON 摊平成一串「路径 → 值」。
   *
   * @param {*} value
   * @param {{sep?: string, expandArrays?: boolean, keepEmpty?: boolean}} [opts]
   *   expandArrays  false → 数组整体当成一个值，不再往下拆
   *   keepEmpty     false → 空对象 / 空数组直接丢掉，不出现在结果里
   * @returns {Array<{segs: Array, value: *}>}
   */
  function flattenDocument(value, opts) {
    opts = opts || {};
    var expandArrays = opts.expandArrays !== false;
    var keepEmpty = opts.keepEmpty !== false;
    var out = [];

    function walk(v, segs) {
      var type = nodeType(v);
      if (type === 'object') {
        var keys = Object.keys(v);
        if (!keys.length) {
          if (keepEmpty) out.push({ segs: segs, value: {} });
          return;
        }
        for (var i = 0; i < keys.length; i++) walk(v[keys[i]], segs.concat([keys[i]]));
        return;
      }
      if (type === 'array') {
        if (!expandArrays) {
          out.push({ segs: segs, value: v });
          return;
        }
        if (!v.length) {
          if (keepEmpty) out.push({ segs: segs, value: [] });
          return;
        }
        for (var j = 0; j < v.length; j++) walk(v[j], segs.concat([j]));
        return;
      }
      out.push({ segs: segs, value: v });
    }

    walk(value, []);
    return out;
  }

  /**
   * 值文本 → 值。
   * 先按标准 JSON 解，解不开再按 JSON5 解，还解不开就当普通字符串
   * （手写的一行里写 `$.name = hello` 也不该报错）。
   */
  function parseValue(text) {
    var s = String(text === null || text === undefined ? '' : text).trim();
    if (!s) return '';
    var guarded = U.guardBigIntegers(s);
    try {
      return JSON.parse(guarded);
    } catch (e1) { /* 试 JSON5 */ }
    if (typeof window.JSON5 !== 'undefined' && window.JSON5 && typeof window.JSON5.parse === 'function') {
      try {
        return window.JSON5.parse(guarded);
      } catch (e2) { /* 当字符串 */ }
    }
    return s;
  }

  /**
   * 读一行「路径 值」。
   *
   * 行格式定死成「路径 + 空白 + 值」，中间可以有一个 '='（方便手写）。
   * 路径与值之间必须有个分界 —— 否则 '$.a.b' 这种「只有路径没有值」的
   * 行会被当成值读走，那一行就白写了。
   *
   * @returns {{segs: Array, valueText: string, error: string}}
   */
  function parseFlatLine(line, sep) {
    var text = String(line === null || line === undefined ? '' : line);
    var scan = scanPath(text, sep);
    if (!scan.ok) return { segs: [], valueText: '', error: scan.error };
    // 路径后面必须是空白（或者什么都没有）—— 路径与值之间没有分界符是不行的
    if (scan.end < text.length && !/\s/.test(text.charAt(scan.end))) {
      return { segs: [], valueText: '', error: 'bad_path' };
    }
    var rest = text.slice(scan.end).replace(/^\s+/, '');
    if (rest.charAt(0) === '=') rest = rest.slice(1).replace(/^\s+/, '');
    if (!rest) return { segs: [], valueText: '', error: 'no_value' };
    return { segs: scan.segs, valueText: rest, error: '' };
  }

  /**
   * 读一整段「扁平列表」，认出它是什么形态。
   *
   * @param {string} text
   * @param {string} sep
   * @returns {{pairs: Array, errors: Array}} errors 里每条 {line, reason}
   */
  function parseFlatInput(text, sep) {
    var trimmed = String(text === null || text === undefined ? '' : text).trim();
    var pairs = [];
    var errors = [];
    if (!trimmed) return { pairs: pairs, errors: errors };

    // 1) 整段是 JSON 数组 → 数组对形态
    if (trimmed.charAt(0) === '[') {
      var arr = tryParseJson(trimmed);
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) {
          var item = arr[i];
          if (!Array.isArray(item) || item.length !== 2) {
            errors.push({ line: i + 1, reason: 'not_pair' });
            continue;
          }
          var scan = scanPath(String(item[0]), sep);
          if (!scan.ok || scan.end !== String(item[0]).length) {
            errors.push({ line: i + 1, reason: 'bad_path' });
            continue;
          }
          pairs.push({ segs: scan.segs, value: item[1] });
        }
        return { pairs: pairs, errors: errors };
      }
    }

    // 2) 整段是 JSON 对象 → 每个键是一条路径，值是叶子
    //
    //    这里没有歧义：{"a":{"b":1}} 理解成「a → 一个对象叶子」
    //    还是「a.b 一条路径」，还原出来的结果都是 {"a":{"b":1}}。
    if (trimmed.charAt(0) === '{') {
      var obj = tryParseJson(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        var keys = Object.keys(obj);
        for (var k = 0; k < keys.length; k++) {
          var sk = scanPath(keys[k], sep);
          if (!sk.ok || sk.end !== keys[k].length) {
            errors.push({ line: k + 1, reason: 'bad_path' });
            continue;
          }
          pairs.push({ segs: sk.segs, value: obj[keys[k]] });
        }
        return { pairs: pairs, errors: errors };
      }
    }

    // 3) 一行一条
    var lines = trimmed.split(/\r?\n/);
    for (var n = 0; n < lines.length; n++) {
      var l = lines[n].trim();
      if (!l) continue;
      var parsed = parseFlatLine(l, sep);
      if (parsed.error) {
        errors.push({ line: n + 1, reason: parsed.error });
        continue;
      }
      pairs.push({ segs: parsed.segs, value: parseValue(parsed.valueText) });
    }
    return { pairs: pairs, errors: errors };
  }

  /** 试着把一段文本解成 JSON（大整数先换哨兵）。解不开返回 null。 */
  function tryParseJson(text) {
    try {
      return JSON.parse(U.guardBigIntegers(text));
    } catch (e) {
      return null;
    }
  }

  /**
   * 把一串「路径 → 值」还原成嵌套结构。
   *
   * 先按路径组织成一棵树，再一次性建出对象与数组 ——
   * 数组下标可以乱序也可以有缺口（缺口补 null），
   * 边插边建的话很难处理这两种情况。
   *
   * @param {Array<{segs: Array, value: *}>} pairs
   * @param {string} [sep] 冲突提示里路径文本用的分隔符
   * @returns {{value: *, conflicts: Array}} conflicts 里每条是重复出现的路径
   */
  function unflattenPairs(pairs, sep) {
    var root = { seg: null, children: [], value: undefined, hasValue: false };
    var conflicts = [];

    for (var i = 0; i < pairs.length; i++) {
      var segs = pairs[i].segs;
      var node = root;
      for (var j = 0; j < segs.length; j++) {
        var seg = segs[j];
        var child = null;
        for (var c = 0; c < node.children.length; c++) {
          if (node.children[c].seg === seg) { child = node.children[c]; break; }
        }
        if (!child) {
          child = { seg: seg, children: [], value: undefined, hasValue: false };
          node.children.push(child);
        }
        node = child;
      }
      if (node.hasValue) {
        // 同一个路径出现两次 —— 后一条覆盖前一条，但要记下来，不能静默丢数据
        conflicts.push(formatPath(segs, sep || DEFAULT_SEP));
      }
      node.value = pairs[i].value;
      node.hasValue = true;
    }

    return { value: materialize(root), conflicts: conflicts };
  }

  /** 把中间那棵树变成真正的对象 / 数组。 */
  function materialize(node) {
    if (!node.children.length) return node.hasValue ? node.value : null;

    // 全是数字下标 → 数组；否则当对象
    var isArray = true;
    for (var i = 0; i < node.children.length; i++) {
      if (typeof node.children[i].seg !== 'number') { isArray = false; break; }
    }

    if (isArray) {
      var arr = [];
      for (var j = 0; j < node.children.length; j++) {
        var idx = node.children[j].seg;
        if (idx < 0) continue;
        while (arr.length <= idx) arr.push(null);   // 缺的下标补 null
        arr[idx] = materialize(node.children[j]);
      }
      return arr;
    }

    var obj = {};
    for (var k = 0; k < node.children.length; k++) {
      obj[String(node.children[k].seg)] = materialize(node.children[k]);
    }
    return obj;
  }

  /** 值的文本形式（JSON 文本，字符串带引号）。 */
  function valueToText(value) {
    if (value === undefined) return 'null';
    var text;
    try {
      text = JSON.stringify(value);
    } catch (e) {
      text = String(value);
    }
    return text === undefined ? 'null' : text;
  }

  /**
   * 结果的输出形态。
   * @param {Array<{segs: Array, value: *}>} pairs
   * @param {'object'|'array'|'table'} shape
   * @param {string} sep
   * @returns {string}
   */
  function renderPairs(pairs, shape, sep) {
    var i, out;
    if (shape === 'array') {
      var arr = [];
      for (i = 0; i < pairs.length; i++) arr.push([formatPath(pairs[i].segs, sep), pairs[i].value]);
      return JSON.stringify(arr, null, 2);
    }
    if (shape === 'object') {
      var obj = {};
      for (i = 0; i < pairs.length; i++) obj[formatPath(pairs[i].segs, sep)] = pairs[i].value;
      return JSON.stringify(obj, null, 2);
    }
    // 文本列表：路径 + 一个空格 + 值
    var lines = [];
    for (i = 0; i < pairs.length; i++) {
      lines.push(formatPath(pairs[i].segs, sep) + ' ' + valueToText(pairs[i].value));
    }
    return lines.join('\n');
  }

  /* ---------- UI ---------- */

  window.ItTools.register('json-flatten', function (root) {
    var modeSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'flatten', text: t('mode_flatten', 'Flatten') }),
      D.h('option', { value: 'rebuild', text: t('mode_rebuild', 'Rebuild') })
    );

    var textarea = D.h('textarea.layui-textarea.mono', {
      rows: 12,
      spellcheck: 'false',
      placeholder: t('ph_json', '{ "user": { "id": 1 } }')
    });

    var sepSelect = D.h('select.layui-select', null, SEPARATORS.map(function (s) {
      return D.h('option', { value: s, text: s });
    }));
    sepSelect.value = DEFAULT_SEP;

    var arraySelect = D.h('select.layui-select', null,
      D.h('option', { value: 'expand', text: t('array_expand', 'Expand every element') }),
      D.h('option', { value: 'keep', text: t('array_keep', 'Keep the array as one value') })
    );

    var emptySelect = D.h('select.layui-select', null,
      D.h('option', { value: 'keep', text: t('empty_keep', 'Keep them') }),
      D.h('option', { value: 'drop', text: t('empty_drop', 'Drop them') })
    );

    var shapeSelect = D.h('select.layui-select', null,
      D.h('option', { value: 'table', text: t('shape_table', 'Text list') }),
      D.h('option', { value: 'object', text: t('shape_object', 'Object') }),
      D.h('option', { value: 'array', text: t('shape_array', 'Array of pairs') })
    );

    var statusLine = D.h('p.form-status');
    var output = U.codeBlock();
    var inputLabel = D.h('label.field-label');
    var timer = null;

    /**
     * 「标签在上 + 控件」的字段块。
     * 标签在上而不是在左边：几个下拉框要并排放在一行里，
     * 左边留一列标签的话就得占掉四份 120px，窄屏上摆不下。
     */
    function labeled(labelText, control, id) {
      control.id = id;
      return D.h('div.field', null,
        D.h('label.field-label', { for: id, text: labelText }),
        control
      );
    }

    var modeField = labeled(t('mode', 'Mode'), modeSelect, 'jf-mode');
    var inputField = D.h('div.field', null, inputLabel, textarea);
    var sepField = labeled(t('separator', 'Separator'), sepSelect, 'jf-sep');
    var arrayField = labeled(t('array_mode', 'Arrays'), arraySelect, 'jf-array');
    var emptyField = labeled(t('empty_mode', 'Empty containers'), emptySelect, 'jf-empty');
    var shapeField = labeled(t('output_shape', 'Output'), shapeSelect, 'jf-shape');

    function currentSep() {
      var v = sepSelect.value;
      return SEPARATORS.indexOf(v) >= 0 ? v : DEFAULT_SEP;
    }

    function isFlatten() {
      return modeSelect.value !== 'rebuild';
    }

    function setStatus(message, isError) {
      D.clear(statusLine);
      statusLine.classList.remove('is-error');
      if (!message) return;
      if (isError) statusLine.classList.add('is-error');
      statusLine.appendChild(D.h('span', { text: message }));
    }

    function reasonText(reason) {
      if (reason === 'not_pair') return t('reason_pair', 'it is not a [path, value] pair');
      if (reason === 'unclosed_bracket') return t('reason_bracket', 'a bracket is not closed');
      if (reason === 'no_value') return t('reason_value', 'there is no value after the path');
      return t('reason_path', 'the key path cannot be read');
    }

    function renderFlatten() {
      var res = JP.parse(textarea.value);
      if (!res.ok) {
        output.value = '';
        if (res.error === 'empty') {
          setStatus(t('hint_empty', 'Paste a JSON document to flatten it.'), false);
        } else if (res.error === 'unclosed_comment') {
          setStatus(t('err_unclosed_comment', 'Unclosed block comment.'), true);
        } else if (res.error === 'no_json5') {
          setStatus(t('err_no_json5', 'This page is missing the JSON5 parser.'), true);
        } else {
          setStatus(t('err_parse', 'Could not parse the JSON: {message}')
            .replace('{message}', function () { return res.message || ''; }), true);
        }
        return;
      }
      var pairs = flattenDocument(res.value, {
        expandArrays: arraySelect.value !== 'keep',
        keepEmpty: emptySelect.value !== 'drop'
      });
      var shape = shapeSelect.value;
      output.value = U.restoreBigIntegers(renderPairs(pairs, shape, currentSep()));
      var dup = 0;
      if (shape === 'object') {
        // 对象形态放不下重复的路径 —— 数一下有多少条被吃掉了
        var seen = {};
        for (var i = 0; i < pairs.length; i++) {
          var key = formatPath(pairs[i].segs, currentSep());
          if (seen[key]) dup++;
          seen[key] = true;
        }
      }
      var summary = t('summary', '{count} entries').replace('{count}', function () { return String(pairs.length); });
      if (dup) {
        summary += ' · ' + t('err_dup_paths', '{count} paths appear more than once; the last one wins.')
          .replace('{count}', function () { return String(dup); });
      }
      setStatus(summary, false);
    }

    function renderRebuild() {
      var parsed = parseFlatInput(textarea.value, currentSep());
      var built = unflattenPairs(parsed.pairs, currentSep());
      output.value = U.restoreBigIntegers(JSON.stringify(built.value, null, 2));

      var summary = t('summary', '{count} entries').replace('{count}', function () { return String(parsed.pairs.length); });
      var problems = [];
      for (var i = 0; i < parsed.errors.length; i++) {
        problems.push(t('err_bad_line', 'Line {line}: {reason}')
          .replace('{line}', function () { return String(parsed.errors[i].line); })
          .replace('{reason}', function () { return reasonText(parsed.errors[i].reason); }));
      }
      for (var c = 0; c < built.conflicts.length; c++) {
        problems.push(t('err_dup_path', 'The key {path} appears more than once; the last one wins.')
          .replace('{path}', function () { return built.conflicts[c]; }));
      }
      if (problems.length) {
        setStatus(summary + ' · ' + problems.join(' · '), true);
      } else {
        setStatus(summary, false);
      }
    }

    function render() {
      if (isFlatten()) renderFlatten();
      else renderRebuild();
    }

    function scheduleRender() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; render(); }, 250);
    }

    function syncMode() {
      var flatten = isFlatten();
      inputLabel.textContent = flatten ? t('input_json', 'JSON document') : t('input_flat', 'Flat key list');
      textarea.placeholder = flatten ? t('ph_json', '{ "user": { "id": 1 } }') : t('ph_flat', '$.user.id = 1');
      // 还原模式只用得上分隔符，其余选项先藏起来
      arrayField.style.display = flatten ? '' : 'none';
      emptyField.style.display = flatten ? '' : 'none';
      shapeField.style.display = flatten ? '' : 'none';
      render();
    }

    var offMode = D.on(modeSelect, 'change', syncMode);
    var offText = D.on(textarea, 'input', scheduleRender);
    var offSep = D.on(sepSelect, 'change', render);
    var offArray = D.on(arraySelect, 'change', render);
    var offEmpty = D.on(emptySelect, 'change', render);
    var offShape = D.on(shapeSelect, 'change', render);

    /* ---------- 组装 ---------- */

    textarea.id = 'jf-input';
    inputLabel.setAttribute('for', textarea.id);

    var inputCard = D.h('div.card', null,
      modeField,
      inputField,
      D.h('div.field-row', null, sepField, arrayField, emptyField, shapeField),
      D.h('p.field-hint', {
        text: t('hint_sep', 'Keys are joined with this character. A key that contains it is written as ["key"].')
      }),
      statusLine
    );
    // 卡片里的大标题用动作句（侧边栏里的名字是名词短语，两处不是同一句）
    inputCard.insertBefore(D.h('h3', { text: t('title', 'Flatten a JSON document into dot-separated keys, or rebuild it') }), inputCard.firstChild);
    root.appendChild(inputCard);

    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('result_title', 'Result') }),
      output.card
    ));

    syncMode();

    return {
      destroy: function () {
        offMode();
        offText();
        offSep();
        offArray();
        offEmpty();
        offShape();
        if (timer) clearTimeout(timer);
        D.clear(root);
      }
    };
  });

  /* ---------- 单测用的纯逻辑 ---------- */

  window.ItTools.logic['json-flatten'] = {
    nodeType: nodeType,
    needsQuote: needsQuote,
    quoteIfNeeded: quoteIfNeeded,
    formatPath: formatPath,
    scanPath: scanPath,
    flattenDocument: flattenDocument,
    parseValue: parseValue,
    parseFlatLine: parseFlatLine,
    parseFlatInput: parseFlatInput,
    unflattenPairs: unflattenPairs,
    materialize: materialize,
    valueToText: valueToText,
    renderPairs: renderPairs,
    __cases: function (assert) {
      /* ---- formatPath ---- */
      assert.eq(formatPath(['user', 'id'], '.'), '$.user.id', '两层');
      assert.eq(formatPath(['user', 0, 'id'], '.'), '$.user[0].id', '数组下标');
      assert.eq(formatPath([], '.'), '$', '根');
      assert.eq(formatPath(['a.b'], '.'), '$["a.b"]', '键里有点号要用引用形式');
      assert.eq(formatPath(['a.b'], '_'), '$["a.b"]', '分隔符是下划线时也一样');
      assert.eq(formatPath(['a', 'b'], '_'), '$_a_b', '换个分隔符');
      assert.eq(formatPath(['a b'], '.'), '$["a b"]', '键里有空格');
      assert.eq(formatPath([0, 1], '.'), '$[0][1]', '两个下标挨着');
      assert.eq(formatPath(['a', 'b.c'], '.'), '$.a["b.c"]', '中间的键用了引号形式');

      /* ---- scanPath ---- */
      assert.eq(scanPath('$.user.id', '.').segs, ['user', 'id'], '扫出两段');
      assert.eq(scanPath('$.user[0].id', '.').segs, ['user', 0, 'id'], '下标是数字');
      assert.eq(scanPath('$["a.b"].c', '.').segs, ['a.b', 'c'], '引用形式的键');
      assert.eq(scanPath('$.a b', '.').segs, ['a'], '路径到空白为止');
      assert.eq(scanPath('$.a b', '.').end, 3, 'end 指向空白');
      assert.eq(scanPath('$.a', '.').ok, true, '正常路径');
      assert.eq(scanPath('$["a', '.').ok, false, '括号没闭合');
      assert.eq(scanPath('$.a..b', '.').ok, false, '中间有空名字');
      assert.eq(scanPath('a.b', '.').segs, ['a', 'b'], '没有 $ 的相对路径');

      /* ---- flattenDocument ---- */
      var pairs = flattenDocument({ user: { id: 1, tags: ['a'] } });
      assert.eq(pairs.length, 2, '摊出两条');
      assert.eq(formatPath(pairs[0].segs, '.'), '$.user.id', '第一条');
      assert.eq(pairs[0].value, 1, '第一条的值');
      assert.eq(formatPath(pairs[1].segs, '.'), '$.user.tags[0]', '数组元素');
      assert.eq(pairs[1].value, 'a', '数组元素的值');

      var kept = flattenDocument({ tags: ['a', 'b'] }, { expandArrays: false });
      assert.eq(kept.length, 1, '数组整体保留时只有一条');
      assert.eq(kept[0].value, ['a', 'b'], '值就是那个数组');

      var empties = flattenDocument({ a: {}, b: [] });
      assert.eq(empties.length, 2, '空容器默认留着');
      assert.eq(valueToText(empties[0].value), '{}', '空对象的值');
      assert.eq(flattenDocument({ a: {}, b: [] }, { keepEmpty: false }).length, 0, '空容器可以丢掉');

      var rootScalar = flattenDocument(5);
      assert.eq(rootScalar.length, 1, '根是个标量');
      assert.eq(formatPath(rootScalar[0].segs, '.'), '$', '根的路径就是 $');

      /* ---- parseValue ---- */
      assert.eq(parseValue('1'), 1, '数字');
      assert.eq(parseValue('"bob"'), 'bob', '带引号的字符串');
      assert.eq(parseValue('true'), true, '布尔');
      assert.eq(parseValue('null'), null, 'null');
      assert.eq(parseValue('{"x":1}'), { x: 1 }, '对象');
      assert.eq(parseValue('hello'), 'hello', '解不开就当字符串');

      /* ---- parseFlatLine ---- */
      var line = parseFlatLine('$.user.id 1', '.');
      assert.eq(line.error, '', '这一行没问题');
      assert.eq(line.segs, ['user', 'id'], '路径');
      assert.eq(line.valueText, '1', '值文本');
      assert.eq(parseFlatLine('$.a = {"x":1}', '.').valueText, '{"x":1}', '值里有空格也不能丢');
      assert.eq(parseFlatLine('$.a.b', '.').error, 'no_value', '只有路径没有值');
      assert.eq(parseFlatLine('$.a..b 1', '.').error, 'bad_path', '路径中间有空名字');
      assert.eq(parseFlatLine('$.a.b1 1', '.').segs, ['a', 'b1'], '键名里的数字还是键名的一部分');

      /* ---- 往返 ---- */
      var doc = { a: { b: [1, 2] }, c: 'x', 'd.e': { f: 1 } };
      var flat = flattenDocument(doc);
      var text = renderPairs(flat, 'table', '.');
      var back = parseFlatInput(text, '.');
      assert.eq(back.errors.length, 0, '往返没有报错');
      var rebuilt = unflattenPairs(back.pairs).value;
      assert.eq(rebuilt, doc, '摊平再还原，结果跟原文一样');

      /* ---- 数组与缺的下标 ---- */
      var rebuilt2 = unflattenPairs([
        { segs: ['a', 2], value: 'x' },
        { segs: ['a', 0], value: 'y' }
      ]).value;
      assert.eq(rebuilt2, { a: ['y', null, 'x'] }, '缺的下标补 null —— 顺序不影响结果');

      /* ---- 重复路径 ---- */
      var dup = unflattenPairs([
        { segs: ['a'], value: 1 },
        { segs: ['a'], value: 2 }
      ]);
      assert.eq(dup.value, { a: 2 }, '重复的路径后一条赢');
      assert.eq(dup.conflicts.length, 1, '但要记下来');

      /* ---- 对象形态的输入 ---- */
      var fromObject = parseFlatInput('{"$.a": 1, "$.b": {"c": 2}}', '.');
      assert.eq(fromObject.errors.length, 0, '对象形态没有报错');
      assert.eq(unflattenPairs(fromObject.pairs).value, { a: 1, b: { c: 2 } }, '对象形态还原');

      /* ---- 数组形态的输入 ---- */
      var fromArray = parseFlatInput('[["$.a", 1], ["$.b", 2]]', '.');
      assert.eq(fromArray.errors.length, 0, '数组形态没有报错');
      assert.eq(unflattenPairs(fromArray.pairs).value, { a: 1, b: 2 }, '数组形态还原');

      /* ---- 大整数往返 ---- */
      var big = JP.parse('{"id":9223372036854775807}');
      assert.eq(big.ok, true, '大整数能解开');
      var bigFlat = flattenDocument(big.value);
      var bigText = U.restoreBigIntegers(renderPairs(bigFlat, 'table', '.'));
      assert.eq(bigText, '$.id 9223372036854775807', '摊平时还是原来的位数');
      var bigBack = unflattenPairs(parseFlatInput(bigText, '.').pairs).value;
      assert.eq(U.restoreBigIntegers(JSON.stringify(bigBack)), '{"id":9223372036854775807}', '还原后还是原来的位数');
    }
  };
})();
