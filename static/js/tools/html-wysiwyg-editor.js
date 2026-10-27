/* ==========================================================================
   HTML 可视化编辑器（html-wysiwyg-editor）

   一个轻量 contenteditable 编辑器：粗体/斜体/下划线/删除线、标题下拉、
   有序无序列表、链接、对齐、清除格式、源码视图（双向）、复制 HTML。
   源码视图里有一个「格式化」按钮，做的是安全的块级缩进（见 formatHtml）。

   参考实现：src/tools/html-wysiwyg-editor/（it-tools, GPLv3）

   与参考实现的差别：

   1. **不 vendor tiptap / ProseMirror**。原版用 @tiptap/vue-3 + StarterKit，
      那是 ProseMirror 之上的完整文档模型 + 一整套扩展机制，光 prosemirror-
      state / prosemirror-view / prosemirror-model 就有几百 KB，再加
      @tiptap/starter-kit（katex、dropcursor、gapcursor、history…）。
      本项目的静态资源是直接由 Rust 侧 embed 的、没有构建步骤，加它等于给每个
      访问者强加几百 KB。改用 `contenteditable` + document.execCommand，
      不引入任何依赖。代价是丢掉了 ProseMirror 的 schema 校验和 undo 栈
      （execCommand 的 undo 在各浏览器上不一致，因此没做撤销/重做）。

   2. **不 vendor prettier，也不复制它那个 bug**。原版 html-wysiwyg-editor.vue
      在运行时 `import { format } from 'prettier'` + `prettier/plugins/html`
      来「格式化」HTML，但 prettier 只在 **devDependencies** 里（package.json
      第 139 行），不在 dependencies —— 打包到生产时那两行 import 要么被摇掉、
      要么直接解析失败。plan 里点名了「不要复制参考项目的 bug」。
      这里自己实现 formatHtml：只做**块级标签的换行 + 缩进**，绝不碰
      非空白文本、属性写法、`pre`/`textarea`/`script`/`style` 内部。
      取舍写在 formatHtml 的注释里。

   3. **多了一层 sanitizeHtml**，原版没有。这个工具的整个前提就是把用户写的
      HTML 渲染进页面，而 contenteditable 的粘贴 / innerHTML 会毫无保留地
      带进 `<script onerror=…>` 这类东西。所以「源码视图 → 可视化」这一个
      方向必须过白名单清洗，粘贴事件同样过。白名单的取舍见下面的说明。

   ---- 白名单是怎么定的 ----
   · 标签：按「这个编辑器自己会生成什么」+「粘贴时常见的富文本元素」列，
     约 50 个（p / h1-h6 / b / strong / i / em / u / s / del / ins / ul / ol /
     li / blockquote / pre / code / a / img / table 系列 / 少量语义标签）。
     不在名单里的标签**拆包**（丢掉标签本身、保留子节点），不是连内容一起删 ——
     用户粘一段带 <font> 的老网页时，内容不会凭空消失。
   · 例外：一张 DROP_SUBTREE 表（script / style / svg / math / iframe /
     object / embed / template / form / input / textarea …）整个连内容丢掉。
     分两类：
       (a) 内容和真正的攻击面：script、style、svg/math（外层内容里可以藏
           <script>，且它们的解析规则跟 HTML 不同，是 mXSS 的经典入口）、
           iframe/object/embed、template（惰性内容但仍会被解析）。
       (b) 表单类：form / input / button / select / textarea。
           (b) 这条是有争议的取舍 —— 粘进来的 <textarea>hello</textarea> 会丢掉
           "hello"。判据是：这个工具把用户内容渲染在**编辑器的页面上**，一个能
           提交的仿登录表单放在别人站点的编辑器里是被公认的攻击面，收益远大于
           偶尔丢几个字。textarea 不在允许名单里本来也会被拆包（里面的文字
           变成可见文本），这里选择直接丢。
   · 属性：全局只留 title / lang / dir / style，另外按标签给一小撮
     （a: href target rel name；img: src alt width height loading；
     td/th: colspan rowspan headers scope align valign；ol: start type reversed；
     col/colgroup: span；blockquote/q: cite；details: open）。
     `on*`、`style` 之外的 style-family、`srcset`、`formaction`、`xlink:href`、
     `data-*` 全部丢掉。出现两次的属性只留第一个。
   · style：不是整条丢，而是**按声明逐条过白名单**：只留 text-align /
     font-weight / font-style / text-decoration / 字体与颜色相关的少量属性，
     值还要再过一道正则（颜色、字号、text-align 枚举；允许 rgb()/rgba()/
     hsl()/hsla() 但括号里只允许数字字母%.,/ 空白 —— 这样 url() 和
     expression() 自然落在允许的函数名之外）。position / z-index /
     behavior / -moz-binding 这些「盖住界面」的属性根本不在名单里。
   · URL：href / src / cite 走 isSafeUrl —— 先把数值实体和 &colon; 这类命名
     实体解出来（`javascript&colon;`、`jav&#x09;ascript:` 都要挡住），再把
     所有 ≤0x20 的控制字符和空白剥掉（浏览器解析 scheme 时也会剥），
     最后只放行 http / https / mailto / tel / ftp / ftps 与相对路径、锚点、
     协议相对 URL。data: 一律不放行。
   · target="_blank" 强制补 rel="noopener noreferrer"（反向标签劫持）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('html-wysiwyg-editor');

  /* ========================================================================
     白名单
     ======================================================================== */

  var DEFAULT_ALLOWED_TAGS = [
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
    'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
    'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span',
    'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'tr', 'u', 'ul', 'var', 'wbr'
  ];

  /** 整个标签连内容一起丢弃的标签，见文件头说明。 */
  var DROP_SUBTREE = {
    script: 1, style: 1, template: 1, svg: 1, math: 1,
    iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1, applet: 1,
    noscript: 1, noembed: 1, noframes: 1, xmp: 1, plaintext: 1, title: 1,
    base: 1, link: 1, meta: 1,
    form: 1, input: 1, button: 1, select: 1, option: 1, optgroup: 1, textarea: 1,
    canvas: 1, audio: 1, video: 1, source: 1, track: 1, param: 1,
    marquee: 1, dialog: 1, slot: 1, picture: 1
  };

  /** 不需要闭合标签的。 */
  var VOID_TAGS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
  };

  /** 所有允许标签都能带的属性。style 走 sanitizeStyle 单独处理。 */
  var GLOBAL_ATTRS = { title: 1, lang: 1, dir: 1, style: 1 };

  /** 按标签额外允许的属性。 */
  var TAG_ATTRS = {
    a: { href: 1, target: 1, rel: 1, name: 1 },
    img: { src: 1, alt: 1, width: 1, height: 1, loading: 1 },
    td: { colspan: 1, rowspan: 1, headers: 1, align: 1, valign: 1 },
    th: { colspan: 1, rowspan: 1, headers: 1, scope: 1, align: 1, valign: 1 },
    col: { span: 1 }, colgroup: { span: 1 },
    ol: { start: 1, type: 1, reversed: 1 },
    blockquote: { cite: 1 }, q: { cite: 1 },
    details: { open: 1 }
  };

  /** 需要过 URL 白名单的属性。 */
  var URL_ATTRS = { href: 1, src: 1, cite: 1 };

  var SAFE_SCHEMES = ['http', 'https', 'mailto', 'tel', 'ftp', 'ftps'];

  /** sanitizeStyle 允许的 CSS 属性。 */
  var SAFE_CSS_PROPS = {
    'text-align': 1, 'text-decoration': 1, 'font-weight': 1, 'font-style': 1,
    'font-size': 1, 'font-family': 1, color: 1, 'background-color': 1,
    'line-height': 1, 'letter-spacing': 1, 'vertical-align': 1
  };

  /** sanitizeStyle 允许的 CSS 函数（括号里的内容另有正则约束）。 */
  var SAFE_CSS_FUNCS = ['rgb', 'rgba', 'hsl', 'hsla'];

  /* ---- 保底阈值 ---- */
  var MAX_DEPTH = 200;        // 嵌套层数上限，挡住 `<div<div<div…` 把栈撑爆
  var MAX_TOKENS = 200000;    // token 数上限，超出就截断（防病态输入）

  /* ========================================================================
     转义
     ======================================================================== */

  /**
   * 转义文本。
   *
   * `&` 只在**后面不是合法实体**时才转义（HTML 序列化器的标准做法）：
   * 用户写的 `&amp;` 原样留着，`&` `&foo` 才变成 `&amp;` / `&amp;foo`。
   * 一律转义虽然也「安全」（实体在文本位置本来就是惰性的），但会把
   * `<p>a &amp; b</p>` 变成 `<p>a &amp;amp; b</p>` —— 再解析回来显示的是
   * 字面的 `&amp;`，语义就变了。
   */
  function escapeText(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&(?!(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ========================================================================
     URL 白名单
     ======================================================================== */

  /** 只解码跟「藏协议」有关的实体，不做全量实体解码（避免把用户的 &amp; 之类改写掉）。 */
  var URL_ENTITIES = {
    colon: ':', tab: '\t', newline: '\n', amp: '&', lt: '<', gt: '>',
    quot: '"', apos: "'", sol: '/', nbsp: '\u00a0'
  };

  function decodeForCheck(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, function (m, body) {
      if (body.charAt(0) === '#') {
        var isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        var cp = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
        try { return String.fromCodePoint(cp); } catch (e) { return ''; }
      }
      var key = body.toLowerCase();
      return Object.prototype.hasOwnProperty.call(URL_ENTITIES, key) ? URL_ENTITIES[key] : m;
    });
  }

  /**
   * URL 是否安全。
   *
   * 判定顺序不能换：必须**先解实体、再剥控制字符**，因为
   * `jav&#x09;ascript:` 这类绕过正是靠「实体里藏了个制表符」——
   * 只剥不解它仍然是 `jav&#x09;ascript:`（不匹配 javascript:），
   * 只解不剥它解出来是 `jav\tascript:`（也不匹配）。两步都做才是对的。
   * 浏览器解析 scheme 时同样会忽略内部的 TAB / LF / CR，所以这里一并剥掉
   * 所有 ≤ 0x20 的控制字符和空白（比浏览器还严一点，属于过度拦，方向是安全的）。
   */
  function isSafeUrl(value) {
    var s = decodeForCheck(value).replace(/[\u0000-\u0020\u007f]/g, '');
    if (s === '') return true;                       // 空 href 合法
    var c = s.charAt(0);
    if (c === '#' || c === '/') return true;         // 锚点 / 站内 / 协议相对
    var m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
    if (!m) return true;                             // 没有 scheme → 相对路径
    return SAFE_SCHEMES.indexOf(m[1].toLowerCase()) >= 0;
  }

  /* ========================================================================
     CSS 白名单
     ======================================================================== */

  /**
   * 逐条声明过白名单，返回 `prop: value; prop: value`。
   *
   * 值的正则里**不允许出现括号里的括号**，只有 rgb/rgba/hsl/hsla 四个函数名在
   * 允许列表里 —— 所以 url(...) 和 expression(...) 自然被拒（它们不在函数
   * 名单里，而且参数 `alert(1)` 也过不了字符类）。反斜杠（CSS 转义）、
   * @（@import）、CSS 注释、括号嵌套也一并挡掉。
   * 代价：rgb(0,0,0) / rgba(…) 之外的现代写法（比如 `color-mix()`）会被丢，
   * 编辑器自己不会产生它们。
   */
  function sanitizeStyle(value) {
    var parts = String(value === null || value === undefined ? '' : value).split(';');
    var kept = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var colon = part.indexOf(':');
      if (colon < 0) continue;
      var prop = part.slice(0, colon).trim().toLowerCase();
      var val = part.slice(colon + 1).trim();
      if (!Object.prototype.hasOwnProperty.call(SAFE_CSS_PROPS, prop)) continue;
      if (!val) continue;
      if (/[\\@{}<>]/.test(val)) continue;
      var funcs = val.match(/([a-z-]+)\s*\(/gi);
      var funcOk = true;
      if (funcs) {
        for (var j = 0; j < funcs.length; j++) {
          if (SAFE_CSS_FUNCS.indexOf(funcs[j].slice(0, -1).trim().toLowerCase()) < 0) funcOk = false;
        }
      }
      if (!funcOk) continue;
      // 括号里只允许数字 / 字母 / % . , / 空白 —— 嵌套括号因此不可能通过
      if (!/^[a-z0-9\s#%.,()'"_+-]*$/i.test(val)) continue;
      kept.push(prop + ': ' + val);
    }
    return kept.join('; ');
  }

  /* ========================================================================
     分词
     ======================================================================== */

  /**
   * 找标签的 `>`。必须跳过引号里的内容 —— `<a title="a > b">` 里的 `>`
   * 不是标签结束。按 HTML 规范的规则走。
   * @returns {number} `>` 的下标；没找到返回 -1
   */
  function findTagEnd(html, from) {
    var q = null;
    for (var k = from; k < html.length; k++) {
      var c = html.charAt(k);
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '>') return k;
    }
    return -1;
  }

  /** 属性解析。属性名不允许含 `" ' < > / = ` ` —— 跟 HTML 规范一致。 */
  function parseAttrs(s) {
    var out = [];
    var re = /([^\s=\/"'<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var has = m[2] !== undefined || m[3] !== undefined || m[4] !== undefined;
      out.push({
        name: m[1].toLowerCase(),
        value: m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : '')),
        hasValue: has
      });
    }
    return out;
  }

  /**
   * 把 HTML 切成 {type, name, attrs, selfClose, raw} 的序列。
   * `raw` 是**原样源码切片**，formatHtml 靠它做到「除了空白以外一个字节都不改」。
   *
   * 注释、doctype、处理指令、CDATA 一律不产 token（直接丢掉）。
   */
  function tokenize(html) {
    var s = String(html === null || html === undefined ? '' : html);
    var toks = [];
    var n = s.length;
    var i = 0;
    while (i < n && toks.length < MAX_TOKENS) {
      var lt = s.indexOf('<', i);
      if (lt < 0) { toks.push({ type: 'text', raw: s.slice(i) }); break; }
      if (lt > i) toks.push({ type: 'text', raw: s.slice(i, lt) });

      // 注释 / CDATA / doctype / 处理指令
      if (s.substr(lt, 4) === '<!--') {
        var ce = s.indexOf('-->', lt + 4);
        i = ce < 0 ? n : ce + 3;
        continue;
      }
      if (s.substr(lt, 9).toUpperCase() === '<![CDATA[') {
        var cde = s.indexOf(']]>', lt + 9);
        i = cde < 0 ? n : cde + 3;
        continue;
      }
      if (s.substr(lt, 2) === '<!' || s.substr(lt, 2) === '<?') {
        var de = s.indexOf('>', lt + 2);
        i = de < 0 ? n : de + 1;
        continue;
      }

      var end = findTagEnd(s, lt + 1);
      if (end < 0) {
        // 没有闭合的 '>' —— 剩下整段当文本（浏览器也这么干）
        toks.push({ type: 'text', raw: s.slice(lt) });
        break;
      }
      var inner = s.slice(lt + 1, end);
      var m = /^(\/?)([a-zA-Z][a-zA-Z0-9:_.-]*)([\s\S]*)$/.exec(inner);
      if (!m) {
        toks.push({ type: 'text', raw: '<' });
        i = lt + 1;
        continue;
      }
      i = end + 1;
      if (m[1] === '/') {
        toks.push({ type: 'close', name: m[2].toLowerCase(), raw: s.slice(lt, end + 1) });
        continue;
      }
      var rest = m[3];
      var selfClose = /\/\s*$/.test(rest);
      if (selfClose) rest = rest.replace(/\/\s*$/, '');
      toks.push({
        type: 'open',
        name: m[2].toLowerCase(),
        attrs: parseAttrs(rest),
        selfClose: selfClose,
        raw: s.slice(lt, end + 1)
      });
    }
    return toks;
  }

  /** 从 open token 处开始，吃掉整个子树，返回最后一个被吃掉的 token 下标。 */
  function skipSubtree(toks, i) {
    var name = toks[i].name;
    var depth = 1;
    var j = i + 1;
    while (j < toks.length) {
      if (toks[j].type === 'open' && toks[j].name === name) depth++;
      else if (toks[j].type === 'close' && toks[j].name === name) {
        depth--;
        if (!depth) return j;
      }
      j++;
    }
    return toks.length - 1;   // 标签没闭合 → 吞到结尾
  }

  /* ========================================================================
     属性过滤
     ======================================================================== */

  /** 属性是否在这个标签上被允许。 */
  function isAllowedAttr(tagName, attrName) {
    if (Object.prototype.hasOwnProperty.call(GLOBAL_ATTRS, attrName)) return true;
    var per = TAG_ATTRS[tagName];
    return !!(per && Object.prototype.hasOwnProperty.call(per, attrName));
  }

  /**
   * 一个标签的属性列表 → 清洗后的 [{name, value}]。
   *  · 不在白名单 → 丢
   *  · 重复出现 → 只留第一个
   *  · URL 属性 → 过 isSafeUrl
   *  · style → 过 sanitizeStyle，清完为空就丢
   *  · target 只留 _blank / _self
   * @returns {Array<{name:string, value:string}>}
   */
  function filterAttrs(tagName, attrs, out) {
    var kept = [];
    var seen = {};
    out = out || [];
    (attrs || []).forEach(function (a) {
      if (!a || !a.name || seen[a.name]) return;
      if (!isAllowedAttr(tagName, a.name)) return;
      var value = a.value;
      if (Object.prototype.hasOwnProperty.call(URL_ATTRS, a.name) && !isSafeUrl(value)) return;
      if (a.name === 'style') {
        value = sanitizeStyle(value);
        if (!value) return;
      }
      if (a.name === 'target' && value !== '_blank' && value !== '_self') return;
      seen[a.name] = true;
      kept.push({ name: a.name, value: value });
    });
    // 反向标签劫持：新窗口必须断开 opener
    if (tagName === 'a') {
      var tgt = null;
      kept.forEach(function (k) { if (k.name === 'target') tgt = k.value; });
      if (tgt === '_blank') {
        var hasRel = kept.some(function (k) { return k.name === 'rel'; });
        if (!hasRel) kept.push({ name: 'rel', value: 'noopener noreferrer' });
      }
    }
    return kept;
  }

  function serializeAttrs(attrs) {
    var out = '';
    for (var i = 0; i < attrs.length; i++) {
      out += ' ' + attrs[i].name + '="' + escapeAttr(attrs[i].value) + '"';
    }
    return out;
  }

  /* ========================================================================
     主清洗函数
     ======================================================================== */

  function toSet(list) {
    var set = {};
    (list || []).forEach(function (item) { set[String(item).toLowerCase()] = 1; });
    return set;
  }

  /**
   * 白名单清洗。
   *
   * 不是「黑名单过滤」而是「重新序列化」：所有标签名走白名单，所有属性重新
   * 拼出来并转义引号，文本重新转义 & < >。输出里不可能残留任何原始标记，
   * 所以浏览器再解析一遍也只能得到同样的东西（这一点是 mXSS 的关键 ——
   * 「过滤后原样塞回去」和「过滤后重新序列化」的安全性差很远）。
   *
   * 标签嵌套不匹配时按「补齐中间层」处理：`</b>` 撞上 `<p>` 会先补 `</p>`
   * 再输出 `</b>`；孤立的闭标签直接丢；没关的标签在结尾补齐。
   *
   * @param {string} html
   * @param {string[]} [allowedTags] 省略则用 DEFAULT_ALLOWED_TAGS
   * @returns {string}
   */
  function sanitizeHtml(html, allowedTags) {
    var allowed = toSet(allowedTags === null || allowedTags === undefined ? DEFAULT_ALLOWED_TAGS : allowedTags);
    var toks = tokenize(html);
    var out = [];
    var stack = [];
    var overflow = false;

    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];

      if (tk.type === 'text') { out.push(escapeText(tk.raw)); continue; }

      var name = tk.name;

      if (tk.type === 'open') {
        if (DROP_SUBTREE[name]) { i = skipSubtree(toks, i); continue; }
        if (!allowed[name]) continue;                     // 拆包：留内容不留标签
        var attrs = filterAttrs(name, tk.attrs);
        if (VOID_TAGS[name]) { out.push('<' + name + serializeAttrs(attrs) + '>'); continue; }
        if (overflow) continue;                           // 已经超过 MAX_DEPTH，后面全是拆包
        out.push('<' + name + serializeAttrs(attrs) + '>');
        // 自闭合标记（`<div/>`）对非 void 标签没有意义 —— 按开标签处理并入栈，
        // 这样输出永远是平衡的，不会漏掉闭标签
        if (stack.length >= MAX_DEPTH) overflow = true;
        else stack.push(name);
        continue;
      }

      // close
      if (!allowed[name] || VOID_TAGS[name]) continue;
      var at = stack.lastIndexOf(name);
      if (at < 0) continue;                               // 孤立的闭标签，丢
      for (var k = stack.length - 1; k >= at; k--) out.push('</' + stack[k] + '>');
      stack.length = at;
      if (!overflow) continue;                            // overflow 时栈已被冻结
      overflow = false;
    }
    for (var k2 = stack.length - 1; k2 >= 0; k2--) out.push('</' + stack[k2] + '>');
    return out.join('');
  }

  /* ========================================================================
     保守的 HTML 缩进（替代 prettier）
     ======================================================================== */

  /** 参与换行缩进的块级标签。注意 br 不算 —— 它是换行本身，当块级会多切一刀。 */
  var BLOCK_TAGS = {
    address: 1, article: 1, aside: 1, blockquote: 1, caption: 1, col: 1,
    colgroup: 1, dd: 1, details: 1, div: 1, dl: 1, dt: 1, fieldset: 1,
    figcaption: 1, figure: 1, footer: 1, form: 1, h1: 1, h2: 1, h3: 1, h4: 1,
    h5: 1, h6: 1, header: 1, hgroup: 1, hr: 1, li: 1, main: 1, nav: 1, ol: 1,
    p: 1, pre: 1, section: 1, summary: 1, table: 1, tbody: 1, td: 1, tfoot: 1,
    th: 1, thead: 1, tr: 1, ul: 1
  };

  /** 内容是纯文本（不能插空白）的标签 —— 进去之后原样输出，一个字节都不动。 */
  var PRESERVE_TAGS = { pre: 1, textarea: 1, script: 1, style: 1 };

  /**
   * 安全的块级缩进，替代 prettier（见文件头第 2 条）。
   *
   * **保证**（每一条都对应一类会被改坏的 HTML）：
   *  · 非空白文本原样输出，不重排、不折行、不 trim；
   *  · 属性写法一字不改（不加引号、不调顺序、不改成自闭合）；
   *  · `pre` / `textarea` / `script` / `style` 内部原样输出；
   *  · 注释 / doctype 已经在分词阶段丢了。
   *
   * **代价**（明说，免得被当成 prettier 的等价物）：
   *  · 不统一空白（`  <p>` 还是 `  <p>`）；
   *  · 不重排属性、不把 `<br>` 写成 `<br />`、不改 `<img>` 的自闭合形式；
   *  · 内联元素整串留在同一行，不会拆开。
   * 这三条都是「不动」而不是「做不到」，是刻意的：少写一次就少错一次，
   * 而这个按钮的价值只是让长 HTML 读起来不挤。
   */
  function formatHtml(html) {
    var toks = tokenize(html);
    var lines = [];
    var cur = '';
    var indent = 0;
    // 处于哪个「原样输出」的标签内部；null = 正常缩进。
    // 用名字而不是计数器：遇到它的闭标签时要交回正常流程（否则缩进不会退回来）
    var preserveUntil = null;

    function pad() { return new Array(indent + 1).join('  '); }

    function flush() {
      if (cur !== '') { lines.push(cur); cur = ''; }
    }

    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];

      /* 在 pre / textarea / script / style 里面：逐 token 原样拼回去。
         里面的换行和缩进都是内容的一部分，一个字节都不动。 */
      if (preserveUntil !== null) {
        if (tk.type === 'close' && tk.name === preserveUntil) {
          preserveUntil = null;          // 交回正常流程，让缩进正常退一级
        } else {
          cur += tk.raw;
          continue;
        }
      }

      if (tk.type === 'text') {
        // 纯空白且当前行还没内容 → 丢掉（否则块级之间会多出空行）
        if (!/^\s*$/.test(tk.raw) || cur !== '') cur += tk.raw;
        continue;
      }

      var name = tk.name;

      if (tk.type === 'open') {
        if (PRESERVE_TAGS[name] && !tk.selfClose) preserveUntil = name;
        if (BLOCK_TAGS[name]) {
          flush();                       // 上一行还没收尾就先收尾
          cur = pad() + tk.raw;
          if (!tk.selfClose) indent++;
        } else {
          cur += tk.raw;                 // 行内：跟在当前行后面，不换行
        }
        continue;
      }

      /* 闭标签 */
      if (!BLOCK_TAGS[name]) { cur += tk.raw; continue; }

      // 先退一级：闭标签本身属于上一层
      if (indent > 0) indent--;
      if (cur !== '') { cur += tk.raw; flush(); }   // 本行有内容 → 补上再收行
      else cur = pad() + tk.raw;                    // 本行空 → 闭标签独占一行
    }
    flush();
    return lines.join('\n');
  }

  /* ========================================================================
     UI
     ======================================================================== */

  window.ItTools.register('html-wysiwyg-editor', function (root) {
    var visual = D.h('div.preview-box.preview-box-doc', {
      contenteditable: 'true',
      spellcheck: 'false',
      role: 'textbox',
      'aria-multiline': 'true',
      style: {
        minHeight: '240px', textAlign: 'left',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '13px', lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
      }
    });
    // 原版的源码框是 monospace 的
    var source = D.h('textarea.layui-textarea.mono', {
      rows: 14, spellcheck: 'false',
      style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px' }
    });
    source.style.display = 'none';
    // 原版页面底部还有一张「格式化后的 HTML」代码卡（TextareaCopyable），
    // 里面是当前内容的格式化结果。
    var outputCard = U.codeBlock();
    var status = D.h('span.form-status');
    var toolbar = D.h('div.form-actions');
    var paneActions = D.h('div.form-actions');

    var DEFAULT_HTML = '<h1>Hey!</h1><p>Welcome to this html wysiwyg editor</p>';
    source.value = DEFAULT_HTML;
    // 初始渲染也走清洗 —— 页面上的所有 HTML 都只有这一个入口
    visual.innerHTML = sanitizeHtml(DEFAULT_HTML);

    /* ---- 富文本命令 ---- */

    // jsdom 不实现 execCommand，老浏览器也可能已经移除；没有就只留源码视图可用
    var canExec = typeof window.document !== 'undefined'
      && typeof window.document.execCommand === 'function';

    function exec(cmd, value) {
      if (!canExec) {
        say(t('err_no_execcommand', 'This browser does not support document.execCommand.'), true);
        return;
      }
      try {
        visual.focus();
        if (canExec && !styledOnce) {
          // 让 justify* 产生 style="text-align:…" 而不是 <center> 标签
          window.document.execCommand('styleWithCSS', false, true);
          styledOnce = true;
        }
        window.document.execCommand(cmd, false, value === undefined ? null : value);
        status.className = 'form-status';
        status.textContent = '';
      } catch (e) {
        say(t('err_command_failed', 'Command "{cmd}" failed: {msg}')
          .replace('{cmd}', cmd).replace('{msg}', e.message), true);
      }
    }
    var styledOnce = false;

    function say(text, isError) {
      status.className = isError ? 'form-status is-error' : 'form-status';
      status.textContent = text;
    }

    function btn(label, title, onClick) {
      return D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
        type: 'button', text: label, title: title, onclick: onClick
      });
    }

    toolbar.appendChild(btn('B', t('bold', 'Bold'), function () { exec('bold'); }));
    toolbar.appendChild(btn('I', t('italic', 'Italic'), function () { exec('italic'); }));
    toolbar.appendChild(btn('U', t('underline', 'Underline'), function () { exec('underline'); }));
    toolbar.appendChild(btn('S', t('strikethrough', 'Strikethrough'), function () { exec('strikeThrough'); }));
    toolbar.appendChild(btn('❝', t('blockquote', 'Blockquote'), function () { exec('formatBlock', '<blockquote>'); }));

    var blocks = D.h('select.layui-input', null,
      ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote'].map(function (tag) {
        return D.h('option', {
          value: '<' + tag + '>',
          text: tag === 'p' ? t('paragraph', 'Paragraph')
            : tag === 'blockquote' ? t('blockquote_quote', 'BLOCKQUOTE (quote)')
            : tag.toUpperCase()
        });
      })
    );
    D.on(blocks, 'change', function () { exec('formatBlock', blocks.value); });
    toolbar.appendChild(blocks);

    toolbar.appendChild(btn(t('label_bullet_list', '• List'), t('bullet_list', 'Bullet list'),
      function () { exec('insertUnorderedList'); }));
    toolbar.appendChild(btn(t('label_ordered_list', '1. List'), t('ordered_list', 'Ordered list'),
      function () { exec('insertOrderedList'); }));
    toolbar.appendChild(btn('🔗', t('insert_link', 'Insert link'), insertLink));
    toolbar.appendChild(btn('⇤', t('align_left', 'Align left'), function () { exec('justifyLeft'); }));
    toolbar.appendChild(btn('⇔', t('align_center', 'Align center'), function () { exec('justifyCenter'); }));
    toolbar.appendChild(btn('⇥', t('align_right', 'Align right'), function () { exec('justifyRight'); }));
    toolbar.appendChild(btn('✕', t('clear_formatting', 'Clear formatting'), function () { exec('removeFormat'); }));
    toolbar.appendChild(status);

    function insertLink() {
      if (!canExec) {
        say(t('err_no_execcommand', 'This browser does not support document.execCommand.'), true);
        return;
      }
      var url = window.prompt(t('prompt_link_url', 'Link URL (http://, https://, mailto: or a relative path):'), 'https://');
      if (url === null) return;
      url = String(url).trim();
      if (!url) { say(t('err_empty_url', 'Empty URL, nothing inserted.')); return; }
      // 和清洗走同一道 URL 白名单：不让用户把 javascript: 通过编辑器插进来
      if (!isSafeUrl(url)) {
        say(t('err_unsafe_url',
          'Refused "{url}" — only http/https/mailto/tel/ftp and relative URLs are allowed.')
          .replace('{url}', url), true);
        return;
      }
      exec('createLink', url);
      say(t('link_inserted', 'Link inserted.'));
    }

    /* ---- 源码视图 ---- */

    /** 把当前内容（可视区或源码区 whichever 正在编辑）同步到下面的代码卡 */
    function syncOutput() {
      var raw = source.style.display === 'none' ? visual.innerHTML : source.value;
      outputCard.value = formatHtml(raw);
    }

    function showSource() {
      source.value = visual.innerHTML;
      source.style.display = '';
      visual.style.display = 'none';
      source.removeAttribute('readonly');
      say(t('editing_source', 'Editing source — press "Preview" to render it (the HTML is sanitized).'));
    }
    function showVisual() {
      var cleaned = sanitizeHtml(source.value);
      if (cleaned !== source.value) say(t('source_changed', 'Source changed: unsupported tags/attributes were removed.'));
      else say('');
      visual.innerHTML = cleaned;
      source.value = cleaned;
      source.style.display = 'none';
      visual.style.display = '';
      syncOutput();
    }

    paneActions.appendChild(btn('<>', t('toggle_source', 'Toggle source / preview'), function () {
      if (source.style.display === 'none') showSource(); else showVisual();
    }));
    paneActions.appendChild(btn('⇥', t('indent_tags', 'Indent block level tags (safe pretty printer)'), function () {
      var target = source.style.display === 'none' ? visual.innerHTML : source.value;
      var formatted = formatHtml(target);
      if (source.style.display === 'none') {
        visual.innerHTML = sanitizeHtml(formatted);
        say(t('indented', 'Indented.'));
      } else {
        source.value = formatted;
        say(t('indented', 'Indented.'));
      }
      syncOutput();
    }));
    paneActions.appendChild(U.copyButton(function () { return visual.innerHTML; }, t('copy_html', 'Copy HTML')));
    paneActions.appendChild(D.h('span.field-hint', {
      text: canExec
        ? t('hint_sanitized', 'Pasted content and the source view are both sanitized before rendering.')
        : t('hint_no_execcommand', 'document.execCommand is unavailable in this browser — use the source view only.')
    }));

    /* ---- 粘贴：这是 contenteditable 真正会出事的地方 ---- */
    function onPaste(evt) {
      var dt = evt.clipboardData || window.clipboardData;
      if (!dt) return;
      var html = null;
      if (dt.types && dt.types.length && String(dt.types).indexOf('text/html') >= 0 && dt.getData) {
        html = dt.getData('text/html');
      }
      // 拦下默认行为，我们自己插 —— 不让它把 onerror 之类直接塞进 DOM
      evt.preventDefault();
      if (html) {
        visual.innerHTML = sanitizeHtml(html);
        say(t('paste_sanitized', 'Pasted HTML was sanitized.'));
      } else if (dt.getData) {
        // 纯文本粘贴：转义后作为文本插入，绝不走 innerHTML
        document.execCommand('insertText', false, dt.getData('text/plain'));
      }
    }
    var offPaste = D.on(visual, 'paste', onPaste);
    var offInput = D.on(visual, 'input', syncOutput);
    var offSourceInput = D.on(source, 'input', syncOutput);

    root.appendChild(D.h('div.card', null,
      D.h('div.tool-separator'),
      toolbar,
      // 原版：菜单栏 → n-divider（margin-top: 0）→ 编辑区
      U.divider(0),
      D.h('div.input-group', null, visual, source),
      paneActions
    ));

    // 原版：编辑区下面是一张 TextareaCopyable（格式化后的 HTML）
    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('output_html', 'Formatted HTML') }),
      outputCard.card
    ));

    syncOutput();

    return {
      destroy: function () {
        offPaste();
        offInput();
        offSourceInput();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['html-wysiwyg-editor'] = {
    DEFAULT_ALLOWED_TAGS: DEFAULT_ALLOWED_TAGS,
    DROP_SUBTREE: DROP_SUBTREE,
    VOID_TAGS: VOID_TAGS,
    GLOBAL_ATTRS: GLOBAL_ATTRS,
    TAG_ATTRS: TAG_ATTRS,
    SAFE_SCHEMES: SAFE_SCHEMES,
    SAFE_CSS_PROPS: SAFE_CSS_PROPS,
    BLOCK_TAGS: BLOCK_TAGS,
    PRESERVE_TAGS: PRESERVE_TAGS,
    escapeText: escapeText,
    escapeAttr: escapeAttr,
    decodeForCheck: decodeForCheck,
    isSafeUrl: isSafeUrl,
    sanitizeStyle: sanitizeStyle,
    findTagEnd: findTagEnd,
    parseAttrs: parseAttrs,
    tokenize: tokenize,
    skipSubtree: skipSubtree,
    isAllowedAttr: isAllowedAttr,
    filterAttrs: filterAttrs,
    serializeAttrs: serializeAttrs,
    toSet: toSet,
    sanitizeHtml: sanitizeHtml,
    formatHtml: formatHtml,

    __cases: function (assert) {
      /* ================= 转义 ================= */
      assert.eq(escapeText('<a href="x">&</a>'), '&lt;a href="x"&gt;&amp;&lt;/a&gt;',
        '文本只转义 & < >，引号不归它管（那是 escapeAttr 的事）');
      assert.eq(escapeText('a &amp; b'), 'a &amp; b', '合法实体不重复转义');
      assert.eq(escapeText('a & b'), 'a &amp; b', '裸的 & 要转义');
      assert.eq(escapeText('&#65;'), '&#65;', '数值实体也认');
      assert.eq(escapeText('&1'), '&amp;1', '&# 后面不是数字 → 转义');
      assert.eq(escapeText('& foo'), '&amp; foo', '& 后面是空格 → 转义');
      // 「合法实体」按语法判定（& 后面跟着字母数字再跟分号），不查表。
      // 浏览器也是这么做的：&notanentity; 会被最长匹配解成 &not + anentity;。
      // 文本位置的实体是惰性的，留着不会变成标记，
      // 而转义反倒会把用户的 &amp; 变成 &amp;amp;（语义就坏了）。
      assert.eq(escapeText('&notanentity;'), '&notanentity;', '语法像实体就原样留（与浏览器一致）');
      assert.eq(escapeText(''), '', '空串');
      assert.eq(escapeText(null), '', 'null → 空串');
      assert.eq(escapeText(undefined), '', 'undefined → 空串');
      assert.eq(escapeAttr('a"b\'c<d>&e'), 'a&quot;b&#39;c&lt;d&gt;&amp;e', '属性再补两种引号');
      assert.eq(escapeAttr(null), '', 'null → 空串（继承了 escapeText 的兜底）');

      /* ================= URL 白名单 ================= */
      assert(isSafeUrl('https://example.com/a?b=1#c'), 'https');
      assert(isSafeUrl('http://example.com'), 'http');
      assert(isSafeUrl('mailto:a@b.com'), 'mailto');
      assert(isSafeUrl('tel:+123'), 'tel');
      assert(isSafeUrl('/relative/path'), '绝对路径');
      assert(isSafeUrl('relative.html'), '相对路径');
      assert(isSafeUrl('#anchor'), '锚点');
      assert(isSafeUrl('//cdn.example.com/x.js'), '协议相对');
      assert(isSafeUrl(''), '空串合法');
      assert(!isSafeUrl('javascript:alert(1)'), 'javascript:');
      assert(!isSafeUrl('JavaScript:alert(1)'), '大小写变体');
      assert(!isSafeUrl('JAVASCRIPT:alert(1)'), '全大写');
      assert(!isSafeUrl('  javascript:alert(1)'), '前导空白');
      assert(!isSafeUrl('\tjavascript:alert(1)'), '前导制表符');
      assert(!isSafeUrl('java\tscript:alert(1)'), '中间插制表符');
      assert(!isSafeUrl('java\nscript:alert(1)'), '中间插换行');
      assert(!isSafeUrl('java\r\nscript:alert(1)'), '中间插 CRLF');
      assert(!isSafeUrl('java script:alert(1)'), '中间插空格');
      assert(!isSafeUrl('java\u0000script:alert(1)'), '中间插 NUL');
      assert(!isSafeUrl('jav&#x09;ascript:alert(1)'), '实体藏制表符');
      assert(!isSafeUrl('jav&#9;ascript:alert(1)'), '十进制实体藏制表符');
      assert(!isSafeUrl('javascript&colon;alert(1)'), '&colon; 实体');
      assert(!isSafeUrl('javascript&COLON;alert(1)'), '命名实体大小写');
      assert(!isSafeUrl('javascript&#58;alert(1)'), '&#58;');
      assert(!isSafeUrl('&#106;avascript:alert(1)'), '实数字母开头');
      assert(!isSafeUrl('&#0000106;avascript:alert(1)'), '前导零数值实体');
      assert(!isSafeUrl('vbscript:msgbox(1)'), 'vbscript:');
      assert(!isSafeUrl('data:text/html;base64,PHNjcmlwdD4='), 'data:text/html');
      assert(!isSafeUrl('data:image/svg+xml,<svg onload=alert(1)>'), 'data: 一律不放行');
      assert(!isSafeUrl('file:///etc/passwd'), 'file:');
      assert(!isSafeUrl('blob:https://x/y'), 'blob:');
      assert(!isSafeUrl('JaVaScRiPt&colon;alert(1)'), '混合大小写 + 实体');
      assert.eq(decodeForCheck('a&amp;b'), 'a&b', '&amp; 被解码（不相关的实体也解，够用即可）');
      assert.eq(decodeForCheck('&unknownentity;'), '&unknownentity;', '不认识的命名实体原样保留');
      assert.eq(decodeForCheck('&#x1F600;'), '😀', '十六进制数值实体');
      assert.eq(decodeForCheck('&#999999999999;'), '', '越界的数值实体');

      /* ================= CSS 白名单 ================= */
      assert.eq(sanitizeStyle('text-align: center'), 'text-align: center', '对齐保留');
      assert.eq(sanitizeStyle('color:red;background-color:#fff'), 'color: red; background-color: #fff', '颜色保留');
      assert.eq(sanitizeStyle('position: fixed; top: 0'), '', 'position / top 不在名单 → 整条丢');
      assert.eq(sanitizeStyle('background-image: url(javascript:alert(1))'), '', 'url() 被拒');
      assert.eq(sanitizeStyle('width: expression(alert(1))'), '', 'expression() 被拒（width 也不在名单，双重保险）');
      assert.eq(sanitizeStyle('color: red; position: absolute'), 'color: red', '逐条过滤而不是整条丢弃');
      assert.eq(sanitizeStyle('behavior: url(#default#time2)'), '', 'IE behavior');
      assert.eq(sanitizeStyle('-moz-binding: url(x.xml#y)'), '', '-moz-binding');
      assert.eq(sanitizeStyle('@import "evil.css"'), '', '@import');
      assert.eq(sanitizeStyle('color: rgb(255, 0, 0)'), 'color: rgb(255, 0, 0)', 'rgb() 在允许的函数名单里');
      assert.eq(sanitizeStyle('color: rgba(255,0,0,.5)'), 'color: rgba(255,0,0,.5)', 'rgba()');
      assert.eq(sanitizeStyle('color: var(--x)'), '',
        'var() 也不放行 —— 它能把值指向页面上别处定义的变量，等于开了个后门');
      assert.eq(sanitizeStyle(''), '', '空串');
      assert.eq(sanitizeStyle(null), '', 'null');
      assert.eq(sanitizeStyle('nonsense'), '', '没有冒号 → 丢');
      assert.eq(sanitizeStyle('color:'), '', '值为空 → 丢');
      assert.eq(sanitizeStyle('COLOR: Red'), 'color: Red', '属性名小写化，值保留原样');
      assert.eq(sanitizeStyle('color: red /* x */'), '', 'CSS 注释被字符类挡掉');

      /* ================= 分词 ================= */
      assert.eq(findTagEnd('<a title="a > b">x', 1), 16, '引号里的 > 不是标签结束');
      assert.eq(findTagEnd("<a title='a > b'>x", 1), 16, '单引号同理');
      assert.eq(findTagEnd('<a>x', 1), 2, '普通标签');
      assert.eq(findTagEnd('<a', 1), -1, '没有 > 返回 -1');

      assert.eq(parseAttrs(' href="x" target=_blank hidden').map(function (a) { return a.name + '=' + a.value + ':' + a.hasValue; }),
        ['href=x:true', 'target=_blank:true', 'hidden=:false'], '三种取值形式 + 无值属性');
      assert.eq(parseAttrs(''), [], '空串');
      assert.eq(parseAttrs('a/b=c'),
        [{ name: 'a', value: '', hasValue: false }, { name: 'b', value: 'c', hasValue: true }],
        '属性名里不能带 / —— 所以 a/b=c 被切成两个属性（浏览器也是这么解析的）');
      assert.eq(parseAttrs('HREF="X"'), [{ name: 'href', value: 'X', hasValue: true }], '属性名小写、值原样');

      var toks = tokenize('<p class="a">hi</p><!-- c --><br/>');
      assert.eq(toks.map(function (t) { return t.type + (t.name ? ':' + t.name : ''); }),
        ['open:p', 'text', 'close:p', 'open:br'], '注释被丢掉');
      assert.eq(toks[0].selfClose, false, 'p 不是自闭合');
      assert.eq(toks[3].selfClose, true, '<br/> 是自闭合');
      assert.eq(toks[1].raw, 'hi', 'raw 是原样源码切片');
      assert.eq(tokenize('<!-- <script> -->').length, 0, '注释里藏标签也没用');
      assert.eq(tokenize('<!DOCTYPE html><p>x</p>').length, 3, 'doctype 被丢掉（剩下 open p / text / close p）');
      assert.eq(tokenize('a < b').map(function (t) { return t.type; }), ['text', 'text'], '裸的 < 退化成文本');
      assert.eq(tokenize('<p').map(function (t) { return t.type; }), ['text'], '没闭合的标签当文本');
      assert.eq(tokenize(''), [], '空串');

      /* ================= sanitizeHtml：必须挡住的 ================= */
      assert.eq(sanitizeHtml('<script>alert(1)</script>'), '', 'script 连内容一起丢');
      assert.eq(sanitizeHtml('<SCRIPT>alert(1)</SCRIPT>'), '', '大小写无关');
      assert.eq(sanitizeHtml('<script src="//evil.com/x.js"></script>'), '', '外链 script');
      assert.eq(sanitizeHtml('a<script>alert(1)</script>b'), 'ab', 'script 只影响自己那一段');
      assert.eq(sanitizeHtml('<script>var s = "</p>";</script><p>x</p>'), '<p>x</p>', 'script 里藏 </p> 也吃干净');
      assert.eq(sanitizeHtml('<style>body{background:url(javascript:1)}</style><p>x</p>'), '<p>x</p>', 'style 连内容一起丢');
      assert.eq(sanitizeHtml('<svg onload=alert(1)></svg>'), '', 'svg 整个丢（外层内容藏 script 的入口）');
      assert.eq(sanitizeHtml('<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>'), '',
        '经典 mXSS 链');
      assert.eq(sanitizeHtml('<img src=x onerror=alert(1)>'), '<img src="x">', 'onerror 被剥');
      assert.eq(sanitizeHtml('<img src=x OnErRoR=alert(1)>'), '<img src="x">', '属性名大小写无关');
      assert.eq(sanitizeHtml('<img src=x onerror=alert(1)//>'), '<img src="x">', '畸形属性分隔符');
      assert.eq(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>', 'javascript: href 被剥，文本留下');
      assert.eq(sanitizeHtml('<a href="JaVaScRiPt&colon;alert(1)">x</a>'), '<a>x</a>', '实体藏冒号');
      assert.eq(sanitizeHtml('<a href="/ok" onclick="alert(1)">x</a>'), '<a href="/ok">x</a>', 'href 留、onclick 丢');
      assert.eq(sanitizeHtml('<p onmouseover=alert(1)>x</p>'), '<p>x</p>', 'onmouseover');
      assert.eq(sanitizeHtml('<p onclick=alert(1)>x</p>'), '<p>x</p>', 'onclick');
      assert.eq(sanitizeHtml('<div style="position:fixed;top:0;left:0;width:100vw;height:100vh"></div>'), '<div></div>',
        '遮住整个界面的 style 被清空');
      assert.eq(sanitizeHtml('<div style="color:red"></div>'), '<div style="color: red"></div>', '无害的 style 留下');
      assert.eq(sanitizeHtml('<iframe src="//evil.com"></iframe>'), '', 'iframe 连内容丢');
      assert.eq(sanitizeHtml('<object data="x.swf"></object>'), '', 'object');
      assert.eq(sanitizeHtml('<embed src="x.swf">'), '', 'embed');
      assert.eq(sanitizeHtml('<base href="//evil.com/">'), '', 'base（会改掉所有相对链接）');
      assert.eq(sanitizeHtml('<meta http-equiv="refresh" content="0;url=//evil.com">'), '', 'meta refresh');
      assert.eq(sanitizeHtml('<link rel="stylesheet" href="//evil.com/x.css">'), '', '外链样式表');
      assert.eq(sanitizeHtml('<template><img src=x onerror=alert(1)></template>'), '', 'template 子树');
      assert.eq(sanitizeHtml('<form action="//evil.com"><input name=pw></form>'), '',
        '仿登录表单连内容一起丢（取舍见文件头）');
      assert.eq(sanitizeHtml('<textarea><img src=x onerror=alert(1)></textarea>'), '', 'textarea 子树');
      assert.eq(sanitizeHtml('<body onload=alert(1)><p>x</p></body>'), '<p>x</p>', 'body 上的事件属性被剥（标签拆包）');
      assert.eq(sanitizeHtml('<p onclick="alert(1)" ONCLICK="alert(2)">x</p>'), '<p>x</p>', '重复属性两条都丢');
      assert.eq(sanitizeHtml('<a href="https://a" href="javascript:b">x</a>'), '<a href="https://a">x</a>',
        '同名属性只留第一个，后面的绕过写法没机会生效');

      /* ================= sanitizeHtml：正文必须原样保留 ================= */
      assert.eq(sanitizeHtml('<p>hello <b>world</b></p>'), '<p>hello <b>world</b></p>', '普通富文本不动');
      assert.eq(sanitizeHtml('<h1>Hey!</h1><p>Welcome</p>'), '<h1>Hey!</h1><p>Welcome</p>', '默认首屏内容原样通过');
      assert.eq(sanitizeHtml('<ul><li>a</li><li>b</li></ul>'), '<ul><li>a</li><li>b</li></ul>', '列表');
      assert.eq(sanitizeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d', '裸的尖括号转义，& 被转义');
      assert.eq(sanitizeHtml('<p>a &amp; b</p>'), '<p>a &amp; b</p>', '已有实体保持实体（不重复转义成 &amp;amp;）');
      assert.eq(sanitizeHtml('<em>x</em><strong>y</strong>'), '<em>x</em><strong>y</strong>', '行内标签');
      assert.eq(sanitizeHtml('<img src="https://x/y.png" alt="a">'), '<img src="https://x/y.png" alt="a">', '图片');
      assert.eq(sanitizeHtml('<a href="https://x" target="_blank">y</a>'),
        '<a href="https://x" target="_blank" rel="noopener noreferrer">y</a>', '_blank 自动补 rel');
      assert.eq(sanitizeHtml('<a href="https://x" target="_blank" rel="nofollow">y</a>'),
        '<a href="https://x" target="_blank" rel="nofollow">y</a>', '已有 rel 就不覆盖');
      assert.eq(sanitizeHtml('<a target="_blank">y</a>'),
        '<a target="_blank" rel="noopener noreferrer">y</a>', '只有 target 也要补 rel');
      assert.eq(sanitizeHtml('<table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table>'),
        '<table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table>', '表格');
      assert.eq(sanitizeHtml('<p style="text-align: center">x</p>'), '<p style="text-align: center">x</p>', '编辑器自己的对齐');
      assert.eq(sanitizeHtml('<hr>'), '<hr>', '空元素');
      assert.eq(sanitizeHtml('<p></p>'), '<p></p>', '自闭合写法的开标签也照样闭合输出');

      /* ================= sanitizeHtml：拆包 / 补齐 ================= */
      assert.eq(sanitizeHtml('<font color="red">hi</font>'), 'hi', '不在名单的标签被拆包，内容留下');
      assert.eq(sanitizeHtml('<span class="x" data-y="1">hi</span>'), '<span>hi</span>', 'class / data-* 不在白名单');
      assert.eq(sanitizeHtml('<p>unclosed'), '<p>unclosed</p>', '没关的标签在结尾补齐');
      assert.eq(sanitizeHtml('<b><i>x</b></i>'), '<b><i>x</i></b>', '交叉嵌套被理顺');
      assert.eq(sanitizeHtml('</p>text'), 'text', '孤立闭标签丢掉');
      assert.eq(sanitizeHtml('</b></i>'), '', '只有孤立闭标签');
      assert.eq(sanitizeHtml('<b>a</b></b>'), '<b>a</b>', '多出来的闭标签丢掉');
      assert.eq(sanitizeHtml('<p/>text'), '<p>text</p>',
        '<p/> 按开标签处理并补上闭标签 —— 浏览器解析 <p/>text 也得到 <p>text</p>');
      assert.eq(sanitizeHtml('<br/><br>'), '<br><br>', '空元素统一输出 HTML5 形式');
      assert.eq(sanitizeHtml(''), '', '空串');
      assert.eq(sanitizeHtml(null), '', 'null');
      assert.eq(sanitizeHtml(undefined), '', 'undefined');
      assert.eq(sanitizeHtml('<p>x</p>', []), 'x', '允许标签传空数组 → 全拆包');
      assert.eq(sanitizeHtml('<p>x</p>', ['P']), '<p>x</p>', '允许列表大小写无关');

      /* ---- 深度与长度保底 ---- */
      var deep = new Array(500).join('<div>') + 'x' + new Array(500).join('</div>');
      var outDeep = sanitizeHtml(deep);
      assert(outDeep.indexOf('<div>') === 0, '深嵌套开头仍然输出');
      assert(outDeep.indexOf('<script') < 0, '深嵌套也不会吐出危险标签');
      assert(sanitizeHtml('<!--'.repeat(1) + '<script>alert(1)</script>').indexOf('alert') < 0, '截断的注释里藏 script');

      /* ================= formatHtml ================= */
      assert.eq(formatHtml('<p>hello <b>world</b></p>'), '<p>hello <b>world</b></p>', '单行块级不加工具');
      assert.eq(formatHtml('<h1>a</h1><p>b</p>'), '<h1>a</h1>\n<p>b</p>', '兄弟块级之间换行，缩进退回同级');
      assert.eq(formatHtml('<h1>a</h1>\n<p>b</p>'), '<h1>a</h1>\n<p>b</p>', '原有的块级间空白被丢掉，不留空行');
      assert.eq(formatHtml('<ul><li>a</li><li>b</li></ul>'),
        '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>', '列表逐层缩进');
      assert.eq(formatHtml('<span>a</span><span>b</span>'), '<span>a</span><span>b</span>', '行内元素不拆行');
      assert.eq(formatHtml('<p>a<br>b</p>'), '<p>a<br>b</p>', 'br 是行内，不多切一刀');
      assert.eq(formatHtml(''), '', '空串');
      assert.eq(formatHtml('   '), '', '纯空白没有内容可输出');
      assert.eq(formatHtml('plain text'), 'plain text', '纯文本');
      assert.eq(formatHtml('<p>a</p><p>b</p>'), '<p>a</p>\n<p>b</p>', '兄弟块级之间的缩进会退回 0');

      // 非空白内容一字不改
      assert.eq(formatHtml('<p   class="a"    id=\'b\'>x</p>'), '<p   class="a"    id=\'b\'>x</p>', '属性写法一字不改');
      assert.eq(formatHtml('<br/>'), '<br/>', '不把 <br/> 改成 <br />');
      assert.eq(formatHtml('<img src=x>'), '<img src=x>', '不给属性补引号');
      assert.eq(formatHtml('<p>a   b</p>'), '<p>a   b</p>', '正文里的连续空格保留（pre-wrap 下是有意义的）');
      assert.eq(formatHtml('<pre>  a\n    b</pre>'), '<pre>  a\n    b</pre>', 'pre 内部原样');
      assert.eq(formatHtml('<pre>\n<p>x</p>\n</pre>'), '<pre>\n<p>x</p>\n</pre>', 'pre 里的标签也不重排');
      assert.eq(formatHtml('<textarea>  a\n  b</textarea>'), '<textarea>  a\n  b</textarea>', 'textarea 内部原样');
      assert.eq(formatHtml('<style>  a\n  b</style>'), '<style>  a\n  b</style>', 'style 内部原样');

      // 清洗与格式化是两条独立的路：格式化不会放行 script
      assert.eq(sanitizeHtml(formatHtml('<script>alert(1)</script><p>x</p>')).trim(), '<p>x</p>',
        '先格式化再清洗，script 照样被挡住');
      assert.eq(formatHtml(sanitizeHtml('<p class="x">a</p>')), '<p>a</p>', '清洗后 class 没了，格式化不动内容');

      /* ================= 属性白名单细节 ================= */
      assert(isAllowedAttr('a', 'href'), 'a 允许 href');
      assert(isAllowedAttr('img', 'src'), 'img 允许 src');
      assert(isAllowedAttr('td', 'colspan'), 'td 允许 colspan');
      assert(isAllowedAttr('p', 'title'), 'p 允许全局的 title');
      assert(!isAllowedAttr('p', 'href'), 'p 不允许 href');
      assert(!isAllowedAttr('a', 'src'), 'a 不允许 src');
      assert(!isAllowedAttr('p', 'onclick'), 'on* 一律不允许');
      assert(!isAllowedAttr('p', 'class'), 'class 不允许');
      assert(!isAllowedAttr('p', 'id'), 'id 不允许（避免和页面自身元素撞车）');
      assert.eq(filterAttrs('a', [{ name: 'href', value: 'javascript:alert(1)', hasValue: true }]), [],
        'filterAttrs 层就把危险 href 挡掉');
      assert.eq(filterAttrs('p', [{ name: 'style', value: 'color:red', hasValue: true }]),
        [{ name: 'style', value: 'color: red' }], 'style 在 filterAttrs 里已经清洗过');
      assert.eq(filterAttrs('p', [{ name: 'style', value: 'position:fixed', hasValue: true }]),
        [], '清完为空的 style 直接丢掉');
      assert.eq(filterAttrs('a', [{ name: 'target', value: '_top', hasValue: true }]), [],
        'target=_top 会跳到顶层框架，禁止');
      assert.eq(serializeAttrs([{ name: 'a', value: 'x"y' }]), ' a="x&quot;y"', 'serializeAttrs 转义引号');
      assert.eq(serializeAttrs([]), '', '没有属性时不留空格');

      /* ================= 白名单本身 ================= */
      assert.eq(toSet(['A', 'b']), { a: 1, b: 1 }, 'toSet 小写化');
      assert.eq(toSet(null), {}, 'null → 空');
      assert(DEFAULT_ALLOWED_TAGS.indexOf('script') < 0, '允许名单里没有 script');
      assert(DEFAULT_ALLOWED_TAGS.indexOf('style') < 0, '允许名单里没有 style');
      assert(DEFAULT_ALLOWED_TAGS.indexOf('iframe') < 0, '允许名单里没有 iframe');
      assert(DEFAULT_ALLOWED_TAGS.indexOf('p') >= 0, '允许名单里有 p');
      assert(DEFAULT_ALLOWED_TAGS.indexOf('b') >= 0, '允许名单里有 b');
      assert(SAFE_SCHEMES.indexOf('data') < 0, 'data: 不在放行的 scheme 里');
      assert(SAFE_SCHEMES.indexOf('javascript') < 0, 'javascript 不在放行的 scheme 里');
    }
  };
})();