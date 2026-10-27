/* ==========================================================================
   邮件头解析器（email-header-parser）

   贴一整封邮件的原始头（或者只贴头那一段），把里面藏着的结构摊开成看得懂的
   几块：收发件人、日期、投递路径（Received 链）、认证结果（SPF/DKIM/DMARC）、
   以及全部头字段。

   上游 issue #1396 是个「想要个新工具」的需求，参考了 mxtoolbox 的
   EmailHeaders 分析页与 cyberdefenders/email-header-analyzer。
   it-tools 本身没有对应实现，所以这里从零写，没有「参考实现」可抄
   —— 上游**没有这个工具**，这一份是从零实现的，没有照抄任何上游代码。

   ---- 为什么值得单独写一个工具 ----
   原始邮件头有两处不做处理就读不懂：
   1. RFC 2047 编码字（encoded word）。中文/带重音字符的 Subject 几乎一定是
      `=?UTF-8?B?5Lit5paH?=` 这种形式，不解开就是一串 Base64。这里实现了
      RFC 2047 §6 的 B/Q 两种编码。
   2. 折行（folding）。RFC 5322 允许一个头字段跨多行，续行以空白开头。
      不先拼回去的话，`Received:` 会被截成半截，后面正则全部匹配不上。

   ---- 与参考站点的差别 ----
   mxtoolbox 要收域名，cyberdefenders 只给了个命令行。这里纯前端、零请求。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('email-header-parser');

  /* ======================================================================
     1. 切分与折行
     ====================================================================== */

  /**
   * 把输入切成「头块」和「正文」。
   *
   * 头块结束于第一个空行（RFC 5322 §4.1）。用户常常只贴了头，那就整段都算头；
   * 也常常连 `\r\n\r\n` 都忘了，那全篇没有空行，同样整段算头 —— 两种情况
   * 都不能报错，得照样解析。
   *
   * @param {string} text
   * @returns {{headers: string, body: string}}
   */
  function splitHeaderBlock(text) {
    var raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var idx = raw.indexOf('\n\n');
    if (idx === -1) return { headers: raw, body: '' };
    return { headers: raw.slice(0, idx), body: raw.slice(idx + 2) };
  }

  /**
   * 展开折行：把以空白开头的续行接回上一行（RFC 5322 §2.2.3）。
   *
   * 续行接上去时**留一个空格**。规范说的是展开成 CRLF，但这一层我们是给人和
   * 正则看的，换成空格比换行友好得多；只有在 `Received` 里多个 from 挨在一起
   * 的极端情况下会有歧义，实际邮件里见不到。
   *
   * 自己先把 CRLF 归一成 LF，别指望调用方记得做 —— 粘来的邮件头三种换行
   * （\r\n / \n / \r）都有，漏了一种就会在每行尾巴留个 \r，后面正则全错位。
   *
   * @param {string} text 头块，换行随意
   * @returns {string[]}
   */
  function unfold(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    lines.forEach(function (line) {
      // 续行：至少一个空白开头，且前面确实已经有内容可以续
      if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += ' ' + line.trim();
      else out.push(line);
    });
    return out;
  }

  /**
   * 解析成头字段数组，**保持原始顺序**（同名头会重复出现，例如 Received）。
   * @param {string} text 整封邮件或纯头块
   * @returns {{name: string, lname: string, value: string}[]}
   */
  function parseHeaders(text) {
    var head = splitHeaderBlock(text).headers;
    var out = [];
    unfold(head).forEach(function (line) {
      if (!line.trim()) return;
      // 第一个冒号才是分隔符 —— 值里可以再有冒号（`Date: ... 07:28:00 +0000`）
      var i = line.indexOf(':');
      if (i <= 0) return;   // 不是合法头字段（正文残留 / 分隔线 `---`），跳过而不是报错
      var name = line.slice(0, i).trim();
      if (!name) return;
      out.push({ name: name, lname: name.toLowerCase(), value: line.slice(i + 1).trim() });
    });
    return out;
  }

  /** 取第一个同名头的值，没有返回 ''。 */
  function firstHeader(headers, lname) {
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].lname === lname) return headers[i].value;
    }
    return '';
  }

  /** 取所有同名头的值，按出现顺序。 */
  function allHeaders(headers, lname) {
    return headers.filter(function (h) { return h.lname === lname; })
      .map(function (h) { return h.value; });
  }

  /* ======================================================================
     2. RFC 2047 编码字
     ====================================================================== */

  /**
   * 按字符集名解一段字节。TextDecoder 不认识的编码名（各家的别名很多）退回
   * UTF-8 —— 总比抛异常把整个工具打挂强。
   */
  function decodeCharset(bytes, charset) {
    var cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
    // TextDecoder 只认 WHATWG 名字，补几个 RFC 里常见但它不认的别名
    var alias = {
      'utf8': 'utf-8', 'utf-8': 'utf-8',
      'iso-8859-1': 'windows-1252', 'latin1': 'windows-1252', 'latin-1': 'windows-1252',
      'us-ascii': 'windows-1252', 'ascii': 'windows-1252',
      'gb2312': 'gbk', 'gb_2312-80': 'gbk', 'x-gbk': 'gbk',
      'ks_c_5601-1987': 'euc-kr', 'ks_c_5601-1989': 'euc-kr',
      'windows-31j': 'shift_jis', 'cp932': 'shift_jis', 'x-sjis': 'shift_jis',
      'big5': 'big5', 'unknown-8bit': 'windows-1252', 'x-unknown': 'windows-1252',
      'default': 'windows-1252', '': 'windows-1252'
    };
    var name = alias[cs] || cs;
    try {
      return new TextDecoder(name).decode(bytes);
    } catch (e) {
      try { return new TextDecoder('utf-8').decode(bytes); } catch (e2) { return ''; }
    }
  }

  /**
   * 解 Q 编码（RFC 2047 §4.2）：`_` 是空格，`=XX` 是字节，其余原样。
   * 走字节而不是字符串，才能保住非 ASCII 的原字节。
   */
  function decodeQ(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (c === '_') { bytes.push(0x20); continue; }
      if (c === '=' && /^[0-9a-f]{2}$/i.test(str.substr(i + 1, 2))) {
        bytes.push(parseInt(str.substr(i + 1, 2), 16));
        i += 2;
        continue;
      }
      // 非 ASCII 字符取其 UTF-8 字节（Q 编码里理论上不该出现，出现也不该丢）
      var cp = str.codePointAt(i);
      var s = String.fromCodePoint(cp);
      if (cp > 0xffff) i++;
      for (var b of U.utf8Bytes(s)) bytes.push(b);
    }
    return new Uint8Array(bytes);
  }

  /**
   * 解开字符串里的 RFC 2047 编码字。
   *
   * 两条容易踩的坑：
   * - 编码字之间夹的空白必须**丢掉**（§6.2）。`=?UTF-8?B?5Lit?= =?UTF-8?B?5paH?=`
   *   是一整个词，中间那个空格只是分隔符，留在结果里就成了「中 文」。
   * - 只在编码字**完整匹配**时才替换。值里出现字面的 `=?` 序列（比如被二次编码过的
   *   内容）不该被吃掉。
   *
   * @param {string} str
   * @returns {string}
   */
  function decodeMimeWords(str) {
    var s = String(str == null ? '' : str);
    var RE = /=\?([^?]*)\?([BbQq])\?([^?]*)\?=/g;
    if (!RE.test(s)) return s;
    RE.lastIndex = 0;

    var out = '';
    var last = 0;
    var m;
    var prevWasWord = false;
    while ((m = RE.exec(s)) !== null) {
      var between = s.slice(last, m.index);
      // 紧邻的两个编码字之间的空白按 §6.2 丢掉
      if (!(prevWasWord && /^[ \t\r\n]*$/.test(between))) out += between;
      prevWasWord = true;

      var charset = m[1], enc = m[2].toUpperCase(), payload = m[3];
      var text;
      if (enc === 'B') {
        try { text = decodeCharset(U.base64ToBytes(payload), charset); }
        catch (e) { text = ''; }   // Base64 非法：吞掉，别让整个字段解析失败
      } else {
        text = decodeCharset(decodeQ(payload), charset);
      }
      out += text;
      last = m.index + m[0].length;
    }
    out += s.slice(last);
    return out;
  }

  /* ======================================================================
     3. 地址
     ====================================================================== */

  /**
   * 把地址列表按逗号切开。
   *
   * 不能直接 `split(',')`：`"Zhang, San" <san@x.com>` 里那个逗号在引号里面，
   * 按逗号切会把一个地址劈成两个。括号 `<>` 同理（`<a@x.com, b@x.com>` 是群发）。
   */
  function splitAddressList(str) {
    var parts = [];
    var buf = '';
    var inQuote = false;
    var angle = 0;
    var inComment = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (c === '\\' && i + 1 < str.length) { buf += c + str.charAt(i + 1); i++; continue; }
      if (inComment > 0) { if (c === '(') inComment++; else if (c === ')') inComment--; buf += c; continue; }
      if (inQuote) { if (c === '"') inQuote = false; buf += c; continue; }
      if (c === '"') { inQuote = true; buf += c; continue; }
      if (c === '(') { inComment++; buf += c; continue; }
      if (c === '<') { angle++; buf += c; continue; }
      if (c === '>') { if (angle > 0) angle--; buf += c; continue; }
      if (c === ',' && angle === 0) { parts.push(buf); buf = ''; continue; }
      buf += c;
    }
    parts.push(buf);
    return parts.map(function (p) { return p.trim(); }).filter(function (p) { return p.length; });
  }

  /** 去掉显示名外面的引号，并把转义引号还原。 */
  function unquote(str) {
    var s = String(str == null ? '' : str).trim();
    if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
      s = s.slice(1, -1);
    }
    return s.replace(/\\(["\\])/g, '$1').trim();
  }

  /**
   * 解析一个地址。
   *
   * `Name <addr>` 取尖括号里的邮箱、尖括号前当显示名；没有尖括号时整段就是邮箱。
   * 显示名如果是编码字，一并解开。
   *
   * @returns {{name: string, address: string}}
   */
  function parseAddress(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var m = s.match(/^(.*?)<([^<>]*)>\s*$/);
    if (m) {
      // 尖括号前还可能带注释块（`(the boss)`），剥掉再当显示名
      var label = m[1].replace(/\([^()]*\)/g, '').trim();
      return { name: decodeMimeWords(unquote(label)), address: m[2].trim() };
    }
    s = s.replace(/\([^()]*\)/g, '').trim();
    return { name: '', address: decodeMimeWords(s) };
  }

  /** 解析整个地址列表字段。空串返回空数组。 */
  function parseAddresses(str) {
    return splitAddressList(decodeMimeWords(str)).map(parseAddress);
  }

  /* ======================================================================
     4. 日期
     ====================================================================== */

  /**
   * 解析 RFC 5322 的 Date。
   *
   * `Date.parse` 原生就吃 `Wed, 21 Oct 2015 07:28:00 +0000` 这种格式，
   * 所以不自己写日期解析器 —— 写了也不会比它准。真正要做的是把「转成
   * 什么样」和「原值是什么」分开返回：邮件里的时区是发件方写的，跟看的人
   * 未必一致，两个都得给出。
   *
   * @returns {{raw: string, iso: string, local: string, ageMs: number|null}|null}
   */
  function parseHeaderDate(str) {
    var raw = String(str == null ? '' : str).trim();
    if (!raw) return null;
    var ts = Date.parse(raw);
    if (!isFinite(ts)) return null;
    var d = new Date(ts);
    return {
      raw: raw,
      iso: d.toISOString(),
      local: d.toString(),
      ageMs: Date.now() - ts
    };
  }

  /**
   * 把时长说成人话（`2 days ago`）。
   *
   * 单位名与「多久以前 / 还有多久」的说法都走 i18n —— 单复数各占一个键，
   * 中文两种写法一样，英文靠 one/many 区分。
   */
  var AGE_UNITS = [
    { ms: 31536000000, one: t('unit_year', 'year'), many: t('unit_years', 'years') },
    { ms: 2592000000, one: t('unit_month', 'month'), many: t('unit_months', 'months') },
    { ms: 604800000, one: t('unit_week', 'week'), many: t('unit_weeks', 'weeks') },
    { ms: 86400000, one: t('unit_day', 'day'), many: t('unit_days', 'days') },
    { ms: 3600000, one: t('unit_hour', 'hour'), many: t('unit_hours', 'hours') },
    { ms: 60000, one: t('unit_minute', 'minute'), many: t('unit_minutes', 'minutes') },
    { ms: 1000, one: t('unit_second', 'second'), many: t('unit_seconds', 'seconds') }
  ];

  function humanizeAge(ms) {
    if (ms == null || !isFinite(ms)) return null;
    var abs = Math.abs(ms);
    for (var i = 0; i < AGE_UNITS.length; i++) {
      if (abs >= AGE_UNITS[i].ms) {
        var n = Math.floor(abs / AGE_UNITS[i].ms);
        var label = n === 1 ? AGE_UNITS[i].one : AGE_UNITS[i].many;
        return ms >= 0
          ? t('age_ago', '{n} {unit} ago').replace('{n}', String(n)).replace('{unit}', label)
          : t('age_in', 'in {n} {unit}').replace('{n}', String(n)).replace('{unit}', label);
      }
    }
    return ms >= 0 ? t('age_now', 'just now') : t('age_moment', 'in a moment');
  }

  /* ======================================================================
     5. Received 链
     ====================================================================== */

  /**
   * 拆一条 `Received:`。
   *
   * 形如：
   *   from a.google.com (a.google.com. [209.85.220.41])
   *   by mx.example.com with ESMTPS id abc for <u@x.com>;
   *   Wed, 21 Oct 2015 07:28:00 -0700 (PDT)
   *
   * 字段之间没有严格语法，唯一稳的分隔是**最后一个顶层分号**：它前面是路径，
   * 后面是时间。`(PDT)` 这种注释里的分号不能当分隔，所以先剥注释。
   *
   * @returns {{from, by, with: protocol, for: recipient, id, ip, date, raw}}
   */
  function parseReceived(str) {
    var raw = String(str == null ? '' : str).trim();
    // 剥掉 (…)，但保留其中的方括号内容 —— IP 就写在里面。
    // 方括号里既可能是 IPv4 也可能是 IPv6，别只认点分的那一种。
    var noComment = raw.replace(/\((?:[^()\\]|\\.)*\)/g, function (m) {
      return /\[[0-9a-f.:]+\]/i.test(m) ? m.replace(/^\(|\)$/g, '') : '';
    });

    // 最后一次出现且不在尖括号里的分号
    var semi = -1;
    var angle = 0;
    for (var i = noComment.length - 1; i >= 0; i--) {
      var c = noComment.charAt(i);
      if (c === '>') angle++;
      else if (c === '<') { if (angle > 0) angle--; }
      else if (c === ';' && angle === 0) { semi = i; break; }
    }
    var path = semi === -1 ? noComment : noComment.slice(0, semi);
    var dateStr = semi === -1 ? '' : noComment.slice(semi + 1).trim();

    function pick(re) {
      var m = path.match(re);
      return m ? m[1].trim() : '';
    }

    // IP：优先取方括号里的（`(host. [1.2.3.4])`），其次取路径里裸露的
    var ip = '';
    var bracket = noComment.match(/\[\s*(?:IPv6:)?([0-9a-f.:]+)\s*\]/i);
    if (bracket) ip = bracket[1];
    else {
      var bare = path.match(/(?:^|\s)((?:\d{1,3}\.){3}\d{1,3})(?:\s|$)/);
      if (bare) ip = bare[1];
    }

    return {
      from: pick(/\bfrom\s+(\S+)/i),
      by: pick(/\bby\s+(\S+)/i),
      with: pick(/\bwith\s+(\S+)/i),
      for: pick(/\bfor\s+<?([^>]*)>?/i),
      id: pick(/\bid\s+(\S+)/i),
      ip: ip,
      date: dateStr,
      raw: raw
    };
  }

  /* ======================================================================
     6. 认证结果
     ====================================================================== */

  /**
   * 拆 `Authentication-Results:`。
   *
   *   mx.example.com; spf=pass smtp.mailfrom=user@x.com;
   *   dkim=pass header.i=@x.com; dmarc=pass header.from=x.com
   *
   * 一次认证可以报多个机制（还有 arc、iprev、auth），全部列出来 —— 判定
   * 「这封信是不是 spoof 不了」靠的是**全过**，少看一条就可能误判。
   *
   * @returns {{method: string, result: string, detail: string}[]}
   */
  function parseAuthResults(str) {
    var out = [];
    // 只取真正的方法名（`a.b.c; spf=...` 这种头部元信息先切掉）
    var RE = /\b([a-z][a-z0-9-]{1,15})=([a-z0-9_-]+)((?:\s+[a-z0-9._-]+=[^\s;]*)*)/gi;
    var m;
    var s = String(str == null ? '' : str);
    while ((m = RE.exec(s)) !== null) {
      out.push({
        method: m[1].toLowerCase(),
        result: m[2].toLowerCase(),
        detail: String(m[3] || '').trim()
      });
    }
    return out;
  }

  /** 结果是好是坏。`none`/`neutral`/`bestpasspass` 这类要区别对待，所以单独列。 */
  function authVerdict(result) {
    if (result === 'pass') return 'pass';
    if (result === 'fail' || result === 'permerror' || result === 'temperror' || result === 'hardfail') return 'fail';
    return 'other';
  }

  /* ======================================================================
     7. 汇总
     ====================================================================== */

  /**
   * 主入口：整封邮件 -> 一份结构化结果。
   * @param {string} text
   * @returns {Object}
   */
  function parseEmail(text) {
    var headers = parseHeaders(text);
    var subject = firstHeader(headers, 'subject');
    var date = parseHeaderDate(firstHeader(headers, 'date'));

    var received = allHeaders(headers, 'received').map(parseReceived);

    // 认证结果可能散在多个 Authentication-Results 头里（多跳 MTA 各加一条）
    var auth = [];
    allHeaders(headers, 'authentication-results').forEach(function (v) {
      auth = auth.concat(parseAuthResults(v));
    });

    var contentType = firstHeader(headers, 'content-type');

    return {
      headers: headers,
      summary: {
        from: parseAddresses(firstHeader(headers, 'from')),
        to: parseAddresses(firstHeader(headers, 'to')),
        cc: parseAddresses(firstHeader(headers, 'cc')),
        bcc: parseAddresses(firstHeader(headers, 'bcc')),
        replyTo: parseAddresses(firstHeader(headers, 'reply-to')),
        returnPath: decodeMimeWords(firstHeader(headers, 'return-path')),
        sender: decodeMimeWords(firstHeader(headers, 'sender')),
        subject: decodeMimeWords(subject),
        subjectEncoded: /=\?[^?]*\?[BbQq]\?/.test(subject),
        date: date,
        messageId: firstHeader(headers, 'message-id'),
        inReplyTo: allHeaders(headers, 'in-reply-to'),
        references: firstHeader(headers, 'references'),
        contentType: contentType,
        mimeVersion: firstHeader(headers, 'mime-version')
      },
      // 头部从上到下是「最新 → 最旧」，投递路径要正着读才顺，所以反过来
      received: received,
      receivedOldestFirst: received.slice().reverse(),
      auth: auth,
      body: splitHeaderBlock(text).body,
      xHeaders: headers.filter(function (h) { return /^x-/i.test(h.name); })
    };
  }

  /* ======================================================================
     8. UI
     ====================================================================== */

  var SAMPLE = [
    'Return-Path: <bounce+abc123@mail.example.org>',
    'Received: from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.41])',
    '\tby mx.example.com (Postfix) with ESMTPS id 4C7F2A1B',
    '\tfor <zhang@example.com>; Wed, 21 Oct 2015 07:28:00 -0700 (PDT)',
    'Received: from sender.local (unknown [10.0.0.7])',
    '\tby mail.example.org (Postfix) with ESMTP id 9911',
    '\tfor <zhang@example.com>; Wed, 21 Oct 2015 07:27:41 -0700 (PDT)',
    'Authentication-Results: mx.example.com; spf=pass smtp.mailfrom=notice@example.org;',
    '\tdkim=pass header.i=@example.org; dmarc=pass header.from=example.org',
    'Message-ID: <CAF=abc123def456@mail.example.org>',
    'Date: Wed, 21 Oct 2015 07:28:00 -0700',
    'From: =?UTF-8?B?5byg5LiJ?= <zhang@example.org>',
    'To: "Doe, John" <john@example.com>, jane@example.com',
    'Cc: bob@example.com',
    'Subject: =?UTF-8?B?5Lit5paH6YKu5Lu25qCH6aKY?=',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'X-Mailer: Example Mailer 3.2',
    'X-Priority: 3'
  ].join('\r\n');

  window.ItTools.register('email-header-parser', function (root) {
    var textarea = D.h('textarea.layui-textarea', {
      rows: 10, spellcheck: 'false',
      placeholder: t('input_ph', 'Paste the raw email headers here...')
    });
    // 样例这样填（而不是塞进 attrs 的 value 里）—— 本仓库里多数工具都是这么写的。
    textarea.value = SAMPLE;
    var output = D.h('div');

    function addrList(list) {
      if (!list.length) return D.h('span', { style: { opacity: '.6' }, text: '—' });
      return D.h('div', null, list.map(function (a) {
        return D.h('div', null,
          a.name ? D.h('strong', { text: a.name }) : null,
          a.name ? D.h('span', { text: ' ' }) : null,
          D.h('span', { style: { opacity: '.8' }, text: '<' + a.address + '>' })
        );
      }));
    }

    function row(name, valueNode) {
      return D.h('tr', null, D.h('td', null, D.h('strong', { text: name })), D.h('td.val', null, valueNode));
    }

    function textNode(v) {
      return D.h('span', { text: String(v) });
    }

    function render() {
      D.clear(output);
      var data = parseEmail(textarea.value);
      var s = data.summary;

      if (!data.headers.length) {
        output.appendChild(D.h('p.field-hint', { text: t('no_headers', 'No headers found — check the input.') }));
        return;
      }

      /* --- 概要 --- */
      var subjectNode = D.h('span', { text: s.subject || '—' });
      if (s.subjectEncoded) {
        subjectNode.appendChild(D.h('span.badge-note', { text: t('rfc2047_decoded', ' (RFC 2047 decoded)') }));
      }

      var dateNode;
      if (s.date) {
        dateNode = D.h('div', null,
          D.h('div', { text: s.date.local }),
          D.h('div', { style: { opacity: '.7', marginTop: '4px' },
            text: s.date.iso + ' · ' + (humanizeAge(s.date.ageMs) || '') }));
      } else {
        dateNode = textNode(s.date === null && firstHeader(data.headers, 'date') ? t('unparseable_date', 'Unparseable Date header') : '—');
      }

      output.appendChild(D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null, D.h('th', { colspan: '2', text: t('summary', 'Summary') }))),
        D.h('tbody', null,
          row(t('from', 'From'), addrList(s.from)),
          s.sender ? row(t('sender', 'Sender'), textNode(s.sender)) : null,
          row(t('to', 'To'), addrList(s.to)),
          s.cc.length ? row(t('cc', 'Cc'), addrList(s.cc)) : null,
          s.bcc.length ? row(t('bcc', 'Bcc'), addrList(s.bcc)) : null,
          s.replyTo.length ? row(t('reply_to', 'Reply-To'), addrList(s.replyTo)) : null,
          s.returnPath ? row(t('return_path', 'Return-Path'), textNode(s.returnPath)) : null,
          row(t('subject', 'Subject'), subjectNode),
          row(t('date', 'Date'), dateNode),
          s.messageId ? row(t('message_id', 'Message-ID'), textNode(s.messageId)) : null,
          s.inReplyTo.length ? row(t('in_reply_to', 'In-Reply-To'), textNode(s.inReplyTo.join(' '))) : null,
          s.references ? row(t('references', 'References'), textNode(s.references)) : null,
          s.contentType ? row(t('content_type', 'Content-Type'), textNode(s.contentType)) : null,
          s.mimeVersion ? row(t('mime_version', 'MIME-Version'), textNode(s.mimeVersion)) : null
        )
      ));

      /* --- 投递路径 --- */
      if (data.received.length) {
        var tbody = D.h('tbody');
        // 从最早的一跳画到最新的一跳，跟邮件实际走过来的方向一致
        data.receivedOldestFirst.forEach(function (r, i) {
          var bits = [];
          if (r.from) bits.push('from ' + r.from);
          if (r.ip) bits.push(r.ip);
          if (r.by) bits.push('by ' + r.by);
          if (r.with) bits.push('with ' + r.with);
          if (r.id) bits.push('id ' + r.id);
          if (r.for) bits.push('for <' + r.for + '>');
          tbody.appendChild(D.h('tr', null,
            D.h('td', null, D.h('strong', { text: t('hop', 'hop {n}').replace('{n}', String(i + 1)) })),
            D.h('td.val', null,
              D.h('div', { text: bits.join(' · ') }),
              r.date ? D.h('div', { style: { opacity: '.7', marginTop: '4px' },
                text: (parseHeaderDate(r.date) ? parseHeaderDate(r.date).local : r.date) }) : null
            )
          ));
        });
        output.appendChild(D.h('table.kv-table', null,
          D.h('thead', null, D.h('tr', null,
            D.h('th', { colspan: '2', text: t('delivery_path', 'Delivery path (oldest → newest, {n} hops)').replace('{n}', String(data.received.length)) }))),
          tbody
        ));
      }

      /* --- 认证结果 --- */
      if (data.auth.length) {
        var atbody = D.h('tbody');
        data.auth.forEach(function (a) {
          var verdict = authVerdict(a.result);
          var tag = D.h('span', {
            style: {
              fontWeight: '600',
              color: verdict === 'pass' ? 'var(--primary)' : verdict === 'fail' ? '#d93025' : 'var(--text-muted)'
            },
            text: a.result
          });
          atbody.appendChild(D.h('tr', null,
            D.h('td', null, D.h('strong', { text: a.method })),
            D.h('td.val', null, tag, a.detail ? D.h('div', { style: { opacity: '.7', marginTop: '4px' }, text: a.detail }) : null)
          ));
        });
        output.appendChild(D.h('table.kv-table', null,
          D.h('thead', null, D.h('tr', null, D.h('th', { colspan: '2', text: t('auth_results', 'Authentication results') }))),
          atbody
        ));
      }

      /* --- 全部头字段 --- */
      var htbody = D.h('tbody');
      data.headers.forEach(function (h) {
        var value = h.value;
        // 值里可能含编码字，展示的是解开的，旁边保留原值以便核对
        var decoded = decodeMimeWords(value);
        htbody.appendChild(D.h('tr', null,
          D.h('td', null, D.h('strong', { text: h.name })),
          D.h('td.val', null,
            D.h('div', { text: decoded }),
            decoded !== value ? D.h('div', { style: { opacity: '.6', marginTop: '4px' }, text: t('raw_value', '(raw) {value}').replace('{value}', value) }) : null
          )
        ));
      });
      output.appendChild(D.h('table.kv-table', null,
        D.h('thead', null, D.h('tr', null,
          D.h('th', { colspan: '2', text: t('all_headers', 'All headers ({n})').replace('{n}', String(data.headers.length)) }))),
        htbody
      ));

      output.appendChild(D.h('div.form-actions', null,
        U.copyButton(function () { return JSON.stringify(data.headers, null, 2); }, t('copy_json', 'Copy headers as JSON'))
      ));
    }

    textarea.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Raw email headers'), textarea, {
        wide: true,
        hint: t('input_hint', 'The whole email (body included) works too — it is split at the first blank line, and RFC 2047 encoded words and folded lines are unfolded')
      }),
      output
    ));
    render();

    return { destroy: function () { D.clear(root); } };
  });

  /* ======================================================================
     9. 导出与自测
     ====================================================================== */

  window.ItTools.logic['email-header-parser'] = {
    splitHeaderBlock: splitHeaderBlock,
    unfold: unfold,
    parseHeaders: parseHeaders,
    firstHeader: firstHeader,
    allHeaders: allHeaders,
    decodeCharset: decodeCharset,
    decodeQ: decodeQ,
    decodeMimeWords: decodeMimeWords,
    splitAddressList: splitAddressList,
    unquote: unquote,
    parseAddress: parseAddress,
    parseAddresses: parseAddresses,
    parseHeaderDate: parseHeaderDate,
    humanizeAge: humanizeAge,
    parseReceived: parseReceived,
    parseAuthResults: parseAuthResults,
    authVerdict: authVerdict,
    parseEmail: parseEmail,
    __cases: function (assert) {
      /* ---- 切分与折行 ---- */
      assert.eq(splitHeaderBlock('A: 1\r\nB: 2\r\n\r\nbody').headers, 'A: 1\nB: 2', 'CRLF 归一 + 按空行切头');
      assert.eq(splitHeaderBlock('A: 1\nB: 2').body, '', '没有空行时正文为空（整段都算头）');
      assert.eq(splitHeaderBlock('').headers, '', '空输入');

      assert.eq(unfold('A: one\n two\nB: three'), ['A: one two', 'B: three'], '折行接回上一行');
      assert.eq(unfold('A: one\r\n\tstill one'), ['A: one still one'], '制表符续行，且 CRLF 自己归一');
      assert.eq(unfold('A: one\rB: two'), ['A: one', 'B: two'], '裸 CR 是换行，不是续行');
      assert.eq(unfold('  leading'), ['  leading'], '首行就是续行时不越界，原样保留');
      assert.eq(parseHeaders('  leading').length, 0, '首行是续行时不会被当成头');

      /* ---- 头解析 ---- */
      var hs = parseHeaders('Received: from a\n\tby b\nDate: Wed, 21 Oct 2015 07:28:00 +0000\nX-A: 1\nX-A: 2');
      assert.eq(hs.length, 4, '折行后是 4 个头');
      assert.eq(hs[0].value, 'from a by b', 'Received 折行被接起来');
      assert.eq(hs[1].value, 'Wed, 21 Oct 2015 07:28:00 +0000', '值里的冒号不当分隔符');
      assert.eq(hs.filter(function (h) { return h.name === 'X-A'; }).length, 2, '同名头各自保留，不合并');
      assert.eq(allHeaders(hs, 'x-a').length, 2, 'allHeaders 收齐同名头');
      assert.eq(firstHeader(hs, 'x-a'), '1', 'firstHeader 取第一个');
      assert.eq(firstHeader(hs, 'nope'), '', '没有就是空串');
      assert.eq(parseHeaders('not a header line').length, 0, '非法行被跳过而不是报错');
      assert.eq(parseHeaders('X-Empty:').length, 1, '只有名字没有值也算一个头');

      /* ---- RFC 2047 ---- */
      assert.eq(decodeMimeWords('=?UTF-8?B?5Lit5paH?='), '中文', 'B 编码');
      assert.eq(decodeMimeWords('=?UTF-8?Q?=E4=B8=AD=E6=96=87?='), '中文', 'Q 编码的 =XX');
      assert.eq(decodeMimeWords('=?utf-8?q?a_b?='), 'a b', 'Q 编码里 _ 是空格');
      assert.eq(decodeMimeWords('=?ISO-8859-1?Q?caf=E9?='), 'café', 'latin1 字符集');
      assert.eq(decodeMimeWords('=?BIG5?B?pKSk5Q==?='), '中文', '字符集别名 Big5');
      assert.eq(decodeMimeWords('=?x-unknown-charset?B?5Lit5paH?='), '中文', '不认识的字符集退回 UTF-8 而不是抛错');
      assert.eq(decodeMimeWords('=?utf-8?b?5Lit?= =?utf-8?b?5paH?='), '中文',
        '相邻编码字中间的空白按 §6.2 丢掉');
      assert.eq(decodeMimeWords('a =?UTF-8?B?5Lit?='), 'a 中', '编码字前面的空白要留着');
      assert.eq(decodeMimeWords('plain text'), 'plain text', '没有编码字就原样');
      assert.eq(decodeMimeWords('a=?b'), 'a=?b', '不完整的编码字不动');
      assert.eq(decodeMimeWords('=?UTF-8?B?!!!?='), '', '非法 Base64 不炸');

      /* ---- 地址 ---- */
      assert.eq(parseAddresses('a@x.com, b@y.com').map(function (a) { return a.address; }),
        ['a@x.com', 'b@y.com'], '两个地址');
      assert.eq(parseAddress('John Doe <john@x.com>'), { name: 'John Doe', address: 'john@x.com' }, '显示名 + 尖括号');
      assert.eq(parseAddress('john@x.com'), { name: '', address: 'john@x.com' }, '没有显示名');
      assert.eq(parseAddress('"Zhang, San" <san@x.com>').address, 'san@x.com',
        '"Zhang, San" 里的逗号不切地址');
      assert.eq(parseAddress('"Zhang, San" <san@x.com>').name, 'Zhang, San', '带引号的显示名');
      assert.eq(parseAddress('"a\\"b" <a@x.com>').name, 'a"b', '转义引号还原');
      assert.eq(parseAddress('Boss (the boss) <b@x.com>').name, 'Boss', '注释块剥掉');
      assert.eq(parseAddresses('<a@x.com, b@x.com>').map(function (a) { return a.address; }),
        ['a@x.com, b@x.com'], '尖括号内的逗号不切');
      assert.eq(parseAddresses('=?UTF-8?B?5byg5LiJ?= <z@x.com>')[0].name, '张三', '显示名是编码字');
      assert.eq(parseAddresses('').length, 0, '空串');

      /* ---- 日期 ---- */
      var d = parseHeaderDate('Wed, 21 Oct 2015 07:28:00 -0700');
      assert(d !== null, 'RFC 5322 日期能解析');
      assert.eq(d.iso, '2015-10-21T14:28:00.000Z', '按 UTC 归一');
      assert.eq(parseHeaderDate('not a date'), null, '非法日期给 null');
      assert.eq(parseHeaderDate(''), null, '空日期给 null');
      assert.eq(humanizeAge(0), 'just now', '0 毫秒');
      assert.eq(humanizeAge(-7200000), 'in 2 hours', '未来');
      assert.eq(humanizeAge(172800000), '2 days ago', '过去且复数');

      /* ---- Received ---- */
      var r = parseReceived('from mail.google.com (mail.google.com. [209.85.220.41]) by mx.example.com with ESMTPS id 4C7F2A1B for <z@x.com>; Wed, 21 Oct 2015 07:28:00 -0700 (PDT)');
      assert.eq(r.from, 'mail.google.com', 'from');
      assert.eq(r.by, 'mx.example.com', 'by');
      assert.eq(r.with, 'ESMTPS', 'with');
      assert.eq(r.id, '4C7F2A1B', 'id');
      assert.eq(r.for, 'z@x.com', 'for');
      assert.eq(r.ip, '209.85.220.41', '方括号里的 IP');
      assert(r.date.indexOf('Wed, 21 Oct 2015') === 0, '分号后面是时间: ' + r.date);
      assert.eq(parseReceived('by b; Wed, 21 Oct 2015 07:28:00 -0700').from, '', '没有 from');
      assert.eq(parseReceived('from a by b').date, '', '没有分号就没有时间');
      assert.eq(parseReceived('from a (with semicolon ; inside) by b; Mon, 1 Jan 2024 00:00:00 +0000').date.indexOf('Mon, 1 Jan 2024'), 0,
        '注释里的分号不当分隔符');
      assert.eq(parseReceived('from a ([2001:db8::1]) by b; Mon, 1 Jan 2024 00:00:00 +0000').ip, '2001:db8::1', 'IPv6');
      assert.eq(parseReceived('from a by b for <a@x.com>, <b@y.com>; Mon, 1 Jan 2024 00:00:00 +0000').for, 'a@x.com',
        'for 有多个收件人时只取第一个');

      /* ---- 认证结果 ---- */
      var auth = parseAuthResults('mx.example.com; spf=pass smtp.mailfrom=u@x.com; dkim=pass header.i=@x.com; dmarc=pass header.from=x.com');
      assert.eq(auth.map(function (a) { return a.method; }), ['spf', 'dkim', 'dmarc'], '三个机制都抓到');
      assert.eq(auth[0].result, 'pass', '结果');
      assert(auth[0].detail.indexOf('smtp.mailfrom=u@x.com') === 0, '细节: ' + auth[0].detail);
      assert.eq(parseAuthResults('spf=fail smtp.mailfrom=x.com')[0].result, 'fail', 'fail');
      assert.eq(parseAuthResults('dkim=neutral')[0].result, 'neutral', 'neutral');
      assert.eq(parseAuthResults('').length, 0, '空串');
      assert.eq(authVerdict('pass'), 'pass', 'pass 判定');
      assert.eq(authVerdict('hardfail'), 'fail', 'hardfail 算失败');
      assert.eq(authVerdict('none'), 'other', 'none 不算过也不算挂');

      /* ---- 汇总 ---- */
      var msg = parseEmail(SAMPLE_TEXT());
      assert.eq(msg.summary.from[0].name, '张三', 'From 显示名解开');
      assert.eq(msg.summary.from[0].address, 'zhang@example.org', 'From 地址');
      assert.eq(msg.summary.subject, '中文邮件标题', 'Subject 解码');
      assert.eq(msg.summary.subjectEncoded, true, '标记出 Subject 原本是编码字');
      assert.eq(msg.summary.to.map(function (a) { return a.name; }), ['Doe, John', ''], 'To 两个，一个有显示名');
      assert.eq(msg.summary.cc.length, 1, 'Cc');
      assert.eq(msg.summary.messageId, '<CAF=abc123def456@mail.example.org>', 'Message-ID');
      assert.eq(msg.summary.date.iso, '2015-10-21T14:28:00.000Z', 'Date');
      assert.eq(msg.received.length, 2, '两跳');
      assert.eq(msg.received[0].by, 'mx.example.com', '第一跳（最新）在前');
      assert.eq(msg.receivedOldestFirst[0].by, 'mail.example.org', '正序看第一跳是最早那跳');
      assert.eq(msg.auth.map(function (a) { return a.method; }), ['spf', 'dkim', 'dmarc'], '认证结果');
      assert.eq(msg.xHeaders.length, 2, 'X- 头两个');
      assert.eq(parseEmail('').headers.length, 0, '空输入不炸');
      assert.eq(parseEmail('Date: Wed, 21 Oct 2015 07:28:00 -0700\n\nbody here').body, 'body here', '正文被切出来');
      assert.eq(parseEmail('Date: Wed, 21 Oct 2015 07:28:00 -0700\n\nbody here').headers.length, 1, '整封邮件只切出头');
    }
  };

  /** __cases 用的样例，和 UI 里的 SAMPLE 保持一致。 */
  function SAMPLE_TEXT() {
    return [
      'Return-Path: <bounce+abc123@mail.example.org>',
      'Received: from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.41])',
      '\tby mx.example.com (Postfix) with ESMTPS id 4C7F2A1B',
      '\tfor <zhang@example.com>; Wed, 21 Oct 2015 07:28:00 -0700 (PDT)',
      'Received: from sender.local (unknown [10.0.0.7])',
      '\tby mail.example.org (Postfix) with ESMTP id 9911',
      '\tfor <zhang@example.com>; Wed, 21 Oct 2015 07:27:41 -0700 (PDT)',
      'Authentication-Results: mx.example.com; spf=pass smtp.mailfrom=notice@example.org;',
      '\tdkim=pass header.i=@example.org; dmarc=pass header.from=example.org',
      'Message-ID: <CAF=abc123def456@mail.example.org>',
      'Date: Wed, 21 Oct 2015 07:28:00 -0700',
      'From: =?UTF-8?B?5byg5LiJ?= <zhang@example.org>',
      'To: "Doe, John" <john@example.com>, jane@example.com',
      'Cc: bob@example.com',
      'Subject: =?UTF-8?B?5Lit5paH6YKu5Lu25qCH6aKY?=',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'X-Mailer: Example Mailer 3.2',
      'X-Priority: 3'
    ].join('\r\n');
  }
})();