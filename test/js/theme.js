/*
 * 深/浅色主题切换的冒烟测试。
 *
 * 守的是一个实测出来的 bug：深色模式下月亮和太阳两个图标同时显示，
 * 把 34px 的圆按钮挤成 44px（横向溢出到按钮外面）。
 *
 * 根因在 CSS 的写法而不是 JS：早先 app.css 里只写了四条「显示哪个」的规则，
 * 漏了「深色下藏太阳」那一条，而 .theme-icon-sun 又没有基础规则 ——
 * 于是深色下太阳落到 span 默认的 display:block，和月亮一起显示。
 *
 * 「漏写一条规则 = 多出一个图标」这种失效模式，靠肉眼看 diff 很难保证不再犯，
 * 所以这里把「任一主题下有且只有一个图标可见」钉成断言。
 * jsdom 的 getComputedStyle 能正确处理 :root[data-theme='...'] 的层叠，
 * 所以断言的是真层叠结果，不是把 CSS 抄一遍。
 *
 * 顺带钉住图标方向：浅色显月亮（点它切到深色），深色显太阳（点它切回浅色），
 * 与参考实现 NavbarButtons.vue 一致。
 *
 * 用法：node theme.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { parseRules, ruleFor, ruleBySuffix } = require('./lib/css');

const ROOT = path.join(__dirname, '../..');
const APP = fs.readFileSync(path.join(ROOT, 'static/js/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'static/css/app.css'), 'utf8');

/** 一个够用的页面骨架，结构照抄 templates/navbar.html + base.html */
function page() {
  return `<!DOCTYPE html><html data-theme="light"><body>
    <header class="navbar">
      <div class="nav-left">
        <button class="icon-btn" id="toggle-menu" type="button">menu</button>
      </div>
      <div class="nav-right">
        <button class="icon-btn theme-toggle" id="toggle-theme" type="button" title="Dark mode" aria-label="Dark mode">
          <span class="theme-icon-moon"><svg></svg></span>
          <span class="theme-icon-sun"><svg></svg></span>
        </button>
      </div>
    </header>
    <div class="layout" id="layout">
      <aside class="sidebar" id="sidebar"><nav class="nav"></nav></aside>
      <div class="main"><main class="content" id="main-content"></main></div>
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
 * 起一个页面，把 app.css 塞进 <style>（jsdom 不会去取外链样式表），
 * 再跑 app.js。
 */
async function boot(theme, i18n) {
  const dom = new JSDOM(page(), { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.__IT_TOOLS_I18N__ = Object.assign(
    { dark_mode: 'Dark mode', light_mode: 'Light mode' },
    i18n || {}
  );
  w.fetch = () => new Promise(() => {});
  w.matchMedia = (q) => ({
    media: q,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  const style = w.document.createElement('style');
  style.textContent = CSS;
  w.document.head.appendChild(style);
  w.document.documentElement.dataset.theme = theme;
  w.eval(APP);
  await new Promise((r) => setTimeout(r, 50));
  return w;
}

const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

/** 图标是否可见。computed display 为空串 = 没有规则命中 = 按默认可见（span 默认 inline）。 */
const isVisible = (w, el) => w.getComputedStyle(el).display !== 'none';

/** 主题按钮里可见的图标：'moon' / 'sun' / null（一个都没有）/ 'both'（两个都有，就是那个 bug） */
function visibleIcons(w) {
  const btn = w.document.getElementById('toggle-theme');
  const moon = isVisible(w, btn.querySelector('.theme-icon-moon'));
  const sun = isVisible(w, btn.querySelector('.theme-icon-sun'));
  if (moon && sun) return 'both';
  if (moon) return 'moon';
  if (sun) return 'sun';
  return null;
}

/**
 * 拆 CSS 规则：见 ./lib/css.js（与 sidebar.js 共用同一份，免得两边抄歪）。
 */

(async () => {
  console.log('--- CSS 层叠：任一主题下有且只有一个图标可见 ---');
  let w = await boot('light');
  ok('浅色下可见的是月亮（点它切到深色）', visibleIcons(w), 'moon');

  w = await boot('dark');
  ok('深色下可见的是太阳（点它切回浅色）', visibleIcons(w), 'sun');

  console.log('--- CSS 结构：两个图标先一律藏起来 ---');
  // 「先全藏、再放一个」是让「漏写一条就多出一个图标」不可能再犯的结构保证。
  // 只靠「显示谁」的规则驱动时，漏掉一条 = 另一个图标同时可见。
  const rules = parseRules(CSS);
  const baseRule = rules.find(
    (r) =>
      r.selectors.some((s) => s === '.theme-icon-moon') &&
      r.selectors.some((s) => s === '.theme-icon-sun')
  );
  ok('有一条规则同时提到两个图标', !!baseRule, true);
  ok('那条规则把两个图标都藏起来', baseRule && /display:\s*none/.test(baseRule.body), true);

  console.log('--- 点按钮：主题、存档、图标、tooltip 一起变 ---');
  w = await boot('light');
  const btn = w.document.getElementById('toggle-theme');
  ok('初始 tooltip 说切到深色', [btn.title, btn.getAttribute('aria-label')], ['Dark mode', 'Dark mode']);
  ok('初始 data-theme', [w.document.documentElement.dataset.theme], ['light']);
  ok('初始可见图标', visibleIcons(w), 'moon');

  click(w, btn);
  ok('点一下 -> 深色', [w.document.documentElement.dataset.theme], ['dark']);
  ok('localStorage 记下深色', [w.localStorage.getItem('theme')], ['dark']);
  ok('图标换成太阳', visibleIcons(w), 'sun');
  ok('tooltip 改成切回浅色', [btn.title, btn.getAttribute('aria-label')], ['Light mode', 'Light mode']);

  click(w, btn);
  ok('再点 -> 浅色', [w.document.documentElement.dataset.theme], ['light']);
  ok('localStorage 记下浅色', [w.localStorage.getItem('theme')], ['light']);
  ok('图标换回月亮', visibleIcons(w), 'moon');
  ok('tooltip 回到切到深色', [btn.title], ['Dark mode']);

  console.log('--- tooltip 走客户端语言包 ---');
  w = await boot('dark', { dark_mode: '深色模式', light_mode: '浅色模式' });
  ok('深色下用中文文案', [w.document.getElementById('toggle-theme').title], ['浅色模式']);

  console.log('--- 刷新后按存档恢复 ---');
  w = await boot('light');
  click(w, w.document.getElementById('toggle-theme'));
  const saved = w.localStorage.getItem('theme');
  w = await boot('light');
  w.localStorage.setItem('theme', saved);
  // 重开页面时 base.html 的内联脚本把存档写回 data-theme，这里补上那一步
  w.document.documentElement.dataset.theme = w.localStorage.getItem('theme');
  ok('存档是 dark', [saved], ['dark']);
  ok('恢复后可见的是太阳', visibleIcons(w), 'sun');

  console.log('--- 开关（.switch）：暗色下轨道不能是透明的 ---');
  // 轨道曾经写成 background: var(--border-sider)，而深色主题里 --border-sider 是
  // transparent —— 于是深色下轨道整个消失，只剩一个悬空的白圆点（滑块还是
  // position:absolute 而 .switch 没有定位基准，跑到远处去了）。全站 20 多个工具
  // 共用这一个类，所以一处写错就是满屏的坏开关。
  w = await boot('dark');
  const trackDark = w.getComputedStyle(w.document.documentElement).getPropertyValue('--switch-track').trim();
  ok('深色下轨道有颜色', [trackDark !== '', trackDark !== 'transparent', trackDark !== 'rgba(0, 0, 0, 0)'], [true, true, true]);
  w = await boot('light');
  const trackLight = w.getComputedStyle(w.document.documentElement).getPropertyValue('--switch-track').trim();
  ok('浅色下轨道有颜色', [trackLight !== '', trackLight !== 'transparent'], [true, true]);
  ok('两套主题给了不同的轨道色（不是同一个 transparent 蒙混过关）', trackLight !== trackDark, true);

  // jsdom 不实现伪元素的 getComputedStyle，只能按规则文本断言：
  // 轨道不许再引用 --border-sider，滑块所在的 span 必须是定位基准。
  const swRules = parseRules(CSS);
  const trackRule = ruleBySuffix(swRules, '.switch span::before');
  ok('轨道规则还在', !!trackRule, true);
  ok(
    '轨道用的是 --switch-track，不是 --border-sider',
    /background:[^;]*--switch-track/.test(trackRule.body) &&
      !/--border-sider/.test(trackRule.body),
    true
  );
  const spanRule = ruleFor(swRules, '.switch span');
  ok('滑块的定位基准 span 有 position', spanRule && /position:\s*relative/.test(spanRule.body), true);
  const knobRule = ruleBySuffix(swRules, '.switch span::after');
  ok('滑块仍是绝对定位（叠在轨道上）', knobRule && /position:\s*absolute/.test(knobRule.body), true);
  ok('滑块开了态的位移还带着纵向居中', /translateY\(-50%\)\s*translateX/.test(
    (ruleBySuffix(swRules, '.switch input:checked + span::after') || { body: '' }).body
  ), true);

  console.log(failures ? `\n${failures} 项不符` : '\n全部符合预期');
  process.exit(failures ? 1 : 0);
})();
