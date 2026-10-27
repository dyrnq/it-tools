/* ==========================================================================
   图片元数据去除（exif-remover）

   上传一张 JPEG / PNG / WebP，把里面的元数据段列出来，勾掉要删的，
   下载清理后的文件。

   参考实现：上游 PR #1229 的 src/tools/exif-remover/
   （上游 it-tools, GPLv3）
   与上游的差别：
   1. 上游靠 `vite-plugin-node-polyfills` 才能在浏览器里跑 node 的
      stream / buffer —— 那个插件是**全站每个 chunk**都要带上的。
      我们不引入任何依赖：整件事就是**按字节删段**。
   2. 上游重新编码整张图（走 canvas / sharp 一类的路径）；
      我们**一个字节都不重新编码** —— 原来的像素数据原样搬运。
      重新编码会让有损 JPEG 再掉一次画质，这是不可逆的。
   3. 删的粒度是**整段**，不是「单个 EXIF 标签」。
      删单个标签要重建 TIFF 的 IFD 树，代价大且容易出错；
      而隐私场景里用户要的是「把这段元数据整个拿掉」，
      段级粒度正好对上（APP1 整段就是 EXIF，eXIf 整块就是 EXIF）。
   4. WebP 删完要**改 RIFF 头里的长度字段** —— 忘了改的话文件在
      部分查看器里会读不出来。上游没做 WebP。

   处理的格式与段：
     JPEG  APP0~APP15 / COM —— APP1 里可能是 Exif 或 XMP，APP13 是 IPTC
     PNG   tEXt / iTXt / zTXt / eXIf / tIME / iCCP
     WebP  EXIF / XMP / ICCP
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('exif-remover');

  /* ---------- 格式识别 ---------- */

  var PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

  /**
   * 按文件头判断格式。**看魔数不看扩展名** —— 改了扩展名的文件照样要认对。
   * @param {Uint8Array} bytes
   * @returns {'jpeg'|'png'|'webp'|null}
   */
  function detectFormat(bytes) {
    if (!bytes || bytes.length < 4) return null;
    // JPEG：SOI 之后必须紧跟一个标记（FF D8 FF）
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
    if (bytes.length >= 8) {
      var isPng = true;
      for (var i = 0; i < 8; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) { isPng = false; break; }
      }
      if (isPng) return 'png';
    }
    // WebP 是 RIFF 容器：'RIFF' + 4 字节长度 + 'WEBP'
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return 'webp';
    }
    return null;
  }

  /* ---------- JPEG ---------- */

  /** JPEG 标记码 → 名字。表里没有的按段归类。 */
  var JPEG_MARKER_NAMES = {
    0xC0: 'SOF0', 0xC1: 'SOF1', 0xC2: 'SOF2', 0xC3: 'SOF3',
    0xC4: 'DHT', 0xC5: 'SOF5', 0xC6: 'SOF6', 0xC7: 'SOF7',
    0xC8: 'JPG', 0xC9: 'SOF9', 0xCA: 'SOF10', 0xCB: 'SOF11',
    0xCC: 'DAC', 0xCD: 'SOF13', 0xCE: 'SOF14', 0xCF: 'SOF15',
    0xD8: 'SOI', 0xD9: 'EOI', 0xDA: 'SOS', 0xDB: 'DQT', 0xDC: 'DNL',
    0xDD: 'DRI', 0xDE: 'DHP', 0xDF: 'EXP', 0xFE: 'COM'
  };

  /**
   * APP 段的名字与性质。
   * @param {number} appIndex 0~15
   */
  function appName(appIndex) {
    return 'APP' + appIndex;
  }

  /**
   * 看 APP 段的头几个字节判断它到底装的是什么。
   * 同一段里能装多种东西（APP1 既是 Exif 也可能是 XMP），所以要看内容。
   * @param {Uint8Array} bytes
   * @param {number} start 段载荷的起始偏移
   * @param {number} length 载荷长度
   * @returns {{title: string, kind: string}}
   */
  function describeAppPayload(bytes, start, length) {
    function startsWith(str) {
      if (length < str.length) return false;
      for (var i = 0; i < str.length; i++) {
        if (bytes[start + i] !== str.charCodeAt(i)) return false;
      }
      return true;
    }
    function latin(str) {
      // APP1 里的 XMP 标识符后面跟一个 NUL
      if (length > str.length && bytes[start + str.length] === 0) return true;
      return false;
    }
    if (startsWith('Exif')) {
      return { title: 'Exif', kind: 'metadata' };
    }
    if (startsWith('http://ns.adobe.com/xap/1.0/') && latin('http://ns.adobe.com/xap/1.0/')) {
      return { title: 'XMP', kind: 'metadata' };
    }
    if (startsWith('ICC_PROFILE')) {
      return { title: 'ICC profile', kind: 'technical' };
    }
    if (startsWith('JFIF')) {
      return { title: 'JFIF', kind: 'technical' };
    }
    if (startsWith('Photoshop 3.0')) {
      return { title: 'IPTC / Photoshop', kind: 'metadata' };
    }
    if (startsWith('Adobe')) {
      return { title: 'Adobe', kind: 'technical' };
    }
    return { title: '', kind: 'technical' };
  }

  /**
   * 列出 JPEG 的所有段。
   *
   * 关键点：**扫描数据（SOS 之后）里不能按标记解析** ——
   * 熵编码数据里 0xFF 是字节填充，后面跟 0x00 表示「这是数据不是标记」。
   * 所以 SOS 之后要**整块跳到下一个真正的标记**为止。
   *
   * @param {Uint8Array} bytes
   * @returns {Array<object>} 段列表，每段带 start/end 字节范围
   */
  function listJpegBlocks(bytes) {
    var blocks = [];
    var pos = 0;

    function push(id, start, end, kind, removable, title, detail) {
      blocks.push({
        id: id, start: start, end: end, kind: kind,
        removable: removable, title: title || id, detail: detail || ''
      });
    }

    // SOI
    if (bytes.length < 2 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return blocks;
    push('SOI', 0, 2, 'data', false, 'SOI');
    pos = 2;

    while (pos < bytes.length) {
      // 标记必须是 0xFF 开头；中间可能有若干个 0xFF 填充
      if (bytes[pos] !== 0xFF) { pos++; continue; }
      var markerStart = pos;
      while (pos < bytes.length && bytes[pos] === 0xFF) pos++;
      if (pos >= bytes.length) break;
      var code = bytes[pos];
      pos++; // 现在 pos 指向标记码之后

      // 无负载的标记：SOI / EOI / TEM / RSTn
      if (code === 0xD8 || code === 0x01 || (code >= 0xD0 && code <= 0xD7)) {
        push('MARKER', markerStart, pos, 'data', false, '0x' + code.toString(16).toUpperCase());
        continue;
      }
      if (code === 0xD9) { // EOI
        push('EOI', markerStart, pos, 'data', false, 'EOI');
        // EOI 之后是文件尾（有的文件会有 padding）
        if (pos < bytes.length) push('TRAILER', pos, bytes.length, 'data', false, 'Trailing data');
        break;
      }

      // 有负载的标记：2 字节长度（含长度字段自身）
      if (pos + 2 > bytes.length) break;
      var length = (bytes[pos] << 8) | bytes[pos + 1];
      if (length < 2) break;
      var segEnd = pos + length;
      if (segEnd > bytes.length) segEnd = bytes.length;
      // 载荷从长度字段**之后**开始 —— 长度字段本身不算载荷
      var payloadStart = pos + 2;

      if (code === 0xDA) { // SOS：后面是熵编码数据
        push('SOS', markerStart, segEnd, 'data', false, 'SOS');
        // 整块跳过扫描数据，直到下一个真正的标记
        var scan = segEnd;
        while (scan < bytes.length - 1) {
          if (bytes[scan] === 0xFF) {
            var next = bytes[scan + 1];
            // 0x00 是字节填充；0xD0~0xD7 是重启标记，也是数据的一部分
            if (next !== 0x00 && !(next >= 0xD0 && next <= 0xD7)) break;
          }
          scan++;
        }
        if (scan > segEnd) push('SCAN', segEnd, scan, 'data', false, 'Scan data');
        pos = scan;
        continue;
      }

      var id = (code >= 0xE0 && code <= 0xEF) ? appName(code - 0xE0) : (JPEG_MARKER_NAMES[code] || ('0x' + code.toString(16).toUpperCase()));
      if (code === 0xFE || (code >= 0xE0 && code <= 0xEF)) {
        var info = describeAppPayload(bytes, payloadStart, segEnd - payloadStart);
        var isComment = code === 0xFE;
        push(id, markerStart, segEnd, isComment ? 'metadata' : info.kind, true,
          isComment ? 'Comment' : (id + (info.title ? ' · ' + info.title : '')),
          isComment ? 'COM' : id);
      } else {
        // 其它标记：技术性数据，不可删（删了图就解不出来了）
        push(id, markerStart, segEnd, 'data', false, id);
      }
      pos = segEnd;
    }

    return blocks;
  }

  /* ---------- PNG ---------- */

  /** PNG 块类型 → 性质与名字。 */
  var PNG_CHUNK_INFO = {
    tEXt: { title: 'Text', kind: 'metadata' },
    zTXt: { title: 'Compressed text', kind: 'metadata' },
    iTXt: { title: 'International text', kind: 'metadata' },
    eXIf: { title: 'Exif', kind: 'metadata' },
    tIME: { title: 'Modification time', kind: 'metadata' },
    iCCP: { title: 'ICC profile', kind: 'technical' },
    pHYs: { title: 'Pixel density', kind: 'technical' },
    sRGB: { title: 'sRGB', kind: 'technical' },
    gAMA: { title: 'Gamma', kind: 'technical' },
    cHRM: { title: 'Chromaticity', kind: 'technical' },
    bKGD: { title: 'Background', kind: 'technical' },
    sBIT: { title: 'Significant bits', kind: 'technical' },
    hIST: { title: 'Histogram', kind: 'technical' },
    sPLT: { title: 'Palette', kind: 'technical' }
  };

  /**
   * 列出 PNG 的所有块。
   * @param {Uint8Array} bytes
   */
  function listPngBlocks(bytes) {
    var blocks = [];
    if (bytes.length < 8) return blocks;
    blocks.push({ id: 'SIGNATURE', start: 0, end: 8, kind: 'data', removable: false, title: 'PNG signature', detail: '' });

    var pos = 8;
    while (pos + 8 <= bytes.length) {
      var length = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      var dataStart = pos + 8;
      var dataEnd = dataStart + length;
      var chunkEnd = dataEnd + 4; // 4 字节 CRC
      if (chunkEnd > bytes.length) {
        // 文件被截断了 —— 把剩下的当成一个块，别再往下解析
        blocks.push({ id: type, start: pos, end: bytes.length, kind: 'technical', removable: false, title: type, detail: 'truncated' });
        break;
      }
      var info = PNG_CHUNK_INFO[type];
      var isImage = type === 'IHDR' || type === 'PLTE' || type === 'IDAT' || type === 'IEND' || type === 'tRNS';
      blocks.push({
        id: type, start: pos, end: chunkEnd,
        kind: isImage ? 'data' : (info ? info.kind : 'technical'),
        removable: !isImage,
        title: info ? (info.title + ' (' + type + ')') : type,
        detail: type
      });
      pos = chunkEnd;
      if (type === 'IEND') break;
    }
    return blocks;
  }

  /* ---------- WebP ---------- */

  var WEBP_CHUNK_INFO = {
    EXIF: { title: 'Exif', kind: 'metadata' },
    XMP: { title: 'XMP', kind: 'metadata' },
    ICCP: { title: 'ICC profile', kind: 'metadata' }
  };

  /**
   * 列出 WebP 的所有块。
   * @param {Uint8Array} bytes
   */
  function listWebpBlocks(bytes) {
    var blocks = [];
    if (bytes.length < 12) return blocks;
    blocks.push({ id: 'RIFF', start: 0, end: 12, kind: 'data', removable: false, title: 'RIFF header', detail: '' });

    var pos = 12;
    while (pos + 8 <= bytes.length) {
      var type = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      var size = bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24);
      var dataStart = pos + 8;
      var dataEnd = dataStart + size;
      // 块数据按偶数字节补齐
      var padded = size + (size & 1);
      var chunkEnd = dataStart + padded;
      if (chunkEnd > bytes.length) chunkEnd = bytes.length;
      var info = WEBP_CHUNK_INFO[type];
      blocks.push({
        id: type, start: pos, end: chunkEnd,
        kind: info ? info.kind : 'data',
        removable: !!info,
        title: info ? (info.title + ' (' + type + ')') : type,
        detail: type
      });
      pos = chunkEnd;
    }
    return blocks;
  }

  /* ---------- 统一入口 ---------- */

  /**
   * 列出文件里的所有段。
   * @param {Uint8Array} bytes
   * @returns {{format: string, blocks: Array<object>}|null}
   */
  function listBlocks(bytes) {
    var format = detectFormat(bytes);
    if (!format) return null;
    var blocks;
    if (format === 'jpeg') blocks = listJpegBlocks(bytes);
    else if (format === 'png') blocks = listPngBlocks(bytes);
    else blocks = listWebpBlocks(bytes);
    return { format: format, blocks: blocks };
  }

  /**
   * 段列表里**默认勾选**（= 默认要删掉）的那些：只有元数据段。
   * 技术性段（ICC 色彩描述、像素密度…）默认保留 ——
   * 删了不影响隐私，但会让颜色/尺寸不对。
   * @param {Array<object>} blocks
   * @returns {number[]} 段在列表里的下标
   */
  function defaultRemovableIndexes(blocks) {
    var out = [];
    blocks.forEach(function (b, i) {
      if (b.removable && b.kind === 'metadata') out.push(i);
    });
    return out;
  }

  /**
   * 按下标删掉若干段，其余字节**原样**拼起来。
   *
   * WebP 特殊：RIFF 头里的长度字段是「文件长度 - 8」，
   * 删完块必须重算，否则有些查看器读不出来。
   *
   * @param {Uint8Array} bytes 原文件
   * @param {Array<object>} blocks 段列表
   * @param {number[]} removeIndexes 要删的段下标
   * @returns {Uint8Array}
   */
  function stripBlocks(bytes, blocks, removeIndexes) {
    var drop = {};
    removeIndexes.forEach(function (i) { drop[i] = true; });

    var out = [];
    blocks.forEach(function (b, i) {
      if (drop[i]) return;
      out.push(bytes.subarray(b.start, b.end));
    });

    // 有没被列出来的尾巴（文件末尾多出来的字节）—— 一起带走
    var covered = 0;
    blocks.forEach(function (b) { if (b.end > covered) covered = b.end; });
    if (covered < bytes.length) out.push(bytes.subarray(covered, bytes.length));

    var total = 0;
    out.forEach(function (part) { total += part.length; });
    var result = new Uint8Array(total);
    var offset = 0;
    out.forEach(function (part) { result.set(part, offset); offset += part.length; });

    // WebP：修 RIFF 长度
    if (result.length >= 4 && result[0] === 0x52 && result[1] === 0x49 && result[2] === 0x46 && result[3] === 0x46) {
      var size = result.length - 8;
      result[4] = size & 0xFF;
      result[5] = (size >> 8) & 0xFF;
      result[6] = (size >> 16) & 0xFF;
      result[7] = (size >> 24) & 0xFF;
    }
    return result;
  }

  /**
   * 清掉一个文件里的元数据。
   * @param {Uint8Array} bytes
   * @param {number[]|null} removeIndexes 不给就按默认（元数据段全删）
   * @returns {{format: string, bytes: Uint8Array, removed: number[]}|null}
   */
  function removeMetadata(bytes, removeIndexes) {
    var info = listBlocks(bytes);
    if (!info) return null;
    var indexes = removeIndexes === null || removeIndexes === undefined
      ? defaultRemovableIndexes(info.blocks)
      : removeIndexes;
    return {
      format: info.format,
      bytes: stripBlocks(bytes, info.blocks, indexes),
      removed: indexes.slice()
    };
  }

  /* ---------- 界面 ---------- */

  /** 字节数 → 人类可读的大小。 */
  function formatBytes(n) {
    var value = Number(n);
    if (!isFinite(value) || value < 0) return '';
    if (value < 1024) return value + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    value = value / 1024;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) { value = value / 1024; i++; }
    return value.toFixed(2) + ' ' + units[i];
  }

  /** 清理后的文件名：原名 + "-cleaned"。 */
  function cleanedName(name) {
    var base = String(name || 'image');
    var dot = base.lastIndexOf('.');
    if (dot > 0) return base.slice(0, dot) + '-cleaned' + base.slice(dot);
    return base + '-cleaned';
  }

  var MIME_BY_FORMAT = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp'
  };

  window.ItTools.register('exif-remover', function (root) {
    var disposed = false;
    var state = { bytes: null, name: '', format: '', blocks: null, selected: [] };

    var uploadCard = D.h('div.card');
    var fileCard = D.h('div.card', { hidden: true });
    var listCard = D.h('div.card', { hidden: true });
    var resultCard = D.h('div.card', { hidden: true });

    root.appendChild(uploadCard);
    root.appendChild(fileCard);
    root.appendChild(listCard);
    root.appendChild(resultCard);

    /* ---- 上传卡片 ---- */

    var fileInput = D.h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    var status = D.h('p.field-hint');

    uploadCard.appendChild(D.h('h3', { text: t('title', 'Remove metadata from an image') }));
    uploadCard.appendChild(D.h('div.preview-box', null,
      D.h('label.field-label', { text: t('choose_file', 'Choose an image file') }),
      fileInput,
      D.h('p.field-hint', { text: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.') })
    ));
    uploadCard.appendChild(status);

    function setStatus(message, isError) {
      status.textContent = message || '';
      status.classList.toggle('is-error', !!isError);
    }

    /* ---- 文件信息卡片 ---- */

    var fileBody = D.h('div');
    fileCard.appendChild(D.h('h3', { text: t('file_info', 'File') }));
    fileCard.appendChild(fileBody);

    /* ---- 段列表卡片 ---- */

    var listBody = D.h('div');
    listCard.appendChild(D.h('h3', { text: t('found_title', 'Metadata found') }));
    listCard.appendChild(listBody);

    /* ---- 结果卡片 ---- */

    var resultBody = D.h('div');
    resultCard.appendChild(D.h('h3', { text: t('result_title', 'Result') }));
    resultCard.appendChild(resultBody);

    /* ---------- 渲染 ---------- */

    function kvTable(rows) {
      var table = D.h('table.kv-table');
      table.appendChild(D.h('thead', null, D.h('tr', null,
        D.h('th', { text: t('label_name', 'Name') }),
        D.h('th', { text: t('label_size', 'Size') })
      )));
      var body = D.h('tbody');
      rows.forEach(function (row) {
        body.appendChild(D.h('tr', null,
          D.h('td', { text: row.label }),
          D.h('td.val', { text: row.value })
        ));
      });
      table.appendChild(body);
      return table;
    }

    /** 可勾选的段列表。 */
    function renderList() {
      D.clear(listBody);

      var removable = state.blocks.filter(function (b) { return b.removable; });
      if (!removable.length) {
        listBody.appendChild(D.h('p.field-hint', { text: t('no_metadata', 'This file has no removable metadata.') }));
        return;
      }

      var checks = [];
      var grid = D.h('div.switch-grid');
      state.blocks.forEach(function (b, i) {
        if (!b.removable) return;
        var box = D.h('input', { type: 'checkbox' });
        box.checked = state.selected.indexOf(i) >= 0;
        box.addEventListener('change', function () {
          var at = state.selected.indexOf(i);
          if (box.checked) { if (at < 0) state.selected.push(i); }
          else if (at >= 0) state.selected.splice(at, 1);
          refresh();
        });
        checks.push({ index: i, input: box, block: b });
        grid.appendChild(D.h('label.switch', null, box, D.h('span', { text: b.title })));
      });
      listBody.appendChild(grid);

      var allBtn = D.h('button.layui-btn.layui-btn-sm', {
        type: 'button', text: t('select_all', 'Remove all')
      });
      allBtn.addEventListener('click', function () {
        state.selected = removable.map(function (b, i) { return state.blocks.indexOf(b); });
        renderList();
        refresh();
      });
      var noneBtn = D.h('button.layui-btn.layui-btn-sm', {
        type: 'button', text: t('select_none', 'Keep all')
      });
      noneBtn.addEventListener('click', function () {
        state.selected = [];
        renderList();
        refresh();
      });

      listBody.appendChild(D.h('div.form-actions', null, allBtn, noneBtn));
      listBody.appendChild(D.h('p.field-hint', { text: t('hint_metadata', 'Metadata segments are ticked by default — ticking one removes it.') }));
    }

    /** 重新算结果并刷新结果卡。 */
    function refresh() {
      if (!state.bytes) return;
      var result;
      try {
        result = removeMetadata(state.bytes, state.selected);
      } catch (e) {
        D.clear(resultBody).appendChild(D.h('p.field-hint.is-error', {
          text: t('err_strip', 'Could not rebuild the file: {reason}').replace('{reason}', function () { return String(e && e.message ? e.message : e); })
        }));
        return;
      }
      D.clear(resultBody);
      resultBody.appendChild(kvTable([
        { label: t('label_before', 'Size before'), value: formatBytes(state.bytes.length) },
        { label: t('label_after', 'Size after'), value: formatBytes(result.bytes.length) },
        { label: t('label_removed', 'Removed segments'), value: String(result.removed.length) }
      ]));

      var button = D.h('button.layui-btn.layui-btn-primary', {
        type: 'button', text: t('download', 'Download the cleaned file')
      });
      button.addEventListener('click', function () {
        if (disposed) return;
        var blob = new Blob([result.bytes], { type: MIME_BY_FORMAT[state.format] || 'application/octet-stream' });
        window.ItTools.download(cleanedName(state.name), blob, MIME_BY_FORMAT[state.format]);
      });
      resultBody.appendChild(D.h('div.form-actions', null, button));
    }

    /* ---------- 处理文件 ---------- */

    function handleBytes(bytes, name) {
      var info = listBlocks(bytes);
      if (!info) {
        setStatus(t('err_not_image', 'This does not look like a JPEG, PNG or WebP file.'), true);
        fileCard.hidden = true;
        listCard.hidden = true;
        resultCard.hidden = true;
        return;
      }
      state.bytes = bytes;
      state.name = name || 'image';
      state.format = info.format;
      state.blocks = info.blocks;
      state.selected = defaultRemovableIndexes(info.blocks);

      setStatus('');
      fileCard.hidden = false;
      listCard.hidden = false;
      resultCard.hidden = false;

      D.clear(fileBody).appendChild(kvTable([
        { label: t('label_name', 'Name'), value: state.name },
        { label: t('label_format', 'Format'), value: state.format.toUpperCase() },
        { label: t('label_size', 'Size'), value: formatBytes(bytes.length) }
      ]));

      renderList();
      refresh();
    }

    function readFile(file) {
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        if (disposed) return;
        try {
          handleBytes(new Uint8Array(reader.result), file.name);
        } catch (e) {
          setStatus(t('err_read', 'Could not read the file.'), true);
        }
      };
      reader.onerror = function () {
        if (disposed) return;
        setStatus(t('err_read', 'Could not read the file.'), true);
      };
      reader.readAsArrayBuffer(file);
    }

    fileInput.addEventListener('change', function () {
      readFile(fileInput.files && fileInput.files[0]);
    });

    // 拖进来
    var dropBox = uploadCard.querySelector('.preview-box');
    ['dragenter', 'dragover'].forEach(function (evt) {
      dropBox.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dropBox.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
      });
    });
    dropBox.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) readFile(files[0]);
    });

    return {
      destroy: function () {
        disposed = true;
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['exif-remover'] = {
    detectFormat: detectFormat,
    listBlocks: listBlocks,
    listJpegBlocks: listJpegBlocks,
    listPngBlocks: listPngBlocks,
    listWebpBlocks: listWebpBlocks,
    defaultRemovableIndexes: defaultRemovableIndexes,
    stripBlocks: stripBlocks,
    removeMetadata: removeMetadata,
    cleanedName: cleanedName,
    formatBytes: formatBytes,

    __cases: function (assert) {
      /* ---- 造样本 ---- */

      /** 造一段 JPEG 段（FF 标记 + 2 字节长度 + 载荷）。 */
      function jpegSegment(code, payload) {
        var out = [0xFF, code];
        var len = payload.length + 2;
        out.push((len >> 8) & 0xFF, len & 0xFF);
        for (var i = 0; i < payload.length; i++) out.push(payload[i]);
        return out;
      }

      function bytes(arr) {
        return new Uint8Array(arr);
      }

      function ascii(str) {
        var out = [];
        for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i));
        return out;
      }

      /** 一张最小的 JPEG：SOI + APP1(Exif) + APP0(JFIF) + SOF0 + 扫描数据 + EOI。 */
      function sampleJpeg() {
        var exifPayload = ascii('Exif').concat([0, 0, 1, 2, 3, 4]);
        var jfifPayload = ascii('JFIF').concat([0, 1, 2]);
        var sofPayload = [0, 8, 0, 16, 0, 16, 1];
        // 扫描数据里故意放一个 0xFF 0x00（字节填充）—— 解析时不能把它当标记
        var scanPayload = [0x11, 0x22, 0xFF, 0x00, 0x33];
        var out = [0xFF, 0xD8]
          .concat(jpegSegment(0xE1, exifPayload))
          .concat(jpegSegment(0xE0, jfifPayload))
          .concat(jpegSegment(0xC0, sofPayload))
          .concat(jpegSegment(0xDA, [1, 1, 0, 0, 63, 0]))
          .concat(scanPayload)
          .concat([0xFF, 0xD9]);
        return bytes(out);
      }

      /** 造一个 PNG 块（长度 + 类型 + 数据 + CRC）。CRC 这里填假的 —— 工具不校验它。 */
      function pngChunk(type, data) {
        var out = [(data.length >> 24) & 0xFF, (data.length >> 16) & 0xFF, (data.length >> 8) & 0xFF, data.length & 0xFF];
        for (var i = 0; i < 4; i++) out.push(type.charCodeAt(i));
        for (var j = 0; j < data.length; j++) out.push(data[j]);
        out.push(0, 0, 0, 0); // CRC
        return out;
      }

      function samplePng() {
        var out = PNG_SIGNATURE.slice()
          .concat(pngChunk('IHDR', [0, 0, 0, 1, 8, 6, 0, 0, 0]))
          .concat(pngChunk('tEXt', ascii('Comment').concat([0]).concat(ascii('hello'))))
          .concat(pngChunk('IDAT', [0x78, 0x9C, 0x03, 0x00]))
          .concat(pngChunk('IEND', []));
        return bytes(out);
      }

      /** 造一个 WebP：RIFF 头 + VP8X + EXIF。 */
      function sampleWebp() {
        // VP8X 的块数据是 10 字节：标志(1) + 保留(3) + 宽(3) + 高(3)
        var body = ascii('VP8X').concat([10, 0, 0, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        var exif = ascii('EXIF').concat([4, 0, 0, 0, 1, 2, 3, 4]);
        body = body.concat(exif);
        var riffSize = body.length + 4; // 'WEBP' 四个字节
        var out = ascii('RIFF').concat([riffSize & 0xFF, (riffSize >> 8) & 0xFF, (riffSize >> 16) & 0xFF, (riffSize >> 24) & 0xFF]);
        out = out.concat(ascii('WEBP')).concat(body);
        return bytes(out);
      }

      /* ---- 格式识别 ---- */

      assert.eq(detectFormat(sampleJpeg()), 'jpeg', 'JPEG 认得出来');
      assert.eq(detectFormat(samplePng()), 'png', 'PNG 认得出来');
      assert.eq(detectFormat(sampleWebp()), 'webp', 'WebP 认得出来');
      assert.eq(detectFormat(bytes([1, 2, 3, 4])), null, '不是图片就认不出来');
      assert.eq(detectFormat(bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x50])), null,
        'RIFF 容器但不是 WEBP 就别当成图片');
      assert.eq(detectFormat(bytes([0xFF, 0xD8, 0xE0, 0x00])), null, 'JPEG 必须 FF D8 FF 三个字节都对上');

      /* ---- JPEG 段列表 ---- */

      var jpegBlocks = listJpegBlocks(sampleJpeg());
      var exifBlock = jpegBlocks.filter(function (b) { return b.id === 'APP1'; })[0];
      assert(exifBlock, 'APP1 段在列表里');
      assert.eq(exifBlock.title, 'APP1 · Exif', 'APP1 认出是 Exif');
      assert.eq(exifBlock.kind, 'metadata', 'Exif 属于元数据');
      var jfifBlock = jpegBlocks.filter(function (b) { return b.id === 'APP0'; })[0];
      assert.eq(jfifBlock.title, 'APP0 · JFIF', 'APP0 认出是 JFIF');
      assert.eq(jfifBlock.kind, 'technical', 'JFIF 是技术性段');
      var scanBlock = jpegBlocks.filter(function (b) { return b.id === 'SCAN'; })[0];
      assert(scanBlock, '扫描数据是一整块');
      assert.eq(scanBlock.end - scanBlock.start, 5, '扫描数据里那个 FF 00 没被当成标记');
      var eoiBlock = jpegBlocks.filter(function (b) { return b.id === 'EOI'; })[0];
      assert(eoiBlock, 'EOI 在列表里');
      assert.eq(eoiBlock.end, sampleJpeg().length, 'EOI 正好在文件末尾');

      /* ---- JPEG 默认只删元数据 ---- */

      var jpegDefaults = defaultRemovableIndexes(jpegBlocks);
      assert.eq(jpegDefaults.length, 1, 'JPEG 只有 Exif 一个元数据段默认被选中');
      assert.eq(jpegBlocks[jpegDefaults[0]].id, 'APP1', '默认选中的是 APP1');

      /* ---- JPEG 删段 ---- */

      var cleaned = removeMetadata(sampleJpeg(), jpegDefaults);
      assert.eq(cleaned.format, 'jpeg', '格式没变');
      assert(cleaned.bytes.length < sampleJpeg().length, '文件变小了');
      // 删完之后不能再有 Exif 头
      var stillHasExif = false;
      for (var i = 0; i + 4 <= cleaned.bytes.length; i++) {
        if (cleaned.bytes[i] === 0x45 && cleaned.bytes[i + 1] === 0x78 && cleaned.bytes[i + 2] === 0x69 && cleaned.bytes[i + 3] === 0x66) {
          stillHasExif = true;
        }
      }
      assert(!stillHasExif, 'Exif 头已经不在了');
      // 别的字节一个都不能动
      var jpegNoExif = removeMetadata(sampleJpeg(), []);
      assert.eq(jpegNoExif.bytes.length, sampleJpeg().length, '不删任何东西时长度不变');

      /* ---- PNG ---- */

      var pngBlocks = listPngBlocks(samplePng());
      var textBlock = pngBlocks.filter(function (b) { return b.id === 'tEXt'; })[0];
      assert(textBlock, 'tEXt 块在列表里');
      assert.eq(textBlock.kind, 'metadata', 'tEXt 是元数据');
      var ihdrBlock = pngBlocks.filter(function (b) { return b.id === 'IHDR'; })[0];
      assert.eq(ihdrBlock.removable, false, 'IHDR 不能删');
      var idatBlock = pngBlocks.filter(function (b) { return b.id === 'IDAT'; })[0];
      assert.eq(idatBlock.removable, false, 'IDAT 不能删');
      var pngDefaults = defaultRemovableIndexes(pngBlocks);
      assert.eq(pngDefaults.length, 1, 'PNG 只有 tEXt 一个元数据块默认被选中');

      var pngCleaned = removeMetadata(samplePng(), pngDefaults);
      assert(pngCleaned.bytes.length < samplePng().length, 'PNG 变小了');
      var pngTextGone = true;
      for (var k = 0; k + 4 <= pngCleaned.bytes.length; k++) {
        if (pngCleaned.bytes[k] === 0x74 && pngCleaned.bytes[k + 1] === 0x45 &&
            pngCleaned.bytes[k + 2] === 0x58 && pngCleaned.bytes[k + 3] === 0x74) {
          pngTextGone = false;
        }
      }
      assert(pngTextGone, 'tEXt 块已经不在了');
      // 签名必须还在
      assert.eq(pngCleaned.bytes[0], 0x89, 'PNG 签名还在');
      assert.eq(pngCleaned.bytes[1], 0x50, 'PNG 签名还在');

      /* ---- WebP：RIFF 长度必须重算 ---- */

      var webpBlocks = listWebpBlocks(sampleWebp());
      var exifWebp = webpBlocks.filter(function (b) { return b.id === 'EXIF'; })[0];
      assert(exifWebp, 'EXIF 块在列表里');
      assert.eq(exifWebp.kind, 'metadata', 'EXIF 是元数据');
      var webpDefaults = defaultRemovableIndexes(webpBlocks);
      assert.eq(webpDefaults.length, 1, 'WebP 默认只选中 EXIF');

      var webpCleaned = removeMetadata(sampleWebp(), webpDefaults);
      assert(webpCleaned.bytes.length < sampleWebp().length, 'WebP 变小了');
      // RIFF 长度字段 = 文件长度 - 8
      var riffSize = webpCleaned.bytes[4] | (webpCleaned.bytes[5] << 8) |
        (webpCleaned.bytes[6] << 16) | (webpCleaned.bytes[7] << 24);
      assert.eq(riffSize, webpCleaned.bytes.length - 8, 'RIFF 长度字段已经跟着改了');
      // VP8X 必须还在
      var vp8xKept = false;
      for (var w = 0; w + 4 <= webpCleaned.bytes.length; w++) {
        if (webpCleaned.bytes[w] === 0x56 && webpCleaned.bytes[w + 1] === 0x50 &&
            webpCleaned.bytes[w + 2] === 0x38 && webpCleaned.bytes[w + 3] === 0x58) {
          vp8xKept = true;
        }
      }
      assert(vp8xKept, 'VP8X 块还在');

      /* ---- 杂项 ---- */

      assert.eq(cleanedName('photo.jpg'), 'photo-cleaned.jpg', '清理后的文件名');
      assert.eq(cleanedName('photo'), 'photo-cleaned', '没有扩展名的文件名');
      assert.eq(cleanedName('a.b.png'), 'a.b-cleaned.png', '只换最后一个扩展名');
      assert.eq(formatBytes(512), '512 B', '字节数');
      assert.eq(formatBytes(2048), '2.00 KB', 'KB');
      assert.eq(formatBytes(1024 * 1024 * 3), '3.00 MB', 'MB');
      assert.eq(listBlocks(bytes([0, 1, 2])), null, '不是图片就没有段列表');
    }
  };
})();
