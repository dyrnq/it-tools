/*
 * 测试用的 CSS 解析小工具。
 *
 * 为什么单独一个文件：theme.js 和 sidebar.js 都要「按规则文本」断言，
 * 两边各抄一份 parseRules，抄歪一边就是两个测试说两套话。
 * 这里只解析一层花括号 —— 本项目的 CSS 里没有嵌套规则，够用。
 *
 * 之所以要按文本断言而不是靠布局：jsdom 不做布局，getComputedStyle 返回的
 * 宽高全是 0，而且它**不实现伪元素的 getComputedStyle**（会打印
 * "Not implemented" 并返回垃圾值）。所以「深色下轨道不是透明的」
 * 「滑块有定位基准」这类只能读规则文本。
 */

/**
 * 拆 CSS 规则：返回 [{ selectors: [...], body: '...' }]。
 * 注释要先剥掉 —— 否则注释会粘在下一条规则的选择器前面，选择器再也对不上。
 */
function parseRules(css) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let m;
  while ((m = re.exec(bare)) !== null) {
    rules.push({
      selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean),
      body: m[2],
    });
  }
  return rules;
}

/** 读某条规则里一个声明的值，没写就返回 null。 */
function decl(rule, prop) {
  const m = rule.body.match(new RegExp('(^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i'));
  return m ? m[2].trim() : null;
}

/** 按规则选择器精确找出第一条规则。 */
function ruleFor(rules, selector) {
  return rules.find((r) => r.selectors.some((s) => s === selector)) || null;
}

/** 按选择器后缀找（用来抓 `.x span::after` 这类复合选择器的最后一段）。 */
function ruleBySuffix(rules, suffix) {
  return rules.find((r) => r.selectors.some((s) => s.endsWith(suffix))) || null;
}

/**
 * 取 `margin` / `margin-left` / `margin-right` 里的**左右**值，
 * 简写按 CSS 的 1/2/3/4 值规则拆开。
 * 返回 [[来源, 值], ...]，没写就是空数组。
 */
function horizontalMargins(rule) {
  const out = [];
  for (const prop of ['margin-left', 'margin-right']) {
    const v = decl(rule, prop);
    if (v !== null) out.push([prop, v]);
  }
  const sh = decl(rule, 'margin');
  if (sh !== null) {
    const v = sh.split(/\s+/);
    // 简写的四值形式是 T R B L，左右分别取第 4、第 2 项；1/2/3 值形式左右都落在第 2 项
    const [left, right] = v.length === 4 ? [v[3], v[1]] : [v[Math.min(1, v.length - 1)], v[Math.min(1, v.length - 1)]];
    out.push(['margin(简写) 左', left], ['margin(简写) 右', right]);
  }
  return out;
}

/** 一个外边距值会不会把盒子往外顶？auto 和 0 都不会。 */
function pushesOutward(value) {
  const v = value.trim();
  if (v === 'auto' || v === 'inherit' || v === 'initial' || v === 'unset') return false;
  if (/^[+-]?0(?:\.0+)?(px|rem|em|%|pt)?$/.test(v)) return false;
  return true;
}

/**
 * 找出「`width:100%` 又带一个非零左右外边距」的规则。
 *
 * 这正是侧栏那条横向滚动条的成因：块级元素的 auto 宽度本来就把 margin
 * 算进可用宽度，再叠一句 width:100% 就正好多出一个 margin 的宽度，
 * 于是父容器 scrollWidth > clientWidth。
 *
 * 只盯 width:100%（而不是所有 width）：100% 明确等于「父内容宽度」，
 * 配上任何非零边距必然溢出；而 `.brand-divider{width:50px;margin:6px}`
 * 这种定宽装饰条撑的是自己那一行，不会把父容器顶出滚动条。
 *
 * @deprecated 用 overflowingWidth 代替 —— 它连 calc(100% - 6px) 这类
 *   「刚好抵掉外边距」的写法一起算，比这条更准。
 */
function width100WithSideMargin(css) {
  const out = [];
  for (const r of parseRules(css)) {
    if (decl(r, 'width') !== '100%') continue;
    for (const [prop, value] of horizontalMargins(r)) {
      if (!pushesOutward(value)) continue;
      out.push(`${r.selectors.join(', ')} { width:100%; ${prop}:${value} }`);
    }
  }
  return out;
}

/**
 * 把一个宽度值换算成「父内容宽度的百分之多少 + 固定 px 偏移」。
 *
 *   '100%'                -> { pct: 100, px:  0 }
 *   'calc(100% - 6px)'    -> { pct: 100, px: -6 }
 *   'calc(100% + 6px)'    -> { pct: 100, px: +6 }
 *   '50%'                 -> { pct:  50, px:  0 }
 *
 * 认不出来（auto / fit-content / 定宽 px）就返回 null —— 定宽跟父宽无从比较，
 * 而且 `.brand-divider{width:50px}` 这种装饰条本来也撑不出滚动条。
 */
function widthFraction(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v || /^(auto|fit-content|max-content|min-content|inherit|initial|unset)$/i.test(v)) return null;
  const calc = v.match(/^calc\(([^()]*)\)$/i);
  const inner = calc ? calc[1] : v;
  if (!/%/.test(inner)) return null;            // 定宽：没有百分比就比不了
  let pct = 0, px = 0, seen = false;
  const re = /([+-]?)\s*(\d*\.?\d+)\s*(%|px)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    seen = true;
    const sign = m[1] === '-' ? -1 : 1;
    const num = parseFloat(m[2]);
    if (m[3] === '%') pct += sign * num;
    else px += sign * num;
  }
  return seen ? { pct, px } : null;
}

/**
 * 左右外边距各是多少。优先用长写（margin-left/margin-right），
 * 没有再用 margin 简写拆出来（简写按 CSS 的 1/2/3/4 值规则拆）。
 *
 * 返回 [左, 右]，每项是字符串或 null（没写）。
 */
function sideMargins(rule) {
  const ml = decl(rule, 'margin-left');
  const mr = decl(rule, 'margin-right');
  const sh = decl(rule, 'margin');
  if (sh === null) return [ml, mr];
  const v = sh.trim().split(/\s+/);
  let left, right;
  if (v.length === 1) { left = right = v[0]; }
  else if (v.length === 2) { left = right = v[1]; }
  else if (v.length === 3) { left = right = v[1]; }
  else { left = v[3]; right = v[1]; }
  return [ml !== null ? ml : left, mr !== null ? mr : right];
}

/**
 * 外边距值换算成 { pct, px }。auto 视作 0（不撑）。
 * rem/em 没法跟基于 px 的父宽比较，返回 null 表示「这条比不了」。
 */
function marginFraction(value) {
  if (value === null || value === undefined) return { pct: 0, px: 0 };
  const v = String(value).trim();
  if (/^(auto|inherit|initial|unset)$/i.test(v)) return { pct: 0, px: 0 };
  if (/^[+-]?0(?:\.0+)?(px|rem|em|%|pt)?$/.test(v)) return { pct: 0, px: 0 };
  if (/rem|em|pt/i.test(v)) return null;        // 跟 px 父宽不是一个量纲
  const calc = v.match(/^calc\(([^()]*)\)$/i);
  const inner = calc ? calc[1] : v;
  let pct = 0, px = 0, seen = false;
  const re = /([+-]?)\s*(\d*\.?\d+)\s*(%|px)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    seen = true;
    const sign = m[1] === '-' ? -1 : 1;
    const num = parseFloat(m[2]);
    if (m[3] === '%') pct += sign * num;
    else px += sign * num;
  }
  return seen ? { pct, px } : null;
}

/**
 * 找出「盒子横向撑出父容器」的规则：宽度 + 左右外边距 > 父内容宽度。
 *
 * 父内容宽度记作 P（100%）。规则的实际占位是
 *   width + margin-left + margin-right
 * 超过 P 就意味着父容器 scrollWidth > clientWidth —— 侧栏那条横向滚动条。
 *
 * 早先只认 `width:100%`（配任何非零边距必溢出）。后来侧栏分类头为了
 * 「整行都能点」改成了 `width: calc(100% - 6px)` + `margin-left: 6px` ——
 * 两者正好抵掉，占位仍是 100%，不溢出。所以这里按「百分比宽度 + 外边距」
 * 统一算账，而不是只盯某一种写法。
 *
 * 返回 ['.foo { width:...; 左右外边距合计 ... }', ...]。
 */
function overflowingWidth(css) {
  const out = [];
  for (const r of parseRules(css)) {
    const w = widthFraction(decl(r, 'width'));
    if (!w) continue;
    let pct = w.pct, px = w.px, comparable = true;
    for (const side of sideMargins(r)) {
      const m = marginFraction(side);
      if (!m) { comparable = false; break; }
      pct += m.pct; px += m.px;
    }
    if (!comparable) continue;
    if (pct > 100 || (pct === 100 && px > 0)) {
      out.push(`${r.selectors.join(', ')} { width:${decl(r, 'width')}; 左右外边距合计 ${pct}% / ${px}px }`);
    }
  }
  return out;
}

/**
 * 这条规则的盒子是不是**刚好**占满父容器的内容宽度。
 *
 * 占满 = 百分比部分正好 100%，且固定 px 部分被外边距抵平。
 * `.nav-group-head { width: calc(100% - 6px); margin-left: 6px }` 就是
 * 占满：6px 的缩进照样在，右边那一片空白也在可点范围内。
 */
function fillsRow(rule) {
  if (!rule) return false;
  const w = widthFraction(decl(rule, 'width'));
  if (!w) return false;
  let pct = w.pct, px = w.px;
  for (const side of sideMargins(rule)) {
    const m = marginFraction(side);
    if (!m) return false;
    pct += m.pct; px += m.px;
  }
  return pct === 100 && px === 0;
}

/**
 * 找出「媒体查询里的覆盖规则，排在它要覆盖的基础规则前面」的写法。
 *
 * 媒体查询不提升优先级：@media(max-width:700px){ .switch{...} } 和后面的
 * .switch{...} 同为 (0,1,0)，同优先级按源码顺序决胜 —— 后面的基础规则会赢，
 * 媒体查询里写的东西一条都不生效。实测丢了两次：
 *   .field-row 的窄屏覆盖写在基础规则之前、.switch 的写在文件头部的窄屏块里，
 *   两者从 CSS 文本上看都「写对了」，量宽度才发现一条都没生效
 *   （开关溢出卡片 30px、输入框被标签挤成 116px）。
 *
 * 返回 [{ selector, mediaLine, baseLine }]，行号是原文件（含注释）的行号。
 *
 * 用真实的括号配对来切，不靠正则硬啃 —— 这个文件里 @media 里有嵌套的
 * 规则体，用 /([^{}]+)\{([^{}]*)\}/ 扫会把媒体查询整块吞掉、算出错行号。
 */
function mediaBeforeBase(css) {
  const lineOf = (idx) => css.slice(0, idx).split('\n').length;

  /* 跳过空白和注释 —— app.css 里那段注释正文写着
     `[hidden] { display: none } 来自 UA 样式表`，不跳的话从那里开始
     括号配对就全乱了；而且规则前面的注释会被粘进 prelude，
     导致 prelude.startsWith('@media') 判断失效、整个媒体查询块
     被当成一条基础规则吃掉（实测 @media 只认出 5 个，实际有 11 个）。 */
  const skipComment = (from) => {
    if (css.slice(from, from + 2) !== '/*') return from;
    const e = css.indexOf('*/', from + 2);
    return e < 0 ? css.length : e + 2;
  };
  const skipTrivia = (from) => {
    let k = from;
    while (k < css.length) {
      if (/\s/.test(css[k])) { k++; continue; }
      if (css.slice(k, k + 2) === '/*') { k = skipComment(k); continue; }
      break;
    }
    return k;
  };
  const matchBrace = (open) => {
    let depth = 0;
    for (let k = open; k < css.length; ) {
      k = skipTrivia(k);
      if (k >= css.length) break;
      if (css[k] === '{') depth++;
      else if (css[k] === '}') { depth--; if (depth === 0) return k; }
      k++;
    }
    return css.length - 1;
  };

  const rules = [];
  let i = skipTrivia(0);
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    const close = matchBrace(open);
    const take = (sel, line, media, body) => {
      for (const s2 of sel.split(',').map((x) => x.trim()).filter(Boolean)) {
        rules.push({ selector: s2, line, media, props: properties(body) });
      }
    };

    if (prelude.startsWith('@media')) {
      let j2 = skipTrivia(open + 1);
      while (j2 < close) {
        const o2 = css.indexOf('{', j2);
        if (o2 < 0 || o2 > close) break;
        const sel2 = css.slice(j2, o2).trim();
        const c2 = matchBrace(o2);
        if (sel2 && !sel2.startsWith('@')) take(sel2, lineOf(j2), prelude, css.slice(o2 + 1, c2));
        j2 = skipTrivia(c2 + 1);
      }
    } else if (prelude && !prelude.startsWith('@')) {
      take(prelude, lineOf(i), null, css.slice(open + 1, close));
    }
    i = skipTrivia(close + 1);
  }

  const bad = [];
  for (const r of rules) {
    if (!r.media || !/^\.[A-Za-z]/.test(r.selector)) continue;
    const base = rules.find((o) => o.selector === r.selector && !o.media);
    if (!base || base.line <= r.line) continue;
    // 只报「真的会被盖掉」的那条：基础规则也声明了的属性才谈得上覆盖。
    // 光看先后顺序会误报 —— 比如 @media 里改 display/overflow-x，
    // 而后置的基础规则只写 width/border-collapse，两者根本不打架。
    const clobbered = r.props.filter((p) => base.props.includes(p));
    if (!clobbered.length) continue;
    bad.push(
      `${r.selector}：${r.media} 里的 ${clobbered.join('/')} 会被第 ${base.line} 行的基础规则盖掉`
    );
  }
  const seen = new Set();
  return bad.filter((b) => {
    const k = b.split('：')[0];
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 规则体里声明过的属性名（小写，去掉 !important 和自定义属性）。 */
function properties(body) {
  const bare = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const part of bare.split(';')) {
    const m = part.match(/^\s*(-{0,2}[a-zA-Z][a-zA-Z0-9-]*)\s*:/);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

module.exports = {
  parseRules, decl, ruleFor, ruleBySuffix, horizontalMargins,
  width100WithSideMargin, overflowingWidth, fillsRow, mediaBeforeBase,
};