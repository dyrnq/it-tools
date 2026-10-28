/* ==========================================================================
   .gitattributes 生成器（gitattributes-generator）

   从 alexkaratarakis/gitattributes 的模板快照里挑几个，拼成一个能直接用的
   .gitattributes。

   参考实现：src/tools/gitattributes-generator/（it-tools2 的 fork，Vue 写的）。
   与参考实现的差别：

   1. 参考实现是**在线**的：选项来自 GitHub API 的目录树，正文来自
      raw.githubusercontent；网络一抖就半个界面不能用。它取的还是**分支头**
      （master）——今天预览到的和下周命令拉下来的已经不是一份了。
      这里改成：模板正文随站点一起发布（static/data/gitattributes-templates.json，
      由 scripts/build-git-templates.sh 从**钉死的 commit** 生成），界面上的
      下载链接也指同一个 commit。预览、命令、数据三者永远一致。

   2. 参考实现给 curl / wget / PowerShell / Windows CMD 四条命令，其中后三条
      拼出来的命令**只能下载最后一个文件**（`Invoke-WebRequest a b -OutFile x`
      会报错或者只留最后一个），而且四个都指向**分支头**，不是快照 commit。
      这里只给一条 curl（curl 一次带多个 URL 会把正文依次写进 stdout，
      正好拼成一个文件），并且所有链接都指到那个 commit。

   3. 模板的键是「相对仓库根的路径去掉后缀」：Common.gitattributes → "Common"，
      Global/VisualStudio.gitattributes → "Global/VisualStudio"。
      不能只用文件名——仓库里确实有重名（Racket 与 community/Racket、
      community/BoxLang/ColdBox 与 community/CFML/ColdBox），只用文件名会**丢模板**。

   4. 参考实现只有一个 n-select（下拉里搜）。四十来个条目还行，但这里跟
      gitignore-generator 保持一致：可搜索的复选列表，能多选、选了什么一目了然。

   依赖：无（原生 DOM + fetch 一份静态 JSON）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('gitattributes-generator');

  /* ---- 本工具的固定参数（跟 gitignore-generator 只有这几行不同） ---- */
  var REPO = 'alexkaratarakis/gitattributes';
  var EXT = '.gitattributes';
  var DATA_URL = '/assets/data/gitattributes-templates.json';
  var DOWNLOAD_NAME = 'gitattributes';
  var OUTPUT_TITLE = '.gitattributes';

  /* ========================================================================
     纯逻辑
     ======================================================================== */

  /**
   * 排序：不分大小写，同一字母再按码位比。
   *
   * 不用 localeCompare —— 它跟着运行环境的默认 locale 走，不同机器上顺序可能
   * 不一样（列表顺序变了，用户会以为是数据变了）。这里要的是**稳定**的顺序。
   *
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  function byName(a, b) {
    var la = String(a).toLowerCase(), lb = String(b).toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  /**
   * 从 fetch 回来的 JSON 里取出模板表，顺手把 commit 校验一遍。
   *
   * commit 是这个工具的命根子：界面上的下载链接全靠它拼，校验不过就宁可报错，
   * 也不能拿一个来路不明的模板凑合 —— 那样「预览到的」和「命令拉下来的」就
   * 又对不上了（这正是这个工具要解决的问题）。
   *
   * @param {*} data
   * @returns {{commit: string, source: string, templates: Object, names: string[]}}
   */
  function parseSnapshot(data) {
    if (!data || typeof data !== 'object') throw new Error('snapshot is not an object');
    if (typeof data.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(data.commit)) {
      throw new Error('snapshot has no valid commit sha');
    }
    var templates = data.templates;
    if (!templates || typeof templates !== 'object') throw new Error('snapshot has no templates');
    var names = Object.keys(templates).filter(function (k) {
      return typeof templates[k] === 'string';
    }).sort(byName);
    if (!names.length) throw new Error('snapshot has no templates');
    return {
      commit: data.commit,
      source: typeof data.source === 'string' && data.source ? data.source : 'https://github.com/' + REPO,
      templates: templates,
      names: names
    };
  }

  /**
   * 搜索：不分大小写的子串匹配（键里带目录，所以 "studio" 也能命中
   * Global/VisualStudio）。
   *
   * @param {string[]} names
   * @param {string} query
   * @returns {string[]}
   */
  function filterNames(names, query) {
    var list = Array.isArray(names) ? names : [];
    var q = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
    if (!q) return list.slice();
    return list.filter(function (n) { return String(n).toLowerCase().indexOf(q) >= 0; });
  }

  /**
   * 把选中的模板拼成一个文件：每段前面加一行 "# <模板名>"，段与段之间空一行。
   *
   * 末尾补一个换行 —— 生成的是要给 git 读的文件，最后一行没有换行很难看。
   *
   * @param {string[]} names
   * @param {Object} templates 名字 → 文件内容
   * @returns {string}
   */
  function buildFile(names, templates) {
    var parts = [];
    (Array.isArray(names) ? names : []).forEach(function (name) {
      var content = templates ? templates[name] : null;
      if (typeof content !== 'string') return;   // 快照里没有的模板直接跳过，不抛
      parts.push('# ' + name + '\n' + content.replace(/\s+$/, ''));
    });
    if (!parts.length) return '';
    return parts.join('\n\n') + '\n';
  }

  /**
   * 模板正文的固定链接 —— commit 钉死，跟预览用的是同一份内容。
   * @param {string} name
   * @param {string} commit
   * @returns {string}
   */
  function templateUrl(name, commit) {
    return 'https://raw.githubusercontent.com/' + REPO + '/' + commit + '/' + name + EXT;
  }

  /**
   * 仓库在那个 commit 上的目录页 —— 界面上「模板快照」那个链接。
   * @param {string} commit
   * @returns {string}
   */
  function snapshotUrl(commit) {
    return 'https://github.com/' + REPO + '/tree/' + commit;
  }

  /**
   * 一条把选中的模板按**同一个 commit** 拉下来的命令。
   *
   * curl 一次给多个 URL 时会把它们的正文**依次**写到 stdout，所以
   * `curl url1 url2 > 文件` 得到的就是拼接后的内容。
   *
   * @param {string[]} names
   * @param {string} commit
   * @returns {string}
   */
  function buildCommand(names, commit) {
    var list = Array.isArray(names) ? names : [];
    if (!list.length) return '';
    var urls = list.map(function (n) { return templateUrl(n, commit); }).join(' ');
    return 'curl -fsSL ' + urls + ' > ' + DOWNLOAD_NAME;
  }

  /* ========================================================================
     UI
     ======================================================================== */

  window.ItTools.register('gitattributes-generator', function (root) {
    var snapshot = null;      // {commit, source, templates, names}
    var selected = [];        // 选中的模板名，按勾选顺序
    var alive = true;         // fetch 回来时工具可能已经被卸载了
    var outText = '';         // 当前生成出来的文件内容

    var search = D.h('input.layui-input', {
      type: 'search', spellcheck: 'false', autocomplete: 'off',
      placeholder: t('ph_search', 'Search templates (e.g. visualstudio, python, vim)…')
    });

    var list = D.h('div', { style: {
      maxHeight: '260px',
      overflowY: 'auto',
      border: '1px solid var(--border-card)',
      borderRadius: 'var(--radius)',
      padding: '8px 12px'
    } });

    var snapshotLine = D.h('p.field-hint');
    var status = D.h('span.form-status');
    var selBadge = D.h('span.badge-note');

    /* ---- 输出区 ---- */
    var outPre = D.h('pre.code-body.mono');
    var outHint = D.h('p.field-hint', { text: t('out_empty', 'Nothing generated yet — tick some templates and press Generate.') });
    var outStatus = D.h('span.form-status');
    var outActions = D.h('div.form-actions');
    var outCard = D.h('div.card.code-card', null,
      D.h('div.code-label', { text: OUTPUT_TITLE }),
      outHint,
      outPre,
      U.copyButton(function () { return outText; }),
      outActions
    );

    var cmdPre = D.h('pre.mono-output');
    var cmdCard = D.h('div.card', null,
      D.h('div.code-label', { text: t('cmd_title', 'Fetch the same templates with curl') }),
      D.h('p.field-hint', { text: t('cmd_hint', 'The links below point to the same snapshot commit as the preview above, so the files you fetch match what you see — minus the "# <name>" header lines.') }),
      cmdPre
    );

    /* ---- 状态 ---- */

    /**
     * 写一行状态。isError 为真时标红。
     * @param {string} msg
     * @param {boolean} [isError]
     */
    function setStatus(msg, isError) {
      status.className = 'form-status' + (isError ? ' is-error' : '');
      status.textContent = msg || '';
    }

    /** 输出区自己的状态行（下载结果报在这儿，不跟输入区的混在一起）。 */
    function setOutStatus(msg, isError) {
      outStatus.className = 'form-status' + (isError ? ' is-error' : '');
      outStatus.textContent = msg || '';
    }

    /** 勾选数量的徽标。 */
    function renderSelection() {
      selBadge.textContent = t('status_selected', '{count} selected').replace('{count}', selected.length);
    }

    /* ---- 模板列表 ---- */

    function renderList() {
      D.clear(list);
      if (!snapshot) {
        list.appendChild(D.h('p.field-hint', { text: t('status_loading', 'Loading templates…') }));
        return;
      }
      var names = filterNames(snapshot.names, search.value);
      if (!names.length) {
        list.appendChild(D.h('p.form-status.is-error', {
          text: t('nothing_matches', 'No template matches "{query}".').replace('{query}', search.value)
        }));
        return;
      }
      names.forEach(function (name) {
        var box = D.h('input', { type: 'checkbox', value: name });
        box.checked = selected.indexOf(name) >= 0;
        D.on(box, 'change', function () {
          var at = selected.indexOf(name);
          if (box.checked) { if (at < 0) selected.push(name); }
          else if (at >= 0) selected.splice(at, 1);
          renderSelection();
          regenerate();
        });
        list.appendChild(D.h('label', {
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0', cursor: 'pointer' }
        }, box, D.h('span', { text: name })));
      });
    }

    /** 快照那行：commit 明明白白摆出来，还给一个指到那个 commit 的链接。 */
    function renderSnapshot() {
      D.clear(snapshotLine);
      if (!snapshot) {
        snapshotLine.appendChild(D.h('span', { text: t('snapshot_loading', 'Template snapshot: loading…') }));
        return;
      }
      snapshotLine.appendChild(D.h('span', { text: t('snapshot_label', 'Template snapshot:') + ' ' }));
      snapshotLine.appendChild(D.h('a', {
        href: snapshotUrl(snapshot.commit),
        target: '_blank',
        rel: 'noopener noreferrer',
        title: t('snapshot_link_title', 'Open the template repository at this commit'),
        text: snapshot.commit
      }));
      snapshotLine.appendChild(D.h('span', {
        text: ' · ' + t('snapshot_count', '{count} templates from {repo}').replace('{count}', snapshot.names.length).replace('{repo}', REPO)
      }));
    }

    /* ---- 生成 ---- */

    /** 按当前勾选重算输出（勾选变了就跟着变，免得看到的是上一版）。 */
    function regenerate() {
      if (!snapshot || !selected.length) {
        outText = '';
        outPre.textContent = '';
        cmdPre.textContent = '';
        outHint.style.display = '';
        return;
      }
      outText = buildFile(selected, snapshot.templates);
      outPre.textContent = outText;
      cmdPre.textContent = buildCommand(selected, snapshot.commit);
      outHint.style.display = 'none';
    }

    function generate() {
      if (!snapshot) {
        setStatus(t('status_loading', 'Loading templates…'), true);
        return;
      }
      if (!selected.length) {
        setStatus(t('err_no_selection', 'Select at least one template first.'), true);
        return;
      }
      regenerate();
      setStatus(t('status_generated', 'Merged {count} templates.').replace('{count}', selected.length));
    }

    /* ---- 按钮 ---- */

    var generateBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: t('btn_generate', 'Generate'), onclick: generate
    });

    var selectAllBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: t('btn_select_all', 'Select all shown'), onclick: function () {
        if (!snapshot) { setStatus(t('status_loading', 'Loading templates…'), true); return; }
        filterNames(snapshot.names, search.value).forEach(function (name) {
          if (selected.indexOf(name) < 0) selected.push(name);
        });
        renderSelection();
        renderList();
        regenerate();
      }
    });

    var clearBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: t('btn_clear', 'Clear selection'), onclick: function () {
        selected = [];
        renderSelection();
        renderList();
        regenerate();
      }
    });

    var downloadBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: t('btn_download', 'Download'), onclick: function () {
        if (!outText) { setOutStatus(t('err_nothing_to_download', 'Nothing to download yet.'), true); return; }
        window.ItTools.download(DOWNLOAD_NAME, outText, 'text/plain;charset=utf-8');
        setOutStatus(t('status_downloaded', 'Saved {name}.').replace('{name}', DOWNLOAD_NAME));
      }
    });
    outActions.appendChild(downloadBtn);
    outActions.appendChild(outStatus);

    /* ---- 装配 ---- */

    var searchField = U.field(t('label_templates', 'Templates'), search, {
      wide: true,
      hint: t('hint_search', 'Type to filter the list, then tick every template you want to merge. The file is built in the order you tick them.')
    });

    root.appendChild(D.h('div.card', null,
      searchField,
      list,
      snapshotLine,
      D.h('div.form-actions', null,
        generateBtn,
        selectAllBtn,
        clearBtn,
        status,
        selBadge
      )
    ));

    root.appendChild(outCard);
    root.appendChild(cmdCard);

    var offSearch = D.on(search, 'input', renderList);

    renderList();
    renderSnapshot();
    renderSelection();

    /* ---- 取数据 ---- */

    /**
     * 模板正文随站点一起发布；取不到就报一行字，别让整块工具白掉。
     */
    function loadTemplates() {
      if (typeof window.fetch !== 'function') {
        return Promise.reject(new Error('fetch is not available'));
      }
      return window.fetch(DATA_URL).then(function (r) {
        if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : 'error'));
        return r.json();
      });
    }

    loadTemplates().then(function (data) {
      if (!alive) return;
      snapshot = parseSnapshot(data);
      renderSnapshot();
      renderList();
      regenerate();
    }).catch(function (e) {
      if (!alive) return;
      var msg = t('load_failed', 'Failed to load the template snapshot: {error}').replace('{error}', e && e.message ? e.message : e);
      setStatus(msg, true);
      // 快照那行也跟着说失败 —— 留着「加载中」会让人一直等下去。
      D.clear(snapshotLine).appendChild(D.h('span', { text: msg }));
    });

    return {
      destroy: function () {
        alive = false;
        offSearch();
        D.clear(root);
      }
    };
  });

  /* ========================================================================
     逻辑与用例
     ======================================================================== */

  window.ItTools.logic['gitattributes-generator'] = {
    REPO: REPO,
    EXT: EXT,
    DATA_URL: DATA_URL,
    DOWNLOAD_NAME: DOWNLOAD_NAME,
    byName: byName,
    parseSnapshot: parseSnapshot,
    filterNames: filterNames,
    buildFile: buildFile,
    templateUrl: templateUrl,
    snapshotUrl: snapshotUrl,
    buildCommand: buildCommand,

    /* 用例里用的样本，形状照抄真的 static/data/gitattributes-templates.json */
    FIXTURE: {
      commit: '2c20a14833a5ab196c7fc3effcc72ef4e895f4d4',
      source: 'https://github.com/alexkaratarakis/gitattributes',
      templates: {
        'Common': '*.txt   text\n',
        'Python': '*.py    text diff=python\n',
        'Global/VisualStudio': '*.sln    text eol=crlf\n'
      }
    },

    __cases: function (assert) {
      var FIX = this.FIXTURE;

      /* ---- 快照解析 ---- */
      var s = parseSnapshot(FIX);
      assert.eq(s.commit, FIX.commit, 'commit 原样取出');
      assert.eq(s.source, FIX.source, 'source 原样取出');
      assert.eq(s.names.length, 3, '三个模板');
      assert.eq(s.names, ['Common', 'Global/VisualStudio', 'Python'], '按名字排好序（不分大小写）');
      assert.eq(byName('Node', 'node'), -1, '同名不同大小写：码位小的在前');
      assert.eq(byName('node', 'Node'), 1, '同名不同大小写：反过来');
      assert.eq(byName('a', 'b'), -1, '小的在前');

      var threw = false;
      try { parseSnapshot(null); } catch (e) { threw = true; }
      assert(threw, 'null 快照要报错');
      threw = false;
      try { parseSnapshot({ commit: 'abc', templates: {} }); } catch (e) { threw = true; }
      assert(threw, 'commit 不是 40 位 sha 要报错');
      threw = false;
      try { parseSnapshot({ commit: FIX.commit }); } catch (e) { threw = true; }
      assert(threw, '没有 templates 要报错');
      threw = false;
      try { parseSnapshot({ commit: FIX.commit, templates: {} }); } catch (e) { threw = true; }
      assert(threw, '空模板表要报错');

      /* ---- 搜索 ---- */
      var names = s.names;
      assert.eq(filterNames(names, '').length, 3, '空查询返回全部');
      assert.eq(filterNames(names, '   ').length, 3, '纯空白等于没有查询');
      assert.eq(filterNames(names, 'common'), ['Common'], '不分大小写');
      assert.eq(filterNames(names, 'COMMON'), ['Common'], '大写也认');
      assert.eq(filterNames(names, 'studio'), ['Global/VisualStudio'], '带目录的键按子串匹配');
      assert.eq(filterNames(names, 'zzz').length, 0, '匹配不到就是空');
      assert.eq(filterNames(names, null).length, 3, 'null 查询不炸');
      assert.eq(filterNames(null, 'x').length, 0, 'names 是 null 不炸');

      /* ---- 拼文件 ---- */
      assert.eq(
        buildFile(['Common', 'Python'], FIX.templates),
        '# Common\n*.txt   text\n\n# Python\n*.py    text diff=python\n',
        '每段前面一行注释，段间空一行，末尾补换行'
      );
      assert.eq(
        buildFile(['Python', 'Common'], FIX.templates),
        '# Python\n*.py    text diff=python\n\n# Common\n*.txt   text\n',
        '按传入顺序拼'
      );
      assert.eq(buildFile([], FIX.templates), '', '没选就是空串');
      assert.eq(buildFile(null, FIX.templates), '', 'names 是 null 不炸');
      assert.eq(buildFile(['Nope'], FIX.templates), '', '快照里没有的模板被跳过，不抛');
      assert.eq(buildFile(['Common'], {}), '', '模板表是空对象也不炸');
      assert.eq(
        buildFile(['Common'], { 'Common': 'a\n\n\n' }),
        '# Common\na\n',
        '每段末尾多余的空行被去掉'
      );
      assert(buildFile(['Common'], FIX.templates).indexOf('# Common\n') === 0, '第一行就是模板注释');

      /* ---- 链接 ---- */
      assert.eq(
        templateUrl('Common', FIX.commit),
        'https://raw.githubusercontent.com/alexkaratarakis/gitattributes/2c20a14833a5ab196c7fc3effcc72ef4e895f4d4/Common.gitattributes',
        '模板链接指到钉死的 commit'
      );
      assert.eq(
        templateUrl('Global/VisualStudio', FIX.commit),
        'https://raw.githubusercontent.com/alexkaratarakis/gitattributes/2c20a14833a5ab196c7fc3effcc72ef4e895f4d4/Global/VisualStudio.gitattributes',
        '带目录的模板链接同样对'
      );
      assert.eq(
        snapshotUrl(FIX.commit),
        'https://github.com/alexkaratarakis/gitattributes/tree/2c20a14833a5ab196c7fc3effcc72ef4e895f4d4',
        '快照链接指到那个 commit 的目录页'
      );
      // 链接里必须带 commit —— 这正是「预览到的」和「命令拉下来的」要对上的前提
      assert(templateUrl('Common', FIX.commit).indexOf(FIX.commit) >= 0, '模板链接里带 commit');
      assert(snapshotUrl(FIX.commit).indexOf(FIX.commit) >= 0, '快照链接里带 commit');

      /* ---- 命令 ---- */
      var cmd = buildCommand(['Common', 'Python'], FIX.commit);
      assert(cmd.indexOf(FIX.commit) >= 0, '命令里的链接带 commit');
      assert(cmd.indexOf(templateUrl('Common', FIX.commit)) >= 0, '命令里有第一个模板');
      assert(cmd.indexOf(templateUrl('Python', FIX.commit)) >= 0, '命令里有第二个模板');
      assert(cmd.indexOf('curl') === 0, '命令是 curl 开头');
      assert(cmd.indexOf('> gitattributes') >= 0, '命令把内容写进 gitattributes');
      assert.eq(buildCommand([], FIX.commit), '', '没选就没有命令');
      assert.eq(buildCommand(null, FIX.commit), '', 'names 是 null 不炸');
    }
  };
})();
