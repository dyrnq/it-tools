#!/usr/bin/env node
/*
 * 把只发 CommonJS 的 npm 包打成浏览器能直接 <script src> 加载的单文件。
 *
 * 为什么需要它：本站没有 Node 构建步骤，ESM（import/export）在页面里根本跑不起来；
 * 而 uuid、yaml、colord、ibantools、cron-validator、randexp、composerize、
 * email-normalizer、date-fns 这些包都只发 CJS。浏览器也没有 require，
 * 浏览器自带的 require 是 ES 模块的，而且异步 —— CJS 的 require 是同步的，
 * 套一层 fetch 再求值行不通（同步代码等不到异步 IO）。
 *
 * 所以在 vendor 阶段就把 require 图走一遍、按依赖序拼成一个自洽的 IIFE：
 *   · 每个原文件原样保留，只裹一层 function(module, exports, require)
 *   · 不改写任何一行包内源码，版权头也照原样留着
 *   · 相对路径按 Node 的规则解析（含 .. 回退与补 .js）
 *
 * 用法: node scripts/cjs-bundle.js <包目录> <入口> <输出> <全局名> [--bare 名字=目录 ...]
 *                                          [--builtin node内置模块名 ...] [--export 字段名]
 *
 * --bare 用来支持「主包 require 了另一个 npm 包」的情况（randexp 就 require
 * 了 ret 和 drange）。那个包会被以自己的名字注册成模块，require('ret') 就能命中。
 *
 * --builtin 声明「这个 Node 内置模块在本包里只出现在浏览器永远走不到的分支上」。
 * @iarna/toml 就是典型：parse.js 无条件 require 了 parse-stream.js，而后者只在
 * parse.stream() 里 new stream.Transform —— 浏览器里那个 API 根本不存在。
 * 替代方案有两个，都不太好：一是塞个空对象 quietly 顶替，真跑到那行就报
 * 「x is not a constructor」这种看不懂的错；二是改包内源码（我们不改）。
 * 所以做成**碰一下就炸**的桩：require 得过，真用到时立刻说明是哪个内置模块。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

/* --bare / --builtin 都可以重复出现，统一收进各自的列表；
   其余按位置参数处理。 */
const barePairs = [];
const builtins = [];
const positional = [];
let exportPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bare') { barePairs.push(args[++i]); }
  else if (args[i] === '--builtin') { builtins.push(args[++i]); }
  else if (args[i] === '--export') { exportPath = args[++i]; }
  else positional.push(args[i]);
}

const [pkgDir, entry, outFile, globalName] = positional;
if (!pkgDir || !entry || !outFile || !globalName) {
  console.error('用法: cjs-bundle.js <package目录> <入口> <输出> <全局名> [--bare 名字=目录 ...]');
  process.exit(2);
}

/* 裸名包：名字 -> { 目录, 主入口 }。
   入口要按**浏览器**的条件选，不能只照 package.json 的 main：
   nanoid 的 main 指向 index.cjs（require('crypto')，Node 专用），
   它的 browser 字段才指向 index.browser.cjs。 */
function browserEntry(dir) {
  const pkg = require(path.join(dir, 'package.json'));
  const strip = p => p.replace(/^\.\//, '');
  let main = strip(pkg.main || 'index.js');
  const b = pkg.browser;
  if (typeof b === 'string') {
    main = strip(b);                       // "browser": "./browser.js" —— 整体替换
  }
  else if (b && typeof b === 'object') {
    // 也可能是映射表：{ "./index.cjs": "./index.browser.cjs", … }，键没有 ./ 前缀也认
    for (const k of Object.keys(b)) {
      const from = strip(k);
      if (typeof b[k] === 'string' && (from === '' || from === main)) { main = strip(b[k]); break; }
    }
  }
  return main;
}

const bare = {};
for (const spec of barePairs) {
  const i = spec.indexOf('=');
  if (i < 0) { console.error(`--bare 需要 名字=目录 形式，收到 ${spec}`); process.exit(2); }
  const name = spec.slice(0, i);
  const dir = spec.slice(i + 1);
  bare[name] = { dir, main: browserEntry(dir) };
}

const seen = new Set();      // 已收录的模块 id（形如 dist/index.js 或 ret/dist/index.js）
const sources = new Map();   // id -> 绝对路径
const alias = new Map();     // 裸名 -> 实际 id
const missing = new Map();   // 裸名 -> 第一个要它的模块 id

/** 在某个包里解析相对路径：处理 . 与 ..，必要时补 .js / index.js */
function resolveIn(dir, fromRel, id) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), id));
  for (const c of [joined, joined + '.js', joined + '/index.js']) {
    if (fs.existsSync(path.join(dir, c)) && fs.statSync(path.join(dir, c)).isFile()) return c;
  }
  return null;
}

function walk(dir, rel, prefix) {
  const id = prefix + path.posix.normalize(rel);
  if (seen.has(id)) return;
  const abs = path.join(dir, rel);
  if (!fs.existsSync(abs)) { console.error(`  ✗ 模块不存在: ${id}`); process.exit(1); }
  seen.add(id);
  sources.set(id, abs);
  const src = fs.readFileSync(abs, 'utf8');
  /* 先把 eval("…") 里的内容抹掉再扫依赖。js-sha256 就是靠这个**故意**把 Node-only
     的 require 藏起来的：
         var crypto = eval("require('crypto')");
         var Buffer = eval("require('buffer').Buffer");
     那两行只在真·Node 路径下才可能执行（它前面先判了 process.versions.node），
     浏览器里永远走不到。照扫不抹就会把 crypto / buffer 报成缺失依赖。 */
  const scannable = src.replace(/\beval\s*\(\s*(["'])[\s\S]*?\1\s*\)/g, '""');
  const re = /require\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(scannable))) {
    const rid = m[1];
    if (rid.startsWith('.')) {
      const target = resolveIn(dir, rel, rid);
      if (!target) { console.error(`  ✗ 解析不了 require("${rid}")（来自 ${id}）`); process.exit(1); }
      walk(dir, target, prefix);
    } else if (bare[rid]) {
      // 跳进那个包里，它的 id 一律带上自己的名字前缀
      walk(bare[rid].dir, bare[rid].main, rid + '/');
      const mainId = rid + '/' + path.posix.normalize(bare[rid].main);
      if (!alias.has(rid)) alias.set(rid, mainId);
    } else if (builtins.includes(rid)) {
      // 声明过了，生成时塞一个碰一下就炸的桩
    } else {
      // 记下来是谁要的 —— 只报缺哪几个包的话，被一条传递依赖绕晕时很难查
      if (!missing.has(rid)) missing.set(rid, id);
    }
  }
}

walk(pkgDir, entry, '');

if (missing.size) {
  // 剩下的多半是 Node 内置模块（crypto/fs/path…）或没提供的 npm 包。
  // 静默替换成空对象只会在运行时炸，不如生成前就报出来。
  for (const [rid, from] of missing) console.error(`  · require('${rid}') 来自 ${from}`);
  console.error(`  ✗ ${globalName} 依赖了未提供的裸名包: ${[...missing.keys()].join(', ')}`);
  process.exit(1);
}

/* ---- 生成 ---- */
const parts = [];
parts.push(`/* 由 scripts/vendor-js-libs.sh 自动生成，请勿手改。
 * 源包: ${path.basename(pkgDir)}  入口: ${entry}
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
  var __builtin = ${JSON.stringify(builtins)};
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
${builtins.map(b => `  __cache[${JSON.stringify(b)}] = { exports: __nodeStub(${JSON.stringify(b)}) };`).join('\n')}
`);


/* 裸名别名表 */
if (alias.size) {
  parts.push('  var __alias = {\n');
  for (const [name, id] of alias) parts.push(`    ${JSON.stringify(name)}: ${JSON.stringify(id)},\n`);
  parts.push('  };\n');
} else {
  parts.push('  var __alias = {};\n');
}

for (const [id, abs] of sources) {
  const src = fs.readFileSync(abs, 'utf8');
  parts.push(`  __modules[${JSON.stringify(id)}] = function (module, exports, require) {\n`);
  parts.push(src);
  parts.push('\n  };\n');
}

/* 有些包入口导出的不是本体而是命名空间（colord → {colord, Colord, extend…}、
   oggen → {generateMeta}），挂上去之后工具里就得写 Colord.colord(…) 这种绕口的
   代码。用 --export <字段名> 直接把那个字段挂成全局。 */
const pick = exportPath
  ? `(function () { var __v = __req(${JSON.stringify(entry)}); return __v == null ? __v : __v[${JSON.stringify(exportPath)}]; })()`
  : `__req(${JSON.stringify(entry)})`;
parts.push(`  root[${JSON.stringify(globalName)}] = ${pick};\n`);
parts.push(`})(typeof globalThis !== 'undefined' ? globalThis : this);\n`);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, parts.join(''));

const bytes = fs.statSync(outFile).size;
console.error(`    ${seen.size} 个模块 -> ${(bytes / 1024).toFixed(0)}KB`);