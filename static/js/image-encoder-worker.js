/* ==========================================================================
   图片编码的 Web Worker —— HEIC / AVIF 的 wasm 编码器搬到这里跑。

   为什么要 worker：
   这两个编码器是**同步**的，调用一次就把所在线程占住。实测这台机器
   （AVIF，speed 6）：3 MP 要 4 秒、12 MP 要 15 秒、48 MP 要 62 秒。
   主线程被占住的时候页面不能滚、不能点、动画不动，用户只看到一句
   「正在编码中」，跟卡死了没区别。搬到 worker 里，页面全程可用。

   对外的协议（主线程 ↔ worker）：

     请求 { id, op, ... }
       op: 'encode'  format: 'avif' | 'heic'
            data:    RGBA 的 ArrayBuffer（宽 × 高 × 4 字节）
            width, height
            options: AVIF 的 embind 选项结构体（HEIC 不用）
            wantPreview: true —— 顺带把 HEIC 解回来做预览
       op: 'decode'  format: 'heic'
            blob:  文件本身（Blob 克隆是按引用的，不拷数据；worker 自己去读）
            data:  HEIC 的 ArrayBuffer（没有文件时才走这条）

     进度 { id, phase, loaded?, total? }
       phase: 'loading'（在拉编解码库）/ 'encoding' / 'decoding'
       loaded / total: 下载到哪儿了（字节）。total 是 0 表示不知道总量。

     回应 { id, ok: true, data, width, height, preview? }
          { id, ok: false, error: '...' }

   data 一律用 ArrayBuffer，来回都能**转移**（transfer）而不是拷贝 ——
   一张 48 MP 的 RGBA 有 192 MB，拷贝一次就要几百毫秒。
   ========================================================================== */
(function () {
  'use strict';

  var AVIF_GLUE = '/assets/lib/avif/codec/enc/avif_enc.js';
  var AVIF_WASM = '/assets/lib/avif/codec/enc/avif_enc.wasm';
  var ELHEIF_GLUE = '/assets/lib/elheif/pkg/elheif-wasm.js';

  /** 拉 wasm 的超时。拉不动就该报错，不能一直挂着。 */
  var FETCH_TIMEOUT = 120000;

  /** 各编码器的模块，初始化一次就好，之后一直用同一个。 */
  var avifModule = null;
  var avifLoading = null;
  var elheifModule = null;
  var elheifLoading = null;

  /**
   * 把 Uint8Array 变成一个「整个都是它」的 ArrayBuffer ——
   * 只有这样才能整体转移（transfer）给主线程。
   *
   * @param {Uint8Array} u8
   * @returns {ArrayBuffer}
   */
  function ownBuffer(u8) {
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
    return u8.slice().buffer;
  }

  /**
   * 从 elheif 解出来的帧里取出 RGBA8888 的像素。
   *
   * **elheif 给的 buffer 比图像本身长** —— 它自己的 core/src/impl.cpp 里
   * 解码完又把整个 libheif plane 原样追加了一遍（上游的 bug）。
   * 前面 width*height*4 字节才是图像本身，后面那些是重复的。
   *
   * @param {{width: number, height: number, data: *}} frame
   * @returns {{width: number, height: number, data: Uint8Array}}
   */
  function trimFrame(frame) {
    if (!frame) throw new Error('decode');
    var w = frame.width | 0;
    var h = frame.height | 0;
    if (!w || !h) throw new Error('decode');
    var need = w * h * 4;
    var src = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data || 0);
    if (src.length < need) throw new Error('decode');
    return { width: w, height: h, data: src.subarray(0, need) };
  }

  /**
   * 拉一个文件（带超时）。
   *
   * 没有超时的 fetch 会一直挂着 —— 主线程那边就停在「正在下载…」，
   * 用户既看不到发生了什么，也没法重试。
   *
   * @param {string} url
   * @returns {Promise<Response>}
   */
  function fetchWithTimeout(url) {
    var controller = null;
    if (typeof AbortController === 'function') {
      try { controller = new AbortController(); } catch (e) { controller = null; }
    }
    var p = fetch(url, controller ? { signal: controller.signal } : undefined);
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (controller) {
          try { controller.abort(); } catch (e) { /* 忽略 */ }
        }
        reject(new Error('timeout'));
      }, FETCH_TIMEOUT);
      p.then(function (res) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res);
      }, function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * 把响应体读出来，顺带报下载进度。
   *
   * 一次 fetch 拿到的是**整块**结果 —— 2.6 MB 的编码器下完了才知道下完，
   * 页面上只能写一句「正在下载…」。改成一块一块读，就能报出
   * 「已下 1.2 MB / 共 2.6 MB」，页面上画得出进度条。
   *
   * 没有流可读的老浏览器退回整块拿 —— 那时候进度是未知的，
   * 页面上画一个不确定的进度条（浏览器自己那个来回走的条）。
   *
   * @param {Response} res
   * @param {function} onProgress (loaded, total) —— total 是 0 表示不知道总量
   * @returns {Promise<ArrayBuffer>}
   */
  function readWithProgress(res, onProgress) {
    var body = res.body;
    if (!body || typeof body.getReader !== 'function' || typeof onProgress !== 'function') {
      return res.arrayBuffer();
    }
    var total = 0;
    try {
      var len = res.headers && res.headers.get ? res.headers.get('Content-Length') : null;
      total = len ? Number(len) : 0;
    } catch (e) { total = 0; }
    if (!(total > 0)) total = 0;

    var reader = body.getReader();
    var chunks = [];
    var loaded = 0;

    function step() {
      return reader.read().then(function (r) {
        if (r.done) {
          var out = new Uint8Array(loaded);
          var off = 0;
          for (var i = 0; i < chunks.length; i++) {
            out.set(chunks[i], off);
            off += chunks[i].length;
          }
          return out.buffer;
        }
        chunks.push(r.value);
        loaded += r.value.length;
        try { onProgress(loaded, total); } catch (e) { /* 报进度失败不该影响下载 */ }
        return step();
      });
    }

    return step();
  }

  /**
   * 拉起 AVIF 编码器。
   *
   * wasm 是**运行期**拉的（第一次转换才拉，2.6 MB）。
   *
   * 给了 locateFile 才能绕开胶水里那条
   * `new URL('avif_enc.wasm', globalThis.__esm2iifeScriptUrl)` ——
   * worker 里没有 document.currentScript，脚本地址是空的，那条路会抛
   * "Invalid base URL"。
   *
   * @param {function} [onProgress] (loaded, total) —— 下载进度
   * @returns {Promise<object>} 带 encode() 的模块
   */
  function loadAvif(onProgress) {
    if (avifModule) return Promise.resolve(avifModule);
    if (avifLoading) return avifLoading;

    var p = fetchWithTimeout(AVIF_WASM)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // 一块一块地读，页面上才画得出进度条。
        return readWithProgress(res, onProgress);
      })
      .then(function (buf) {
        return WebAssembly.compile(buf);
      })
      .then(function (wasm) {
        importScripts(AVIF_GLUE);
        var factory = self.__avifEncFactory;
        if (typeof factory !== 'function') throw new Error('avif encoder is not loaded');
        return factory({
          locateFile: function () { return AVIF_WASM; },
          instantiateWasm: function (imports, callback) {
            var instance = new WebAssembly.Instance(wasm, imports);
            callback(instance);
            return instance.exports;
          }
        });
      })
      .then(function (mod) {
        avifModule = mod;
        return mod;
      });

    // 失败了下次还能重试 —— 失败的原因多半是临时的（网络、CDN）。
    p.catch(function () { avifLoading = null; });
    avifLoading = p;
    return avifLoading;
  }

  /**
   * 拉起 elheif（HEIC 的编解码器）。
   *
   * elheif 挂出来的是**模块工厂** `__init__ELHEIF_MODULE(cfg)`，
   * 通过配置对象的 `onRuntimeInitialized` 回调报告「wasm 跑起来了」。
   * 回调必须**在调用工厂之前**挂上，晚了就再也等不到了。
   *
   * @returns {Promise<object>} 模块实例
   */
  function loadElheif() {
    if (elheifModule) return Promise.resolve(elheifModule);
    if (elheifLoading) return elheifLoading;

    var p = new Promise(function (resolve, reject) {
      importScripts(ELHEIF_GLUE);
      var factory = self.__init__ELHEIF_MODULE;
      if (typeof factory !== 'function') {
        reject(new Error('elheif unavailable'));
        return;
      }
      var mod = {};
      mod.onRuntimeInitialized = function () {
        elheifModule = mod;
        resolve(mod);
      };
      try {
        factory(mod);
      } catch (e) {
        reject(e);
      }
    });
    p.catch(function () { elheifLoading = null; });
    elheifLoading = p;
    return elheifLoading;
  }

  /**
   * 报一下进度 —— 主线程那边要把这句话显示出来。
   *
   * extra 里可以带上下载进度（loaded / total）。
   *
   * @param {number} id
   * @param {string} phase
   * @param {object} [extra]
   */
  function reportPhase(id, phase, extra) {
    var msg = { id: id, phase: phase };
    if (extra) {
      Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
    }
    self.postMessage(msg);
  }

  /**
   * 这个编解码器是不是已经就绪（不用再下载了）。
   *
   * @param {string} format 'avif' | 'heic'
   * @returns {boolean}
   */
  function codecReady(format) {
    if (format === 'avif') return !!(avifModule || avifLoading);
    if (format === 'heic') return !!(elheifModule || elheifLoading);
    return false;
  }

  /** 编码成 AVIF。 */
  function encodeAvif(msg) {
    return loadAvif(function (loaded, total) {
      reportPhase(msg.id, 'loading', { loaded: loaded, total: total });
    }).then(function (mod) {
      reportPhase(msg.id, 'encoding');
      var out = mod.encode(new Uint8Array(msg.data), msg.width, msg.height, msg.options);
      if (!out) throw new Error('encode');
      var bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
      return { data: ownBuffer(bytes), width: msg.width, height: msg.height };
    });
  }

  /** 编码成 HEIC。 */
  function encodeHeic(msg) {
    return loadElheif().then(function (mod) {
      reportPhase(msg.id, 'encoding');
      var rgba = new Uint8Array(msg.data);
      var out = mod.jsEncodeImage(rgba, msg.width, msg.height);
      if (!out || out.err || !out.data) {
        throw new Error(out && out.err ? String(out.err) : 'encode');
      }
      var bytes = out.data instanceof Uint8Array ? out.data : new Uint8Array(out.data);
      var result = { data: ownBuffer(bytes), width: msg.width, height: msg.height };

      // 浏览器解不了 HEIC（<img> 直接报错），但 elheif 能解 ——
      // 解回来做预览，顺便证明这份 HEIC 确实是好的。
      if (msg.wantPreview) {
        try {
          var back = mod.jsDecodeImage(bytes);
          if (back && back.data && back.data[0]) {
            var frame = trimFrame(back.data[0]);
            result.preview = {
              data: ownBuffer(frame.data),
              width: frame.width,
              height: frame.height
            };
          }
        } catch (e) {
          // 预览解不出来不算失败 —— 编码本身是好的，只是没有预览。
        }
      }
      return result;
    });
  }

  /**
   * 解码一张 HEIC。
   *
   * 字节有两种来法：
   *   · blob —— 给的是**文件本身**。Blob 克隆是按引用的（不拷数据），
   *     worker 自己去读。这样主线程那份字节原封不动地留着 ——
   *     万一 worker 这边不行（脚本没加载起来、跑到一半炸了），
   *     主线程还能拿它重解一遍。
   *   · data —— 直接给字节（转移过来的）。转移之后主线程那份就废了，
   *     退不回主线程，所以这条路只在拿不到文件时才用。
   *
   * @param {object} msg
   * @returns {Promise<object>}
   */
  function decodeHeic(msg) {
    return loadElheif().then(function (mod) {
      reportPhase(msg.id, 'decoding');
      var source = msg.blob
        ? msg.blob.arrayBuffer().then(function (buf) { return new Uint8Array(buf); })
        : Promise.resolve(new Uint8Array(msg.data));
      return source.then(function (bytes) {
        var out = mod.jsDecodeImage(bytes);
        if (!out || out.err || !out.data || !out.data.length) {
          throw new Error(out && out.err ? String(out.err) : 'decode');
        }
        var frame = trimFrame(out.data[0]);
        return { data: ownBuffer(frame.data), width: frame.width, height: frame.height };
      });
    });
  }

  self.onmessage = function (ev) {
    var msg = ev.data || {};
    var id = msg.id;

    // 编解码器还没就绪才报「在拉库」—— 那 2.6 MB 的 wasm 要下一会儿，
    // 主线程得有个说法，不能让人以为卡住了。
    // 已经就绪就别报了：第二次转换直接进编码，页面上闪一下
    // 「正在下载…」反而像出了故障。
    if (!codecReady(msg.format)) reportPhase(id, 'loading');

    Promise.resolve()
      .then(function () {
        if (msg.op === 'encode' && msg.format === 'avif') return encodeAvif(msg);
        if (msg.op === 'encode' && msg.format === 'heic') return encodeHeic(msg);
        if (msg.op === 'decode' && msg.format === 'heic') return decodeHeic(msg);
        throw new Error('unknown op');
      })
      .then(function (r) {
        var transfer = [r.data];
        if (r.preview) transfer.push(r.preview.data);
        self.postMessage({
          id: id,
          ok: true,
          data: r.data,
          width: r.width,
          height: r.height,
          preview: r.preview
        }, transfer);
      })
      .catch(function (e) {
        self.postMessage({ id: id, ok: false, error: String(e && e.message ? e.message : e) });
      });
  };
})();
