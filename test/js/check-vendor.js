/*
 * vendor 产物自检：每个库用 <script> 标签加载后，到底有没有挂出可用的全局？
 *
 * 为什么需要这个：`npm pack` 下来的包里混着 ESM 桩文件、CommonJS、以及
 * 「deprecated，路径已挪走」的抛错占位文件。光看文件名（*.min.js 之类的）
 * 挑很容易挑中坏的那个 —— mathjs 的 dist/math.min.js 就是一个只会 throw 的
 * 弃用占位，libphonenumber-js/max/index.js 是纯 ESM 重导出，xml-js 挂的
 * 也不止 xml2js 一个（还顺手塞了 setImmediate）。
 *
 * 所以这里直接把文件丢进 jsdom 真跑一遍，看 window 上多了什么。
 * 顺带对每个库做一次**功能**断言 ——「没抛异常」和「能用」之间差得很远，
 * 一个只 export 了 {} 的空壳也能安静地加载。断言里的期望值都是在真跑过
 * 之后才写下来的，凭印象写期望值这件事本身已经在这个文件上错过好几轮了。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// vendored 库目录 = 本文件往上两级到仓库根，再进 static/lib。
// 不写死绝对路径 —— 别人把仓库 clone 到别处时，写死的路径直接跑不起来。
const LIB = path.join(__dirname, '..', '..', 'static', 'lib');

/* 直接拷进来的 UMD / IIFE 产物 */
const PLAIN = [
  ['ulid', 'ulid/dist/index.umd.js', ['ULID'],
    // UMD 挂的是整个命名空间，真正的 ulid 生成函数在 .ulid 上
    w => /^[0-9A-Z]{26}$/.test(w.ULID.ulid()) && w.ULID.ulid() !== w.ULID.ulid()],
  // 名字很有迷惑性：xml2js/js2xml 走对象，xml2json/json2xml 返回的是 **JSON 文本字符串**。
  // 而且 compact 只有前者认 —— 给 xml2json 传 {compact:true} 会被默默忽略，
  // 拿回来的还是完整 AST 的字符串，写工具时按名字猜必然踩雷。
  ['xml-js', 'xml-js/dist/xml-js.min.js', ['xml2js', 'xml2json', 'js2xml', 'json2xml'],
    w => JSON.stringify(w.xml2js('<a>1</a>', { compact: true })) === '{"a":{"_text":"1"}}'
      && w.js2xml({ a: { _text: '1' } }, { compact: true }) === '<a>1</a>'
      && JSON.parse(w.xml2json('<a>1</a>')).elements[0].name === 'a'],
  // 坑：json5@2.2.3 这个 build **不支持 elision（两个连续逗号）**，跟注释没关系。
  // 一开始记的诊断是「块注释紧跟逗号时分词器就挂了」——错的，[1,/*x*/,2] 之所以炸只是
  // 因为剥掉注释之后它本来就是 [1,,2]。实测对照：
  //     [1,/*x*/,2]  → ERR   [1,,2] → ERR   [1, ,2] → ERR
  //     [1,/*x*/2]   → ok    {a:1,,b:2} → ERR
  // 块注释和行注释本身都正常。所以工具侧要处理的是 elision，不是注释。
  ['json5', 'json5/dist/index.min.js', ['JSON5'],
    w => {
      const v = w.JSON5.parse('{a:1,/*c*/b:2,}');          // 注释后面不是逗号
      const l = w.JSON5.parse('[1,//x\n2]');                 // 行注释
      const e = w.JSON5.parse('[1,/*x*/2]');                // 注释后面没有第二个逗号
      let elisionOk = false;
      try { w.JSON5.parse('[1,,2]'); } catch (err) { elisionOk = true; }
      return v.a === 1 && v.b === 2 && l[1] === 2 && e[1] === 2 && elisionOk;
    }],
  // jsonrepair：挂出的全局 JSONRepair 是个**对象**，函数在 .jsonrepair 上
  // （不是全局函数本身，写成 window.jsonrepair(...) 会 undefined）。
  // 修的是「少了逗号 / 括号没闭合 / 尾逗号 / 缺值」这类常见手误。
  // 坑：它只认严格 JSON —— JSON5 的十六进制数字 0xFF 会被当成**字符串** "0xFF"，
  // NaN / Infinity 同理。所以工具侧只在「普通解析失败」之后才用它，别拿它当主解析器。
  ['jsonrepair', 'jsonrepair/lib/umd/jsonrepair.min.js', ['JSONRepair'],
    w => {
      const jr = w.JSONRepair.jsonrepair;
      return typeof jr === 'function'
        && jr('{"a":1 "b":2}') === '{"a":1, "b":2}'      // 补上漏掉的逗号
        && jr('[1,2,3') === '[1,2,3]'                    // 补上没闭合的括号
        && jr('{"a":1,}') === '{"a":1}'                  // 去掉尾逗号
        && jr('{"a":1,"b":}') === '{"a":1,"b":null}'     // 缺的值补成 null
        && jr("{'a':'b'}") === '{"a":"b"}'               // 单引号换成双引号
        && jr('{"a":1}') === '{"a":1}';                  // 本身合法的原样返回
    }],
  ['markdown-it', 'markdown-it/dist/markdown-it.min.js', ['markdownit'],
    w => w.markdownit().render('# hi').trim() === '<h1>hi</h1>'],
  // turndown：HTML → Markdown。内部用 DOMParser，所以只能在浏览器/jsdom 里跑。
  // 挂出的是全局 TurndownService（构造函数），不是实例。
  ['turndown', 'turndown/lib/turndown.browser.umd.js', ['TurndownService'],
    w => typeof w.TurndownService === 'function'
      && new w.TurndownService().turndown('<h1>Hi</h1>') === 'Hi\n=='],
  // GFM 插件：挂出的是命名空间 TurndownPluginGfmService（gfm / tables / taskListItems…），
  // 不是构造函数 —— 它的每个函数都把 turndown 服务当参数收，不需要自己 require('turndown')。
  // 这里连 turndown 一起加载，端到端验一次表格转换（表头 + 分隔行 + 数据行）。
  ['turndown-plugin-gfm', 'turndown-plugin-gfm/dist/turndown-plugin-gfm.js', ['TurndownPluginGfmService'],
    w => {
      w.eval(fs.readFileSync(path.join(LIB, 'turndown/lib/turndown.browser.umd.js'), 'utf8'));
      const svc = new w.TurndownService();
      w.TurndownPluginGfmService.gfm(svc);
      const table = svc.turndown(
        '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
      return table === '| A | B |\n| --- | --- |\n| 1 | 2 |'
        && svc.turndown('<del>x</del>') === '~x~'
        && svc.turndown('<ul><li><input type="checkbox" checked> done</li></ul>') === '*   [x]  done';
    }],
  ['sql-formatter', 'sql-formatter/dist/sql-formatter.min.js', ['sqlFormatter'],
    w => /select/i.test(w.sqlFormatter.format('select a from b'))],
  ['cronstrue', 'cronstrue/dist/cronstrue.min.js', ['cronstrue'],
    w => /every minute/i.test(w.cronstrue.toString('* * * * *'))],
  ['mathjs', 'mathjs/lib/browser/math.js', ['math'],
    w => w.math.evaluate('2 + 3 * 4') === 14],
  ['ua-parser-js', 'ua-parser-js/dist/ua-parser.min.js', ['UAParser'],
    w => new w.UAParser('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)').getDevice().type === 'mobile'],
  ['regexper-render', 'regexper-render/dist/regexper.js', ['regexper'],
    w => typeof w.regexper.render === 'function'],
  ['qrcode', 'qrcode/build/qrcode.js', ['QRCode'],
    w => typeof w.QRCode.create === 'function' && typeof w.QRCode.toCanvas === 'function'],
  ['libphonenumber-js', 'libphonenumber-js/bundle/libphonenumber-max.js', ['libphonenumber'],
    w => w.libphonenumber.parsePhoneNumber('+14155552671').country === 'US'],
  // js-beautify：挂出的是**对象**不是函数 —— 入口是 .js() / .css() / .html()。
  // 上游 it-tools 里 `import beautify from 'js-beautify'` 拿到的可调用对象来自
  // js/index.js（Node 入口，会拉 glob / nopt / editorconfig），浏览器里用不了，
  // 所以只能用裸 UMD 的 js/lib/beautifier.js。
  // 另外它的 indent_size 默认是 **4** 不是 2，options 是覆盖不是合并。
  ['js-beautify', 'js-beautify/js/lib/beautifier.js', ['beautifier'],
    w => w.beautifier.js('function  foo( a,b ){return a+b;}', { indent_char: ' ', indent_size: 2, eol: '\n' })
      === 'function foo(a, b) {\n  return a + b;\n}'
      && w.beautifier.css('a{color:red;background:blue}', { indent_char: ' ', indent_size: 2, eol: '\n' })
      === 'a {\n  color: red;\n  background: blue\n}'],
  // exifreader：4.x 的 load() 收到 ArrayBuffer 时**同步**返回解析结果
  // （传 URL / File 才是 Promise）。用一张 454 字节的最小 JPEG 真解一遍。
  ['exifreader', 'exifreader/dist/exif-reader.js', ['ExifReader'],
    w => {
      const base64 = '/9j/4cABRXhpZgAASUkqAAgAAAAHAA8BAgAGAAAA/gAAABABAgAXAAAABAEAABIBAwAB'
        + 'AAAAAQAAABoBBQABAAAAHAEAADIBAgAUAAAAJAEAAGmHBAABAAAAYgAAACWIBAABAAAAsAAAAAAAAAAGAJqCBQABAAAAOAEAAJ2CBQABAAAAQAEAACeI'
        + 'AwABAAAAkAEAAAOQAgAUAAAASAEAAAqSBQABAAAAXAEAADSkAgAbAAAAZAEAAAAAAAAGAAEAAgACAAAATgAAAAIABQADAAAAgAEAAAMAAgACAAAARQAAAAQABQ'
        + 'ADAAAAmAEAAAUAAQABAAAAAAAAAAYABQABAAAAsAEAAAAAAABDYW5vbgBDYW5vbiBFT1MgNUQgTWFyayBJVgAAAABIAAAAAQAAADIwMjQ6MDE6MDkgMTI6'
        + 'MzQ6NTYAAQAAAMgAAAAcAAAACgAAADIwMjQ6MDE6MDkgMTI6MzQ6NTYAMgAAAAEAAABFRjI0LTcwbW0gZi8yLjhMIElJIFVTTQAAAAAAMgAAAAEAAAAEAAAAAQAA'
        + 'ALABAABkAAAADgAAAAEAAAAZAAAAAQAAAOwEAABkAAAA6wAAAAEAAAD/2Q==';
      const raw = Buffer.from(base64, 'base64');
      const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const tags = w.ExifReader.load(buffer, { expanded: true });
      return tags.exif.Model.description === 'Canon EOS 5D Mark IV'
        && tags.exif.ExposureTime.description === '1/200'
        && tags.exif.FNumber.description === 'f/2.8'
        && tags.exif.ISOSpeedRatings.description === 400
        && tags.exif.DateTimeOriginal.description === '2024:01:09 12:34:56'
        && Math.abs(tags.gps.Latitude - 50.06786666666667) < 1e-9
        && Math.abs(tags.gps.Longitude - 14.420166666666667) < 1e-9
        && tags.gps.Altitude === 235
        && tags.file.FileType.description === 'JPEG';
    }],
  // convert：window.convert 是**命名空间对象**，不是函数 ——
  // 真正的换算函数在 .default（=== .convert）。
  // 而且它没有 .from()：源单位在构造时就带上了，形状是 convert(q, from).to(to)。
  ['convert', 'convert/dist/index.js', ['convert'],
    w => {
      const cv = w.convert.default;
      let badUnit = false, crossMeasure = false;
      try { cv(1, 'zzz').to('m'); } catch (e) { badUnit = e.name === 'RangeError'; }
      try { cv(1, 'm').to('kg'); } catch (e) { crossMeasure = e.name === 'RangeError'; }
      return typeof cv === 'function'
        && cv(1, 'km').to('m') === 1000
        && cv(1, 'lb').to('kg') === 0.45359237
        && cv(1, 'h').to('min') === 60
        && cv(1, 'atm').to('Pa') === 101325
        && cv(1, 'Wh').to('J') === 3600
        && cv(1, 'KiB').to('B') === 1024
        && cv(1, 'gal').to('L') === 3.785411784
        && cv(1, 'deg').to('rad') === 0.017453292519943295
        && cv(1, 'hp').to('W') === 745.699872
        && cv(1, 'kgf').to('N') === 9.80665
        && cv(1, 'm3').to('L') === 1000
        && String(cv(1234, 'm').to('best')) === '1.234 km'
        && badUnit && crossMeasure;
    }],
];

/* scripts/cjs-bundle.js 打完的 bundle.js。第二个字段是期望挂出的全局名，
   第三个是这个库里真正要用的入口形态（和 vendor-js-libs.sh 的 CJS_GLOBAL 对应）。 */
const CJS = [
  ['uuid', 'uuid', ['uuid'],
    w => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(w.uuid.v4())],
  ['nanoid', 'nanoid', ['nanoid'],
    w => w.nanoid.nanoid(10).length === 10 && typeof w.nanoid.customAlphabet === 'function'],
  ['bip39', 'BIP39', ['BIP39'],
    w => w.BIP39.englishWordList.words.length === 2048
      && w.BIP39.entropyToMnemonic('7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f')
        === 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
  ['colord', 'Colord', ['Colord'],
    w => w.Colord('#ff0000').toHex() === '#ff0000' && w.Colord('rgb(255,0,0)').toHsl().h === 0],
  ['yaml', 'YAML', ['YAML'],
    w => w.YAML.parse('a: 1').a === 1 && w.YAML.stringify({ a: 1 }).trim() === 'a: 1'],
  ['toml', 'TOML', ['TOML'],
    w => JSON.stringify(w.TOML.parse('a = 1\nb = "x"')) === '{"a":1,"b":"x"}'
      && w.TOML.stringify({ a: 1 }) === 'a = 1\n'],
  ['xml-formatter', 'xmlFormatter', ['xmlFormatter'],
    w => w.xmlFormatter('<a><b>1</b></a>') === '<a>\r\n    <b>\r\n        1\r\n    </b>\r\n</a>'],
  ['ibantools', 'ibantools', ['ibantools'],
    // 带空格的会判成 false —— 工具里得先自己把空格去掉，这是个容易踩的坑
    w => w.ibantools.isValidIBAN('GB82WEST12345698765432') === true
      && w.ibantools.isValidIBAN('GB82WEST12345698765433') === false],
  ['country-code-lookup', 'countryCodeLookup', ['countryCodeLookup'],
    w => w.countryCodeLookup.byIso('CN').country === 'China'],
  ['cron-validator', 'cronValidator', ['cronValidator'],
    w => w.cronValidator.isValidCron('*/5 * * * *') === true
      && w.cronValidator.isValidCron('bogus') === false],
  ['randexp', 'RandExp', ['RandExp'],
    w => { const s = new w.RandExp('[a-c]{2,4}').gen(); return /^[a-c]{2,4}$/.test(s); }],
  ['oggen', 'oggen', ['oggen'],
    // 签名不是 oggen(url, opts) —— @it-tools/oggen@1.3.0 导出的是 generateMeta(metadataObj, opts)，
    // 单参数对象。之前这里按 url 传字符串，断言只正则匹配 '<meta property="og:'
    // 所以照样绿 —— 值全是 undefined 也看不出来。断言要钉住真实值。
    // 另外注意它输出的是 value=" 而不是规范要求的 content="，图片属性也写成 og:img_url，
    // 那是上游的 bug，由工具侧修正，不在 vendor 层动。
    w => w.oggen({ type: 'website', url: 'https://example.com/a', title: 'T', description: 'D' })
      .includes('<meta property="og:title" value="T"')],
  ['composerize', 'composerize', ['composerize'],
    // 返回的是 {yaml, messages}，不是 YAML 字符串
    // 调用它会往 console 打一行 '://user:pass@host:27017/mydb'：flex-js 的
    // Lexer.defaultOutput() 拿不到 process.stdout 时 fallback 到 console.log，
    // 真浏览器也一样（不是我们的 shim 造成的）。断言时静音，免得测试输出里
    // 混进一行看着像故障的日志 —— 工具侧同样处理。
    w => {
      const real = w.console.log;
      w.console.log = function () {};
      try {
        return /^version: '3\.9'/m.test(w.composerize('mongodb://user:pass@host:27017/mydb').yaml);
      } finally {
        w.console.log = real;
      }
    }],
  ['email-normalizer', 'emailNormalizer', ['emailNormalizer'],
    // 注意它收的是对象不是字符串，传字符串会抛 "Invalid email"（参考项目也是这么调的）
    w => w.emailNormalizer.normalizeEmail({ email: 'Test@GMX.com' }) === 'test@gmx.com'],
  ['date-fns', 'dateFns', ['dateFns'],
    // 挂出来的就是 formatRelative 本体（bundle 用 --export 取了默认导出）。
    // 输出走 Intl，具体文案随 locale 和本机时区变，所以不硬编码那句话，
    // 断言的是**行为边界**：±7 天内给相对说法，超过就退回绝对日期。
    // （早先这里写的是「56 年的差值会退回绝对日期」——错的，实测阈值是 7 天。）
    // 少传参数会抛，不是返回 undefined。
    w => {
      const base = new Date(Date.UTC(2024, 0, 10));
      const near = w.dateFns(new Date(base.getTime() + 864e5), base);
      const far = w.dateFns(new Date(base.getTime() + 30 * 864e5), base);
      let threw = false;
      try { w.dateFns(base); } catch (e) { threw = true; }
      return typeof near === 'string' && near.length > 0
        && /^\d+\/\d+\/\d+/.test(far)      // 7 天以上变成 M/D/YYYY
        && threw;                         // 必须传足两个参数
    }],
  ['figlet', 'figlet', ['figlet'],
    // textSync 是 Node 专用（要 fs 同步读字体），浏览器里只有异步的 text；
    // 这里验的是字体解析器 + 我们随包发的字体文件本身
    w => {
      const flf = fs.readFileSync(path.join(LIB, 'figlet/fonts/Standard.flf'), 'utf8');
      const font = w.figlet.parseFont('Standard', flf);
      // 1.7.0 的 hardBlank 是 '$'，渲染时才替换成 █
      return typeof w.figlet.text === 'function' && font.height === 6 && font.hardBlank === '$';
    }],
];

/* 纯数据（json）：不走 script 标签，运行时 fetch */
const DATA = [
  ['emojilib', 'emojilib/emoji-en-US.json'],
  ['unicode-emoji-json', 'unicode-emoji-json/data-by-emoji.json'],
  ['mime-db', 'mime-db/db.json'],
];

let pass = 0;
const fail = [];

function loadScript(name, file) {
  const full = path.join(LIB, file);
  if (!fs.existsSync(full)) { fail.push([name, `文件不存在: ${file}`]); return null; }
  try {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'dangerously' });
    dom.window.eval(fs.readFileSync(full, 'utf8'));
    return dom.window;
  } catch (e) {
    fail.push([name, `加载抛异常: ${String(e.message).slice(0, 90)}`]);
    return null;
  }
}

function checkScript(name, file, globals, check) {
  const w = loadScript(name, file);
  if (!w) return;
  const missing = globals.filter(g => w[g] === undefined);
  if (missing.length) { fail.push([name, `没挂出全局: ${missing.join(', ')}`]); return; }
  if (check) {
    try {
      if (!check(w)) { fail.push([name, `全局挂出来了，但功能断言不通过`]); return; }
    } catch (e) {
      fail.push([name, `功能断言自己抛异常: ${String(e.message).slice(0, 90)}`]);
      return;
    }
  }
  pass++;
}

for (const [name, file, globals, check] of PLAIN) checkScript(name, file, globals, check);
for (const [name, globalName, globals, check] of CJS) checkScript(name, `${name}/bundle.js`, globals, check);

for (const [name, file] of DATA) {
  const full = path.join(LIB, file);
  if (!fs.existsSync(full)) { fail.push([name, `文件不存在: ${file}`]); continue; }
  try {
    if (typeof JSON.parse(fs.readFileSync(full, 'utf8')) !== 'object') {
      fail.push([name, '解析出来不是对象']);
      continue;
    }
    pass++;
  } catch (e) { fail.push([name, `不是合法 JSON: ${String(e.message).slice(0, 60)}`]); }
}

/* figlet 的 .flf 字体：不走 script 标签，但页面会 fetch 它们，
   少拷一个就是那个字体一点就报错的坑，所以一起数一遍。 */
try {
  const fonts = fs.readdirSync(path.join(LIB, 'figlet/fonts'));
  const broken = fonts.filter(f => !fs.readFileSync(path.join(LIB, 'figlet/fonts', f), 'utf8').startsWith('flf2'));
  if (broken.length) fail.push(['figlet/fonts', `${broken.length} 个字体文件头不是 flf2: ${broken.slice(0, 3).join(', ')}`]);
  else { pass++; }
} catch (e) { fail.push(['figlet/fonts', String(e.message).slice(0, 60)]); }

if (fail.length) {
  console.log('\x1b[31m失败\x1b[0m');
  for (const [n, why] of fail) console.log(`  ✗ ${n.padEnd(20)} ${why}`);
  console.log(`\n${pass}/${pass + fail.length} 通过`);
  process.exit(1);
}
console.log(`\x1b[32m全部通过\x1b[0m ${pass} 个 vendor 产物，均能加载且功能自检通过`);