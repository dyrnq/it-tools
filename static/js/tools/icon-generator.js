/* ==========================================================================
   应用图标生成器（icon-generator）

   一张图 -> 一整套应用图标（PWA / Android / iOS 各平台要的尺寸），
   顺带生成 manifest.webmanifest，并把全部产物打成 ZIP 下载。

   参考实现：上游 PR #1740（src/tools/icon-generator/，it-tools, GPLv3）。
   与原版的差别（原版这几处要么依赖外部库，要么会真的坏掉）：
   1. 原版用 jszip 打包、用 dom-to-image-more 导 PNG —— 这里两样都不 vendor：
      ZIP 自己写（只做 STORE，见 createZip 上面的注释），PNG 直接走 canvas
      （上游导 PNG 那一步最终也是画进 canvas 再 toDataURL）。
   2. 原版的 manifest 叫 manifest.json；这里叫 manifest.webmanifest ——
      浏览器按扩展名认这个后缀（application/manifest+json），改名会影响安装。
   3. 原版的「自定义尺寸」是一个数字输入框 + 「添加」按钮，预设则要一个个点
      按钮叠加进去；这里预设是复选框、自定义尺寸是一个逗号分隔的输入框，
      最终尺寸 = 预设 ∪ 自定义（走同一套归一，见 currentSizes）。
   4. 原版的 sanitizeBaseName 只把非法字符换成 '-'，于是 "///" 会变成 "-"
      这种没法当文件名的结果；这里额外收一下连续与首尾的横线，空则回落到 icon。
   5. 原版把 canvas 摆在页面上、挂载时就把图画一遍；这里 canvas 只在点
      「生成」之后才创建 —— 挂载时碰 canvas 会在没有 canvas 实现的
      环境（node 侧的 jsdom）里抛异常，工具页直接打不开。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('icon-generator');

  /* ---------- 纯逻辑：尺寸 ---------- */

  /**
   * 各平台要的图标尺寸。
   * 数字是照抄上游的 —— 各平台的商店/安装器就是按这张表来挑图的，
   * 少一个尺寸就装不上或者显示成低清。
   */
  var ICON_PRESETS = [
    { key: 'pwa', sizes: [72, 96, 128, 144, 152, 192, 384, 512] },
    { key: 'android', sizes: [48, 72, 96, 144, 192, 512] },
    { key: 'ios', sizes: [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024] }
  ];

  /** 自定义尺寸的上限：canvas 一边 2048px 是各浏览器都还稳的尺寸，
   *  再大生成的 PNG 体积会失控（用户多半是手滑打了个 100000）。 */
  var MAX_ICON_SIZE = 2048;

  /**
   * 尺寸集合归一：取整 → 丢掉非正数与非有限值 → 去重 → 升序。
   * 为什么要归一：预设之间大量重叠（72/96/144/192/512 三个预设都有），
   * 自定义尺寸也可能跟预设撞上；不归一就会给同一个尺寸生成两张 PNG，
   * ZIP 里文件名还一样（后一个把前一个盖掉），用户根本不知道少了哪张。
   * @param {number[]} sizes
   * @returns {number[]}
   */
  function normalizeSizes(sizes) {
    var seen = {};
    var out = [];
    (sizes || []).forEach(function (size) {
      var n = Math.floor(Number(size));
      // Number('') 是 0、Number('abc') 是 NaN —— 两种都得挡掉
      if (!isFinite(n) || n <= 0) return;
      if (seen[n]) return;
      seen[n] = true;
      out.push(n);
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /**
   * 多个预设的尺寸并集（归一后）。
   * @param {string[]} presetKeys
   * @returns {number[]}
   */
  function getPresetSizes(presetKeys) {
    var picked = [];
    (presetKeys || []).forEach(function (key) {
      for (var i = 0; i < ICON_PRESETS.length; i++) {
        if (ICON_PRESETS[i].key === key) picked = picked.concat(ICON_PRESETS[i].sizes);
      }
    });
    return normalizeSizes(picked);
  }

  /**
   * 解析自定义尺寸输入（逗号或空白分隔，如 "64,128,256"）。
   * 非法项直接丢掉而不是报错：这里是尺寸清单，不是需要精确校验的表单。
   * @param {string} text
   * @returns {number[]}
   */
  function parseCustomSizes(text) {
    var parts = String(text == null ? '' : text).split(/[,\s]+/);
    var out = [];
    parts.forEach(function (part) {
      if (!part) return;
      var n = Math.floor(Number(part));
      if (!isFinite(n) || n <= 0) return;
      if (n > MAX_ICON_SIZE) n = MAX_ICON_SIZE;
      out.push(n);
    });
    return normalizeSizes(out);
  }

  /* ---------- 纯逻辑：文件名 ---------- */

  /**
   * 文件名基名清洗：去掉各系统都不允许的字符，空白转 '-',空则回落到 'icon'。
   * 非法字符清单跟 Windows 一致（<>:"/\|?*），这七个在 ZIP 目录里同样不能出现。
   * @param {string} baseName
   * @returns {string}
   */
  function sanitizeBaseName(baseName) {
    var s = String(baseName == null ? '' : baseName).trim();
    // 控制字符也一并换掉：它们在 ZIP 的目录项里能过，但解压到 Windows 上
    // 会变成一堆看不明白的文件名
    s = s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-');
    s = s.replace(/\s+/g, '-');
    // 换完字符常常留下一串 '-'（"a//b" -> "a-b" 之外的 "a---b"），
    // 首尾的横线更是纯噪声：收掉，名字才干净。
    s = s.replace(/-{2,}/g, '-').replace(/^-+/, '').replace(/-+$/, '');
    return s || 'icon';
  }

  /**
   * 图标文件名：<基名>-<边长>x<边长>.png
   * @param {number} size
   * @param {string} [baseName]
   * @returns {string}
   */
  function buildIconFilename(size, baseName) {
    var safe = sanitizeBaseName(baseName);
    return safe + '-' + size + 'x' + size + '.png';
  }

  /* ---------- 纯逻辑：绘制区域 ---------- */

  /**
   * 算源图在目标正方形里的绘制区域（居中）。
   * cover  取 max 缩放：短边贴满正方形，长边溢出被裁掉（不留白）。
   * contain 取 min 缩放：长边贴满正方形，短边留白。
   * @param {{sourceWidth:number,sourceHeight:number,targetSize:number,fitMode:string}} opts
   * @returns {{x:number,y:number,width:number,height:number}}
   */
  function calculateDrawArea(opts) {
    opts = opts || {};
    var sw = Number(opts.sourceWidth);
    var sh = Number(opts.sourceHeight);
    var target = Number(opts.targetSize);
    if (!isFinite(sw) || !isFinite(sh) || sw <= 0 || sh <= 0 || !isFinite(target) || target <= 0) {
      var fallback = target > 0 ? target : 0;
      return { x: 0, y: 0, width: fallback, height: fallback };
    }
    var scale = opts.fitMode === 'cover'
      ? Math.max(target / sw, target / sh)
      : Math.min(target / sw, target / sh);
    var w = sw * scale;
    var h = sh * scale;
    return { x: (target - w) / 2, y: (target - h) / 2, width: w, height: h };
  }

  /* ---------- 纯逻辑：manifest ---------- */

  /**
   * 生成 manifest.webmanifest 的内容。
   * icons 里每项都要有 sizes（"192x192" 这种）和 type，浏览器据此挑图。
   * @param {{appName:string,icons:{filename:string,size:number}[],description?:string,
   *          startUrl?:string,scope?:string,lang?:string,
   *          backgroundColor?:string,themeColor?:string}} opts
   * @returns {string} JSON 文本
   */
  function createWebAppManifest(opts) {
    opts = opts || {};
    var appName = String(opts.appName == null ? '' : opts.appName);
    var icons = opts.icons || [];
    var startUrl = opts.startUrl || '/';
    var scope = opts.scope || '/';
    var lang = opts.lang || 'en';
    var backgroundColor = opts.backgroundColor || '#ffffff';
    var themeColor = opts.themeColor || '#ffffff';
    return JSON.stringify({
      id: startUrl,
      name: appName,
      short_name: appName,
      description: opts.description || (appName + ' icons'),
      lang: lang,
      start_url: startUrl,
      scope: scope,
      display: 'standalone',
      background_color: backgroundColor,
      theme_color: themeColor,
      icons: icons.map(function (icon) {
        return {
          src: icon.filename,
          sizes: icon.size + 'x' + icon.size,
          type: 'image/png',
          purpose: 'any maskable'
        };
      })
    }, null, 2);
  }

  /* ---------- 纯逻辑：ZIP 写入器 ----------
     只做 STORE（不压缩）这一种方式。
     为什么不上 DEFLATE：PNG 本身已经是 deflate 过的，再压一遍几乎不省体积，
     却要背上几百行压缩实现（还得自带 inflate 兼容性问题）；
     而 ZIP 的 STORE 方式对任何解压工具都是标准支持的，浏览器一生成就能下载。
     代价是 manifest 文本在 ZIP 里是明文 —— 那是给人看的文件，本来就该能直接读。 */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  /**
   * CRC-32（IEEE 多项式），ZIP 用它校验每个文件的内容。
   * @param {Uint8Array} bytes
   * @returns {number}
   */
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** ZIP 里的时间是 MS-DOS 格式（本地时间），不是 Unix 时间戳。 */
  function dosDateTime(date) {
    var year = date.getFullYear();
    // DOS 纪元从 1980 年起，早于它的年份没有合法表示
    if (year < 1980) return { time: 0, date: 0x0021 };
    return {
      time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF,
      date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF
    };
  }

  /**
   * 写一个 ZIP（STORE）。
   * 结构：每个文件一段本地文件头 + 数据，全部文件之后是中央目录，
   * 最后是中央目录结束记录（EOCD）。
   * @param {{name:string,data:Uint8Array}[]} entries
   * @returns {Uint8Array}
   */
  function createZip(entries) {
    var list = [];
    var offset = 0;
    var centralSize = 0;
    var i;

    for (i = 0; i < entries.length; i++) {
      var nameBytes = U.utf8Bytes(entries[i].name);
      var data = entries[i].data || new Uint8Array(0);
      list.push({
        nameBytes: nameBytes,
        data: data,
        crc: crc32(data),
        offset: offset
      });
      offset += 30 + nameBytes.length + data.length;
      centralSize += 46 + nameBytes.length;
    }

    var centralOffset = offset;
    var buf = new Uint8Array(centralOffset + centralSize + 22);
    var dv = new DataView(buf.buffer);
    var pos = 0;
    var stamp = dosDateTime(new Date());

    for (i = 0; i < list.length; i++) {
      var r = list[i];
      dv.setUint32(pos, 0x04034b50, true); pos += 4;   // 本地文件头签名
      dv.setUint16(pos, 20, true); pos += 2;          // 解压所需版本 2.0
      dv.setUint16(pos, 0x0800, true); pos += 2;      // 通用标志位：文件名按 UTF-8 解读
      dv.setUint16(pos, 0, true); pos += 2;           // 压缩方式 0 = STORE
      dv.setUint16(pos, stamp.time, true); pos += 2;
      dv.setUint16(pos, stamp.date, true); pos += 2;
      dv.setUint32(pos, r.crc, true); pos += 4;
      dv.setUint32(pos, r.data.length, true); pos += 4;  // 压缩后大小
      dv.setUint32(pos, r.data.length, true); pos += 4;  // 原始大小
      dv.setUint16(pos, r.nameBytes.length, true); pos += 2;
      dv.setUint16(pos, 0, true); pos += 2;           // 扩展字段长度
      buf.set(r.nameBytes, pos); pos += r.nameBytes.length;
      buf.set(r.data, pos); pos += r.data.length;
    }

    for (i = 0; i < list.length; i++) {
      var c = list[i];
      dv.setUint32(pos, 0x02014b50, true); pos += 4;   // 中央目录项签名
      dv.setUint16(pos, 20, true); pos += 2;          // 生成版本
      dv.setUint16(pos, 20, true); pos += 2;          // 解压所需版本
      dv.setUint16(pos, 0x0800, true); pos += 2;
      dv.setUint16(pos, 0, true); pos += 2;
      dv.setUint16(pos, stamp.time, true); pos += 2;
      dv.setUint16(pos, stamp.date, true); pos += 2;
      dv.setUint32(pos, c.crc, true); pos += 4;
      dv.setUint32(pos, c.data.length, true); pos += 4;
      dv.setUint32(pos, c.data.length, true); pos += 4;
      dv.setUint16(pos, c.nameBytes.length, true); pos += 2;
      dv.setUint16(pos, 0, true); pos += 2;           // 扩展字段长度
      dv.setUint16(pos, 0, true); pos += 2;           // 注释长度
      dv.setUint16(pos, 0, true); pos += 2;           // 起始磁盘号
      dv.setUint16(pos, 0, true); pos += 2;           // 内部属性
      dv.setUint32(pos, 0, true); pos += 4;           // 外部属性
      dv.setUint32(pos, c.offset, true); pos += 4;    // 本地头在文件里的偏移
      buf.set(c.nameBytes, pos); pos += c.nameBytes.length;
    }

    dv.setUint32(pos, 0x06054b50, true); pos += 4;     // EOCD 签名
    dv.setUint16(pos, 0, true); pos += 2;             // 当前磁盘号
    dv.setUint16(pos, 0, true); pos += 2;             // 中央目录所在磁盘号
    dv.setUint16(pos, list.length, true); pos += 2;   // 本盘条目数
    dv.setUint16(pos, list.length, true); pos += 2;   // 总条目数
    dv.setUint32(pos, centralSize, true); pos += 4;
    dv.setUint32(pos, centralOffset, true); pos += 4;
    dv.setUint16(pos, 0, true); pos += 2;             // 注释长度
    return buf;
  }

  /**
   * 最小 ZIP 解析器 —— 只为单测把刚写出来的字节解回来对账，
   * 顺带在运行时也能校验一下打包结果不是坏的。
   * @param {Uint8Array} bytes
   * @returns {{entries:{name:string,method:number,crc:number,size:number,data:Uint8Array}[]}}
   */
  function readZip(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    var i;
    for (i = bytes.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP 里找不到中央目录结束记录');
    var count = dv.getUint16(eocd + 10, true);
    var pos = dv.getUint32(eocd + 16, true);
    var out = [];
    for (var j = 0; j < count; j++) {
      if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error('中央目录项签名不对');
      var method = dv.getUint16(pos + 10, true);
      var crc = dv.getUint32(pos + 16, true);
      var size = dv.getUint32(pos + 24, true);
      var nameLen = dv.getUint16(pos + 28, true);
      var extraLen = dv.getUint16(pos + 30, true);
      var commentLen = dv.getUint16(pos + 32, true);
      var localOffset = dv.getUint32(pos + 42, true);
      var name = U.utf8Decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      var localNameLen = dv.getUint16(localOffset + 26, true);
      var localExtraLen = dv.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + localNameLen + localExtraLen;
      out.push({
        name: name,
        method: method,
        crc: crc,
        size: size,
        data: bytes.subarray(dataStart, dataStart + size)
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: out };
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('icon-generator', function (root) {
    var state = {
      sourceDataUrl: '',
      presets: { pwa: true, android: false, ios: false },
      customSizes: '',
      fitMode: 'cover',
      baseName: 'icon',
      appName: 'My App',
      appDescription: '',
      startUrl: '/',
      scope: '/',
      lang: 'en',
      backgroundColor: '#ffffff',
      themeColor: '#ffffff',
      icons: []
    };

    /* 预设标签必须是字面量键 —— 键拼出来的话语言包对账那套工具扫不到，
       中文界面里这条就会悄悄退回英文。 */
    var PRESET_LABELS = {
      pwa: t('preset_pwa', 'PWA'),
      android: t('preset_android', 'Android'),
      ios: t('preset_ios', 'iOS')
    };

    var sizesSummary = D.h('p.field-hint');
    var statusLine = D.h('p.field-hint');
    var previewBox = D.h('div.preview-box');
    var resultsBody = D.h('div.output-body');
    var manifestOut = D.h('textarea.layui-textarea', { rows: 10, readonly: true });

    var generateBtn = D.h('button.layui-btn', {
      type: 'button',
      text: t('generate', 'Generate icons'),
      onclick: function () { generate(); }
    });
    var zipBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button',
      text: t('download_zip', 'Download ZIP'),
      onclick: function () { downloadZip(); }
    });
    zipBtn.disabled = true;

    /* ---- 尺寸来源 ---- */

    var presetSwitches = ICON_PRESETS.map(function (preset) {
      var box = D.h('input', { type: 'checkbox', checked: state.presets[preset.key] });
      box.addEventListener('change', function () {
        state.presets[preset.key] = box.checked;
        updateSizes();
      });
      return D.h('label.switch', null, box, D.h('span', { text: PRESET_LABELS[preset.key] }));
    });

    var customInput = D.h('input.layui-input', {
      type: 'text',
      placeholder: t('custom_sizes_ph', '64,128,256')
    });
    customInput.addEventListener('input', function () {
      state.customSizes = customInput.value;
      updateSizes();
    });

    var fitRadios = [
      { key: 'cover', label: t('fit_cover', 'Cover (fill the square, crop the overflow)') },
      { key: 'contain', label: t('fit_contain', 'Contain (fit the whole image inside the square)') }
    ].map(function (item) {
      var radio = D.h('input', {
        type: 'radio', name: 'icon-generator-fit', value: item.key,
        checked: item.key === state.fitMode
      });
      radio.addEventListener('change', function () {
        state.fitMode = item.key;
      });
      return D.h('label.switch', null, radio, D.h('span', { text: item.label }));
    });

    var baseNameInput = D.h('input.layui-input', { type: 'text', value: state.baseName });
    baseNameInput.addEventListener('input', function () {
      state.baseName = baseNameInput.value;
      updateSizes();
    });

    /** 当前要生成的尺寸：预设 ∪ 自定义。 */
    function currentSizes() {
      var keys = [];
      ICON_PRESETS.forEach(function (preset) {
        if (state.presets[preset.key]) keys.push(preset.key);
      });
      return normalizeSizes(getPresetSizes(keys).concat(parseCustomSizes(state.customSizes)));
    }

    function updateSizes() {
      var sizes = currentSizes();
      sizesSummary.textContent = t('selected_sizes', 'Sizes to generate: {sizes}')
        .replace('{sizes}', function () { return sizes.length ? sizes.join(', ') : '-'; });
    }

    /* ---- 源图 ---- */

    var fileInput = D.h('input', { type: 'file', accept: 'image/*', style: { flex: '1 1 auto', minWidth: '0' } });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (file) readFile(file);
    });

    function readFile(file) {
      var reader = new FileReader();
      reader.onload = function () {
        state.sourceDataUrl = String(reader.result || '');
        // 文件名还没被用户改过的话，就拿源文件名当基名，省一次手输
        if (state.baseName === 'icon') {
          state.baseName = sanitizeBaseName(String(file.name || '').replace(/\.[^.]*$/, ''));
          baseNameInput.value = state.baseName;
          updateSizes();
        }
        showPreview();
        setStatus('');
      };
      reader.onerror = function () {
        setStatus(t('err_read_file', 'Failed to read the file.'), true);
      };
      reader.readAsDataURL(file);
    }

    function showPreview() {
      D.clear(previewBox);
      if (!state.sourceDataUrl) {
        previewBox.appendChild(D.h('p.field-hint', { text: t('no_image', 'No image selected yet.') }));
        return;
      }
      previewBox.appendChild(D.h('img', {
        src: state.sourceDataUrl,
        alt: t('preview_alt', 'Source image preview'),
        style: { maxWidth: '100%', maxHeight: '320px' }
      }));
    }

    /* ---- manifest 字段 ---- */

    function textField(labelText, key, opts) {
      var input = D.h('input.layui-input', { type: 'text', value: state[key] });
      input.addEventListener('input', function () {
        state[key] = input.value;
        updateManifest();
      });
      return U.field(labelText, input, opts);
    }

    function colorField(labelText, key) {
      var input = D.h('input', { type: 'color', value: state[key] });
      input.addEventListener('input', function () {
        state[key] = input.value;
        updateManifest();
      });
      return U.field(labelText, input);
    }

    var descriptionInput = D.h('input.layui-input', { type: 'text', value: state.appDescription });
    descriptionInput.addEventListener('input', function () {
      state.appDescription = descriptionInput.value;
      updateManifest();
    });

    /** manifest 里的图标清单跟着已生成的图标走。 */
    function manifestJson() {
      return createWebAppManifest({
        appName: state.appName.trim() || sanitizeBaseName(state.baseName),
        description: state.appDescription,
        startUrl: state.startUrl,
        scope: state.scope,
        lang: state.lang,
        backgroundColor: state.backgroundColor,
        themeColor: state.themeColor,
        icons: state.icons.map(function (icon) {
          return { filename: icon.filename, size: icon.size };
        })
      });
    }

    function updateManifest() {
      manifestOut.value = manifestJson();
    }

    /* ---- 生成 ---- */

    function setStatus(text, isError) {
      statusLine.textContent = text || '';
      statusLine.classList.toggle('is-error', !!isError);
    }

    /** data URL -> 字节。ZIP 里要的是真字节，不是 base64 文本。 */
    function dataUrlToBytes(dataUrl) {
      var comma = String(dataUrl).indexOf(',');
      return U.base64ToBytes(String(dataUrl).slice(comma + 1));
    }

    function loadImage(src) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error(t('err_load_image', 'Failed to load the image.'))); };
        img.src = src;
      });
    }

    /**
     * 把源图画成边长 size 的 PNG。
     * canvas 只在这里创建 —— 挂载阶段碰 canvas 在没有 canvas 2D 实现的
     * 环境里会直接抛异常，工具页会打不开。
     */
    function renderIcon(img, size, fitMode) {
      var canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      var ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(t('err_no_canvas', 'This browser cannot export PNG images.'));
      var area = calculateDrawArea({
        sourceWidth: img.naturalWidth || img.width,
        sourceHeight: img.naturalHeight || img.height,
        targetSize: size,
        fitMode: fitMode
      });
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, area.x, area.y, area.width, area.height);
      return canvas.toDataURL('image/png');
    }

    function generate() {
      if (!state.sourceDataUrl) {
        setStatus(t('err_no_image', 'Choose an image first.'), true);
        return;
      }
      var sizes = currentSizes();
      if (!sizes.length) {
        setStatus(t('err_no_size', 'Pick at least one size.'), true);
        return;
      }
      setStatus(t('status_generating', 'Generating…'));
      loadImage(state.sourceDataUrl).then(function (img) {
        var icons = sizes.map(function (size) {
          return {
            size: size,
            filename: buildIconFilename(size, state.baseName),
            dataUrl: renderIcon(img, size, state.fitMode)
          };
        });
        state.icons = icons;
        renderResults();
        updateManifest();
        zipBtn.disabled = false;
        setStatus(t('status_generated', 'Generated {count} icons.').replace('{count}', function () {
          return String(icons.length);
        }));
      }).catch(function (err) {
        setStatus(String((err && err.message) || err), true);
      });
    }

    function renderResults() {
      D.clear(resultsBody);
      if (!state.icons.length) {
        resultsBody.appendChild(D.h('p.field-hint', { text: t('no_icons', 'Nothing generated yet.') }));
        return;
      }
      var grid = D.h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: '12px'
        }
      });
      state.icons.forEach(function (icon) {
        grid.appendChild(D.h('div', {
          style: {
            border: '1px solid var(--border-card)', borderRadius: '6px',
            padding: '10px', textAlign: 'center'
          }
        },
          D.h('img', {
            src: icon.dataUrl, alt: icon.filename,
            style: { width: '96px', height: '96px', objectFit: 'contain', maxWidth: '100%' }
          }),
          D.h('div', { text: icon.size + 'x' + icon.size, style: { fontSize: '13px', margin: '6px 0' } }),
          // 单个图标直接给 data URL：浏览器会把 <a download> 的内容存成文件，
          // 不用先过 Blob/ObjectURL 那一条路
          D.h('a.layui-btn.layui-btn-sm.layui-btn-primary', {
            href: icon.dataUrl, download: icon.filename, text: t('download', 'Download')
          })
        ));
      });
      resultsBody.appendChild(grid);
    }

    /* ---- ZIP 下载 ---- */

    function downloadZip() {
      if (!state.icons.length) {
        setStatus(t('err_no_icons', 'Generate the icons first.'), true);
        return;
      }
      var entries = state.icons.map(function (icon) {
        return { name: icon.filename, data: dataUrlToBytes(icon.dataUrl) };
      });
      // manifest 跟图标放在一起：装 PWA 时这两个文件要挨着
      entries.push({ name: 'manifest.webmanifest', data: U.utf8Bytes(manifestJson()) });
      var zip = createZip(entries);
      window.ItTools.download(sanitizeBaseName(state.baseName) + '-icons.zip', zip, 'application/zip');
    }

    /* ---- 挂载 ---- */

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('presets', 'Presets and sizes') }),
      D.h('div.switch-grid', null, presetSwitches),
      U.field(t('custom_sizes', 'Custom sizes'), customInput, {
        wide: true,
        hint: t('custom_sizes_hint', 'Comma-separated pixel sizes, e.g. 64,128,256')
      }),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('fit_mode', 'Fit mode') }),
        D.h('div.switch-grid', { style: { marginBottom: '0', flex: '1 1 auto' } }, fitRadios)
      ),
      U.field(t('base_name', 'File name base'), baseNameInput, {
        wide: true,
        hint: t('base_name_hint', 'Used for the PNG file names and for the ZIP file name.')
      }),
      sizesSummary
    ));

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('source_image', 'Source image') }),
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('choose_file', 'Choose an image') }),
        fileInput
      ),
      D.h('p.field-hint', { text: t('image_hint', 'Any image the browser can decode: PNG, JPEG, WebP, SVG...') }),
      previewBox,
      statusLine,
      D.h('div.form-actions', null, generateBtn, zipBtn)
    ));

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('manifest', 'Web app manifest') }),
      D.h('div.field-row', null,
        textField(t('app_name', 'App name'), 'appName'),
        textField(t('lang', 'Language'), 'lang')
      ),
      D.h('div.field-row', null,
        textField(t('start_url', 'Start URL'), 'startUrl'),
        textField(t('scope', 'Scope'), 'scope')
      ),
      U.field(t('app_description', 'Description'), descriptionInput, { wide: true }),
      D.h('div.field-row', null,
        colorField(t('background_color', 'Background color'), 'backgroundColor'),
        colorField(t('theme_color', 'Theme color'), 'themeColor')
      ),
      U.field(t('manifest_json', 'manifest.webmanifest'), manifestOut, { wide: true }),
      D.h('p.field-hint', { text: t('manifest_hint', 'The manifest is included in the ZIP next to the icons.') })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('output', 'Generated icons') }),
      resultsBody
    ));

    showPreview();
    updateSizes();
    updateManifest();
    renderResults();

    return { destroy: function () { D.clear(root); } };
  });

  /* ---------- 供单测调用的纯逻辑 ---------- */

  window.ItTools.logic['icon-generator'] = {
    ICON_PRESETS: ICON_PRESETS,
    MAX_ICON_SIZE: MAX_ICON_SIZE,
    normalizeSizes: normalizeSizes,
    getPresetSizes: getPresetSizes,
    parseCustomSizes: parseCustomSizes,
    sanitizeBaseName: sanitizeBaseName,
    buildIconFilename: buildIconFilename,
    calculateDrawArea: calculateDrawArea,
    createWebAppManifest: createWebAppManifest,
    crc32: crc32,
    createZip: createZip,
    readZip: readZip,
    __cases: function (assert) {
      /* ---- normalizeSizes ---- */
      assert.eq(normalizeSizes([192, 192, 0, -1, 512.8, 72]), [72, 192, 512], '去重、取整、丢掉非正数、升序');
      assert.eq(normalizeSizes([]), [], '空数组');
      assert.eq(normalizeSizes([64, 32, 16]), [16, 32, 64], '升序');
      assert.eq(normalizeSizes([0]), [], '0 被丢掉');
      assert.eq(normalizeSizes([-5]), [], '负数被丢掉');
      assert.eq(normalizeSizes([12.9]), [12], '小数取整（而不是四舍五入）');
      assert.eq(normalizeSizes(['48']), [48], '字符串数字');
      assert.eq(normalizeSizes([NaN, Infinity, 'abc', null, undefined]), [], '非有限值与非数字全丢掉');

      /* ---- getPresetSizes ---- */
      assert.eq(getPresetSizes(['pwa', 'android']), [48, 72, 96, 128, 144, 152, 192, 384, 512], 'pwa + android 合并');
      assert.eq(getPresetSizes(['pwa', 'android', 'ios']),
        [20, 29, 40, 48, 58, 60, 72, 76, 80, 87, 96, 120, 128, 144, 152, 167, 180, 192, 384, 512, 1024],
        '三个预设合并');
      assert.eq(getPresetSizes(['ios']), [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024], '只有 ios');
      assert.eq(getPresetSizes([]), [], '没有预设');
      assert.eq(getPresetSizes(['nope']), [], '不认识的预设键');
      assert.eq(ICON_PRESETS.map(function (p) { return p.key; }), ['pwa', 'android', 'ios'], '三个平台预设');

      /* ---- parseCustomSizes ---- */
      assert.eq(parseCustomSizes('64,128,256'), [64, 128, 256], '逗号分隔');
      assert.eq(parseCustomSizes('64 128 256'), [64, 128, 256], '空白分隔');
      assert.eq(parseCustomSizes('64, 128 ,256'), [64, 128, 256], '逗号边上有空格');
      assert.eq(parseCustomSizes('64,64,0,-3,abc'), [64], '非法项丢掉、重复的去掉');
      assert.eq(parseCustomSizes(''), [], '空串');
      assert.eq(parseCustomSizes('99999'), [MAX_ICON_SIZE], '超过上限的截到上限');

      /* ---- sanitizeBaseName ---- */
      assert.eq(sanitizeBaseName('my app/name'), 'my-app-name', '斜杠与空格都变成横线');
      assert.eq(sanitizeBaseName(''), 'icon', '空串回落 icon');
      assert.eq(sanitizeBaseName('   '), 'icon', '纯空白回落 icon');
      assert.eq(sanitizeBaseName('My App'), 'My-App', '空白转横线');
      assert.eq(sanitizeBaseName('a<b>c:d"e/f\\g|h?i*j'), 'a-b-c-d-e-f-g-h-i-j', '七个非法字符全换掉');
      assert.eq(sanitizeBaseName('a//b'), 'a-b', '连续横线收成一个');
      assert.eq(sanitizeBaseName('/leading/'), 'leading', '首尾横线去掉');
      assert.eq(sanitizeBaseName('///'), 'icon', '全是非法字符时回落 icon');

      /* ---- buildIconFilename ---- */
      assert.eq(buildIconFilename(192, 'logo'), 'logo-192x192.png', '常规文件名');
      assert.eq(buildIconFilename(192), 'icon-192x192.png', '不传基名时用 icon');
      assert.eq(buildIconFilename(512, ' My App/Icon '), 'My-App-Icon-512x512.png', '基名先清洗再拼');
      assert.eq(buildIconFilename(20, ''), 'icon-20x20.png', '空基名回落 icon');

      /* ---- calculateDrawArea ---- */
      var cover = calculateDrawArea({ sourceWidth: 400, sourceHeight: 200, targetSize: 100, fitMode: 'cover' });
      assert.eq(cover.width, 200, 'cover：短边贴满，长边溢出');
      assert.eq(cover.height, 100, 'cover：另一条边正好等于目标');
      assert.eq(cover.x, -50, 'cover：横向居中所以左边溢出 50');
      assert.eq(cover.y, 0, 'cover：纵向不溢出');

      var contain = calculateDrawArea({ sourceWidth: 400, sourceHeight: 200, targetSize: 100, fitMode: 'contain' });
      assert.eq(contain.width, 100, 'contain：长边贴满');
      assert.eq(contain.height, 50, 'contain：短边留白');
      assert.eq(contain.x, 0, 'contain：横向不溢出');
      assert.eq(contain.y, 25, 'contain：纵向居中，上下各留 25');

      var square = calculateDrawArea({ sourceWidth: 512, sourceHeight: 512, targetSize: 192, fitMode: 'cover' });
      assert.eq(square.width, 192, '正方形源图 cover：正好铺满');
      assert.eq(square.height, 192, '正方形源图 cover：高度也正好');
      assert.eq(square.x, 0, '正方形源图 cover：横向不偏移');
      assert.eq(square.y, 0, '正方形源图 cover：纵向不偏移');

      /* ---- createWebAppManifest ---- */
      var manifest = JSON.parse(createWebAppManifest({
        appName: 'my-app',
        description: 'my generated icons',
        icons: [
          { filename: 'my-app-192x192.png', size: 192 },
          { filename: 'my-app-512x512.png', size: 512 }
        ]
      }));
      assert.eq(manifest.name, 'my-app', 'name');
      assert.eq(manifest.short_name, 'my-app', 'short_name');
      assert.eq(manifest.display, 'standalone', 'display 是 standalone');
      assert.eq(manifest.description, 'my generated icons', 'description');
      assert.eq(manifest.start_url, '/', 'start_url 默认 /');
      assert.eq(manifest.scope, '/', 'scope 默认 /');
      assert.eq(manifest.lang, 'en', 'lang 默认 en');
      assert.eq(manifest.background_color, '#ffffff', 'background_color 默认白色');
      assert.eq(manifest.theme_color, '#ffffff', 'theme_color 默认白色');
      assert.eq(manifest.icons.length, 2, '两个图标');
      assert.eq(manifest.icons[0].src, 'my-app-192x192.png', 'icons[0].src');
      assert.eq(manifest.icons[0].sizes, '192x192', 'icons[0].sizes 是 192x192');
      assert.eq(manifest.icons[1].sizes, '512x512', 'icons[1].sizes 是 512x512');
      assert.eq(manifest.icons[0].type, 'image/png', 'icons[0].type');
      assert.eq(manifest.icons[0].purpose, 'any maskable', 'icons[0].purpose');

      /* ---- CRC32 ---- */
      assert.eq(crc32(U.utf8Bytes('hello')), 0x3610A686, 'CRC32("hello")');
      assert.eq(crc32(U.utf8Bytes('123456789')), 0xCBF43926, 'CRC32("123456789") 是标准校验值');
      assert.eq(crc32(new Uint8Array(0)), 0, '空内容的 CRC32');

      /* ---- ZIP 写入器 ---- */
      var helloBytes = U.utf8Bytes('hello');
      var pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]);
      var zip = createZip([
        { name: 'hello.txt', data: helloBytes },
        { name: 'icon-192x192.png', data: pngBytes }
      ]);

      assert.eq(zip[0], 0x50, '首字节是 P');
      assert.eq(zip[1], 0x4B, '次字节是 K');
      assert.eq(zip[2], 0x03, '第三个字节 0x03');
      assert.eq(zip[3], 0x04, '第四个字节 0x04（本地文件头签名）');
      assert.eq(zip.length >= 22, true, 'ZIP 至少有 EOCD 那么长');
      assert.eq(zip[zip.length - 22], 0x50, 'EOCD 起始于倒数第 22 字节');
      assert.eq(zip[zip.length - 21], 0x4B, 'EOCD 起始于倒数第 22 字节');
      assert.eq(zip[zip.length - 20], 0x05, 'EOCD 起始于倒数第 22 字节');
      assert.eq(zip[zip.length - 19], 0x06, 'EOCD 起始于倒数第 22 字节');

      // 解回来逐项对账：文件名、字节内容、CRC、压缩方式
      var parsed = readZip(zip);
      assert.eq(parsed.entries.length, 2, 'ZIP 里有两项');
      assert.eq(parsed.entries[0].name, 'hello.txt', '第一项的文件名');
      assert.eq(parsed.entries[0].method, 0, '压缩方式是 STORE（0）');
      assert.eq(parsed.entries[0].size, 5, '第一项的大小');
      assert.eq(U.utf8Decode(parsed.entries[0].data), 'hello', '第一项的内容原样解回来');
      assert.eq(parsed.entries[0].crc, crc32(helloBytes), '第一项的 CRC32 对得上');
      assert.eq(parsed.entries[1].name, 'icon-192x192.png', '第二项的文件名');
      assert.eq(Array.prototype.slice.call(parsed.entries[1].data), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A],
        '二进制内容一个字节都不差');
      assert.eq(parsed.entries[1].crc, crc32(pngBytes), '第二项的 CRC32 对得上');

      // 空 ZIP 也要能读（中央目录为空）
      var emptyZip = createZip([]);
      assert.eq(readZip(emptyZip).entries.length, 0, '空 ZIP 读出来没有条目');
    }
  };
})();
