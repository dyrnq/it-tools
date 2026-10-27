/* ==========================================================================
   HAR 脱敏器（har-sanitizer）

   把 HAR 文件里的令牌、Cookie、密码等敏感数据抹掉，再放心分享出去。

   参考实现：上游 it-tools PR #1531（src/tools/har-sanitizer/，GPLv3）。
   原版是**在整份 JSON 文本上做正则替换**，看着简洁，实际有四个问题：

     1. 误伤：正文里恰好长得像 "token=xxx" 的普通字符串会被替换掉；
     2. 漏改：嵌在 postData.text 里的表单串、以及 "name"/"value" 形式的
        结构化字段，靠正则很难覆盖；
     3. 全文重排：removeContentForMimeTypes 走 JSON.parse -> stringify(2)，
        把整份 HAR 重新格式化了一遍，跟用户手里的原文件对不上；
     4. 死代码：getScrubWords 里的 `scrubWords || defaultScrubItems`
        永远走不到兜底（空数组也是 truthy），那 28 个默认敏感词
        **一次都没生效过**。

   这里改成**结构化脱敏**：先把 JSON 解析成带位置信息的树，按字段路径
   （queryString / postData / cookies / headers / response.content.text）
   逐项处理，最后只把改动的那几段文本拼回原文 —— 其余部分（缩进、字段顺序、
   空白）原样保留。输出是「结构化改过」，不是「重新序列化过」。

   零第三方依赖：JSON 解析、位置扫描、表单解析都是自己写的。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('har-sanitizer');

  /* ---------- 常量 ---------- */

  /** 脱敏后替换上去的占位文本。 */
  var REDACTED = '[redacted]';

  /** 上游 PR #1531 的 28 个默认敏感词（defaultWordList）。
      原版里它们一次都没生效过 —— 这里它们是真正生效的。 */
  var DEFAULT_WORDS = [
    'Authorization', 'SAMLRequest', 'SAMLResponse', 'access_token', 'appID',
    'assertion', 'auth', 'authenticity_token', 'challenge', 'client_id',
    'client_secret', 'code', 'code_challenge', 'code_verifier', 'email',
    'facetID', 'fcParams', 'id_token', 'password', 'refresh_token',
    'serverData', 'shdf', 'state', 'token', 'usg', 'vses2', 'x-client-data'
  ];

  /** 原版没列、但真实 HAR 里天天见的敏感名。 */
  var EXTRA_WORDS = [
    'api_key', 'api-key', 'apikey', 'secret', 'client-secret', 'private_key',
    'session_id', 'sessionid', 'session-id', 'csrf_token', 'csrftoken',
    'xsrf_token', 'xsrftoken', 'jwt', 'bearer', 'passwd', 'pwd',
    'credential', 'credentials', 'cookie', 'set-cookie',
    'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-access-token',
    'x-csrf-token', 'x-xsrf-token', 'x-session-token', 'refresh-token',
    'id-token', 'auth-token', 'otp', 'mfa-code', 'totp', 'secret-key',
    'sid', 'phpsessid', 'jsessionid', 'connect.sid'
  ];

  /** 名字里出现这些词就算敏感：x-auth-token、userPassword、apiKey …
      （词级匹配，所以前缀后缀不影响判定）。 */
  var SENSITIVE_TOKENS = [
    'token', 'password', 'passwd', 'pwd', 'secret', 'auth', 'authorization',
    'assertion', 'credential', 'credentials', 'cookie', 'session', 'csrf',
    'xsrf', 'saml', 'signature', 'jwt', 'apikey'
  ];

  /** 默认整段抹掉的响应类型（跟上游一致：跑 JS 的响应体没什么分享价值）。 */
  var DEFAULT_MIME_TYPES = ['application/javascript', 'text/javascript'];

  var ERR_NO_LOG = 'no log section in this HAR file';
  var ERR_NO_ENTRIES = 'no log.entries in this HAR file';

  /* ---------- 小工具 ---------- */

  function toSet(value) {
    if (value === undefined || value === null) return new Set();
    if (typeof Set !== 'undefined' && value instanceof Set) return new Set(value);
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }

  /** 名字归一化：大小写、分隔符都抹掉。
      access_token / accessToken / ACCESS-TOKEN 都归成 accesstoken。 */
  function normalizeName(name) {
    return String(name === undefined || name === null ? '' : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  /** 把名字切成词：分隔符与驼峰都算边界。
      x-auth-token -> [x, auth, token]，apiKey -> [api, key]。 */
  function splitTokens(name) {
    return String(name === undefined || name === null ? '' : name)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map(function (part) { return part.toLowerCase(); });
  }

  function isTokenSensitive(name) {
    return splitTokens(name).some(function (tok) {
      return SENSITIVE_TOKEN_SET.has(tok);
    });
  }

  /** 名字默认算不算敏感：命中默认词表，或者名字里含敏感词。 */
  function defaultSensitive(name) {
    var n = normalizeName(name);
    if (!n) return false;
    if (DEFAULT_WORD_SET.has(n)) return true;
    return isTokenSensitive(name);
  }

  var DEFAULT_WORD_SET = toSet(DEFAULT_WORDS.concat(EXTRA_WORDS).map(normalizeName));
  var SENSITIVE_TOKEN_SET = toSet(SENSITIVE_TOKENS);

  /** JSON 字符串字面量（带引号、带转义）。 */
  function jsonString(text) {
    return JSON.stringify(String(text));
  }

  /** JSON 字符串反转义。 */
  function unescapeJson(text) {
    if (text.indexOf('\\') < 0) return text;
    return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, function (whole, g) {
      if (g.charAt(0) === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
      var map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      return Object.prototype.hasOwnProperty.call(map, g) ? map[g] : g;
    });
  }

  /* ---------- JSON 位置树 ----------
     目的只有一个：**别把整份 HAR 重新序列化一遍**。
     这里把 JSON 文本解析成带位置（start/end）的树，脱敏时只替换要改的那几段，
     其余字节原样保留 —— 缩进、字段顺序、空白全都不动。 */

  function parseJson(src) {
    var i = 0;

    function fail(message) { throw new Error(message); }

    function skipWs() {
      while (i < src.length) {
        var code = src.charCodeAt(i);
        if (code === 32 || code === 9 || code === 10 || code === 13) i++;
        else break;
      }
    }

    function readString() {
      var start = i;
      i++; // 开头的引号
      while (i < src.length) {
        var ch = src.charAt(i);
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"') {
          i++;
          return { start: start, end: i, value: unescapeJson(src.slice(start + 1, i - 1)) };
        }
        i++;
      }
      fail('unterminated string');
    }

    function readValue() {
      skipWs();
      var ch = src.charAt(i);
      if (ch === undefined) fail('unexpected end of input');
      if (ch === '{') return readObject();
      if (ch === '[') return readArray();
      if (ch === '"') {
        var s = readString();
        return { type: 'string', start: s.start, end: s.end, value: s.value };
      }
      var start = i;
      while (i < src.length && !/[\s,\]}]/.test(src.charAt(i))) i++;
      if (i === start) fail('unexpected character ' + ch);
      var literal = src.slice(start, i);
      return { type: /^-?\d/.test(literal) ? 'number' : 'literal', start: start, end: i, value: literal };
    }

    function readObject() {
      var node = { type: 'object', start: i, end: 0, members: [] };
      i++; // '{'
      skipWs();
      if (src.charAt(i) === '}') { i++; node.end = i; return node; }
      for (;;) {
        skipWs();
        if (src.charAt(i) !== '"') fail('expected an object key');
        var key = readString();
        skipWs();
        if (src.charAt(i) !== ':') fail('expected ":"');
        i++;
        var value = readValue();
        node.members.push({
          key: key.value,
          keyStart: key.start,
          keyEnd: key.end,
          start: value.start,
          end: value.end,
          node: value
        });
        skipWs();
        var ch = src.charAt(i);
        if (ch === ',') { i++; continue; }
        if (ch === '}') { i++; break; }
        fail('expected "," or "}"');
      }
      node.end = i;
      return node;
    }

    function readArray() {
      var node = { type: 'array', start: i, end: 0, items: [] };
      i++; // '['
      skipWs();
      if (src.charAt(i) === ']') { i++; node.end = i; return node; }
      for (;;) {
        var value = readValue();
        node.items.push({ start: value.start, end: value.end, node: value });
        skipWs();
        var ch = src.charAt(i);
        if (ch === ',') { i++; continue; }
        if (ch === ']') { i++; break; }
        fail('expected "," or "]"');
      }
      node.end = i;
      return node;
    }

    var root = readValue();
    skipWs();
    if (i !== src.length) fail('unexpected content after the top-level value');
    return root;
  }

  /* ---------- 树上的导航 ---------- */

  function getMember(node, key) {
    if (!node || node.type !== 'object') return null;
    for (var i = 0; i < node.members.length; i++) {
      if (node.members[i].key === key) return node.members[i];
    }
    return null;
  }

  function getMemberValue(node, key) {
    var member = getMember(node, key);
    return member ? member.node : null;
  }

  function getString(node, key) {
    var member = getMember(node, key);
    if (!member || member.node.type !== 'string') return null;
    return member.node.value;
  }

  /** 对象里某个键对应的数组节点，取不到返回 null。 */
  function getArrayItems(node, key) {
    var member = getMember(node, key);
    if (!member || member.node.type !== 'array') return null;
    return member.node.items.map(function (item) { return item.node; });
  }

  /** 遍历树里所有对象的成员。fn(member, 父对象节点)。 */
  function eachObjectMember(node, fn) {
    if (!node) return;
    if (node.type === 'object') {
      node.members.forEach(function (member) {
        fn(member, node);
        eachObjectMember(member.node, fn);
      });
    } else if (node.type === 'array') {
      node.items.forEach(function (item) { eachObjectMember(item.node, fn); });
    }
  }

  /* ---------- 文本替换 ---------- */

  /** 丢掉被别的替换段盖住的（嵌套的）替换段 —— 位置会互相打架。 */
  function dropNested(replacements) {
    var sorted = replacements.slice().sort(function (a, b) {
      return a.start - b.start || b.end - a.end;
    });
    var kept = [];
    var lastEnd = -1;
    sorted.forEach(function (rep) {
      if (rep.start >= lastEnd) { kept.push(rep); lastEnd = rep.end; }
    });
    return kept;
  }

  /** 把替换段贴回原文（从后往前贴，前面的偏移才不会失效）。 */
  function applyReplacements(src, replacements) {
    var kept = dropNested(replacements).sort(function (a, b) { return b.start - a.start; });
    var out = src;
    kept.forEach(function (rep) {
      out = out.slice(0, rep.start) + rep.text + out.slice(rep.end);
    });
    return out;
  }

  /* ---------- 表单串 ---------- */

  function decodeFormComponent(text) {
    try {
      return decodeURIComponent(String(text).replace(/\+/g, ' '));
    } catch (e) {
      return String(text);
    }
  }

  function encodeFormComponent(text) {
    return encodeURIComponent(String(text)).replace(/%20/g, '+');
  }

  /**
   * 抹掉 URL 查询串里命中敏感名的参数。
   * 只动那一个参数，其余部分（路径、编码方式、fragment）原样保留 ——
   * 不用 URL 解析器重建整条 URL，那样路径和编码都会被改掉。
   * @returns {{text: string, names: string[]}|null}
   */
  function redactUrlQuery(url, isSensitive) {
    var text = String(url);
    var fragment = '';
    var hashAt = text.indexOf('#');
    if (hashAt >= 0) {
      fragment = text.slice(hashAt);
      text = text.slice(0, hashAt);
    }
    var queryAt = text.indexOf('?');
    if (queryAt < 0) return null;
    var head = text.slice(0, queryAt + 1);
    var query = text.slice(queryAt + 1);
    var changed = false;
    var names = [];
    var rebuilt = query.split('&').map(function (part) {
      if (!part) return part;
      var eq = part.indexOf('=');
      var rawName = eq < 0 ? part : part.slice(0, eq);
      var name = decodeFormComponent(rawName);
      if (!isSensitive(name)) return part;
      changed = true;
      names.push(name);
      return rawName + '=' + encodeFormComponent(REDACTED);
    });
    if (!changed) return null;
    return { text: head + rebuilt.join('&') + fragment, names: names };
  }

  /* ---------- JWT ---------- */

  var JWT_RE = /\b(ey[A-Za-z0-9_-]+)\.(ey[A-Za-z0-9_-]+)\.[A-Za-z0-9-_.+/=]+/g;

  /** 把 JWT 的签名段抹掉，头两段留着（它们只是载荷，本来也不是秘密）。 */
  function redactJwt(text) {
    return String(text).replace(JWT_RE, '$1.$2.[redacted]');
  }

  /* ---------- 选项 ---------- */

  /**
   * 把界面上的选择整成一个判定函数。
   * @param {{scrubNames?: *, excluded?: *, mimeTypes?: *, scrubBody?: boolean}} [raw]
   */
  function normalizeOptions(raw) {
    var opts = raw || {};
    var scrubNames = opts.scrubNames === undefined
      ? new Set(DEFAULT_WORD_SET)
      : toSet(opts.scrubNames);
    var excluded = toSet(opts.excluded);
    var mimeTypes = opts.mimeTypes === undefined
      ? toSet(DEFAULT_MIME_TYPES)
      : toSet(opts.mimeTypes);
    var scrubBody = opts.scrubBody !== false;

    return {
      scrubNames: scrubNames,
      excluded: excluded,
      mimeTypes: mimeTypes,
      scrubBody: scrubBody,
      /** 这个名字要不要脱敏。 */
      isSensitive: function (name) {
        var n = normalizeName(name);
        if (!n) return false;
        if (excluded.has(n)) return false;   // 用户明确取消的优先
        if (scrubNames.has(n)) return true;
        return isTokenSensitive(name);
      }
    };
  }

  /* ---------- 扫描 HAR ---------- */

  function looksLikeJson(text) {
    var trimmed = String(text).replace(/^\s+/, '');
    if (!trimmed) return false;
    var first = trimmed.charAt(0);
    return first === '{' || first === '[';
  }

  /**
   * 解析 HAR 并列出能脱敏的东西。
   * @param {string} src
   * @param {{isDisplaySensitive?: function(string): boolean}} [raw]
   */
  function parseHar(src, raw) {
    var opts = raw || {};
    var isDisplaySensitive = opts.isDisplaySensitive || defaultSensitive;

    var tree = parseJson(src);
    var log = getMemberValue(tree, 'log');
    if (!log) throw new Error(ERR_NO_LOG);
    var entriesMember = getMember(log, 'entries');
    if (!entriesMember || entriesMember.node.type !== 'array') throw new Error(ERR_NO_ENTRIES);

    var info = {
      requestHeaders: [],
      responseHeaders: [],
      cookies: [],
      queryArgs: [],
      postParams: [],
      bodyKeys: [],
      mimeTypes: [],
      entryCount: entriesMember.node.items.length
    };
    // 用 Object.create(null)：HAR 里的名字可能是 "constructor"、"__proto__"
    var seen = {
      requestHeaders: Object.create(null),
      responseHeaders: Object.create(null),
      cookies: Object.create(null),
      queryArgs: Object.create(null),
      postParams: Object.create(null),
      bodyKeys: Object.create(null),
      mimeTypes: Object.create(null)
    };

    function add(category, name) {
      if (!name) return;
      var bucket = seen[category];
      if (bucket[name]) return;
      bucket[name] = true;
      info[category].push(name);
    }

    function addHeaders(node, category) {
      var items = getArrayItems(node, 'headers');
      if (!items) return;
      items.forEach(function (item) {
        var name = getString(item, 'name');
        if (name) add(category, name);
      });
    }

    function addCookies(node) {
      var items = getArrayItems(node, 'cookies');
      if (!items) return;
      items.forEach(function (item) {
        var name = getString(item, 'name');
        if (name) add('cookies', name);
      });
    }

    entriesMember.node.items.forEach(function (item) {
      var entry = item.node;
      var request = getMemberValue(entry, 'request');
      var response = getMemberValue(entry, 'response');

      if (request) {
        addHeaders(request, 'requestHeaders');
        addCookies(request);
        var query = getArrayItems(request, 'queryString');
        if (query) {
          query.forEach(function (q) {
            var name = getString(q, 'name');
            if (name) add('queryArgs', name);
          });
        }
        var postData = getMemberValue(request, 'postData');
        if (postData) {
          var params = getArrayItems(postData, 'params');
          if (params) {
            params.forEach(function (p) {
              var name = getString(p, 'name');
              if (name) add('postParams', name);
            });
          }
        }
      }

      if (response) {
        addHeaders(response, 'responseHeaders');
        addCookies(response);
        var content = getMemberValue(response, 'content');
        if (content) {
          var mime = getString(content, 'mimeType');
          if (mime) add('mimeTypes', mime);
          var text = getString(content, 'text');
          var encoding = getString(content, 'encoding') || '';
          if (text && !/base64/i.test(encoding) && looksLikeJson(text)) {
            var bodyTree = null;
            try { bodyTree = parseJson(text); } catch (e) { bodyTree = null; }
            if (bodyTree) {
              eachObjectMember(bodyTree, function (member) {
                if (isDisplaySensitive(member.key)) add('bodyKeys', member.key);
              });
            }
          }
        }
      }
    });

    ['requestHeaders', 'responseHeaders', 'cookies', 'queryArgs', 'postParams', 'bodyKeys', 'mimeTypes']
      .forEach(function (category) {
        info[category].sort(function (a, b) { return String(a).localeCompare(String(b)); });
      });

    return { tree: tree, info: info };
  }

  /* ---------- 脱敏 ---------- */

  /**
   * 扫响应正文里的 JSON，找出会泄露的键。
   * @param {object} node 正文 JSON 的树
   * @param {function(string): boolean} isSensitive
   * @param {function(number, number, string, string): void} add 记录一段替换
   */
  function scanBody(node, isSensitive, add) {
    eachObjectMember(node, function (member, parent) {
      // 键本身就是敏感名 —— 整个值抹掉
      if (isSensitive(member.key)) {
        add(member.start, member.end, jsonString(REDACTED), member.key);
        return;
      }
      // { "name": "token", "value": "…" } 这种结构 —— 名字敏感，值跟着抹
      if (member.key === 'value' && parent) {
        var nameMember = getMember(parent, 'name');
        if (nameMember && nameMember.node.type === 'string' && isSensitive(nameMember.node.value)) {
          add(member.start, member.end, jsonString(REDACTED), nameMember.node.value);
          return;
        }
      }
      // 值本身是个 JWT —— 抹掉签名段
      if (member.node.type === 'string') {
        var redacted = redactJwt(member.node.value);
        if (redacted !== member.node.value) {
          add(member.start, member.end, jsonString(redacted), member.key);
        }
      }
    });
  }

  /**
   * 递归扫一段 JSON 文本，把敏感键的值抹掉。
   * @param {string} text
   * @param {function(string): boolean} isSensitive
   * @returns {{text: string, labels: string[]}|null}
   */
  function redactJsonText(text, isSensitive) {
    if (!looksLikeJson(text)) return null;
    var tree = null;
    try { tree = parseJson(text); } catch (e) { tree = null; }
    if (!tree) return null;
    var bodyReplacements = [];
    var labels = [];
    scanBody(tree, isSensitive, function (start, end, replacement, label) {
      bodyReplacements.push({ start: start, end: end, text: replacement });
      labels.push(label);
    });
    if (!bodyReplacements.length) return null;
    return { text: applyReplacements(text, bodyReplacements), labels: labels };
  }

  /**
   * 结构化脱敏。
   * @param {string} src HAR 原文
   * @param {object} [raw] 见 normalizeOptions
   * @returns {{text: string, report: {count: number, entries: number, items: Array}}}
   */
  function sanitizeHar(src, raw) {
    var opts = normalizeOptions(raw);
    var parsed = parseHar(src);
    return sanitizeTree(parsed.tree, src, opts);
  }

  /**
   * 在已经解析好的树上做脱敏。
   * @param {object} tree parseJson 的结果
   * @param {string} src 原文（位置都相对它）
   * @param {object} opts normalizeOptions 的结果
   */
  function sanitizeTree(tree, src, opts) {
    var log = getMemberValue(tree, 'log');
    var entriesMember = getMember(log, 'entries');
    var replacements = [];
    var report = { count: 0, entries: entriesMember.node.items.length, items: [] };

    function note(kind, name, entryIndex) {
      report.count++;
      report.items.push({ kind: kind, name: name, entry: entryIndex });
    }

    /** 把 {name, value} 数组里命中敏感名的 value 抹掉。 */
    function redactNamedArray(node, arrayKey, kind, entryIndex) {
      var items = getArrayItems(node, arrayKey);
      if (!items) return;
      items.forEach(function (item) {
        var name = getString(item, 'name');
        if (!name || !opts.isSensitive(name)) return;
        var value = getMember(item, 'value');
        if (!value) return;
        replacements.push({ start: value.start, end: value.end, text: jsonString(REDACTED) });
        note(kind, name, entryIndex);
      });
    }

    /** 处理请求体：表单串按参数名替换，JSON 体递归扫键。 */
    function redactPostBody(postData, entryIndex) {
      var mime = getString(postData, 'mimeType') || '';
      var textMember = getMember(postData, 'text');
      if (!textMember || textMember.node.type !== 'string') return;

      if (/x-www-form-urlencoded/i.test(mime)) {
        // 只换掉命中敏感名的那一段，其余片段连编码都原样保留
        var parts = textMember.node.value.split('&');
        var changed = false;
        var rebuilt = parts.map(function (part) {
          if (!part) return part;
          var eq = part.indexOf('=');
          var rawName = eq < 0 ? part : part.slice(0, eq);
          var name = decodeFormComponent(rawName);
          if (!opts.isSensitive(name)) return part;
          changed = true;
          note('post', name, entryIndex);
          return rawName + '=' + encodeFormComponent(REDACTED);
        });
        if (!changed) return;
        replacements.push({
          start: textMember.start,
          end: textMember.end,
          text: jsonString(rebuilt.join('&'))
        });
        return;
      }

      if (!opts.scrubBody) return;
      if (!/json/i.test(mime)) return;
      var body = redactJsonText(textMember.node.value, opts.isSensitive);
      if (!body) return;
      replacements.push({
        start: textMember.start,
        end: textMember.end,
        text: jsonString(body.text)
      });
      body.labels.forEach(function (label) { note('post', label, entryIndex); });
    }

    /** 处理响应正文：整段抹掉（按 MIME 类型），或者递归扫 JSON 键。 */
    function redactResponseBody(response, entryIndex) {
      var content = getMemberValue(response, 'content');
      if (!content) return;
      var textMember = getMember(content, 'text');
      if (!textMember || textMember.node.type !== 'string') return;
      var mime = getString(content, 'mimeType') || '';

      if (opts.mimeTypes.has(mime)) {
        replacements.push({
          start: textMember.start,
          end: textMember.end,
          text: jsonString('[' + mime + ' redacted]')
        });
        note('mime', mime, entryIndex);
        return;
      }
      if (!opts.scrubBody) return;
      var encoding = getString(content, 'encoding') || '';
      if (/base64/i.test(encoding)) return;
      var body = redactJsonText(textMember.node.value, opts.isSensitive);
      if (!body) return;
      replacements.push({
        start: textMember.start,
        end: textMember.end,
        text: jsonString(body.text)
      });
      body.labels.forEach(function (label) { note('body', label, entryIndex); });
    }

    /** 抹掉 URL 里命中敏感名的查询参数。 */
    function redactUrl(node, key, entryIndex) {
      var member = getMember(node, key);
      if (!member || member.node.type !== 'string') return;
      var redacted = redactUrlQuery(member.node.value, opts.isSensitive);
      if (!redacted) return;
      replacements.push({
        start: member.start,
        end: member.end,
        text: jsonString(redacted.text)
      });
      redacted.names.forEach(function (name) { note('query', name, entryIndex); });
    }

    entriesMember.node.items.forEach(function (item, entryIndex) {
      var entry = item.node;
      var request = getMemberValue(entry, 'request');
      var response = getMemberValue(entry, 'response');

      if (request) {
        redactNamedArray(request, 'headers', 'header', entryIndex);
        redactNamedArray(request, 'cookies', 'cookie', entryIndex);
        redactNamedArray(request, 'queryString', 'query', entryIndex);
        redactUrl(request, 'url', entryIndex);
        var postData = getMemberValue(request, 'postData');
        if (postData) {
          redactNamedArray(postData, 'params', 'post', entryIndex);
          redactPostBody(postData, entryIndex);
        }
      }
      if (response) {
        redactNamedArray(response, 'headers', 'header', entryIndex);
        redactNamedArray(response, 'cookies', 'cookie', entryIndex);
        redactUrl(response, 'redirectURL', entryIndex);
        redactResponseBody(response, entryIndex);
      }
    });

    return { text: applyReplacements(src, replacements), report: report };
  }

  /* ---------- 界面 ---------- */

  window.ItTools.register('har-sanitizer', function (root) {
    var disposers = [];
    // 选项面板每次重画都会重建一批监听，单独收着，重画时整批丢掉 ——
    // 跟 disposers 混在一起的话，在输入框里每敲一个字就攒一批。
    var optionDisposers = [];
    var currentReader = null;

    var inputArea = D.h('textarea.layui-textarea', {
      rows: 8,
      spellcheck: 'false',
      placeholder: t('har_ph', 'Paste the contents of a .har file here')
    });
    var fileInput = D.h('input', { type: 'file', accept: '.har,application/json' });
    var status = D.h('p.form-status');
    var optionsBox = D.h('div');
    var customInput = D.h('textarea.layui-textarea', {
      rows: 3,
      spellcheck: 'false',
      placeholder: t('custom_ph', 'One per line, or separated by commas')
    });
    var resultArea = D.h('textarea.layui-textarea', {
      rows: 10,
      readonly: true,
      spellcheck: 'false',
      placeholder: t('result_ph', 'The sanitized HAR will appear here')
    });
    var resultStatus = D.h('p.form-status');

    var sanitizeBtn = D.h('button.layui-btn', { type: 'button', text: t('sanitize', 'Sanitize') });
    var copyBtn = U.copyButton(function () { return resultArea.value; }, t('copy_result', 'Copy result'));
    var downloadBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button',
      text: t('download', 'Download')
    });

    /* ---- 状态 ---- */

    var parsed = null;          // parseHar 的结果
    var scrubNames = new Set(DEFAULT_WORD_SET);
    var excluded = new Set();   // 用户明确取消的
    var customNames = [];       // 用户自己加的名字
    var mimeChecked = Object.create(null);
    var nameInputs = Object.create(null);   // 归一化名 -> {inputs: [], display: 原名}
    var fileName = '';
    var resultText = '';

    function isNameChecked(name) {
      var n = normalizeName(name);
      if (excluded.has(n)) return false;
      if (scrubNames.has(n)) return true;
      return isTokenSensitive(name);
    }

    function setNameChecked(name, checked) {
      var n = normalizeName(name);
      if (checked) {
        excluded.delete(n);
        scrubNames.add(n);
      } else {
        excluded.add(n);
        scrubNames.delete(n);
      }
      syncNameInputs(n);
    }

    function registerNameInput(name, input) {
      var n = normalizeName(name);
      if (!nameInputs[n]) nameInputs[n] = { inputs: [], display: name };
      nameInputs[n].inputs.push(input);
    }

    /** 同一个名字可能在好几组里出现（请求头、响应头、Cookie…），
        勾一个要连带把别的也勾上 —— 所以按归一化名同步。
        判定用的是**原名**：归一化之后 "x-auth-token" 变成 "xauthtoken"，
        词级判定（里面含 auth）就失效了。 */
    function syncNameInputs(n) {
      var entry = nameInputs[n];
      if (!entry) return;
      var checked = isNameChecked(entry.display);
      entry.inputs.forEach(function (input) { input.checked = checked; });
    }

    function syncAllInputs() {
      Object.keys(nameInputs).forEach(syncNameInputs);
    }

    /* ---- 选项面板 ---- */

    function renderNameGroup(title, names, onToggle) {
      var box = D.h('div', { style: { marginBottom: '14px' } });
      box.appendChild(D.h('div.section-head', null, D.h('span', { text: title })));

      var all = D.h('input', { type: 'checkbox' });
      var allLabel = D.h('label.switch', null, all, D.h('span', { text: t('select_all', 'Select all') }));
      box.appendChild(allLabel);

      var list = D.h('div.switch-grid');
      names.forEach(function (name) {
        var input = D.h('input', { type: 'checkbox' });
        input.checked = isNameChecked(name);
        registerNameInput(name, input);
        optionDisposers.push(D.on(input, 'change', function () {
          onToggle(name, input.checked);
          all.checked = names.every(isNameChecked);
        }));
        list.appendChild(D.h('label.switch', null, input, D.h('span', { text: name })));
      });
      box.appendChild(list);

      all.checked = names.every(isNameChecked);
      optionDisposers.push(D.on(all, 'change', function () {
        names.forEach(function (name) { onToggle(name, all.checked); });
        syncAllInputs();
      }));
      return box;
    }

    function renderMimeGroup(mimes) {
      var box = D.h('div', { style: { marginBottom: '14px' } });
      box.appendChild(D.h('div.section-head', null, D.h('span', { text: t('cat_mime', 'Response content types') })));
      var list = D.h('div.switch-grid');
      mimes.forEach(function (mime) {
        var input = D.h('input', { type: 'checkbox' });
        input.checked = !!mimeChecked[mime];
        optionDisposers.push(D.on(input, 'change', function () {
          mimeChecked[mime] = input.checked;
          runSanitize();
        }));
        list.appendChild(D.h('label.switch', null, input, D.h('span', { text: mime })));
      });
      box.appendChild(list);
      return box;
    }

    function renderOptions() {
      optionDisposers.forEach(function (off) {
        try { off(); } catch (e) { /* 忽略 */ }
      });
      optionDisposers = [];
      D.clear(optionsBox);
      nameInputs = Object.create(null);
      if (!parsed) {
        optionsBox.appendChild(D.h('p.field-hint', {
          text: t('hint_empty', 'Load a HAR file to see what can be scrubbed.')
        }));
        return;
      }
      var info = parsed.info;
      var groups = [
        { title: t('cat_request_headers', 'Request headers'), names: info.requestHeaders },
        { title: t('cat_response_headers', 'Response headers'), names: info.responseHeaders },
        { title: t('cat_cookies', 'Cookies'), names: info.cookies },
        { title: t('cat_query', 'Query parameters'), names: info.queryArgs },
        { title: t('cat_post', 'Post parameters'), names: info.postParams },
        { title: t('cat_body_keys', 'Response body keys'), names: info.bodyKeys }
      ];
      groups.forEach(function (group) {
        if (!group.names.length) return;
        optionsBox.appendChild(renderNameGroup(group.title, group.names, function (name, checked) {
          setNameChecked(name, checked);
          runSanitize();
        }));
      });

      var custom = customNames.filter(function (name) {
        return !info.requestHeaders.includes(name) &&
          !info.responseHeaders.includes(name) &&
          !info.cookies.includes(name) &&
          !info.queryArgs.includes(name) &&
          !info.postParams.includes(name) &&
          !info.bodyKeys.includes(name);
      });
      if (custom.length) {
        optionsBox.appendChild(renderNameGroup(t('cat_custom', 'Custom names'), custom, function (name, checked) {
          setNameChecked(name, checked);
          runSanitize();
        }));
      }

      if (info.mimeTypes.length) {
        optionsBox.appendChild(renderMimeGroup(info.mimeTypes));
      }

      optionsBox.appendChild(D.h('p.field-hint', {
        text: t('options_hint', 'Names are matched case-insensitively. A name selected in any group is redacted everywhere it appears in the file.')
      }));
    }

    /* ---- 主流程 ---- */

    function applyCustomNames() {
      customNames = customInput.value
        .split(/[\s,;]+/)
        .map(function (part) { return part.trim(); })
        .filter(Boolean);
      customNames.forEach(function (name) {
        var n = normalizeName(name);
        if (!n) return;
        scrubNames.add(n);
        excluded.delete(n);
      });
    }

    function refresh() {
      var src = inputArea.value;
      if (!src.trim()) {
        parsed = null;
        renderOptions();
        status.textContent = '';
        status.classList.remove('is-error');
        resultArea.value = '';
        resultText = '';
        resultStatus.textContent = '';
        return;
      }
      try {
        applyCustomNames();
        parsed = parseHar(src, {
          isDisplaySensitive: function (name) {
            return defaultSensitive(name) || customNames.indexOf(name) >= 0;
          }
        });
        status.textContent = t('loaded', 'Loaded {entries} entries.').replace('{entries}', parsed.info.entryCount);
        status.classList.remove('is-error');
      } catch (e) {
        parsed = null;
        status.textContent = t('err_invalid', 'Cannot read this file: ') + e.message;
        status.classList.add('is-error');
        renderOptions();
        resultArea.value = '';
        resultText = '';
        resultStatus.textContent = '';
        return;
      }
      parsed.info.mimeTypes.forEach(function (mime) {
        if (mimeChecked[mime] === undefined) {
          mimeChecked[mime] = DEFAULT_MIME_TYPES.indexOf(mime) >= 0;
        }
      });
      renderOptions();
      runSanitize();
    }

    function runSanitize() {
      var src = inputArea.value;
      if (!src.trim() || !parsed) {
        resultArea.value = '';
        resultText = '';
        resultStatus.textContent = '';
        resultStatus.classList.remove('is-error');
        return;
      }
      var mimes = [];
      Object.keys(mimeChecked).forEach(function (mime) {
        if (mimeChecked[mime]) mimes.push(mime);
      });
      try {
        var out = sanitizeTree(parsed.tree, src, normalizeOptions({
          scrubNames: Array.from(scrubNames),
          excluded: Array.from(excluded),
          mimeTypes: mimes,
          scrubBody: true
        }));
        resultText = out.text;
        resultArea.value = out.text;
        resultStatus.textContent = out.report.count
          ? t('summary', '{count} values redacted in {entries} entries.')
            .replace('{count}', out.report.count)
            .replace('{entries}', out.report.entries)
          : t('summary_none', 'Nothing matched the selected names.');
        resultStatus.classList.remove('is-error');
      } catch (e) {
        resultText = '';
        resultArea.value = '';
        resultStatus.textContent = e.message;
        resultStatus.classList.add('is-error');
      }
    }

    /* ---- 事件 ---- */

    disposers.push(D.on(inputArea, 'input', function () { refresh(); }));
    disposers.push(D.on(customInput, 'input', function () {
      // 走一遍 refresh：自定义名字可能让正文里多出几个该脱敏的键，
      // 重新扫一遍才会把它们列出来。
      refresh();
    }));
    disposers.push(D.on(sanitizeBtn, 'click', function () { refresh(); }));
    disposers.push(D.on(downloadBtn, 'click', function () {
      if (!resultText) return;
      var name = fileName ? 'sanitized-' + fileName : 'sanitized.har';
      window.ItTools.download(name, resultText, 'application/json');
    }));
    disposers.push(D.on(fileInput, 'change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      currentReader = reader;
      reader.onload = function () {
        currentReader = null;
        inputArea.value = String(reader.result || '');
        fileName = file.name;
        refresh();
      };
      reader.onerror = function () {
        currentReader = null;
        status.textContent = t('err_read', 'Failed to read the file.');
        status.classList.add('is-error');
      };
      reader.readAsText(file);
    }));

    /* ---- 面板（根节点的直属子元素必须全是 .card） ---- */

    root.appendChild(D.h('div.card', null,
      D.h('div.section-head', null, D.h('span', { text: t('input_title', 'HAR file') })),
      U.field(t('input_label', 'HAR content'), inputArea),
      U.field(t('file_label', 'HAR file'), fileInput),
      D.h('p.field-hint', { text: t('input_hint', 'Everything happens in your browser; nothing is uploaded.') }),
      status
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.section-head', null, D.h('span', { text: t('options_title', 'What to scrub') })),
      optionsBox,
      U.field(t('custom_label', 'Extra sensitive names'), customInput),
      D.h('p.field-hint', { text: t('custom_hint', 'These names are added to the ones detected above.') })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div.section-head', null, D.h('span', { text: t('result_title', 'Sanitized HAR') })),
      D.h('div.form-actions', null, sanitizeBtn, copyBtn, downloadBtn),
      resultStatus,
      resultArea
    ));

    renderOptions();

    return {
      destroy: function () {
        if (currentReader) {
          try { currentReader.abort(); } catch (e) { /* 忽略 */ }
          currentReader = null;
        }
        disposers.forEach(function (off) {
          try { off(); } catch (e) { /* 忽略 */ }
        });
        disposers = [];
        optionDisposers.forEach(function (off) {
          try { off(); } catch (e) { /* 忽略 */ }
        });
        optionDisposers = [];
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（给 node 侧的 jsdom 测试用） ---------- */

  window.ItTools.logic['har-sanitizer'] = {
    DEFAULT_WORDS: DEFAULT_WORDS,
    EXTRA_WORDS: EXTRA_WORDS,
    SENSITIVE_TOKENS: SENSITIVE_TOKENS,
    DEFAULT_MIME_TYPES: DEFAULT_MIME_TYPES,
    REDACTED: REDACTED,
    normalizeName: normalizeName,
    splitTokens: splitTokens,
    defaultSensitive: defaultSensitive,
    isTokenSensitive: isTokenSensitive,
    normalizeOptions: normalizeOptions,
    parseJson: parseJson,
    parseHar: parseHar,
    sanitizeHar: sanitizeHar,
    sanitizeTree: sanitizeTree,
    applyReplacements: applyReplacements,
    redactJwt: redactJwt,
    redactJsonText: redactJsonText,
    redactUrlQuery: redactUrlQuery,
    decodeFormComponent: decodeFormComponent,
    __cases: function (assert) {
      /** 从脱敏后的 HAR 里取出响应正文（解码后的字符串）。 */
      function bodyTextOf(harText, entryIndex) {
        var tree = parseJson(harText);
        var log = getMemberValue(tree, 'log');
        var entries = getMember(log, 'entries').node.items;
        var entry = entries[entryIndex || 0].node;
        var response = getMemberValue(entry, 'response');
        var content = getMemberValue(response, 'content');
        return getString(content, 'text');
      }

      /* ---- 名字归一化 ---- */
      assert.eq(normalizeName('access_token'), 'accesstoken', '下划线被抹掉');
      assert.eq(normalizeName('Authorization'), 'authorization', '大小写归一');
      assert.eq(normalizeName('X-Client-Data'), 'xclientdata', '连字符被抹掉');
      assert.eq(normalizeName(null), '', 'null 归成空串');
      assert.eq(normalizeName('apiKey'), 'apikey', '驼峰归一');

      /* ---- 分词 ---- */
      assert.eq(splitTokens('x-auth-token'), ['x', 'auth', 'token'], '连字符分词');
      assert.eq(splitTokens('apiKey'), ['api', 'key'], '驼峰分词');
      assert.eq(splitTokens('Authorization'), ['authorization'], '单词不动');

      /* ---- 默认敏感词 ---- */
      assert(defaultSensitive('Authorization'), 'Authorization 默认敏感');
      assert(defaultSensitive('authorization'), '大小写不敏感');
      assert(defaultSensitive('access_token'), 'access_token 默认敏感');
      assert(defaultSensitive('password'), 'password 默认敏感');
      assert(defaultSensitive('x-client-data'), 'x-client-data 默认敏感');
      assert(defaultSensitive('x-auth-token'), '含 auth 的名字也敏感');
      assert(!defaultSensitive('Content-Type'), 'Content-Type 不敏感');
      assert(!defaultSensitive('User-Agent'), 'User-Agent 不敏感');
      assert(!defaultSensitive('Accept'), 'Accept 不敏感');
      assert(!defaultSensitive(''), '空名字不敏感');

      /* ---- 判定函数：排除优先于命中 ---- */
      var opts = normalizeOptions({ scrubNames: ['token'], excluded: ['token'] });
      assert(!opts.isSensitive('token'), '用户取消后不再脱敏');
      var opts2 = normalizeOptions({ scrubNames: ['token'] });
      assert(opts2.isSensitive('token'), '勾选的名字会被脱敏');
      assert(opts2.isSensitive('x-auth-token'), '含敏感词的名字也会被脱敏');
      assert(opts2.isSensitive('userPassword'), '含 password 的名字也会被脱敏');
      var opts3 = normalizeOptions({ scrubNames: [], excluded: ['password'] });
      assert(!opts3.isSensitive('password'), '取消之后连 password 也不脱敏');
      assert(opts3.isSensitive('secret'), '没取消的敏感词照旧脱敏');

      /* ---- JSON 位置树 ---- */
      var tree = parseJson('{"a": 1, "b": {"c": "x"}}');
      assert.eq(tree.type, 'object', '根是对象');
      assert.eq(tree.members.length, 2, '两个成员');
      assert.eq(tree.members[0].key, 'a', '第一个键');
      assert.eq(tree.members[0].node.value, '1', '第一个值');
      assert.eq(tree.members[1].node.members[0].key, 'c', '嵌套的键');
      var arr = parseJson('[1, 2, 3]');
      assert.eq(arr.type, 'array', '根是数组');
      assert.eq(arr.items.length, 3, '三个元素');
      var threw = false;
      try { parseJson('{oops'); } catch (e) { threw = true; }
      assert(threw, '坏 JSON 会抛异常');

      /* ---- 替换段贴回原文 ---- */
      assert.eq(applyReplacements('abcdef', [{ start: 1, end: 3, text: 'X' }]), 'aXdef', '替换一段');
      assert.eq(
        applyReplacements('abcdef', [{ start: 0, end: 6, text: 'X' }, { start: 2, end: 4, text: 'Y' }]),
        'X',
        '嵌套的替换段只留最外层'
      );

      /* ---- JWT ---- */
      assert.eq(
        redactJwt('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'),
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.[redacted]',
        'JWT 签名被抹掉'
      );
      assert.eq(redactJwt('not a jwt'), 'not a jwt', '不是 JWT 就不动');

      /* ---- 表单串 ---- */
      assert.eq(decodeFormComponent('a%20b+c'), 'a b c', '表单解码');

      /* ---- 脱敏本体 ---- */
      var har = [
        '{',
        '  "log": {',
        '    "version": "1.2",',
        '    "entries": [',
        '      {',
        '        "request": {',
        '          "method": "POST",',
        '          "url": "https://example.com/api?token=secret123&page=2",',
        '          "headers": [',
        '            { "name": "Authorization", "value": "Bearer abc" },',
        '            { "name": "Content-Type", "value": "application/json" }',
        '          ],',
        '          "queryString": [',
        '            { "name": "token", "value": "secret123" },',
        '            { "name": "page", "value": "2" }',
        '          ],',
        '          "cookies": [',
        '            { "name": "session", "value": "s3cr3t" }',
        '          ],',
        '          "postData": {',
        '            "mimeType": "application/x-www-form-urlencoded",',
        '            "text": "user=bob&password=hunter2",',
        '            "params": [',
        '              { "name": "password", "value": "hunter2" }',
        '            ]',
        '          }',
        '        },',
        '        "response": {',
        '          "headers": [',
        '            { "name": "Set-Cookie", "value": "sid=1" }',
        '          ],',
        '          "content": {',
        '            "mimeType": "application/json",',
        '            "text": "{\\"user\\": \\"bob\\", \\"access_token\\": \\"abc\\", \\"note\\": \\"token=not-a-secret\\"}"',
        '          }',
        '        }',
        '      }',
        '    ]',
        '  }',
        '}'
      ].join('\n');

      var out = sanitizeHar(har);
      var text = out.text;
      var body = bodyTextOf(text);

      assert(text.indexOf('"version": "1.2"') >= 0, '没动的地方原样保留');
      assert(text.indexOf('"Bearer abc"') < 0, 'Authorization 头被抹掉');
      assert(text.indexOf('"Content-Type", "value": "application/json"') >= 0, '无关的头不动');
      assert(text.indexOf('"secret123"') < 0, '查询串里的 token 被抹掉');
      assert(text.indexOf('"name": "page", "value": "2"') >= 0, '无关的查询参数不动');
      assert(text.indexOf('s3cr3t') < 0, 'Cookie 被抹掉');
      assert(text.indexOf('hunter2') < 0, '表单串里的密码被抹掉');
      assert(text.indexOf('user=bob') >= 0, '表单串里无关的参数原样保留');
      assert(text.indexOf('"sid=1"') < 0, 'Set-Cookie 被抹掉');
      assert(body.indexOf('"access_token": "[redacted]"') >= 0, '响应正文里的敏感键被抹掉');
      assert(body.indexOf('token=not-a-secret') >= 0, '正文里形状相似的普通字符串不误伤');
      assert(body.indexOf('"user": "bob"') >= 0, '正文里无关的键不动');
      assert(text.indexOf('\n  "log": {') >= 0, '缩进与字段顺序原样保留');
      assert(out.report.count >= 6, '报告里数到了多处脱敏');

      /* ---- URL 里的查询串也要脱敏 ---- */
      assert(text.indexOf('token=secret123') < 0, 'URL 里的 token 被抹掉');
      assert(text.indexOf('page=2') >= 0, 'URL 里无关的参数原样保留');
      assert(text.indexOf('https://example.com/api?') >= 0, 'URL 的其余部分不动');

      /* ---- 排除之后不再脱敏 ---- */
      var out2 = sanitizeHar(har, { excluded: ['authorization', 'token', 'session', 'password', 'setcookie'] });
      assert(out2.text.indexOf('"Bearer abc"') >= 0, '排除后请求头保留');
      assert(out2.text.indexOf('secret123') >= 0, '排除后查询串保留');
      assert(out2.text.indexOf('hunter2') >= 0, '排除后表单串保留');

      /* ---- MIME 类型整段抹掉 ---- */
      var out3 = sanitizeHar(har, { mimeTypes: ['application/json'] });
      assert(out3.text.indexOf('[application/json redacted]') >= 0, '按 MIME 类型整段抹掉');

      /* ---- 响应正文里的 name/value 结构 ---- */
      var har2 = JSON.stringify({
        log: {
          entries: [{
            response: {
              content: {
                mimeType: 'application/json',
                text: JSON.stringify({ items: [{ name: 'token', value: 'zzz' }] })
              }
            }
          }]
        }
      });
      var out4 = sanitizeHar(har2);
      var body2 = bodyTextOf(out4.text);
      assert(body2.indexOf('zzz') < 0, 'name/value 结构里的敏感值被抹掉');
      assert(body2.indexOf('"name":"token"') >= 0, 'name 本身留着');

      /* ---- JSON 请求体也扫键 ---- */
      var har3 = JSON.stringify({
        log: {
          entries: [{
            request: {
              postData: {
                mimeType: 'application/json',
                text: JSON.stringify({ user: 'bob', password: 'pw' })
              }
            }
          }]
        }
      });
      var out5 = sanitizeHar(har3);
      assert(out5.text.indexOf('pw') < 0, 'JSON 请求体里的密码被抹掉');
      assert(out5.text.indexOf('bob') >= 0, 'JSON 请求体里无关的字段不动');

      /* ---- JWT 只抹签名段 ---- */
      var har4 = JSON.stringify({
        log: {
          entries: [{
            response: {
              content: {
                mimeType: 'application/json',
                text: JSON.stringify({ data: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln' })
              }
            }
          }]
        }
      });
      var out6 = sanitizeHar(har4);
      var body4 = bodyTextOf(out6.text);
      assert(body4.indexOf('c2ln') < 0, 'JWT 的签名段被抹掉');
      assert(body4.indexOf('eyJhbGciOiJIUzI1NiJ9') >= 0, 'JWT 的头部与载荷留着');

      /* ---- 出错的情况 ---- */
      var threw2 = false;
      try { sanitizeHar('{"foo": 1}'); } catch (e) { threw2 = true; }
      assert(threw2, '没有 log 段会抛异常');
      var threw3 = false;
      try { sanitizeHar('{"log": {}}'); } catch (e) { threw3 = true; }
      assert(threw3, '没有 entries 会抛异常');
      var threw4 = false;
      try { sanitizeHar('not json'); } catch (e) { threw4 = true; }
      assert(threw4, '不是 JSON 会抛异常');
    }
  };
})();
