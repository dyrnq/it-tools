/* ==========================================================================
   密码强度分析器（password-strength-analyser）

   参考实现：src/tools/password-strength-analyser/（it-tools, GPLv3）

   ⚠ 重要：这是一个**简化版**的启发式评估器，不是 zxcvbn。
   参考实现（it-tools）的 UI 文案提到「zxcvbn 风格打分」，但它的
   password-strength-analyser.service.ts 其实也只是一套
   `log2(字符集大小) × 长度` 的暴力破解估算，并没有真正引入 zxcvbn。
   本文件在此基础上补了几样 zxcvbn 会做的事，但都只是启发式近似：

     1. 字符集大小（小写 26 / 大写 26 / 数字 10 / 符号 32），与参考实现一致；
     2. 逐字符熵 = log2(字符集) × 长度，再减去「可猜模式」折掉的字符数：
        重复串（aaaa）、顺序串（abcd / 9876）、键盘走位（qwerty）、
        常见弱口令（password / 123456 …）、年份（1980~2035）；
     3. 按猜测次数分 0~4 五档（对应 zxcvbn 的 score 语义）；
     4. 给出暴力破解所需时间，允许切换攻击者速度（每秒 10 / 1e4 / 1e9 / 1e12 次）。

   它**不**包含词典攻击模型，也不做字典/用户资料的匹配 —— 页面底部也有这句提示。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('password-strength-analyser');

  /** 攻击者速度档位（次/秒），与参考实现默认的 1e9 对齐。 */
  var ATTACK_SPEEDS = [
    { label: t('speed_throttled', 'Throttled (10/s)'), guessesPerSecond: 1e1 },
    { label: t('speed_unthrottled', 'Unthrottled (1e4/s)'), guessesPerSecond: 1e4 },
    { label: t('speed_fast_hash', 'Fast hash (1e9/s)'), guessesPerSecond: 1e9 },
    { label: t('speed_very_fast', 'Very fast (1e12/s)'), guessesPerSecond: 1e12 }
  ];

  /** 常见弱口令片段（小写后匹配）。命中一次就折掉对应长度。 */
  var COMMON_WORDS = [
    'password', 'passwd', 'qwerty', 'qwertz', 'azerty', 'admin', 'administrator',
    'welcome', 'letmein', 'monkey', 'dragon', 'iloveyou', 'sunshine', 'princess',
    'football', 'baseball', 'master', 'shadow', 'superman', 'batman', 'trustno1',
    'login', 'secret', 'root', 'toor', 'guest', 'user', 'test', 'demo', 'abc',
    'starwars', 'whatever', 'hello', 'freedom', 'love', 'sex', 'god'
  ];

  /** 键盘/数字键盘上的连续走位。 */
  var KEYBOARD_ROWS = [
    'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890',
    '`1234567890-=', '~!@#$%^&*()_+'
  ];

  /** 判定「键盘走位」的最小连续键数。 */
  var KEYBOARD_WINDOW = 4;

  /** 0~4 分档的显示名。id 是稳定标识，界面用 label 渲染。 */
  var SCORE_LABELS = [
    { id: 'score_0', label: t('score_0', 'Very guessable') },
    { id: 'score_1', label: t('score_1', 'Weak') },
    { id: 'score_2', label: t('score_2', 'Somewhat weak') },
    { id: 'score_3', label: t('score_3', 'Safe') },
    { id: 'score_4', label: t('score_4', 'Very safe') }
  ];

  /**
   * 密码用到的字符集大小。与参考实现的 getCharsetLength 完全一致，
   * 它的 vitest 用例也全部保留在 __cases 里。
   */
  function getCharsetLength(password) {
    var str = String(password == null ? '' : password);
    var length = 0;
    if (/[a-z]/.test(str)) length += 26;
    if (/[A-Z]/.test(str)) length += 26;
    if (/\d/.test(str)) length += 10;
    if (/\W|_/.test(str)) length += 32;
    return length;
  }

  /**
   * 找出密码里「可猜」的部分，每条返回扣掉的字符数。
   * 这是简化版 zxcvbn 的核心：模式越长越固定，实际熵越低。
   * @returns {Array<{id:string, label:string, chars:number}>}
   */
  function findWeakPatterns(password) {
    var str = String(password == null ? '' : password);
    var lower = str.toLowerCase();
    var found = [];

    // 1. 同一字符连续出现 3 次及以上（aaaa / 111111）
    var rep = /(.)(\1){2,}/g;
    var m;
    while ((m = rep.exec(str)) !== null) {
      found.push({ id: 'repeated', label: t('pattern_repeated', 'Repeated characters'), chars: m[0].length });
    }

    // 2. 字母/数字顺序串，正序反序都算（abcd / dcba / 1234 / 9876）
    for (var step = 1; step <= 2; step++) {
      [1, -1].forEach(function (dir) {
        for (var i = 0; i + 2 * step < str.length; i++) {
          var a = str.charCodeAt(i);
          var b = str.charCodeAt(i + step);
          var c = str.charCodeAt(i + 2 * step);
          var inRange = (a >= 48 && a <= 57) || (a >= 65 && a <= 90) || (a >= 97 && a <= 122);
          if (inRange && b === a + dir * step && c === a + 2 * dir * step) {
            found.push({ id: 'sequential', label: t('pattern_sequential', 'Sequential characters'), chars: 3 });
            return;
          }
        }
      });
    }

    // 3. 键盘走位（qwerty / asdfgh 片段）。逐个 4 键窗口找，
//    顺带也认反向走位（qwer 倒着打成的 trew）。
    var windows = {};
    KEYBOARD_ROWS.forEach(function (row) {
      var rev = row.split('').reverse().join('');
      [row, rev].forEach(function (r) {
        for (var k = 0; k + KEYBOARD_WINDOW <= r.length; k++) {
          windows[r.substr(k, KEYBOARD_WINDOW)] = true;
        }
      });
    });
    var keys = Object.keys(windows);
    for (var k2 = 0; k2 + KEYBOARD_WINDOW <= lower.length; k2++) {
      if (windows[lower.substr(k2, KEYBOARD_WINDOW)]) {
        found.push({ id: 'keyboard', label: t('pattern_keyboard', 'Keyboard pattern'), chars: 8 });
        break;
      }
    }

    // 4. 常见弱口令
    COMMON_WORDS.forEach(function (word) {
      if (lower.indexOf(word) !== -1) found.push({ id: 'common_word', label: t('pattern_common_word', 'Common password word'), chars: word.length });
    });

    // 5. 4 位年份
    if (/(19|20)\d{2}/.test(str)) found.push({ id: 'year', label: t('pattern_year', 'Year-like number'), chars: 4 });

    return found;
  }

  /** 弱模式一共折掉多少字符。最多扣掉密码长度的 2/3，免得长密码被一刀砍死。 */
  function deductedChars(patterns, passwordLength) {
    var total = patterns.reduce(function (n, p) { return n + p.chars; }, 0);
    return Math.min(total, Math.ceil(passwordLength * 2 / 3));
  }

  /** 指数记数法美化：1234 -> "1,234"；1e21 -> "1e21"。 */
  function prettifyExponentialNotation(value) {
    var parts = String(value).toLowerCase().split('e');
    var base = parseFloat(parts[0]);
    var exponent = parts[1];
    var prettyBase = base % 1 === 0 ? base.toLocaleString('en-US') : base.toFixed(2);
    return exponent ? prettyBase + 'e' + exponent.replace('+', '') : prettyBase;
  }

  /** 把秒数说成人话，取最大的两个单位。 */
  function getHumanFriendlyDuration(seconds) {
    if (seconds <= 0.001) return t('duration_instantly', 'Instantly');
    if (seconds <= 1) return t('duration_less_than_second', 'Less than a second');

    var timeUnits = [
      { unit: t('unit_millennium', 'millenium'), plural: t('unit_millennia', 'millennia'), secondsInUnit: 31536000000, format: prettifyExponentialNotation },
      { unit: t('unit_century', 'century'), plural: t('unit_centuries', 'centuries'), secondsInUnit: 3153600000 },
      { unit: t('unit_decade', 'decade'), plural: t('unit_decades', 'decades'), secondsInUnit: 315360000 },
      { unit: t('unit_year', 'year'), plural: t('unit_years', 'years'), secondsInUnit: 31536000 },
      { unit: t('unit_month', 'month'), plural: t('unit_months', 'months'), secondsInUnit: 2592000 },
      { unit: t('unit_week', 'week'), plural: t('unit_weeks', 'weeks'), secondsInUnit: 604800 },
      { unit: t('unit_day', 'day'), plural: t('unit_days', 'days'), secondsInUnit: 86400 },
      { unit: t('unit_hour', 'hour'), plural: t('unit_hours', 'hours'), secondsInUnit: 3600 },
      { unit: t('unit_minute', 'minute'), plural: t('unit_minutes', 'minutes'), secondsInUnit: 60 },
      { unit: t('unit_second', 'second'), plural: t('unit_seconds', 'seconds'), secondsInUnit: 1 }
    ];

    var rest = seconds;
    var parts = [];
    for (var i = 0; i < timeUnits.length && parts.length < 2; i++) {
      var unit = timeUnits[i];
      var quantity = Math.floor(rest / unit.secondsInUnit);
      rest %= unit.secondsInUnit;
      if (quantity <= 0) continue;
      var formatted = unit.format ? unit.format(quantity) : quantity.toLocaleString('en-US');
      parts.push(t('duration_part', '{n} {unit}').replace('{n}', formatted).replace('{unit}', quantity > 1 ? unit.plural : unit.unit));
    }
    return parts.join(', ');
  }

  /** 猜测次数 -> 0~4 分。分档边界参照 zxcvbn 的 score 语义。 */
  function scoreOf(guesses) {
    if (guesses < 1e3) return 0;
    if (guesses < 1e6) return 1;
    if (guesses < 1e8) return 2;
    if (guesses < 1e10) return 3;
    return 4;
  }

  /**
   * 主入口。
   * @param {string} password
   * @param {{guessesPerSecond?:number}} [opts]
   */
  function analyse(password, opts) {
    var str = String(password == null ? '' : password);
    var guessesPerSecond = (opts && opts.guessesPerSecond) || 1e9;

    var charsetLength = getCharsetLength(str);
    var passwordLength = str.length;
    var patterns = findWeakPatterns(str);
    var deducted = passwordLength ? deductedChars(patterns, passwordLength) : 0;
    // 空字符集（密码里全是没法归类的字符）兜底成 1，log2 才不会是 -Infinity
    var effectiveLength = passwordLength ? Math.max(1, passwordLength - deducted) : 0;

    // 参考实现的口径：熵 = log2(字符集) × 长度；这里把长度换成「扣掉弱模式后」的长度
    var entropy = charsetLength > 0 && passwordLength > 0
      ? Math.log(charsetLength) / Math.LN2 * effectiveLength
      : 0;
    var guesses = Math.pow(2, entropy);
    var secondsToCrack = guesses / guessesPerSecond;
    var score = passwordLength ? scoreOf(guesses) : 0;

    return {
      passwordLength: passwordLength,
      charsetLength: charsetLength,
      effectiveLength: effectiveLength,
      deductedChars: deducted,
      patterns: patterns,
      entropy: entropy,
      guesses: guesses,
      guessesPerSecond: guessesPerSecond,
      secondsToCrack: secondsToCrack,
      crackDurationFormatted: getHumanFriendlyDuration(secondsToCrack),
      score: score,
      scoreId: SCORE_LABELS[score].id,
      scoreLabel: SCORE_LABELS[score].label
    };
  }

  /** 保持与参考实现同名同参，方便对照。 */
  function getPasswordCrackTimeEstimation(args) {
    args = args || {};
    var result = analyse(args.password, { guessesPerSecond: args.guessesPerSecond });
    return {
      entropy: result.entropy,
      charsetLength: result.charsetLength,
      passwordLength: result.passwordLength,
      crackDurationFormatted: result.crackDurationFormatted,
      secondsToCrack: result.secondsToCrack,
      // 参考实现的 score 是 0~1 的归一化值，这里保留它，同时另给一个 0~4 的整数分
      score: Math.min(result.entropy / 128, 1),
      grade: result.score,
      gradeId: result.scoreId,
      gradeLabel: result.scoreLabel,
      patterns: result.patterns
    };
  }

  window.ItTools.register('password-strength-analyser', function (root) {
    var passwordGroup = U.passwordInput({ placeholder: t('input_ph', 'Enter a password...') });
    var password = passwordGroup.querySelector('input');
    password.setAttribute('autofocus', 'autofocus');

    var speedSelect = D.h('select.layui-input', null,
      ATTACK_SPEEDS.map(function (s, i) {
        return D.h('option', { value: String(s.guessesPerSecond), text: s.label, selected: i === 2 });
      })
    );

    var durationBox = D.h('div.preview-box', null,
      D.h('div', { style: { textAlign: 'center' } },
        D.h('div.field-hint', { text: t('crack_duration', 'Duration to crack this password with brute force') }),
        D.h('strong', { style: { fontSize: '22px' } })
      )
    );
    var durationText = durationBox.querySelector('strong');

    var detailsBox = D.h('table.kv-table', null, D.h('tbody'));
    var patternsBox = D.h('div');

    function detailRow(label, value) {
      return D.h('tr', null,
        D.h('th', { text: label }),
        D.h('td.val', { text: String(value) })
      );
    }

    function render() {
      var result = analyse(password.value, { guessesPerSecond: Number(speedSelect.value) });
      durationText.textContent = result.crackDurationFormatted;

      D.clear(detailsBox);
      [
        [t('password_length', 'Password length:'), result.passwordLength],
        [t('charset_size', 'Character set size:'), result.charsetLength],
        [t('entropy_bits', 'Entropy (bits):'), Math.round(result.entropy * 100) / 100],
        [t('guesses_needed', 'Guesses needed:'), prettifyExponentialNotation(result.guesses)],
        [t('score', 'Score:'), t('score_value', '{n} / 100　({label})')
          .replace('{n}', String(Math.round(result.score / 4 * 100)))
          .replace('{label}', result.scoreLabel)]
      ].forEach(function (pair) {
        detailsBox.appendChild(detailRow(pair[0], pair[1]));
      });
      detailsBox.appendChild(D.h('tr', null,
        D.h('th', { text: t('raw_guesses_needed', 'Raw guesses needed:') }),
        D.h('td.val', null, D.h('span', { text: prettifyExponentialNotation(result.guesses) }),
          U.copyButton(function () { return result.guesses.toExponential(3); }))
      ));

      D.clear(patternsBox);
      if (!result.patterns.length) {
        patternsBox.appendChild(D.h('p.field-hint', { text: t('no_weak_patterns', 'No common guessable pattern detected.') }));
      } else {
        patternsBox.appendChild(D.h('div.switch-grid', null,
          result.patterns.map(function (p) {
            return D.h('span.badge-note', {
              text: t('pattern_badge', '{label} (−{n})').replace('{label}', p.label).replace('{n}', String(p.chars))
            });
          })
        ));
        patternsBox.appendChild(D.h('p.field-hint', {
          text: t('deducted_note', 'Deducted {n} characters of effective length ({from} → {to}).')
            .replace('{n}', String(result.deductedChars))
            .replace('{from}', String(result.passwordLength))
            .replace('{to}', String(result.effectiveLength))
        }));
      }
    }

    password.addEventListener('input', render);
    speedSelect.addEventListener('change', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('password', 'Password'), passwordGroup, { wide: true }),
      U.field(t('attacker_speed', 'Attacker speed'), speedSelect, {
        hint: t('attacker_speed_hint', 'Upper bound of the speed of an offline brute force against a common hash.')
      })
    ));

    root.appendChild(D.h('div.card', null, durationBox, detailsBox));

    root.appendChild(D.h('div.card', null,
      D.h('span.badge-note', { text: t('heuristic_badge', 'Heuristic simplified version, not zxcvbn') }),
      D.h('p.field-hint', {
        text: t('note', 'Note: the score comes from the character set size and the length, and subtracts guessable patterns such as repetitions, sequences, keyboard walks and common weak words; it does not include a dictionary attack model and does not match against dictionaries or user profiles, so the score can only be taken as a lower bound.')
      }),
      patternsBox
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['password-strength-analyser'] = {
    getCharsetLength: getCharsetLength,
    getPasswordCrackTimeEstimation: getPasswordCrackTimeEstimation,
    findWeakPatterns: findWeakPatterns,
    analyse: analyse,
    getHumanFriendlyDuration: getHumanFriendlyDuration,
    prettifyExponentialNotation: prettifyExponentialNotation,
    __cases: function (assert) {
      // ---- 字符集大小：与参考实现的 vitest 用例逐条对齐 ----
      assert.eq(getCharsetLength('abcdefghijklmnopqrstuvwxyz'), 26, '纯小写 = 26');
      assert.eq(getCharsetLength('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 26, '纯大写 = 26');
      assert.eq(getCharsetLength('0123456789'), 10, '纯数字 = 10');
      assert.eq(getCharsetLength('-_('), 32, '纯特殊字符 = 32');
      assert.eq(getCharsetLength(''), 0, '空串 = 0');
      assert.eq(getCharsetLength('abcdefghijklmnopqrstuvwxyz0123456789'), 36, '小写 + 数字 = 36');
      assert.eq(getCharsetLength('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_('), 94, '全字符集 = 94');

      // ---- 弱模式检测 ----
      assert(findWeakPatterns('aaaaaaaa').some(function (p) { return p.id === 'repeated'; }), '检出重复字符');
      assert(findWeakPatterns('abcdef').some(function (p) { return p.id === 'sequential'; }), '检出正序串');
      assert(findWeakPatterns('dcba').some(function (p) { return p.id === 'sequential'; }), '检出反序串');
      assert(findWeakPatterns('qwertyui').some(function (p) { return p.id === 'keyboard'; }), '检出键盘走位');
      assert(findWeakPatterns('mypassword1').some(function (p) { return p.id === 'common_word'; }), '检出常见弱口令');
      assert(findWeakPatterns('summer1990').some(function (p) { return p.id === 'year'; }), '检出年份');
      assert.eq(findWeakPatterns('x7#qLz2!Rv9$mB8@pW4&hF6*jD3%'), [], '随机强密码不该有可猜模式');

      // ---- 强度递增 ----
      var weak = analyse('123456');
      var mid = analyse('Tr0ub4dor&3');
      var strong = analyse('x7#qLz2!Rv9$mB8@pW4&hF6*jD3%');
      assert(weak.score <= 1, '123456 应很低分，实际 ' + weak.score);
      assert(mid.score >= 2, 'Tr0ub4dor&3 至少 2 分，实际 ' + mid.score);
      assert.eq(strong.score, 4, '22 位随机强密码应满分');
      assert(strong.entropy > mid.entropy, '熵应随长度增长');
      assert(strong.crackDurationFormatted !== weak.crackDurationFormatted, '破解时间描述应不同');

      // 弱模式确实压低了分数：同样的字符集，顺序串应比随机串弱
      var seq = analyse('abcdefghijklmnop');
      var rnd = analyse('hjkmnpqrvwxzlya');
      assert(seq.entropy < rnd.entropy, '顺序串熵应低于随机串');

      // 空串
      var empty = analyse('');
      assert.eq(empty.entropy, 0, '空串熵为 0');
      assert.eq(empty.score, 0, '空串 0 分');
      assert.eq(empty.crackDurationFormatted, 'Instantly', '空串瞬间破解');
      assert.eq(empty.scoreId, 'score_0', '0 分档的 id 是 score_0');

      // 攻击速度越快破解时间越短
      assert(analyse('abcdefghijklmnop', { guessesPerSecond: 1e12 }).secondsToCrack
        < analyse('abcdefghijklmnop', { guessesPerSecond: 1e1 }).secondsToCrack, '快机器破解更快');

      // ---- 时长格式化 ----
      assert.eq(getHumanFriendlyDuration(0.0005), 'Instantly', '极短叫 instantly');
      assert.eq(getHumanFriendlyDuration(0.5), 'Less than a second', '一秒内');
      assert.eq(getHumanFriendlyDuration(60), '1 minute', '60 秒');
      assert.eq(getHumanFriendlyDuration(7200), '2 hours', '2 小时');
      assert.eq(getHumanFriendlyDuration(31536000 * 3), '3 years', '3 年');
      assert(/millen/i.test(getHumanFriendlyDuration(31536000000 * 5)), '超大单位叫 millennium');
      assert.eq(prettifyExponentialNotation(1234), '1,234', '千分位');
      assert.eq(prettifyExponentialNotation(1e21), '1e21', '科学记数法');

      // ---- 与参考实现同名函数的口径 ----
      var est = getPasswordCrackTimeEstimation({ password: 'Tr0ub4dor&3' });
      assert.eq(est.passwordLength, 11, '长度');
      assert.eq(est.charsetLength, 94, '字符集 94');
      assert(est.entropy > 0, '熵大于 0');
      assert(est.score >= 0 && est.score <= 1, '归一化 score 在 0~1');
      assert(est.grade >= 0 && est.grade <= 4, 'grade 在 0~4');
    }
  };
})();