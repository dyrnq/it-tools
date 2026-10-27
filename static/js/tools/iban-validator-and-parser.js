/* ==========================================================================
   IBAN 校验与解析（iban-validator-and-parser）

   输入一串 IBAN，输出合法性、错误原因、国家、BBAN、校验位、各种排版形式，
   以及该国 BBAN 的字段结构（也就是「账号长什么样」）。

   参考实现：src/tools/iban-validator-and-parser/（it-tools, GPLv3）
   与原版的差别：
   · 原版的错误码 → 文案映射表（iban-validator-and-parser.service.ts）照抄了过来。
   · 原版只给 6 项。这里补了校验位、electronic（无空格）形式、BBAN 字段结构、
     期望长度与 SEPA / IBAN registry 标记 —— 这些都能从 ibantools 自带的
     countrySpecs 推出来，不引入新数据源。
   · ⚠ 关键坑：`validateIBAN` 是按**字符位置**切片的，给它带空格的串会得到
     WrongBBANLength + WrongBBANFormat + WrongIBANChecksum 三个假错误
     （`isValidIBAN('GB82 WEST …')` 直接返回 false 就是这个原因）。
     所以这里先统一 sanitize（大写 + 去掉空格和连字符）再喂给库。
   · `composeIBAN({countryCode, bban})` 收的是**对象**，不是两个位置参数；
     本工具用不上（只解析不组装），但顺手包了一个 composeIban 以备后用。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('iban-validator-and-parser');

  /** 错误码 → 人话。键是 ibantools.ValidationErrorsIBAN 的数值，与参考实现一致。 */
  var ERROR_MESSAGES = {
    0: t('err_no_iban', 'No IBAN provided'),
    1: t('err_no_country', 'No IBAN country'),
    2: t('err_wrong_bban_length', 'Wrong BBAN length'),
    3: t('err_wrong_bban_format', 'Wrong BBAN format'),
    4: t('err_checksum_not_number', 'Checksum is not a number'),
    5: t('err_wrong_iban_checksum', 'Wrong IBAN checksum'),
    6: t('err_wrong_branch_checksum', 'Wrong account bank branch checksum'),
    7: t('err_qr_iban_not_allowed', 'QR-IBAN not allowed')
  };

  /** 参考实现给的三个示例。 */

  var EXAMPLES = [
    'FR7630006000011234567890189',
    'DE89370400440532013000',
    'GB29NWBK60161331926819'
  ];

  var CHAR_CLASS_LABELS = {
    '0-9': t('cls_digits', 'digits'),
    'A-Z': t('cls_uppercase_letters', 'uppercase letters'),
    'A-Z0-9': t('cls_uppercase_letters_or_digits', 'uppercase letters or digits')
  };

  /**
   * 归一化输入：去空白、去连字符、转大写。
   * 库的校验函数按位置切片，不这么做就会报出三个假错误。
   * @param {string} raw
   * @returns {string} 非字符串返回空串
   */
  function sanitizeIban(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/[\s-]/g, '').toUpperCase();
  }

  /** 错误码数组 → 文案数组。未知码不会把行弄丢。 */
  function friendlyErrors(errorCodes) {
    if (!Array.isArray(errorCodes)) return [];
    return errorCodes.map(function (code) {
      return ERROR_MESSAGES[code] || t('err_unknown_code', 'Unknown error (code {code})')
        .replace('{code}', function () { return String(code); });
    });
  }

  /**
   * 把国家规格里的 BBAN 正则翻译成人话，例如
   * `^[0-9]{8}[0-9]{16}$` → `8 digits + 16 digits`。
   * 这就是「这个国家的账号由哪几段组成」—— 各段长度不同的直接按原样分段，
   * 相邻等长段也不合并（它们在各国是不同字段，合起来反而不准）。
   *
   * @param {string} regexp
   * @returns {string} 解析不了就原样返回
   */
  function describeBbanRegexp(regexp) {
    if (typeof regexp !== 'string' || !regexp) return '';
    var parts = [];
    var re = /\[([^\]]+)\]\{(\d+)\}/g;
    var m;
    while ((m = re.exec(regexp)) !== null) {
      var label = CHAR_CLASS_LABELS[m[1]];
      if (!label) {
        label = t('cls_other', 'characters in [{cls}]')
          .replace('{cls}', function () { return m[1]; });
      }
      parts.push(m[2] + ' ' + label);
    }
    if (!parts.length) return regexp;
    return parts.join(' + ');
  }

  /** 该国的规格（长度 / BBAN 结构 / SEPA / registry），查不到返回 null。 */
  function countrySpec(countryCode) {
    if (!countryCode) return null;
    var specs = window.ibantools.countrySpecs || {};
    var spec = specs[countryCode];
    if (!spec || spec.chars == null) return null;
    return {
      chars: spec.chars,
      bbanRegexp: spec.bban_regexp || '',
      bbanStructure: describeBbanRegexp(spec.bban_regexp),
      sepa: spec.SEPA === true,
      registered: spec.IBANRegistry === true
    };
  }

  /**
   * 组装一个 IBAN（收的是对象，与库一致）。
   * @param {string} countryCode
   * @param {string} bban
   * @returns {string|null} 库在参数不合法时返回 null
   */
  function composeIban(countryCode, bban) {
    return window.ibantools.composeIBAN({ countryCode: countryCode, bban: bban });
  }

  /**
   * 主入口：解析一串 IBAN。
   * @param {string} raw
   * @returns {{raw:string, iban:string, empty:boolean, valid:boolean, errors:string[],
   *            errorCodes:number[], qrIban:boolean, countryCode:string, bban:string,
   *            checkDigits:string, friendly:string, electronic:string,
   *            spec:Object|null, lengthMatches:boolean|undefined}}
   */
  function analyzeIban(raw) {
    var original = typeof raw === 'string' ? raw : '';
    var iban = sanitizeIban(original);
    if (!iban) {
      return {
        raw: original, iban: '', empty: true, valid: false, errors: [], errorCodes: [],
        qrIban: false, countryCode: '', bban: '', checkDigits: '', friendly: '', electronic: '',
        spec: null, lengthMatches: undefined
      };
    }

    var validation = window.ibantools.validateIBAN(iban);
    var extracted = window.ibantools.extractIBAN(iban);
    var countryCode = extracted.countryCode || iban.slice(0, 2);
    var spec = countrySpec(countryCode);

    return {
      raw: original,
      iban: iban,
      empty: false,
      valid: validation.valid === true,
      errorCodes: validation.errorCodes || [],
      errors: friendlyErrors(validation.errorCodes),
      // 库里 isQRIBAN 只对 LI / CH 认，且要求 IID 以 3 开头
      qrIban: window.ibantools.isQRIBAN(iban) === true,
      countryCode: countryCode,
      // extractIBAN 只在整体合法时才给出 bban / countryCode，非法时这两个字段不存在
      bban: extracted.bban || '',
      // IBAN 前 4 位是「国家码 + 两位校验位」，之后才是各国账号
      checkDigits: iban.slice(2, 4),
      friendly: window.ibantools.friendlyFormatIBAN(iban) || '',
      electronic: window.ibantools.electronicFormatIBAN(iban) || '',
      spec: spec,
      lengthMatches: spec ? (iban.length === spec.chars) : undefined
    };
  }

  /**
   * 把分析结果拍平成 [{id, label, value, tone}] 供 UI 直接渲染。
   *
   * label 走 i18n（界面用 label 渲染），id 是稳定的内部标识 —— 断言按 id 查，
   * 不受语言影响。
   */
  function ibanRows(a) {
    var rows = [
      { id: 'is_valid', label: t('row_is_valid', 'Is IBAN valid ?'), value: a.valid ? t('yes', 'Yes') : t('no', 'No'), tone: a.valid ? 'ok' : 'error' },
      { id: 'errors', label: t('row_errors', 'IBAN errors'), value: a.errors.join(', '), tone: a.errors.length ? 'error' : '', hideOnEmpty: true }
    ];
    if (!a.empty) {
      rows.push({ id: 'qr_iban', label: t('row_is_qr', 'Is IBAN a QR-IBAN ?'), value: a.qrIban ? t('yes', 'Yes') : t('no', 'No'), tone: '' });
      rows.push({ id: 'country_code', label: t('row_country_code', 'Country code'), value: a.countryCode || t('na', 'N/A'), tone: '' });
      rows.push({ id: 'bban', label: t('row_bban', 'BBAN'), value: a.bban || t('na', 'N/A'), tone: '' });
      rows.push({ id: 'check_digits', label: t('row_check_digits', 'Check digits'), value: a.checkDigits || t('na', 'N/A'), tone: '' });
      if (a.spec) {
        rows.push({ id: 'bban_structure', label: t('row_bban_structure', 'BBAN structure'), value: a.spec.bbanStructure || t('na', 'N/A'), tone: '' });
        rows.push({
          id: 'iban_length',
          label: t('row_iban_length', 'IBAN length'),
          value: a.iban.length + ' / ' + a.spec.chars + (a.lengthMatches ? '' : t('length_mismatch', ' (length mismatch)')),
          tone: a.lengthMatches ? '' : 'error'
        });
        rows.push({ id: 'sepa', label: t('row_sepa', 'SEPA country'), value: a.spec.sepa ? t('yes', 'Yes') : t('no', 'No'), tone: '' });
        rows.push({ id: 'registry', label: t('row_registry', 'In IBAN registry'), value: a.spec.registered ? t('yes', 'Yes') : t('no', 'No'), tone: '' });
      }
      rows.push({ id: 'friendly', label: t('row_friendly', 'IBAN friendly format'), value: a.friendly, tone: '' });
      rows.push({ id: 'electronic', label: t('row_electronic', 'IBAN electronic format'), value: a.electronic, tone: '' });
    }
    return rows.filter(function (r) { return !(r.hideOnEmpty && !r.value); });
  }

  window.ItTools.register('iban-validator-and-parser', function (root) {
    var input = D.h('input.layui-input', {
      placeholder: t('input_ph', 'Enter an IBAN to check for validity...'),
      spellcheck: 'false', 'aria-label': t('input_aria', 'IBAN')
    });

    var table = D.h('div');
    var hint = D.h('p.field-hint');

    function render() {
      var a = analyzeIban(input.value);
      D.clear(table);
      if (a.empty) {
        hint.textContent = t('hint_empty', 'Paste an IBAN above — spaces and dashes are stripped for you.');
        return;
      }
      var normalizedNote = a.iban !== a.raw.trim()
        ? t('hint_normalized', 'Checked as {iban} (spaces, dashes and case removed).')
          .replace('{iban}', function () { return a.iban; })
        : '';
      hint.textContent = normalizedNote;

      var body = D.h('tbody');
      ibanRows(a).forEach(function (row) {
        body.appendChild(D.h('tr', null,
          D.h('td', { text: row.label }),
          D.h('td.val', {
            text: row.value,
            style: row.tone === 'error' ? { color: 'var(--danger, #d93025)' } : null
          })
        ));
      });
      table.appendChild(D.h('table.kv-table', null, body));
    }

    var exampleRow = D.h('div.form-actions', null, EXAMPLES.map(function (ex) {
      return D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button',
        text: window.ibantools.friendlyFormatIBAN(ex),
        onclick: function () { input.value = ex; render(); }
      });
    }));

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'IBAN'), input, { wide: true }),
      exampleRow,
      hint
    ));

    root.appendChild(D.h('div.card', null, table));
    render();

    return {
      destroy: function () {
        off();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['iban-validator-and-parser'] = {
    ERROR_MESSAGES: ERROR_MESSAGES,
    EXAMPLES: EXAMPLES,
    sanitizeIban: sanitizeIban,
    friendlyErrors: friendlyErrors,
    describeBbanRegexp: describeBbanRegexp,
    countrySpec: countrySpec,
    composeIban: composeIban,
    analyzeIban: analyzeIban,
    ibanRows: ibanRows,
    __cases: function (assert) {
      /* ---- 归一化：这是本工具最关键的一步 ---- */
      assert.eq(sanitizeIban('GB82 WEST 1234 5698 7654 32'), 'GB82WEST12345698765432', '空格被去掉');
      assert.eq(sanitizeIban('de89-3704-0044-0532-0130-00'), 'DE89370400440532013000', '连字符去掉 + 转大写');
      assert.eq(sanitizeIban('DE89370400440532013000'), 'DE89370400440532013000', '已经是干净的不动');
      assert.eq(sanitizeIban(''), '', '空串');
      assert.eq(sanitizeIban(null), '', 'null 不炸');
      assert.eq(sanitizeIban(42), '', '数字不炸');

      /* ---- 合法 IBAN ---- */
      var a = analyzeIban('DE89370400440532013000');
      assert.eq(a.valid, true, '德国 IBAN 合法');
      assert.eq(a.errors, [], '没有错误');
      assert.eq(a.countryCode, 'DE', '国家码');
      assert.eq(a.bban, '370400440532013000', 'BBAN');
      assert.eq(a.checkDigits, '89', '校验位是第 3-4 位');
      assert.eq(a.friendly, 'DE89 3704 0044 0532 0130 00', '友好格式每 4 位一空格');
      assert.eq(a.electronic, 'DE89370400440532013000', 'electronic 形式无空格');
      assert.eq(a.qrIban, false, '不是 QR-IBAN');
      assert.eq(a.spec.chars, 22, '德国 IBAN 共 22 位');
      assert.eq(a.lengthMatches, true, '长度对上');
      assert.eq(a.spec.bbanStructure, '18 digits', '德国账号 = 18 位数字');
      assert.eq(a.spec.sepa, true, '德国属于 SEPA');
      assert.eq(a.spec.registered, true, '德国在 IBAN registry 里');

      // 带空格 / 小写 / 带连字符 —— 归一化之后都要判成合法
      assert.eq(analyzeIban('DE89 3704 0044 0532 0130 00').valid, true, '带空格照样合法');
      assert.eq(analyzeIban('de89370400440532013000').valid, true, '小写照样合法');
      assert.eq(analyzeIban('DE89-3704-0044-0532-0130-00').valid, true, '带连字符照样合法');

      a = analyzeIban('GB29 NWBK 6016 1331 9268 19');
      assert.eq(a.valid, true, '带空格的英国 IBAN 合法');
      assert.eq(a.countryCode, 'GB', '国家码 GB');
      assert.eq(a.bban, 'NWBK60161331926819', 'BBAN');
      assert.eq(a.checkDigits, '29', '校验位');
      assert.eq(a.spec.bbanStructure, '4 uppercase letters + 14 digits', '英国账号 = 4 字母 + 14 数字');

      /* ---- 参考实现给的第一个例子本身就是合法的 ---- */
      a = analyzeIban('FR7630006000011234567890189');
      assert.eq(a.valid, true, 'FR 那个例子其实校验得过');
      assert.eq(a.countryCode, 'FR', '国家码 FR');
      assert.eq(a.bban, '30006000011234567890189', 'BBAN');
      assert.eq(a.spec.bbanStructure, '10 digits + 11 uppercase letters or digits + 2 digits',
        '法国账号 = 银行码 + 账号 + RIB 校验');
      assert.eq(a.errors, [], '合法就不给错误');

      /* ---- 非法输入：逐个错误码 ---- */
      // 这条是参考实现 e2e 里用的，被原样搬过来；它确实是错的
      a = analyzeIban('FR7630006060011234567890189');
      assert.eq(a.valid, false, '参考实现 e2e 里那条 FR 是非法的');
      assert.eq(a.errors, ['Wrong account bank branch checksum', 'Wrong IBAN checksum'],
        '两个错误按库里给出的顺序');
      assert.eq(a.friendly, 'FR76 3000 6060 0112 3456 7890 189', '即使非法也照样能排版');

      /* ---- 本工具最核心的那个坑：不先去空格，库会判错 ----
         同一条英国 IBAN，带空格时库里报三个错误、判无效；去掉空格后完全合法。
         所以 sanitize 不是洁癖，是正确性的一部分。 */
      assert.eq(window.ibantools.isValidIBAN('GB82 WEST 1234 5698 7654 32'), false, '库直接吃带空格的串 → false');
      assert.eq(window.ibantools.isValidIBAN('GB82WEST12345698765432'), true, '库里吃去掉空格的串 → true');
      assert.eq(window.ibantools.validateIBAN('GB82 WEST 1234 5698 7654 32').errorCodes, [2, 3, 5],
        '带空格时库里报的是长度/格式/校验位三个假错误');
      a = analyzeIban('GB82 WEST 1234 5698 7654 32');
      assert.eq(a.valid, true, '本工具先 sanitize，于是判为合法');
      assert.eq(a.errors, [], '没有假错误');
      assert.eq(a.iban, 'GB82WEST12345698765432', '库里看到的是去掉空格的串');
      assert.eq(a.bban, 'WEST12345698765432', 'BBAN');

      a = analyzeIban('XX');
      assert.eq(a.valid, false, '未知国家码');
      assert.eq(a.errors, ['No IBAN country'], 'No IBAN country');
      assert.eq(a.spec, null, '查不到国家规格');
      assert.eq(a.countryCode, 'XX', '国家码只是原样取前两位');

      a = analyzeIban('DE00');
      assert.eq(a.valid, false, '太短的 IBAN');
      assert(a.errors.indexOf('Wrong BBAN length') >= 0, '长度错误：' + a.errors.join(' / '));

      a = analyzeIban('');
      assert.eq(a.empty, true, '空串是 empty 不是 invalid');
      assert.eq(a.valid, false, '空串不算合法');
      assert.eq(a.friendly, '', '空串没有排版结果');
      a = analyzeIban('   ');
      assert.eq(a.empty, true, '纯空白当空');
      a = analyzeIban(null);
      assert.eq(a.empty, true, 'null 不炸');
      a = analyzeIban(undefined);
      assert.eq(a.empty, true, 'undefined 不炸');

      /* ---- 错误码映射 ---- */
      assert.eq(friendlyErrors([0, 5]), ['No IBAN provided', 'Wrong IBAN checksum'], '映射到人话');
      assert.eq(friendlyErrors([]), [], '空数组');
      assert.eq(friendlyErrors(undefined), [], 'undefined 不炸');
      assert.eq(friendlyErrors([99]), ['Unknown error (code 99)'], '未知码不丢行');
      // 参考实现用 .filter(Boolean) 会静默丢掉未知码，这里改成回显码值
      assert(Object.keys(ERROR_MESSAGES).length === 8, '错误码表覆盖 0-7');

      /* ---- BBAN 结构翻译 ---- */
      assert.eq(describeBbanRegexp('^[0-9]{8}[0-9]{16}$'), '8 digits + 16 digits', '两段数字');
      assert.eq(describeBbanRegexp('^[A-Z]{4}[0-9]{14}$'), '4 uppercase letters + 14 digits', '字母 + 数字');
      assert.eq(describeBbanRegexp('^[A-Z]{4}[0-9]{4}[A-Z0-9]{16}$'),
        '4 uppercase letters + 4 digits + 16 uppercase letters or digits', '三段');
      assert.eq(describeBbanRegexp('^[0-9]{23}[A-Z]{1}[A-Z0-9]{1}$'),
        '23 digits + 1 uppercase letters + 1 uppercase letters or digits', '单字符段也照实转');
      assert.eq(describeBbanRegexp('^[0-9]{25}$'), '25 digits', '结尾缺 $ 也能解');
      assert.eq(describeBbanRegexp(''), '', '空串');
      assert.eq(describeBbanRegexp(null), '', 'null 不炸');
      assert.eq(describeBbanRegexp('^[a-z]+$'), '^[a-z]+$', '解不了的正则原样返回');

      /* ---- 国家规格 ---- */
      assert.eq(countrySpec('DE').chars, 22, '德国 22 位');
      assert.eq(countrySpec('XX'), null, '未知国家没有规格');
      assert.eq(countrySpec(''), null, '空国家码没有规格');
      assert.eq(countrySpec(null), null, 'null 没有规格');

      /* ---- QR-IBAN：库里只认 CH / LI 且 IID 以 3 开头 ---- */
      assert.eq(analyzeIban('CH4431999123000889012').qrIban, true, 'CH + IID 31999 → QR-IBAN');
      assert.eq(analyzeIban('LI5731999123000889012').qrIban, true, 'LI + IID 31999 → QR-IBAN');
      assert.eq(analyzeIban('CH1100762011623859574').qrIban, false, 'CH 但 IID 不以 3 开头 → 不是 QR-IBAN');
      assert.eq(analyzeIban('DE89370400440532013000').qrIban, false, '德国永远不是 QR-IBAN');

      /* ---- 展示层 ---- */
      // label 现在是翻译过的显示名，断言一律按稳定的 id 查
      var rows = ibanRows(analyzeIban('DE89370400440532013000'));
      var ids = rows.map(function (r) { return r.id; });
      assert(ids.indexOf('errors') < 0, '合法 IBAN 不显示错误行');
      assert(ids.indexOf('check_digits') >= 0, '显示校验位');
      assert(ids.indexOf('bban_structure') >= 0, '显示账号结构');
      assert(ids.indexOf('electronic') >= 0, '显示 electronic 形式');

      rows = ibanRows(analyzeIban('FR7630006060011234567890189'));
      ids = rows.map(function (r) { return r.id; });
      assert(ids.indexOf('errors') >= 0, '非法 IBAN 显示错误行');

      rows = ibanRows(analyzeIban(''));
      assert.eq(rows.length, 1, '空输入只给一行（有效性判断）');

      /* ---- 组装（收对象，不是两个位置参数） ---- */
      assert.eq(composeIban('NL', 'ABNA0417164300'), 'NL91ABNA0417164300', '按对象传参能算出校验位');
      assert.eq(composeIban('DE', '370400440532013000'), 'DE89370400440532013000', '德国那条能对上本工具的解析结果');
      assert.eq(analyzeIban(composeIban('CH', '31999123000889012')).qrIban, true, '自己拼出来的 QR-IBAN 也认');
      assert.eq(composeIban('DE', 'nope'), null, 'BBAN 不合规返回 null');
    }
  };
})();