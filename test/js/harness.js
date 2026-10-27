/*
 * JS 工具模块的冒烟测试。
 *
 * 每个 static/js/tools/<slug>.js 都要过两关：
 *   1. 能注册进 ItTools，挂到页面上不抛异常；
 *   2. 如果模块挂了 ItTools.logic[slug]，跑它自己声明的用例。
 *
 * 依赖第三方库的工具还要先把库灌进 jsdom —— 清单和浏览器渲染用的是同一份
 * static/lib/manifest.tsv（Rust 侧读它渲染 <script>），不存在「页面加了库、
 * 测试没加」这种只有一边生效的状态。
 *
 * 用法：node harness.js [slug ...]        不带参数则测全部
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

// 仓库根目录 = 本文件往上两级（test/js/ → 仓库根）。
// 不写死绝对路径 —— 别人把仓库 clone 到别处时，写死的路径直接跑不起来。
const ROOT = path.join(__dirname, '..', '..');
const TOOLS = path.join(ROOT, 'static/js/tools');
const LIB = path.join(ROOT, 'static/lib');

/** slug → 库产物路径数组，读的是浏览器同款清单 */
function libManifest() {
  const map = new Map();
  for (const line of fs.readFileSync(path.join(LIB, 'manifest.tsv'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [slug, files] = t.split('\t');
    map.set(slug, files.split(',').map(s => s.trim()).filter(Boolean));
  }
  return map;
}

/* 每个工具页的最小骨架 —— 只保留 app.js 与 mountAll 真正用到的部分。 */
function page(slug) {
  return `<!DOCTYPE html><html><body>
    <div class="layout" id="layout">
      <div class="main"><main class="content" id="main-content">
        <div class="tool-content" id="tool-body">
          <div class="card tool-loading" id="tool-loading"></div>
        </div>
      </main></div>
    </div>
  </body></html>`;
}

function bootWindow(slug, libs) {
  // jsdom 把事件监听器里抛出的异常**吞掉**（不往外抛，只报到 virtual console）。
  // 工具的输入处理器要是抛了异常，页面上就是「敲一个字整块工具白了」，
  // 而测试里什么也看不见 —— 所以这里自己盯着 console，把异常收集起来。
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    // jsdom 自己「没实现」的提示不算错（download 触发的导航、window.open 等）
    if (/Not implemented/i.test(e.message)) return;
    errors.push(e);
  });

  const dom = new JSDOM(page(slug), { runScripts: 'outside-only', url: 'http://localhost/', virtualConsole: vc });
  const w = dom.window;
  w.__errors = errors;
  // app.js 的 boot() 会 fetch 工具索引，测试里不需要
  w.fetch = () => new Promise(() => {});
  // jsdom 没有 matchMedia（initMenu 用它判断 700px 断点），补一个最简实现。
  // 默认 matches:false = 宽屏，和 jsdom 默认 1024px 窗口一致。
  w.matchMedia = (q) => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {} });
  // jsdom 不暴露 TextEncoder/TextDecoder，但它们是 Encoding 标准的必备 API，
  // 所有目标浏览器都有（base64、jwt、unicode 类工具都依赖），所以补上以贴近真实环境。
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  // jsdom 也没实现 URL.createObjectURL（浏览器都有），工具的「下载」按钮会用到。
  w.URL.createObjectURL = () => 'blob:it-tools-test';
  w.URL.revokeObjectURL = () => {};
  // 浏览器里这些库是 <script src> 同步加载的，jsdom 不会自动去取，
  // 这里按 tool.html 的顺序手动喂进去
  for (const lib of libs) {
    w.eval(fs.readFileSync(path.join(LIB, lib), 'utf8'));
  }
  w.eval(fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8'));
  w.document.querySelector('.tool-content').dataset.slug = slug;
  // 数一数每个工具的 mount 被调了几次。
  // 真实页面里 mountAll() 会被调两次（模板里的内联脚本 + boot()），
  // 同一个工具只能挂一次 —— 这里记着数，下面有专门的检查盯着。
  w.__mounts = {};
  const origRegister = w.ItTools.register;
  w.ItTools.register = function (toolSlug, fn) {
    w.__mounts[toolSlug] = 0;
    return origRegister.call(this, toolSlug, function (root) {
      w.__mounts[toolSlug]++;
      return fn(root);
    });
  };
  return w;
}

let pass = 0;
const failures = [];

/* 传给工具模块 __cases 的断言。必须在循环之前定义完，
   模块里拿到的是这个函数的引用，属性要提前挂好。

   这里**收集**失败而不是第一个就抛 —— 否则一条写错的期望值会把后面所有断言
   一起盖掉，报告上只剩一处，看起来像「只错了一个」，实际上后面根本没跑过。 */
let collected = null;

function assertFn(cond, msg) {
  if (!cond) collected.push(msg || '断言失败');
}
assertFn.eq = function (actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) collected.push(`${msg || ''} 期望 ${b}，实际 ${a}`);
};

function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { failures.push({ name, error: e.message }); }
}

/* ---- 中文语言包 ----
   Rust 侧（src/i18n.rs）只认**字面量**的 t('key', …) 调用；键是拼出来的那种
   （'col.' + name）它扫不到，也就查不了语言包里有没有这一条。

   这里反过来做：从真实的 zh-CN.yml 出发，把整个模块真跑一遍。任何 t() 调用
   —— 键是不是字面量都一样 —— 都会去 bundle 里查，缺一条就记下来。
   顺带把「工具挂载时不抛异常」也在中文包下再验一遍。 */
function zhBundle() {
  const dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync(path.join(LIB, 'yaml/bundle.js'), 'utf8'));
  const doc = dom.window.YAML.parse(fs.readFileSync(path.join(ROOT, 'locales/zh-CN.yml'), 'utf8'));
  const flat = {};
  (function walk(node, prefix) {
    for (const [k, v] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      else flat[key] = String(v);
    }
  })(doc, '');
  // 前端拿到的键去掉了 `ui.` 前缀（见 crate::i18n::ui_bundle）
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    if (k.startsWith('ui.')) out[k.slice(3)] = v;
  }
  return out;
}

const only = process.argv.slice(2);
const files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
const LIBS = libManifest();
const ZH = zhBundle();

/* 开过的窗口都留着，最后一起收一遍「迟到的异常」 */
const windows = [];

for (const slug of files) {
  if (only.length && !only.includes(slug)) continue;
  const code = fs.readFileSync(path.join(TOOLS, `${slug}.js`), 'utf8');

  let w;
  try {
    w = bootWindow(slug, LIBS.get(slug) || []);
    w.eval(code);
  } catch (e) {
    failures.push({ name: `${slug} · 加载`, error: e.message });
    continue;
  }
  windows.push({ slug, w });

  // 1. 注册名必须与文件名一致
  check(`${slug} · 注册名一致`, () => {
    if (!w.ItTools.logic || !w.ItTools.logic[slug]) {
      throw new Error('未挂 ItTools.logic，纯逻辑无法单测');
    }
  });

  // 2. 挂载到真实容器
  check(`${slug} · 挂载`, () => {
    w.ItTools.mountAll();
    const body = w.document.getElementById('tool-body');
    if (!body.children.length) throw new Error('挂载后容器为空');
    if (body.getElementById) { /* noop */ }
    if (w.document.getElementById('tool-loading')) {
      throw new Error('加载占位没被移除');
    }
  });

  // 2.2 同一个工具只能挂一次
  //     页面加载时 mountAll() 会被调两次：一次是 tool.html 末尾的内联脚本
  //     （DOMContentLoaded 之前），一次是 app.js 的 boot()（DOMContentLoaded 时）。
  //     挂两遍的话 mount 里的副作用要跑两遍，第一个实例刚建好就被 destroy 掉，
  //     异步拉的数据还会写进已经清空的 DOM。
  check(`${slug} · 只挂一次`, () => {
    const n = w.__mounts[slug] || 0;
    if (n !== 1) throw new Error(`mount 被调了 ${n} 次，应当只挂 1 次`);
  });

  // 2.5 面板必须是「整块」，不能是碎片
  //     .tool-content 是 flex 容器（照抄参考实现 tool.layout.vue 的 .tool-content），
  //     它的**直属子元素各自就是一块面板**。字段、按钮条、提示、裸 div 这类碎片
  //     直接挂上去，会各自变成一块 600px 的独立面板 —— 好几个工具都栽过这一下，
  //     比如 ulid-generator 的「Refresh」按钮曾经孤零零飘在卡片外面。
  //
  //     但「必须是一张 .card」这条后来被证明太死：参考实现的结果区是
  //     **标题在卡片外面、卡片里是代码**（n-form-item 的 label + c-card），
  //     也就是直属子元素是一个「div.code-label + div.card」的包装层，不是卡片本身。
  //     参考实现的 svg-placeholder-generator 还把预览图作为模板的第二个根节点渲染，
  //     eta-calculator 的 n-divider 也直接挂在根上 —— 同样不是卡片。
  //
  //     所以现在守两条：
  //       a) 顶层不许出现裸露的交互控件（当初 ulid 那个 bug 的形状）；
  //       b) 顶层元素要么是卡片，要么是一块「装着完整内容」的块。
  check(`${slug} · 面板都是整张卡片`, () => {
    const body = w.document.getElementById('tool-body');
    const BLOCK = '.card, .field, .field-row, .input-group, .form-actions, .alert, ' +
      '.code-label, .input-copyable, .api-rows, .output-body, .preview-box, ' +
      'pre, table, img, .tool-divider';
    const isWhole = (el) => {
      const tag = el.tagName.toLowerCase();
      if (['button', 'input', 'select', 'textarea', 'label', 'a'].includes(tag)) return false;
      if (el.classList.contains('card')) return true;
      // 预览图：参考实现里就是模板的第二个根节点
      if (tag === 'img') return true;
      // 分隔线：参考实现里的 n-divider 就挂在根上
      if (el.classList.contains('tool-divider')) return true;
      // 空容器（比如装提示的 notes 区）不占地方，放行
      if (!el.children.length) return true;
      return !!el.querySelector(BLOCK);
    };
    const stray = Array.from(body.children).filter((el) => !isWhole(el));
    if (stray.length) {
      throw new Error('不是卡片的直属子元素：' + stray.map((el) =>
        el.tagName.toLowerCase() + '.' + String(el.className || '').trim().split(/\s+/)[0]
      ).join(', '));
    }
  });

  // 2.6 模块自己声明的逻辑用例
  //     必须跑在「打字」「点按钮」**之前**：那两个检查会改工具的状态
  //     （benchmark-builder 会把输入的单位存进 localStorage），
  //     而用例断言的是「刚打开页面」时的行为。
  const logic = w.ItTools.logic[slug];
  if (logic && typeof logic.__cases === 'function') {
    collected = [];
    let thrown = null;
    try { logic.__cases(assertFn); } catch (e) { thrown = e.message; }
    const errs = collected.slice();
    collected = null;
    if (thrown) errs.push('抛出异常：' + thrown);
    if (errs.length) failures.push({ name: `${slug} · 逻辑用例`, error: errs.join('\n      ') });
    else pass++;
  }

  // 2.7 往输入框里打字不能把界面搞炸
  //     工具的输入处理器里直接抛异常的话，页面上就是「敲一个字整块工具白了」。
  //     jsdom 会把监听器里抛出的异常吞进 virtual console（不往外抛），
  //     所以 bootWindow 里挂了 console，异常都收在 w.__errors 里。
  check(`${slug} · 打字不炸`, () => {
    const body = w.document.getElementById('tool-body');
    const before = w.__errors.length;
    for (const el of Array.from(body.querySelectorAll('input,textarea'))) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['file', 'checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(type)) continue;
      if (el.readOnly) continue;
      el.value = '123';
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    for (const el of Array.from(body.querySelectorAll('select'))) {
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    if (w.__errors.length > before) {
      throw new Error(w.__errors.slice(before).map((e) => e.message).join('; '));
    }
  });

  // 2.7 每个按钮点一遍不能抛异常
  check(`${slug} · 点按钮不炸`, () => {
    const body = w.document.getElementById('tool-body');
    const before = w.__errors.length;
    for (const b of Array.from(body.querySelectorAll('button'))) {
      b.click();
    }
    if (w.__errors.length > before) {
      throw new Error(w.__errors.slice(before).map((e) => e.message).join('; '));
    }
  });

  // 3. 卸载不抛异常
  check(`${slug} · 卸载`, () => {
    w.ItTools.unmountAll();
  });

  // 3.5 中文语言包对得上
  //     用真实的 zh-CN.yml 另起一个窗口，把工具挂一遍：任何一条 t() 在语言包里
  //     找不到，就说明这条文案在中文界面里会悄悄退回英文。
  check(`${slug} · 中文语言包对得上`, () => {
    const w2 = bootWindow(slug, LIBS.get(slug) || []);
    w2.__IT_TOOLS_I18N__ = ZH;
    const misses = [];
    const origT = w2.ItTools.t;
    w2.ItTools.t = function (toolSlug) {
      const fn = origT(toolSlug);
      return function (key, fallback) {
        const value = fn(key, fallback);
        // 值跟英文兜底一样，可能是「语言包里的译文本来就一样」，
        // 也可能是「语言包里根本没这条」—— 用键在不在 bundle 里来区分。
        if (value === fallback && !(`tool.${toolSlug}.${key}` in ZH)) {
          misses.push(`${toolSlug}.${key}`);
        }
        return value;
      };
    };
    w2.eval(code);
    w2.ItTools.mountAll();
    windows.push({ slug, w: w2 });
    if (misses.length) throw new Error('语言包里缺：' + misses.join(', '));
  });
}

/* ---- 真实页面顺序下的挂载次数 ----
   上面那一轮是「手动调 mountAll()」，跟浏览器里的实际顺序不一样。真实的工具页是：

     app.js（解析途中加载，readyState 还是 loading，boot() 因此挂在
             DOMContentLoaded 上）→ 工具模块 → tool.html 末尾的内联
             window.ItTools.mountAll() → DOMContentLoaded → boot() → mountAll()

   也就是说 mountAll() 会被调两次，间隔一个 DOMContentLoaded。
   这里照着这个顺序走一遍，盯住 mount 只发生一次。

   用一个假工具而不是真工具：这件事是 app.js 的性质，与具体工具无关。 */
async function realPageOrderCheck() {
  const w = bootWindow('__mount_once__', []);
  let mounts = 0;
  const origRegister = w.ItTools.register;
  w.ItTools.register = function (slug, fn) {
    return origRegister.call(this, slug, function (root) { mounts++; return fn(root); });
  };
  w.eval(`window.ItTools.register('__mount_once__', function (root) {
    root.appendChild(root.ownerDocument.createElement('div'));
    return { destroy: function () { root.innerHTML = ''; } };
  });`);

  // tool.html 末尾的内联脚本
  w.ItTools.mountAll();
  if (mounts !== 1) throw new Error(`内联脚本之后 mount 了 ${mounts} 次，应当是 1 次`);

  // 等 DOMContentLoaded —— app.js 的 boot() 就在这一刻跑，里面还有一次 mountAll()
  await new Promise((resolve) => {
    if (w.document.readyState !== 'loading') resolve();
    else w.addEventListener('DOMContentLoaded', () => resolve());
  });
  // boot() 是 DOMContentLoaded 的同步回调，但队列里可能还排着别的监听器，
  // 让出一个宏任务，确保 boot() 里的 mountAll() 一定跑完了。
  await new Promise((resolve) => setTimeout(resolve, 0));

  if (mounts !== 1) {
    throw new Error(`整个页面加载过程中 mount 了 ${mounts} 次，应当只挂 1 次（mountAll() 被调了两次）`);
  }
}

/* ---- 迟到的异常 ----
   有些工具的输入是防抖的（停顿 200ms 之后才转），还有的走的是 fetch 回调 ——
   异常是在定时器/回调里抛的，上面那两条同步检查盯不到。
   等一拍，把所有窗口收过的异常再看一遍。 */
async function lateErrorSweep() {
  await new Promise((resolve) => setTimeout(resolve, 600));
  const bad = [];
  for (const { slug, w } of windows) {
    for (const e of w.__errors) {
      bad.push(`${slug}：${e.message}`);
    }
  }
  if (bad.length) throw new Error(bad.join('\n      '));
}

/* ---- 汇总 ---- */
function report() {
  const total = pass + failures.length;
  if (failures.length) {
    console.log('\x1b[31m失败\x1b[0m');
    for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.error}`);
    console.log(`\n${pass}/${total} 通过，${failures.length} 失败`);
    process.exit(1);
  } else {
    console.log(`\x1b[32m全部通过\x1b[0m  ${pass} 项检查，覆盖 ${files.length} 个工具模块`);
  }
}

realPageOrderCheck()
  .then(() => { pass++; })
  .catch((e) => { failures.push({ name: '页面加载顺序 · 只挂一次', error: e.message }); })
  .then(() => lateErrorSweep())
  .then(() => { pass++; })
  .catch((e) => { failures.push({ name: '迟到的异常（防抖 / 异步回调）', error: e.message }); })
  .then(report);