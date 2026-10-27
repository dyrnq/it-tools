/* ==========================================================================
   秒表（chronometer）

   requestAnimationFrame 驱动的计时显示，支持计次（lap）。

   参考实现：src/tools/chronometer/（it-tools, GPLv3）
   与原版的唯一差别：原版在每帧里累加 `Date.now() - previous`，一旦标签页被
   切到后台，rAF 会被浏览器完全停掉，这段时间就一毫秒都不计（切回来会发现
   秒表「走慢了」）。这里改成记录「本次运行的起点」，每帧直接算
   `累计 + (now - 本段起点)`，后台暂停不影响读数。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('chronometer');

  /* jsdom 等没有 rAF 的环境退回 setTimeout，cancel 侧对称处理。 */
  var HAS_RAF = typeof window.requestAnimationFrame === 'function';

  /** 高精度时钟；拿不到 performance.now 时退回 Date.now()。 */
  function now() {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  }

  function scheduleFrame(cb) {
    return HAS_RAF
      ? window.requestAnimationFrame(cb)
      : window.setTimeout(function () { cb(now()); }, 16);
  }

  function cancelFrame(id) {
    if (id == null) return;
    if (HAS_RAF) window.cancelAnimationFrame(id);
    else window.clearTimeout(id);
  }

  /**
   * 把毫秒数格式化成 mm:ss.mmm（超过一小时前面补 hh:）。
   * 与参考实现逐字符一致：小时位只在 > 0 时出现，且不做小时进位截断。
   */
  function formatMs(msTotal) {
    var total = Math.max(0, Math.floor(msTotal) || 0);
    var ms = total % 1000;
    var secs = ((total - ms) / 1000) % 60;
    var mins = (((total - ms) / 1000 - secs) / 60) % 60;
    var hrs = (((total - ms) / 1000 - secs) / 60 - mins) / 60;
    var hrsString = hrs > 0 ? hrs.toString().padStart(2, '0') + ':' : '';
    return hrsString +
      mins.toString().padStart(2, '0') + ':' +
      secs.toString().padStart(2, '0') + '.' +
      ms.toString().padStart(3, '0');
  }

  /**
   * 把 [{index, total}] 的原始计次算成展示用的行（含分段 split）。
   * total 视为毫秒，内部会做一次兜底的数值净化，避免非数字把后面全带崩。
   */
  function lapRows(laps) {
    var prev = 0;
    return (laps || []).map(function (lap, i) {
      var total = Number(lap && lap.total) || 0;
      var row = {
        index: (lap && lap.index) != null ? lap.index : i + 1,
        total: formatMs(total),
        totalMs: total,
        split: formatMs(total - prev)
      };
      prev = total;
      return row;
    });
  }

  window.ItTools.register('chronometer', function (root) {
    var accumulated = 0;   // 已暂停期间累计的毫秒
    var segmentStart = 0;  // 本次连续运行的起点（performance.now）
    var running = false;
    var laps = [];         // 倒序，最新的在最上面
    var rafId = null;

    var display = D.h('p.mono-output', {
      text: formatMs(0),
      style: { fontSize: '40px', textAlign: 'center', margin: '20px 0', fontWeight: '600' }
    });
    var lapBox = D.h('div');
    var lapBadge = D.h('span.badge-note', { text: '0 ' + t('laps', 'laps') });

    /** 当前应显示的时长：累计 + 本段已跑。 */
    function elapsed() {
      return accumulated + (running ? now() - segmentStart : 0);
    }

    function renderLaps() {
      D.clear(lapBox);
      var rows = lapRows(laps);
      lapBadge.textContent = rows.length + ' ' + (rows.length === 1 ? t('lap_one', 'lap') : t('laps', 'laps'));
      if (!rows.length) {
        lapBox.appendChild(D.h('p.field-hint', { text: t('no_laps', 'No lap recorded yet.') }));
        return;
      }
      var tbody = D.h('tbody');
      rows.forEach(function (r) {
        tbody.appendChild(D.h('tr', null,
          D.h('td', { text: '#' + r.index }),
          D.h('td.val', { text: r.split }),
          D.h('td.val', { text: r.total })
        ));
      });
      lapBox.appendChild(D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { text: t('col_lap', 'Lap') }),
          D.h('th', { text: t('col_split', 'Split time') }),
          D.h('th', { text: t('col_total', 'Total time') })
        )),
        tbody
      ));
    }

    function render() {
      display.textContent = formatMs(elapsed());
    }

    function frame() {
      render();
      rafId = scheduleFrame(frame);
    }

    var toggleBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('start', 'Start') });
    var lapBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('lap', 'Lap'), disabled: true });
    var resetBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('reset', 'Reset') });

    function setRunning(on) {
      running = on;
      toggleBtn.textContent = on ? t('stop', 'Stop') : t('start', 'Start');
      lapBtn.disabled = !on;
      if (on) {
        segmentStart = now();
        cancelFrame(rafId);
        rafId = scheduleFrame(frame);
      } else {
        cancelFrame(rafId);
        rafId = null;
        accumulated = elapsed();   // 停表瞬间把本段固化
      }
      render();
    }

    toggleBtn.addEventListener('click', function () { setRunning(!running); });

    lapBtn.addEventListener('click', function () {
      if (!running) return;
      // 倒序存，最新的在最上面；index 从 1 递增
      laps.unshift({ index: laps.length + 1, total: elapsed() });
      renderLaps();
    });

    resetBtn.addEventListener('click', function () {
      setRunning(false);
      accumulated = 0;
      laps = [];
      render();
      renderLaps();
    });

    root.appendChild(D.h('div.card', null,
      display,
      // 按钮条待在这张卡里：直接挂到 root 上会被 flex 拆成独立面板
      D.h('div.form-actions', { style: { justifyContent: 'center' } },
        toggleBtn, lapBtn, resetBtn,
        U.copyButton(function () { return formatMs(elapsed()); }, t('copy_time', 'Copy time'))
      )
    ));
    root.appendChild(D.h('div.card', null,
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('laps_title', 'Laps') }),
        lapBadge
      ),
      lapBox
    ));
    render();
    renderLaps();

    return {
      destroy: function () {
        cancelFrame(rafId);   // 必须的：页面切换时不留悬空 rAF 回调
        rafId = null;
        running = false;
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['chronometer'] = {
    formatMs: formatMs,
    lapRows: lapRows,
    __cases: function (assert) {
      // 与参考实现 chronometer.service.test.ts 的四个用例一致
      assert.eq(formatMs(0), '00:00.000', '0 毫秒');
      assert.eq(formatMs(1), '00:00.001', '1 毫秒');
      assert.eq(formatMs(123456), '02:03.456', '2 分 3 秒 456 毫秒');
      assert.eq(formatMs(12345600), '03:25:45.600', '3 小时 25 分 45 秒 600 毫秒');
      // 小时位只在 > 0 时出现，且恰好 60 分钟要进位到 01:00:00.000
      assert.eq(formatMs(59999), '00:59.999', '不满一分钟不带小时位');
      assert.eq(formatMs(3600000), '01:00:00.000', '一小时整');
      assert.eq(formatMs(36000000), '10:00:00.000', '十小时不进位到天');
      assert.eq(formatMs(-5), '00:00.000', '负数兜底为 0');
      assert.eq(formatMs(1.9), '00:00.001', '小数向下取整');

      assert.eq(lapRows([]), [], '无计次');
      assert.eq(lapRows([{ index: 1, total: 1000 }, { index: 2, total: 3500 }]), [
        { index: 1, total: '00:01.000', totalMs: 1000, split: '00:01.000' },
        { index: 2, total: '00:03.500', totalMs: 3500, split: '00:02.500' }
      ], '分段 = 本次累计 - 上一次累计');
    }
  };
})();