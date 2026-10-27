/* ==========================================================================
   基准对比计算器（benchmark-builder）

   名字叫 benchmark builder，但它**不是计时器**：不读 performance.now()，
   也不跑任何测量循环。参考实现从头到尾没有任何计时 API，用户要自己把测好的
   数字粘进来。它做的事是纯算术：

     · 每个 suite 一组样本值 → 平均值 / 方差
     · 按平均值升序排序，最快（最小）的排第一
     · 其余每行标注相对最优 suite 的差值与倍率 (+Δ ; xRatio)
     · 结果能复制成 Markdown 表格或 bullet list（贴进 PR / issue 用）

   状态只落在 localStorage 里，纯前端算完，所以放 JS 档而不是走服务端表单
   （为一次 sum/n 往返一趟服务端毫无意义）。

   参考实现：src/tools/benchmark-builder/（it-tools, GPLv3）
   与原版的差别都写在各自函数上方的注释里，主口径（总体方差、rounded 到
   3 位小数、`∞`、空 suite 记 0）一律照抄，不做「顺手修正」。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('benchmark-builder');

  /* useStorage('benchmark-builder:suites' | 'benchmark-builder:unit') 的两个键 */
  var SUITES_KEY = 'benchmark-builder:suites';
  var UNIT_KEY = 'benchmark-builder:unit';

  /* Markdown 表头映射。列的先后不由这里决定，而由结果对象的键序决定：
     {position, title, mean, variance, size} → Position / Suite / Mean / Variance / Samples。 */
  var HEADERS = {
    position: t('col_position', 'Position'),
    title: t('col_suite', 'Suite'),
    size: t('col_samples', 'Samples'),
    mean: t('col_mean', 'Mean'),
    variance: t('col_variance', 'Variance')
  };

  /* bullet list 里每行的字段顺序：参考实现用 {...rest} 把 title 摘掉后剩下的
     键序，这里写死，免得以后给结果对象加字段时漏改导出格式。 */
  var BULLET_FIELDS = ['position', 'mean', 'variance', 'size'];

  /* ---------- 纯函数 ---------- */

  /**
   * 数字判定，对应参考实现的 `data.filter(_.isNumber)`：空行（null）不参与统计，
   * 一行没填也不会把整个 suite 拖成 NaN。
   * 比 _.isNumber 多挡掉了 NaN / ±Infinity —— 一个 Infinity 就足以让 mean 变
   * Infinity、再让 0/0 出 NaN，而输入框（type=number）根本填不出这种值，
   * 只能来自 localStorage 里被手改过的 JSON。
   */
  function isNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** 输入框字符串 → number；空串 / 非法值 / 非有限值一律 null（等价于「这一行没填」）。 */
  function parseMeasure(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s.length) return null;
    var n = Number(s);
    return isNumber(n) ? n : null;
  }

  /** 平均值。空数组返回 0 而不是 NaN —— 空 suite 在表里是 0，不是报错。 */
  function computeAverage(data) {
    if (!data.length) return 0;
    var sum = 0;
    for (var i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length;
  }

  /**
   * 总体方差：离差平方的平均值，**除以 n**。
   * 参考实现刻意用 n 而不是样本方差的 n-1，这里照抄并保留区分：
   * [2,4,4,4,5,5,7,9] 的总体方差是教科书上的 4，样本方差则是 32/7 ≈ 4.571。
   * 「改对」的直觉在这里是错的，两套口径混用出来的对比表没有意义。
   */
  function computeVariance(data) {
    var mean = computeAverage(data);
    var squares = data.map(function (v) { return (v - mean) * (v - mean); });
    return computeAverage(squares);
  }

  /** 保留 3 位小数。注意 Math.round 是「四舍五入到 +∞」，
      所以 round(-1.2345) = -1.234（不是 -1.235）。 */
  function round(v) {
    return Math.round(v * 1000) / 1000;
  }

  /**
   * 把 suites 算成展示用的行。
   * 与参考实现逐步对应：先剔掉非数字 → 算 mean/size/variance → 按 mean 升序排 →
   * 再按排序后的名次标注相对最优 suite 的差距。标注有个容易漏的条件：
   * 只有 index !== 0 **且** 与最优 mean 不相等时才出现，所以并列最优的两行
   * 谁也不会被标成「相对自己」。
   * @param {Array<{title: string, data: Array}>} suites
   * @param {string} unit 单位，追加在 mean 后面，并给方差加 ²
   * @returns {Array<{position: number, title: string, mean: string, variance: string, size: number}>}
   */
  function computeResults(suites, unit) {
    var rows = (suites || []).map(function (suite) {
      var data = (suite && suite.data ? suite.data : []).filter(isNumber);
      return {
        title: suite && suite.title != null ? String(suite.title) : '',
        size: data.length,
        mean: computeAverage(data),
        variance: computeVariance(data)
      };
    });

    rows.sort(function (a, b) { return a.mean - b.mean; });

    var cleanUnit = String(unit == null ? '' : unit).trim();
    var bestMean = rows.length ? rows[0].mean : 0;

    return rows.map(function (row, index) {
      var ratio = bestMean === 0 ? '∞' : round(row.mean / bestMean);
      var comparison = (index !== 0 && bestMean !== row.mean)
        ? ' (+' + round(row.mean - bestMean) + cleanUnit + ' ; x' + ratio + ')'
        : '';
      return {
        position: index + 1,
        title: row.title,
        mean: String(round(row.mean)) + cleanUnit + comparison,
        variance: String(round(row.variance)) + cleanUnit + (cleanUnit ? '²' : ''),
        size: row.size
      };
    });
  }

  /**
   * 对象数组 → Markdown 表格。空数组 / 非数组返回 ''（参考实现原样）。
   * 表头优先用 headerMap 里的显示名，取不到就用键名本身。
   */
  function arrayToMarkdownTable(data, headerMap) {
    if (!Array.isArray(data) || data.length === 0) return '';
    headerMap = headerMap || {};
    var headers = Object.keys(data[0]);
    var headerRow = '| ' + headers.map(function (key) {
      return headerMap[key] != null ? headerMap[key] : key;
    }).join(' | ') + ' |';
    var separatorRow = '| ' + headers.map(function () { return '---'; }).join(' | ') + ' |';
    var bodyRows = data.map(function (obj) {
      return '| ' + Object.keys(obj).map(function (key) { return obj[key]; }).join(' | ') + ' |';
    }).join('\n');
    return headerRow + '\n' + separatorRow + '\n' + bodyRows;
  }

  /**
   * 对象数组 → bullet list。每个 suite 一条，子项缩进 4 个空格：
   *   ' - Suite 1'
   *   '    - Position: 1'
   *   '    - Mean: 7.5'
   */
  function toBulletList(rows) {
    return (rows || []).map(function (row) {
      var lines = [' - ' + row.title];
      BULLET_FIELDS.forEach(function (key) {
        var label = HEADERS[key] != null ? HEADERS[key] : key;
        lines.push('    - ' + label + ': ' + row[key]);
      });
      return lines.join('\n');
    }).join('\n');
  }

  /* ---------- localStorage ---------- */

  /** 首次打开时的样例数据（参考实现的 useStorage 默认值）。 */
  function defaultSuites() {
    return [{ title: 'Suite 1', data: [5, 10] }, { title: 'Suite 2', data: [8, 12] }];
  }

  /** 「Reset suites」复位到两个**空** suite —— 与首次打开的样例数据不同，照抄参考实现。 */
  function resetSuites() {
    return [{ title: 'Suite 1', data: [] }, { title: 'Suite 2', data: [] }];
  }

  /**
   * 校对存储里的 suites。localStorage 是用户可见可改的，旧版本、手改、写到一半
   * 的 JSON 都可能进来，所以只放行「数组 + 每一项是对象」这一个形状，其余一律退回
   * 默认值而不是崩在半路：
   *   · data 里只放行数字与 null（null = 一个还没填的空行，要留着，用户下次回来还能接着填；
   *     其它类型一律降级成 null，绝不把对象/字符串塞进 type=number 的输入框）
   *   · 非对象的项直接丢掉；全被丢掉、或存的是空数组 → 用默认值
   */
  function sanitizeSuites(raw) {
    if (!Array.isArray(raw)) return defaultSuites();
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var suite = raw[i];
      if (!suite || typeof suite !== 'object' || Array.isArray(suite)) continue;
      var data = Array.isArray(suite.data) ? suite.data : [];
      out.push({
        title: typeof suite.title === 'string' ? suite.title : '',
        data: data.map(function (v) { return isNumber(v) ? v : null; })
      });
    }
    return out.length ? out : defaultSuites();
  }

  /** 单位必须是字符串，否则退回空串。 */
  function sanitizeUnit(raw) {
    return typeof raw === 'string' ? raw : '';
  }

  function loadSuites() {
    try {
      var raw = localStorage.getItem(SUITES_KEY);
      return sanitizeSuites(raw ? JSON.parse(raw) : null);
    } catch (e) {
      // JSON.parse 失败、隐私模式下 localStorage 直接抛 —— 都退回默认
      return defaultSuites();
    }
  }

  function saveSuites(suites) {
    try { localStorage.setItem(SUITES_KEY, JSON.stringify(suites)); } catch (e) { /* 隐私模式 */ }
  }

  function loadUnit() {
    try {
      var raw = localStorage.getItem(UNIT_KEY);
      // 存的时候 JSON.stringify 过，读回来也得 JSON.parse，否则拿到的是带引号的 '"ms"'
      return sanitizeUnit(raw ? JSON.parse(raw) : null);
    } catch (e) { return ''; }
  }

  function saveUnit(unit) {
    try { localStorage.setItem(UNIT_KEY, JSON.stringify(unit)); } catch (e) { /* 隐私模式 */ }
  }

  /**
   * 新 suite 的名字取最小的未被占用的 "Suite N"。
   * 参考实现直接用 `Suite ${suites.length + 1}`，连续点两次「Add suite」会得到
   * 两个 "Suite 3"，后面导出对比表就分不清谁是谁了，所以这里去个重。
   */
  function nextSuiteTitle(suites) {
    var taken = {};
    suites.forEach(function (s) { taken[s.title] = true; });
    var n = 1;
    while (taken['Suite ' + n]) n++;
    return 'Suite ' + n;
  }

  /* ---------- 挂载 ---------- */

  window.ItTools.register('benchmark-builder', function (root) {
    var suites = loadSuites();
    var unit = loadUnit();

    var wrap = D.h('div', {
      style: {
        display: 'flex', flexWrap: 'nowrap', gap: '12px',
        overflowX: 'auto', paddingBottom: '8px'
      }
    });
    var tableBox = D.h('div');
    var unitInput = D.h('input.layui-input', {
      type: 'text', value: unit, placeholder: t('ph_unit', 'Unit (eg: ms)')
    });
    /** 与 suites 同下标：每张卡片的元素引用，重建时整体替换 */
    var cards = [];

    function render() {
      var rows = computeResults(suites, unit);
      D.clear(tableBox);
      var tbody = D.h('tbody');
      rows.forEach(function (row) {
        tbody.appendChild(D.h('tr', null,
          D.h('td', { text: String(row.position) }),
          D.h('td', { text: row.title }),
          D.h('td.val', { text: String(row.size) }),
          D.h('td.val', { text: row.mean }),
          D.h('td.val', { text: row.variance })
        ));
      });
      tableBox.appendChild(D.h('table.result-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: HEADERS.position }),
          D.h('th', { text: HEADERS.title }),
          D.h('th', { text: HEADERS.size }),
          D.h('th', { text: HEADERS.mean }),
          D.h('th', { text: HEADERS.variance })
        )),
        tbody
      ));
    }

    function persist() {
      saveSuites(suites);
      saveUnit(unit);
    }

    /** 重建第 i 个 suite 的样本行；加/删一行走这里（只在点击或回车时发生，不会打断打字）。 */
    function renderValues(i) {
      var card = cards[i];
      D.clear(card.valuesBox);
      card.valueInputs = [];
      suites[i].data.forEach(function (value, j) {
        var input = D.h('input.layui-input', {
          type: 'number', step: 'any',
          placeholder: t('ph_measure', 'Set your measure...'),
          value: value == null ? '' : String(value)
        });
        input.addEventListener('input', function () {
          suites[i].data[j] = parseMeasure(input.value);
          render();
          persist();
        });
        input.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          // 最后一格回车 = 加一行；否则跳到下一格
          if (j === suites[i].data.length - 1) { addValue(i); return; }
          if (card.valueInputs[j + 1]) card.valueInputs[j + 1].focus();
        });

        var del = D.h('button.icon-btn', {
          type: 'button', text: '×', title: t('delete_value', 'Delete this value'), 'aria-label': t('delete_value', 'Delete this value')
        });
        del.addEventListener('click', function () {
          suites[i].data.splice(j, 1);
          renderValues(i);
          render();
          persist();
        });

        card.valuesBox.appendChild(D.h('div.field-row', null, input, del));
        card.valueInputs.push(input);
      });

      var addBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button', text: t('add_measure', 'Add a measure')
      });
      addBtn.addEventListener('click', function () { addValue(i); });
      card.valuesBox.appendChild(addBtn);
    }

    /** 追加一个空样本行（值是 null，统计时会被滤掉），并把焦点移到新行。 */
    function addValue(i) {
      suites[i].data.push(null);
      renderValues(i);
      render();
      persist();
      var card = cards[i];
      var last = card.valueInputs[card.valueInputs.length - 1];
      if (last) last.focus();
    }

    /** 整体重建 suite 卡片（增删 suite、复位时用）。 */
    function renderSuites() {
      D.clear(wrap);
      cards = [];
      suites.forEach(function (suite, i) {
        var titleInput = D.h('input.layui-input', {
          type: 'text', value: suite.title, placeholder: t('ph_suite_name', 'Suite name...')
        });
        titleInput.addEventListener('input', function () {
          suites[i].title = titleInput.value;
          render();
          persist();
        });

        var card = { el: null, valuesBox: D.h('div'), valueInputs: [] };
        // 每张卡片都叫「Suite name」，所以 label 的 for 要各指各的输入框
        // （U.field 生成的 id 是按 label 文本算的，多张卡片会撞成同一个 id）
        titleInput.id = 'bb-suite-name-' + i;
        card.el = D.h('div', { style: { flex: '0 0 294px' } },
          D.h('div.card', null,
            // 原版这个字段是 c-input-text label-position="left"，
            // **没写 label-width**（=auto，标签按文字宽度）也没写 label-align（=left），
            // 所以标签在左、按文字宽、左对齐。
            D.h('div.field.field-left', { style: { '--field-label-width': 'auto', '--field-label-align': 'left' } },
              D.h('label.field-label', { for: titleInput.id, text: t('suite_name', 'Suite name') }),
              titleInput
            ),
            // 原版每张 suite 卡片里：名字 → 分隔线 → 数值
            U.divider(),
            // 「Suite values」是 n-form-item 的标签，naive-ui 的 n-form-item
            // 默认 label-placement="top" —— 标签**在输入框上面一行**，
            // 而且这一档是**左对齐**（text-align: start，实测量出来的）。
            // （左标签那档 n-form-item 反而是右对齐，两档不一样。）
            D.h('div.field', null,
              D.h('label.field-label', { text: t('suite_values', 'Suite values') }),
              card.valuesBox
            )
          )
        );

        var actions = D.h('div.form-actions', { style: { justifyContent: 'center' } });
        // 只剩一个 suite 时不给删 —— 删光了就没东西可比了
        if (suites.length > 1) {
          var delSuite = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
            type: 'button', text: t('delete_suite', 'Delete suite')
          });
          delSuite.addEventListener('click', function () {
            suites.splice(i, 1);
            renderSuites();
            render();
            persist();
          });
          actions.appendChild(delSuite);
        }
        var addSuite = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button', text: t('add_suite', 'Add suite')
        });
        addSuite.addEventListener('click', function () {
          suites.splice(i + 1, 0, { title: nextSuiteTitle(suites), data: [0] });
          renderSuites();
          render();
          persist();
        });
        actions.appendChild(addSuite);
        card.el.appendChild(actions);

        cards.push(card);
        wrap.appendChild(card.el);
        renderValues(i);
      });
    }

    unitInput.addEventListener('input', function () {
      unit = unitInput.value;
      render();
      saveUnit(unit);
    });

    var resetBtn = D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
      type: 'button', text: t('reset_suites', 'Reset suites')
    });
    resetBtn.addEventListener('click', function () {
      suites = resetSuites();
      renderSuites();
      render();
      persist();
    });

    root.appendChild(D.h('div.card', null,
      D.h('p.field-hint', { text: t('hint_intro', 'Paste the numbers you measured one by one, they are sorted by ascending average and the first one is the fastest. Empty rows are not counted.') }),
      wrap,
      // 按钮条待在自己那张卡里：直接挂到 root 上会被 flex 拆成独立面板
      D.h('div.form-actions', { style: { justifyContent: 'center' } },
        resetBtn
      ),
      // 原版这个字段是 label-position="left"（c-input-text 显式写的），
      // 同样没写 label-width（=auto）也没写 label-align（=left）。
      // 放在按钮条外面，别挤在按钮中间。
      U.field(t('unit', 'Unit'), unitInput, {
        left: true, labelWidth: 'auto', labelAlign: 'left',
        hint: t('unit_hint', 'Appended to every mean and variance, eg: ms')
      })
    ));
    root.appendChild(D.h('div.card', null,
      tableBox,
      D.h('div.form-actions', { style: { justifyContent: 'center' } },
        U.copyButton(function () { return arrayToMarkdownTable(computeResults(suites, unit), HEADERS); },
          t('copy_markdown_table', 'Copy as markdown table')),
        U.copyButton(function () { return toBulletList(computeResults(suites, unit)); },
          t('copy_bullet_list', 'Copy as bullet list'))
      )
    ));

    renderSuites();
    render();

    return { destroy: function () { D.clear(root); } };
  });

  /* ---------- 供 harness 调用的纯逻辑 ---------- */

  window.ItTools.logic['benchmark-builder'] = {
    isNumber: isNumber,
    parseMeasure: parseMeasure,
    computeAverage: computeAverage,
    computeVariance: computeVariance,
    round: round,
    computeResults: computeResults,
    arrayToMarkdownTable: arrayToMarkdownTable,
    toBulletList: toBulletList,
    defaultSuites: defaultSuites,
    resetSuites: resetSuites,
    sanitizeSuites: sanitizeSuites,
    sanitizeUnit: sanitizeUnit,
    nextSuiteTitle: nextSuiteTitle,
    SUITES_KEY: SUITES_KEY,
    UNIT_KEY: UNIT_KEY,
    HEADERS: HEADERS,
    __cases: function (assert) {
      /* ---- 平均值 ---- */
      assert.eq(computeAverage([]), 0, '空 suite 记 0，不是 NaN');
      assert.eq(computeAverage([5]), 5, '单个值');
      assert.eq(computeAverage([5, 10]), 7.5, '默认 Suite 1');
      assert.eq(computeAverage([8, 12]), 10, '默认 Suite 2');
      assert.eq(computeAverage([-4, 4]), 0, '正负相消');
      assert.eq(computeAverage([2, 4, 4, 4, 5, 5, 7, 9]), 5, '教科书样本的均值是 5');

      /* ---- 方差（总体方差，除以 n）---- */
      assert.eq(computeVariance([]), 0, '空 suite 方差 0');
      assert.eq(computeVariance([42]), 0, '单值方差恒为 0');
      assert.eq(computeVariance([2, 4, 4, 4, 5, 5, 7, 9]), 4, '教科书值：总体方差 4');
      // 这组数据相对均值 5 的离差平方和是 32：除以 n=8 得总体方差 4，
      // 除以 n-1=7 得样本方差 32/7 ≈ 4.571。这里锁死的是 n 那一套 ——
      // 哪天有人「顺手改成样本方差」，下面这条 ratio 与上面的 4 就会互相打架。
      var deviations = [2, 4, 4, 4, 5, 5, 7, 9].map(function (v) { return (v - 5) * (v - 5); });
      assert.eq(computeVariance([2, 4, 4, 4, 5, 5, 7, 9]), 32 / deviations.length,
        '总体方差 = 离差平方和 / n');
      assert.eq(round(32 / 7), 4.571, '样本方差（除以 n-1）会是 4.571，本工具不用它');
      assert.eq(computeVariance([5, 10]), 6.25, '离差 ±2.5 → 平方 6.25');
      assert.eq(computeVariance([8, 12]), 4, '离差 ±2 → 平方 4');

      /* ---- 四舍五入到 3 位小数 ---- */
      assert.eq(round(1.23456), 1.235, '多余的小数位被丢掉');
      assert.eq(round(1.2344), 1.234, '第三位以下直接截掉');
      assert.eq(round(10 / 3), 3.333, '1/3 循环小数');
      assert.eq(round(0.0005), 0.001, '0.5 进位到 1');
      // Math.round 是「向 +∞ 四舍五入」，负数 -1.2345 会进成 -1.234 而不是 -1.235
      assert.eq(round(-1.2345), -1.234, '负数：Math.round 向 +∞ 进位');
      assert.eq(round(-2.5004), -2.5, '负数：不触发进位时截到 3 位小数');
      assert.eq(round(0), 0, '0');

      /* ---- 非数字被滤掉 ---- */
      assert.eq(isNumber(1), true, '数字');
      assert.eq(isNumber(0), true, '0 是数字');
      assert.eq(isNumber(null), false, '空行不是数字');
      assert.eq(isNumber(''), false, '空串不是数字');
      assert.eq(isNumber('5'), false, '数字串也不是数字（存进来就该是 number）');
      assert.eq(isNumber(NaN), false, 'NaN 挡掉，否则整张表变 NaN');
      assert.eq(isNumber(Infinity), false, 'Infinity 挡掉');
      assert.eq(computeResults([{ title: 'S', data: [1, null, 3, '', null] }], '')[0].size, 2,
        '空行不计入样本数');

      /* ---- 输入解析 ---- */
      assert.eq(parseMeasure(''), null, '空串');
      assert.eq(parseMeasure('  '), null, '只有空白');
      assert.eq(parseMeasure(null), null, 'null');
      assert.eq(parseMeasure('abc'), null, '字母');
      assert.eq(parseMeasure('1e999'), null, '溢出成 Infinity 的写法按空处理');
      assert.eq(parseMeasure('12.5'), 12.5, '小数');
      assert.eq(parseMeasure('-3'), -3, '负数');

      /* ---- 排序 + 对比标注（默认数据，无单位）---- */
      var dflt = computeResults(defaultSuites(), '');
      assert.eq(dflt.map(function (r) { return r.title; }), ['Suite 1', 'Suite 2'],
        '按 mean 升序：7.5 在 10 前');
      assert.eq(dflt.map(function (r) { return r.position; }), [1, 2], '名次从 1 开始');
      assert.eq(dflt[0], { position: 1, title: 'Suite 1', mean: '7.5', variance: '6.25', size: 2 },
        '第一名不带任何对比标注');
      assert.eq(dflt[1], { position: 2, title: 'Suite 2', mean: '10 (+2.5 ; x1.333)', variance: '4', size: 2 },
        '第二名标注差值 2.5 与倍率 1.333（10/7.5）');

      /* ---- 排序：并列 ---- */
      var tied = computeResults([
        { title: 'B', data: [1, 3] },
        { title: 'C', data: [2, 2] },
        { title: 'A', data: [0, 4] }
      ], '');
      assert.eq(tied.map(function (r) { return r.title; }), ['B', 'C', 'A'],
        'mean 全相等时保持原顺序（排序稳定），并列最优谁也不标「相对最优」');
      assert.eq(tied.map(function (r) { return r.mean; }), ['2', '2', '2'],
        '并列最优时 mean 后面没有对比括号');

      /* ---- 单位 ---- */
      var withUnit = computeResults(defaultSuites(), 'ms');
      assert.eq(withUnit[0].mean, '7.5ms', '单位追加在 mean 后面');
      assert.eq(withUnit[0].variance, '6.25ms²', '方差也带单位并多一个 ²');
      assert.eq(withUnit[1].mean, '10ms (+2.5ms ; x1.333)',
        '单位紧跟在 mean 后面，括号里是差值 + 单位（原版就是这样，两处都带单位）');
      assert.eq(withUnit[1].variance, '4ms²', '第二个 suite 的方差');
      assert.eq(computeResults(defaultSuites(), '  ')[0].variance, '6.25',
        '单位只有空白时不追加 ²');
      assert.eq(computeResults(defaultSuites(), '')[0].variance, '6.25', '没有单位时不追加');

      /* ---- 最优值为 0：倍率显示 ∞ ---- */
      var zero = computeResults([
        { title: 'Zero', data: [0] },
        { title: 'Five', data: [5] }
      ], '');
      assert.eq(zero[0], { position: 1, title: 'Zero', mean: '0', variance: '0', size: 1 },
        '最优 mean 为 0 时第一名照常不带标注');
      assert.eq(zero[1].mean, '5 (+5 ; x∞)', '除以 0 的倍率显示 ∞ 而不是 Infinity');
      // 两个都是 0：bestMean === mean，走的是「不加标注」分支，不是 ∞ 分支
      assert.eq(computeResults([
        { title: 'A', data: [0, 0] },
        { title: 'B', data: [0] }
      ], '')[1].mean, '0', '同为 0 时不标对比');

      /* ---- 空输入 ---- */
      var empty = computeResults([{ title: 'Suite 1', data: [] }, { title: 'Suite 2', data: [] }], '');
      assert.eq(empty.map(function (r) { return [r.mean, r.variance, r.size]; }),
        [['0', '0', 0], ['0', '0', 0]], '两个空 suite：mean/variance 0，样本数 0');

      /* ---- Markdown 表格 ---- */
      assert.eq(arrayToMarkdownTable([], HEADERS), '', '空数组返回空串');
      assert.eq(arrayToMarkdownTable(null, HEADERS), '', '非数组也返回空串');
      assert.eq(arrayToMarkdownTable(dflt, HEADERS),
        '| Position | Suite | Mean | Variance | Samples |\n' +
        '| --- | --- | --- | --- | --- |\n' +
        '| 1 | Suite 1 | 7.5 | 6.25 | 2 |\n' +
        '| 2 | Suite 2 | 10 (+2.5 ; x1.333) | 4 | 2 |',
        '列顺序取结果对象的键序，分隔行是五个 ---');
      assert.eq(arrayToMarkdownTable([{ foo: 1, bar: 2 }]),
        '| foo | bar |\n| --- | --- |\n| 1 | 2 |',
        '没有 headerMap 时用键名兜底');

      /* ---- bullet list ---- */
      assert.eq(toBulletList(dflt),
        ' - Suite 1\n    - Position: 1\n    - Mean: 7.5\n    - Variance: 6.25\n    - Samples: 2\n' +
        ' - Suite 2\n    - Position: 2\n    - Mean: 10 (+2.5 ; x1.333)\n    - Variance: 4\n    - Samples: 2',
        'suite 行缩进 1 格、子项缩进 4 个空格，末尾无换行');
      assert.eq(toBulletList([]), '', '空结果返回空串');

      /* ---- 存储形状不对时要退回默认值，而不是崩 ---- */
      assert.eq(sanitizeSuites(null), defaultSuites(), 'null');
      assert.eq(sanitizeSuites('nonsense'), defaultSuites(), '字符串');
      assert.eq(sanitizeSuites([]), defaultSuites(), '空数组');
      assert.eq(sanitizeSuites([1, 'x', null]), defaultSuites(), '全是非对象项');
      assert.eq(sanitizeSuites({ 0: { title: 'S', data: [] } }), defaultSuites(), '对象不是数组');
      assert.eq(sanitizeSuites([{ title: 'S' }]), [{ title: 'S', data: [] }], '缺 data 补空数组');
      assert.eq(sanitizeSuites([{ title: 7, data: [1, 'a', null, NaN] }]),
        [{ title: '', data: [1, null, null, null] }],
        '非字符串 title 清空；非数字的样本降级成 null，空行因此得以保留');
      assert.eq(sanitizeSuites([[1, 2]]), defaultSuites(), '数组项也算形状不对');
      assert.eq(sanitizeUnit('ms'), 'ms', '单位就是字符串');
      assert.eq(sanitizeUnit(5), '', '非字符串单位退回空串');
      assert.eq(sanitizeUnit(null), '', 'null 单位退回空串');

      /* ---- localStorage 往返 ---- */
      localStorage.setItem(SUITES_KEY, '{"not":"a suite list"}');
      assert.eq(loadSuites(), defaultSuites(), '存了别的东西 → 读回默认值');
      localStorage.setItem(SUITES_KEY, 'not json at all');
      assert.eq(loadSuites(), defaultSuites(), '存了坏 JSON → 读回默认值而不是抛异常');
      localStorage.setItem(SUITES_KEY, JSON.stringify([{ title: 'Kept', data: [3, null] }]));
      assert.eq(loadSuites(), [{ title: 'Kept', data: [3, null] }], '正常结构往返无损');
      saveSuites([{ title: 'Saved', data: [1.5] }]);
      assert.eq(JSON.parse(localStorage.getItem(SUITES_KEY)), [{ title: 'Saved', data: [1.5] }],
        '写入的就是 JSON 数组');
      assert.eq(loadUnit(), '', '没存过单位就是空串');
      saveUnit('ms');
      assert.eq(localStorage.getItem(UNIT_KEY), '"ms"', '单位按 JSON 字符串存');
      assert.eq(loadUnit(), 'ms', '单位读回');
      localStorage.removeItem(SUITES_KEY);
      localStorage.removeItem(UNIT_KEY);

      /* ---- 新 suite 的名字 ---- */
      assert.eq(nextSuiteTitle(defaultSuites()), 'Suite 3', '默认两个 → Suite 3');
      assert.eq(nextSuiteTitle([{ title: 'Suite 1' }, { title: 'Suite 2' }, { title: 'Suite 3' }]),
        'Suite 4', '接着往后排');
      assert.eq(nextSuiteTitle([{ title: 'a' }, { title: 'b' }]), 'Suite 1',
        '没有同名就从头取');
      assert.eq(nextSuiteTitle([{ title: 'Suite 2' }, { title: 'Suite 1' }]), 'Suite 3',
        '乱序也能跳过已占用的名字（原版会撞名）');
    }
  };
})();