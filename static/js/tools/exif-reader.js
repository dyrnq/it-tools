/* ==========================================================================
   EXIF 信息读取器（exif-reader）

   上传一张图片，把里面的 EXIF / IPTC / XMP / GPS 等元数据读出来。
   常用的几个字段（厂商、型号、拍摄时间、曝光参数、GPS）单独列在前面，
   全部字段按分组列在后面。

   参考实现：it-tools PR #865 的 src/tools/image-exif-reader/
   （上游 it-tools, GPLv3）
   与上游的差别：
   1. 上游用 exifreader 4.x 的 ESM 入口 + Vue3 / naive-ui；这里用同一份库的
      UMD 产物（挂在 window.ExifReader 上）+ layui + 原生 DOM，
      与本项目「没有打包器」的约束对齐。
   2. 上游只有一个「按分组罗列全部标签」的列表；这里多一个摘要区，
      把最常看的几个字段提到最前面。
   3. 上游的 GPS 只给十进制度；这里同时给度分秒与 OpenStreetMap 链接。
   4. 上游不区分「这不是图片」与「图片里没有 EXIF」；这里分开报，
      没有 EXIF 时把能读到的其它字段照常列出来。
   5. 上游顺带用 jpeg-quality-estimator 估 JPEG 质量；这里不做 ——
      多一个依赖换一条用不上的信息，不划算。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('exif-reader');

  /* ---------- 图片格式识别（看文件头，不看扩展名） ---------- */

  var IMAGE_SIGNATURES = [
    { kind: 'jpeg', mime: 'image/jpeg', magic: [0xFF, 0xD8, 0xFF] },
    { kind: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
    { kind: 'gif', mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
    { kind: 'bmp', mime: 'image/bmp', magic: [0x42, 0x4D] },
    { kind: 'tiff', mime: 'image/tiff', magic: [0x49, 0x49, 0x2A, 0x00] },
    { kind: 'webp', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
    { kind: 'heif', mime: 'image/heif', magic: [0x66, 0x74, 0x79, 0x70] },
    { kind: 'svg', mime: 'image/svg+xml', magic: [0x3C, 0x73, 0x76, 0x67] }
  ];

  /**
   * 按文件头判断图片格式。认不出来返回 null。
   * @param {Uint8Array} bytes 文件开头的一段
   * @returns {{kind: string, mime: string}|null}
   */
  function detectImageType(bytes) {
    if (!bytes || bytes.length < 3) return null;
    for (var i = 0; i < IMAGE_SIGNATURES.length; i++) {
      var sig = IMAGE_SIGNATURES[i];
      if (bytes.length < sig.magic.length) continue;
      var matched = true;
      for (var j = 0; j < sig.magic.length; j++) {
        if (bytes[j] !== sig.magic[j]) { matched = false; break; }
      }
      if (!matched) continue;
      // RIFF 容器：第 8~11 字节才是 'WEBP'，只看 'RIFF' 会把 WAV/AVI 也当成图片
      if (sig.kind === 'webp') {
        if (bytes.length < 12) continue;
        if (bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) continue;
      }
      return { kind: sig.kind, mime: sig.mime };
    }
    return null;
  }

  /* ---------- 通用小工具 ---------- */

  /** 字节数 → 人类可读的大小。 */
  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var value = n / 1024;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return value.toFixed(2) + ' ' + units[i];
  }

  /** 标签名 → 可读的标签名：ISOSpeedRatings → ISO Speed Ratings。 */
  function tagLabel(name) {
    // 有些标签名本身就带空格（Exif IFD Pointer），补空格之后会变成两个 —— 收一下
    return String(name == null ? '' : name).replace(/([A-Z][a-z])/g, ' $1').replace(/\s+/g, ' ').trim();
  }

  /**
   * 标签 → 可显示的值。优先用库算好的 description，
   * 没有就退回原始值；二进制的给个占位，别把一串数字糊在界面上。
   */
  function tagValue(tag) {
    if (!tag || typeof tag !== 'object') return '';
    if (typeof tag.description === 'string' && tag.description !== '') return tag.description;
    // 有些标签的 description 是算好的数字（GPS 坐标、ISO 之类），不是字符串
    if (typeof tag.description === 'number' && isFinite(tag.description)) return String(tag.description);
    var value = tag.value;
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) {
      if (!value.length) return '';
      var printable = value.every(function (v) {
        return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';
      });
      return printable ? value.join(', ') : '<binary>';
    }
    if (typeof value === 'object') return '<binary>';
    return String(value);
  }

  /* ---------- GPS ---------- */

  /** 有理数 [分子, 分母] → 数值；不是有理数就当普通数字。 */
  function rationalToNumber(pair) {
    if (Array.isArray(pair)) {
      var n = Number(pair[0]);
      var d = Number(pair[1]);
      if (!isFinite(n) || !isFinite(d) || d === 0) return 0;
      return n / d;
    }
    var v = Number(pair);
    return isFinite(v) ? v : 0;
  }

  /**
   * exifreader 给的度分秒是三个有理数对：[[度], [分], [秒]]。
   * @returns {number[]|null} [度, 分, 秒]
   */
  function dmsParts(value) {
    if (!Array.isArray(value) || value.length < 3) return null;
    return [rationalToNumber(value[0]), rationalToNumber(value[1]), rationalToNumber(value[2])];
  }

  /**
   * 度分秒 → 十进制度。ref 为 'S' / 'W' 时取负。
   * @returns {number|null}
   */
  function dmsToDecimal(deg, min, sec, ref) {
    var d = Number(deg);
    var m = Number(min || 0);
    var s = Number(sec || 0);
    if (!isFinite(d) || !isFinite(m) || !isFinite(s)) return null;
    var value = Math.abs(d) + m / 60 + s / 3600;
    var letter = String(ref == null ? '' : ref).trim().toUpperCase();
    if (letter === 'S' || letter === 'W') value = -value;
    return value;
  }

  /**
   * 十进制度 → 度分秒字符串，例如 50° 4′ 4.3″ N。
   * @param {number} decimal 带符号的十进制度
   * @param {string} ref 半球字母（N/S/E/W）；没给就按符号猜
   * @returns {string}
   */
  function formatDms(decimal, ref) {
    if (typeof decimal !== 'number' || !isFinite(decimal)) return '';
    var abs = Math.abs(decimal);
    var deg = Math.floor(abs);
    var minutes = (abs - deg) * 60;
    var min = Math.floor(minutes);
    var sec = Math.round((minutes - min) * 600) / 10;
    if (sec >= 60) { sec -= 60; min += 1; }
    if (min >= 60) { min -= 60; deg += 1; }
    var letter = String(ref == null ? '' : ref).trim().toUpperCase();
    if (!letter) letter = decimal < 0 ? 'S' : 'N';
    return deg + '° ' + min + '′ ' + sec.toFixed(1) + '″ ' + letter;
  }

  /**
   * 经纬度 → OpenStreetMap 链接。
   * @returns {string} 不是数字就返回空串
   */
  function openStreetMapUrl(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number') return '';
    if (!isFinite(lat) || !isFinite(lon)) return '';
    var a = lat.toFixed(6);
    var b = lon.toFixed(6);
    return 'https://www.openstreetmap.org/?mlat=' + a + '&mlon=' + b + '#map=18/' + a + '/' + b;
  }

  /** 取半球字母：优先用 EXIF 里的 ref，没有就按正负猜。 */
  function hemisphereLetter(tag, positive, negative) {
    if (tag && typeof tag.value === 'object' && !Array.isArray(tag.value)) {
      var v = tag.value;
      if (typeof v === 'string' && v) return v.trim().toUpperCase().charAt(0);
    }
    if (tag && Array.isArray(tag.value) && tag.value.length) {
      var first = tag.value[0];
      if (typeof first === 'string' && first) return first.trim().toUpperCase().charAt(0);
    }
    return '';
  }

  /**
   * 从解析结果里抽出 GPS 信息。
   * @returns {{latitude:number, longitude:number, altitude:number|null,
   *            latDms:string, lonDms:string, mapUrl:string}|null}
   */
  function gpsInfo(tags) {
    var gps = tags && tags.gps;
    if (!gps || typeof gps !== 'object') return null;
    var lat = gps.Latitude;
    var lon = gps.Longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    if (!isFinite(lat) || !isFinite(lon)) return null;

    var exif = (tags && tags.exif) || {};
    var latRef = hemisphereLetter(exif.GPSLatitudeRef, 'N', 'S') || (lat < 0 ? 'S' : 'N');
    var lonRef = hemisphereLetter(exif.GPSLongitudeRef, 'E', 'W') || (lon < 0 ? 'W' : 'E');
    var altitude = (typeof gps.Altitude === 'number' && isFinite(gps.Altitude)) ? gps.Altitude : null;

    return {
      latitude: lat,
      longitude: lon,
      altitude: altitude,
      latDms: formatDms(lat, latRef),
      lonDms: formatDms(lon, lonRef),
      mapUrl: openStreetMapUrl(lat, lon)
    };
  }

  /* ---------- 分组与摘要 ---------- */

  /** 元数据分组的名字与标题（顺序即显示顺序）。 */
  function sectionDefs() {
    return [
      { name: 'file', title: t('section_file', 'File') },
      { name: 'jfif', title: t('section_jfif', 'JFIF') },
      { name: 'exif', title: t('section_exif', 'EXIF') },
      { name: 'iptc', title: t('section_iptc', 'IPTC') },
      { name: 'xmp', title: t('section_xmp', 'XMP') },
      { name: 'photoshop', title: t('section_photoshop', 'Photoshop') },
      { name: 'icc', title: t('section_icc', 'ICC') },
      { name: 'png', title: t('section_png', 'PNG') },
      { name: 'pngFile', title: t('section_png_file', 'PNG file') },
      { name: 'pngText', title: t('section_png_text', 'PNG text') },
      { name: 'gif', title: t('section_gif', 'GIF') },
      { name: 'riff', title: t('section_riff', 'RIFF') },
      { name: 'mpf', title: t('section_mpf', 'MPF') },
      { name: 'vp8x', title: t('section_vp8x', 'VP8X') }
    ];
  }

  /** 摘要区要列的字段：第一个命中的标签名胜出。 */
  function summaryFields() {
    return [
      { label: t('sum_make', 'Camera make'), tags: ['Make'] },
      { label: t('sum_model', 'Camera model'), tags: ['Model'] },
      { label: t('sum_date', 'Date taken'), tags: ['DateTimeOriginal', 'DateTimeDigitized', 'CreateDate', 'DateTime'] },
      { label: t('sum_exposure', 'Exposure time'), tags: ['ExposureTime'] },
      { label: t('sum_aperture', 'Aperture'), tags: ['FNumber', 'ApertureValue'] },
      { label: t('sum_iso', 'ISO'), tags: ['ISOSpeedRatings', 'ISOSpeed', 'PhotographicSensitivity'] },
      { label: t('sum_focal', 'Focal length'), tags: ['FocalLength', 'FocalLengthIn35mmFormat'] },
      { label: t('sum_lens', 'Lens'), tags: ['LensModel', 'Lens'] },
      { label: t('sum_program', 'Exposure program'), tags: ['ExposureProgram'] },
      { label: t('sum_metering', 'Metering mode'), tags: ['MeteringMode'] },
      { label: t('sum_flash', 'Flash'), tags: ['Flash'] },
      { label: t('sum_white_balance', 'White balance'), tags: ['WhiteBalance'] },
      { label: t('sum_orientation', 'Orientation'), tags: ['Orientation'] },
      { label: t('sum_width', 'Width'), tags: ['ImageWidth', 'PixelXDimension'] },
      { label: t('sum_height', 'Height'), tags: ['ImageLength', 'PixelYDimension'] },
      { label: t('sum_software', 'Software'), tags: ['Software'] },
      { label: t('sum_artist', 'Artist'), tags: ['Artist'] },
      { label: t('sum_copyright', 'Copyright'), tags: ['Copyright'] }
    ];
  }

  /**
   * 挑出摘要区的行。
   * @param {object} tags 展开后的标签
   * @returns {{label:string, value:string}[]}
   */
  function pickSummary(tags) {
    var exif = (tags && tags.exif) || {};
    var rows = [];
    summaryFields().forEach(function (field) {
      for (var i = 0; i < field.tags.length; i++) {
        var tag = exif[field.tags[i]];
        if (!tag) continue;
        var value = tagValue(tag);
        if (!value) continue;
        rows.push({ label: field.label, value: value });
        return;
      }
    });
    return rows;
  }

  /**
   * 把展开后的标签按分组整理成可以逐行渲染的形状。
   * @returns {{name:string, title:string, entries:{label:string, value:string}[]}[]}
   */
  function groupSections(tags) {
    if (!tags || typeof tags !== 'object') return [];
    var out = [];
    sectionDefs().forEach(function (def) {
      var section = tags[def.name];
      if (!section || typeof section !== 'object') return;
      var entries = [];
      Object.keys(section).forEach(function (name) {
        var tag = section[name];
        if (!tag || typeof tag !== 'object') return;
        entries.push({ label: tagLabel(name), value: tagValue(tag) });
      });
      if (!entries.length) return;
      out.push({ name: def.name, title: def.title, entries: entries });
    });
    return out;
  }

  /**
   * 给「复制 JSON」用的干净副本：缩略图的 base64 太长，
   * 换成一句长度说明，免得复制出去的东西比原图还大。
   */
  function serializableTags(tags) {
    var out = {};
    if (!tags || typeof tags !== 'object') return out;
    Object.keys(tags).forEach(function (section) {
      var value = tags[section];
      if (section === 'Thumbnail' && value && typeof value.base64 === 'string') {
        out[section] = { base64: '<thumbnail: ' + value.base64.length + ' base64 chars>' };
        return;
      }
      out[section] = value;
    });
    return out;
  }

  /** 有没有真正的 EXIF 元数据（结构信息不算）。 */
  function hasExifSection(tags) {
    return !!(tags && typeof tags === 'object' && tags.exif && typeof tags.exif === 'object');
  }

  window.ItTools.register('exif-reader', function (root) {
    var disposed = false;
    var previewUrl = null;
    var currentTags = null;

    /* ---- 五张卡片：上传 / 文件 / 摘要 / GPS / 全部字段 ---- */

    var uploadCard = D.h('div.card');
    var fileCard = D.h('div.card', { hidden: true });
    var summaryCard = D.h('div.card', { hidden: true });
    var gpsCard = D.h('div.card', { hidden: true });
    var tagsCard = D.h('div.card', { hidden: true });

    root.appendChild(uploadCard);
    root.appendChild(fileCard);
    root.appendChild(summaryCard);
    root.appendChild(gpsCard);
    root.appendChild(tagsCard);

    /* ---- 上传卡片 ---- */

    var fileInput = D.h('input', { type: 'file', accept: 'image/*' });
    var status = D.h('p.field-hint');
    var dropZone = D.h('div.preview-box', null,
      D.h('label.field-label', { text: t('choose_file', 'Choose an image file') }),
      fileInput,
      D.h('p.field-hint', { text: t('drop_hint', 'You can also drop the file into this box. The image is parsed in your browser, nothing is uploaded.') })
    );

    uploadCard.appendChild(D.h('h3', { text: t('upload_title', 'Read EXIF metadata') }));
    uploadCard.appendChild(dropZone);
    uploadCard.appendChild(status);

    /* ---- 文件信息卡片 ---- */

    var fileBody = D.h('div');
    fileCard.appendChild(D.h('h3', { text: t('file_title', 'File') }));
    fileCard.appendChild(fileBody);

    /* ---- 摘要卡片 ---- */

    var summaryBody = D.h('div');
    summaryCard.appendChild(D.h('h3', { text: t('summary_title', 'Summary') }));
    summaryCard.appendChild(summaryBody);

    /* ---- GPS 卡片 ---- */

    var gpsBody = D.h('div');
    gpsCard.appendChild(D.h('h3', { text: t('gps_title', 'GPS') }));
    gpsCard.appendChild(gpsBody);

    /* ---- 全部字段卡片 ---- */

    var tagsBody = D.h('div');
    tagsCard.appendChild(D.h('h3', { text: t('tags_title', 'All metadata fields') }));
    tagsCard.appendChild(tagsBody);

    /* ---------- 渲染 ---------- */

    /** 两列的「字段 / 值」表。 */
    function kvTable(rows) {
      var table = D.h('table.kv-table');
      table.appendChild(D.h('thead', null, D.h('tr', null,
        D.h('th', { text: t('field', 'Field') }),
        D.h('th', { text: t('value', 'Value') })
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

    function setStatus(message, isError) {
      status.textContent = message || '';
      status.classList.toggle('is-error', !!isError);
    }

    function hideAll() {
      fileCard.hidden = true;
      summaryCard.hidden = true;
      gpsCard.hidden = true;
      tagsCard.hidden = true;
    }

    function renderFile(file, kind) {
      D.clear(fileBody);
      var rows = [
        { label: t('file_name', 'Name'), value: file.name || '' },
        { label: t('file_size', 'Size'), value: formatBytes(file.size) },
        { label: t('file_type', 'Format'), value: kind ? kind.kind : t('file_type_unknown', 'unknown') }
      ];
      fileBody.appendChild(kvTable(rows));

      // 预览：object URL 用完要 revoke，否则每换一张图就泄一个 blob
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      if (typeof URL.createObjectURL === 'function' && file.type && /^image\//i.test(file.type)) {
        previewUrl = URL.createObjectURL(file);
        fileBody.appendChild(D.h('img', {
          src: previewUrl,
          alt: file.name || '',
          style: { maxWidth: '100%', maxHeight: '320px', marginTop: '12px' }
        }));
      }
      fileCard.hidden = false;
    }

    function renderSummary(tags) {
      D.clear(summaryBody);
      var rows = pickSummary(tags);
      if (!rows.length) {
        summaryBody.appendChild(D.h('p.field-hint', { text: t('no_summary', 'No common EXIF fields were found in this image.') }));
      } else {
        summaryBody.appendChild(kvTable(rows));
      }
      summaryCard.hidden = false;
    }

    function renderGps(tags) {
      D.clear(gpsBody);
      var info = gpsInfo(tags);
      if (!info) {
        gpsBody.appendChild(D.h('p.field-hint', { text: t('no_gps', 'No GPS information was found in this image.') }));
        gpsCard.hidden = false;
        return;
      }
      var rows = [
        { label: t('gps_latitude', 'Latitude'), value: info.latDms + '  (' + info.latitude.toFixed(6) + ')' },
        { label: t('gps_longitude', 'Longitude'), value: info.lonDms + '  (' + info.longitude.toFixed(6) + ')' }
      ];
      if (info.altitude !== null) {
        rows.push({ label: t('gps_altitude', 'Altitude'), value: info.altitude + ' m' });
      }
      gpsBody.appendChild(kvTable(rows));
      gpsBody.appendChild(D.h('div.form-actions', null,
        D.h('a.layui-btn.layui-btn-primary', {
          href: info.mapUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: t('map_link', 'Open in OpenStreetMap')
        })
      ));
      gpsCard.hidden = false;
    }

    function renderTags(tags) {
      D.clear(tagsBody);
      if (!hasExifSection(tags)) {
        tagsBody.appendChild(D.h('p.field-hint.is-warn', {
          text: t('no_exif', 'This image carries no EXIF metadata. Everything that was found is listed below.')
        }));
      }
      var sections = groupSections(tags);
      if (!sections.length) {
        tagsBody.appendChild(D.h('p.field-hint', { text: t('no_tags', 'No metadata field was found in this image.') }));
      }
      sections.forEach(function (section) {
        tagsBody.appendChild(D.h('h4', { text: section.title }));
        tagsBody.appendChild(kvTable(section.entries));
      });

      // 缩略图单独放 —— 它是一张图，不是一行字段
      var thumb = tags && tags.Thumbnail;
      if (thumb && typeof thumb.base64 === 'string' && thumb.base64) {
        tagsBody.appendChild(D.h('h4', { text: t('section_thumbnail', 'Thumbnail') }));
        tagsBody.appendChild(D.h('img', {
          src: 'data:' + (thumb.type || 'image/jpeg') + ';base64,' + thumb.base64,
          alt: t('section_thumbnail', 'Thumbnail'),
          style: { maxWidth: '100%', maxHeight: '240px' }
        }));
      }

      tagsBody.appendChild(D.h('div.form-actions', null,
        U.copyButton(function () {
          return JSON.stringify(serializableTags(tags), null, 2);
        }, t('copy_json', 'Copy all metadata as JSON'))
      ));
      tagsCard.hidden = false;
    }

    /* ---------- 解析 ---------- */

    function showError(message) {
      setStatus(message, true);
    }

    function handleParseError(err) {
      var name = err && err.name;
      var message = err && err.message ? String(err.message) : String(err);
      if (name === 'MetadataMissingError') {
        showError(t('err_no_metadata', 'No EXIF or other metadata was found in this image.'));
      } else if (/invalid image format/i.test(message)) {
        showError(t('err_not_image', 'This file does not look like an image. Please choose a JPEG, PNG, WebP, HEIC, TIFF or GIF file.'));
      } else {
        showError(t('err_parse', 'Could not read the metadata of this image: {message}').replace('{message}', message));
      }
      hideAll();
    }

    function handleTags(tags) {
      if (disposed) return;
      currentTags = tags;
      setStatus('', false);
      renderSummary(tags);
      renderGps(tags);
      renderTags(tags);
    }

    function parseBuffer(buffer, file) {
      if (disposed) return;
      var bytes = new Uint8Array(buffer);
      var kind = detectImageType(bytes);
      if (!kind && !/^image\//i.test(String(file.type || ''))) {
        showError(t('err_not_image', 'This file does not look like an image. Please choose a JPEG, PNG, WebP, HEIC, TIFF or GIF file.'));
        hideAll();
        return;
      }
      if (kind) renderFile(file, kind);

      var lib = window.ExifReader;
      if (!lib || typeof lib.load !== 'function') {
        showError(t('err_lib', 'The EXIF parsing library did not load. Please refresh the page and try again.'));
        hideAll();
        return;
      }

      var result;
      try {
        result = lib.load(buffer, { expanded: true });
      } catch (err) {
        handleParseError(err);
        return;
      }
      // 传 ArrayBuffer 时各版本多半是同步返回的，但也可能给 Promise —— 两种都接住
      if (result && typeof result.then === 'function') {
        result.then(handleTags, handleParseError);
      } else {
        handleTags(result);
      }
    }

    function handleFile(file) {
      if (!file || disposed) return;
      currentTags = null;
      hideAll();
      setStatus(t('parsing', 'Reading the file...'), false);

      var reader = new FileReader();
      reader.onload = function () {
        if (disposed) return;
        parseBuffer(reader.result, file);
      };
      reader.onerror = function () {
        if (disposed) return;
        showError(t('err_read', 'Failed to read the file.'));
        hideAll();
      };
      reader.readAsArrayBuffer(file);
    }

    /* ---------- 事件 ---------- */

    fileInput.addEventListener('change', function () {
      var files = fileInput.files;
      handleFile(files && files[0]);
    });

    function onDragOver(e) {
      e.preventDefault();
      dropZone.classList.add('is-active');
    }

    function onDragLeave(e) {
      e.preventDefault();
      dropZone.classList.remove('is-active');
    }

    function onDrop(e) {
      e.preventDefault();
      dropZone.classList.remove('is-active');
      var files = e.dataTransfer && e.dataTransfer.files;
      handleFile(files && files[0]);
    }

    dropZone.addEventListener('dragover', onDragOver);
    dropZone.addEventListener('dragleave', onDragLeave);
    dropZone.addEventListener('drop', onDrop);

    return {
      destroy: function () {
        disposed = true;
        currentTags = null;
        dropZone.removeEventListener('dragover', onDragOver);
        dropZone.removeEventListener('dragleave', onDragLeave);
        dropZone.removeEventListener('drop', onDrop);
        if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['exif-reader'] = {
    detectImageType: detectImageType,
    formatBytes: formatBytes,
    tagLabel: tagLabel,
    tagValue: tagValue,
    rationalToNumber: rationalToNumber,
    dmsParts: dmsParts,
    dmsToDecimal: dmsToDecimal,
    formatDms: formatDms,
    openStreetMapUrl: openStreetMapUrl,
    hemisphereLetter: hemisphereLetter,
    gpsInfo: gpsInfo,
    pickSummary: pickSummary,
    groupSections: groupSections,
    serializableTags: serializableTags,
    hasExifSection: hasExifSection,
    __cases: function (assert) {
      /* ---- 文件头识别 ---- */
      assert.eq(detectImageType(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])), { kind: 'jpeg', mime: 'image/jpeg' }, 'JPEG 文件头');
      assert.eq(detectImageType(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), { kind: 'png', mime: 'image/png' }, 'PNG 文件头');
      assert.eq(detectImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), { kind: 'gif', mime: 'image/gif' }, 'GIF 文件头');
      assert.eq(detectImageType(new Uint8Array([0x42, 0x4D, 0x00, 0x00])), { kind: 'bmp', mime: 'image/bmp' }, 'BMP 文件头');
      assert.eq(detectImageType(new Uint8Array([0x49, 0x49, 0x2A, 0x00])), { kind: 'tiff', mime: 'image/tiff' }, 'TIFF 文件头');
      assert.eq(detectImageType(new Uint8Array([0x66, 0x74, 0x79, 0x70])), { kind: 'heif', mime: 'image/heif' }, 'HEIF 文件头');
      assert.eq(detectImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])),
        { kind: 'webp', mime: 'image/webp' }, 'RIFF + WEBP 才是 webp');
      assert.eq(detectImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45])), null, 'RIFF 里的 WAV 不是图片');
      assert.eq(detectImageType(new Uint8Array([0x68, 0x65, 0x6C, 0x6C, 0x6F])), null, '文本文件不是图片');
      assert.eq(detectImageType(new Uint8Array([0xFF])), null, '太短了认不出');
      assert.eq(detectImageType(null), null, '没有字节也认不出');

      /* ---- 大小 ---- */
      assert.eq(formatBytes(0), '0 B', '0 字节');
      assert.eq(formatBytes(512), '512 B', '不足 1 KB');
      assert.eq(formatBytes(1024), '1.00 KB', '1 KB');
      assert.eq(formatBytes(1024 * 1024 * 3), '3.00 MB', '3 MB');
      assert.eq(formatBytes(-1), '', '负数没有意义');

      /* ---- 标签名与标签值 ---- */
      assert.eq(tagLabel('ISOSpeedRatings'), 'ISO Speed Ratings', '大写字母前补空格');
      assert.eq(tagLabel('GPSLatitude'), 'GPS Latitude', 'GPS 标签');
      assert.eq(tagLabel('Exif IFD Pointer'), 'Exif IFD Pointer', '本来就带空格的原样保留');
      assert.eq(tagValue({ description: 'Canon EOS 5D', value: ['Canon EOS 5D'] }), 'Canon EOS 5D', '优先用 description');
      assert.eq(tagValue({ description: 50.06786666666667, value: [[50, 1], [4, 1], [432, 100]] }), '50.06786666666667', 'description 是数字也要用');
      assert.eq(tagValue({ value: 400 }), '400', '没有 description 就用原始值');
      assert.eq(tagValue({ value: ['a', 'b'] }), 'a, b', '字符串数组用逗号连起来');
      assert.eq(tagValue({ value: [[50, 1], [4, 1]] }), '<binary>', '有数列给占位');
      assert.eq(tagValue({}), '', '空的标签没有值');
      assert.eq(tagValue(null), '', 'null 也没有值');

      /* ---- 度分秒 ---- */
      assert.eq(rationalToNumber([1, 200]), 0.005, '有理数 1/200');
      assert.eq(rationalToNumber([50, 1]), 50, '整数有理数');
      assert.eq(rationalToNumber(7), 7, '不是数组就当普通数字');
      assert.eq(rationalToNumber([1, 0]), 0, '分母为 0 不炸');
      assert.eq(dmsParts([[50, 1], [4, 1], [432, 100]]), [50, 4, 4.32], '度分秒三元组');
      assert.eq(dmsParts([1, 2]), null, '不够三项就不是度分秒');
      assert.eq(dmsToDecimal(50, 4, 4.32, 'N'), 50.06786666666667, '北纬换十进制度');
      assert.eq(dmsToDecimal(50, 4, 4.32, 'S'), -50.06786666666667, '南纬取负');
      assert.eq(dmsToDecimal(14, 25, 12.6, 'E'), 14.420166666666667, '东经换十进制度');
      assert.eq(dmsToDecimal(14, 25, 12.6, 'W'), -14.420166666666667, '西经取负');
      assert.eq(dmsToDecimal(NaN, 0, 0, 'N'), null, '不是数字就返回 null');
      assert.eq(formatDms(50.06786666666667, 'N'), '50° 4′ 4.3″ N', '纬度转度分秒');
      assert.eq(formatDms(-14.420166666666667, 'W'), '14° 25′ 12.6″ W', '负数只取绝对值，方向交给 ref');
      assert.eq(formatDms(-14.420166666666667), '14° 25′ 12.6″ S', '没给 ref 就按符号猜');
      assert.eq(formatDms(NaN, 'N'), '', '不是数字没有度分秒');

      /* ---- 地图链接 ---- */
      assert.eq(openStreetMapUrl(50.06786666666667, 14.420166666666667),
        'https://www.openstreetmap.org/?mlat=50.067867&mlon=14.420167#map=18/50.067867/14.420167',
        'OpenStreetMap 链接');
      assert.eq(openStreetMapUrl(NaN, 1), '', '不是数字就不给链接');
      assert.eq(openStreetMapUrl('50', 1), '', '字符串不是数字');

      /* ---- 半球 ---- */
      assert.eq(hemisphereLetter({ value: ['N'] }, 'N', 'S'), 'N', '北纬');
      assert.eq(hemisphereLetter({ value: ['W'] }, 'E', 'W'), 'W', '西经');
      assert.eq(hemisphereLetter(undefined, 'E', 'W'), '', '没有 ref 就是空');

      /* ---- GPS 汇总 ---- */
      var gpsTags = {
        exif: {
          GPSLatitudeRef: { value: ['N'] },
          GPSLongitudeRef: { value: ['E'] }
        },
        gps: { Latitude: 50.06786666666667, Longitude: 14.420166666666667, Altitude: 235 }
      };
      var info = gpsInfo(gpsTags);
      assert.eq(info.latitude, 50.06786666666667, '纬度');
      assert.eq(info.longitude, 14.420166666666667, '经度');
      assert.eq(info.altitude, 235, '海拔');
      assert.eq(info.latDms, '50° 4′ 4.3″ N', '纬度度分秒');
      assert.eq(info.lonDms, '14° 25′ 12.6″ E', '经度度分秒');
      assert(info.mapUrl.indexOf('mlat=50.067867') > -1, '地图链接里有纬度');
      assert.eq(gpsInfo({ gps: { Latitude: 1 } }), null, '只有纬度不算完整 GPS');
      assert.eq(gpsInfo({}), null, '没有 gps 段就是没有 GPS');

      /* ---- 摘要与分组 ---- */
      var tags = {
        exif: {
          Make: { value: ['Canon'], description: 'Canon' },
          Model: { value: ['Canon EOS 5D Mark IV'], description: 'Canon EOS 5D Mark IV' },
          DateTimeOriginal: { value: ['2024:01:09 12:34:56'], description: '2024:01:09 12:34:56' },
          ExposureTime: { value: [1, 200], description: '1/200' },
          FNumber: { value: [28, 10], description: 'f/2.8' },
          ISOSpeedRatings: { value: 400, description: 400 }
        },
        file: { FileType: { value: 'jpeg', description: 'JPEG' } }
      };
      var summary = pickSummary(tags);
      assert.eq(summary.length, 6, '摘要区挑出 6 个常用字段');
      assert.eq(summary[0].value, 'Canon', '摘要第一行是厂商');
      assert.eq(summary[1].value, 'Canon EOS 5D Mark IV', '摘要第二行是型号');
      assert.eq(summary[2].value, '2024:01:09 12:34:56', '摘要第三行是拍摄时间');
      assert.eq(summary[3].value, '1/200', '摘要第四行是快门');
      assert.eq(summary[4].value, 'f/2.8', '摘要第五行是光圈');
      assert.eq(summary[5].value, '400', '摘要第六行是 ISO');
      assert.eq(pickSummary({}).length, 0, '没有 exif 段时摘要为空');
      assert.eq(hasExifSection(tags), true, '有 exif 段');
      assert.eq(hasExifSection({ file: {} }), false, '只有结构信息不算 EXIF');

      var sections = groupSections(tags);
      assert.eq(sections.length, 2, '分成 EXIF 与 File 两组');
      assert.eq(sections[0].name, 'file', 'File 组排在前面');
      assert.eq(sections[0].entries[0].label, 'File Type', 'File 组的标签名');
      assert.eq(sections[0].entries[0].value, 'JPEG', 'File 组的标签值');
      assert.eq(sections[1].name, 'exif', 'EXIF 组');
      assert.eq(sections[1].entries.length, 6, 'EXIF 组有 6 个字段');
      assert.eq(groupSections({}).length, 0, '什么都没有就没有分组');

      /* ---- 复制用的干净副本 ---- */
      var plain = serializableTags({ exif: { Make: { value: ['Canon'] } }, Thumbnail: { base64: 'abcdef' } });
      assert.eq(plain.exif.Make.value[0], 'Canon', '普通字段照抄');
      assert.eq(plain.Thumbnail.base64, '<thumbnail: 6 base64 chars>', '缩略图换成一句说明');
      assert.eq(Object.keys(serializableTags(null)).length, 0, '空输入给空对象');

      /* ---- 库在的时候顺手真跑一遍解析 ----
         这条只在 exifreader 被加载进来时才有意义（页面与 node 测试都会加载它），
         没加载时跳过 —— 不然这个用例会因为「测试环境没灌库」而假红。 */
      if (window.ExifReader && typeof window.ExifReader.load === 'function') {
        // 一张 454 字节的最小 JPEG：IFD0 + Exif IFD + GPS IFD，
        // 里面写着 Canon EOS 5D Mark IV / 2024:01:09 12:34:56 / f/2.8 / 1/200 / ISO 400
        // 与东经 14°25'12.6"、北纬 50°4'4.3"、海拔 235 m。
        var base64 = '/9j/4cABRXhpZgAASUkqAAgAAAAHAA8BAgAGAAAA/gAAABABAgAXAAAABAEAABIBAwAB'
          + 'AAAAAQAAABoBBQABAAAAHAEAADIBAgAUAAAAJAEAAGmHBAABAAAAYgAAACWIBAABAAAAsAAAAAAAAAAGAJqCBQABAAAAOAEAAJ2CBQABAAAAQAEAACeI'
          + 'AwABAAAAkAEAAAOQAgAUAAAASAEAAAqSBQABAAAAXAEAADSkAgAbAAAAZAEAAAAAAAAGAAEAAgACAAAATgAAAAIABQADAAAAgAEAAAMAAgACAAAARQAAAAQABQ'
          + 'ADAAAAmAEAAAUAAQABAAAAAAAAAAYABQABAAAAsAEAAAAAAABDYW5vbgBDYW5vbiBFT1MgNUQgTWFyayBJVgAAAABIAAAAAQAAADIwMjQ6MDE6MDkgMTI6'
          + 'MzQ6NTYAAQAAAMgAAAAcAAAACgAAADIwMjQ6MDE6MDkgMTI6MzQ6NTYAMgAAAAEAAABFRjI0LTcwbW0gZi8yLjhMIElJIFVTTQAAAAAAMgAAAAEAAAAEAAAAAQAA'
          + 'ALABAABkAAAADgAAAAEAAAAZAAAAAQAAAOwEAABkAAAA6wAAAAEAAAD/2Q==';
        var raw = window.atob(base64);
        var bytes = new Uint8Array(raw.length);
        for (var bi = 0; bi < raw.length; bi++) bytes[bi] = raw.charCodeAt(bi);
        var buffer = new Uint8Array(bytes).buffer;
        var parsed = window.ExifReader.load(buffer, { expanded: true });
        assert.eq(parsed.exif.Model.description, 'Canon EOS 5D Mark IV', '真跑一遍：读出相机型号');
        assert.eq(parsed.exif.DateTimeOriginal.description, '2024:01:09 12:34:56', '真跑一遍：读出拍摄时间');
        assert.eq(parsed.exif.ExposureTime.description, '1/200', '真跑一遍：读出快门');
        assert.eq(parsed.exif.FNumber.description, 'f/2.8', '真跑一遍：读出光圈');
        assert.eq(parsed.exif.ISOSpeedRatings.description, 400, '真跑一遍：读出 ISO');
        assert.eq(parsed.gps.Latitude, 50.06786666666667, '真跑一遍：读出纬度');
        assert.eq(parsed.gps.Longitude, 14.420166666666667, '真跑一遍：读出经度');
        assert.eq(parsed.gps.Altitude, 235, '真跑一遍：读出海拔');
        var parsedSummary = pickSummary(parsed);
        var parsedValues = parsedSummary.map(function (row) { return row.value; });
        assert(parsedSummary.length >= 6, '真跑一遍：摘要挑出 6 行以上');
        assert(parsedValues.indexOf('Canon') > -1, '真跑一遍：摘要里有厂商');
        assert(parsedValues.indexOf('Canon EOS 5D Mark IV') > -1, '真跑一遍：摘要里有型号');
        assert(parsedValues.indexOf('2024:01:09 12:34:56') > -1, '真跑一遍：摘要里有拍摄时间');
        assert(parsedValues.indexOf('1/200') > -1, '真跑一遍：摘要里有快门');
        assert(parsedValues.indexOf('f/2.8') > -1, '真跑一遍：摘要里有光圈');
        assert(parsedValues.indexOf('400') > -1, '真跑一遍：摘要里有 ISO');
        assert(parsedValues.indexOf('50 mm') > -1, '真跑一遍：摘要里有焦距');
        var parsedSections = groupSections(parsed);
        assert(parsedSections.length >= 2, '真跑一遍：至少分出两组');
        assert.eq(parsedSections[0].name, 'file', '真跑一遍：第一组是 File');
      }
    }
  };
})();
