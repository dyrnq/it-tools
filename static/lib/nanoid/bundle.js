/* 由 scripts/vendor-js-libs.sh 自动生成，请勿手改。
 * 源包: package  入口: index.browser.cjs
 * 原文件逐个原样保留（只包了一层 module/exports/require），未做任何源码改写。 */
(function (root) {
  'use strict';
  var __modules = {};
  var __cache = {};

  /* 浏览器里没有 process，但有些包会直接摸它。yaml 的 composer 就是这么写的：
     if (process.env.LOG_STREAM) console.dir(token) —— 没加 typeof 保护，一 parse 就炸。
     它同时又用 typeof process !== 'undefined' 来判断是不是 Node，所以这个壳必须
     恰好只在「被直接访问」时兜得住。
     在闭包里定义（而不是挂到 root 上）正好满足：模块里的 process 一律指向这里，
     外面 window.process 仍然不存在。用到的能力也就 env / emitWarning 这两处，
     补一个空的 emitWarning 不存在即可 —— 与其在运行时炸，不如在这里如实反映浏览器。 */
  var process = root.process || { env: {}, versions: {}, nextTick: function (f) { setTimeout(f, 0); } };

  /* Node 的 global 同样没有别名，但浏览器里 globalThis 就是 window，直接指过去。
     @iarna/toml 到处在摸 global.Date / global.BigInt（它还留着 Node 时代的
     写法），少了这一行 parse 一个日期就炸。 */
  var global = root;

  function __norm(base, id) {
    /* 必须和生成阶段用的 path.posix.normalize 得出**同一个** id，否则注册的和查找的
       对不上。这里曾经把 out.length > 1 当成「不能弹到顶」，结果
       formatRelative/index.js 里的 require('../_lib/...') 被算成
       formatRelative/_lib/...，而生成阶段算的是 _lib/... —— 一个注册一个找不到。
       '.js' / '/index.js' 的补全规则也要和 resolveIn 一致。 */
    var parts = (base.slice(0, base.lastIndexOf('/') + 1) + id).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '' || p === '.') continue;
      if (p === '..') { if (out.length) out.pop(); continue; }
      out.push(p);
    }
    var joined = out.join('/');
    return __has(joined) ? joined : (__has(joined + '.js') ? joined + '.js' : joined + '/index.js');
  }
  function __has(id) { return Object.prototype.hasOwnProperty.call(__modules, id); }

  function __req(id) {
    if (__cache[id]) return __cache[id].exports;
    if (__alias[id]) return __req(__alias[id]);
    if (!__has(id)) throw new Error('模块未注册: ' + id);
    var m = __cache[id] = { exports: {} };
    /* 位置必须和 function (module, exports, require) 的形参一一对应：
         this         = module.exports（让包里写 this.foo = … 的代码落对地方）
         module       = 那个持有 exports 的壳 —— 必须和 exports **分开**。
                       共用同一个对象的话，包里一句 module.exports = Foo 会变成
                       往原对象上挂 .exports，最后返回的还是那个空壳
                       （randexp / date-fns / xml-formatter 全栽在这上面）。
         exports      = exports
         require      = 依赖查找
       require 里要按「先别名、再内置模块、最后才当相对路径解析」的顺序查 ——
       少一步都会把一个纯 npm 依赖错当成路径，比如 require('ret') 被当成 ./ret。 */
    __modules[id].call(m.exports, m, m.exports, function (r) {
      if (__alias[r]) return __req(__alias[r]);
      if (__builtin.indexOf(r) >= 0) return __cache[r].exports;
      return __req(__norm(id, r));
    });
    return m.exports;
  }

  /* --builtin 声明的 Node 内置模块：占位对象，但碰任何属性/构造都立刻报错。
     直接预填进 __cache，require 命中时不必真的注册模块。
     'then' 要特判成 undefined —— 有些库会无脑探测 then（Promise 同化），
     抛错会让它们误判。 */
  var __builtin = [];
  function __nodeStub(name) {
    var msg = '浏览器里没有 Node 内置模块 ' + name;
    return new Proxy(function () {}, {
      get: function (t, k) {
        if (k === 'then' || typeof k === 'symbol') return undefined;
        throw new Error(msg + '（访问 .' + String(k) + ' 时）');
      },
      construct: function () { throw new Error(msg + '（被 new 时）'); },
      apply: function () { throw new Error(msg + '（被调用时）'); }
    });
  }

  var __alias = {};
  __modules["index.browser.cjs"] = function (module, exports, require) {
let { urlAlphabet } = require('./url-alphabet/index.cjs')
let random = bytes => crypto.getRandomValues(new Uint8Array(bytes))
let customRandom = (alphabet, defaultSize, getRandom) => {
  let mask = (2 << (Math.log(alphabet.length - 1) / Math.LN2)) - 1
  let step = -~((1.6 * mask * defaultSize) / alphabet.length)
  return (size = defaultSize) => {
    let id = ''
    while (true) {
      let bytes = getRandom(step)
      let j = step
      while (j--) {
        id += alphabet[bytes[j] & mask] || ''
        if (id.length === size) return id
      }
    }
  }
}
let customAlphabet = (alphabet, size = 21) =>
  customRandom(alphabet, size, random)
let nanoid = (size = 21) =>
  crypto.getRandomValues(new Uint8Array(size)).reduce((id, byte) => {
    byte &= 63
    if (byte < 36) {
      id += byte.toString(36)
    } else if (byte < 62) {
      id += (byte - 26).toString(36).toUpperCase()
    } else if (byte > 62) {
      id += '-'
    } else {
      id += '_'
    }
    return id
  }, '')
module.exports = { nanoid, customAlphabet, customRandom, urlAlphabet, random }

  };
  __modules["url-alphabet/index.cjs"] = function (module, exports, require) {
let urlAlphabet =
  'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
module.exports = { urlAlphabet }

  };
  root["nanoid"] = __req("index.browser.cjs");
})(typeof globalThis !== 'undefined' ? globalThis : this);
