/* ==========================================================================
   正则表达式测试（regex-tester）

   输入正则 + 测试串，实时高亮所有匹配，列出每次匹配的捕获组与命名组，
   并用 @regexper/render 把正则画成 SVG 示意图。附一份常用正则片段速查表，
   点一下就把片段填进正则输入框。

   参考实现：src/tools/regex-tester/（it-tools, GPLv3）
   与原版的差别：
   1. **原版会崩**。它对每个捕获组直接取 `indices[n][0]`，但没参与匹配的
      分组在 `indices[n]` 上是 undefined —— `(a)|(b)` 匹配 "b" 时就抛
      TypeError，整页白屏。这里对缺失的下标返回 null。
   2. **原版空匹配会提前收工**。模式 `\d*`（带 g 标志）跑 "a1b" 时第一个结果是空串，
      它直接 break，后面的 "1" 永远匹配不到。这里空匹配时把 lastIndex 推进
      一格继续找，语义与 String.matchAll 一致。
   3. 原版只有勾选框（g/i/m/s/u/v），这里按清单改成 flags 下拉（g/i/m/s/u/y），
      多一个 y（sticky）；v（Unicode sets）不在清单里就没放进去。
      实测 v 和 d 可以同时给（Node 22：`new RegExp('a','vd')` 正常，flags='dv'）。
   4. `match.indices` 需要 `d` 标志。这里内部始终尝试加 `d`（用户看不到），
      引擎不支持 `d` 时退回无 indices 的模式：匹配结果照常给，只是不再显示
      捕获组的下标区间。
   5. 「按正则生成一条样本串」用 RandExp。RandExp **不认命名捕获组**
      （`(?<name>…)` 直接抛 "Invalid group, character '<' after '?'"），
      也不认后向断言，这里都先改写成非捕获组。参考实现只处理了命名组，
      后向断言那条会漏掉。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('regex-tester');

  /** 下拉里的 flags。默认 g，和原版一致。 */
  var FLAGS = ['g', 'i', 'm', 's', 'u', 'y'];

  var FLAG_DESC = {
    g: t('flag_g', 'global — find every match, not just the first one'),
    i: t('flag_i', 'ignoreCase — case insensitive'),
    m: t('flag_m', 'multiline — ^ and $ also match the start and end of every line'),
    s: t('flag_s', 'dotAll — . also matches the line break'),
    u: t('flag_u', 'unicode — the pattern is handled by Unicode code points'),
    y: t('flag_y', 'sticky — matching is only tried from lastIndex')
  };

  /* 常用正则片段：点一下填进正则框。取自参考项目里的 regex-memo 速查表，
     按主题归了类，够日常用了。 */
  var COMMON_PATTERNS = [
    { group: t('group_characters', 'Characters'), expr: '.', desc: t('pattern_dot', 'Any character except the line break') },
    { group: t('group_characters', 'Characters'), expr: '\\d', desc: t('pattern_digit', 'A digit, same as [0-9]') },
    { group: t('group_characters', 'Characters'), expr: '\\D', desc: t('pattern_non_digit', 'Not a digit') },
    { group: t('group_characters', 'Characters'), expr: '\\w', desc: t('pattern_word', 'A letter, a digit or an underscore') },
    { group: t('group_characters', 'Characters'), expr: '\\W', desc: t('pattern_non_word', 'The opposite of \\w') },
    { group: t('group_characters', 'Characters'), expr: '\\s', desc: t('pattern_space', 'A space, a tab, a line break or a carriage return') },
    { group: t('group_characters', 'Characters'), expr: '\\S', desc: t('pattern_non_space', 'The opposite of \\s') },
    { group: t('group_characters', 'Characters'), expr: '[a-zA-Z]', desc: t('pattern_letter', 'Any english letter') },
    { group: t('group_characters', 'Characters'), expr: '[^abc]', desc: t('pattern_not_abc', 'Any character except a, b and c') },

    { group: t('group_quantifiers', 'Quantifiers'), expr: 'a*', desc: t('pattern_a_star', 'a appears 0 or more times') },
    { group: t('group_quantifiers', 'Quantifiers'), expr: 'a+', desc: t('pattern_a_plus', 'a appears 1 or more times') },
    { group: t('group_quantifiers', 'Quantifiers'), expr: 'a?', desc: t('pattern_a_optional', 'a appears 0 or 1 time') },
    { group: t('group_quantifiers', 'Quantifiers'), expr: 'a{3}', desc: t('pattern_a_exactly_3', 'a appears exactly 3 times') },
    { group: t('group_quantifiers', 'Quantifiers'), expr: 'a{2,}', desc: t('pattern_a_at_least_2', 'a appears at least 2 times') },
    { group: t('group_quantifiers', 'Quantifiers'), expr: 'a{2,4}', desc: t('pattern_a_2_to_4', 'a appears 2 to 4 times') },
    { group: t('group_quantifiers', 'Quantifiers'), expr: 'a+?', desc: t('pattern_a_lazy', 'Lazy version: stop as early as possible') },
    { group: t('group_quantifiers', 'Quantifiers'), expr: 'a{2,4}?', desc: t('pattern_a_range_lazy', 'Lazy version of the range quantifier') },

    { group: t('group_anchors', 'Anchors'), expr: '^abc', desc: t('pattern_line_start', 'Start of the line (with the m flag)') },
    { group: t('group_anchors', 'Anchors'), expr: 'abc$', desc: t('pattern_line_end', 'End of the line (with the m flag)') },
    { group: t('group_anchors', 'Anchors'), expr: '\\bword\\b', desc: t('pattern_word_boundary', 'Word boundary') },
    { group: t('group_anchors', 'Anchors'), expr: '(?=abc)', desc: t('pattern_lookahead', 'Lookahead: abc must come next') },
    { group: t('group_anchors', 'Anchors'), expr: '(?!abc)', desc: t('pattern_negative_lookahead', 'Negative lookahead: abc must not come next') },
    { group: t('group_anchors', 'Anchors'), expr: '(?<=abc)', desc: t('pattern_lookbehind', 'Lookbehind (needs the v flag or ES2018 and above)') },

    { group: t('group_groups', 'Groups'), expr: '(abc)', desc: t('pattern_capture_group', 'Capturing group') },
    { group: t('group_groups', 'Groups'), expr: '(?:abc)', desc: t('pattern_non_capture_group', 'Non capturing group, it groups without recording') },
    { group: t('group_groups', 'Groups'), expr: '(?<year>\\d{4})', desc: t('pattern_named_group', 'Named capturing group') },
    { group: t('group_groups', 'Groups'), expr: '(a)(b)\\2', desc: t('pattern_backreference', 'Backreference: repeat the group number 2') },

    { group: t('group_common', 'Common'), expr: '^\\d{4}-\\d{2}-\\d{2}$', desc: t('pattern_iso_date', 'A YYYY-MM-DD date') },
    { group: t('group_common', 'Common'), expr: '^\\d{2}:\\d{2}(:\\d{2})?$', desc: t('pattern_time', 'A HH:MM or HH:MM:SS time') },
    { group: t('group_common', 'Common'), expr: '[\\w.+-]+@[\\w-]+\\.[\\w.]+', desc: t('pattern_email', 'A rough email address') },
    { group: t('group_common', 'Common'), expr: 'https?://\\S+', desc: t('pattern_url', 'An http(s) link') },
    { group: t('group_common', 'Common'), expr: '^(?:\\d{1,3}\\.){3}\\d{1,3}$', desc: t('pattern_ipv4', 'An IPv4 address (rough)') },
    { group: t('group_common', 'Common'), expr: '#[0-9a-fA-F]{6}\\b', desc: t('pattern_hex_color', 'A #RRGGBB color') },
    { group: t('group_common', 'Common'), expr: '\\b\\d+(?:\\.\\d+)?\\b', desc: t('pattern_decimal_number', 'A decimal number') },
    { group: t('group_common', 'Common'), expr: '(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})', desc: t('pattern_ipv4_octets', 'Split the four parts of an IPv4 address') }
  ];

  /**
   * 编译正则。内部补一个 `d` 标志以拿到 match.indices；老引擎不支持就退回去。
   * @returns {{ok:boolean, re?:RegExp, indices?:boolean, error?:string}}
   */
  function buildRegex(src, flags) {
    var f = flags || '';
    try {
      return { ok: true, re: new RegExp(src, f + 'd'), indices: true };
    } catch (e) {
      // 可能是模式本身非法，也可能是这个引擎不认 d —— 用不带 d 的再试一次来区分
    }
    try {
      return { ok: true, re: new RegExp(src, f), indices: false };
    } catch (e2) {
      return { ok: false, error: e2 && e2.message ? e2.message : String(e2) };
    }
  }

  /**
   * d 标志的 indices 在规范里是「码点下标」（开了 u 时），而 text.slice 是 UTF-16 下标。
   * V8 实际返回的是 UTF-16 下标，但别的引擎不一定，这里统一换算一次，
   * 免得捕获组下标在 Safari 上错位。
   * @param {string} text
   * @param {number} cpIndex 码点下标
   * @returns {number} UTF-16 下标
   */
  function codePointIndexToUtf16(text, cpIndex) {
    if (cpIndex == null || cpIndex < 0) return null;
    var cp = 0, i = 0;
    while (i < text.length && cp < cpIndex) {
      var c = text.charCodeAt(i);
      i += (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) ? 2 : 1;
      cp++;
    }
    return cp >= cpIndex ? i : null;
  }

  /**
   * 主匹配函数。行为对齐参考实现的 matchRegex，但修掉了它的两处崩溃/漏匹配。
   * 正则非法时**抛异常**（跟原版一样），调用方自己决定怎么兜。
   * @param {string} regex
   * @param {string} text
   * @param {string} flags
   * @returns {Array<Object>}
   */
  function matchRegex(regex, text, flags) {
    var built = buildRegex(regex, flags);
    if (!built.ok) throw new Error(built.error);

    var re = built.re;
    var hasIndices = built.indices;
    var unicode = (flags || '').indexOf('u') !== -1;
    var global = (flags || '').indexOf('g') !== -1;
    var results = [];

    function push(m) {
      var raw = { index: m.index, value: m[0], end: m.index + m[0].length, captures: [], groups: [] };
      if (hasIndices && m.indices) {
        for (var i = 1; i < m.length; i++) {
          var g = m.indices[i];
          raw.captures.push({
            name: String(i),
            value: m[i] === undefined ? '' : m[i],
            start: g ? (unicode ? codePointIndexToUtf16(text, g[0]) : g[0]) : null,
            end: g ? (unicode ? codePointIndexToUtf16(text, g[1]) : g[1]) : null
          });
        }
        if (m.groups) {
          Object.keys(m.groups).forEach(function (name) {
            var ng = m.indices.groups && m.indices.groups[name];
            raw.groups.push({
              name: name,
              value: m.groups[name] === undefined ? '' : m.groups[name],
              start: ng ? (unicode ? codePointIndexToUtf16(text, ng[0]) : ng[0]) : null,
              end: ng ? (unicode ? codePointIndexToUtf16(text, ng[1]) : ng[1]) : null
            });
          });
        }
      } else {
        // 没有 d 标志：仍然列出捕获组，只是没有下标区间
        for (var j = 1; j < m.length; j++) {
          raw.captures.push({ name: String(j), value: m[j] === undefined ? '' : m[j], start: null, end: null });
        }
        if (m.groups) {
          Object.keys(m.groups).forEach(function (name) {
            raw.groups.push({ name: name, value: m.groups[name] === undefined ? '' : m.groups[name], start: null, end: null });
          });
        }
      }
      results.push(raw);
    }

    if (!global) {
      // 没有 g：exec 每次都从 0 开始，只会得到第一个匹配 —— 原版靠 lastIndex
      // 相等的 hack 收住循环，这里直接只跑一次，语义更清楚也不会死循环。
      var one = re.exec(text);
      if (one) push(one);
      return results;
    }

    var m = re.exec(text);
    while (m !== null) {
      push(m);
      if (m[0] === '') {
        // 空匹配：手动推进，否则 lastIndex 不动会永远卡在同一个位置。
        // 原版在这里 break，导致 /\d*/g 跑 "a1b" 时找不到后面的 "1"。
        re.lastIndex++;
        if (re.lastIndex > text.length) break;
      }
      m = re.exec(text);
    }
    return results;
  }

  /** 不抛版：非法正则返回 {ok:false,error}，页面上好显示提示 */
  function safeMatchRegex(regex, text, flags) {
    try {
      return { ok: true, matches: matchRegex(regex, text, flags) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), matches: [] };
    }
  }

  /**
   * 把测试串切成「命中 / 没命中」的片段序列，铺满整个串（供高亮用）。
   * @param {string} text
   * @param {Array<Object>} matches matchRegex 的结果
   * @returns {Array<{start:number,end:number,matched:boolean}>}
   */
  function highlightSegments(text, matches) {
    var segs = [];
    var cursor = 0;
    (matches || []).forEach(function (m) {
      var start = Math.max(0, m.index);
      var end = Math.min(text.length, m.end);
      if (end <= start) return;      // 空匹配不参与高亮（否则满屏都是标记）
      if (start < cursor) return;    // 重叠的丢掉，前一个已经吃掉了
      if (start > cursor) segs.push({ start: cursor, end: start, matched: false });
      segs.push({ start: start, end: end, matched: true });
      cursor = end;
    });
    if (cursor < text.length) segs.push({ start: cursor, end: text.length, matched: false });
    return segs;
  }

  /**
   * 改写成 RandExp 认识的写法。
   *  · 命名捕获组 `(?<name>X)` → `(?:X)`：RandExp 见到 `(?<` 直接抛异常；
   *  · 后向断言 `(?<=X)` / `(?<!X)` → `(?:X)`：同样不认，而且断言没法「生成」，
   *    这里直接丢掉 —— 生成的样本可能因此不满足断言，UI 上会如实提示。
   * 注意参考实现的 `/\(\?<[^>]*>/g` 处理不了后向断言：`(?<=a)` 里根本没有 `>`。
   * @param {string} src
   * @returns {string}
   */
  function rewriteForRandExp(src) {
    return String(src)
      .replace(/\(\?<[=!]([^)]*)\)/g, '(?:$1)')
      .replace(/\(\?<[^>]*>/g, '(?:');
  }

  /**
   * 按正则生成一条能匹配的样本串。
   * 失败（正则非法 / RandExp 没加载 / RandExp 生成不出来）一律返回空串，**不抛**。
   * RandExp 内部只用 `Math.random`，不碰 crypto / window，所以 jsdom 和浏览器里
   * 行为一致，测试时可以真的调它；但结果每次都不同，断言只能测形状。
   * 传 RegExp（而不是字符串）是有意的：RandExp 靠 regexp.ignoreCase 决定
   * 要不要随机大小写，只传字符串的话 i 标志就丢了。
   * @param {string} src
   * @param {string} [flags]
   * @returns {string}
   */
  function generateSample(src, flags) {
    var raw = String(src == null ? '' : src).trim();
    if (!raw) return '';
    if (typeof window.RandExp !== 'function') return '';
    // g / y 是有状态的（lastIndex），不能带进 RandExp
    var f = String(flags || '').replace(/[gy]/g, '');
    try {
      return new window.RandExp(new RegExp(rewriteForRandExp(raw), f)).gen();
    } catch (e) {
      return '';
    }
  }

  /**
   * 样本串是不是真的能被原正则匹配上。RandExp 有盲区（比如它把 `\p{...}` 当普通
   * 字符、丢掉了后向断言），页面上要如实告诉用户，而不是给一条对不上的串。
   * @returns {(boolean|null)} null = 正则本身非法，判断不了
   */
  function sampleMatches(src, sample, flags) {
    var raw = String(src == null ? '' : src);
    try {
      return new RegExp(raw, String(flags || '').replace(/[gy]/g, '')).test(String(sample));
    } catch (e) {
      return null;
    }
  }

  /** 校验一下 COMMON_PATTERNS 自身没写错（非法正则会在页面上打不开） */
  function isValidPattern(src, flags) { return buildRegex(src, flags || '').ok; }

  window.ItTools.register('regex-tester', function (root) {
    var regexInput = D.h('textarea.layui-textarea', {
      rows: 3, spellcheck: 'false', placeholder: t('ph_regex', 'Put the regex to test, e.g. (?<year>\\d{4})-\\d{2}-\\d{2}')
    });
    var textInput = D.h('textarea.layui-textarea', {
      rows: 6, spellcheck: 'false', placeholder: t('ph_text', 'Put the text to match')
    });

    var flagSelect = D.h('select.layui-input', null,
      D.h('option', { value: '', text: t('opt_no_flags', '(no flags)') }),
      FLAGS.map(function (f) { return D.h('option', { value: f, text: f, selected: f === 'g' }); }));
    flagSelect.value = 'g';
    var flagHint = D.h('p.field-hint', { text: FLAG_DESC.g });

    var errorBox = D.h('p.field-hint.is-error', { style: { display: 'none' } });
    var sampleBtn = D.h('button.layui-btn.layui-btn-sm', { type: 'button', text: t('generate_sample', 'Generate sample') });
    var sampleNote = D.h('p.field-hint', { style: { display: 'none' } });
    var highlightBox = D.h('div', {
      style: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '8px', border: '1px solid var(--border, #e6e6e6)', borderRadius: '4px', minHeight: '40px'
      }
    });
    var matchCount = D.h('span.badge-note', { text: t('match_count_zero', '0 match') });
    var tableBox = D.h('div');
    var svgHost = D.h('div', { style: { overflowX: 'auto' } });

    function renderMatches() {
      var raw = regexInput.value;
      var text = textInput.value;
      var res = safeMatchRegex(raw, text, flagSelect.value);

      if (!res.ok) {
        D.clear(highlightBox);
        highlightBox.appendChild(D.h('span.muted', { text: text || t('empty_test_text', '(the test string is empty)') }));
        matchCount.textContent = '—';
        D.clear(tableBox);
        if (raw === '') {
          errorBox.style.display = 'none';
          errorBox.textContent = '';
        } else {
          errorBox.style.display = '';
          errorBox.textContent = t('invalid_regex', 'Invalid regex: {error}').replace('{error}', res.error);
        }
        return;
      }
      errorBox.style.display = 'none';
      errorBox.textContent = '';

      D.clear(highlightBox);
      if (!text) {
        highlightBox.appendChild(D.h('span.muted', { text: t('empty_test_text', '(the test string is empty)') }));
      } else {
        var segs = highlightSegments(text, res.matches);
        if (!segs.length) {
          highlightBox.appendChild(document.createTextNode(text));
        }
        segs.forEach(function (s) {
          var chunk = text.slice(s.start, s.end);
          if (s.matched) {
            highlightBox.appendChild(D.h('mark', {
              text: chunk,
              style: { background: 'rgba(255, 205, 0, .45)', color: 'inherit', borderRadius: '2px' }
            }));
          } else {
            highlightBox.appendChild(document.createTextNode(chunk));
          }
        });
      }

      matchCount.textContent = res.matches.length === 1
        ? t('match_count_one', '{count} match').replace('{count}', res.matches.length)
        : t('match_count_many', '{count} matches').replace('{count}', res.matches.length);

      D.clear(tableBox);
      if (!res.matches.length) {
        tableBox.appendChild(D.h('p.muted', { text: t('no_match', 'No match') }));
        return;
      }
      var tbody = D.h('tbody');
      res.matches.forEach(function (m, i) {
        var capCells = m.captures.map(function (c) {
          var where = c.start === null ? '' : ' [' + c.start + ' - ' + c.end + ']';
          return D.h('div', { text: '"' + c.name + '" = ' + (c.value === '' ? t('capture_no_match', '(no match)') : c.value) + where });
        });
        var grpCells = m.groups.map(function (g) {
          var where = g.start === null ? '' : ' [' + g.start + ' - ' + g.end + ']';
          return D.h('div', { text: '"' + g.name + '" = ' + (g.value === '' ? t('capture_no_match', '(no match)') : g.value) + where });
        });
        tbody.appendChild(D.h('tr', null,
          D.h('td', { text: String(i) }),
          D.h('td', { text: String(m.index) }),
          D.h('td', null, D.h('code', { text: m.value })),
          D.h('td', null, capCells.length ? capCells : D.h('span.muted', { text: '—' })),
          D.h('td', null, grpCells.length ? grpCells : D.h('span.muted', { text: '—' }))
        ));
      });
      tableBox.appendChild(D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_index', '#') }), D.h('th', { text: t('col_text_index', 'Index in text') }),
          D.h('th', { text: t('col_value', 'Value') }), D.h('th', { text: t('col_captures', 'Captures') }),
          D.h('th', { text: t('col_groups', 'Groups') }))),
        tbody));
    }

    /* ---- SVG 示意图：@regexper/render 只有 render(src, targetEl)，没有 parse ---- */
    var svgTimer = null;
    function drawDiagram() {
      var src = regexInput.value;
      if (svgTimer) { clearTimeout(svgTimer); svgTimer = null; }
      if (!window.regexper || typeof window.regexper.render !== 'function') return;
      svgTimer = setTimeout(function () {
        svgTimer = null;
        D.clear(svgHost);
        if (!src) { svgHost.appendChild(D.h('p.muted', { text: t('diagram_empty', 'Enter a regex to see its diagram.') })); return; }
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgHost.appendChild(svg);
        try {
          var p = window.regexper.render(src, svg);
          // render 是异步的；非法正则会 reject（必须 catch，否则变成 unhandledrejection）
          if (p && typeof p.catch === 'function') {
            p.catch(function () { D.clear(svgHost).appendChild(D.h('p.muted', { text: t('diagram_failed', 'Cannot draw this regex.') })); });
          }
        } catch (e) {
          D.clear(svgHost).appendChild(D.h('p.muted', { text: t('diagram_failed', 'Cannot draw this regex.') }));
        }
      }, 250);
    }

    function render() { renderMatches(); drawDiagram(); }

    function note(msg) {
      sampleNote.textContent = msg || '';
      sampleNote.style.display = msg ? '' : 'none';
    }

    /* ---- 按当前正则生成一条样本串，填进测试串 ---- */
    function onGenerateSample() {
      var src = regexInput.value;
      var built = buildRegex(src, flagSelect.value);
      if (!src.trim()) { note(t('sample_need_regex', 'Enter a regex first.')); return; }
      if (!built.ok) { note(t('invalid_regex', 'Invalid regex: {error}').replace('{error}', built.error)); return; }

      var sample = generateSample(src, flagSelect.value);
      textInput.value = sample;
      render();

      // RandExp 不理解的东西会让样本对不上原正则，这种时候要说清楚，
      // 而不是默默给一条匹配不上的串。
      note(sampleMatches(src, sample, flagSelect.value) === false
        ? t('sample_mismatch', 'Sample inserted, but RandExp does not fully understand this regex, so it may not match.')
        : t('sample_inserted', 'Sample inserted into the text box.'));
    }

    var offs = [
      D.on(regexInput, 'input', render),
      D.on(textInput, 'input', renderMatches),
      D.on(flagSelect, 'change', function () {
        flagHint.textContent = FLAG_DESC[flagSelect.value] || t('no_flags_hint', 'no flags');
        render();
      }),
      D.on(sampleBtn, 'click', onGenerateSample)
    ];

    // 面板必须是整张卡片：.tool-content 是 flex 容器，
    // 直属子元素各自会成为一块面板，字段/按钮/提示这类碎片不能直接挂在 root 上。
    root.appendChild(D.h('div.card', null,
      U.field(t('label_regex', 'Regex to test'), regexInput, { wide: true }),
      U.field(t('label_flags', 'Flags'), flagSelect, { hint: FLAG_DESC.g }),
      D.h('div.form-actions', null, sampleBtn),
      sampleNote,
      errorBox,
      // 原版：正则 + 开关组 → 分隔线 → 待匹配文本
      U.divider(),
      U.field(t('label_text', 'Text to match'), textInput, { wide: true })
    ));

    var matchCard = D.h('div.card', null,
      D.h('div.output-head', null, D.h('span.output-label', { text: t('output_matches', 'Matches') }), matchCount),
      highlightBox,
      tableBox);
    root.appendChild(matchCard);

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null, D.h('span.output-label', { text: t('output_diagram', 'Regex Diagram') })),
      svgHost));

    /* ---- 常用片段速查表：所有分组收进同一张卡片 ---- */
    var cheatCard = D.h('div.card');
    var lastGroup = null;
    COMMON_PATTERNS.forEach(function (p) {
      if (p.group !== lastGroup) {
        lastGroup = p.group;
        cheatCard.appendChild(D.h('h3.section-head', { text: p.group, style: { marginTop: '16px' } }));
        var rows = [];
        COMMON_PATTERNS.filter(function (x) { return x.group === p.group; }).forEach(function (item) {
          var btn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', { type: 'button', text: item.expr, title: item.desc });
          btn.addEventListener('click', function () {
            regexInput.value = item.expr;
            render();
          });
          rows.push(D.h('tr', null, D.h('td', null, btn), D.h('td', { text: item.desc })));
        });
        cheatCard.appendChild(D.h('table.kv-table', null, D.h('tbody', null, rows)));
      }
    });
    root.appendChild(cheatCard);


    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        if (svgTimer) clearTimeout(svgTimer);
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['regex-tester'] = {
    FLAGS: FLAGS,
    COMMON_PATTERNS: COMMON_PATTERNS,
    buildRegex: buildRegex,
    codePointIndexToUtf16: codePointIndexToUtf16,
    matchRegex: matchRegex,
    safeMatchRegex: safeMatchRegex,
    highlightSegments: highlightSegments,
    rewriteForRandExp: rewriteForRandExp,
    generateSample: generateSample,
    sampleMatches: sampleMatches,
    isValidPattern: isValidPattern,
    __cases: function (assert) {
      /* ---- 基本匹配 ---- */
      assert.eq(matchRegex('a', 'banana', 'g').length, 3, 'g 找全部：banana 里有 3 个 a');
      assert.eq(matchRegex('a', 'banana', '').length, 1, '没有 g 只给第一个匹配');
      assert.eq(matchRegex('a', 'banana', '')[0].index, 1, '第一个 a 在下标 1');
      assert.eq(matchRegex('a', 'banana', 'g')[0].value, 'a', '匹配文本就是 a');
      assert.eq(matchRegex('A', 'banana', 'i')[0].index, 1, 'i 忽略大小写');
      assert.eq(matchRegex('A', 'banana', 'g').length, 0, '不加 i 匹配不到大写');
      assert.eq(matchRegex('^b', 'banana', 'g').length, 1, '^ 锚定串首');
      assert.eq(matchRegex('^.', 'a\nb', 'gm').length, 2, 'm 下 ^ 匹配每行行首');
      assert.eq(matchRegex('^a', 'a\nb', 'g').length, 1, '没有 m 时 ^ 只看整串开头');
      assert.eq(matchRegex('a.b', 'a\nb', 'gs').length, 1, 's 让 . 吃掉换行');
      assert.eq(matchRegex('a.b', 'a\nb', 'g').length, 0, '没有 s 时 . 不跨行');

      /* ---- 捕获组 / 命名组 ---- */
      var m1 = matchRegex('(\\d{4})-(\\d{2})', 'on 2024-06-01 ok', '')[0];
      assert.eq(m1.value, '2024-06', '整体匹配');
      assert.eq(m1.captures.length, 2, '两个捕获组');
      assert.eq(m1.captures[0].value, '2024', '第 1 组');
      assert.eq(m1.captures[0].start, 3, '第 1 组下标');
      assert.eq(m1.captures[1].end, 10, '第 2 组下标');
      assert.eq(m1.end, 10, '整体结束下标');

      var m2 = matchRegex('(?<y>\\d{4})-(?<m>\\d{2})', '2024-06', '')[0];
      assert.eq(m2.groups.length, 2, '两个命名组');
      assert.eq(m2.groups.map(function (g) { return g.name; }), ['y', 'm'], '命名组名字');
      assert.eq(m2.groups[0].value, '2024', '命名组的值');
      assert.eq(m2.groups[1].start, 5, '命名组的下标');

      /* ---- 原版在这两个 case 上会崩/漏匹配 ---- */
      var m3 = matchRegex('(a)|(b)', 'b', '')[0];
      assert.eq(m3.captures[0].value, '', '没参与的捕获组给空串而不是崩');
      assert.eq(m3.captures[0].start, null, '没参与的捕获组下标是 null');
      assert.eq(m3.captures[1].value, 'b', '参与的那组照常');
      assert.eq(matchRegex('(a)|(b)', 'b', '').length, 1, '原版这里 indices[1] 是 undefined 会抛 TypeError');

      var m4 = matchRegex('(?<x>a)|(?<y>b)', 'b', '')[0];
      assert.eq(m4.groups[0].value, '', '未命中的命名组给空串');
      assert.eq(m4.groups[0].start, null, '未命中的命名组下标 null');

      // 原版空匹配就 break，/\d*/g 跑 "a1b" 找不到后面的 1
      assert.eq(matchRegex('\\d*', 'a1b', 'g').length, 4, '空匹配继续推进：4 个位置都试过了');
      assert.eq(matchRegex('\\d*', 'a1b', 'g')[1].value, '1', '空匹配之后还能找到真正的数字');
      assert.eq(matchRegex('x*', '', 'g').length, 1, '空串上只匹配一次空串就收工，不死循环');
      assert.eq(matchRegex('\\d*', 'ab', 'g').length, 3, '两个字符的串 + 末尾一次空匹配');

      /* ---- 边界 ---- */
      assert.eq(matchRegex('', 'abc', 'g').length, 4, '空正则 + g 在每个位置各匹配一次空串（与 matchAll 一致）');
      assert.eq(matchRegex('', 'abc', '').length, 1, '空正则不加 g 匹配一次空串');
      assert.eq(matchRegex('a', '', 'g').length, 0, '空串上匹配不到东西');
      assert.eq(matchRegex('^', 'abc', 'g').length, 1, '^ 在非空串上只匹配位置 0');
      assert.eq(matchRegex('a', 'aaa', 'gy').length, 3, 'sticky + global 正常工作');
      assert.eq(matchRegex('b', 'ab', 'y').length, 0, 'sticky 不加 g 只在位置 0 试，匹配不到 b');

      /* ---- 非法正则 ---- */
      var safe = safeMatchRegex('a(', 'abc', 'g');
      assert(!safe.ok, '非法正则要能识别出来');
      assert(typeof safe.error === 'string' && safe.error.length > 0, '非法正则要给出可读信息');
      assert.eq(safe.matches, [], '非法正则不给匹配结果');
      assert(safeMatchRegex('[z-a]', 'x', 'g').ok === false, '非法字符类也认得出来');
      assert(safeMatchRegex('a', 'x', 'k').ok === false, '非法 flags 也认得出来');
      assert.eq(safeMatchRegex('a+', 'aaa', 'g').matches.length, 1, '合法正则 ok=true，贪婪 a+ 只匹配一次');
      var threw = false;
      try { matchRegex('a(', 'x', 'g'); } catch (e) { threw = true; }
      assert(threw, 'matchRegex 本身仍然对非法正则抛错（跟原版一致）');

      /* ---- d 标志探测 ---- */
      var built = buildRegex('a', 'g');
      assert(built.ok && built.re instanceof RegExp, 'buildRegex 成功时给出 RegExp');
      assert(built.indices === true, '当前引擎支持 d 标志，所以能拿到 indices');
      assert(!buildRegex('a(', 'g').ok, '非法模式 buildRegex 返回 ok:false');

      /* ---- 码点下标换算 ---- */
      assert.eq(codePointIndexToUtf16('abc', 2), 2, '纯 BMP 文本原样返回');
      assert.eq(codePointIndexToUtf16('\u{1F600}ab', 1), 2, '代理对算 2 个 UTF-16 单元');
      assert.eq(codePointIndexToUtf16('\u{1F600}ab', 3), 4, '走完两个码点 = 4 个 UTF-16 单元');
      assert.eq(codePointIndexToUtf16('abc', null), null, 'null 透传');
      assert.eq(codePointIndexToUtf16('abc', 99), null, '越过末尾给 null');

      /* ---- 高亮切片 ---- */
      var segs = highlightSegments('banana', matchRegex('a', 'banana', 'g'));
      assert.eq(segs.map(function (s) { return [s.start, s.end, s.matched]; }),
        [[0, 1, false], [1, 2, true], [2, 3, false], [3, 4, true], [4, 5, false], [5, 6, true]], '切出命中/未命中的连续片段');
      assert.eq(highlightSegments('abc', []), [{ start: 0, end: 3, matched: false }], '没有匹配时整串都是未命中');
      assert.eq(highlightSegments('', []), [], '空串没有片段');
      assert.eq(highlightSegments('ab', matchRegex('\\d*', 'ab', 'g')), [{ start: 0, end: 2, matched: false }], '空匹配不高亮');
      var overlap = highlightSegments('abab', [{ index: 0, end: 2 }, { index: 1, end: 3 }]);
      assert.eq(overlap.length, 2, '重叠的匹配只留前一个，后面的丢弃');
      assert.eq(overlap[1], { start: 2, end: 4, matched: false }, '重叠部分之后的文本仍是未命中');

      /* ---- 速查表自身合法 ---- */
      var bad = COMMON_PATTERNS.filter(function (p) { return !isValidPattern(p.expr, 'u'); });
      assert.eq(bad.map(function (p) { return p.expr; }), [], '内置的每个片段都是合法正则');
      assert(COMMON_PATTERNS.length > 20, '速查表内容足够多');
      assert.eq(FLAGS.join(''), 'gimsuy', '下拉里的 flags 就是 g/i/m/s/u/y');

      /* ---- 实测：v 与内部补的 d 可以共存，所以 buildRegex 不用为它特殊处理 ---- */
      var bv = buildRegex('a', 'v');
      assert(bv.ok === true, 'v 标志本身编译得过');
      assert(bv.re.flags.indexOf('v') !== -1, '用户的 v 标志保留');
      assert(bv.re.flags.indexOf('d') !== -1, '内部补的 d 标志也在');
      assert.eq(bv.indices, true, 'v + d 依然拿得到 indices');
      assert(buildRegex('a', 'q').ok === false, '真的非法 flags 仍然报错');

      /* ---- 样本串生成（RandExp） ----
         断言只测形状和可解析性：生成出来的是随机串，具体值每次都不一样。 */
      assert.eq(rewriteForRandExp('(?<year>\\d{4})'), '(?:\\d{4})', '命名捕获组改写成非捕获组');
      assert.eq(rewriteForRandExp('(?<y>a)(?<m>b)'), '(?:a)(?:b)', '多个命名组都改写');
      assert.eq(rewriteForRandExp('(?<=ab)c'), '(?:ab)c', '后向断言也改写（参考实现会漏，RandExp 直接抛）');
      assert.eq(rewriteForRandExp('(?<!a)b'), '(?:a)b', '否定后向断言同样改写');
      assert.eq(rewriteForRandExp('(?:a)'), '(?:a)', '本来就有的非捕获组不动');
      assert.eq(rewriteForRandExp('(a)(b)'), '(a)(b)', '普通捕获组不动');
      assert.eq(rewriteForRandExp(''), '', '空串进去空串出来');

      var s1 = generateSample('[a-c]{2,4}');
      assert(typeof s1 === 'string' && /^[a-c]{2,4}$/.test(s1), '样本落在字符集和次数范围内：' + JSON.stringify(s1));
      var s2 = generateSample('(?<year>\\d{4})-(?<m>\\d{2})');
      assert(typeof s2 === 'string' && /^\d{4}-\d{2}$/.test(s2), '带命名捕获组的正则也能出样本：' + JSON.stringify(s2));
      assert(sampleMatches('(?<year>\\d{4})-(?<m>\\d{2})', s2) === true, '样本真的能匹配原正则（改写只发生在喂给 RandExp 的那一份）');

      var ci = generateSample('(?<w>abc)', 'i');
      assert(typeof ci === 'string' && /^[a-z]{3}$/i.test(ci), 'i 标志下样本大小写随机：' + JSON.stringify(ci));
      assert(sampleMatches('(?<w>abc)', ci, 'i') === true, 'i 标志下样本依然匹配');

      assert(generateSample('(?<=a)b').length > 0, '后向断言的正则也能出样本（断言已被丢掉）');

      assert.eq(generateSample('a(', ''), '', '非法正则返回空串，不抛');
      assert.eq(generateSample('[a-', ''), '', '非法的字符集也返回空串');
      assert.eq(generateSample('', ''), '', '空正则返回空串');
      assert.eq(generateSample('   ', ''), '', '纯空白当成空');
      assert.eq(generateSample(null), '', 'null 不崩');
      assert.eq(generateSample(undefined), '', 'undefined 不崩');

      assert.eq(sampleMatches('a+', 'aaa', ''), true, 'sampleMatches：能匹配');
      assert.eq(sampleMatches('a+', 'b', ''), false, 'sampleMatches：匹配不上');
      assert.eq(sampleMatches('abc', 'ABC', 'i'), true, 'sampleMatches：i 标志生效');
      assert.eq(sampleMatches('abc', 'ABC', ''), false, 'sampleMatches：没给 i 就是不匹配');
      assert.eq(sampleMatches('a(', 'x', ''), null, 'sampleMatches：正则非法返回 null');
      assert.eq(sampleMatches('', '', ''), true, 'sampleMatches：空正则匹配一切');
      // g/y 会带 lastIndex 状态，必须先剥掉，否则同一个串连问两次结果会翻转
      assert.eq(sampleMatches('a', 'a', 'g'), true, 'sampleMatches：g 标志不产生状态');
      assert.eq(sampleMatches('a', 'a', 'g'), true, 'sampleMatches：连续两次结果一致（没有 lastIndex 残留）');
      var rep = generateSample('a+', 'g');
      assert(/^a+$/.test(rep) && sampleMatches('a+', rep, '') === true, 'g 标志被剥掉，样本仍是纯 a 且匹配：' + JSON.stringify(rep));
      assert(sampleMatches('a+', generateSample('a+', 'gy'), '') === true, 'y 标志也不影响样本');
    }
  };
})();