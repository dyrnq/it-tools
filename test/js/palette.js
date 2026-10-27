/*
 * 命令面板（Ctrl/Cmd+K）的冒烟测试。
 *
 * 守的是一个实测出来的 bug：**面板里点工具条目什么也不会发生** ——
 * 面板「啪」地关掉，地址栏纹丝不动，控制台报
 * `TypeError: f.entry.run is not a function`。
 *
 * 根因是字段名对不上：服务端给的条目长这样
 *   { path: "/hash-text", name: "Hash text", ... }   （src/handlers/view.rs 的 SearchEntry）
 * 而 app.js 判的是 `item.href` —— 于是每个工具条目都被当成「动作条目」，
 * 渲染成 <button>，点下去调一个根本不存在的 run()，于是抛异常、什么也没做。
 *
 * 这类失效在页面上**看不出来**：面板照常打开、结果照常列出来，
 * 只是点下去没反应。所以这里把「条目必须是能跳的 <a href>」与
 * 「点击不许抛异常」都钉成断言。
 *
 * 用法：node palette.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8');

/** 服务端给的条目 —— 字段名是 path，不是 href（见 src/handlers/view.rs）。 */
const ENTRIES = [
  {
    category: 'crypto',
    description: 'Hash a text string.',
    icon: 'eye-off',
    keywords: ['hash', 'digest'],
    name: 'Hash text',
    path: '/hash-text',
  },
  {
    category: 'crypto',
    description: 'Generate random UUIDs.',
    icon: 'fingerprint',
    keywords: ['uuid', 'guid'],
    name: 'UUIDs generator',
    path: '/uuid-generator',
  },
];

/** 面板的骨架 —— 结构照抄 templates/command_palette.html */
function page() {
  return `<!DOCTYPE html><html data-theme="light"><body>
    <div class="layout" id="layout">
      <div class="main"><main class="content" id="main-content"></main></div>
    </div>
    <button id="search-trigger" type="button">search</button>
    <div class="palette" id="palette" hidden>
      <div class="palette-panel">
        <input class="palette-input" id="palette-input" type="text">
        <div class="palette-results" id="palette-results"></div>
        <div class="palette-empty" id="palette-empty" hidden></div>
      </div>
    </div>
    <script id="palette-data" type="application/json">${JSON.stringify(ENTRIES)}</script>
    <script id="palette-i18n" type="application/json">${JSON.stringify({
      tools: 'Tools',
      actions: 'Actions',
      random_tool: 'Random tool',
      toggle_theme: 'Toggle dark mode',
      about: 'About',
      home: 'Home',
    })}</script>
  </body></html>`;
}

let failures = 0;
function ok(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(
    pass ? '  ok  ' : '  FAIL',
    label,
    '=>',
    JSON.stringify(actual),
    pass ? '' : '   期望 ' + JSON.stringify(expected)
  );
}

/**
 * 起一个页面并跑 app.js。
 * 返回 { w, errors } —— errors 是监听器里抛出来的异常。
 */
async function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    // jsdom 自己「没实现」的提示不算错（点 <a> 触发的跳转、window.open 等）
    if (/Not implemented/i.test(e.message)) return;
    errors.push(e.message || String(e));
  });

  const dom = new JSDOM(page(), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
    virtualConsole: vc,
  });
  const w = dom.window;
  // app.js 的 boot() 会去取工具索引（首页收藏区用），测试里不需要
  w.fetch = () => new Promise(() => {});
  w.matchMedia = (q) => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {} });
  // jsdom 没实现 scrollIntoView（面板选中项要滚进视野），补一个最简实现
  w.Element.prototype.scrollIntoView = function () {};
  w.eval(APP);
  await new Promise((r) => setTimeout(r, 50));
  return { w, errors };
}

const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

/** 打开面板并输入关键词 */
async function search(w, q) {
  w.document.getElementById('search-trigger').click();
  await new Promise((r) => setTimeout(r, 20));
  const input = w.document.getElementById('palette-input');
  input.value = q;
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
}

const items = (w) => [...w.document.querySelectorAll('#palette-results .palette-item')];
const byName = (w, name) =>
  items(w).find((el) => el.querySelector('.palette-item-name').textContent === name);

(async () => {
  console.log('--- 条目渲染：工具条目是能跳的 <a href> ---');
  {
    const { w } = await boot();
    await search(w, '');
    const tool = byName(w, 'Hash text');
    ok('工具条目的标签', tool && tool.tagName, 'A');
    ok('工具条目的链接', tool && tool.getAttribute('href'), '/hash-text');
    ok('动作条目是按钮（没有 path 的那些）', byName(w, 'Random tool').tagName, 'BUTTON');
    ok('有 path 的动作条目仍是链接', byName(w, 'About').getAttribute('href'), '/about');
  }

  console.log('--- 点工具条目：不抛异常，面板关掉 ---');
  {
    const { w, errors } = await boot();
    await search(w, 'hash');
    const tool = byName(w, 'Hash text');
    click(w, tool);
    await new Promise((r) => setTimeout(r, 20));
    ok('点击没有抛异常', errors, []);
    ok('面板关掉了', w.document.getElementById('palette').hidden, true);
  }

  console.log('--- 回车：跟点击走同一条路，也不许抛异常 ---');
  {
    const { w, errors } = await boot();
    await search(w, 'hash');
    // 选中第一条（update() 之后 selected = 0）
    const input = w.document.getElementById('palette-input');
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    ok('回车没有抛异常', errors, []);
    ok('面板关掉了', w.document.getElementById('palette').hidden, true);
  }

  console.log('--- 动作条目：切主题还是能用的 ---');
  {
    const { w, errors } = await boot();
    await search(w, 'toggle');
    const btn = byName(w, 'Toggle dark mode');
    ok('找得到切主题的条目', !!btn, true);
    click(w, btn);
    await new Promise((r) => setTimeout(r, 20));
    ok('主题切成了深色', w.document.documentElement.dataset.theme, 'dark');
    ok('没有抛异常', errors, []);
  }

  console.log(failures ? `\n有 ${failures} 条没通过` : '\n全部符合预期');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
