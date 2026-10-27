/* ==========================================================================
   文本转拼写字母表（text-to-nato-alphabet）

   逐字符把文本替换成「拼读字母表」里的读音词，没有对应读音词的字符原样保留。
   除了北约音标字母表（NATO），还可以选德国 DIN 5008、法语、西班牙语、俄语。

   参考实现：src/tools/text-to-nato-alphabet/（it-tools, GPLv3）
   对应上游 PR：#1888（多字母表 + 数字）与 #1894（俄文字母表按西里尔顺序取词、
   补德语变音字母与西班牙语 ñ）。

   与原版的差别：
   · 原版用 text.split('') 按 UTF-16 码元切分，代理对（emoji、
     大部分增补平面字符）会被劈成两个残缺码元，各自再补一个读音词，
     输出直接损坏；这里改用 Array.from 按码点切分，emoji 原样透传。
   · 原版的俄语字母表是拿拉丁字母的位置去查的 —— 也就是说它对西里尔字母
     实际上是失效的（位置越界，落到「原样保留」）。#1894 修的就是这个：
     俄语按 U+0430..U+044F（а..я）的顺序直接取词，拉丁字母原样透传。
   · 变音字母（德语 ä/ö/ü/ß、西班牙语 ñ）走 `extras` 单独映射。
   · 数字默认也拼读（NATO 用 Zero..Niner，德语用 Null..Neun），
     可以用开关关掉 —— 与上游一致。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('text-to-nato-alphabet');

  /** 选中的字母表与「是否拼读数字」记在 localStorage 里（对应上游的 useStorage）。 */
  var ALPHABET_KEY = 'text-to-nato-alphabet:alphabet';
  var DIGITS_KEY = 'text-to-nato-alphabet:spell-digits';

  /**
   * 拼读字母表。key 与上游一致（nato / de / fr / es / ru）。
   *
   * - `letters`  按字母表顺序排的读音词；拉丁表 26 条，俄语表 32 条。
   * - `digits`   可选的数字读音词（10 条）；没有这一项时数字原样保留。
   * - `extras`   变音字母的单独映射，键是小写字符。
   * - `cyrillic` 字母表按西里尔字母顺序排（这时 `letters` 是 32 条）。
   */
  var SPELLING_ALPHABETS = [
    {
      key: 'nato',
      label: 'NATO (International)',
      letters: [
        'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
        'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa',
        'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey',
        'X-ray', 'Yankee', 'Zulu'
      ],
      // 航电口径的 9 读 Niner
      digits: ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Niner']
    },
    {
      key: 'de',
      label: 'German (DIN 5008)',
      letters: [
        'Anton', 'Berta', 'Cäsar', 'Dora', 'Emil', 'Friedrich', 'Gustav',
        'Heinrich', 'Ida', 'Julius', 'Kaufmann', 'Ludwig', 'Martha', 'Nordpol',
        'Otto', 'Paula', 'Quelle', 'Richard', 'Samuel', 'Theodor', 'Ulrich',
        'Viktor', 'Wilhelm', 'Xanthippe', 'Ypsilon', 'Zacharias'
      ],
      digits: ['Null', 'Eins', 'Zwei', 'Drei', 'Vier', 'Fünf', 'Sechs', 'Sieben', 'Acht', 'Neun'],
      extras: { 'ä': 'Ärger', 'ö': 'Ökonom', 'ü': 'Übermut', 'ß': 'Eszett' }
    },
    {
      key: 'fr',
      label: 'French',
      letters: [
        'Anatole', 'Berthe', 'Célestin', 'Désiré', 'Eugène', 'François', 'Gaston',
        'Henri', 'Irma', 'Jean', 'Kléber', 'Louis', 'Marcel', 'Nicolas', 'Oscar',
        'Pierre', 'Quintal', 'Raoul', 'Suzanne', 'Thérèse', 'Ursule', 'Victor',
        'William', 'Xavier', 'Yvonne', 'Zoé'
      ]
    },
    {
      key: 'es',
      label: 'Spanish',
      letters: [
        'Antonio', 'Burgos', 'Carmen', 'Dolores', 'Enrique', 'Francia', 'Gitano',
        'Historia', 'Inés', 'Jalapa', 'Kilo', 'Lorenzo', 'Madrid', 'Navarra',
        'Oviedo', 'París', 'Querido', 'Ramón', 'Sevilla', 'Toledo', 'Ultramar',
        'Valencia', 'Washington', 'Xiquena', 'Yegua', 'Zaragoza'
      ],
      extras: { 'ñ': 'Ñoño' }
    },
    {
      key: 'ru',
      label: 'Russian',
      // 俄语字母表是 32 条：а..я 是 U+0430..U+044F（ё=U+0451 不在表里，原样透传）
      letters: [
        'Анна', 'Борис', 'Василий', 'Григорий', 'Дмитрий', 'Елена', 'Женя',
        'Зинаида', 'Иван', 'Йот', 'Константин', 'Леонид', 'Михаил', 'Николай',
        'Ольга', 'Павел', 'Роман', 'Семён', 'Татьяна', 'Ульяна', 'Фёдор',
        'Харитон', 'Цапля', 'Человек', 'Шура', 'Щука', 'Твёрдый знак', 'Ы',
        'Мягкий знак', 'Эхо', 'Юрий', 'Яков'
      ],
      cyrillic: true
    }
  ];

  /**
   * 字母表的显示名。中文界面里用中文名，英文界面里用上游的原文。
   *
   * 键是**写死的字面量**而不是拼出来的 —— 语言包的对账单测要能逐条找到它们，
   * 拼出来的键对不上账（`src/i18n.rs` 的 `js_text` 那几个单测）。
   */
  var ALPHABET_LABELS = {
    nato: t('alphabet.nato', 'NATO (International)'),
    de: t('alphabet.de', 'German (DIN 5008)'),
    fr: t('alphabet.fr', 'French'),
    es: t('alphabet.es', 'Spanish'),
    ru: t('alphabet.ru', 'Russian')
  };

  function alphabetLabel(alphabet) {
    return ALPHABET_LABELS[alphabet.key] || alphabet.label;
  }

  /**
   * 按 key 取字母表。取不到就抛 —— 上游也是抛
   * （`Unknown spelling alphabet: ${key}`），不静默退回 NATO：
   * 静默退回会让「我选了俄语却拿到英语字母表」这种事看不出来。
   */
  function getSpellingAlphabet(key) {
    for (var i = 0; i < SPELLING_ALPHABETS.length; i++) {
      if (SPELLING_ALPHABETS[i].key === key) return SPELLING_ALPHABETS[i];
    }
    throw new Error('Unknown spelling alphabet: ' + key);
  }

  /**
   * 字母表下标。不是这张表里的字母返回 -1。
   *
   * 用 toLowerCase 而不是正则，是想保留原版行为：少数会小写成 ASCII 的
   * 字符（如开尔文符号 U+212A）也会被认成对应字母。
   */
  function alphabetIndex(char, alphabet) {
    var lower = String(char).toLowerCase();
    // 少数字符小写后不止一个码元（如 İ → i + U+0307），取不了位
    if (lower.length !== 1) return -1;
    if (alphabet.cyrillic) {
      // 俄语按西里尔字母自己的顺序取词：а..я 连续占 U+0430..U+044F
      var code = lower.charCodeAt(0);
      return (code >= 0x0430 && code <= 0x044F) ? code - 0x0430 : -1;
    }
    var idx = lower.charCodeAt(0) - 97;
    return (idx >= 0 && idx < 26) ? idx : -1;
  }

  /** 变音字母的专用读音词（德语 ä/ö/ü/ß、西班牙语 ñ）。没有就返回 null。 */
  function extraWord(char, alphabet) {
    var extras = alphabet.extras;
    if (!extras) return null;
    var key = String(char).toLowerCase();
    // 用 hasOwnProperty 而不是直接取值：extras 是普通对象，
    // 直接取 extras['constructor'] 会拿到 Object.prototype 上的东西。
    if (!Object.prototype.hasOwnProperty.call(extras, key)) return null;
    return extras[key] || null;
  }

  /**
   * 单个字符对应的读音词。表里没有就原样返回这个字符。
   *
   * 顺序与上游一致：先看变音字母，再查字母表，最后才是数字。
   */
  function wordFor(char, alphabet, spellDigits) {
    var extra = extraWord(char, alphabet);
    if (extra) return extra;

    var idx = alphabetIndex(char, alphabet);
    if (idx !== -1 && alphabet.letters[idx]) return alphabet.letters[idx];

    if (spellDigits && /\d/.test(char) && alphabet.digits) {
      var digit = alphabet.digits[Number(char)];
      if (digit) return digit;
    }

    return char;
  }

  /**
   * 逐字符明细，给结果表格用。
   *
   * @param {string} text
   * @param {{alphabetKey?: string, spellDigits?: boolean}} [opts]
   */
  function toEntries(text, opts) {
    opts = opts || {};
    var alphabet = getSpellingAlphabet(opts.alphabetKey || 'nato');
    var spellDigits = opts.spellDigits !== false;
    return Array.from(String(text == null ? '' : text)).map(function (char, index) {
      var word = wordFor(char, alphabet, spellDigits);
      return {
        index: index,
        char: char,
        word: word,
        codePoint: char.codePointAt(0),
        mapped: word !== char
      };
    });
  }

  /**
   * 文本 → 拼读字母串。字符之间（含空格自己）一律用空格连接，
   * 所以 'abc' → 'Alpha Bravo Charlie'、'a b' → 'Alpha  Bravo'。
   *
   * @param {{text: string, alphabetKey?: string, spellDigits?: boolean}} opts
   */
  function textToSpellingAlphabet(opts) {
    opts = opts || {};
    return toEntries(opts.text, opts).map(function (e) {
      return e.word;
    }).join(' ');
  }

  /**
   * 只用北约音标字母表的老入口 —— 保持原版语义（数字不拼读，原样保留）。
   *
   * @param {string} text
   */
  function textToNatoAlphabet(text) {
    return textToSpellingAlphabet({ text: text, alphabetKey: 'nato', spellDigits: false });
  }

  /** 表里有对应读音词的字符个数。 */
  function mappedCount(text, opts) {
    return toEntries(text, opts).filter(function (e) { return e.mapped; }).length;
  }

  /* ---------- localStorage ---------- */

  function readStored(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return raw;
    } catch (e) {
      return fallback; // 隐私模式下 localStorage 直接抛
    }
  }

  function writeStored(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式 */ }
  }

  window.ItTools.register('text-to-nato-alphabet', function (root) {
    var textarea = D.h('textarea.layui-textarea', { rows: 4, placeholder: t('input_ph', 'Put your text here...') });
    textarea.value = 'SOS';

    // 存下来的 key 可能是旧版本留下的、现在已不存在的字母表 —— 认不出来就回 NATO。
    var storedAlphabet = readStored(ALPHABET_KEY, 'nato');
    var initialAlphabet = storedAlphabet;
    try {
      getSpellingAlphabet(initialAlphabet);
    } catch (e) {
      initialAlphabet = 'nato';
    }
    var storedDigits = readStored(DIGITS_KEY, 'true');
    var initialDigits = storedDigits !== 'false';

    var alphabetSelect = D.h('select.layui-select#nato-alphabet', null, SPELLING_ALPHABETS.map(function (a) {
      return D.h('option', { value: a.key, text: alphabetLabel(a) });
    }));
    alphabetSelect.value = initialAlphabet;

    var digitsBox = D.h('input', { type: 'checkbox' });
    digitsBox.checked = initialDigits;

    // 原版的结果标题是一句**普通文字**（<div mb-2>Your text in NATO phonetic alphabet</div>），
    // 不是 <label>：字号字重跟正文一样（14px/400），下面留 8px，再跟一张卡片。
    // 我们自己的 .output-label 是 13px/500 的小标题，跟原版对不上，
    // 这里用 .code-label（14px/400 的输出区标题）再把下边距改成原版的 8px。
    var resultLabel = D.h('div.code-label', {
      style: { marginBottom: '8px' },
      text: t('result', 'Your text in the selected spelling alphabet')
    });
    var resultBox = D.h('pre.mono-output');
    var table = D.h('table.result-table', null,
      D.h('thead', null, D.h('tr', null,
        D.h('th', { text: '#' }),
        D.h('th', { text: t('col.char', 'Character') }),
        D.h('th', { text: t('col.word', 'Spelling') }),
        D.h('th', { text: t('col.codepoint', 'Code point') })
      )),
      D.h('tbody')
    );
    var note = D.h('span.badge-note');

    function render() {
      var text = textarea.value;
      var opts = { alphabetKey: alphabetSelect.value, spellDigits: digitsBox.checked };
      var entries = toEntries(text, opts);
      resultBox.textContent = text ? textToSpellingAlphabet({ text: text, alphabetKey: opts.alphabetKey, spellDigits: opts.spellDigits }) : '';

      var tbody = table.querySelector('tbody');
      D.clear(tbody);
      entries.forEach(function (e) {
        tbody.appendChild(D.h('tr', null,
          D.h('td', { text: String(e.index) }),
          D.h('td', { text: e.char }),
          D.h('td', { text: e.mapped ? e.word : e.word + t('kept', ' (kept as-is)') }),
          D.h('td', { text: 'U+' + e.codePoint.toString(16).toUpperCase().padStart(4, '0') })
        ));
      });

      var total = entries.length;
      var mapped = entries.filter(function (e) { return e.mapped; }).length;
      note.textContent = total
        ? t('note', '{total} characters, {mapped} of them have a spelling word')
            .replace('{total}', total)
            .replace('{mapped}', mapped)
        : t('note_empty', 'Type some text to see the per-character breakdown');
    }

    textarea.addEventListener('input', render);
    alphabetSelect.addEventListener('change', function () {
      writeStored(ALPHABET_KEY, alphabetSelect.value);
      render();
    });
    digitsBox.addEventListener('change', function () {
      writeStored(DIGITS_KEY, digitsBox.checked ? 'true' : 'false');
      render();
    });

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your text to convert to a spelling alphabet'), textarea, {
        wide: true,
        hint: t('hint', 'Characters with no spelling word (punctuation, spaces, emoji) are kept as-is.')
      }),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'nato-alphabet', text: t('alphabet_label', 'Spelling alphabet') }),
        alphabetSelect
      ),
      D.h('label.switch', null, digitsBox,
        D.h('span', { text: t('spell_digits', 'Spell digits') })),
      D.h('div.form-actions', null, note)
    ));

    // 原版的复制按钮在结果**下面**（mt-3 flex justify-center 的居中按钮）。
    // 这一页是 plain-shell（卡片被摘掉），所以按钮行放在结果卡片里，
    // 看上去仍然在结果下面；同时顶层不会多出一块只剩按钮的碎片。
    root.appendChild(D.h('div.card', null,
      resultLabel,
      resultBox,
      D.h('div.form-actions', { style: { justifyContent: 'center' } },
        U.copyButton(function () { return resultBox.textContent; }))
    ));

    root.appendChild(D.h('div.card', null, table));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['text-to-nato-alphabet'] = {
    textToNatoAlphabet: textToNatoAlphabet,
    textToSpellingAlphabet: textToSpellingAlphabet,
    getSpellingAlphabet: getSpellingAlphabet,
    spellingAlphabets: SPELLING_ALPHABETS,
    toEntries: toEntries,
    mappedCount: mappedCount,
    __cases: function (assert) {
      // —— 原有的北约音标字母表行为 ——
      assert.eq(textToNatoAlphabet(''), '', '空串');
      assert.eq(textToNatoAlphabet('a'), 'Alpha', '小写 a');
      assert.eq(textToNatoAlphabet('A'), 'Alpha', '大写 A');
      assert.eq(textToNatoAlphabet('z'), 'Zulu', '最后一个字母');
      assert.eq(textToNatoAlphabet('abc'), 'Alpha Bravo Charlie', '多个字母');
      assert.eq(textToNatoAlphabet('AZ'), 'Alpha Zulu', '跨字母表首尾');
      // 老入口不拼读数字
      assert.eq(textToNatoAlphabet('1-2'), '1 - 2', '数字与连字符');
      assert.eq(textToNatoAlphabet('!'), '!', '标点');
      // 原文本里的空格占一个 token，拼接时前后各补一个空格，于是出现三个空格
      assert.eq(textToNatoAlphabet('a b'), 'Alpha   Bravo', '空格自己占一格');
      assert.eq(textToNatoAlphabet('it-tools').indexOf('India Tango'), 0, 'it-tools 开头');
      // 码点：emoji 必须整体透传，不能被劈成两半
      assert.eq(textToNatoAlphabet('😀'), '😀', 'emoji 原样保留');
      assert.eq(textToNatoAlphabet('a😀'), 'Alpha 😀', '字母 + emoji');
      assert.eq(toEntries('中')[0].mapped, false, '非拉丁文字不查表');
      // 明细表
      assert.eq(toEntries('a').length, 1, '逐字符明细');
      assert.eq(toEntries('a')[0].word, 'Alpha', '明细带读音词');
      assert.eq(toEntries('😀')[0].char, '😀', '明细按码点切');
      assert.eq(mappedCount('abc'), 3, '三个字母都有读音');
      assert.eq(mappedCount('a1'), 2, '默认拼读数字，数字也有读音词');
      assert.eq(mappedCount('a1', { spellDigits: false }), 1, '关掉拼数字后数字原样保留');

      // —— 多字母表（上游 #1888 / #1894）——
      assert.eq(textToSpellingAlphabet({ text: 'AB', alphabetKey: 'nato' }), 'Alpha Bravo', '默认 NATO');
      assert.eq(textToSpellingAlphabet({ text: 'A!', alphabetKey: 'nato' }), 'Alpha !', '未知字符原样透传');
      assert.eq(textToSpellingAlphabet({ text: 'aB', alphabetKey: 'nato' }), 'Alpha Bravo', '大小写不敏感');
      assert.eq(textToSpellingAlphabet({ text: 'AB', alphabetKey: 'de' }), 'Anton Berta', '德语字母表');
      assert.eq(textToSpellingAlphabet({ text: 'AB', alphabetKey: 'fr' }), 'Anatole Berthe', '法语字母表');
      assert.eq(textToSpellingAlphabet({ text: 'AB', alphabetKey: 'es' }), 'Antonio Burgos', '西班牙语字母表');

      // 数字：默认拼读，可以关掉
      assert.eq(textToSpellingAlphabet({ text: '1A', alphabetKey: 'de' }), 'Eins Anton', '德语数字默认拼读');
      assert.eq(textToSpellingAlphabet({ text: '1A', alphabetKey: 'de', spellDigits: false }), '1 Anton', '关掉后数字原样');
      assert.eq(textToSpellingAlphabet({ text: '9', alphabetKey: 'nato' }), 'Niner', 'NATO 的 9 读 Niner');
      assert.eq(textToSpellingAlphabet({ text: '9', alphabetKey: 'nato', spellDigits: false }), '9', '关掉后数字原样');
      // 没有数字读音表的字母表（法语、西班牙语、俄语）里数字原样保留
      assert.eq(textToSpellingAlphabet({ text: '1', alphabetKey: 'fr' }), '1', '法语没有数字读音词');

      // 变音字母
      assert.eq(textToSpellingAlphabet({ text: 'äöüß', alphabetKey: 'de' }), 'Ärger Ökonom Übermut Eszett', '德语变音字母');
      assert.eq(textToSpellingAlphabet({ text: 'ñ', alphabetKey: 'es' }), 'Ñoño', '西班牙语 ñ');
      // 变音字母的 extras 只对对应字母表生效
      assert.eq(textToSpellingAlphabet({ text: 'ñ', alphabetKey: 'de' }), 'ñ', '德语表里没有 ñ 的读音词');

      // 俄语：按西里尔字母自己的顺序取词（上游 #1894 修的就是这个）
      assert.eq(textToSpellingAlphabet({ text: 'абв', alphabetKey: 'ru' }), 'Анна Борис Василий', '西里尔字母按俄语顺序');
      assert.eq(textToSpellingAlphabet({ text: 'Яя', alphabetKey: 'ru' }), 'Яков Яков', '俄语大小写不敏感');
      assert.eq(textToSpellingAlphabet({ text: 'ё', alphabetKey: 'ru' }), 'ё', 'ё 不在表里，原样保留');
      assert.eq(textToSpellingAlphabet({ text: 'AB', alphabetKey: 'ru' }), 'A B', '拉丁字母在俄语表里原样保留');

      // 未知字母表要报错，不静默退回 NATO
      var threw = false;
      try { textToSpellingAlphabet({ text: 'A', alphabetKey: 'xx' }); } catch (e) { threw = true; }
      assert(threw, '未知字母表要抛错');
    }
  };
})();
