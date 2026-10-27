/* ==========================================================================
   SQL 格式化（sql-prettify）

   把一段 SQL 按关键字分行、按缩进对齐，可选方言 / 关键字大小写 / 缩进风格。
   参考实现：src/tools/sql-prettify/（it-tools, GPLv3）

   ---- 库里核到的 API 形状 ----
   - 全局是 sqlFormatter，可用的方言列表**不在** `sqlFormatter.dialects` 上
     （那个属性是 undefined），而在 `sqlFormatter.supportedDialects`，实测 18 个：
     bigquery db2 hive mariadb mysql n1ql plsql postgresql redshift spark
     sqlite sql transactsql tsql singlestoredb snowflake trino
     下拉框直接从 supportedDialects 生成（tsql / transactsql 是同一个方言的别名）。
   - 传 `language` 和传 `dialect` 等价，这个版本不会打 deprecation 警告；
     这里沿用参考实现和任务书里的 `language`。
   - keywordCase / indentStyle 传了不认识的**不会报错，会静默按 preserve 处理**。
     所以本模块自己先校验，非法值给明确报错，别让用户对着「按下的按钮」
     得到一个「不知为何的输出」。

   ---- 与参考实现的差别 ----
   - 参考实现的 config 是 reactive，格式化在 computed 里跑；sql-formatter 抛错
     （比如方言拼错）时会直接把 computed 打挂。这里把方言先校验掉，格式化失败
     也捕获后显示错误，不让工具页变成空白。
   - 参考实现的 tabulateAlias 固定写死 true，这里留在配置里默认 true（行为一致），
     但多给了 tabWidth / useTabs 两个控件（任务书要求的）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('sql-prettify');

  var KEYWORD_CASES = ['upper', 'lower', 'preserve'];
  var INDENT_STYLES = ['standard', 'tabularLeft', 'tabularRight'];

  /** 库里 supportedDialects 没读到时的兜底（覆盖 sql-formatter 4.x 的全部方言） */
  var FALLBACK_DIALECTS = [
    'bigquery', 'db2', 'hive', 'mariadb', 'mysql', 'n1ql', 'plsql',
    'postgresql', 'redshift', 'singlestoredb', 'snowflake', 'spark',
    'sqlite', 'sql', 'transactsql', 'trino', 'tsql'
  ];

  /**
   * 方言 → 下拉框里显示的名字。
   * 显示名走 i18n，键名（dialect 的取值）是内部标识，不翻译。
   */
  var DIALECT_LABELS = {
    bigquery: t('dialect_bigquery', 'GCP BigQuery'),
    db2: t('dialect_db2', 'IBM DB2'),
    hive: t('dialect_hive', 'Apache Hive'),
    mariadb: t('dialect_mariadb', 'MariaDB'),
    mysql: t('dialect_mysql', 'MySQL'),
    n1ql: t('dialect_n1ql', 'Couchbase N1QL'),
    plsql: t('dialect_plsql', 'Oracle PL/SQL'),
    postgresql: t('dialect_postgresql', 'PostgreSQL'),
    redshift: t('dialect_redshift', 'Amazon Redshift'),
    singlestoredb: t('dialect_singlestoredb', 'SingleStoreDB'),
    snowflake: t('dialect_snowflake', 'Snowflake'),
    spark: t('dialect_spark', 'Spark'),
    sqlite: t('dialect_sqlite', 'SQLite'),
    sql: t('dialect_sql', 'Standard SQL'),
    transactsql: t('dialect_transactsql', 'SQL Server Transact-SQL'),
    trino: t('dialect_trino', 'Trino'),
    tsql: t('dialect_tsql', 'T-SQL (alias of transactsql)')
  };

  /**
   * 支持的方言列表。直接问库要，库没挂上就退回兜底表。
   * @returns {string[]}
   */
  function supportedDialects() {
    var list = window.sqlFormatter && sqlFormatter.supportedDialects;
    if (Array.isArray(list) && list.length) return list.slice();
    return FALLBACK_DIALECTS.slice();
  }

  /**
   * 归一化配置。非法值一律抛错而不是让库静默降级。
   * @param {{language?: string, keywordCase?: string, indentStyle?: string,
   *          tabWidth?: number, useTabs?: boolean, tabulateAlias?: boolean}} [opts]
   */
  function normalizeOptions(opts) {
    opts = opts || {};
    var dialects = supportedDialects();

    var language = opts.language === undefined ? 'sql' : opts.language;
    if (dialects.indexOf(language) === -1) {
      throw new Error(t('err_dialect', 'Unsupported SQL dialect: {lang} (supported: {list})')
        .replace('{lang}', language).replace('{list}', dialects.join(', ')));
    }
    var keywordCase = opts.keywordCase === undefined ? 'upper' : opts.keywordCase;
    if (KEYWORD_CASES.indexOf(keywordCase) === -1) {
      throw new Error(t('err_keyword_case', 'Unknown keywordCase: {case} (supported: {list})')
        .replace('{case}', keywordCase).replace('{list}', KEYWORD_CASES.join(', ')));
    }
    var indentStyle = opts.indentStyle === undefined ? 'standard' : opts.indentStyle;
    if (INDENT_STYLES.indexOf(indentStyle) === -1) {
      throw new Error(t('err_indent_style', 'Unknown indentStyle: {style} (supported: {list})')
        .replace('{style}', indentStyle).replace('{list}', INDENT_STYLES.join(', ')));
    }

    var tabWidth = opts.tabWidth === undefined ? 2 : opts.tabWidth;
    if (!(tabWidth >= 0) || tabWidth > 10) tabWidth = 2;

    return {
      language: language,
      keywordCase: keywordCase,
      indentStyle: indentStyle,
      tabWidth: Math.floor(tabWidth),
      useTabs: opts.useTabs === true,
      tabulateAlias: opts.tabulateAlias !== false,   // 参考实现固定 true
      linesBetweenQueries: opts.linesBetweenQueries
    };
  }

  /**
   * 主函数：原始 SQL → 格式化后的 SQL。空输入返回空串，非法输入抛错。
   * @param {string} sql
   * @param {object} [opts]
   * @returns {string}
   */
  function formatSql(sql, opts) {
    var src = sql === null || sql === undefined ? '' : String(sql);
    if (src.trim() === '') return '';
    var cfg = normalizeOptions(opts);
    if (cfg.linesBetweenQueries === undefined) delete cfg.linesBetweenQueries;
    var out = sqlFormatter.format(src, cfg);
    return typeof out === 'string' ? out : '';
  }

  /* ---------- UI ---------- */

  window.ItTools.register('sql-prettify', function (root) {
    var DEFAULT_SQL = 'select field1,field2,field3 from my_table where my_condition;';  // 参考实现的默认输入

    // 原版这两个框是 monospace 的
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 12, spellcheck: 'false', placeholder: t('input_ph', 'Put your SQL query here...')
    });
    input.value = DEFAULT_SQL;
    var output = U.codeBlock();
    var error = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });

    function selectOf(options, initial) {
      var sel = D.h('select.layui-select');
      options.forEach(function (o) {
        sel.appendChild(D.h('option', { value: o[0], text: o[1] }));
      });
      sel.value = initial;
      return sel;
    }

    var dialectSelect = selectOf(supportedDialects().map(function (d) {
      return [d, DIALECT_LABELS[d] || d];
    }), 'sql');
    var caseSelect = selectOf(KEYWORD_CASES.map(function (c) {
      return [c, {
        upper: t('case_upper', 'UPPERCASE'),
        lower: t('case_lower', 'lowercase'),
        preserve: t('case_preserve', 'Preserve')
      }[c]];
    }), 'upper');
    var styleSelect = selectOf(INDENT_STYLES.map(function (s) {
      return [s, {
        standard: t('style_standard', 'Standard'),
        tabularLeft: t('style_tabular_left', 'Tabular left'),
        tabularRight: t('style_tabular_right', 'Tabular right')
      }[s]];
    }), 'standard');
    var tabWidthSelect = selectOf([['2', '2'], ['4', '4'], ['8', '8']], '2');
    var useTabsInput = D.h('input', { type: 'checkbox' });

    function render() {
      D.clear(error);
      try {
        output.value = formatSql(input.value, {
          language: dialectSelect.value,
          keywordCase: caseSelect.value,
          indentStyle: styleSelect.value,
          tabWidth: Number(tabWidthSelect.value),
          useTabs: useTabsInput.checked
        });
      } catch (e) {
        output.value = '';
        error.textContent = t('err_format', 'SQL formatting failed. {error}')
          .replace('{error}', e && e.message ? e.message : e);
      }
    }

    var offs = [
      D.on(input, 'input', render),
      D.on(dialectSelect, 'change', render),
      D.on(caseSelect, 'change', render),
      D.on(styleSelect, 'change', render),
      D.on(tabWidthSelect, 'change', render),
      D.on(useTabsInput, 'change', render)
    ];

    /**
     * 一列选项：标签在上、控件在下，各占一份宽度。
     * U.field 默认就是「标签在上」的写法，跟原版 c-select 的
     * labelPosition='top'（标签在控件上面一行、左对齐）一致。
     */
    function optionColumn(labelText, select) {
      return D.h('div', { style: { flex: '1 1 0', minWidth: '0' } },
        U.field(labelText, select));
    }

    // 原版选项区是 `flex gap-2` 的一行，几个 c-select 并排、标签都在各自
    // 下拉框的上面一行，各占一份宽度（flex-1）。原版三个，我们多一个
    // 「Tab width」，四个下拉框并排一行。
    var optionsRow = D.h('div', { style: { display: 'flex', gap: '8px' } },
      optionColumn(t('dialect', 'Dialect'), dialectSelect),
      optionColumn(t('keyword_case', 'Keyword case'), caseSelect),
      optionColumn(t('indent_style', 'Indent style'), styleSelect),
      optionColumn(t('tab_width', 'Tab width'), tabWidthSelect)
    );

    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      optionsRow,
      D.h('div.switch-grid', null,
        D.h('label.switch', null, useTabsInput, D.h('span', { text: t('indent_with_tabs', 'Indent with tabs') }))),
      U.field(t('input', 'Your SQL query'), input),
      error
    ));
    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output', 'Prettify version of your query') }),
      output.card
    ));
    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['sql-prettify'] = {
    KEYWORD_CASES: KEYWORD_CASES,
    INDENT_STYLES: INDENT_STYLES,
    DIALECT_LABELS: DIALECT_LABELS,
    supportedDialects: supportedDialects,
    normalizeOptions: normalizeOptions,
    formatSql: formatSql,
    __cases: function (assert) {
      /* ---- 方言列表来自库本身 ---- */
      assert(Array.isArray(supportedDialects()), 'supportedDialects 返回数组');
      assert(supportedDialects().length >= 13, 'sql-formatter 4.x 至少 13 个方言，实际 ' + supportedDialects().length + ' 个');
      ['sql', 'mysql', 'postgresql', 'tsql', 'transactsql', 'bigquery', 'plsql', 'redshift', 'sqlite', 'spark']
        .forEach(function (d) {
          assert(supportedDialects().indexOf(d) !== -1, '下拉框里应该有 ' + d);
        });
      assert.eq(sqlFormatter.dialects, undefined, '任务书猜的 sqlFormatter.dialects 实际不存在，列表在 supportedDialects 上');

      /* ---- 正常值 ---- */
      assert.eq(formatSql('select field1,field2,field3 from my_table where my_condition;'),
        'SELECT\n  field1,\n  field2,\n  field3\nFROM\n  my_table\nWHERE\n  my_condition;',
        '参考实现的默认输入（默认 sql 方言 + 关键字大写）');
      assert.eq(formatSql('select a,b from t where x=1', { language: 'postgresql' }),
        'SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1', 'PostgreSQL');
      assert.eq(formatSql('select a from b', { keywordCase: 'lower' }), 'select\n  a\nfrom\n  b', '关键字小写');
      assert.eq(formatSql('select a from b', { keywordCase: 'preserve' }), 'select\n  a\nfrom\n  b', '关键字保持原样');
      assert.eq(formatSql('SELECT a FROM b', { keywordCase: 'preserve' }), 'SELECT\n  a\nFROM\n  b', 'preserve 真的不动大小写');
      assert.eq(formatSql('select a from b', { tabWidth: 4 }), 'SELECT\n    a\nFROM\n    b', '缩进 4');
      assert.eq(formatSql('select a from b', { tabWidth: 99 }), 'SELECT\n  a\nFROM\n  b', '越界 tabWidth 回落到 2');
      assert.eq(formatSql('select a from b', { useTabs: true }), 'SELECT\n\ta\nFROM\n\tb', '用 tab 缩进');
      assert(formatSql('select a from b', { indentStyle: 'tabularLeft' }) !== formatSql('select a from b', { indentStyle: 'standard' }),
        'tabularLeft 与 standard 输出不同');
      assert(formatSql('select a from b', { indentStyle: 'tabularRight' }) !== formatSql('select a from b', { indentStyle: 'standard' }),
        'tabularRight 与 standard 输出不同');
      // 每个方言都得能跑通，别只测一个
      supportedDialects().forEach(function (d) {
        var out;
        try { out = formatSql('select a from b where c = 1', { language: d }); } catch (e) { out = 'ERR ' + e.message; }
        assert(/SELECT/.test(out), '方言 ' + d + ' 应能格式化，实际 ' + JSON.stringify(out));
      });

      /* ---- 边界 ---- */
      assert.eq(formatSql(''), '', '空串');
      assert.eq(formatSql('   \n '), '', '纯空白');
      assert.eq(formatSql(null), '', 'null 输入');
      assert.eq(formatSql('select 1'), 'SELECT\n  1', '单条简单语句');
      assert.eq(formatSql('blah blah blah'), 'blah blah blah', '完全不是 SQL：库原样返回，不报错');
      assert.eq(formatSql('select * from'), 'SELECT\n  *\nFROM', '不完整的语句也不报错');

      /* ---- 错误输入 ---- */
      var badLang = false;
      try { formatSql('select 1', { language: 'nope' }); } catch (e) { badLang = true; }
      assert(badLang, '未知方言应抛错');
      var badCase = false;
      try { formatSql('select 1', { keywordCase: 'nope' }); } catch (e) { badCase = true; }
      assert(badCase, '未知 keywordCase 应抛错（库自己会静默降级成 preserve，所以得我们拦）');
      var badStyle = false;
      try { formatSql('select 1', { indentStyle: 'nope' }); } catch (e) { badStyle = true; }
      assert(badStyle, '未知 indentStyle 应抛错');

      /* ---- normalizeOptions ---- */
      assert.eq(normalizeOptions(), { language: 'sql', keywordCase: 'upper', indentStyle: 'standard', tabWidth: 2, useTabs: false, tabulateAlias: true },
        '默认配置跟参考实现一致');
      assert.eq(normalizeOptions({ useTabs: true }).useTabs, true, 'useTabs 透传');
      assert.eq(normalizeOptions({ tabWidth: 8 }).tabWidth, 8, 'tabWidth 透传');
      assert.eq(normalizeOptions({ language: 'mysql' }).language, 'mysql', 'language 透传');
    }
  };
})();