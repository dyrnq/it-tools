/* ==========================================================================
   URL 解析器（url-parser）

   把一个 URL 拆成 protocol / username / password / hostname / port /
   pathname / search / hash 若干段，每段可以单独复制；query 参数再展开成
   键值对照表。

   参考实现：src/tools/url-parser/（it-tools, GPLv3）
   与原版的差别：
   1. 原版只列了 8 个属性，漏掉了 hash、search 参数的解码值和 origin，
      这里补全了 hash 与 query 明细。
   2. 原版用 `new URL(...)` 直接抛异常，非法输入整页报错；这里捕获异常并
      返回 { ok: false, error }，UI 显示提示而不是白屏。
   3. 原版对「多个同名 query 参数」用 Object.fromEntries 折叠，只会留下最后
      一个；这里保留数组顺序，同名参数全部列出。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('url-parser');

  /** 拆出的字段顺序就是 UI 里的展示顺序。title 是显示名，走 i18n。 */
  var FIELDS = [
    { key: 'protocol', title: t('protocol', 'Protocol') },
    { key: 'username', title: t('username', 'Username') },
    { key: 'password', title: t('password', 'Password') },
    { key: 'hostname', title: t('hostname', 'Hostname') },
    { key: 'port', title: t('port', 'Port') },
    { key: 'pathname', title: t('path', 'Path') },
    { key: 'search', title: t('params', 'Params') },
    { key: 'hash', title: t('hash', 'Hash') },
    { key: 'origin', title: t('origin', 'Origin') }
  ];

  /**
   * 解析 URL。
   * @returns {{ok:boolean, error?:string, fields:object, params:Array<{key:string,value:string}>}}
   */
  function parse(input) {
    var raw = String(input == null ? '' : input).trim();
    var empty = { ok: false, fields: {}, params: [] };
    if (!raw.length) return Object.assign({ error: t('err_empty', 'Please enter a URL.') }, empty);

    var url;
    try {
      url = new URL(raw);
    } catch (e) {
      return Object.assign({
        error: t('err_invalid', 'Invalid URL: an absolute address (including the protocol) is required.')
      }, empty);
    }

    // query 参数按出现顺序收集，同名参数不去重
    var params = [];
    url.searchParams.forEach(function (value, key) {
      params.push({ key: key, value: value });
    });

    var fields = {};
    FIELDS.forEach(function (f) {
      fields[f.key] = url[f.key] === undefined ? '' : url[f.key];
    });
    // 没有端口时 URL.port 是空串，展示成默认端口更直观
    if (!fields.port) fields.port = (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');

    return { ok: true, fields: fields, params: params };
  }

  window.ItTools.register('url-parser', function (root) {
    var input = D.h('input.layui-input', {
      type: 'text',
      value: 'https://me:pwd@example.com:3000/url-parser?key1=value&key2=value2#the-hash',
      placeholder: t('input_ph', 'Your url to parse...')
    });

    var fieldsBox = D.h('div.kv-rows');
    var paramsBox = D.h('div.kv-rows');
    var status = D.h('p.field-hint');

    function kvRow(label, value) {
      var inputEl = D.h('input.layui-input', { type: 'text', readonly: true, value: value });
      // 原版这几行是 InputCopyable + label-position="left" label-width="110px"，
      // **没写 label-align** —— c-input-text 的默认对齐是 left（左对齐）。
      return D.h('div.field-row', { style: { '--field-label-width': '110px', '--field-label-align': 'left' } },
        D.h('label.field-label', { text: label }),
        inputEl,
        U.copyButton(function () { return inputEl.value; })
      );
    }

    function render() {
      var result = parse(input.value);
      D.clear(fieldsBox);
      D.clear(paramsBox);
      status.textContent = result.error || '';
      status.classList.toggle('is-error', !result.ok);
      if (!result.ok) return;

      FIELDS.forEach(function (f) {
        fieldsBox.appendChild(kvRow(f.title, result.fields[f.key]));
      });
      if (!result.params.length) {
        paramsBox.appendChild(D.h('p.field-hint', { text: t('no_params', 'This URL has no query parameters.') }));
      } else {
        paramsBox.appendChild(D.h('div.field-row', null,
          D.h('label.field-label', { text: t('query_parameters', 'Query parameters') })
        ));
        result.params.forEach(function (p) {
          paramsBox.appendChild(D.h('div.field-row', { style: { '--field-label-width': '110px', '--field-label-align': 'left' } },
            D.h('label.field-label', { text: p.key }),
            D.h('input.layui-input', { type: 'text', readonly: true, value: p.value }),
            U.copyButton(function () { return p.key + '=' + p.value; })
          ));
        });
      }
    }

    input.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your url to parse:'), input, { wide: true }),
      status,
      // 原版：输入框 → 分隔线 → 各个字段
      U.divider(),
      fieldsBox,
      paramsBox
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['url-parser'] = {
    parse: parse,
    FIELDS: FIELDS,
    __cases: function (assert) {
      var r = parse('https://me:pwd@example.com:3000/url-parser?key1=value&key2=value2#the-hash');
      assert(r.ok, '合法 URL 应解析成功');
      assert.eq(r.fields.protocol, 'https:', 'protocol 带冒号');
      assert.eq(r.fields.username, 'me', 'username');
      assert.eq(r.fields.password, 'pwd', 'password');
      assert.eq(r.fields.hostname, 'example.com', 'hostname 不含端口');
      assert.eq(r.fields.port, '3000', 'port');
      assert.eq(r.fields.pathname, '/url-parser', 'pathname');
      assert.eq(r.fields.search, '?key1=value&key2=value2', 'search 保留问号');
      assert.eq(r.fields.hash, '#the-hash', 'hash 保留井号');
      assert.eq(r.fields.origin, 'https://example.com:3000', 'origin');
      assert.eq(r.params, [{ key: 'key1', value: 'value' }, { key: 'key2', value: 'value2' }], 'query 参数按顺序');

      // 同名参数全部保留（参考实现用 Object.fromEntries 会只剩最后一个）
      assert.eq(parse('https://a.b/?x=1&x=2&x=3').params, [{ key: 'x', value: '1' }, { key: 'x', value: '2' }, { key: 'x', value: '3' }], '重复 key 不折叠');
      // 参数值是 URL 解码后的
      assert.eq(parse('https://a.b/?q=a%20b%26c').params[0].value, 'a b&c', '参数值已解码');

      assert(!parse('').ok, '空串不合法');
      assert(!parse('  ').ok, '纯空白不合法');
      assert(!parse('not a url').ok, '缺协议名不合法');
      assert(!parse('example.com/path').ok, '裸域名不合法');

      var b = parse('http://a.b');
      assert.eq(b.ok, true, '最短 URL 也能解析');
      assert.eq(b.fields.pathname, '/', '无路径时 pathname 为 /');
      assert.eq(b.fields.port, '80', 'http 默认端口');
      assert.eq(b.fields.hash, '', '无 hash 时为空串');
      assert.eq(parse('https://a.b').fields.port, '443', 'https 默认端口');
      assert.eq(parse('ws://a.b:8080').fields.port, '8080', '自定义端口');
    }
  };
})();