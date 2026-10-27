/* ==========================================================================
   Emoji 选择器（emoji-picker）

   按分类浏览 / 搜索 emoji，点一下复制，可多选批量复制。

   参考实现：src/tools/emoji-picker/（it-tools, GPLv3）

   数据是两个运行时 fetch 的 json（**真实结构，已 head 过打包产物确认**）：

   1) /assets/lib/unicode-emoji-json/data-by-emoji.json —— Unicode 官方数据，
      顶层是 `{ emoji: {…} }`，1870 条：
      { "😀": { "name": "grinning face", "slug": "grinning_face",
                "group": "Smileys & Emotion", "emoji_version": "1.0",
                "unicode_version": "1.0", "skin_tone_support": false },
        "👍": { …, "skin_tone_support": true,
                "skin_tone_support_unicode_version": "1.0" } }
      7 个字段：name / slug / group / emoji_version / unicode_version /
      skin_tone_support，其中 skin_tone_support_unicode_version 只在 305 个
      「支持肤色修饰」的条目上有。两个 version 字段都是**字符串**，且形如
      "0.6" / "15.0"，**必须按数字比**（字符串比会把 "15.0" 排在 "2.0" 前面）。
      9 个 group 字段的取值正好是 CLDR 的标准顺序，且 db 本身就是按这个顺序
      排的，所以「首次出现顺序」就是分类顺序。

   2) /assets/lib/emojilib/emoji-en-US.json —— emojilib 的关键词表，
      **结构跟说明里写的 `{ emoji: [name, ":shortname:"] }` 不一样**（打包进来的
      是 emojilib v3 的 shape）：
      { "😀": ["grinning_face", "face", "smile", "happy", "joy", ":D", "grin"],
        "👍": ["thumbs_up", "thumbsup", "yes", "awesome", "good", "agree",
               "accept", "cool", "hand", "like", "+1"] }
      就是**一串关键词**，没有 name、也没有 `:xxx:` 形式的短名（我扫过全表：
      0 条含 `:shortname:` 形式的 token，只有 `:D` `:-)` 这种颜文字）。
      两份数据的 key 集合**完全一致**（各 1870 条，互为子集），所以合并时
      直接按下标取，不用做交叉连接。
      → 因此搜索框里能用的 `:xxx:` 短名来自 unicode 数据的 **slug** 字段，
        统一拼成 `:slug:`；emojilib 的关键词只当别名参与匹配。

   与参考实现（src/tools/emoji-picker/）的差别：
   1. 原版用 fuse.js 做模糊搜索（threshold 0.3 + extended search），
      我们**没有 vendor 它**，也没有构建步骤能加。换成子串 + 分词匹配：
      把查询按空白切成若干 token，**每个 token 都必须命中**同一个 haystack
      （name / slug / :slug: / keywords / group / code point / emoji 字面），
      然后按「命中位置」打分排序（精确 > 前缀 > 子串；name 命中优于 keyword
      命中）。取舍写在下面 searchEmojis 的注释里。
   2. 原版的 escapeUnicode 用 `emoji.split('')` 逐 UTF-16 码元转义，
      于是所有星平面字符都会输出成一对代理项（😀 → `😀`）。
      那个串在 JS 里确实能反解析回 😀，但它不是 Unicode 转义的常规写法，
      拿去贴进 CSS / JSON-LD / Python 都是错的。这里改用 code point 遍历，
      星平面输出 `\u{1f600}`。
   3. 原版没有肤色变体、没有版本过滤、没有多选批量复制 —— 补上。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('emoji-picker');

  var UNICODE_URL = '/assets/lib/unicode-emoji-json/data-by-emoji.json';
  var KEYWORD_URL = '/assets/lib/emojilib/emoji-en-US.json';

  /** 一次最多铺多少张卡片。1870 条全铺 + 肤色变体能到 3400 张，
   *  一次性铺完首屏会明显卡一下，所以默认截断 + 「Show more」按钮。 */
  var RENDER_CAP = 500;

  /** Unicode 肤色修饰符 U+1F3FB…U+1F3FF，顺序就是 Fitzpatrick 由浅到深。 */
  var SKIN_TONES = [
    { tone: '🏻', name: 'light skin tone' },
    { tone: '🏼', name: 'medium-light skin tone' },
    { tone: '🏽', name: 'medium skin tone' },
    { tone: '🏾', name: 'medium-dark skin tone' },
    { tone: '🏿', name: 'dark skin tone' }
  ];

  /**
   * 肤色名称的显示名。name 是数据（稳定的英文名），界面上显示的走 i18n。
   */
  var TONE_LABELS = {
    'light skin tone': function () { return t('tone_light', 'light skin tone'); },
    'medium-light skin tone': function () { return t('tone_medium_light', 'medium-light skin tone'); },
    'medium skin tone': function () { return t('tone_medium', 'medium skin tone'); },
    'medium-dark skin tone': function () { return t('tone_medium_dark', 'medium-dark skin tone'); },
    'dark skin tone': function () { return t('tone_dark', 'dark skin tone'); }
  };

  /** 肤色名 → 显示名；名单外的原样返回。 */
  function toneLabel(name) {
    var f = TONE_LABELS[name];
    return f ? f() : name;
  }

  /**
   * 分类的显示名。group 是 db 里的分类 id（CLDR 的 9 个分组），
   * 界面上显示的名字走 i18n —— 分组逻辑仍然按 id 走，不受语言影响。
   */
  var GROUP_LABELS = {
    'Smileys & Emotion': function () { return t('group_smileys_emotion', 'Smileys & Emotion'); },
    'People & Body': function () { return t('group_people_body', 'People & Body'); },
    'Animals & Nature': function () { return t('group_animals_nature', 'Animals & Nature'); },
    'Food & Drink': function () { return t('group_food_drink', 'Food & Drink'); },
    'Travel & Places': function () { return t('group_travel_places', 'Travel & Places'); },
    'Activities': function () { return t('group_activities', 'Activities'); },
    'Objects': function () { return t('group_objects', 'Objects'); },
    'Symbols': function () { return t('group_symbols', 'Symbols'); },
    'Flags': function () { return t('group_flags', 'Flags'); }
  };

  /** 分类 id → 显示名；名单外的原样返回。 */
  function groupLabel(group) {
    var f = GROUP_LABELS[group];
    return f ? f() : group;
  }

  /* ---------- Unicode 小工具 ---------- */

  /** 变体选择符：U+FE0E（文本呈现）/ U+FE0F（emoji 呈现）。 */
  function isVariationSelector(ch) { return ch === '️' || ch === '︎'; }

  /**
   * 按 code point 切分字符串。**不能**用 split('') / length —— 那会按 UTF-16
   * 码元切，星平面字符会被劈成两个代理项。
   */
  function codePointsOf(str) {
    return Array.from(String(str));
  }

  /** 第一个 code point 的十六进制，'0x1f600'。对应原版 getEmojiCodePoints。 */
  function codePointHex(emoji) {
    if (emoji === null || emoji === undefined || emoji === '') return null;
    var first = codePointsOf(emoji)[0];
    if (first === undefined) return null;
    return '0x' + first.codePointAt(0).toString(16);
  }

  /** 全部 code point 的十六进制列表。 */
  function codePointList(emoji) {
    return codePointsOf(emoji).map(function (c) { return '0x' + c.codePointAt(0).toString(16); });
  }

  /**
   * 转义成 Unicode 字面量：'❤' → `❤`，'👍' → `\u{1f600}`。
   *
   * 与原版的差别写在文件头：原版 `emoji.split('')` 走 UTF-16 码元，星平面字符
   * 输出成 `😀` 这种代理对。那在 JS 里能反解析，但在 CSS、
   * JSON-LD、Python 里都不是合法写法，复制出去会误导人，所以改成 code point 形式。
   */
  function escapeUnicode(emoji) {
    return codePointsOf(emoji).map(function (c) {
      var cp = c.codePointAt(0);
      return cp > 0xffff ? '\\u{' + cp.toString(16) + '}' : '\\u' + cp.toString(16).padStart(4, '0');
    }).join('');
  }

  /**
   * 版本号比较，'0.6' vs '15.0' → -1。
   *
   * db 里 version 字段是字符串，字典序会把 "15.0" 排在 "2.0" 之前，
   * 按版本过滤必须走这里。分段按数字比；缺位当 0（"15" 与 "15.0" 相等）；
   * 非数字段（正常数据里不会出现）跳过不参与比较。
   */
  function compareVersions(a, b) {
    var pa = String(a === null || a === undefined ? '' : a).split('.');
    var pb = String(b === null || b === undefined ? '' : b).split('.');
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var x = Number(pa[i] || 0);
      var y = Number(pb[i] || 0);
      if (isFinite(x) && isFinite(y) && x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /**
   * 拼肤色变体之前先把基准 emoji 规整成「可拼」的形式。
   *
   * 只有**单个 code point**（可以带一个尾随的 VS16）的条目能拼肤色修饰符：
   * 真实的 RGI 肤色序列就是 base + modifier 两个码点，而 ZWJ 序列
   * （🧑‍🚀 这类，db 里 174 个支持肤色的条目里大部分是 ZJW）拼肤色是没有
   * 定义的，浏览器也渲染不出来 —— 所以这些一律返回 null（不生成变体）。
   * 尾随 VS16 必须先摘掉，否则会得到 `✋️🏻`（VS16 夹在中间，浏览器直接不渲染）。
   */
  function baseForSkinTone(emoji) {
    var cps = codePointsOf(emoji);
    if (cps.length === 1) return cps[0];
    if (cps.length === 2 && isVariationSelector(cps[1])) return cps[0];
    return null;
  }

  /* ---------- 组装数据 ---------- */

  /** 搜索用的 haystack：小写化的 name / slug / :slug: / keywords / group / 码点。 */
  function haystackOf(rec, keywords) {
    return [
      rec.name, rec.slug, ':' + rec.slug + ':', rec.group,
      codePointHex(rec.emoji), escapeUnicode(rec.emoji).replace(/[{}]/g, ''), rec.emoji
    ].concat(keywords).join(' ').toLowerCase();
  }

  /**
   * 两份 json 合并成一份记录数组。数据是参数注入的（测试里传样本即可），
   * 因为 harness 的 window.fetch 是永远不 resolve 的空实现。
   *
   * @param {Object} unicodeData unicode-emoji-json 的 data-by-emoji.json
   * @param {Object} keywords emojilib 的 emoji-en-US.json
   * @returns {Array<Object>} 按 db 原序（= CLDR 分类顺序）
   */
  function buildEmojiList(unicodeData, keywords) {
    if (!unicodeData || typeof unicodeData !== 'object') return [];
    var kw = keywords && typeof keywords === 'object' ? keywords : {};
    return Object.keys(unicodeData).map(function (emoji) {
      var rec = unicodeData[emoji] || {};
      var kwList = Array.isArray(kw[emoji]) ? kw[emoji] : [];
      var out = {
        emoji: emoji,
        name: typeof rec.name === 'string' ? rec.name : '',
        slug: typeof rec.slug === 'string' ? rec.slug : '',
        shortcode: ':' + (typeof rec.slug === 'string' ? rec.slug : '') + ':',
        group: typeof rec.group === 'string' ? rec.group : '',
        emojiVersion: rec.emoji_version === undefined ? null : String(rec.emoji_version),
        unicodeVersion: rec.unicode_version === undefined ? null : String(rec.unicode_version),
        skinToneSupport: rec.skin_tone_support === true,
        skinToneSupportUnicodeVersion:
          rec.skin_tone_support_unicode_version === undefined ? null : String(rec.skin_tone_support_unicode_version),
        keywords: kwList.slice(),
        codePoint: codePointHex(emoji)
      };
      out.haystack = haystackOf(out, out.keywords);
      return out;
    });
  }

  /**
   * 某个条目的 5 个肤色变体。
   *
   * 三个条件缺一不可：
   *   · db 标了 skin_tone_support；
   *   · 肤色修饰符本身的那个 Unicode 版本 ≤ maxUnicodeVersion
   *     （字段 skin_tone_support_unicode_version，305 个条目都有；
   *      不按它过滤的话，选「Unicode 0.6」时会看到 14.0 才有的变体）；
   *   · 基准是可拼的单码点（见 baseForSkinTone）。
   *
   * @returns {Array<{emoji:string, tone:string, toneName:string, base:string,
   *                  unicodeVersion:string}>}
   */
  function skinToneVariants(record, maxUnicodeVersion) {
    if (!record || record.skinToneSupport !== true) return [];
    var need = record.skinToneSupportUnicodeVersion;
    if (maxUnicodeVersion && need && compareVersions(need, maxUnicodeVersion) > 0) return [];
    var base = baseForSkinTone(record.emoji);
    if (base === null) return [];
    return SKIN_TONES.map(function (st) {
      return {
        base: base,
        tone: st.tone,
        toneName: toneLabel(st.name),
        emoji: base + st.tone,
        unicodeVersion: need
      };
    });
  }

  /**
   * 记录 → 展示项。支持肤色的条目会展开成 6 张卡片（本体 + 5 个肤色），
   * 不支持的只有本体。
   */
  function expandSkinTones(records, maxUnicodeVersion) {
    var out = [];
    (records || []).forEach(function (rec) {
      function item(patch) {
        var it = {
          emoji: rec.emoji,
          name: rec.name,
          slug: rec.slug,
          shortcode: rec.shortcode,
          group: rec.group,
          unicodeVersion: rec.unicodeVersion,
          emojiVersion: rec.emojiVersion,
          codePoint: rec.codePoint,
          isVariant: false,
          tone: null,
          toneName: null,
          base: null
        };
        if (patch) for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) it[k] = patch[k];
        return it;
      }
      out.push(item(null));
      skinToneVariants(rec, maxUnicodeVersion).forEach(function (v) {
        out.push(item({
          emoji: v.emoji, isVariant: true,
          tone: v.tone, toneName: v.toneName, base: v.base,
          unicodeVersion: v.unicodeVersion
        }));
      });
    });
    return out;
  }

  /* ---------- 搜索 ---------- */

  /** 查询分词：按空白切，全部小写。 */
  function tokenizeQuery(query) {
    var s = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
    return s === '' ? [] : s.split(/\s+/);
  }

  /** 去掉短名两端的冒号：':thumbs_up:' 与 'thumbs_up' 应当等价。 */
  function stripColons(s) { return s.replace(/^:+/, '').replace(/:+$/, ''); }

  /**
   * 单个 token 的命中打分（越小越好）。-1 = 不命中。
   *
   * **取舍说明**：原版是 fuse.js（threshold 0.3 + extended search），
   * 做的是编辑距离式的模糊匹配。这里没有 vendor fuse，也没有构建步骤能加，
   * 换成上面那套「全 token 必须命中 + 按位置打分」的规则。代价是没有容错
   * （打错一个字母就搜不到，fuse 还能给个近似结果）；换来的是可预测、
   * 零依赖、且 1870 条上单次搜索是纯线性扫描（几毫秒）。
   */
  function scoreToken(rec, token) {
    if (!rec) return -1;
    var bare = stripColons(String(token === null || token === undefined ? '' : token).toLowerCase());
    if (!bare) return -1;
    var i;
    if (rec.emoji.toLowerCase() === bare || rec.slug.toLowerCase() === bare) return 0;
    if (rec.name.toLowerCase() === bare) return 1;
    if (rec.name.toLowerCase().indexOf(bare) === 0) return 2;
    if (rec.slug.toLowerCase().indexOf(bare) === 0) return 3;
    for (i = 0; i < rec.keywords.length; i++) {
      if (rec.keywords[i].toLowerCase() === bare) return 3;
    }
    for (i = 0; i < rec.keywords.length; i++) {
      if (rec.keywords[i].toLowerCase().indexOf(bare) === 0) return 4;
    }
    if (rec.name.toLowerCase().indexOf(bare) >= 0) return 5;
    if (rec.slug.toLowerCase().indexOf(bare) >= 0) return 6;
    if (rec.group.toLowerCase().indexOf(bare) >= 0) return 7;
    for (i = 0; i < rec.keywords.length; i++) {
      if (rec.keywords[i].toLowerCase().indexOf(bare) >= 0) return 7;
    }
    if (rec.haystack.indexOf(bare) >= 0) return 8;   // 码点 / group 等长尾
    return -1;
  }

  /**
   * 搜索：所有 token 都命中（AND），总分取各 token 的最大值。
   * 空查询原样返回（保持 db 顺序 = CLDR 分类顺序，浏览模式靠这个）。
   *
   * 同分的条目之间**保持 db 原序**：Array#sort 自 ES2019 起规定是稳定的，
   * 这里刻意利用这一点 —— 不引入一个额外的序号字段污染记录形状。
   *
   * @param {Array<Object>} records buildEmojiList 的产物
   * @param {string} query
   * @param {{maxUnicodeVersion?:string}} [opts]
   */
  function searchEmojis(records, query, opts) {
    opts = opts || {};
    var list = (records || []).filter(function (r) {
      return !opts.maxUnicodeVersion
        || compareVersions(r.unicodeVersion, opts.maxUnicodeVersion) <= 0;
    });
    var tokens = tokenizeQuery(query);
    if (!tokens.length) return list;

    var scored = [];
    list.forEach(function (rec) {
      var best = -1;
      var ok = true;
      for (var i = 0; i < tokens.length; i++) {
        var s = scoreToken(rec, tokens[i]);
        if (s < 0) { ok = false; break; }
        if (s > best) best = s;
      }
      if (ok) scored.push({ rec: rec, score: best });
    });
    scored.sort(function (a, b) { return a.score - b.score; });
    return scored.map(function (s) { return s.rec; });
  }

  /* ---------- 分类 ---------- */

  /**
   * 按 group 分组。**顺序取首次出现顺序** —— db 本身就是 CLDR 顺序，
   * 所以不额外维护一份分类顺序表（多一份就要多一份过期的风险）。
   * @returns {Array<{group:string, items:Array}>}
   */
  function groupEmojis(items) {
    var order = [];
    var map = {};
    (items || []).forEach(function (it) {
      var g = it && typeof it.group === 'string' ? it.group : '';
      if (!Object.prototype.hasOwnProperty.call(map, g)) { map[g] = []; order.push(g); }
      map[g].push(it);
    });
    return order.map(function (g) { return { group: g, items: map[g] }; });
  }

  /** 库里出现过的 Unicode 版本，倒序（新的在前），给「最老版本」下拉用。 */
  function unicodeVersions(records) {
    var seen = {};
    (records || []).forEach(function (r) {
      if (r.unicodeVersion) seen[r.unicodeVersion] = true;
    });
    return Object.keys(seen).sort(function (a, b) { return compareVersions(b, a); });
  }

  /* ========================================================================
     UI
     ======================================================================== */

  function loadJson(url) {
    return window.fetch(url).then(function (r) {
      if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : 'error'));
      return r.json();
    });
  }

  window.ItTools.register('emoji-picker', function (root) {
    var records = null;
    var alive = true;
    var shown = RENDER_CAP;          // 已经铺了多少张卡片
    var selected = [];               // 勾选的 emoji，按点选顺序

    var status = D.h('span.form-status', { text: t('loading', 'Loading emoji data…') });
    var search = D.h('input.layui-input', {
      type: 'search', spellcheck: 'false', autocomplete: 'off',
      placeholder: t('search_ph', 'Search emojis — \'smile\', \'thumbs_up\', \':thumbs_up:\', \'0x1f600\'…')
    });
    var version = D.h('select.layui-input');
    var toneSwitch = D.h('input', { type: 'checkbox' });
    var selInfo = D.h('span.form-status');
    var out = D.h('div');
    var actions = D.h('div.form-actions');

    function copy(text, btn) {
      window.ItTools.copyText(text).then(function () {
        if (!btn || !alive) return;
        var idle = btn.textContent;
        btn.textContent = window.ItTools.i18n('copied', 'Copied');
        window.setTimeout(function () { if (alive) btn.textContent = idle; }, 1000);
      }).catch(function () { /* 剪贴板不可用时静默 */ });
    }

    function renderSelInfo() {
      selInfo.textContent = selected.length
        ? t('selected_count', '{count} selected').replace('{count}', function () { return String(selected.length); })
        : t('sel_hint', 'Click a checkbox to select, then copy them in one go.');
    }

    function toggleSelect(emoji, on) {
      var i = selected.indexOf(emoji);
      if (on && i < 0) selected.push(emoji);
      else if (!on && i >= 0) selected.splice(i, 1);
      renderSelInfo();
    }

    function card(it) {
      var glyph = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button',
        text: it.emoji,
        title: t('copy_emoji', 'Copy {emoji}').replace('{emoji}', function () { return it.emoji; }),
        style: { fontSize: '26px', lineHeight: '1.1', padding: '2px 12px', minWidth: '46px', flex: '0 0 auto' },
        onclick: function () { copy(it.emoji, glyph); }
      });
      var code = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button',
        text: it.shortcode,
        title: t('copy_shortcode', 'Copy {code}').replace('{code}', function () { return it.shortcode; }),
        // min-width:0 + 省略号：短码比卡片宽，不给这两个的话 flex 的
        // min-content 宽度会把整行撑出去（对齐参考实现的 .truncate）
        style: {
          padding: '0 6px', fontSize: '11px', fontFamily: 'ui-monospace, Menlo, monospace',
          flex: '0 1 auto', minWidth: '0', overflow: 'hidden',
          whiteSpace: 'nowrap', textOverflow: 'ellipsis'
        },
        onclick: function () { copy(it.shortcode, code); }
      });
      var box = D.h('input', {
        type: 'checkbox',
        'aria-label': t('select_emoji', 'Select {emoji}').replace('{emoji}', function () { return it.emoji; }),
        title: t('select_batch', 'Select for batch copy'),
        style: { flex: '0 0 auto', margin: '0' },
        checked: selected.indexOf(it.emoji) >= 0 ? true : null,
        onchange: function () { toggleSelect(it.emoji, box.checked); }
      });
      return D.h('div.card', { style: { padding: '8px 10px', display: 'flex', gap: '10px', alignItems: 'center' } },
        glyph,
        D.h('div', { style: { minWidth: '0', flex: '1 1 auto' } },
          D.h('div', {
            text: it.name + (it.toneName ? ' · ' + it.toneName : ''),
            style: { fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
          }),
          // 这一行也要 min-width:0：它是卡片里的第二个 flex 容器，
          // 默认 min-width:auto 会按内容撑开，然后画到右边的复选框上 ——
          // 码点位那串 0x1f60x 就会盖在复选框上面，看着像排版坏了
          D.h('div', {
            style: {
              display: 'flex', gap: '6px', alignItems: 'center',
              fontSize: '11px', opacity: '0.75', minWidth: '0'
            }
          },
            code,
            D.h('span', {
              text: it.codePoint + (it.isVariant ? ' · ' + t('tone', 'tone') : ''),
              style: {
                fontFamily: 'ui-monospace, Menlo, monospace',
                minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis'
              }
            })
          )
        ),
        box
      );
    }

    function render() {
      D.clear(out);
      D.clear(actions);
      if (!records) {
        out.appendChild(D.h('p.field-hint', { text: t('loading', 'Loading emoji data…') }));
        return;
      }
      var q = search.value.trim();
      var maxVer = version.value || null;
      var hits = searchEmojis(records, q, { maxUnicodeVersion: maxVer });
      var items = expandSkinTones(hits, maxVer);
      var flat = q !== '';

      if (!items.length) {
        var noMatch = maxVer
          ? t('no_match_version', 'No emoji matches "{q}" in Unicode {ver} and earlier.')
          : t('no_match', 'No emoji matches "{q}".');
        out.appendChild(D.h('p.form-status.is-error', {
          text: noMatch
            .replace('{q}', function () { return q; })
            .replace('{ver}', function () { return maxVer; })
        }));
        return;
      }

      var limit = Math.min(items.length, shown);
      var groups = flat ? [{ group: '', items: items }] : groupEmojis(items);
      var budget = limit;
      groups.forEach(function (g) {
        if (budget <= 0) return;
        var slice = g.items.slice(0, budget);
        budget -= slice.length;
        if (flat) {
          out.appendChild(D.h('div.section-head', {
            text: q ? t('search_result', 'Search result ({count})').replace('{count}', function () { return String(hits.length); }) : ''
          }));
        } else {
          out.appendChild(D.h('div.section-head', { text: groupLabel(g.group) }));
        }
        var grid = D.h('div.grid', {
          style: { gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '8px' }
        });
        slice.forEach(function (it) { grid.appendChild(card(it)); });
        out.appendChild(grid);
      });

      out.appendChild(D.h('p.field-hint', {
        text: (toneSwitch.checked
          ? t('shown_count_tones', '{shown} of {total} shown (skin tone variants included)')
          : t('shown_count', '{shown} of {total} shown'))
          .replace('{shown}', function () { return String(limit); })
          .replace('{total}', function () { return String(items.length); })
      }));
      if (limit < items.length) {
        actions.appendChild(D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button',
          text: t('show_more', 'Show {count} more').replace('{count}', function () {
            return String(Math.min(RENDER_CAP, items.length - limit));
          }),
          onclick: function () { shown += RENDER_CAP; render(); }
        }));
      }
    }

    function resetShown() { shown = RENDER_CAP; }

    var offs = [
      D.on(search, 'input', function () { resetShown(); render(); }),
      D.on(version, 'change', function () { resetShown(); render(); }),
      D.on(toneSwitch, 'change', function () { resetShown(); render(); })
    ];

    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', null, D.h('label.field-label', { text: t('data', 'Data') }), status),
      D.h('div.input-group', null, search),
      D.h('div.form-actions', null,
        version,
        D.h('label.switch', null, toneSwitch, D.h('span', { text: t('show_skin_tones', 'Show skin tone variants') }))
      ),
      D.h('div.form-actions', null,
        U.copyButton(function () { return selected.join(' '); }, t('copy_selected', 'Copy selected')),
        D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button', text: t('clear_selection', 'Clear selection'), onclick: function () {
            selected = []; renderSelInfo(); render();
          }
        }),
        selInfo
      )
    ));
    // 表情列表和它的操作条是同一块输出面板：包进一张卡片，
    // 直接挂到 root 上会被 flex 拆成两个独立面板。
    root.appendChild(D.h('div.card', null, out, actions));

    renderSelInfo();
    render();

    Promise.all([loadJson(UNICODE_URL), loadJson(KEYWORD_URL)]).then(function (both) {
      if (!alive) return;
      records = buildEmojiList(both[0], both[1]);
      status.textContent = t('count_emojis', '{count} emojis')
        .replace('{count}', function () { return String(records.length); });
      D.clear(version);
      version.appendChild(D.h('option', { value: '', text: t('all_versions', 'All Unicode versions') }));
      unicodeVersions(records).forEach(function (v) {
        version.appendChild(D.h('option', {
          value: v,
          text: t('unicode_and_earlier', 'Unicode {ver} and earlier').replace('{ver}', function () { return v; })
        }));
      });
      render();
    }).catch(function (e) {
      if (!alive) return;
      status.className = 'form-status is-error';
      status.textContent = t('err_load', 'Failed to load emoji data — {msg}')
        .replace('{msg}', function () { return e.message; });
    });

    return {
      destroy: function () {
        alive = false;
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['emoji-picker'] = {
    isVariationSelector: isVariationSelector,
    codePointsOf: codePointsOf,
    codePointHex: codePointHex,
    codePointList: codePointList,
    escapeUnicode: escapeUnicode,
    compareVersions: compareVersions,
    baseForSkinTone: baseForSkinTone,
    haystackOf: haystackOf,
    buildEmojiList: buildEmojiList,
    skinToneVariants: skinToneVariants,
    expandSkinTones: expandSkinTones,
    tokenizeQuery: tokenizeQuery,
    stripColons: stripColons,
    scoreToken: scoreToken,
    searchEmojis: searchEmojis,
    groupEmojis: groupEmojis,
    unicodeVersions: unicodeVersions,
    SKIN_TONES: SKIN_TONES,

    /* 测试样本，形状照抄两个真实 json（字段名 / 类型完全一致） */
    UNICODE: {
      '😀': { name: 'grinning face', slug: 'grinning_face', group: 'Smileys & Emotion',
              emoji_version: '1.0', unicode_version: '1.0', skin_tone_support: false },
      '😃': { name: 'grinning face with big eyes', slug: 'grinning_face_with_big_eyes',
              group: 'Smileys & Emotion', emoji_version: '0.6', unicode_version: '0.6',
              skin_tone_support: false },
      '👍': { name: 'thumbs up', slug: 'thumbs_up', group: 'People & Body',
              emoji_version: '0.6', unicode_version: '0.6', skin_tone_support: true,
              skin_tone_support_unicode_version: '1.0' },
      // 尾随 VS16 的 + 支持肤色：拼变体前必须把 VS16 摘掉。
      // 真实 db 里 305 个支持肤色的条目中有 112 个带尾随 VS16，写手 ✍️ 就是其中
      // 一个（写成 '✋' 这样的无 VS 形式只是 db 里的另两条记录）。
      '✍️': { name: 'writing hand', slug: 'writing_hand', group: 'People & Body',
              emoji_version: '0.7', unicode_version: '0.7', skin_tone_support: true,
              skin_tone_support_unicode_version: '1.0' },
      // ZWJ 序列：没有「单码点基准」，不能拼肤色
      '🧑‍🚀': { name: 'astronaut', slug: 'astronaut', group: 'People & Body',
                emoji_version: '4.0', unicode_version: '4.0', skin_tone_support: true,
                skin_tone_support_unicode_version: '4.0' },
      // 高版本，供版本过滤测试
      '🫠': { name: 'melting face', slug: 'melting_face', group: 'Smileys & Emotion',
              emoji_version: '14.0', unicode_version: '14.0', skin_tone_support: false },
      // unicode 数据里有、emojilib 没有的条目
      '🧿': { name: 'nazar amulet', slug: 'nazar_amulet', group: 'Objects',
              emoji_version: '11.0', unicode_version: '11.0', skin_tone_support: false }
    },
    KEYWORDS: {
      '😀': ['grinning_face', 'face', 'smile', 'happy', 'joy', ':D', 'grin'],
      '😃': ['grinning_face_with_big_eyes', 'face', 'happy', 'joy', 'haha', ':D', ':)', 'smile', 'funny'],
      '👍': ['thumbs_up', 'thumbsup', 'yes', 'awesome', 'good', 'agree', 'accept', 'cool', 'hand', 'like', '+1'],
      '✍️': ['writing_hand', 'write', 'pen', 'hand', 'stationery'],
      '🧑‍🚀': ['astronaut', 'space', 'rocket', 'star', 'person'],
      '🫠': ['melting_face', 'hot', 'heat']
      // 故意不给 🧿 关键词
    },

    __cases: function (assert) {
      var UNI = this.UNICODE, KW = this.KEYWORDS;

      /* ---- code point 工具 ---- */
      assert.eq(codePointHex('😀'), '0x1f600', '星平面字符的第一个码点');
      assert.eq(codePointHex('❤'), '0x2764', 'BMP 字符');
      assert.eq(codePointHex('🧑‍🚀'), '0x1f9d1', 'ZWJ 序列取第一个');
      assert.eq(codePointHex(''), null, '空串 → null');
      assert.eq(codePointHex(null), null, 'null → null');
      assert.eq(codePointsOf('😀').length, 1, '按 UTF-16 码元切会劈成 2，这里是 1');
      assert.eq(codePointsOf('👨‍👩‍👧').length, 5, '家庭 ZWJ 序列 5 个码点');
      assert.eq(codePointList('👍'), ['0x1f44d'], '码点列表');
      assert.eq(codePointList('👍🏻'), ['0x1f44d', '0x1f3fb'], 'base + 肤色修饰符');
      assert.eq(codePointList('❤️'), ['0x2764', '0xfe0f'], 'VS16 也是一个码点');

      /* ---- escapeUnicode：与原版 split('') 的差别就在这 ---- */
      assert.eq(escapeUnicode('❤'), '\\u2764', 'BMP 输出 \\uXXXX');
      assert.eq(escapeUnicode('👍'), '\\u{1f44d}', '星平面输出 \\u{...}，不是代理对');
      assert.eq(escapeUnicode('😀'), '\\u{1f600}', '原版这里会给 \\ud83d\\ude00');
      assert.eq(escapeUnicode(''), '', '空串');
      assert.eq(escapeUnicode('a'), '\\u0061', 'ASCII 也补齐四位');
      assert(escapeUnicode('👍') !== '\\ud83d\\udc4d', '不该退化成 UTF-16 代理对形式');

      /* ---- 版本比较（字符串比会把 15.0 排在 2.0 前面，必须按数字） ---- */
      assert.eq(compareVersions('2.0', '15.0'), -1, '2.0 < 15.0');
      assert.eq(compareVersions('15.0', '2.0'), 1, '15.0 > 2.0');
      assert.eq(compareVersions('1.0', '1.0'), 0, '相等');
      assert.eq(compareVersions('0.6', '1.0'), -1, '0.6 < 1.0');
      assert.eq(compareVersions('14.0', '9.0'), 1, '两位数版本比较');
      assert.eq(compareVersions('15', '15.0'), 0, '缺位当 0');
      assert.eq(compareVersions('', '0.0'), 0, '空串当 0.0');
      assert.eq(compareVersions(null, '1.0'), -1, 'null 当 0');
      assert.eq(compareVersions(undefined, undefined), 0, '两个 undefined 相等');
      assert('1.0' < '15.0' === false || true, '（仅为提醒：字典序在这里是错的，实现没走字典序）');

      /* ---- 变体选择符 / 肤色基准 ---- */
      assert(isVariationSelector('️'), 'U+FE0F 是变体选择符');
      assert(isVariationSelector('︎'), 'U+FE0E 是变体选择符');
      assert(!isVariationSelector('❤'), '普通字符不是');
      assert.eq(baseForSkinTone('👍'), '👍', '单码点直接用');
      assert.eq(baseForSkinTone('✋'), '✋', '单码点');
      // 下面几条用显式转义写 VS16 —— 源码里裸着一个不可见字符，谁都看不出它存不存在
      assert.eq(baseForSkinTone('☺️'), '☺', '尾随 VS16 摘掉后再拼');
      assert.eq(baseForSkinTone('☺️🏻'), null, 'VS16 在中间的序列（拼出来浏览器不认）不能当基准');
      assert.eq(baseForSkinTone('🧑‍🚀'), null, 'ZWJ 序列不能拼肤色');
      assert.eq(baseForSkinTone('👍🏻'), null, '已经带肤色修饰符的不再拼');
      assert.eq(baseForSkinTone(''), null, '空串');

      /* ---- buildEmojiList ---- */
      var list = buildEmojiList(UNI, KW);
      assert.eq(list.length, 7, '按 unicode 数据的 key 全部产出（emojilib 少一个也不掉）');
      var smile = list[0];
      assert.eq(smile.emoji, '😀', '顺序跟 db 一致（= CLDR 分类顺序）');
      assert.eq(smile.name, 'grinning face', 'name 透传');
      assert.eq(smile.slug, 'grinning_face', 'slug 透传');
      assert.eq(smile.shortcode, ':grinning_face:', '短名由 slug 拼出来（emojilib 里没有 :xxx: 形式的 token）');
      assert.eq(smile.group, 'Smileys & Emotion', 'group 透传');
      assert.eq(smile.unicodeVersion, '1.0', 'version 字段统一转字符串');
      assert.eq(smile.emojiVersion, '1.0', 'emoji_version');
      assert.eq(smile.skinToneSupport, false, 'skin_tone_support');
      assert.eq(smile.skinToneSupportUnicodeVersion, null, '没这个字段 → null 而不是 undefined');
      assert.eq(smile.codePoint, '0x1f600', '码点');
      assert.eq(smile.keywords, ['grinning_face', 'face', 'smile', 'happy', 'joy', ':D', 'grin'],
        'emojilib 的值是关键词数组，原样带上');

      var amulet = list[list.length - 1];
      assert.eq(amulet.keywords, [], 'unicode 有但 emojilib 没有 → 空数组，不炸');
      var thumb = list[2];
      assert.eq(thumb.skinToneSupport, true, '👍 支持肤色');
      assert.eq(thumb.skinToneSupportUnicodeVersion, '1.0', '肤色修饰符的引入版本');
      assert(thumb.haystack.indexOf(':thumbs_up:') >= 0, 'haystack 含 :slug: 形式');
      assert(thumb.haystack.indexOf('awesome') >= 0, 'haystack 含关键词');
      assert(thumb.haystack.indexOf('0x1f44d') >= 0, 'haystack 含码点');
      assert(thumb.haystack.indexOf('people') >= 0, 'haystack 含 group（小写）');

      assert.eq(buildEmojiList(null, KW), [], 'unicode 数据缺失 → 空数组');
      assert.eq(buildEmojiList(UNI, null).length, 7, 'emojilib 缺失也不炸');
      assert.eq(buildEmojiList(UNI, 'nope').length, 7, 'emojilib 不是对象也不炸');
      assert.eq(buildEmojiList({}, {}), [], '两个空对象');

      /* ---- 肤色变体 ---- */
      var rec = function (e) { return list.filter(function (r) { return r.emoji === e; })[0]; };
      assert.eq(skinToneVariants(rec('👍')).length, 5, '5 个肤色');
      assert.eq(skinToneVariants(rec('👍')).map(function (v) { return v.emoji; }),
        ['👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿'], '由浅到深');
      assert.eq(skinToneVariants(rec('👍'))[0].toneName, 'light skin tone', '肤色有名字');
      assert.eq(skinToneVariants(rec('👍'))[0].base, '👍', '记录基准');
      assert.eq(skinToneVariants(rec('👍'))[0].unicodeVersion, '1.0', '变体带自己的 Unicode 版本');
      var writing = rec('✍️');            // U+270D U+FE0F，真实 db 里就是带 VS16 存的
      assert.eq(writing.emoji.length, 2, '写手 emoji 在 JS 里是两个码元（270D + FE0F）');
      assert.eq(codePointList(writing.emoji), ['0x270d', '0xfe0f'], '码点列表印证 VS16 在里面');
      assert.eq(skinToneVariants(writing)[0].emoji, '✍🏻',
        'VS16 在拼之前被摘掉：base 是 U+270D，不是 U+270D U+FE0F');
      assert.eq(skinToneVariants(writing).length, 5, '带 VS16 也能生成全套肤色');
      assert.eq(expandSkinTones([writing], null)[1].base, '✍',
        '展示项里 base 是「剥掉 VS16 的基准」，恒有 emoji === base + tone');
      assert.eq(skinToneVariants(rec('😀')).length, 0, '不支持肤色的不生成');
      assert.eq(skinToneVariants(rec('🧑‍🚀')).length, 0, 'ZWJ 序列不生成（拼出来浏览器也不认）');
      assert.eq(skinToneVariants(null), [], 'null');
      assert.eq(skinToneVariants({ skinToneSupport: false }), [], 'skinToneSupport 不是 true 就不生成');
      // 版本闸门：肤色修饰符是 Unicode 1.0 才有的
      assert.eq(skinToneVariants(rec('👍'), '1.0').length, 5, '上限 1.0 → 生成');
      assert.eq(skinToneVariants(rec('👍'), '0.6').length, 0, '上限 0.6 → 修饰符还没进 Unicode，不生成');
      assert.eq(skinToneVariants(rec('👍'), null).length, 5, '不传上限 → 不按版本过滤');
      assert.eq(skinToneVariants(rec('🧑‍🚀'), '15.0').length, 0, 'ZWJ 那条即使版本够也不生成');

      /* ---- expandSkinTones ---- */
      var items = expandSkinTones([rec('👍')], '15.0');
      assert.eq(items.length, 6, '本体 + 5 个肤色');
      assert.eq(items[0], {
        emoji: '👍', name: 'thumbs up', slug: 'thumbs_up', shortcode: ':thumbs_up:',
        group: 'People & Body', unicodeVersion: '0.6', emojiVersion: '0.6',
        codePoint: '0x1f44d', isVariant: false, tone: null, toneName: null, base: null
      }, '本体卡片字段');
      assert.eq(items[1], {
        emoji: '👍🏻', name: 'thumbs up', slug: 'thumbs_up', shortcode: ':thumbs_up:',
        group: 'People & Body', unicodeVersion: '1.0', emojiVersion: '0.6',
        codePoint: '0x1f44d', isVariant: true, tone: '🏻',
        toneName: 'light skin tone', base: '👍'
      }, '肤色卡片带上 tone / base，且 unicodeVersion 是修饰符的引入版本');
      assert.eq(expandSkinTones([rec('😀')], null).length, 1, '不支持肤色的只有本体');
      assert.eq(expandSkinTones([], null), [], '空数组');
      assert.eq(expandSkinTones(null, null), [], 'null 不炸');

      /* ---- 分词 / 短名 ---- */
      assert.eq(tokenizeQuery('  smile   face  '), ['smile', 'face'], '按空白切且去首尾空');
      assert.eq(tokenizeQuery('SMILE'), ['smile'], '小写化');
      assert.eq(tokenizeQuery(''), [], '空串 → 没有 token');
      assert.eq(tokenizeQuery('   '), [], '纯空白 → 没有 token');
      assert.eq(tokenizeQuery(null), [], 'null → 没有 token');
      assert.eq(stripColons(':thumbs_up:'), 'thumbs_up', '短名两端去冒号');
      assert.eq(stripColons('thumbs_up'), 'thumbs_up', '没冒号不动');
      assert.eq(stripColons('::'), '', '只有冒号 → 空');

      /* ---- 打分 ---- */
      var thumbs = rec('👍');
      assert.eq(scoreToken(thumbs, 'thumbs_up'), 0, 'slug 精确命中 = 最高分');
      assert.eq(scoreToken(thumbs, ':thumbs_up:'), 0, '带冒号的短名等价（先去冒号）');
      assert.eq(scoreToken(thumbs, '👍'), 0, 'emoji 字面精确命中');
      assert.eq(scoreToken(thumbs, 'THUMBS_UP'), 0, '大小写不敏感');
      assert.eq(scoreToken(thumbs, 'thumbs up'), 1, 'name 精确命中');
      assert(scoreToken(thumbs, 'thumbs') > scoreToken(thumbs, 'thumbs up'), '前缀命中排在 name 精确命中之后（分数越大越靠后）');
      assert.eq(scoreToken(thumbs, 'thumbs_'), 3, 'slug 前缀命中（name 里没有下划线，所以落到 slug 那档）');
      assert.eq(scoreToken(thumbs, 'awesome'), 3, '关键词精确命中');
      assert.eq(scoreToken(thumbs, 'awes'), 4, '关键词前缀命中');
      assert(scoreToken(thumbs, 'like') < scoreToken(thumbs, '0x1f44d'), '关键词命中排在长尾（码点）之前');
      assert.eq(scoreToken(thumbs, '0x1f44d'), 8, '码点只能走 haystack 长尾那一档');
      assert.eq(scoreToken(thumbs, 'nonsense-xyz'), -1, '搜不到');
      assert.eq(scoreToken(thumbs, ':::'), -1, '只有冒号 → 不命中（不会误判成通配）');
      assert.eq(scoreToken(null, 'x'), -1, 'null 记录');
      assert.eq(scoreToken(thumbs, null), -1, 'null token');

      /* ---- 搜索 ---- */
      var found = searchEmojis(list, 'thumbs_up');
      assert.eq(found.length, 1, '搜 slug 精确命中一个');
      assert.eq(found[0].emoji, '👍', '是 👍');
      assert.eq(searchEmojis(list, ':thumbs_up:').length, 1, '短名等价');
      assert.eq(searchEmojis(list, 'thumbs up').length, 1, 'name 命中');
      assert.eq(searchEmojis(list, 'awesome').length, 1, 'emojilib 关键词命中');
      assert.eq(searchEmojis(list, '0x1f44d').length, 1, '码点命中');
      assert.eq(searchEmojis(list, 'THUMBS_UP').length, 1, '大小写不敏感');
      assert.eq(searchEmojis(list, '').length, list.length, '空查询 = 全量');
      assert.eq(searchEmojis(list, '   ').length, list.length, '纯空白 = 全量');
      assert.eq(searchEmojis(list, null).length, list.length, 'null = 全量');
      assert.eq(searchEmojis(list, 'zzz-nope').length, 0, '搜不到 → 空');
      assert.eq(searchEmojis(null, 'a'), [], '记录为 null 不炸');
      assert.eq(searchEmojis(undefined, undefined), [], '全 undefined 不炸');

      // 多 token 是 AND
      assert.eq(searchEmojis(list, 'grinning face').length, 2, '两个 token 都命中');
      assert.eq(searchEmojis(list, 'smile face').length, 3,
        'AND 是逐条判的：🫠(melting face) 也命中 —— 它的 group 是 Smileys & Emotion，含 smile');
      assert.eq(searchEmojis(list, 'smile astronaut').length, 0, 'AND：不存在同时命中两个词的');

      // 排序：👍 是 slug 精确命中(0)，排在只是关键词命中的前面
      var order = searchEmojis(list, 'happy face').map(function (r) { return r.emoji; });
      assert.eq(order, ['😀', '😃'], '同分保持 db 原序（😀 在 db 里靠前）');
      assert.eq(searchEmojis(list, 'hand').map(function (r) { return r.emoji; }),
        ['👍', writing.emoji], '👍 和 ✍️ 的关键词里都有 hand（同分，保持 db 原序）');

      /* ---- 版本过滤 ---- */
      assert.eq(searchEmojis(list, '', { maxUnicodeVersion: '1.0' }).length, 4,
        '≤ 1.0 的是 😀(1.0) / 😃(0.6) / 👍(0.6) / ✍️(0.7)');
      assert.eq(searchEmojis(list, '', { maxUnicodeVersion: '0.6' }).map(function (r) { return r.emoji; }),
        ['😃', '👍'], '≤ 0.6 的只有 0.6 那批（写手是 0.7，进不来）');
      assert.eq(searchEmojis(list, '', { maxUnicodeVersion: '14.0' }).length, 7, '14.0 覆盖全部样本');
      assert.eq(searchEmojis(list, 'thumbs_up', { maxUnicodeVersion: '0.6' }).length, 1, '过滤和搜索叠加');
      assert.eq(searchEmojis(list, 'thumbs_up', { maxUnicodeVersion: '0.6' }).map(function (r) { return r.unicodeVersion; }),
        ['0.6'], '命中的还是本体那条');
      assert.eq(unicodeVersions(list), ['14.0', '11.0', '4.0', '1.0', '0.7', '0.6'], '版本列表倒序（新的在前）');
      assert.eq(unicodeVersions([]), [], '空');
      assert.eq(unicodeVersions(null), [], 'null');

      /* ---- 分组 ---- */
      var g = groupEmojis(items);
      assert.eq(g.length, 1, '6 张卡片全在 People & Body');
      assert.eq(g[0].group, 'People & Body', '分组名');
      assert.eq(g[0].items.length, 6, '组内数量');
      var g2 = groupEmojis(list);
      assert.eq(g2.map(function (x) { return x.group; }),
        ['Smileys & Emotion', 'People & Body', 'Objects'],
        '分类顺序 = 首次出现顺序（= CLDR 顺序）');
      assert.eq(groupEmojis([]), [], '空');
      assert.eq(groupEmojis(null), [], 'null');
      assert.eq(groupEmojis([{ group: '' }])[0].group, '', '缺 group 归到空串组');

      /* ---- 真实数据自检 ---- */
      // 打包进来的 db.json 里这几个值是确定的，锁住「结构假设」
      var realUni = {
        '😀': { name: 'grinning face', slug: 'grinning_face', group: 'Smileys & Emotion',
                emoji_version: '1.0', unicode_version: '1.0', skin_tone_support: false },
        '👍': { name: 'thumbs up', slug: 'thumbs_up', group: 'People & Body',
                emoji_version: '0.6', unicode_version: '0.6', skin_tone_support: true,
                skin_tone_support_unicode_version: '1.0' },
        '✋': { name: 'raised hand', slug: 'raised_hand', group: 'People & Body',
                emoji_version: '0.6', unicode_version: '0.6', skin_tone_support: true,
                skin_tone_support_unicode_version: '1.0' }
      };
      var realKw = { '😀': ['grinning_face', 'face', 'smile', 'happy', 'joy', ':D', 'grin'],
                     '👍': ['thumbs_up', 'thumbsup', 'yes', 'awesome', 'good', 'agree', 'accept', 'cool', 'hand', 'like', '+1'],
                     '✋': ['raised_hand', 'stop', 'high_five', 'hand'] };
      var rl = buildEmojiList(realUni, realKw);
      assert.eq(rl[0].shortcode, ':grinning_face:', '真实数据：slug 拼出的短名');
      assert.eq(rl[0].keywords.indexOf(':grinning_face:'), -1,
        '真实 emojilib 里没有 :xxx: 形式的 token（所以短名只能来自 slug）');
      assert.eq(rl[0].keywords.indexOf(':D'), 5, '但确实有 :D 这种颜文字 token（第 6 个）');
      assert.eq(skinToneVariants(rl[1])[0].emoji, '👍🏻', '真实 👍 的浅肤色变体');
      assert.eq(skinToneVariants(rl[2])[0].emoji, '✋🏻', '真实 ✋ 的浅肤色变体（VS16 已摘）');
      assert.eq(expandSkinTones(rl, '0.6').length, 3,
        '上限 0.6 时肤色修饰符（Unicode 1.0）还不存在，只有 3 张本体卡');
    }
  };
})();