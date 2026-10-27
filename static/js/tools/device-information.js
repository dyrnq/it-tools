/* ==========================================================================
   设备信息（device-information）

   把 navigator / screen / window 上的可见信息摊平成几张表，并在窗口尺寸、
   屏幕方向、在线状态、设备列表变化时刷新。

   参考实现：src/tools/device-information/（it-tools, GPLv3）
   与原版的差别：
   1. 原版直接读 `screen.orientation.type`，而 orientation 在多数桌面浏览器上
      就是 undefined，会连带把整个渲染搞崩；这里所有取值都走 try/catch 兜底，
      拿不到就显示 unknown（与原版的空值展示一致）。
   2. 原版只监听窗口尺寸。这里额外监听 orientationchange / online / offline /
      devicechange，并且这些监听全部登记在 destroy 里摘掉 —— 页面上反复切换
      工具时最容易出的就是这一类泄漏。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('device-information');

  /** 取环境对象。screen / navigator 在极端嵌入环境（如某些 SSR 桩）下可能整个没有。 */
  function readEnv(win) {
    return { win: win, nav: win.navigator || {}, scr: win.screen || {} };
  }

  /** 统一取值：null / undefined / 空串 / 非有限数字 一律按「拿不到」处理。 */
  function raw(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    return String(v);
  }

  /** 空值统一显示 unknown —— 与参考实现 v-else 分支的文案一致。 */
  function show(v) { return raw(v) || t('unknown', 'unknown'); }

  function prop(obj, name) {
    try { return obj ? obj[name] : undefined; } catch (e) { return undefined; }   // 某些 getter 会抛
  }

  /** 能力探测表：[标签, 判定函数]。判定函数返回真值即视为「支持」。 */
  var CAPABILITIES = [
    ['media_recorder', 'MediaRecorder', function (e) { return prop(e.win, 'MediaRecorder'); }],
    ['media_stream', 'MediaStream', function (e) { return prop(e.win, 'MediaStream'); }],
    ['get_user_media', 'getUserMedia', function (e) { return prop(prop(e.nav, 'mediaDevices'), 'getUserMedia'); }],
    ['webgl', 'WebGL', function (e) { return prop(e.win, 'WebGLRenderingContext'); }],
    ['webrtc', 'WebRTC', function (e) { return prop(e.win, 'RTCPeerConnection'); }],
    ['web_worker', 'Web Worker', function (e) { return prop(e.win, 'Worker'); }],
    ['service_worker', 'Service Worker', function (e) { return prop(e.nav, 'serviceWorker'); }],
    ['indexeddb', 'IndexedDB', function (e) { return prop(e.win, 'indexedDB'); }],
    ['clipboard_api', 'Clipboard API', function (e) { return prop(e.nav, 'clipboard'); }],
    ['notifications', 'Notifications', function (e) { return prop(e.win, 'Notification'); }],
    ['geolocation', 'Geolocation', function (e) { return prop(e.nav, 'geolocation'); }],
    ['wake_lock', 'Wake Lock', function (e) { return prop(e.nav, 'wakeLock'); }],
    ['web_crypto', 'Web Crypto', function (e) { return prop(e.win, 'crypto') && prop(prop(e.win, 'crypto'), 'subtle'); }],
    ['match_media', 'matchMedia', function (e) { return prop(e.win, 'matchMedia'); }],
    ['resize_observer', 'ResizeObserver', function (e) { return prop(e.win, 'ResizeObserver'); }],
    ['intl', 'Intl', function (e) { return prop(e.win, 'Intl'); }],
    ['touch_events', 'Touch events', function (e) { return 'ontouchstart' in e.win; }]
  ];

  /**
   * 把环境对象摊平成若干分区。每行的 value 已经是可直接显示的字符串
   * （拿不到就是 unknown），所以这份函数是纯的、可单测的。
   * @param {{win:Window,nav:Navigator,screen:Object,battery?:Object,storage?:Object}} env
   */
  function snapshot(env) {
    var win = env.win, nav = env.nav, scr = env.scr;
    var orient = prop(scr, 'orientation');
    var conn = prop(nav, 'connection') || prop(nav, 'mozConnection') || prop(nav, 'webkitConnection');
    var battery = env.battery || null;
    var storage = env.storage || null;

    var sections = [
      {
        id: 'screen',
        name: t('section_screen', 'Screen'),
        rows: [
          { id: 'screen_size', label: t('row_screen_size', 'Screen size'), value: show(prop(scr, 'availWidth')) + ' x ' + (raw(prop(scr, 'availHeight')) || t('unknown', 'unknown')) },
          { id: 'full_resolution', label: t('row_full_resolution', 'Full resolution'), value: show(prop(scr, 'width')) + ' x ' + (raw(prop(scr, 'height')) || t('unknown', 'unknown')) },
          { id: 'orientation', label: t('row_orientation', 'Orientation'), value: show(prop(orient, 'type')) },
          { id: 'orientation_angle', label: t('row_orientation_angle', 'Orientation angle'), value: show(prop(orient, 'angle') === undefined ? undefined : prop(orient, 'angle') + '°') },
          { id: 'color_depth', label: t('row_color_depth', 'Color depth'), value: show(prop(scr, 'colorDepth')) + (raw(prop(scr, 'colorDepth')) ? ' bits' : '') },
          { id: 'pixel_ratio', label: t('row_pixel_ratio', 'Pixel ratio'), value: show(prop(win, 'devicePixelRatio')) + (raw(prop(win, 'devicePixelRatio')) ? ' dppx' : '') },
          { id: 'window_size', label: t('row_window_size', 'Window size'), value: show(prop(win, 'innerWidth')) + ' x ' + (raw(prop(win, 'innerHeight')) || t('unknown', 'unknown')) },
          { id: 'window_position', label: t('row_window_position', 'Window position'), value: show(prop(win, 'screenX')) + ', ' + (raw(prop(win, 'screenY')) || t('unknown', 'unknown')) }
        ]
      },
      {
        id: 'device',
        name: t('section_device', 'Device'),
        rows: [
          { id: 'browser_vendor', label: t('row_browser_vendor', 'Browser vendor'), value: show(prop(nav, 'vendor')) },
          { id: 'platform', label: t('row_platform', 'Platform'), value: show(prop(nav, 'platform')) },
          { id: 'languages', label: t('row_languages', 'Languages'), value: show((prop(nav, 'languages') || []).join(', ') || prop(nav, 'language')) },
          { id: 'user_agent', label: t('row_user_agent', 'User agent'), value: show(prop(nav, 'userAgent')) },
          { id: 'hardware_concurrency', label: t('row_hardware_concurrency', 'Hardware concurrency'), value: show(prop(nav, 'hardwareConcurrency')) },
          { id: 'max_touch_points', label: t('row_max_touch_points', 'Max touch points'), value: show(prop(nav, 'maxTouchPoints')) },
          { id: 'online', label: t('row_online', 'Online'), value: raw(prop(nav, 'onLine')) === '' ? t('unknown', 'unknown') : (nav.onLine ? t('yes', 'yes') : t('no', 'no')) },
          { id: 'cookies_enabled', label: t('row_cookies_enabled', 'Cookies enabled'), value: prop(nav, 'cookieEnabled') ? t('yes', 'yes') : (prop(nav, 'cookieEnabled') === false ? t('no', 'no') : t('unknown', 'unknown')) },
          { id: 'do_not_track', label: t('row_do_not_track', 'Do Not Track'), value: raw(prop(nav, 'doNotTrack')) === '' ? t('not_set', 'not set') : nav.doNotTrack },
          { id: 'global_privacy_control', label: t('row_global_privacy_control', 'Global Privacy Control'), value: prop(nav, 'globalPrivacyControl') === undefined ? t('unknown', 'unknown') : (nav.globalPrivacyControl ? t('on', 'on') : t('off', 'off')) }
        ]
      },
      {
        id: 'runtime',
        name: t('section_runtime', 'Runtime'),
        rows: [
          { id: 'timezone', label: t('row_timezone', 'Timezone'), value: show(getTimeZone()) },
          { id: 'utc_offset', label: t('row_utc_offset', 'UTC offset'), value: utcOffsetLabel() },
          { id: 'utc_offset_minutes', label: t('row_utc_offset_minutes', 'UTC offset (minutes)'), value: utcOffsetMinutes() === null ? t('unknown', 'unknown') : (utcOffsetMinutes() > 0 ? '+' : '') + utcOffsetMinutes() },
          { id: 'network_type', label: t('row_network_type', 'Network type'), value: show(prop(conn, 'effectiveType')) },
          { id: 'battery_level', label: t('row_battery_level', 'Battery level'), value: battery ? Math.round(battery.level * 100) + '%' : t('unknown', 'unknown') },
          { id: 'charging', label: t('row_charging', 'Charging'), value: battery ? (battery.charging ? t('yes', 'yes') : t('no', 'no')) : t('unknown', 'unknown') },
          { id: 'storage_used', label: t('row_storage_used', 'Storage used'), value: storage && storage.usage != null ? formatBytes(storage.usage) : t('unknown', 'unknown') },
          { id: 'storage_quota', label: t('row_storage_quota', 'Storage quota'), value: storage && storage.quota != null ? formatBytes(storage.quota) : t('unknown', 'unknown') }
        ]
      },
      {
        id: 'capabilities',
        name: t('section_capabilities', 'Capabilities'),
        rows: CAPABILITIES.map(function (c) {
          return { id: c[0], label: c[1], value: c[2]({ win: win, nav: nav, scr: scr }) ? t('yes', 'yes') : t('no', 'no') };
        })
      }
    ];

    return sections;
  }

  function getTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; }
  }

  /**
   * 本机相对 UTC 的偏移，单位是分钟，**向东为正**。
   *
   * `Date.getTimezoneOffset()` 返回的恰恰相反 —— 它是「落后 UTC 的分钟数」，
   * 东八区给的是 -480。直接把它写成 "-480 minutes" 极易误读（看着像西十二区），
   * 所以这里取反。
   * @returns {?number} 取不到时返回 null
   */
  function utcOffsetMinutes() {
    try {
      var m = new Date().getTimezoneOffset();
      return typeof m === 'number' && isFinite(m) ? -m : null;
    } catch (e) { return null; }
  }

  /**
   * 把偏移分钟数写成 `UTC+08:00` 这种样子 —— 与 date_time_converter 的
   * `offset_label()` 同一个约定（那边也是手写的，没用 `%:z`）。
   * @param {?number} minutes 向东为正的分钟数
   */
  function utcOffsetLabelFromMinutes(minutes) {
    if (minutes === null || minutes === undefined || !isFinite(minutes)) return t('unknown', 'unknown');
    var sign = minutes < 0 ? '-' : '+';
    var abs = Math.abs(Math.round(minutes));
    var h = Math.floor(abs / 60);
    var m = abs % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'UTC' + sign + pad(h) + ':' + pad(m);
  }

  /** 本机时区偏移的完整标签，例如 `UTC+08:00`。 */
  function utcOffsetLabel() {
    return utcOffsetLabelFromMinutes(utcOffsetMinutes());
  }

  function formatBytes(n) {
    if (!isFinite(n) || n < 0) return t('unknown', 'unknown');
    var units = ['B', 'kB', 'MB', 'GB', 'TB'];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? String(v) : v.toFixed(2)) + ' ' + units[i];
  }

  window.ItTools.register('device-information', function (root) {
    var env = readEnv(window);
    // host 本身是「设备信息」这一整块面板，所以它得是张卡片：
    // .tool-content 的直属子元素各自就是一块面板，裸 div 会被当成无边框的面板。
    var host = D.h('div.card');
    var unlisteners = [];   // destroy 时逐个调用，页面来回切也不会漏
    var disposed = false;

    function render() {
      D.clear(host);
      snapshot(env).forEach(function (section) {
        var tbody = D.h('tbody');
        section.rows.forEach(function (row) {
          tbody.appendChild(D.h('tr', null,
            D.h('th', { text: row.label }),
            D.h('td.val', { text: row.value })
          ));
        });
        host.appendChild(D.h('div', { style: { marginBottom: '20px' } },
          D.h('h3', { text: section.name, style: { margin: '0 0 12px', fontSize: '16px' } }),
          D.h('table.kv-table', null,
            D.h('thead', null, D.h('tr', null, D.h('th', { text: t('col_property', 'Property') }), D.h('th', { text: t('col_value', 'Value') }))),
            tbody
          )
        ));
      });
      host.appendChild(D.h('div.form-actions', null,
        U.copyButton(function () {
          return snapshot(env).map(function (s) {
            return '## ' + s.name + '\n' +
              s.rows.map(function (r) { return '- ' + r.label + ': ' + r.value; }).join('\n');
          }).join('\n\n');
        }, t('copy_as_markdown', 'Copy as markdown')),
        D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('refresh', 'Refresh'), onclick: render })
      ));
    }

    function listen(target, ev, fn) {
      if (!target || typeof target.addEventListener !== 'function') return;
      D.on(target, ev, fn);
      unlisteners.push(function () {
        target.removeEventListener(ev, fn);
      });
    }

    /* 窗口尺寸 / 屏幕方向 / 网络状态变化后重绘 */
    listen(window, 'resize', render);
    listen(window, 'orientationchange', render);
    listen(window, 'online', render);
    listen(window, 'offline', render);
    /* 摄像头麦克风插拔 */
    listen(env.nav.mediaDevices, 'devicechange', render);

    /* 电池与存储配额是异步 API：拿到后再补一次渲染。
       disposed 拦住「组件已卸载但 Promise 才 resolve」的迟到回调。 */
    if (typeof env.nav.getBattery === 'function') {
      Promise.resolve().then(function () { return env.nav.getBattery(); })
        .then(function (b) {
          if (disposed || !b) return;
          env.battery = { level: b.level, charging: b.charging };
          render();
        })['catch'](function () { /* 隐私模式下拿不到就算了 */ });
    }
    if (env.nav.storage && typeof env.nav.storage.estimate === 'function') {
      Promise.resolve().then(function () { return env.nav.storage.estimate(); })
        .then(function (s) {
          if (disposed || !s) return;
          env.storage = s;
          render();
        })['catch'](function () { /* 同上 */ });
    }

    root.appendChild(host);
    render();

    return {
      destroy: function () {
        disposed = true;
        unlisteners.forEach(function (off) { off(); });
        unlisteners = [];
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['device-information'] = {
    snapshot: snapshot,
    formatBytes: formatBytes,
    utcOffsetMinutes: utcOffsetMinutes,
    utcOffsetLabel: utcOffsetLabel,
    utcOffsetLabelFromMinutes: utcOffsetLabelFromMinutes,
    __cases: function (assert) {
      // 一个最小可用环境：只给用得到的字段，其余全是 undefined。
      var env = {
        win: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2, screenX: 0, screenY: 0 },
        nav: { vendor: 'Acme', platform: 'Linux', userAgent: 'UA/1.0', languages: ['zh-CN', 'en'], onLine: true, cookieEnabled: true },
        scr: { availWidth: 1920, availHeight: 1040, width: 1920, height: 1080, colorDepth: 24, orientation: { type: 'landscape-primary', angle: 0 } }
      };
      // label 现在是翻译过的显示名，断言一律按稳定的 id 查
      var byName = {};
      snapshot(env).forEach(function (s) {
        byName[s.id] = {};
        s.rows.forEach(function (r) { byName[s.id][r.id] = r.value; });
      });

      assert.eq(byName.screen.screen_size, '1920 x 1040', '屏幕可用尺寸');
      assert.eq(byName.screen.full_resolution, '1920 x 1080', '屏幕完整分辨率');
      assert.eq(byName.screen.orientation, 'landscape-primary', '屏幕方向');
      assert.eq(byName.screen.orientation_angle, '0°', '屏幕方向角带度数符号');
      assert.eq(byName.screen.color_depth, '24 bits', '色深带单位');
      assert.eq(byName.screen.pixel_ratio, '2 dppx', '像素比带单位');
      assert.eq(byName.screen.window_size, '800 x 600', '窗口尺寸跟着 resize 变');

      assert.eq(byName.device.browser_vendor, 'Acme', '厂商');
      assert.eq(byName.device.languages, 'zh-CN, en', '语言列表逗号分隔');
      assert.eq(byName.device.hardware_concurrency, t('unknown', 'unknown'), '缺失字段显示 unknown');
      assert.eq(byName.device.online, t('yes', 'yes'), '在线状态');
      assert.eq(byName.device.do_not_track, t('not_set', 'not set'), '未设置 DNT');
      assert.eq(byName.device.cookies_enabled, t('yes', 'yes'), 'cookie 开关');

      // 异步数据到位后同一批行被就地填上
      env.battery = { level: 0.42, charging: true };
      env.storage = { usage: 1024 * 1024 * 3, quota: 1024 * 1024 * 1024 };
      var runtime = {};
      snapshot(env)[2].rows.forEach(function (r) { runtime[r.id] = r.value; });
      assert.eq(runtime.battery_level, '42%', '电量百分比取整');
      assert.eq(runtime.charging, t('yes', 'yes'), '充电中');
      assert.eq(runtime.storage_used, '3.00 MB', '已用存储');
      assert.eq(runtime.storage_quota, '1.00 GB', '配额');

      // 整个环境都是空壳时不能抛，且每个分区都要有内容
      var empty = snapshot({ win: {}, nav: {}, scr: {} });
      assert.eq(empty.length, 4, '固定四个分区');
      empty.forEach(function (s) {
        assert(s.rows.length > 0, s.id + ' 分区不能是空的');
        s.rows.forEach(function (r) { assert(typeof r.value === 'string' && r.value.length > 0, '每行都要有可显示的值'); });
      });

      assert.eq(formatBytes(512), '512 B', '字节不换算');
      assert.eq(formatBytes(1536), '1.50 kB', 'kB');
      assert.eq(formatBytes(-1), t('unknown', 'unknown'), '负数兜底');

      // UTC 偏移（上游 #1385）：向东为正，写成 ±HH:MM
      assert.eq(utcOffsetLabelFromMinutes(480), 'UTC+08:00', '东八区');
      assert.eq(utcOffsetLabelFromMinutes(-330), 'UTC-05:30', '美东夏令时');
      assert.eq(utcOffsetLabelFromMinutes(0), 'UTC+00:00', 'UTC 本地');
      assert.eq(utcOffsetLabelFromMinutes(345), 'UTC+05:45', '尼泊尔是 45 分钟');
      assert.eq(utcOffsetLabelFromMinutes(-570), 'UTC-09:30', '西九区三十');
      assert.eq(utcOffsetLabelFromMinutes(null), t('unknown', 'unknown'), '取不到就是 unknown');
      // getTimezoneOffset 给的是「落后 UTC 的分钟数」，这里必须取反
      var offset = utcOffsetMinutes();
      assert(offset === null || (offset >= -840 && offset <= 840), '偏移落在合法的 ±14 小时里');
      assert(/^UTC[+-]\d{2}:\d{2}$/.test(utcOffsetLabel()), '标签格式');
    }
  };
})();