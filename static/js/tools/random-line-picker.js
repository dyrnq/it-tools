/* ==========================================================================
   随机抽行（random-line-picker）

   从一段文本里随机抽出若干行，抽出的行互不重复。

   参考实现：src/tools/random-line-picker/（it-tools2 的 fork，Vue 写的）
   与上游的差别：
   1. 上游的随机数是 Math.random() —— 不是密码学安全的随机源。本仓库有
      一条硬规矩：随机数一律走 U.randomInt（crypto.getRandomValues）。
      这里默认就用它，并且把随机源做成了**可注入**的参数：用例里传一个
      定好的随机源，结果就完全可复现。
   2. 上游是「重复抽样」：不勾「允许重复」时靠 lines.splice 把抽中的行从
      数组里摘掉。它能保证不重复，但抽第 k 行时是在**剩下的**行里挑的，
      分布不是均匀的。这里改成「先 Fisher-Yates 洗牌，再取前 n 个」——
      洗牌是均匀的，前 n 个同样均匀，而且实现上更简单。
   3. 上游的 pickLines 在 repeat 为真时用 splice 的同一个分支去「删」数组
      元素却又不删（config.repeat ? lines[index] : lines.splice(...)），
      抽到空行时 prefix 也加不上（line && config.prefix 里空串是 falsy）。
      这里不搞「允许重复」这一档：抽出来的行一定互不相同。
   4. 上游在输入为空时把 maxCount 设成 0，而 n-input-number 的 min 是 1、
      max 是 0 —— 输入框会进入一个既不合法又进不去的状态。这里空输入只给
      一行提示，不改输入框的值。
   5. 上游把 count 静默截断到总行数（用户填 10 行、只有 3 行时看不出少了）。
      这里多抽时给一行提示说明「只有 N 行，全抽走了」。

   不依赖任何第三方库。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('random-line-picker');

  /**
   * 切行：CRLF / CR / LF 都算换行；末尾那个换行不额外造出一行。
   * 空文本没有行。中间的空行照样算一行（它就是文本里的一行）。
   */
  function splitLines(text) {
    var s = text == null ? '' : String(text);
    if (!s) return [];
    s = s.replace(/\r\n$|\r$|\n$/, '');
    if (!s) return [];
    return s.split(/\r\n|\r|\n/);
  }

  /**
   * Fisher-Yates 洗牌（返回副本，不动原数组）。
   *
   * @param {Array} items
   * @param {(max:number)=>number} rng 返回 [0, max) 的整数
   * @returns {Array}
   */
  function shuffle(items, rng) {
    var a = items.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = rng(i + 1);
      // 兜底：注入的随机源不守规矩时也不越界（自己写用例容易漏掉边界）
      if (!(j >= 0 && j <= i)) j = i;
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  /**
   * 抽 n 行（互不重复）。
   *
   * @param {string} text
   * @param {number} count 要抽几行
   * @param {(max:number)=>number} [rng] 随机源，默认 U.randomInt（crypto）
   * @returns {string[]}
   */
  function pickLines(text, count, rng) {
    var lines = splitLines(text);
    var n = Number(count);
    if (!isFinite(n)) n = 0;
    n = Math.floor(n);
    if (!lines.length || n <= 0) return [];
    var r = typeof rng === 'function' ? rng : U.randomInt;
    return shuffle(lines, r).slice(0, Math.min(n, lines.length));
  }

  window.ItTools.register('random-line-picker', function (root) {
    var textarea = D.h('textarea.layui-textarea', {
      rows: 10,
      placeholder: t('input_ph', 'Paste the lines you want to pick from.'),
      spellcheck: 'false'
    });

    var countInput = D.h('input.layui-input', {
      type: 'number',
      min: 1,
      step: 1,
      value: 1,
      style: { flex: '0 0 140px', width: '140px' }
    });

    var status = D.h('p.field-hint');
    var resultBox = D.h('div.output-body');

    /** 读输入框里的条数。空 / 不是数字 → NaN（界面上给提示，不抛异常）。 */
    function readCount() {
      var raw = String(countInput.value == null ? '' : countInput.value).trim();
      if (!raw) return NaN;
      var n = Number(raw);
      return isFinite(n) ? Math.floor(n) : NaN;
    }

    function render() {
      var text = textarea.value;
      var total = splitLines(text).length;
      var count = readCount();
      var picked = [];

      if (total && isFinite(count) && count > 0) {
        picked = pickLines(text, count, U.randomInt);
      }
      resultBox.textContent = picked.join('\n');

      if (!total) {
        status.textContent = t('status_empty', 'Type or paste some text to pick lines from.');
      } else if (!isFinite(count)) {
        status.textContent = t('status_bad_count', 'Enter how many lines to pick (at least 1).');
      } else if (count < 1) {
        status.textContent = t('status_bad_count', 'Enter how many lines to pick (at least 1).');
      } else if (count > total) {
        status.textContent = t('status_too_many', 'The text only has {total} line(s), so all of them were picked.')
          .replace('{total}', String(total));
      } else {
        status.textContent = t('status_picked', 'Picked {count} of {total} line(s).')
          .replace('{count}', String(picked.length))
          .replace('{total}', String(total));
      }
    }

    textarea.addEventListener('input', render);
    countInput.addEventListener('input', render);
    countInput.addEventListener('change', render);

    var copyBtn = U.copyButton(function () {
      return resultBox.textContent;
    }, t('copy', 'Copy'));

    var pickAgain = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button',
      text: t('pick_again', 'Pick again'),
      onclick: render
    });

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your text:'), textarea, { wide: true }),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('count', 'Number of lines to pick:') }),
        countInput
      ),
      D.h('p.field-hint', { text: t('note_count', 'Picked lines never repeat.') })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.code-label', { style: { marginBottom: '8px' }, text: t('result', 'Picked lines') }),
      status,
      resultBox,
      D.h('div.form-actions', null, copyBtn, pickAgain)
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['random-line-picker'] = {
    splitLines: splitLines,
    shuffle: shuffle,
    pickLines: pickLines,
    __cases: function (assert) {
      /* ---- 切行 ---- */
      assert.eq(splitLines(''), [], '空文本没有行');
      assert.eq(splitLines('a'), ['a'], '单行');
      assert.eq(splitLines('a\nb'), ['a', 'b'], '按换行切');
      assert.eq(splitLines('a\n'), ['a'], '末尾换行不造出空行（上游会多出一个空行）');
      assert.eq(splitLines('a\r\nb'), ['a', 'b'], 'CRLF 算一个换行');

      /* ---- 洗牌 ---- */
      var fixed = function () { return 0; };
      assert.eq(shuffle(['a', 'b', 'c'], fixed), ['b', 'c', 'a'], '固定随机源下洗牌结果固定');
      assert.eq(shuffle([], fixed), [], '空数组');
      assert.eq(shuffle(['a'], fixed), ['a'], '只有一个元素时不动');
      assert.eq(shuffle(['a', 'b', 'c', 'd'], function (max) { return max - 1; }),
        ['a', 'b', 'c', 'd'], '随机源总是给最大值时顺序不变');

      /* ---- 抽行（固定随机源，结果可复现） ---- */
      assert.eq(pickLines('a\nb\nc\nd\ne', 2, fixed), ['b', 'c'], '抽到的行固定');
      assert.eq(pickLines('a\nb\nc', 3, fixed), ['b', 'c', 'a'], '全抽走时顺序也是固定的');
      assert.eq(pickLines('a\nb\nc', 10, fixed), ['b', 'c', 'a'], '要抽的比总行数多时全抽走');
      assert.eq(pickLines('', 3, fixed), [], '空文本抽不到行');
      assert.eq(pickLines('only', 1, fixed), ['only'], '单行文本');
      assert.eq(pickLines('a\nb', 0, fixed), [], '抽 0 行');
      assert.eq(pickLines('a\nb', -1, fixed), [], '抽负数行');
      assert.eq(pickLines('a\nb', NaN, fixed), [], '条数不是数字时抽不到行');

      /* ---- 抽出来的行互不重复，且都来自输入 ---- */
      var many = pickLines('a\nb\nc\nd', 4, function (max) { return max - 1; });
      assert.eq(many.length, 4, '抽了 4 行');
      assert.eq(many.filter(function (x, i) { return many.indexOf(x) !== i; }), [], '没有重复的行');
      var fromInput = pickLines('x\ny\nz', 2, fixed);
      assert(fromInput.every(function (line) { return ['x', 'y', 'z'].indexOf(line) >= 0; }), '抽出的行都来自输入');

      /* ---- 默认随机源（crypto）也只断言性质，不断言具体值 ---- */
      var real = pickLines('a\nb\nc\nd\ne', 3);
      assert.eq(real.length, 3, '默认随机源抽 3 行');
      assert.eq(real.filter(function (x, i) { return real.indexOf(x) !== i; }), [], '默认随机源抽出的行也不重复');
      assert(real.every(function (line) { return 'abcde'.indexOf(line) >= 0; }), '默认随机源抽出的行都来自输入');
    }
  };
})();
