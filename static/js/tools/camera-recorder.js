/* ==========================================================================
   摄像头录制（camera-recorder）

   getUserMedia 取流 + MediaRecorder 录制，顺带可以截屏；录完的媒体以画廊形式
   列出，可下载或删除。

   参考实现：src/tools/camera-recorder/（it-tools, GPLv3）
   与原版的差别：
   1. 原版写死 mimeType 为 'video/webm'，在 Safari / iOS 上 isTypeSupported 为
      false，整个录制功能直接不可用。这里按候选列表探测，返回第一个受支持的
      类型，文件后缀也跟着实际 mimeType 走。
   2. 原版每次录完都 createObjectURL 却从不 revoke，录一次泄一个 blob；这里
      所有 URL 登记在册，删除条目和组件卸载时都释放掉。
   3. 原版的 useDevicesList 在标签页被拒绝权限后会一直停在「需要授权」页，
      这里区分了「不支持」「被拒绝」和「可重试」，并给出手动重试入口。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('camera-recorder');

  /* 按偏好排序的录制容器类型：webm 体积小，mp4 兼容 Safari/iOS。 */
  var MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4', 'video/ogg'];

  /**
   * 挑一个当前浏览器支持的录制容器。
   * @param {(mime:string)=>boolean} isTypeSupported 通常是 MediaRecorder.isTypeSupported
   * @returns {string} 受支持的 mime；一个都不支持时返回空串
   */
  function pickMimeType(isTypeSupported) {
    if (typeof isTypeSupported !== 'function') return '';
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      try {
        if (isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
      } catch (e) { /* 某些实现对非法参数会抛，继续试下一个 */ }
    }
    return '';
  }

  /** mime → 文件后缀。认不出的一律按 webm 处理（与参考实现的默认一致）。 */
  function extensionFor(mime) {
    var m = String(mime || '').toLowerCase();
    if (m.indexOf('mp4') >= 0) return 'mp4';
    if (m.indexOf('ogg') >= 0) return 'ogv';
    if (m.indexOf('webm') >= 0) return 'webm';
    return 'webm';
  }

  /** 画廊条目的文件名，纯函数便于单测。 */
  function mediaFilename(type, createdAt, mime) {
    var ts = createdAt instanceof Date ? createdAt.getTime() : Number(createdAt);
    if (!isFinite(ts)) ts = 0;
    return type + '-' + ts + (type === 'image' ? '.png' : '.' + extensionFor(mime));
  }

  /** 录制时长 mm:ss（超过一小时补 hh）。 */
  function timecode(ms) {
    var elapsed = Math.max(0, Math.floor(ms) || 0);
    var total = Math.floor(elapsed / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h ? pad(h) + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  window.ItTools.register('camera-recorder', function (root) {
    // host 是「设备 + 预览」这一整块，自身就是一张卡片；
    // 若它是普通 div，.tool-content 的 flex 会把它当成一块独立面板。
    var host = D.h('div.card');
    var stream = null;            // 当前 MediaStream
    var recorder = null;          // 当前 MediaRecorder
    var chunks = [];              // 正在录制时收集的分片
    var medias = [];              // 画廊条目，最新的在最上面
    var objectUrls = [];          // 需要 revoke 的 blob URL
    var ticker = null;            // 录制计时器
    var startedAt = 0;
    var disposed = false;

    var md = window.navigator && window.navigator.mediaDevices;
    var canCapture = !!(md && typeof md.getUserMedia === 'function' && window.MediaStream);
    var canRecord = !!(canCapture && typeof window.MediaRecorder === 'function');
    var mime = canRecord ? pickMimeType(window.MediaRecorder.isTypeSupported.bind(window.MediaRecorder)) : '';

    /* ---------- 资源释放 ---------- */

    function stopStream() {
      if (!stream) return;
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }

    function revokeAll() {
      objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
      objectUrls = [];
    }

    function stopTicker() {
      if (ticker) { window.clearInterval(ticker); ticker = null; }
    }

    /* ---------- 取流 ---------- */

    function constraints() {
      var c = { video: true };
      var sel = document.getElementById('cr-camera');
      if (sel && sel.value) c.video = { deviceId: { exact: sel.value } };
      var mic = document.getElementById('cr-mic');
      if (mic && mic.value) c.audio = { deviceId: { exact: mic.value } };
      return c;
    }

    function refreshDevices() {
      if (!md || typeof md.enumerateDevices !== 'function') return Promise.resolve();
      return Promise.resolve(md.enumerateDevices()).then(function (list) {
        if (disposed) return;
        fillSelect('cr-camera', (list || []).filter(function (d) { return d.kind === 'videoinput'; }));
        fillSelect('cr-mic', (list || []).filter(function (d) { return d.kind === 'audioinput'; }));
      })['catch'](function () { /* 设备列表拿不到不影响取流 */ });
    }

    function fillSelect(id, devices) {
      var sel = document.getElementById(id);
      if (!sel) return;
      D.clear(sel);
      if (!devices.length) {
        sel.appendChild(D.h('option', { value: '', text: t('no_device', 'No device found') }));
        sel.disabled = true;
        return;
      }
      sel.disabled = false;
      devices.forEach(function (d, i) {
        sel.appendChild(D.h('option', { value: d.deviceId, text: d.label || (d.kind + ' ' + (i + 1)) }));
      });
    }

    /* ---------- 画廊 ---------- */

    function addMedia(media) {
      medias.unshift(media);
      renderGallery();
    }

    function removeMedia(index) {
      var m = medias[index];
      if (!m) return;
      if (m.objectUrl) {
        URL.revokeObjectURL(m.objectUrl);
        objectUrls = objectUrls.filter(function (u) { return u !== m.objectUrl; });
      }
      medias.splice(index, 1);
      renderGallery();
    }

    function downloadMedia(media) {
      var name = mediaFilename(media.type, media.createdAt, media.mime);
      if (media.type === 'video') {
        window.ItTools.download(name, media.blob, media.mime || 'video/webm');
        return;
      }
      // 截图是 data URL，走 <a download> 才能拿到图片本身而不是那段文本
      var a = D.h('a', { href: media.value, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function renderGallery() {
      var box = document.getElementById('cr-gallery');
      if (!box) return;
      D.clear(box);
      if (!medias.length) {
        box.appendChild(D.h('p.field-hint', { text: t('nothing_captured', 'Nothing captured yet.') }));
        return;
      }
      medias.forEach(function (m, i) {
        var media = m.type === 'image'
          ? D.h('img', { src: m.value, alt: t('alt_screenshot', 'screenshot'), style: { width: '100%', borderRadius: '4px' } })
          : D.h('video', { src: m.value, controls: true, playsinline: true, style: { width: '100%', borderRadius: '4px' } });
        box.appendChild(D.h('div.card', null,
          media,
          D.h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px' } },
            D.h('strong', { text: m.type === 'image' ? t('media_screenshot', 'Screenshot') : t('media_video', 'Video') }),
            D.h('div', { style: { display: 'flex', gap: '8px' } },
              D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
                type: 'button', text: t('download', 'Download'), onclick: function () { downloadMedia(m); }
              }),
              D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
                type: 'button', text: t('delete', 'Delete'), onclick: function () { removeMedia(i); }
              })
            )
          )
        ));
      });
    }

    /* ---------- 录制 ---------- */

    function shot() {
      var video = document.getElementById('cr-video');
      if (!video || !video.videoWidth) return;
      var canvas = D.h('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0);
      addMedia({ type: 'image', value: canvas.toDataURL('image/png'), createdAt: new Date() });
    }

    function startRecording() {
      if (!canRecord || !stream || recorder) return;
      var type = mime || pickMimeType(window.MediaRecorder.isTypeSupported.bind(window.MediaRecorder));
      chunks = [];
      try {
        recorder = type ? new window.MediaRecorder(stream, { mimeType: type }) : new window.MediaRecorder(stream);
      } catch (e) {
        recorder = null;
        setStatus(t('err_cannot_start', 'Cannot start recording: {msg}')
          .replace('{msg}', function () { return e.message; }), true);
        return;
      }
      recorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = function () {
        stopTicker();
        var type2 = (recorder && recorder.mimeType) || type || 'video/webm';
        var blob = new Blob(chunks, { type: type2 });
        chunks = [];
        recorder = null;
        if (blob.size) {
          var url = URL.createObjectURL(blob);
          objectUrls.push(url);
          addMedia({ type: 'video', value: url, objectUrl: url, blob: blob, mime: type2, createdAt: new Date() });
        }
        renderControls();
      };
      recorder.start();
      startedAt = Date.now();
      tick();
      ticker = window.setInterval(tick, 250);
      renderControls();
    }

    function tick() {
      var el = document.getElementById('cr-timer');
      if (el) el.textContent = timecode(Date.now() - startedAt);
    }

    function stopRecording() {
      if (!recorder || recorder.state === 'inactive') return;
      recorder.stop();
    }

    /* ---------- 界面 ---------- */

    var statusBox = D.h('div.badge-note', { text: t('status_off', 'Camera is off') });

    function setStatus(text, isError) {
      statusBox.textContent = text;
      statusBox.style.color = isError ? 'var(--danger, #d03050)' : '';
    }

    var video = D.h('video', {
      id: 'cr-video', autoplay: true, controls: true, playsinline: true,
      style: { width: '100%', borderRadius: '4px', background: '#000' }
    });
    var timer = D.h('span#cr-timer.badge-note', { text: '00:00' });

    var startCamBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('start_webcam', 'Start webcam') });
    var shotBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('take_screenshot', 'Take screenshot'), disabled: true });
    var recBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('start_recording', 'Start recording'), disabled: true });
    var pauseBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('pause', 'Pause'), disabled: true });
    var stopBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('stop', 'Stop'), disabled: true });

    function renderControls() {
      var live = !!stream;
      startCamBtn.textContent = live ? t('restart_webcam', 'Restart webcam') : t('start_webcam', 'Start webcam');
      shotBtn.disabled = !live;
      recBtn.disabled = !live || !canRecord;
      var recording = !!recorder && recorder.state === 'recording';
      var paused = !!recorder && recorder.state === 'paused';
      recBtn.textContent = paused ? t('resume', 'Resume') : t('start_recording', 'Start recording');
      recBtn.disabled = !live || !canRecord || recording;
      pauseBtn.disabled = !recording;
      stopBtn.disabled = !recorder;
      timer.style.display = recorder ? '' : 'none';
    }

    startCamBtn.addEventListener('click', function () {
      startCamBtn.disabled = true;
      setStatus(t('status_requesting', 'Requesting camera…'));
      var previous = stream;
      Promise.resolve().then(function () { return md.getUserMedia(constraints()); })
        .then(function (s) {
          stopStream();
          stream = s;
          if (disposed) { stopStream(); return; }
          video.srcObject = s;
          var p = video.play();
          if (p && typeof p['catch'] === 'function') p['catch'](function () { /* 自动播放被拦下无所谓，用户点一下即可 */ });
          setStatus(t('status_live', 'Camera is live'));
          renderControls();
          return refreshDevices();
        })
        ['catch'](function (err) {
          stopStream();
          video.srcObject = null;
          // 以前这里调的是 describeError(err) —— 那个函数在本文件里根本没定义，
          // 取流失败会抛 ReferenceError，用户只看到一个不动的界面。
          setStatus(t('err_camera', 'Camera error: {msg}')
            .replace('{msg}', function () { return (err && err.message) || String(err); }), true);
          renderControls();
        })
        ['finally'](function () {
          startCamBtn.disabled = false;
          if (previous && previous !== stream) previous.getTracks().forEach(function (t) { t.stop(); });
        });
    });

    shotBtn.addEventListener('click', shot);
    recBtn.addEventListener('click', function () {
      if (recorder && recorder.state === 'paused') recorder.resume();
      else startRecording();
      renderControls();
    });
    pauseBtn.addEventListener('click', function () {
      if (recorder && recorder.state === 'recording') recorder.pause();
      renderControls();
    });
    stopBtn.addEventListener('click', function () { stopRecording(); renderControls(); });

    if (canCapture) {
      ['cr-camera', 'cr-mic'].forEach(function (id) {
        var sel = D.h('select.layui-select', { id: id });
        sel.addEventListener('change', function () { if (stream) startCamBtn.click(); });
        var label = id === 'cr-camera' ? t('video_label', 'Video:') : t('audio_label', 'Audio:');
        host.appendChild(D.h('div.field-row', null, D.h('label.field-label', { text: label }), sel));
      });
    }

    root.appendChild(host);
    if (!canCapture) {
      host.appendChild(D.h('div', { text: t('err_not_supported', 'Your browser does not support recording video from camera.') }));
    } else {
      host.appendChild(D.h('div', null,
        startCamBtn,
        !canRecord ? D.h('p.field-hint', { text: t('err_recording_not_supported', 'Video recording is not supported in your browser.') }) : null,
        D.h('div', { style: { marginTop: '12px' } }, video),
        D.h('div.form-actions', { style: { marginTop: '12px' } },
          shotBtn, recBtn, pauseBtn, stopBtn, timer
        ),
        D.h('p.field-hint', {
          text: canRecord
            ? t('container', 'Recording container: {mime}').replace('{mime}', function () {
              return mime || t('container_default', 'browser default');
            })
            : t('container_unavailable', 'Recording container: unavailable')
        })
      ));
    }
    root.appendChild(D.h('div.card', null,
      D.h('h3', { text: t('captured_media', 'Captured media'), style: { margin: '0 0 10px', fontSize: '16px' } }),
      D.h('div#cr-gallery', null, D.h('p.field-hint', { text: t('nothing_captured', 'Nothing captured yet.') }))
    ));
    setStatus(canCapture ? t('status_off', 'Camera is off') : t('err_capture_not_supported', 'Media capture is not supported by this browser'));
    renderControls();
    renderGallery();

    return {
      destroy: function () {
        disposed = true;
        stopTicker();
        if (recorder) {
          // 停掉再摘 handler，避免 onstop 在组件已销毁时往 DOM 上写画廊
          recorder.onstop = null;
          recorder.ondataavailable = null;
          if (recorder.state !== 'inactive') recorder.stop();
          recorder = null;
        }
        chunks = [];
        stopStream();
        if (video) video.srcObject = null;
        revokeAll();
        medias = [];
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['camera-recorder'] = {
    pickMimeType: pickMimeType,
    extensionFor: extensionFor,
    mediaFilename: mediaFilename,
    timecode: timecode,
    __cases: function (assert) {
      // mime 探测：按候选顺序返回第一个被支持的
      assert.eq(pickMimeType(function () { return false; }), '', '全不支持时返回空串');
      assert.eq(pickMimeType(null), '', '探测函数缺失时返回空串');
      assert.eq(pickMimeType(function (m) { return m === 'video/webm'; }), 'video/webm', '命中 webm');
      assert.eq(pickMimeType(function (m) { return m === 'video/mp4'; }), 'video/mp4', 'webm 不支持时退到 mp4（Safari）');
      // isTypeSupported 对带 codecs 参数的实现可能抛，不能因此中断候选遍历
      assert.eq(pickMimeType(function (m) {
        if (m.indexOf('codecs=') >= 0) throw new Error('unsupported parameter');
        return m === 'video/webm';
      }), 'video/webm', '探测函数抛异常时继续试下一个');

      assert.eq(extensionFor('video/webm;codecs=vp9'), 'webm', 'webm 后缀');
      assert.eq(extensionFor('video/mp4'), 'mp4', 'mp4 后缀');
      assert.eq(extensionFor('video/ogg;codecs=theora'), 'ogv', 'ogg 后缀');
      assert.eq(extensionFor(''), 'webm', '空 mime 回落到 webm');

      assert.eq(mediaFilename('video', new Date(1700000000000), 'video/mp4'), 'video-1700000000000.mp4', '视频文件名跟实际容器');
      assert.eq(mediaFilename('image', new Date(1700000000000)), 'image-1700000000000.png', '截图文件名固定 png');
      assert.eq(mediaFilename('video', 'bad'), 'video-0.webm', '非法时间戳兜底为 0');

      assert.eq(timecode(0), '00:00', '零时长');
      assert.eq(timecode(59999), '00:59', '不足一分钟');
      assert.eq(timecode(60000), '01:00', '一分钟整');
      assert.eq(timecode(3600000), '01:00:00', '一小时补 hh');
      assert.eq(timecode(-1), '00:00', '负数兜底');
    }
  };
})();