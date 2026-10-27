/*
 * API 工具表单（`initApiForm` → `render` / `describeError`）的冒烟测试。
 *
 * 这段代码在闭包里，没法直接调 `render()`，所以这里走完整链路：
 * 造一个带 data-tool-api 的工具页，把 fetch 换成假的，
 * 提交表单，然后看 #api-output-body 里到底出现了什么。
 *
 * ⚠️ 下面的**假响应**必须跟真服务端发的一模一样。
 * 信封的形状以 `scripts/test/integration-test.sh` 为准（那边打的是真的二进制）——
 * 这里只验「前端怎么消费这个信封」，验不到「服务端真的这么发」。
 * 改了服务端的键名，先改那边，再回来改这里的假响应。
 *
 * 三条守着的都是实测踩到的坑：
 *   1. 服务端统一回 `{ok, data}`，render 必须先拆信封 —— 不拆的话
 *      table/output/html 三个键全落空，整包被 JSON.stringify 成原始 JSON 贴出来；
 *   2. 错误也是信封 `{ok, error: {kind, message}}`，直接把 error 塞给
 *      new Error 会显示 "[object Object]"；
 *   3. output 是主结果（RSA 私钥、密文、哈希），table 是补充 —— 两者都在时
 *      必须都显示，只渲染 table 会把主结果吃掉。
 *
 * 用法：node api-form.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = fs.readFileSync(path.join(__dirname, '../../static/js/app.js'), 'utf8');

let failures = 0;
function ok(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(
    pass ? '  ok  ' : '  FAIL',
    label,
    '=>',
    JSON.stringify(actual),
    pass ? '' : '   期望 ' + JSON.stringify(expected)
  );
}

/** 造一个最小的 API 工具页，fetch 由 response 决定 */
async function boot(response, httpOk, opts) {
  const o = opts || {};
  // 行式结果（date-converter 那种）：表单上带 data-rows="1"，下面多一个 #api-rows
  const rowsHost = o.rows
    ? '<div class="api-rows" id="api-rows" hidden></div>'
    : '';
  const timezoneField = o.timezone
    ? `<div class="field">
         <label class="field-label" for="f-timezone">时区</label>
         <input class="layui-input" type="text" id="f-timezone" name="timezone">
       </div>`
    : '';
  // 定时刷新（data-refresh / data-refresh-field）：注册表说这个工具要自己跳。
  // 那个字段得真的在表单里 —— 不在的话前端会静默地不跳。
  const refreshAttr = o.refresh
    ? ` data-refresh="${o.refresh.ms}" data-refresh-field="${o.refresh.field}"`
    : '';
  const dateField = o.refresh
    ? `<div class="field">
         <label class="field-label" for="f-date">日期</label>
         <input class="layui-input" type="text" id="f-date" name="date" value="">
       </div>`
    : '';
  const formatField = o.format
    ? `<div class="field">
         <label class="field-label" for="f-format">输入格式</label>
         <select class="layui-select" id="f-format" name="format">
           <option value="auto">自动识别</option>
           <option value="iso8601">ISO 8601</option>
           <option value="unix">Unix 时间戳（秒）</option>
         </select>
       </div>`
    : '';
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div class="layout" id="layout">
        <div class="main"><main class="content" id="main-content">
          <div class="tool-content" id="tool-body" data-tool-api="/api/tools/x">
            <form class="card api-form" id="api-form" autocomplete="off"${o.rows ? ' data-rows="1"' : ''}${refreshAttr}>
              <div class="field">
                <label class="field-label" for="f-text">输入文本</label>
                <input class="layui-input" type="text" id="f-text" name="text" value="abc">
              </div>
              ${dateField}
              ${formatField}
              ${timezoneField}
              <div class="form-actions">
                <button class="layui-btn" type="submit" id="api-run">Run</button>
                <button class="layui-btn" type="button" data-clear>Clear</button>
                <span class="form-status" id="api-status"></span>
              </div>
              ${rowsHost}
            </form>
            <div class="card api-output" id="api-output" hidden>
              <div class="output-head">
                <span class="output-label">输出</span>
                <button class="layui-btn" id="api-copy">复制</button>
              </div>
              <div class="output-body" id="api-output-body"></div>
            </div>
          </div>
        </main></div>
      </div>
    </body></html>`,
    { runScripts: 'outside-only', url: 'http://localhost/' }
  );
  const w = dom.window;
  // jsdom 没有 matchMedia（initMenu 用它判断 700px 断点），补一个最简实现
  w.matchMedia = (q) => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {} });
  // 数一数问了几次服务端：定时刷新靠它验。
  w.__fetches = 0;
  w.fetch = () => {
    w.__fetches++;
    return Promise.resolve({
      ok: httpOk,
      json: () => Promise.resolve(response),
    });
  };
  w.eval(APP);
  // app.js 在 readyState === 'loading' 时把 boot 挂到 DOMContentLoaded 上，
  // 那是异步的；不等它跑完就提交表单，initApiForm 还没绑监听，什么都不会发生。
  await new Promise((r) => setTimeout(r, 20));
  return w;
}

/** 提交表单并等 Promise 链跑完 */
function submitAndSettle(w) {
  w.document.getElementById('api-form').dispatchEvent(
    new w.Event('submit', { bubbles: true, cancelable: true })
  );
  return new Promise((r) => setTimeout(r, 30));
}

function text(w) {
  return w.document.getElementById('api-output-body').textContent;
}
function status(w) {
  return w.document.getElementById('api-status').textContent;
}

(async () => {
  console.log('--- 信封必须被拆开（否则整包被当成原始 JSON 显示）---');
  let w = await boot({ ok: true, data: { output: 'ba7816bf8f01cfea' } }, true);
  await submitAndSettle(w);
  ok('只有 output → 直接显示', text(w), 'ba7816bf8f01cfea');
  ok('没有退化成 JSON.stringify', text(w).includes('"ok"'), false);

  w = await boot({ ok: true, data: { output: '', table: { md5: 'abc', sha1: 'def' } } }, true);
  await submitAndSettle(w);
  ok('只有 table → 显示表格', text(w), 'md5abcsha1def');

  console.log('--- output 与 table 并存时，两个都要显示 ---');
  w = await boot(
    {
      ok: true,
      data: {
        output: 'CIPHERTEXT-OR-PRIVATE-KEY',
        table: { bits: '2048', 'Public key': 'MIIB...' },
        meta: { ignored: 'yes' },
      },
    },
    true
  );
  await submitAndSettle(w);
  ok('主结果可见', text(w).includes('CIPHERTEXT-OR-PRIVATE-KEY'), true);
  ok('表格细节也可见', text(w).includes('MIIB'), true);
  ok(
    '主结果有独立的块',
    !!w.document.querySelector('#api-output-body .output-primary'),
    true
  );

  console.log('--- 错误信封要取出 message，而不是显示 [object Object] ---');
  w = await boot({ ok: false, error: { kind: 'invalid input', message: '缺少字段 `key`' } }, false);
  await submitAndSettle(w);
  ok('错误文案取自 error.message', status(w), '缺少字段 `key`');
  ok('不是 [object Object]', status(w).includes('[object'), false);

  w = await boot({ ok: false, error: '纯字符串错误' }, false);
  await submitAndSettle(w);
  ok('字符串 error 也认', status(w), '纯字符串错误');

  w = await boot({ ok: false, detail: 'actix 风格的 detail' }, false);
  await submitAndSettle(w);
  ok('detail 也认', status(w), 'actix 风格的 detail');

  w = await boot({ ok: false }, false);
  await submitAndSettle(w);
  ok('什么都没有 → 退回 HTTP 状态', status(w), 'HTTP false');

  console.log('--- html 形状仍然可用，但只在没有 output/table 时 ---');
  w = await boot({ ok: true, data: { html: '<b>hi</b>' } }, true);
  await submitAndSettle(w);
  ok('html 走 innerHTML', text(w), 'hi');
  ok('确实渲染成了元素', !!w.document.querySelector('#api-output-body b'), true);

  console.log('--- 空 output 不该渲染出一个空块 ---');
  w = await boot({ ok: true, data: { output: '', table: { a: '1' } } }, true);
  await submitAndSettle(w);
  ok('空 output 不产生 .output-primary', !!w.document.querySelector('.output-primary'), false);

  console.log('--- 行式结果（date-converter 那种）：一行一个格式 ---');
  const rowsResponse = {
    ok: true,
    data: {
      output: '2023-04-12T23:10:24+02:00',
      table: { 'ISO 8601': '2023-04-12T23:10:24+02:00' },
      rows: [
        { key: 'iso8601', label: 'ISO 8601', value: '2023-04-12T23:10:24+02:00' },
        { key: 'unix', label: 'Unix timestamp (seconds)', value: '1681333824' },
      ],
      meta: { utc: '2023-04-12T21:10:24Z' },
    },
  };
  w = await boot(rowsResponse, true, { rows: true, format: true, timezone: true });
  await submitAndSettle(w);
  const rowEls = [...w.document.querySelectorAll('#api-rows .field-row')];
  ok('行数 = JS locale + 服务端给的两行', rowEls.length, 3);
  ok(
    '第一行是浏览器本地写法（前端算的）',
    rowEls[0].querySelector('.field-label').textContent,
    'JS locale date string'
  );
  ok(
    '第一行的值 = Date.prototype.toString()',
    rowEls[0].querySelector('input').value,
    new Date('2023-04-12T21:10:24Z').toString()
  );
  ok(
    '行序按服务端给的顺序',
    rowEls.slice(1).map((r) => r.querySelector('.field-label').textContent),
    ['ISO 8601', 'Unix 时间戳（秒）']
  );
  ok(
    '标签取自下拉框的文案（各语言一致）',
    rowEls[2].querySelector('.field-label').textContent,
    'Unix 时间戳（秒）'
  );
  ok('每行的输入框是只读的', rowEls[1].querySelector('input').hasAttribute('readonly'), true);
  ok('每行都有复制按钮', rowEls.every((r) => !!r.querySelector('.copy-btn')), true);
  ok('结果区不再用 Output 卡片', w.document.getElementById('api-output').hidden, true);
  ok('行式结果区已经显示', w.document.getElementById('api-rows').hidden, false);

  console.log('--- 时区字段预填浏览器自己的时区 ---');
  const zone = w.document.getElementById('f-timezone');
  ok('预填了时区', !!zone.value, true);
  ok(
    '预填的是 Intl 报的那个',
    zone.value,
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );

  console.log('--- 重画结果时复用节点，不拆了重建 ---');
  //
  // 背景（都是拿 CDP 在真浏览器里量出来的）：
  //   · 结果区以前是「全拆了重建」。拆的时候页面矮一大截，浏览器要重新布局，
  //     发现当前的滚动位置已经超出「矮版页面」的上限，就把滚动条**夹回顶部**
  //     （实测 568 → 73）。等新行装回去、页面又长回来了，滚动位置却停在
  //     被夹过的那个数上 —— 用户看到的就是「点一下下面那个值，滚动条弹回最顶」。
  //   · 拆节点还会把用户正要点着的那一格换掉，选区没了，复制不了字。
  // 原版是 Vue 写的：同一个 DOM 节点留着，只改 value，所以它没这两个毛病。
  const changed = JSON.parse(JSON.stringify(rowsResponse));
  changed.data.rows[1].value = '1681333825';
  w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(changed) });
  const before = w.document.querySelectorAll('#api-rows .field-row')[2].querySelector('input');
  before.focus();
  ok('点一下那个值 → 它有焦点', w.document.activeElement === before, true);
  await submitAndSettle(w);
  const after = w.document.querySelectorAll('#api-rows .field-row')[2].querySelector('input');
  ok('重画之后还是**同一个节点**', after === before, true);
  ok('焦点没掉（选中文字复制才做得到）', w.document.activeElement === before, true);
  ok('值更新了', after.value, '1681333825');

  console.log('--- 拆了重建之后，焦点还给回同一个控件 ---');
  //
  // 背景（拿 CDP 在真浏览器里量出来的）：
  //   JS 工具重画结果区时都是「先全拆了、再装回去」。拆的那一刻页面
  //   矮一大截 → 浏览器重新布局 → 发现滚动位置已经超出「矮版页面」的上限 →
  //   把滚动条**夹回顶部**（实测 704 → 0）。同一个原因还会带走**焦点**：
  //   用户正点着的那一格被摘掉了，想选中结果里的字也复制不成。
  //
  // app.js 的 Dom.clear 里有个看门狗：拆之前记下滚动位置和「正被点着的是谁」，
  // 拆完装回去之后（微任务里，浏览器绘制之前）再还回去。
  // 滚动那一半在 jsdom 里测不了（jsdom 没有布局，scrollY 永远是 0），
  // 焦点这一半能测 —— 这里测的就是它。
  w = await boot({ ok: true, data: { output: 'x' } }, true);
  const host = w.document.createElement('div');
  w.document.getElementById('tool-body').appendChild(host);

  function putInput(readonly, value) {
    const el = w.document.createElement('input');
    el.className = 'layui-input';
    el.readOnly = readonly;
    el.value = value;
    host.appendChild(el);
    return el;
  }

  // 每一小节都是同一个套路：清空 → 等上一个任务结束 → 造一个控件并点它 →
  // 再清空（工具重画）→ 造一个新的 → 等 → 看焦点在哪儿。
  // 「等上一个任务结束」这步不能省：看门狗一个任务只还一次焦点。
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // ① 只读的结果框：值就是会变的（重画的意义就在这儿），焦点照样还回去
  w.ItTools.dom.clear(host);
  await settle();
  const out1 = putInput(true, 'fd00::/48');
  out1.focus();
  ok('点一下那个值 → 它有焦点', w.document.activeElement === out1, true);
  w.ItTools.dom.clear(host);
  const out2 = putInput(true, 'fd11::/48'); // 重画，值变了
  await settle();
  ok('重画之后焦点回到那个框（新节点）', w.document.activeElement === out2, true);

  // ② 可以编辑的输入框：值变了就**不还**焦点 —— 还错了的话，用户接着打字
  //    就打到别的框里去了
  w.ItTools.dom.clear(host);
  await settle();
  const edit1 = putInput(false, 'abc');
  edit1.focus();
  w.ItTools.dom.clear(host);
  const edit2 = putInput(false, 'xyz'); // 值变了
  await settle();
  ok('可编辑的框：值变了 → 焦点不乱还', w.document.activeElement === edit2, false);

  w.ItTools.dom.clear(host);
  await settle();
  const edit3 = putInput(false, 'abc');
  edit3.focus();
  w.ItTools.dom.clear(host);
  const edit4 = putInput(false, 'abc'); // 值没变
  await settle();
  ok('可编辑的框：值没变 → 焦点还回新节点', w.document.activeElement === edit4, true);

  // ③ 复制按钮点下去的那一瞬间文案是「Copied」，重画之后又变回「Copy all」——
  //    这时候还得认得出「还是这个按钮」
  w.ItTools.dom.clear(host);
  await settle();
  const btn1 = w.document.createElement('button');
  btn1.className = 'layui-btn layui-btn-sm layui-btn-primary';
  btn1.textContent = 'Copied';
  host.appendChild(btn1);
  btn1.focus();
  w.ItTools.dom.clear(host);
  const btn2 = w.document.createElement('button');
  btn2.className = 'layui-btn layui-btn-sm layui-btn-primary';
  btn2.textContent = 'Copy all';
  host.appendChild(btn2);
  await settle();
  ok('复制按钮：文案变回「Copy all」了，焦点还是还回同一个按钮', w.document.activeElement === btn2, true);

  console.log('--- 定时刷新：字段空着时自己跳，填了值就停 ---');
  // 间隔用 50ms 而不是 1000ms：机制一样，但测试不用等一秒。
  w = await boot({ ok: true, data: { output: 'now' } }, true, {
    refresh: { field: 'date', ms: 50 },
  });
  await new Promise((r) => setTimeout(r, 300));
  ok('空着的时候自己问了好几次', w.__fetches > 1, true);
  ok(
    'Run 按钮没有闪成 Loading',
    w.document.getElementById('api-run').textContent.trim(),
    'Run'
  );

  // 填了值之后：显示的是解析出来的时刻，不该再跳。
  w.document.getElementById('f-date').value = '2023-04-12T23:10:24+02:00';
  await new Promise((r) => setTimeout(r, 200));
  const settled = w.__fetches;
  await new Promise((r) => setTimeout(r, 300));
  ok('填了值之后不再问服务端', w.__fetches, settled);

  // 清空之后：又该跳起来了（回到「现在」）。
  w.document.getElementById('f-date').value = '';
  await new Promise((r) => setTimeout(r, 300));
  ok('清空之后又开始跳', w.__fetches > settled, true);

  console.log(failures ? `\n${failures} 项不符` : '\n全部符合预期');
  process.exit(failures ? 1 : 0);
})();