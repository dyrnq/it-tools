/* ==========================================================================
   文本统计（text-statistics）

   统计一段文本的字符数、词数、句数、段落数、行数、UTF-8 字节数，
   并按成人阅读 / 语速估算耗时。

   参考实现：src/tools/text-statistics/（it-tools, GPLv3）
   与原版的差别：
   1. 原版的词数用 text.split(/\s+/).length，头尾空白会各多切出一个空串，
      ' hello ' 会被算成 3 个词；这里先 trim 再数。
   2. 原版的字符数用 String.length，那是 UTF-16 码元数，一个 emoji 算 2。
      这里按码点统计（另外单列「不含空白」一项），已在界面上注明口径。
   3. 句子数与段落数是原版没有的，按业界常见口径补上：
      句子 = 以 . ! ? … 收尾且后面是空白或串尾的片段（所以 'Dr.' 这类缩写
      仍会被误判成句末，这是有意接受的简化）。
   4. 上游 PR #1010 要的「按字符类别分个数」补齐了（上游只有大写/小写/数字/标点/
      空白五项，而且是用正则 replace 数的 —— 那是 UTF-16 单元数，一个 emoji
      会被算成 2 个空白，跟本页「字符数按码点」的口径对不上）。
      这里逐个码点判，口径跟「字符数」一致；另外多给了「区分大小写的不重复词数」
      （上游只有不分大小写的那一版）。

   参考项目的 formatBytes 是 1024 进制、保留 2 位小数，这里照抄。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('text-statistics');

  // 默认真实数据：成人默读英文约 200 词/分钟，正常语速约 130 词/分钟
  var WORDS_PER_MINUTE_READ = 200;
  var WORDS_PER_MINUTE_SPEAK = 130;

  function str(text) {
    return text == null ? '' : String(text);
  }

  /** 码点数（不是 UTF-16 长度）：emoji 算一个字符。 */
  function countCharacters(text) {
    return Array.from(str(text)).length;
  }

  /** 去掉所有空白后的码点数。 */
  function countCharactersNoSpaces(text) {
    return countCharacters(str(text).replace(/\s+/g, ''));
  }

  /** 词数：按空白切，先 trim，避免头尾空白多切出空串。 */
  function countWords(text) {
    var trimmed = str(text).trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  /** 去重词数（忽略大小写）。 */
  function countUniqueWords(text) {
    var trimmed = str(text).trim();
    if (!trimmed) return 0;
    return new Set(trimmed.toLowerCase().split(/\s+/)).size;
  }

  /**
   * 去重词数（**区分**大小写）：'Word' 与 'word' 算两个词。
   */
  function countUniqueWordsCaseSensitive(text) {
    var trimmed = str(text).trim();
    if (!trimmed) return 0;
    return new Set(trimmed.split(/\s+/)).size;
  }

  /**
   * 不含标点的词数：先把标点去掉，再按空白切。
   *
   * 注意口径：标点是**直接删掉**的，所以 'a,b' 会并成一个词 'ab'，
   * 'don't' 会变成 'dont'。这跟上游 #1010 的算法一致。
   */
  function countWordsWithoutPunctuation(text) {
    var stripped = str(text).replace(/\p{P}/gu, '').trim();
    return stripped ? stripped.split(/\s+/).length : 0;
  }

  /**
   * 按 Unicode 类别把字符分个数一遍。
   *
   * 逐个**码点**判，不用正则 replace —— replace 那套数的是 UTF-16 单元，
   * 一个 emoji 会被算成 2 个空白，跟本页「字符数按码点」的口径对不上。
   *
   * 分类（大写/小写/数字/标点互不重叠）：
   *   空白   \s
   *   大写   \p{Lu}（各种文字系统的大写字母都算，不只是 A-Z）
   *   小写   \p{Ll}
   *   数字   \p{Nd}（十进制数字，含阿拉伯-印度数字 ٠١٢ —— \d 只认 ASCII）
   *   标点   \p{P}（句点、逗号、引号、括号……）
   *
   * @param {string} text
   * @returns {{upper: number, lower: number, digits: number, punctuation: number, whitespace: number}}
   */
  function countCharacterClasses(text) {
    var counts = { upper: 0, lower: 0, digits: 0, punctuation: 0, whitespace: 0 };
    var chars = Array.from(str(text));
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (/\s/u.test(ch)) counts.whitespace++;
      else if (/\p{Lu}/u.test(ch)) counts.upper++;
      else if (/\p{Ll}/u.test(ch)) counts.lower++;
      else if (/\p{Nd}/u.test(ch)) counts.digits++;
      else if (/\p{P}/u.test(ch)) counts.punctuation++;
    }
    return counts;
  }

  /** 句数：句末标点后必须跟空白或串尾，否则 'Dr.' 这类缩写会被切开。 */
  function countSentences(text) {
    var trimmed = str(text).trim();
    if (!trimmed) return 0;
    return trimmed.split(/[.!?…]+(?=\s|$)/).filter(function (part) {
      return /\S/.test(part);
    }).length;
  }

  /** 段落数：空行（可含缩进）分隔。 */
  function countParagraphs(text) {
    var trimmed = str(text).trim();
    if (!trimmed) return 0;
    return trimmed.split(/\n[ \t]*(?:\r?\n)+/).filter(function (part) {
      return /\S/.test(part);
    }).length;
  }

  /** 行数：CRLF / CR / LF 都算换行；空文本记 0（与原版一致）。 */
  function countLines(text) {
    var value = str(text);
    if (!value) return 0;
    return value.split(/\r\n|\r|\n/).length;
  }

  /** 行里非空白的字符数，写代码时的有效行数用。 */
  function countNonEmptyLines(text) {
    var value = str(text);
    if (!value) return 0;
    return value.split(/\r\n|\r|\n/).filter(function (line) {
      return /\S/.test(line);
    }).length;
  }

  /** UTF-8 字节数。 */
  function byteSize(text) {
    return U.utf8Bytes(str(text)).length;
  }

  /** 1024 进制的可读体积，与参考项目的 formatBytes 一致。 */
  function formatBytes(bytes) {
    if (!bytes) return '0 Bytes';
    var k = 1024;
    var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    var i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /** 秒 → 「45 s」「2 min 5 s」「1 h 3 min」。 */
  function formatDuration(seconds) {
    var total = Math.round(seconds);
    if (total < 60) return total + ' s';
    var minutes = Math.floor(total / 60);
    var restSeconds = total % 60;
    if (minutes < 60) return minutes + ' min' + (restSeconds ? ' ' + restSeconds + ' s' : '');
    var hours = Math.floor(minutes / 60);
    var restMinutes = minutes % 60;
    return hours + ' h' + (restMinutes ? ' ' + restMinutes + ' min' : '');
  }

  /**
   * 一次统计的全部指标，界面直接按顺序渲染成表。
   *
   * label 是显示名，走 i18n；id 是稳定的内部标识（不随语言变），
   * 断言按 id 查值 —— 见 __cases 里的 byId。
   */
  function statistics(text) {
    var words = countWords(text);
    var classes = countCharacterClasses(text);
    var classHint = t('hint_unicode_classes',
      'Counted by Unicode category: uppercase Lu, lowercase Ll, digits Nd, punctuation P');
    return [
      {
        id: 'characters',
        label: t('characters', 'Characters'),
        value: String(countCharacters(text)),
        hint: t('hint_codepoint', 'Counted by code point; an emoji counts as 1 character')
      },
      {
        id: 'characters_without_spaces',
        label: t('characters_without_spaces', 'Characters without spaces'),
        value: String(countCharactersNoSpaces(text))
      },
      {
        id: 'characters_whitespace',
        label: t('characters_whitespace', 'Whitespace characters'),
        value: String(classes.whitespace),
        hint: t('hint_whitespace', 'Spaces, tabs and line breaks')
      },
      {
        id: 'characters_upper',
        label: t('characters_upper', 'Uppercase characters'),
        value: String(classes.upper),
        hint: classHint
      },
      {
        id: 'characters_lower',
        label: t('characters_lower', 'Lowercase characters'),
        value: String(classes.lower),
        hint: classHint
      },
      {
        id: 'characters_digits',
        label: t('characters_digits', 'Digit characters'),
        value: String(classes.digits),
        hint: classHint
      },
      {
        id: 'characters_punctuation',
        label: t('characters_punctuation', 'Punctuation characters'),
        value: String(classes.punctuation),
        hint: classHint
      },
      { id: 'words', label: t('words', 'Words'), value: String(words) },
      {
        id: 'words_without_punctuation',
        label: t('words_without_punctuation', 'Words without punctuation'),
        value: String(countWordsWithoutPunctuation(text)),
        hint: t('hint_punctuation_removed', 'Punctuation is removed before splitting')
      },
      {
        id: 'unique_words',
        label: t('unique_words', 'Unique words'),
        value: String(countUniqueWords(text)),
        hint: t('hint_ignore_case', 'Case-insensitive')
      },
      {
        id: 'unique_words_case_sensitive',
        label: t('unique_words_case_sensitive', 'Unique words (case-sensitive)'),
        value: String(countUniqueWordsCaseSensitive(text)),
        hint: t('hint_case_sensitive', '"Word" and "word" count as two')
      },
      { id: 'sentences', label: t('sentences', 'Sentences'), value: String(countSentences(text)) },
      { id: 'paragraphs', label: t('paragraphs', 'Paragraphs'), value: String(countParagraphs(text)) },
      { id: 'lines', label: t('lines', 'Lines'), value: String(countLines(text)) },
      { id: 'non_empty_lines', label: t('non_empty_lines', 'Non-empty lines'), value: String(countNonEmptyLines(text)) },
      { id: 'bytes_utf8', label: t('bytes_utf8', 'Bytes (UTF-8)'), value: String(byteSize(text)) },
      { id: 'size', label: t('size', 'Size'), value: formatBytes(byteSize(text)) },
      {
        id: 'reading_time',
        label: t('reading_time', 'Reading time'),
        value: formatDuration(words / WORDS_PER_MINUTE_READ * 60),
        hint: t('read_rate', '{rate} words per minute').replace('{rate}', WORDS_PER_MINUTE_READ)
      },
      {
        id: 'speaking_time',
        label: t('speaking_time', 'Speaking time'),
        value: formatDuration(words / WORDS_PER_MINUTE_SPEAK * 60),
        hint: t('speak_rate', '{rate} words per minute').replace('{rate}', WORDS_PER_MINUTE_SPEAK)
      }
    ];
  }

  window.ItTools.register('text-statistics', function (root) {
    var textarea = D.h('textarea.layui-textarea', { rows: 8, placeholder: t('input_ph', 'Your text...') });
    var tbody = D.h('tbody');

    function render() {
      D.clear(tbody);
      statistics(textarea.value).forEach(function (row) {
        tbody.appendChild(D.h('tr', null,
          D.h('td', null, row.label, row.hint ? D.h('span.field-hint', { text: row.hint }) : null),
          D.h('td.val', { text: row.value })
        ));
      });
    }

    textarea.addEventListener('input', render);

    // 原版这一页只有**一张** c-card：输入框和统计表都在里面。
    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your text:'), textarea, { wide: true }),
      D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_metric', 'Metric') }),
          D.h('th', { text: t('col_value', 'Value') })
        )),
        tbody
      ),
      D.h('p.field-hint', {
        text: t('sentence_note', 'Sentences end at . ! ? …; abbreviations such as "Dr." count as sentence ends.')
      })
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['text-statistics'] = {
    statistics: statistics,
    countCharacters: countCharacters,
    countWords: countWords,
    countUniqueWords: countUniqueWords,
    countUniqueWordsCaseSensitive: countUniqueWordsCaseSensitive,
    countWordsWithoutPunctuation: countWordsWithoutPunctuation,
    countCharacterClasses: countCharacterClasses,
    countSentences: countSentences,
    countParagraphs: countParagraphs,
    countLines: countLines,
    countNonEmptyLines: countNonEmptyLines,
    byteSize: byteSize,
    formatBytes: formatBytes,
    formatDuration: formatDuration,
    __cases: function (assert) {
      // 与参考实现的 vitest 用例一致：UTF-8 字节数
      assert.eq(byteSize(''), 0, '空串');
      assert.eq(byteSize('a'), 1, '一个 ASCII 字符');
      assert.eq(byteSize('aa'), 2, '两个 ASCII 字符');
      assert.eq(byteSize('😀'), 4, 'emoji 占 4 字节');
      assert.eq(byteSize('aaaaaaaaaa'), 10, '十个 ASCII 字符');

      // 字符数按码点，与 String.length 不同
      assert.eq(countCharacters(''), 0, '空串');
      assert.eq(countCharacters('abc'), 3, 'ASCII');
      assert.eq(countCharacters('😀'), 1, 'emoji 只算一个字符');
      assert.eq('😀'.length, 2, '对照：String.length 会算成 2');
      assert.eq(countCharactersNoSpaces('a b\tc\n'), 3, '去掉空白后 3 个字符');

      // 词数
      assert.eq(countWords(''), 0, '空串没有词');
      assert.eq(countWords('   '), 0, '纯空白没有词');
      assert.eq(countWords('hello world'), 2, '两个词');
      assert.eq(countWords(' hello '), 1, '头尾空白不再多切空串');
      assert.eq(countWords('a\tb\nc'), 3, '制表符与换行也算分隔');
      assert.eq(countUniqueWords('a b a c A'), 3, '去重忽略大小写');
      assert.eq(countUniqueWordsCaseSensitive('a b a c A'), 4, '区分大小写时 A 与 a 是两个词');
      assert.eq(countUniqueWordsCaseSensitive(''), 0, '空串');
      assert.eq(countUniqueWordsCaseSensitive('a a a'), 1, '同一个词重复只算一个');

      // 不含标点的词数（上游 #1010 的口径：先把标点删掉再切）
      assert.eq(countWordsWithoutPunctuation(''), 0, '空串');
      assert.eq(countWordsWithoutPunctuation('   '), 0, '纯空白');
      assert.eq(countWordsWithoutPunctuation('hello, world'), 2, '逗号删掉后还是两个词');
      assert.eq(countWordsWithoutPunctuation('hello world'), 2, '没有标点时与词数相同');
      assert.eq(countWordsWithoutPunctuation("don't"), 1, '撇号删掉后是一个词');
      assert.eq(countWordsWithoutPunctuation('a,b'), 1, '标点删掉后相邻的词会并成一个');

      // 字符按 Unicode 类别分类（上游 #1010 补的那几项）
      var cls = countCharacterClasses('Ab1, !\n');
      assert.eq(cls.upper, 1, '1 个大写字母');
      assert.eq(cls.lower, 1, '1 个小写字母');
      assert.eq(cls.digits, 1, '1 个数字');
      assert.eq(cls.punctuation, 2, '逗号与感叹号共 2 个标点');
      assert.eq(cls.whitespace, 2, '2 个空白（一个空格、一个换行）');
      assert.eq(countCharacterClasses('').upper, 0, '空串各类都是 0');
      // 上游用正则 replace 数的是 UTF-16 单元，emoji 会被算成 2 个空白
      assert.eq(countCharacterClasses('😀').whitespace, 0, 'emoji 不算空白');
      assert.eq(countCharacterClasses('😀').digits, 0, 'emoji 不算数字');
      assert.eq(countCharacterClasses('٠١٢').digits, 3, '阿拉伯-印度数字也算数字（\\d 只认 ASCII）');
      assert.eq(countCharacterClasses('ÄÖÜ').upper, 3, '非 ASCII 的大写字母也算大写');
      assert.eq(countCharacterClasses('äöü').lower, 3, '非 ASCII 的小写字母也算小写');

      // 句子 / 段落 / 行
      assert.eq(countSentences(''), 0, '空串');
      assert.eq(countSentences('One.'), 1, '单句');
      assert.eq(countSentences('One. Two! Three?'), 3, '三种句末标点');
      assert.eq(countSentences('Wow...'), 1, '连续省略号算一句');
      assert.eq(countSentences('3.14 is pi'), 1, '小数点不切句');
      assert.eq(countParagraphs('a\n\nb'), 2, '空行分段');
      assert.eq(countParagraphs('a\n  \nb'), 2, '只含空格的空行也算');
      assert.eq(countParagraphs('a\nb'), 1, '单换行不分段');
      assert.eq(countLines(''), 0, '空文本 0 行');
      assert.eq(countLines('a'), 1, '单行');
      assert.eq(countLines('a\nb\nc'), 3, '三行');
      assert.eq(countLines('a\r\nb'), 2, 'CRLF 算一个换行');
      assert.eq(countLines('a\n\nb'), 3, '空行也算一行');
      assert.eq(countNonEmptyLines('a\n\nb'), 2, '非空行 2 行');

      // 体积与耗时
      assert.eq(formatBytes(0), '0 Bytes', '0 字节');
      assert.eq(formatBytes(500), '500 Bytes', '不足 1 KB');
      assert.eq(formatBytes(1024), '1 KB', '整 1 KB');
      assert.eq(formatBytes(1536), '1.5 KB', '1.5 KB');
      assert.eq(formatBytes(1048576), '1 MB', '整 1 MB');
      assert.eq(formatDuration(0), '0 s', '0 秒');
      assert.eq(formatDuration(45), '45 s', '不到 1 分钟');
      assert.eq(formatDuration(60), '1 min', '整 1 分钟');
      assert.eq(formatDuration(125), '2 min 5 s', '分秒');
      assert.eq(formatDuration(3660), '1 h 1 min', '时分');

      // 汇总表
      // label 现在是翻译过的显示名，断言一律按稳定的 id 查
      var rows = statistics('Hello world. Bye!');
      var byId = {};
      rows.forEach(function (row) { byId[row.id] = row; });
      assert.eq(rows.length, 19, '19 项指标');
      assert.eq(byId.characters.value, '17', '17 个字符');
      assert.eq(byId.words.value, '3', '3 个词');
      assert.eq(byId.sentences.value, '2', '2 句');
      assert.eq(byId.characters_upper.value, '2', 'H 与 B 是大写');
      assert.eq(byId.characters_lower.value, '11', '其余 11 个是小写');
      assert.eq(byId.characters_punctuation.value, '2', '句点与感叹号共 2 个标点');
      assert.eq(byId.characters_whitespace.value, '2', '两个空格');
      assert.eq(byId.words_without_punctuation.value, '3', '去掉句点还是 3 个词');
      assert.eq(byId.unique_words_case_sensitive.value, '3', '三个词互不相同');
      // 口径自洽：字符数 = 不含空白的字符数 + 空白字符数
      assert.eq(
        String(Number(byId.characters.value)),
        String(Number(byId.characters_without_spaces.value) + Number(byId.characters_whitespace.value)),
        '字符数 = 不含空白的 + 空白的');
    }
  };
})();