/* ==========================================================================
   去重词频统计（distinct-words）

   把一段文本切成词，统计每个不同的词出现了多少次，按次数降序列成表。

   参考实现：src/tools/distinct-words/（it-tools2 的 fork，Vue 写的）
   与上游的差别：
   1. 上游只有一个输入框，标点是**永远**被清掉的，而且清理得不干净：
      它用的是 /\p{P}+\s|\s\p{P}+|\p{P}+$|^\p{P}+|\s+/gu —— 只有「紧挨着空白」
      或「在首尾」的标点会被去掉，夹在词中间的标点留着（"a,b" 仍是一个词，
      "don't" 仍是一个词）。这里把这件事交给用户：默认按空白切（标点算词的
      一部分），另给一个「标点也切」的开关。
   2. 上游清标点之后用 countBy(cleanedText.split(' '))，而 ''.split(' ') 是
      [''] —— 所以**输入为空时表里会多出一行「空词，1 次」**。这里空输入
      就是空表。
   3. 上游用普通对象存词频，像 "10"、"2" 这样的词会按数字键的规则重排
      （"10" 排在 "2" 前面）；而且 orderBy 对次数相同的词不保证稳定。这里
      用 Map 统计，排序写死「次数降序、次数相同按词升序」—— 结果可复现。
   4. 上游没有大小写开关（"Word" 和 "word" 算两个词）。这里默认**区分**
      大小写，另给一个「忽略大小写」的开关；打开后词条统一显示为小写。
   5. 上游的标点清理是「删掉」，跟这里的「切分」不是一回事：切分会把
      "don't" 切成 "don" 和 "t"，删掉则变成 "dont"。

   不依赖任何第三方库。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('distinct-words');

  /**
   * 分词。
   *
   * 默认按空白切；opts.splitOnPunctuation 为真时标点也当分隔符。
   *
   * 标点取的是 Unicode 的 P 类（句点、逗号、引号、括号……）。数学符号与
   * 货币符号（$ + = €）属于 S 类，**不**切 —— 这跟上游清标点时的口径一致，
   * 界面上也写明了。
   *
   * @param {string} text
   * @param {{splitOnPunctuation?:boolean}} [opts]
   * @returns {string[]}
   */
  function splitWords(text, opts) {
    opts = opts || {};
    var s = text == null ? '' : String(text);
    if (!s) return [];
    var parts = opts.splitOnPunctuation
      ? s.split(/[\s\p{P}]+/u)
      : s.split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) out.push(parts[i]);
    }
    return out;
  }

  /**
   * 统计词频。
   *
   * @param {string} text
   * @param {{ignoreCase?:boolean, splitOnPunctuation?:boolean}} [opts]
   * @returns {{rows: {word:string,count:number}[], total:number}}
   *   rows  按次数降序、次数相同按词升序（UTF-16 码元序，跟 locale 无关，
   *         任何机器上排出来的顺序都一样）
   *   total 切出来的词总数（含重复）
   */
  function countWords(text, opts) {
    opts = opts || {};
    var words = splitWords(text, opts);
    var counts = new Map();
    var i;
    for (i = 0; i < words.length; i++) {
      var key = opts.ignoreCase ? words[i].toLowerCase() : words[i];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    var rows = [];
    counts.forEach(function (count, word) {
      rows.push({ word: word, count: count });
    });
    rows.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      if (a.word < b.word) return -1;
      if (a.word > b.word) return 1;
      return 0;
    });
    return { rows: rows, total: words.length };
  }

  /** 词频清单：「词<TAB>次数」，一行一条 —— 复制 / 下载用的就是它。 */
  function wordsToText(result) {
    return result.rows.map(function (r) { return r.word + '\t' + r.count; }).join('\n');
  }

  window.ItTools.register('distinct-words', function (root) {
    var opts = { ignoreCase: false, splitOnPunctuation: false };

    var textarea = D.h('textarea.layui-textarea', {
      rows: 10,
      placeholder: t('input_ph', 'Paste the text you want to count the words in.'),
      spellcheck: 'false'
    });

    var status = D.h('p.field-hint');
    var tbody = D.h('tbody');
    var table = D.h('table.result-table', null,
      D.h('thead', null, D.h('tr', null,
        D.h('th', { text: t('col_word', 'Word') }),
        D.h('th', { text: t('col_count', 'Occurrences') })
      )),
      tbody
    );

    function currentResult() {
      return countWords(textarea.value, opts);
    }

    function render() {
      var result = currentResult();
      D.clear(tbody);
      result.rows.forEach(function (row) {
        tbody.appendChild(D.h('tr', null,
          D.h('td', null,
            D.h('span', {
              style: {
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
              },
              text: row.word
            }),
            ' ',
            U.copyButton(function () { return row.word; })
          ),
          D.h('td', { text: String(row.count) })
        ));
      });

      table.style.display = result.rows.length ? '' : 'none';

      if (!result.total) {
        status.textContent = t('status_empty', 'Type or paste some text to count the words.');
      } else {
        status.textContent = t('status_found', '{count} distinct word(s) out of {total} word(s).')
          .replace('{count}', String(result.rows.length))
          .replace('{total}', String(result.total));
      }
    }

    textarea.addEventListener('input', render);

    var toggles = [
      { key: 'ignoreCase', label: t('ignore_case', 'Ignore case') },
      { key: 'splitOnPunctuation', label: t('split_punctuation', 'Also split on punctuation') }
    ].map(function (tg) {
      var input = D.h('input', { type: 'checkbox' });
      input.addEventListener('change', function () {
        opts[tg.key] = input.checked;
        render();
      });
      return D.h('label.switch', null, input, D.h('span', { text: tg.label }));
    });

    var copyAll = U.copyButton(function () {
      return wordsToText(currentResult());
    }, t('copy_all', 'Copy all'));

    var downloadBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button',
      text: t('download', 'Download'),
      onclick: function () {
        var text = wordsToText(currentResult());
        if (!text) return;
        window.ItTools.download('word-frequencies.tsv', text, 'text/tab-separated-values;charset=utf-8');
      }
    });

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your text:'), textarea, { wide: true }),
      D.h('div.switch-grid', null, toggles),
      D.h('p.field-hint', {
        text: t('note_options', 'Words are split on whitespace. "Also split on punctuation" additionally splits on Unicode punctuation (.,;:!?…), but not on symbols such as $ or +. With "Ignore case" on, words are lower-cased and listed in lower case.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.code-label', { style: { marginBottom: '8px' }, text: t('result', 'Word frequencies') }),
      status,
      table,
      D.h('div.form-actions', null, copyAll, downloadBtn)
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['distinct-words'] = {
    splitWords: splitWords,
    countWords: countWords,
    wordsToText: wordsToText,
    __cases: function (assert) {
      /* ---- 分词 ---- */
      assert.eq(splitWords(''), [], '空文本没有词');
      assert.eq(splitWords('   '), [], '纯空白没有词');
      assert.eq(splitWords('a b c'), ['a', 'b', 'c'], '按空白切');
      assert.eq(splitWords(' a  b '), ['a', 'b'], '头尾空白与连续空白不产生空词');
      assert.eq(splitWords('a\tb\nc'), ['a', 'b', 'c'], '制表符与换行也算分隔');
      assert.eq(splitWords('a,b'), ['a,b'], '默认标点算词的一部分');
      assert.eq(splitWords('a,b', { splitOnPunctuation: true }), ['a', 'b'], '打开开关后标点也切');
      assert.eq(splitWords('hello, world!', { splitOnPunctuation: true }), ['hello', 'world'], '标点切开后不剩空词');
      assert.eq(splitWords('don\'t', { splitOnPunctuation: true }), ['don', 't'], '词中间的撇号也会切开');
      assert.eq(splitWords('$100 + 2', { splitOnPunctuation: true }), ['$100', '+', '2'], '符号属于 S 类，不切');

      /* ---- 词频 ---- */
      var r = countWords('a b a c');
      assert.eq(r.rows, [{ word: 'a', count: 2 }, { word: 'b', count: 1 }, { word: 'c', count: 1 }], '按次数降序');
      assert.eq(r.total, 4, '一共 4 个词');
      assert.eq(countWords('').rows, [], '空输入没有词（上游会多出一行空词）');
      assert.eq(countWords('   ').rows, [], '纯空白也没有词');
      assert.eq(countWords('a a a').rows, [{ word: 'a', count: 3 }], '同一个词只列一行');

      /* ---- 次数相同时按词升序 ---- */
      r = countWords('b a c');
      assert.eq(r.rows.map(function (x) { return x.word; }), ['a', 'b', 'c'], '次数相同按词升序');
      // 上游用普通对象存词频，"10" 这种数字键会排在 "2" 前面
      r = countWords('10 2');
      assert.eq(r.rows.map(function (x) { return x.word; }), ['10', '2'], '数字词按码元序排，不按数字大小');

      /* ---- 大小写 ---- */
      assert.eq(countWords('Word word').rows.length, 2, '默认区分大小写');
      r = countWords('Word word', { ignoreCase: true });
      assert.eq(r.rows, [{ word: 'word', count: 2 }], '忽略大小写后合并成一行，且显示为小写');

      /* ---- 复制 / 下载用的文本 ---- */
      assert.eq(wordsToText(countWords('a b a')), 'a\t2\nb\t1', '清单是「词<TAB>次数」');
      assert.eq(wordsToText(countWords('')), '', '没有词时是空串');
    }
  };
})();
