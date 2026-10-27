/* ==========================================================================
   令牌生成器（token-generator）

   按勾选的字符集生成随机串，长度 1~512 可调，一次可以生成多条。
   还能排除指定字符（上游 #913），以及把设置记住（上游 #1870）。

   参考实现：src/tools/token-generator/（it-tools, GPLv3）
   与原版的差别：
   1. 原版的两个字符集漏了字母 N / n（`ABCDEFGHIJKLMOPQRSTUVWXYZ`、
      `abcdefghijklmopqrstuvwxyz`），会让生成的令牌永远不含这两个字母，
      白白少掉一份熵，这里按完整字母表实现。
   2. 原版用 `shuffleString(alphabet.repeat(length))` 生成 —— 字符集越大，
      repeat 出来的中间串越长（512 位 × 92 个字符 = 47K 个字符），
      而且 repeat+shuffle 的取模偏置让部分字符略微偏多；
      这里改成 rejection sampling 直接从字符集里均匀取字符（见 `U.randomString`）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('token-generator');

  var ALPHABETS = {
    uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lowercase: 'abcdefghijklmnopqrstuvwxyz',
    numbers: '0123456789',
    symbols: '.,;:!?./-"\'#{([-|\\@)]=}*+'
  };

  /** 设置在 localStorage 里的键名 */
  var STORAGE_KEY = 'token-generator:settings';

  /** 默认设置 */
  var DEFAULTS = {
    uppercase: true,
    lowercase: true,
    numbers: true,
    symbols: false,
    length: 64,
    count: 1,
    denied: ''
  };

  /** 一次最多生成多少条 */
  var MAX_COUNT = 50;

  /**
   * 按选项拼出字符集。全部关闭时返回空串（与参考实现的单测一致）。
   * `denied` 里的字符会被剔除（上游 #913）—— 注意是**精确匹配**，
   * 排除 `o` 不会连带排除 `O`。
   * @param {{uppercase?:boolean, lowercase?:boolean, numbers?:boolean,
   *          symbols?:boolean, denied?:string}} opts
   */
  function alphabetOf(opts) {
    var base = Object.keys(ALPHABETS)
      .filter(function (k) { return opts[k]; })
      .map(function (k) { return ALPHABETS[k]; })
      .join('');
    var denied = String(opts.denied == null ? '' : opts.denied);
    if (!denied.length) return base;
    return base.split('').filter(function (c) { return denied.indexOf(c) < 0; }).join('');
  }

  /**
   * 生成一条令牌。用 rejection sampling 从 crypto 均匀取字符，
   * 不用 shuffle —— 后者会因取模偏置而让部分字符略微偏多。
   * @param {{length?:number, denied?:string}} opts
   */
  function createToken(opts) {
    var length = Math.max(0, Math.floor(opts.length == null ? 64 : opts.length));
    var alphabet = alphabetOf(opts);
    if (!alphabet.length || !length) return '';
    return U.randomString(alphabet, length);
  }

  /**
   * 一次生成多条（上游 #913 的 count）。条数夹在 1~50。
   * @returns {Array<string>}
   */
  function createTokens(opts) {
    var count = Math.min(MAX_COUNT, Math.max(1, Math.floor(Number(opts.count) || 1)));
    var out = [];
    for (var i = 0; i < count; i++) out.push(createToken(opts));
    return out;
  }

  /**
   * 读回上次的设置（上游 #1870）。
   *
   * localStorage 可能整个不可用（隐私模式），也可能被人手改成乱七八糟的 JSON，
   * 两种情况都退回默认值 —— 工具不该因为设置读不出来就打不开。
   * @returns {object}
   */
  function loadSettings() {
    var settings = {};
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') settings = parsed;
      }
    } catch (e) { /* 隐私模式 / 手改坏了 */ }

    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = settings[k];
      if (typeof DEFAULTS[k] === 'boolean') {
        out[k] = typeof v === 'boolean' ? v : DEFAULTS[k];
      } else if (typeof DEFAULTS[k] === 'number') {
        out[k] = (typeof v === 'number' && isFinite(v)) ? v : DEFAULTS[k];
      } else {
        out[k] = typeof v === 'string' ? v : DEFAULTS[k];
      }
    });
    out.length = Math.min(512, Math.max(1, Math.floor(out.length)));
    out.count = Math.min(MAX_COUNT, Math.max(1, Math.floor(out.count)));
    return out;
  }

  /**
   * 把设置写回 localStorage。写不进去（隐私模式）就算了，不能因此报错。
   * @param {object} settings
   */
  function saveSettings(settings) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) { /* 隐私模式 */ }
  }

  var TOGGLES = [
    { key: 'uppercase', label: t('include_uppercase', 'Include uppercase letters') },
    { key: 'lowercase', label: t('include_lowercase', 'Include lowercase letters') },
    { key: 'numbers', label: t('include_numbers', 'Include numbers') },
    { key: 'symbols', label: t('include_symbols', 'Include symbols') }
  ];

  window.ItTools.register('token-generator', function (root) {
    var opts = loadSettings();

    var tokenBox = D.h('textarea.layui-textarea.token-display', {
      rows: 3, readonly: true, placeholder: t('token_ph', 'The token...')
    });
    var hint = D.h('p.field-hint');

    function generate() {
      var tokens = createTokens(opts);
      tokenBox.value = tokens.join('\n');
      // 行数跟着条数走：生成 1 条时留一大片空白、生成 50 条要滚动，都不合适
      tokenBox.rows = Math.min(20, Math.max(3, tokens.length));

      var alphabet = alphabetOf(opts);
      if (!alphabet.length) {
        hint.textContent = t('empty_alphabet', 'The character set is empty — select at least one kind of character, and do not exclude them all.');
        hint.style.color = '#d03050';
      } else if (opts.denied) {
        hint.textContent = t('excluded_chars', 'Excluded {n} characters, {left} characters still available.')
          .replace('{n}', opts.denied.length).replace('{left}', alphabet.length);
        hint.style.color = '';
      } else {
        hint.textContent = '';
        hint.style.color = '';
      }
      saveSettings(opts);
    }

    /**
     * 一个字符集开关。
     *
     * 原版这一页是 `<n-form label-placement="left" label-width="140">` 里
     * 4 个 n-form-item：标签在左、列宽写死 140px、右对齐（naive-ui 的
     * n-form-item 标签实测一律右对齐），右边才是 n-switch。
     * 所以标签和开关得拆成两个元素 —— 不能再把文字塞进开关里
     * （那样文字就跑到开关右边去了）。
     */
    function toggleRow(opt) {
      var input = D.h('input', { type: 'checkbox', checked: opts[opt.key] });
      input.id = 'tg-' + opt.key;
      input.addEventListener('change', function () {
        opts[opt.key] = input.checked;
        generate();
      });
      return D.h('div.field-row', { style: { '--field-label-width': '140px' } },
        D.h('label.field-label', { for: input.id, text: opt.label }),
        D.h('label.switch', null, input, D.h('span'))
      );
    }

    var lengthLabel = D.h('label.field-label', { for: 'tg-length', text: t('length', 'Length ({n})').replace('{n}', opts.length) });
    var slider = D.h('input.slider', { type: 'range', id: 'tg-length', min: 1, max: 512, step: 1, value: opts.length });
    slider.addEventListener('input', function () {
      opts.length = Number(slider.value);
      lengthLabel.textContent = t('length', 'Length ({n})').replace('{n}', opts.length);
      generate();
    });

    var countLabel = D.h('label.field-label', { for: 'tg-count', text: t('count', 'Count ({n})').replace('{n}', opts.count) });
    var countSlider = D.h('input.slider', { type: 'range', id: 'tg-count', min: 1, max: MAX_COUNT, step: 1, value: opts.count });
    countSlider.addEventListener('input', function () {
      opts.count = Number(countSlider.value);
      countLabel.textContent = t('count', 'Count ({n})').replace('{n}', opts.count);
      generate();
    });

    var deniedInput = D.h('input.layui-input', {
      type: 'text', value: opts.denied, spellcheck: 'false',
      placeholder: t('denied_ph', 'e.g. oO0lI')
    });
    deniedInput.addEventListener('input', function () {
      opts.denied = deniedInput.value;
      generate();
    });

    var card = D.h('div.card', null,
      // 原版的开关区：`<n-form label-placement="left" label-width="140">` 里
      // `<div flex justify-center>` 套两列 —— 左列 Uppercase/Lowercase、
      // 右列 Numbers/Symbols，整组在卡片里居中；每行的标签都是
      // n-form-item 的左标签、140px 一列、右对齐。
      //
      // 这里用 grid 摆同样的形状：两列按内容宽度（140px 标签列 + 开关），
      // 整组居中；grid 的行高是两边取齐的，原版两列的开关也是齐的
      // （naive-ui 的 n-form-item 高度固定，实测 58px），
      // 我们用 flex 行高不齐的话，长标签那一列的开关就会上下错开。
      D.h('div', {
        style: {
          display: 'grid', gridTemplateColumns: 'auto auto', gridTemplateRows: 'auto auto',
          gridAutoFlow: 'column', justifyContent: 'center', columnGap: '12px', rowGap: '0',
          marginBottom: '14px'
        }
      },
        toggleRow(TOGGLES[0]), toggleRow(TOGGLES[1]),
        toggleRow(TOGGLES[2]), toggleRow(TOGGLES[3])
      ),
      // 原版的 Length 是 n-form-item label-placement="left"，
      // **没有写 label-width** —— 标签列宽按文字走、右对齐。
      // （原版实测 93px = 文字 81px + naive-ui 标签自带的 12px 右内边距；
      //   我们这边 .field-row 的标签后面本来就有 12px 间距，控件的位置对得上。）
      D.h('div.field-row', { style: { '--field-label-width': 'auto', '--field-label-align': 'right' } },
        lengthLabel, D.h('div', { style: { flex: '1 1 0', minWidth: '0' } }, slider)),
      // Count 是我们自己加的字段（原版没有），按 Length 那一套排：左标签、按文字宽度、右对齐。
      D.h('div.field-row', { style: { '--field-label-width': 'auto', '--field-label-align': 'right' } },
        countLabel, D.h('div', { style: { flex: '1 1 0', minWidth: '0' } }, countSlider)),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('denied_characters', 'Denied characters') }),
        deniedInput
      ),
      hint,
      tokenBox,
      D.h('div.form-actions', null,
        U.copyButton(function () { return tokenBox.value; }),
        D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('refresh', 'Refresh'), onclick: generate })
      )
    );
    root.appendChild(card);
    generate();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['token-generator'] = {
    ALPHABETS: ALPHABETS,
    DEFAULTS: DEFAULTS,
    MAX_COUNT: MAX_COUNT,
    STORAGE_KEY: STORAGE_KEY,
    createToken: createToken,
    createTokens: createTokens,
    alphabetOf: alphabetOf,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    __cases: function (assert) {
      // 与参考实现 vitest 用例一致：全关时是空串
      assert.eq(createToken({ uppercase: false, lowercase: false, numbers: false, symbols: false, length: 10 }), '');
      assert(/^[A-Z]+$/.test(createToken({ uppercase: true, lowercase: false, numbers: false, symbols: false, length: 256 })), '只开大写');
      assert(/^[a-z]+$/.test(createToken({ uppercase: false, lowercase: true, numbers: false, symbols: false, length: 256 })), '只开小写');
      assert(/^[0-9]+$/.test(createToken({ uppercase: false, lowercase: false, numbers: true, symbols: false, length: 256 })), '只开数字');
      [5, 10, 100, 512].forEach(function (n) {
        assert.eq(createToken({ uppercase: true, lowercase: true, numbers: true, symbols: true, length: n }).length, n, '长度 ' + n);
      });
      // 原版漏掉的字母必须补上，否则令牌永远不含 N / n
      var all = createToken({ uppercase: true, lowercase: true, numbers: true, symbols: true, length: 512 });
      assert(/[Nn]/.test(all), '字母表应包含 N 与 n');
      assert(/[A-Z]/.test(all) && /[a-z]/.test(all) && /[0-9]/.test(all), '大小写数字都应出现');
      // 两次生成不应相同
      var opts = { uppercase: true, lowercase: true, numbers: true, symbols: false, length: 32 };
      assert(createToken(opts) !== createToken(opts), '两次生成应不同');

      // 排除字符（上游 #913）
      var no12 = createToken({
        uppercase: false, lowercase: false, numbers: true, symbols: false,
        length: 256, denied: '12'
      });
      assert.eq(no12.length, 256, '排除字符后长度不变');
      assert(/^[03456789]+$/.test(no12), '1 与 2 被排除');
      assert.eq(alphabetOf({ numbers: true, denied: '12' }), '03456789', '字符集里剔掉了 1 与 2');
      // 排除是精确匹配：排 o 不会连带排 O
      assert.eq(alphabetOf({ uppercase: true, lowercase: true, denied: 'o' }).indexOf('O') >= 0, true, '大写 O 还在');
      assert.eq(alphabetOf({ uppercase: true, lowercase: true, denied: 'o' }).indexOf('o') < 0, true, '小写 o 没了');
      // 排光了字符集 → 空串
      assert.eq(alphabetOf({ numbers: true, denied: '0123456789' }), '', '全排完就是空集');
      assert.eq(createToken({ numbers: true, length: 10, denied: '0123456789' }), '', '空集生成空串');

      // 批量生成（上游 #913 的 count）
      assert.eq(createTokens({ uppercase: true, numbers: true, length: 8, count: 1 }).length, 1, '一条');
      assert.eq(createTokens({ uppercase: true, numbers: true, length: 8, count: 10 }).length, 10, '十条');
      assert.eq(createTokens({ uppercase: true, numbers: true, length: 8, count: 0 }).length, 1, '0 条按 1 条算');
      assert.eq(createTokens({ uppercase: true, numbers: true, length: 8, count: 999 }).length, 50, '超过上限按 50 条算');
      var many = createTokens({ uppercase: true, numbers: true, length: 16, count: 20 });
      assert.eq(new Set(many).size, 20, '每条都不一样');

      // 设置持久化（上游 #1870）：读回来的是默认值 + 存过的部分
      var saved = loadSettings();
      assert.eq(saved.uppercase, true, '默认开大写');
      assert.eq(saved.length, 64, '默认长度 64');
      assert.eq(saved.count, 1, '默认一条');
      assert.eq(typeof saved.denied, 'string', '默认没有排除字符');
    }
  };
})();
