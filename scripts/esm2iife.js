#!/usr/bin/env node
/*
 * 把一个只发 ESM 的 npm 包改写成浏览器能直接 <script src> 加载的经典脚本。
 *
 * 为什么需要它：本站没有 Node 构建步骤，也没有打包器（见 scripts/cjs-bundle.js
 * 的头部说明）。页面里的 <script> 是**同步执行**的经典脚本，ESM 的
 * import/export 在里面根本不是合法语法 —— 于是只发 ESM 的包一律用不了。
 * cjs-bundle.js 解决的是「只发 CommonJS」的那一半，这一半解决「只发 ESM」。
 *
 * 眼下用它的是 @jsquash/avif 的 AVIF 编码器（codec/enc/avif_enc.js）：
 * 整个包只有 `export default Module` 一句导出，但要拿它当 AVIF 编码器用。
 *
 * ------------------------------------------------------------------------
 * 改写规则（只动导入/导出语句与 import.meta.url，包内源码一行不改，
 * 版权头照原样留着 —— 与 cjs-bundle.js 的做法一致）：
 *
 *   1. `import.meta.url` → `globalThis.__esm2iifeScriptUrl`。
 *      经典脚本里 `import.meta` 是**语法错误**，不改就整个文件跑不起来。
 *      而且不能换成字符串字面量：有些包（@jsquash/avif 就是）拿它当**赋值目标**
 *      —— `if (import.meta.url === undefined) { import.meta.url = 'https://localhost'; }`
 *      —— 换成 `''` 会得到 `'' = '...'` 的 SyntaxError。
 *      所以换成一个**可写的全局**，并在 IIFE 开头用 document.currentScript.src 填上
 *      （经典脚本里它只在同步执行期间有效，之后就是 null）。
 *
 *   2. `import './x.js'`（副作用导入）→ 删掉。
 *      被导入的那个文件得由别处保证已经加载（本项目里靠 manifest.tsv 的
 *      <script> 标签按顺序引入）。删的时候会在 stderr 上说一声。
 *
 *   3. `import x from '...'` / `import {a} from '...'` / `import * as ns from '...'`
 *      → **不支持，当场报错退出**。
 *      同理 `export * from '...'`。
 *      理由跟 cjs-bundle.js 一样：宁可 vendor 阶段就炸，也不要页面静默半残
 *      —— 一个少了一半依赖的脚本，症状会出现在几秒之后、且跟真正的病因不像。
 *
 *   4. `export default X` → `var __esm2iifeDefault = X`。
 *   5. `export function foo` / `export async function foo` / `export class Foo`
 *      / `export const foo` → 去掉 export 关键字，名字记进命名空间。
 *   6. `export { a, b as c }` → 记进命名空间（c 是导出名，a/b 是本地名）。
 *
 * 挂出去的全局是什么：
 *   · 不带 --export：命名空间对象，具名导出都在里面（default 也在）。
 *   · --export default：默认值本身。
 *   · --export <名字>：那个具名导出。
 *
 * 用法: node scripts/esm2iife.js <入口文件> <输出文件> <全局名> [--export <字段>]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let exportField = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--export') exportField = args[++i];
  else positional.push(args[i]);
}

const [entry, outFile, globalName] = positional;
if (!entry || !outFile || !globalName) {
  console.error('用法: esm2iife.js <入口文件> <输出文件> <全局名> [--export <字段>]');
  process.exit(2);
}

/** 碰到不支持的写法就当场退出 —— 报清楚是哪一行、是哪一种。 */
function bail(msg, line) {
  console.error(`esm2iife: ${msg}${line ? `（第 ${line} 行）` : ''}`);
  process.exit(1);
}

const src = fs.readFileSync(entry, 'utf8');
const notes = [];

/* ------------------------------------------------------------------
   1. import.meta.url —— 必须先换，不然下面所有正则都跑不到
   ------------------------------------------------------------------ */
const URL_GLOBAL = '__esm2iifeScriptUrl';
let body = src.split('import.meta.url').join('globalThis.' + URL_GLOBAL);

/* ------------------------------------------------------------------
   2 & 3. import 语句
   ------------------------------------------------------------------ */
const importRe = /^([ \t]*)import\b([^\n]*)$/gm;
let m;
while ((m = importRe.exec(body)) !== null) {
  const indent = m[1];
  const rest = m[2].trim();
  const line = body.slice(0, m.index).split('\n').length;

  // import 'x'  /  import 'x';   —— 副作用导入，删掉
  const sideEffect = /^(['"])([^'"]+)\1\s*;?$/.exec(rest);
  if (sideEffect) {
    notes.push(`丢弃了副作用导入 ${sideEffect[2]}（第 ${line} 行）`);
    body = body.slice(0, m.index) + indent + body.slice(m.index + m[0].length);
    importRe.lastIndex = m.index;
    continue;
  }
  bail(`不支持这种 import：${rest}`, line);
}

/* ------------------------------------------------------------------
   4~6. export 语句
   ------------------------------------------------------------------ */
const named = [];   // { local, exported }
let hasDefault = false;

/* export default <表达式> —— 只支持单行（多行的表达式少见，
   真遇到了再扩；宁可现在报错也不要改出一段坏代码）。 */
const defaultRe = /^([ \t]*)export\s+default\s+(.+)$/gm;
while ((m = defaultRe.exec(body)) !== null) {
  const indent = m[1];
  let expr = m[2].trim();
  if (expr.endsWith(';')) expr = expr.slice(0, -1).trim();
  if (!expr) bail('export default 后面没有表达式');
  hasDefault = true;
  body = body.slice(0, m.index) + `${indent}var __esm2iifeDefault = ${expr};`
    + body.slice(m.index + m[0].length);
  defaultRe.lastIndex = m.index;
}

/* export { a, b as c }; */
const listRe = /^([ \t]*)export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;
while ((m = listRe.exec(body)) !== null) {
  const line = body.slice(0, m.index).split('\n').length;
  for (const item of m[2].split(',')) {
    const t = item.trim();
    if (!t) continue;
    const parts = t.split(/\s+as\s+/);
    const local = parts[0].trim();
    const exported = (parts[1] || parts[0]).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(local) || !/^[A-Za-z_$][\w$]*$/.test(exported)) {
      bail(`export {…} 里看不懂的写法：${t}`, line);
    }
    named.push({ local, exported });
  }
  body = body.slice(0, m.index) + m[1] + body.slice(m.index + m[0].length);
  listRe.lastIndex = m.index;
}

/* export function foo / export async function foo / export class Foo
   / export const foo / export let foo / export var foo */
const declRe = /^([ \t]*)export\s+(async\s+)?(function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)([\s\S]*)$/gm;
while ((m = declRe.exec(body)) !== null) {
  const indent = m[1];
  const asyncKw = m[2] || '';
  const kind = m[3];
  const name = m[4];
  const tail = m[5];
  const line = body.slice(0, m.index).split('\n').length;

  // export const a = 1, b = 2; —— 一次声明多个变量，本脚本处理不了
  if ((kind === 'const' || kind === 'let' || kind === 'var') && /,/.test(tail.split(';')[0])) {
    bail(`export ${kind} 一次声明多个变量，本脚本处理不了：${name}${tail.split(';')[0]}`, line);
  }
  named.push({ local: name, exported: name });
  body = body.slice(0, m.index) + `${indent}${asyncKw}${kind} ${name}${tail}`
    + body.slice(m.index + m[0].length);
  declRe.lastIndex = m.index;
}

/* export * from '...' —— 不支持 */
const starRe = /^[ \t]*export\s*\*/m;
if (starRe.test(body)) bail("不支持 export * from '…'");

/* 剩下的 export 开头 —— 一律不认识就报错 */
const leftoverRe = /^[ \t]*export\b[^\n]*$/gm;
while ((m = leftoverRe.exec(body)) !== null) {
  bail(`不支持这种 export：${m[0].trim()}`);
}

/* ------------------------------------------------------------------
   拼装输出
   ------------------------------------------------------------------ */
const nsParts = named.map((n) => `${n.exported}: ${n.local}`);
if (hasDefault) nsParts.push('default: __esm2iifeDefault');
const ns = `{ ${nsParts.join(', ')} }`;

let value;
if (exportField === null) {
  value = '__esm2iifeNs';
} else if (exportField === 'default') {
  if (!hasDefault) bail('这个模块没有 default 导出');
  value = '__esm2iifeDefault';
} else {
  if (!named.some((n) => n.exported === exportField)) {
    bail(`这个模块没有名为 ${exportField} 的导出（现有：${named.map((n) => n.exported).join(', ') || '无'}）`);
  }
  value = `__esm2iifeNs.${exportField}`;
}

const out = `/* 由 scripts/esm2iife.js 从 ${path.basename(entry)} 改写而成 —— 勿手改。
   原始包：${path.basename(entry)}（见 scripts/vendor-js-libs.sh 的清单） */
(function () {
  // 经典脚本里没有 import.meta.url，用当前脚本自己的地址顶上 ——
  // 改写时 import.meta.url 已经被换成了这个全局。
  globalThis.${URL_GLOBAL} = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';

${body}

  var __esm2iifeNs = ${ns};
  globalThis[${JSON.stringify(globalName)}] = ${value};
})();
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out);

for (const n of notes) console.error(`  · ${n}`);
console.error(`    ${path.basename(entry)} -> ${outFile}（全局 ${globalName}，${named.length + (hasDefault ? 1 : 0)} 个导出，${(Buffer.byteLength(out) / 1024).toFixed(0)}KB）`);
