/* ==========================================================================
   Numeronym 生成器（numeronym-generator）

   把单词缩成 i18n / a11y / k8s 这种「首字母 + 中间字母数 + 尾字母」的形式。

   参考实现：src/tools/numeronym-generator/（it-tools, GPLv3）
   与原版的差别：
   1. 原版用 word.length 与 word.at(0) / word.at(-1)，都是 UTF-16 码元口径，
      emoji 等增补平面字符会被劈成两半（word.at(-1) 拿到的是半个代理对）。
      这里按码点统计与取首尾。
   2. 原版只处理单个单词，实际做 i18n 缩写时常常要一次处理一整句；
      这里补了 generateNumeronyms()，逐词缩写并原样保留词间的空白与标点
      （原版的主函数 generateNumeronym 行为不变）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('numeronym-generator');

  /**
   * 单词 → numeronym。3 个字符及以内原样返回。
   * 例：internationalization → i18n，accessibility → a11y。
   * @param {string} word
   */
  function generateNumeronym(word) {
    var chars = Array.from(String(word == null ? '' : word));
    if (chars.length <= 3) return chars.join('');
    return chars[0] + (chars.length - 2) + chars[chars.length - 1];
  }

  /** 一个「词」：字母开头，后面可以跟字母数字（utf8、k8s 也算一个词）。纯数字不算。 */
  var WORD_RE = /[A-Za-z][A-Za-z0-9]*/g;

  /**
   * 一段文本 → 逐词 numeronym。词与词之间的空白、标点原样保留，只有词本身被缩写。
   * @param {string} text
   */
  function generateNumeronyms(text) {
    return String(text == null ? '' : text).replace(WORD_RE, function (word) {
      return generateNumeronym(word);
    });
  }

  /** 一段文本里的 word 数，界面上做提示。 */
  function wordCount(text) {
    var trimmed = String(text == null ? '' : text).trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  window.ItTools.register('numeronym-generator', function (root) {
    // 原版的输入框没有标签（c-input-text 的 label 是空的），只有 placeholder，
    // 而且是 size="large"（40px 高）。这里照做：标签留着反而跟原版不一样。
    var input = D.h('input.layui-input', {
      type: 'text',
      style: { height: '40px' },
      placeholder: t('input_ph', 'Enter a word, e.g. \'internationalization\'')
    });
    input.value = 'internationalization';

    // 结果是 input-copyable：只读框 + 浮在框里右端的复制图标
    var output = D.h('input.layui-input', {
      type: 'text',
      readonly: true,
      style: { height: '40px', fontSize: '18px', letterSpacing: '1px' },
      placeholder: t('output_ph', 'Your numeronym will be here, e.g. \'i18n\'')
    });
    var badge = D.h('span.badge-note');

    function render() {
      var text = input.value;
      output.value = generateNumeronyms(text);
      var count = wordCount(text);
      if (!count) {
        badge.textContent = t('hint_empty', 'Type or paste something above');
      } else if (count === 1) {
        badge.textContent = t('word_count_one', '{n} word').replace('{n}', count);
      } else {
        badge.textContent = t('word_count_other', '{n} words').replace('{n}', count);
      }
    }

    input.addEventListener('input', render);

    // 原版这一页没有卡片：输入框、向下箭头、结果框竖排居中（flex-col items-center gap-4）。
    root.appendChild(D.h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' } },
      D.h('div', { style: { width: '100%' } }, input),
      D.icon('arrow-down', 30),
      D.h('div.input-copyable', { style: { width: '100%' } },
        output,
        U.copyButton(function () { return output.value; })
      ),
      D.h('p.field-hint', { style: { textAlign: 'center', margin: '0' } },
        badge,
        ' ',
        t('input_hint', 'You can paste a whole sentence at once; each word is abbreviated on its own.')
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.output-label', { text: t('examples', 'Examples') }),
      D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_word', 'Word') }),
          D.h('th', { text: t('numeronym', 'Numeronym') })
        )),
        D.h('tbody', null, [
          ['internationalization', 'i18n'],
          ['localization', 'l10n'],
          ['accessibility', 'a11y'],
          ['Kubernetes', 'K8s'],
          ['abbreviation', 'a12n'],
          ['abc', 'abc'],
          ['internationalization and localization', 'i18n and l10n']
        ].map(function (pair) {
          return D.h('tr', null, D.h('td', { text: pair[0] }), D.h('td.val', { text: pair[1] }));
        }))
      ),
      D.h('p.field-hint', { text: t('hint_short_words', 'Words of 3 characters or fewer are left as they are.') })
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['numeronym-generator'] = {
    generateNumeronym: generateNumeronym,
    generateNumeronyms: generateNumeronyms,
    wordCount: wordCount,
    __cases: function (assert) {
      // 与参考实现的 vitest / e2e 用例一致
      assert.eq(generateNumeronym('internationalization'), 'i18n', 'internationalization');
      assert.eq(generateNumeronym('accessibility'), 'a11y', 'accessibility');
      assert.eq(generateNumeronym('localization'), 'l10n', 'localization');
      assert.eq(generateNumeronym('abc'), 'abc', '3 个字符原样');
      assert.eq(generateNumeronym('internationalization').length, 4, '结果是 i18n 四个字符');

      assert.eq(generateNumeronym(''), '', '空串');
      assert.eq(generateNumeronym('a'), 'a', '1 个字符');
      assert.eq(generateNumeronym('ab'), 'ab', '2 个字符');
      assert.eq(generateNumeronym('abcd'), 'a2d', '4 个字符');
      assert.eq(generateNumeronym('Kubernetes'), 'K8s', '大小写原样保留');

      // 修掉的行为：按码点统计，emoji 不会被劈开
      assert.eq(generateNumeronym('a😀b'), 'a😀b', '3 个码元以内原样');
      assert.eq(generateNumeronym('a😀bc'), 'a2c', '码点计数：4 个码点（UTF-16 长度会是 5）');
      assert.eq(generateNumeronym('😀😀😀😀'), '😀2😀', '四个 emoji');

      // 整句
      assert.eq(generateNumeronyms('internationalization and localization'), 'i18n and l10n', '整句');
      assert.eq(generateNumeronyms('internationalization\nlocalization'), 'i18n\nl10n', '换行保留');
      assert.eq(generateNumeronyms('  abc  def  '), '  abc  def  ', '词间空白原样保留');
      assert.eq(generateNumeronyms('hello, world!'), 'h3o, w3d!', '标点后的词也缩写');
      assert.eq(generateNumeronyms('keep 2024 as is'), 'k2p 2024 as is', '纯数字不算词');
      assert.eq(generateNumeronyms('abc def'), 'abc def', '短词不缩写');
      assert.eq(generateNumeronyms(''), '', '空串');
      assert.eq(wordCount('one two three'), 3, '词数');
      assert.eq(wordCount('  '), 0, '空白没有词');
    }
  };
})();