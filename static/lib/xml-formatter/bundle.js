/* 由 scripts/vendor-js-libs.sh 自动生成，请勿手改。
 * 源包: package  入口: dist/cjs/index.js
 * 原文件逐个原样保留（只包了一层 module/exports/require），未做任何源码改写。 */
(function (root) {
  'use strict';
  var __modules = {};
  var __cache = {};

  /* 浏览器里没有 process，但有些包会直接摸它。yaml 的 composer 就是这么写的：
     if (process.env.LOG_STREAM) console.dir(token) —— 没加 typeof 保护，一 parse 就炸。
     它同时又用 typeof process !== 'undefined' 来判断是不是 Node，所以这个壳必须
     恰好只在「被直接访问」时兜得住。
     在闭包里定义（而不是挂到 root 上）正好满足：模块里的 process 一律指向这里，
     外面 window.process 仍然不存在。用到的能力也就 env / emitWarning 这两处，
     补一个空的 emitWarning 不存在即可 —— 与其在运行时炸，不如在这里如实反映浏览器。 */
  var process = root.process || { env: {}, versions: {}, nextTick: function (f) { setTimeout(f, 0); } };

  /* Node 的 global 同样没有别名，但浏览器里 globalThis 就是 window，直接指过去。
     @iarna/toml 到处在摸 global.Date / global.BigInt（它还留着 Node 时代的
     写法），少了这一行 parse 一个日期就炸。 */
  var global = root;

  function __norm(base, id) {
    /* 必须和生成阶段用的 path.posix.normalize 得出**同一个** id，否则注册的和查找的
       对不上。这里曾经把 out.length > 1 当成「不能弹到顶」，结果
       formatRelative/index.js 里的 require('../_lib/...') 被算成
       formatRelative/_lib/...，而生成阶段算的是 _lib/... —— 一个注册一个找不到。
       '.js' / '/index.js' 的补全规则也要和 resolveIn 一致。 */
    var parts = (base.slice(0, base.lastIndexOf('/') + 1) + id).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '' || p === '.') continue;
      if (p === '..') { if (out.length) out.pop(); continue; }
      out.push(p);
    }
    var joined = out.join('/');
    return __has(joined) ? joined : (__has(joined + '.js') ? joined + '.js' : joined + '/index.js');
  }
  function __has(id) { return Object.prototype.hasOwnProperty.call(__modules, id); }

  function __req(id) {
    if (__cache[id]) return __cache[id].exports;
    if (__alias[id]) return __req(__alias[id]);
    if (!__has(id)) throw new Error('模块未注册: ' + id);
    var m = __cache[id] = { exports: {} };
    /* 位置必须和 function (module, exports, require) 的形参一一对应：
         this         = module.exports（让包里写 this.foo = … 的代码落对地方）
         module       = 那个持有 exports 的壳 —— 必须和 exports **分开**。
                       共用同一个对象的话，包里一句 module.exports = Foo 会变成
                       往原对象上挂 .exports，最后返回的还是那个空壳
                       （randexp / date-fns / xml-formatter 全栽在这上面）。
         exports      = exports
         require      = 依赖查找
       require 里要按「先别名、再内置模块、最后才当相对路径解析」的顺序查 ——
       少一步都会把一个纯 npm 依赖错当成路径，比如 require('ret') 被当成 ./ret。 */
    __modules[id].call(m.exports, m, m.exports, function (r) {
      if (__alias[r]) return __req(__alias[r]);
      if (__builtin.indexOf(r) >= 0) return __cache[r].exports;
      return __req(__norm(id, r));
    });
    return m.exports;
  }

  /* --builtin 声明的 Node 内置模块：占位对象，但碰任何属性/构造都立刻报错。
     直接预填进 __cache，require 命中时不必真的注册模块。
     'then' 要特判成 undefined —— 有些库会无脑探测 then（Promise 同化），
     抛错会让它们误判。 */
  var __builtin = [];
  function __nodeStub(name) {
    var msg = '浏览器里没有 Node 内置模块 ' + name;
    return new Proxy(function () {}, {
      get: function (t, k) {
        if (k === 'then' || typeof k === 'symbol') return undefined;
        throw new Error(msg + '（访问 .' + String(k) + ' 时）');
      },
      construct: function () { throw new Error(msg + '（被 new 时）'); },
      apply: function () { throw new Error(msg + '（被调用时）'); }
    });
  }

  var __alias = {
    "xml-parser-xo": "xml-parser-xo/dist/cjs/index.js",
  };
  __modules["dist/cjs/index.js"] = function (module, exports, require) {
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const xml_parser_xo_1 = __importDefault(require("xml-parser-xo"));
function newLine(state) {
    if (!state.options.indentation && !state.options.lineSeparator)
        return;
    state.content += state.options.lineSeparator;
    let i;
    for (i = 0; i < state.level; i++) {
        state.content += state.options.indentation;
    }
}
function appendContent(state, content) {
    state.content += content;
}
function processNode(node, state, preserveSpace) {
    if (typeof node.content === 'string') {
        processContent(node.content, state, preserveSpace);
    }
    else if (node.type === 'Element') {
        processElementNode(node, state, preserveSpace);
    }
    else if (node.type === 'ProcessingInstruction') {
        processProcessingIntruction(node, state);
    }
    else {
        throw new Error('Unknown node type: ' + node.type);
    }
}
function processContent(content, state, preserveSpace) {
    if (!preserveSpace) {
        const trimmedContent = content.trim();
        if (state.options.lineSeparator) {
            content = trimmedContent;
        }
        else if (trimmedContent.length === 0) {
            content = trimmedContent;
        }
    }
    if (content.length > 0) {
        if (!preserveSpace && state.content.length > 0) {
            newLine(state);
        }
        appendContent(state, content);
    }
}
function processElementNode(node, state, preserveSpace) {
    if (!preserveSpace && state.content.length > 0) {
        newLine(state);
    }
    appendContent(state, '<' + node.name);
    processAttributes(state, node.attributes);
    if (node.children === null) {
        const selfClosingNodeClosingTag = state.options.whiteSpaceAtEndOfSelfclosingTag ? ' />' : '/>';
        // self-closing node
        appendContent(state, selfClosingNodeClosingTag);
    }
    else if (node.children.length === 0) {
        // empty node
        appendContent(state, '></' + node.name + '>');
    }
    else {
        const nodeChildren = node.children;
        appendContent(state, '>');
        state.level++;
        let nodePreserveSpace = node.attributes['xml:space'] === 'preserve';
        if (!nodePreserveSpace && state.options.collapseContent) {
            let containsTextNodes = false;
            let containsTextNodesWithLineBreaks = false;
            let containsNonTextNodes = false;
            nodeChildren.forEach(function (child, index) {
                if (child.type === 'Text') {
                    if (child.content.includes('\n')) {
                        containsTextNodesWithLineBreaks = true;
                        child.content = child.content.trim();
                    }
                    else if (index === 0 || index === nodeChildren.length - 1) {
                        if (child.content.trim().length === 0) {
                            // If the text node is at the start or end and is empty, it should be ignored when formatting
                            child.content = '';
                        }
                    }
                    if (child.content.trim().length > 0) {
                        containsTextNodes = true;
                    }
                }
                else if (child.type === 'CDATA') {
                    containsTextNodes = true;
                }
                else {
                    containsNonTextNodes = true;
                }
            });
            if (containsTextNodes && (!containsNonTextNodes || !containsTextNodesWithLineBreaks)) {
                nodePreserveSpace = true;
            }
        }
        nodeChildren.forEach(function (child) {
            processNode(child, state, preserveSpace || nodePreserveSpace);
        });
        state.level--;
        if (!preserveSpace && !nodePreserveSpace) {
            newLine(state);
        }
        appendContent(state, '</' + node.name + '>');
    }
}
function processAttributes(state, attributes) {
    Object.keys(attributes).forEach(function (attr) {
        const escaped = attributes[attr].replace(/"/g, '&quot;');
        appendContent(state, ' ' + attr + '="' + escaped + '"');
    });
}
function processProcessingIntruction(node, state) {
    if (state.content.length > 0) {
        newLine(state);
    }
    appendContent(state, '<?' + node.name);
    processAttributes(state, node.attributes);
    appendContent(state, '?>');
}
/**
 * Converts the given XML into human readable format.
 */
function formatXml(xml, options = {}) {
    options.indentation = 'indentation' in options ? options.indentation : '    ';
    options.collapseContent = options.collapseContent === true;
    options.lineSeparator = 'lineSeparator' in options ? options.lineSeparator : '\r\n';
    options.whiteSpaceAtEndOfSelfclosingTag = options.whiteSpaceAtEndOfSelfclosingTag === true;
    options.throwOnFailure = options.throwOnFailure !== false;
    try {
        const parsedXml = (0, xml_parser_xo_1.default)(xml, { filter: options.filter });
        const state = { content: '', level: 0, options: options };
        if (parsedXml.declaration) {
            processProcessingIntruction(parsedXml.declaration, state);
        }
        parsedXml.children.forEach(function (child) {
            processNode(child, state, false);
        });
        if (!options.lineSeparator) {
            return state.content;
        }
        return state.content
            .replace(/\r\n/g, '\n')
            .replace(/\n/g, options.lineSeparator);
    }
    catch (err) {
        if (options.throwOnFailure) {
            throw err;
        }
        return xml;
    }
}
formatXml.minify = (xml, options = {}) => {
    return formatXml(xml, Object.assign(Object.assign({}, options), { indentation: '', lineSeparator: '' }));
};
if (typeof module !== 'undefined' && typeof exports === 'object') {
    module.exports = formatXml;
}
exports.default = formatXml;
//# sourceMappingURL=index.js.map
  };
  __modules["xml-parser-xo/dist/cjs/index.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParsingError = void 0;
class ParsingError extends Error {
    constructor(message, cause) {
        super(message);
        this.cause = cause;
    }
}
exports.ParsingError = ParsingError;
let parsingState;
function nextChild() {
    return element(false) || text() || comment() || cdata() || processingInstruction();
}
function nextRootChild() {
    match(/\s*/);
    return element(true) || comment() || doctype() || processingInstruction();
}
function parseDocument() {
    const declaration = processingInstruction();
    const children = [];
    let documentRootNode;
    let child = nextRootChild();
    while (child) {
        if (child.node.type === 'Element') {
            if (documentRootNode) {
                throw new Error('Found multiple root nodes');
            }
            documentRootNode = child.node;
        }
        if (!child.excluded) {
            children.push(child.node);
        }
        child = nextRootChild();
    }
    if (!documentRootNode) {
        throw new ParsingError('Failed to parse XML', 'Root Element not found');
    }
    if (parsingState.xml.length !== 0) {
        throw new ParsingError('Failed to parse XML', 'Not Well-Formed XML');
    }
    return {
        declaration: declaration ? declaration.node : null,
        root: documentRootNode,
        children
    };
}
function processingInstruction() {
    const m = match(/^<\?([\w-:.]+)\s*/);
    if (!m)
        return;
    // tag
    const node = {
        name: m[1],
        type: 'ProcessingInstruction',
        content: ''
    };
    const endMarkerIndex = parsingState.xml.indexOf('?>');
    if (endMarkerIndex > -1) {
        node.content = parsingState.xml.substring(0, endMarkerIndex).trim();
        parsingState.xml = parsingState.xml.slice(endMarkerIndex);
    }
    else {
        throw new ParsingError('Failed to parse XML', 'ProcessingInstruction closing tag not found');
    }
    match(/\?>/);
    return {
        excluded: parsingState.options.filter(node) === false,
        node
    };
}
function element(matchRoot) {
    const m = match(/^<([^?!</>\s]+)\s*/);
    if (!m)
        return;
    // name
    const node = {
        type: 'Element',
        name: m[1],
        attributes: {},
        children: []
    };
    const excluded = matchRoot ? false : parsingState.options.filter(node) === false;
    // attributes
    while (!(eos() || is('>') || is('?>') || is('/>'))) {
        const attr = attribute();
        if (attr) {
            node.attributes[attr.name] = attr.value;
        }
        else {
            return;
        }
    }
    // self closing tag
    if (match(/^\s*\/>/)) {
        node.children = null;
        return {
            excluded,
            node
        };
    }
    match(/\??>/);
    // children
    let child = nextChild();
    while (child) {
        if (!child.excluded) {
            node.children.push(child.node);
        }
        child = nextChild();
    }
    // closing
    if (parsingState.options.strictMode) {
        const closingTag = `</${node.name}>`;
        if (parsingState.xml.startsWith(closingTag)) {
            parsingState.xml = parsingState.xml.slice(closingTag.length);
        }
        else {
            throw new ParsingError('Failed to parse XML', `Closing tag not matching "${closingTag}"`);
        }
    }
    else {
        match(/^<\/[\p{L}\p{M}\w\-:.]+\s*>/u);
    }
    return {
        excluded,
        node
    };
}
function doctype() {
    const m = match(/^<!DOCTYPE\s+\S+\s+SYSTEM[^>]*>/) ||
        match(/^<!DOCTYPE\s+\S+\s+PUBLIC[^>]*>/) ||
        match(/^<!DOCTYPE\s+\S+\s*\[[^\]]*]>/) ||
        match(/^<!DOCTYPE\s+\S+\s*>/);
    if (m) {
        const node = {
            type: 'DocumentType',
            content: m[0]
        };
        return {
            excluded: parsingState.options.filter(node) === false,
            node
        };
    }
}
function cdata() {
    if (parsingState.xml.startsWith('<![CDATA[')) {
        const endPositionStart = parsingState.xml.indexOf(']]>');
        if (endPositionStart > -1) {
            const endPositionFinish = endPositionStart + 3;
            const node = {
                type: 'CDATA',
                content: parsingState.xml.substring(0, endPositionFinish)
            };
            parsingState.xml = parsingState.xml.slice(endPositionFinish);
            return {
                excluded: parsingState.options.filter(node) === false,
                node
            };
        }
    }
}
function comment() {
    const m = match(/^<!--[\s\S]*?-->/);
    if (m) {
        const node = {
            type: 'Comment',
            content: m[0]
        };
        return {
            excluded: parsingState.options.filter(node) === false,
            node
        };
    }
}
function text() {
    const m = match(/^([^<]+)/);
    if (m) {
        const node = {
            type: 'Text',
            content: m[1]
        };
        return {
            excluded: parsingState.options.filter(node) === false,
            node
        };
    }
}
function attribute() {
    const m = match(/([^=]+)\s*=\s*("[^"]*"|'[^']*'|[^>\s]+)\s*/);
    if (m) {
        return {
            name: m[1].trim(),
            value: stripQuotes(m[2].trim())
        };
    }
}
function stripQuotes(val) {
    return val.replace(/^['"]|['"]$/g, '');
}
/**
 * Match `re` and advance the string.
 */
function match(re) {
    const m = parsingState.xml.match(re);
    if (m) {
        parsingState.xml = parsingState.xml.slice(m[0].length);
        return m;
    }
}
/**
 * End-of-source.
 */
function eos() {
    return 0 === parsingState.xml.length;
}
/**
 * Check for `prefix`.
 */
function is(prefix) {
    return 0 === parsingState.xml.indexOf(prefix);
}
/**
 * Parse the given XML string into an object.
 */
function parseXml(xml, options = {}) {
    xml = xml.trim();
    const filter = options.filter || (() => true);
    parsingState = {
        xml,
        options: Object.assign(Object.assign({}, options), { filter, strictMode: options.strictMode === true })
    };
    return parseDocument();
}
if (typeof module !== 'undefined' && typeof exports === 'object') {
    module.exports = parseXml;
}
exports.default = parseXml;
//# sourceMappingURL=index.js.map
  };
  root["xmlFormatter"] = __req("dist/cjs/index.js");
})(typeof globalThis !== 'undefined' ? globalThis : this);
