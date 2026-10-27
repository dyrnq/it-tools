/* ==========================================================================
   Crontab 表达式生成 / 解析（crontab-generator）

   把 cron 表达式翻译成自然语言，同时校验合法性，并附一张语法速查表。

   参考实现：src/tools/crontab-generator/（it-tools, GPLv3）
   与原版的差别：
   · 原版只输出英文（cronstrue 的语言包没加载）。这里按页面语言自动选 locale，
     并在页面上给一个语言下拉，让用户能随时切。
   · 原版的校验开关是 `alias: true`，但 cron-validator 的 alias 只管「月份/星期缩写」
     （jan/mon），**不管** @daily 这类简写；而它 vendored 的 cronstrue 也没有 useAlias，
     于是 @daily 两边都处理不了。这里照旧如实报「无法解析」，
     但速查表仍然列出这些简写（跟原版一致），让用户知道它们存在。
   · 原版没开 allowSevenAsSunday，导致 `0 0 * * 7`（Vixie cron 允许 7 表示周日）
     被判无效。这里打开 —— 8 及以上仍然拒绝。
   · 原版把 cronstrue 的输出直接丢进模板，没有兜底。cronstrue 抛的是**字符串**不是
     Error（e.message 是 undefined），所以这里统一用 String(e) 取信息。
   · 说明：原版没有「自然语言描述 → 表达式」这个功能（方向是反的：表达式 → 描述）。
     速查表每一行上的 "Use" 按钮把该行的等价表达式填回输入框，就是这个工具里
     「一键得到表达式」的入口。randexp 属于 regex-tester（生成随机样本串），与本工具无关。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('crontab-generator');

  var DEFAULT_EXPRESSION = '40 * * * *';

  /** 速查表：与参考实现逐条一致。 */
  var HELPERS = [
    { symbol: '*', meaning: t('meaning_star', 'Any value'), example: '* * * *', equivalent: t('equivalent_star', 'Every minute') },
    { symbol: '-', meaning: t('meaning_dash', 'Range of values'), example: '1-10 * * *', equivalent: t('equivalent_dash', 'Minutes 1 through 10') },
    { symbol: ',', meaning: t('meaning_comma', 'List of values'), example: '1,10 * * *', equivalent: t('equivalent_comma', 'At minutes 1 and 10') },
    { symbol: '/', meaning: t('meaning_slash', 'Step values'), example: '*/10 * * *', equivalent: t('equivalent_slash', 'Every 10 minutes') },
    { symbol: '@yearly', meaning: t('meaning_at_yearly', 'Once every year at midnight of 1 January'), example: '@yearly', equivalent: '0 0 1 1 *' },
    { symbol: '@annually', meaning: t('meaning_at_annually', 'Same as @yearly'), example: '@annually', equivalent: '0 0 1 1 *' },
    { symbol: '@monthly', meaning: t('meaning_at_monthly', 'Once a month at midnight on the first day'), example: '@monthly', equivalent: '0 0 1 * *' },
    { symbol: '@weekly', meaning: t('meaning_at_weekly', 'Once a week at midnight on Sunday morning'), example: '@weekly', equivalent: '0 0 * * 0' },
    { symbol: '@daily', meaning: t('meaning_at_daily', 'Once a day at midnight'), example: '@daily', equivalent: '0 0 * * *' },
    { symbol: '@midnight', meaning: t('meaning_at_midnight', 'Same as @daily'), example: '@midnight', equivalent: '0 0 * * *' },
    { symbol: '@hourly', meaning: t('meaning_at_hourly', 'Once an hour at the beginning of the hour'), example: '@hourly', equivalent: '0 * * * *' },
    { symbol: '@reboot', meaning: t('meaning_at_reboot', 'Run at startup'), example: '', equivalent: '' }
  ];

  /** 页面语言 → cronstrue 的 locale 名。cronstrue 只认精确名，别的一律静默退回英文。 */
  var LOCALES = [
    { value: 'en', label: t('locale_en', 'English') },
    { value: 'zh_CN', label: t('locale_zh_cn', 'Simplified Chinese') }
  ];

  var FIELD_LAYOUT =
    '┌──────────── [optional] seconds (0 - 59)\n' +
    '| ┌────────── minute (0 - 59)\n' +
    '| | ┌──────── hour (0 - 23)\n' +
    '| | | ┌────── day of month (1 - 31)\n' +
    '| | | | ┌──── month (1 - 12) OR jan,feb,mar,apr ...\n' +
    '| | | | | ┌── day of week (0 - 6, sunday=0) OR sun,mon ...\n' +
    '| | | | | |\n' +
    '* * * * * * command';

  /**
   * 推断页面语言。
   * @param {Document} [doc]
   * @param {Object} [i18nBundle] window.__IT_TOOLS_I18N__
   * @returns {'en'|'zh_CN'}
   */
  function detectCronLocale(doc, i18nBundle) {
    var lang = (doc && doc.documentElement && doc.documentElement.lang) || '';
    if (/^zh/i.test(lang)) return 'zh_CN';
    if (lang) return 'en';

    // <html lang> 缺失时的退路：拿语言包里已知会变的文案来嗅探。
    // en.yml / zh-CN.yml 的 ui.home 分别是 Home / 首页。
    var ui = i18nBundle || {};
    var probes = [ui.home, ui.search, ui.language, ui.about, ui.no_results];
    for (var i = 0; i < probes.length; i++) {
      if (typeof probes[i] === 'string' && /[一-鿿]/.test(probes[i])) return 'zh_CN';
    }
    return 'en';
  }

  /**
   * cron-validator 的校验选项。
   *
   * 说明：
   * · alias —— 只影响月份/星期缩写（jan、mon），不负责 @daily 这类简写；
   * · allowBlankDay —— 放行 Quartz 的 `?`；
   * · seconds —— 允许 6 段（带秒）；
   * · allowSevenAsSunday —— 放行 `7` 表示周日（Vixie cron 的老写法）。
   *
   * 归一化前后必须用**同一套**选项，否则「归一化说合法、校验说不合法」会打架。
   */
  var VALIDATOR_OPTIONS = {
    allowBlankDay: true,
    alias: true,
    seconds: true,
    allowSevenAsSunday: true
  };

  /** 直接问 cron-validator（不做任何预处理）。 */
  function isValidCronRaw(expr) {
    return window.cronValidator.isValidCron(expr, VALIDATOR_OPTIONS);
  }

  /**
   * 抹掉「复制粘贴带出来的杂质」，返回 cron-validator 认的那一种写法。
   *
   * 常见的两种：
   * · 多余的空白 —— `*  *  *  *  *`、列表里的 `1, 2, 3`；
   * · 步长被空格拆开 —— `* /10`（有些编辑器、网页、聊天软件会把斜杠前原本紧贴的
   *   星号和斜杠拆开显示）。
   *
   * 找不到能通过校验的写法就返回压缩过的版本，让报错信息对着用户输入说。
   * （上游 #1882 的做法，这里照搬。）
   *
   * @param {string} expr
   * @returns {string}
   */
  function normalizeCron(expr) {
    if (typeof expr !== 'string') return '';
    var compact = expr.trim().replace(/\s+/g, ' ').replace(/,\s+/g, ',');
    if (isValidCronRaw(compact)) return compact;
    // '* /10 * * * *' -> '*/10 * * * *'
    var merged = compact.replace(/\s+(\/\S+)/g, '$1');
    if (isValidCronRaw(merged)) return merged;
    return compact;
  }

  /**
   * 合法性校验（cron-validator）。
   *
   * @param {string} expr
   * @returns {boolean} 非字符串一律判 false（底层会对 null 调 .trim 而炸）
   */
  function isCronValid(expr) {
    if (typeof expr !== 'string') return false;
    return isValidCronRaw(normalizeCron(expr));
  }

  /** 组装 cronstrue 的配置。 */
  function cronstrueOptions(opts) {
    opts = opts || {};
    return {
      verbose: opts.verbose !== false,
      use24HourTimeFormat: opts.use24HourTimeFormat !== false,
      dayOfWeekStartIndexZero: opts.dayOfWeekStartIndexZero !== false,
      locale: opts.locale === 'zh_CN' ? 'zh_CN' : 'en',
      throwExceptionOnParseError: true
    };
  }

  /**
   * 翻译成自然语言。
   * @param {string} expr
   * @param {Object} [opts] {locale, verbose, use24HourTimeFormat, dayOfWeekStartIndexZero}
   * @returns {{ok:boolean, text:string, error:string}} error 形如 'empty' / 'unparsable'
   */
  function describeCron(expr, opts) {
    if (typeof expr !== 'string' || !expr.trim()) return { ok: false, text: '', error: 'empty' };
    try {
      // 描述也走归一化后的表达式 —— 否则 `* /10` 会被 cronstrue 当成 6 段而抛错。
      return { ok: true, text: window.cronstrue.toString(normalizeCron(expr), cronstrueOptions(opts)), error: '' };
    } catch (e) {
      // cronstrue 抛的是字符串，e.message 是 undefined，必须 String(e)
      return { ok: false, text: '', error: 'unparsable', message: String(e) };
    }
  }

  /**
   * 一次算完「合法性 + 自然语言」。
   *
   * 为什么要分开判：cron-validator 与 cronstrue 对同一串的判断并不总是一致 ——
   * `0 0 L * *`（Quartz 的「当月最后一天」）cronstrue 能描述，cron-validator 不认。
   * 这时不让它显示「无效」就完事，而是仍然给出描述，同时用 relaxed 标出让用户知道
   * 两个库的判断有分歧。
   *
   * @param {string} expr
   * @param {Object} [opts] 同 describeCron
   * @returns {{raw:string, empty:boolean, valid:boolean, relaxed:boolean, text:string, message:string}}
   */
  function analyzeCron(expr, opts) {
    var raw = typeof expr === 'string' ? expr.trim() : '';
    if (!raw) {
      return { raw: '', empty: true, valid: false, relaxed: false, text: '', message: '' };
    }
    var valid = isCronValid(raw);
    var described = describeCron(raw, opts);
    return {
      raw: raw,
      empty: false,
      valid: valid,
      // 校验器说不合法、但描述得出来 → 两个库判断不一致
      relaxed: !valid && described.ok,
      text: described.ok ? described.text : '',
      message: described.ok ? '' : (described.message || '')
    };
  }

  window.ItTools.register('crontab-generator', function (root) {
    var opts = {
      locale: detectCronLocale(window.document, window.__IT_TOOLS_I18N__),
      verbose: true,
      use24HourTimeFormat: true,
      dayOfWeekStartIndexZero: true
    };

    var input = D.h('input.layui-input', {
      value: DEFAULT_EXPRESSION,
      spellcheck: 'false',
      placeholder: '* * * * *',
      'aria-label': t('aria_cron_expression', 'Cron expression'),
      style: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '22px',
        textAlign: 'center'
      }
    });

    var localeSelect = D.h('select.layui-select', null, LOCALES.map(function (l) {
      return D.h('option', { value: l.value, text: l.label, selected: l.value === opts.locale });
    }));

    var descCard = D.outputCard(t('output_description', 'Description'));
    var badge = D.h('span.badge-note', { text: '' });
    var note = D.h('p.field-hint');

    /**
     * 选项区的一行：标签在**左边**、170px、**右对齐**，控件紧跟在标签列右边。
     *
     * 原版这里是 `<n-form :show-feedback="false" label-width="170" label-placement="left">`，
     * 里面三个 n-form-item（Verbose / Use 24 hour time format / Days start at 0）
     * 的标签都在左边。实测原版：标签列 170px、文字右对齐，标签框自带 12px
     * 右内边距，控件正好从标签列的右边缘开始。
     *
     * .field-row 的默认标签列是 120px、行内间距 12px。这里把标签列换成 170px，
     * 再把行内间距清零、把这 12px 挪到标签自己的 padding-right ——
     * 这样标签列宽度和控件的起始位置都跟原版一致。
     *
     * @param {string} labelText
     * @param {Node} control
     * @param {string} [labelFor] 控件的 id（写进标签的 for）
     */
    function optionRow(labelText, control, labelFor) {
      return D.h('div.field-row', { style: { '--field-label-width': '170px', gap: '0' } },
        D.h('label.field-label', { text: labelText, for: labelFor, style: { paddingRight: '12px' } }),
        control);
    }

    /**
     * 一个开关。原版是 n-form-item（label-placement="left" label-width="170"）包着 n-switch：
     * 标签在左、170px、右对齐，开关在右边 —— 所以标签和开关得分成两个元素。
     */
    function toggle(key, label) {
      var boxId = 'cron-' + key;
      var box = D.h('input', { type: 'checkbox', id: boxId });
      box.checked = opts[key];
      box.addEventListener('change', function () { opts[key] = box.checked; render(); });
      return optionRow(label, D.h('label.switch', null, box, D.h('span')), boxId);
    }

    function render() {
      var a = analyzeCron(input.value, opts);
      D.clear(descCard.outputBody);
      badge.textContent = a.empty
        ? t('badge_empty', 'Empty')
        : (a.valid ? t('badge_valid', 'Valid cron expression') : t('badge_invalid', 'Invalid cron expression'));
      badge.style.color = a.valid ? '' : (a.relaxed ? '' : 'var(--danger, #d93025)');

      if (a.empty) {
        D.clear(note);
        note.appendChild(D.h('span', { text: t('note_empty', 'Type a cron expression above to get a human readable description.') }));
        return;
      }
      if (a.relaxed) {
        D.clear(note).appendChild(D.h('span', {
          text: t('note_relaxed', 'The bundled validator rejects this expression (Quartz-only specifiers such as L / W / # are not in its grammar), but the description below was produced successfully.')
        }));
      } else if (!a.valid) {
        D.clear(note).appendChild(D.h('span', {
          text: a.message || t('note_invalid_layout', 'Check the field layout: it expects 5 fields, or 6 when seconds are enabled.')
        }));
      } else {
        D.clear(note);
      }
      descCard.outputBody.textContent = a.text;
    }

    var helperBody = D.h('tbody');
    HELPERS.forEach(function (h) {
      var fill = h.example || h.equivalent;
      helperBody.appendChild(D.h('tr', null,
        D.h('td', null, D.h('strong', { text: h.symbol })),
        D.h('td', { text: h.meaning }),
        D.h('td', null, D.h('code', { text: h.example })),
        D.h('td', { text: h.equivalent }),
        D.h('td', null, fill
          ? D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
            type: 'button',
            text: t('use', 'Use'),
            title: t('use_title', 'Fill the expression of this row into the input box: {expr}').replace('{expr}', fill),
            onclick: function () { input.value = fill; render(); }
          })
          : D.h('span.field-hint', { text: '—' }))
      ));
    });

    var off = D.on(input, 'input', render);
    var offLocale = D.on(localeSelect, 'change', function () {
      opts.locale = localeSelect.value === 'zh_CN' ? 'zh_CN' : 'en';
      render();
    });

    root.appendChild(D.h('div.card', null,
      U.field(t('label_cron_expression', 'Cron expression'), input, { wide: true, hint: t('hint_field_layout', '5 fields = minute hour day month weekday; with 6 fields the first one is seconds') }),
      descCard,
      // 原版：cron 表达式 → cron 说明 → 分隔线 → 开关组
      U.divider(),
      // 选项区（原版的 n-form + 三个 n-form-item）：标签一律在左、170px、右对齐。
      // 「Description language」是本移植版自己加的下拉，也放进同一列，免得两行标签对不齐。
      optionRow(t('label_description_language', 'Description language'), localeSelect),
      toggle('verbose', t('toggle_verbose', 'Verbose')),
      toggle('use24HourTimeFormat', t('toggle_24h', 'Use 24 hour time format')),
      toggle('dayOfWeekStartIndexZero', t('toggle_day_start_zero', 'Days start at 0 (Sunday)')),
      D.h('div', { style: { marginTop: '10px' } }, badge),
      note
    ));

    root.appendChild(D.h('div.card', null,
      // white-space: pre 是必须的：这张图是定宽的 ASCII 图（框线对齐的），
      // 一旦折行就对不齐了。.mono-output 默认是 pre-wrap（会把长行折起来），
      // 这里改成不折 + overflow:auto —— 窄屏上出横向滚动条，图还保持原样。
      // 原版（Vue）就是这个排法：它的 <pre> 是 white-space:pre; overflow-x:auto。
      D.h('pre.mono-output', { text: FIELD_LAYOUT, style: { whiteSpace: 'pre', overflow: 'auto', margin: '0 0 16px' } }),
      D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_symbol', 'Symbol') }),
          D.h('th', { text: t('col_meaning', 'Meaning') }),
          D.h('th', { text: t('col_example', 'Example') }),
          D.h('th', { text: t('col_equivalent', 'Equivalent') }),
          D.h('th', { text: '' })
        )),
        helperBody
      )
    ));

    render();

    return {
      destroy: function () {
        off();
        offLocale();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['crontab-generator'] = {
    HELPERS: HELPERS,
    LOCALES: LOCALES,
    FIELD_LAYOUT: FIELD_LAYOUT,
    detectCronLocale: detectCronLocale,
    normalizeCron: normalizeCron,
    isCronValid: isCronValid,
    cronstrueOptions: cronstrueOptions,
    describeCron: describeCron,
    analyzeCron: analyzeCron,
    __cases: function (assert) {
      /* ---- 合法性 ---- */
      assert(isCronValid('* * * * *') === true, '每分钟');
      assert(isCronValid('40 * * * *') === true, '每小时第 40 分');
      assert(isCronValid('*/5 * * * *') === true, '每 5 分钟');
      assert(isCronValid('0 0 1 1 *') === true, '元旦零点');
      assert(isCronValid('0 0 * * MON-FRI') === true, '星期缩写 alias');
      assert(isCronValid('0 0 * jan-mar *') === true, '月份缩写 alias');
      assert(isCronValid('0 0 ? * 1') === true, 'allowBlankDay 放行 Quartz 的 ?');
      assert(isCronValid('* * * * * *') === true, '秒级 6 段');
      assert(isCronValid('0 0 * * 7') === true, 'allowSevenAsSunday：7 表示周日');

      // 非法
      assert(isCronValid('') === false, '空串非法');
      assert(isCronValid('   ') === false, '纯空白非法');
      assert(isCronValid('* * * *') === false, '只有 4 段');
      assert(isCronValid('60 * * * *') === false, '分钟不能到 60');
      assert(isCronValid('99 * * * *') === false, '分钟不能到 99');
      assert(isCronValid('* * * * 8') === false, '星期不能到 8');
      assert(isCronValid('invalid') === false, '垃圾串非法');
      assert(isCronValid('@daily') === false, 'cron-validator 的 alias 不管 @daily 简写');
      assert(isCronValid(null) === false, 'null 不炸且判非法');
      assert(isCronValid(undefined) === false, 'undefined 不炸且判非法');
      assert(isCronValid(42) === false, '数字不炸且判非法');
      assert(isCronValid('*  *  *  *  *') === true, '多空格照旧按单空格切');

      /* ---- 复制粘贴带出来的杂质（上游 #1882） ---- */
      assert(isCronValid('* /10 * * * *') === true, '步长被空格拆开也认');
      assert(isCronValid('1, 2, 3 * * * *') === true, '列表里的空格也认');
      assert.eq(normalizeCron('* /10 * * * *'), '*/10 * * * *', '归一化把 * /10 并回 */10');
      assert.eq(normalizeCron('1, 2, 3 * * * *'), '1,2,3 * * * *', '归一化去掉列表里的空格');
      assert.eq(normalizeCron('  0   0  * * *  '), '0 0 * * *', '归一化压缩多余空白');
      assert.eq(normalizeCron('garbage'), 'garbage', '认不出来的原样返回');
      assert.eq(normalizeCron(null), '', '非字符串返回空串');
      var dp = describeCron('* /10 * * * *', { locale: 'en' });
      assert(dp.ok === true, '带杂质的表达式也能翻译');
      assert(dp.text.indexOf('10') >= 0, '描述里看得到步长：' + dp.text);

      /* ---- 自然语言 ---- */
      var d = describeCron('40 * * * *', { locale: 'en' });
      assert(d.ok === true, '合法表达式能翻译');
      assert.eq(d.text, 'At 40 minutes past the hour, every hour, every day', '英文描述');

      d = describeCron('40 * * * *', { locale: 'zh_CN' });
      assert(d.ok === true, '中文 locale 能翻译');
      assert(d.text.indexOf('每') >= 0, '中文描述走的是 zh_CN 语言包：' + d.text);

      d = describeCron('40 * * * *', { locale: 'zh_CN', verbose: false });
      assert.eq(d.text, '在每小时的第 40 分钟', 'verbose 关掉后只剩主要描述');

      d = describeCron('40 * * * *', { locale: 'en', use24HourTimeFormat: true });
      assert.eq(d.text, 'At 40 minutes past the hour, every hour, every day', '24 小时制');
      d = describeCron('40 * * * *', { locale: 'en', use24HourTimeFormat: false });
      assert.eq(d.text, 'At 40 minutes past the hour, every hour, every day', '12 小时制下这句没差别');

      d = describeCron('0 0 * * *', { locale: 'en', use24HourTimeFormat: true });
      assert.eq(d.text, 'At 00:00, every day', '24 小时制 → 00:00');
      d = describeCron('0 0 * * *', { locale: 'en', use24HourTimeFormat: false });
      assert.eq(d.text, 'At 12:00 AM, every day', '12 小时制 → 12:00 AM');

      // 星期起始值
      d = describeCron('0 0 * * 0', { locale: 'en', dayOfWeekStartIndexZero: true });
      assert.eq(d.text, 'At 00:00, only on Sunday', '0 = 周日');
      d = describeCron('0 0 * * 1', { locale: 'en', dayOfWeekStartIndexZero: true });
      assert.eq(d.text, 'At 00:00, only on Monday', '1 = 周一');

      // 秒级
      d = describeCron('30 0 9 * * 1-5', { locale: 'en' });
      assert(d.ok === true, '6 段表达式能翻译');
      assert.eq(d.text, 'At 09:00:30, Monday through Friday', '秒级描述带秒');

      /* ---- 错误输入不抛 ---- */
      d = describeCron('', { locale: 'en' });
      assert.eq(d, { ok: false, text: '', error: 'empty' }, '空串 → empty');
      d = describeCron('   ', { locale: 'en' });
      assert.eq(d.error, 'empty', '纯空白 → empty');
      d = describeCron('bad', { locale: 'en' });
      assert(d.ok === false, '垃圾串解不出来');
      assert.eq(d.error, 'unparsable', '垃圾串 → unparsable');
      // cronstrue 抛的是字符串：e.message 是 undefined，这里必须取得到信息
      assert(typeof d.message === 'string' && d.message.length > 0, '抛出的字符串能被 String(e) 读到：' + d.message);
      d = describeCron(null);
      assert.eq(d.error, 'empty', 'null → empty 而不是抛错');
      d = describeCron(42);
      assert.eq(d.error, 'empty', '非字符串当空处理（底层对数字调 .trim 会炸）');

      /* ---- 两个库判断不一致的情况 ---- */
      var a = analyzeCron('0 0 L * *', { locale: 'en' });
      assert.eq(a.valid, false, 'Quartz 的 L cron-validator 不认');
      assert.eq(a.relaxed, true, '但 cronstrue 描述得出来 → 标记 relaxed');
      assert(a.text.length > 0, '仍然给出描述');

      a = analyzeCron('nope', { locale: 'en' });
      assert.eq(a.valid, false, '非法表达式 invalid');
      assert.eq(a.relaxed, false, '两边都过不了');
      assert.eq(a.text, '', '没有描述');

      a = analyzeCron('', { locale: 'en' });
      assert.eq(a.empty, true, '空串是 empty 而不是 invalid');
      assert.eq(a.valid, false, '空串不算合法');

      a = analyzeCron('   * * * *   ', { locale: 'en' });
      assert.eq(a.raw, '* * * *', '首尾空白被裁掉');
      assert.eq(a.valid, false, '4 段仍然非法');

      a = analyzeCron('0 0 * * 7', { locale: 'en' });
      assert.eq(a.valid, true, '7=周日 通过校验（allowSevenAsSunday）');
      assert.eq(a.relaxed, false, '合法且描述得出来 → 不是 relaxed');

      /* ---- locale 推断 ---- */
      var fakeDoc = function (lang) { return { documentElement: { lang: lang } }; };
      assert.eq(detectCronLocale(fakeDoc('zh-CN'), {}), 'zh_CN', 'html lang=zh-CN → zh_CN');
      assert.eq(detectCronLocale(fakeDoc('zh'), {}), 'zh_CN', 'html lang=zh → zh_CN');
      assert.eq(detectCronLocale(fakeDoc('en'), {}), 'en', 'html lang=en → en');
      assert.eq(detectCronLocale(fakeDoc('fr-FR'), {}), 'en', '未收录的语言 → en');
      assert.eq(detectCronLocale(fakeDoc(''), {}), 'en', 'html lang 为空且无语言包 → en');
      assert.eq(detectCronLocale(fakeDoc(''), { home: '首页' }), 'zh_CN', '退回嗅探语言包：中文');
      assert.eq(detectCronLocale(fakeDoc(''), { home: 'Home' }), 'en', '退回嗅探语言包：英文');
      assert.eq(detectCronLocale(fakeDoc(undefined), null), 'en', '连 document 都没有也不炸');
      // cronstrue 只认精确 locale 名，别的名字会静默退回英文，所以这里只给两种
      assert.eq(cronstrueOptions({ locale: 'zh-cn' }).locale, 'en', '非精确名不会被透传');
      assert.eq(cronstrueOptions({}).locale, 'en', '缺省英文');

      /* ---- 速查表 ---- */
      assert.eq(HELPERS.length, 12, '速查表 12 条');
      assert.eq(HELPERS[0].example, '* * * *', '第一条 * 的示例');
      assert.eq(HELPERS[4].equivalent, '0 0 1 1 *', '@yearly 等价于 0 0 1 1 *');
      assert.eq(HELPERS[11].symbol, '@reboot', '最后一条是 @reboot');
      assert.eq(HELPERS[11].example, '', '@reboot 没有示例表达式');
      // 速查表里的等价表达式本身必须是合法的，否则表就骗人了
      HELPERS.forEach(function (h) {
        if (h.equivalent && /^[\d*/,?-]+/.test(h.equivalent)) {
          assert(isCronValid(h.equivalent) === true, '速查表里的等价表达式合法：' + h.equivalent);
        }
      });
    }
  };
})();