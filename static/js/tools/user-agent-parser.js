/* ==========================================================================
   User Agent 解析器（user-agent-parser）

   把一段 User-Agent 字符串拆成浏览器 / 引擎 / 系统 / 设备 / CPU 五组字段。

   参考实现：src/tools/user-agent-parser/（it-tools, GPLv3）
   与原版的差别：
   · 原版用 `UAParser(ua)` 直接调（v1 的写法）。这里统一成 `new UAParser(ua).getResult()`，
     两种写法在 v1.0.35 上结果一致，但后者在 v2 上还能用（v2 取消了裸调用）。
   · 原版的字段表格对每个字段配了 undefinedFallback 文案。这里保留这个行为，
     解析不出来的字段渲染成一句人话，而不是留空白单元格 —— 空值和「没填」看起来一样。
   · 原版没有示例 UA。这里补了几条一键填充（纯 UI 便利，不影响解析行为）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('user-agent-parser');

  /**
   * 示例 UA：覆盖桌面 / iOS / Android / Chromium 系 / 命令行五种常见形态。
   *
   * label 走 i18n（界面上是按钮上的文字），id 是稳定的内部标识 —— 断言按 id 查。
   */
  var SAMPLES = [
    {
      id: 'chrome_windows',
      label: t('sample_chrome_windows', 'Chrome on Windows'),
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    {
      id: 'safari_iphone',
      label: t('sample_safari_iphone', 'Safari on iPhone'),
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'
    },
    {
      id: 'chrome_android',
      label: t('sample_chrome_android', 'Chrome on Android'),
      ua: 'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36'
    },
    {
      id: 'edge_windows',
      label: t('sample_edge_windows', 'Edge on Windows'),
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.2088.76'
    },
    {
      id: 'firefox_linux',
      label: t('sample_firefox_linux', 'Firefox on Linux'),
      ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/119.0'
    },
    {
      id: 'curl',
      label: t('sample_curl', 'curl'),
      ua: 'curl/8.4.0'
    }
  ];

  /**
   * 解析 UA。
   *
   * 空串必须在这里挡掉：`UAParser('')` 会去读 `navigator.userAgent`，返回**当前浏览器**
   * 的解析结果 —— 用户什么都没填却看到一整页自己的浏览器信息，比空白更让人困惑。
   *
   * @param {string} ua
   * @returns {{ua:string,browser:object,cpu:object,device:object,engine:object,os:object}}
   */
  function parseUserAgent(ua) {
    var text = typeof ua === 'string' ? ua.trim() : '';
    if (!text) {
      return { ua: '', browser: {}, cpu: {}, device: {}, engine: {}, os: {} };
    }
    return new window.UAParser(text).getResult();
  }

  /**
   * 把解析结果拍平成 [{group,label,value}] 的展示列表。
   * value 为空时给出 fallback 文案，UI 与单测都用这一份结构。
   *
   * group / label 都走 i18n（界面上是表格里的文字），同时给出稳定的 id ——
   * 断言按 id 查，不受语言影响。
   *
   * 注意 `device.os`：ua-parser-js 1.x 的 device 块只有 vendor/model/type，
   * 这个字段在当前版本恒为空 —— 仍然列出它，是为了将来换库/升版本时能直接用上。
   *
   * @param {string} ua
   * @returns {Array<{group:string,groupLabel:string,id:string,label:string,value:string,empty:boolean}>}
   */
  function describeUserAgent(ua) {
    var r = parseUserAgent(ua);
    var groups = [
      {
        id: 'browser',
        label: t('group_browser', 'Browser'),
        fields: [
          { id: 'name', label: t('field_name', 'Name'), get: function (x) { return x.browser.name; }, missing: t('missing_browser_name', 'No browser name available') },
          { id: 'version', label: t('field_version', 'Version'), get: function (x) { return x.browser.version; }, missing: t('missing_browser_version', 'No browser version available') },
          { id: 'major', label: t('field_major', 'Major'), get: function (x) { return x.browser.major; }, missing: t('missing_browser_major', 'No browser major version available') }
        ]
      },
      {
        id: 'engine',
        label: t('group_engine', 'Engine'),
        fields: [
          { id: 'name', label: t('field_name', 'Name'), get: function (x) { return x.engine.name; }, missing: t('missing_engine_name', 'No engine name available') },
          { id: 'version', label: t('field_version', 'Version'), get: function (x) { return x.engine.version; }, missing: t('missing_engine_version', 'No engine version available') }
        ]
      },
      {
        id: 'os',
        label: t('group_os', 'OS'),
        fields: [
          { id: 'name', label: t('field_name', 'Name'), get: function (x) { return x.os.name; }, missing: t('missing_os_name', 'No OS name available') },
          { id: 'version', label: t('field_version', 'Version'), get: function (x) { return x.os.version; }, missing: t('missing_os_version', 'No OS version available') }
        ]
      },
      {
        id: 'device',
        label: t('group_device', 'Device'),
        fields: [
          { id: 'model', label: t('field_model', 'Model'), get: function (x) { return x.device.model; }, missing: t('missing_device_model', 'No device model available') },
          { id: 'type', label: t('field_type', 'Type'), get: function (x) { return x.device.type; }, missing: t('missing_device_type', 'No device type available') },
          { id: 'vendor', label: t('field_vendor', 'Vendor'), get: function (x) { return x.device.vendor; }, missing: t('missing_device_vendor', 'No device vendor available') },
          { id: 'os', label: t('field_os', 'OS'), get: function (x) { return x.device.os; }, missing: t('missing_device_os', 'No device OS available') }
        ]
      },
      {
        id: 'cpu',
        label: t('group_cpu', 'CPU'),
        fields: [
          { id: 'architecture', label: t('field_architecture', 'Architecture'), get: function (x) { return x.cpu.architecture; }, missing: t('missing_cpu_architecture', 'No CPU architecture available') }
        ]
      }
    ];

    var out = [];
    groups.forEach(function (g) {
      g.fields.forEach(function (f) {
        var raw = f.get(r);
        var value = raw === undefined || raw === null || raw === '' ? '' : String(raw);
        out.push({
          group: g.id,
          groupLabel: g.label,
          id: f.id,
          label: f.label,
          value: value,
          empty: !value,
          fallback: f.missing
        });
      });
    });
    return out;
  }

  /** 有没有任何一项解析出来 —— 用来决定要不要提示「这条 UA 认不出来」。 */
  function isRecognized(ua) {
    return describeUserAgent(ua).some(function (row) { return !row.empty; });
  }

  /**
   * 只保留「真的有值」的键。
   * ua-parser-js 解析失败时给的是 `{name: undefined, ...}` 而不是空对象 `{}`，
   * 直接 Object.keys 会数出一堆 undefined，得先滤一遍。
   */
  function filledKeys(block) {
    if (!block || typeof block !== 'object') return [];
    return Object.keys(block).filter(function (k) {
      return block[k] !== undefined && block[k] !== null && block[k] !== '';
    });
  }

  window.ItTools.register('user-agent-parser', function (root) {
    // 原版这个输入框是 monospace 的
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 3, spellcheck: 'false', 'aria-label': t('input', 'User agent string'),
      placeholder: t('input_ph', 'Put your user-agent here...')
    });

    var sampleRow = D.h('div.form-actions', null,
      SAMPLES.map(function (s) {
        return D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button',
          text: s.label,
          onclick: function () { input.value = s.ua; render(); }
        });
      })
    );

    var summary = D.h('span.badge-note', { text: t('waiting', 'Waiting for a user agent') });
    var output = D.h('div.card');

    function sectionRows(group) {
      return describeUserAgent(input.value).filter(function (row) { return row.group === group; });
    }

    function card(group) {
      // 这里返回的是「卡片里的一段」，不是独立面板：整组结果共用一张卡片，
      // 否则 .tool-content 的 flex 会把 OS/Device/CPU 拆成三块并排。
      var rows = sectionRows(group);
      var box = D.h('div', { style: { marginBottom: '18px' } },
        D.h('h3.field-label', { text: rows.length ? rows[0].groupLabel : group })
      );
      var table = D.h('table.kv-table', null, D.h('tbody'));
      rows.forEach(function (row) {
        table.appendChild(D.h('tr', null,
          D.h('td', { text: row.label }),
          D.h('td.val', { text: row.empty ? row.fallback : row.value, style: row.empty ? { opacity: '.7' } : null })
        ));
      });
      box.appendChild(table);
      return box;
    }

    function render() {
      D.clear(output);
      var raw = input.value.trim();
      if (!raw) {
        summary.textContent = t('waiting', 'Waiting for a user agent');
        output.appendChild(D.h('p.field-hint', { text: t('paste_hint', 'Paste a user agent above to see what it resolves to.') }));
        return;
      }
      summary.textContent = isRecognized(raw)
        ? t('recognized', 'Recognized user agent')
        : t('not_recognized', 'Nothing recognized in this user agent');
      output.appendChild(card('browser'));
      output.appendChild(card('engine'));
      output.appendChild(card('os'));
      output.appendChild(card('device'));
      output.appendChild(card('cpu'));
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'User agent string'), input, { wide: true }),
      sampleRow,
      D.h('div.field-row', { style: { marginTop: '16px', marginBottom: '0' } },
        D.h('label.field-label', { text: t('status', 'Status') }),
        summary
      )
    ));
    root.appendChild(output);
    render();

    return {
      destroy: function () {
        off();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['user-agent-parser'] = {
    SAMPLES: SAMPLES,
    parseUserAgent: parseUserAgent,
    describeUserAgent: describeUserAgent,
    isRecognized: isRecognized,
    filledKeys: filledKeys,
    __cases: function (assert) {
      var CHROME_WIN = SAMPLES[0].ua;
      var SAFARI_IPHONE = SAMPLES[1].ua;
      var ANDROID = SAMPLES[2].ua;
      var EDGE = SAMPLES[3].ua;
      var FIREFOX = SAMPLES[4].ua;
      var CURL = SAMPLES[5].ua;

      /* ---- 正常值 ---- */
      var r = parseUserAgent(CHROME_WIN);
      assert.eq(r.browser, { name: 'Chrome', version: '120.0.0.0', major: '120' }, 'Windows Chrome 的浏览器块');
      assert.eq(r.engine, { name: 'Blink', version: '120.0.0.0' }, 'Chromium 的引擎是 Blink');
      assert.eq(r.os, { name: 'Windows', version: '10' }, '系统块');
      assert.eq(r.cpu, { architecture: 'amd64' }, 'Win64 x64 → amd64');
      assert.eq(r.device, {}, '桌面浏览器没有设备块');

      r = parseUserAgent(SAFARI_IPHONE);
      assert.eq(r.browser.name, 'Mobile Safari', 'iPhone 上的 Safari');
      assert.eq(r.browser.version, '17.1', 'Safari 版本');
      assert.eq(r.engine.name, 'WebKit', 'iOS Safari 引擎是 WebKit');
      assert.eq(r.os, { name: 'iOS', version: '17.1' }, 'iOS 版本');
      assert.eq(r.device, { vendor: 'Apple', model: 'iPhone', type: 'mobile' }, '设备块');

      r = parseUserAgent(ANDROID);
      assert.eq(r.device, { vendor: 'Samsung', model: 'SM-S908B', type: 'mobile' }, 'Android 设备块');
      assert.eq(r.os, { name: 'Android', version: '13' }, 'Android 版本');

      // 同一族里靠 UA 尾部区分浏览器，Chromium 内核仍然是 Blink
      r = parseUserAgent(EDGE);
      assert.eq(r.browser.name, 'Edge', 'Edge 不是 Chrome');
      assert.eq(r.engine.name, 'Blink', 'Edge 引擎仍是 Blink');

      r = parseUserAgent(FIREFOX);
      assert.eq(r.browser.name, 'Firefox', 'Firefox');
      assert.eq(r.engine, { name: 'Gecko', version: '109.0' }, 'Gecko 版本取自 rv:');

      /* ---- 边界：空串不能退回当前浏览器 ---- */
      // 这是原版注释里点名的坑：UAParser('') 会去解析 navigator.userAgent
      assert.eq(parseUserAgent(''), { ua: '', browser: {}, cpu: {}, device: {}, engine: {}, os: {} }, '空串返回全空结果');
      assert.eq(parseUserAgent('    '), { ua: '', browser: {}, cpu: {}, device: {}, engine: {}, os: {} }, '纯空白同样返回全空');
      assert(parseUserAgent('') !== null, '空串返回对象而不是 null');
      assert.eq(parseUserAgent(null).ua, '', 'null 也不炸');
      assert.eq(parseUserAgent(undefined).ua, '', 'undefined 也不炸');
      // 前后空白会被去掉，且 ua 字段回显的是去掉空白后的串
      assert.eq(parseUserAgent('  ' + CHROME_WIN + '  ').ua, CHROME_WIN, '首尾空白被裁掉');

      /* ---- 非法输入：认不出来就是认不出来，不能编 ---- */
      r = parseUserAgent(CURL);
      assert.eq(r.browser, {}, 'curl 不是浏览器');
      assert.eq(r.os, {}, 'curl 没有 OS 块');
      // 注意两点：① assert.eq 走 JSON.stringify，对象键顺序不同就会判不等；
      //          ② 解析不出来时库里塞的是 undefined 值而不是不写这个键
      //             （JSON.stringify 会把它们抹成 {}，Object.keys 却看得到）。
      //             所以判「空」只能数有值的键。
      var bogus = parseUserAgent('TotallyMadeUpAgent/1.0');
      assert.eq(bogus.ua, 'TotallyMadeUpAgent/1.0', '原样回显 UA');
      assert.eq([bogus.browser, bogus.cpu, bogus.device, bogus.engine, bogus.os].map(function (b) { return filledKeys(b).length; }),
        [0, 0, 0, 0, 0], '完全编造的 UA 各块都没有有值的字段');

      /* ---- 展示层：缺字段要用 fallback 文案，而不是留空 ---- */
      var rows = describeUserAgent(CURL);
      assert.eq(rows.length, 12, '5 组共 12 个字段（Browser 3 + Engine 2 + OS 2 + Device 4 + CPU 1）');
      assert(rows.every(function (x) { return x.empty === true; }), 'curl 的所有字段都标记为空');
      // label 现在是翻译过的显示名，断言一律按稳定的 id 查
      var nameRow = rows.filter(function (x) { return x.group === 'browser' && x.id === 'name'; })[0];
      assert.eq(nameRow.value, '', '空字段的 value 是空串');
      assert.eq(nameRow.fallback, 'No browser name available', '空字段带 fallback 文案');

      rows = describeUserAgent(SAFARI_IPHONE);
      var byKey = {};
      rows.forEach(function (x) { byKey[x.group + '.' + x.id] = x; });
      assert.eq(byKey['device.model'].value, 'iPhone', 'Device/Model');
      assert.eq(byKey['device.type'].value, 'mobile', 'Device/Type');
      assert.eq(byKey['device.vendor'].value, 'Apple', 'Device/Vendor');
      // ua-parser-js 1.x 的 device 块没有 os 字段，这一行必然显示 fallback
      assert.eq(byKey['device.os'].value, '', 'device.os 在当前库版本里恒为空');
      assert.eq(byKey['cpu.architecture'].empty, true, 'iPhone UA 没有 CPU 架构');
      assert.eq(byKey['os.name'].value, 'iOS', 'OS/Name');
      assert.eq(byKey['engine.version'].value, '605.1.15', 'Engine/Version');
      assert.eq(byKey['browser.major'].value, '17', 'Browser/Major 单独取主版本');

      /* ---- 认不出来的判据 ---- */
      assert(isRecognized(CHROME_WIN) === true, '正常 UA 认得出来');
      assert(isRecognized(CURL) === false, 'curl 认不出来');
      assert(isRecognized('') === false, '空串认不出来');
      assert(isRecognized('not a ua') === false, '垃圾串认不出来');
    }
  };
})();