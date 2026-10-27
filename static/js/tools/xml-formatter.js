/* ==========================================================================
   XML 格式化（xml-formatter）

   把一段 XML 缩进成人类可读的格式，可选把只含文本的短元素压回一行。
   参考实现：src/tools/xml-formatter/（it-tools, GPLv3）

   ---- 库里踩到的两件事（实测）----
   1) 行尾符：xml-formatter 默认输出 CRLF（\r\n）。这里显式传 lineSeparator:'\n'
      输出 LF。理由：CRLF 是 Windows 惯例，从工具的 textarea 复制到 Unix 编辑器
      或者丢进 git diff 时会多出一堆 ^M；参考实现的 xml-formatter.vue 也是
      显式传 '\n' 的，保持一致。
   2) **它解不了 XML 声明 `<?xml ... ?>`**：直接喂进去抛
      `TypeError: Cannot convert undefined or null to object`（不是 ParsingError，
      是库内部空指针）。可现实中几乎每个 XML 文件都以它开头。所以先把开头的
      声明摘出来，格式化剩下的部分，再把声明拼回去。
      DOCTYPE（`<!DOCTYPE ...>`）同样解不了，报 ParsingError；这个不做特判——
      DOCTYPE 后面可能跟内部子集 `[ ... ]`，盲切容易切坏，原样把库的报错透出去。
   3) 反过来它的解析器**很宽松**：标签没闭合（`<a>` → `<a></a>`）、闭合标签名字
      对不上（`<a></b>` → `<a></a>`）都会自动补/吞掉，不报错。所以 isValidXml 判
      「合法」并不等于 XML 真的合法 —— 这点在 __cases 里写明了，免得以后有人
      照着「未闭合应该判非法」去改，白折腾一轮。

   ---- 与参考实现的差别 ----
   - 参考实现的 formatXml 用 withDefaultOnError 把异常吞成空串，失败时输出区
     悄悄变空白，看不出原因。这里改成解析失败时抛错，UI 显示库的原始报错。
   - indentation 必须传字符串。传数字 2 会被 toString 成 "2"，结果每个缩进层级
     是 2 个字符的「2」而不是 2 个空格（实测）。这里统一用 repeat 生成。
   - 补了下载按钮（上游 #1169）：输出区多一个 Download 按钮，把结果存成
     output.xml。下载用的是 app.js 里早就写好的 ItTools.download，
     这里只是把按钮补上（文件名与上游一致）。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('xml-formatter');

  var DEFAULT_INDENT = 2;
  var MAX_INDENT = 10;

  /** 开头的 XML 声明（PI）。非贪婪匹配到第一个 ?>。 */
  var PROLOG_RE = /^(<\?xml[\s\S]*?\?>)/i;

  /**
   * 归一化选项，拼成 xmlFormatter 认识的形状。
   * @param {{indentSize?: number, collapseContent?: boolean}} [opts]
   */
  function normalizeOptions(opts) {
    opts = opts || {};
    var n = opts.indentSize === undefined ? DEFAULT_INDENT : opts.indentSize;
    // !(n >= 0) 顺手挡掉 NaN 和非数字（select.value 万一被塞了脏东西）
    if (!(n >= 0) || n > MAX_INDENT) n = DEFAULT_INDENT;
    n = Math.floor(n);
    return {
      indentation: new Array(n + 1).join(' '),   // ' '.repeat(n) 的 ES5 写法
      collapseContent: opts.collapseContent !== false,
      lineSeparator: '\n'                        // 见文件头说明 1)
    };
  }

  /**
   * 主函数：原始 XML → 格式化后的 XML。空输入返回空串，非法输入抛错。
   * @param {string} rawXml
   * @param {{indentSize?: number, collapseContent?: boolean}} [opts]
   * @returns {string}
   */
  function formatXml(rawXml, opts) {
    var src = rawXml === null || rawXml === undefined ? '' : String(rawXml).trim();
    if (src === '') return '';

    // xml-formatter 见 xml 声明就崩，先摘出来（见文件头说明 2)）
    var prolog = '';
    var m = PROLOG_RE.exec(src);
    if (m) {
      prolog = m[1];
      src = src.slice(m[1].length).trim();
      if (src === '') return prolog;            // 只声明没正文
    }

    var out = xmlFormatter(src, normalizeOptions(opts));
    if (typeof out !== 'string') out = '';
    return prolog ? prolog + '\n' + out : out;
  }

  /**
   * 是否是能被格式化的 XML。空串算合法（对应 UI 里什么都没填）。
   * @param {string} rawXml
   * @returns {boolean}
   */
  function isValidXml(rawXml) {
    var src = rawXml === null || rawXml === undefined ? '' : String(rawXml).trim();
    if (src === '') return true;
    try { formatXml(src); return true; } catch (e) { return false; }
  }

  /* ---------- UI ---------- */

  window.ItTools.register('xml-formatter', function (root) {
    var input = D.h('textarea.layui-textarea.mono', {
      rows: 20, spellcheck: 'false', placeholder: t('input_ph', 'Paste your XML here...')
    });
    input.value = '<hello><world>foo</world><world>bar</world></hello>';  // 参考实现的默认输入
    var output = U.codeBlock();
    var error = D.h('p.field-hint', { style: { color: 'var(--danger, #d93025)' } });

    var collapseInput = D.h('input', { type: 'checkbox', checked: 'checked' });
    // 原版的缩进框是 n-input-number，宽度写死 100px（w-100px），
    // 放在左标签那一列里 —— 这里跟着给 select 同样的宽度。
    var indentSelect = D.h('select.layui-select', { style: { width: '100px', flex: '0 0 100px' } });
    for (var n = 0; n <= MAX_INDENT; n++) {
      indentSelect.appendChild(D.h('option', { value: String(n), text: String(n) }));
    }
    indentSelect.value = String(DEFAULT_INDENT);

    function render() {
      D.clear(error);
      try {
        output.value = formatXml(input.value, {
          indentSize: Number(indentSelect.value),
          collapseContent: collapseInput.checked
        });
      } catch (e) {
        output.value = '';
        error.textContent = t('err_invalid', 'Provided XML is not valid. {message}')
          // 用函数形式回填：解析器的报错里可能有 '$'，字符串替换会把它当替换模式
          .replace('{message}', function () { return e && e.message ? e.message : e; });
      }
    }

    collapseInput.addEventListener('change', render);
    indentSelect.addEventListener('change', render);
    var off = D.on(input, 'input', render);

    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    root.appendChild(D.h('div.card', null,
      // 原版顶部是两个 n-form-item，都是 label-placement="left"（标签在左、右对齐），
      // 摆在一条居中的 flex 行里；这两个 form-item 之间**没有** gap（参考实现的
      // 内层 div 只写了 `flex justify-center`，没写 gap-3）。
      // 标签列宽：原版给 "Indent size:" 写死了 label-width="100"（实测 100px），
      // "Collapse content:" 没写 label-width，naive-ui 按文字自适应 ——
      // 实测那一列 134px（文字 122px + 标签自带的 12px 右内边距）。
      D.h('div', { style: { display: 'flex', gap: '0px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '14px' } },
        D.h('div.field-row', { style: { '--field-label-width': '134px', '--field-label-align': 'right', marginBottom: '0', flex: '0 1 auto' } },
          D.h('label.field-label', { text: t('collapse_content', 'Collapse content') }),
          D.h('label.switch', null, collapseInput, D.h('span'))),
        D.h('div.field-row', { style: { '--field-label-width': '100px', '--field-label-align': 'right', marginBottom: '0', flex: '0 1 auto' } },
          D.h('label.field-label', { text: t('indent_size', 'Indent size:') }),
          indentSelect)
      ),
      U.field(t('input', 'Your XML'), input),
      error
    ));
    root.appendChild(D.h('div', null,
      D.h('div.code-label', { text: t('result', 'Formatted XML from your XML') }),
      output.card,
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-primary', {
          type: 'button', text: t('download', 'Download'), onclick: function () {
            if (output.value) {
              window.ItTools.download('output.xml', output.value, 'text/xml;charset=utf-8');
            }
          }
        })
      )
    ));
    render();

    return { destroy: function () { off(); D.clear(root); } };
  });

  window.ItTools.logic['xml-formatter'] = {
    normalizeOptions: normalizeOptions,
    formatXml: formatXml,
    isValidXml: isValidXml,
    __cases: function (assert) {
      /* ---- 参考实现那两个用例 ---- */
      assert.eq(formatXml('<hello><world>foo</world><world>bar</world></hello>', { collapseContent: false }),
        '<hello>\n  <world>\n    foo\n  </world>\n  <world>\n    bar\n  </world>\n</hello>',
        '参考实现的快照用例（展开 + 缩进 2）');
      assert.eq(formatXml('<hello><world>foo</world></hello>'), '<hello>\n  <world>foo</world>\n</hello>',
        '默认 collapseContent=true，短元素压回一行');

      /* ---- 正常值 ---- */
      assert.eq(formatXml('<a><b>1</b></a>', { collapseContent: false }), '<a>\n  <b>\n    1\n  </b>\n</a>', '基础缩进');
      assert.eq(formatXml('<a><b><c><d>1</d></c></b></a>', { collapseContent: false }),
        '<a>\n  <b>\n    <c>\n      <d>\n        1\n      </d>\n    </c>\n  </b>\n</a>', '多层嵌套');
      assert.eq(formatXml('<a><b>1</b></a>', { indentSize: 4, collapseContent: false }),
        '<a>\n    <b>\n        1\n    </b>\n</a>', '缩进 4');
      assert.eq(formatXml('<a><b>1</b></a>', { indentSize: 0, collapseContent: false }),
        '<a>\n<b>\n1\n</b>\n</a>', '缩进 0 —— 行还在，缩进没了');
      assert.eq(formatXml('<a x="1" y="2"><b>t</b></a>'), '<a x="1" y="2">\n  <b>t</b>\n</a>',
        '属性原样保留；collapse 只压「子节点全是文本」的元素，有元素子节点照样展开');
      assert.eq(formatXml('<a/>'), '<a/>', '自闭合标签');
      assert.eq(formatXml('<a>&amp;</a>'), '<a>&amp;</a>', '实体不转义');
      assert.eq(formatXml('<a><![CDATA[x]]></a>'), '<a><![CDATA[x]]></a>', 'CDATA');
      assert.eq(formatXml('<!-- c --><a/>'), '<!-- c -->\n<a/>', '注释保留在根元素之前');
      assert.eq(formatXml('<a>\n<b/>\n</a>'), '<a>\n  <b/>\n</a>', '输入里本来就带缩进，输出按配置重来');

      /* ---- XML 声明：库会崩，这里摘出来再拼回去 ---- */
      assert.eq(formatXml('<?xml version="1.0"?><a/>'), '<?xml version="1.0"?>\n<a/>', '最简声明');
      assert.eq(formatXml('<?xml version="1.0" encoding="UTF-8"?>\n<a><b>1</b></a>', { collapseContent: false }),
        '<?xml version="1.0" encoding="UTF-8"?>\n<a>\n  <b>\n    1\n  </b>\n</a>', '带 encoding 的声明');
      assert.eq(formatXml('<?xml version="1.0"?>'), '<?xml version="1.0"?>', '只有声明没有正文');

      /* ---- 输出必须是 LF，不带 \\r ---- */
      assert.eq(formatXml('<a><b>1</b></a>', { collapseContent: false }).indexOf('\r'), -1,
        '默认行尾符是 CRLF，这里换成了 LF');
      assert.eq(formatXml('<a>\n<b>1</b>\n</a>', { collapseContent: false }), '<a>\n  <b>\n    1\n  </b>\n</a>',
        '输入里本来是 CRLF，输出也统一成 LF');

      /* ---- 边界 ---- */
      assert.eq(formatXml(''), '', '空串');
      assert.eq(formatXml('   \n '), '', '纯空白');
      assert.eq(formatXml(null), '', 'null 输入');

      /* ---- normalizeOptions ---- */
      assert.eq(normalizeOptions().indentation, '  ', '默认缩进 2 个空格');
      assert.eq(normalizeOptions({ indentSize: 0 }).indentation, '', '缩进 0 得到空串');
      assert.eq(normalizeOptions({ indentSize: 99 }).indentation, '  ', '越界缩进回落到默认');
      assert.eq(normalizeOptions({ indentSize: 'x' }).indentation, '  ', '非数字缩进回落到默认');
      assert.eq(normalizeOptions({ indentSize: 3 }).indentation, '   ', '缩进 3 —— 必须是字符串，传数字 3 会被库当 "3"');
      assert.eq(normalizeOptions({ collapseContent: true }).collapseContent, true, '显式开折叠');
      assert.eq(normalizeOptions({}).collapseContent, true, '默认折叠（参考实现默认 true）');
      assert.eq(normalizeOptions({ collapseContent: false }).collapseContent, false, '显式关折叠');
      assert.eq(normalizeOptions().lineSeparator, '\n', '行尾符 LF');

      /* ---- isValidXml ---- */
      assert(isValidXml('<a><b>1</b></a>'), '合法 XML');
      assert(isValidXml(''), '空串算合法（对应什么都没填）');
      assert(isValidXml('   '), '纯空白算合法');
      assert(isValidXml('<?xml version="1.0"?><a/>'), '带声明的合法 XML');
      assert(!isValidXml('hello world'), '不是 XML');
      assert(!isValidXml('<>'), '空标签名');
      assert(!isValidXml('</a>'), '没有开标签的闭标签');
      assert(!isValidXml('<a/><b/>'), '多个根节点');
      assert(!isValidXml('<!DOCTYPE a><a/>'), 'DOCTYPE 这个库解不了（内部子集没法盲切，原样报错）');
      // 这个库的解析器很宽松：标签没闭合、闭合标签名字对不上，它都自动补/吞掉，
      // 所以「未闭合」在它眼里是合法的。记下来，免得以后有人照着
      // 参考实现去断言「未闭合应该判非法」。
      assert(isValidXml('<a>'), '库会自动补全未闭合标签，<a> 也算合法');
      assert(isValidXml('<a></b>'), '闭标签名字对不上也照样放过');
      assert.eq(formatXml('<a><b></a>', { collapseContent: true }), '<a>\n  <b></b>\n</a>', '自动补全的实际输出');

      /* ---- 错误输入必须抛错（参考实现是吞成空串）---- */
      ['hello world', '<', '<>', '</a>', '<a/><b/>', '<!DOCTYPE html><a/>'].forEach(function (bad) {
        var threw = false;
        try { formatXml(bad); } catch (e) { threw = true; }
        assert(threw, '非法输入 ' + JSON.stringify(bad) + ' 应抛错');
      });
      assert.eq(formatXml('   '), '', '纯空白走空输入分支，返回空串而不是抛错');
    }
  };
})();