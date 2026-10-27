/* ==========================================================================
   邮箱地址规范化（email-normalizer）

   一行一个邮箱，输出规范形式：整体小写，并对 gmail / googlemail / hotmail /
   outlook / live 这几个域名套用它们各自的规则（去点、去 +tag、googlemail→gmail）。

   参考实现：src/tools/email-normalizer/（it-tools, GPLv3）
   与原版的差别：
   · 原版直接 import 原库 `email-normalizer`（没有二次封装），vendored 的也是同一个库，
     所以行为一致；这里只是把「传对象给库」这件事包在一个 try/catch 里，
     并逐行标注成败，原版则把错误行当成普通文本混在输出里。
   · 原版按 `\n` 切行后**不去空行**，一段文本末尾那个换行会产出一行
     "Unable to parse email: " —— 一条没有的邮箱凭空出现在结果里。这里跳过纯空行。
   · 原版只输出结果文本。这里额外列出「哪几行发生了变化」，否则用户看不出
     库里到底动了哪一段（去点？去 +tag？还是只是改了大小写）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('email-normalizer');

  /** 库里硬编码了规则的域名，列出来方便 UI 提示（不是库的导出，只能自己写一份）。 */
  var SPECIAL_DOMAINS = ['gmail.com', 'googlemail.com', 'hotmail.com', 'live.com', 'outlook.com'];

  /**
   * 库里唯一会抛的邮箱错误文案是 "Invalid email"，它会显示在结果表里，
   * 所以过一遍 i18n；别的异常（不该出现）原样透传。
   */
  function libraryError(message) {
    return message === 'Invalid email' ? t('err_invalid_email', 'Invalid email') : message;
  }

  /**
   * 规范化一个邮箱。
   *
   * ⚠ 库要的是**对象**：`normalizeEmail({email})`。传字符串进去不会报错，
   * 而是读 undefined.email 当成空串，最后统一抛 "Invalid email" —— 排查起来很费劲。
   *
   * @param {string} email
   * @returns {{input:string, ok:boolean, normalized:string, error:string, changed:boolean}}
   */
  function normalizeOne(email) {
    var raw = typeof email === 'string' ? email : '';
    var trimmed = raw.trim();
    if (!trimmed) return { input: raw, ok: false, normalized: '', error: t('err_empty_address', 'Empty address'), changed: false };
    try {
      var normalized = window.emailNormalizer.normalizeEmail({ email: raw });
      return {
        input: raw,
        ok: true,
        normalized: normalized,
        error: '',
        changed: normalized !== trimmed
      };
    } catch (e) {
      return {
        input: raw,
        ok: false,
        normalized: '',
        error: libraryError(String((e && e.message) || e)),
        changed: false
      };
    }
  }

  /**
   * 批量规范化：一行一个邮箱。
   *
   * 纯空行整条跳过（末尾换行不算一条邮箱）。非法行不中断整批，
   * 而是留在结果里标成 error —— 一批贴过来的地址里混进一行脏数据，
   * 不该让另外 99 行也看不到结果。
   *
   * @param {string} text
   * @returns {{items:Array, output:string, total:number, changed:number, unchanged:number, invalid:number, skipped:number}}
   */
  function normalizeEmails(text) {
    var lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
    var items = [];
    var skipped = 0;

    lines.forEach(function (line, index) {
      if (!line.trim()) { skipped++; return; }
      var r = normalizeOne(line);
      r.line = index + 1;
      items.push(r);
    });

    var changed = 0;
    var unchanged = 0;
    var invalid = 0;
    items.forEach(function (it) {
      if (!it.ok) invalid++;
      else if (it.changed) changed++;
      else unchanged++;
    });

    return {
      items: items,
      // 输出里保持与输入一一对应（除空行外）：非法行原样回显，方便对着改
      output: items.map(function (it) { return it.ok ? it.normalized : it.input; }).join('\n'),
      total: items.length,
      changed: changed,
      unchanged: unchanged,
      invalid: invalid,
      skipped: skipped
    };
  }

  window.ItTools.register('email-normalizer', function (root) {
    // 原版这个输入框是 monospace 的（c-input-text 的 monospace 属性）
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 6, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
      placeholder: t('input_ph', 'Put your emails here (one per line)...'),
      'aria-label': t('aria_input', 'Raw emails to normalize')
    });

    var outCard = D.outputCard(t('title_normalized', 'Normalized emails'));
    var summary = D.h('span.badge-note', { text: '' });
    var table = D.h('div');

    function render() {
      var r = normalizeEmails(input.value);
      outCard.outputBody.textContent = r.output;

      if (!r.total) {
        summary.textContent = t('no_email', 'No email');
        D.clear(table).appendChild(D.h('p.field-hint', { text: t('hint_one_per_line', 'Type one email per line above.') }));
        return;
      }

      summary.textContent = t('summary', '{total} email(s) · {changed} normalized · {unchanged} already normal · {invalid} invalid')
        .replace('{total}', r.total)
        .replace('{changed}', r.changed)
        .replace('{unchanged}', r.unchanged)
        .replace('{invalid}', r.invalid)
        + (r.skipped ? ' · ' + t('summary_skipped', '{count} blank line(s) skipped').replace('{count}', r.skipped) : '');

      D.clear(table);
      var interesting = r.items.filter(function (it) { return !it.ok || it.changed; });
      if (!interesting.length) {
        table.appendChild(D.h('p.field-hint', { text: t('hint_all_normal', 'Every address is already in its normalized form.') }));
        return;
      }

      var body = D.h('tbody');
      interesting.forEach(function (it) {
        body.appendChild(D.h('tr', null,
          D.h('td', { text: 'L' + it.line, style: { color: 'var(--text-muted)', whiteSpace: 'nowrap' } }),
          D.h('td.val', { text: it.input }),
          D.h('td', { text: '→', style: { color: 'var(--text-muted)' } }),
          D.h('td.val', {
            text: it.ok ? it.normalized : it.error,
            style: it.ok ? null : { color: 'var(--danger, #d93025)' }
          })
        ));
      });
      table.appendChild(D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_line', 'Line') }),
          D.h('th', { text: t('col_input', 'Input') }),
          D.h('th', { text: '' }),
          D.h('th', { text: t('col_result', 'Result') })
        )),
        body
      ));
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Raw emails to normalize'), input, {
        wide: true,
        hint: t('special_domains', 'Special-rule domains: {domains}')
          .replace('{domains}', SPECIAL_DOMAINS.join(t('domain_sep', ', ')))
      }),
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button',
          text: window.ItTools.i18n('clear', 'Clear'),
          onclick: function () { input.value = ''; render(); }
        }),
        U.copyButton(function () { return normalizeEmails(input.value).output; }, t('copy_normalized', 'Copy normalized emails'))
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', null, D.h('label.field-label', { text: t('summary_label', 'Summary') }), summary),
      outCard,
      table
    ));

    render();

    return {
      destroy: function () {
        off();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['email-normalizer'] = {
    SPECIAL_DOMAINS: SPECIAL_DOMAINS,
    normalizeOne: normalizeOne,
    normalizeEmails: normalizeEmails,
    __cases: function (assert) {
      /* ---- 单个：基础规范化 ---- */
      var r = normalizeOne('Test@GMX.com');
      assert.eq(r, { input: 'Test@GMX.com', ok: true, normalized: 'test@gmx.com', error: '', changed: true },
        '整体转小写');

      r = normalizeOne('  spaced@Example.com  ');
      assert.eq(r.normalized, 'spaced@example.com', '首尾空白被去掉');
      assert.eq(r.changed, true, '去掉空白算变化');
      assert.eq(r.input, '  spaced@Example.com  ', 'input 原样保留');

      r = normalizeOne('user.name@my-domain.io');
      assert.eq(r.normalized, 'user.name@my-domain.io', '不在特殊域名表里的地址只改大小写');
      r = normalizeOne('a+b@sub.domain.co.uk');
      assert.eq(r.normalized, 'a+b@sub.domain.co.uk', '非特殊域名的 +tag 保留');

      /* ---- 单个：各域名的专属规则 ---- */
      assert.eq(normalizeOne('a.b+tag@gmail.com').normalized, 'ab@gmail.com', 'gmail 去点 + 去 +tag');
      assert.eq(normalizeOne('First.Last+tag@GoogleMail.com').normalized, 'firstlast@gmail.com',
        'googlemail 去点 + 去 +tag + 域名改写成 gmail');
      assert.eq(normalizeOne('A.B+tag@hotmail.com').normalized, 'a.b@hotmail.com', 'hotmail 保留点、去 +tag');
      assert.eq(normalizeOne('a.b+tag@outlook.com').normalized, 'a.b@outlook.com', 'outlook 保留点、去 +tag');
      assert.eq(normalizeOne('a.b+tag@live.com').normalized, 'ab@live.com', 'live 去点、去 +tag');
      assert.eq(normalizeOne('Foo+bar@Yahoo.com').normalized, 'foo+bar@yahoo.com', 'yahoo 不在规则表里，+tag 保留');

      /* ---- 单个：已经规范 ---- */
      r = normalizeOne('user@example.com');
      assert.eq(r.changed, false, '本来就规范的地址标记为未变化');
      assert.eq(r.ok, true, '合法');

      /* ---- 单个：非法输入 ---- */
      r = normalizeOne('not-an-email');
      assert.eq(r.ok, false, '没有 @ 的判非法');
      assert.eq(r.error, 'Invalid email', '错误信息取自库');
      assert.eq(r.normalized, '', '非法时不产出结果');

      ['no-at-sign', '@example.com', 'a b@c.com', 'a@b', 'a@@b.com', 'a@b.c', '测试@example.com']
        .forEach(function (bad) {
          assert.eq(normalizeOne(bad).ok, false, '非法：' + bad);
        });

      // 边界：库里那条正则很松，双点域名是放行的，别自己加戏判它非法
      assert.eq(normalizeOne('a@b..com').normalized, 'a@b..com', '双点域名库里放行，照实转述');
      assert.eq(normalizeOne('a@b.co').normalized, 'a@b.co', '两字母 TLD 合法');

      r = normalizeOne('');
      assert.eq(r.ok, false, '空串非法');
      assert.eq(r.error, 'Empty address', '空串在调库之前就被挡掉');
      r = normalizeOne('   ');
      assert.eq(r.ok, false, '纯空白也当空');
      assert.eq(normalizeOne(null).ok, false, 'null 不炸');
      assert.eq(normalizeOne(undefined).ok, false, 'undefined 不炸');
      assert.eq(normalizeOne(42).ok, false, '数字不炸');

      /* ---- 批量 ---- */
      var b = normalizeEmails('Test@GMX.com\na.b+tag@gmail.com\nuser@example.com');
      assert.eq(b.items.map(function (x) { return x.line; }), [1, 2, 3], '行号从 1 开始');
      assert.eq(b.output, 'test@gmx.com\nab@gmail.com\nuser@example.com', '输出保持顺序');
      assert.eq([b.total, b.changed, b.unchanged, b.invalid], [3, 2, 1, 0], '统计：3 条里 2 条变了');

      // 非法行不中断整批，且原样留在输出里
      b = normalizeEmails('ok@example.com\nbroken\nAlso.OK@Example.com');
      assert.eq(b.total, 3, '3 条都处理了');
      assert.eq(b.invalid, 1, '1 条非法');
      assert.eq(b.output, 'ok@example.com\nbroken\nalso.ok@example.com', '非法行原样回显，其余照常');
      assert.eq(b.items[1].error, 'Invalid email', '非法行带错误信息');

      // 空行跳过：原版会为末尾换行产出一条 "Unable to parse email: "
      b = normalizeEmails('a@b.com\n');
      assert.eq(b.total, 1, '末尾换行不算一条邮箱');
      assert.eq(b.skipped, 1, '空行被跳过');
      assert.eq(b.output, 'a@b.com', '输出没有多出来的空行条目');

      b = normalizeEmails('\n\n  \n');
      assert.eq(b.total, 0, '全是空行');
      assert.eq(b.output, '', '输出为空串');
      assert.eq(b.skipped, 4, '4 行空行');

      b = normalizeEmails('');
      assert.eq(b.total, 0, '空输入');
      assert.eq(b.output, '', '空输入 → 空输出');

      b = normalizeEmails(null);
      assert.eq(b.total, 0, 'null 输入不炸');
      assert.eq(b.output, '', 'null 输入 → 空输出');

      // CRLF：行尾的 \r 不能混进邮箱里
      b = normalizeEmails('A@B.com\r\nC@D.com');
      assert.eq(b.total, 2, 'CRLF 也算两行');
      assert.eq(b.output, 'a@b.com\nc@d.com', 'CRLF 里的 CR 被吃掉');
      assert.eq(b.invalid, 0, 'CRLF 不造成误判');
    }
  };
})();