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

  /* ---------- 图片编解码共用内核 ----------
     「图片压缩」与「图片格式转换」两个工具共用这一份：
     认格式、算目标尺寸、算省了多少、画进 canvas 再编码成 Blob。

     为什么放在这里而不是两个工具各写一份：这两个工具做的事情有九成是重合的
     （读文件 → 认格式 → 解码 → 缩放 → 编码 → 报体积），
     各写一份的话，改了压缩算法就得记得改两处 ——
     而两处迟早会不一样，不一样的时候没人知道该信哪个。
     这跟 ItTools.jsonInfer（四个 json 转语言工具共用）是同一个道理。 */

  /** 支持的输出格式 —— 浏览器原生能编的那几种。 */
  var IMAGE_FORMATS = [
    // JPEG 没有 alpha 通道：透明区域必须先铺背景色，否则会变成黑色。
    { id: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', lossy: true, alpha: false, encoder: 'native', previewable: true },
    // WebP 有 alpha 通道，也能调质量。
    { id: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp', lossy: true, alpha: true, encoder: 'native', previewable: true },
    // PNG 无损，画质不打折 —— 质量设置对它没有意义，界面里要把它关掉。
    { id: 'png', label: 'PNG', mime: 'image/png', ext: 'png', lossy: false, alpha: true, encoder: 'native', previewable: true }
  ];

  /**
   * 需要 wasm 编解码器的两种格式。
   *
   * 浏览器**只会解码 AVIF，不会编码**它；HEIC 则是解码编码都不会 ——
   * canvas.toBlob 遇到 image/avif、image/heic 会按规范**悄悄退回 PNG**
   * （实测 Chrome 156 就是这样），所以这两种格式必须自己带编码器。
   *
   * 拆成两张表而不是加个标志位：/image-compressor 与 /image-converter
   * 这两个页面**不带 wasm**，界面上不能出现这两种格式。
   */
  var IMAGE_FORMATS_WASM = [
    {
      id: 'heic',
      label: 'HEIC',
      mime: 'image/heic',
      ext: 'heic',
      lossy: true,
      alpha: true,
      // elheif（libheif + libde265 + kvazaar）。
      // **没有质量参数** —— 画质是固定的，界面上也就不该给质量滑块。
      encoder: 'elheif',
      qualityAdjustable: false,
      // 浏览器解不了 HEIC，放 <img> 预览就是一张破图。
      previewable: false,
      // wasm 编码是**同步阻塞主线程**的，大图要一秒多。
      slow: true
    },
    {
      id: 'avif',
      label: 'AVIF',
      mime: 'image/avif',
      ext: 'avif',
      lossy: true,
      alpha: true,
      // @jsquash/avif（Squoosh 的那个）。
      encoder: 'avif',
      qualityAdjustable: true,
      // 有速度档（speed 0~10）：慢档干净但要等好几秒。
      speedAdjustable: true,
      // 浏览器原生就能解 AVIF，预览没问题。
      previewable: true,
      slow: true
    }
  ];

  /** mime → 格式 id。编码器认不出来时用它把 blob 归回某个格式。 */
  var IMAGE_MIME_TO_ID = {
    'image/jpeg': 'jpeg',
    'image/webp': 'webp',
    'image/png': 'png',
    'image/heic': 'heic',
    'image/heif': 'heic',
    'image/avif': 'avif'
  };

  /** 转换页面的默认质量（1~100）。 */
  var IMAGE_DEFAULT_QUALITY = 90;

  /** AVIF 编码的默认速度档（0~10，越小越慢越干净）。 */
  var IMAGE_DEFAULT_SPEED = 6;

  /**
   * 编码失败后最多再缩几次重试。
   * 每缩一次长宽减半，面积只剩四分之一 —— 5 次足够把一张顶格的图
   * 缩到任何浏览器都吃得下的尺寸。
   */
  var IMAGE_ENCODE_MAX_SHRINK = 5;

  /**
   * 缩一次之后的尺寸。长宽各减半（向上取整），最少留 1 像素。
   * 单独拎出来是为了能测 —— 缩放的规则不该只藏在编码的回调里。
   * @param {number} width
   * @param {number} height
   * @returns {{width: number, height: number}}
   */
  function imageShrinkSize(width, height) {
    return {
      width: Math.max(1, Math.ceil(width / 2)),
      height: Math.max(1, Math.ceil(height / 2))
    };
  }

  /**
   * 按 id 取格式定义。两张表都找 —— 原生的和 wasm 的。
   * @param {string} id
   * @returns {object|null}
   */
  function imageFormatById(id) {
    var i;
    for (i = 0; i < IMAGE_FORMATS.length; i++) {
      if (IMAGE_FORMATS[i].id === id) return IMAGE_FORMATS[i];
    }
    for (i = 0; i < IMAGE_FORMATS_WASM.length; i++) {
      if (IMAGE_FORMATS_WASM[i].id === id) return IMAGE_FORMATS_WASM[i];
    }
    return null;
  }

  /**
   * 按魔数认输入格式。**看文件头不看扩展名** ——
   * 改了扩展名的文件照样要认对（跟 exif-remover 同一个道理）。
   * @param {Uint8Array} bytes
   * @returns {'jpeg'|'png'|'webp'|'gif'|'bmp'|'heic'|'avif'|null}
   */
  function imageDetectFormat(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return 'webp';
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'bmp';
    // HEIC 与 AVIF 都是 ISOBMFF（和 MP4 同一个盒子格式）：
    // 第 4~8 字节是 'ftyp'，紧跟其后的 4 个字节是「品牌」——
    // 品牌才决定它到底是 HEIC 还是 AVIF（品牌不认识的按 mif1 处理，
    // 也就是「HEIF 图像」，一律当 HEIC 解）。
    if (bytes.length >= 12 &&
        bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      var brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (brand === 'avif' || brand === 'avis') return 'avif';
      if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' ||
          brand === 'heim' || brand === 'heis' || brand === 'hevm' || brand === 'hevs' ||
          brand === 'mif1' || brand === 'msf1') {
        return 'heic';
      }
    }
    return null;
  }

  /**
   * 数一数这张图有几帧、是不是动图。
   *
   * canvas 只画得出来第一帧 —— 动图导进去会变成静图，后面几帧没了。
   * 这种事不说清楚比说清楚更糟，所以这里先把帧数查出来，
   * 界面才能告诉用户「你的动图只剩第一帧了」。
   *
   * 静态格式（以及文件头坏了的）返回 null，意思是「没有帧数这回事」。
   *
   * @param {Uint8Array} bytes
   * @returns {{frames: number, animated: boolean}|null}
   */
  function imageAnimationInfo(bytes) {
    if (!bytes || bytes.length < 16) return null;
    var format = imageDetectFormat(bytes);
    if (format === 'gif') return imageGifInfo(bytes);
    if (format === 'png') return imagePngInfo(bytes);
    if (format === 'webp') return imageWebpInfo(bytes);
    return null;
  }

  /** 读 big-endian 的无符号整数（PNG / GIF 用的是大端）。 */
  function imageReadUintBE(bytes, at, length) {
    var n = 0;
    for (var i = 0; i < length; i++) {
      if (at + i >= bytes.length) return null;
      n = n * 256 + bytes[at + i];
    }
    return n;
  }

  /** 读 little-endian 的无符号整数（WebP 的 chunk 长度用小端）。 */
  function imageReadUintLE(bytes, at, length) {
    var n = 0;
    for (var i = length - 1; i >= 0; i--) {
      if (at + i >= bytes.length) return null;
      n = n * 256 + bytes[at + i];
    }
    return n;
  }

  /**
   * GIF 的帧数。
   *
   * 结构从头到尾是「块」：0x21 开头的是扩展（里面还是一串子块），
   * 0x2C 开头的是一帧图像描述，0x3B 是结束。
   * 一帧 = 一个图像描述块。
   *
   * 调色板要特别当心：逻辑屏幕描述的 packed 字段最高位是「有没有全局调色板」，
   * 图像描述自己的 packed 字段最高位是「有没有局部调色板」——
   * **不跳过去的话，后面读到的就是调色板里的颜色值，不是块标记。**
   */
  function imageGifInfo(bytes) {
    var offset = 13; // 6 字节签名 + 7 字节逻辑屏幕描述
    var screenPacked = bytes[10];
    if (screenPacked & 0x80) {
      offset += 3 * (1 << ((screenPacked & 0x07) + 1)); // 全局调色板
    }
    var frames = 0;
    while (offset < bytes.length) {
      var marker = bytes[offset];
      if (marker === 0x3B) break; // trailer
      if (marker === 0x21) {
        // 扩展块：1 字节标签，后面一串子块（每个子块是「长度 + 数据」）
        offset += 2;
        while (offset < bytes.length && bytes[offset] !== 0) {
          offset += bytes[offset] + 1;
        }
        offset += 1;
        continue;
      }
      if (marker === 0x2C) {
        frames++;
        var imagePacked = bytes[offset + 9];
        offset += 10; // 图像描述符本身（分隔符 + 4 个 2 字节字段 + packed）
        if (imagePacked & 0x80) {
          offset += 3 * (1 << ((imagePacked & 0x07) + 1)); // 局部调色板
        }
        offset += 1; // LZW 最小码长
        while (offset < bytes.length && bytes[offset] !== 0) {
          offset += bytes[offset] + 1;
        }
        offset += 1;
        continue;
      }
      return null; // 不认识的块 —— 文件头坏了，当查不出来
    }
    if (!frames) return null;
    return { frames: frames, animated: frames > 1 };
  }

  /**
   * PNG（也含 APNG）的帧数。
   * 有 acTL 块就是 APNG，帧数写在 acTL 里；只有 IDAT 就是静态 PNG。
   */
  function imagePngInfo(bytes) {
    var offset = 8; // 8 字节签名
    while (offset + 8 <= bytes.length) {
      var length = imageReadUintBE(bytes, offset, 4);
      if (length === null) return null;
      var type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      if (type === 'acTL') {
        var frames = imageReadUintBE(bytes, offset + 8, 4);
        return frames === null ? null : { frames: frames, animated: frames > 1 };
      }
      if (type === 'IDAT') return { frames: 1, animated: false };
      offset += 12 + length;
    }
    return null;
  }

  /**
   * WebP 的帧数。
   * VP8X 块的标志位里有「动画」这一位；再往下数 ANMF 块能数出帧数，
   * 数不清就只说「是动图」，不说几帧。
   */
  function imageWebpInfo(bytes) {
    var offset = 12; // 'RIFF' + 4 字节长度 + 'WEBP'
    var animated = false;
    var frames = 0;
    while (offset + 8 <= bytes.length) {
      var type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      var size = imageReadUintLE(bytes, offset + 4, 4);
      if (size === null) return null;
      if (type === 'VP8X') {
        var flags = bytes[offset + 8];
        animated = !!(flags & 0x02);
        break;
      }
      if (type === 'ANIM') {
        animated = true;
        break;
      }
      if (type === 'ANMF') {
        frames++;
      }
      offset += 8 + size + (size % 2); // chunk 长度是奇数的话后面还跟一个补位字节
    }
    if (animated) return { frames: frames || 1, animated: true };
    return { frames: 1, animated: false };
  }

  /**
   * 把「最大宽/最大高」解析成正整数。空、0、负数、非法输入都算「没设」。
   * @param {*} value
   * @returns {number|null}
   */
  function imageParseDimension(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = parseInt(String(value), 10);
    if (!isFinite(n) || n <= 0) return null;
    return n;
  }

  /**
   * 等比缩放：把图缩进 maxWidth × maxHeight 的框里。
   *
   * 两个上限都空就原样返回；只给一个就按比例缩另一边。
   * **不放大** —— 把 100×100 的图放到 800×800 只会浪费体积，
   * 而且浏览器重编码时放大的图是插值出来的，并没有多出细节。
   *
   * @param {number} width 原宽
   * @param {number} height 原高
   * @param {*} maxWidth
   * @param {*} maxHeight
   * @returns {{width: number, height: number, scaled: boolean}}
   */
  function imageFitWithin(width, height, maxWidth, maxHeight) {
    var w = Math.max(1, Math.round(Number(width) || 0));
    var h = Math.max(1, Math.round(Number(height) || 0));
    var mw = imageParseDimension(maxWidth);
    var mh = imageParseDimension(maxHeight);
    if (!mw && !mh) return { width: w, height: h, scaled: false };
    var ratio = 1;
    if (mw && w > mw) ratio = Math.min(ratio, mw / w);
    if (mh && h > mh) ratio = Math.min(ratio, mh / h);
    if (ratio >= 1) return { width: w, height: h, scaled: false };
    return {
      width: Math.max(1, Math.round(w * ratio)),
      height: Math.max(1, Math.round(h * ratio)),
      scaled: true
    };
  }

  /**
   * 质量取值。0 和 1 都是合法值（0 是最低质量，1 是最高），
   * 但浏览器对 0 的处理各家不一样（有的当成 1，有的当成 0.5），
   * 所以范围收成 1~100，跟常见的图片压缩工具一致。
   * @param {*} value
   * @returns {number}
   */
  function imageClampQuality(value) {
    var n = parseInt(String(value), 10);
    if (!isFinite(n)) return 75;
    if (n < 1) return 1;
    if (n > 100) return 100;
    return n;
  }

  /**
   * 算出省了多少。
   * @param {number} before 原字节数
   * @param {number} after 新字节数
   * @returns {{beforeBytes: number, afterBytes: number, savedBytes: number, savedPercent: number, isSmaller: boolean}}
   */
  function imageSavings(before, after) {
    var b = Math.max(0, Number(before) || 0);
    var a = Math.max(0, Number(after) || 0);
    var saved = b - a;
    return {
      beforeBytes: b,
      afterBytes: a,
      savedBytes: saved,
      savedPercent: b > 0 ? (saved / b) * 100 : 0,
      isSmaller: saved > 0
    };
  }

  /**
   * 字节数 → 人类可读的大小。
   * @param {number} n
   * @returns {string}
   */
  function imageFormatBytes(n) {
    var value = Number(n);
    if (!isFinite(value) || value < 0) return '';
    if (value < 1024) return value + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    value = value / 1024;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) { value = value / 1024; i++; }
    return value.toFixed(2) + ' ' + units[i];
  }

  /**
   * 输出文件名：换扩展名，可选加后缀。
   * @param {string} name 原文件名
   * @param {string} ext 新扩展名（不带点）
   * @param {string} suffix 可选后缀
   * @returns {string}
   */
  function imageOutputName(name, ext, suffix) {
    var base = String(name || 'image');
    var dot = base.lastIndexOf('.');
    if (dot > 0) base = base.slice(0, dot);
    if (suffix) base += '-' + suffix;
    return base + '.' + ext;
  }

  /**
   * 浏览器**实际**编码出来的格式。
   *
   * canvas.toBlob 遇到不支持的 mime 会**悄悄退回 PNG**（按规范），
   * 返回的 blob.type 才是真相。老浏览器不支持 WebP 编码时，
   * 选 WebP 会拿到一张 PNG —— 不查这一下，界面就会一边显示
   * 「WebP」一边下载出 PNG 文件。
   *
   * @param {{type?: string}} blob
   * @param {string} requestedId 用户选的格式 id
   * @returns {string} 实际格式 id
   */
  function imageActualFormatId(blob, requestedId) {
    var mime = (blob && blob.type) || '';
    var got = IMAGE_MIME_TO_ID[mime];
    if (got) return got;
    return imageFormatById(requestedId) ? requestedId : 'png';
  }

  /**
   * 解码一个图片文件。
   *
   * 优先用 createImageBitmap：它能一次拿到解码好的位图，还支持
   * imageOrientation: 'from-image'（按 EXIF 里的方向摆正），
   * 而且不依赖 DOM。取不到就退回 <img> + object URL。
   *
   * @param {Blob} file
   * @returns {Promise<{source: *, width: number, height: number, close: function}>}
   */
  function imageDecode(file) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function fail(err) {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      function ok(source, width, height, close) {
        if (settled) return;
        settled = true;
        resolve({ source: source, width: width, height: height, close: close || function () {} });
      }

      if (typeof createImageBitmap === 'function') {
        try {
          createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bitmap) {
            ok(bitmap, bitmap.width, bitmap.height, function () {
              if (bitmap && typeof bitmap.close === 'function') bitmap.close();
            });
          }, fail);
          return;
        } catch (e) {
          // 老浏览器不认 imageOrientation 选项，退回 <img> 那条路
        }
      }

      var url;
      try {
        url = URL.createObjectURL(file);
      } catch (e) {
        fail(e);
        return;
      }
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        ok(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        fail(new Error('decode'));
      };
      img.src = url;
    });
  }

  /**
   * 把解码好的图画进 canvas，再按目标格式编码成 Blob。
   *
   * 浏览器给 canvas 的面积是有上限的（Chrome 大约 2.68 亿像素），
   * 超了 `toBlob` 不会报错，只是**返回 null**。
   * 要是照直报「编码失败」，一张超大的全景图就完全没法用 ——
   * 而「压缩」本来就是要把图变小的事。
   *
   * 所以这里改成：编码不成就把长宽各减半再试一次，
   * 直到成功或者缩到 1 像素为止（最多 IMAGE_ENCODE_MAX_SHRINK 次）。
   * 不写死浏览器的上限是多少 —— 各家浏览器不一样，探测一次太贵，
   * 失败了再缩比猜一个数字靠谱。
   *
   * @param {{source: *, width: number, height: number}} decoded
   * @param {object} opts
   *   opts.width / opts.height  目标尺寸
   *   opts.formatId             目标格式（jpeg / webp / png）
   *   opts.quality              质量 1~100（只有有损格式认）
   *   opts.background           背景色（目标格式没有 alpha 时才用）
   * @returns {Promise<{blob: Blob, width: number, height: number, formatId: string,
   *                    scaledToFit: boolean}>}
   */
  function imageEncode(decoded, opts) {
    var format = imageFormatById(opts.formatId) || IMAGE_FORMATS[0];
    var width = Math.max(1, Math.round(Number(opts.width) || decoded.width || 1));
    var height = Math.max(1, Math.round(Number(opts.height) || decoded.height || 1));

    return new Promise(function (resolve, reject) {
      var scaledToFit = false;
      // 还能再缩几次 —— 每次长宽都减半，面积就只剩四分之一，
      // 一次减半一般就够了，留几次兜底。这个计数是**每次调用自己的**，
      // 放在模块级会被上一张图用掉。
      var shrinksLeft = IMAGE_ENCODE_MAX_SHRINK;

      /** 画一次 canvas 并编码。拿到 null 表示这个尺寸浏览器吃不下了。 */
      function attempt(w, h) {
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas'));
          return;
        }
        // JPEG 存不下透明通道：先把背景铺满，
        // 否则 drawImage 画完的透明区域在 JPEG 里是黑的。
        if (!format.alpha) {
          ctx.fillStyle = opts.background || '#ffffff';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(decoded.source, 0, 0, w, h);

        var quality = format.lossy ? imageClampQuality(opts.quality) / 100 : undefined;
        canvas.toBlob(function (blob) {
          if (!blob) {
            if (w > 1 && h > 1 && shrinksLeft > 0) {
              shrinksLeft -= 1;
              scaledToFit = true;
              var smaller = imageShrinkSize(w, h);
              attempt(smaller.width, smaller.height);
              return;
            }
            reject(new Error('encode'));
            return;
          }
          resolve({
            blob: blob,
            width: w,
            height: h,
            formatId: imageActualFormatId(blob, format.id),
            requestedFormatId: format.id,
            mime: blob.type || format.mime,
            scaledToFit: scaledToFit
          });
        }, format.mime, quality);
      }

      attempt(width, height);
    });
  }

  /**
   * 造一个「上传图片」的卡片：文件选择框 + 拖放区 + 状态行。
   *
   * 文案由调用方给（工具自己的 t()），这个函数只管搭结构 ——
   * 它住在共用的内核里，不能自己去查语言包。
   *
   * @param {object} opts
   *   opts.accept    input[type=file] 的 accept
   *   opts.label     选择框上方的标签
   *   opts.hint      选择框下方的说明
   *   opts.onFile    拿到 File 时调用
   * @returns {{card: HTMLElement, input: HTMLInputElement, setStatus: function}}
   */
  function imageUploadCard(opts) {
    opts = opts || {};
    var card = Dom.h('div.card');
    var input = Dom.h('input', { type: 'file', accept: opts.accept || 'image/*' });
    var status = Dom.h('p.field-hint');
    var box = Dom.h('div.preview-box', null,
      Dom.h('label.field-label', { text: opts.label || '' }),
      input,
      Dom.h('p.field-hint', { text: opts.hint || '' })
    );
    card.appendChild(box);
    card.appendChild(status);

    function setStatus(message, isError) {
      status.textContent = message || '';
      status.classList.toggle('is-error', !!isError);
    }

    if (typeof opts.onFile === 'function') {
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (file) opts.onFile(file);
      });
      // 拖进来
      ['dragenter', 'dragover'].forEach(function (evt) {
        box.addEventListener(evt, function (e) {
          e.preventDefault();
          e.stopPropagation();
        });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        box.addEventListener(evt, function (e) {
          e.preventDefault();
          e.stopPropagation();
        });
      });
      box.addEventListener('drop', function (e) {
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) opts.onFile(files[0]);
      });
    }

    return { card: card, input: input, setStatus: setStatus };
  }

  /* ---------- HEIC / AVIF：wasm 编解码 ---------- */

  /**
   * elheif 的 wasm 模块 —— 初始化一次就好，之后一直用同一个。
   * null 表示还没初始化过。
   */
  var imageElheifPromise = null;

  /** AVIF 编码器的 wasm —— 跟胶水脚本放在同一个目录。 */
  var IMAGE_AVIF_WASM_URL = '/assets/lib/avif/codec/enc/avif_enc.wasm';

  /** AVIF 编码器模块 —— 第一次真要编码时才去拉那个 2.6 MB 的 wasm。 */
  var imageAvifPromise = null;

  /* ---------- 编码 worker ----------

     两个 wasm 编码器都是**同步**的：调一次就把所在线程占住。
     实测这台机器（AVIF，默认速度档）：3 MP 要 4 秒、12 MP 要 15 秒、
     48 MP 要 62 秒。

     在主线程上跑，页面就只剩一句「正在编码中」——
     滚动条不动、按钮点不动、动画停住，跟卡死了没区别。
     （这正是「AVIF 一直正在编码中」那个毛病的根因。）

     所以编码搬到 Web Worker 里（static/js/image-encoder-worker.js）。
     主线程只负责把像素交出去、把结果收回来，中间全程可交互。 */

  /** 编码 worker 的地址。 */
  var IMAGE_WORKER_URL = '/assets/js/image-encoder-worker.js';

  /** 拉 wasm / 编解码库的超时。拉不动就该报错，不能一直挂着。 */
  var IMAGE_FETCH_TIMEOUT = 120000;

  /**
   * worker 里一次任务的上限。
   * 48 MP 的图 AVIF 要一分钟，慢机器上更久 —— 给得宽松点，
   * 但不能没有：worker 卡死了界面得有个说法。
   */
  var IMAGE_WORKER_TIMEOUT = 600000;

  /** 当前那个 worker。null 表示还没建起来。 */
  var imageWorker = null;

  /** worker 任务的编号。 */
  var imageWorkerSeq = 0;

  /** 在飞的任务：id → {resolve, reject, onPhase, timer}。 */
  var imageWorkerPending = {};

  /**
   * 造一个「worker 这边不行」的错。
   *
   * 只有这一类错才值得退回主线程 —— 编码本身失败的话，
   * 在主线程上再试一次就是再卡一分钟。
   *
   * @param {string} message
   * @returns {Error}
   */
  function imageWorkerUnavailable(message) {
    var err = new Error(message);
    err.workerUnavailable = true;
    return err;
  }

  /**
   * 造一个「这个任务被换掉了」的错。
   *
   * 跟「worker 坏了」必须分开：被换掉的任务就该安静地结束。
   * 要是把它当成「worker 坏了」退到主线程上再编一遍，
   * 等于白等一分钟 —— 界面又卡住了。
   *
   * @returns {Error}
   */
  function imageWorkerSuperseded() {
    var err = new Error('superseded');
    err.superseded = true;
    return err;
  }

  /**
   * 这个浏览器有没有 Worker。
   *
   * 只判断「能不能建」，不真的建一个 ——
   * 建了不用就白建，还得多terminate一次。
   *
   * @returns {boolean}
   */
  function imageWorkerSupported() {
    return typeof Worker === 'function';
  }

  /**
   * 拿到编码 worker。
   *
   * 没有 Worker（老浏览器、jsdom 测试）就返回 null ——
   * 调用方退回主线程那条路，功能不缺，只是会卡住界面。
   *
   * @returns {Worker|null}
   */
  function imageWorkerGet() {
    if (imageWorker) return imageWorker;
    if (typeof Worker !== 'function') return null;
    try {
      imageWorker = new Worker(IMAGE_WORKER_URL);
    } catch (e) {
      return null;
    }
    imageWorker.onmessage = imageWorkerOnMessage;
    imageWorker.onerror = function (ev) {
      // 脚本层面的错（importScripts 拉不到胶水之类）。
      // worker 里自己处理过的错会回一条消息，走不到这里。
      imageWorkerReset(imageWorkerUnavailable(
        'worker error: ' + (ev && ev.message ? ev.message : 'unknown')
      ));
    };
    return imageWorker;
  }

  /**
   * worker 回消息。
   *
   * 两种消息：带 phase 的是「进度」（还在拉库 / 开始编码了，
   * 拉库那条还带着 loaded / total，页面上据此画进度条），
   * 带 ok 的是「结果」。进度消息不影响 promise 的兑现。
   *
   * @param {MessageEvent} ev
   */
  function imageWorkerOnMessage(ev) {
    var msg = ev.data || {};
    var entry = imageWorkerPending[msg.id];
    if (!entry) return;
    if (msg.phase) {
      // 第二个参数是整条消息 —— 进度条要用的数字都在里面。
      if (entry.onPhase) entry.onPhase(msg.phase, msg);
      return;
    }
    delete imageWorkerPending[msg.id];
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error || 'encode'));
  }

  /**
   * 把 worker 换掉：干掉现在的，拒掉所有在飞的任务。
   *
   * 为什么要换而不是等：wasm 编码是同步的，**编码中途停不下来** ——
   * 唯一的办法是把 worker 整个终止掉。
   *
   * 换掉之后 wasm 会重新初始化（胶水重新 import、wasm 重新编译），
   * 但 wasm 本体走 HTTP 协商缓存（304，不重下），
   * 所以代价只有编译那几百毫秒。
   *
   * @param {Error} err 拒掉在飞任务时带的错
   */
  function imageWorkerReset(err) {
    var pending = imageWorkerPending;
    imageWorkerPending = {};
    if (imageWorker) {
      try { imageWorker.terminate(); } catch (e) { /* 已经死了就算了 */ }
      imageWorker = null;
    }
    Object.keys(pending).forEach(function (id) {
      var entry = pending[id];
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err || imageWorkerUnavailable('worker reset'));
    });
  }

  /**
   * 让 worker 干一件事。
   *
   * @param {object} msg 任务（id 由这里补上）
   * @param {Array} transfer 要转移（而不是拷贝）过去的缓冲区
   * @param {function} onPhase 阶段回调
   * @returns {Promise<object>}
   */
  function imageWorkerCall(msg, transfer, onPhase) {
    // 上一次的任务还没完 —— 干掉它。
    // 换了设置就得重编，等旧的编完再编新的等于白等一分钟。
    // （作废的活儿会被 `ticket` 拦掉，不会把界面写成「出错」。）
    if (Object.keys(imageWorkerPending).length > 0) {
      imageWorkerReset(imageWorkerSuperseded());
    }

    var worker = imageWorkerGet();
    if (!worker) return Promise.reject(imageWorkerUnavailable('no worker'));

    var id = ++imageWorkerSeq;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete imageWorkerPending[id];
        // 卡死了 —— 换掉它，下一次重新建一个。
        imageWorkerReset(imageWorkerUnavailable('timeout'));
        reject(imageWorkerUnavailable('timeout'));
      }, IMAGE_WORKER_TIMEOUT);

      imageWorkerPending[id] = {
        resolve: resolve,
        reject: reject,
        onPhase: onPhase,
        timer: timer
      };
      msg.id = id;
      try {
        worker.postMessage(msg, transfer || []);
      } catch (e) {
        delete imageWorkerPending[id];
        clearTimeout(timer);
        reject(imageWorkerUnavailable(String(e && e.message ? e.message : e)));
      }
    });
  }

  /**
   * 把一个 Uint8Array 变成能整体转移（transfer）的 ArrayBuffer。
   *
   * 能整体转移就不用拷贝 —— 一张 HEIC 可能有十几 MB，
   * 拷一次主线程要停一下。
   *
   * @param {Uint8Array} bytes
   * @returns {ArrayBuffer}
   */
  function imageOwnBuffer(bytes) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer;
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  /**
   * 初始化 elheif（libheif 的 wasm 封装）。
   *
   * elheif 挂出来的是**模块工厂** `__init__ELHEIF_MODULE(cfg)`，
   * 不是模块本身：工厂要一个配置对象，通过配置对象的
   * `onRuntimeInitialized` 回调报告「wasm 跑起来了」。
   * （npm 包自带的 pkg/index.js 就是这么写的；我们直接用胶水，
   * 省得为一个 40 行的包装文件再发明一种 vendor 机制。）
   *
   * @returns {Promise<object>} 模块实例
   */
  function imageElheifInit() {
    if (imageElheifPromise) return imageElheifPromise;
    var factory = window.__init__ELHEIF_MODULE;
    if (typeof factory !== 'function') {
      return Promise.reject(new Error('elheif unavailable'));
    }
    var p = new Promise(function (resolve, reject) {
      var mod = {};
      // 胶水跑起来的时候会调这个回调 —— 必须**在调用工厂之前**挂上，
      // 晚了就再也等不到了。
      mod.onRuntimeInitialized = function () { resolve(mod); };
      try {
        factory(mod);
      } catch (e) {
        reject(e);
      }
    });
    // 失败了下次还能重试 —— 失败的原因多半是临时的。
    p.catch(function () { if (imageElheifPromise === p) imageElheifPromise = null; });
    imageElheifPromise = p;
    return p;
  }

  /**
   * 从 elheif 解出来的帧里取出 RGBA8888 的像素。
   *
   * **elheif 给的 buffer 比图像本身长** —— 它自己的 core/src/impl.cpp 里
   * 解码完又把整个 libheif plane 原样追加了一遍（上游的 bug）：
   *
   *   if (stride == width * 4) { copy(plane, plane + stride * height); }
   *   else { 逐行压缩成 width*4 一行 }
   *   copy(plane, plane + stride * height);   ← 多出来的这一次
   *
   * 所以 buffer 的长度是 width*height*4 的两倍（stride 对齐时更少），
   * 直接 `imageData.set(frame.data)` 会抛 "offset is out of bounds"。
   * 前面 width*height*4 字节才是图像本身，后面那些是重复的。
   *
   * 单拎出来是为了能测 —— 这个取法错了，HEIC 就解不出来。
   *
   * @param {{width: number, height: number, data: *}} frame
   * @returns {{width: number, height: number, data: Uint8Array}}
   */
  function imageRgbaFromFrame(frame) {
    if (!frame) throw new Error('decode');
    var w = frame.width | 0;
    var h = frame.height | 0;
    if (!w || !h) throw new Error('decode');
    var need = w * h * 4;
    var src = frame.data instanceof Uint8Array
      ? frame.data
      : new Uint8Array(frame.data || 0);
    if (src.length < need) throw new Error('decode');
    return { width: w, height: h, data: src.subarray(0, need) };
  }

  /**
   * 解码一张 HEIC/HEIF 图。
   *
   * 浏览器解不了 HEIC（<img> 直接报错），所以走 elheif：
   * jsDecodeImage 返回 RGBA8888 的位图，我们把它画进 canvas，
   * 当作「已解码的图」交给后面的编码器。
   *
   * 解码也是**同步**的（3 MP 要 0.3 秒），所以优先在 worker 里做。
   *
   * @param {Uint8Array} bytes 文件的字节（主线程这一份）
   * @param {Blob} [blob] 文件本身。有的话优先给 worker **文件** ——
   *   Blob 克隆是按引用的（不拷数据），而且主线程这份字节原封不动：
   *   万一 worker 这边不行（脚本没加载起来、跑到一半炸了），
   *   还能退回主线程重解一遍。转移字节就做不到这个 ——
   *   转移之后主线程这份已经被分离，退不回去。
   * @returns {Promise<{source: *, width: number, height: number, close: function}>}
   */
  function imageDecodeHeic(bytes, blob) {
    if (!imageWorkerSupported()) return imageDecodeHeicOnMainThread(bytes);

    if (blob && typeof blob.arrayBuffer === 'function') {
      return imageWorkerCall({
        op: 'decode',
        format: 'heic',
        blob: blob
      }, []).then(function (res) {
        return imageRgbaToSource(new Uint8Array(res.data), res.width, res.height);
      }, function (err) {
        // 只有「worker 这边不行」才退回主线程 ——
        // 文件本身解不开的话，在主线程上再试一次也是白试。
        if (err && err.workerUnavailable) return imageDecodeHeicOnMainThread(bytes);
        throw err;
      });
    }

    // 没有文件可给 —— 只能转移字节。主线程这份就废了，
    // 所以这条路没有退回主线程的余地。
    var buf = imageOwnBuffer(bytes);
    return imageWorkerCall({
      op: 'decode',
      format: 'heic',
      data: buf
    }, [buf]).then(function (res) {
      return imageRgbaToSource(new Uint8Array(res.data), res.width, res.height);
    }, function (err) {
      if (err && err.workerUnavailable) {
        // 字节已经转移走了，这里拿到的可能是个已被分离的空视图。
        throw new Error('decode');
      }
      throw err;
    });
  }

  /**
   * 主线程上解码 HEIC —— 没有 Worker 时的退路。
   *
   * @param {Uint8Array} bytes
   * @returns {Promise<{source: *, width: number, height: number, close: function}>}
   */
  function imageDecodeHeicOnMainThread(bytes) {
    return imageElheifInit().then(function (mod) {
      var out;
      try {
        out = mod.jsDecodeImage(bytes);
      } catch (e) {
        throw new Error('decode');
      }
      if (!out || out.err || !out.data || !out.data.length) {
        throw new Error(out && out.err ? String(out.err) : 'decode');
      }
      var frame = imageRgbaFromFrame(out.data[0]);
      return imageRgbaToSource(frame.data, frame.width, frame.height);
    });
  }

  /**
   * 把 RGBA 像素画进 canvas，当成「已解码的图」。
   *
   * @param {Uint8Array} data
   * @param {number} width
   * @param {number} height
   * @returns {{source: *, width: number, height: number, close: function}}
   */
  function imageRgbaToSource(data, width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    var imageData = ctx.createImageData(width, height);
    imageData.data.set(data);
    ctx.putImageData(imageData, 0, 0);
    return {
      source: canvas,
      width: width,
      height: height,
      close: function () {}
    };
  }

  /**
   * 把 RGBA 像素画成一个能直接放进页面的 canvas（预览用）。
   *
   * @param {Uint8Array} data
   * @param {number} width
   * @param {number} height
   * @returns {HTMLCanvasElement|null}
   */
  function imageRgbaCanvas(data, width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var imageData = ctx.createImageData(width, height);
    imageData.data.set(data);
    ctx.putImageData(imageData, 0, 0);
    canvas.style.maxWidth = '100%';
    return canvas;
  }

  /**
   * 把已解码的图另画一份到新的 canvas —— 拿来做预览。
   *
   * 另画一份，而不是把 decoded.source 直接塞进页面：
   * 那块画布后面还要拿来编码（drawImage 的来源），
   * 而且一个元素同一时刻只能待在一个地方。
   *
   * @param {{source: *, width: number, height: number}} decoded
   * @returns {HTMLCanvasElement|null}
   */
  function imageSourceCanvas(decoded) {
    if (!decoded || !decoded.source) return null;
    try {
      var canvas = document.createElement('canvas');
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      var ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(decoded.source, 0, 0, decoded.width, decoded.height);
      canvas.style.maxWidth = '100%';
      return canvas;
    } catch (e) {
      return null;
    }
  }

  /**
   * 解码一个图片文件 —— 认得出是 HEIC 就走 wasm，其余走浏览器原生。
   *
   * AVIF 不用特别处理：浏览器原生就能解（Chrome 85+ / Firefox 93+ / Safari 16.4+）。
   *
   * 页面没带 elheif（比如普通的转换页）时，HEIC 就走原生那条路 ——
   * 解不出来，由界面报错，而不是去喊一个不存在的编解码器。
   *
   * @param {Blob} file
   * @param {Uint8Array} bytes 文件的字节（用来认格式）
   * @returns {Promise<{source: *, width: number, height: number, close: function}>}
   */
  function imageDecodeAny(file, bytes) {
    var format = imageDetectFormat(bytes);
    if (format === 'heic' && typeof window.__init__ELHEIF_MODULE === 'function') {
      // 文件也一起给过去：worker 读文件不用主线程那份字节，
      // 万一 worker 不行，主线程还能拿字节重解一遍。
      return imageDecodeHeic(bytes, file);
    }
    return imageDecode(file);
  }

  /**
   * 把一张已解码的图画进 canvas，取出 RGBA8888 的字节。
   *
   * 两个 wasm 编码器要的都是这个形状：宽、高、每像素 4 字节的 RGBA。
   *
   * @param {*} source 已解码的图（ImageBitmap / HTMLImageElement / canvas）
   * @param {number} width
   * @param {number} height
   * @returns {Uint8Array}
   */
  function imageSourceToRgba(source, width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.drawImage(source, 0, 0, width, height);
    // getImageData 给的是 Uint8ClampedArray，wasm 要的是 Uint8Array ——
    // 复制一份，别把 canvas 的内部缓冲直接递出去。
    return new Uint8Array(ctx.getImageData(0, 0, width, height).data);
  }

  /**
   * 界面上的质量（1~100，越大越好）→ AVIF 的 cqLevel（0~63，越小越好）。
   *
   * 单拎出来是为了能测 —— 这个映射错了，滑块就是反的。
   *
   * @param {number} quality
   * @returns {number} 0~63
   */
  function imageAvifCqLevel(quality) {
    var q = imageClampQuality(quality);
    return Math.round((100 - q) * 63 / 99);
  }

  /**
   * 把速度档夹到 0~10。
   * @param {*} value
   * @returns {number}
   */
  function imageClampSpeed(value) {
    var n = parseInt(String(value), 10);
    if (!isFinite(n)) return IMAGE_DEFAULT_SPEED;
    if (n < 0) return 0;
    if (n > 10) return 10;
    return n;
  }

  /**
   * AVIF 编码器的选项。
   *
   * 这些字段**一个都不能少** —— embind 的结构体少一个字段就抛
   * "Missing field: cqAlphaLevel"，整个编码失败。
   *
   * cqLevel 是 0~63，**0 最好**；界面上的质量是 1~100（越大越好），
   * 得反着映射。speed 是 0~10，越小越慢越干净。
   *
   * @param {number} quality
   * @param {number} speed
   * @returns {object}
   */
  function imageAvifOptions(quality, speed) {
    return {
      cqLevel: imageAvifCqLevel(quality),
      cqAlphaLevel: -1,          // -1 = 跟着 cqLevel 走
      denoiseLevel: 0,
      tileColsLog2: 0,
      tileRowsLog2: 0,
      speed: imageClampSpeed(speed),
      subsample: 1,
      chromaDeltaQ: false,
      sharpness: 0,
      tune: 0
    };
  }

  /**
   * 拿到 AVIF 编码器模块。
   *
   * 为什么要自己 fetch 那个 2.6 MB 的 wasm：胶水脚本（avif_enc.js）本身
   * 只有 42 KB，但它要用的 wasm 是单独一个文件 —— 页面刚打开就去拉
   * 2.6 MB，对只想看一眼的人太奢侈。真要转 AVIF 了再拉，拉一次缓存着。
   *
   * 编译用 compileStreaming：编译在浏览器里是**后台线程**干的，
   * 不卡页面（compile 要在主线程上跑，几百毫秒）。
   *
   * @returns {Promise<object>} 带 encode() 的模块
   */
  function imageAvifModule() {
    if (imageAvifPromise) return imageAvifPromise;
    // 能 abort 就 abort —— 不然超时之后那个 2.6 MB 还在后台下。
    var controller = null;
    if (typeof AbortController === 'function') {
      try { controller = new AbortController(); } catch (e) { controller = null; }
    }
    var fetchPromise = fetch(
      IMAGE_AVIF_WASM_URL,
      controller ? { signal: controller.signal } : undefined
    ).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var type = res.headers && res.headers.get ? res.headers.get('Content-Type') : '';
      if (WebAssembly.compileStreaming && type === 'application/wasm') {
        return WebAssembly.compileStreaming(res);
      }
      return res.arrayBuffer().then(function (buf) { return WebAssembly.compile(buf); });
    });
    var p = imageWithTimeout(fetchPromise, IMAGE_FETCH_TIMEOUT, 'timeout', function () {
      if (controller) {
        try { controller.abort(); } catch (e) { /* 忽略 */ }
      }
    }).then(function (wasmModule) {
      var factory = window.__avifEncFactory;
      if (typeof factory !== 'function') throw new Error('avif encoder is not loaded');
      // instantiateWasm：把我们已经编译好的模块塞给它，
      // 别让它自己再去 fetch 一遍。
      return factory({
        instantiateWasm: function (imports, callback) {
          var instance = new WebAssembly.Instance(wasmModule, imports);
          callback(instance);
          return instance.exports;
        }
      });
    });
    p.catch(function () { if (imageAvifPromise === p) imageAvifPromise = null; });
    imageAvifPromise = p;
    return p;
  }

  /**
   * 给一个 promise 加个超时。
   *
   * 没有超时的 promise 会一直挂着 —— 页面就停在「正在下载…」，
   * 用户既看不到发生了什么，也没法重试。
   *
   * @param {Promise} p 要看着的那个 promise
   * @param {number} ms 多久算超时
   * @param {string} message 超时后报的错
   * @param {function} onTimeout 超时时顺手做的事（比如中断下载）
   * @returns {Promise}
   */
  function imageWithTimeout(p, ms, message, onTimeout) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (typeof onTimeout === 'function') {
          try { onTimeout(); } catch (e) { /* 忽略 */ }
        }
        reject(new Error(message));
      }, ms);
      p.then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /**
   * 编码成 HEIC。
   *
   * elheif 的编码器（kvazaar）**没有质量参数** —— 画质是固定的，
   * 所以这个函数不认 opts.quality，界面里也就不该给 HEIC 挂质量滑块。
   *
   * @param {{source: *, width: number, height: number}} decoded
   * @param {object} opts
   * @returns {Promise<{blob: Blob, width: number, height: number, formatId: string}>}
   */
  function imageEncodeHeic(decoded, opts) {
    var width = Math.max(1, Math.round(Number(opts.width) || decoded.width || 1));
    var height = Math.max(1, Math.round(Number(opts.height) || decoded.height || 1));
    return imageWasmEncode({
      format: 'heic',
      source: decoded.source,
      width: width,
      height: height,
      options: null,
      // 浏览器显示不了 HEIC —— 让 worker 顺带解回来当预览。
      wantPreview: true,
      onPhase: opts.onPhase
    }).then(function (out) {
      return {
        blob: new Blob([out.bytes], { type: 'image/heic' }),
        width: width,
        height: height,
        formatId: 'heic',
        requestedFormatId: 'heic',
        mime: 'image/heic',
        scaledToFit: false,
        preview: out.preview
      };
    });
  }

  /**
   * 编码成 AVIF。
   *
   * @param {{source: *, width: number, height: number}} decoded
   * @param {object} opts
   * @returns {Promise<{blob: Blob, width: number, height: number, formatId: string}>}
   */
  function imageEncodeAvif(decoded, opts) {
    var width = Math.max(1, Math.round(Number(opts.width) || decoded.width || 1));
    var height = Math.max(1, Math.round(Number(opts.height) || decoded.height || 1));
    return imageWasmEncode({
      format: 'avif',
      source: decoded.source,
      width: width,
      height: height,
      options: imageAvifOptions(opts.quality, opts.speed),
      // AVIF 浏览器原生就能显示，不用解回来。
      wantPreview: false,
      onPhase: opts.onPhase
    }).then(function (out) {
      return {
        blob: new Blob([out.bytes], { type: 'image/avif' }),
        width: width,
        height: height,
        formatId: 'avif',
        requestedFormatId: 'avif',
        mime: 'image/avif',
        scaledToFit: false,
        preview: out.preview
      };
    });
  }

  /**
   * 用 wasm 编码器编码 —— 优先在 worker 里做。
   *
   * @param {object} job
   *   job.format      'heic' | 'avif'
   *   job.source      已解码的图
   *   job.width       宽
   *   job.height      高
   *   job.options     AVIF 的选项结构体（HEIC 用不上）
   *   job.wantPreview 要不要顺带解回来做预览
   *   job.onPhase     阶段回调（'loading' / 'encoding'）
   * @returns {Promise<{bytes: Uint8Array, preview: ?object}>}
   */
  function imageWasmEncode(job) {
    if (!imageWorkerSupported()) return imageWasmEncodeOnMainThread(job);

    var rgba;
    try {
      rgba = imageSourceToRgba(job.source, job.width, job.height);
    } catch (e) {
      return Promise.reject(e);
    }

    return imageWorkerCall({
      op: 'encode',
      format: job.format,
      data: rgba.buffer,
      width: job.width,
      height: job.height,
      options: job.options || null,
      wantPreview: !!job.wantPreview
    }, [rgba.buffer], job.onPhase).then(function (res) {
      return {
        bytes: new Uint8Array(res.data),
        preview: res.preview ? {
          data: new Uint8Array(res.preview.data),
          width: res.preview.width,
          height: res.preview.height
        } : null
      };
    }, function (err) {
      // 只有「worker 这边不行」才退回主线程 ——
      // 编码本身失败的话，在主线程上再试一次就是再卡一分钟。
      if (err && err.workerUnavailable) return imageWasmEncodeOnMainThread(job);
      throw err;
    });
  }

  /**
   * 主线程上编码 —— 没有 Worker 时的退路。
   *
   * 结果一样，就是会把界面卡住（wasm 是同步的）。
   *
   * @param {object} job 同 imageWasmEncode
   * @returns {Promise<{bytes: Uint8Array, preview: ?object}>}
   */
  function imageWasmEncodeOnMainThread(job) {
    if (job.format === 'avif') {
      return imageAvifModule().then(function (mod) {
        if (job.onPhase) job.onPhase('encoding');
        var rgba = imageSourceToRgba(job.source, job.width, job.height);
        var bytes = mod.encode(rgba, job.width, job.height, job.options);
        if (!bytes) throw new Error('encode');
        return {
          bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
          preview: null
        };
      });
    }
    return imageElheifInit().then(function (mod) {
      if (job.onPhase) job.onPhase('encoding');
      var rgba = imageSourceToRgba(job.source, job.width, job.height);
      var out = mod.jsEncodeImage(rgba, job.width, job.height);
      if (!out || out.err || !out.data) {
        throw new Error(out && out.err ? String(out.err) : 'encode');
      }
      var bytes = out.data instanceof Uint8Array ? out.data : new Uint8Array(out.data);
      var result = { bytes: bytes, preview: null };
      // 顺带解回来当预览 —— 浏览器显示不了 HEIC。
      if (job.wantPreview) {
        try {
          var back = mod.jsDecodeImage(bytes);
          if (back && back.data && back.data[0]) {
            var frame = imageRgbaFromFrame(back.data[0]);
            result.preview = { data: frame.data, width: frame.width, height: frame.height };
          }
        } catch (e) {
          // 解不出来不算失败 —— 编码本身是好的，只是没有预览。
        }
      }
      return result;
    });
  }

  /**
   * 按格式分派到对应的编码器。
   *
   * 原生三种走 canvas.toBlob；HEIC 走 elheif；AVIF 走 jsquash。
   * 后两种在 worker 里跑（wasm 是同步的，见上面那段说明）。
   *
   * @param {{source: *, width: number, height: number}} decoded
   * @param {object} opts 其中 opts.onPhase 是阶段回调
   * @returns {Promise<object>}
   */
  function imageEncodeTo(decoded, opts) {
    var format = imageFormatById(opts.formatId);
    if (!format) return Promise.reject(new Error('unknown format'));
    if (format.encoder === 'elheif') return imageEncodeHeic(decoded, opts);
    if (format.encoder === 'avif') return imageEncodeAvif(decoded, opts);
    return imageEncode(decoded, opts);
  }

  /**
   * 编码到哪一步了 —— 界面上那一行字。
   *
   * 拉编码器（2.6 MB）和真正编码是两件事，混成一句「正在编码中」的话，
   * 用户会以为卡住了 —— 头几秒其实什么都没干，在等下载。
   *
   * @param {object} s 这个工具的文案表
   * @param {string} phase 'loading' / 'encoding' / 'decoding'
   * @returns {string}
   */
  function imageBusyText(s, phase) {
    if (phase === 'loading') return s.status_downloading || s.status_encoding;
    if (phase === 'decoding') return s.status_decoding || s.status_encoding;
    return s.status_encoding;
  }

  /**
   * 下载进度 —— 百分比。
   *
   * 不知道总量的时候给 null（页面上画不确定进度）。
   * 单拎出来是为了能测：百分比算错了，进度条就是骗人的。
   *
   * @param {number} loaded 已经下了多少字节
   * @param {number} total 一共多少字节（0 或者没有就是不知道）
   * @returns {number|null} 0~100 的整数
   */
  function imageProgressPercent(loaded, total) {
    var l = Number(loaded);
    var t = Number(total);
    if (!isFinite(l) || !isFinite(t) || t <= 0 || l < 0) return null;
    var pct = Math.floor(l / t * 100);
    if (pct > 100) pct = 100;
    return pct;
  }

  /**
   * 这个格式认不认质量设置。
   *
   * 三种情况都要分开：
   *   · PNG 无损 —— 拖滑块没有意义（界面里把滑块置灰）；
   *   · HEIC 有损，但编码器**没有质量参数** —— 滑块藏起来，说明白为什么；
   *   · 其余（JPEG / WebP / AVIF）认质量。
   *
   * @param {object|string} format 格式对象或格式 id
   * @returns {boolean}
   */
  function imageQualityApplies(format) {
    var f = typeof format === 'string' ? imageFormatById(format) : format;
    if (!f || !f.lossy) return false;
    return f.qualityAdjustable !== false;
  }

  /**
   * 这个格式要不要铺背景色。只有没有 alpha 通道的格式要。
   * @param {object|string} format 格式对象或格式 id
   * @returns {boolean}
   */
  function imageBackgroundApplies(format) {
    var f = typeof format === 'string' ? imageFormatById(format) : format;
    return !!f && !f.alpha;
  }

  /**
   * 让出一帧 —— wasm 编码是**同步阻塞主线程**的，
   * 得先把「编码中…」画到屏幕上，再进编码器。
   * @returns {Promise<void>}
   */
  function imageYieldFrame() {
    return new Promise(function (resolve) {
      var raf = window.requestAnimationFrame;
      if (typeof raf === 'function') {
        raf(function () { setTimeout(resolve, 0); });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /**
   * 造一个「图片格式转换」工具的整个界面。
   *
   * 三个页面共用它：/image-converter（只转浏览器原生的三种）、
   * /image-converter-heic、/image-converter-avif。
   *
   * 为什么共用而不是各写一份：这三个页面的界面有九成是重合的
   * （上传卡 → 设置卡 → 结果卡 + 前后预览 + 下载），
   * 各写一份的话，改一处就得记得改三处 —— 而三处迟早会不一样。
   * 这跟 ItTools.jsonInfer（几个 json 转语言的工具共用）是同一个道理。
   *
   * **文案由调用方给**（工具模块用 t('键','英文') 拼好传进来）。
   * 语言包的对账只扫 static/js/tools/*.js 里的字面量调用，
   * 文案放在这里就扫不到了（见 src/i18n.rs 的 js_text 模块）。
   *
   * @param {object} opts
   *   opts.root          挂载的容器
   *   opts.s             已翻译的文案
   *   opts.formats       这一页能选的输出格式
   *   opts.defaultFormat 默认选中的格式
   *   opts.accept        文件选择框的 accept
   *   opts.qualityNote   「这个格式调不了质量」时的说明（没有就传 null）
   *   opts.speed         速度档 {label, options:[{value,label}]}（没有就传 null）
   *   opts.extraHints    这个工具自己的补充说明（字符串数组，没有就传 null）
   *   opts.debounce      质量滑块的防抖毫秒数（编码慢的格式要设）
   * @returns {{destroy: function}}
   */
  function imageConverterView(opts) {
    var root = opts.root;
    var s = opts.s;
    var formats = opts.formats || IMAGE_FORMATS;
    var disposed = false;
    /** 重算的序号。慢的那次算完了不许盖掉快的那次的结果。 */
    var ticket = 0;
    /** 上传了第几张图。用来作废「上一张还没解完」的那次解码。 */
    var fileTicket = 0;
    var debounceTimer = null;

    var state = {
      name: '',
      size: 0,
      sourceFormat: '',
      /** 动图的帧数；静态图是 null。见 imageAnimationInfo。 */
      animation: null,
      decoded: null,
      width: 0,
      height: 0,
      formatId: opts.defaultFormat || formats[0].id,
      quality: IMAGE_DEFAULT_QUALITY,
      speed: IMAGE_DEFAULT_SPEED,
      background: '#ffffff',
      result: null,
      originalUrl: '',
      resultUrl: '',
      /** 原图解出来的像素（浏览器显示不了的格式才用得上）。 */
      sourceCanvas: null
    };

    /* ---------- 卡片 ---------- */

    var upload = imageUploadCard({
      accept: opts.accept || 'image/*',
      label: s.choose_file,
      hint: s.drop_hint,
      onFile: handleFile
    });
    upload.card.insertBefore(Dom.h('h3', { text: s.title }), upload.card.firstChild);

    var settingsCard = Dom.h('div.card', { hidden: true });
    var resultCard = Dom.h('div.card', { hidden: true });

    root.appendChild(upload.card);
    root.appendChild(settingsCard);
    root.appendChild(resultCard);

    /* ---------- 设置 ---------- */

    var formatSelect = Dom.h('select.layui-select', null,
      formats.map(function (f) {
        return Dom.h('option', { value: f.id, text: f.label });
      })
    );

    var qualityLabel = Dom.h('label.field-label', {
      for: 'iv-quality',
      text: s.label_quality.replace('{n}', String(IMAGE_DEFAULT_QUALITY))
    });
    var qualitySlider = Dom.h('input.slider', {
      type: 'range', id: 'iv-quality', min: 1, max: 100, step: 1, value: IMAGE_DEFAULT_QUALITY
    });
    var qualityField = Dom.h('div.field', null, qualityLabel, qualitySlider);

    var backgroundInput = Dom.h('input', { type: 'color', value: state.background });

    var qualityHint = Dom.h('p.field-hint');
    var backgroundHint = Dom.h('p.field-hint');

    settingsCard.appendChild(Dom.h('h3', { text: s.settings_title }));
    settingsCard.appendChild(Util.field(s.label_format, formatSelect));
    settingsCard.appendChild(qualityField);
    settingsCard.appendChild(Util.field(s.label_background, backgroundInput));
    settingsCard.appendChild(qualityHint);
    settingsCard.appendChild(backgroundHint);
    settingsCard.appendChild(Dom.h('p.field-hint', { text: s.hint_formats }));
    // 各工具自己的补充说明（比如「首次转换要下载编解码库」）。
    if (opts.extraHints) {
      opts.extraHints.forEach(function (text) {
        settingsCard.appendChild(Dom.h('p.field-hint', { text: text }));
      });
    }

    /* ---- 速度档（只有 AVIF 有） ---- */
    var speedField = null;
    var speedSelect = null;
    if (opts.speed) {
      speedSelect = Dom.h('select.layui-select', null,
        opts.speed.options.map(function (o) {
          return Dom.h('option', { value: String(o.value), text: o.label });
        })
      );
      speedField = Util.field(opts.speed.label, speedSelect);
      speedField.hidden = true;
      settingsCard.appendChild(speedField);
    }

    // 初始状态就先对一次：默认格式用不用得上质量、背景色，一眼能看出来。
    refreshHints();

    /* ---------- 结果 ---------- */

    var resultBody = Dom.h('div');
    var busyHint = Dom.h('p.field-hint');
    /* 下载进度条。只有「在下载编码器」的时候才露出来 ——
       编码本身没有进度可言（wasm 是同步的，要么在跑要么不在跑）。 */
    var progressBar = Dom.h('progress.progress-bar');
    var progressLabel = Dom.h('span.progress-label');
    var progressRow = Dom.h('div.progress-row', { hidden: true },
      progressBar, progressLabel);
    resultCard.appendChild(Dom.h('h3', { text: s.result_title }));
    resultCard.appendChild(busyHint);
    resultCard.appendChild(progressRow);
    resultCard.appendChild(resultBody);

    /** 键值对照表。 */
    function kvTable(rows) {
      var table = Dom.h('table.kv-table');
      table.appendChild(Dom.h('thead', null, Dom.h('tr', null,
        Dom.h('th', { text: s.label_item }),
        Dom.h('th', { text: s.label_value })
      )));
      var body = Dom.h('tbody');
      rows.forEach(function (row) {
        body.appendChild(Dom.h('tr', null,
          Dom.h('td', { text: row.label }),
          Dom.h('td.val', { text: row.value })
        ));
      });
      table.appendChild(body);
      return table;
    }

    /** 换掉结果图的 object URL —— 不撤销的话每改一次设置就漏一个 blob。 */
    function replaceResultUrl(blob) {
      if (state.resultUrl) {
        URL.revokeObjectURL(state.resultUrl);
        state.resultUrl = '';
      }
      state.resultUrl = URL.createObjectURL(blob);
    }

    /**
     * 「编码中…」状态。wasm 编码慢的格式才用得上。
     *
     * @param {boolean} on
     * @param {string} phase 'loading' / 'encoding' / 'decoding'
     * @param {object} [info] worker 报来的进度（loaded / total）
     */
    function setBusy(on, phase, info) {
      busyHint.textContent = on ? imageBusyText(s, phase) : '';
      // 进度条只在**下载**的时候出现 —— 编码本身没有进度可言。
      if (on && phase === 'loading') {
        progressRow.hidden = false;
        var pct = imageProgressPercent(info && info.loaded, info && info.total);
        if (pct === null) {
          // 不知道总量 —— 不确定进度：浏览器自己画那个来回走的条。
          progressBar.removeAttribute('value');
          progressLabel.textContent = '';
        } else {
          progressBar.max = 100;
          progressBar.value = pct;
          progressLabel.textContent = pct + '%';
        }
      } else {
        progressRow.hidden = true;
        progressLabel.textContent = '';
      }
    }

    /** 设置变了之后刷新提示文案。 */
    function refreshHints() {
      var format = imageFormatById(state.formatId);
      var lossy = imageQualityApplies(format);
      var needsBackground = imageBackgroundApplies(format);

      // HEIC 那种「压根没有质量参数」的格式：滑块藏起来，换成一句说明。
      // PNG 这种「无损所以用不上」的格式：滑块留着但置灰 —— 跟原来一样。
      var hideQuality = !!(format && format.qualityAdjustable === false);
      qualityField.hidden = hideQuality;
      qualitySlider.disabled = !lossy;

      if (!format) {
        qualityHint.textContent = '';
      } else if (hideQuality) {
        qualityHint.textContent = opts.qualityNote || '';
      } else if (!format.lossy) {
        qualityHint.textContent = s.hint_lossless;
      } else {
        qualityHint.textContent = s.hint_quality;
      }

      backgroundInput.parentNode.style.display = needsBackground ? '' : 'none';
      backgroundHint.textContent = needsBackground ? s.hint_background : '';

      if (speedField) speedField.hidden = !(format && format.speedAdjustable);
    }

    /**
     * 一块预览图。
     *
     * 浏览器解不了的格式（HEIC）放 <img> 就是一张破图 —— 那种情况下
     * 要么给一句话说明，要么给**解出来的**像素（canvas）。
     *
     * @param {string} formatId 这个块的格式
     * @param {string} url 文件的地址（可能是空的）
     * @param {string} label 块上面的说明
     * @param {HTMLCanvasElement} canvas 已经解出来的像素（有就用它）
     * @param {string} note 附在下面的说明（有就显示）
     */
    function previewBlock(formatId, url, label, canvas, note) {
      var format = imageFormatById(formatId);
      var block = Dom.h('div', null, Dom.h('p.field-hint', { text: label }));
      if (canvas) {
        block.appendChild(canvas);
        if (note) block.appendChild(Dom.h('p.field-hint', { text: note }));
        return block;
      }
      if (!url) return block;
      if (format && format.previewable === false) {
        block.appendChild(Dom.h('p.field-hint', { text: s.hint_not_previewable }));
      } else {
        block.appendChild(Dom.h('img', { src: url, alt: label, style: { maxWidth: '100%' } }));
      }
      return block;
    }

    /** 画结果卡片。 */
    function renderResult() {
      Dom.clear(resultBody);
      var r = state.result;
      if (!r) {
        resultBody.appendChild(Dom.h('p.field-hint', { text: s.no_result }));
        return;
      }

      var format = imageFormatById(r.formatId) || formats[0];
      resultBody.appendChild(kvTable([
        {
          label: s.label_source_format,
          value: state.sourceFormat ? state.sourceFormat.toUpperCase() : s.label_unknown
        },
        { label: s.label_target_format, value: format.label },
        { label: s.label_before, value: imageFormatBytes(r.beforeBytes) },
        { label: s.label_after, value: imageFormatBytes(r.blob.size) },
        {
          label: s.label_dimensions,
          value: r.width + ' × ' + r.height
        }
      ]));

      if (state.sourceFormat && r.requestedFormatId === state.sourceFormat) {
        resultBody.appendChild(Dom.h('p.field-hint', { text: s.hint_same_format }));
      }

      // 浏览器不支持这个格式的编码时，toBlob 会退回 PNG —— 必须说出来
      if (r.formatId !== r.requestedFormatId) {
        var requested = imageFormatById(r.requestedFormatId);
        resultBody.appendChild(Dom.h('div.alert.alert-warning', null,
          Dom.h('div', {
            text: s.warn_fallback
              .replace('{format}', requested ? requested.label : r.requestedFormatId)
              .replace('{actual}', format.label)
          })
        ));
      }

      // 动图只剩第一帧 —— canvas 画不出后面的帧，不说清楚就成了骗人
      if (state.animation && state.animation.animated) {
        resultBody.appendChild(Dom.h('div.alert.alert-warning', null,
          Dom.h('div', {
            text: s.warn_animation.replace('{n}', String(state.animation.frames))
          })
        ));
      }

      // 图太大，浏览器吃不下这个尺寸，内核自动缩过 —— 尺寸变了得说出来
      if (r.scaledToFit) {
        resultBody.appendChild(Dom.h('div.alert.alert-warning', null,
          Dom.h('div', {
            text: s.warn_too_large
              .replace('{width}', String(r.width))
              .replace('{height}', String(r.height))
          })
        ));
      }

      // 原图与结果的并排预览
      var preview = Dom.h('div.preview-box');
      preview.appendChild(previewBlock(
        state.sourceFormat, state.originalUrl, s.preview_before, state.sourceCanvas, s.hint_preview_decoded
      ));
      preview.appendChild(previewBlock(
        r.formatId, state.resultUrl, s.preview_after, r.previewCanvas, s.hint_preview_decoded
      ));
      resultBody.appendChild(preview);

      var downloadBtn = Dom.h('button.layui-btn.layui-btn-primary', {
        type: 'button', text: s.download
      });
      downloadBtn.addEventListener('click', function () {
        if (disposed || !state.result) return;
        var fmt = imageFormatById(state.result.formatId) || formats[0];
        window.ItTools.download(
          imageOutputName(state.name, fmt.ext, 'converted'),
          state.result.blob,
          fmt.mime
        );
      });
      resultBody.appendChild(Dom.h('div.form-actions', null, downloadBtn));
    }

    /** 按当前设置重新编码。 */
    function recompute() {
      if (!state.decoded) return;
      var mine = ++ticket;
      var decoded = state.decoded;
      var format = imageFormatById(state.formatId) || formats[0];
      var encodeOpts = {
        width: state.width,
        height: state.height,
        formatId: state.formatId,
        quality: state.quality,
        speed: state.speed,
        background: state.background,
        // 编码到哪一步了 —— worker 会先报「在下载编码器」，再报「在编码」。
        onPhase: function (phase, info) {
          if (disposed || mine !== ticket) return;
          setBusy(true, phase, info);
        }
      };

      // wasm 编码是**同步阻塞**的（3 MP 的图要一两秒）——
      // 先把「编码中…」画出来，再让出一帧，最后才进编码器。
      // 顺序反了的话，用户看到的是「按下去没反应，过两秒突然出结果」。
      var slow = !!format.slow;
      if (slow) setBusy(true);

      var chain = slow
        ? imageYieldFrame().then(function () { return imageEncodeTo(decoded, encodeOpts); })
        : imageEncodeTo(decoded, encodeOpts);

      chain.then(function (out) {
        // 慢的那次算完了不许盖掉快的那次的结果
        if (disposed || mine !== ticket) return;
        setBusy(false);
        state.result = {
          blob: out.blob,
          width: out.width,
          height: out.height,
          formatId: out.formatId,
          requestedFormatId: out.requestedFormatId,
          beforeBytes: state.size,
          scaledToFit: out.scaledToFit,
          // 浏览器显示不了的格式（HEIC）：用解回来的像素当预览。
          previewCanvas: out.preview
            ? imageRgbaCanvas(out.preview.data, out.preview.width, out.preview.height)
            : null
        };
        replaceResultUrl(out.blob);
        renderResult();
      }, function (err) {
        if (disposed || mine !== ticket) return;
        setBusy(false);
        state.result = null;
        Dom.clear(resultBody).appendChild(Dom.h('p.field-hint.is-error', {
          text: s.err_encode.replace('{reason}', function () {
            return String(err && err.message ? err.message : err);
          })
        }));
      });
    }

    /**
     * 设置连着变的时候别每次都重编 —— wasm 编码一次要好几秒，
     * 拖一下滑块卡一下是不能忍的。
     *
     * 只有**慢**的格式才防抖：原生编码一次也就几十毫秒，
     * 防抖反倒让界面显得迟钝。
     */
    function scheduleRecompute() {
      var format = imageFormatById(state.formatId);
      var delay = format && format.slow ? (opts.debounce || 0) : 0;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (!delay) {
        recompute();
        return;
      }
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        recompute();
      }, delay);
    }

    /* ---------- 处理文件 ---------- */

    function handleFile(file) {
      if (!file) return;
      // 上一张图的编码还在跑 —— 作废它。
      // （worker 那边会把它终止掉，见 imageWorkerCall。）
      ticket++;
      // 上一张图可能还没解完 —— 也作废它，
      // 别让它的失败把这一张的界面写成「解不出来」。
      var mine = ++fileTicket;
      upload.setStatus(s.status_reading);

      var reader = new FileReader();
      reader.onload = function () {
        if (disposed || mine !== fileTicket) return;
        var bytes;
        try {
          bytes = new Uint8Array(reader.result);
        } catch (e) {
          upload.setStatus(s.err_read, true);
          return;
        }
        var format = imageDetectFormat(bytes);
        // 解码可能把 bytes 的 buffer **转移**给 worker（拿不到文件时才会这样），
        // 转移之后 bytes 就废了 —— 要用的东西得先取出来。
        var byteLength = bytes.length;
        var animation = imageAnimationInfo(bytes);

        // HEIC 得用 wasm 解 —— 那是要花点时间的，得说清楚在干什么。
        if (format === 'heic') upload.setStatus(s.status_decoding || s.status_reading);

        imageDecodeAny(file, bytes).then(function (decoded) {
          if (disposed || mine !== fileTicket) return;

          state.name = file.name || 'image';
          state.size = file.size || byteLength;
          state.sourceFormat = format || '';
          state.animation = animation;
          state.decoded = decoded;
          state.width = decoded.width;
          state.height = decoded.height;
          state.quality = IMAGE_DEFAULT_QUALITY;

          // 浏览器显示不了的格式（原图是 HEIC）：预览用解出来的像素，
          // 别的格式照旧用文件本身。
          state.sourceCanvas = null;
          var sourceFormat = imageFormatById(state.sourceFormat);
          if (sourceFormat && sourceFormat.previewable === false) {
            state.sourceCanvas = imageSourceCanvas(decoded);
          }

          qualitySlider.value = String(IMAGE_DEFAULT_QUALITY);
          qualityLabel.textContent = s.label_quality.replace('{n}', String(IMAGE_DEFAULT_QUALITY));
          formatSelect.value = state.formatId;

          if (state.originalUrl) {
            URL.revokeObjectURL(state.originalUrl);
            state.originalUrl = '';
          }
          state.originalUrl = URL.createObjectURL(file);

          upload.setStatus('');
          settingsCard.hidden = false;
          resultCard.hidden = false;
          refreshHints();
          recompute();
        }, function () {
          if (disposed || mine !== fileTicket) return;
          upload.setStatus(s.err_decode, true);
          settingsCard.hidden = true;
          resultCard.hidden = true;
        });
      };
      reader.onerror = function () {
        if (disposed) return;
        upload.setStatus(s.err_read, true);
      };
      reader.readAsArrayBuffer(file);
    }

    /* ---------- 事件 ---------- */

    formatSelect.addEventListener('change', function () {
      state.formatId = formatSelect.value;
      refreshHints();
      recompute();
    });

    qualitySlider.addEventListener('input', function () {
      state.quality = imageClampQuality(qualitySlider.value);
      qualityLabel.textContent = s.label_quality.replace('{n}', String(state.quality));
      scheduleRecompute();
    });

    backgroundInput.addEventListener('input', function () {
      state.background = backgroundInput.value || '#ffffff';
      scheduleRecompute();
    });

    if (speedSelect) {
      speedSelect.addEventListener('change', function () {
        state.speed = imageClampSpeed(speedSelect.value);
        recompute();
      });
    }

    return {
      destroy: function () {
        disposed = true;
        ticket++;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
        if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
        if (state.decoded && state.decoded.close) state.decoded.close();
        state.originalUrl = '';
        state.resultUrl = '';
        state.decoded = null;
        Dom.clear(root);
      }
    };
  }

  var ImageCodec = {
    FORMATS: IMAGE_FORMATS,
    FORMATS_WASM: IMAGE_FORMATS_WASM,
    ALL_FORMATS: IMAGE_FORMATS.concat(IMAGE_FORMATS_WASM),
    formatById: imageFormatById,
    detectFormat: imageDetectFormat,
    animationInfo: imageAnimationInfo,
    parseDimension: imageParseDimension,
    fitWithin: imageFitWithin,
    shrinkSize: imageShrinkSize,
    clampQuality: imageClampQuality,
    clampSpeed: imageClampSpeed,
    savings: imageSavings,
    formatBytes: imageFormatBytes,
    outputName: imageOutputName,
    actualFormatId: imageActualFormatId,
    qualityApplies: imageQualityApplies,
    backgroundApplies: imageBackgroundApplies,
    avifCqLevel: imageAvifCqLevel,
    avifOptions: imageAvifOptions,
    busyText: imageBusyText,
    progressPercent: imageProgressPercent,
    ownBuffer: imageOwnBuffer,
    decode: imageDecode,
    decodeAny: imageDecodeAny,
    rgbaFromFrame: imageRgbaFromFrame,
    encode: imageEncode,
    encodeTo: imageEncodeTo,
    uploadCard: imageUploadCard,
    converterView: imageConverterView
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
    /** 「图片压缩」与「图片格式转换」两个工具共用的图片编解码内核。 */
    imageCodec: ImageCodec,
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