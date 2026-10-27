/* ==========================================================================
   电话号码解析与格式化（phone-parser-and-formatter）

   输入一串号码，选一个默认国家，实时看到 AsYouType 的格式化结果，
   并给出 E.164 / 国际 / 国内 / RFC3966 四种写法与合法性判断。

   参考实现：src/tools/phone-parser-and-formatter/（it-tools, GPLv3）
   与原版的差别：
   · 原版的明细表里有**两行都叫 "Country"**（一行 ISO2、一行国名），v-for 的 key 也撞了。
     这里拆成 "Country (ISO2)" 与 "Country"。
   · ⚠ 本仓库 vendored 的 libphonenumber-js 包里 PhoneNumber **没有** isMobile /
     isFixedLine / isTollFree 这类逐类型判定方法（只有 getType / isValid / isPossible …），
     所以「按类型分组展示」只能按 getType() 的返回值做一个 taxonomy 清单。
   · ⚠ country-code-lookup 这个包**没有** byPhone 方法，countries 里也没有电话区号字段；
     原版 models.ts 里的 `lookup.byPhone` 在本仓库的产物上会直接抛
     "C.byPhone is not a function"。国名统一走 byIso(iso2).country 区号走
     libphonenumber 的 getCountryCallingCode —— 这也是原版下拉框本来就在用的两条路径。
   · ⚠ AsYouType.input() 在本产物里**返回格式化后的字符串**，不是实例
     （返回实例是 v1.x 一些构建的行为）。这里统一用返回值，并保留实例上的
     formattedOutput / getNumberValue() 作为等价读法。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('phone-parser-and-formatter');

  /** getType() 可能返回的值 → 人话。表与参考实现一致。 */
  var TYPE_LABELS = {
    MOBILE: t('type_mobile', 'Mobile'),
    FIXED_LINE: t('type_fixed_line', 'Fixed line'),
    FIXED_LINE_OR_MOBILE: t('type_fixed_line_or_mobile', 'Fixed line or mobile'),
    PERSONAL_NUMBER: t('type_personal_number', 'Personal number'),
    PREMIUM_RATE: t('type_premium_rate', 'Premium rate'),
    SHARED_COST: t('type_shared_cost', 'Shared cost'),
    TOLL_FREE: t('type_toll_free', 'Toll free'),
    UAN: t('type_uan', 'Universal access number'),
    VOICEMAIL: t('type_voicemail', 'Voicemail'),
    VOIP: t('type_voip', 'VoIP'),
    PAGER: t('type_pager', 'Pager')
  };

  /** 原版的输入校验：只允许数字、空格、加号、连字符和圆括号。 */
  var ALLOWED_CHARS = /^[0-9 +\-()]+$/;

  var DEFAULT_COUNTRY = 'FR';

  var EXAMPLES = [
    { label: t('example_fr_mobile', 'FR mobile'), value: '+33 6 12 34 56 78', country: 'FR' },
    { label: t('example_cn_mobile', 'CN mobile'), value: '+86 139 1234 5678', country: 'CN' },
    { label: t('example_us', 'US'), value: '+1 (415) 555-2671', country: 'US' },
    { label: t('example_gb_fixed', 'GB fixed'), value: '+44 20 7946 0958', country: 'GB' }
  ];

  /** getType() 的值 → 人话；认不出来的原样返回，不丢信息。 */
  function formatTypeToHumanReadable(type) {
    if (!type) return undefined;
    return TYPE_LABELS[type] || type;
  }

  /** ISO2 → 国名。查不到返回 undefined（不编造）。 */
  function getFullCountryName(countryCode) {
    if (!countryCode) return undefined;
    var hit = window.countryCodeLookup.byIso(countryCode);
    return hit ? hit.country : undefined;
  }

  /**
   * 从 locale（形如 en-US）推出默认国家码。
   * 取不到就用 defaultCode，与原版一致。
   *
   * 传空串表示「明确不指定」，只有**不传**才回落到 navigator.language ——
   * 这里对齐原版 JS 默认参数的语义（`locale = window.navigator.language`），
   * 用 `locale || navigator.language` 会让空串也被浏览器语言顶掉。
   *
   * @param {string} [locale]
   * @param {string} [defaultCode]
   */
  function getDefaultCountryCode(locale, defaultCode) {
    var fallback = defaultCode || DEFAULT_COUNTRY;
    var tag = locale === undefined || locale === null
      ? ((window.navigator && window.navigator.language) || '')
      : String(locale);
    var parts = tag.split('-');
    var region = (parts[1] || '').toUpperCase();
    if (!region) return fallback;
    return (window.countryCodeLookup.byIso(region) || {}).iso2 || fallback;
  }

  /** 下拉框选项：国名 + 区号，按国名排序。 */
  function countryOptions() {
    return window.libphonenumber.getCountries().map(function (code) {
      var name = getFullCountryName(code) || code;
      var calling = window.libphonenumber.getCountryCallingCode(code);
      return { value: code, label: name + ' (+' + calling + ')', name: name };
    }).sort(function (a, b) { return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0); });
  }

  /** 输入字符白名单校验（与原版一致，早于解析，省掉无意义的报错）。 */
  function isAllowedInput(raw) {
    if (typeof raw !== 'string') return false;
    if (raw === '') return true;      // 空输入不算错，只是什么都还没填
    return ALLOWED_CHARS.test(raw);
  }

  /**
   * AsYouType 实时格式化。
   *
   * 每调用一次都新建实例：AsYouType 是**有状态**的，input() 往当前状态上追加，
   * 复用实例会把上一次输入的尾巴一起带进来。
   * 本产物的 input() 直接返回格式化字符串（旧构建返回实例，两种读法都留了）。
   *
   * @param {string} raw
   * @param {string} country ISO2
   * @returns {string}
   */
  function formatAsYouType(raw, country) {
    if (typeof raw !== 'string' || !raw) return '';
    try {
      var ayt = new window.libphonenumber.AsYouType(country || undefined);
      var out = ayt.input(raw);
      return typeof out === 'string' ? out : String(ayt.formattedOutput || '');
    } catch (e) {
      return '';
    }
  }

  /** ParseError 的 message → 人话（本产物的 ParseError 类名被压缩过，只能认 message）。 */
  function describeParseError(err) {
    switch (String((err && err.message) || err)) {
      case 'NOT_A_NUMBER': return t('err_not_a_number', 'Not a number');
      case 'TOO_SHORT': return t('err_too_short', 'Number is too short');
      case 'TOO_LONG': return t('err_too_long', 'Number is too long');
      case 'INVALID_COUNTRY': return t('err_invalid_country', 'Invalid country calling code');
      case 'INVALID_COUNTRY_CALLING_CODE': return t('err_invalid_country', 'Invalid country calling code');
      default: return String((err && err.message) || err);
    }
  }

  /**
   * 解析一个号码。
   * @param {string} raw
   * @param {string} country ISO2，作为没有 + 区号时的默认国家
   * @returns {{ok:boolean, input:string, error:string, live:string}}
   */
  function parsePhone(raw, country) {
    var input = typeof raw === 'string' ? raw.trim() : '';
    if (!input) return { ok: false, input: '', error: '', live: '' };
    if (!isAllowedInput(input)) {
      return { ok: false, input: input, error: t('err_invalid_phone', 'Invalid phone number'), live: formatAsYouType(input, country) };
    }
    var live;
    try { live = formatAsYouType(input, country); } catch (e) { live = ''; }
    try {
      var p = window.libphonenumber.parsePhoneNumber(input, country);
      var type = p.getType();
      return {
        ok: true,
        input: input,
        error: '',
        live: live,
        number: p.number,
        country: p.country || '',
        countryName: getFullCountryName(p.country) || '',
        countryCallingCode: p.countryCallingCode,
        nationalNumber: p.nationalNumber,
        valid: p.isValid(),
        possible: p.isPossible(),
        type: type || '',
        typeLabel: formatTypeToHumanReadable(type) || '',
        international: p.formatInternational(),
        national: p.formatNational(),
        e164: p.format('E.164'),
        rfc3966: p.format('RFC3966'),
        possibleCountries: p.getPossibleCountries()
      };
    } catch (e) {
      return { ok: false, input: input, error: describeParseError(e), live: live };
    }
  }

  /** 明细表：[{id, label, value}]，id 稳定不变，label 随语言变，空值显示 Unknown。 */
  function phoneRows(r) {
    if (!r.ok) return [];
    return [
      { id: 'country_iso2', label: t('row_country_iso2', 'Country (ISO2)'), value: r.country },
      { id: 'country', label: t('row_country', 'Country'), value: r.countryName },
      { id: 'country_calling_code', label: t('row_country_calling_code', 'Country calling code'), value: r.countryCallingCode },
      { id: 'is_valid', label: t('row_is_valid', 'Is valid?'), value: r.valid ? t('yes', 'Yes') : t('no', 'No') },
      { id: 'is_possible', label: t('row_is_possible', 'Is possible?'), value: r.possible ? t('yes', 'Yes') : t('no', 'No') },
      { id: 'type', label: t('row_type', 'Type'), value: r.typeLabel },
      { id: 'national_number', label: t('row_national_number', 'National number'), value: r.nationalNumber },
      { id: 'international_format', label: t('row_international_format', 'International format'), value: r.international },
      { id: 'national_format', label: t('row_national_format', 'National format'), value: r.national },
      { id: 'e164', label: t('row_e164_format', 'E.164 format'), value: r.e164 },
      { id: 'rfc3966', label: t('row_rfc3966_format', 'RFC3966 format'), value: r.rfc3966 }
    ];
  }

  /**
   * WhatsApp 发送链接（上游 #1107）。
   *
   * 号码取 E.164 再去掉所有非数字字符：`+33 6 12 34 56 78` → `33612345678`。
   * 用 E.164 而不是「国际格式」，是因为国际格式里带空格与不间断空格，
   * 去掉非数字才稳；E.164 本身不带分隔符，去掉 `+` 之后就是 WhatsApp 要的形态。
   *
   * @param {object} r parsePhone 的结果
   * @param {string} [message] 预填的消息
   * @returns {string} 解析不出来时返回空串
   */
  function whatsappLink(r, message) {
    if (!r || !r.ok || !r.e164) return '';
    var digits = String(r.e164).replace(/\D/g, '');
    if (!digits) return '';
    var link = 'https://wa.me/' + digits;
    if (message) link += '?text=' + encodeURIComponent(message);
    return link;
  }

  /**
   * 短信发送链接（上游 #1107）。
   *
   * RFC 5724 的写法是 `sms:+15551234567?body=hello` —— 正文用 `?body=`，
   * 不是上游写的 `&body=`（那个不是合法 URI，短信应用多半认不出正文）。
   *
   * @param {object} r parsePhone 的结果
   * @param {string} [message] 预填的消息
   * @returns {string}
   */
  function smsLink(r, message) {
    if (!r || !r.ok || !r.e164) return '';
    var digits = String(r.e164).replace(/\D/g, '');
    if (!digits) return '';
    var link = 'sms:+' + digits;
    if (message) link += '?body=' + encodeURIComponent(message);
    return link;
  }

  window.ItTools.register('phone-parser-and-formatter', function (root) {
    var country = getDefaultCountryCode();
    var countrySelect = D.h('select.layui-select', null, countryOptions().map(function (o) {
      return D.h('option', { value: o.value, text: o.label, selected: o.value === country });
    }));
    // 下拉按国名排序了，默认国家未必是第 0 项，这里显式对齐一次
    countrySelect.value = country;

    var input = D.h('input.layui-input', {
      placeholder: t('ph_phone', 'Enter a phone number'), spellcheck: 'false', 'aria-label': t('aria_phone', 'Phone number')
    });
    var liveOut = D.h('p.token-display', { text: '' });
    var table = D.h('div');
    var hint = D.h('p.field-hint');
    var messageInput = D.h('textarea.layui-textarea', {
      rows: 3, placeholder: t('ph_message', 'Message to send (optional)'), spellcheck: 'false'
    });
    var sendBox = D.h('div');

    function render() {
      var r = parsePhone(input.value, countrySelect.value);
      D.clear(table);
      D.clear(sendBox);
      liveOut.textContent = r.live || '';

      if (!input.value.trim()) {
        hint.textContent = t('hint_start', 'Pick a default country, then type a number. Live formatting is shown below.');
        return;
      }
      if (!r.ok) {
        hint.textContent = r.error;
        hint.style.color = 'var(--danger, #d93025)';
        return;
      }
      D.clear(hint);
      hint.style.color = '';

      var body = D.h('tbody');
      phoneRows(r).forEach(function (row) {
        body.appendChild(D.h('tr', null,
          D.h('td', { text: row.label }),
          D.h('td.val', { text: row.value || t('unknown', 'Unknown'), style: row.value ? null : { opacity: '.7' } })
        ));
      });
      table.appendChild(D.h('table.kv-table', null, body));

      // 发送链接：WhatsApp 与短信（上游 #1107）
      var message = messageInput.value;
      var links = [
        { id: 'whatsapp', label: t('label_whatsapp_link', 'WhatsApp send link'), url: whatsappLink(r, message) },
        { id: 'sms', label: t('label_sms_link', 'SMS send link'), url: smsLink(r, message) }
      ];
      links.forEach(function (item) {
        if (!item.url) return;
        sendBox.appendChild(D.h('div.field-row', null,
          D.h('label.field-label', { text: item.label }),
          D.h('div.input-group', null,
            D.h('input.layui-input', { type: 'text', readonly: true, value: item.url, spellcheck: 'false' }),
            U.copyButton(function () { return item.url; })
          )
        ));
        sendBox.appendChild(D.h('div.form-actions', null,
          D.h('a.layui-btn.layui-btn-primary.layui-btn-sm', {
            href: item.url, target: '_blank', rel: 'noopener noreferrer',
            text: item.id === 'whatsapp' ? t('open_whatsapp', 'Open WhatsApp') : t('open_sms', 'Open SMS app')
          })
        ));
      });
    }

    var offInput = D.on(input, 'input', render);
    var offCountry = D.on(countrySelect, 'change', render);
    var offMessage = D.on(messageInput, 'input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('label_default_country', 'Default country code:'), countrySelect, { wide: true, hint: t('hint_default_country', 'Applies to numbers typed without a +country code') }),
      U.field(t('label_phone_number', 'Phone number:'), input, { wide: true }),
      D.h('div.form-actions', null, EXAMPLES.map(function (ex) {
        return D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button',
          text: ex.label,
          onclick: function () {
            countrySelect.value = ex.country;
            input.value = ex.value;
            render();
          }
        });
      })),
      liveOut,
      hint
    ));

    root.appendChild(D.h('div.card', null,
      table,
      D.h('p.field-hint', {
        text: t('hint_line_types', 'Line types reported by this library: {types}').replace('{types}',
          Object.keys(TYPE_LABELS).map(function (k) { return TYPE_LABELS[k]; }).join(', ')) + '.'
      })
    ));

    root.appendChild(D.h('div.card', null,
      U.field(t('label_message', 'Message to send:'), messageInput, { wide: true }),
      sendBox
    ));

    render();

    return {
      destroy: function () {
        offInput();
        offCountry();
        offMessage();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['phone-parser-and-formatter'] = {
    TYPE_LABELS: TYPE_LABELS,
    EXAMPLES: EXAMPLES,
    DEFAULT_COUNTRY: DEFAULT_COUNTRY,
    formatTypeToHumanReadable: formatTypeToHumanReadable,
    getFullCountryName: getFullCountryName,
    getDefaultCountryCode: getDefaultCountryCode,
    countryOptions: countryOptions,
    isAllowedInput: isAllowedInput,
    formatAsYouType: formatAsYouType,
    describeParseError: describeParseError,
    parsePhone: parsePhone,
    phoneRows: phoneRows,
    whatsappLink: whatsappLink,
    smsLink: smsLink,
    __cases: function (assert) {
      /* ---- 类型标签 ---- */
      assert.eq(formatTypeToHumanReadable('MOBILE'), t('type_mobile', 'Mobile'), 'MOBILE → Mobile');
      assert.eq(formatTypeToHumanReadable('FIXED_LINE'), t('type_fixed_line', 'Fixed line'), 'FIXED_LINE → Fixed line');
      assert.eq(formatTypeToHumanReadable('FIXED_LINE_OR_MOBILE'), t('type_fixed_line_or_mobile', 'Fixed line or mobile'), '组合类型');
      assert.eq(formatTypeToHumanReadable('TOLL_FREE'), t('type_toll_free', 'Toll free'), 'TOLL_FREE');
      assert.eq(formatTypeToHumanReadable('VOIP'), t('type_voip', 'VoIP'), 'VOIP');
      assert.eq(formatTypeToHumanReadable('WHATEVER'), 'WHATEVER', '认不出来的原样返回，不丢信息');
      assert.eq(formatTypeToHumanReadable(undefined), undefined, '没有类型返回 undefined');
      assert.eq(formatTypeToHumanReadable(''), undefined, '空串返回 undefined');
      assert.eq(Object.keys(TYPE_LABELS).length, 11, '11 种类型');

      /* ---- 国名 ---- */
      assert.eq(getFullCountryName('CN'), 'China', 'byIso 拿国名');
      assert.eq(getFullCountryName('FR'), 'France', 'byIso 拿国名');
      assert.eq(getFullCountryName('ZZ'), undefined, '查不到返回 undefined');
      assert.eq(getFullCountryName(''), undefined, '空串返回 undefined');
      // 本包的 countries 记录里没有电话区号字段，也没有 byPhone
      assert(typeof window.countryCodeLookup.byPhone === 'undefined', '这个包的 byPhone 确实不存在');
      assert(window.countryCodeLookup.byIso('CN').phone === undefined, '记录里也没有 phone 字段');

      /* ---- 默认国家码 ---- */
      assert.eq(getDefaultCountryCode('en-US', 'FR'), 'US', 'en-US → US');
      assert.eq(getDefaultCountryCode('zh-CN', 'FR'), 'CN', 'zh-CN → CN');
      assert.eq(getDefaultCountryCode('en', 'FR'), 'FR', '没有地区段就退回默认值');
      assert.eq(getDefaultCountryCode('', 'GB'), 'GB', '显式传空串 → 退回默认值（不回落浏览器语言）');
      assert.eq(getDefaultCountryCode(), 'US', '不传 → 回落 navigator.language（jsdom 里是 en-US）');
      assert.eq(getDefaultCountryCode('xx-ZZ', 'FR'), 'FR', '认不出来的地区退回默认值');

      /* ---- 下拉选项 ---- */
      var opts = countryOptions();
      assert(opts.length > 200, '国家列表来自 libphonenumber：' + opts.length + ' 项');
      var cn = opts.filter(function (o) { return o.value === 'CN'; })[0];
      assert(cn.label, 'China (+86)', 'CN 的选项文案');
      var fr = opts.filter(function (o) { return o.value === 'FR'; })[0];
      assert.eq(fr.label, 'France (+33)', 'FR 的选项文案');
      // 按 label 排序，所以「China (+86)」排在「France (+33)」前面
      var iCn = opts.indexOf(cn), iFr = opts.indexOf(fr);
      assert(iCn < iFr, '选项按文案排序');

      /* ---- 输入白名单 ---- */
      assert(isAllowedInput('+33 6 12 34 56 78') === true, '带空格和加号可以');
      assert(isAllowedInput('(415) 555-2671') === true, '圆括号和连字符可以');
      assert(isAllowedInput('') === true, '空输入不算错');
      assert(isAllowedInput('abc') === false, '字母不行');
      assert(isAllowedInput('+33.6.12') === false, '句点不行');
      assert(isAllowedInput(null) === false, 'null 不炸');

      /* ---- AsYouType 实时格式化 ---- */
      // 逐字符喂进去应该一直是格式化后的样子
      assert.eq(formatAsYouType('0612345678', 'FR'), '06 12 34 56 78', '法国固话格式');
      assert.eq(formatAsYouType('13912345678', 'CN'), '139 1234 5678', '中国手机格式');
      assert.eq(formatAsYouType('4155552671', 'US'), '(415) 555-2671', '美国格式');
      assert.eq(formatAsYouType('+8613912345678', ''), '+86 139 1234 5678', '没有默认国也能靠 + 区号认出来');
      assert.eq(formatAsYouType('06', 'FR'), '06', '还没输完就保持原样');
      assert.eq(formatAsYouType('0', 'FR'), '0', '第一个字符');
      assert.eq(formatAsYouType('(415) 555-2671', 'US'), '(415) 555-2671', '带空格括号照样吃得下');
      assert.eq(formatAsYouType('', 'FR'), '', '空输入');
      assert.eq(formatAsYouType(null, 'FR'), '', 'null 输入');
      assert.eq(formatAsYouType('#', 'FR'), '', '非法字符给不出格式');
      // 每次调用都是新实例：连着喂两次不会把上一次的尾巴带进来
      assert.eq(formatAsYouType('0612345678', 'FR'), '06 12 34 56 78', '重复调用结果一致（实例不复用）');

      /* ---- 解析：正常值 ---- */
      var r = parsePhone('+33 6 12 34 56 78', 'FR');
      assert.eq(r.ok, true, '法国手机号能解析');
      assert.eq(r.country, 'FR', '国家 FR');
      assert.eq(r.countryName, 'France', '国名');
      assert.eq(r.countryCallingCode, '33', '区号');
      assert.eq(r.nationalNumber, '612345678', '国内号码');
      assert.eq(r.valid, true, '有效');
      assert.eq(r.possible, true, '可能');
      assert.eq(r.type, 'MOBILE', '类型 MOBILE');
      assert.eq(r.typeLabel, t('type_mobile', 'Mobile'), '类型人话');
      assert.eq(r.e164, '+33612345678', 'E.164');
      assert.eq(r.international, '+33 6 12 34 56 78', '国际格式');
      assert.eq(r.national, '06 12 34 56 78', '国内格式');
      assert.eq(r.rfc3966, 'tel:+33612345678', 'RFC3966');
      assert.eq(r.live, '+33 6 12 34 56 78', '同时给出 AsYouType 的实时结果');

      r = parsePhone('+86 139 1234 5678', 'CN');
      assert.eq(r.countryName, 'China', '中国');
      assert.eq(r.type, 'MOBILE', '中国手机');
      assert.eq(r.national, '139 1234 5678', '中国国内格式');

      r = parsePhone('+1 (415) 555-2671', 'US');
      assert.eq(r.country, 'US', '美国');
      assert.eq(r.type, 'FIXED_LINE_OR_MOBILE', '美国号码库分不清固话还是手机');
      assert.eq(r.typeLabel, t('type_fixed_line_or_mobile', 'Fixed line or mobile'), '类型人话');

      r = parsePhone('+44 20 7946 0958', 'GB');
      assert.eq(r.type, 'FIXED_LINE', '英国固话');
      assert.eq(r.countryCallingCode, '44', '区号 44');
      assert.eq(r.possibleCountries, ['GB'], '可能的只有 GB');

      /* ---- 依赖默认国家（没有 + 区号） ---- */
      r = parsePhone('0612345678', 'FR');
      assert.eq(r.ok, true, '按默认国家 FR 解析');
      assert.eq(r.e164, '+33612345678', '补上区号');
      r = parsePhone('13912345678', 'CN');
      assert.eq(r.e164, '+8613912345678', '按 CN 解析');

      /* ---- 非法输入 ---- */
      r = parsePhone('', 'FR');
      assert.eq(r.ok, false, '空输入不报解析错');
      assert.eq(r.error, '', '空输入没有错误文案');

      r = parsePhone('   ', 'FR');
      assert.eq(r.ok, false, '纯空白当空');

      r = parsePhone('abc', 'FR');
      assert.eq(r.ok, false, '字母进不来');
      assert.eq(r.error, t('err_invalid_phone', 'Invalid phone number'), '白名单就挡住了');
      r = parsePhone('+33.6.12.34', 'FR');
      assert.eq(r.error, t('err_invalid_phone', 'Invalid phone number'), '句点也挡住');

      r = parsePhone('+33 6', 'FR');
      assert.eq(r.ok, false, '太短');
      assert.eq(r.error, t('err_too_short', 'Number is too short'), 'TOO_SHORT 的文案');

      r = parsePhone('000000000000000000000', 'FR');
      assert.eq(r.ok, false, '太长');
      assert.eq(r.error, t('err_too_long', 'Number is too long'), 'TOO_LONG 的文案');

      r = parsePhone('+999999999999', 'FR');
      assert.eq(r.ok, false, '区号不存在');
      assert.eq(r.error, t('err_invalid_country', 'Invalid country calling code'), 'INVALID_COUNTRY 的文案');

      r = parsePhone(null, 'FR');
      assert.eq(r.ok, false, 'null 不炸');

      // 格式对但号码本身不是有效号：能解析、但 valid=false，这是最容易被误当成 bug 的一种情况
      r = parsePhone('+33 6 12 34 56 00', 'FR');
      assert(r.ok === true, '能解析出来');
      assert.eq(r.possible, true, '长度上是可能的');
      assert(typeof r.valid, 'boolean', '有效性是个布尔值');

      /* ---- 明细表 ---- */
      var rows = phoneRows(parsePhone('+33 6 12 34 56 78', 'FR'));
      var ids = rows.map(function (x) { return x.id; });
      assert.eq(rows.length, 11, '11 行明细');
      assert.eq(ids.filter(function (id) { return id === 'country'; }).length, 1,
        'Country 只有一行（原版有两行重名）');
      assert(ids.indexOf('country_iso2') >= 0, 'ISO2 单独一行');
      assert(ids.indexOf('rfc3966') >= 0, 'RFC3966');
      assert.eq(rows.filter(function (x) { return x.id === 'is_valid'; })[0].value, t('yes', 'Yes'), '有效那行给 Yes');
      assert.eq(phoneRows(parsePhone('abc', 'FR')).length, 0, '解析失败没有明细');

      /* ---- 发送链接（上游 #1107）---- */
      var fr = parsePhone('+33 6 12 34 56 78', 'FR');
      assert.eq(whatsappLink(fr), 'https://wa.me/33612345678', 'WhatsApp 链接');
      assert.eq(whatsappLink(fr, 'hello world'),
        'https://wa.me/33612345678?text=hello%20world', '带预填消息');
      assert.eq(whatsappLink(fr, 'a&b=c'),
        'https://wa.me/33612345678?text=a%26b%3Dc', '消息里的特殊字符要转义');
      // 短信：RFC 5724 用 ?body=
      assert.eq(smsLink(fr), 'sms:+33612345678', '短信链接');
      assert.eq(smsLink(fr, 'hello'), 'sms:+33612345678?body=hello', '短信正文');
      // 意大利这类「国号后面还带一个 0」的号码不能把 0 吃掉
      var it = parsePhone('+39 06 6982', 'IT');
      assert.eq(whatsappLink(it), 'https://wa.me/39066982', '意大利的 0 要保留');
      // 解析不出来就没有链接
      assert.eq(whatsappLink(parsePhone('abc', 'FR')), '', '解析失败没有链接');
      assert.eq(smsLink(parsePhone('abc', 'FR')), '', '解析失败没有链接');
      assert.eq(whatsappLink(null), '', 'null 也不炸');
    }
  };
})();