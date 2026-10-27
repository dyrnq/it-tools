/*
 * 侧栏分类折叠的冒烟测试。
 *
 * 守的是三个实测踩到的坑，都出在「看起来能点、其实点了没反应」这一类：
 *   1. 折叠状态是从 aria-expanded 推出来的，方向搞反就等于把当前状态又写回去 ——
 *      localStorage 照写，界面上纹丝不动；
 *   2. renderFavorites 里侧栏和首页各有一个 `var section`，var 是函数级的，
 *      后一个把前一个覆盖掉，侧栏的点击回调于是把 dataset.collapsed 写到
 *      首页那块节点上（工具页上则直接抛 null 异常）；
 *   3. boot() 每跑一遍就多挂一遍监听，两遍的话一次点击触发两个 handler，
 *      各自翻一次状态，等于没翻。
 *
 * 用法：node sidebar.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '../..');
const APP = fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'static/css/app.css'), 'utf8');
const { parseRules, ruleFor, overflowingWidth, fillsRow, mediaBeforeBase } = require('./lib/css');

const CATEGORIES = ['crypto', 'converter', 'web', 'network', 'text'];

/** 一个够用的侧栏骨架，结构照抄 templates/sidebar.html */
function page() {
  const groups = CATEGORIES.map(
    (id) => `
    <section class="nav-group" data-category="${id}">
      <button class="nav-group-head" type="button" aria-expanded="true">
        <span class="chev"></span><span class="nav-group-label">${id}</span>
      </button>
      <div class="nav-group-body">
        <button class="nav-toggle-bar" type="button"></button>
        <ul class="nav-list"><li><a class="nav-item" href="/x-${id}"><span class="nav-text">${id}</span></a></li></ul>
      </div>
    </section>`
  ).join('');
  return `<!DOCTYPE html><html><body>
    <button class="icon-btn" id="toggle-menu" type="button">menu</button>
    <div class="layout" id="layout">
      <aside class="sidebar" id="sidebar">
        <nav class="nav">
          <div id="favorites-group" hidden></div>
          ${groups}
        </nav>
      </aside>
      <div class="main"><main class="content">
        <section id="favorites-section" hidden><div class="tool-grid" id="favorites-grid"></div></section>
      </main></div>
    </div>
    <div class="scrim" id="scrim" hidden></div>
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
 * 起一个页面。store 是 localStorage 初值，registry 决定收藏组渲不渲染。
 * 注意这里【不】手工 dispatch DOMContentLoaded —— app.js 在 readyState 为
 * loading 时会自己挂监听，再补一发等于让 boot 跑两遍，那是测试自己造的坑。
 */
async function boot(store, registry, mobile) {
  const dom = new JSDOM(page(), { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  for (const [k, v] of Object.entries(store || {})) w.localStorage.setItem(k, v);
  w.fetch = registry
    ? () => Promise.resolve({ json: () => Promise.resolve(registry) })
    : () => new Promise(() => {});
  // jsdom 没有 matchMedia（initMenu 用它判断 700px 断点），补一个最简实现。
  // 默认 matches:false = 宽屏，和 jsdom 默认 1024px 窗口一致。
  //
  // 每条查询分开算：app.js 里除了 700px 断点，还有一条
  // '(prefers-color-scheme: dark)'（主题跟着系统走）。这里按查询串区分，
  // 深色那条恒为 false —— 测试只关心断点。
  const isMobileQuery = (q) => /max-width:\s*700px/.test(q);
  const listeners = [];
  w.matchMedia = (q) => ({
    media: q,
    // 必须是 getter：真实 MediaQueryList.matches 是实时的，快照会漏掉
    // 「窗口跨过断点后 matches 要跟着变」这件事
    get matches() { return isMobileQuery(q) ? !!mobile : false; },
    addEventListener: (t, fn) => t === 'change' && listeners.push({ fn, q }),
    removeEventListener() {},
  });
  // 模拟窗口跨过 700px 断点。
  // 真实浏览器会把 MediaQueryListEvent 传给监听器，这里也得给 ——
  // app.js 的主题监听器读的是 e.matches，给个 undefined 就直接抛异常了。
  w.__crossBreakpoint = (nowMobile) => {
    mobile = nowMobile;
    listeners.forEach(({ fn, q }) => fn({ matches: isMobileQuery(q) ? !!mobile : false }));
  };
  // jsdom 不会去取外链样式表，不塞进来的话 getComputedStyle 看不到折叠规则
  const style = w.document.createElement('style');
  style.textContent = CSS;
  w.document.head.appendChild(style);
  w.eval(APP);
  await new Promise((r) => setTimeout(r, 50));
  return w;
}

const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

/** 每个分类组的 [collapsed, ...] */
const states = (w) =>
  [...w.document.querySelectorAll('.nav-group[data-category]')].map((g) => g.dataset.collapsed);

/**
 * 折叠后的真实层叠结果：外层把 grid 行高收到 0fr，内层裁掉溢出。
 * 这正是 grid-template-rows: 1fr ↔ 0fr 那套写法要成立的全部条件，
 * 少一条（内层没 min-height:0，或者外面没 overflow:hidden）就收不干净。
 */
function collapseGeom(w, group) {
  const cs = (el, prop) => w.getComputedStyle(el).getPropertyValue(prop);
  const body = group.querySelector('.nav-group-body');
  const list = group.querySelector('.nav-list');
  return {
    rows: cs(body, 'grid-template-rows'),
    bodyDisplay: cs(body, 'display'),
    listMinHeight: cs(list, 'min-height'),
    listOverflow: cs(list, 'overflow'),
  };
}

/** 左侧竖线的可见度：收起时藏起来（0），展开时常态是 .12、悬停 .45 */
const railOpacity = (w, group) => w.getComputedStyle(group.querySelector('.nav-toggle-bar')).opacity;

(async () => {
  let w = await boot();
  let groups = [...w.document.querySelectorAll('.nav-group[data-category]')];
  let heads = groups.map((g) => g.querySelector('.nav-group-head'));
  let [g0, g1, g2] = groups;
  let [h0, , h2] = heads;

  console.log('--- 收起 / 展开 ---');
  ok('初始全部展开', states(w), groups.map(() => 'false'));

  click(w, h0);
  ok('点第 1 组 -> 只有它收起', states(w), ['true', 'false', 'false', 'false', 'false']);
  ok('aria-expanded 变 false', [h0.getAttribute('aria-expanded')], ['false']);
  ok(
    '收起后 grid 行高收到 0fr，内容被裁掉',
    collapseGeom(w, g0),
    { rows: '0fr', bodyDisplay: 'grid', listMinHeight: '0', listOverflow: 'hidden' }
  );
  ok('没被收的组仍是 1fr', collapseGeom(w, g1).rows, '1fr');

  click(w, h0);
  ok('再点 -> 恢复展开', [g0.dataset.collapsed], ['false']);
  ok('恢复成 1fr', collapseGeom(w, g0).rows, '1fr');

  console.log('--- 折叠动画（参考实现 CollapsibleToolMenu.vue 的 <n-collapse-transition>）---');
  // 纯 CSS 等效写法：grid-template-rows 过渡。用 .animating 门控，
  // 首屏按 localStorage 还原折叠状态时不该看到「啪」地一下收起来。
  click(w, h0);
  ok('用户点过之后挂上 animating', [g0.classList.contains('animating')], [true]);
  const withAnim = w.getComputedStyle(g0.querySelector('.nav-group-body')).transition;
  ok('此时才有过渡', [/\S/.test(withAnim) || 'grid-template-rows .22s ease'], [true]);
  click(w, h0);
  ok('再次收起仍然有过渡', [/\S/.test(w.getComputedStyle(g0.querySelector('.nav-group-body')).transition)], [true]);

  w = await boot({ collapsedNavGroups: JSON.stringify({ crypto: true }) });
  const restored = w.document.querySelector('.nav-group[data-category]');
  ok('从存档还原成收起', [restored.dataset.collapsed], ['true']);
  ok('还原时没挂 animating（不播动画）', [restored.classList.contains('animating')], [false]);
  ok('还原时也没有过渡', [/\S/.test(w.getComputedStyle(restored.querySelector('.nav-group-body')).transition)], [false]);

  console.log('--- 左侧 2px 竖线 ---');
  w = await boot();
  const railGroup = w.document.querySelector('.nav-group[data-category]');
  const bar = railGroup.querySelector('.nav-toggle-bar');
  ok('竖线挂在每个分类组里', [...w.document.querySelectorAll('.nav-group .nav-toggle-bar')].length, CATEGORIES.length);
  ok('展开时常态近乎不可见', [railOpacity(w, railGroup)], ['0.12']);
  ok('竖线绝对定位，不占布局宽度（工具名不会被挤走）', [w.getComputedStyle(bar).position], ['absolute']);
  click(w, bar);
  ok('点竖线 -> 收起', [railGroup.dataset.collapsed], ['true']);
  ok('收起时竖线藏起来', [railOpacity(w, railGroup)], ['0']);
  ok('竖线点击也存了档', JSON.parse(w.localStorage.getItem('collapsedNavGroups')), { crypto: true });
  click(w, bar);
  ok('再点竖线 -> 展开', [railGroup.dataset.collapsed], ['false']);

  console.log('--- 竖线不能变成折叠动画的第二个 grid item ---');
  // 绝对定位的元素是脱流的，不参与网格布局，所以 grid 里只剩 nav-list 一个 item。
  // 一旦把它改成 relative/static，0fr 就同时作用到两个 item 上，折叠会「顿一下」。
  const itemsOf = (group) =>
    [...group.querySelector('.nav-group-body').children].filter(
      (el) => w.getComputedStyle(el).position !== 'absolute'
    );
  ok('grid 里只剩 nav-list 一个 item', itemsOf(railGroup).map((el) => el.className), ['nav-list']);

  w = await boot();
  groups = [...w.document.querySelectorAll('.nav-group[data-category]')];
  heads = groups.map((g) => g.querySelector('.nav-group-head'));
  [g0, g1, g2] = groups;
  [h0, , h2] = heads;
  ok(
    '服务端渲染的分组结构齐全：body 包住竖线和列表',
    [...groups].every((g) => {
      const body = g.querySelector('.nav-group-body');
      return (
        body &&
        body.firstElementChild.classList.contains('nav-toggle-bar') &&
        body.querySelector(':scope > .nav-list')
      );
    }),
    true
  );

  console.log('--- 各组互不影响 ---');
  click(w, h0);
  click(w, h2);
  ok('第 1、3 组收起，第 2 组仍展开', [g0.dataset.collapsed, g1.dataset.collapsed, g2.dataset.collapsed], ['true', 'false', 'true']);

  console.log('--- 刷新后状态还在 ---');
  const saved = w.localStorage.getItem('collapsedNavGroups');
  // 按下标取名字，别把分类名写死在断言里 —— CATEGORIES 一改断言就该跟着走
  const [C0, , C2] = CATEGORIES;
  ok('localStorage 存的是「收起」态', JSON.parse(saved), { [C0]: true, [C2]: true });
  w = await boot({ collapsedNavGroups: saved });
  groups = [...w.document.querySelectorAll('.nav-group[data-category]')];
  ok('重开后第 1、3 组仍收起', [groups[0].dataset.collapsed, groups[2].dataset.collapsed], ['true', 'true']);
  ok('重开后没存过的组仍展开', [groups[1].dataset.collapsed], ['false']);

  console.log('--- 收藏组（走真实的 renderFavorites）---');
  const favPaths = ['/hash-text', '/qrcode-generator'];
  w = await boot(
    {
      collapsedNavGroups: JSON.stringify({ favorites: true }),
      favoriteToolsName: JSON.stringify(favPaths)
    },
    { tools: favPaths.map((p) => ({ path: p, name: p, icon: 'tool' })) }
  );
  const fav = w.document.querySelector('[data-category="favorites"]');
  ok('收藏组渲染出来了', !!fav, true);
  const fh = fav.querySelector('.nav-group-head');
  ok('按存档渲染为收起', [fav.dataset.collapsed, fh.getAttribute('aria-expanded')], ['true', 'false']);
  click(w, fh);
  // 侧栏那一组和首页那一组同名，var 一旦撞车，写回就落到首页节点上去了
  ok('点一下展开', [fav.dataset.collapsed], ['false']);
  ok('没有误写到首页收藏区', w.document.getElementById('favorites-section').hasAttribute('data-collapsed'), false);
  click(w, fh);
  ok('再点收起', [fav.dataset.collapsed], ['true']);

  // 收藏组是 renderFavorites 在 boot 之后插进来的，竖线不是模板渲染的，
  // 结构得跟服务端那边一模一样（少一层 body 就没有折叠动画）
  const favBody = fav.querySelector('.nav-group-body');
  ok('收藏组也包了一层 body', !!favBody, true);
  ok('收藏组的 body 里就是竖线 + 列表', [[...favBody.children].map((c) => c.className)], [['nav-toggle-bar', 'nav-list']]);
  const fbar = fav.querySelector('.nav-toggle-bar');
  ok('收藏组的竖线有 tooltip', [!!fbar.title, !!fbar.getAttribute('aria-label')], [true, true]);
  ok('此时收藏组是收起的（上面两次点头的结果）', [fav.dataset.collapsed], ['true']);
  click(w, fbar);
  ok('点竖线 -> 展开', [fav.dataset.collapsed], ['false']);
  click(w, fbar);
  ok('再点 -> 收起', [fav.dataset.collapsed], ['true']);
  ok('竖线点击没误写到首页收藏区', w.document.getElementById('favorites-section').hasAttribute('data-collapsed'), false);

  console.log('--- 无存档时收藏组默认展开 ---');
  w = await boot({ favoriteToolsName: JSON.stringify(favPaths) }, { tools: favPaths.map((p) => ({ path: p, name: p, icon: 'tool' })) });
  ok('默认展开', [w.document.querySelector('[data-category="favorites"]').dataset.collapsed], ['false']);

  console.log('--- boot 跑两遍也不会翻倍挂监听 ---');
  w = await boot();
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  const r0 = w.document.querySelector('.nav-group[data-category]');
  const rh = r0.querySelector('.nav-group-head');
  // 一次点击触发两个 handler 的话，各自翻一次状态 = 没翻
  click(w, rh);
  ok('重复 boot 后点一下仍然只翻一次', [r0.dataset.collapsed], ['true']);
  click(w, rh);
  ok('再点翻回展开', [r0.dataset.collapsed], ['false']);

  /* ---------- 侧栏展开 / 收起 ----------
     对应参考实现 MenuLayout.vue：宽屏 collapse-mode="width" :collapsed-width="0"，
     小屏 absolute 位移 + 遮罩（v-show="isSmallScreen && !isMenuCollapsed"）。

     钉的是一个实测 bug：早先 setOpen 无条件 scrim.hidden = !open，
     宽屏点一下就给整页糊一层 rgba(0,0,0,.5)，而侧栏在宽屏根本不动。 */

  const state = (w) => {
    const l = w.document.getElementById('layout');
    const sc = w.document.getElementById('scrim');
    return { open: l.dataset.menuOpen, scrim: !sc.hidden };
  };

  console.log('--- 宽屏（>700px）---');
  let m = await boot();
  ok('默认展开', [state(m).open], ['true']);
  ok('默认没有遮罩', [state(m).scrim], [false]);

  click(m, m.document.getElementById('toggle-menu'));
  ok('点一下 -> 收起', [state(m).open], ['false']);
  ok('收起时也没有遮罩（宽屏不该糊屏）', [state(m).scrim], [false]);

  click(m, m.document.getElementById('toggle-menu'));
  ok('再点 -> 展开', [state(m).open], ['true']);
  ok('展开仍无遮罩', [state(m).scrim], [false]);

  console.log('--- 小屏（<=700px）---');
  m = await boot({}, null, true);
  ok('无存档时默认收起', [state(m).open], ['false']);
  click(m, m.document.getElementById('toggle-menu'));
  ok('点一下 -> 滑出', [state(m).open], ['true']);
  ok('这时才有遮罩', [state(m).scrim], [true]);
  click(m, m.document.getElementById('scrim'));
  ok('点遮罩 -> 收起', [state(m).open], ['false']);
  click(m, m.document.getElementById('toggle-menu'));
  m.document.dispatchEvent(new m.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok('Esc -> 收起', [state(m).open], ['false']);
  ok('收起后遮罩跟着消失', [state(m).scrim], [false]);

  console.log('--- 状态存档（键名/语义对齐参考实现的 useStorage(\'isMenuCollapsed\')）---');
  m = await boot();
  click(m, m.document.getElementById('toggle-menu'));
  ok('存的是「收起」', [m.localStorage.getItem('isMenuCollapsed')], ['true']);
  click(m, m.document.getElementById('toggle-menu'));
  ok('存的是「展开」', [m.localStorage.getItem('isMenuCollapsed')], ['false']);
  let m2 = await boot({ isMenuCollapsed: 'true' });
  ok('刷新后按存档收起', [state(m2).open], ['false']);
  let m3 = await boot({ isMenuCollapsed: 'false' }, null, true);
  ok('存档的「展开」压过小屏默认值', [state(m3).open], ['true']);

  console.log('--- 跨断点时状态跟着断点走 ---');
  m = await boot();
  m.__crossBreakpoint(true);
  ok('宽 -> 窄：自动收起', [state(m).open], ['false']);
  ok('窄屏下收起才带遮罩的另一半（此时不该有）', [state(m).scrim], [false]);
  m.__crossBreakpoint(false);
  ok('窄 -> 宽：自动展开', [state(m).open], ['true']);
  m2 = await boot({}, null, true);
  m2.__crossBreakpoint(false);
  ok('小屏下先展开，再拉宽仍展开', [state(m2).open], ['true']);

  console.log('--- 分类标题要撑满整行，但不许把侧栏顶出横向滚动条 ---');
  // 分类头是 <button>：表单控件的 width:auto 会收缩到内容宽度，
  // 「加密」只有 58px、「转换器」89px，而侧栏有 239px —— 右边一大片空白点不动。
  // 参考实现那边用的是块级 div，整行都是折叠入口。我们要整行都能点，
  // 就得显式把宽度写出来。
  //
  // 但宽度不是随便写的：早先写过 width:100% 又写 margin-left:6px，
  // 块级元素的可用宽度本来就把 margin 算进去了，再叠一句 100% 就正好多出 6px ——
  // 侧栏 clientWidth 239 / scrollWidth 245，每个页面、任何宽度都中招。
  // 现在是 width:calc(100% - 6px) + margin-left:6px，两者正好抵掉。
  //
  // 这条只能按规则文本钉：jsdom 不做布局，量不出 scrollWidth。
  // 但浏览器里是量得出来的，所以这条断言的价值在于「写坏之前就被挡住」。
  const head = ruleFor(parseRules(CSS), '.nav-group-head');
  ok('还有 .nav-group-head 这条规则', !!head, true);
  ok('.nav-group-head 正好占满整行（分类名右边的空白也能点）', fillsRow(head), true);
  ok('全站没有「宽度 + 左右边距撑出父容器」的规则', overflowingWidth(CSS), []);
  // 媒体查询里的覆盖必须排在基础规则之后。媒体查询不提升优先级，
  // 排反了就是一段永远不生效的死 CSS —— 而从文本上完全看不出问题。
  // 这个坑已经踩了两次（.field-row、.switch 的窄屏覆盖），
  // 都是量宽度才发现「规则写了却没生效」。
  ok('媒体查询的覆盖都排在基础规则之后', mediaBeforeBase(CSS), []);

  console.log(failures ? `\n${failures} 项不符` : '\n全部符合预期');
  process.exit(failures ? 1 : 0);
})();