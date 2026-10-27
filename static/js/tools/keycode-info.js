/* ==========================================================================
   键码查询（keycode-info）

   监听 keydown / keyup，把 KeyboardEvent 的关键字段摊平出来，并保留最近
   按下的一串键。

   参考实现：src/tools/keycode-info/（it-tools, GPLv3）
   与原版的差别：
   1. 原版只监听 keydown，字段里也就没有「按下 / 松开」的状态；这里同时监听
      keyup，key 松开后卡片会淡出提示，两条监听都在 destroy 里摘掉。
   2. 原版的 Location 直接打印数字。这里补上 DOM Level 3 的
      standard / left / right / numpad 语义。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('keycode-info');

  var HISTORY_LIMIT = 12;

  /** DOM Level 3 的 key.location 语义。 */
  function locationOf(loc) {
    switch (loc) {
      case 0: return t('location_standard', 'standard (0)');
      case 1: return t('location_left', 'left (1)');
      case 2: return t('location_right', 'right (2)');
      case 3: return t('location_numpad', 'numpad (3)');
      default: return String(loc == null ? '' : loc);
    }
  }

  /** 组合键列表，顺序与参考实现一致：Meta / Shift / Ctrl / Alt。 */
  function modifiersOf(evt) {
    return [
      evt.metaKey && 'Meta',
      evt.shiftKey && 'Shift',
      evt.ctrlKey && 'Ctrl',
      evt.altKey && 'Alt'
    ].filter(Boolean).join(' + ');
  }

  function val(v) {
    return v === null || v === undefined || v === '' ? t('unknown', 'unknown') : String(v);
  }

  /**
   * 把一个 KeyboardEvent 摊成若干行。纯函数，方便单测。
   *
   * label 是界面上的显示名，走 i18n；id 是稳定的内部标识（不随语言变），
   * 断言按 id 查值 —— 见 __cases 里的 rows。
   *
   * 注意：键名本身（evt.key）与修饰键名（Meta / Shift / Ctrl / Alt）是数据，不翻译。
   * @param {KeyboardEvent} evt
   * @param {'down'|'up'} state
   */
  function describe(evt, state) {
    return [
      { id: 'key', label: t('key', 'Key :'), value: val(evt.key) },
      { id: 'keycode', label: t('keycode', 'Keycode :'), value: evt.keyCode ? String(evt.keyCode) : t('unknown', 'unknown') },
      { id: 'code', label: t('code', 'Code :'), value: val(evt.code) },
      { id: 'location', label: t('location', 'Location :'), value: evt.location ? locationOf(evt.location) : locationOf(0) },
      { id: 'modifiers', label: t('modifiers', 'Modifiers :'), value: modifiersOf(evt) || t('none', 'None') },
      { id: 'repeat', label: t('repeat', 'Repeat :'), value: evt.repeat ? t('value_yes', 'yes') : t('value_no', 'no') },
      { id: 'composing', label: t('composing', 'Composing :'), value: evt.isComposing ? t('value_yes', 'yes') : t('value_no', 'no') },
      { id: 'state', label: t('state', 'State :'), value: state === 'up' ? t('released', 'released') : t('pressed', 'pressed') }
    ];
  }

  /** 历史项的展示串，纯函数便于单测。 */
  function historyText(item) {
    var mods = modifiersOf(item);
    return (mods ? mods + ' + ' : '') + val(item.key) + '  ·  ' + val(item.code);
  }

  window.ItTools.register('keycode-info', function (root) {
    var fields = D.h('div');
    var bigKey = D.h('div', { style: { fontSize: '30px', minHeight: '38px', fontWeight: '600' } });
    var stateBadge = D.h('span.badge-note', { text: t('waiting', 'waiting…') });
    var history = [];        // 最新在前
    var historyBox = D.h('div');
    var releaseTimer = null; // 松开后提示语的复位定时器

    function renderRows(rows) {
      D.clear(fields);
      if (!rows) return;
      rows.forEach(function (row) {
        var input = D.h('input.layui-input', { type: 'text', readonly: true, value: row.value });
        fields.appendChild(D.h('div.field-row', null,
          D.h('label.field-label', { for: 'kc-' + row.id, text: row.label }),
          input,
          U.copyButton(function () { return input.value; })
        ));
      });
    }

    function renderHistory() {
      D.clear(historyBox);
      if (!history.length) {
        historyBox.appendChild(D.h('p.field-hint', { text: t('hint_nothing_pressed', 'Nothing pressed yet.') }));
        return;
      }
      var box = D.h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } });
      history.forEach(function (item) {
        box.appendChild(D.h('span.badge-note', { text: historyText(item) }));
      });
      historyBox.appendChild(box);
    }

    function onKey(evt, state) {
      // 任何一次按键都会取消「已松开」的复位定时器，避免提示语停在错误状态
      if (releaseTimer) { window.clearTimeout(releaseTimer); releaseTimer = null; }

      bigKey.textContent = val(evt.key);
      stateBadge.textContent = state === 'up' ? t('released', 'released') : t('pressed', 'pressed');
      renderRows(describe(evt, state));

      if (state === 'down') {
        history.unshift({ key: evt.key, code: evt.code, metaKey: evt.metaKey, shiftKey: evt.shiftKey, ctrlKey: evt.ctrlKey, altKey: evt.altKey });
        history = history.slice(0, HISTORY_LIMIT);
        renderHistory();
      }
      if (state === 'up') {
        releaseTimer = window.setTimeout(function () {
          releaseTimer = null;
          stateBadge.textContent = t('waiting', 'waiting…');
        }, 900);
      }
    }

    var onKeyDown = function (evt) { onKey(evt, 'down'); };
    var onKeyUp = function (evt) { onKey(evt, 'up'); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    root.appendChild(D.h('div.card', {
      style: { textAlign: 'center', padding: '28px 16px', marginBottom: '16px' }
    }, bigKey, D.h('p.field-hint', {
      text: t('hint_press_key', 'Press the key on your keyboard you want to get info about this key')
    }),
    // 按钮条待在这张卡里：直接挂到 root 上会被 flex 拆成独立面板
    D.h('div.form-actions', null,
      stateBadge,
      D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button', text: t('clear_history', 'Clear history'), onclick: function () { history = []; renderHistory(); }
      })
    )));
    root.appendChild(D.h('div.card', null, fields));
    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('recent_keys', 'Recent keys'), style: { margin: '0 0 10px', fontSize: '16px' } }),
      historyBox
    ));
    renderHistory();

    return {
      destroy: function () {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        if (releaseTimer) { window.clearTimeout(releaseTimer); releaseTimer = null; }
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['keycode-info'] = {
    describe: describe,
    modifiersOf: modifiersOf,
    locationOf: locationOf,
    historyText: historyText,
    __cases: function (assert) {
      assert.eq(modifiersOf({ metaKey: true, shiftKey: false, ctrlKey: false, altKey: false }), 'Meta', '单个修饰键');
      assert.eq(modifiersOf({ metaKey: true, shiftKey: true, ctrlKey: true, altKey: true }), 'Meta + Shift + Ctrl + Alt', '四个修饰键按 Meta/Shift/Ctrl/Alt 排序');
      assert.eq(modifiersOf({}), '', '无修饰键返回空串（显示层再兜成 None）');

      assert.eq(locationOf(0), t('location_standard', 'standard (0)'), '标准键位');
      assert.eq(locationOf(1), t('location_left', 'left (1)'), '左 Shift / 左 Ctrl');
      assert.eq(locationOf(2), t('location_right', 'right (2)'), '右 Shift / 右 Ctrl');
      assert.eq(locationOf(3), t('location_numpad', 'numpad (3)'), '小键盘');

      // label 现在是翻译过的显示名，断言一律按稳定的 id 查
      var evt = { key: 'A', keyCode: 65, code: 'KeyA', location: 0, shiftKey: true, repeat: false, isComposing: false };
      var rows = {};
      describe(evt, 'down').forEach(function (r) { rows[r.id] = r.value; });
      assert.eq(rows.key, 'A', '键名');
      assert.eq(rows.keycode, '65', 'keyCode 转字符串');
      assert.eq(rows.code, 'KeyA', 'code');
      assert.eq(rows.location, t('location_standard', 'standard (0)'), '键位');
      assert.eq(rows.modifiers, 'Shift', '修饰键');
      assert.eq(rows.repeat, t('value_no', 'no'), '长按标记');
      assert.eq(rows.state, t('pressed', 'pressed'), '按下状态');
      assert.eq(describe(evt, 'up')[7].value, t('released', 'released'), '松开状态');
      assert.eq(describe({ key: '' }, 'down')[0].value, t('unknown', 'unknown'), '空键名兜底');
      assert.eq(describe({ key: 'x', keyCode: 0 }, 'down')[1].value, t('unknown', 'unknown'), 'keyCode 为 0 时兜底');

      assert.eq(historyText({ key: 'K', code: 'KeyK' }), 'K  ·  KeyK', '历史项展示');
      assert.eq(historyText({ key: 's', code: 'KeyS', metaKey: true }), 'Meta + s  ·  KeyS', '历史项带修饰键');
    }
  };
})();