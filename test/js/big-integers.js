/*
 * 超范围整数的无损往返。
 *
 * 这条线守的是三件事：
 *   1. `ItTools.util` 的两个守卫函数本身（保护 / 还原）；
 *   2. 12 个 JSON / YAML / TOML 转换器，每一个都不能把 19 位整数改掉；
 *   3. 普通数据完全不受影响 —— 保护只在真的超范围时才动手。
 *
 * 为什么值得单开一个文件而不是塞进某个工具的 `__cases`：这条线横跨
 * json-viewer / yaml-viewer / toml-to-json …十几个模块，守卫本身又住在
 * app.js（不是工具模块，harness 不会跑它的 `__cases`）。哪个工具漏了
 * 接线，只有从外面拿真实输入打一遍才知道。
 *
 * 背景：上游 it-tools 的 #1615（标题就叫 "Long number precision is lost"，
 * 至今未修）。JS 的 Number 尾数只有 53 位，`9223372036854775807` 一进
 * JSON5 / YAML / TOML 的解析器就变成 `9223372036854776000`，而且没有任何一步
 * 会报错 —— 转换器就这么把用户的数据改了。`@iarna/toml` 更直接：超范围整数它
 * 返回 BigInt，而它自己算出来的那个 BigInt 就是错的
 * （`17478252242305210114` → `-968491831404341502`，连符号都反了）。
 *
 * 用法：node big-integers.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '../..');
const TOOLS = path.join(ROOT, 'static/js/tools');
const LIB = path.join(ROOT, 'static/lib');

/** 哨兵字符，与 app.js 里的 Util 用的是同一个（私用区 U+E000）。 */
const MARK = '\uE000';
const BIG = '17478252242305210114';          // 20 位，> 2^53-1
const I64_MAX = '9223372036854775807';

let failures = 0;
let checks = 0;
function ok(label, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) {
    failures++;
    console.log(`  ✗ ${label}\n      期望 ${b}\n      实际 ${a}`);
  }
}
function okThat(label, cond, detail) {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  ✗ ${label}\n      ${detail || ''}`);
  }
}

/* ---------- 起一个装了全部工具与依赖的窗口 ---------- */

const dom = new JSDOM('<!DOCTYPE html><body><div id="tool-body"></div></body>', {
  runScripts: 'outside-only',
  url: 'http://localhost/',
});
const w = dom.window;
w.fetch = () => new Promise(() => {});
w.eval(fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8'));
for (const lib of ['json5/dist/index.min.js', 'yaml/bundle.js', 'toml/bundle.js', 'xml-js/dist/xml-js.min.js']) {
  try { w.eval(fs.readFileSync(path.join(LIB, lib), 'utf8')); } catch (e) { /* 有的用例不需要它 */ }
}
for (const f of fs.readdirSync(TOOLS)) {
  if (f.endsWith('.js')) w.eval(fs.readFileSync(path.join(TOOLS, f), 'utf8'));
}
const U = w.ItTools.util;
const L = w.ItTools.logic;

console.log('--- guardBigIntegers：该换的换了 ---');
const guarded = (src, opts) => U.guardBigIntegers(src, opts).split(MARK).join('<M>');
ok('20 位十进制', guarded(`a=${BIG}`), `a="<M>#${BIG}<M>"`);
ok('i64::MAX', guarded(`[${I64_MAX}]`), `["<M>#${I64_MAX}<M>"]`);
ok('负数', guarded(`x: -${BIG}`, { hashComment: true }), `x: "<M>#-${BIG}<M>"`);
ok('JSON5 正号', guarded('{a:+9007199254740993}'), '{a:"<M>#9007199254740993<M>"}');
// 还原成十进制而不是原文：`0xFF` 在 YAML 里合法、在 JSON 里不合法
ok('十六进制还原成十进制', guarded('a: 0xFFFFFFFFFFFFFFFF', { hashComment: true }), 'a: "<M>#18446744073709551615<M>"');
ok('二进制', guarded('a: 0b' + '1'.repeat(64), { hashComment: true }), 'a: "<M>#18446744073709551615<M>"');
ok('TOML 下划线分隔', guarded('a = 1_744_782_524_230_521_0114', { hashComment: true }), 'a = "<M>#17447825242305210114<M>"');

console.log('--- guardBigIntegers：该不动的没动 ---');
ok('2^53-1 正好在界内', guarded('a=9007199254740991'), 'a=9007199254740991');
ok('15 位', guarded('a=123456789012345'), 'a=123456789012345');
ok('浮点数不管', guarded(`a=${BIG}.5`), `a=${BIG}.5`);
ok('指数不管', guarded('a=1.74478252423e19'), 'a=1.74478252423e19');
ok('字符串里的长数字是数据不是数值', guarded(`{"id":"${BIG}"}`), `{"id":"${BIG}"}`);
ok('注释里的长数字（YAML/TOML）', guarded(`a: 1 # ${BIG}\n`, { hashComment: true }), `a: 1 # ${BIG}\n`);
ok('标识符里的数字', guarded(`a: abc${BIG}`, { hashComment: true }), `a: abc${BIG}`);
ok('裸数字键不动（还原不成合法 JSON）', guarded(`{${BIG}: 1}`), `{${BIG}: 1}`);
ok('YAML 时间戳不拆', guarded('d: 1979-05-27T07:32:00Z', { hashComment: true }), 'd: 1979-05-27T07:32:00Z');
ok('TOML 多行字符串整段跳过', guarded(`a = """${BIG}"""`, { hashComment: true }), `a = """${BIG}"""`);
ok('没闭合的引号不会吞掉整个文件', guarded(`a = "${BIG}`), `a = "${BIG}`);
ok('空串', guarded(''), '');
ok('没有超范围整数时原样返回同一个串', U.guardBigIntegers('{"a":1}'), '{"a":1}');

console.log('--- restoreBigIntegers：三种输出形态 ---');
ok('JSON 双引号', U.restoreBigIntegers(`{"a":"${MARK}#123${MARK}"}`), '{"a":123}');
ok('YAML 单引号', U.restoreBigIntegers(`a: '${MARK}#123${MARK}'`), 'a: 123');
ok('YAML 裸标量', U.restoreBigIntegers(`a: ${MARK}#123${MARK}`), 'a: 123');
ok('负数', U.restoreBigIntegers(`[${MARK}#-123${MARK}]`), '[-123]');
ok('一个输出里多个', U.restoreBigIntegers(`[${MARK}#1${MARK},${MARK}#2${MARK}]`), '[1,2]');
ok('普通字符串不受影响', U.restoreBigIntegers('{"a":"hello"}'), '{"a":"hello"}');

console.log('--- restoreBigIntegerValue：逐值还原 ---');
ok('哨兵 → 数字文本', U.restoreBigIntegerValue(`${MARK}#${BIG}${MARK}`), BIG);
ok('普通字符串', U.restoreBigIntegerValue('hello'), 'hello');
ok('数字原样', U.restoreBigIntegerValue(42), 42);
ok('null 原样', U.restoreBigIntegerValue(null), null);

console.log('--- 12 个转换器：大整数必须原样出来 ---');
const JSON_IN = `{"userId":${BIG},"sn":${I64_MAX},"neg":-${BIG},"ok":12345,"f":1.5}`;
const YAML_IN = `userId: ${BIG}\nsn: ${I64_MAX}\nneg: -${BIG}\nok: 12345\nf: 1.5\n`;
const TOML_IN = `userId = ${BIG}\nsn = ${I64_MAX}\nneg = -${BIG}\nok = 12345\nf = 1.5\n`;

function converter(tool, fnName, input, label) {
  let out;
  try { out = L[tool][fnName](input); }
  catch (e) { ok(label, '抛错: ' + e.message, '正常返回'); return; }
  okThat(label, String(out).includes(BIG) && String(out).includes(I64_MAX),
    `输出里找不到原整数，实际输出：${String(out).slice(0, 200)}`);
}

converter('json-viewer', 'formatJson', JSON_IN, 'json-viewer  (/json-prettify)');
converter('json-minify', 'minifyJson', JSON_IN, 'json-minify');
converter('json-to-yaml-converter', 'jsonToYaml', JSON_IN, 'json-to-yaml');
converter('json-to-xml', 'jsonToXml', JSON_IN, 'json-to-xml');
converter('json-to-toml', 'jsonToToml', JSON_IN, 'json-to-toml');
converter('yaml-to-json-converter', 'yamlToJson', YAML_IN, 'yaml-to-json');
converter('yaml-viewer', 'formatYaml', YAML_IN, 'yaml-viewer  (/yaml-prettify)');
converter('yaml-to-toml', 'yamlToToml', YAML_IN, 'yaml-to-toml');
converter('toml-to-json', 'tomlToJson', TOML_IN, 'toml-to-json');
converter('toml-to-yaml', 'tomlToYaml', TOML_IN, 'toml-to-yaml');

/* json-to-csv：UI 路径是 render() 先 guard 再 JSON.parse，convertArrayToCsv
   拿到的是已经解析好的数组，所以这里照抄那条路径。 */
{
  let out;
  try {
    out = L['json-to-csv'].convertArrayToCsv(
      JSON.parse(U.guardBigIntegers(`[{"id":${BIG},"sn":${I64_MAX},"ok":12345}]`))
    );
  } catch (e) { out = '抛错: ' + e.message; }
  okThat('json-to-csv', String(out).includes(BIG) && String(out).includes(I64_MAX),
    `输出：${String(out).slice(0, 200)}`);
  // 还原出来的必须是**裸数字**，不能带引号 —— 带引号 Excel 会当文本
  okThat('json-to-csv 还原成裸数字（不被当成字符串）', !/"-?\d{16,}"/.test(String(out)),
    `输出里出现了带引号的超长数字：${String(out).slice(0, 200)}`);
}

console.log('--- json-diff：哨兵相等才不会误判「有差异」 ---');
{
  const JD = L['json-diff'];
  const parse = (s) => JSON.parse(U.guardBigIntegers(s));
  const changed = (x, y) => JD.hasChanges(JD.diff(parse(x), parse(y)));
  ok('同一份文档 → 无差异', changed(JSON_IN, JSON_IN), false);
  ok('只有真数字不同 → 有差异', changed(JSON_IN, JSON_IN.replace('"ok":12345', '"ok":99999')), true);
  // 这条是本测试存在的理由：末位差 1 的两个大整数，
  // 在没有保护时会被 Number 舍成同一个值，于是「有差异」被误判成「无差异」
  ok('两个大整数末位差 1 → 仍是差异', changed(`{"a":${BIG}}`, `{"a":${BIG.slice(0, -1)}5}`), true);

  const node = JD.diff(parse('{"a":1}'), parse(`{"a":${BIG}}`)).children[0];
  ok('渲染时逐值还原成数字', U.restoreBigIntegerValue(node.value), BIG);
}

console.log('--- 同格式二次转换必须幂等 ---');
// 只在「输入输出同一种格式」时才有意义：toml-to-yaml 的输出是 YAML，
// 拿回去喂 TOML 解析器当然报错，那是格式换了，不是精度丢了
[['json-viewer', 'formatJson', JSON_IN], ['json-minify', 'minifyJson', JSON_IN],
 ['yaml-to-json-converter', 'yamlToJson', YAML_IN], ['yaml-viewer', 'formatYaml', YAML_IN]].forEach(([tool, fn, input]) => {
  const once = L[tool][fn](input);
  const twice = L[tool][fn](once);
  okThat(`${tool}.${fn} 幂等`, once === twice, `两次输出不同：\n      1 ${once.slice(0, 120)}\n      2 ${twice.slice(0, 120)}`);
});

console.log('--- 普通数据一点不受影响 ---');
[
  ['json-viewer', 'formatJson', '{"a":1,"b":[1,2,{"c":"x"}],"d":null,"e":1.5}'],
  ['json-minify', 'minifyJson', '{"a":1,"b":"héllo 💩"}'],
  ['json-to-yaml-converter', 'jsonToYaml', '{"foo":"bar","list":["item",{"key":"value"}]}'],
  ['yaml-to-json-converter', 'yamlToJson', 'a: 1\nb:\n  - x\n  - y\n'],
  ['yaml-viewer', 'formatYaml', 'a: 1\nb: two\n'],
  ['yaml-to-toml', 'yamlToToml', 'a: 1\nb: two\n'],
  ['toml-to-json', 'tomlToJson', 'a = 1\nb = "x"\n[t]\nc = true\n'],
  ['toml-to-yaml', 'tomlToYaml', 'a = 1\nb = "x"\n'],
].forEach(([tool, fn, input]) => {
  let out;
  try { out = L[tool][fn](input); } catch (e) { out = '抛错: ' + e.message; }
  okThat(`${tool}.${fn} 输出里没有哨兵残留`, !String(out).includes(MARK), String(out).slice(0, 160));
});

console.log(failures
  ? `\n${failures} 项不符（共 ${checks} 项）`
  : `\n全部符合预期（${checks} 项）`);
process.exit(failures ? 1 : 0);