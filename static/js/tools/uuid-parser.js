/* ==========================================================================
   UUID 解析器（uuid-parser）

   一行一个 UUID，把版本、变体、时间戳、时钟序列、节点这些字段逐条拆出来。
   非法的那一行单独标出来，不影响其它行。

   上游参考：it-tools 的 PR #742「New tool: UUID converter」（GPLv3）。
   上游那份是一个只覆盖「标准写法 + v1 时间戳」的转换器，下面这些是这里
   补齐或改掉的地方：

   1. 写法：标准带连字符的、大写的、紧凑 32 位十六进制的、带花括号的、
      带 urn:uuid: 前缀的都认；非法写法只标出那一行，不抛异常、也不影响
      其它行。上游遇到非标准写法直接报错。
   2. 版本：1..8 全认；nil（全 0）与 max（全 F）单独标注。上游把版本位
      限定在 1-5，v6 / v7 一概不认。
   3. v2（DCE security）不是标准时间戳，写明「不支持」；v3 / v5 的命名空间
      与被哈希的原文不可还原，写明「不可还原」。上游干脆不给这两种版本
      任何字段。
   4. v6：与 v1 同一套字段，只是 60 位时间戳被重排成
      time_high(32) | time_mid(16) | time_low(12)。
   5. v7：前 48 位是 Unix 毫秒时间戳，接着 12 位是亚毫秒随机数；
      没有时钟序列也没有节点。
   6. 时间戳换算全程用「两段 32 位」的整数运算，**不碰 BigInt** ——
      60 位时间戳在双精度里放不下，BigInt 一旦降级成 Number 就开始丢精度
      （《js-tool-conventions》里记着上游栽过这个坑）。这里把 60 位拆成
      (28 位, 32 位) 两段分别算，每段都稳稳小于 2^53。
   7. 节点是不是随机生成的，按 RFC 4122 §4.1.1 看多播位（节点首字节的
      最低位）：真 MAC 是 0，随机节点是 1。
   8. 额外给出 Microsoft GUID（混合端序）形式。

   本项目是 GPLv3（上游 it-tools 也是）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('uuid-parser');

  /**
   * RFC 4122 的纪元是 1582-10-15T00:00:00Z，比 Unix 纪元早
   * 12219292800 秒（12219292800000 毫秒）。v1 / v6 的 60 位时间戳就是从
   * 这个纪元起算的 100 纳秒计数。
   */
  var GREGORIAN_OFFSET_MS = 12219292800000;

  /** 标准写法：8-4-4-4-12。 */
  var HYPHEN_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  /** 只有十六进制数字与连字符 —— 别的东西（字母 g~z、中文、标点）一律非法。 */
  var HEXISH_RE = /^[0-9a-fA-F-]+$/;

  /* ---------- 写法归一 ---------- */

  /**
   * 去掉最外层的花括号。
   * @param {string} s
   * @returns {string}
   */
  function stripBraces(s) {
    if (s.length > 1 && s.charAt(0) === '{' && s.charAt(s.length - 1) === '}') {
      return s.slice(1, -1).trim();
    }
    return s;
  }

  /**
   * 去掉 urn:uuid: 前缀、花括号与首尾空白。
   *
   * urn:uuid: 前缀按 RFC 8141 是不分大小写的（URN 的 NID 与 "urn" 本身
   * 都比大小写），所以这里用 /i 匹配；上游只认全小写的 "urn:uuid:"。
   *
   * 花括号与前缀谁在外都行，所以先剥一层花括号，剥掉前缀之后再剥一层 ——
   * "{urn:uuid:…}" 与 "urn:uuid:{…}" 两种都得认。
   *
   * @param {string} s
   * @returns {string}
   */
  function stripDecorations(s) {
    var out = stripBraces(String(s == null ? '' : s).trim());
    if (/^urn:uuid:/i.test(out)) out = stripBraces(out.slice(9).trim());
    return out;
  }

  /**
   * 把一行输入解析成规范写法。
   *
   * 失败时给的是「原因类别」而不是一句话 —— 三类原因分别对应三条不同的
   * 提示文案：长度不对、含非十六进制字符、连字符位置不对。
   *
   * @param {string} raw
   * @returns {{ok: true, canonical: string, hex: string} | {ok: false, reason: string}}
   */
  function parseUuidString(raw) {
    var s = stripDecorations(raw);

    if (!s.length) return { ok: false, reason: 'length' };
    if (!HEXISH_RE.test(s)) return { ok: false, reason: 'charset' };

    var hex;
    if (s.indexOf('-') !== -1) {
      // 带连字符：长度必须是 36，连字符必须落在 8-4-4-4-12 的位置上
      if (s.length !== 36) return { ok: false, reason: 'length' };
      if (!HYPHEN_RE.test(s)) return { ok: false, reason: 'hyphens' };
      hex = s.replace(/-/g, '').toLowerCase();
    } else {
      if (s.length !== 32) return { ok: false, reason: 'length' };
      hex = s.toLowerCase();
    }

    return {
      ok: true,
      canonical: hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
        hex.slice(16, 20) + '-' + hex.slice(20),
      hex: hex
    };
  }

  /**
   * 只取规范写法；非法时返回 null。
   * @param {string} raw
   * @returns {string|null}
   */
  function normalizeUuid(raw) {
    var r = parseUuidString(raw);
    return r.ok ? r.canonical : null;
  }

  /* ---------- 变体 / 版本 ---------- */

  /**
   * 变体（variant）：按第 9 个八位组（octet 8，0 起数）的最高位判定。
   *
   *   0b0xx  → NCS（保留）
   *   0b10x → RFC 4122
   *   0b110 → Microsoft
   *   0b111 → 保留给将来
   *
   * @param {number} octet8 第 9 个字节（0..255）
   * @returns {string} 'ncs' | 'rfc4122' | 'microsoft' | 'future'
   */
  function detectVariant(octet8) {
    if ((octet8 & 0x80) === 0x00) return 'ncs';
    if ((octet8 & 0xc0) === 0x80) return 'rfc4122';
    if ((octet8 & 0xe0) === 0xc0) return 'microsoft';
    return 'future';
  }

  /* ---------- 时间戳 ---------- */

  /**
   * 60 位时间戳（100 纳秒单位）→ Unix 毫秒。
   *
   * 时间戳本身放不进双精度（2^60 ≈ 1.15e18 > 2^53），所以传的是两段：
   * hi 是高 28 位、lo 是低 32 位，整体时间戳 = hi * 2^32 + lo。
   *
   * 除以 10000 时也不能先算 hi * 2^32（那一下就溢出 2^53 了），而是先把
   * hi 拆成 10000 的倍数与余数：
   *
   *   floor((hi * 2^32 + lo) / 10000)
   *     = (hi / 10000) * 2^32 + floor(((hi % 10000) * 2^32 + lo) / 10000)
   *
   * 两项都稳稳小于 2^53，全程整数、无精度损失。
   *
   * @param {number} hi 高 28 位（0 .. 2^28-1）
   * @param {number} lo 低 32 位（0 .. 2^32-1）
   * @returns {number} Unix 毫秒
   */
  function ticksToUnixMs(hi, lo) {
    var a = Math.floor(hi / 10000);
    var ar = hi - a * 10000;
    var q = a * 4294967296 + Math.floor((ar * 4294967296 + lo) / 10000);
    return q - GREGORIAN_OFFSET_MS;
  }

  /**
   * Unix 毫秒 → ISO-8601（UTC），形如 2023-11-14T22:13:20.123Z。
   *
   * 不用 Date.toISOString()：那玩意儿的可用范围只有 ±8.64e15 毫秒，
   * 超出就抛 RangeError。这里自己按「天 → 年月日」的算法算，
   * v1 / v6 那些几千年后的时间戳照样能出结果。
   *
   * @param {number} ms
   * @returns {string}
   */
  function formatUnixMs(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';

    var days = Math.floor(ms / 86400000);
    var rem = ms - days * 86400000;
    var msOfDay = Math.floor(rem % 1000);
    var secOfDay = Math.floor(rem / 1000) % 86400;
    var hour = Math.floor(secOfDay / 3600);
    var minute = Math.floor((secOfDay % 3600) / 60);
    var second = secOfDay % 60;

    // Howard Hinnant 的 civil_from_days：把「自 1970-01-01 起的天数」
    // 换成公历的年月日，闰年规则与公历完全一致。
    var z = days + 719468;
    var era = Math.floor(z / 146097);
    var doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var month = mp < 10 ? mp + 3 : mp - 9;
    y += (month <= 2) ? 1 : 0;

    return padNum(y, 4) + '-' + padNum(month, 2) + '-' + padNum(day, 2) + 'T' +
      padNum(hour, 2) + ':' + padNum(minute, 2) + ':' + padNum(second, 2) + '.' +
      padNum(msOfDay, 3) + 'Z';
  }

  /** 数字补零到指定宽度（负数带负号）。 */
  function padNum(value, width) {
    var n = Math.floor(value);
    var sign = n < 0 ? '-' : '';
    var s = String(Math.abs(n));
    while (s.length < width) s = '0' + s;
    return sign + s;
  }

  /** 十六进制补零到指定宽度。 */
  function padHex(value, width) {
    var s = (value >>> 0).toString(16);
    while (s.length < width) s = '0' + s;
    return s;
  }

  /* ---------- 主解析 ---------- */

  /**
   * Microsoft GUID：前三个八位组按小端重排，后 8 个字节原样。
   *
   * GUID 的 Data1（32 位）、Data2（16 位）、Data3（16 位）都是小端存放，
   * 打印成字符串时按字节反过来写；Data4 是 8 个字节的序列，顺序不动。
   *
   * @param {number[]} b 16 个字节
   * @returns {string}
   */
  function toMicrosoftGuid(b) {
    function h2(x) { return (x & 0xff).toString(16); }
    function hx(x) { var s = h2(x); return s.length < 2 ? '0' + s : s; }
    return hx(b[3]) + hx(b[2]) + hx(b[1]) + hx(b[0]) + '-' +
      hx(b[5]) + hx(b[4]) + '-' +
      hx(b[7]) + hx(b[6]) + '-' +
      hx(b[8]) + hx(b[9]) + hx(b[10]) + hx(b[11]) + hx(b[12]) + hx(b[13]) + hx(b[14]) + hx(b[15]);
  }

  /**
   * 解析一条 UUID，把全部事实列出来。
   *
   * @param {string} raw
   * @returns {object} 非法时是 {ok: false, input, reason}；
   *                   合法时是 {ok: true, canonical, hex, version, variant, …}
   */
  function analyzeUuid(raw) {
    var input = String(raw == null ? '' : raw);
    var parsed = parseUuidString(input);
    if (!parsed.ok) return { ok: false, input: input, reason: parsed.reason };

    var hex = parsed.hex;
    var b = [];
    for (var i = 0; i < 16; i++) b.push(parseInt(hex.substr(i * 2, 2), 16));

    var res = {
      ok: true,
      input: input,
      canonical: parsed.canonical,
      hex: hex,
      hexUpper: hex.toUpperCase(),
      hexLower: hex,
      version: b[6] >> 4,
      isNil: hex === '00000000000000000000000000000000',
      isMax: hex === 'ffffffffffffffffffffffffffffffff',
      variant: detectVariant(b[8]),
      clockSeq: null,
      node: null,
      nodeIsRandom: null,
      unixMs: null,
      timestampIso: null,
      randA: null,
      guid: toMicrosoftGuid(b)
    };

    // v1 / v6 才有时钟序列与节点（RFC 4122 §4.1.1）：
    // 时钟序列是 14 位，占 octet 8 的低 6 位加 octet 9 的全部 8 位；
    // 节点是 48 位，占最后 6 个字节。
    if (res.version === 1 || res.version === 6) {
      res.clockSeq = ((b[8] & 0x3f) << 8) | b[9];
      res.node = hex.slice(20, 32);
      // 多播位（节点首字节的最低位）：真 MAC 是 0，随机节点是 1
      res.nodeIsRandom = (b[10] & 0x01) === 1;
    }

    if (res.version === 1) {
      // time_low(32) | time_mid(16) | time_hi(12)，时间戳 = time_hi<<48 | time_mid<<32 | time_low
      var timeLow = parseInt(hex.slice(0, 8), 16);
      var timeMid = parseInt(hex.slice(8, 12), 16);
      var timeHi = parseInt(hex.slice(13, 16), 16);
      // 高 28 位 = time_hi(12) << 16 | time_mid(16)，低 32 位 = time_low
      res.unixMs = ticksToUnixMs(timeHi * 65536 + timeMid, timeLow);
    } else if (res.version === 6) {
      // v6 只是把 v1 的 60 位时间戳重排成高位在前：
      // time_high(32) | time_mid(16) | time_low(12)，时间戳 = time_high<<28 | time_mid<<12 | time_low
      var timeHigh = parseInt(hex.slice(0, 8), 16);
      var v6Mid = parseInt(hex.slice(8, 12), 16);
      var v6Low = parseInt(hex.slice(13, 16), 16);
      // 拆成 (28 位, 32 位)：hi = time_high >> 4，
      // lo = (time_high & 0xf) << 28 | time_mid << 12 | time_low
      res.unixMs = ticksToUnixMs(
        Math.floor(timeHigh / 16),
        (timeHigh % 16) * 268435456 + v6Mid * 4096 + v6Low
      );
    } else if (res.version === 7) {
      // v7：前 48 位就是 Unix 毫秒时间戳，接着 12 位是亚毫秒随机数（rand_a）
      res.unixMs = parseInt(hex.slice(0, 12), 16);
      res.randA = parseInt(hex.slice(13, 16), 16);
    }

    if (res.unixMs !== null) res.timestampIso = formatUnixMs(res.unixMs);
    return res;
  }

  /**
   * 逐行解析。空行忽略，其余每一行单独给一个结果（合法的、非法的不混在一起）。
   *
   * @param {string} text
   * @returns {object[]} 每项带 line（原文行号，1 起）
   */
  function parseMany(text) {
    var lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim().length) continue;
      var res = analyzeUuid(lines[i]);
      res.line = i + 1;
      out.push(res);
    }
    return out;
  }

  /* ---------- 文案 ---------- */

  /** 变体名。 */
  function variantText(variant) {
    switch (variant) {
      case 'ncs': return t('d_variant_ncs', 'NCS (reserved)');
      case 'rfc4122': return t('d_variant_rfc4122', 'RFC 4122');
      case 'microsoft': return t('d_variant_microsoft', 'Microsoft');
      default: return t('d_variant_future', 'Reserved for future use');
    }
  }

  /** 版本的一句话说明。nil / max 另有专门的标注，不走这里。 */
  function versionDetails(res) {
    switch (res.version) {
      case 1: return t('d_v1', 'Time-based');
      case 2: return t('d_v2', 'DCE Security — the timestamp is not a standard UUID timestamp and is not supported');
      case 3: return t('d_v3', 'Name-based (MD5) — the namespace and the hashed name cannot be recovered from the UUID');
      case 4: return t('d_v4', 'Random — the UUID carries no timestamp');
      case 5: return t('d_v5', 'Name-based (SHA-1) — the namespace and the hashed name cannot be recovered from the UUID');
      case 6: return t('d_v6', 'Reordered time-based — the same fields as v1, with the 60-bit timestamp rearranged');
      case 7: return t('d_v7', 'Unix epoch time-based — the first 48 bits are a Unix millisecond timestamp');
      case 8: return t('d_v8', 'Custom — the layout is defined by the application');
      default:
        return t('d_unknown_version', 'Unknown version ({n})')
          .replace('{n}', function () { return String(res.version); });
    }
  }

  /** 解析失败的原因。 */
  function reasonText(reason) {
    switch (reason) {
      case 'length': return t('err_length', 'wrong length: a UUID has 32 hexadecimal digits (36 characters with hyphens)');
      case 'charset': return t('err_charset', 'invalid characters: only hexadecimal digits (0-9, a-f) are allowed');
      case 'hyphens': return t('err_hyphens', 'wrong hyphenation: the hyphens must be at positions 8, 13, 18 and 23');
      default: return t('err_unknown', 'not a valid UUID');
    }
  }

  /**
   * 把解析结果整理成 [标签, 值] 的行列表。
   * 界面表格与纯文本导出共用这一份，免得两处各写一遍、日后改文案漏掉一处。
   *
   * @param {object} res analyzeUuid 的结果
   * @returns {Array<[string, string]>}
   */
  function describeUuid(res) {
    var rows = [];
    rows.push([t('f_canonical', 'Canonical form'), res.canonical]);
    rows.push([t('f_hex_upper', 'HEX notation (uppercase)'), res.hexUpper]);
    rows.push([t('f_hex_lower', 'HEX notation (lowercase)'), res.hexLower]);
    rows.push([t('f_version', 'RFC version'),
      res.isNil ? t('d_nil', 'Nil UUID (all zeros)')
        : res.isMax ? t('d_max', 'Max UUID (all ones)')
          : String(res.version)]);
    if (!res.isNil && !res.isMax) {
      rows.push([t('f_version_details', 'Version details'), versionDetails(res)]);
    }
    rows.push([t('f_variant', 'Variant'), variantText(res.variant)]);
    if (res.unixMs !== null) {
      rows.push([t('f_timestamp', 'Timestamp (UTC)'), res.timestampIso]);
    }
    if (res.clockSeq !== null) {
      rows.push([t('f_clock_seq', 'Clock sequence'), res.clockSeq + ' (0x' + padHex(res.clockSeq, 4) + ')']);
    }
    if (res.node !== null) {
      rows.push([t('f_node', 'Node identifier'), res.node]);
      rows.push([t('f_node_kind', 'Node type'),
        res.nodeIsRandom ? t('d_node_random', 'Randomly assigned (the multicast bit is set)')
          : t('d_node_mac', 'Real MAC address (the multicast bit is clear)')]);
    }
    if (res.randA !== null) {
      rows.push([t('f_rand_a', 'Sub-millisecond fraction (rand_a)'), res.randA + ' (0x' + padHex(res.randA, 3) + ')']);
    }
    rows.push([t('f_guid', 'Microsoft GUID'), res.guid]);
    return rows;
  }

  /* ---------- UI ---------- */

  window.ItTools.register('uuid-parser', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 6, spellcheck: 'false',
      placeholder: t('input_ph', 'One UUID per line')
    });
    var output = D.h('div', { style: { maxHeight: '460px', overflow: 'auto' } });
    var summary = D.h('p.form-status');
    var lastResults = [];

    /** 一条结果的 DOM：一段标题 + 一张键值表；非法行则是一行红字。 */
    function resultNode(res) {
      if (!res.ok) {
        return D.h('p.field-hint', {
          style: { color: 'var(--danger, #d03050)' },
          text: t('invalid_line', 'Line {line}: {reason}')
            .replace('{line}', function () { return String(res.line); })
            .replace('{reason}', function () { return reasonText(res.reason); })
        });
      }
      var tbody = D.h('tbody');
      describeUuid(res).forEach(function (row) {
        tbody.appendChild(D.h('tr', null,
          D.h('th', { text: row[0] }),
          D.h('td.val', { text: row[1] })
        ));
      });
      return D.h('div', { style: { marginBottom: '18px' } },
        D.h('div', { style: { fontWeight: '600', marginBottom: '6px' }, text: res.canonical }),
        D.h('table.kv-table', null, tbody)
      );
    }

    /** 纯文本导出：跟界面表格用同一份行数据。 */
    function resultsText() {
      var out = [];
      lastResults.forEach(function (res) {
        if (!res.ok) {
          out.push(t('invalid_line', 'Line {line}: {reason}')
            .replace('{line}', function () { return String(res.line); })
            .replace('{reason}', function () { return reasonText(res.reason); }));
          return;
        }
        out.push(res.canonical);
        describeUuid(res).forEach(function (row) {
          out.push('  ' + row[0] + ': ' + row[1]);
        });
        out.push('');
      });
      return out.join('\n');
    }

    function render() {
      lastResults = parseMany(input.value);
      D.clear(output);

      if (!lastResults.length) {
        summary.textContent = '';
        output.appendChild(D.h('p.field-hint', { text: t('empty', 'Nothing to parse yet.') }));
        return;
      }

      var bad = 0;
      lastResults.forEach(function (res) { if (!res.ok) bad++; });
      summary.textContent = t('summary', '{ok} valid, {bad} invalid')
        .replace('{ok}', function () { return String(lastResults.length - bad); })
        .replace('{bad}', function () { return String(bad); });

      lastResults.forEach(function (res) { output.appendChild(resultNode(res)); });
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input_label', 'UUIDs to parse'), input, {
        wide: true,
        hint: t('input_hint', 'Accepted: 8-4-4-4-12 with hyphens, uppercase, 32 hex digits without hyphens, the value wrapped in curly braces, and the urn:uuid: prefix. Empty lines are ignored.')
      }),
      D.h('div.form-actions', null,
        U.copyButton(function () { return resultsText(); }, t('copy', 'Copy result')),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('parse', 'Parse'), onclick: render
        }),
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('clear', 'Clear'), onclick: function () { input.value = ''; render(); }
        })
      )
    ));

    root.appendChild(D.h('div.card', null,
      D.h('h3.section-head', { text: t('results', 'Parsed UUIDs') }),
      summary,
      output
    ));

    render();

    return {
      destroy: function () {
        off();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['uuid-parser'] = {
    GREGORIAN_OFFSET_MS: GREGORIAN_OFFSET_MS,
    stripDecorations: stripDecorations,
    parseUuidString: parseUuidString,
    normalizeUuid: normalizeUuid,
    detectVariant: detectVariant,
    ticksToUnixMs: ticksToUnixMs,
    formatUnixMs: formatUnixMs,
    toMicrosoftGuid: toMicrosoftGuid,
    analyzeUuid: analyzeUuid,
    parseMany: parseMany,
    describeUuid: describeUuid,
    __cases: function (assert) {
      /* ================= 写法归一 ================= */

      var STD = '005056a3-e753-1eee-97a1-e5eb141bb52c';

      assert.eq(normalizeUuid(STD), STD, '标准写法');
      assert.eq(normalizeUuid('005056A3-E753-1EEE-97A1-E5EB141BB52C'), STD, '大写写法解出同一个规范形式');
      assert.eq(normalizeUuid('005056a3e7531eee97a1e5eb141bb52c'), STD, '紧凑 32 位写法');
      assert.eq(normalizeUuid('{005056a3-e753-1eee-97a1-e5eb141bb52c}'), STD, '花括号写法');
      assert.eq(normalizeUuid('urn:uuid:005056a3-e753-1eee-97a1-e5eb141bb52c'), STD, 'urn:uuid: 前缀');
      assert.eq(normalizeUuid('URN:UUID:005056a3-e753-1eee-97a1-e5eb141bb52c'), STD, 'urn:uuid: 前缀不分大小写');
      assert.eq(normalizeUuid('  ' + STD + '  '), STD, '首尾空白先 trim');
      assert.eq(normalizeUuid('{urn:uuid:005056a3e7531eee97a1e5eb141bb52c}'), STD, '花括号里套紧凑写法');
      assert.eq(normalizeUuid(STD.toUpperCase().replace(/-/g, '')), STD, '大写紧凑写法');

      // 非法写法：给的是原因类别，不是抛异常
      assert.eq(parseUuidString('005056a3-e753-1eee-97a1-e5eb141bb52x').reason, 'charset', '末位不是十六进制');
      assert.eq(parseUuidString('005056a3-e753-1eee-97a1-e5eb141bb52').reason, 'length', '长度不对');
      assert.eq(parseUuidString('005056a3-e753-1ee-e97a1-e5eb141bb52c').reason, 'hyphens', '连字符位置不对');
      assert.eq(parseUuidString('').reason, 'length', '空串');
      assert.eq(parseUuidString('   ').reason, 'length', '纯空白');
      assert.eq(parseUuidString('not-a-uuid').reason, 'charset', '完全不是 UUID');
      assert.eq(parseUuidString(null).reason, 'length', 'null');
      assert.eq(parseUuidString(undefined).reason, 'length', 'undefined');
      assert.eq(normalizeUuid('005056a3-e753-1eee-97a1-e5eb141bb52x'), null, '非法写法返回 null');
      // 解析非法输入不抛异常 —— 这是工具能一行一行往下走的前提
      var threw = false;
      try { analyzeUuid('nonsense'); } catch (e) { threw = true; }
      assert(!threw, '非法输入不抛异常');

      /* ================= 变体 ================= */

      assert.eq(detectVariant(0x00), 'ncs', '0b0xx → NCS');
      assert.eq(detectVariant(0x7f), 'ncs', '0b0xx 的上界仍是 NCS');
      assert.eq(detectVariant(0x80), 'rfc4122', '0b10x → RFC 4122');
      assert.eq(detectVariant(0xbf), 'rfc4122', '0b10x 的上界仍是 RFC 4122');
      assert.eq(detectVariant(0xc0), 'microsoft', '0b110 → Microsoft');
      assert.eq(detectVariant(0xdf), 'microsoft', '0b110 的上界仍是 Microsoft');
      assert.eq(detectVariant(0xe0), 'future', '0b111 → 保留给将来');
      assert.eq(detectVariant(0xff), 'future', '0b111 的上界仍是保留');

      assert.eq(analyzeUuid('00000000-0000-1000-0000-000000000000').variant, 'ncs', '整条 UUID 的变体（octet 8 = 0x00）');
      assert.eq(analyzeUuid('00000000-0000-1000-8000-000000000000').variant, 'rfc4122', '整条 UUID 的变体（octet 8 = 0x80）');
      assert.eq(analyzeUuid('00000000-0000-1000-c000-000000000000').variant, 'microsoft', '整条 UUID 的变体（octet 8 = 0xc0）');
      assert.eq(analyzeUuid('00000000-0000-1000-e000-000000000000').variant, 'future', '整条 UUID 的变体（octet 8 = 0xe0）');

      /* ================= 版本 / nil / max ================= */

      assert.eq(analyzeUuid(STD).version, 1, 'v1');
      assert.eq(analyzeUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8').version, 1, 'v1（DNS 命名空间）');
      assert.eq(analyzeUuid('f81d4fae-7dec-11d0-a765-00a0c91e6bf6').version, 1, 'v1（另一个向量）');
      assert.eq(analyzeUuid('550e8400-e29b-41d4-a716-446655440000').version, 4, 'v4');
      assert.eq(analyzeUuid('00000000-0000-0000-0000-000000000000').isNil, true, 'nil UUID');
      assert.eq(analyzeUuid('00000000-0000-0000-0000-000000000000').version, 0, 'nil 的版本位是 0');
      assert.eq(analyzeUuid('ffffffff-ffff-ffff-ffff-ffffffffffff').isMax, true, 'max UUID');
      assert.eq(analyzeUuid('ffffffff-ffff-ffff-ffff-ffffffffffff').version, 15, 'max 的版本位是 f');
      assert.eq(analyzeUuid(STD).isNil, false, '普通 UUID 不是 nil');
      assert.eq(analyzeUuid(STD).isMax, false, '普通 UUID 不是 max');
      assert.eq(analyzeUuid('00000000-0000-1000-8000-000000000000').version, 1, '版本位是 hex[12] 的高 4 位');

      /* ================= v1 的字段 ================= */

      var r1 = analyzeUuid(STD);
      assert.eq(r1.canonical, STD, 'v1 的规范形式');
      assert.eq(r1.hexUpper, '005056A3E7531EEE97A1E5EB141BB52C', 'v1 的 HEX 大写');
      assert.eq(r1.hexLower, '005056a3e7531eee97a1e5eb141bb52c', 'v1 的 HEX 小写');
      assert.eq(r1.clockSeq, 6049, 'v1 的时钟序列（14 位）');
      assert.eq(r1.node, 'e5eb141bb52c', 'v1 的节点');
      assert.eq(r1.nodeIsRandom, true, 'v1 的节点多播位是 1 → 随机生成');
      assert.eq(r1.unixMs, 95385877666169, 'v1 的时间戳（Unix 毫秒）');
      assert.eq(r1.timestampIso, '4992-08-28T05:07:46.169Z', 'v1 的时间戳（ISO-8601 UTC）');

      var dns = analyzeUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
      assert.eq(dns.clockSeq, 180, 'DNS 命名空间那条的时钟序列');
      assert.eq(dns.node, '00c04fd430c8', 'DNS 命名空间那条的节点');
      assert.eq(dns.nodeIsRandom, false, 'DNS 命名空间那条的节点多播位是 0 → 真 MAC');
      assert.eq(dns.unixMs, 886630433151, 'DNS 命名空间那条的时间戳');
      assert.eq(dns.timestampIso, '1998-02-04T22:13:53.151Z', 'DNS 命名空间那条的时间戳（ISO-8601 UTC）');

      var third = analyzeUuid('f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
      assert.eq(third.clockSeq, 10085, '第三条 v1 的时钟序列');
      assert.eq(third.node, '00a0c91e6bf6', '第三条 v1 的节点');
      assert.eq(third.unixMs, 854991792216, '第三条 v1 的时间戳');

      /* ================= v4 ================= */

      var r4 = analyzeUuid('550e8400-e29b-41d4-a716-446655440000');
      assert.eq(r4.variant, 'rfc4122', 'v4 的变体');
      assert.eq(r4.unixMs, null, 'v4 没有时间戳');
      assert.eq(r4.clockSeq, null, 'v4 没有时钟序列');
      assert.eq(r4.node, null, 'v4 没有节点');
      assert.eq(r4.randA, null, 'v4 没有 rand_a');

      /* ================= v6 ================= */

      // 60 位时间戳被重排成 time_high(32) | time_mid(16) | time_low(12)
      // 这条正是本站 uuid-generator 在 ms=1700000000123 时生成的 v6
      var v6 = '1ee833b0-4c29-6ade-9234-0123456789ab';
      var r6 = analyzeUuid(v6);
      assert.eq(r6.version, 6, 'v6 的版本位');
      assert.eq(r6.variant, 'rfc4122', 'v6 的变体');
      assert.eq(r6.clockSeq, 0x1234, 'v6 的时钟序列与 v1 同位置');
      assert.eq(r6.node, '0123456789ab', 'v6 的节点');
      assert.eq(r6.nodeIsRandom, true, 'v6 的节点多播位');
      assert.eq(r6.unixMs, 1700000000123, 'v6 的时间戳');
      assert.eq(r6.timestampIso, '2023-11-14T22:13:20.123Z', 'v6 的时间戳（ISO-8601 UTC）');

      /* ================= v7 ================= */

      // 前 48 位是 Unix 毫秒，version = 7，variant = 0b10
      var v7 = '018bcfe5-687b-7abc-8000-0123456789ab';
      var r7 = analyzeUuid(v7);
      assert.eq(r7.version, 7, 'v7 的版本位');
      assert.eq(r7.variant, 'rfc4122', 'v7 的变体');
      assert.eq(r7.unixMs, 1700000000123, 'v7 的时间戳就是前 48 位');
      assert.eq(r7.timestampIso, '2023-11-14T22:13:20.123Z', 'v7 的时间戳（ISO-8601 UTC）');
      assert.eq(r7.randA, 0xabc, 'v7 的亚毫秒随机数 rand_a');
      assert.eq(r7.clockSeq, null, 'v7 没有时钟序列');
      assert.eq(r7.node, null, 'v7 没有节点');

      // 自己造一条 v7：放进去的毫秒要原样解出来
      var planted = 1234567890123;
      var plantedHex = planted.toString(16);
      while (plantedHex.length < 12) plantedHex = '0' + plantedHex;
      var made = plantedHex.slice(0, 8) + '-' + plantedHex.slice(8, 12) + '-7000-8000-000000000000';
      assert.eq(analyzeUuid(made).unixMs, planted, '自己造的 v7 解出原来的毫秒');

      /* ================= 独立复算时间戳（BigInt） =================
         上面的时间戳是被测函数自己算的，这里用**另一套写法**重算一遍：
       直接按 RFC 的位布局手算 BigInt，再对拍。 */

      function refV1Ticks(h) {
        var tl = BigInt('0x' + h.slice(0, 8));
        var tm = BigInt('0x' + h.slice(8, 12));
        var th = BigInt('0x' + h.slice(13, 16));
        return (th << 48n) | (tm << 32n) | tl;
      }
      function refV6Ticks(h) {
        var a = BigInt('0x' + h.slice(0, 8));
        var b = BigInt('0x' + h.slice(8, 12));
        var c = BigInt('0x' + h.slice(13, 16));
        return (a << 28n) | (b << 12n) | c;
      }
      function refUnixMs(ticks) {
        return Number(ticks / 10000n - BigInt(GREGORIAN_OFFSET_MS));
      }

      var v1hex = STD.replace(/-/g, '');
      assert.eq(r1.unixMs, refUnixMs(refV1Ticks(v1hex)), 'v1 时间戳：与 BigInt 手算对拍');
      assert.eq(dns.unixMs, refUnixMs(refV1Ticks('6ba7b8109dad11d180b400c04fd430c8')), 'v1 时间戳：DNS 那条也对拍');
      assert.eq(third.unixMs, refUnixMs(refV1Ticks('f81d4fae7dec11d0a76500a0c91e6bf6')), 'v1 时间戳：第三条也对拍');
      assert.eq(r6.unixMs, refUnixMs(refV6Ticks('1ee833b04c296ade92340123456789ab')), 'v6 时间戳：与 BigInt 手算对拍');
      assert.eq(r7.unixMs, Number(BigInt('0x' + '018bcfe5687b')), 'v7 时间戳：与 BigInt 手算对拍');

      // ticksToUnixMs 本身也对拍一次（用两个极端值）
      assert.eq(ticksToUnixMs(0, 0), -GREGORIAN_OFFSET_MS, '零时间戳 = 1582 纪元');
      assert.eq(ticksToUnixMs(0, 10000), 0 - GREGORIAN_OFFSET_MS + 1, '10000 个 100 纳秒 = 1 毫秒');
      assert.eq(ticksToUnixMs((1 << 28) - 1, 0xffffffff), refUnixMs((((BigInt(1) << 28n) - 1n) << 32n) | 0xffffffffn),
        'ticksToUnixMs 的上界也与 BigInt 对拍');

      /* ================= ISO-8601 格式化 ================= */

      assert.eq(formatUnixMs(0), '1970-01-01T00:00:00.000Z', 'Unix 纪元');
      assert.eq(formatUnixMs(1700000000123), '2023-11-14T22:13:20.123Z', '一个普通的时刻');
      assert.eq(formatUnixMs(-1), '1969-12-31T23:59:59.999Z', '纪元前一毫秒');
      assert.eq(formatUnixMs(951782400000), '2000-02-29T00:00:00.000Z', '闰日');
      // 跟 Date.toISOString() 对拍：两者必须一致
      [0, 1, 1000, 1700000000123, 886630433151, 854991792216, 95385877666169, -1, -86400000].forEach(function (m) {
        assert.eq(formatUnixMs(m), new Date(m).toISOString(), '与 toISOString 一致：' + m);
      });

      /* ================= Microsoft GUID ================= */

      assert.eq(analyzeUuid(STD).guid, 'a3565000-53e7-ee1e-97a1e5eb141bb52c', 'Microsoft GUID：前三个八位组小端重排');
      assert.eq(analyzeUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8').guid, '10b8a76b-ad9d-d111-80b400c04fd430c8', 'Microsoft GUID：DNS 那条');
      assert.eq(analyzeUuid('550e8400-e29b-41d4-a716-446655440000').guid, '00840e55-9be2-d441-a716446655440000', 'Microsoft GUID：v4');
      assert.eq(analyzeUuid('00000000-0000-0000-0000-000000000000').guid, '00000000-0000-0000-0000000000000000', 'Microsoft GUID：nil');
      assert.eq(analyzeUuid('ffffffff-ffff-ffff-ffff-ffffffffffff').guid, 'ffffffff-ffff-ffff-ffffffffffffffff', 'Microsoft GUID：max');
      // 后 8 个字节不重排
      assert(analyzeUuid(STD).guid.indexOf('97a1e5eb141bb52c') > 0, 'GUID 的后 8 个字节原样保留');

      /* ================= 界面行的取值 ================= */

      // 界面与纯文本导出共用 describeUuid 的行数据；这里按标签取值，
      // 免得改字段顺序就把断言改坏。
      function rowValue(res, label) {
        var rows = describeUuid(res);
        for (var i = 0; i < rows.length; i++) if (rows[i][0] === label) return rows[i][1];
        return null;
      }
      assert.eq(rowValue(r1, 'Clock sequence'), '6049 (0x17a1)', '时钟序列同时给十进制与十六进制');
      assert.eq(rowValue(dns, 'Clock sequence'), '180 (0x00b4)', '时钟序列的十六进制要补齐 4 位');
      assert.eq(rowValue(r7, 'Sub-millisecond fraction (rand_a)'), '2748 (0xabc)', 'rand_a 同时给十进制与十六进制');
      assert.eq(rowValue(r1, 'Node type'), 'Randomly assigned (the multicast bit is set)', '节点类型：多播位为 1');
      assert.eq(rowValue(dns, 'Node type'), 'Real MAC address (the multicast bit is clear)', '节点类型：多播位为 0');
      assert.eq(rowValue(r1, 'Variant'), 'RFC 4122', '变体名');
      assert.eq(rowValue(r1, 'Timestamp (UTC)'), '4992-08-28T05:07:46.169Z', '时间戳');
      assert.eq(rowValue(analyzeUuid('00000000-0000-0000-0000-000000000000'), 'RFC version'),
        'Nil UUID (all zeros)', 'nil 单独标注');
      assert.eq(rowValue(analyzeUuid('ffffffff-ffff-ffff-ffff-ffffffffffff'), 'RFC version'),
        'Max UUID (all ones)', 'max 单独标注');
      assert.eq(rowValue(r1, 'Microsoft GUID'), 'a3565000-53e7-ee1e-97a1e5eb141bb52c', 'GUID 行');
      assert.eq(rowValue(r4, 'Timestamp (UTC)'), null, 'v4 没有时间戳行');
      assert.eq(rowValue(r7, 'Node identifier'), null, 'v7 没有节点行');

      /* ================= 多行输入 ================= */

      var many = parseMany(['', STD, '   ', '550e8400-e29b-41d4-a716-446655440000', 'not-a-uuid', ''].join('\n'));
      assert.eq(many.length, 3, '空行被忽略');
      assert.eq(many[0].line, 2, '行号是原文行号');
      assert.eq(many[1].line, 4, '行号是原文行号');
      assert.eq(many[2].line, 5, '非法那行也带行号');
      assert.eq(many[0].ok, true, '第一条合法');
      assert.eq(many[1].ok, true, '第二条合法');
      assert.eq(many[2].ok, false, '第三条非法');
      assert.eq(many[2].reason, 'charset', '非法那行给的是原因类别');
      assert.eq(parseMany('').length, 0, '空输入没有结果');
      assert.eq(parseMany('\n\n\n').length, 0, '只有空行也没有结果');
      // \r\n 也要按行切开
      assert.eq(parseMany(STD + '\r\n' + '550e8400-e29b-41d4-a716-446655440000').length, 2, 'CRLF 也按行切开');

      /* ================= 同一 UUID 的五种写法 ================= */

      var forms = [
        STD,
        '005056A3-E753-1EEE-97A1-E5EB141BB52C',
        '005056a3e7531eee97a1e5eb141bb52c',
        '{005056a3-e753-1eee-97a1-e5eb141bb52c}',
        'urn:uuid:005056a3-e753-1eee-97a1-e5eb141bb52c'
      ];
      var canon = forms.map(function (f) { return analyzeUuid(f).canonical; });
      assert.eq(canon.join('|'), canon[0] + '|' + canon[0] + '|' + canon[0] + '|' + canon[0] + '|' + canon[0],
        '五种写法的规范形式完全一致');
      var stamps = forms.map(function (f) { return analyzeUuid(f).unixMs; });
      assert.eq(stamps.join('|'), stamps[0] + '|' + stamps[0] + '|' + stamps[0] + '|' + stamps[0] + '|' + stamps[0],
        '五种写法解出的时间戳完全一致');
    }
  };
})();
