/* ==========================================================================
   随机端口生成器（random-port-generator）

   从注册端口段里随机取一个端口号。

   参考实现：src/tools/random-port-generator/（it-tools, GPLv3）
   与原版的差别：
   1. 原版的 randIntFromInterval(min, max) 实际是 Math.floor(rand()*(max-min)+min)，
      右开区间，生成端口永远摸不到 65535。这里把区间定义成闭区间 [1024, 65535]。
   2. 原版用 Math.random() 取随机数。这里走 crypto.getRandomValues。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('random-port-generator');

  /** 端口范围：0~1023 是系统/知名端口，不参与。 */
  var DEFAULT_MIN = 1024;
  var DEFAULT_MAX = 65535;

  /**
   * 主函数：生成一个 [min, max] 闭区间内的随机端口。
   * 区间两端写反时自动纠正，避免拿到空区间。
   */
  function generatePort(min, max) {
    var lo = Math.floor(min === undefined ? DEFAULT_MIN : min);
    var hi = Math.floor(max === undefined ? DEFAULT_MAX : max);
    if (lo > hi) { var tmp = lo; lo = hi; hi = tmp; }
    if (hi < lo) return null;
    return lo + U.randomInt(hi - lo + 1);
  }

  window.ItTools.register('random-port-generator', function (root) {
    var display = D.h('div.mono-output', {
      style: { textAlign: 'center', fontSize: '26px', fontWeight: '400', margin: '10px 0 25px' },
      text: ''
    });

    function refresh() {
      display.textContent = String(generatePort());
    }

    root.appendChild(D.h('div.card', null,
      display,
      D.h('div.form-actions', null,
        U.copyButton(function () { return display.textContent; }),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('refresh', 'Refresh'), onclick: refresh
        })
      )
    ));
    refresh();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['random-port-generator'] = {
    generatePort: generatePort,
    DEFAULT_MIN: DEFAULT_MIN,
    DEFAULT_MAX: DEFAULT_MAX,
    __cases: function (assert) {
      assert.eq(generatePort(5, 5), 5, '单点区间');
      // 默认区间两端都能取到（原版取不到 65535）
      assert.eq(generatePort(1, 1), 1, '下界可达');
      assert.eq(generatePort(65535, 65535), 65535, '上界可达');
      assert(generatePort() >= 1024 && generatePort() <= 65535, '默认落在 1024~65535');

      // 端点确实能被取到：闭区间上，原版永远摸不到 max
      var seenMin = false, seenMax = false;
      for (var i = 0; i < 400; i++) {
        var p = generatePort(1024, 1025);
        if (p === 1024) seenMin = true;
        if (p === 1025) seenMax = true;
      }
      assert(seenMin && seenMax, '闭区间两端都应可达');
      var flipped = generatePort(10, 5);
      assert(flipped >= 5 && flipped <= 10, '写反的区间也能取值');

      // 全落在区间内，且两个端口不该总是相同
      var a = generatePort(1024, 65535);
      var b = generatePort(1024, 65535);
      assert(Number.isInteger(a) && a >= 1024 && a <= 65535, '落在区间内');
      assert(a !== b, '两次生成应不同');

      // 覆盖参考实现单测的取值范围
      var seen = {};
      for (var j = 0; j < 2000; j++) seen[generatePort(1, 5)] = true;
      assert.eq(Object.keys(seen).sort(), ['1', '2', '3', '4', '5'], '五个值都出现过');
    }
  };
})();