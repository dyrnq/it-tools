/* ==========================================================================
   MIME 类型查询（mime-types）

   三块：mime 类型 → 扩展名、扩展名 → mime 类型、按关键字浏览全部条目。

   数据是 mime-db 的 db.json，运行时 fetch('/assets/lib/mime-db/db.json')。
   **真实结构**（已 head 过打包产物确认，不是猜的）：
     {
       "text/html": { "source": "iana", "compressible": true,
                      "extensions": ["html", "htm", "shtml"] },
       "text/css":  { "source": "iana", "charset": "UTF-8",
                      "compressible": true, "extensions": ["css"] },
       "image/png": { "source": "iana", "compressible": false,
                      "extensions": ["png"] }
     }
     共 2279 条、1180 个不同扩展名。三个必须留意的点：
     1. 顶层是 `{ mimeType: {...} }`，**不是** 「mimeType → [扩展名]」；
     2. `extensions` 可能整个字段缺失（1314 条没有），所以不能无脑读；
     3. `compressible` 也可能缺失（1537 条没有），它是**三态**
        （true / false / 没写），拿它当布尔用会漏掉一半条目。
     另有两个可选字段：`charset`（只有 39 条有，全是 UTF-8 / US-ASCII 之类）
     和 `source`（iana 1948 / apache 250 / nginx 13 / 没写 68）。

   参考实现：src/tools/mime-types/（it-tools, GPLv3）

   与参考实现的差别：
   1. 原版 `import { types, extensions } from 'mime-types'` —— 那个 npm 包我们
      **没有 vendor**。它本身只是 mime-db 的一份薄封装（内部同样是遍历这份
      db.json 建表），没有额外的数据源，所以按 db 的结构自己实现等价功能即可：
      `lookupMime` ≈ `mime.getType()`，`mimeTypeOfPath` ≈ `mime.lookup()`，
      `preferredTypeFor` ≈ `mime.extension()`。数据完全一致。
   2. 反查扩展名时一个扩展名可能对应多个 mime 类型（1180 个里有 38 个）。
      mime 包的 populateMaps 只留**一个**，规则是「后来的 type 若 source 是
      iana 而原来的不是就覆盖」，边角很含糊。这里改成一条写明的确定性排序：
      iana 优先 > 没写 source > apache/nginx 等厂商条目，同级按类型名字典序。
      38 条里 24 条是跨 source 的，其余全是 source 相同的平局 —— 字典序
      恰好让 xml→application/xml（而不是 text/xml）、mp3→audio/mpeg 落在前面，
      与 mime 包的常用结果一致，但规则本身是可复述的。
   3. 原版只有两个下拉框，没有搜索、没有分页、没有加载态。这里补上。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('mime-types');

  var DB_URL = '/assets/lib/mime-db/db.json';
  var DEFAULT_PAGE_SIZE = 50;
  var MAX_PAGE_SIZE = 500;

  /* ---------- 归一化 ---------- */

  /** 数字兜底 + 取整 + 夹范围。opts 里的 undefined/NaN 一律退回 fallback。 */
  function clampInt(v, fallback, lo, hi) {
    var n = Math.floor(Number(v));
    if (!isFinite(n)) n = fallback;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
  }

  /**
   * mime 类型归一化：去参数（text/html; charset=utf-8 → text/html）、
   * 去首尾空白、转小写。MIME 类型本身大小写不敏感，统一小写才好查表。
   */
  function normalizeType(type) {
    if (type === null || type === undefined) return '';
    var s = String(type).trim();
    var semi = s.indexOf(';');
    if (semi >= 0) s = s.slice(0, semi);
    return s.trim().toLowerCase();
  }

  /** 扩展名归一化：' .HTML ' → 'html'，前导的点全部去掉。 */
  function normalizeExtension(ext) {
    if (ext === null || ext === undefined) return '';
    var s = String(ext).trim().toLowerCase();
    while (s.charAt(0) === '.') s = s.slice(1);
    return s.trim();
  }

  /**
   * 从路径/文件名里取出扩展名部分：去掉 query 与 fragment，再取最后一段。
   * 反斜杠也当分隔符（Windows 路径）。没有点就返回空串。
   */
  function basename(p) {
    if (p === null || p === undefined) return '';
    var s = String(p).trim().split(/[?#]/)[0];
    var cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (cut >= 0) s = s.slice(cut + 1);
    return s;
  }

  /** source 的排序权重：IANA 注册的条目最可信，厂商自填的最不可信。 */
  function sourceRank(rec) {
    if (!rec || typeof rec.source !== 'string' || rec.source === '') return 1;
    return rec.source === 'iana' ? 0 : 2;
  }

  /** 同层按类型名字典序，保证同一份 db 每次都排出同一个结果。 */
  function byTypeThenName(a, b) {
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  /* ---------- 查询 ---------- */

  /**
   * 按 mime 类型查条目。找不到（或参数不是对象 / 空串）返回 null。
   *
   * 返回的是**扁平的展示对象**而不是 db 里的原始记录：compressible / charset
   * 被规范成「三态的 null 而不是 undefined」，这样 UI 和断言都不用再区分
   * 「字段缺失」和「值为空」这两种在 JSON 里长得一样的情况。
   *
   * @param {Object} db mime-db 的 db.json
   * @param {string} type 例如 'text/html'
   * @returns {{type:string, source:string|null, charset:string|null,
   *            compressible:boolean|null, extensions:string[]}|null}
   */
  function lookupMime(db, type) {
    if (!db || typeof db !== 'object') return null;
    var key = normalizeType(type);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(db, key)) return null;
    var rec = db[key];
    if (!rec || typeof rec !== 'object') return null;
    return {
      type: key,
      source: typeof rec.source === 'string' ? rec.source : null,
      charset: typeof rec.charset === 'string' ? rec.charset : null,
      compressible: rec.compressible === true ? true : (rec.compressible === false ? false : null),
      extensions: Array.isArray(rec.extensions) ? rec.extensions.slice() : []
    };
  }

  /**
   * 反查：某个扩展名被哪些 mime 类型占用（已按 sourceRank + 字典序排好）。
   * db 里没有这个扩展名就返回空数组。
   */
  function typesForExtension(db, ext) {
    var e = normalizeExtension(ext);
    if (!db || typeof db !== 'object' || !e) return [];
    var out = [];
    Object.keys(db).forEach(function (type) {
      var rec = db[type];
      if (!rec || !Array.isArray(rec.extensions)) return;
      if (rec.extensions.indexOf(e) >= 0) out.push(type);
    });
    out.sort(function (a, b) {
      var ra = sourceRank(db[a]), rb = sourceRank(db[b]);
      return ra !== rb ? ra - rb : byTypeThenName(a, b);
    });
    return out;
  }

  /** 扩展名 → 首选 mime 类型（等价于 mime 包的 mime.extension 反向用法）。 */
  function preferredTypeFor(db, ext) {
    var hits = typesForExtension(db, ext);
    return hits.length ? hits[0] : null;
  }

  /**
   * 完整路径/文件名 → mime 类型（等价 mime.lookup()）。
   * 'a/b/index.HTML?v=2' → 'text/html'。
   */
  function mimeTypeOfPath(db, path) {
    var base = basename(path);
    if (!base || base.charAt(0) === '.') return null;   // '.gitignore' 这种没有扩展名
    var dot = base.lastIndexOf('.');
    if (dot < 0) return null;
    return preferredTypeFor(db, base.slice(dot + 1));
  }

  /**
   * 建「扩展名 → 类型列表」索引。**键**按扩展名字典序、**值**按 sourceRank +
   * 字典序，两边都排好，直接拿来渲染下拉/结果都不必再排。
   *
   * 注意 Object.keys 的插入序不是字典序（'bmp' 看着在 'html' 后面只是因为
   * db 的键恰好这么排），所以最后整体重建一遍把键也排掉。
   */
  function buildExtensionIndex(db) {
    var acc = {};
    if (db && typeof db === 'object') {
      Object.keys(db).forEach(function (type) {
        var rec = db[type];
        if (!rec || !Array.isArray(rec.extensions)) return;
        rec.extensions.forEach(function (raw) {
          var key = normalizeExtension(raw);
          if (!key) return;
          if (!acc[key]) acc[key] = [];
          if (acc[key].indexOf(type) < 0) acc[key].push(type);
        });
      });
    }
    var index = {};
    Object.keys(acc).sort(byTypeThenName).forEach(function (e) {
      index[e] = acc[e].sort(function (a, b) {
        var ra = sourceRank(db[a]), rb = sourceRank(db[b]);
        return ra !== rb ? ra - rb : byTypeThenName(a, b);
      });
    });
    return index;
  }

  /* ---------- 过滤 / 分页 / 统计 ---------- */

  /** compressible 的三态 → 过滤档位：'yes' / 'no' / 'unknown'。 */
  function compressibleOf(rec) {
    if (rec && rec.compressible === true) return 'yes';
    if (rec && rec.compressible === false) return 'no';
    return 'unknown';
  }

  /** 关键字命中：类型串本身，或它声明的任一扩展名（允许带点写 '.html'）。 */
  function matchesQuery(type, rec, q) {
    if (type.indexOf(q) >= 0) return true;
    var bare = q.charAt(0) === '.' ? q.slice(1) : q;
    if (!rec || !Array.isArray(rec.extensions)) return false;
    for (var i = 0; i < rec.extensions.length; i++) {
      if (rec.extensions[i].indexOf(bare) >= 0) return true;
    }
    return false;
  }

  /**
   * 搜索 + compressible 过滤 + 分页。
   *
   * compressible 是三态，所以档位是四个字符串而不是布尔：
   *   'any'（默认，全部）/ 'yes' / 'no' / 'unknown'（db 里没写这个字段的）。
   * 传布尔 true/false 也认，按 yes/no 处理。
   *
   * page 越界会夹回最后一页；空结果时 totalPages 报 1（而不是 0），
   * 这样 UI 不用专门处理「除以零」。
   *
   * @returns {{query:string, compressible:string, page:number, pageSize:number,
   *            total:number, totalPages:number, items:string[]}}
   */
  function filterMimeTypes(db, opts) {
    opts = opts || {};
    var query = (opts.query === null || opts.query === undefined ? '' : String(opts.query)).trim().toLowerCase();
    var mode = opts.compressible;
    if (mode === true) mode = 'yes';
    else if (mode === false) mode = 'no';
    else if (mode !== 'yes' && mode !== 'no' && mode !== 'unknown') mode = 'any';

    var pageSize = clampInt(opts.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    var page = clampInt(opts.page, 1, 1, 9007199254740991);

    var all = [];
    var keys = db && typeof db === 'object' ? Object.keys(db) : [];
    for (var i = 0; i < keys.length; i++) {
      var type = keys[i];
      var rec = db[type];
      if (mode !== 'any' && compressibleOf(rec) !== mode) continue;
      if (query && !matchesQuery(type, rec, query)) continue;
      all.push(type);
    }
    all.sort(byTypeThenName);

    var total = all.length;
    var totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (page > totalPages) page = totalPages;
    var from = (page - 1) * pageSize;
    return {
      query: query,
      compressible: mode,
      page: page,
      pageSize: pageSize,
      total: total,
      totalPages: totalPages,
      items: all.slice(from, from + pageSize)
    };
  }

  /**
   * 整库统计。byTopLevel 按 `type` 的第一段（'text' / 'image' / …）分组；
   * 没有斜杠的少数条目归到 '(none)'，免得 key 变成空串。
   */
  function mimeTypeStats(db) {
    var s = {
      total: 0, withExtensions: 0,
      compressible: 0, nonCompressible: 0, unknownCompressible: 0,
      byTopLevel: {}
    };
    var keys = db && typeof db === 'object' ? Object.keys(db) : [];
    for (var i = 0; i < keys.length; i++) {
      var type = keys[i];
      var rec = db[type] || {};
      s.total++;
      if (Array.isArray(rec.extensions) && rec.extensions.length) s.withExtensions++;
      var c = compressibleOf(rec);
      if (c === 'yes') s.compressible++;
      else if (c === 'no') s.nonCompressible++;
      else s.unknownCompressible++;
      var slash = type.indexOf('/');
      var top = slash > 0 ? type.slice(0, slash) : '(none)';
      s.byTopLevel[top] = (s.byTopLevel[top] || 0) + 1;
    }
    return s;
  }

  /* ========================================================================
     UI
     ======================================================================== */

  function loadDb() {
    return window.fetch(DB_URL).then(function (r) {
      if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : 'error'));
      return r.json();
    });
  }

  window.ItTools.register('mime-types', function (root) {
    var db = null;
    var alive = true;               // fetch 回来时可能已经 destroy 了
    var page = 1;

    var status = D.h('span.form-status', { text: t('loading', 'Loading mime-db…') });

    /* ---- ① mime 类型 → 扩展名 ---- */
    var typeIn = D.h('input.layui-input', {
      type: 'text', spellcheck: 'false', autocomplete: 'off',
      placeholder: t('ph_type', 'text/html  (parameters like ; charset=utf-8 are ignored)')
    });
    var typeOut = D.h('div');

    function renderTypeLookup() {
      D.clear(typeOut);
      if (!db) { typeOut.appendChild(D.h('p.field-hint', { text: t('db_still_loading', 'mime-db is still loading.') })); return; }
      var q = typeIn.value.trim();
      if (!q) { typeOut.appendChild(D.h('p.field-hint', { text: t('type_prompt', 'Type a mime type to see its extensions.') })); return; }
      var info = lookupMime(db, q);
      if (!info) {
        typeOut.appendChild(D.h('p.form-status.is-error', { text: t('no_entry', 'No entry for "{value}" in mime-db.').replace('{value}', q) }));
        return;
      }
      var tags = info.extensions.length
        ? info.extensions.map(function (e) { return D.h('span.tag', { text: '.' + e }); })
        : [D.h('span.field-hint', { text: t('no_extension', 'mime-db lists no extension for this type.') })];
      typeOut.appendChild(D.h('div.kv-table', null,
        row(t('row_type', 'Type'), D.h('span.tag', { text: info.type })),
        row(t('row_extensions', 'Extensions'), D.h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, tags)),
        row(t('row_compressible', 'Compressible'), String(info.compressible === null ? t('not_specified', 'not specified') : info.compressible)),
        row(t('row_charset', 'Charset'), info.charset || t('not_specified', 'not specified')),
        row(t('row_source', 'Source'), info.source || t('not_specified', 'not specified'))
      ));
    }
    function row(label, value) {
      var val = value && value.nodeType ? value : D.h('span', { text: String(value) });
      return D.h('div', null, D.h('div.output-table', null,
        D.h('tr', null, D.h('td', { text: label }), D.h('td', null, val))));
    }

    /* ---- ② 扩展名 → mime 类型（收文件名也收裸扩展名） ---- */
    var extIn = D.h('input.layui-input', {
      type: 'text', spellcheck: 'false', autocomplete: 'off',
      placeholder: t('ph_extension', 'html  ·  .html  ·  index.html')
    });
    var extOut = D.h('div');

    function renderExtLookup() {
      D.clear(extOut);
      if (!db) { extOut.appendChild(D.h('p.field-hint', { text: t('db_still_loading', 'mime-db is still loading.') })); return; }
      var q = extIn.value.trim();
      if (!q) { extOut.appendChild(D.h('p.field-hint', { text: t('ext_prompt', 'Type an extension or a file name.') })); return; }

      var byPath = mimeTypeOfPath(db, q);
      var hits = typesForExtension(db, q);
      if (!hits.length) {
        extOut.appendChild(D.h('p.form-status.is-error', {
          text: t('no_claims', 'No mime type claims the extension "{value}".').replace('{value}', q)
        }));
        return;
      }
      var rows = hits.map(function (type) {
        var rec = lookupMime(db, type) || {};
        return D.h('tr', null,
          D.h('td.val', null,
            D.h('span', { text: type }),
            ' ',
            U.copyButton(function () { return type; }, window.ItTools.i18n('copy', 'Copy'))
          ),
          D.h('td', { text: rec.compressible === null ? '—' : String(rec.compressible) }),
          D.h('td', { text: rec.source || '—' })
        );
      });
      extOut.appendChild(D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_mime_type', 'Mime type') }), D.h('th', { text: t('col_compressible', 'Compressible') }), D.h('th', { text: t('col_source', 'Source') })
        )),
        D.h('tbody', null, rows)
      ));
      if (hits.length > 1) {
        extOut.appendChild(D.h('p.field-hint', {
          text: t('multi_types_hint', '{count} types claim this extension; mime-db has no priority flag, so they are sorted by source (iana first) then alphabetically. The first one is what a Content-Type header would normally use.').replace('{count}', hits.length)
        }));
      }
      if (byPath && hits.indexOf(byPath) === -1) {
        extOut.appendChild(D.h('p.field-hint', { text: t('resolved_to', 'File name resolved to {value}.').replace('{value}', byPath) }));
      }
    }

    /* ---- ③ 浏览 / 搜索 ---- */
    var search = D.h('input.layui-input', {
      type: 'search', spellcheck: 'false', autocomplete: 'off',
      placeholder: t('ph_search', 'Search mime types and extensions… (e.g. "svg", "zip", "application/")')
    });
    var mode = D.h('select.layui-input', null,
      D.h('option', { value: 'any', text: t('mode_any', 'Any compressibility') }),
      D.h('option', { value: 'yes', text: t('mode_yes', 'compressible = true') }),
      D.h('option', { value: 'no', text: t('mode_no', 'compressible = false') }),
      D.h('option', { value: 'unknown', text: t('mode_unknown', 'compressible not specified') })
    );
    var size = D.h('select.layui-input', null,
      [25, 50, 100, 200, 500].map(function (n) {
        return D.h('option', { value: String(n), text: t('per_page', '{count} / page').replace('{count}', n) });
      })
    );
    size.value = String(DEFAULT_PAGE_SIZE);
    var stats = D.h('div.field-row');
    var tableOut = D.h('div');
    var pager = D.h('div.form-actions');

    function renderStats() {
      D.clear(stats);
      stats.appendChild(D.h('label.field-label', { text: t('label_database', 'Database') }));
      if (!db) { stats.appendChild(status); return; }
      var s = mimeTypeStats(db);
      [
        t('stat_types', '{count} types').replace('{count}', s.total),
        t('stat_with_extensions', '{count} with extensions').replace('{count}', s.withExtensions),
        t('stat_compressible', '{count} compressible').replace('{count}', s.compressible),
        t('stat_not_compressible', '{count} not compressible').replace('{count}', s.nonCompressible),
        t('stat_unspecified', '{count} unspecified').replace('{count}', s.unknownCompressible)
      ].forEach(function (label) { stats.appendChild(D.h('span.badge-note', { text: label })); });
    }

    function renderTable() {
      D.clear(tableOut);
      D.clear(pager);
      if (!db) { tableOut.appendChild(D.h('p.field-hint', { text: t('loading', 'Loading mime-db…') })); return; }
      var r = filterMimeTypes(db, { query: search.value, compressible: mode.value, page: page, pageSize: Number(size.value) });
      page = r.page;

      if (!r.total) {
        tableOut.appendChild(D.h('p.form-status.is-error', {
          text: t('nothing_matches', 'Nothing matches "{value}".').replace('{value}', search.value)
        }));
        return;
      }

      var body = r.items.map(function (type) {
        var rec = lookupMime(db, type) || {};
        var exts = rec.extensions.length
          ? rec.extensions.map(function (e) { return D.h('span.tag', { text: '.' + e }); })
          : [D.h('span.muted', { text: '—' })];
        return D.h('tr', null,
          D.h('td.val', null,
            D.h('span', { text: type }),
            ' ',
            U.copyButton(function () { return type; }, window.ItTools.i18n('copy', 'Copy'))
          ),
          D.h('td', null, D.h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } }, exts)),
          D.h('td', { text: rec.compressible === null ? '—' : String(rec.compressible) })
        );
      });
      tableOut.appendChild(D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_mime_type', 'Mime type') }), D.h('th', { text: t('col_extensions', 'Extensions') }), D.h('th', { text: t('col_compressible', 'Compressible') })
        )),
        D.h('tbody', null, body)
      ));

      var label = t('page_label', 'Page {page} / {pages} — {total} types').replace('{page}', r.page).replace('{pages}', r.totalPages).replace('{total}', r.total);
      pager.appendChild(D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button', text: t('prev', '‹ Prev'), disabled: r.page <= 1,
        onclick: function () { if (page > 1) { page--; renderTable(); } }
      }));
      pager.appendChild(D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button', text: t('next', 'Next ›'), disabled: r.page >= r.totalPages,
        onclick: function () { if (page < r.totalPages) { page++; renderTable(); } }
      }));
      pager.appendChild(D.h('span.form-status', { text: label }));
      pager.appendChild(U.copyButton(function () {
        return filterMimeTypes(db, { query: search.value, compressible: mode.value, page: 1, pageSize: MAX_PAGE_SIZE })
          .items.join('\n');
      }, t('copy_all_filtered', 'Copy all filtered')));
    }

    function resetPage() { page = 1; }

    var offs = [
      D.on(typeIn, 'input', renderTypeLookup),
      D.on(extIn, 'input', renderExtLookup),
      D.on(search, 'input', function () { resetPage(); renderTable(); }),
      D.on(mode, 'change', function () { resetPage(); renderTable(); }),
      D.on(size, 'change', function () { resetPage(); renderTable(); })
    ];

    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', null, D.h('label.field-label', { text: t('label_mime_type', 'Mime type') }), status),
      U.field(t('field_type_to_extensions', 'Mime type → extensions'), typeIn, { wide: true }),
      typeOut
    ));
    root.appendChild(D.h('div.card', null,
      U.field(t('field_ext_to_type', 'File extension → mime type'), extIn, {
        wide: true,
        hint: t('hint_ext_input', 'Accepts a bare extension, a dotted one or a whole file name.')
      }),
      extOut
    ));
    root.appendChild(D.h('div.card', null,
      stats,
      D.h('div.input-group', null, search),
      D.h('div.form-actions', null, mode, size),
      tableOut,
      pager
    ));

    renderTypeLookup(); renderExtLookup(); renderStats(); renderTable();

    loadDb().then(function (data) {
      if (!alive) return;
      if (!data || typeof data !== 'object') throw new Error('db.json is not an object');
      db = data;
      renderStats(); renderTypeLookup(); renderExtLookup(); renderTable();
    }).catch(function (e) {
      if (!alive) return;
      status.className = 'form-status is-error';
      status.textContent = t('load_failed', 'Failed to load {url} — {error}').replace('{url}', DB_URL).replace('{error}', e.message);
    });

    return {
      destroy: function () {
        alive = false;
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['mime-types'] = {
    clampInt: clampInt,
    normalizeType: normalizeType,
    normalizeExtension: normalizeExtension,
    basename: basename,
    sourceRank: sourceRank,
    lookupMime: lookupMime,
    typesForExtension: typesForExtension,
    preferredTypeFor: preferredTypeFor,
    mimeTypeOfPath: mimeTypeOfPath,
    buildExtensionIndex: buildExtensionIndex,
    compressibleOf: compressibleOf,
    matchesQuery: matchesQuery,
    filterMimeTypes: filterMimeTypes,
    mimeTypeStats: mimeTypeStats,

    /* 测试用的小样本，形状照抄真实 db.json（尤其是缺失字段的那种） */
    DB: {
      'text/html': { source: 'iana', compressible: true, extensions: ['html', 'htm', 'shtml'] },
      'text/css': { source: 'iana', charset: 'UTF-8', compressible: true, extensions: ['css'] },
      'text/plain': { source: 'iana', compressible: true, extensions: ['txt', 'log'] },
      'text/xml': { source: 'iana', compressible: true, extensions: ['xml'] },
      'application/xml': { source: 'iana', compressible: true, extensions: ['xml'] },
      'image/png': { source: 'iana', compressible: false, extensions: ['png'] },
      'image/x-ms-bmp': { source: 'nginx', compressible: false, extensions: ['bmp'] },
      'image/bmp': { source: 'iana', compressible: false, extensions: ['bmp'] },
      'application/vnd.ms-project': { source: 'iana', extensions: ['mpp'] },
      'application/dash-patch+xml': { source: 'iana', extensions: ['mpp'] },
      // 有意造的三种「字段缺失」
      'application/1d-interleaved-parityfec': { source: 'iana' },
      'video/quicktime': { compressible: false },
      'message/rfc822': {}
    },

    __cases: function (assert) {
      var DB = this.DB;

      /* ---- 归一化 ---- */
      assert.eq(normalizeType('  TEXT/HTML '), 'text/html', '大小写与空白归一');
      assert.eq(normalizeType('text/html; charset=utf-8'), 'text/html', '参数被剥掉');
      assert.eq(normalizeType('text/html ; charset=utf-8'), 'text/html', '分号前有空格也剥得掉');
      assert.eq(normalizeType(''), '', '空串');
      assert.eq(normalizeType(null), '', 'null 不炸');
      assert.eq(normalizeType(undefined), '', 'undefined 不炸');
      assert.eq(normalizeType('nonsense'), 'nonsense', '没有斜杠也照原样（查表时才判失败）');

      assert.eq(normalizeExtension('.HTML'), 'html', '点 + 大写');
      assert.eq(normalizeExtension('  .html  '), 'html', '空白');
      assert.eq(normalizeExtension('..html'), 'html', '多个前导点');
      assert.eq(normalizeExtension(''), '', '空串');
      assert.eq(normalizeExtension(null), '', 'null 不炸');

      assert.eq(basename('/var/www/index.html'), 'index.html', 'posix 路径');
      assert.eq(basename('C:\\Users\\a\\b.TXT'), 'b.TXT', 'windows 反斜杠');
      assert.eq(basename('file.html?v=2#frag'), 'file.html', 'query/fragment 被剥掉');
      assert.eq(basename('plain'), 'plain', '没有路径');
      assert.eq(basename(null), '', 'null 不炸');

      /* ---- clampInt ---- */
      assert.eq(clampInt(undefined, 50, 1, 500), 50, 'undefined 走 fallback');
      assert.eq(clampInt(NaN, 50, 1, 500), 50, 'NaN 走 fallback');
      assert.eq(clampInt(0, 50, 1, 500), 1, '低于下界夹住');
      assert.eq(clampInt(99999, 50, 1, 500), 500, '高于上界夹住');
      assert.eq(clampInt(7.9, 50, 1, 500), 7, '小数向下取整');
      assert.eq(clampInt(-3, 1, 1, 10), 1, '负数夹住');
      assert.eq(clampInt('12', 50, 1, 500), 12, '字符串数字也认（select.value 就是字符串）');

      /* ---- lookupMime ---- */
      assert.eq(lookupMime(DB, 'text/html'), {
        type: 'text/html', source: 'iana', charset: null,
        compressible: true, extensions: ['html', 'htm', 'shtml']
      }, '查得到：三态被规范成 null 而不是 undefined');
      assert.eq(lookupMime(DB, '  TEXT/HTML ; charset=UTF-8  '), {
        type: 'text/html', source: 'iana', charset: null,
        compressible: true, extensions: ['html', 'htm', 'shtml']
      }, '大小写/参数/空白都容忍');
      assert.eq(lookupMime(DB, 'text/css').charset, 'UTF-8', 'charset 透传');
      assert.eq(lookupMime(DB, 'text/css').compressible, true, 'compressible 是真布尔');
      // 字段缺失的几种形状
      assert.eq(lookupMime(DB, 'application/1d-interleaved-parityfec'),
        { type: 'application/1d-interleaved-parityfec', source: 'iana', charset: null, compressible: null, extensions: [] },
        '没有 extensions 字段不能炸，当空数组');
      assert.eq(lookupMime(DB, 'video/quicktime'),
        { type: 'video/quicktime', source: null, charset: null, compressible: false, extensions: [] },
        '没有 source 字段 → null');
      assert.eq(lookupMime(DB, 'message/rfc822'),
        { type: 'message/rfc822', source: null, charset: null, compressible: null, extensions: [] },
        '空对象：两个字段都当没写');
      // 查不到 / 非法输入
      assert.eq(lookupMime(DB, 'nope/nope'), null, '查不到返回 null');
      assert.eq(lookupMime(DB, 'text/html/../etc'), null, '原型链上的 key 不算命中');
      assert.eq(lookupMime(DB, 'constructor'), null, '继承来的属性不算命中（hasOwnProperty 卡住了）');
      assert.eq(lookupMime(DB, ''), null, '空串');
      assert.eq(lookupMime(DB, null), null, 'null');
      assert.eq(lookupMime(DB, undefined), null, 'undefined');
      assert.eq(lookupMime(null, 'text/html'), null, 'db 本身是 null');
      assert.eq(lookupMime('not an object', 'text/html'), null, 'db 不是对象');
      assert.eq(lookupMime(DB, 'toString'), null, 'toString 不是 mime 类型');

      /* ---- sourceRank ---- */
      assert.eq(sourceRank({ source: 'iana' }), 0, 'iana 最高');
      assert.eq(sourceRank({}), 1, '没写 source 居中');
      assert.eq(sourceRank({ source: 'apache' }), 2, '厂商条目最低');
      assert.eq(sourceRank(null), 1, '记录不存在按没写算');

      /* ---- 反查 ---- */
      assert.eq(typesForExtension(DB, 'html'), ['text/html'], '一对一');
      assert.eq(typesForExtension(DB, '.HTML'), ['text/html'], '带点带大写也认');
      assert.eq(typesForExtension(DB, 'bmp'), ['image/bmp', 'image/x-ms-bmp'],
        '多类型按 source 排：iana 在 nginx 前');
      assert.eq(typesForExtension(DB, 'xml'), ['application/xml', 'text/xml'],
        '同 source 用字典序，application/xml 在前');
      assert.eq(typesForExtension(DB, 'mpp'), ['application/dash-patch+xml', 'application/vnd.ms-project'],
        '同 source 平局也按字典序，结果稳定');
      assert.eq(typesForExtension(DB, 'zzz'), [], '没人要的扩展名 → 空数组');
      assert.eq(typesForExtension(DB, ''), [], '空串 → 空数组');
      assert.eq(typesForExtension(DB, null), [], 'null 不炸');
      assert.eq(typesForExtension(null, 'html'), [], 'db 是 null → 空数组');

      assert.eq(preferredTypeFor(DB, 'xml'), 'application/xml', '取排序后的第一个');
      assert.eq(preferredTypeFor(DB, 'zzz'), null, '没有就 null');

      assert.eq(mimeTypeOfPath(DB, 'index.html'), 'text/html', '裸文件名');
      assert.eq(mimeTypeOfPath(DB, '/a/b/c.CSS?v=1'), 'text/css', '路径 + 大写 + query');
      assert.eq(mimeTypeOfPath(DB, '.gitignore'), null, '纯点开头的文件当没有扩展名');
      assert.eq(mimeTypeOfPath(DB, 'README'), null, '没有点');
      assert.eq(mimeTypeOfPath(DB, ''), null, '空串');
      assert.eq(mimeTypeOfPath(DB, 'a.'), null, '只有点');

      /* ---- 扩展名索引 ---- */
      var idx = buildExtensionIndex(DB);
      assert.eq(Object.keys(idx), ['bmp', 'css', 'htm', 'html', 'log', 'mpp', 'png', 'shtml', 'txt', 'xml'],
        '键按字典序排好（htm 是 html 的前缀，所以 htm 在前）');
      assert.eq(idx.xml, ['application/xml', 'text/xml'], '值也排好序');
      assert.eq(idx.txt, ['text/plain'], 'html/htm/shtml 三个扩展名各自成键');
      assert.eq(buildExtensionIndex(null), {}, 'db 是 null → 空索引');

      /* ---- compressible 三态 ---- */
      assert.eq(compressibleOf({ compressible: true }), 'yes', 'true');
      assert.eq(compressibleOf({ compressible: false }), 'no', 'false');
      assert.eq(compressibleOf({}), 'unknown', '字段缺失');
      assert.eq(compressibleOf(null), 'unknown', '记录缺失');
      assert.eq(compressibleOf({ compressible: 'yes' }), 'unknown', '非布尔值当没写');

      /* ---- matchesQuery ---- */
      assert(matchesQuery('image/svg+xml', { extensions: ['svg', 'svgz'] }, 'svg'), '扩展名命中');
      assert(matchesQuery('image/svg+xml', { extensions: ['svg'] }, '.svg'), '带点的关键字也命中');
      assert(matchesQuery('application/json', null, 'json'), '类型串命中');
      assert(!matchesQuery('application/json', null, 'xml'), '不命中');
      assert(!matchesQuery('application/json', { extensions: null }, 'json/'), 'extensions 不是数组也不炸');

      /* ---- 过滤 / 分页 ---- */
      var r = filterMimeTypes(DB, {});
      assert.eq(r.total, DB && Object.keys(DB).length, '默认全量');
      assert.eq(r.items.length, DB && Object.keys(DB).length, '默认页大到装得下');
      assert.eq(r.page, 1, '默认第一页');
      assert.eq(r.totalPages, 1, '默认一页');
      assert.eq(r.compressible, 'any', '默认不过滤 compressible');
      assert.eq(r.items, Object.keys(DB).sort(), '结果按类型名字典序');

      r = filterMimeTypes(DB, { query: 'xml' });
      assert.eq(r.items, ['application/dash-patch+xml', 'application/xml', 'text/xml'],
        '关键字同时打类型串和扩展名');
      r = filterMimeTypes(DB, { query: 'XML' });
      assert.eq(r.items.length, 3, '大小写不敏感');
      r = filterMimeTypes(DB, { query: 'html' });
      assert.eq(r.items, ['text/html'], '按扩展名查（text/html 声明了 html）');
      r = filterMimeTypes(DB, { query: '.log' });
      assert.eq(r.items, ['text/plain'], '带点的关键字按去点后的扩展名匹配');
      r = filterMimeTypes(DB, { query: '  ' });
      assert.eq(r.total, Object.keys(DB).length, '纯空白的 query 当没筛');

      // 样本共 13 条：compressible 三态分别是 5 / 4 / 4
      assert.eq(filterMimeTypes(DB, { compressible: 'yes' }).total, 5, 'compressible = true 的 5 条');
      assert.eq(filterMimeTypes(DB, { compressible: 'no' }).total, 4, 'compressible = false 的 4 条');
      assert.eq(filterMimeTypes(DB, { compressible: 'unknown' }).total, 4, '没写 compressible 的 4 条');
      assert.eq(filterMimeTypes(DB, { compressible: true }).compressible, 'yes', '布尔 true 也认');
      assert.eq(filterMimeTypes(DB, { compressible: false }).compressible, 'no', '布尔 false 也认');
      assert.eq(filterMimeTypes(DB, { compressible: 'garbage' }).compressible, 'any', '非法档位退回 any');
      assert.eq(filterMimeTypes(DB, { compressible: 'no', query: 'png' }).items, ['image/png'], '两个条件是 AND');
      assert.eq(filterMimeTypes(DB, { compressible: 'yes', query: 'png' }).items, [], 'AND 互斥时就是空');

      // 分页
      r = filterMimeTypes(DB, { pageSize: 5 });
      assert.eq(r.totalPages, 3, '13 条 / 每页 5 → 3 页');
      assert.eq(r.items.length, 5, '第一页满页');
      r = filterMimeTypes(DB, { pageSize: 5, page: 3 });
      assert.eq(r.items.length, 3, '最后一页不满');
      r = filterMimeTypes(DB, { pageSize: 5, page: 99 });
      assert.eq(r.page, 3, '页码越界夹回最后一页');
      r = filterMimeTypes(DB, { pageSize: 5, page: -2 });
      assert.eq(r.page, 1, '负页码夹到 1');
      r = filterMimeTypes(DB, { pageSize: 0 });
      assert.eq(r.pageSize, 1, 'pageSize 0 夹到 1，不允许除以零');
      r = filterMimeTypes(DB, { pageSize: 1e9 });
      assert.eq(r.pageSize, 500, 'pageSize 上限 500');
      assert.eq(filterMimeTypes(DB, { query: 'zzzz' }).items, [], '空结果');
      assert.eq(filterMimeTypes(DB, { query: 'zzzz' }).totalPages, 1, '空结果的 totalPages 是 1（不是 0）');
      assert.eq(filterMimeTypes(DB, { query: 'zzzz', page: 4 }).page, 1, '空结果时页码夹到 1');
      assert.eq(filterMimeTypes(null, {}).total, 0, 'db 是 null 不炸');
      assert.eq(filterMimeTypes(undefined, undefined).items, [], '全 undefined 也不炸');

      /* ---- 统计 ---- */
      var s = mimeTypeStats(DB);
      assert.eq(s.total, 13, '总数');
      assert.eq(s.withExtensions, 10, '带 extensions 的条目数');
      assert.eq(s.compressible, 5, 'compressible = true');
      assert.eq(s.nonCompressible, 4, 'compressible = false');
      assert.eq(s.unknownCompressible, 4, '没写 compressible');
      assert.eq(s.byTopLevel, { text: 4, application: 4, image: 3, video: 1, message: 1 }, '按第一段分组');
      assert.eq(mimeTypeStats({ 'weirdtype': {} }).byTopLevel, { '(none)': 1 }, '没有斜杠的归到 (none)');
      assert.eq(mimeTypeStats(null).total, 0, 'db 是 null 不炸');

      /* ---- 真实数据自检（这些断言对应打包进来的 db.json 里的真实条目） ---- */
      // 这里手写 db.json 里确实存在的值，用来锁住「三态 / 缺字段」这些假设
      var real = {
        'application/1d-interleaved-parityfec': { source: 'iana' },
        'text/html': { source: 'iana', compressible: true, extensions: ['html', 'htm', 'shtml'] },
        'image/png': { source: 'iana', compressible: false, extensions: ['png'] },
        'application/javascript': { source: 'iana', compressible: true, extensions: ['js', 'mjs'] },
        'text/xml': { source: 'iana', compressible: true, extensions: ['xml'] },
        'application/xml': { source: 'iana', compressible: true, extensions: ['xml'] }
      };
      assert.eq(lookupMime(real, 'text/html').extensions, ['html', 'htm', 'shtml'],
        '真实 db 里 text/html 带 shtml（参考实现的说明里漏了这个扩展名）');
      assert.eq(lookupMime(real, 'application/1d-interleaved-parityfec').extensions, [],
        '真实 db 里有整条没有 extensions 的记录');
      assert.eq(typesForExtension(real, 'xml'), ['application/xml', 'text/xml'],
        '真实 db 里 xml 确实被两个类型占用');
      assert.eq(typesForExtension(real, 'js'), ['application/javascript'], 'js 是干净的');
      assert.eq(preferredTypeFor(real, 'png'), 'image/png', 'png 是干净的');
    }
  };
})();