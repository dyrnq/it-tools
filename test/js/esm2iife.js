/*
 * scripts/esm2iife.js（ESM → 经典脚本改写器）的单测。
 *
 * 为什么这个改写器要单独有测试：它改的是**别人家的包**，而包的结构
 * 我们控制不了 —— 一旦它悄悄改坏（少改一句、多改一句），症状会出现在
 * 页面加载之后，而且是「wasm 编码器莫名其妙不工作」这种极难定位的样子。
 * 所以这里用几个小片段把每一条改写规则都钉住。
 *
 * 特别要守住的���条（都是实测踩出来的）：
 *   1. `import.meta.url` 在经典脚本里是语法错误 → 必须换掉；
 *   2. 有些包拿 `import.meta.url` 当**赋值目标**
 *      （`import.meta.url = 'https://localhost'`）→ 换成字符串字面量会产生
 *      `'' = '...'` 的 SyntaxError，整个文件根本不执行，症状是「全局没挂出来」；
 *   3. 不认识的 import 形态必须**当场报错退出**，不能改出个半残的脚本。
 *
 * 用法：node esm2iife.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'esm2iife.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'esm2iife-test-'));
let pass = 0;
const failures = [];

function ok(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    failures.push(`${name}\n      期望 ${e}，实际 ${a}`);
  }
}

/** 去掉注释 —— 产物开头有一段说明用的块注释，检查代码时要把它排除掉。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 跑一次改写器。
 * @param {string} source 入口文件的内容
 * @param {string[]} args 追加的命令行参数
 * @returns {{code: number, stdout: string, stderr: string, out: string}}
 */
function run(source, args = []) {
  const entry = path.join(TMP, 'entry.js');
  const out = path.join(TMP, 'out.js');
  fs.writeFileSync(entry, source);
  const r = spawnSync('node', [SCRIPT, entry, out, '__TEST_GLOBAL', ...args], { encoding: 'utf8' });
  return {
    code: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    out: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '',
  };
}

/** 在 jsdom 里跑改写后的脚本，返回 window 上的全局。 */
function evaluate(source) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
  dom.window.eval(source);
  return dom.window;
}

/* ---- 1. 具名导出 → 命名空间 ---- */
{
  const r = run(`
export function hello() { return 'hi'; }
export const answer = 42;
export async function later() { return 1; }
export class Thing {}
`);
  ok('具名导出：退出码 0', r.code, 0);
  const w = evaluate(r.out);
  ok('具名导出：全局是个命名空间', typeof w.__TEST_GLOBAL, 'object');
  ok('具名导出：函数在', typeof w.__TEST_GLOBAL.hello, 'function');
  ok('具名导出：函数能调', w.__TEST_GLOBAL.hello(), 'hi');
  ok('具名导出：常量在', w.__TEST_GLOBAL.answer, 42);
  ok('具名导出：异步函数在', typeof w.__TEST_GLOBAL.later, 'function');
  ok('具名导出：类在', typeof w.__TEST_GLOBAL.Thing, 'function');
  ok('具名导出：源码里不再有 export 关键字', /^[ \t]*export\b/m.test(r.out), false);
}

/* ---- 2. 默认导出 ---- */
{
  const r = run('const Module = { v: 7 };\nexport default Module;\n');
  ok('默认导出：退出码 0', r.code, 0);
  const w = evaluate(r.out);
  ok('默认导出：不带 --export 时全局是命名空间', typeof w.__TEST_GLOBAL, 'object');
  ok('默认导出：命名空间里有 default', w.__TEST_GLOBAL.default.v, 7);
}

/* ---- 3. --export default：全局就是默认值本身 ---- */
{
  const r = run('const Module = { v: 9 };\nexport default Module;\n', ['--export', 'default']);
  ok('--export default：退出码 0', r.code, 0);
  const w = evaluate(r.out);
  ok('--export default：全局就是默认值', w.__TEST_GLOBAL.v, 9);
}

/* ---- 4. --export <具名> ---- */
{
  const r = run('export function pick() { return 5; }\nexport function other() { return 6; }\n',
    ['--export', 'pick']);
  ok('--export 具名：退出码 0', r.code, 0);
  const w = evaluate(r.out);
  ok('--export 具名：全局是那一个导出', w.__TEST_GLOBAL(), 5);
}

/* ---- 5. export { a, b as c } ---- */
{
  const r = run('const a = 1; const b = 2;\nexport { a, b as c };\n');
  ok('重导出：退出码 0', r.code, 0);
  const w = evaluate(r.out);
  ok('重导出：本地名照原样', w.__TEST_GLOBAL.a, 1);
  ok('重导出：as 后面是导出名', w.__TEST_GLOBAL.c, 2);
  ok('重导出：本地名 b 不进命名空间', 'b' in w.__TEST_GLOBAL, false);
}

/* ---- 6. import.meta.url ---- */
{
  // 这一段照抄 @jsquash/avif 的真实写法：import.meta.url 既是**读取**，
  // 又是**赋值目标**。
  const r = run(`
var dir = import.meta.url;
if (import.meta.url === undefined) {
  import.meta.url = 'https://localhost';
}
export default { dir: dir };
`);
  ok('import.meta.url：退出码 0', r.code, 0);
  ok('import.meta.url：源码里不再出现', stripComments(r.out).includes('import.meta.url'), false);
  const w = evaluate(r.out);
  ok('import.meta.url：赋值目标没被改成字面量（否则是 SyntaxError）',
    w.__TEST_GLOBAL.default.dir, '');
}

/* ---- 7. 副作用导入被丢掉 ---- */
{
  const r = run("import './side.js';\nexport default 1;\n");
  ok('副作用导入：退出码 0', r.code, 0);
  ok('副作用导入：源码里没了', stripComments(r.out).includes("import './side.js'"), false);
  ok('副作用导入：stderr 里有交代', /丢弃了副作用导入/.test(r.stderr), true);
}

/* ---- 8. 不认识的 import 形态要报错退出 ---- */
{
  const r = run("import { thing } from './other.js';\nexport default 1;\n");
  ok('具名 import：退出码非 0', r.code !== 0, true);
  ok('具名 import：报的是「不支持」', /不支持这种 import/.test(r.stderr), true);
}
{
  const r = run("import def from './other.js';\nexport default 1;\n");
  ok('默认 import：退出码非 0', r.code !== 0, true);
}
{
  const r = run("import * as ns from './other.js';\nexport default 1;\n");
  ok('命名空间 import：退出码非 0', r.code !== 0, true);
}
{
  const r = run("export * from './other.js';\n");
  ok('export *：退出码非 0', r.code !== 0, true);
  ok('export *：报的是「不支持」', /不支持 export \*/.test(r.stderr), true);
}

/* ---- 9. --export 指了不存在的名字 ---- */
{
  const r = run('export function a() {}\n', ['--export', 'nope']);
  ok('--export 指向不存在的导出：退出码非 0', r.code !== 0, true);
  ok('--export 指向不存在的导出：报清楚了', /没有名为 nope 的导出/.test(r.stderr), true);
}

/* ---- 10. 改写后的产物是合法的经典脚本（没有 import/export 残留） ---- */
{
  const r = run(`
import './a.js';
export function f() { return 1; }
export default f;
`);
  ok('产物里没有 import 语句', /^[ \t]*import\b/m.test(stripComments(r.out)), false);
  ok('产物里没有 export 语句', /^[ \t]*export\b/m.test(stripComments(r.out)), false);
  ok('产物包在 IIFE 里', /^\(function \(\) \{/.test(stripComments(r.out).trim()), true);
}

fs.rmSync(TMP, { recursive: true, force: true });

if (failures.length) {
  console.log('\x1b[31m失败\x1b[0m');
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n${pass}/${pass + failures.length} 通过`);
  process.exit(1);
}
console.log(`\x1b[32m全部通过\x1b[0m ${pass} 项检查`);
