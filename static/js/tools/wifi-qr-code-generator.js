/* ==========================================================================
   WiFi 二维码生成器（wifi-qr-code-generator）

   把 SSID / 密码 / 加密方式拼成 `WIFI:T:WPA;S:<ssid>;P:<pw>;H:true;;` 这种
   payload，交给全局 QRCode 画成二维码，手机扫一下就能连网。

   参考实现：src/tools/wifi-qr-code-generator/（it-tools, GPLv3）
   payload 格式（字段、转义、hidden 标志）的出处是 ZXing 的说明页：
   https://github.com/zxing/zxing/wiki/Barcode-Contents#wi-fi-network-config-android-ios-11

   —— 转义规则（本工具的核心）——
   字段之间用 `;` 分隔，字段内部这五个字符有特殊含义，必须用 `\` 转义：
       \  反斜杠自身，不转义会把后面那个字符一起吃掉
       ;  字段分隔符
       :  键值分隔符
       ,  分隔符（ZXing 的 SSID 白名单正则也把它列入特殊字符）
       "  引号形式 WiFi 配置里的定界符
   参考实现的 escapeString 用的是 `/([\\;,:"])/g` —— **逐条核对下来一个没漏**，
   本文件的 escapeWifi 与它完全一致（__cases 里用「转义-反解往返」再兜一遍）。

   —— 与参考实现的四处不同 ——
   1. 【原版的 bug】nopass 分支返回 `WIFI:S:<ssid>;`，把 `H:true` 整个丢掉了。
      隐藏的开放网络扫进去等于没用 —— 手机靠这个标志才知道「这个 SSID 不广播，
      你得主动去找」。
   2. 字段顺序：原版是 `S;T;P;H`，这里是 `T;S;P;H`。ZXing 的解析是
      `(?:^|[;\\])<key>:` 的键查找，与顺序无关；这里用社区通行的规范顺序，
      也和各家文档里给的示例一致。
   3. 补了原版没有的 SSID 校验：先去掉首尾空白再判空（原版 `'   '` 会被当成
      合法 SSID 放行），且 UTF-8 字节数不得超过 32 —— 802.11 的硬上限，
      超长的 SSID 生成的码扫出来是连不上的。
   4. 原版在校验不过时静默返回 null，页面上什么都不显示也不说原因；这里把原因
      带出来，直接告诉用户是哪一项不合法。

   —— WPA3（上游 #1479）——
   ZXing 的 `T:` 字段认的是这几个值：nopass / WEP / WPA（PSK，WPA、WPA2 与
   WPA2+WPA3 混合模式都用它）/ SAE（WPA3-only）/ WPA2-EAP。
   上游 #1479 加的两个选项**两个分支都写 `T:WPA3`** —— 那是 ZXing 不认的值，
   扫出来认不出加密方式；它还给 WPA3-only 那个多写了一个 `R:1`。
   这里按规范来：WPA3-only 用 `T:SAE`，混合模式沿用 `T:WPA`。

   —— 关于画布 ——
   vendor 进来的是 build/qrcode.js（含 Node 兼容层），它画图要真 canvas，
   而 node 侧的 jsdom 没装 canvas 实现。所以「拼 payload / 校验 / 解析颜色」
   这些纯逻辑都放在本文件里并单测，真正的 toCanvas 调用留在 UI 代码中，
   且入口先探一次 canvasAvailable()，探测不过就整段跳过。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('wifi-qr-code-generator');

  /** 802.11 规定的 SSID 上限（32 个八位组，不是 32 个字符）。 */
  var SSID_MAX_BYTES = 32;
  /** WPA-PSK 的口令长度区间，超出就是非标准配置（只提醒，不拦）。 */
  var PSK_MIN = 8, PSK_MAX = 63;

  var ENCRYPTIONS = [
    { value: 'nopass', label: t('enc_nopass', 'No password') },
    // `T:WPA` 是 ZXing 规范里的 PSK 类型，WPA / WPA2 / WPA2+WPA3 混合模式都用它
    { value: 'WPA', label: t('enc_wpa', 'WPA / WPA2 / WPA3 (mixed)') },
    // `T:SAE` 才是 WPA3-only（SAE = Simultaneous Authentication of Equals）
    { value: 'SAE', label: t('enc_sae', 'WPA3 only (SAE)') },
    { value: 'WEP', label: t('enc_wep', 'WEP') },
    { value: 'WPA2-EAP', label: t('enc_wpa2_eap', 'WPA2-EAP') }
  ];

  /** 可选的 EAP 方法，名单照抄参考实现。 */
  var EAP_METHODS = [
    'MD5', 'POTP', 'GTC', 'TLS', 'IKEv2', 'SIM', "AKA'", 'TTLS', 'PWD', 'LEAP',
    'PSK', 'FAST', 'TEAP', 'EKE', 'NOOB', 'PEAP'
  ];
  var EAP_PHASE2_METHODS = ['None', 'MSCHAPV2'];

  /* ---------- 纯逻辑 ---------- */

  /** 非法颜色的报错文案。 */
  function invalidHex(color) {
    return t('err_invalid_hex_color', 'Invalid hex color: {color}')
      .replace('{color}', function () { return color; });
  }

  /**
   * WiFi payload 的字段转义：\ ; : , " 五个字符前加一个反斜杠。
   * 与参考实现的 escapeString 一致（逐字符核对过）。
   */
  function escapeWifi(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/([\\;,:"])/g, '\\$1');
  }

  /** UTF-8 字节数（SSID 的 32 上限按字节算，不是按字符算；代理对算 4 字节）。 */
  function utf8Length(str) {
    var s = String(str == null ? '' : str);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length &&
               s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /** 加密方式归一：只认 ENCRYPTIONS 里的值，认不出就返回 null。 */
  function normalizeEncryption(v) {
    var s = String(v == null ? '' : v).trim();
    for (var i = 0; i < ENCRYPTIONS.length; i++) if (ENCRYPTIONS[i].value === s) return s;
    return null;
  }

  /** WEP 密钥长度：5/13 个字符，或者 10/26 个十六进制数字。 */
  function isValidWepKey(pw) {
    if (pw.length === 5 || pw.length === 13) return true;
    return /^[0-9a-fA-F]+$/.test(pw) && (pw.length === 10 || pw.length === 26);
  }

  /**
   * 校验表单。ok=false 时 reason 说明**硬性**错误（生不出码），
   * warnings 只是提醒（码能扫，但配置可能连不上）。
   * @param {{ssid?:string,password?:string,encryption?:string,hidden?:boolean,
   *          eapMethod?:string,eapIdentity?:string,eapAnonymous?:boolean,
   *          eapPhase2Method?:string}} opts
   * @returns {{ok:boolean, reason:string, warnings:string[], ssid:string, encryption:string|null}}
   */
  function validateWifi(opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', warnings: [], ssid: '', encryption: null };

    // 1. SSID：去空白后判空 + 32 字节上限（参考实现缺这两条）
    out.ssid = String(opts.ssid == null ? '' : opts.ssid).trim();
    if (!out.ssid) { out.reason = t('err_ssid_empty', 'SSID is empty.'); return out; }
    var ssidBytes = utf8Length(out.ssid);
    if (ssidBytes > SSID_MAX_BYTES) {
      out.reason = t('err_ssid_too_long', 'SSID is {bytes} UTF-8 bytes, over the 32-byte limit of 802.11.')
        .replace('{bytes}', function () { return String(ssidBytes); });
      return out;
    }

    // 2. 加密方式必须在名单里
    out.encryption = normalizeEncryption(opts.encryption);
    if (!out.encryption) {
      out.reason = t('err_unknown_encryption', 'Unknown encryption {enc}.')
        .replace('{enc}', function () { return JSON.stringify(opts.encryption); });
      return out;
    }
    if (out.encryption === 'nopass') { out.ok = true; return out; }

    // 3. 其余加密方式都要口令
    var pw = String(opts.password == null ? '' : opts.password);
    if (!pw) {
      out.reason = out.encryption === 'WEP'
        ? t('err_wep_needs_password', 'WEP needs a password.')
        : t('err_needs_password', '{enc} needs a password.')
          .replace('{enc}', function () { return out.encryption; });
      return out;
    }

    if (out.encryption === 'WPA2-EAP') {
      if (EAP_METHODS.indexOf(String(opts.eapMethod)) < 0) {
        out.reason = t('err_eap_needs_method', 'WPA2-EAP needs an EAP method.');
        return out;
      }
      // 没有身份、也没勾匿名 —— 生成的码里没有任何可用的凭据
      if (!opts.eapAnonymous && !String(opts.eapIdentity == null ? '' : opts.eapIdentity).trim()) {
        out.reason = t('err_eap_needs_identity', 'WPA2-EAP needs either an identity or the anonymous flag.');
        return out;
      }
      // PEAP 一定会走第二阶段认证，缺了连不上（参考实现也拦了这一条）
      if (opts.eapMethod === 'PEAP' && opts.eapPhase2Method === 'None') {
        out.reason = t('err_peap_needs_phase2', 'PEAP needs an EAP phase 2 method.');
        return out;
      }
      if (pw.length < PSK_MIN || pw.length > PSK_MAX) out.warnings.push(pskWarning(pw.length));
      out.ok = true;
      return out;
    }

    if (out.encryption === 'WEP') {
      if (!isValidWepKey(pw)) {
        out.warnings.push(t('warn_wep_key', 'WEP keys are 5 or 13 characters (10/26 hex digits); this one is {len}.')
          .replace('{len}', function () { return String(pw.length); }));
      }
    } else if (pw.length < PSK_MIN || pw.length > PSK_MAX) {
      out.warnings.push(pskWarning(pw.length));
    }

    out.ok = true;
    return out;
  }

  function pskWarning(len) {
    return t('warn_psk_length', 'The password is {len} characters; PSK wants {min}–{max}.')
      .replace('{len}', function () { return String(len); })
      .replace('{min}', function () { return String(PSK_MIN); })
      .replace('{max}', function () { return String(PSK_MAX); });
  }

  /**
   * 拼出完整的 WIFI payload。
   *
   * 结构：`WIFI:` + 若干个 `键:值;` + 一个收尾的 `;`（于是末尾是 `;;`，
   * 与参考实现一致）。`H:true` 只在勾了隐藏 SSID 时出现，绝不出现 `H:false`。
   *
   * @returns {string|null} 校验不通过时返回 null（原因见 validateWifi）
   */
  function buildWifiPayload(opts) {
    var v = validateWifi(opts);
    if (!v.ok) return null;
    opts = opts || {};

    var fields = ['T:' + v.encryption, 'S:' + escapeWifi(v.ssid)];
    if (v.encryption !== 'nopass') fields.push('P:' + escapeWifi(opts.password));

    if (v.encryption === 'WPA2-EAP') {
      fields.push('E:' + opts.eapMethod);
      if (opts.eapPhase2Method && opts.eapPhase2Method !== 'None') {
        fields.push('PH2:' + opts.eapPhase2Method);
      }
      if (opts.eapAnonymous) fields.push('A:anon');
      else fields.push('I:' + escapeWifi(opts.eapIdentity));
    }

    if (opts.hidden) fields.push('H:true');

    return 'WIFI:' + fields.join(';') + ';;';
  }

  /**
   * 十六进制颜色 → {r,g,b,a,hex}。
   * 接受 #rgb / #rgba / #rrggbb / #rrggbbaa（#rrggbba 里那个 7 位的怪长度也照收，
   * 与 qrcode 自带的那段解析保持同一口径），其余一律抛错。
   *
   * 与 qrcode 自带解析的两处收紧：只剥**开头**的那个 `#`（它是 `replace('#','')`
   * 会剥掉任意位置的第一个 #），并且强制每一位都是十六进制数字（它是直接
   * `parseInt(str, 16)`，`#zzz` 会静默 parse 成 NaN 再被 `& 255` 抹成纯黑）。
   *
   * @returns {{r:number,g:number,b:number,a:number,hex:string}}
   */
  function parseHexColor(color) {
    if (typeof color === 'number') color = String(color);
    if (typeof color !== 'string') throw new Error(t('err_color_not_string', 'Color should be defined as hex string'));
    var s = color.charAt(0) === '#' ? color.slice(1) : color;
    if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error(invalidHex(color));
    var digits = s.split('');
    if (digits.length < 3 || digits.length === 5 || digits.length > 8) {
      throw new Error(invalidHex(color));
    }
    if (digits.length === 3 || digits.length === 4) {
      digits = digits.reduce(function (acc, c) { return acc.concat([c, c]); }, []);
    }
    if (digits.length === 6) digits = digits.concat(['F', 'F']);
    var v = parseInt(digits.join(''), 16);
    return {
      r: (v >>> 24) & 255,
      g: (v >>> 16) & 255,
      b: (v >>> 8) & 255,
      a: v & 255,
      hex: '#' + digits.slice(0, 6).join('').toLowerCase()
    };
  }

  /**
   * payload + 颜色 → 一份可以直接喂给 QRCode.toCanvas / toDataURL 的参数。
   * 纯逻辑，不碰 canvas，所以可以单测（jsdom 里 canvas 不可用）。
   * @returns {{text:string, width:number, margin:number, errorCorrectionLevel:string,
   *            color:{dark:string,light:string}}}
   */
  function buildQrOptions(opts) {
    var v = validateWifi(opts);
    if (!v.ok) throw new Error(v.reason);
    return {
      text: buildWifiPayload(opts),
      width: 1024,               // 与参考实现一致，固定 1024
      margin: 4,                 // qrcode 自己的默认值
      errorCorrectionLevel: 'M', // 与参考实现一致
      color: {
        dark: parseHexColor((opts && opts.foreground) || '#000000').hex,
        light: parseHexColor((opts && opts.background) || '#ffffff').hex
      }
    };
  }

  /**
   * 本环境有没有可用的 canvas。jsdom（node 侧测试）没装 canvas 实现：
   * HTMLCanvasElement 在，getContext 却只会往控制台喷一句 Not implemented
   * 并返回 null，qrcode 随即在 createImageData 上炸掉。这里拿 ImageData 当判据
   * —— 真实浏览器一定有，没装 canvas 的 jsdom 里没有，且探测本身不产生噪音。
   */
  function canvasAvailable() {
    try {
      return typeof window.ImageData !== 'undefined' &&
        typeof document !== 'undefined' &&
        typeof document.createElement('canvas').getContext === 'function';
    } catch (e) { return false; }
  }

  window.ItTools.register('wifi-qr-code-generator', function (root) {
    var state = {
      encryption: 'WPA',
      ssid: '',
      password: '',
      hidden: false,
      eapMethod: 'PEAP',
      eapIdentity: '',
      eapAnonymous: false,
      eapPhase2Method: 'MSCHAPV2',
      foreground: '#000000',
      background: '#ffffff'
    };

    var status = D.h('p.field-hint');
    var payloadOut = D.h('textarea.layui-textarea', { rows: 4, readonly: 'readonly', spellcheck: 'false' });
    var canvas = D.h('canvas', { style: { width: '220px', height: '220px', maxWidth: '100%' } });
    var downloadBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('download_png', 'Download PNG') });
    var lastPayload = '';

    var encSelect = D.h('select.layui-input', null, ENCRYPTIONS.map(function (e, i) {
      return D.h('option', { value: e.value, text: e.label, selected: i === 1 });
    }));
    encSelect.addEventListener('change', function () {
      state.encryption = encSelect.value;
      syncEapVisibility();
      update();
    });

    var ssidInput = D.h('input.layui-input', { type: 'text', placeholder: t('ph_ssid', 'Your WiFi SSID...') });
    ssidInput.addEventListener('input', function () { state.ssid = ssidInput.value; update(); });

    var hiddenInput = D.h('input', { type: 'checkbox' });
    hiddenInput.addEventListener('change', function () { state.hidden = hiddenInput.checked; update(); });

    var passwordWrap = U.passwordInput({ placeholder: t('ph_password', 'Your WiFi password...') });
    var passwordInput = passwordWrap.querySelector('input');
    passwordInput.addEventListener('input', function () { state.password = passwordInput.value; update(); });

    function selectField(labelText, values, initial, onChange) {
      var sel = D.h('select.layui-input', null, values.map(function (v) {
        return D.h('option', { value: v, text: v, selected: v === initial });
      }));
      sel.addEventListener('change', function () { onChange(sel.value); });
      return U.field(labelText, sel, { left: true, labelWidth: '130px' });
    }

    var eapWrap = D.h('div.field-row', null,
      selectField(t('eap_method', 'EAP method:'), EAP_METHODS, state.eapMethod, function (v) { state.eapMethod = v; update(); }),
      selectField(t('eap_phase2', 'EAP phase 2:'), EAP_PHASE2_METHODS, state.eapPhase2Method, function (v) { state.eapPhase2Method = v; update(); })
    );

    var identityInput = D.h('input.layui-input', { type: 'text', placeholder: t('ph_identity', 'Your EAP identity...') });
    identityInput.addEventListener('input', function () { state.eapIdentity = identityInput.value; update(); });

    var anonInput = D.h('input', { type: 'checkbox' });
    anonInput.addEventListener('change', function () { state.eapAnonymous = anonInput.checked; update(); });

    // 整个 .field 一起隐藏，标签才不会留下一个没有控件的壳
    var identityField = U.field(t('identity', 'Identity:'), D.h('div.input-group', null, identityInput,
      D.h('label.switch', null, anonInput, D.h('span', { text: t('anonymous', 'Anonymous') }))),
      { left: true, labelWidth: '130px' });

    function colorField(labelText, key) {
      var input = D.h('input', { type: 'color', value: state[key] });
      input.addEventListener('input', function () { state[key] = input.value; update(); });
      // 原版这一页的表单项全是左标签、130px、右对齐
      return U.field(labelText, input, { left: true, labelWidth: '130px' });
    }

    function syncEapVisibility() {
      var isEap = state.encryption === 'WPA2-EAP';
      eapWrap.hidden = !isEap;
      identityField.hidden = !isEap;
      passwordWrap.hidden = state.encryption === 'nopass';
    }

    function setStatus(text, isError) {
      status.textContent = text;
      status.style.color = isError ? 'var(--danger, #d93025)' : 'var(--text-muted)';
    }

    function update() {
      var v = validateWifi(state);
      var payload = v.ok ? buildWifiPayload(state) : null;
      lastPayload = payload || '';

      if (!v.ok) setStatus(v.reason, true);
      else if (v.warnings.length) setStatus(v.warnings.join(' '), false);
      else setStatus('');

      payloadOut.value = payload || '';
      downloadBtn.disabled = !payload;

      if (!payload || !canvasAvailable()) return;
      var opts;
      try { opts = buildQrOptions(state); }
      catch (e) { setStatus(e.message, true); return; }
      // qrcode 的绘制在 Promise executor 里是同步跑的，但接口本身返回 Promise，
      // 必须挂上拒绝处理 —— 否则 node 侧会以 unhandledRejection 直接退出进程。
      window.QRCode.toCanvas(canvas, opts.text, opts).catch(function (err) {
        setStatus(String((err && err.message) || err), true);
      });
    }

    downloadBtn.addEventListener('click', function () {
      if (!lastPayload) return;
      var opts;
      try { opts = buildQrOptions(state); } catch (e) { return; }
      window.QRCode.toDataURL(opts.text, opts).then(function (dataUrl) {
        // data URL 只是文本，必须先解回字节再交给 download，否则下到的是
        // 一个「内容是 base64 字符串」的假 PNG
        var bytes = U.base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
        window.ItTools.download('wifi-qr-code.png', new Blob([bytes], { type: 'image/png' }), 'image/png');
      }).catch(function (err) {
        setStatus(String((err && err.message) || err), true);
      });
    });

    // 原版这一页只有**一张** c-card：左边是表单，右边是二维码预览
    // （一个 grid 的两列）。我们拆成两张卡就凭空多出一圈边框。
    root.appendChild(D.h('div.card', null,
      U.field(t('encryption', 'Encryption:'), encSelect, { left: true, labelWidth: '130px' }),
      U.field(t('ssid', 'SSID:'), D.h('div.input-group', null, ssidInput,
        D.h('label.switch', null, hiddenInput, D.h('span', { text: t('hidden_ssid', 'Hidden SSID') }))),
        { left: true, labelWidth: '130px' }),
      U.field(t('password', 'Password:'), passwordWrap, { left: true, labelWidth: '130px' }),
      eapWrap,
      identityField,
      D.h('div.field-row', null,
        colorField(t('foreground', 'Foreground:'), 'foreground'),
        colorField(t('background', 'Background:'), 'background')
      ),
      status,
      U.field(t('qr_code', 'QR code (1024px):'), D.h('div.preview-box', null, canvas), { wide: true }),
      U.field(t('payload', 'Payload:'), payloadOut, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return payloadOut.value; }, t('copy_payload', 'Copy payload')),
        downloadBtn
      )
    ));

    syncEapVisibility();
    update();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['wifi-qr-code-generator'] = {
    escapeWifi: escapeWifi,
    utf8Length: utf8Length,
    normalizeEncryption: normalizeEncryption,
    isValidWepKey: isValidWepKey,
    validateWifi: validateWifi,
    buildWifiPayload: buildWifiPayload,
    parseHexColor: parseHexColor,
    buildQrOptions: buildQrOptions,
    canvasAvailable: canvasAvailable,
    SSID_MAX_BYTES: SSID_MAX_BYTES,
    __cases: function (assert) {
      /* ---- 转义：五个字符，一个都不能漏 ---- */
      assert.eq(escapeWifi('a;b'), 'a\\;b', '分号必须转义，否则会被读成下一个字段');
      assert.eq(escapeWifi('a,b'), 'a\\,b', '逗号必须转义');
      assert.eq(escapeWifi('a:b'), 'a\\:b', '冒号必须转义');
      assert.eq(escapeWifi('a"b'), 'a\\"b', '双引号必须转义');
      assert.eq(escapeWifi('a\\b'), 'a\\\\b', '反斜杠自身必须先转义');
      assert.eq(escapeWifi('My;Net, "x":\\y'), 'My\\;Net\\, \\"x\\"\\:\\\\y', '五个字符一起出现');
      assert.eq(escapeWifi('plain-ssid_123'), 'plain-ssid_123', '普通字符不动');
      assert.eq(escapeWifi(''), '', '空串');
      assert.eq(escapeWifi(null), '', 'null 当空串');
      assert.eq(escapeWifi(undefined), '', 'undefined 当空串');
      assert.eq(escapeWifi('中文 café 🎉'), '中文 café 🎉', '非 ASCII 不需要转义');

      // 转义的正确性用「反解回来等于原串」兜底 —— 只要漏掉任何一个分隔符，
      // 反解就会在第一个未转义的分号处截断。
      function unescapeWifi(s) { return s.replace(/\\(.)/g, '$1'); }
      /** 模拟 ZXing 的两步解析：先按未转义的分号切字段，再把每段反解回来。 */
      function splitPayload(s) {
        var out = [], cur = '';
        for (var i = 0; i < s.length; i++) {
          if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
          if (s[i] === ';') { if (cur) out.push(unescapeWifi(cur)); cur = ''; continue; }
          cur += s[i];
        }
        if (cur) out.push(unescapeWifi(cur));
        return out;
      }
      ['a;b', 'a,b', 'a:b', 'a"b', 'a\\b', '\\;:,', 'x',
        'Café;Bar, "Wi\\Fi": #1', '\\\\;', ';', ',', ':', '"', '\\', ';;,']
        .forEach(function (sample, i) {
          assert.eq(unescapeWifi(escapeWifi(sample)), sample, '转义-反解往返 样本' + i);
        });

      /* ---- payload 拼装 ---- */
      assert.eq(buildWifiPayload({ ssid: 'MyNet', password: 'secret', encryption: 'WPA' }),
        'WIFI:T:WPA;S:MyNet;P:secret;;', 'WPA 基本形态');
      assert.eq(buildWifiPayload({ ssid: 'MyNet', password: 'secret', encryption: 'WPA', hidden: true }),
        'WIFI:T:WPA;S:MyNet;P:secret;H:true;;', '勾了隐藏 SSID 就多一个 H:true');
      assert.eq(buildWifiPayload({ ssid: 'MyNet', password: 'pass', encryption: 'WEP', hidden: true }),
        'WIFI:T:WEP;S:MyNet;P:pass;H:true;;', 'WEP 同构');
      assert.eq(buildWifiPayload({ ssid: 'MyNet', encryption: 'nopass' }),
        'WIFI:T:nopass;S:MyNet;;', '无密码不带 P 字段');
      // ↓ 原版在这里把 hidden 丢了
      assert.eq(buildWifiPayload({ ssid: 'MyNet', encryption: 'nopass', hidden: true }),
        'WIFI:T:nopass;S:MyNet;H:true;;', '【原版的 bug】nopass 也必须保留 H:true');

      /* ---- WPA3（上游 #1479）---- */
      // ZXing 认的是 T:SAE（WPA3-only），不是上游那个 T:WPA3
      assert.eq(buildWifiPayload({ ssid: 'MyNet', password: 'secret', encryption: 'SAE' }),
        'WIFI:T:SAE;S:MyNet;P:secret;;', 'WPA3-only 用 T:SAE');
      assert.eq(buildWifiPayload({ ssid: 'MyNet', password: 'secret', encryption: 'SAE', hidden: true }),
        'WIFI:T:SAE;S:MyNet;P:secret;H:true;;', 'WPA3-only 也能带隐藏标志');
      // 混合模式（WPA2 + WPA3）沿用 T:WPA
      assert.eq(buildWifiPayload({ ssid: 'MyNet', password: 'secret', encryption: 'WPA' }),
        'WIFI:T:WPA;S:MyNet;P:secret;;', '混合模式仍是 T:WPA');
      // 上游那个 T:WPA3 是 ZXing 不认的值，别写进去
      assert(buildWifiPayload({ ssid: 'MyNet', password: 'secret', encryption: 'WPA3' }) === null,
        'T:WPA3 不是合法取值，直接判非法');
      assert.eq(normalizeEncryption('SAE'), 'SAE', 'SAE 在名单里');
      assert.eq(normalizeEncryption('WPA3'), null, 'WPA3 不是 ZXing 的取值');
      // WPA3-only 也要口令
      assert.eq(validateWifi({ ssid: 'MyNet', encryption: 'SAE' }).ok, false, 'SAE 没有口令不行');
      assert(/needs a password/.test(validateWifi({ ssid: 'MyNet', encryption: 'SAE' }).reason),
        '并说明缺的是口令');

      // 转义要一路透传到最终 payload 里
      assert.eq(buildWifiPayload({ ssid: 'a;b', password: 'p;w', encryption: 'WPA' }),
        'WIFI:T:WPA;S:a\\;b;P:p\\;w;;', 'SSID 与密码里的分号都被转义');
      assert.eq(buildWifiPayload({ ssid: 'Caf"e;1', password: 'x:y,z', encryption: 'WPA' }),
        'WIFI:T:WPA;S:Caf\\"e\\;1;P:x\\:y\\,z;;', '引号/分号/冒号/逗号全都转义');
      var p = buildWifiPayload({ ssid: 'x;y', password: 'a', encryption: 'WPA', hidden: true });
      assert(p.indexOf('WIFI:T:WPA;') === 0, 'T 是第一个字段');
      assert(p.indexOf('H:false') < 0, '不勾隐藏时绝不写 H:false');
      // 字段切分必须认得转义：先按未转义的分号切开、再把成对的转义符粘回去，
      // 得到的字段数才与「SSID 里有一个分号」之前一致
      assert.eq(splitPayload(buildWifiPayload({ ssid: 'MyNet', password: 'a', encryption: 'WPA', hidden: true })),
        ['WIFI:T:WPA', 'S:MyNet', 'P:a', 'H:true'], '无转义时是 4 个字段');
      assert.eq(splitPayload(p),
        ['WIFI:T:WPA', 'S:x;y', 'P:a', 'H:true'], 'SSID 里的分号不会把字段切开');

      /* ---- WPA2-EAP ---- */
      assert.eq(buildWifiPayload({
        ssid: 'Campus', password: 'hunter22', encryption: 'WPA2-EAP',
        eapMethod: 'PEAP', eapPhase2Method: 'MSCHAPV2', eapIdentity: 'alice'
      }), 'WIFI:T:WPA2-EAP;S:Campus;P:hunter22;E:PEAP;PH2:MSCHAPV2;I:alice;;', 'EAP 全字段');
      assert.eq(buildWifiPayload({
        ssid: 'Campus', password: 'hunter22', encryption: 'WPA2-EAP',
        eapMethod: 'TLS', eapPhase2Method: 'None', eapAnonymous: true
      }), 'WIFI:T:WPA2-EAP;S:Campus;P:hunter22;E:TLS;A:anon;;', '匿名 → A:anon；phase2 为 None 时不写');
      assert.eq(buildWifiPayload({
        ssid: 'a;b', password: 'p', encryption: 'WPA2-EAP', eapMethod: 'GTC',
        eapIdentity: 'do;e\\r', hidden: true
      }), 'WIFI:T:WPA2-EAP;S:a\\;b;P:p;E:GTC;I:do\\;e\\\\r;H:true;;', 'EAP 身份也要转义');

      /* ---- 返回 null 的情形（非法输入）---- */
      assert.eq(buildWifiPayload({ ssid: '', password: 'p', encryption: 'WPA' }), null, '空 SSID');
      assert.eq(buildWifiPayload({ ssid: '   ', password: 'p', encryption: 'WPA' }), null, '纯空白 SSID（原版会放行）');
      assert.eq(buildWifiPayload({ ssid: 'x', password: '', encryption: 'WPA' }), null, 'WPA 没有密码');
      assert.eq(buildWifiPayload({ ssid: 'x', password: '', encryption: 'WEP' }), null, 'WEP 没有密码');
      assert.eq(buildWifiPayload({ ssid: 'x', password: 'p', encryption: 'WPA3' }), null, '名单外的加密方式');
      assert.eq(buildWifiPayload({ ssid: 'x', password: 'p', encryption: '' }), null, '加密方式为空');
      assert.eq(buildWifiPayload({ ssid: 'x', password: 'p', encryption: 'wpa' }), null, '加密方式大小写不匹配');
      assert.eq(buildWifiPayload({ ssid: 'x', password: 'p', encryption: 'WPA2-EAP', eapMethod: 'PEAP', eapPhase2Method: 'MSCHAPV2' }),
        null, 'EAP 既没有身份也没勾匿名');
      assert.eq(buildWifiPayload({ ssid: 'x', password: 'p', encryption: 'WPA2-EAP', eapMethod: 'PEAP', eapPhase2Method: 'None' }),
        null, 'PEAP 缺 phase 2');
      assert.eq(buildWifiPayload({ ssid: 'x', password: 'p', encryption: 'WPA2-EAP', eapMethod: 'NOPE' }),
        null, 'EAP 方法不在名单里');
      // SSID 的 32 字节上限是按 UTF-8 算的
      assert(buildWifiPayload({ ssid: 'x'.repeat(32), password: 'password', encryption: 'WPA' }),
        '32 字节 SSID 放行');
      assert.eq(buildWifiPayload({ ssid: 'x'.repeat(33), password: 'password', encryption: 'WPA' }), null, '33 字节 SSID 超限');
      assert(buildWifiPayload({ ssid: '字'.repeat(10), password: 'password', encryption: 'WPA' }),
        '10 个汉字 = 30 字节，放行');
      assert.eq(buildWifiPayload({ ssid: '字'.repeat(16), password: 'password', encryption: 'WPA' }), null,
        '16 个汉字 = 48 字节，超限');

      /* ---- utf8Length ---- */
      assert.eq(utf8Length(''), 0, '空串 0 字节');
      assert.eq(utf8Length('abc'), 3, 'ASCII');
      assert.eq(utf8Length('é'), 2, '2 字节字符');
      assert.eq(utf8Length('中'), 3, '3 字节字符');
      assert.eq(utf8Length('🎉'), 4, '代理对算 4 字节（不是两个 4 字节）');
      assert.eq(utf8Length('a中é🎉'), 1 + 3 + 2 + 4, '混合');

      /* ---- normalizeEncryption / WEP 密钥 ---- */
      assert.eq(normalizeEncryption('WPA'), 'WPA', '命中名单');
      assert.eq(normalizeEncryption(' nopass '), 'nopass', '去空白后命中');
      assert.eq(normalizeEncryption('WPA3'), null, '未命中');
      assert.eq(normalizeEncryption(null), null, 'null');
      assert.eq(isValidWepKey('abcde'), true, 'WEP 5 字符');
      assert.eq(isValidWepKey('abcdefghijklm'), true, 'WEP 13 字符');
      assert.eq(isValidWepKey('0123456789'), true, 'WEP 10 位十六进制');
      assert.eq(isValidWepKey('0123456789012345678901234f'), true, 'WEP 26 位十六进制');
      assert.eq(isValidWepKey('abc'), false, 'WEP 3 字符不合法');
      assert.eq(isValidWepKey('012345678'), false, '9 位十进制既不是 10 位十六进制也不是 5/13 字符');

      /* ---- validateWifi 的错误原因与提醒 ---- */
      var v = validateWifi({ ssid: '', password: 'password', encryption: 'WPA' });
      assert(v.ok === false && v.reason.indexOf('SSID') >= 0, '空 SSID 给出可读原因');
      v = validateWifi({ ssid: 'x', password: 'short', encryption: 'WPA' });
      assert(v.ok === true, '短密码不阻断（只是提醒）');
      assert.eq(v.warnings.length, 1, 'WPA 口令不足 8 位给一条提醒');
      assert(v.warnings[0].indexOf('8') >= 0, '提醒里带上长度区间');
      assert.eq(validateWifi({ ssid: 'x', password: 'p'.repeat(64), encryption: 'WPA' }).warnings.length,
        1, 'WPA 口令超过 63 位也给提醒');
      assert.eq(validateWifi({ ssid: 'x', password: 'password', encryption: 'WPA' }).warnings.length, 0, '合规口令没有提醒');
      assert.eq(validateWifi({ ssid: 'x', password: 'abcde', encryption: 'WEP' }).warnings.length, 0, 'WEP 5 位合法');
      assert.eq(validateWifi({ ssid: 'x', password: 'abc', encryption: 'WEP' }).warnings.length, 1, 'WEP 3 位给提醒');
      assert.eq(validateWifi({ ssid: 'x', encryption: 'nopass' }).warnings.length, 0, '无密码没有提醒');
      assert.eq(validateWifi(undefined).ok, false, '传 undefined 不炸，返回校验失败');

      /* ---- parseHexColor ---- */
      assert.eq(parseHexColor('#000000ff'), { r: 0, g: 0, b: 0, a: 255, hex: '#000000' }, '8 位带透明度');
      assert.eq(parseHexColor('#fff'), { r: 255, g: 255, b: 255, a: 255, hex: '#ffffff' }, '3 位 shorthand');
      assert.eq(parseHexColor('#1234'), { r: 17, g: 34, b: 51, a: 68, hex: '#112233' }, '4 位 shorthand 带 alpha');
      assert.eq(parseHexColor('#ffffff00'), { r: 255, g: 255, b: 255, a: 0, hex: '#ffffff' }, '全透明');
      assert.eq(parseHexColor('#AABBCC'), { r: 170, g: 187, b: 204, a: 255, hex: '#aabbcc' }, 'hex 统一小写');
      assert.eq(parseHexColor('ff0000'), { r: 255, g: 0, b: 0, a: 255, hex: '#ff0000' }, '省略 # 也认');
      // qrcode 自带的解析会把 #zzz 静默 parse 成 NaN 再抹成纯黑，这里必须拦住
      ['red', '#ff', '#fffff', '#zzz', '#fffffffff', '', null, 42].forEach(function (bad, i) {
        var threw = false;
        try { parseHexColor(bad); } catch (e) { threw = true; }
        assert(threw, '非法颜色 ' + JSON.stringify(bad) + ' 应抛错（样本' + i + '）');
      });

      /* ---- buildQrOptions ---- */
      var o = buildQrOptions({ ssid: 'MyNet', password: 'secret', encryption: 'WPA', hidden: true, foreground: '#000000', background: '#ffffff' });
      assert.eq(o.text, 'WIFI:T:WPA;S:MyNet;P:secret;H:true;;', 'payload 进 text');
      assert.eq(o.width, 1024, '宽度与参考实现一致');
      assert.eq(o.margin, 4, 'margin 默认 4（qrcode 的默认值）');
      assert.eq(o.errorCorrectionLevel, 'M', '容错级别与参考实现一致');
      assert.eq(o.color, { dark: '#000000', light: '#ffffff' }, '颜色归一成 6 位 hex');
      assert.eq(buildQrOptions({ ssid: 'MyNet', encryption: 'nopass' }).color,
        { dark: '#000000', light: '#ffffff' }, '颜色缺省时回落到黑白');
      var threw = false;
      try { buildQrOptions({ ssid: '' }); } catch (e) { threw = true; }
      assert(threw, 'payload 拼不出来时 buildQrOptions 抛错');
      threw = false;
      try { buildQrOptions({ ssid: 'x', encryption: 'nopass', foreground: 'red' }); } catch (e) { threw = true; }
      assert(threw, '非法前景色抛错');

      /* ---- canvas 能力探测 ---- */
      assert.eq(typeof canvasAvailable(), 'boolean', 'canvasAvailable 永远给布尔值');
    }
  };
})();