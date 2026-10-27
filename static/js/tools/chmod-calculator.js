/* ==========================================================================
   chmod 权限计算器（chmod-calculator）

   rwx 三组九宫格 + setuid / setgid / sticky 三个特殊位，
   八进制（3~4 位）与符号表示（9~12 位）双向互转，最后拼出 chmod 命令。

   参考实现：src/tools/chmod-calculator/（it-tools, GPLv3）
   与原版的差别：原版只有 9 个勾选框，八进制固定 3 位、符号固定 9 位，
   完全没有 setuid(4)/setgid(2)/sticky(1)，也没有反向解析（不能从 755 或
   rwxr-xr-x 推回勾选状态）。这里补上特殊位与两个方向的解析，
   符号位按 ls 的惯例渲染：特殊位占掉它所在那一组的可执行位，可执行写小写 s/t、
   不可执行写大写 S/T。原版的 computeOctal / computeSymbolic 接口与返回值保持不变。

   另外补了上游 #645 / #964 的两处：
   1. 符号输入框能直接吃 `ls -l` 的输出 —— 前面那个文件类型字符（- d l b c p s）
      会被剥掉，末尾的 ACL/SELinux 标记（+ .）也会。
   2. umask 表示：当前权限对应哪个 umask（755 → 022），反过来也能输入 umask
      看它作用在 666 / 777 上是什么结果。符号写法遵循 GNU `umask -S` 的约定：
      列出的是**没有被屏蔽**的位。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('chmod-calculator');

  var GROUPS = [
    { key: 'owner', title: 'Owner (u)' },
    { key: 'group', title: 'Group (g)' },
    { key: 'public', title: 'Other (o)' }
  ];

  var SCOPES = [
    { key: 'read', title: 'Read', octal: 4, letter: 'r' },
    { key: 'write', title: 'Write', octal: 2, letter: 'w' },
    { key: 'execute', title: 'Execute', octal: 1, letter: 'x' }
  ];

  var SPECIALS = [
    { key: 'setuid', title: 'setuid', octal: 4, letter: 's' },
    { key: 'setgid', title: 'setgid', octal: 2, letter: 's' },
    { key: 'sticky', title: 'sticky', octal: 1, letter: 't' }
  ];

  /**
   * 界面上的显示名走 i18n。
   * GROUPS / SCOPES / SPECIALS 里的 title 是数据（也会被导出给测试用），不动；
   * 这里另开一份显示名，界面用它渲染。
   */
  var GROUP_TITLES = {
    owner: t('group_owner', 'Owner (u)'),
    group: t('group_group', 'Group (g)'),
    public: t('group_public', 'Other (o)')
  };

  var SCOPE_TITLES = {
    read: t('scope_read', 'Read'),
    write: t('scope_write', 'Write'),
    execute: t('scope_execute', 'Execute')
  };

  var SPECIAL_TITLES = {
    setuid: t('special_setuid', 'setuid'),
    setgid: t('special_setgid', 'setgid'),
    sticky: t('special_sticky', 'sticky')
  };

  /**
   * `ls -l` 输出最前面那个文件类型字符：- 普通文件、d 目录、l 符号链接，
   * b/c 块设备与字符设备、p 命名管道、s 套接字。有些系统还会在最前面放个 ?。
   */
  var LS_TYPE_CHARS = '-dlbcps?';

  /** `ls -l` 输出末尾的标记：+ 表示有 ACL，. 表示有 SELinux 标签（macOS）。 */
  var LS_TRAILING_CHARS = '+.';

  /** 全空的权限状态 */
  function emptyState() {
    return {
      permissions: {
        owner: { read: false, write: false, execute: false },
        group: { read: false, write: false, execute: false },
        public: { read: false, write: false, execute: false }
      },
      special: { setuid: false, setgid: false, sticky: false }
    };
  }

  /** 一组权限的八进制值（0~7） */
  function groupOctal(group) {
    return (group.read ? 4 : 0) + (group.write ? 2 : 0) + (group.execute ? 1 : 0);
  }

  /** 一组权限的符号写法（rwx，缺省位是 -） */
  function groupSymbolic(group) {
    return (group.read ? 'r' : '-') + (group.write ? 'w' : '-') + (group.execute ? 'x' : '-');
  }

  /**
   * 八进制（3 位，不含特殊位）。接口与参考实现一致。
   * @param {{permissions: object}} state
   */
  function computeOctal(state) {
    return GROUPS.map(function (g) { return String(groupOctal(state.permissions[g.key])); }).join('');
  }

  /**
   * 符号表示（9 位，不含特殊位）。接口与参考实现一致。
   * @param {{permissions: object}} state
   */
  function computeSymbolic(state) {
    return GROUPS.map(function (g) { return groupSymbolic(state.permissions[g.key]); }).join('');
  }

  /** 特殊位折成一位八进制（0~7），没有特殊位时返回 0 */
  function computeSpecialDigit(state) {
    return SPECIALS.reduce(function (acc, s) { return acc + (state.special[s.key] ? s.octal : 0); }, 0);
  }

  /** 完整八进制：4 位（首位是特殊位），例如 4755 */
  function computeFullOctal(state) {
    return String(computeSpecialDigit(state)) + computeOctal(state);
  }

  /**
   * 完整符号表示：固定 9 位，用 ls 的写法 —— 特殊位占掉它所在那一组的可执行位，
   * 可执行 → 小写 s / t，不带可执行 → 大写 S / T。没有特殊位时与原版完全一致。
   */
  function computeFullSymbolic(state) {
    var groups = GROUPS.map(function (g) { return groupSymbolic(state.permissions[g.key]); });
    var marks = {
      owner: state.special.setuid ? 's' : null,
      group: state.special.setgid ? 's' : null,
      public: state.special.sticky ? 't' : null
    };
    GROUPS.forEach(function (g, i) {
      if (!marks[g.key]) return;
      var lower = marks[g.key];
      var upper = lower.toUpperCase();
      groups[i] = groups[i].slice(0, 2) +
        (state.permissions[g.key].execute ? lower : upper);
    });
    return groups.join('');
  }

  /**
   * 解析八进制：3 位（普通）或 4 位（首位是特殊位）。非法返回 null。
   * @returns {?object}
   */
  function parseOctal(str) {
    var s = String(str == null ? '' : str).trim();
    if (!/^[0-7]{3,4}$/.test(s)) return null;
    var digits = s.split('');
    var state = emptyState();
    if (digits.length === 4) {
      var special = Number(digits.shift());
      SPECIALS.forEach(function (sp) { state.special[sp.key] = (special & sp.octal) !== 0; });
    }
    GROUPS.forEach(function (g, i) {
      var value = Number(digits[i]);
      SCOPES.forEach(function (sc) {
        state.permissions[g.key][sc.key] = (value & sc.octal) !== 0;
      });
    });
    return state;
  }

  /**
   * 剥掉 `ls -l` 输出的装饰：末尾的 ACL/SELinux 标记（+ .）与开头的文件类型字符。
   *
   * "rwxr-xr-x" 原样返回；"-rwxr-xr-x" → "rwxr-xr-x"；"drwxr-xr-x." → "rwxr-xr-x"。
   * 长度不对的（既不是 9 位也不是 10 位）原样返回，交给调用方判非法。
   */
  function stripLsAffixes(s) {
    var out = s;
    // 末尾标记：只有 9/10 位时才可能是装饰，长度不对的一律当非法输入
    while (out.length > 9 && LS_TRAILING_CHARS.indexOf(out.charAt(out.length - 1)) >= 0) {
      out = out.slice(0, out.length - 1);
    }
    if (out.length === 10 && LS_TYPE_CHARS.indexOf(out.charAt(0)) >= 0) {
      out = out.slice(1);
    }
    return out;
  }

  /**
   * 解析符号写法：固定 9 位，用 ls 的写法 —— 特殊位占掉它所在那一组的可执行位，
   * 大写 S/T 表示「特殊位生效但没有可执行位」，小写 s/t 表示两者都有。
   * 也接受 `ls -l` 的输出（多一个开头的文件类型字符）。非法返回 null。
   * @returns {?object}
   */
  function parseSymbolic(str) {
    var s = stripLsAffixes(String(str == null ? '' : str).trim());
    if (s.length !== 9) return null;
    if (!/^[r-][w-][xsS-]$/.test(s.slice(0, 3))) return null;
    if (!/^[r-][w-][xsS-]$/.test(s.slice(3, 6))) return null;
    if (!/^[r-][w-][xtT-]$/.test(s.slice(6, 9))) return null;

    var state = emptyState();
    GROUPS.forEach(function (g, i) {
      var triple = s.slice(i * 3, i * 3 + 3);
      var x = triple.charAt(2);
      state.permissions[g.key].read = triple.charAt(0) === 'r';
      state.permissions[g.key].write = triple.charAt(1) === 'w';
      state.permissions[g.key].execute = x === 'x' || x === 's' || x === 't';
    });
    state.special.setuid = s.charAt(2) === 's' || s.charAt(2) === 'S';
    state.special.setgid = s.charAt(5) === 's' || s.charAt(5) === 'S';
    state.special.sticky = s.charAt(8) === 't' || s.charAt(8) === 'T';
    return state;
  }

  /**
   * 符号写法 → 八进制数字（上游 #645 的同名接口）。
   *
   * 沿用上游的口径：返回的是**八进制那串数字本身**，当成十进制数读 ——
   * 'rwxr-xr-x' 得到 755（而不是它真正的数值 493）。这样显示出来的
   * 就是人习惯写的那串八进制，特殊位也一起算上（rwsr-xr-x → 4755）。
   * 接受 9 位与 `ls -l` 的 10 位；解析不了返回 null。
   * @returns {?number}
   */
  function symbolicToOctal(str) {
    var state = parseSymbolic(str);
    if (!state) return null;
    return parseInt(computeFullOctal(state), 10);
  }

  /**
   * 当前权限对应的 umask（上游 #964）。
   *
   * umask 是「要屏蔽掉的位」，所以它就是权限位按位取反（777 - 权限）：
   * 755 对应 umask 022，644 对应 umask 133。
   *
   * 符号写法遵循 GNU `umask -S` 的约定：列出的是**没有被屏蔽**的位
   * （也就是权限本身），不写横杠，全屏蔽的组写成空串。
   * @returns {{octal: string, symbolic: string}}
   */
  function computeUmask(state) {
    var perm = parseInt(computeOctal(state), 8);
    var mask = 511 - perm; // 0o777 - 权限
    var octal = ('00' + mask.toString(8)).slice(-3);
    var letters = function (group) {
      var s = '';
      if (group.read) s += 'r';
      if (group.write) s += 'w';
      if (group.execute) s += 'x';
      return s;
    };
    var symbolic = 'umask u=' + letters(state.permissions.owner) +
      ',g=' + letters(state.permissions.group) +
      ',o=' + letters(state.permissions.public);
    return { octal: octal, symbolic: symbolic };
  }

  /**
   * 解析 umask。
   *
   * 八进制写法：022 / 22 / 0022 都收（只有低 3 位有意义）。
   * 符号写法：u=...,g=...,o=...。带横杠的（u=---,g=-w-,o=-w-）按「被屏蔽的位」理解；
   * 不带横杠的（GNU `umask -S` 的写法 u=rwx,g=rx,o=rx）按「没被屏蔽的位」理解。
   * 解析不了返回 null。
   * @returns {?number} 0~0o777 的掩码
   */
  function parseUmask(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s.length) return null;
    if (/^[0-7]{1,4}$/.test(s)) return parseInt(s, 8) & 511;

    var m = s.match(/^(?:u|g|o)\s*=.*$/);
    if (!m) return null;
    var digits = { u: null, g: null, o: null };
    var ok = true;
    s.split(',').forEach(function (part) {
      var kv = part.trim().match(/^([ugo])\s*=\s*([rwx-]*)$/);
      if (!kv) { ok = false; return; }
      var who = kv[1];
      var spec = kv[2];
      var value = 0;
      for (var i = 0; i < spec.length; i++) {
        var ch = spec.charAt(i);
        if (ch === 'r') value += 4;
        else if (ch === 'w') value += 2;
        else if (ch === 'x') value += 1;
      }
      // 带横杠 → 列出的是被屏蔽的位；不带横杠 → 列出的是没被屏蔽的位
      if (spec.indexOf('-') < 0) value = 7 - value;
      digits[who] = value;
    });
    if (!ok || digits.u === null || digits.g === null || digits.o === null) return null;
    return ((digits.u * 8 + digits.g) * 8 + digits.o) & 511;
  }

  /**
   * 把 umask 作用在基础模式上，得到实际生效的权限。
   * @param {number} mask umask（要屏蔽掉的位）
   * @param {number} base  基础模式（普通文件 0o666，目录 0o777）
   * @returns {object} 权限状态
   */
  function applyUmask(mask, base) {
    var mode = base & ~mask & 511;
    return parseOctal(('00' + mode.toString(8)).slice(-3));
  }

  /** 拼出可复制的 chmod 命令 */
  function buildCommand(state, path) {
    return 'chmod ' + computeFullOctal(state) + ' ' + (path || 'path/to/file');
  }

  window.ItTools.register('chmod-calculator', function (root) {
    var state = emptyState();

    /** group -> scope -> checkbox */
    var boxes = {};
    GROUPS.forEach(function (g) {
      boxes[g.key] = {};
      SCOPES.forEach(function (sc) { boxes[g.key][sc.key] = null; });
    });

    var octalInput = D.h('input.layui-input', { type: 'text', value: '000', spellcheck: 'false' });
    var symbolicInput = D.h('input.layui-input', { type: 'text', value: '---------', spellcheck: 'false' });
    var pathInput = D.h('input.layui-input', { type: 'text', value: 'path/to/file', spellcheck: 'false' });
    var commandInput = D.h('input.layui-input', { type: 'text', readonly: true });
    var hint = D.h('p.field-hint');

    // umask 卡片
    var umaskOctal = D.h('input.layui-input', { type: 'text', readonly: true });
    var umaskSymbolic = D.h('input.layui-input', { type: 'text', readonly: true });
    var umaskInput = D.h('input.layui-input', { type: 'text', value: '022', spellcheck: 'false' });
    var umaskFile = D.h('input.layui-input', { type: 'text', readonly: true });
    var umaskDir = D.h('input.layui-input', { type: 'text', readonly: true });
    var umaskHint = D.h('p.field-hint');

    function showError(message) {
      hint.textContent = message;
      hint.style.color = message ? '#d03050' : '';
    }

    /** 把 state 同步到所有勾选框 */
    function syncBoxes() {
      GROUPS.forEach(function (g) {
        SCOPES.forEach(function (sc) {
          if (boxes[g.key][sc.key]) boxes[g.key][sc.key].checked = !!state.permissions[g.key][sc.key];
        });
      });
      SPECIALS.forEach(function (sp) {
        boxes[sp.key].checked = !!state.special[sp.key];
      });
    }

    /**
     * 刷新显示。skip 是用户当前正在输入的那一栏，避免边打字边被覆盖。
     * @param {string=} skip 'octal' | 'symbolic'
     */
    function render(skip) {
      if (skip !== 'octal') octalInput.value = computeFullOctal(state);
      if (skip !== 'symbolic') symbolicInput.value = computeFullSymbolic(state);
      commandInput.value = buildCommand(state, pathInput.value.trim());
      renderUmask();
    }

    /** 刷新 umask 卡片：当前权限对应的 umask，以及用户输入的 umask 的效果 */
    function renderUmask() {
      var umask = computeUmask(state);
      umaskOctal.value = umask.octal;
      umaskSymbolic.value = umask.symbolic;

      var mask = parseUmask(umaskInput.value);
      if (mask === null) {
        umaskFile.value = '';
        umaskDir.value = '';
        umaskHint.textContent = t('umask_invalid', 'umask must be octal (e.g. 022) or symbolic (e.g. u=rwx,g=rx,o=rx).');
        umaskHint.style.color = '#d03050';
        return;
      }
      umaskHint.textContent = '';
      umaskHint.style.color = '';
      var file = applyUmask(mask, 438); // 0o666
      var dir = applyUmask(mask, 511);  // 0o777
      umaskFile.value = computeOctal(file) + '  ' + computeSymbolic(file);
      umaskDir.value = computeOctal(dir) + '  ' + computeSymbolic(dir);
    }

    /** 权限表 */
    var table = D.h('table.result-table', null,
      D.h('thead', null, D.h('tr', null,
        D.h('th'),
        GROUPS.map(function (g) { return D.h('th', { text: GROUP_TITLES[g.key] }); })
      )),
      D.h('tbody', null, SCOPES.map(function (sc) {
        return D.h('tr', null,
          D.h('td', null, D.h('strong', { text: SCOPE_TITLES[sc.key] + ' (' + sc.octal + ')' })),
          GROUPS.map(function (g) {
            var box = D.h('input', { type: 'checkbox', 'aria-label': GROUP_TITLES[g.key] + ' ' + SCOPE_TITLES[sc.key] });
            box.checked = false;
            box.addEventListener('change', function () {
              state.permissions[g.key][sc.key] = box.checked;
              showError('');
              render();
            });
            boxes[g.key][sc.key] = box;
            return D.h('td', null, box);
          })
        );
      }))
    );

    /** 特殊位开关 */
    var specialToggles = SPECIALS.map(function (sp) {
      var box = D.h('input', { type: 'checkbox' });
      boxes[sp.key] = box;
      box.addEventListener('change', function () {
        state.special[sp.key] = box.checked;
        showError('');
        render();
      });
      return D.h('label.switch', null, box,
        D.h('span', { text: SPECIAL_TITLES[sp.key] + ' (' + sp.octal + ')' }));
    });

    octalInput.addEventListener('input', function () {
      var parsed = parseOctal(octalInput.value);
      if (!parsed) {
        showError(t('octal_invalid', 'Octal must be 3 or 4 digits of 0~7, e.g. 755 or 4755.'));
        return;
      }
      showError('');
      state = parsed;
      syncBoxes();
      render('octal');
    });

    symbolicInput.addEventListener('input', function () {
      var parsed = parseSymbolic(symbolicInput.value);
      if (!parsed) {
        showError(t('symbolic_invalid', 'The symbolic form must be 9 characters, e.g. rwxr-xr-x or rwsr-xr-t, using only r w x s t - and the uppercase S T; you can also paste the output of ls -l (-rwxr-xr-x).'));
        return;
      }
      showError('');
      state = parsed;
      syncBoxes();
      render('symbolic');
    });

    umaskInput.addEventListener('input', function () { renderUmask(); });

    pathInput.addEventListener('input', function () { render(); });

    function labelled(text, control) {
      return D.h('div.field-row', null, D.h('label.field-label', { text: text }), control);
    }

    root.appendChild(D.h('div.card', null, table));

    root.appendChild(D.h('div.card', null,
      D.h('div.switch-grid', null, specialToggles),
      labelled(t('octal', 'Octal'), octalInput),
      labelled(t('symbolic', 'Symbolic'), symbolicInput),
      hint,
      labelled(t('path', 'Path'), pathInput),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('command', 'Command') }),
        commandInput,
        U.copyButton(function () { return commandInput.value; })
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('p.field-hint', {
        text: t('umask_hint', 'umask is "the bits to be masked out", i.e. the current permissions bitwise inverted (777 - permissions).')
      }),
      labelled(t('umask_current', 'umask (current permissions)'), umaskOctal),
      labelled(t('umask_symbolic', 'umask -S'), umaskSymbolic),
      labelled(t('umask_input', 'Enter a umask'), umaskInput),
      labelled(t('file_666', 'Regular file 666'), umaskFile),
      labelled(t('dir_777', 'Directory 777'), umaskDir),
      umaskHint
    ));

    render();
    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['chmod-calculator'] = {
    GROUPS: GROUPS,
    SCOPES: SCOPES,
    SPECIALS: SPECIALS,
    emptyState: emptyState,
    computeOctal: computeOctal,
    computeSymbolic: computeSymbolic,
    computeSpecialDigit: computeSpecialDigit,
    computeFullOctal: computeFullOctal,
    computeFullSymbolic: computeFullSymbolic,
    parseOctal: parseOctal,
    parseSymbolic: parseSymbolic,
    stripLsAffixes: stripLsAffixes,
    symbolicToOctal: symbolicToOctal,
    computeUmask: computeUmask,
    parseUmask: parseUmask,
    applyUmask: applyUmask,
    buildCommand: buildCommand,
    __cases: function (assert) {
      /** 用简写造一个状态：o/g/p 三组各一个字符串，如 'rwx' */
      function state(octal, special) {
        var s = emptyState();
        if (special) {
          SPECIALS.forEach(function (sp) { s.special[sp.key] = (special & sp.octal) !== 0; });
        }
        var digits = String(octal);
        GROUPS.forEach(function (g, i) {
          var value = Number(digits.charAt(i));
          SCOPES.forEach(function (sc) { s.permissions[g.key][sc.key] = (value & sc.octal) !== 0; });
        });
        return s;
      }

      // 与参考实现 vitest 用例一致的三位八进制
      assert.eq(computeOctal(state('777')), '777', '全开');
      assert.eq(computeOctal(state('000')), '000', '全关');
      assert.eq(computeOctal(state('235')), '235', '-w- rwx r-x');
      assert.eq(computeOctal(state('421')), '421', 'r-- -w- --x');
      assert.eq(computeOctal(state('124')), '124', '--x -w- r--');
      assert.eq(computeOctal(state('222')), '222', '-w- -w- -w-');

      // 与参考实现 vitest 用例一致的九位符号
      assert.eq(computeSymbolic(state('777')), 'rwxrwxrwx', '全开');
      assert.eq(computeSymbolic(state('000')), '---------', '全关');
      assert.eq(computeSymbolic(state('235')), '-w--wxr-x', '-w- rwx r-x');
      assert.eq(computeSymbolic(state('421')), 'r---w---x', 'r-- -w- --x');
      assert.eq(computeSymbolic(state('124')), '--x-w-r--', '--x -w- r--');
      assert.eq(computeSymbolic(state('222')), '-w--w--w-', '-w- -w- -w-');

      // 特殊位
      assert.eq(computeSpecialDigit(state('777', 0)), 0, '没有特殊位');
      assert.eq(computeSpecialDigit(state('777', 4)), 4, 'setuid');
      assert.eq(computeSpecialDigit(state('777', 2)), 2, 'setgid');
      assert.eq(computeSpecialDigit(state('777', 1)), 1, 'sticky');
      assert.eq(computeSpecialDigit(state('777', 7)), 7, '三个都要');
      assert.eq(computeFullOctal(state('755', 4)), '4755', 'setuid + 755');
      assert.eq(computeFullOctal(state('644', 0)), '0644', '没有特殊位也补零');
      assert.eq(computeFullSymbolic(state('755', 0)), 'rwxr-xr-x', '没有特殊位就是普通九位');
      assert.eq(computeFullSymbolic(state('755', 4)), 'rwsr-xr-x', 'setuid 且可执行 → 小写 s');
      assert.eq(computeFullSymbolic(state('644', 4)), 'rwSr--r--', 'setuid 但不可执行 → 大写 S');
      assert.eq(computeFullSymbolic(state('777', 2)), 'rwxrwsrwx', 'setgid → 组那一组');
      assert.eq(computeFullSymbolic(state('777', 1)), 'rwxrwxrwt', 'sticky → other 那一组');
      assert.eq(computeFullSymbolic(state('777', 7)), 'rwsrwsrwt', '三个特殊位');
      assert.eq(computeFullSymbolic(state('111', 7)).length, 9, '特殊位不额外占位，仍是 9 位');

      // 八进制解析
      assert.eq(parseOctal('755').permissions.owner.write, true, '755 的 owner 可写');
      assert.eq(parseOctal('644').permissions.group.execute, false, '644 的 group 不可执行');
      assert.eq(computeFullOctal(parseOctal('4755')), '4755', '4755 往返');
      assert.eq(computeFullOctal(parseOctal('755')), '0755', '3 位补成 4 位');
      assert.eq(parseOctal('4755').special.setuid, true, '4755 有 setuid');
      assert.eq(parseOctal('2755').special.setgid, true, '2755 有 setgid');
      assert.eq(parseOctal('1755').special.sticky, true, '1755 有 sticky');
      assert.eq(parseOctal(''), null, '空串非法');
      assert.eq(parseOctal('77777'), null, '5 位非法');
      assert(computeFullOctal(parseOctal('7777')) === '7777', '4 位全 7 = 三个特殊位 + rwxrwxrwx');
      assert.eq(parseOctal('888'), null, '8 不是八进制');
      assert.eq(parseOctal('rwx'), null, '符号写法不是八进制');
      assert.eq(parseOctal('75'), null, '2 位非法');

      // 符号解析
      assert.eq(parseSymbolic('rwxr-xr-x').permissions.owner.execute, true, 'rwx 的 x');
      assert.eq(computeFullSymbolic(parseSymbolic('rwxr-xr-x')), 'rwxr-xr-x', '9 位往返');
      assert.eq(computeFullSymbolic(parseSymbolic('rwsr-xr-x')), 'rwsr-xr-x', '带特殊位往返');
      assert.eq(computeFullSymbolic(parseSymbolic('rwSr--r--')), 'rwSr--r--', '大写 S 往返');
      assert.eq(parseSymbolic('rwsr-xr-x').special.setuid, true, 's → setuid');
      assert.eq(parseSymbolic('rwSr--r--').special.setuid, true, 'S → setuid');
      assert.eq(parseSymbolic('rwSr--r--').permissions.owner.execute, false, 'S 意味着没有可执行');
      assert.eq(parseSymbolic('rwsr-xr-x').permissions.owner.execute, true, 's 意味着可执行');
      assert.eq(parseSymbolic('rwxrwsrwx').special.setgid, true, 's 在组 → setgid');
      assert.eq(parseSymbolic('rwxrwxrwt').special.sticky, true, 't 在 other → sticky');
      assert.eq(parseSymbolic('rwxrwx--T').permissions.public.execute, false, 'T 意味着没有可执行');
      assert.eq(parseSymbolic('rwxrwx--T').special.sticky, true, 'T 也是 sticky');
      assert.eq(computeFullSymbolic(state('000', 1)), '--------T', '全关 + sticky → 大写 T 落在 other 组');
      assert.eq(computeFullSymbolic(state('000', 2)), '-----S---', '全关 + setgid → 大写 S 落在 group 组');
      assert.eq(computeFullSymbolic(state('000', 4)), '--S------', '全关 + setuid → 大写 S 落在 owner 组的可执行位');
      assert.eq(parseSymbolic(''), null, '空串非法');
      assert.eq(parseSymbolic('rwxr-xr'), null, '8 位非法');
      assert.eq(parseSymbolic('rwxrwxrwxq'), null, '10 位非法');
      assert.eq(parseSymbolic('rwxrwxrwz'), null, 'z 不是合法字符');
      assert.eq(parseSymbolic('rwtr-xr-x'), null, 't 不能出现在 owner 位');

      // 两个方向对同一个状态必须给出同一个答案
      ['', '1', '7', '64', '755', '4755', '6755', '1777'].forEach(function (octal) {
        var fromOctal = state(octal.slice(-3), Number(octal.charAt(0)) || 0);
        var octalText = computeFullOctal(fromOctal);
        var symbolicText = computeFullSymbolic(fromOctal);
        assert.eq(computeFullOctal(parseSymbolic(symbolicText)), octalText, '符号 → 八进制：' + symbolicText);
        assert.eq(computeFullSymbolic(parseOctal(octalText)), symbolicText, '八进制 → 符号：' + octalText);
      });

      // 512 组 rwx 权限 × 8 种特殊位组合，全量往返一次
      for (var o = 0; o <= 7; o++) {
        for (var g = 0; g <= 7; g++) {
          for (var p = 0; p <= 7; p++) {
            for (var sp = 0; sp <= 7; sp++) {
              var s = state('' + o + g + p, sp);
              var oct = computeFullOctal(s);
              var sym = computeFullSymbolic(s);
              if (computeFullOctal(parseSymbolic(sym)) !== oct || computeFullSymbolic(parseOctal(oct)) !== sym) {
                throw new Error('往返失败：' + oct + ' / ' + sym);
              }
            }
          }
        }
      }
      assert(true, '4096 组权限（含特殊位）双向往返一致');

      assert.eq(buildCommand(state('755', 4), 'script.sh'), 'chmod 4755 script.sh', '命令拼接');
      assert.eq(buildCommand(state('755', 0), ''), 'chmod 0755 path/to/file', '空路径用默认占位');

      // ls -l 的输出（上游 #645）：前面那个文件类型字符要能直接吃
      assert.eq(computeFullOctal(parseSymbolic('-rwxr-xr-x')), '0755', 'ls -l 普通文件');
      assert.eq(computeFullOctal(parseSymbolic('drwxr-xr-x')), '0755', 'ls -l 目录');
      assert.eq(computeFullOctal(parseSymbolic('lrwxrwxrwx')), '0777', 'ls -l 符号链接');
      assert.eq(computeFullOctal(parseSymbolic('brwxrwxrwx')), '0777', 'ls -l 块设备');
      assert.eq(computeFullOctal(parseSymbolic('crwxrwxrwx')), '0777', 'ls -l 字符设备');
      assert.eq(computeFullOctal(parseSymbolic('srwxrwxrwx')), '0777', 'ls -l 套接字');
      assert.eq(computeFullOctal(parseSymbolic('prwxrwxrwx')), '0777', 'ls -l 命名管道');
      assert.eq(computeFullOctal(parseSymbolic('-rw-r--r--')), '0644', 'ls -l 644');
      assert.eq(computeFullOctal(parseSymbolic('-rwxrwxrwx+')), '0777', 'ls -l 末尾的 ACL 标记 +');
      assert.eq(computeFullOctal(parseSymbolic('-rwxr-xr-x.')), '0755', 'ls -l 末尾的 SELinux 标记 .');
      assert.eq(computeFullOctal(parseSymbolic('rwxr-xr-x')), '0755', '没有类型字符的 9 位照旧');
      assert.eq(parseSymbolic('xrwxr-xr-x'), null, 'x 不是文件类型字符');
      assert.eq(parseSymbolic('-rwxr-xr-'), null, '剥掉类型字符后不足 9 位');
      assert.eq(parseSymbolic('-rwxr-xr-xx'), null, '剥掉类型字符后多一位');

      // symbolicToOctal：与上游 #645 的用例一致
      assert.eq(symbolicToOctal('rwxrwxrwx'), 777, '全开');
      assert.eq(symbolicToOctal('drwxrwxrwx'), 777, '带类型字符');
      assert.eq(symbolicToOctal('-rwxrwxrwx'), 777, '带类型字符');
      assert.eq(symbolicToOctal('lrwxrwxrwx'), 777, '带类型字符');
      assert.eq(symbolicToOctal('rwxr-xr-x'), 755, '755');
      assert.eq(symbolicToOctal('drwxr-xr-x'), 755, '755 带类型字符');
      assert.eq(symbolicToOctal('-rw-r--r--'), 644, '644');
      assert.eq(symbolicToOctal('rwx------'), 700, '700');
      assert.eq(symbolicToOctal('rw-rw-r--'), 664, '664');
      assert.eq(symbolicToOctal('r-xr-xr-x'), 555, '555');
      assert.eq(symbolicToOctal('---------'), 0, '全关');
      assert.eq(symbolicToOctal('d---------'), 0, '全关带类型字符');
      assert.eq(symbolicToOctal('----------'), 0, '全关带类型字符');
      assert.eq(symbolicToOctal('rwsr-xr-x'), 4755, 'setuid 也算进去');
      assert.eq(symbolicToOctal('rwxrwxrwt'), 1777, 'sticky 也算进去');
      assert.eq(symbolicToOctal('rwxr-xr'), null, '解析不了返回 null');

      // umask（上游 #964）：当前权限对应的 umask
      assert.eq(computeUmask(state('755')).octal, '022', '755 → umask 022');
      assert.eq(computeUmask(state('755')).symbolic, 'umask u=rwx,g=rx,o=rx', '755 的 umask -S 写法');
      assert.eq(computeUmask(state('644')).octal, '133', '644 → umask 133');
      assert.eq(computeUmask(state('644')).symbolic, 'umask u=rw,g=r,o=r', '644 的 umask -S 写法');
      assert.eq(computeUmask(state('000')).octal, '777', '000 → umask 777');
      assert.eq(computeUmask(state('000')).symbolic, 'umask u=,g=,o=', '全屏蔽的组写空串');
      assert.eq(computeUmask(state('777')).octal, '000', '777 → umask 000');
      assert.eq(computeUmask(state('777')).symbolic, 'umask u=rwx,g=rwx,o=rwx', '777 的 umask -S 写法');

      // umask 解析：八进制与符号两种写法
      assert.eq(parseUmask('022'), 18, '八进制 umask');
      assert.eq(parseUmask('22'), 18, '少写一个前导零');
      assert.eq(parseUmask('0022'), 18, '多写一个前导零');
      assert.eq(parseUmask('0'), 0, '单个 0');
      assert.eq(parseUmask('u=rwx,g=rx,o=rx'), 18, 'GNU umask -S 写法（列出没被屏蔽的位）');
      assert.eq(parseUmask('u=---,g=-w-,o=-w-'), 18, '列出被屏蔽的位');
      assert.eq(parseUmask('u=rwx,g=rwx,o=rwx'), 0, '什么都不屏蔽');
      assert.eq(parseUmask('u=,g=,o='), 511, '全屏蔽');
      assert.eq(parseUmask(''), null, '空串非法');
      assert.eq(parseUmask('abc'), null, '非数字非法');
      assert.eq(parseUmask('888'), null, '8 不是八进制');
      assert.eq(parseUmask('u=rwx'), null, '三组缺两组非法');
      assert.eq(parseUmask('x=rw'), null, '不认识的关键字');

      // umask 作用在基础模式上
      assert.eq(computeOctal(applyUmask(0, 438)), '666', 'umask 000 → 文件 666');
      assert.eq(computeOctal(applyUmask(0, 511)), '777', 'umask 000 → 目录 777');
      assert.eq(computeOctal(applyUmask(18, 438)), '644', 'umask 022 → 文件 644');
      assert.eq(computeOctal(applyUmask(18, 511)), '755', 'umask 022 → 目录 755');
      assert.eq(computeOctal(applyUmask(63, 438)), '600', 'umask 077 → 文件 600');
      assert.eq(computeOctal(applyUmask(63, 511)), '700', 'umask 077 → 目录 700');
      assert.eq(computeOctal(applyUmask(2, 438)), '664', 'umask 002 → 文件 664');
      assert.eq(computeOctal(applyUmask(511, 511)), '000', 'umask 777 → 目录 000');

      // umask 与权限互为反数：777 & ~umask 必须回到原权限
      for (var p = 0; p <= 777; p++) {
        var oct = ('00' + p.toString(8)).slice(-3);
        var s2 = state(oct);
        var mask = parseInt(computeUmask(s2).octal, 8);
        if (computeOctal(applyUmask(mask, 511)) !== oct) {
          throw new Error('umask 往返失败：' + oct);
        }
      }
      assert(true, '512 组权限的 umask 往返一致');
    }
  };
})();