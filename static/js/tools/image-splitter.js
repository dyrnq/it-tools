/* ==========================================================================
   图片切割（image-splitter）

   把一张图片按网格切成等分的若干块：单独下载某一块，或者把全部块打包成 ZIP。

   参考的是 split-image.org：2×2 / 3×3 / 4×4 三个预设，加上最多 20×20 的
   自定义行列；预览上画出切割线，点某一块就单独下载那一块；也可以整组打包。

   跟它不一样的几处（本工具自己的取舍）：

   1. **图块一律是 PNG**。切图最怕的就是切完再压一次画质 ——
      PNG 是无损的，透明度也保得住，ZIP 里存的就是原图像素。
   2. **切不匀的时候余数给最后几行/几列**。1000 像素宽切 3 列就是
      333 / 333 / 334，每一块都至少一个像素，不会切出空块。
   3. **网格比图片还细时（3×3 的图切 4×4）网格自动收回来**，
      并在界面上说明收成了几行几列 —— 静默改掉用户填的数是不行的。
   4. **不缩放、不重采样**：切割是按源矩形取下的一块，
      拼回去跟原图一模一样（差一个像素都对不上）。

   全程在浏览器里做，图片一个字节都不出本机。

   文案为什么在本文件里：语言包的对账（src/i18n.rs 的 js_text 模块）
   **只扫 static/js/tools/*.js** 里的字面量调用 —— 文案放在共用内核里
   就扫不到了，单测会直接红。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var C = window.ItTools.imageCodec;
  var t = window.ItTools.t('image-splitter');

  /** 网格最多 20 × 20（跟参考实现一样）。 */
  var MAX_GRID = 20;

  /** 预览画布的最长边（像素）。预览是给人看的，不必按原图分辨率画。 */
  var PREVIEW_MAX = 720;

  /* ---------- 纯逻辑 ---------- */

  /**
   * 网格的行列数：夹到 1 ~ MAX_GRID。
   *
   * @param {*} value 用户填的值（可能是字符串，也可能是空的）
   * @returns {number}
   */
  function clampGrid(value) {
    var n = Math.floor(Number(value));
    if (!isFinite(n) || n < 1) return 1;
    if (n > MAX_GRID) return MAX_GRID;
    return n;
  }

  /**
   * 把一条边切成 n 份，余数给最后几份。
   *
   *   1000 切 3 份 → [333, 333, 334]
   *   100 切 4 份 → [25, 25, 25, 25]
   *   10 切 4 份 → [2, 2, 3, 3]
   *
   * 余数为什么给最后几份而不是摊到中间：切出来的块要能按顺序拼回去，
   * 边界落在「前面几份的整倍数」上，剩下那一两个像素落在最右边，
   * 拼回去正好是原图 —— 中间插一个 1 像素的缝反而更难对齐。
   *
   * @param {number} total 这一边的像素数
   * @param {number} parts 切成几份
   * @returns {number[]} 每一份的像素数
   */
  function splitEdge(total, parts) {
    var n = Math.max(1, Math.floor(Number(parts)) || 1);
    var sum = Math.max(0, Math.floor(Number(total)) || 0);
    var base = Math.floor(sum / n);
    var rem = sum % n;
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(i >= n - rem ? base + 1 : base);
    }
    return out;
  }

  /**
   * 切割方案：每一块的位置与大小。
   *
   * 网格比图片还细时（3×3 的图切 4×4）会把网格收回来 ——
   * 一块至少要有一个像素，否则切出来是空的。
   *
   * @param {number} width 原图宽（像素）
   * @param {number} height 原图高（像素）
   * @param {number} rows 行数
   * @param {number} cols 列数
   * @returns {{tiles: object[], widths: number[], heights: number[], rows: number, cols: number}}
   */
  function planGrid(width, height, rows, cols) {
    var w = Math.max(1, Math.floor(Number(width)) || 1);
    var h = Math.max(1, Math.floor(Number(height)) || 1);
    var r = clampGrid(rows);
    var c = clampGrid(cols);
    if (r > h) r = h;
    if (c > w) c = w;

    var widths = splitEdge(w, c);
    var heights = splitEdge(h, r);
    var tiles = [];
    var y = 0;
    for (var row = 0; row < r; row++) {
      var x = 0;
      for (var col = 0; col < c; col++) {
        tiles.push({
          index: tiles.length + 1,
          row: row,
          col: col,
          x: x,
          y: y,
          width: widths[col],
          height: heights[row]
        });
        x += widths[col];
      }
      y += heights[row];
    }
    return { tiles: tiles, widths: widths, heights: heights, rows: r, cols: c };
  }

  /**
   * 图块的文件名：原名去掉扩展名，加个序号。
   *   photo.png → photo-1.png、photo-2.png …
   *
   * @param {string} name 原文件名
   * @param {number} index 序号（从 1 开始）
   * @returns {string}
   */
  function tileFileName(name, index) {
    var base = String(name || 'image');
    var dot = base.lastIndexOf('.');
    if (dot > 0) base = base.slice(0, dot);
    return base + '-' + index + '.png';
  }

  /**
   * ZIP 包的文件名。
   * @param {string} name 原文件名
   * @returns {string}
   */
  function zipFileName(name) {
    var base = String(name || 'image');
    var dot = base.lastIndexOf('.');
    if (dot > 0) base = base.slice(0, dot);
    return base + '-tiles.zip';
  }

  /* ---------- ZIP ----------
     自己写一个最小的 ZIP（存储方式，不压缩）：
     图块本来就是 PNG —— 已经 deflate 压过一遍 —— 再压一遍几乎压不动，
     白白搭上 CPU。 */

  /** CRC-32（IEEE 多项式）的查表。ZIP 的每个文件头都要它。 */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  /**
   * CRC-32（IEEE）。
   *
   * @param {Uint8Array} bytes
   * @returns {number} 无符号 32 位整数
   */
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * 字符串 → UTF-8 字节。
   *
   * 自己写而不用 TextEncoder：文件名里可能有中文，
   * 而 ZIP 的文件头要求文件名是 UTF-8（标志位 0x0800）。
   *
   * @param {string} text
   * @returns {Uint8Array}
   */
  function utf8Bytes(text) {
    var s = String(text === null || text === undefined ? '' : text);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        // 代理对：两个 UTF-16 码元合成一个码点
        var c2 = s.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        i++;
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return new Uint8Array(out);
  }

  /**
   * 打一个 ZIP 包（存储方式）。
   *
   * 格式（一条记录）：
   *   本地文件头 0x04034b50 → 数据 → … → 中央目录头 0x02014b50 → … → 结束记录 0x06054b50
   *
   * @param {{name: string, data: Uint8Array}[]} entries
   * @returns {Uint8Array} 整个包
   */
  function zipBytes(entries) {
    var list = entries || [];
    var parts = [];
    var central = [];
    var offset = 0;

    list.forEach(function (entry) {
      var name = utf8Bytes(entry.name);
      var data = entry.data || new Uint8Array(0);
      var crc = crc32(data);

      var head = new Uint8Array(30 + name.length);
      var dv = new DataView(head.buffer);
      dv.setUint32(0, 0x04034b50, true);   // 本地文件头的签名
      dv.setUint16(4, 20, true);          // 解压需要的版本：2.0
      dv.setUint16(6, 0x0800, true);      // 标志位：文件名是 UTF-8
      dv.setUint16(8, 0, true);           // 压缩方式：0 = 存储
      dv.setUint16(10, 0, true);          // 修改时间（1980-01-01 00:00）
      dv.setUint16(12, 0x21, true);       // 修改日期（1980-01-01）
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);   // 压缩后的大小
      dv.setUint32(22, data.length, true);   // 原始大小
      dv.setUint16(26, name.length, true);
      dv.setUint16(28, 0, true);             // 扩展字段的长度
      head.set(name, 30);

      central.push({ name: name, crc: crc, size: data.length, offset: offset });
      parts.push(head, data);
      offset += head.length + data.length;
    });

    // 中央目录：每个文件一条记录
    var cdStart = offset;
    central.forEach(function (c) {
      var head = new Uint8Array(46 + c.name.length);
      var dv = new DataView(head.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);            // 生成这个包的程序：2.0
      dv.setUint16(6, 20, true);            // 解压需要的版本
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, 0, true);            // 压缩方式
      dv.setUint16(12, 0, true);            // 修改时间
      dv.setUint16(14, 0x21, true);         // 修改日期
      dv.setUint32(16, c.crc, true);
      dv.setUint32(20, c.size, true);
      dv.setUint32(24, c.size, true);
      dv.setUint16(28, c.name.length, true);
      dv.setUint16(30, 0, true);            // 扩展字段
      dv.setUint16(32, 0, true);            // 注释
      dv.setUint16(34, 0, true);            // 起始磁盘号
      dv.setUint16(36, 0, true);            // 内部属性
      dv.setUint32(38, 0, true);            // 外部属性
      dv.setUint32(42, c.offset, true);     // 本地文件头在包里的偏移
      head.set(c.name, 46);
      parts.push(head);
      offset += head.length;
    });

    // 目录结束记录
    var end = new Uint8Array(22);
    var dv2 = new DataView(end.buffer);
    dv2.setUint32(0, 0x06054b50, true);
    dv2.setUint16(4, 0, true);
    dv2.setUint16(6, 0, true);
    dv2.setUint16(8, list.length, true);       // 这个盘上的记录数
    dv2.setUint16(10, list.length, true);      // 总记录数
    dv2.setUint32(12, offset - cdStart, true); // 中央目录的大小
    dv2.setUint32(16, cdStart, true);          // 中央目录的起始位置
    dv2.setUint16(20, 0, true);                // 注释长度
    parts.push(end);

    // 拼起来
    var total = 0;
    parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total);
    var at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  /* ---------- 界面 ---------- */

  /** 这个工具的文案表。 */
  var S = {
    title: t('title', 'Split an image'),
    choose_file: t('choose_file', 'Choose an image file'),
    drop_hint: t('drop_hint', 'You can also drop the file into this box. The file is processed in your browser, nothing is uploaded.'),
    settings_title: t('settings_title', 'Grid'),
    preview_title: t('preview_title', 'Preview'),
    label_grid: t('label_grid', 'Grid size'),
    label_rows: t('label_rows', 'Rows'),
    label_cols: t('label_cols', 'Columns'),
    btn_split: t('btn_split', 'Split the image'),
    btn_zip: t('btn_zip', 'Download all tiles (ZIP)'),
    status_reading: t('status_reading', 'Reading the file…'),
    status_splitting: t('status_splitting', 'Splitting the image…'),
    err_read: t('err_read', 'Could not read the file.'),
    err_decode: t('err_decode', 'This file could not be decoded as an image.'),
    err_split: t('err_split', 'The image could not be split: {reason}'),
    hint_click: t('hint_click', 'Click any tile in the preview to download it on its own.'),
    hint_remainder: t('hint_remainder', 'The image does not divide evenly: the extra pixels go to the last rows and columns, so the tiles differ by one pixel.'),
    hint_clamped: t('hint_clamped', 'The grid was reduced to {rows} × {cols} — a tile cannot be smaller than one pixel.'),
    hint_order: t('hint_order', 'Tiles are numbered from left to right, top to bottom. For Instagram, upload them from the bottom right upwards.'),
    hint_output: t('hint_output', 'Every tile is saved as PNG, without resampling. The picture never leaves your machine.'),
    summary_tiles: t('summary_tiles', '{n} tiles'),
    summary_tile_size: t('summary_tile_size', 'Each tile is at least {width} × {height} px'),
    summary_zip: t('summary_zip', 'The ZIP is {size}')
  };

  window.ItTools.register('image-splitter', function (root) {
    var disposed = false;
    /** 上传了第几张图。用来作废「上一张还没解完」的那次解码。 */
    var fileTicket = 0;

    var state = {
      name: '',
      decoded: null,
      width: 0,
      height: 0,
      rows: 3,
      cols: 3,
      /** 当前网格的切割方案 */
      plan: null,
      /** 鼠标指着的块的序号，-1 表示没指着 */
      hover: -1,
      /** 切好的 ZIP 的字节（切完才有） */
      zip: null
    };

    /* ---------- 卡片 ---------- */

    var upload = C.uploadCard({
      accept: 'image/*',
      label: S.choose_file,
      hint: S.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(D.h('h3', { text: S.title }), upload.card.firstChild);

    var settingsCard = D.h('div.card', { hidden: true });
    var previewCard = D.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(settingsCard);
    root.appendChild(previewCard);

    /* ---------- 设置 ---------- */

    var rowsInput = D.h('input.layui-input', {
      type: 'number', min: 1, max: MAX_GRID, step: 1, value: state.rows,
      style: { width: '96px' }
    });
    var colsInput = D.h('input.layui-input', {
      type: 'number', min: 1, max: MAX_GRID, step: 1, value: state.cols,
      style: { width: '96px' }
    });

    var presetRow = D.h('div.form-actions', null,
      presetButton('2 × 2', 2, 2),
      presetButton('3 × 3', 3, 3),
      presetButton('4 × 4', 4, 4)
    );

    var summaryTiles = D.h('p.field-hint');
    var summarySize = D.h('p.field-hint');
    var gridNote = D.h('p.field-hint');
    var splitProgress = D.h('p.field-hint');
    var splitButton = D.h('button.layui-btn', {
      type: 'button', text: S.btn_split, onclick: splitAll
    });

    settingsCard.appendChild(D.h('h3', { text: S.settings_title }));
    settingsCard.appendChild(U.field(S.label_grid, presetRow));
    settingsCard.appendChild(D.h('div.form-actions', null,
      U.field(S.label_rows, rowsInput),
      U.field(S.label_cols, colsInput)
    ));
    settingsCard.appendChild(summaryTiles);
    settingsCard.appendChild(summarySize);
    settingsCard.appendChild(gridNote);
    settingsCard.appendChild(D.h('div.form-actions', null, splitButton));
    settingsCard.appendChild(splitProgress);

    /* ---------- 预览 ---------- */

    var previewCanvas = D.h('canvas');
    var zipButton = D.h('button.layui-btn', { type: 'button', text: S.btn_zip, onclick: downloadZip });
    var zipRow = D.h('div.form-actions', { hidden: true }, zipButton);
    var zipSize = D.h('p.field-hint');

    previewCard.appendChild(D.h('h3', { text: S.preview_title }));
    previewCard.appendChild(D.h('div.preview-box', null, previewCanvas));
    previewCard.appendChild(D.h('p.field-hint', { text: S.hint_click }));
    previewCard.appendChild(zipRow);
    previewCard.appendChild(zipSize);
    previewCard.appendChild(D.h('p.field-hint', { text: S.hint_order }));
    previewCard.appendChild(D.h('p.field-hint', { text: S.hint_output }));

    rowsInput.addEventListener('input', function () { applyGrid(rowsInput.value, colsInput.value); });
    colsInput.addEventListener('input', function () { applyGrid(rowsInput.value, colsInput.value); });

    previewCanvas.addEventListener('mousemove', function (ev) {
      var i = tileAt(ev.clientX, ev.clientY);
      if (i === state.hover) return;
      state.hover = i;
      drawPreview();
    });
    previewCanvas.addEventListener('mouseleave', function () {
      if (state.hover === -1) return;
      state.hover = -1;
      drawPreview();
    });
    previewCanvas.addEventListener('click', function (ev) {
      var i = tileAt(ev.clientX, ev.clientY);
      if (i < 0) return;
      downloadTile(i);
    });

    /* ---------- 行为 ---------- */

    /**
     * 预设按钮。
     * @param {string} label 按钮上的字
     * @param {number} rows 行数
     * @param {number} cols 列数
     * @returns {HTMLElement}
     */
    function presetButton(label, rows, cols) {
      return D.h('button.layui-btn.layui-btn-primary', {
        type: 'button',
        text: label,
        onclick: function () { applyGrid(rows, cols); }
      });
    }

    /**
     * 改网格：夹到合法范围，重算切割方案，重画预览。
     *
     * @param {*} rows 行数
     * @param {*} cols 列数
     */
    function applyGrid(rows, cols) {
      state.rows = clampGrid(rows);
      state.cols = clampGrid(cols);
      rowsInput.value = String(state.rows);
      colsInput.value = String(state.cols);
      replan();
    }

    /**
     * 重算切割方案并刷新界面。
     *
     * 网格一改，之前切好的块就作废了 —— 那些块是按老网格切的。
     */
    function replan() {
      if (!state.decoded) return;
      var plan = planGrid(state.width, state.height, state.rows, state.cols);
      state.plan = plan;
      state.hover = -1;
      state.zip = null;
      zipRow.hidden = true;
      zipSize.textContent = '';

      var smallest = Math.min.apply(null, plan.widths);
      var largest = Math.max.apply(null, plan.widths);
      var smallestH = Math.min.apply(null, plan.heights);
      var largestH = Math.max.apply(null, plan.heights);

      summaryTiles.textContent = S.summary_tiles.replace('{n}', String(plan.tiles.length));
      summarySize.textContent = S.summary_tile_size
        .replace('{width}', String(smallest))
        .replace('{height}', String(smallestH));

      // 两条提示可能同时成立（网格被收回来的时候，余数也可能还在）。
      // 挨着摆，别让后一条把前一条顶掉 —— 顶掉的话用户就只看到一半的事实。
      var notes = [];

      // 切不匀的时候说清楚：多出来的像素分给了最后几行、最后几列
      if (largest !== smallest || largestH !== smallestH) {
        notes.push(S.hint_remainder);
      }

      // 网格被收回来的时候也要说 —— 静默改掉用户填的数是不行的
      if (plan.rows !== state.rows || plan.cols !== state.cols) {
        notes.push(S.hint_clamped
          .replace('{rows}', String(plan.rows))
          .replace('{cols}', String(plan.cols)));
      }

      gridNote.textContent = notes.join(' ');

      drawPreview();
    }

    /**
     * 画预览：图 + 切割线 + 鼠标指着的那一块。
     *
     * 预览是缩着画的（原图可能几十 MB），
     * 切割线按同一比例画，切的时候用的是原图的全分辨率 —— 两边互不影响。
     */
    function drawPreview() {
      var ctx = previewCanvas.getContext('2d');
      if (!ctx || !state.decoded || !state.plan) return;
      var plan = state.plan;
      var w = previewCanvas.width;
      var h = previewCanvas.height;

      ctx.clearRect(0, 0, w, h);
      try {
        ctx.drawImage(state.decoded.source, 0, 0, w, h);
      } catch (e) {
        return;
      }

      // 切割线
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      var x = 0;
      for (var c = 1; c < plan.widths.length; c++) {
        x += plan.widths[c - 1];
        var dx = Math.round(x / state.width * w) + 0.5;
        ctx.moveTo(dx, 0);
        ctx.lineTo(dx, h);
      }
      var y = 0;
      for (var r = 1; r < plan.heights.length; r++) {
        y += plan.heights[r - 1];
        var dy = Math.round(y / state.height * h) + 0.5;
        ctx.moveTo(0, dy);
        ctx.lineTo(w, dy);
      }
      ctx.stroke();

      // 鼠标指着的那一块：垫一层半透明的底，再描一圈边
      if (state.hover >= 0 && plan.tiles[state.hover]) {
        var tile = plan.tiles[state.hover];
        var x0 = tile.x / state.width * w;
        var y0 = tile.y / state.height * h;
        var tw = tile.width / state.width * w;
        var th = tile.height / state.height * h;
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(x0, y0, tw, th);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, y0 + 1, Math.max(0, tw - 2), Math.max(0, th - 2));
      }
    }

    /**
     * 鼠标指着的是哪一块。
     *
     * @param {number} clientX
     * @param {number} clientY
     * @returns {number} 序号（-1 表示没指着）
     */
    function tileAt(clientX, clientY) {
      if (!state.plan) return -1;
      var rect = previewCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return -1;
      var px = (clientX - rect.left) / rect.width * state.width;
      var py = (clientY - rect.top) / rect.height * state.height;
      var tiles = state.plan.tiles;
      for (var i = 0; i < tiles.length; i++) {
        var tile = tiles[i];
        if (px >= tile.x && px < tile.x + tile.width &&
            py >= tile.y && py < tile.y + tile.height) {
          return i;
        }
      }
      return -1;
    }

    /**
     * 切一块：按源矩形取下这一块，编码成 PNG。
     *
     * 不缩放、不重采样 —— 画的就是原图那一片的像素。
     *
     * @param {*} source 已解码的图
     * @param {object} tile 这一块的位置与大小
     * @returns {Promise<Uint8Array>} PNG 的字节
     */
    function cutTile(source, tile) {
      return new Promise(function (resolve, reject) {
        var canvas;
        try {
          canvas = document.createElement('canvas');
          canvas.width = tile.width;
          canvas.height = tile.height;
          var ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('canvas');
          ctx.drawImage(source, tile.x, tile.y, tile.width, tile.height,
            0, 0, tile.width, tile.height);
        } catch (e) {
          reject(e);
          return;
        }
        if (typeof canvas.toBlob !== 'function') {
          reject(new Error('encode'));
          return;
        }
        canvas.toBlob(function (blob) {
          if (!blob) {
            reject(new Error('encode'));
            return;
          }
          if (typeof blob.arrayBuffer === 'function') {
            blob.arrayBuffer().then(function (buf) {
              resolve(new Uint8Array(buf));
            }, reject);
            return;
          }
          // 老浏览器没有 Blob.arrayBuffer
          var reader = new FileReader();
          reader.onload = function () { resolve(new Uint8Array(reader.result)); };
          reader.onerror = function () { reject(new Error('read')); };
          reader.readAsArrayBuffer(blob);
        }, 'image/png');
      });
    }

    /**
     * 读文件并解码。
     * @param {File} file
     */
    function handleFile(file) {
      if (!file) return;
      var mine = ++fileTicket;
      upload.setStatus(S.status_reading);

      var reader = new FileReader();
      reader.onload = function () {
        if (disposed || mine !== fileTicket) return;
        var bytes;
        try {
          bytes = new Uint8Array(reader.result);
        } catch (e) {
          upload.setStatus(S.err_read, true);
          return;
        }
        C.decodeAny(file, bytes).then(function (decoded) {
          if (disposed || mine !== fileTicket) return;
          releaseImage();
          state.name = file.name || 'image';
          state.decoded = decoded;
          state.width = decoded.width;
          state.height = decoded.height;
          state.hover = -1;
          state.zip = null;
          upload.setStatus('');
          settingsCard.hidden = false;
          previewCard.hidden = false;
          sizePreview();
          replan();
        }, function () {
          if (disposed || mine !== fileTicket) return;
          upload.setStatus(S.err_decode, true);
        });
      };
      reader.onerror = function () {
        if (disposed || mine !== fileTicket) return;
        upload.setStatus(S.err_read, true);
      };
      reader.readAsArrayBuffer(file);
    }

    /** 把预览画布调到显示用的尺寸（不超过 PREVIEW_MAX）。 */
    function sizePreview() {
      var scale = Math.min(1, PREVIEW_MAX / Math.max(state.width, state.height));
      previewCanvas.width = Math.max(1, Math.round(state.width * scale));
      previewCanvas.height = Math.max(1, Math.round(state.height * scale));
    }

    /**
     * 切出全部块，打成 ZIP。
     *
     * 一块一块切（toBlob 自己是异步的，不会把主线程堵住），
     * 每切完一块报一次进度 —— 20×20 就是 400 块，得让人看见在动。
     */
    function splitAll() {
      if (!state.decoded || !state.plan) return;
      var tiles = state.plan.tiles;
      var done = [];
      var i = 0;
      upload.setStatus(S.status_splitting);

      function step() {
        if (disposed) return;
        if (i >= tiles.length) {
          finish();
          return;
        }
        var tile = tiles[i];
        i++;
        cutTile(state.decoded.source, tile).then(function (bytes) {
          done.push({ name: tileFileName(state.name, tile.index), data: bytes });
          splitProgress.textContent = done.length + ' / ' + tiles.length;
          step();
        }, function (e) {
          upload.setStatus(S.err_split.replace('{reason}', String(e && e.message ? e.message : e)), true);
        });
      }

      function finish() {
        state.zip = zipBytes(done);
        upload.setStatus('');
        splitProgress.textContent = '';
        zipRow.hidden = false;
        zipSize.textContent = S.summary_zip.replace('{size}', C.formatBytes(state.zip.length));
      }

      splitProgress.textContent = '0 / ' + tiles.length;
      step();
    }

    /**
     * 下载单独一块。
     * @param {number} i 块的序号
     */
    function downloadTile(i) {
      var tile = state.plan && state.plan.tiles[i];
      if (!tile || !state.decoded) return;
      cutTile(state.decoded.source, tile).then(function (bytes) {
        window.ItTools.download(tileFileName(state.name, tile.index), bytes, 'image/png');
      }, function (e) {
        upload.setStatus(S.err_split.replace('{reason}', String(e && e.message ? e.message : e)), true);
      });
    }

    /** 下载整包。 */
    function downloadZip() {
      if (!state.zip) return;
      window.ItTools.download(zipFileName(state.name), state.zip, 'application/zip');
    }

    /** 释放上一张图（ImageBitmap 不关掉就一直占着内存）。 */
    function releaseImage() {
      if (state.decoded && typeof state.decoded.close === 'function') {
        try { state.decoded.close(); } catch (e) { /* 已经关了 */ }
      }
      state.decoded = null;
    }

    return {
      destroy: function () {
        disposed = true;
        releaseImage();
        state.zip = null;
      }
    };
  });

  /* ---------- 纯逻辑（给 harness 用） ---------- */

  window.ItTools.logic['image-splitter'] = {
    clampGrid: clampGrid,
    splitEdge: splitEdge,
    planGrid: planGrid,
    tileFileName: tileFileName,
    zipFileName: zipFileName,
    crc32: crc32,
    utf8Bytes: utf8Bytes,
    zipBytes: zipBytes,

    __cases: function (assert) {
      /* ---- 网格大小 ---- */

      assert.eq(clampGrid(3), 3, '3 就是 3');
      assert.eq(clampGrid(0), 1, '0 夹到 1');
      assert.eq(clampGrid(-5), 1, '负数夹到 1');
      assert.eq(clampGrid(21), MAX_GRID, '超过上限夹到上限');
      assert.eq(clampGrid('abc'), 1, '不是数字就用 1');
      assert.eq(clampGrid(''), 1, '空的就用 1');
      assert.eq(clampGrid(3.9), 3, '小数往下取整');

      /* ---- 一条边怎么切 ---- */

      assert.eq(splitEdge(1000, 3), [333, 333, 334], '余数给最后一份');
      assert.eq(splitEdge(100, 4), [25, 25, 25, 25], '正好切完');
      assert.eq(splitEdge(10, 4), [2, 2, 3, 3], '余下的两像素给最后两份');
      assert.eq(splitEdge(3, 1), [3], '切一份就是原样');
      assert.eq(splitEdge(9, 3).reduce(function (a, b) { return a + b; }, 0), 9, '切完的总长还是原来那么长');

      /* ---- 切割方案 ---- */

      var plan = planGrid(100, 100, 3, 3);
      assert.eq(plan.tiles.length, 9, '3×3 是 9 块');
      assert.eq(plan.widths, [33, 33, 34], '列宽是 33/33/34');
      assert.eq(plan.heights, [33, 33, 34], '行高是 33/33/34');
      assert.eq(plan.tiles[0], { index: 1, row: 0, col: 0, x: 0, y: 0, width: 33, height: 33 },
        '第一块在左上角');
      assert.eq(plan.tiles[1].col, 1, '第二块在同一行的右边');
      assert.eq(plan.tiles[1].x, 33, '第二块接在第一块后面');
      assert.eq(plan.tiles[3].row, 1, '第四块换行了');
      assert.eq(plan.tiles[3].y, 33, '第四块在第二行');
      assert.eq(plan.tiles[8].x, 66, '最后一块的 x 是前两列之和');
      assert.eq(plan.tiles[8].y, 66, '最后一块的 y 是前两行之和');
      assert.eq(plan.tiles[8].index, 9, '序号从 1 开始');

      // 所有块加起来正好是原图 —— 少一个像素就拼不回去了
      var area = plan.tiles.reduce(function (sum, tile) { return sum + tile.width * tile.height; }, 0);
      assert.eq(area, 100 * 100, '所有块的面积加起来正好是原图');
      var edge = plan.tiles.reduce(function (sum, tile) { return sum + tile.width; }, 0);
      assert.eq(edge, 300, '每一行的宽度加起来是原图的宽 × 行数');

      /* ---- 网格比图片还细 ---- */

      var tiny = planGrid(3, 3, 4, 4);
      assert.eq(tiny.rows, 3, '行数收到图片的高度');
      assert.eq(tiny.cols, 3, '列数收到图片的宽度');
      assert.eq(tiny.tiles.length, 9, '每一块都至少有一个像素');
      assert.eq(tiny.tiles.every(function (tile) {
        return tile.width >= 1 && tile.height >= 1;
      }), true, '没有空块');

      /* ---- 文件名 ---- */

      assert.eq(tileFileName('photo.png', 3), 'photo-3.png', '图块的名字');
      assert.eq(tileFileName('照片.heic', 1), '照片-1.png', '图块一律是 PNG');
      assert.eq(tileFileName('noext', 2), 'noext-2.png', '没有扩展名也照样加序号');
      assert.eq(zipFileName('photo.png'), 'photo-tiles.zip', 'ZIP 包的名字');

      /* ---- CRC-32 ---- */

      var nine = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
      assert.eq(crc32(nine), 0xCBF43926, 'CRC-32 的标准测试值');
      assert.eq(crc32(new Uint8Array(0)), 0, '空的是 0');

      /* ---- UTF-8 ---- */

      assert.eq(Array.from(utf8Bytes('A')), [0x41], 'ASCII 就是一个字节');
      assert.eq(Array.from(utf8Bytes('é')), [0xC3, 0xA9], '两字节的字符');
      assert.eq(Array.from(utf8Bytes('图')), [0xE5, 0x9B, 0xBE], '三字节的字符');

      /* ---- ZIP ---- */

      var zip = zipBytes([{ name: 'a.txt', data: new Uint8Array([1, 2, 3]) }]);
      assert.eq(Array.from(zip.subarray(0, 4)), [0x50, 0x4B, 0x03, 0x04], '以本地文件头开头');
      assert.eq(Array.from(zip.subarray(zip.length - 22, zip.length - 18)),
        [0x50, 0x4B, 0x05, 0x06], '以目录结束记录结尾');
      var tail = zip.subarray(zip.length - 22);
      assert.eq(tail[10] | (tail[11] << 8), 1, '里面有一个文件');
      assert.eq(tail[8] | (tail[9] << 8), 1, '这个盘上也是一条记录');

      // 两个文件：条目数要跟着变
      var two = zipBytes([
        { name: 'a.txt', data: new Uint8Array([1]) },
        { name: 'b.txt', data: new Uint8Array([2]) }
      ]);
      var tail2 = two.subarray(two.length - 22);
      assert.eq(tail2[10] | (tail2[11] << 8), 2, '两个文件就是两条记录');
    }
  };
})();
