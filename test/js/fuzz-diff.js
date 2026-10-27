/*
 * text-diff 的 Hirschberg LCS 实现 —— 独立随机校验。
 *
 * 为什么要单独一个文件：harness.js 跑的是模块自带的 __cases，那些断言和被测
 * 实现是同一个人（同一个心智模型）写的，一起错的时候发现不了。这个文件另写
 * 一份朴素 O(N*M) DP 作为参照，对同一批随机样本同时校验两件事：
 *
 *   1. 合法性 —— ops 必须是单调对齐，应用到 a 上能逐行还原出 b；
 *   2. 最小性 —— same 的条数必须正好等于参照 DP 算出的 LCS 长度。
 *
 * 只测「不抛异常」或只测几个手写例子，都抓不住编辑脚本非最优这类问题；
 * 而非最优的 diff 在页面上表现为「明明只改了两行却显示改了几百行」。
 *
 * 用法：node fuzz-diff.js [样本数]     不带参数则跑默认值
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// 仓库根目录 = 本文件往上两级（test/js/ → 仓库根）。不写死绝对路径。
const ROOT = path.join(__dirname, '..', '..');
const N = Number(process.argv[2] || 500);

const dom = new JSDOM(
  '<!DOCTYPE html><body><div class="tool-content" id="tool-body"></div></body>',
  { runScripts: 'outside-only', url: 'http://localhost/' }
);
const w = dom.window;
w.fetch = () => new Promise(() => {});
w.TextEncoder = TextEncoder;
w.TextDecoder = TextDecoder;
w.eval(fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8'));
w.document.querySelector('.tool-content').dataset.slug = 'text-diff';
w.eval(fs.readFileSync(path.join(ROOT, 'static/js/tools/text-diff.js'), 'utf8'));
const L = w.ItTools.logic['text-diff'];

/* 参照实现：朴素 DP。故意写得慢且笨，和被测实现犯同样的错的概率低。 */
function dpLcs(a, b) {
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = a[i] === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/* 确定性 PRNG：失败能靠固定种子复现，不用祈祷随机数刚好撞上。 */
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

function gen(maxLen, alphabet) {
  const a = [], b = [];
  for (let i = 0, n = Math.floor(rnd() * maxLen); i < n; i++) a.push(pick(alphabet));
  for (let i = 0, m = Math.floor(rnd() * maxLen); i < m; i++) b.push(pick(alphabet));
  return [a, b];
}

/** 校验 ops 是合法单调对齐，且 same 条数等于 LCS。返回 {ok, why}。 */
function verify(ops, a, b) {
  let ai = 0, bi = 0, same = 0;
  for (const op of ops) {
    if (op.type === 'same') {
      if (a[op.aNo] !== b[op.bNo]) return { ok: false, why: `same 内容不符 a${op.aNo}/b${op.bNo}` };
      if (op.aNo !== ai || op.bNo !== bi) return { ok: false, why: `same 不连续，应为 a${ai}/b${bi}` };
      ai++; bi++; same++;
    } else if (op.type === 'del') {
      if (op.aNo !== ai) return { ok: false, why: `del 行号跳跃，应为 a${ai}` };
      ai++;
    } else if (op.type === 'add') {
      if (op.bNo !== bi) return { ok: false, why: `add 行号跳跃，应为 b${bi}` };
      bi++;
    } else {
      return { ok: false, why: `未知 op 类型 ${op.type}` };
    }
  }
  if (ai !== a.length) return { ok: false, why: `a 未消费完 ${ai}/${a.length}` };
  if (bi !== b.length) return { ok: false, why: `b 未消费完 ${bi}/${b.length}` };
  const want = dpLcs(a, b);
  if (same !== want) return { ok: false, why: `非最优：same=${same}，参照 LCS=${want}` };
  return { ok: true };
}

/* 字母表越小，重复行越多，分治挑错切分点越容易暴露 —— 二元字母表最狠。 */
const ALPHABETS = [
  ['x', 'y'],
  ['a', 'b', 'c'],
  Array.from({ length: 10 }, (_, i) => 'line' + i),
];

let checked = 0, bad = 0;
function report(r, a, b, who) {
  bad++;
  if (bad <= 3) console.log(`✗ ${who}: ${r.why}\n    a=${JSON.stringify(a)}\n    b=${JSON.stringify(b)}`);
}

// 1. 直接打核心，跳过前后缀剥离 —— 覆盖最硬的组合
for (const alpha of ALPHABETS) {
  for (let t = 0; t < N; t++) {
    const [a, b] = gen(28, alpha);
    const ops = [];
    L.lcsDiff(a, 0, a.length, b, 0, b.length, ops);
    const r = verify(ops, a, b);
    checked++;
    if (!r.ok) report(r, a, b, 'lcsDiff');
  }
}

// 2. 走带前后缀剥离的完整路径
for (let t = 0; t < N; t++) {
  const [a, b] = gen(30, ALPHABETS[t % ALPHABETS.length]);
  const r = verify(L.diffScripts(a.slice(), b.slice()), a, b);
  checked++;
  if (!r.ok) report(r, a, b, 'diffScripts');
}

// 3. diffLines 文本层往返 + identical 标记
for (let t = 0; t < Math.floor(N / 2); t++) {
  const [a, b] = gen(30, ALPHABETS[t % ALPHABETS.length]);
  const opts = [{}, { ignoreWhitespace: true }, { ignoreCase: true }, { ignoreEmpty: true }][t % 4];
  const at = a.join('\n'), bt = b.join('\n');
  const out = L.diffLines(at, bt, opts);
  checked++;
  if (out.identical !== (at === bt)) { bad++; if (bad <= 3) console.log('✗ diffLines: identical 标记错误'); }
  // toUnifiedDiff 必须是空串当且仅当两侧相同
  const ud = L.toUnifiedDiff(at, bt, opts);
  if (out.identical !== (ud === '')) { bad++; if (bad <= 3) console.log('✗ toUnifiedDiff: 空串条件与 identical 不一致'); }
}

if (bad) {
  console.log(`\n\x1b[31m${bad} 处不一致\x1b[0m（共 ${checked} 例）`);
  process.exit(1);
} else {
  console.log(`\x1b[32m全部通过\x1b[0m ${checked} 例随机样本，编辑脚本均合法且为最小编辑脚本`);
}