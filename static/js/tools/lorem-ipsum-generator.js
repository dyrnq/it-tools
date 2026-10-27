/* ==========================================================================
   占位文本生成器（lorem-ipsum-generator）

   按段落数 / 每段句数 / 每句词数随机生成 lorem ipsum，可选择以
   "Lorem ipsum dolor sit amet..." 开头，或直接输出 <p> 包裹的 HTML。

   参考实现：src/tools/lorem-ipsum-generator/（it-tools, GPLv3）
   与原版的两处差别：
   1. 原版的区间随机 randIntFromInterval(min, max) 取不到上界（[min, max-1]），
      词数上限 15 实际最多只能出 14；这里改成闭区间 [min, max]。
   2. 原版在 paragraphCount = 0 且「以 lorem ipsum 开头」打开时会直接抛
      TypeError（paragraphs[0][0] 越界）；这里对空结果做了保护。
   随机数一律走 U.randomInt / U.randomPick（crypto），不用 Math.random。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('lorem-ipsum-generator');

  /** 内置词库（与参考实现一致，165 个拉丁词） */
  var VOCABULARY = [
    'a', 'ac', 'accumsan', 'ad', 'adipiscing', 'aenean', 'aliquam', 'aliquet', 'amet', 'ante',
    'aptent', 'arcu', 'at', 'auctor', 'bibendum', 'blandit', 'class', 'commodo', 'condimentum',
    'congue', 'consectetur', 'consequat', 'conubia', 'convallis', 'cras', 'cubilia', 'cum',
    'curabitur', 'curae', 'dapibus', 'diam', 'dictum', 'dictumst', 'dignissim', 'dolor', 'donec',
    'dui', 'duis', 'egestas', 'eget', 'eleifend', 'elementum', 'elit', 'enim', 'erat', 'eros',
    'est', 'et', 'etiam', 'eu', 'euismod', 'facilisi', 'faucibus', 'felis', 'fermentum', 'feugiat',
    'fringilla', 'fusce', 'gravida', 'habitant', 'habitasse', 'hac', 'hendrerit', 'himenaeos',
    'iaculis', 'id', 'imperdiet', 'in', 'inceptos', 'integer', 'interdum', 'ipsum', 'justo',
    'lacinia', 'lacus', 'laoreet', 'lectus', 'leo', 'ligula', 'litora', 'lobortis', 'lorem',
    'luctus', 'maecenas', 'magna', 'magnis', 'malesuada', 'massa', 'mattis', 'mauris', 'metus',
    'mi', 'molestie', 'mollis', 'montes', 'morbi', 'mus', 'nam', 'nascetur', 'natoque', 'nec',
    'neque', 'netus', 'nisi', 'nisl', 'non', 'nostra', 'nulla', 'nullam', 'nunc', 'odio', 'orci',
    'ornare', 'parturient', 'pellentesque', 'penatibus', 'per', 'pharetra', 'phasellus', 'placerat',
    'platea', 'porta', 'porttitor', 'posuere', 'potenti', 'praesent', 'pretium', 'primis', 'proin',
    'pulvinar', 'purus', 'quam', 'quis', 'quisque', 'rhoncus', 'ridiculus', 'risus', 'rutrum',
    'sagittis', 'sapien', 'scelerisque', 'sed', 'sem', 'semper', 'senectus', 'sit', 'sociis',
    'sociosqu', 'sodales', 'sollicitudin', 'suscipit', 'suspendisse', 'taciti', 'tellus',
    'tempor', 'tempus', 'tincidunt', 'torquent', 'tortor', 'turpis', 'ullamcorper', 'ultrices',
    'ultricies', 'urna', 'varius', 'vehicula', 'vel', 'velit', 'venenatis', 'vestibulum', 'vitae',
    'vivamus', 'viverra', 'volutpat', 'vulputate'
  ];

  var FIRST_SENTENCE = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';

  /** [min, max] 闭区间随机整数（原版取不到上界，这里补上） */
  function randomIntRange(min, max) {
    var lo = Math.max(0, Math.floor(min));
    var hi = Math.floor(max);
    if (hi < lo) hi = lo;
    return lo + U.randomInt(hi - lo + 1);
  }

  /** 随机取一个词 */
  function randomWord() { return U.randomPick(VOCABULARY); }

  /** 一句话：wordCount 个词，首字母大写，句末补句号 */
  function generateSentence(wordCount) {
    var words = [];
    for (var i = 0; i < wordCount; i++) words.push(randomWord());
    var sentence = words.join(' ');
    return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
  }

  /**
   * 生成占位文本。
   * @param {{paragraphCount?:number, sentencePerParagraph?:number, wordCount?:number,
   *          startWithLoremIpsum?:boolean, asHTML?:boolean}} [opts]
   */
  function generateLoremIpsum(opts) {
    opts = opts || {};
    var paragraphCount = Math.max(0, Math.floor(opts.paragraphCount == null ? 1 : opts.paragraphCount));
    var sentencePerParagraph = Math.max(0, Math.floor(opts.sentencePerParagraph == null ? 3 : opts.sentencePerParagraph));
    var wordCount = Math.max(0, Math.floor(opts.wordCount == null ? 10 : opts.wordCount));
    var startWithLoremIpsum = opts.startWithLoremIpsum !== false;
    var asHTML = !!opts.asHTML;

    var paragraphs = [];
    for (var p = 0; p < paragraphCount; p++) {
      var sentences = [];
      for (var s = 0; s < sentencePerParagraph; s++) sentences.push(generateSentence(wordCount));
      paragraphs.push(sentences);
    }

    // 段落数为 0 时没有首句可替换，这里做了保护（原版会抛 TypeError）
    if (startWithLoremIpsum && paragraphs.length && paragraphs[0].length) {
      paragraphs[0][0] = FIRST_SENTENCE;
    }

    var texts = paragraphs.map(function (s) { return s.join(' '); });
    if (asHTML) return '<p>' + texts.join('</p>\n\n<p>') + '</p>';
    return texts.join('\n\n');
  }

  window.ItTools.register('lorem-ipsum-generator', function (root) {
    var paragraphs = 1;
    var sentences = [3, 8];
    var words = [8, 15];
    var startWithLoremIpsum = true;
    var asHTML = false;

    var output = D.h('textarea.layui-textarea', { rows: 8, readonly: true });

    function render() {
      output.value = generateLoremIpsum({
        paragraphCount: paragraphs,
        // 原版每次刷新都重新随机句数与词数，这里保持一致
        sentencePerParagraph: randomIntRange(sentences[0], sentences[1]),
        wordCount: randomIntRange(words[0], words[1]),
        startWithLoremIpsum: startWithLoremIpsum,
        asHTML: asHTML
      });
    }

    /** 段落数滑块 */
    var paragraphLabel = D.h('label.field-label', { text: t('paragraphs', 'Paragraphs ({n})').replace('{n}', 1) });
    var paragraphSlider = D.h('input.slider', { type: 'range', min: 1, max: 20, step: 1, value: 1 });
    paragraphSlider.addEventListener('input', function () {
      paragraphs = Number(paragraphSlider.value);
      paragraphLabel.textContent = t('paragraphs', 'Paragraphs ({n})').replace('{n}', paragraphs);
      render();
    });

    /** 「区间」用两个数字框表示 */
    function rangeField(labelText, bounds, min, max) {
      var lo = D.h('input.layui-input', { type: 'number', min: min, max: max, value: bounds[0] });
      var hi = D.h('input.layui-input', { type: 'number', min: min, max: max, value: bounds[1] });
      function read() {
        var a = Number(lo.value);
        var b = Number(hi.value);
        if (!isFinite(a)) a = min;
        if (!isFinite(b)) b = max;
        if (b < a) b = a;
        bounds[0] = a;
        bounds[1] = b;
        render();
      }
      lo.addEventListener('input', read);
      hi.addEventListener('input', read);
      // 原版这几个字段是 n-form-item + label-placement="left"、200px、右对齐
      return D.h('div.field-row', { style: { '--field-label-width': '200px' } },
        D.h('label.field-label', { text: labelText }),
        D.h('div.input-group', null,
          D.h('span.badge-note', { text: t('from', 'from') }), lo,
          D.h('span.badge-note', { text: t('to', 'to') }), hi
        )
      );
    }

    /**
     * 一个开关：getter 读当前值，setter 写回。
     *
     * 原版这里是 n-form-item（label-placement="left"、label-width="200"）
     * 加一个光秃秃的 n-switch —— 开关自己不带文字，文字是左边那列 200px 的标签，
     * 所以这里也是「标签在左 + 右侧一个裸开关」，不能再把文字塞进开关里。
     */
    function flag(getter, setter, labelText, id) {
      var box = D.h('input', { type: 'checkbox', id: id });
      box.checked = getter();
      box.addEventListener('change', function () {
        setter(box.checked);
        render();
      });
      return D.h('div.field-row', { style: { '--field-label-width': '200px' } },
        D.h('label.field-label', { for: id, text: labelText }),
        D.h('label.switch', null, box, D.h('span'))
      );
    }

    root.appendChild(D.h('div.card', null,
      // 原版这 5 个选项全是 n-form-item + label-placement="left"、label-width="200"，
      // 标签一律在左、200px 一列、右对齐 —— 滑块、两个区间、两个开关都一样。
      D.h('div.field-row', { style: { '--field-label-width': '200px' } },
        paragraphLabel,
        D.h('div', { style: { flex: '1 1 0', minWidth: '0' } }, paragraphSlider)),
      rangeField(t('sentences_per_paragraph', 'Sentences per paragraph'), sentences, 1, 50),
      rangeField(t('words_per_sentence', 'Words per sentence'), words, 1, 50),
      flag(function () { return startWithLoremIpsum; },
        function (v) { startWithLoremIpsum = v; }, t('start_with_lorem', 'Start with lorem ipsum'),
        'lorem-start-with-lorem'),
      flag(function () { return asHTML; },
        function (v) { asHTML = v; }, t('as_html', 'As HTML'),
        'lorem-as-html'),
      output,
      D.h('div.form-actions', null,
        U.copyButton(function () { return output.value; }),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('refresh', 'Refresh'), onclick: render
        })
      )
    ));

    render();
    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['lorem-ipsum-generator'] = {
    VOCABULARY: VOCABULARY,
    FIRST_SENTENCE: FIRST_SENTENCE,
    randomIntRange: randomIntRange,
    generateSentence: generateSentence,
    generateLoremIpsum: generateLoremIpsum,
    __cases: function (assert) {
      var words = new Set(VOCABULARY);
      /** 校验一句话：首字母大写、以句号结尾、每个词都在词库里 */
      function checkSentence(s, expectedWords) {
        var tokens = s.split(' ');
        assert.eq(tokens.length, expectedWords, '词数：' + s);
        assert(/^[A-Z]/.test(s), '首字母大写：' + s);
        assert(/\.$/.test(s), '以句号结尾：' + s);
        // 首词被大写过，比对词库时还原成小写
        tokens.forEach(function (token, i) {
          var word = token.replace(/\.$/, '').toLowerCase();
          assert(words.has(word), '词在词库里：' + word);
          if (i === tokens.length - 1) assert(/\.$/.test(token), '末词带句号：' + s);
        });
      }

      var text = generateLoremIpsum({
        paragraphCount: 3, sentencePerParagraph: 2, wordCount: 4, startWithLoremIpsum: false
      });
      var paragraphs = text.split('\n\n');
      assert.eq(paragraphs.length, 3, '3 段');
      paragraphs.forEach(function (p) {
        // 词库里没有句点，所以「每句一段」可以按句号切（切出来的片段前面会带空格）
        var sentences = (p.match(/[^.]+\./g) || []).map(function (s) { return s.trim(); });
        assert.eq(sentences.length, 2, '每段 2 句');
        sentences.forEach(function (s) { checkSentence(s, 4); });
      });

      // 以 lorem ipsum 开头
      assert(/^Lorem ipsum dolor sit amet, consectetur adipiscing elit\./.test(
        generateLoremIpsum({ paragraphCount: 1, sentencePerParagraph: 2, wordCount: 5, startWithLoremIpsum: true })
      ), '首句固定为 Lorem ipsum…');
      assert(!/^Lorem ipsum dolor sit amet/.test(
        generateLoremIpsum({ paragraphCount: 1, sentencePerParagraph: 1, wordCount: 5, startWithLoremIpsum: false })
      ), '关掉开关时首句是随机的，不会固定为 Lorem ipsum…');

      // HTML 输出
      var html = generateLoremIpsum({ paragraphCount: 2, sentencePerParagraph: 1, wordCount: 3, asHTML: true });
      assert(/^<p>[\s\S]*<\/p>$/.test(html), '被 <p> 包住');
      assert.eq((html.match(/<p>/g) || []).length, 2, '2 个 <p>');

      // 边界：0 段不应抛异常（原版在这里会 TypeError）
      assert.eq(generateLoremIpsum({ paragraphCount: 0, startWithLoremIpsum: true }), '', '0 段');
      assert.eq(generateLoremIpsum({ paragraphCount: 0, startWithLoremIpsum: true, asHTML: true }), '<p></p>', '0 段的 HTML');
      assert.eq(generateLoremIpsum({ paragraphCount: 1, sentencePerParagraph: 0, wordCount: 5, startWithLoremIpsum: false }), '', '0 句');
      assert.eq(generateLoremIpsum({ paragraphCount: 2, sentencePerParagraph: 0, startWithLoremIpsum: false }), '\n\n', '每段 0 句');

      // 区间随机是闭区间（原版取不到上界）
      assert.eq(randomIntRange(5, 5), 5, 'min == max');
      var seen = {};
      for (var i = 0; i < 400; i++) {
        var n = randomIntRange(1, 3);
        assert(n >= 1 && n <= 3, '落在闭区间内');
        seen[n] = true;
      }
      assert(seen[1] && seen[2] && seen[3], '三个端点都能取到（含上界 3）');

      // 每次生成都应不同
      var a = generateLoremIpsum({ paragraphCount: 1, sentencePerParagraph: 4, wordCount: 6, startWithLoremIpsum: false });
      var b = generateLoremIpsum({ paragraphCount: 1, sentencePerParagraph: 4, wordCount: 6, startWithLoremIpsum: false });
      assert(a !== b, '两次生成应不同');
    }
  };
})();