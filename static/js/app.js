/* ==========================================================================
   IT Tools — 全局前端逻辑
   无构建步骤，全部是浏览器原生 API。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- 工具模块注册表 ---------- */

  var modules = {};
  var mounted = [];
  /** 当前挂在页面上的工具的 slug（用来判断「是不是同一个工具」）。 */
  var mountedSlug = null;

  /**
   * 注册一个 JS 工具。
   * @param {string} slug 与注册表里的 slug 一致
   * @param {(root: HTMLElement) => ({destroy?: () => void} | void)} fn
   */
  function register(slug, fn) {
    modules[slug] = fn;
  }

  /** 挂载当前页面上的所有 JS 工具（切换页面后重复调用是安全的）。 */
  function mountAll() {
    var body = document.getElementById('tool-body');
    if (!body) return;
    var page = body.closest('[data-slug]');
    var slug = page && page.dataset.slug;
    var fn = slug && modules[slug];

    // 同一个工具已经在页面上了，就别再挂一遍。
    //
    // 真实页面里 mountAll() 会被调两次：一次是模板里的内联脚本
    // （tool.html 末尾，DOMContentLoaded 之前），一次是 app.js 的 boot()
    // （DOMContentLoaded 的时候）。app.js 是在解析途中加载的，那时
    // document.readyState 还是 'loading'，所以 boot() 一定排在
    // DOMContentLoaded 上，比内联脚本晚。
    //
    // 不挡这一下的话，工具会被挂载两次：第一个实例刚建好就被 destroy 掉。
    // 后果是 mount 里的副作用白跑一遍（拉库文件、生成数据、挂全局监听都得
    // 来两次），异步拉数据的那次还会写进已经被清空的 DOM，页面上也会闪一下
    // 第一个实例的界面。
    if (fn && mounted.length && mountedSlug === slug) return;

    unmountAll();
    if (!fn) return;

    var spinner = document.getElementById('tool-loading');
    try {
      var ret = fn(body);
      mounted.push(typeof ret === 'object' && ret !== null ? ret : null);
      mountedSlug = slug;
    } catch (err) {
      console.error('[it-tools] tool "' + slug + '" failed:', err);
      if (spinner) spinner.textContent = String(err && err.message || err);
    }
    if (spinner) spinner.remove();
  }

  function unmountAll() {
    mounted.forEach(function (m) {
      if (m && typeof m.destroy === 'function') {
        try { m.destroy(); } catch (e) { console.error(e); }
      }
    });
    mounted = [];
    mountedSlug = null;
  }

  /* ---------- DOM 小工具 ---------- */

  /**
   * 「拆了重建」的看门狗：把滚动位置和焦点还回去。
   *
   * 背景：工具重画结果区时是「先全拆了、再装回去」。拆的那一刻页面矮一大截，
   * 浏览器重新布局，发现当前的滚动位置已经超过「矮版页面」能滚到的上限，
   * 就把滚动条**夹回顶部**（实测 704 → 0）。等新内容装回去、页面长回来了，
   * 滚动位置却停在被夹过的那个数上 —— 用户看到的就是「点一下下面的值，
   * 滚动条自己弹回最顶」。同一个原因还会带走**焦点**：用户正点着的那一格
   * 被摘掉了，焦点就没了，想选中结果里的字复制也复制不成。
   *
   * 原版没这毛病：它是 Vue，**同一个 DOM 节点留着、只改 value**，不拆。
   * 我们已经能复用节点的都复用了（见 renderRows 的 rowNodes），但还有一堆
   * 工具是「拆了重建」的（每个 JS 工具重画时都调 D.clear(...)），所以在这里兜底。
   *
   * 做法：拆之前把 scrollY 和「正被点着的是谁」记下来，在**微任务**里
   * （浏览器绘制之前）放回去。微任务跑的时候新内容已经装回去了。
   *
   * 两条不放的情况：
   *   - 页面**真的**矮了（内容真少了）→ 那个位置已经够不着了，
   *     浏览器夹上去是对的，别跟它较劲；
   *   - 滚动位置是**往下**走的（页面变高了、内容插在视口上面）→ 那是浏览器
   *     的滚动锚定在起作用，不动。
   *
   * 焦点只还「同一个控件」：路径、标签、类名、兄弟里的排名都得对得上，
   * 还要看是哪种控件（见 controlKind）：只读框认位置就行（值本来就是会变的），
   * 可编辑的框还得值一样，按钮还得文案一样 —— 认错了比不还更糟
   * （用户接下来一下点击就点到别的地方去了）。
   */
  var wipeMemo = null;

  /** 记下「这个控件长什么样」，重建之后靠它认出是不是同一个。 */
  function controlSignature(el) {
    var sig = {
      tag: el.tagName,
      cls: el.className || '',
      kind: controlKind(el),
      val: typeof el.value === 'string' ? el.value : '',
      text: controlLabel(el),
      sel: null,
      twins: 0,
    };
    if (sig.kind === 'input' || sig.kind === 'output') {
      try { sig.sel = [el.selectionStart, el.selectionEnd]; } catch (e) { /* 不是文本控件 */ }
    }
    sig.twins = twinRank(el);
    return sig;
  }

  /**
   * 按钮上那句「稳住的」文案。
   *
   * 复制按钮点下去的那一瞬间文案会临时变成「Copied」，重画之后又变回
   * 「Copy all」。认按钮要认的是**稳住的那句**，不然每次复制完焦点都认不回来。
   */
  function controlLabel(el) {
    return el.getAttribute('data-label') || (el.textContent || '').trim();
  }

  /**
   * 控件分三类，分别用不同的口径认。
   *
   *   output 只读框（结果区里的值）—— **值就是会变的**，重画之后值不一样才是
   *           重画的意义。所以只认「同一个位置上的同一个框」：标签、类名、
   *           兄弟排名。认错了顶多焦点落到隔壁那行的值上，无害。
   *   input  可以编辑的输入框 —— 用户的字打在这儿，**值必须一样**才认，
   *           否则宁可不给焦点（不然一个字就打到别的框里去了）。
   *   button 按钮 —— 按上面的文字认（「Copy all」这种）。
   */
  function controlKind(el) {
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return el.readOnly ? 'output' : 'input';
    }
    return 'button';
  }

  /** 同一个爹妈下、长得一模一样的兄弟里排第几（0 起）。 */
  function twinRank(el) {
    var n = el.previousElementSibling, t = 0;
    while (n) {
      if (n.tagName === el.tagName && (n.className || '') === (el.className || '')) t++;
      n = n.previousElementSibling;
    }
    return t;
  }

  /** 这个节点是不是刚才那个控件？ */
  function sameControl(el, sig) {
    if (!el) return false;
    if (el.tagName !== sig.tag) return false;
    if ((el.className || '') !== sig.cls) return false;
    if (controlKind(el) !== sig.kind) return false;
    if (sig.kind === 'input' && el.value !== sig.val) return false;
    if (sig.kind === 'button' && sig.text) {
      var label = controlLabel(el);
      // 文案对不上就不认 —— 认错按钮比不认更糟（用户接着按回车就点到别的了）。
      // 唯一的例外：旧文案是复制按钮那个临时的「Copied」，那时候按位置认。
      if (label !== sig.text && sig.text !== i18n('copied', 'Copied')) return false;
    }
    return twinRank(el) === sig.twins;
  }

  /** 从 root 到 node 的孩子下标路线（node 自己不在 root 底下就返回 null）。 */
  function pathFrom(root, node) {
    var path = [], n = node;
    while (n && n !== root) {
      var parent = n.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, n));
      n = parent;
    }
    return n === root ? path : null;
  }

  /**
   * 拆之前打个招呼：记下滚动位置，还有「正被点着的是谁」。
   *
   * el 是马上要被拆干净的那个容器。
   */
  function rememberWipe(el) {
    var memo = wipeMemo;
    if (!memo) {
      memo = wipeMemo = { y: window.scrollY, focus: null };
      // 微任务 = 这一轮绘制之前。装回去的内容这时候已经在页面上了。
      Promise.resolve().then(restoreWipe);
    }
    if (!memo.focus) {
      var a = document.activeElement;
      if (a && a !== document.body && a !== document.documentElement && el.contains(a)) {
        var path = pathFrom(el, a);
        if (path) memo.focus = { host: el, path: path, sig: controlSignature(a) };
      }
    }
  }

  function restoreWipe() {
    var memo = wipeMemo;
    wipeMemo = null;
    if (!memo) return;

    // 焦点先还 —— 用 preventScroll，别让它自己滚一下（那会把滚动位置搅了）
    if (memo.focus) {
      var node = memo.focus.host;
      for (var i = 0; i < memo.focus.path.length && node; i++) {
        node = node.children[memo.focus.path[i]];
      }
      if (sameControl(node, memo.focus.sig)) {
        try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
        // 文本控件把选区也还回去（用户想选中结果里的字复制）——
        // 但只在字没变的时候还：值都变了，旧的下标没意义。
        if (memo.focus.sig.sel && node.value === memo.focus.sig.val && typeof node.setSelectionRange === 'function') {
          try { node.setSelectionRange(memo.focus.sig.sel[0], memo.focus.sig.sel[1]); } catch (e) { /* 忽略 */ }
        }
      }
    }

    // 滚动位置：只有「被夹上去了」且「那个位置还在」才放回去
    var y = memo.y;
    if (window.scrollY < y - 1) {
      var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      if (h >= y + window.innerHeight) window.scrollTo(0, y);
    }
  }

  var Dom = {
    /** 极简 h('div.cls#id', {attr}, children...) */
    h: function (spec, attrs) {
      var parts = String(spec).split(/(?=[.#])/);
      var el = document.createElement(parts[0] || 'div');
      parts.slice(1).forEach(function (p) {
        if (p[0] === '.') el.classList.add(p.slice(1));
        else if (p[0] === '#') el.id = p.slice(1);
      });
      var start = 1;
      if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
        Object.keys(attrs).forEach(function (k) {
          var v = attrs[k];
          if (v === null || v === undefined || v === false) return;
          if (k === 'html') el.innerHTML = v;
          else if (k === 'text') el.textContent = v;
          else if (k === 'style' && typeof v === 'object') {
            // 自定义属性（--foo）必须走 setProperty，Object.assign 到 style 上不生效
            Object.keys(v).forEach(function (p) {
              if (p.charAt(0) === '-') el.style.setProperty(p, v[p]);
              else el.style[p] = v[p];
            });
          }
          else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
          // textarea 的内容来自子文本节点，没有 value 内容属性 —— 直接
          // setAttribute('value', …) 会被静默忽略，样例就填不进去了。
          // 这里当成 property 设，两个都覆盖到。
          else if (k === 'value' && el.tagName === 'TEXTAREA') el.value = v;
          else el.setAttribute(k, v === true ? '' : v);
        });
        start = 2;
      }
      for (var i = start; i < arguments.length; i++) append(el, arguments[i]);
      return el;
    },
    icon: function (name, size, cls) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', cls ? 'icon ' + cls : 'icon');
      svg.setAttribute('width', size || 18);
      svg.setAttribute('height', size || 18);
      svg.setAttribute('aria-hidden', 'true');
      var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '/assets/img/icons.svg#i-' + name);
      svg.appendChild(use);
      return svg;
    },
    /**
     * 清空子节点。返回 el 本身，方便 D.clear(x).appendChild(...) 这样链式用。
     *
     * 拆之前先跟看门狗打个招呼 —— 拆到一半页面会矮一大截，浏览器会趁机
     * 把滚动条夹回顶部，还会带走正被点着的那一格的焦点
     * （原因见上面 rememberWipe 的注释）。
     */
    clear: function (el) { rememberWipe(el); while (el.firstChild) el.removeChild(el.firstChild); return el; },
    on: function (el, ev, fn, opts) { el.addEventListener(ev, fn, opts); return function () { el.removeEventListener(ev, fn, opts); }; }
  };

  function append(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(parent, c); }); return; }
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  /* ---------- 杂项 ---------- */

  function i18n(key, fallback) {
    return (window.__IT_TOOLS_I18N__ || {})[key] || fallback || key;
  }

  /**
   * 工具模块的文案翻译。
   *
   *   var t = ItTools.t('case-converter');
   *   U.field(t('your_string', 'Your string:'), textarea)
   *
   * 语言包里的键是 `ui.tool.<slug>.<key>`，下发到前端时去掉了 `ui.` 前缀
   * （见 crate::i18n::ui_bundle），所以前端这边查的是 `tool.<slug>.<key>`。
   *
   * 第二个参数是英文兜底：语言包里没有这条时用它。**兜底必须跟语言包里的英文一致** ——
   * src/i18n.rs 里有单测盯着这件事，不一致就红。
   */
  function toolText(slug) {
    return function (key, fallback) {
      return i18n('tool.' + slug + '.' + key, fallback);
    };
  }

  /**
   * 浏览器所在的 IANA 时区名（`Asia/Shanghai` 这样的）。
   *
   * 服务端算日期转换时需要知道「本地」是哪个时区，浏览器自己知道。
   * 老浏览器没有 Intl.DateTimeFormat，就返回空串 —— 那时服务端退回
   * 「按输入自带的偏移量显示」，也不会出错。
   */
  function browserZone() {
    try {
      if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return '';
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      return '';
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function download(filename, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /** 结果卡片 —— API 工具与 JS 工具共用同一套渲染。 */
  function outputCard(title) {
    var body = Dom.h('div.output-body');
    // 复制按钮复用 Util.copyButton。早先这里自己抄了一份，写成了
    // text: i18n('copied','Copy') 再把 i18n('copy','Copy') 当第三个参数传进去 ——
    // Dom.h 的第三个参数是「子节点」，于是按钮里先有一份 Copied、
    // 又挂了一个 Copy 文本节点，页面上每个结果卡的按钮都印着「CopiedCopy」。
    var copy = Util.copyButton(function () { return body.textContent; });
    var card = Dom.h('div.card', null,
      Dom.h('div.output-head', null, Dom.h('span.output-label', { text: title || i18n('output', 'Output') }), copy),
      body);
    card.outputBody = body;
    return card;
  }

  Dom.outputCard = outputCard;

  /* ---------- 工具之间共用的小工具 ---------- */

  /* ---------- 等宽块里的 CJK 对齐 ----------
   *
   * 等宽字体的「等宽」只对拉丁部分成立：CJK 走的是系统回退字体
   * （Linux 上是 Noto Serif CJK，Windows 上是微软雅黑，macOS 上是苹方），
   * 它们的字宽跟正文字体对不上。实测本机 DejaVu Sans Mono 的拉丁一格
   * 8.44px，而回退字体的一个汉字 14px —— Markdown 表格按「CJK 占两格」
   * 算，期望 16.88px。每多一个汉字就差 2.86px，竖线自然歪。
   *
   * 办法：拿系统自带的 CJK 字体（local()，不走网络）造一个 @font-face，
   * 用 size-adjust 把它整体缩放到「正好两格」，再挂到 font-family 前面。
   * 拉丁部分不在 unicode-range 里，字体照旧 —— 只动宽字符。
   *
   * 字体名找不到（机器上压根没装 CJK 字体）就放弃：顶多还是歪，
   * 工具本身不能因此坏掉。
   */

  // 常见的 CJK / 彩色 emoji 字体。local() 只在本机找，不发网络请求。
  var MONO_CJK_FONT_SRC = {
    cjk: "local('Noto Sans CJK SC'), local('Noto Sans CJK JP'), local('Noto Serif CJK SC'), " +
         "local('Microsoft YaHei'), local('PingFang SC'), local('Hiragino Sans GB'), " +
         "local('Droid Sans Fallback'), local('WenQuanYi Zen Hei'), local('Source Han Sans SC'), " +
         "local('SimSun'), local('MS Gothic'), local('Meiryo')",
    emoji: "local('Noto Color Emoji'), local('Segoe UI Emoji'), local('Apple Color Emoji'), " +
           "local('Twemoji Mozilla'), local('Noto Emoji')"
  };

  // 量字宽时用的代表字符
  var MONO_CJK_PROBE = { cjk: '中', emoji: '😀' };

  // 调好的字体面按「种类 + 目标宽度 + 字号」缓存，换页面、换工具都不用重做
  var monoCjkCache = {};

  function monoCjkRange(ranges) {
    if (!ranges || !ranges.length) return '';
    return ranges.map(function (r) {
      var lo = r[0].toString(16).toUpperCase();
      var hi = r[1].toString(16).toUpperCase();
      return lo === hi ? 'U+' + lo : 'U+' + lo + '-' + hi;
    }).join(',');
  }

  function monoCjkMeasure(probe, fontFamily, ch) {
    probe.style.fontFamily = fontFamily;
    probe.textContent = ch;
    return probe.getBoundingClientRect().width;
  }

  function monoCjkTryFace(kind, src, range, ch, fontCss, target, probe, pct) {
    var name = 'it-tools-mono-' + kind + '-' + Math.round(pct * 10);
    var face;
    try {
      face = new FontFace(name, src, { unicodeRange: range, sizeAdjust: pct + '%' });
    } catch (e) {
      return Promise.resolve(null);
    }
    return face.load().then(function () {
      try { document.fonts.add(face); } catch (e) { return null; }
      return { name: name, adv: monoCjkMeasure(probe, "'" + name + "', " + fontCss, ch) };
    }).catch(function () { return null; });
  }

  function monoCjkBuildFace(kind, src, range, ch, fontCss, target, probe) {
    // 先量「现在渲染成什么样」：浏览器会自动回退到系统的 CJK 字体，
    // 那就是它本来的字宽。
    var current = monoCjkMeasure(probe, fontCss, ch);
    if (!current || current <= 0) return Promise.resolve(null);
    var pct = (target / current) * 100;
    return monoCjkTryFace(kind, src, range, ch, fontCss, target, probe, pct).then(function (info) {
      if (!info) return null;
      if (Math.abs(info.adv - target) <= 0.5) return info;
      // 差得远 —— 多半是 local() 找到的字体跟浏览器自动回退的不是同一个。
      // 按实测比例再调一次。
      return monoCjkTryFace(kind, src, range, ch, fontCss, target, probe,
                            pct * (target / info.adv));
    });
  }

  function applyMonoCjk(el, specs) {
    if (!el || !specs || !specs.length) return;
    if (el.getAttribute('data-mono-cjk') === '1') return;
    el.setAttribute('data-mono-cjk', '1');
    if (typeof FontFace !== 'function' || !document.fonts ||
        typeof document.fonts.add !== 'function') return;
    var cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return; }
    if (!cs || !cs.fontFamily) return;

    var probe = Dom.h('span', { style: {
      position: 'absolute', visibility: 'hidden', display: 'inline-block',
      whiteSpace: 'pre', top: '-9999px', left: '0',
      fontFamily: cs.fontFamily, fontSize: cs.fontSize,
      fontWeight: cs.fontWeight, fontStyle: cs.fontStyle
    }});
    document.body.appendChild(probe);

    // 一格 = 一个空格那么宽（表格补位全靠空格）
    var target = monoCjkMeasure(probe, cs.fontFamily, ' ') * 2;
    if (!target || target <= 0) {
      if (probe.parentNode) probe.parentNode.removeChild(probe);
      return;
    }

    var jobs = specs.map(function (spec) {
      var kind = spec.kind || 'cjk';
      var src = MONO_CJK_FONT_SRC[kind];
      var range = monoCjkRange(spec.ranges);
      if (!src || !range) return Promise.resolve(null);
      var ch = spec.probe || MONO_CJK_PROBE[kind] || '中';
      var key = kind + '@' + Math.round(target * 100) + '@' +
                Math.round(parseFloat(cs.fontSize) * 100);
      if (monoCjkCache[key]) return Promise.resolve(monoCjkCache[key]);
      return monoCjkBuildFace(kind, src, range, ch, cs.fontFamily, target, probe)
        .then(function (info) { if (info) monoCjkCache[key] = info; return info; });
    });

    Promise.all(jobs).then(function (list) {
      var stack = '';
      list.forEach(function (i) { if (i) stack += "'" + i.name + "', "; });
      if (stack) el.style.fontFamily = stack + cs.fontFamily;
      if (probe.parentNode) probe.parentNode.removeChild(probe);
    }).catch(function () {
      if (probe.parentNode) probe.parentNode.removeChild(probe);
    });
  }

  var Util = {
    /**
     * 统一的「标签 + 控件」字段块，多数工具的第一个输入都用它。
     *
     * 标签默认在控件上面（跟参考实现的 c-input-text 默认值一致）。
     * 参考实现里 label-position="left" 只出现在少数工具上，
     * 要左标签就传 opts.left；标签列宽用 opts.labelWidth，
     * 对齐方式用 opts.labelAlign（'right' 是 c-input-text 显式右对齐的那种，
     * 'left' 是 n-form-item 那种左对齐的）。
     */
    field: function (labelText, control, opts) {
      opts = opts || {};
      var id = control.id || ('f-' + Math.abs(hashCode(String(labelText) + (opts.hint || ''))));
      control.id = id;
      var label = Dom.h('label.field-label', { for: id, text: labelText });
      var attrs = null;
      if (opts.wide || (opts.left && (opts.labelWidth || opts.labelAlign))) {
        attrs = { style: {} };
        if (opts.wide) attrs.style.width = '100%';
        if (opts.left && opts.labelWidth) attrs.style['--field-label-width'] = opts.labelWidth;
        if (opts.left && opts.labelAlign) attrs.style['--field-label-align'] = opts.labelAlign;
      }
      var wrap = Dom.h(opts.left ? 'div.field.field-left' : 'div.field', attrs, label, control);
      if (opts.hint) wrap.appendChild(Dom.h('p.field-hint', { text: opts.hint }));
      return wrap;
    },

    /**
     * 输入区与结果区之间的分隔线。
     * 参考实现里这一段是 <n-divider />（上下各 24px），
     * 另有几处写成 <div my-16px divider />（上下各 16px）——
     * 传 margin 覆盖这个间距。
     */
    divider: function (margin) {
      var attrs = { 'aria-hidden': 'true' };
      // 0 也是合法值（参考实现里有一处 <n-divider style="margin-top: 0" />），
      // 所以判空不能用 if (margin)。
      if (margin !== undefined && margin !== null) {
        attrs.style = { 'margin-top': margin + 'px', 'margin-bottom': margin + 'px' };
      }
      return Dom.h('div.tool-divider', attrs);
    },

    /**
     * 结果代码块 —— 原版的 TextareaCopyable 就是这个样子：
     * 一张白卡片，里面是等宽的代码（横向滚动），右上角浮一个圆形复制按钮。
     *
     * 返回的对象用法跟 textarea 一样（.value 读写出），所以工具代码里
     * `output.value = x` 那一行不用改，只要 appendChild 的地方换成 .card。
     *
     * @param {object} opts
     *   opts.mono    false → 不用等宽字体
     *   opts.getText 自定义取内容的函数（默认取 pre 的文本）
     *   opts.noCopy  true → 不放复制按钮（原版的 copy-placement="none"，
     *                 复制按钮在卡片外面另给一行）
     */
    codeBlock: function (opts) {
      opts = opts || {};
      var pre = Dom.h('pre.code-body' + (opts.mono === false ? '' : '.mono'));
      var card = Dom.h('div.card.code-card');
      if (!opts.noCopy) {
        card.appendChild(Util.copyButton(opts.getText || function () { return pre.textContent; }));
      }
      card.insertBefore(pre, card.firstChild);
      return {
        card: card,
        el: pre,
        get value() { return pre.textContent; },
        set value(v) { pre.textContent = v === null || v === undefined ? '' : String(v); }
      };
    },

    /**
     * 让等宽块里的中日韩字符正好占两格（细节见上面 applyMonoCjk 的注释）。
     *
     * 为什么要单独做这件事：等宽字体的「等宽」只对拉丁部分成立，CJK 走的是
     * 系统回退字体，字宽跟正文对不上。表格按「CJK 占两格」算出来是齐的，
     * 画到屏幕上却每多一个汉字就歪一点。
     *
     * @param {Element} el    要处理的等宽元素（pre / textarea 都行）
     * @param {Array}  specs  [{ kind: 'cjk' | 'emoji', ranges: [[lo, hi], …] }]
     *                        ranges 得跟调用方算宽度时用的那张表一致 ——
     *                        「算两格」和「渲染两格」必须是同一批码点。
     */
    monoCjk: function (el, specs) {
      applyMonoCjk(el, specs);
    },

    /**
     * 提示框（参考实现的 n-alert / c-alert）。
     *
     * type: 'info' | 'warning' | 'error'。
     * title 可选；正文可以是字符串，也可以是 DOM 节点（要放列表时用）。
     */
    alert: function (type, title, body) {
      var icon = type === 'error' ? 'close-circle' : (type === 'warning' ? 'alert-circle' : 'info-circle');
      var kids = [];
      if (title) kids.push(Dom.h('div.alert-title', { text: title }));
      if (body !== null && body !== undefined && body !== '') {
        if (typeof body === 'string') kids.push(Dom.h('div', { text: body }));
        else kids.push(body);
      }
      return Dom.h('div.alert.alert-' + (type || 'info'), null,
        Dom.icon(icon, 22, 'alert-icon'),
        Dom.h('div', null, kids));
    },

    /**
     * 复制按钮：点一下把 getText() 的内容写进剪贴板。
     *
     * 给了 labelText 的仍是文字按钮 —— 表格里并排好几个复制按钮时，
     * 光看图标分不清复制的是哪一列。
     * 没给文案的是图标按钮：参考实现里复制图标是输入框的 suffix
     * （叠在控件右端的一个小图标），不是一整块带文字的按钮。
     */
    copyButton: function (getText, labelText) {
      if (labelText) {
        var idle = labelText;
        // data-label = 稳住的那句文案。点下去之后按钮会临时显示「Copied」，
        // 重画之后要靠它认出「还是这个按钮」（见 controlLabel）。
        var btn = Dom.h('button.layui-btn.layui-btn-sm.layui-btn-primary', { type: 'button', text: idle, 'data-label': idle });
        btn.addEventListener('click', function () {
          copyText(String(getText())).then(function () {
            btn.textContent = i18n('copied', 'Copied');
            setTimeout(function () { btn.textContent = idle; }, 1200);
          }).catch(function () {
            btn.textContent = i18n('error', 'Failed');
            setTimeout(function () { btn.textContent = idle; }, 1200);
          });
        });
        return btn;
      }

      var btn2 = Dom.h('button.copy-btn', {
        type: 'button',
        title: i18n('copy', 'Copy'),
        'aria-label': i18n('copy', 'Copy'),
      }, Dom.icon('copy', 16));
      btn2.addEventListener('click', function () {
        copyText(String(getText())).then(function () {
          Dom.clear(btn2).appendChild(Dom.icon('check', 16));
          btn2.classList.add('is-copied');
          btn2.title = i18n('copied', 'Copied');
          btn2.setAttribute('aria-label', i18n('copied', 'Copied'));
          setTimeout(function () {
            Dom.clear(btn2).appendChild(Dom.icon('copy', 16));
            btn2.classList.remove('is-copied');
            btn2.title = i18n('copy', 'Copy');
            btn2.setAttribute('aria-label', i18n('copy', 'Copy'));
          }, 1200);
        }).catch(function () {
          btn2.title = i18n('error', 'Failed');
          btn2.setAttribute('aria-label', i18n('error', 'Failed'));
          setTimeout(function () {
            btn2.title = i18n('copy', 'Copy');
            btn2.setAttribute('aria-label', i18n('copy', 'Copy'));
          }, 1200);
        });
      });
      return btn2;
    },

    /** 密码可见性切换，返回包装好的输入框。 */
    passwordInput: function (attrs) {
      var input = Dom.h('input.layui-input', Object.assign({ type: 'password' }, attrs || {}));
      var eye = Dom.h('button.icon-btn', { type: 'button', title: 'Show', 'aria-label': 'Show' }, Dom.icon('eye', 18));
      eye.addEventListener('click', function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        Dom.clear(eye).appendChild(Dom.icon(show ? 'eye-off' : 'eye', 18));
        eye.title = eye.ariaLabel = show ? 'Hide' : 'Show';
      });
      return Dom.h('div.input-group', null, input, eye);
    },

    /* ---- 随机数：一律走 crypto.getRandomValues，不用 Math.random ---- */

    randomBytes: function (n) {
      var out = new Uint8Array(n);
      crypto.getRandomValues(out);
      return out;
    },
    /** [0, max) 的无偏随机整数 */
    randomInt: function (max) {
      if (max <= 0) throw new Error('max 必须为正数');
      var limit = Math.floor(0x100000000 / max) * max;
      var buf = new Uint32Array(1);
      do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
      return buf[0] % max;
    },
    randomPick: function (arr) { return arr[Util.randomInt(arr.length)]; },
    /** 从字符集里取 n 个字符组成随机串 */
    randomString: function (charset, n) {
      var out = '';
      for (var i = 0; i < n; i++) out += charset[Util.randomInt(charset.length)];
      return out;
    },

    /* ---- 字节 / 进制 ---- */

    utf8Bytes: function (str) { return new TextEncoder().encode(str); },
    utf8Decode: function (bytes) { return new TextDecoder().decode(bytes); },
    bytesToBase64: function (bytes) {
      var bin = '';
      var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      for (var i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
      return btoa(bin);
    },
    base64ToBytes: function (b64) {
      var bin = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
    hex: function (bytes) {
      return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    },
    bytesToNumber: function (bytes) {
      var n = 0;
      for (var i = 0; i < bytes.length; i++) n = n * 256 + bytes[i];
      return n;
    },
    numberToBytes: function (num, size) {
      var out = new Uint8Array(size);
      for (var i = size - 1; i >= 0; i--) { out[i] = num % 256; num = Math.floor(num / 256); }
      return out;
    },

    /** 复制 app.js 里已转义的文案；工具模块请一律走 ItTools.i18n() */
    escapeHtml: function (str) {
      return String(str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },

    /* ---- 超范围整数的无损往返 ---- */

    /**
     * 文本 → 文本：把超出安全范围的整数字面量换成哨兵字符串。
     * 序列化之后记得用 `restoreBigIntegers` 换回去。
     * @param {string} src
     * @param {{hashComment?: boolean}} [opts] YAML / TOML 传 true（`#` 起注释）
     * @returns {string}
     */
    guardBigIntegers: guardBigIntegers,
    /**
     * 文本 → 文本：把哨兵换回裸的十进制数字（含可能裹在外面的引号）。
     * @param {string} text
     * @returns {string}
     */
    restoreBigIntegers: restoreBigIntegers,
    /**
     * 值 → 值：哨兵字符串还原成十进制文本，其余原样返回。
     * 逐值渲染的地方（CSV 单元格、diff 树）用这个，别去改拼好的文本。
     * @param {*} value
     * @returns {*}
     */
    restoreBigIntegerValue: restoreBigIntegerValue
  };

  /* ---------- 超范围整数的无损往返 ----------

     JS 的 Number 尾数只有 53 位，`9223372036854775807` 一进 JSON5 / YAML / TOML 的
     解析器就被舍成 `9223372036854776000`；等序列化写回去时错值已经定型，中间没有
     任何一步能察觉 —— 转换器就这么把用户的数据改了还不吭声。`@iarna/toml` 更直接，
     超范围整数它返回 BigInt，而它自己那个 BigInt 的还原值就是错的。

     绕开的办法是不让解析器碰这个数值：**解析之前**把超范围的整数字面量换成一条带
     哨兵的字符串（解析器当普通字符串收下），**序列化之后**再把哨兵换回裸的十进制
     数字。往返无损，代价只是中间态里那几个值是字符串。

     已知不管的：
       - 浮点数。`0.1 + 0.2` 那类尾数问题依旧，超出量级的 `1e400` 仍会变 null。
       - 多行块标量。YAML 的 `|` / `>` 与 TOML 的 `"""` 里若藏着长数字，仍会走原来的
         有损路径（`"""` 已按整段跳过，`|` / `>` 没有）。

     放在 app.js 而不是每个工具各留一份：app.js 是每个页面都加载的，`Util` 是所有
     工具都已经握在手里的公共层，挂在 window 上不存在加载顺序问题。 */

  /** 哨兵用私用区字符 U+E000 包住，正常数据里几乎撞不上。 */
  var BIG_MARK = '\uE000';
  /** 2^53-1，BigInt 能精确表示的整数上界。 */
  var MAX_SAFE_BIG = 9007199254740991n;
  /** 数字紧挨着这些字符时不算「一个独立的字面量」（`abc123`、`a-1` 之类）。 */
  var IDENT_CHAR = /[A-Za-z0-9_$]/;

  /**
   * 从 i 开始读一个数值字面量。只在它是**整数**且绝对值超过 2^53-1 时返回可替换的
   * 十进制文本；其余一律返回 null，原样交给调用方。
   *
   * 返回十进制而不是原文是有意的：`0xFF` 在 YAML 里合法、在 JSON 里不合法，
   * 还原成十进制才能保证写进任何一种输出格式都是合法的数。
   *
   * @param {string} s
   * @param {number} i 起始位置（可以指向前导 + / -）
   * @returns {{end: number, decimal: string}|null}
   */
  function readBigIntegerLiteral(s, i) {
    var n = s.length;
    var negative = false;
    if (s.charAt(i) === '+' || s.charAt(i) === '-') {
      negative = s.charAt(i) === '-';
      i++;
    }

    var rest = s.slice(i);
    // radix 默认为空 = 十进制；下面三条分支才换成前缀
    var digits, radix = '', m;
    if ((m = /^0[xX]([0-9a-fA-F_]+)/.exec(rest))) { radix = '0x'; digits = m[1].replace(/_/g, ''); i += m[0].length; }
    else if ((m = /^0[oO]([0-7_]+)/.exec(rest))) { radix = '0o'; digits = m[1].replace(/_/g, ''); i += m[0].length; }
    else if ((m = /^0[bB]([01_]+)/.exec(rest))) { radix = '0b'; digits = m[1].replace(/_/g, ''); i += m[0].length; }
    else {
      if (!(m = /^[0-9][0-9_]*/.exec(rest))) return null;
      digits = m[0].replace(/_/g, '');
      i += m[0].length;
      // 小数和指数不是整数，这一版不管
      if (i < n && /[.eE]/.test(s.charAt(i))) return null;
    }
    // `123abc` / `0xFFg`：不是数字，别把后半截留在外面
    if (i < n && IDENT_CHAR.test(s.charAt(i))) return null;

    var v;
    try { v = BigInt(radix + digits); } catch (e) { return null; }
    if (v <= MAX_SAFE_BIG && -v <= MAX_SAFE_BIG) return null;
    var abs = v < 0n ? -v : v;
    return { end: i, decimal: (negative ? '-' : '') + abs.toString() };
  }

  /**
   * 扫描文本，把超范围整数字面量换成哨兵字符串。
   *
   * 字符串整段照抄：里面长得像数字的东西（base64 片段、长订单号）不是数值字面量，
   * 换了就等于改数据。
   *
   * @param {string} src
   * @param {{hashComment?: boolean}} [opts] YAML / TOML 传 true（`#` 起注释）
   * @returns {string} 没有需要保护的整数时原样返回
   */
  function guardBigIntegers(src, opts) {
    var s = String(src == null ? '' : src);
    var hashComment = !!(opts && opts.hashComment);
    var n = s.length, out = '', i = 0, changed = false;

    while (i < n) {
      var c = s.charAt(i);

      if (c === '"' || c === "'") {
        // TOML 的 `"""..."""` / `'''...'''` 先按整段跳过，否则只会吃掉两个引号就停
        var triple = s.substr(i, 3);
        if (triple === '"""' || triple === "'''") {
          var close = s.indexOf(triple, i + 3);
          var tEnd = close < 0 ? n : close + 3;
          out += s.slice(i, tEnd); i = tEnd; continue;
        }
        var j = i + 1;
        while (j < n) {
          if (s.charAt(j) === '\\') { j += 2; continue; }
          if (s.charAt(j) === c) { j++; break; }
          if (s.charAt(j) === '\n') break;   // 没闭合就到行为止，别把余下整个文件吞掉
          j++;
        }
        out += s.slice(i, j); i = j; continue;
      }

      if (hashComment && c === '#') {
        var eol = s.indexOf('\n', i);
        if (eol < 0) eol = n;
        out += s.slice(i, eol); i = eol; continue;
      }

      var next = s.charAt(i + 1);
      var startsNumber = (c >= '0' && c <= '9')
        || ((c === '+' || c === '-') && next >= '0' && next <= '9');
      if (startsNumber && (i === 0 || !IDENT_CHAR.test(s.charAt(i - 1)))) {
        var lit = readBigIntegerLiteral(s, i);
        if (lit) {
          // 后面（跳过空白）是冒号，说明这是对象的键 —— JSON5 允许裸数字键，
          // 而键没法用裸数字还原成 JSON，只保值。
          var after = lit.end;
          while (after < n && /[ \t]/.test(s.charAt(after))) after++;
          if (s.charAt(after) !== ':') {
            // 一定要带引号：JSON 的字符串不能裸写，YAML / TOML 带引号也更保险
            // （裸哨兵在 YAML 里虽然也是合法标量，但少一处分歧少一处坑）。
            out += '"' + BIG_MARK + '#' + lit.decimal + BIG_MARK + '"';
            i = lit.end; changed = true; continue;
          }
        }
      }

      out += c; i++;
    }
    return changed ? out : s;
  }

  /** 还原整个输出文本。引号两侧各自可选：JSON 是 `"哨兵"`，YAML / TOML 可能是
   *  `'哨兵'`、`"哨兵"`，也可能引号被省掉写成裸哨兵。 */
  function restoreBigIntegers(text) {
    return String(text == null ? '' : text).replace(
      new RegExp('["\']?' + BIG_MARK + '#(-?[0-9]+)' + BIG_MARK + '["\']?', 'g'),
      '$1'
    );
  }

  /** 逐值还原。CSV 单元格 / diff 树这类一个值一个值拼的地方用它，
   *  别对拼好的文本跑 `restoreBigIntegers` —— 那会把 CSV 的引号一起吃掉。 */
  function restoreBigIntegerValue(value) {
    if (typeof value !== 'string') return value;
    var m = new RegExp('^' + BIG_MARK + '#(-?[0-9]+)' + BIG_MARK + '$').exec(value);
    return m ? m[1] : value;
  }

  /** 由字符串生成稳定的短 id，供 Util.field 关联 label 与控件。 */
  function hashCode(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }

  /* ---------- 主题 ---------- */

  /**
   * 切换主题。导航栏按钮和命令面板两处入口都走这里，别各写一份。
   *
   * 图标方向对齐参考实现：浅色显示月亮（点它切到深色），深色显示太阳（点它切回浅色）。
   * 哪个月亮/太阳可见由 CSS 按 [data-theme] 决定，这里只管状态。
   */
  function applyTheme(next) {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* 隐私模式 */ }
    syncThemeButton();
  }

  /** 主题按钮可能有多个（顶栏一个、窄屏侧栏一个），一起找出来。 */
  function themeButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('.theme-toggle'));
  }

  /**
   * 按钮的 title/aria-label 要说明「点下去会变成什么」，所以跟着当前主题走。
   * 服务端渲染的是默认主题下的那一句，客户端起来后由这里纠正。
   */
  function syncThemeButton() {
    var label = document.documentElement.dataset.theme === 'dark'
      ? i18n('light_mode', 'Light mode')
      : i18n('dark_mode', 'Dark mode');
    themeButtons().forEach(function (btn) {
      btn.title = label;
      btn.setAttribute('aria-label', label);
    });
  }

  function initTheme() {
    themeButtons().forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      });
    });
    syncThemeButton();
    syncKbd();

    // 系统换了深浅色设置时跟着换 —— 前提是用户没自己选过。
    // 原版 useDark() 的默认值是 'auto'，就是这个行为。
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function (e) {
      var saved = null;
      try { saved = localStorage.getItem('theme'); } catch (err) { /* 隐私模式 */ }
      if (saved === 'dark' || saved === 'light') return;   // 用户自己选过，别动
      document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
      syncThemeButton();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  function isMac() { return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent); }
  function syncKbd() {
    var kbd = document.getElementById('search-kbd');
    if (kbd) kbd.textContent = (isMac() ? '⌘' : 'Ctrl') + ' K';
  }

  /* ---------- 侧栏展开 / 收起 ---------- */

  // 键名与语义都跟参考实现一致（stores/style.store.ts 的 useStorage('isMenuCollapsed')），
  // 存的是「收起」，不是「展开」
  var MENU_KEY = 'isMenuCollapsed';
  var MOBILE_QUERY = '(max-width: 700px)';

  function initMenu() {
    var layout = document.getElementById('layout');
    var scrim = document.getElementById('scrim');
    var toggle = document.getElementById('toggle-menu');
    if (!layout || !toggle) return;

    var mq = window.matchMedia(MOBILE_QUERY);
    var isOpen = function () { return layout.dataset.menuOpen === 'true'; };

    function setOpen(open, remember) {
      layout.dataset.menuOpen = open ? 'true' : 'false';
      // 遮罩只在小屏出现 —— 参考实现是 v-show="isSmallScreen && !isMenuCollapsed"。
      // 早先这里无条件显示，于是宽屏点一下就是给整个页面糊一层黑，而侧栏
      // （桌面端走宽度归零，跟这里没关系）纹丝不动，纯粹是个 bug。
      if (scrim) scrim.hidden = !open || !mq.matches;
      if (remember !== false) writeJson(MENU_KEY, !open);
    }

    // 没存过状态时以断点为准：小屏默认收起、宽屏默认展开
    setOpen(readJson(MENU_KEY, mq.matches) === false, false);

    toggle.addEventListener('click', function () { setOpen(!isOpen()); });
    if (scrim) scrim.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) setOpen(false);
    });

    // 跨断点时状态跟着断点走，对齐参考实现的 watch(isSmallScreen, v => v)：
    // 缩到小屏自动收起，拉回宽屏自动展开。少了这段的话，把窗口从宽拖到窄，
    // 侧栏还开着，正文被 absolute 定位的侧栏压在下面。
    var onBreakpoint = function () { setOpen(!mq.matches); };
    if (mq.addEventListener) mq.addEventListener('change', onBreakpoint);
    else if (mq.addListener) mq.addListener(onBreakpoint);   // 老 Safari
  }

  /* ---------- 分类折叠 ---------- */

  var COLLAPSE_KEY = 'collapsedNavGroups';

  function initNavGroups() {
    var state = readJson(COLLAPSE_KEY, null);

    document.querySelectorAll('.nav-group[data-category]').forEach(function (group) {
      var head = group.querySelector('.nav-group-head');
      if (!head) return;
      var id = group.dataset.category;
      apply(head, group, state ? state[id] === true : false);

      head.addEventListener('click', function () {
        toggleGroup(head, group, id);
      });
      // 左侧那条 2px 竖线也是折叠入口（参考实现 .toggle-bar 的 @click）
      var bar = group.querySelector('.nav-toggle-bar');
      if (bar) {
        bar.addEventListener('click', function () {
          toggleGroup(head, group, id);
        });
      }
    });
  }

  /* 「现在是展开的」→ 点一下就该收起，所以新状态直接等于当前展开态。
     这里原先写的是 `aria-expanded !== 'true'` —— 那是「当前收起」，拿它当新状态
     写回去等于没变，于是分类组点了永远不动；localStorage 那边还跟着存了
     反的值。收藏组用的是对的那版，两边行为因此对不上。现在统一走这个函数。 */
  function toggleGroup(head, group, id) {
    var collapsed = head.getAttribute('aria-expanded') === 'true';
    // 折叠动画只在用户点的时候开：首屏按 localStorage 还原折叠状态时不该动
    group.classList.add('animating');
    apply(head, group, collapsed);
    var s = readJson(COLLAPSE_KEY, {});
    s[id] = collapsed;
    writeJson(COLLAPSE_KEY, s);
  }

  function apply(head, group, collapsed) {
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    group.dataset.collapsed = collapsed ? 'true' : 'false';
  }

  function readJson(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式 */ }
  }

  /* ---------- 侧栏滚动位置 ----------

   * 原版是 Vue 单页应用：换页面时侧栏不重绘，滚动位置自然留着。
   * 我们是整页跳转，侧栏重新渲染 → scrollTop 归零 → 换页时侧栏「弹」回顶部。
   *
   * 记在 sessionStorage 里 —— 按标签页隔离：新标签页、新会话都不受影响
   * （用户从书签重新打开一个页面时，侧栏该在哪儿就在哪儿）。
   *
   * 还原要等两件事做完，否则 scrollTop 会差一截：
   *   ① initNavGroups 按 localStorage 还原折叠状态（内容高度变了）；
   *   ② renderFavorites 把收藏组插到最上面（内容高度又变了）。
   * 这两件都在 boot 的 loadToolIndex().then() 之后，restoreSidebarScroll()
   * 就挂在它后面。
   */
  var SIDEBAR_SCROLL_KEY = 'sidebarScrollTop';

  function initSidebarScroll() {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    var save = function () {
      try { sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(sidebar.scrollTop)); }
      catch (e) { /* 隐私模式 / sessionStorage 不可用 */ }
    };

    // 滚动时记一份（rAF 节流）
    var ticking = false;
    sidebar.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () { ticking = false; save(); });
    }, { passive: true });
    // 离开页面前再记一次：点链接马上跳走的话，rAF 那一帧可能还没跑
    window.addEventListener('pagehide', save);
  }

  function restoreSidebarScroll() {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    var saved = 0;
    try { saved = parseInt(sessionStorage.getItem(SIDEBAR_SCROLL_KEY) || '0', 10) || 0; }
    catch (e) { saved = 0; }
    if (saved <= 0) return;
    sidebar.scrollTop = saved;
  }

  /* ---------- 收藏 ---------- */

  var FAV_KEY = 'favoriteToolsName';

  function getFavorites() {
    var v = readJson(FAV_KEY, []);
    return Array.isArray(v) ? v.filter(function (p) { return typeof p === 'string'; }) : [];
  }
  function setFavorites(list) {
    writeJson(FAV_KEY, list);
    renderFavorites();
    syncFavButtons();
  }
  function toggleFavorite(path) {
    var list = getFavorites();
    var i = list.indexOf(path);
    if (i === -1) list.push(path);
    else list.splice(i, 1);
    setFavorites(list);
    return i === -1;
  }
  function isFavorite(path) { return getFavorites().indexOf(path) !== -1; }

  function syncFavButtons() {
    document.querySelectorAll('[data-fav]').forEach(function (btn) {
      var on = isFavorite(btn.dataset.fav);
      btn.classList.toggle('is-favorite', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function initFavoriteButtons() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-fav]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(btn.dataset.fav);
    });
  }

  /** 工具索引：path → {name, description, icon, isNew}，来自 registry.json（同源）。 */
  var toolIndex = null;
  function loadToolIndex() {
    if (toolIndex) return Promise.resolve(toolIndex);
    return fetch('/registry.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        toolIndex = {};
        (data.tools || []).forEach(function (t) { toolIndex[t.path] = t; });
        return toolIndex;
      })
      .catch(function () { toolIndex = {}; return toolIndex; });
  }

  function favCard(tool) {
    var card = Dom.h('a.tool-card', { href: tool.path, 'data-path': tool.path });
    var head = Dom.h('div.tool-card-head');
    head.appendChild(Dom.icon(tool.icon, '40', 'tool-card-icon'));
    head.classList.add('tool-card-icon');
    var actions = Dom.h('span.tool-card-actions');
    if (tool.isNew) actions.appendChild(Dom.h('span.badge-new', { text: 'NEW' }));
    actions.appendChild(Dom.h('button.fav-btn.is-favorite', {
      type: 'button', 'data-fav': tool.path, 'aria-label': 'favorite', 'aria-pressed': 'true'
    }, Dom.icon('heart', '18')));
    head.appendChild(actions);
    card.appendChild(head);
    card.appendChild(Dom.h('div.tool-card-title', { text: tool.name }));
    card.appendChild(Dom.h('div.tool-card-desc', { text: tool.description }));
    return card;
  }

  function renderFavorites() {
    var paths = getFavorites();

    // 侧栏分组
    var group = document.getElementById('favorites-group');
    if (group) {
      Dom.clear(group);
      if (paths.length) {
        var section = Dom.h('section.nav-group', { 'data-category': 'favorites' });
        // 这一组是 boot 之后才插进来的，initNavGroups 扫不到它，所以状态得在这儿补上
        var startCollapsed = readJson(COLLAPSE_KEY, {})['favorites'] === true;
        var head = Dom.h('button.nav-group-head', { type: 'button', 'aria-expanded': 'true' },
          Dom.icon('chevron-right', '16', 'chev'), Dom.h('span.nav-group-label', { text: i18n('favorites', 'Favorites') }));
        apply(head, section, startCollapsed);
        head.addEventListener('click', function () {
          toggleGroup(head, section, 'favorites');
        });
        var ul = Dom.h('ul.nav-list');
        paths.forEach(function (path) {
          var t = toolIndex && toolIndex[path];
          var label = t ? t.name : path;
          var icon = t ? t.icon : 'tool';
          ul.appendChild(Dom.h('li', null,
            Dom.h('a.nav-item', { href: path, title: label },
              Dom.icon(icon, '16', 'nav-icon'),
              Dom.h('span.nav-text', { text: label }))));
        });
        // 结构要跟服务端渲染的分类组一致：nav-group-body 里是竖线 + 列表
        var bar = Dom.h('button.nav-toggle-bar', {
          type: 'button',
          title: i18n('toggle_category', 'Toggle category'),
          'aria-label': i18n('toggle_category', 'Toggle category'),
          onclick: function () { toggleGroup(head, section, 'favorites'); }
        });
        section.appendChild(head);
        section.appendChild(Dom.h('div.nav-group-body', null, bar, ul));
        group.appendChild(section);
        group.hidden = false;
      } else {
        group.hidden = true;
      }
    }

    // 首页收藏区
    // 变量名不能叫 `section`：上面侧栏那个也是 `var section`，而 var 是函数级的 ——
    // 这一行会把上面的绑定覆盖掉，侧栏点击回调里的 `section` 于是指向首页这块，
    // dataset.collapsed 就写到错的节点上（侧栏那一组点了没反应）。
    var homeSection = document.getElementById('favorites-section');
    var grid = document.getElementById('favorites-grid');
    if (homeSection && grid) {
      if (!paths.length) { homeSection.hidden = true; return; }
      Dom.clear(grid);
      paths.forEach(function (path) {
        var t = toolIndex && toolIndex[path];
        if (t) grid.appendChild(favCard(t));
      });
      homeSection.hidden = false;
      enableDragSort(grid);
    }
  }

  /** 首页收藏区拖拽排序（HTML5 DnD，移动端靠长按排序按钮，见 enableDragSort 的 hint）。 */
  function enableDragSort(grid) {
    if (grid.dataset.dragReady === '1') return;
    grid.dataset.dragReady = '1';

    var dragging = null;
    grid.addEventListener('dragstart', function (e) {
      var card = e.target.closest('.tool-card');
      if (!card) return;
      dragging = card;
      card.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
      // Firefox 要求设置数据才会触发 drag
      e.dataTransfer.setData('text/plain', card.dataset.path || '');
    });
    grid.addEventListener('dragend', function () {
      if (!dragging) return;
      dragging.style.opacity = '';
      dragging = null;
    });
    grid.addEventListener('dragover', function (e) {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var over = e.target.closest('.tool-card');
      if (!over || over === dragging) return;
      var rect = over.getBoundingClientRect();
      var after = e.clientX > rect.left + rect.width / 2;
      over.parentNode.insertBefore(dragging, after ? over.nextSibling : over);
    });
    grid.addEventListener('drop', function (e) {
      e.preventDefault();
      var order = Array.prototype.map.call(grid.children, function (c) { return c.dataset.path; });
      setFavorites(order.filter(Boolean));
    });

    // 每张卡片可拖拽
    Array.prototype.forEach.call(grid.children, function (card) {
      card.setAttribute('draggable', 'true');
    });
  }

  /** 新增/移除收藏后，拖拽需要重建（子节点换了）。 */
  var origRenderFavorites = renderFavorites;
  renderFavorites = function () {
    origRenderFavorites();
    var grid = document.getElementById('favorites-grid');
    if (grid) {
      delete grid.dataset.dragReady;
      enableDragSort(grid);
    }
  };

  /* ---------- 语言切换 ---------- */

  function initLang() {
    // 宽屏在顶栏、窄屏在侧栏，各有一个语言下拉，两个都要能切。
    var sels = Array.prototype.slice.call(document.querySelectorAll('.lang-select'));
    sels.forEach(function (sel) {
      sel.addEventListener('change', function () {
        try {
          document.cookie = 'lang=' + encodeURIComponent(sel.value) + ';path=/;max-age=31536000;samesite=lax';
        } catch (e) { /* 忽略 */ }
        var url = new URL(window.location.href);
        url.searchParams.set('lang', sel.value);
        window.location.href = url.toString();
      });
    });
  }

  /* ---------- 命令面板 ---------- */

  // 每个分类最多显示多少条结果。5 条太少：工具分散在各个分类里，
  // 一搜「a」就有好几个分类被截断，用户会以为工具不存在。
  var PALETTE_MAX_PER_CATEGORY = 25;

  function initPalette() {
    var palette = document.getElementById('palette');
    if (!palette) return;

    var input = document.getElementById('palette-input');
    var results = document.getElementById('palette-results');
    var empty = document.getElementById('palette-empty');
    var dataEl = document.getElementById('palette-data');

    var entries = [];
    var labels = {};
    try { entries = JSON.parse(dataEl.textContent) || []; } catch (e) { entries = []; }
    try { labels = JSON.parse(document.getElementById('palette-i18n').textContent) || {}; } catch (e) { /* 忽略 */ }

    var selected = -1;
    var flat = [];

    function open() {
      palette.hidden = false;
      input.value = '';
      update();
      input.focus();
    }
    function close() {
      palette.hidden = true;
      selected = -1;
    }
    function isOpen() { return !palette.hidden; }

    function score(entry, q) {
      // 大小写无关的子串匹配，name 权重更高；返回 0 表示不匹配。
      var name = (entry.name || '').toLowerCase();
      if (name === q) return 100;
      if (name.indexOf(q) === 0) return 80;
      if (name.indexOf(q) !== -1) return 60;
      var other = [entry.description, entry.category, (entry.keywords || []).join(' ')]
        .join(' ').toLowerCase();
      if (other.indexOf(q) !== -1) return 30;
      // 逐字符子序列匹配，覆盖 "hsh" → "hash text" 这类简写
      var i = 0;
      for (var j = 0; j < name.length && i < q.length; j++) {
        if (name[j] === q[i]) i++;
      }
      return i === q.length ? 15 : 0;
    }

    function update() {
      var q = input.value.trim().toLowerCase();
      Dom.clear(results);
      flat = [];
      empty.hidden = true;

      if (!q) {
        renderGroup(labels.tools || 'Tools', entries.slice(0, 8));
        renderGroup(labels.actions || 'Actions', actionEntries());
      } else {
        var matched = entries
          .map(function (e) { return { e: e, s: score(e, q) }; })
          .filter(function (x) { return x.s > 0; })
          .sort(function (a, b) { return b.s - a.s; });

        // 按分类分组，每类最多 25 条。
        // 原来是 5 条 —— 光 Crypto 一类就装不下，
        // 搜「e」这种宽一点的词会把一大半结果藏起来（上游 #1440 同样改成 25）。
        var byCat = {};
        var order = [];
        matched.forEach(function (x) {
          var c = x.e.category || '';
          if (!byCat[c]) { byCat[c] = []; order.push(c); }
          if (byCat[c].length < PALETTE_MAX_PER_CATEGORY) byCat[c].push(x.e);
        });
        order.forEach(function (c) { renderGroup(c, byCat[c]); });

        var acts = actionEntries().filter(function (a) { return score(a, q) > 0; });
        if (acts.length) renderGroup(labels.actions || 'Actions', acts);

        if (!flat.length) empty.hidden = false;
      }

      selected = flat.length ? 0 : -1;
      paint();
    }

    function renderGroup(label, items) {
      if (!items || !items.length) return;
      results.appendChild(Dom.h('div.palette-group-label', { text: label }));
      items.forEach(function (item) {
        // 工具条目有 path（跳到那个工具页），动作条目只有 run（做一件事）。
        // 判据是**有没有 path** —— 服务端给的字段就叫 path（base.nav.search），
        // 写成 href 的话每个工具条目都会被当成动作：渲染成 <button>，
        // 点下去调一个根本不存在的 run()，于是**什么也不会发生**。
        var isAction = typeof item.path !== 'string';
        var el = Dom.h(isAction ? 'button.palette-item' : 'a.palette-item',
          isAction ? { type: 'button' } : { href: item.path },
          Dom.icon(item.icon || (isAction ? 'settings' : 'tool'), '22', 'palette-item-icon'),
          Dom.h('span.palette-item-text', null,
            Dom.h('span.palette-item-name', { text: item.name }),
            item.description ? Dom.h('span.palette-item-desc', { text: item.description }) : null),
          item.isNew ? Dom.h('span.badge-new', { text: 'NEW' }) : null);
        el.dataset.index = String(flat.length);
        flat.push({ el: el, entry: item, isAction: isAction });
        results.appendChild(el);
      });
    }

    function actionEntries() {
      return [
        { name: labels.random_tool || 'Random tool', icon: 'dice-5', run: randomTool, description: '' },
        { name: labels.toggle_theme || 'Toggle theme',
          icon: document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon',
          run: toggleThemeNow, description: '' },
        { name: labels.about || 'About', icon: 'info-circle', path: '/about', description: '' },
        { name: labels.home || 'Home', icon: 'home', path: '/', description: '' }
      ];
    }

    function paint() {
      flat.forEach(function (f, i) { f.el.classList.toggle('is-selected', i === selected); });
      if (selected >= 0 && flat[selected]) {
        flat[selected].el.scrollIntoView({ block: 'nearest' });
      }
    }

    /** 选中项被执行：回车，或者点了一个动作条目。 */
    function activate(f) {
      if (!f) return;
      if (f.isAction) { close(); f.entry.run(); return; }
      // 工具条目是 <a href>，**鼠标点它由浏览器自己跳**（这样 cmd+点击
      // 还能开新标签页）。这里管的是回车 —— 键盘上没有 <a> 的默认跳转。
      close();
      window.location.href = f.entry.path;
    }

    input.addEventListener('input', update);

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, flat.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); activate(flat[selected]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    results.addEventListener('click', function (e) {
      var el = e.target.closest('.palette-item');
      if (!el) return;
      var f = flat[Number(el.dataset.index)];
      if (!f) return;
      // 工具条目是 <a href>：这里**不要** preventDefault —— 浏览器自己的
      // 跳转才能保留 cmd+点击开新标签页。只把面板关掉。
      if (f.isAction) activate(f);
      else close();
    });

    palette.addEventListener('mousedown', function (e) {
      if (e.target === palette) close();
    });

    var trigger = document.getElementById('search-trigger');
    if (trigger) trigger.addEventListener('click', open);

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        isOpen() ? close() : open();
      } else if (e.key === '/' && !isOpen() && !isTyping(e.target)) {
        e.preventDefault();
        open();
      }
    });
  }

  function isTyping(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
  }

  function randomTool() {
    loadToolIndex().then(function (idx) {
      var list = Object.keys(idx);
      if (!list.length) return;
      window.location.href = list[Math.floor(Math.random() * list.length)];
    });
  }

  function toggleThemeNow() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }

  /* ---------- 通用 API 表单（ImplKind::Api） ---------- */

  function initApiForm() {
    var body = document.getElementById('tool-body');
    if (!body || !body.dataset.toolApi) return;

    var form = document.getElementById('api-form');
    if (!form) return;

    var status = document.getElementById('api-status');
    var runBtn = document.getElementById('api-run');

    // 结果区的形状（见 src/registry/mod.rs 的 ResultKind）：
    //   card    一张「Output」卡片（我们自己加的服务端工具）
    //   rows    一行一个格式（date-time-converter、hash-text）
    //   text    一个只读输入框（hmac-generator、encryption、bcrypt）
    //   lines   一张装着几行字的卡片（mac-address-lookup）
    //   keypair 两张带标题的代码卡（rsa-key-pair-generator）
    //   tokens  一行三个令牌（otp-code-generator-and-validator）
    //
    // 形状写在表单的 data-kind 上 —— 模板按它挑骨架，这里按它挑渲染逻辑。
    // 以前所有工具都走 card 那一条路，结果区长得千篇一律，对齐不了任何一个
    // 有原版可对的工具：原版的哈希是个只读输入框，不是卡片里的一行字。
    var kind = form.dataset.kind || 'card';

    // 「一行一个格式」的结果（date-converter 那种）：结果直接排在表单卡片里，
    // 每行一个只读输入框 + 叠在框里的复制图标，像参考实现那样。
    // 这种排法下下面那张 Output 卡片不用了。
    var rowsHost = document.getElementById('api-rows');
    // data-rows="1" 是早先的开关，现在形状统一走 data-kind ——
    // 两个都认，老的标记不至于失效。
    var rowsMode = (kind === 'rows' || form.dataset.rows === '1') && !!rowsHost;

    // 「一行一个格式」的那些行：key → {row, label, input}。
    //
    // 留着是为了**原地改值**，而不是每次都拆了重建 —— 拆了重建有两个坏处
    // （都是拿 CDP 一点点试出来的）：
    //
    //   1) 拆的时候页面一下子矮一大截（结果区整个没了）。浏览器随即重新布局，
    //      发现当前的滚动位置已经超出「矮版页面」能滚到的上限，就把滚动条
    //      **夹回顶部**（实测 568 → 73）。等新行装回去、页面又长回来了，
    //      滚动位置却停在被夹过的那个数上 —— 用户看到的就是
    //      「点一下下面那个值，滚动条自己弹回最顶」。
    //      触发点是「正被点着的那一格」：它一被摘掉，浏览器要重新算焦点
    //      落在哪儿，于是就在拆到一半的时候重新布局了一次。
    //   2) 用户正要点着那个值选中文字复制，节点一换，选区就没了。
    //
    // 原版是 Vue 写的：同一个 DOM 节点留着，只改 value，所以它没这两个毛病
    // （实测原版：点着的那一格过了两秒仍然有焦点，值在一格一格地变）。
    var rowNodes = {};
    var rowDivider = null;

    // card 形状的结果区在表单卡片**外面**（它自己就是一张卡片）；
    // 其余四种在表单里面，骨架由下面的 ensure*Dom 搭。
    var resultEl = document.getElementById('api-output');
    var outBody = document.getElementById('api-output-body');

    // 时区字段预填浏览器自己的时区。
    //
    // 参考实现的日期转换是在浏览器里算的，显示的一律是**本地时间**；
    // 服务端这边得有人告诉它「本地」是哪个时区，否则显示的是输入自带的偏移量
    // （同一个瞬间在北京看到 +02:00、在纽约看到 -04:00，没法直接跟原版对上）。
    var tzEl = form.elements['timezone'];
    if (tzEl && !tzEl.value) {
      var zone = browserZone();
      if (zone) {
        tzEl.value = zone;
        // Clear 按钮走 form.reset()，值会还原成 defaultValue ——
        // 这里一并设上，否则清一次就把时区丢了。
        tzEl.defaultValue = zone;
      }
    }

    var clearBtn = form.querySelector('[data-clear]');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        form.reset();
        hideResult();
        if (status) status.textContent = '';
        // 「输入即算」的工具清空后要重算一次：参考实现里清空输入框，
        // 结果立刻变成「现在」的那一份。
        if (form.dataset.live === '1') submit(true);
      });
    }

    var copyBtn = document.getElementById('api-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        copyText(outBody ? outBody.textContent : '').then(function () {
          // 按钮里是一个图标（不是文字），所以「复制成功」靠改类名表现，
          // 别去改 textContent —— 那样会把图标整个换掉。
          copyBtn.classList.add('is-copied');
          setTimeout(function () { copyBtn.classList.remove('is-copied'); }, 1200);
        });
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      submit(false);
    });

    // 「输入即算」：改一个输入就自动提交一次（去抖 300ms）。
    // 参考实现的工具都是改一个输入立刻出结果，服务端实现的工具也该有同样的手感。
    // 只有注册表里标了 api_live 的工具才开 —— 生成密钥、bcrypt 那类不算，
    // 自动触发会白烧 CPU（见 src/registry/mod.rs 的 Tool::api_live）。
    if (form.dataset.live === '1') {
      var timer = null;
      var schedule = function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { timer = null; submit(false); }, 300);
      };
      form.addEventListener('input', schedule);
      form.addEventListener('change', schedule);
      // 首屏先算一次（原版打开页面就出结果）。失败不弹错误提示：
      // 空输入本来就是「还没填」，不是错误。
      if (!form.querySelector('input[type=file]')) submit(true);
    }

    // 「现在」在跳：有些工具在输入框**空着**的时候显示的是当前时刻，
    // 而且那一格是**每秒都在变**的。
    //
    // 参考实现的 date-time-converter 就是这样：输入框空着，十行结果显示
    // 此刻的时刻，一秒跳一格；填了值就换成解析出来的时刻，不再跳。
    // （实测原版：空着时连采五帧每秒一格；填了值之后连采四帧纹丝不动。）
    //
    // 我们这边结果是**服务端**算的（一次请求一张表），所以「跳」只能是
    // 前端定时再问一次服务端。间隔与条件都来自注册表
    // （见 src/registry/mod.rs 的 Tool::api_refresh → 模板上的
    // data-refresh / data-refresh-field）。
    var refreshMs = parseInt(form.dataset.refresh || '0', 10);
    var refreshField = form.dataset.refreshField || '';
    if (refreshMs > 0 && refreshField) {
      var tick = function () {
        var el = form.elements[refreshField];
        // 判据跟服务端一致：只有**完全为空**才算「现在」。
        // 只打了空格的那种在服务端会走「解析失败」，别在这儿一秒问一次。
        if (!el || el.value !== '') return;
        submit(true);
      };
      var scheduleTick = function () {
        // 对齐到整秒：不然显示出来的时刻会比真实时刻慢最多一秒
        //（setInterval(1000) 是从挂上去那一刻开始算的）。
        var delay = refreshMs - (Date.now() % refreshMs);
        setTimeout(function () {
          tick();
          scheduleTick();
        }, delay);
      };
      scheduleTick();
    }

    function payload() {
      var data = {};
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name) return;
        // 勾选框一律发 true / false：不勾也得把这个键发出去，
        // 否则 handler 分不清「用户选了 false」和「这个字段根本没传」。
        if (el.type === 'checkbox') { data[el.name] = el.checked; return; }
        if (el.type === 'number') { data[el.name] = el.value === '' ? null : Number(el.value); return; }
        if (el.type === 'file') { data[el.name] = el.files && el.files[0] ? el.files[0] : null; return; }
        data[el.name] = el.value;
      });
      return data;
    }

    function submit(silent) {
      var body_ = payload();
      // File 字段走 multipart，其余走 JSON。
      var hasFile = Object.keys(body_).some(function (k) { return body_[k] instanceof File; });

      // silent 的那几次（首屏自动算、清空后重算、每秒刷新）用户没在等结果，
      // 别让 Run 按钮每秒闪一次「Loading…」—— 一秒一闪，比不跳还晃眼。
      if (!silent) setBusy(true);
      var req;
      if (hasFile) {
        var fd = new FormData();
        Object.keys(body_).forEach(function (k) {
          var v = body_[k];
          fd.append(k, v instanceof File ? v : (v === null ? '' : String(v)));
        });
        req = fetch(body.dataset.toolApi, { method: 'POST', body: fd });
      } else {
        req = fetch(body.dataset.toolApi, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body_)
        });
      }

      req.then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, json: j }; });
      }).then(function (res) {
        if (!res.ok) throw new Error(describeError(res.json, res.ok));
        render(res.json);
        setStatus('');
      }).catch(function (err) {
        // silent：自动触发的那次（首屏、空输入）失败时不打扰用户。
        if (!silent) setStatus(String(err && err.message || err), true);
      }).then(function () {
        if (!silent) setBusy(false);
      });
    }

    function render(response) {
      if (!response) {
        hideResult();
        return;
      }

      // 服务端统一包了一层 {ok, data} / {ok, error}，真正要渲染的是 data。
      // 直接把 envelope 丢进来会让下面三个键全部落空，
      // 结果就是整个响应被 JSON.stringify 成一坨原始 JSON 贴到页面上。
      var json = response;
      if (json && typeof json === 'object' && json.data !== undefined && json.ok !== undefined) {
        json = json.data;
      }

      // 各形状各走各的路。
      //
      // 行式结果不进 Output 卡片。服务端没给 rows 时（hash-text 只选了单个
      // 算法就是这种），行式渲染器不接手，落回普通输出 —— 否则结果会凭空消失。
      if (rowsMode) {
        if (renderRows(json)) return;
      } else if (kind === 'text' || kind === 'textarea' || kind === 'bare') {
        renderText(json);
        return;
      } else if (kind === 'lines') {
        renderLines(json);
        return;
      } else if (kind === 'keypair') {
        renderKeyPair(json);
        return;
      } else if (kind === 'tokens') {
        renderTokens(json);
        return;
      }

      renderCard(json);
    }

    /** 把结果区藏起来（清空表单、出错时用）。 */
    function hideResult() {
      if (resultEl) resultEl.hidden = true;
      if (rowsHost) rowsHost.hidden = true;
    }

    /** 取出结果的「主值」—— 服务端统一放在 output 里。 */
    function primaryOf(json) {
      if (json === null || json === undefined) return '';
      if (typeof json !== 'object') return String(json);
      if (json.output === undefined || json.output === null) return '';
      return String(json.output);
    }

    /**
     * 默认形状：一张「Output」卡片。
     *
     * 卡片里是主结果（output）+ 补充信息表（table）。
     * 两者都存在时必须都显示 —— 只渲染 table 会把 output 吃掉，
     * 用户看不到密文，只能在源数据里翻。
     */
    function renderCard(json) {
      if (!outBody) return;
      Dom.clear(outBody);

      if (!json || typeof json !== 'object') {
        outBody.textContent = json === null || json === undefined ? '' : String(json);
        if (resultEl) resultEl.hidden = false;
        return;
      }

      if (json.output !== undefined && json.output !== null && String(json.output) !== '') {
        outBody.appendChild(Dom.h('div.output-primary', { text: String(json.output) }));
      }

      if (json.table) {
        var table = Dom.h('table.output-table');
        var labels = [];
        Object.keys(json.table).forEach(function (k) {
          var v = json.table[k];
          labels.push(k);
          table.appendChild(Dom.h('tr', null,
            Dom.h('td', { text: k }),
            Dom.h('td', { text: v === null || v === undefined ? '' : String(v) })));
        });
        outBody.appendChild(table);
        fitLabelColumn(table, labels);
      } else if (json.output === undefined || json.output === null || String(json.output) === '') {
        if (json.html) {
          outBody.innerHTML = json.html;
        } else {
          outBody.appendChild(Dom.h('pre.output-raw', { text: JSON.stringify(json, null, 2) }));
        }
      }
      if (resultEl) resultEl.hidden = false;
    }

    /**
     * 标签列按最长的那个标签定宽。
     *
     * .output-table 是 table-layout: fixed —— 列宽**只由第一行决定**，
     * 浏览器不会替我们按内容算宽度。标签列写死 150px 的话，
     * 「America/Argentina/ComodRivadavia」这种标签装不下，
     * 只能从词中间断（iana-timezone-index 的时区名就是这么断的）。
     *
     * 这里自己量一遍：拿一个跟标签同样字体的探针元素，逐个量宽度取最大值，
     * 通过 --label-w 交给 CSS（.output-table td:first-child 读它）。
     * 标签短的表（MD5、SHA-1 那些）量出来比 150px 还窄，就不设 ——
     * 样子跟以前一模一样。
     */
    function fitLabelColumn(table, labels) {
      if (!labels.length) return;
      var cell = table.querySelector('td');
      if (!cell || !table.parentNode) return;
      var cs = getComputedStyle(cell);
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:0;top:0;';
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.fontStyle = cs.fontStyle;
      probe.style.letterSpacing = cs.letterSpacing;
      // 探针挂在表外面（挂进 <tr> 里是无效 HTML，会被浏览器挪走）
      table.parentNode.appendChild(probe);
      var widest = 0;
      for (var i = 0; i < labels.length; i++) {
        probe.textContent = labels[i];
        var w = probe.getBoundingClientRect().width;
        if (w > widest) widest = w;
      }
      probe.parentNode.removeChild(probe);
      // 加上单元格的内边距（左右各 8px）和一点余量
      var need = Math.ceil(widest + 20);
      // 标签短就不用动（还是 150px，样子跟以前一样）。
      // 特别长的（>400px）也不硬撑，让它折行 —— 那种标签本来就是一整句话。
      if (need > 150 && need <= 400) {
        table.style.setProperty('--label-w', need + 'px');
        // 标签长到容器装不下时（窄屏上表格只有 245px 宽），让整张表比容器宽一点，
        // 在结果区里横向滚 —— 结果区本来就有 overflow:auto。
        // 不这么做的话，标签列会被压回 150px，时区名只能从中间断。
        table.style.minWidth = (need + 160) + 'px';
      }
    }

    /**
     * 文字形状：一个**只读输入框**。
     *
     * 原版的 hmac-generator / encryption / bcrypt 的结果都长这样 ——
     * `c-input-text` 或 `input-copyable`，不是一张装着结果的卡片。
     * 差别看着小：一个是「界面上多了一个框」，一个是「界面上多了一段文字」。
     *
     * 「只读输入框」这一族在原版里又分三份，这里跟着分：
     *   text     单行，标签在上（hmac-generator）
     *   textarea 三行等宽，标签在上（encryption）
     *   bare     单行，**没有标签**，文字居中（bcrypt）
     */
    function renderText(json) {
      if (!resultEl) return;
      ensureTextDom();

      var label = document.getElementById('api-result-label');
      // 加密工具的标题随模式变（加密 → 「加密后的文本」，解密 → 「解密后的文本」），
      // 服务端知道自己算的是哪个，直接把翻好的文案带回来。
      if (label && json && json.meta && json.meta.result_label) {
        label.textContent = String(json.meta.result_label);
      }
      var ta = document.getElementById('api-text-output');
      if (ta) ta.value = primaryOf(json);
      resultEl.hidden = false;
    }

    /**
     * 文字形状的骨架：一个只读框 + 框里的复制按钮。
     *
     * 标签在不在上面，取决于形状（见 [`renderText`] 的说明）：
     * 原版 bcrypt 的结果框是 `<c-input-text :value="hashed" readonly text-center />`
     * —— 没有 `label` 属性，所以**没有标签**；别自作主张给它加一个。
     */
    function ensureTextDom() {
      if (document.getElementById('api-text-output')) return;

      var k = (resultEl && resultEl.dataset.kind) || 'text';
      var box;
      if (k === 'textarea') {
        box = Dom.h('textarea.layui-textarea', {
          id: 'api-text-output', readonly: true, rows: '3', spellcheck: 'false',
        });
      } else {
        box = Dom.h('input.layui-input', {
          id: 'api-text-output', type: 'text', readonly: true, spellcheck: 'false',
        });
      }
      var btn = Dom.h('button.copy-btn', {
        type: 'button',
        title: i18n('copy', 'Copy'),
        'aria-label': i18n('copy', 'Copy'),
      }, Dom.icon('copy', 16));
      btn.addEventListener('click', function () {
        copyText(box.value).then(function () {
          btn.classList.add('is-copied');
          setTimeout(function () { btn.classList.remove('is-copied'); }, 1200);
        });
      });

      var copyable = Dom.h('div.input-copyable', null, box, btn);
      if (k === 'bare') {
        // 原版这里没有标签：一个框就完事了。
        resultEl.appendChild(Dom.h('div.field', null, copyable));
      } else {
        resultEl.appendChild(Dom.h('div.field', null,
          Dom.h('label.field-label', { id: 'api-result-label', text: labelOf(0) }),
          copyable));
      }
    }

    /**
     * 行文字形状：一张卡片，里面一行行普通文字。
     *
     * 原版的 mac-address-lookup 是「Vendor info:」这个小标题 + 一张卡片，
     * 卡片里是厂商信息的好几行（每行一条）。
     */
    function renderLines(json) {
      if (!resultEl) return;
      ensureLinesDom();

      var body = document.getElementById('api-output-body');
      if (!body) return;
      Dom.clear(body);
      primaryOf(json).split('\n').forEach(function (line) {
        body.appendChild(Dom.h('div', { text: line }));
      });
      resultEl.hidden = false;
    }

    function ensureLinesDom() {
      if (document.getElementById('api-output-body')) return;
      resultEl.appendChild(Dom.h('div.code-label', { text: labelOf(0) }));
      resultEl.appendChild(Dom.h('div.card.api-output', null,
        Dom.h('div.output-body', { id: 'api-output-body' })));
    }

    /**
     * 密钥对形状：两个标题，各带一张代码卡。
     *
     * 原版的 rsa-key-pair-generator 就是这么排的：`<h3>Public key</h3>` +
     * 一张 TextareaCopyable，`<h3>Private key</h3>` + 另一张。
     */
    function renderKeyPair(json) {
      if (!resultEl) return;
      ensureKeyPairDom();

      var pub = document.getElementById('api-public-body');
      var priv = document.getElementById('api-private-body');
      if (pub) {
        // 公钥在 meta 里 —— 服务端 table 里的键名是按语言包取的，
        // 前端拿不到稳定的键名，只能走 meta 这条固定的路。
        pub.textContent = (json && json.meta && json.meta.public_key) || '';
      }
      if (priv) priv.textContent = primaryOf(json);
      resultEl.hidden = false;
    }

    function ensureKeyPairDom() {
      if (document.getElementById('api-public-body')) return;

      [0, 1].forEach(function (i) {
        var bodyId = i === 0 ? 'api-public-body' : 'api-private-body';
        var btnId = i === 0 ? 'api-public-copy' : 'api-private-copy';
        var pre = Dom.h('pre.code-body.mono', { id: bodyId });
        var btn = Dom.h('button.copy-btn', {
          type: 'button', id: btnId,
          title: i18n('copy', 'Copy'),
          'aria-label': i18n('copy', 'Copy'),
        }, Dom.icon('copy', 22));
        btn.addEventListener('click', function () {
          copyText(pre.textContent).then(function () {
            btn.classList.add('is-copied');
            setTimeout(function () { btn.classList.remove('is-copied'); }, 1200);
          });
        });
        resultEl.appendChild(Dom.h('div.keypair-block', null,
          Dom.h('h3.keypair-title', { text: labelOf(i) }),
          Dom.h('div.card.code-card', null, pre, btn)));
      });
    }

    /**
     * 令牌形状：一行三个（上一个 / 当前 / 下一个）。
     *
     * 原版的 otp 页面用 TokenDisplay 组件排的：三列标题 + 三个等宽按钮，
     * 当前那个字号更大。三个都能单独复制。
     */
    function renderTokens(json) {
      if (!resultEl) return;
      ensureTokensDom();

      var meta = (json && json.meta) || {};
      setToken('api-token-prev', meta.previous);
      setToken('api-token-cur', meta.code);
      setToken('api-token-next', meta.next);
      resultEl.hidden = false;
    }

    function setToken(id, value) {
      var el = document.getElementById(id);
      if (el) el.textContent = value === null || value === undefined ? '' : String(value);
    }

    function ensureTokensDom() {
      if (document.getElementById('api-token-cur')) return;

      resultEl.appendChild(Dom.h('div.token-head', null,
        Dom.h('span.token-head-prev', { text: labelOf(0) }),
        Dom.h('span.token-head-cur', { text: labelOf(1) }),
        Dom.h('span.token-head-next', { text: labelOf(2) })));

      var row = Dom.h('div.token-row');
      ['api-token-prev', 'api-token-cur', 'api-token-next'].forEach(function (id) {
        var btn = Dom.h('button.token-btn' + (id === 'api-token-cur' ? '.token-btn-current' : ''), {
          type: 'button', id: id,
        });
        btn.addEventListener('click', function () {
          copyText(btn.textContent).then(function () {
            btn.classList.add('is-copied');
            setTimeout(function () { btn.classList.remove('is-copied'); }, 1200);
          });
        });
        row.appendChild(btn);
      });
      resultEl.appendChild(row);
    }

    /** 结果区的第 n 个标题（模板通过 data-label-N 传进来）。 */
    function labelOf(n) {
      if (!resultEl) return '';
      // 别用 dataset 读 —— `data-label-0` 在 dataset 里是 `label-0`（连字符后面
      // 跟数字时 HTML 的驼峰转换规则不生效），写成 dataset.label0 会取到 undefined。
      return resultEl.getAttribute('data-label-' + n) || '';
    }

    /**
     * 行式结果：一行一个格式。
     *
     * 标签用**下拉框里的文案**（服务端已经翻好了），不是服务端给的英文 ——
     * 否则下拉写「Unix 时间戳（秒）」、下面那行写「Unix timestamp (seconds)」，
     * 两边对不上号。服务端给的 label 只在下拉里找不到对应项时兜底。
     */
    function renderRows(json) {
      // 返回值：true = 已经用行式渲染了，false = 没有行，交给普通输出。
      if (!json || typeof json !== 'object') { rowsHost.hidden = true; return false; }

      var rows = [];

      // 「JS locale date string」是浏览器本地的写法（Date.prototype.toString()），
      // 服务端不知道浏览器的时区，所以这一行由前端按 meta.utc 算 ——
      // 参考实现里它也是浏览器算的，行为一致。
      var utc = json.meta && json.meta.utc;
      if (utc) {
        var d = new Date(utc);
        if (!isNaN(d.getTime())) {
          rows.push({ label: 'JS locale date string', value: d.toString() });
        }
      }

      (json.rows || []).forEach(function (r) {
        rows.push({
          key: r.key,
          label: optionText(r.key) || r.label || r.key,
          value: r.value === null || r.value === undefined ? '' : String(r.value),
        });
      });

      if (!rows.length) {
        // 服务端只回了一个 output（hash-text 只选了单个算法时就是这种）——
        // 照样按行式排，只是只有一行。排法不变，用户还是一眼看到
        // 「算法名 + 值 + 复制按钮」，而不是突然冒出一张 Output 卡片。
        var one = primaryOf(json);
        if (!one) { rowsHost.hidden = true; return false; }
        var oneLabel = '';
        // 单独选一种算法时，算法名在 `meta.algorithm` 里（table 是空的）。
        // 没有它这一行的标签就是空的 —— 看着像渲染坏了。
        if (json.meta && json.meta.algorithm) {
          oneLabel = optionText(json.meta.algorithm) || json.meta.algorithm;
        }
        if (!oneLabel && json.table) {
          var keys = Object.keys(json.table);
          if (keys.length === 1) oneLabel = optionText(keys[0]) || keys[0];
        }
        rows.push({ key: 'single', label: oneLabel, value: one });
      }

      // 行与行一一对应：key 相同的行**复用节点**，只改文字和值。
      // （别用 Dom.clear 全拆了重建 —— 理由见 rowNodes 那儿的注释。）
      //
      // 标签列宽按工具来（date-time-converter 150px，hash-text 120px）——
      // 写在行上的内联样式里，盖过 .field-row-wide 的默认值。
      // 对齐也按工具来：date-time-converter 的 `input-copyable` 显式写了
      // label-align="right"，hash-text 的 `n-input-group-label` 里的文字是左对齐。
      var rowLabelWidth = rowsHost.dataset.labelWidth || '150px';
      var rowLabelAlign = rowsHost.dataset.labelAlign || 'right';
      // 原版这两行的标签来自**两种不同的组件**，内边距也不一样：
      //   date-time-converter → c-input-text → c-label，标签带 `pr-12px`（右边 12px）；
      //   hash-text          → n-input-group-label，是个带边框的格子，
      //                          左右各 12px（实测 padL=12px / padR=12px）。
      // 左对齐的（hash-text）要补上左边的 12px，文字才落在和原版一样的位置。
      var rowClass = 'div.field-row.field-row-wide' + (rowLabelAlign === 'left' ? '.field-row-cell-label' : '');

      // 参考实现里「输入 → 结果」之间有一条 n-divider，这里照样留一条
      if (!rowDivider) rowDivider = Util.divider();

      var want = [rowDivider];
      rows.forEach(function (r) {
        // key 优先；没有 key 的（JS locale date string 那行）拿标签当 key
        var key = r.key || r.label;
        var node = rowNodes[key];
        if (!node) {
          var input = Dom.h('input.layui-input', {
            type: 'text', readonly: true, value: r.value,
          });
          var label = Dom.h('label.field-label', { text: r.label });
          var row = Dom.h(rowClass, { style: { '--field-label-width': rowLabelWidth, '--field-label-align': rowLabelAlign } },
            label,
            input,
            Util.copyButton(function () { return input.value; }));
          node = rowNodes[key] = { row: row, label: label, input: input };
        } else {
          // 节点还在：只改文字和值。**别换节点** —— 换了焦点就没了。
          if (node.label.textContent !== r.label) node.label.textContent = r.label;
          if (node.input.value !== r.value) node.input.value = r.value;
          node.row.style.setProperty('--field-label-width', rowLabelWidth);
          node.row.style.setProperty('--field-label-align', rowLabelAlign);
        }
        want.push(node.row);
      });

      // 这次没有的行，摘掉
      Object.keys(rowNodes).forEach(function (key) {
        var row = rowNodes[key].row;
        if (want.indexOf(row) >= 0) return;
        if (row.parentNode) row.parentNode.removeChild(row);
        delete rowNodes[key];
      });

      // 顺序变了才动 DOM：append 一个已经在页面里的节点等于「摘下来再插回去」，
      // 焦点可能跟着掉。顺序没变就一个字节都不碰。
      var same = rowsHost.children.length === want.length;
      if (same) {
        for (var i = 0; i < want.length; i++) {
          if (rowsHost.children[i] !== want[i]) { same = false; break; }
        }
      }
      if (!same) {
        want.forEach(function (n) { rowsHost.appendChild(n); });
      }
      rowsHost.hidden = false;
      if (resultEl) resultEl.hidden = true;
      return true;
    }

    /** 某个取值在下拉框里显示成什么（找不到就返回空串）。 */
    function optionText(value) {
      var sels = form.querySelectorAll('select');
      for (var i = 0; i < sels.length; i++) {
        var opts = sels[i].options;
        for (var j = 0; j < opts.length; j++) {
          if (opts[j].value === value) return opts[j].text;
        }
      }
      return '';
    }

    function describeError(json, ok) {
      if (json) {
        // 服务端发的是 {kind, message} 对象，直接塞给 new Error 会变成
        // "[object Object]" —— 用户什么也看不懂
        var err = json.error;
        if (typeof err === 'string' && err) return err;
        if (err && typeof err.message === 'string' && err.message) return err.message;
        if (typeof json.detail === 'string' && json.detail) return json.detail;
      }
      return 'HTTP ' + (json && json.status ? json.status : ok);
    }

    function setStatus(msg, isError) {
      if (!status) return;
      status.textContent = msg;
      status.classList.toggle('is-error', !!isError);
    }

    function setBusy(busy) {
      if (runBtn) {
        runBtn.disabled = busy;
        runBtn.textContent = busy ? i18n('loading', 'Loading') : (runBtn.dataset.label || i18n('run', 'Run'));
      }
    }
  }

  /* ---------- IPv4 共用计算 ----------

     两个 IPv4 工具（地址转换器、子网计算器）都要用的纯计算放在这里：
     一份 IANA 特殊用途地址登记表 + 几个换算函数。放在一处是为了让两个工具
     不会各写一份、慢慢走偏 —— 这跟注册表「一个 TOOLS 数组驱动全部」的
     想法是同一个。

     登记表来自 IANA 的 IPv4 Special-Purpose Address Registry
     （<https://www.iana.org/assignments/iana-ipv4-special-registry/>）。
     **不是完整的表** —— 只收了做地址类型判断真正用得上的那几段；完整表
     有二十多条（dummy 地址、PCP/TURN anycast、AS112 服务、AMT …），
     对这个工具没有增量价值。这跟本项目里 IPv6 工具（src/tools/ipv6.rs）
     的取舍是一致的。

     匹配用**最长前缀匹配**：一个地址可能同时落在好几段里
     （`192.0.0.1` 既在 `192.0.0.0/24` 里，也在更具体的段里），
     要报最具体的那一段 —— 所以不能靠表里的顺序，谁更具体谁说了算。

     kind 是给语言包用的键（各工具自己翻成中文），name 是英文兜底。
  */
  var IPV4_REGISTRY = [
    { cidr: '0.0.0.0/8', kind: 'this_host', name: 'This host on this network' },
    { cidr: '10.0.0.0/8', kind: 'private_use', name: 'Private Use' },
    { cidr: '100.64.0.0/10', kind: 'shared_address_space', name: 'Shared Address Space' },
    { cidr: '127.0.0.0/8', kind: 'loopback', name: 'Loopback' },
    { cidr: '169.254.0.0/16', kind: 'link_local', name: 'Link Local' },
    { cidr: '172.16.0.0/12', kind: 'private_use', name: 'Private Use' },
    { cidr: '192.0.0.0/24', kind: 'ietf_protocol_assignments', name: 'IETF Protocol Assignments' },
    { cidr: '192.0.2.0/24', kind: 'documentation_testnet1', name: 'Documentation (TEST-NET-1)' },
    { cidr: '192.168.0.0/16', kind: 'private_use', name: 'Private Use' },
    { cidr: '198.18.0.0/15', kind: 'benchmarking', name: 'Benchmarking' },
    { cidr: '198.51.100.0/24', kind: 'documentation_testnet2', name: 'Documentation (TEST-NET-2)' },
    { cidr: '203.0.113.0/24', kind: 'documentation_testnet3', name: 'Documentation (TEST-NET-3)' },
    { cidr: '224.0.0.0/4', kind: 'multicast', name: 'Multicast' },
    { cidr: '240.0.0.0/4', kind: 'reserved', name: 'Reserved' },
    { cidr: '255.255.255.255/32', kind: 'limited_broadcast', name: 'Limited Broadcast' }
  ];

  /** 落在登记表外的地址：公网地址 */
  var IPV4_PUBLIC = { cidr: '', kind: 'public', name: 'Public' };

  /** 点分十进制是不是合法 IPv4：四段，每段 0~255，不允许前导零。 */
  function ipIsValid(ip) {
    if (typeof ip !== 'string') return false;
    var parts = ip.trim().split('.');
    if (parts.length !== 4) return false;
    return parts.every(function (p) {
      return /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255;
    });
  }

  /** IPv4 → 32 位无符号整数；非法返回 null。 */
  function ipToInt(ip) {
    if (!ipIsValid(ip)) return null;
    return ip.trim().split('.').reduce(function (acc, part, i) {
      return acc + Number(part) * Math.pow(256, 3 - i);
    }, 0);
  }

  /** 32 位无符号整数 → IPv4 点分地址。 */
  function intToIp(num) {
    return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
  }

  /** 前缀长度 → 掩码（32 位无符号整数）。 */
  function ipMask(prefix) {
    return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  }

  /** 地址是不是落在某个网段里。 */
  function ipInNetwork(num, netNum, prefix) {
    var mask = ipMask(prefix);
    return ((num & mask) >>> 0) === ((netNum & mask) >>> 0);
  }

  /** 反向 DNS 名：192.168.1.1 → 1.1.168.192.in-addr.arpa */
  function ipToArpa(ip) {
    if (!ipIsValid(ip)) return '';
    return ip.trim().split('.').reverse().join('.') + '.in-addr.arpa';
  }

  /** IPv4 的十六进制写法（4 个字节拼成 8 位十六进制）。 */
  function ipToHex(ip) {
    return ip.trim().split('.').map(function (p) {
      return Number(p).toString(16).padStart(2, '0');
    }).join('');
  }

  /**
   * IPv4 映射地址（十六进制写法）：192.168.1.1 → ::ffff:c0a8:0101
   * 与点分写法 ::ffff:192.168.1.1 是同一个地址（RFC 4291 §2.5.5.2）。
   */
  function ipToMappedHex(ip) {
    if (!ipIsValid(ip)) return '';
    return '::ffff:' + ipToHex(ip).match(/.{4}/g).join(':');
  }

  /** IPv4 映射地址（点分写法）：192.168.1.1 → ::ffff:192.168.1.1 */
  function ipToMappedDecimal(ip) {
    if (!ipIsValid(ip)) return '';
    return '::ffff:' + ip.trim();
  }

  /**
   * 6to4 前缀（RFC 3056）：192.168.1.1 → 2002:c0a8:0101::/48
   *
   * 6to4 是把 IPv4 地址原样塞进 2002::/16 后面的 32 位里，所以
   * `2002:` 后面跟的是**整个地址的 8 位十六进制**（分成两组），
   * 不是四个单字节 —— 拆错了写出来的还是合法 IPv6，意思却完全不同。
   */
  function ipTo6to4(ip) {
    if (!ipIsValid(ip)) return '';
    return '2002:' + ipToHex(ip).match(/.{4}/g).join(':') + '::/48';
  }

  /**
   * IANA 特殊用途地址的类型（最长前缀匹配）。
   * @param {string} ip
   * @returns {?{cidr: string, kind: string, name: string}} 非法地址返回 null
   */
  function ipType(ip) {
    var num = ipToInt(ip);
    if (num === null) return null;
    var best = null;
    for (var i = 0; i < IPV4_REGISTRY.length; i++) {
      var entry = IPV4_REGISTRY[i];
      var slash = entry.cidr.indexOf('/');
      var netNum = ipToInt(entry.cidr.slice(0, slash));
      var prefix = Number(entry.cidr.slice(slash + 1));
      if (netNum === null) continue;
      if (!ipInNetwork(num, netNum, prefix)) continue;
      if (!best || prefix > best.prefix) best = { prefix: prefix, entry: entry };
    }
    return best ? best.entry : IPV4_PUBLIC;
  }

  /**
   * 有类网络划分里的 A~E 类（只看首字节）。
   * @param {string} ip
   * @returns {?string} 非法地址返回 null
   */
  function ipClass(ip) {
    if (!ipIsValid(ip)) return null;
    var first = Number(ip.trim().split('.')[0]);
    if (first < 128) return 'A';
    if (first < 192) return 'B';
    if (first < 224) return 'C';
    if (first < 240) return 'D';
    return 'E';
  }

  /** 对外暴露的 IPv4 共用计算。 */
  var Ip = {
    /** IANA 特殊用途地址登记表（未命中任何一段时用 'public'）。 */
    registry: IPV4_REGISTRY,
    isValidIpv4: ipIsValid,
    ipv4ToInt: ipToInt,
    intToIpv4: intToIp,
    mask: ipMask,
    inNetwork: ipInNetwork,
    toArpa: ipToArpa,
    toMappedHex: ipToMappedHex,
    toMappedDecimal: ipToMappedDecimal,
    to6to4Prefix: ipTo6to4,
    getType: ipType,
    getIpClass: ipClass
  };

  /* ==================================================================
     JSON 类型推断 —— 几个「JSON 转某种语言」的工具共用的一套内核
     ==================================================================

     为什么要有这一层：json-to-csharp / json-to-typescript / json-to-protobuf /
     json-to-schema 干的是同一件事 —— 把一份 JSON 变成一棵类型树，再按各自的
     语言把这棵树写出来。**类型推断**（这个值是整数还是字符串、这个对象该叫什么
     名字、两个键撞名了怎么办）是**与语言无关**的，摊开写四遍就是四份会各自
     漂移的实现 —— 改一条推断规则要改四处，漏一处就出现「C# 里是 int、
     TypeScript 里是 number」这种说不清的东西。所以推断放这里，各语言只留
     「怎么把这个节点写成那种语言」。

     节点形状：

         标量  { kind: 'scalar', type: 'boolean'|'integer'|'number'|'string'|'date'|'null',
                 width: 'int32'|'int64'|'bigint'|'float64' }
         数组  { kind: 'array', element: <节点> }
         对象  { kind: 'object', name: 'User',
                 members: [ { key: '原始的 JSON 键', name: '成员名', type: <节点> } ] }

     `width` 只在 integer / number 上有意义（整数放不放得进 int32、要不要 64 位）。
     `date` 是「字符串但形状像 ISO-8601」这一路 —— 认不认它是日期由各个语言
     自己决定（C# 认 DateTime，protobuf 的 proto3 只有 string）。
     ================================================================== */

  /**
   * ISO-8601 日期 / 日期时间的形状。
   *
   * 只看形状不看真实性 —— 2024-13-45 这种不存在的日子也算日期形状。
   * 要的是「像不像时间戳」，不是「是不是存在的时刻」。
   *
   *   YYYY-MM-DD
   *   YYYY-MM-DDTHH:MM[ :SS[.fff]][Z|±hh:mm]
   */
  var JSON_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

  /**
   * 切词：把一个原始键名拆成一个个词。PascalCase / camelCase / snake_case 都基于它。
   *
   * 切词规则：
   *   1. 分隔符：连字符、下划线、空格、点…… 一律不是 [A-Za-z0-9] 的字符都是分隔符；
   *   2. 驼峰边界：小写或数字后面跟一个大写 → 断开（fooBar → foo | Bar）；
   *   3. 缩写边界：大写 + 大写 + 小写 → 在后一个大写前断开（HTTPServer → HTTP | Server）；
   *   4. 数字边界：字母 ↔ 数字之间断开（foo2bar → foo | 2 | bar）。
   *
   * @param {string} str
   * @returns {string[]}
   */
  function jsonSplitWords(str) {
    var s = String(str == null ? '' : str);
    var words = [];
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (!/[A-Za-z0-9]/.test(ch)) {
        if (cur) { words.push(cur); cur = ''; }
        continue;
      }
      if (cur) {
        var prev = s.charAt(i - 1);
        var next = i + 1 < s.length ? s.charAt(i + 1) : '';
        var boundary = false;
        if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(ch)) {
          boundary = true;                                    // 驼峰边界
        } else if (/[A-Z]/.test(prev) && /[A-Z]/.test(ch) && /[a-z]/.test(next)) {
          boundary = true;                                    // 缩写边界
        } else if (/[0-9]/.test(prev) !== /[0-9]/.test(ch)) {
          boundary = true;                                    // 数字边界
        }
        if (boundary) { words.push(cur); cur = ''; }
      }
      cur += ch;
    }
    if (cur) words.push(cur);
    return words;
  }

  /**
   * PascalCase：每个词首字母大写、其余小写。
   * 数字开头的词保持数字开头（2fa → 2 | fa → 2Fa），后面再由 sanitizeIdentifier 补 _ 前缀。
   */
  function jsonToPascalCase(str) {
    var words = jsonSplitWords(str);
    var out = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var head = w.charAt(0);
      var tail = w.substr(1).toLowerCase();
      out += (head >= '0' && head <= '9') ? head + tail : head.toUpperCase() + tail;
    }
    return out;
  }

  /** camelCase：跟 PascalCase 同样的切词，首词首字母小写。 */
  function jsonToCamelCase(str) {
    var p = jsonToPascalCase(str);
    if (!p) return p;
    var head = p.charAt(0);
    return head.toLowerCase() + p.substr(1);
  }

  /**
   * 标识符清洗（与语言无关的那部分）：非 [A-Za-z0-9_] 的字符换成 _，
   * 数字开头补 _ 前缀，空串给个占位。
   *
   * 各语言自己还要做的事（关键字加前缀、类型名不许与某个词撞……）由调用方
   * 在这之后接着做 —— 这一层只管「变成一个合法标识符的形状」。
   */
  function jsonSanitizeIdentifier(name) {
    var s = String(name == null ? '' : name).replace(/[^A-Za-z0-9_]/g, '_');
    if (!s) s = '_';
    if (s.charAt(0) >= '0' && s.charAt(0) <= '9') s = '_' + s;
    return s;
  }

  /** 是不是一个普通的 JSON 对象（不是数组、不是 null） */
  function jsonIsPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  /** 字符串是不是 ISO-8601 日期/日期时间的形状 */
  function jsonIsIsoDate(str) {
    return JSON_ISO_DATE_RE.test(String(str == null ? '' : str));
  }

  /**
   * 标量值 → 中立的类型标签。
   *
   * 整数按大小分三档：int32 放得下、int64 放得下、再大就是 bigint
   * （JSON 的双精度到 2^53 就到头了，再往上的整数解析时已经丢过精度，
   * 这里只是把「很大」如实标出来，不假装精确）。
   */
  function jsonInferScalar(value) {
    if (value === null) return { kind: 'scalar', type: 'null' };
    switch (typeof value) {
      case 'boolean':
        return { kind: 'scalar', type: 'boolean' };
      case 'number': {
        if (!Number.isInteger(value)) return { kind: 'scalar', type: 'number', width: 'float64' };
        if (value >= -2147483648 && value <= 2147483647) {
          return { kind: 'scalar', type: 'integer', width: 'int32' };
        }
        // long 的上界写的是 < 2^63：JS 的 number 是双精度，2^63 正好可表示，
        // 而 long.MaxValue 是 2^63-1，所以要用「小于 2^63」而不是「小于等于」。
        if (value >= -9223372036854775808 && value < 9223372036854775808) {
          return { kind: 'scalar', type: 'integer', width: 'int64' };
        }
        return { kind: 'scalar', type: 'integer', width: 'bigint' };
      }
      case 'string':
        return jsonIsIsoDate(value)
          ? { kind: 'scalar', type: 'date' }
          : { kind: 'scalar', type: 'string' };
      default:
        return { kind: 'scalar', type: 'null' };
    }
  }

  /**
   * 开一个新类型：名字洗成合法标识符，跟已有的重名就加数字后缀。
   *
   * 重名是必然的：两个不同的键（"user-name" 与 "user_name"）转成同一个类型名，
   * 生成两份一模一样的类型就编译不过。
   */
  function jsonNewTypeName(ctx, nameHint, opts) {
    var base = opts.sanitizeType(jsonToPascalCase(nameHint));
    if (!base || base === '_') base = opts.sanitizeType(jsonToPascalCase(opts.rootName));
    var name = base;
    var i = 2;
    while (ctx.usedTypeNames[name]) { name = base + i; i++; }
    ctx.usedTypeNames[name] = true;
    return name;
  }

  /** 同一个对象里的成员名不能重样，撞了就加数字后缀 */
  function jsonUniqueMemberName(name, used) {
    var candidate = name;
    var i = 2;
    while (used[candidate]) { candidate = name + i; i++; }
    used[candidate] = true;
    return candidate;
  }

  /**
   * 一个 JSON 值对应的类型节点。
   *
   * 对象在这里被展开成一个新类型（类型名用属性名做提示）。
   *
   * @param {object} ctx
   * @param {*} value
   * @param {string} nameHint 生成类型名时的提示（一般是属性名）
   * @param {object} opts
   * @returns {object} 节点
   */
  function jsonBuildType(ctx, value, nameHint, opts) {
    if (value === null) return { kind: 'scalar', type: 'null' };

    if (Array.isArray(value)) {
      if (!value.length) {
        // 空数组：元素类型无从推断 → 元素按「未知对象」算
        return { kind: 'array', element: { kind: 'scalar', type: 'null' } };
      }
      // 只看**第一个**元素：数组里元素类型不一致时没有公共类型可取。
      // 与其编一个「object」，不如给出最可能的类型。
      return { kind: 'array', element: jsonBuildType(ctx, value[0], nameHint, opts) };
    }

    if (jsonIsPlainObject(value)) {
      return jsonBuildObject(ctx, value, nameHint, opts);
    }

    return jsonInferScalar(value);
  }

  /**
   * 把一个 JSON 对象展开成一个类型节点。
   *
   * @returns {{kind: 'object', name: string, members: Array}}
   */
  function jsonBuildObject(ctx, obj, nameHint, opts) {
    var node = { kind: 'object', name: jsonNewTypeName(ctx, nameHint, opts), members: [] };
    ctx.defs.push(node);
    var usedNames = Object.create(null);
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var raw = opts.pascalCase ? jsonToPascalCase(key) : String(key);
      var name = jsonUniqueMemberName(opts.sanitizeMember(raw), usedNames);
      node.members.push({
        key: key,
        name: name,
        type: jsonBuildType(ctx, obj[key], key, opts)
      });
    }
    return node;
  }

  /**
   * 推断整份 JSON 的类型树。
   *
   * @param {*} data 解析好的 JSON 值
   * @param {object} [opts]
   * @param {string} [opts.rootName] 顶层是数组/标量时的根类型名
   * @param {boolean} [opts.pascalCase] 成员名用 PascalCase（默认 true）
   * @param {function} [opts.sanitizeMember] 成员名的语言相关清洗
   * @param {function} [opts.sanitizeType] 类型名的语言相关清洗
   * @returns {{root: object, defs: Array}} defs 是全部对象类型（按生成顺序）
   */
  function jsonInferDocument(data, opts) {
    opts = opts || {};
    if (opts.rootName === undefined) opts.rootName = 'Root';
    if (opts.pascalCase === undefined) opts.pascalCase = true;
    if (!opts.sanitizeMember) opts.sanitizeMember = jsonSanitizeIdentifier;
    if (!opts.sanitizeType) opts.sanitizeType = jsonSanitizeIdentifier;

    var ctx = { defs: [], usedTypeNames: Object.create(null) };
    var root;
    if (Array.isArray(data)) {
      if (!data.length) {
        root = { kind: 'array', element: { kind: 'scalar', type: 'null' } };
      } else {
        root = { kind: 'array', element: jsonBuildType(ctx, data[0], opts.rootName, opts) };
      }
    } else if (jsonIsPlainObject(data)) {
      root = jsonBuildObject(ctx, data, opts.rootName, opts);
    } else {
      root = jsonInferScalar(data);
    }
    return {
      root: root,
      defs: ctx.defs,
      /** 预留一个唯一的类型名 —— 调用方要自己造一个包装类型时用（比如 C# 的根类）。 */
      newTypeName: function (hint) { return jsonNewTypeName(ctx, hint, opts); }
    };
  }

  /** 对外暴露的 JSON 类型推断内核。 */
  var JsonInfer = {
    splitWords: jsonSplitWords,
    toPascalCase: jsonToPascalCase,
    toCamelCase: jsonToCamelCase,
    sanitizeIdentifier: jsonSanitizeIdentifier,
    isPlainObject: jsonIsPlainObject,
    isIsoDate: jsonIsIsoDate,
    inferScalar: jsonInferScalar,
    uniqueMemberName: jsonUniqueMemberName,
    infer: jsonInferDocument
  };

  /* ---------- 对外接口 ----------
     必须放在所有 helper 定义之后：`var` 会提升，若在这里赋值，
     ItTools.dom / ItTools.util 会捕获到尚未初始化的 undefined。 */
  window.ItTools = {
    register: register,
    mountAll: mountAll,
    unmountAll: unmountAll,
    /** 少量工具之间共用的 DOM 小工具。 */
    dom: Dom,
    /** 共用的字段块、复制按钮、随机数、字节/进制换算等。 */
    util: Util,
    /** 两个 IPv4 工具共用的换算与 IANA 特殊用途地址登记表。 */
    ip: Ip,
    /** 几个「JSON 转某种语言」的工具共用的类型推断内核。 */
    jsonInfer: JsonInfer,
    /** 各工具把纯逻辑挂到这里，node 侧的 jsdom 测试直接调用（见 test/js/）。 */
    logic: {},
    i18n: i18n,
    /** 工具模块的文案翻译：ItTools.t('<slug>')('key', 'English') */
    t: toolText,
    download: download,
    copyText: copyText
  };

  /* ---------- 启动 ---------- */

  var booted = false;

  function boot() {
    if (!document.getElementById('layout')) return;
    // 每个 init 都在元素上挂监听，boot 跑两遍就等于挂两遍 —— 分类折叠尤其致命：
    // 一次点击触发两个 handler，各自把 aria-expanded 翻一次，等于什么都没发生。
    if (booted) return;
    booted = true;

    initTheme();
    syncKbd();
    initMenu();
    initNavGroups();
    initSidebarScroll();
    initLang();
    initFavoriteButtons();
    initPalette();
    initApiForm();

    loadToolIndex().then(function () {
      renderFavorites();
      syncFavButtons();
      // 收藏组插完才能还原侧栏位置（见 initSidebarScroll 的说明）
      restoreSidebarScroll();
    });

    window.ItTools.mountAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();