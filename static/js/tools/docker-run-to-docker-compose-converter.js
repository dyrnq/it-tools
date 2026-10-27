/* ==========================================================================
   docker run → docker-compose 转换（docker-run-to-docker-compose-converter）

   贴一条 docker run 命令，转换成等价的 docker-compose.yml。

   参考实现：src/tools/docker-run-to-docker-compose-converter/（it-tools, GPLv3）
   与原版的差别：
   · ⚠ 原版从 `composerize-ts` 里 import 了 `MessageType` 常量。本仓库 vendored 的产物
     只挂了 composerize 这个函数（`composerize.MessageType === undefined`），
     所以三种消息类型在这里按字面量定义（与库里实际吐出的字符串一致）。
   · ⚠ 库里用的是 jflex 生成的扫描器，遇到**匹配不到的字符**会把它们原样 echo 到
     `Lexer.defaultOutput()`；浏览器里没有 `process.stdout`，它就 fallback 到 `console.log`，
     于是用户输入里的 `;` `@` `#` 反引号、未配对的引号会凭空打到控制台上
     （-e 里带 `://` 的值也可能触发）。所以这里在调用前后把 console.log 临时换掉。
   · 原版对空输入也照调，库里不报错，直接吐一段
     `services:\n    "": {}` 的垃圾 YAML。这里空输入不产出结果。
   · 原版下载走 base64 data URL + useDownloadFileFromBase64。这里直接用
     ItTools.download(filename, text, mime)，少一层 base64 编解码。
   · 原版对「输入根本不是 docker run」没有任何提示（`not a docker command` 会被解析成
     一个叫 not 的服务）。这里给一条提示，但仍然照常转换 —— 用户可能正在改命令。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('docker-run-to-docker-compose-converter');

  /** 库里 messages[].type 的三种取值（产物上没有导出常量，只能写字面量）。 */
  var MESSAGE_TYPES = {
    NOT_TRANSLATABLE: 'notTranslatable',
    NOT_IMPLEMENTED: 'notImplemented',
    ERROR: 'errorDuringConversion'
  };

  var DEFAULT_COMMAND =
    'docker run -p 80:80 -v /var/run/docker.sock:/tmp/docker.sock:ro --restart always --log-opt max-size=1g nginx';

  var SAMPLES = [
    DEFAULT_COMMAND,
    'docker run -d -p 8080:80 -e NODE_ENV=production --name web nginx:alpine',
    'docker run --name db -e POSTGRES_PASSWORD=secret -p 5432:5432 -d postgres:15'
  ];

  /**
   * 在静默 console.log 的前提下跑一段代码。
   *
   * 为什么必须静音：composerize 内部那套 jflex 扫描器遇到不认识的字符时，会把它们
   * 写进 `Lexer.defaultOutput()`。浏览器里没有 process.stdout，于是 fallback 到
   * console.log —— 用户只是粘了条带 `;` 或未配对引号的命令，控制台上就多出一行
   * 莫名其妙的内容（严重时会把连接串里的凭据也打出来）。
   *
   * @param {Function} fn
   * @returns {*} fn 的返回值
   */
  function withSilencedConsole(fn) {
    var original = console.log;
    try {
      console.log = function () { /* 静音：jflex 的未匹配字符回显 */ };
      return fn();
    } finally {
      // finally 里恢复：即使 fn 抛错也不能把控制台永久改掉
      console.log = original;
    }
  }

  /** 把 messages 按类型分桶。认不出来的类型进 other，不丢。 */
  function groupMessages(messages) {
    var groups = {
      notComposable: [],
      notImplemented: [],
      errors: [],
      other: []
    };
    (Array.isArray(messages) ? messages : []).forEach(function (m) {
      var value = (m && m.value) || '';
      switch (m && m.type) {
        case MESSAGE_TYPES.NOT_TRANSLATABLE: groups.notComposable.push(value); break;
        case MESSAGE_TYPES.NOT_IMPLEMENTED: groups.notImplemented.push(value); break;
        case MESSAGE_TYPES.ERROR: groups.errors.push(value); break;
        default: groups.other.push(value);
      }
    });
    return groups;
  }

  /**
   * 主入口：docker run 命令 → compose 文件内容。
   *
   * @param {string} command
   * @returns {{ok:boolean, empty:boolean, error:string, yaml:string, messages:Array,
   *            notComposable:string[], notImplemented:string[], errors:string[], other:string[],
   *            looksLikeDockerRun:boolean}}
   */
  function convert(command) {
    var emptyResult = {
      ok: false, empty: true, error: '', yaml: '', messages: [],
      notComposable: [], notImplemented: [], errors: [], other: [], looksLikeDockerRun: false
    };
    if (typeof command !== 'string') {
      return Object.assign({}, emptyResult, {
        error: t('err_not_string', 'Expected a string, got {type}').replace('{type}', typeof command)
      });
    }
    var trimmed = command.trim();
    if (!trimmed) return emptyResult;

    var result;
    try {
      result = withSilencedConsole(function () { return window.composerize(trimmed); });
    } catch (e) {
      return Object.assign({}, emptyResult, {
        error: String((e && e.message) || e),
        looksLikeDockerRun: looksLikeDockerRun(trimmed)
      });
    }
    if (!result || typeof result !== 'object') {
      return Object.assign({}, emptyResult, {
        error: t('err_unexpected', 'composerize returned an unexpected result'),
        looksLikeDockerRun: looksLikeDockerRun(trimmed)
      });
    }

    var groups = groupMessages(result.messages);
    return {
      ok: true,
      empty: false,
      error: '',
      yaml: typeof result.yaml === 'string' ? result.yaml : '',
      messages: Array.isArray(result.messages) ? result.messages : [],
      notComposable: groups.notComposable,
      notImplemented: groups.notImplemented,
      errors: groups.errors,
      other: groups.other,
      looksLikeDockerRun: looksLikeDockerRun(trimmed)
    };
  }

  /**
   * 粗判输入是不是 docker run（只做提示，不拦）。
   * 库只认 `docker run`；`docker container run` 会被它解析成一个叫 docker 的服务，
   * 所以这个判据是有意义的。
   * @param {string} trimmed
   */
  function looksLikeDockerRun(trimmed) {
    return /^docker\s+run\b/i.test(String(trimmed || '').trim());
  }

  window.ItTools.register('docker-run-to-docker-compose-converter', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 4, value: DEFAULT_COMMAND, spellcheck: 'false',
      placeholder: t('input_ph', 'Your docker run command to convert...'),
      style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      'aria-label': t('aria_label', 'Your docker run command')
    });

    // 原版这一页没有卡片外壳：输入 → 分隔线 → yaml → 下载按钮 → 提示块。
    // 我们把输入和输出收进同一张卡，中间放一条分隔线。
    var yamlOut = U.codeBlock();
    var downloadBtn = D.h('button.layui-btn.layui-btn-primary', {
      type: 'button', text: t('download', 'Download docker-compose.yml'), disabled: true
    });
    var hint = D.h('p.field-hint');
    var notes = D.h('div');

    // 原版这几块是 n-alert：标题 + 一列条目，info / warning / error 三种
    function noteBlock(title, items, tone) {
      if (!items.length) return null;
      return U.alert(tone || 'info', title,
        D.h('ul', null, items.map(function (item) { return D.h('li', { text: item }); })));
    }

    function render() {
      var r = convert(input.value);
      yamlOut.value = r.empty ? '' : r.yaml;
      downloadBtn.disabled = !r.yaml;

      D.clear(notes);
      if (r.empty && !r.error) {
        hint.textContent = t('hint_empty', 'Paste a docker run command above.');
      } else if (r.error) {
        hint.textContent = r.error;
        hint.style.color = 'var(--danger, #d93025)';
      } else {
        hint.style.color = '';
        hint.textContent = r.looksLikeDockerRun
          ? ''
          : t('hint_not_docker_run', 'This does not start with "docker run" — the conversion below may not mean anything.');
      }

      [noteBlock(t('note_not_translatable', 'These options are not translatable to docker-compose'), r.notComposable, 'info'),
        noteBlock(t('note_not_implemented', 'These options are not yet implemented and therefore have not been translated'), r.notImplemented, 'warning'),
        noteBlock(t('note_errors', 'The following errors occurred'), r.errors, 'error'),
        noteBlock(t('note_other', 'Other messages from the converter'), r.other, 'info')
      ].forEach(function (b) { if (b) notes.appendChild(b); });
    }

    downloadBtn.addEventListener('click', function () {
      var yaml = convert(input.value).yaml;
      if (!yaml) return;
      window.ItTools.download('docker-compose.yml', yaml, 'text/yaml;charset=utf-8');
    });

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your docker run command:'), input, { wide: true }),
      hint,
      D.h('div.form-actions', null, SAMPLES.map(function (s, i) {
        return D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button',
          text: t('sample', 'Sample') + ' ' + (i + 1),
          onclick: function () { input.value = s; render(); }
        });
      })),
      U.divider(),
      yamlOut.card,
      D.h('div.form-actions', null, downloadBtn)
    ));

    // 提示与备注是原版里的 n-alert，排在按钮后面。
    root.appendChild(notes);
    render();

    return {
      destroy: function () {
        off();
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['docker-run-to-docker-compose-converter'] = {
    MESSAGE_TYPES: MESSAGE_TYPES,
    DEFAULT_COMMAND: DEFAULT_COMMAND,
    SAMPLES: SAMPLES,
    withSilencedConsole: withSilencedConsole,
    groupMessages: groupMessages,
    looksLikeDockerRun: looksLikeDockerRun,
    convert: convert,
    __cases: function (assert) {
      /* ---- 静默 console ---- */
      var logged = [];
      var original = console.log;
      console.log = function () { logged.push(Array.prototype.slice.call(arguments).join(' ')); };
      var silenced;
      try { silenced = withSilencedConsole(function () { console.log('noise'); return 42; }); }
      finally { console.log = original; }
      assert.eq(silenced, 42, 'withSilencedConsole 照常返回 fn 的结果');
      assert.eq(logged, [], 'fn 里的 console.log 被吞掉');
      // assert.eq 走 JSON.stringify，比函数没意义，只能比身份
      assert.eq(console.log === original, true, 'console.log 被还原成原函数');

      // fn 抛异常时也必须还原，否则控制台就永久哑了
      logged = [];
      var threw = false;
      console.log = function () { logged.push('x'); };
      try {
        try { withSilencedConsole(function () { throw new Error('boom'); }); }
        catch (e) { threw = true; }
      } finally { console.log = original; }
      assert.eq(threw, true, '异常照常往外抛');
      assert.eq(console.log === original, true, '抛异常时 console.log 也还原');

      /* ---- 主转换 ---- */
      var r = convert('docker run -p 80:80 nginx');
      assert.eq(r.ok, true, '能转');
      assert.eq(r.empty, false, '不空');
      assert.eq(r.error, '', '没有错误');
      assert.eq(r.yaml, "version: '3.9'\nservices:\n    nginx:\n        image: nginx\n        ports:\n            - '80:80'\n",
        '最简命令的 YAML');
      assert.eq(r.messages, [], '没有消息');
      assert.eq(r.looksLikeDockerRun, true, '认得出是 docker run');

      r = convert('docker run -d -p 8080:80 -e NODE_ENV=production --name web nginx:alpine');
      assert(r.yaml.indexOf("container_name: web") > 0, '--name → container_name');
      assert(r.yaml.indexOf('NODE_ENV=production') > 0, '-e → environment');
      assert(r.yaml.indexOf("'8080:80'") > 0, '-p → ports');
      assert(r.yaml.indexOf("image: 'nginx:alpine'") > 0, '带 tag 的镜像');
      // -d 是 detach，compose 里对应不到任何字段，只能如实报告
      assert.eq(r.notComposable.length, 1, '1 条 notTranslatable');
      assert(r.notComposable[0].indexOf('--detach/-d') >= 0, '说的是 --detach/-d：' + r.notComposable[0]);
      assert.eq(r.notImplemented.length, 0, '没有 notImplemented');

      r = convert('docker run --memory 512m nginx');
      assert.eq(r.notImplemented.length, 1, '1 条 notImplemented');
      assert(r.notImplemented[0].indexOf('--memory/-m') >= 0, '说的是 --memory/-m：' + r.notImplemented[0]);
      assert.eq(r.notComposable.length, 0, '没有 notTranslatable');

      r = convert('docker run -v /var/run/docker.sock:/tmp/docker.sock:ro --log-opt max-size=1g nginx');
      assert(r.yaml.indexOf("'/var/run/docker.sock:/tmp/docker.sock:ro'") > 0, '-v → volumes（带 :ro）');
      assert(r.yaml.indexOf('max-size: 1g') > 0, '--log-opt → logging.options');

      r = convert('docker run -d --restart unless-stopped --network host nginx');
      assert(r.yaml.indexOf('restart: unless-stopped') > 0, '--restart');
      assert(r.yaml.indexOf('networks:') > 0, '--network → networks');
      assert(r.messages.length === 1, '只有 -d 那一条消息');

      // 首尾空白必须先裁掉：不裁的话库里会给命令尾部补一个 command: ""
      r = convert('   docker run nginx   ');
      assert.eq(r.yaml, "version: '3.9'\nservices:\n    nginx:\n        image: nginx\n", '首尾空白不会污染 YAML');

      /* ---- 消息分桶 ---- */
      var g = groupMessages([
        { type: 'notTranslatable', value: 'a' },
        { type: 'notImplemented', value: 'b' },
        { type: 'errorDuringConversion', value: 'c' },
        { type: 'somethingElse', value: 'd' }
      ]);
      assert.eq(g.notComposable, ['a'], 'notTranslatable 桶');
      assert.eq(g.notImplemented, ['b'], 'notImplemented 桶');
      assert.eq(g.errors, ['c'], 'errorDuringConversion 桶');
      assert.eq(g.other, ['d'], '认不出来的类型进 other 而不是被丢掉');
      assert.eq(groupMessages([]).errors, [], '空数组');
      assert.eq(groupMessages(undefined).other, [], 'undefined 不炸');
      assert.eq(groupMessages(null).other, [], 'null 不炸');
      assert.eq(groupMessages([{}]).other, [''], '没有 value 的消息不炸');

      /* ---- 边界 / 非法输入 ---- */
      r = convert('');
      assert.eq(r.ok, false, '空串不产出结果');
      assert.eq(r.empty, true, '标记为 empty');
      assert.eq(r.yaml, '', '没有 YAML（库里对空串会吐 services: {"": {}} 的垃圾）');
      assert.eq(r.error, '', '空串不算错误');

      r = convert('   \n  ');
      assert.eq(r.empty, true, '纯空白也当空');

      r = convert(null);
      assert.eq(r.ok, false, 'null 被挡下');
      assert(r.error.indexOf('string') > 0, '错误里说清要 string：' + r.error);
      r = convert(undefined);
      assert.eq(r.ok, false, 'undefined 被挡下');
      r = convert(42);
      assert.eq(r.ok, false, '数字被挡下');
      r = convert(['docker run nginx']);
      assert.eq(r.ok, false, '数组被挡下');

      // 不是 docker run 的输入照样转换，但要标出来（库里会把它当普通命令行解析）
      r = convert('not a docker command');
      assert.eq(r.ok, true, '照样转，不拦');
      assert.eq(r.looksLikeDockerRun, false, '但会提示不是 docker run');
      assert(r.yaml.indexOf('image: not') > 0, '库把它当成镜像 not');
      assert.eq(looksLikeDockerRun('DOCKER RUN nginx'), true, '大小写不敏感');
      assert.eq(looksLikeDockerRun('docker container run nginx'), false, 'container run 不算（库里不认）');
      assert.eq(looksLikeDockerRun(''), false, '空串不算');
      assert.eq(looksLikeDockerRun(null), false, 'null 不炸');

      /* ---- 库会往 console 打东西的那些输入 ----
         jflex 匹配不到字符时会把字符回显到 console.log（浏览器里也一样）。
         带 `;` / `@` / `#` / 反引号 / 未配对引号的命令都会走到这条路径，
         所以整条链路必须是在 withSilencedConsole 里跑的。 */
      logged = [];
      console.log = function () { logged.push(Array.prototype.slice.call(arguments).join(' ')); };
      var noisy;
      try {
        noisy = convert('docker run -e A="x y" nginx;');
      } finally {
        console.log = original;
      }
      assert.eq(logged, [], 'convert 全程没有往 console 打东西');
      assert.eq(noisy.ok, true, '带杂字符的命令不报错');
      // 库对带引号/杂字符的命令会解析得一塌糊涂（这里它把 `A="x y" nginx;` 当成了
      // 一个叫 x 的服务），但那不是我们的锅 —— 照实转述，别偷偷改用户的命令。
      assert.eq(noisy.yaml.indexOf('version:') === 0, true, '仍是一段 YAML：' + JSON.stringify(noisy.yaml));

      // 直接调库是会打的 —— 证明静音不是多余的
      logged = [];
      console.log = function () { logged.push('leaked'); };
      try { window.composerize('docker run nginx;'); } finally { console.log = original; }
      assert.eq(logged, ['leaked'], '不包静音的话库真的会打 console');
    }
  };
})();