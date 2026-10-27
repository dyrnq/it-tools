/* ==========================================================================
   HTTP 状态码查询（http-status-codes）

   内置 1xx~5xx 全量状态码表，按类别分组，支持搜索。
   搜索权重对齐参考实现给 Fuse 的配置：code ×3 > name ×2 > description / category。

   参考实现：src/tools/http-status-codes/（it-tools, GPLv3）
   与原版的差别：
   1. 原版用 fuse.js 做模糊匹配，这里换成一个确定性的加权子串打分
      （不引外部库，且同样的输入永远得到同样的排序，方便写单测）。
   2. 搜纯数字时优先按码精确匹配 —— 这是这个工具最常见的用法。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('http-status-codes');

  var CODES_BY_CATEGORIES = [
    {
      category: '1xx informational response',
      codes: [
        { code: 100, name: 'Continue', description: 'Waiting for the client to emit the body of the request.', type: 'HTTP' },
        { code: 101, name: 'Switching Protocols', description: 'The server has agreed to change protocol.', type: 'HTTP' },
        { code: 102, name: 'Processing', description: 'The server is processing the request, but no response is available yet.', type: 'WebDav' },
        { code: 103, name: 'Early Hints', description: 'The server returns some response headers before final HTTP message.', type: 'HTTP' }
      ]
    },
    {
      category: '2xx success',
      codes: [
        { code: 200, name: 'OK', description: 'Standard response for successful HTTP requests.', type: 'HTTP' },
        { code: 201, name: 'Created', description: 'The request has been fulfilled, resulting in the creation of a new resource.', type: 'HTTP' },
        { code: 202, name: 'Accepted', description: 'The request has been accepted for processing, but the processing has not been completed.', type: 'HTTP' },
        { code: 203, name: 'Non-Authoritative Information', description: 'The request is successful but the content of the original request has been modified by a transforming proxy.', type: 'HTTP' },
        { code: 204, name: 'No Content', description: 'The server successfully processed the request and is not returning any content.', type: 'HTTP' },
        { code: 205, name: 'Reset Content', description: 'The server indicates to reinitialize the document view which sent this request.', type: 'HTTP' },
        { code: 206, name: 'Partial Content', description: 'The server is delivering only part of the resource due to a range header sent by the client.', type: 'HTTP' },
        { code: 207, name: 'Multi-Status', description: 'The message body that follows is an XML message and can contain a number of separate response codes.', type: 'WebDav' },
        { code: 208, name: 'Already Reported', description: 'The members of a DAV binding have already been enumerated in a preceding part of the (multistatus) response.', type: 'WebDav' },
        { code: 226, name: 'IM Used', description: 'The server has fulfilled a request for the resource, and the response is a representation of the result.', type: 'HTTP' }
      ]
    },
    {
      category: '3xx redirection',
      codes: [
        { code: 300, name: 'Multiple Choices', description: 'Indicates multiple options for the resource that the client may follow.', type: 'HTTP' },
        { code: 301, name: 'Moved Permanently', description: 'This and all future requests should be directed to the given URI.', type: 'HTTP' },
        { code: 302, name: 'Found', description: 'Redirect to another URL. This is an example of industry practice contradicting the standard.', type: 'HTTP' },
        { code: 303, name: 'See Other', description: 'The response to the request can be found under another URI using a GET method.', type: 'HTTP' },
        { code: 304, name: 'Not Modified', description: 'Indicates that the resource has not been modified since the version specified by the request headers.', type: 'HTTP' },
        { code: 305, name: 'Use Proxy', description: 'The requested resource is available only through a proxy, the address for which is provided in the response.', type: 'HTTP' },
        { code: 306, name: 'Switch Proxy', description: 'No longer used. Originally meant "Subsequent requests should use the specified proxy."', type: 'HTTP' },
        { code: 307, name: 'Temporary Redirect', description: 'In this case, the request should be repeated with another URI; however, future requests should still use the original URI.', type: 'HTTP' },
        { code: 308, name: 'Permanent Redirect', description: 'The request and all future requests should be repeated using another URI.', type: 'HTTP' }
      ]
    },
    {
      category: '4xx client error',
      codes: [
        { code: 400, name: 'Bad Request', description: 'The server cannot or will not process the request due to an apparent client error.', type: 'HTTP' },
        { code: 401, name: 'Unauthorized', description: 'Similar to 403 Forbidden, but specifically for use when authentication is required and has failed or has not yet been provided.', type: 'HTTP' },
        { code: 402, name: 'Payment Required', description: 'Reserved for future use. The original intention was that this code might be used as part of some form of digital cash or micropayment scheme.', type: 'HTTP' },
        { code: 403, name: 'Forbidden', description: 'The request was valid, but the server is refusing action. The user might not have the necessary permissions for a resource.', type: 'HTTP' },
        { code: 404, name: 'Not Found', description: 'The requested resource could not be found but may be available in the future.', type: 'HTTP' },
        { code: 405, name: 'Method Not Allowed', description: 'A request method is not supported for the requested resource.', type: 'HTTP' },
        { code: 406, name: 'Not Acceptable', description: 'The requested resource is capable of generating only content not acceptable according to the Accept headers sent in the request.', type: 'HTTP' },
        { code: 407, name: 'Proxy Authentication Required', description: 'The client must first authenticate itself with the proxy.', type: 'HTTP' },
        { code: 408, name: 'Request Timeout', description: 'The server timed out waiting for the request.', type: 'HTTP' },
        { code: 409, name: 'Conflict', description: 'Indicates that the request could not be processed because of conflict in the request, such as an edit conflict.', type: 'HTTP' },
        { code: 410, name: 'Gone', description: 'Indicates that the resource requested is no longer available and will not be available again.', type: 'HTTP' },
        { code: 411, name: 'Length Required', description: 'The request did not specify the length of its content, which is required by the requested resource.', type: 'HTTP' },
        { code: 412, name: 'Precondition Failed', description: 'The server does not meet one of the preconditions that the requester put on the request.', type: 'HTTP' },
        { code: 413, name: 'Payload Too Large', description: 'The request is larger than the server is willing or able to process.', type: 'HTTP' },
        { code: 414, name: 'URI Too Long', description: 'The URI provided was too long for the server to process.', type: 'HTTP' },
        { code: 415, name: 'Unsupported Media Type', description: 'The request entity has a media type which the server or resource does not support.', type: 'HTTP' },
        { code: 416, name: 'Range Not Satisfiable', description: 'The client has asked for a portion of the file, but the server cannot supply that portion.', type: 'HTTP' },
        { code: 417, name: 'Expectation Failed', description: 'The server cannot meet the requirements of the Expect request-header field.', type: 'HTTP' },
        { code: 418, name: "I'm a teapot", description: 'The server refuses the attempt to brew coffee with a teapot.', type: 'HTTP' },
        { code: 421, name: 'Misdirected Request', description: 'The request was directed at a server that is not able to produce a response.', type: 'HTTP' },
        { code: 422, name: 'Unprocessable Entity', description: 'The request was well-formed but was unable to be followed due to semantic errors.', type: 'HTTP' },
        { code: 423, name: 'Locked', description: 'The resource that is being accessed is locked.', type: 'HTTP' },
        { code: 424, name: 'Failed Dependency', description: 'The request failed due to failure of a previous request.', type: 'HTTP' },
        { code: 425, name: 'Too Early', description: 'Indicates that the server is unwilling to risk processing a request that might be replayed.', type: 'HTTP' },
        { code: 426, name: 'Upgrade Required', description: 'The client should switch to a different protocol such as TLS/1.0.', type: 'HTTP' },
        { code: 428, name: 'Precondition Required', description: 'The origin server requires the request to be conditional.', type: 'HTTP' },
        { code: 429, name: 'Too Many Requests', description: 'The user has sent too many requests in a given amount of time.', type: 'HTTP' },
        { code: 431, name: 'Request Header Fields Too Large', description: 'The server is unwilling to process the request because either an individual header field, or all the header fields collectively, are too large.', type: 'HTTP' },
        { code: 451, name: 'Unavailable For Legal Reasons', description: 'A server operator has received a legal demand to deny access to a resource or to a set of resources that includes the requested resource.', type: 'HTTP' }
      ]
    },
    {
      category: '5xx server error',
      codes: [
        { code: 500, name: 'Internal Server Error', description: 'A generic error message, given when an unexpected condition was encountered and no more specific message is suitable.', type: 'HTTP' },
        { code: 501, name: 'Not Implemented', description: 'The server either does not recognize the request method, or it lacks the ability to fulfill the request.', type: 'HTTP' },
        { code: 502, name: 'Bad Gateway', description: 'The server was acting as a gateway or proxy and received an invalid response from the upstream server.', type: 'HTTP' },
        { code: 503, name: 'Service Unavailable', description: 'The server is currently unavailable (because it is overloaded or down for maintenance).', type: 'HTTP' },
        { code: 504, name: 'Gateway Timeout', description: 'The server was acting as a gateway or proxy and did not receive a timely response from the upstream server.', type: 'HTTP' },
        { code: 505, name: 'HTTP Version Not Supported', description: 'The server does not support the HTTP protocol version used in the request.', type: 'HTTP' },
        { code: 506, name: 'Variant Also Negotiates', description: 'Transparent content negotiation for the request results in a circular reference.', type: 'HTTP' },
        { code: 507, name: 'Insufficient Storage', description: 'The server is unable to store the representation needed to complete the request.', type: 'HTTP' },
        { code: 508, name: 'Loop Detected', description: 'The server detected an infinite loop while processing the request.', type: 'HTTP' },
        { code: 510, name: 'Not Extended', description: 'Further extensions to the request are required for the server to fulfill it.', type: 'HTTP' },
        { code: 511, name: 'Network Authentication Required', description: 'The client needs to authenticate to gain network access.', type: 'HTTP' }
      ]
    }
  ];

  /**
   * 各类别的显示名。中文界面里用中文名，英文界面里用表里的原文。
   *
   * 键是**写死的字面量**而不是拼出来的 —— 语言包的对账单测要能逐条找到它们，
   * 拼出来的键对不上账（`src/i18n.rs` 的 `js_text` 那几个单测）。
   * 表里的 `category` 保持英文不动：搜索按它打分，断言也按它查。
   */
  var CATEGORY_LABELS = {
    '1xx informational response': t('cat_1xx', '1xx informational response'),
    '2xx success': t('cat_2xx', '2xx success'),
    '3xx redirection': t('cat_3xx', '3xx redirection'),
    '4xx client error': t('cat_4xx', '4xx client error'),
    '5xx server error': t('cat_5xx', '5xx server error'),
    'Search results': t('cat_search', 'Search results')
  };

  /** 类别的显示名；表里没有的类别原样返回。 */
  function categoryLabel(category) {
    return CATEGORY_LABELS[category] || category;
  }

  /** 打平后的全表，每条带上 category，供搜索用。 */
  var ALL_CODES = CODES_BY_CATEGORIES.reduce(function (acc, group) {
    group.codes.forEach(function (c) {
      acc.push({
        code: c.code,
        name: c.name,
        description: c.description,
        type: c.type,
        category: group.category
      });
    });
    return acc;
  }, []);

  /** 按状态码精确查一条。 */
  function byCode(code) {
    var n = Number(code);
    for (var i = 0; i < ALL_CODES.length; i++) {
      if (ALL_CODES[i].code === n) return ALL_CODES[i];
    }
    return undefined;
  }

  /**
   * 加权子串打分：字段权重 code=3 / name=2 / description=1 / category=1，
   * 命中位置越靠前分越高，完全相等再给一大笔。
   * 返回 0 表示不匹配。
   */
  function scoreOf(entry, needle) {
    var score = 0;
    var fields = [
      { value: String(entry.code), weight: 3 },
      { value: entry.name, weight: 2 },
      { value: entry.description, weight: 1 },
      { value: entry.category, weight: 1 }
    ];
    for (var i = 0; i < fields.length; i++) {
      var hay = fields[i].value.toLowerCase();
      var idx = hay.indexOf(needle);
      if (idx === -1) continue;
      // 越靠前越值钱：第一个命中拿满权重，后面每往后 8 位扣 1 分
      score += fields[i].weight * (1 - idx / (hay.length + 8));
      if (idx === 0 && hay === needle) score += fields[i].weight * 2;
    }
    return score;
  }

  /**
   * 搜索状态码。空查询返回全部；纯数字优先精确匹配码。
   * @returns {Array} 命中项，按分数降序（并列时按码升序，保证结果稳定）
   */
  function search(query) {
    var q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q.length) return ALL_CODES.slice();

    // 纯数字：先给精确匹配的码，再补上其它数字命中
    if (/^\d+$/.test(q)) {
      var exact = byCode(parseInt(q, 10));
      if (exact) return [exact].concat(ALL_CODES.filter(function (c) {
        return c.code !== exact.code && scoreOf(c, q) > 0;
      }));
    }

    return ALL_CODES
      .map(function (c, i) { return { entry: c, index: i, score: scoreOf(c, q) }; })
      .filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return (b.score - a.score) || (a.index - b.index); })
      .map(function (r) { return r.entry; });
  }

  /** 按类别分组输出；无查询时保持原表结构，有查询时归到一个「Search results」组。 */
  function grouped(query) {
    if (!String(query == null ? '' : query).trim()) return CODES_BY_CATEGORIES;
    return [{ category: 'Search results', codes: search(query) }];
  }

  window.ItTools.register('http-status-codes', function (root) {
    var input = D.h('input.layui-input', { type: 'text', placeholder: t('search', 'Search http status...') });
    var output = D.h('div');
    var status = D.h('p.field-hint');

    function render() {
      var query = input.value;
      D.clear(output);
      var groups = grouped(query);
      var total = groups.reduce(function (n, g) { return n + g.codes.length; }, 0);
      status.textContent = query.trim()
        ? t('found_n', 'Found {n} items').replace('{n}', total)
        : t('total_n', 'Total {n} status codes').replace('{n}', total);
      status.classList.remove('is-error');

      groups.forEach(function (group) {
        output.appendChild(D.h('h3', { text: t('group_heading', '{category}（{count}）')
          .replace('{category}', categoryLabel(group.category))
          .replace('{count}', group.codes.length) }));
        var table = D.h('table.kv-table');
        var tbody = D.h('tbody');
        group.codes.forEach(function (c) {
          tbody.appendChild(D.h('tr', null,
            // 状态码是三位数，不许折行 —— 这一列的 min-content 被
            // word-break: break-all 压到 1 个字符，不锁住就会被挤成
            // 「10」「0」两行（原因见 app.css 里 .kv-table td.val.nowrap）。
            D.h('td.val.nowrap', { text: String(c.code) }),
            D.h('td', null,
              D.h('strong', { text: c.name }),
              c.type !== 'HTTP' ? D.h('span.badge-note', { text: t('for_type', 'For {type}').replace('{type}', c.type) }) : null
            ),
            D.h('td', { text: c.description }),
            D.h('td', null, U.copyButton(function () { return String(c.code); }))
          ));
        });
        table.appendChild(tbody);
        output.appendChild(table);
      });

      if (!total) output.appendChild(D.h('div.preview-box', null,
        D.h('span', { text: t('no_match', 'No matching status codes.') })));
    }

    input.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('search', 'Search http status...'), input, { wide: true }),
      status,
      output
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['http-status-codes'] = {
    CODES_BY_CATEGORIES: CODES_BY_CATEGORIES,
    ALL_CODES: ALL_CODES,
    byCode: byCode,
    search: search,
    grouped: grouped,
    __cases: function (assert) {
      assert.eq(CODES_BY_CATEGORIES.length, 5, '五个类别 1xx~5xx');
      assert.eq(ALL_CODES.length, 63, '全表 63 条');
      // 每个类别开头码都在
      [100, 200, 300, 400, 500].forEach(function (c) {
        assert(byCode(c), '应能按 ' + c + ' 查到');
      });
      assert.eq(byCode(404).name, 'Not Found', '404 = Not Found');
      assert.eq(byCode(418).name, "I'm a teapot", '418 = teapot');
      assert.eq(byCode(418).description, 'The server refuses the attempt to brew coffee with a teapot.', '418 描述');
      assert.eq(byCode(511).category, '5xx server error', '511 属于 5xx');
      assert.eq(byCode(102).type, 'WebDav', '102 标着 WebDav');
      assert.eq(byCode(999), undefined, '表里没有的码返回 undefined');
      assert.eq(byCode('404').code, 404, '字符串码也能查');
      assert.eq(byCode(404.0).code, 404, '404.0 就是 404');
      assert.eq(byCode(404.5), undefined, '小数不算精确匹配');

      // 搜索
      assert.eq(search('').length, 63, '空查询返回全表');
      assert.eq(search('   ').length, 63, '纯空白查询返回全表');
      assert.eq(search('404')[0].code, 404, '搜 404 精确命中排第一');
      assert.eq(search('404')[0].name, 'Not Found', '搜 404 名字正确');
      assert.eq(search('not found')[0].code, 404, '搜 "not found" 命中 404');
      assert.eq(search('teapot')[0].code, 418, '搜 teapot 命中 418');
      assert.eq(search('gateway').map(function (c) { return c.code; }), [504, 502], '搜 gateway 命中 504/502，名字里命中位置靠前的排前面');
      assert.eq(search('unavailable')[0].code, 503, '搜 unavailable 命中 503');
      assert.eq(search('zzzzz-not-a-status').length, 0, '搜不到返回空');
      assert(search('200').every(function (c) { return c.code !== 404; }), '搜 200 不该混入 404');
      // code 权重最高：搜 404 时 404 必须排第一（其它码里没有 404 字样）
      assert.eq(search('404')[0].code, 404, '码权重高于名字');

      // 分组
      assert.eq(grouped(''), CODES_BY_CATEGORIES, '无查询时原样返回分类表');
      assert.eq(grouped('404')[0].category, 'Search results', '有查询时归到 Search results');
      assert.eq(grouped('404')[0].codes.length, 1, 'Search results 里只有命中项');
    }
  };
})();