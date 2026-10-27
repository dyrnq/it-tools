/* ==========================================================================
   文本对比（text-diff）

   左右两个文本框，逐行比出增删，结果按 hunk 渲染。

   参考实现：src/tools/text-diff/（it-tools, GPLv3）
   与原版的差别（这是本文件唯一的大改动）：
   原版整页就是一个 monaco 的 diff editor。monaco-editor 光打包体积就有 5MB，
   而这个站点的静态资源是不走构建、直接由 Rust 侧 embed 的，加它等于给每个
   访问者强加 5MB 下载。这里改成自实现的行级 diff（Hirschberg 线性空间 LCS
   分治，也就是 Myers 论文里 linear-space refinement 的等价落地），结果用
   站点已有的 .diff-line/.add/.del/.same 样式渲染。

   算法说明：
   · 编辑脚本最小的充要条件是「匹配行数 = LCS」。直接铺一张 N×M 的 DP 表当然
     最简单，但两份各 1 万行的文本就是 1 亿格，浏览器直接卡死。Hirschberg 的做法
     是把 a 一分为二，各用 O(M) 空间算出一条长度曲线，选出使
     左半 LCS + 右半 LCS 最大的切分点，再对左右两半递归 —— 全程只占 O(M) 空间，
     且切分点是按 LCS 最优性挑出来的，所以递归出来的脚本一定是最小的。
   · 进入递归前先把公共前后缀剥掉。真实场景里两份文本绝大多数行是相同的，
     剥完之后 DP 的规模往往从几十万格掉到几百格；这也顺带保证了「左半一定
     比原问题小」，递归必然收敛。
   · 中间段过大时退化成保底算法：仍然做公共前后缀剥离，中间整段按「全删 + 全增」
     处理。再慢下去浏览器会直接卡住页面，而用户粘两份毫不相干的巨型文件时，
     最优 diff 也没什么可读性可言。阈值见 DP_LIMIT —— 它是个**时间**预算而不是
     内存预算，按实测吞吐折算而来（所以慢机器上的实际等待会比这里写的久）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('text-diff');

  /**
   * 中间段 DP 格子数上限，超过就走保底算法。
   *
   * 这是按实测吞吐折算出来的**时间**预算，不是内存预算：
   * 机器上实测约 12.8M DP 格/秒（含 Hirschberg 各递归层），
   * 1500 万格 ≈ 1.2 秒。再往上就要卡住页面三秒了。
   *
   * 注意这个常数对机器很敏感：慢的手机可能只有这里的几分之一吞吐，
   * 同一个输入等待会更久。要改之前先在目标机器上重测。
   */
  var DP_LIMIT = 15000000;
  var DEFAULT_CONTEXT = 3;

  /* ---------- 文本切分与比较键 ---------- */

  /** 切行。末尾换行不额外造出一个空行（与大多数 diff 工具一致）。 */
  function splitLines(text) {
    if (text === null || text === undefined) return [];
    var s = String(text);
    if (s === '') return [];
    if (s.charAt(s.length - 1) === '\n') s = s.slice(0, -1);
    return s.split('\n').map(function (l) {
      return l.charAt(l.length - 1) === '\r' ? l.slice(0, -1) : l;   // 吃掉 CRLF 里的 CR
    });
  }

  /**
   * 一行参与比较时用的键。忽略空白 / 大小写 / 空行都作用在这一层，
   * 展示用的原文不受影响。
   * 注意 ignoreEmpty 的语义是「所有空白行彼此等价」，而不是把空行删掉 ——
   * 删掉会让行号对不上原文，渲染出来的定位也就没意义了。
   */
  function lineKey(line, opts) {
    opts = opts || {};
    var s = String(line);
    if (opts.ignoreEmpty && s.trim() === '') return '';
    if (opts.ignoreWhitespace) s = s.replace(/\s+/g, '');
    if (opts.ignoreCase) s = s.toLowerCase();
    return s;
  }

  /* ---------- 行级差分核心 ---------- */

  /**
   * 保底算法：剥掉公共前后缀，中间整段按「全删 + 全增」处理。
   * 结果一定合法（应用后能还原 b），只是不再是最小编辑脚本。
   */
  function coarseDiff(a, b, out) {
    var lo = 0;
    var hi = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) { out.push({ type: 'same', aNo: lo, bNo: lo }); lo++; }
    while (hi < a.length - lo && hi < b.length - lo &&
           a[a.length - 1 - hi] === b[b.length - 1 - hi]) hi++;
    var i;
    for (i = lo; i < a.length - hi; i++) out.push({ type: 'del', aNo: i, bNo: lo });
    for (i = lo; i < b.length - hi; i++) out.push({ type: 'add', aNo: a.length - hi, bNo: i });
    for (i = 0; i < hi; i++) out.push({ type: 'same', aNo: a.length - hi + i, bNo: b.length - hi + i });
  }

  /**
   * 一行 DP：res[t] = LCS(a[a0,a1), b[b0, b0+t))，t 取 0..M。
   * 只留一行（滚动数组），内存是 O(M) 而不是 O(N·M)。
   */
  function lcsRow(a, a0, a1, b, b0, b1) {
    var m = b1 - b0;
    var prev = new Int32Array(m + 1);
    var cur = new Int32Array(m + 1);
    var i, ti, ai, j, tmp, left;
    for (i = a0; i < a1; i++) {
      ai = a[i];
      left = 0;
      for (ti = 1, j = b0; ti <= m; ti++, j++) {
        if (ai === b[j]) left = prev[ti - 1] + 1;
        else left = prev[ti] > left ? prev[ti] : left;
        cur[ti] = left;
      }
      tmp = prev; prev = cur; cur = tmp;
    }
    return prev;
  }

  /**
   * 与 lcsRow 对称，a 从尾部往前扫、b 从头往后扫：
   * res[t] = LCS(a[a0,a1), b[b1-t, b1))。
   * 切分点两侧的 LCS 长度分别从这两条曲线读出来。
   * 注意这里的递推方向必须整体反过来：a 倒着扫时，配上的那个 b 元素在窗口里
   * 是最靠后的一个，续上的前缀得落在 b[j+1..b1) 里；沿用 lcsRow 的递推会把它
   * 和 b[j] 的顺序搞反，算出来的曲线偏大，切分点就会挑到不满足最优性的位置。
   */
  function lcsRowRight(a, a0, a1, b, b0, b1) {
    var m = b1 - b0;
    var prev = new Int32Array(m + 1);
    var cur = new Int32Array(m + 1);
    var i, ti, ai, j, tmp, right;
    for (i = a1 - 1; i >= a0; i--) {
      ai = a[i];
      right = 0;
      for (ti = 1, j = b1 - 1; ti <= m; ti++, j--) {
        if (ai === b[j]) right = prev[ti - 1] + 1;
        else right = prev[ti] > right ? prev[ti] : right;
        cur[ti] = right;
      }
      tmp = prev; prev = cur; cur = tmp;
    }
    return prev;
  }

  /**
   * Hirschberg 分治：求 a[a0,a1) 与 b[b0,b1) 的最小编辑脚本，追加到 out。
   * 递归深度是 log(N)，不会爆栈；每层只用 O(M) 的临时数组。
   */
  function lcsDiff(a, a0, a1, b, b0, b1, out) {
    var n = a1 - a0;
    var m = b1 - b0;
    var i, j, ti;

    if (n === 0) { for (j = b0; j < b1; j++) out.push({ type: 'add', aNo: a0, bNo: j }); return; }
    if (m === 0) { for (i = a0; i < a1; i++) out.push({ type: 'del', aNo: i, bNo: b0 }); return; }

    // 只剩一行：直接线性找第一个相等的位置，能配上就只删/增中间那段
    if (n === 1) {
      var hit = -1;
      for (j = b0; j < b1; j++) { if (a[a0] === b[j]) { hit = j; break; } }
      if (hit < 0) {
        out.push({ type: 'del', aNo: a0, bNo: b0 });
        for (j = b0; j < b1; j++) out.push({ type: 'add', aNo: a1, bNo: j });
        return;
      }
      for (j = b0; j < hit; j++) out.push({ type: 'add', aNo: a0, bNo: j });
      out.push({ type: 'same', aNo: a0, bNo: hit });
      for (j = hit + 1; j < b1; j++) out.push({ type: 'add', aNo: a1, bNo: j });
      return;
    }

    var mid = a0 + (n >> 1);
    var left = lcsRow(a, a0, mid, b, b0, b1);
    var right = lcsRowRight(a, mid, a1, b, b0, b1);
    // 切分点取「左半匹配数 + 右半匹配数」最大的那一列；并列时取靠前的一列，
    // 让相同行尽量落在靠前的位置，渲染出来的 diff 更接近直觉
    var best = -1;
    var split = b0;
    for (ti = 0; ti <= m; ti++) {
      var v = left[ti] + right[m - ti];
      if (v > best) { best = v; split = b0 + ti; }
    }

    lcsDiff(a, a0, mid, b, b0, split, out);
    lcsDiff(a, mid, a1, b, split, b1, out);
  }

  /**
   * 对两段已切好的行数组求编辑脚本。
   * 先剥公共前后缀（这一步让真实场景的 DP 规模小几个数量级），中间段再交给
   * 分治；中间段大到 DP 跑不动时退回保底算法。
   * @returns {{type:string,aNo:number,bNo:number}[]}
   */
  function diffScripts(a, b) {
    var out = [];
    var lo = 0;
    var hi = 0;
    var i;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) { out.push({ type: 'same', aNo: lo, bNo: lo }); lo++; }
    while (hi < a.length - lo && hi < b.length - lo &&
           a[a.length - 1 - hi] === b[b.length - 1 - hi]) hi++;

    var am = a.length - lo - hi;
    var bm = b.length - lo - hi;
    if (am > 0 && bm > 0 && am * bm > DP_LIMIT) {
      for (i = lo; i < a.length - hi; i++) out.push({ type: 'del', aNo: i, bNo: lo });
      for (i = lo; i < b.length - hi; i++) out.push({ type: 'add', aNo: a.length - hi, bNo: i });
    } else if (am > 0 || bm > 0) {
      lcsDiff(a, lo, a.length - hi, b, lo, b.length - hi, out);
    }
    for (i = 0; i < hi; i++) out.push({ type: 'same', aNo: a.length - hi + i, bNo: b.length - hi + i });
    return out;
  }

  /* ---------- 组装成可渲染的结果 ---------- */

  /**
   * 主函数：比对两段文本。
   * @param {string} originalText
   * @param {string} modifiedText
   * @param {{ignoreWhitespace?:boolean, ignoreCase?:boolean, ignoreEmpty?:boolean, context?:number}} [opts]
   * @returns {{ops:Array, hunks:Array, stats:Object, identical:boolean}}
   */
  function diffLines(originalText, modifiedText, opts) {
    opts = opts || {};
    var context = opts.context == null ? DEFAULT_CONTEXT : Math.max(0, Math.min(50, Math.floor(opts.context)));

    var a = splitLines(originalText);
    var b = splitLines(modifiedText);
    var ka = a.map(function (l) { return lineKey(l, opts); });
    var kb = b.map(function (l) { return lineKey(l, opts); });

    var ops = diffScripts(ka, kb).map(function (op) {
      return {
        type: op.type,
        aNo: op.type === 'add' ? null : op.aNo,
        bNo: op.type === 'del' ? null : op.bNo,
        text: op.type === 'add' ? b[op.bNo] : a[op.aNo]
      };
    });

    var stats = { added: 0, removed: 0, unchanged: 0 };
    ops.forEach(function (op) {
      if (op.type === 'add') stats.added++;
      else if (op.type === 'del') stats.removed++;
      else stats.unchanged++;
    });

    return {
      ops: ops,
      hunks: groupHunks(ops, context),
      stats: stats,
      identical: stats.added === 0 && stats.removed === 0
    };
  }

  /** 把编辑脚本按上下文行数切成 hunk。相邻 hunk 会合并。 */
  function groupHunks(ops, context) {
    var changed = [];
    var i;
    for (i = 0; i < ops.length; i++) if (ops[i].type !== 'same') changed.push(i);
    if (!changed.length) return [];

    var ranges = [];
    var start = Math.max(0, changed[0] - context);
    var end = Math.min(ops.length - 1, changed[0] + context);
    for (i = 1; i < changed.length; i++) {
      var from = Math.max(0, changed[i] - context);
      var to = Math.min(ops.length - 1, changed[i] + context);
      if (from <= end + 1) end = Math.max(end, to);
      else { ranges.push([start, end]); start = from; end = to; }
    }
    ranges.push([start, end]);

    return ranges.map(function (r) {
      var lines = ops.slice(r[0], r[1] + 1);
      return {
        header: hunkHeader(lines),
        lines: lines
      };
    });
  }

  /** 生成 unified diff 的 @@ 头。 */
  function hunkHeader(lines) {
    var aStart = null, bStart = null, aCount = 0, bCount = 0;
    lines.forEach(function (op) {
      if (op.type !== 'add') { if (aStart === null) aStart = op.aNo; aCount++; }
      if (op.type !== 'del') { if (bStart === null) bStart = op.bNo; bCount++; }
    });
    // 纯新增（aCount === 0）时起点按惯例写成新增处的前一行
    return '@@ -' + (aCount ? aStart + 1 : 0) + ',' + aCount +
           ' +' + (bCount ? bStart + 1 : 0) + ',' + bCount + ' @@';
  }

  /** 拼出标准 unified diff 文本，可直接粘进 git / patch。 */
  function toUnifiedDiff(originalText, modifiedText, opts) {
    var r = diffLines(originalText, modifiedText, opts);
    if (r.identical) return '';
    var lines = ['--- original', '+++ modified'];
    r.hunks.forEach(function (hunk) {
      lines.push(hunk.header);
      hunk.lines.forEach(function (op) {
        lines.push((op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ') + op.text);
      });
    });
    return lines.join('\n') + '\n';
  }

  /**
   * 校验用：把编辑脚本应用到 a 上，看能不能还原出 b。
   * 单测里用它兜住算法正确性 —— 脚本只要有一条不合法，这里就会炸。
   */
  function applyOps(ops) {
    return ops.filter(function (op) { return op.type !== 'del'; })
      .map(function (op) { return op.text; });
  }

  window.ItTools.register('text-diff', function (root) {
    var opts = { ignoreWhitespace: false, ignoreCase: false, ignoreEmpty: false, context: DEFAULT_CONTEXT };
    var timer = null;   // 输入去抖，destroy 里要清掉

    var original = D.h('textarea.layui-textarea', { rows: 10, placeholder: t('original_ph', 'Original text'), spellcheck: 'false' });
    var modified = D.h('textarea.layui-textarea', { rows: 10, placeholder: t('modified_ph', 'Modified text'), spellcheck: 'false' });
    var summary = D.h('span.badge-note', { text: t('no_difference', 'No difference') });
    var output = D.h('div');

    function render() {
      var r = diffLines(original.value, modified.value, opts);
      summary.textContent = r.identical
        ? t('no_difference', 'No difference')
        : t('stats_summary', '+{added} / -{removed} ({unchanged} unchanged)')
          .replace('{added}', String(r.stats.added))
          .replace('{removed}', String(r.stats.removed))
          .replace('{unchanged}', String(r.stats.unchanged));
      D.clear(output);
      if (!original.value && !modified.value) {
        output.appendChild(D.h('p.field-hint', { text: t('type_hint', 'Type or paste two texts to compare them.') }));
        return;
      }
      if (r.identical) {
        output.appendChild(D.h('p.field-hint', { text: t('identical', 'Both sides are identical ({n} lines).').replace('{n}', String(r.stats.unchanged)) }));
        return;
      }
      r.hunks.forEach(function (hunk) {
        var box = D.h('div', { style: { marginBottom: '14px' } });
        box.appendChild(D.h('div.diff-line.same', null,
          D.h('span.diff-no', { text: '⋯' }),
          D.h('span', { style: { color: 'var(--text-muted)' }, text: hunk.header })
        ));
        hunk.lines.forEach(function (op) {
          box.appendChild(D.h('div.diff-line.' + op.type, null,
            D.h('span.diff-no', { text: op.aNo === null ? '' : String(op.aNo + 1) }),
            D.h('span.diff-no', { text: op.bNo === null ? '' : String(op.bNo + 1) }),
            D.h('span', { text: (op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ') + op.text })
          ));
        });
        output.appendChild(box);
      });
    }

    function scheduleRender() {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () { timer = null; render(); }, 150);
    }

    [original, modified].forEach(function (el) { el.addEventListener('input', scheduleRender); });

    var toggles = [
      { key: 'ignoreWhitespace', label: t('ignore_whitespace', 'Ignore whitespace') },
      { key: 'ignoreCase', label: t('ignore_case', 'Ignore case') },
      { key: 'ignoreEmpty', label: t('ignore_empty', 'Ignore empty line changes') }
    ].map(function (tg) {
      var input = D.h('input', { type: 'checkbox' });
      input.addEventListener('change', function () {
        opts[tg.key] = input.checked;
        render();
      });
      return D.h('label.switch', null, input, D.h('span', { text: tg.label }));
    });

    var contextLabel = D.h('span', { text: t('context_lines', 'Context lines ({n})').replace('{n}', String(opts.context)) });
    var contextSlider = D.h('input.slider', {
      type: 'range', min: 0, max: 10, step: 1, value: opts.context
    });
    contextSlider.addEventListener('input', function () {
      opts.context = Number(contextSlider.value);
      contextLabel.textContent = t('context_lines', 'Context lines ({n})').replace('{n}', String(opts.context));
      render();
    });

    function swap() {
      var a = original.value;
      original.value = modified.value;
      modified.value = a;
      render();
    }

    // 原版这一页是**一张**卡（c-diff-editor 在里面）。
    // 我们没引 monaco，用的是「两个输入框 + 选项 + 结果」这套，
    // 但卡片数得对上 —— 拆成两张就凭空多出一圈边框。
    root.appendChild(D.h('div.card', null,
      D.h('div.switch-grid', null, toggles),
      D.h('div.field', null, contextLabel, contextSlider),
      D.h('div', { style: { display: 'flex', gap: '12px', alignItems: 'stretch' } },
        D.h('div', { style: { flex: '1 1 0', minWidth: '0' } }, U.field(t('original', 'Original:'), original, { wide: true })),
        D.h('div', { style: { flex: '1 1 0', minWidth: '0' } }, U.field(t('modified', 'Modified:'), modified, { wide: true }))
      ),
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('swap_sides', 'Swap sides'), onclick: swap }),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('clear', 'Clear'), onclick: function () {
            original.value = '';
            modified.value = '';
            render();
          }
        }),
        U.copyButton(function () { return toUnifiedDiff(original.value, modified.value, opts); }, t('copy_diff', 'Copy as unified diff')),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download_patch', 'Download patch'), onclick: function () {
            var patch = toUnifiedDiff(original.value, modified.value, opts);
            if (!patch) return;
            window.ItTools.download('diff.patch', patch, 'text/x-patch;charset=utf-8');
          }
        })
      ),
      D.h('div.field-row', null, D.h('label.field-label', { text: t('result', 'Result') }), summary),
      output
    ));

    render();

    return {
      destroy: function () {
        if (timer) { window.clearTimeout(timer); timer = null; }
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['text-diff'] = {
    diffLines: diffLines,
    diffScripts: diffScripts,
    lcsDiff: lcsDiff,
    lcsRow: lcsRow,
    lcsRowRight: lcsRowRight,
    coarseDiff: coarseDiff,
    splitLines: splitLines,
    lineKey: lineKey,
    groupHunks: groupHunks,
    toUnifiedDiff: toUnifiedDiff,
    applyOps: applyOps,
    __cases: function (assert) {
      /* ---- 切行 ---- */
      assert.eq(splitLines('a\nb\nc'), ['a', 'b', 'c'], '按换行切分');
      assert.eq(splitLines('a\nb\n'), ['a', 'b'], '末尾换行不造出空行');
      assert.eq(splitLines('a\r\nb\r\n'), ['a', 'b'], '吃掉 CRLF 里的 CR');
      assert.eq(splitLines(''), [], '空串没有行');
      assert.eq(splitLines('a\n\nb'), ['a', '', 'b'], '中间空行要保留');

      /* ---- 比较键 ---- */
      assert.eq(lineKey('  Foo  ', {}), '  Foo  ', '默认原样比较');
      assert.eq(lineKey('  Foo  ', { ignoreWhitespace: true }), 'Foo', '忽略所有空白');
      assert.eq(lineKey('Foo', { ignoreCase: true }), 'foo', '忽略大小写');
      assert.eq(lineKey('   ', { ignoreEmpty: true }), '', '纯空白行按空行处理');
      assert.eq(lineKey('   ', { ignoreWhitespace: true }), '', '纯空白行去掉空白后为空');

      /* ---- 编辑脚本 ---- */
      var r = diffLines('a\nb\nc', 'a\nx\nc');
      assert.eq(r.ops.map(function (o) { return o.type + ':' + o.text; }),
        ['same:a', 'del:b', 'add:x', 'same:c'], '改掉一行：删一行加一行');
      assert.eq(r.stats, { added: 1, removed: 1, unchanged: 2 }, '增删统计');
      assert(r.identical === false, '不相同');

      r = diffLines('a\nb', 'a\nb');
      assert.eq(r.ops.map(function (o) { return o.type; }), ['same', 'same'], '完全相同全是 same');
      assert(r.identical === true, '相同标记');
      assert.eq(r.hunks, [], '没有变化就没有 hunk');

      r = diffLines('', 'a\nb');
      assert.eq(r.ops.map(function (o) { return o.type; }), ['add', 'add'], '空 → 两行');
      assert.eq(r.ops[0].aNo, null, '新增行没有旧行号');
      r = diffLines('a\nb', '');
      assert.eq(r.ops.map(function (o) { return o.type; }), ['del', 'del'], '两行 → 空');
      assert.eq(r.ops[0].bNo, null, '删除行没有新行号');

      // 长公共前后缀只被剥一次，中间整体替换
      r = diffLines('1\n2\n3\nX\n9', '1\n2\n3\nY\n9');
      assert.eq(r.ops.map(function (o) { return o.type + ':' + o.text; }),
        ['same:1', 'same:2', 'same:3', 'del:X', 'add:Y', 'same:9'], '剥掉公共前后缀');

      // 忽略空白 / 大小写
      assert(diffLines('a  b', 'a b', { ignoreWhitespace: true }).identical === true, '忽略空白后相同');
      assert(diffLines('a  b', 'a b').identical === false, '不开忽略空白时这两行仍算不同');
      assert(diffLines('Hello', 'hello').identical === false, '不忽略大小写时不同');
      assert(diffLines('Hello', 'hello', { ignoreCase: true }).identical === true, '忽略大小写后相同');
      assert(diffLines('a\n\nb', 'a\n \nb', { ignoreEmpty: true }).identical === true, '空行与纯空白行按同一类看待');
      // 语义是「空行之间彼此等价」，不是「把空行删掉」：多出来的一行空行仍然算新增
      assert(diffLines('a\n\nb', 'a\nb', { ignoreEmpty: true }).identical === false, '多出的空行仍算新增');

      /* ---- hunk ---- */
      // 10 行里只改第 1 行和第 10 行，上下文 1 行 → 两个 hunk
      var big = [];
      for (var i = 1; i <= 10; i++) big.push('line ' + i);
      var big2 = big.slice();
      big2[0] = 'LINE 1';
      big2[9] = 'LINE 10';
      r = diffLines(big.join('\n'), big2.join('\n'), { context: 1 });
      assert.eq(r.hunks.length, 2, '相距较远的两处改动分成两个 hunk');
      assert.eq(r.hunks[0].lines.map(function (o) { return o.type + ':' + o.text; }),
        ['del:line 1', 'add:LINE 1', 'same:line 2'], '首个 hunk 含 1 行上下文');
      assert(r.hunks[0].header.indexOf('@@ -1,2 +1,2 @@') === 0, 'hunk 头带行列区间：' + r.hunks[0].header);

      // 相邻改动应合并成一个 hunk
      var big3 = big.slice();
      big3[2] = 'THREE';
      big3[3] = 'FOUR';
      r = diffLines(big.join('\n'), big3.join('\n'), { context: 3 });
      assert.eq(r.hunks.length, 1, '相邻改动合并成一个 hunk');
      r = diffLines('a\nb\nc', 'x\ny', { context: 1 });
      assert.eq(r.hunks.length, 1, '整段替换只有一个 hunk');

      /* ---- unified diff ---- */
      var patch = toUnifiedDiff('a\nb\nc', 'a\nx\nc');
      assert.eq(patch,
        '--- original\n+++ modified\n@@ -1,3 +1,3 @@\n a\n-b\n+x\n c\n', 'unified diff 文本');
      assert.eq(toUnifiedDiff('a', 'a'), '', '相同就没有 patch');

      /* ---- 正确性自检：脚本能还原出 b ---- */
      var samples = [
        ['', ''], ['', 'x'], ['x', ''], ['a', 'a'], ['a', 'b'],
        ['a\nb\nc', 'c\nb\na'], ['1\n2\n3\n4\n5', '1\n3\n5'],
        ['a\nb\nc\nd', 'b\nd\na\nc'], ['x\n'.repeat(50), 'x\n'.repeat(30) + 'y\n'],
        ['the quick brown fox', 'the slow brown cat']
      ];
      samples.forEach(function (pair, idx) {
        var d = diffLines(pair[0], pair[1]);
        assert.eq(applyOps(d.ops), splitLines(pair[1]), '样本 ' + idx + ' 的脚本能还原出修改侧');
      });

      /* ---- 最优性：编辑脚本长度必须等于 n + m - 2·LCS ----
         这是 Hirschberg 分治存在的全部理由。短小但字母表极小的样本最容易暴露
         切分点选错的问题，所以这里特意用了这种形状。 */
      var lcsLen = function (a, b) {          // O(n·m) 的朴素 LCS，仅供对答案
        var prev = new Array(b.length + 1).fill(0);
        var cur = new Array(b.length + 1).fill(0);
        for (var x = 0; x < a.length; x++) {
          for (var y = 1; y <= b.length; y++) {
            cur[y] = a[x] === b[y - 1]
              ? prev[y - 1] + 1
              : Math.max(prev[y], cur[y - 1]);
          }
          var tmp = prev; prev = cur; cur = tmp;
        }
        return prev[b.length];
      };
      var tricky = [
        [['v0', 'v3', 'v2', 'v1', 'v2', 'v4', 'v3', 'v0', 'v2', 'v1',
          'v4', 'v3', 'v1', 'v2', 'v4', 'v4', 'v3', 'v2', 'v0', 'v4'],
         ['v4', 'v2', 'v1', 'v4']],           // 尾部相同、中段乱序：只贪心地匹配前缀会漏
        [['v2', 'v3'],
         ['v0', 'v0', 'v1', 'v1', 'v2', 'v1', 'v2', 'v4', 'v2', 'v0', 'v0', 'v4', 'v3', 'v4', 'v4', 'v1']],
        [['a', 'b'], ['b', 'a']],
        [['a', 'b', 'c'], ['c', 'b', 'a']],
        [Array(7).fill('q'), Array(7).fill('q').concat(['z'])]
      ];
      tricky.forEach(function (pair, idx) {
        var ops = diffScripts(pair[0], pair[1]);
        var edits = ops.filter(function (op) { return op.type !== 'same'; }).length;
        var best = pair[0].length + pair[1].length - 2 * lcsLen(pair[0], pair[1]);
        assert.eq(edits, best, '样本 ' + idx + ' 的编辑脚本是最小的');
      });

      /* ---- 曲线方向对称：左右两条 LCS 曲线在单行 a 上必须给出同一个答案 ---- */
      var one = ['p', 'q', 'r', 'p', 'q'];
      assert.eq(lcsRow(one, 0, 1, one, 0, 5)[5], 1, '左曲线：单行 a 最多匹配 1');
      assert.eq(lcsRowRight(one, 0, 1, one, 0, 5)[5], 1, '右曲线：单行 a 最多匹配 1');

      // 保底分支：中间段超过 DP_LIMIT 时整体替换，结果仍然必须能还原出 b
      var coarseOps = function (a, b) {
        var out = [];
        coarseDiff(a, b, out);
        return out.map(function (op) {
          return {
            type: op.type,
            text: op.type === 'add' ? b[op.bNo] : a[op.aNo]
          };
        });
      };
      var A = ['p', 'q', '1', '2'], B = ['p', 'q', '9', '8', '7'];
      assert.eq(coarseOps(A, B).map(function (o) { return o.type + ':' + o.text; }),
        ['same:p', 'same:q', 'del:1', 'del:2', 'add:9', 'add:8', 'add:7'], '保底算法剥前后缀后整段替换');
      assert.eq(applyOps(coarseOps(A, B)), B, '保底算法也能还原出修改侧');
      assert.eq(applyOps(coarseOps(['a'], ['b'])), ['b'], '保底算法处理单行');
      assert.eq(coarseOps(['a'], ['a']), [{ type: 'same', text: 'a' }], '保底算法处理完全相同');
    }
  };
})();