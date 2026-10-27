/* ==========================================================================
   Outlook SafeLink 解码（safelink-decoder）

   SafeLink 是 Outlook 给邮件里的外链套的一层跳转，形如
   https://<域>.safelinks.protection.outlook.com/?url=<真实地址>&data=...
   这个工具把被藏起来的真实地址取出来，好判断邮件里的链接到底指向哪里。

   参考实现：src/tools/safelink-decoder/（it-tools, GPLv3）
   与原版的差别（原版的域名判断是个安全漏洞）：
   1. 原版是 safeLinksUrl.match(/\.safelinks\.protection\.outlook\.com/)，
      只要字符串里任意位置出现这个子串就算通过。于是
      https://evil.com/?to=.safelinks.protection.outlook.com
      甚至 https://x.safelinks.protection.outlook.com.evil.com/ 都能通过校验，
      而这恰恰是钓鱼链接的常用手法 —— 一个用来识别钓鱼的工具反而会被骗。
      这里改成解析 URL 后精确比对 hostname（且要求它是域名的后缀）。
   2. 原版没有 url 参数时返回 null，界面会显示 "null"；这里抛
      'Invalid SafeLinks URL provided'。
   3. 从邮件正文里复制的链接常是 HTML 转义过的（&amp;），这里先还原再解析；
      参考实现的测试用例本来就是这种转义形态。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('safelink-decoder');

  // 官方是 <区域码>.safelinks.protection.outlook.com（如 aus01. / emea0.）
  var HOST_RE = /^[a-z0-9-]+\.safelinks\.protection\.outlook\.com$/i;

  // 报错信息是给用户看的，走 i18n；后半截的细节各自一个键，
  // 拼起来还是原来那句话（INVALID + ' — ' + 细节）。
  var INVALID = t('err_invalid', 'Invalid SafeLinks URL provided');

  /** SafeLink 里的 url 参数本来就是百分号编码的，解不开就是坏链接。 */
  function decodeParam(param) {
    try {
      return decodeURIComponent(param);
    } catch (e) {
      throw new Error(INVALID + ' — ' +
        t('err_bad_encoding', 'the "url" parameter is not valid percent-encoding'));
    }
  }

  /**
   * 解出 SafeLink 指向的真实地址。
   * @param {string} safeLinkUrl
   * @returns {string} 真实地址
   * @throws {Error} 不是 SafeLink / 解析不了 / 缺 url 参数
   */
  function decodeSafeLink(safeLinkUrl) {
    var input = String(safeLinkUrl == null ? '' : safeLinkUrl)
      .trim()
      // 邮件正文里的链接常是 HTML 转义过的
      .replace(/&amp;/gi, '&');
    if (!input) throw new Error(INVALID);

    var url;
    try {
      url = new URL(input);
    } catch (e) {
      throw new Error(INVALID + ' — ' + t('err_not_absolute', 'not a valid absolute URL'));
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(INVALID + ' — ' + t('err_scheme', 'only http(s) URLs are supported'));
    }
    if (!HOST_RE.test(url.hostname)) {
      throw new Error(INVALID + ' — ' +
        t('err_host', 'host is {host}').replace('{host}', url.hostname));
    }

    var target = url.searchParams.get('url');
    if (!target) throw new Error(INVALID + ' — ' + t('err_no_url', 'no "url" parameter'));
    return decodeParam(target);
  }

  /**
   * 解出真实地址并顺带做一次粗筛：是不是绝对地址、是不是 http(s)。
   * 界面上用来提示「这条链接指向哪」，不做安全判定。
   */
  function inspectSafeLink(safeLinkUrl) {
    var target = decodeSafeLink(safeLinkUrl);
    var parsed = null;
    try {
      parsed = new URL(target);
    } catch (e) { /* 不是绝对地址，下面按异常分支处理 */ }
    return {
      target: target,
      host: parsed ? parsed.hostname : null,
      scheme: parsed ? parsed.protocol.replace(':', '') : null,
      suspicious: !parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    };
  }

  window.ItTools.register('safelink-decoder', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 3, placeholder: t('input_ph', 'Your input Outlook SafeLink Url...')
    });
    var output = U.codeBlock();
    var badge = D.h('span.badge-note.form-status');

    function render() {
      if (!input.value.trim()) {
        output.value = '';
        badge.textContent = '';
        badge.classList.remove('is-error');
        return;
      }
      try {
        var info = inspectSafeLink(input.value);
        output.value = info.target;
        badge.textContent = info.suspicious
          ? t('warn_not_http', 'not an http(s) URL — click with care')
          : '→ ' + info.scheme + '://' + info.host;
        badge.classList.toggle('is-error', info.suspicious);
      } catch (e) {
        output.value = '';
        badge.textContent = e.message;
        badge.classList.add('is-error');
      }
    }

    input.addEventListener('input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your input Outlook SafeLink Url:'), input, { wide: true }),
      D.h('p.field-hint', {
        text: t('hint',
          'Only official Outlook domains like https://<region>.safelinks.protection.outlook.com/?url=… are recognized.')
      }),
      // 原版：输入框 → 分隔线 → 输出
      U.divider(),
      D.h('div.code-label', { text: t('output', 'Output decoded URL') }),
      output.card,
      D.h('div.form-actions', null, badge)
    ));

    render();

    return { destroy: function () { D.clear(root); } };
  });

  window.ItTools.logic['safelink-decoder'] = {
    decodeSafeLink: decodeSafeLink,
    inspectSafeLink: inspectSafeLink,
    HOST_RE: HOST_RE,
    __cases: function (assert) {
      // 与参考实现的 vitest 用例一致
      var link = 'https://aus01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dsafelink%26rlz%3D1&data=05%7C02%7C%7C1ed07253975b46da1d1508dc3443752a%7C84df9e7fe9f640afb435aaaaaaaaaaaa%7C1%7C0%7C638442711583216725%7CUnknown%7CTWFpbGZsb3d8eyJWIjoiMC4wLjAwMDAiLCJQIjoiV2luMzIiLCJBTiI6Ik1haWwiLCJXVCI6Mn0%3D%7C0%7C%7C%7C&sdata=%2BQY0HBnnxfI7pzZoxzlhZdDvYu80LwQB0zUUjrffVnk%3D&reserved=0';
      assert.eq(decodeSafeLink(link), 'https://www.google.com/search?q=safelink&rlz=1', '基本 SafeLink');
      assert.eq(decodeSafeLink(link.replace(/&data=/g, '&amp;data=')),
        'https://www.google.com/search?q=safelink&rlz=1', 'HTML 转义过的链接');

      // 非法输入：报错信息与原版一致
      function messageOf(input) {
        try { decodeSafeLink(input); return ''; } catch (e) { return e.message; }
      }
      assert(messageOf('https://google.com').indexOf('Invalid SafeLinks URL provided') === 0, '非 SafeLink 抛错');
      assert(messageOf('').indexOf('Invalid SafeLinks URL provided') === 0, '空串抛错');
      assert(messageOf('not a url').indexOf('Invalid SafeLinks URL provided') === 0, '非绝对地址抛错');

      // 修掉的行为：域名判断必须精确，不能被钓鱼链接骗过
      assert(messageOf('https://aus01.safelinks.protection.outlook.com.evil.com/?url=https://evil.com') !== '', '后缀钓鱼域名要拒绝');
      assert(messageOf('https://evil.com/?to=.safelinks.protection.outlook.com') !== '', '子串出现不算数');
      assert(messageOf('https://evil.com/https://aus01.safelinks.protection.outlook.com/') !== '', '路径里出现不算数');
      assert(messageOf('https://safelinks.protection.outlook.com/?url=https%3A%2F%2Fa.com') !== '', '缺区域码的前缀');
      assert(messageOf('javascript:alert(1)//aus01.safelinks.protection.outlook.com/?url=x') !== '', '非 http 协议');
      assert(messageOf('https://aus01.safelinks.protection.outlook.com/?data=1') !== '', '缺 url 参数');
      assert(messageOf('https://aus01.safelinks.protection.outlook.com/?url=%E0%A4%A') !== '', '坏百分号编码');

      // 合法的变体
      assert.eq(decodeSafeLink('https://emea01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fa.com%2Fx'),
        'https://a.com/x', '别的区域码');
      assert.eq(decodeSafeLink('  https://aus01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fa.com  '),
        'https://a.com', '首尾空白');

      // 顺带的粗筛信息
      var info = inspectSafeLink(link);
      assert.eq(info.host, 'www.google.com', '真实主机名');
      assert.eq(info.scheme, 'https', '协议');
      assert(info.suspicious === false, 'http(s) 目标不算可疑');
      assert(inspectSafeLink('https://aus01.safelinks.protection.outlook.com/?url=javascript%3Aalert(1)').suspicious === true,
        '非 http(s) 的目标要标出来');
    }
  };
})();