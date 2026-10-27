/* ==========================================================================
   Base64 文件转换器（base64-file-converter）

   两个方向：
   - 文件 -> base64：<input type="file"> + FileReader.readAsDataURL
   - base64 -> 文件：猜 MIME（先看 data URI 前缀，再看文件头魔数）、
     预览图片、按指定文件名下载

   参考实现：src/tools/base64-file-converter/ + src/composable/downloadBase64.ts
   （it-tools, GPLv3）
   与原版的差别：
   1. 原版扩展名靠 mime-types 包反查，这里内置一张常用扩展名表，未知类型落到 txt。
   2. 原版 FileReader 那条路（useBase64）把 data URI 前缀也塞进结果，
      这里只取逗号后面的纯 base64 负载 —— 否则直接拿去当 data URI 会双重编码。
   3. 原版下载用 Blob + URL.createObjectURL，这里复用 app.js 的 ItTools.download。
   4. 超过 LARGE_FILE_HINT 的大文件会先提示，避免浏览器直接把标签页卡死。
   5. 补了粘贴（上游 #1147）：剪贴板里带文件就当文件读，带纯文本就填进
      base64 框 —— 「复制一张截图直接 Ctrl+V」是最常见的用法，原版只给
      选文件与拖拽两条路。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('base64-file-converter');

  /** 超过这个大小就先提醒用户：base64 会把体积撑大 4/3，主线程解码也会卡。 */
  var LARGE_FILE_HINT = 2 * 1024 * 1024;

  /** 文件头魔数 —— base64 的前几个字符对应文件头，用来猜 MIME。 */
  var SIGNATURES = [
    { signature: 'JVBERi0', mimeType: 'application/pdf' },
    { signature: 'R0lGODdh', mimeType: 'image/gif' },
    { signature: 'R0lGODlh', mimeType: 'image/gif' },
    { signature: 'iVBORw0KGgo', mimeType: 'image/png' },
    { signature: '/9j/', mimeType: 'image/jpeg' }
  ];

  /** MIME -> 常用扩展名（只列日常会遇到的，替代 mime-types 包）。 */
  var EXTENSIONS = {
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/gzip': 'gz',
    'application/json': 'json',
    'application/javascript': 'js',
    'application/xml': 'xml',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/css': 'css',
    'text/csv': 'csv'
  };

  var DATA_URI_PREFIX = /^data:.*?;base64,/i;

  /** 剥掉 data URI 前缀，只留 base64 负载。 */
  function stripDataUri(str) {
    return String(str == null ? '' : str).replace(DATA_URI_PREFIX, '').replace(/\s/g, '');
  }

  /** 去掉尾部多余填充，方便算长度。 */
  function withoutPadding(str) { return stripDataUri(str).replace(/=+$/, ''); }

  /**
   * 猜 MIME：优先看 data URI 前缀，其次匹配文件头魔数。
   * @returns {string|undefined}
   */
  function getMimeTypeFromBase64(base64String) {
    var raw = String(base64String == null ? '' : base64String);
    var fromUri = raw.match(/data:(.*?);base64/i);
    if (fromUri) return fromUri[1];
    var clean = stripDataUri(raw);
    for (var i = 0; i < SIGNATURES.length; i++) {
      if (clean.indexOf(SIGNATURES[i].signature) === 0) return SIGNATURES[i].mimeType;
    }
    return undefined;
  }

  /** MIME -> 扩展名，未知类型回落到 txt（与参考实现的 defaultExtension 一致）。 */
  function getExtensionFromMimeType(mimeType, defaultExtension) {
    if (!mimeType) return defaultExtension || 'txt';
    return EXTENSIONS[String(mimeType).toLowerCase()] || defaultExtension || 'txt';
  }

  /** base64 负载的字节数（填充算 0 位）。 */
  function byteLength(base64String) {
    var clean = withoutPadding(base64String);
    if (!clean.length) return 0;
    var tail = clean.length % 4;
    return ((clean.length - (tail === 1 ? 3 : tail)) / 4) * 3 + (tail === 0 ? 0 : tail - 1);
  }

  /**
   * 校验 base64：解码成字节再重新编码，逐字比较。
   * （与 base64-string-converter 同款策略，这里不接受无填充形式。）
   */
  function isValidBase64(base64String) {
    var clean = stripDataUri(base64String);
    if (!clean.length) return false;
    try {
      return U.bytesToBase64(U.base64ToBytes(clean)) === clean;
    } catch (e) {
      return false;
    }
  }

  /** 解出字节，失败返回 null。 */
  function toBytes(base64String) {
    if (!isValidBase64(base64String)) return null;
    try { return U.base64ToBytes(stripDataUri(base64String)); }
    catch (e) { return null; }
  }

  /** 文件大小的人类可读描述。 */
  function humanSize(bytes) {
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(2)) + ' ' + units[i];
  }

  window.ItTools.register('base64-file-converter', function (root) {
    /* ---- base64 -> 文件 ---- */

    var fileNameInput = D.h('input.layui-input', { type: 'text', value: 'file' });
    var extensionInput = D.h('input.layui-input', { type: 'text', value: '', placeholder: t('extension_ph', 'Extension') });
    var base64Input = D.h('textarea.layui-textarea', { rows: 5, placeholder: t('base64_ph', 'Put your base64 file string here...') });
    var base64Status = D.h('p.field-hint');
    var previewBox = D.h('div.preview-box');
    var fileButtons = D.h('div.form-actions');

    /* ---- 文件 -> base64 ---- */

    var filePicker = D.h('input', { type: 'file' });
    var fileOutput = D.h('textarea.layui-textarea', { rows: 5, readonly: true, placeholder: t('file_ph', 'File in base64 will be here') });
    var fileStatus = D.h('p.field-hint');

    var guessedMime;

    function setPreviewImage(bytes) {
      D.clear(previewBox);
      if (!bytes) return;
      var img = D.h('img', { style: { maxWidth: '100%', maxHeight: '400px' } });
      var blob = new Blob([bytes], { type: guessedMime || 'application/octet-stream' });
      img.src = URL.createObjectURL(blob);
      img.addEventListener('load', function () { URL.revokeObjectURL(img.src); });
      previewBox.appendChild(img);
    }

    function renderToFile() {
      var raw = base64Input.value;
      var bytes = toBytes(raw);
      var clean = stripDataUri(raw);

      guessedMime = getMimeTypeFromBase64(raw);
      if (guessedMime && !extensionInput.value.trim()) {
        extensionInput.value = getExtensionFromMimeType(guessedMime);
      }

      var messages = [];
      if (raw.trim() && !bytes) messages.push(t('err_invalid_base64', 'Invalid base64 string'));
      if (bytes) {
        messages.push(t('file_info', 'MIME: {mime} · Size: {size} · base64 {b64}')
          .replace('{mime}', guessedMime || t('unknown', 'unknown'))
          .replace('{size}', humanSize(bytes.length))
          .replace('{b64}', humanSize(clean.length)));
        if (bytes.length > LARGE_FILE_HINT) {
          messages.push(t('large_file', '⚠ This file is fairly large; decoding and downloading may take a few seconds.'));
        }
      }
      base64Status.textContent = messages.join('　|　');
      base64Status.classList.toggle('is-error', !!raw.trim() && !bytes);

      setPreviewImage(bytes && /^image\//.test(guessedMime || '') ? bytes : null);

      D.clear(fileButtons);
      if (bytes) {
        fileButtons.appendChild(D.h('button.layui-btn.layui-btn-primary', {
          type: 'button',
          text: t('download_file', 'Download file'),
          onclick: function () {
            var name = fileNameInput.value.trim() || 'file';
            var ext = extensionInput.value.trim();
            window.ItTools.download(ext ? name + '.' + ext : name, bytes, guessedMime || 'application/octet-stream');
          }
        }));
      }
    }

    base64Input.addEventListener('input', renderToFile);
    fileNameInput.addEventListener('input', renderToFile);
    extensionInput.addEventListener('input', renderToFile);

    /* 选文件/拖文件 -> 读成 base64。两条路都汇到 handleFile，
       免得去给 <input> 硬塞 FileList（那在部分浏览器里会抛 TypeError）。 */
    function handleFile(file) {
      if (!file) return;
      if (!fileNameInput.value.trim() || fileNameInput.value.trim() === 'file') {
        fileNameInput.value = file.name.replace(/\.[^.]*$/, '') || 'file';
      }
      extensionInput.value = file.name.indexOf('.') > -1 ? file.name.split('.').pop() : extensionInput.value;

      if (file.size > LARGE_FILE_HINT) {
        fileStatus.textContent = t('large_file_hint', '⚠ File {size} is fairly large; reading may take a few seconds and the base64 output will grow to about {b64}.')
          .replace('{size}', humanSize(file.size))
          .replace('{b64}', humanSize(Math.ceil(file.size / 3) * 4));
        fileStatus.classList.add('is-error');
      } else {
        fileStatus.textContent = '';
        fileStatus.classList.remove('is-error');
      }

      var reader = new FileReader();
      // 只取 data URI 前缀之后的部分 —— 前缀是给 <img src> 用的，直接当负载会双重编码
      reader.onload = function () {
        fileOutput.value = stripDataUri(String(reader.result || ''));
      };
      reader.onerror = function () {
        fileOutput.value = '';
        fileStatus.textContent = t('read_error', 'Failed to read the file.');
        fileStatus.classList.add('is-error');
      };
      reader.readAsDataURL(file);
    }

    filePicker.addEventListener('change', function () {
      handleFile(filePicker.files && filePicker.files[0]);
    });

    /* ---- 粘贴（上游 #1147）----
       最常见的用法是「复制一张截图，直接 Ctrl+V」—— 只给选文件和拖拽两条路的话，
       这一步什么都不发生。剪贴板里带文件就走 handleFile()，带纯文本就填进
       base64 输入框（那是「base64 → 文件」那个方向）。

       监听挂在 document 上：焦点落在页面空白处（target 是 body）时，
       事件不会经过工具根节点，挂在根节点上就收不到。
       代价是要自己判断焦点 —— 焦点在文本框里时不劫持文本的粘贴，
       让浏览器自己处理（原生粘贴还能进撤销栈）。 */
    function onPaste(e) {
      var dt = e.clipboardData;
      if (!dt) return;
      var items = dt.items || [];

      // 1) 剪贴板里有文件（截图、复制的文件）→ 走「文件 → base64」那条路
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            handleFile(file);
            return;
          }
        }
      }

      // 2) 只有文本：焦点在输入框/文本域里就交给浏览器，插到 base64 框里
      var target = e.target;
      var isTextField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (isTextField) return;
      var text = dt.getData('text/plain');
      if (text) {
        e.preventDefault();
        base64Input.value = text;
        renderToFile();
      }
    }
    document.addEventListener('paste', onPaste);

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('base64_to_file', 'Base64 to file') }),
      // 原版是 n-grid 里的两个 c-input-text：标签在上（不是左边），
      // 文件名占 2/3、扩展名占 1/3。
      D.h('div', { style: { display: 'flex', gap: '12px', flex: '1 1 0', minWidth: '0' } },
        D.h('div', { style: { flex: '2 1 0', minWidth: '0' } },
          U.field(t('file_name', 'File Name'), fileNameInput, { wide: true })),
        D.h('div', { style: { flex: '1 1 0', minWidth: '0' } },
          U.field(t('extension', 'Extension'), extensionInput, { wide: true }))
      ),
      U.field(t('base64_file_string', 'Base64 file string'), base64Input, { wide: true }),
      base64Status,
      previewBox,
      fileButtons
    ));

    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('file_to_base64', 'File to base64') }),
      D.h('div.preview-box', null,
        D.h('div', null,
          D.h('label.field-label', { text: t('drop_label', 'Drag a file here, or click the button below to choose one') }),
          filePicker,
          D.h('p.field-hint', { text: t('drop_hint', 'You can also drop a file straight into this box, or press Ctrl+V on the page to paste a screenshot.') })
        )
      ),
      fileStatus,
      U.field(t('file_in_base64', 'File in base64'), fileOutput, { wide: true }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return fileOutput.value; }, t('copy_base64', 'Copy base64'))
      )
    ));

    // 支持拖拽：直接把手上的 File 交给 handleFile
    var dropBox = root.querySelector('.preview-box');
    dropBox.addEventListener('dragover', function (e) { e.preventDefault(); });
    dropBox.addEventListener('drop', function (e) {
      e.preventDefault();
      handleFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });

    renderToFile();

    return {
      destroy: function () {
        document.removeEventListener('paste', onPaste);
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['base64-file-converter'] = {
    stripDataUri: stripDataUri,
    getMimeTypeFromBase64: getMimeTypeFromBase64,
    getExtensionFromMimeType: getExtensionFromMimeType,
    byteLength: byteLength,
    isValidBase64: isValidBase64,
    toBytes: toBytes,
    humanSize: humanSize,
    __cases: function (assert) {
      // MIME 嗅探：先看 data URI 前缀
      assert.eq(getMimeTypeFromBase64('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA'), 'image/png', 'data URI 里的 png');
      assert.eq(getMimeTypeFromBase64('data:image/jpg;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA'), 'image/jpg', 'data URI 里的 jpg');
      assert.eq(getMimeTypeFromBase64('data:application/pdf;base64,JVBERi0'), 'application/pdf', 'data URI 里的 pdf');
      // 没有前缀就按魔数猜（与参考实现 downloadBase64 的单测一致）
      assert.eq(getMimeTypeFromBase64('iVBORw0KGgoAAAANSUhEUgAAAAUA'), 'image/png', '魔数 png');
      assert.eq(getMimeTypeFromBase64('R0lGODdh'), 'image/gif', '魔数 gif 87a');
      assert.eq(getMimeTypeFromBase64('R0lGODlh'), 'image/gif', '魔数 gif 89a');
      assert.eq(getMimeTypeFromBase64('/9j/'), 'image/jpeg', '魔数 jpeg');
      assert.eq(getMimeTypeFromBase64('JVBERi0'), 'application/pdf', '魔数 pdf');
      assert.eq(getMimeTypeFromBase64('JVBERi'), undefined, '认不出来的返回 undefined');
      assert.eq(getMimeTypeFromBase64(''), undefined, '空串返回 undefined');

      assert.eq(getExtensionFromMimeType('image/png'), 'png', 'png 扩展名');
      assert.eq(getExtensionFromMimeType('image/jpeg'), 'jpg', 'jpeg 扩展名');
      assert.eq(getExtensionFromMimeType(undefined), 'txt', '未知类型落到 txt');
      assert.eq(getExtensionFromMimeType('application/x-whatever'), 'txt', '没收录的类型落到 txt');
      assert.eq(getExtensionFromMimeType(undefined, 'bin'), 'bin', '可以指定默认值');

      assert.eq(stripDataUri('data:image/png;base64,iVBORw0KGgo='), 'iVBORw0KGgo=', '剥前缀');
      assert.eq(stripDataUri('iVBORw0KGgo=\n'), 'iVBORw0KGgo=', '顺带去空白');
      assert.eq(byteLength('aGVsbG8='), 5, 'hello 是 5 字节');
      assert.eq(byteLength('aGVsbA=='), 4, 'hell 是 4 字节');
      assert.eq(byteLength('data:text/plain;base64,aGVsbG8='), 5, '带前缀也算 5 字节');
      assert.eq(byteLength(''), 0, '空串 0 字节');

      assert(isValidBase64('aGVsbG8='), '合法 base64');
      assert(isValidBase64('data:text/plain;base64,aGVsbG8='), '带前缀也合法');
      assert(!isValidBase64(''), '空串不合法');
      assert(!isValidBase64('aGVsbG8*'), '非法字符不合法');
      assert.eq(toBytes('aGVsbG8=').length, 5, '解出 5 字节');
      assert.eq(U.utf8Decode(toBytes('aGVsbG8=')), 'hello', '解出来是 hello');
      assert.eq(toBytes('bad!'), null, '非法输入返回 null');

      assert.eq(humanSize(0), '0 B', '0 字节');
      assert.eq(humanSize(512), '512 B', '不足 1 KB');
      assert.eq(humanSize(1024), '1.00 KB', '1 KB');
      assert.eq(humanSize(1024 * 1024 * 3), '3.00 MB', '3 MB');
    }
  };
})();