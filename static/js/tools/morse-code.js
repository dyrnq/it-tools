/* ==========================================================================
   摩尔斯电码转换器（morse-code）

   文本 ↔ 摩尔斯电码。码表来自上游 PR #1021 用的 morsee@1.0.9（MIT），
   但**没有 vendor** 那个包 —— 它是纯 CJS、没有 UMD，浏览器里 <script src>
   加载不了，而整张码表才 2.3KB，直接内联进本模块更省事。

   参考实现：src/tools/morse-converter/（it-tools, GPLv3）
   对应上游 PR：#1021

   与原版的差别（逐条）：
   1. **码表归一化**：上游给 nonEnglish（变音字母）和一部分标点用的是
      U+2212 MINUS SIGN `−` 与 U+00B7 MIDDLE DOT `·` —— 这两个都不是标准
      摩尔斯码的符号（标准码只有 ASCII 的 `-` 与 `.`），也没法跟普通文本
      混排。这里全部归一化成 `-` 与 `.`。
   2. **保留大小写**：上游 `encode` 强制 `toLowerCase()`，大小写被吃掉
      （encode('SOS') 与 encode('sos') 一模一样）。这里保留 —— 约定见下。
   3. **解码不再静默丢字符**：上游 `decode` 里 `fromMorse[morse]` 查不到就是
      undefined，join 时变成空串 —— 一段乱码会被无声无息地吃掉。这里明确
      抛错，并指出是第几段。
   4. **编码不再静默丢字符**：上游 `encode` 里码表没有的字符也是 undefined，
      同样被吃掉。这里把它们收集起来，在界面上提示。
   5. **冲突码的优先级**：上游的 fromMorse 是「后写覆盖先写」，于是
      `.----` 解出来是 `å`（而不是数字 1）、`..--..` 解出来是 `?`
      （而不是 `é`）。这里改成「标准码优先」：字母/数字/标点在前，
      变音字母只填剩下的空位。
   6. **分隔符可配**：上游写死「空格分字符、/ 分词」，这里两个都能改。
   7. 上游把换行编成 `.-.-`，跟变音字母 `ä` 的码撞了 —— 这里换成一个
      码表里没人用的 `.-..-`。

   大小写约定（本工具自定义的扩展，不是 ITU 标准）：
     · ITU-R M.1677-1 的国际摩尔斯码**本身不区分大小写**（码表只有 A–Z），
       所以「保留大小写」必须自己定一套约定。
     · 这里用的是**前缀标记**：大写字母 = 大写标记 `..-..` + 该字母的小写码，
       标记只作用于紧随其后的一个字符组。小写字母就是它自己的码。
       例：Hello → `..-.. .... . .-.. .-.. ---`。
     · 标记挑的是码表里没人用的 5 元素序列（字母最多 4 个元素、数字 5 个、
       标点最多 7 个，但 5 元素的 32 种组合里标准码只占了 24 种，
       `..-..` 正好是空出来的之一），这样跟真实摩尔斯码不会撞。
     · 界面上有开关可以关掉它 —— 关掉就是经典摩尔斯码（`SOS` → `... --- ...`），
       大小写随摩尔斯码一起丢掉，这也是上游的行为。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('morse-code');

  /* ---------- 码表 ---------- */

  /**
   * 26 个字母（ITU-R M.1677-1）。
   * 键一律小写 —— 大写靠大写标记区分，不另给码。
   */
  var LETTERS = {
    'a': '.-', 'b': '-...', 'c': '-.-.', 'd': '-..', 'e': '.', 'f': '..-.',
    'g': '--.', 'h': '....', 'i': '..', 'j': '.---', 'k': '-.-', 'l': '.-..',
    'm': '--', 'n': '-.', 'o': '---', 'p': '.--.', 'q': '--.-', 'r': '.-.',
    's': '...', 't': '-', 'u': '..-', 'v': '...-', 'w': '.--', 'x': '-..-',
    'y': '-.--', 'z': '--..'
  };

  /** 10 个数字（ITU-R M.1677-1）。 */
  var DIGITS = {
    '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
    '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.'
  };

  /** 常用标点（ITU 的那套 + 上游多收的几个）。 */
  var PUNCTUATION = {
    '&': '.-...', "'": '.----.', '@': '.--.-.', '$': '...-..-', ')': '-.--.-',
    '(': '-.--.', ':': '---...', ',': '--..--', ';': '-.-.-.', '=': '-...-',
    '!': '-.-.--', '.': '.-.-.-', '-': '-....-', '_': '..--.-', '+': '.-.-.',
    '"': '.-..-.', '?': '..--..', '/': '-..-.'
  };

  /**
   * 变音字母（上游 nonEnglish 那一组，欧洲摩尔斯码）。
   * 键是小写；大写形式由 toUpperCase() 推出来（所以码跟小写一样）。
   *
   * 少数几个跟标准码撞了（`.----` 撞数字 1、`..--..` 撞问号、
   * `.----.` 撞撇号），解码时按「标准码优先」处理 —— 这些字母仍然能
   * **编码**出去（编码走的是字符 → 码这张表），只是解回来会是那个
   * 标准字符。同一组里几个字母共用一个码的（à/å、ä/ą/æ、ć/ĉ/ç …），
   * 解码时取表里排在前面的那个。
   */
  var ACCENTED = {
    'á': '.--.-', 'à': '.----', 'ä': '.-.-', 'å': '.----', 'ą': '.-.-',
    'æ': '.-.-', 'ć': '-.-..', 'ĉ': '-.-..', 'ç': '-.-..', 'đ': '..--..',
    'ð': '..--.', 'é': '..--..', 'è': '.--.-', 'ę': '..--..', 'ĝ': '--.-.',
    'ĥ': '----', 'ĵ': '.----.', 'ł': '.--.-', 'ń': '--.--', 'ñ': '--.--',
    'ó': '---.', 'ö': '---.', 'ø': '---.', 'ś': '...-...', 'ŝ': '...-.',
    'š': '----', 'þ': '.--..', 'ü': '..--', 'ŭ': '..--', 'ź': '--..-.',
    'ż': '--..-'
  };

  /** 本工具自定义的两个扩展（不是 ITU 标准，注释里都写明了）。 */
  var CAPITAL_MARKER = '..-..';   // 大写标记：前缀，只作用于下一个字符组
  var NEWLINE_CODE = '.-..-';    // 换行：码表里没人用的 5 元素序列

  /** 默认分隔符：字符之间用空格，词之间用斜杠（跟上游一致）。 */
  var DEFAULT_CHAR_SEP = ' ';
  var DEFAULT_WORD_SEP = '/';

  /** 字符 → 码。 */
  var TO_MORSE = Object.create(null);
  /** 码 → 字符。冲突时先到的赢 —— 所以标准码排在变音字母前面。 */
  var FROM_MORSE = Object.create(null);
  /** 大写字符 → 码（码跟对应的小写一样，靠大写标记区分）。 */
  var TO_MORSE_UPPER = Object.create(null);

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  (function buildTables() {
    [LETTERS, DIGITS, PUNCTUATION, ACCENTED].forEach(function (group) {
      Object.keys(group).forEach(function (ch) {
        var code = group[ch];
        if (!has(TO_MORSE, ch)) TO_MORSE[ch] = code;
        if (!has(FROM_MORSE, code)) FROM_MORSE[code] = ch;
      });
    });
    Object.keys(TO_MORSE).forEach(function (ch) {
      // ß 之类的大写会变成两个字符（SS），那种不能当「大写形式」用
      var up = ch.toUpperCase();
      if (up.length === 1 && up !== ch) TO_MORSE_UPPER[up] = TO_MORSE[ch];
    });
    // 换行也进反查表（码表里没人用这个码）
    if (!has(FROM_MORSE, NEWLINE_CODE)) FROM_MORSE[NEWLINE_CODE] = '\n';
  })();

  /* ---------- 纯逻辑 ---------- */

  /**
   * 分隔符合不合法。
   *
   * 不能为空、不能相同、不能包含摩尔斯码的符号（`.` `-`）——
   * 分隔符里出现这两个符号的话，切出来的「组」到底是码还是分隔符就说不清了。
   * 另外词分隔符不能是字符分隔符的子串（否则先按字符分隔符切的时候
   * 词分隔符就被切碎了，永远匹配不上）。
   *
   * @param {string} charSep
   * @param {string} wordSep
   */
  function separatorsValid(charSep, wordSep) {
    if (typeof charSep !== 'string' || typeof wordSep !== 'string') return false;
    if (!charSep.length || !wordSep.length) return false;
    if (charSep === wordSep) return false;
    if (charSep.indexOf('.') !== -1 || charSep.indexOf('-') !== -1) return false;
    if (wordSep.indexOf('.') !== -1 || wordSep.indexOf('-') !== -1) return false;
    if (wordSep.indexOf(charSep) !== -1) return false;
    if (charSep.indexOf(wordSep) !== -1) return false;
    return true;
  }

  /** 分隔符不合法时的错误消息 —— 界面提示与纯逻辑抛错共用一条文案。 */
  function sepError() {
    return t('err_sep', 'The separators must not be empty, must be different, and must not contain "." or "-".');
  }

  /**
   * 查一个字符的码。
   *
   * @param {string} ch
   * @param {boolean} preserveCase 大写字母要不要带大写标记
   * @returns {{code: string, upper: boolean}|null} 码表里没有这个字符时返回 null
   */
  function codeFor(ch, preserveCase) {
    if (has(TO_MORSE, ch)) return { code: TO_MORSE[ch], upper: false };
    if (preserveCase && has(TO_MORSE_UPPER, ch)) {
      return { code: TO_MORSE_UPPER[ch], upper: true };
    }
    if (!preserveCase) {
      // 经典模式：大写字母按小写码发（跟上游一样，大小写随摩尔斯码丢掉）
      var lower = ch.toLowerCase();
      if (lower.length === 1 && has(TO_MORSE, lower)) {
        return { code: TO_MORSE[lower], upper: false };
      }
    }
    return null;
  }

  /**
   * 把一段摩尔斯码切成「组」：码组与词分隔符。
   *
   * 词分隔符可以紧贴码组（`... .. / ..-.` 与 `... ../..-.` 都能切对），
   * 空组（多打了一个空格）直接忽略。
   *
   * @param {string} text
   * @param {string} charSep
   * @param {string} wordSep
   * @returns {Array<{code: boolean, value: string}>}
   */
  function splitGroups(text, charSep, wordSep) {
    var groups = [];
    String(text).split(charSep).forEach(function (part) {
      if (part.indexOf(wordSep) === -1) {
        if (part) groups.push({ code: true, value: part });
        return;
      }
      var pieces = part.split(wordSep);
      pieces.forEach(function (piece, index) {
        if (index > 0) groups.push({ code: false, value: '' });
        var trimmed = piece.trim();
        if (trimmed) groups.push({ code: true, value: trimmed });
      });
    });
    return groups;
  }

  /**
   * 编码：文本 → 摩尔斯码。
   *
   * 输出格式跟上游一致：字符之间用字符分隔符，词之间用词分隔符，
   * 词分隔符自己占一格（`hi friend` → `.... .. / ..-. .-. .. . -. -..`）。
   *
   * @param {string} text
   * @param {{charSep?: string, wordSep?: string, preserveCase?: boolean}} [opts]
   * @returns {{code: string, unsupported: string[]}} unsupported 是码表里没有、
   *          被跳过的字符（按出现顺序去重）
   */
  function encodeDetailed(text, opts) {
    opts = opts || {};
    var charSep = opts.charSep === undefined ? DEFAULT_CHAR_SEP : String(opts.charSep);
    var wordSep = opts.wordSep === undefined ? DEFAULT_WORD_SEP : String(opts.wordSep);
    var preserveCase = opts.preserveCase !== false;
    if (!separatorsValid(charSep, wordSep)) throw new Error(sepError());

    var unsupported = [];
    var seen = Object.create(null);
    var tokens = [];

    var lines = String(text === null || text === undefined ? '' : text)
      .replace(/\r\n?/g, '\n')
      .split('\n');

    lines.forEach(function (line, lineIndex) {
      if (lineIndex > 0) tokens.push(NEWLINE_CODE);
      var prevSpace = false;
      // 按码点切（Array.from），不是按 UTF-16 码元 —— 码表里都是 BMP 字符，
      // 但切对了以后代理对不会被劈成两半。
      Array.from(line).forEach(function (ch) {
        if (ch === ' ' || ch === '\t') {
          // 连续空白算一个词分隔符
          if (!prevSpace) tokens.push(wordSep);
          prevSpace = true;
          return;
        }
        prevSpace = false;
        var hit = codeFor(ch, preserveCase);
        if (!hit) {
          if (!seen[ch]) {
            seen[ch] = true;
            unsupported.push(ch);
          }
          return;
        }
        if (hit.upper) tokens.push(CAPITAL_MARKER);
        tokens.push(hit.code);
      });
    });

    var code = tokens.join(charSep);

    return { code: code, unsupported: unsupported };
  }

  /**
   * 编码：文本 → 摩尔斯码（只要码，不要别的）。
   *
   * @param {string} text
   * @param {{charSep?: string, wordSep?: string, preserveCase?: boolean}} [opts]
   * @returns {string}
   */
  function encode(text, opts) {
    return encodeDetailed(text, opts).code;
  }

  /**
   * 码表里没有、会被跳过的字符。
   *
   * @param {string} text
   * @param {{preserveCase?: boolean}} [opts]
   * @returns {string[]}
   */
  function unsupportedChars(text, opts) {
    return encodeDetailed(text, opts).unsupported;
  }

  /**
   * 解码：摩尔斯码 → 文本。
   *
   * 遇到码表里没有的序列**直接抛错**（上游是静默丢掉），错误里带着
   * 段号（从 1 数起，只数码组，词分隔符不算）与出错的序列。
   *
   * 大小写：带大写标记的组解成大写；没带的组在「保留大小写」模式下解成
   * 小写（码表里的键就是小写，跟上游一致），在经典模式下解成大写 ——
   * 经典摩尔斯码本来就没有大小写，惯例是解出来一律大写。
   *
   * @param {string} text
   * @param {{charSep?: string, wordSep?: string, preserveCase?: boolean}} [opts]
   * @returns {string}
   */
  function decode(text, opts) {
    opts = opts || {};
    var charSep = opts.charSep === undefined ? DEFAULT_CHAR_SEP : String(opts.charSep);
    var wordSep = opts.wordSep === undefined ? DEFAULT_WORD_SEP : String(opts.wordSep);
    var preserveCase = opts.preserveCase !== false;
    if (!separatorsValid(charSep, wordSep)) throw new Error(sepError());

    var groups = splitGroups(text === null || text === undefined ? '' : String(text), charSep, wordSep);
    var out = '';
    var upperNext = false;
    var segment = 0;

    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      if (!group.code) {
        out += ' ';
        continue;
      }
      segment++;
      if (group.value === CAPITAL_MARKER) {
        upperNext = true;
        continue;
      }
      var ch = FROM_MORSE[group.value];
      if (ch === undefined) {
        var err = new Error(t('err_unknown', 'Unknown Morse sequence "{seq}" at segment {n}.')
          .replace('{seq}', group.value)
          .replace('{n}', String(segment)));
        err.sequence = group.value;
        err.segment = segment;
        throw err;
      }
      if (upperNext) {
        ch = ch.toUpperCase();
        upperNext = false;
      } else if (!preserveCase) {
        // 经典摩尔斯码没有大小写，惯例是解出来一律大写
        ch = ch.toUpperCase();
      }
      out += ch;
    }

    if (upperNext) {
      var dangling = new Error(t('err_dangling_marker',
        'The capital marker at segment {n} is not followed by any character.')
        .replace('{n}', String(segment)));
      dangling.segment = segment;
      throw dangling;
    }

    return out;
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('morse-code', function (root) {
    var charSepInput = D.h('input.layui-input#mc-char-sep', { type: 'text', value: DEFAULT_CHAR_SEP });
    var wordSepInput = D.h('input.layui-input#mc-word-sep', { type: 'text', value: DEFAULT_WORD_SEP });
    var preserveCaseBox = D.h('input', { type: 'checkbox' });
    preserveCaseBox.checked = true;

    var encodeInput = D.h('textarea.layui-textarea', { rows: 3, placeholder: t('ph_encode', 'The string to encode') });
    encodeInput.value = 'SOS';
    var encodeOutput = D.h('textarea.layui-textarea.mono-output', {
      rows: 3, readonly: true, placeholder: t('ph_encoded', 'Your string encoded')
    });

    var decodeInput = D.h('textarea.layui-textarea', { rows: 3, placeholder: t('ph_decode', 'The string to decode') });
    // 预填的就是上面那个输入框编出来的结果 —— 两个面板正好对上
    decodeInput.value = '..-.. ... ..-.. --- ..-.. ...';
    var decodeOutput = D.h('textarea.layui-textarea.mono-output', {
      rows: 3, readonly: true, placeholder: t('ph_decoded', 'Your string decoded')
    });

    var encodeStatus = D.h('p.form-status');
    var decodeStatus = D.h('p.form-status');

    function currentOpts() {
      return {
        charSep: charSepInput.value,
        wordSep: wordSepInput.value,
        preserveCase: preserveCaseBox.checked
      };
    }

    function render() {
      var opts = currentOpts();

      if (!separatorsValid(opts.charSep, opts.wordSep)) {
        encodeOutput.value = '';
        decodeOutput.value = '';
        encodeStatus.className = 'form-status is-error';
        encodeStatus.textContent = sepError();
        decodeStatus.className = 'form-status';
        decodeStatus.textContent = '';
        return;
      }

      encodeStatus.className = 'form-status';
      decodeStatus.className = 'form-status';

      var encoded = encodeDetailed(encodeInput.value, opts);
      encodeOutput.value = encoded.code;
      if (encoded.unsupported.length) {
        encodeStatus.className = 'form-status is-warn';
        encodeStatus.textContent = t('warn_unsupported',
          'Characters that are not in the code table were skipped: {chars}')
          .replace('{chars}', encoded.unsupported.join(' '));
      }

      try {
        decodeOutput.value = decode(decodeInput.value, opts);
      } catch (err) {
        decodeOutput.value = '';
        decodeStatus.className = 'form-status is-error';
        decodeStatus.textContent = t('err_decode_title', 'Error while decoding') + ': ' + err.message;
      }
    }

    [encodeInput, decodeInput, charSepInput, wordSepInput].forEach(function (el) {
      el.addEventListener('input', render);
    });
    preserveCaseBox.addEventListener('change', render);

    // ---- 码表参考 ----
    var tableBody = D.h('tbody');
    function appendGroup(title, group) {
      tableBody.appendChild(D.h('tr', null, D.h('th', { colspan: '2', text: title })));
      Object.keys(group).forEach(function (ch) {
        tableBody.appendChild(D.h('tr', null,
          D.h('td', { text: ch }),
          D.h('td.val', { text: group[ch] })
        ));
      });
    }
    appendGroup(t('group_letters', 'Letters'), LETTERS);
    appendGroup(t('group_digits', 'Digits'), DIGITS);
    appendGroup(t('group_punctuation', 'Punctuation'), PUNCTUATION);
    appendGroup(t('group_accented', 'Accented letters'), ACCENTED);

    var table = D.h('table.kv-table', null,
      D.h('thead', null, D.h('tr', null,
        D.h('th', { text: t('col_char', 'Character') }),
        D.h('th', { text: t('col_code', 'Morse code') })
      )),
      tableBody
    );

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null, D.h('span.output-label', { text: t('title_encode', 'Encode') })),
      U.field(t('input_encode', 'Your text:'), encodeInput, {
        wide: true,
        hint: t('hint_encode', 'Spaces separate words, line breaks are encoded as their own sequence.')
      }),
      U.field(t('output_encode', 'Your text encoded to Morse code:'), encodeOutput, { wide: true }),
      encodeStatus,
      D.h('div.form-actions', null,
        U.copyButton(function () { return encodeOutput.value; }, t('copy_encoded', 'Copy encoded'))
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null, D.h('span.output-label', { text: t('title_decode', 'Decode') })),
      U.field(t('input_decode', 'Your Morse code:'), decodeInput, { wide: true }),
      U.field(t('output_decode', 'Your decoded text:'), decodeOutput, { wide: true }),
      decodeStatus,
      D.h('div.form-actions', null,
        U.copyButton(function () { return decodeOutput.value; }, t('copy_decoded', 'Copy decoded'))
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null, D.h('span.output-label', { text: t('title_options', 'Options') })),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'mc-char-sep', text: t('label_char_sep', 'Letter separator') }),
        charSepInput
      ),
      D.h('div.field-row', null,
        D.h('label.field-label', { for: 'mc-word-sep', text: t('label_word_sep', 'Word separator') }),
        wordSepInput
      ),
      D.h('p.field-hint', { text: t('hint_sep', 'The letter separator goes between two characters, the word separator between two words. Default: a space and a slash.') }),
      D.h('label.switch', null, preserveCaseBox,
        D.h('span', { text: t('label_preserve_case', 'Preserve letter case') })),
      D.h('p.field-hint', { text: t('hint_preserve_case', 'When this is off, letters are sent without the capital marker (classic Morse code): the letter case is lost, and decoded letters come out uppercase, like every classic Morse decoder.') }),
      D.h('p.field-hint', { text: t('hint_case', 'Morse code itself has no letter case (ITU-R M.1677-1), so this tool adds one: an uppercase letter is prefixed with the capital marker {marker}. The line break has its own sequence {newline}.')
        .replace('{marker}', CAPITAL_MARKER)
        .replace('{newline}', NEWLINE_CODE) })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-head', null, D.h('span.output-label', { text: t('title_table', 'Code table') })),
      D.h('div', { style: { maxHeight: '420px', overflow: 'auto' } }, table)
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  /* ---------- 纯逻辑挂到这里，node 侧的 jsdom 测试会直接调 ---------- */

  window.ItTools.logic['morse-code'] = {
    encode: encode,
    encodeDetailed: encodeDetailed,
    decode: decode,
    unsupportedChars: unsupportedChars,
    separatorsValid: separatorsValid,
    LETTERS: LETTERS,
    DIGITS: DIGITS,
    PUNCTUATION: PUNCTUATION,
    ACCENTED: ACCENTED,
    CAPITAL_MARKER: CAPITAL_MARKER,
    NEWLINE_CODE: NEWLINE_CODE,
    __cases: function (assert) {
      // —— 与上游 morsee 的行为对齐的部分（上游自己的测试用例）——
      assert.eq(encode('h'), '....', '单个字母');
      assert.eq(encode('hi'), '.... ..', '两个字母之间用空格');
      assert.eq(encode('hi friend'), '.... .. / ..-. .-. .. . -. -..', '词之间用斜杠');
      assert.eq(encode('hi!'), '.... .. -.-.--', '标点');
      assert.eq(decode('....'), 'h', '解一个字母');
      assert.eq(decode('.... ..'), 'hi', '解两个字母');
      assert.eq(decode('.... .. / ..-. .-. .. . -. -..'), 'hi friend', '解一整句');
      assert.eq(decode('.... .. -.-.--'), 'hi!', '解带标点的句子');

      // —— 大小写 ——
      assert.eq(encode('sos'), '... --- ...', '小写 sos 是经典的 ... --- ...');
      assert.eq(encode('SOS'), '..-.. ... ..-.. --- ..-.. ...', '大写字母带大写标记');
      assert.eq(encode('SOS', { preserveCase: false }), '... --- ...', '经典模式下 SOS 就是 ... --- ...');
      assert.eq(encode('Hi'), '..-.. .... ..', '大小写混排：只有 H 带标记');
      assert.eq(decode(encode('Hi')), 'Hi', '大小写混排往返');
      assert.eq(decode(encode('SOS')), 'SOS', '全大写往返');
      assert.eq(decode(encode('SOS', { preserveCase: false }), { preserveCase: false }), 'SOS',
        '经典模式解出来一律是大写');
      assert.eq(decode('.... ..', { preserveCase: false }), 'HI', '经典模式解出来是大写字母');
      assert.eq(decode('.... ..'), 'hi', '默认模式解出来是小写（码表的键就是小写）');
      assert.eq(decode('..-.. .... ..'), 'Hi', '解码认得大写标记');
      assert.eq(decode('..-.. ...'), 'S', '标记只作用于下一个字符组');
      assert.eq(encode('a', { preserveCase: false }), '.-', '经典模式字母还是同一个码');

      // —— 标点与数字 ——
      assert.eq(encode('0123456789'), '----- .---- ..--- ...-- ....- ..... -.... --... ---.. ----.',
        '10 个数字');
      assert.eq(encode('!?.,'), '-.-.-- ..--.. .-.-.- --..--', '常用标点');
      assert.eq(encode('a-b'), '.- -....- -...', '连字符');

      // —— 变音字母（上游 nonEnglish，码表里的 − 与 · 已归一化）——
      assert.eq(encode('ä'), '.-.-', 'ä 的码里没有非 ASCII 的减号与间隔号');
      assert(/^[\.\- ]+$/.test(encode('àåçéñüöø')), '变音字母只用 ASCII 的点与划');
      assert.eq(decode(encode('ä')), 'ä', '变音字母往返');

      // —— 往返 ——
      assert.eq(decode(encode('Hello, World!')), 'Hello, World!', '整句往返');
      assert.eq(decode(encode('hi friend')), 'hi friend', '带词的整句往返');
      assert.eq(decode(encode('a\nb')), 'a\nb', '换行往返');

      // —— 空输入 ——
      assert.eq(encode(''), '', '空串编码');
      assert.eq(decode(''), '', '空串解码');
      assert.eq(encode('   '), '/', '只有空格就是一个词分隔符');

      // —— 分隔符可配 ——
      assert.eq(encode('hi friend', { charSep: '|', wordSep: '//' }), '....|..|//|..-.|.-.|..|.|-.|-..',
        '自定义分隔符');
      assert.eq(decode('....|..|//|..-.|.-.|..|.|-.|-..', { charSep: '|', wordSep: '//' }), 'hi friend',
        '自定义分隔符解码');
      assert(separatorsValid(' ', '/'), '默认分隔组合法');
      assert(!separatorsValid('', '/'), '空分隔符不合法');
      assert(!separatorsValid(' ', ' '), '两个分隔符不能相同');
      assert(!separatorsValid('.', '/'), '分隔符不能含摩尔斯码的点');
      assert(!separatorsValid('-', '/'), '分隔符不能含摩尔斯码的划');
      assert(!separatorsValid(' ', ' /'), '词分隔符不能是字符分隔符的子串');
      var sepThrew = false;
      try { encode('hi', { charSep: '' }); } catch (e) { sepThrew = true; }
      assert(sepThrew, '非法分隔符编码要抛错');
      var sepThrew2 = false;
      try { decode('.... ..', { wordSep: '-' }); } catch (e) { sepThrew2 = true; }
      assert(sepThrew2, '非法分隔符解码要抛错');

      // —— 非法序列要报错，并指出第几段 ——
      var caught = null;
      try { decode('.... .. ..--..x'); } catch (e) { caught = e; }
      assert(caught !== null, '未知序列要抛错');
      assert(caught && caught.segment === 3, '错误里带着段号');
      assert(caught && caught.sequence === '..--..x', '错误里带着出错的序列');
      assert(caught && /segment 3/.test(caught.message), '错误消息里写了第几段');

      var caught2 = null;
      try { decode('..-..'); } catch (e) { caught2 = e; }
      assert(caught2 !== null, '大写标记后面没有字符要抛错');

      // —— 码表里没有的字符不能静默丢掉 ——
      assert.eq(unsupportedChars('a中b').join(''), '中', '报出码表里没有的字符');
      assert.eq(encode('a中b'), '.- -...', '码表里没有的字符被跳过');
      assert.eq(unsupportedChars('SOS').length, 0, '常见字符都能编');
    }
  };
})();
