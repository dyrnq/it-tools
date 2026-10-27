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
    "flex-js": "flex-js/index.js",
    "is-primitive": "is-primitive/index.js",
    "isobject": "isobject/index.js",
    "is-plain-object": "is-plain-object/index.js",
    "set-value": "set-value/index.js",
    "jsbn": "jsbn/index.js",
    "sprintf-js": "sprintf-js/src/sprintf.js",
    "ip-address": "ip-address/dist/ip-address.js",
    "ip-cidr": "ip-cidr/index.js",
    "yamljs": "yamljs/lib/Yaml.js",
    "deepmerge-ts": "deepmerge-ts/dist/node/index.cjs",
  };
  __modules["dist/cjs/index.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupportedOption = exports.MessageType = exports.ComposerizeResult = exports.listSupportedOptions = exports.composerize = void 0;
var composerize_1 = require("./composerize");
Object.defineProperty(exports, "composerize", { enumerable: true, get: function () { return composerize_1.composerize; } });
Object.defineProperty(exports, "listSupportedOptions", { enumerable: true, get: function () { return composerize_1.listSupportedOptions; } });
var types_1 = require("./types");
Object.defineProperty(exports, "ComposerizeResult", { enumerable: true, get: function () { return types_1.ComposerizeResult; } });
Object.defineProperty(exports, "MessageType", { enumerable: true, get: function () { return types_1.MessageType; } });
Object.defineProperty(exports, "SupportedOption", { enumerable: true, get: function () { return types_1.SupportedOption; } });
//# sourceMappingURL=index.js.map
  };
  __modules["dist/cjs/composerize.js"] = function (module, exports, require) {
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSupportedOptions = exports.composerize = void 0;
var parser_1 = require("./parser");
var types_1 = require("./types");
var YAML = __importStar(require("yamljs"));
var deepmerge_ts_1 = require("deepmerge-ts");
var options_1 = require("./options");
var createComposeObjectStructure = function (parseResult, composeVersion) {
    var _a;
    var composeSpecification = {};
    composeSpecification = (0, deepmerge_ts_1.deepmerge)(composeSpecification, {
        version: (Math.floor(composeVersion * 10) / 10).toString(),
        services: (_a = {},
            _a[parseResult.serviceName] = {},
            _a),
    });
    var service = {};
    parseResult.properties.forEach(function (result) { return (service = (0, deepmerge_ts_1.deepmerge)(result.value, service)); });
    // @ts-ignore
    composeSpecification['services'][parseResult.serviceName] = service;
    if (parseResult.additionalComposeObjects !== undefined) {
        parseResult.additionalComposeObjects.forEach(function (obj) { return (composeSpecification = (0, deepmerge_ts_1.deepmerge)(composeSpecification, obj)); });
    }
    return composeSpecification;
};
/**
 *
 * @param command
 * @param composeVersion
 * @param debug
 */
var composerize = function (command, composeVersion, debug) {
    if (composeVersion === void 0) { composeVersion = 3.9; }
    if (debug === void 0) { debug = false; }
    var parseResult = (0, parser_1.parse)(command, debug);
    if (debug) {
        console.log('Parse result:');
        console.log(JSON.stringify(parseResult, null, 2));
    }
    var composeSpecification = createComposeObjectStructure(parseResult, composeVersion);
    return new types_1.ComposerizeResult(YAML.stringify(composeSpecification, 9, 4), parseResult.messages);
};
exports.composerize = composerize;
/**
 * Function to return all the supported (=currently implemented) options with their corresponding docker-compose equivalent.
 */
var listSupportedOptions = function () {
    return (0, options_1.getSupportedOptions)();
};
exports.listSupportedOptions = listSupportedOptions;
//# sourceMappingURL=composerize.js.map
  };
  __modules["dist/cjs/parser.js"] = function (module, exports, require) {
"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __values = (this && this.__values) || function(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
};
var __read = (this && this.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _this = this;
Object.defineProperty(exports, "__esModule", { value: true });
exports.parse = void 0;
var flex_js_1 = __importDefault(require("flex-js"));
var options_1 = require("./options");
var types_1 = require("./types");
var util_1 = require("./util");
var cidr_1 = require("./cidr");
var set_value_1 = __importDefault(require("set-value"));
var SHORT_OPT_STATE = 'short-opt';
var LONG_OPT_STATE = 'long-opt';
var WAITING_FOR_ARGUMENT_STATE = 'waiting-for-arg';
var IMAGE_FOUND_STATE = 'image-found';
var QUOTED_STRING = 'quoted';
var ParserDto = /** @class */ (function (_super) {
    __extends(ParserDto, _super);
    function ParserDto() {
        var _this = _super !== null && _super.apply(this, arguments) || this;
        _this.lexer = new flex_js_1.default();
        _this.lastOpt = undefined;
        return _this;
    }
    ParserDto.prototype.asParseResult = function () {
        var parseResult = new types_1.ParseResult();
        parseResult.serviceName = this.serviceName;
        parseResult.properties = this.properties;
        parseResult.messages = this.messages;
        parseResult.additionalComposeObjects = this.additionalComposeObjects;
        return parseResult;
    };
    return ParserDto;
}(types_1.ParseResult));
var Pattern = {
    DOCKER_CMD: /docker (run|create)/,
    STRING: /[^="][^"'\s\t\r\n]+/,
    LONG_OPT_VALUE: /[a-z][a-z0-9\-]+/,
    IMAGE_NAME: /(?:(?=[^:\/]{1,253})(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*(?::[0-9]{1,5})?\/)?((?![._-])(?:[a-z0-9._-]*)(?<![._-])(?:\/(?![._-])[a-z0-9._-]*(?<![._-]))*)(?::(?![.-])[a-zA-Z0-9_.-]{1,128})?/,
    QUOTE_CHAR: /"/,
    LONG_OPT: /--/,
    SHORT_OPT: /-/,
    CHAR: /./,
    WS: /\s+/,
    WS_OR_EQUALS: /{WS}|=/,
};
var prepareInput = function (input) {
    return input.replace(/'/g, '"');
};
var processOption = function (parserDto) {
    var opt = (0, options_1.getOption)(parserDto.lexer.text);
    parserDto.lastOpt = opt;
    if (opt === undefined) {
        parserDto.messages.push({
            type: types_1.MessageType.errorDuringConversion,
            value: "Unknown option: ".concat(parserDto.lexer.text),
        });
    }
    else {
        if (opt.type === types_1.OptionType.withArgs) {
            parserDto.lexer.pushState(WAITING_FOR_ARGUMENT_STATE);
        }
        else {
            var result = opt.action.call(_this, opt, parserDto.lexer);
            if (result !== undefined) {
                if ((0, util_1.isResult)(result)) {
                    parserDto.properties.push(result);
                    if (result.additionalObject !== undefined) {
                        parserDto.additionalComposeObjects.push(result.additionalObject);
                    }
                }
                else {
                    parserDto.messages.push(result);
                }
            }
        }
    }
};
var processArgument = function (value, parserDto) {
    if (parserDto.lastOpt === undefined) {
        parserDto.messages.push({
            type: types_1.MessageType.errorDuringConversion,
            value: "Error while parsing. Got option value '".concat(value, "' 'but no option the value belongs to."),
        });
        return;
    }
    var result = parserDto.lastOpt.action.call(_this, parserDto.lastOpt, value, parserDto.lexer);
    if (result !== undefined) {
        if ((0, util_1.isResult)(result)) {
            parserDto.properties.push(result);
            if (result.additionalObject !== undefined) {
                parserDto.additionalComposeObjects.push(result.additionalObject);
            }
        }
        else {
            parserDto.messages.push(result);
        }
    }
};
var prepareLexer = function (debug) {
    var e_1, _a;
    var parserDto = new ParserDto();
    var lexer = parserDto.lexer;
    var properties = parserDto.properties;
    // options
    lexer.setIgnoreCase(false);
    lexer.setDebugEnabled(debug);
    // states
    lexer.addState(QUOTED_STRING, true);
    lexer.addState(SHORT_OPT_STATE, true);
    lexer.addState(LONG_OPT_STATE, true);
    lexer.addState(WAITING_FOR_ARGUMENT_STATE, true);
    lexer.addState(IMAGE_FOUND_STATE, true);
    try {
        // definitions
        for (var _b = __values(Object.entries(Pattern)), _c = _b.next(); !_c.done; _c = _b.next()) {
            var _d = __read(_c.value, 2), name = _d[0], regexp = _d[1];
            lexer.addDefinition(name, regexp);
        }
    }
    catch (e_1_1) { e_1 = { error: e_1_1 }; }
    finally {
        try {
            if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
        }
        finally { if (e_1) throw e_1.error; }
    }
    // rules
    // Commands always begin with "docker run" or "docker create"
    lexer.addRule(Pattern.DOCKER_CMD);
    // ignore Whitespaces
    lexer.addRule(Pattern.WS);
    // Recognize short options
    lexer.addRule(Pattern.SHORT_OPT, function (lexer) { return lexer.begin(SHORT_OPT_STATE); });
    // Recognize long options
    lexer.addRule(Pattern.LONG_OPT, function (lexer) { return lexer.begin(LONG_OPT_STATE); });
    // Handle quoted strings
    var str = '';
    lexer.addStateRule(WAITING_FOR_ARGUMENT_STATE, Pattern.QUOTE_CHAR, function (lexer) { return lexer.pushState(QUOTED_STRING); });
    lexer.addStateRule(QUOTED_STRING, Pattern.QUOTE_CHAR, function (lexer) {
        lexer.popState();
        var token = str;
        str = '';
        if (lexer.state == WAITING_FOR_ARGUMENT_STATE) {
            processArgument(token, parserDto);
            lexer.begin(flex_js_1.default.STATE_INITIAL);
        }
    });
    lexer.addStateRule(QUOTED_STRING, /[^\n\"]+/, function (lexer) {
        str += lexer.text;
    });
    // Rules to process short options
    lexer.addStateRule(SHORT_OPT_STATE, Pattern.WS, function (lexer) { return lexer.begin(flex_js_1.default.STATE_INITIAL); });
    lexer.addStateRule(SHORT_OPT_STATE, Pattern.CHAR, function () { return processOption(parserDto); });
    // Rules to process long options
    lexer.addStateRule(LONG_OPT_STATE, Pattern.LONG_OPT_VALUE, function () { return processOption(parserDto); });
    lexer.addStateRule(LONG_OPT_STATE, Pattern.WS, function (lexer) { return lexer.begin(flex_js_1.default.STATE_INITIAL); });
    // Process the arguments for an option
    lexer.addStateRule(WAITING_FOR_ARGUMENT_STATE, Pattern.WS_OR_EQUALS);
    lexer.addStateRule(WAITING_FOR_ARGUMENT_STATE, Pattern.STRING, function (lexer) {
        processArgument(lexer.text.trim(), parserDto);
        lexer.begin(flex_js_1.default.STATE_INITIAL);
    });
    lexer.addStateRule(WAITING_FOR_ARGUMENT_STATE, Pattern.CHAR, function () {
        parserDto.messages.push({
            type: types_1.MessageType.errorDuringConversion,
            // @ts-ignore
            value: "The option \"--".concat(parserDto.lastOpt.name).concat(
            // @ts-ignore
            parserDto.lastOpt.short !== undefined ? '/-' + parserDto.lastOpt.short : '', "\""),
        });
    });
    // Recognize image
    lexer.addStateRule(flex_js_1.default.STATE_INITIAL, Pattern.IMAGE_NAME, function (lexer) {
        lexer.begin(IMAGE_FOUND_STATE);
        var imageName = lexer.text;
        parserDto.serviceName = getServiceName(imageName);
        var valueToSet = {};
        (0, set_value_1.default)(valueToSet, 'image', imageName);
        properties.push({
            path: 'image',
            value: valueToSet,
            multiValue: false,
            additionalObject: undefined,
        });
    });
    // Get docker command
    lexer.addStateRule(IMAGE_FOUND_STATE, / .*/, function (lexer) {
        var valueToSet = {};
        (0, set_value_1.default)(valueToSet, 'command', lexer.text.trim());
        properties.push({
            path: 'command',
            value: valueToSet,
            multiValue: false,
            additionalObject: undefined,
        });
        lexer.terminate();
    });
    return parserDto;
};
var tokenize = function (lexer, input) {
    lexer.setSource(input);
    lexer.lexAll();
};
var postProcessNetworkOption = function (dto) {
    var _a;
    var network = dto.properties.find(function (result) { return result.path === 'networks'; });
    var networkName = 'default';
    if (network !== undefined) {
        // @ts-ignore
        networkName = Object.keys(network.value['networks'])[0];
        // custom network name present
        var networkRelatedProperties_1 = dto.properties.filter(function (result) { return result.path.startsWith('networks') && result.path !== 'networks'; });
        networkRelatedProperties_1.forEach(function (result) {
            // @ts-ignore
            var obj = result.value['networks'];
            // @ts-ignore
            Object.defineProperty(obj, networkName, Object.getOwnPropertyDescriptor(obj, 'default'));
            delete obj['default'];
        });
    }
    var specificIpAddresses = [];
    var networkRelatedProperties = dto.properties.filter(function (result) { return result.path.startsWith('networks') && result.path !== 'networks'; });
    networkRelatedProperties.forEach(function (result) {
        if (result.path.includes('ipv4_address')) {
            // @ts-ignore
            specificIpAddresses.push(result.value.networks[networkName].ipv4_address + '/24');
        }
        if (result.path.includes('ipv6_address')) {
            // @ts-ignore
            specificIpAddresses.push(result.value.networks[networkName].ipv6_address + '/64');
        }
    });
    if (specificIpAddresses.length > 0) {
        var additionalNetworkConfig_1 = {
            networks: (_a = {},
                _a[networkName] = {
                    driver: 'default',
                    config: [],
                },
                _a),
        };
        specificIpAddresses.forEach(function (address) {
            // @ts-ignore
            additionalNetworkConfig_1.networks[networkName].config.push({ subnet: getCidr(address) });
        });
        dto.additionalComposeObjects.push(additionalNetworkConfig_1);
    }
};
var getCidr = function (ip) {
    return (0, cidr_1.normalize)("".concat(ip));
};
var getServiceName = function (image) {
    var name = image.includes('/') ? image.split('/')[1] : image;
    name = name.includes(':') ? name.split(':')[0] : name;
    return name;
};
var parse = function (command, debug) {
    var preparedInput = prepareInput(command);
    var parserDto = prepareLexer(debug);
    tokenize(parserDto.lexer, preparedInput);
    postProcessNetworkOption(parserDto);
    return parserDto.asParseResult();
};
exports.parse = parse;
//# sourceMappingURL=parser.js.map
  };
  __modules["flex-js/index.js"] = function (module, exports, require) {
module.exports = require('./src/Lexer.js');

  };
  __modules["flex-js/src/Lexer.js"] = function (module, exports, require) {
(function (root) {
'use strict';

var ASCII_LIMIT = 128;
var NEWLINE = 10;

// escapes that carry braces of their own, such as \p{L} and \u{1F600}
var BRACED_ESCAPE = '\\\\[pPuk]\\{[^}]*\\}';

/**
 * console.log ends every call with a newline, so text is held back until one
 * arrives and the scanner's own line breaks decide where lines fall.
 */
function consoleOutput() {
  var pending = '';

  return {
    write: function (text) {
      pending += text;
      var lastBreak = pending.lastIndexOf('\n');
      if (lastBreak !== -1) {
        console.log(pending.slice(0, lastBreak));
        pending = pending.slice(lastBreak + 1);
      }
    },
    flush: function () {
      if (pending) {
        console.log(pending);
        pending = '';
      }
    }
  };
}

function defaultOutput() {
  if (typeof process !== 'undefined' && process.stdout &&
    typeof process.stdout.write === 'function') {
    return process.stdout;
  }

  return consoleOutput();
}

function toCharCodes(text) {
  var codes = [];

  for (var index = 0; index < text.length; index++) {
    codes.push(text.charCodeAt(index));
  }

  return codes;
}

function isAscii(text) {
  for (var index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) >= ASCII_LIMIT) {
      return false;
    }
  }

  return true;
}

// flex reads "$" as the trailing context "/\n"
var TRAILING_NEWLINE = '(?=\\n)';

/**
 * FLEX.JS - FLEX-like lexer.
 *
 * @class Lexer
 */
function Lexer() {
  this.clear();
}

Lexer.prototype.idRegExp = /^[a-z_][a-z0-9_-]*$/i;

/**
 * Line of the first character of the current token, counting from one.
 *
 * @return {number} Line number.
 *
 * @public
 */
Lexer.prototype.getLine = function () {
  return this.getLineAt(this.tokenStart) + 1;
};

/**
 * Column of the first character of the current token, counting from one.
 *
 * @return {number} Column number.
 *
 * @public
 */
Lexer.prototype.getColumn = function () {
  var line = this.getLineAt(this.tokenStart);
  return this.tokenStart - this.getLineOffsets()[line] + 1;
};

/**
 * End of file indicator.
 *
 * @const
 * @public
 */
Lexer.EOF = 0;

/**
 * Default initial inclusive state name.
 *
 * @const
 * @public
 */
Lexer.STATE_INITIAL = 'INITIAL';

/**
 * State name reserved to match with any inclusive/exclusive state.
 *
 * @const
 * @public
 */
Lexer.STATE_ANY = '*';

/**
 * Rule indicating EOF.
 *
 * @const
 * @public
 */
Lexer.RULE_EOF = '<<EOF>>';

/**
 * Reset lexer state but keep configuration.
 *
 * @public
 */
Lexer.prototype.reset = function () {
  this.source = '';
  this.index = 0;
  this.text = undefined;
  this.state = Lexer.STATE_INITIAL;

  this.tokenStart = 0;
  this.lineOffsets = null;
  this.ruleIndex = undefined;
  this.readMore = false;
  this.stateStack = [];
  this.rejectedRules = [];
};

/**
 * Reset lexer configuration and internal state.
 *
 * @public
 */
Lexer.prototype.clear = function () {
  // bare maps so an inherited name is never mistaken for a registered entry
  this.states = Object.create(null);
  this.definitions = Object.create(null);
  this.rules = {};
  this.dispatches = {};
  this.scanState = null;
  this.output = defaultOutput();
  this.ignoreCase = false;
  this.unicode = false;
  this.unicodeDefinition = false;
  this.debugEnabled = false;
  this.defaultRuleEnabled = true;

  this.addState(Lexer.STATE_INITIAL);

  this.reset();
};

/**
 * Set ignore case mode.
 *
 * By default it is case sensitie.
 *
 * @param {boolean} ignoreCase
 *
 * @public
 */
Lexer.prototype.setIgnoreCase = function (ignoreCase) {
  this.ignoreCase = ignoreCase;
};

/**
 * Compile rules as unicode expressions, off by default.
 *
 * A pattern unicode mode refuses, an escaped dash outside a character class
 * for instance, keeps its ordinary meaning rather than failing.
 *
 * Turning it off is refused once a definition carrying "u" is declared, since
 * that body would then be read as ASCII.
 *
 * @param {boolean} unicode
 *
 * @public
 */
Lexer.prototype.setUnicode = function (unicode) {
  if (!unicode && this.unicodeDefinition) {
    throw new Error('Unicode cannot be turned off while a definition carrying "u" is declared');
  }

  this.unicode = unicode;
};

/**
 * Set debug enabled.
 *
 * By default it is disabled.
 *
 * @param {boolean} debugEnabled
 *
 * @public
 */
Lexer.prototype.setDebugEnabled = function (debugEnabled) {
  this.debugEnabled = debugEnabled;
};

/**
 * Set whether input matching no rule is echoed, as FLEX does by default.
 *
 * With the default rule off, such input raises an error instead, which is
 * FLEX's "%option nodefault".
 *
 * @param {boolean} defaultRuleEnabled
 *
 * @public
 */
Lexer.prototype.setDefaultRuleEnabled = function (defaultRuleEnabled) {
  this.defaultRuleEnabled = defaultRuleEnabled;
};

/**
 * Set where echo() writes, FLEX's yyout.
 *
 * @param {object|function} output  Anything with a write method, a writable
 *                                  stream for instance, or a function taking
 *                                  the text.
 *
 * @public
 */
Lexer.prototype.setOutput = function (output) {
  if (typeof output === 'function') {
    output = { write: output };
  }

  if (!output || typeof output.write !== 'function') {
    throw new Error('Invalid output: should be a function or have a write method');
  }

  this.output = output;
};

/**
 * Add additional state.
 *
 * @param {string}  name        State name, case sensitive.
 * @param {boolean} [exclusive]
 *
 * @public
 */
Lexer.prototype.addState = function (name, exclusive) {
  // a state name also keys this.rules and this.dispatches, which are plain
  if (typeof name !== 'string' || !this.idRegExp.test(name) || name in Object.prototype) {
    throw new Error('Invalid state name "' + name + '"');
  }

  this.states[name] = { name: name, exclusive: !!exclusive };
};

/**
 * @private
 */
Lexer.prototype.getInclusiveStateNames = function () {
  var names = [];

  for (var name in this.states) {
    if (!this.states[name].exclusive) {
      names.push(name);
    }
  }

  return names;
};

/**
 * Add definition.
 *
 * @param {string}        name        Definition name, case sensitive.
 * @param {string|RegExp} expression  Expression, "u" is the only flag allowed.
 *
 * @public
 */
Lexer.prototype.addDefinition = function (name, expression) {
  if (typeof name !== 'string' || !this.idRegExp.test(name)) {
    throw new Error('Invalid definition name "' + name + '"');
  }

  if (typeof expression === 'string') {
    if (expression.length === 0) {
      throw new Error('Empty expression for definition "' + name + '"');
    }
    expression = this.escapeRegExp(expression);
  } else if (expression instanceof RegExp) {
    if (expression.source === '(?:)') {
      throw new Error('Empty expression for definition "' + name + '"');
    }
    if (expression.flags !== '' && expression.flags !== 'u') {
      throw new Error('Expression flags besides "u" are not supported for definition expressions');
    }
    if (expression.flags === 'u') {
      if (!this.unicode) {
        throw new Error('Definition "' + name + '" carries "u", so setUnicode(true) must come first');
      }
      this.unicodeDefinition = true;
    }
    expression = expression.source;
  } else {
    throw new Error('Invalid expression for definition "' + name + '"');
  }

  this.definitions[name] = this.expandDefinitions(expression);
};

/**
 * Add state-specific rule.
 *
 * Action return value 0 is reserved for TERMINATE action.
 * Action return value undefined is reserved for DISCARD action.
 * Any other value could be used as return value from action as token.
 *
 * @param {string[]|string} states      Single state or state array, case sensitive.
 * @param {string|RegExp}   expression  Expression, can use flags and definitions.
 * @param {function}        [action]    Default action is DISCARD.
 *
 * @public
 */
Lexer.prototype.addStateRule = function (states, expression, action) {
  var isUnqualified = states === undefined || states === null;

  if (isUnqualified) {
    states = this.getInclusiveStateNames();
  } else if (states === Lexer.STATE_ANY) {
    states = Object.keys(this.states);
  } else if (typeof states === 'string') {
    states = [states];
  }

  // drop empty names, and any state named twice, which would file the rule twice
  states = states.filter(function (state, index) {
    return !!state && states.indexOf(state) === index;
  });

  // validate if we have at least one state to add rule into
  if (!states.length) {
    throw new Error('Unable to add rule to empty list of states');
  }

  // do not allow to add rules into not registered states
  var notRegisteredStates = states.reduce(function (acc, state) {
    if (!this.states[state]) {
      acc.push(state);
    }
    return acc;
  }.bind(this), []);
  if (notRegisteredStates.length) {
    throw new Error('Unable to register rule within unregistered state(s): ' + notRegisteredStates.join(', '));
  }

  var source;
  var flags;
  var fixedWidth;
  var literal;

  if (expression === Lexer.RULE_EOF) {
    source = null;
  } else if (typeof expression === 'string') {
    if (expression.length === 0) {
      throw new Error('Empty expression for rule used in states "' + states.join(', ') + '"');
    }
    source = this.escapeRegExp(expression);
    fixedWidth = expression.length;
    flags = '';
    literal = expression;
  } else if (expression instanceof RegExp) {
    if (expression.source === '(?:)') {
      throw new Error('Empty expression for rule used in states "' + states.join(', ') + '"');
    }
    if (expression.flags !== '') {
      var notSupportedFlags = expression.flags
        .split('')
        .filter(function (flag) {
          return flag !== 'i' && flag !== 'u';
        });
      if (notSupportedFlags.length) {
        throw new Error('Expression flags besides "i" and "u" are not supported');
      }
    }
    source = expression.source;
    flags = expression.flags;
  } else {
    throw new Error('Invalid rule expression "' + expression + '"');
  }

  if (action && typeof action !== 'function') {
    throw new Error('Invalid rule action: should be function or empty');
  }

  var isEOF = source === null;
  var expandedSource = isEOF ? '' : this.expandDefinitions(source);
  var compiledExpression = isEOF ? null : this.compileRuleExpression(expandedSource, flags);

  // regard "i" as ASCII case folding, which it is for an ASCII literal
  var foldsCase = compiledExpression !== null && compiledExpression.ignoreCase;
  var comparable = literal !== undefined && (!foldsCase || isAscii(literal));

  var classTables = isEOF ? null : this.getCharClassTables(compiledExpression);

  var rule = {
    expression: compiledExpression,
    isEOF: isEOF,
    isFallbackEOF: isEOF && isUnqualified,
    trailingContextWidth: isEOF ? 0 : this.getTrailingContextWidth(expandedSource),
    firstCharCodes: isEOF ? null : this.getFirstCharCodes(compiledExpression),
    literalLower: comparable ? toCharCodes(foldsCase ? literal.toLowerCase() : literal) : null,
    literalUpper: comparable ? toCharCodes(foldsCase ? literal.toUpperCase() : literal) : null,
    action: action,
    fixedWidth: fixedWidth === undefined ? Infinity : fixedWidth,
    classHead: classTables === null ? null : classTables.head,
    classTail: classTables === null ? null : classTables.tail
  };

  for (var index = 0; index < states.length; index++) {
    var state = states[index];
    if (!this.rules[state]) {
      this.rules[state] = [];
    }
    this.rules[state].push(rule);
  }

  this.dispatches = {};
  this.scanState = null;
};

/**
 * Add multiple rules into one or more states at once.
 *
 * @param {string[]|string} states      Single state or state array, case sensitive.
 * @param {Array}          rules       Each item should have expression and action keys.
 *
 * @public
 */
Lexer.prototype.addStateRules = function (states, rules) {
  for (var index = 0; index < rules.length; index++) {
    this.addStateRule(states, rules[index].expression, rules[index].action);
  }
};

/**
 * Add rule without explicit state.
 *
 * Based on inclusive/exclusive state option it could be available within any state
 * or within specific states.
 *
 * @param {string|RegExp} expression
 * @param {function}      [action]    Default action is DISCARD.
 *
 * @public
 */
Lexer.prototype.addRule = function (expression, action) {
  this.addStateRule(undefined, expression, action);
};

/**
 * Add multiple rules without explicit state.
 *
 * @param {Array}          rules       Each item should have expression and action keys.
 *
 * @public
 */
Lexer.prototype.addRules = function (rules) {
  this.addStateRules(undefined, rules);
};

/**
 * Set source text string to lex.
 *
 * @param {string} source
 *
 * @public
 */
Lexer.prototype.setSource = function (source) {
  if (typeof source !== 'string') {
    throw new Error('Invalid source: should be a string');
  }

  this.source = source;
  this.index = 0;
  this.tokenStart = 0;
  this.lineOffsets = null;
};

/**
 * Run lexer until end or until token will be found.
 *
 * @return Either EOF {@link Lexer.EOF} or specific token produced by action.
 *
 * @public
 */
Lexer.prototype.lex = function () {
  var result;

  do {
    result = this.scan();
  } while (result === undefined);

  return result;
};

/**
 * Run lexer until end, collect all tokens into array and return it.
 *
 * @return {Array} Array of tokens.
 *
 * @public
 */
Lexer.prototype.lexAll = function () {
  var result = [];
  var token;
  for (;;) {
    token = this.scan();
    if (token === undefined) {
      continue;
    }
    if (token === Lexer.EOF) {
      return result;
    }
    result.push(token);
  }
};

/**
 * DISCARD action.
 *
 * @public
 */
Lexer.prototype.discard = function () {
  return undefined;
};

/**
 * ECHO action.
 *
 * @public
 */
Lexer.prototype.echo = function () {
  this.output.write(this.text);
};

/**
 * BEGIN action.
 *
 * @param {string} [newState] Default is INITIAL state.
 *
 * @public
 */
Lexer.prototype.begin = function (newState) {
  if (newState === undefined) {
    newState = Lexer.STATE_INITIAL;
  }
  if (!this.states[newState]) {
    throw new Error('State "' + newState + '" is not registered');
  }
  this.state = newState;
};

/**
 * REJECT action.
 *
 * @public
 */
Lexer.prototype.reject = function () {
  this.rejectedRules.push(this.ruleIndex);
};

/**
 * MORE action.
 *
 * @public
 */
Lexer.prototype.more = function () {
  this.readMore = true;
};

/**
 * LESS action.
 *
 * @param {number} n
 *
 * @public
 */
Lexer.prototype.less = function (n) {
  // a negative length would push the scanner behind where the token started
  if (n < 0) {
    throw new Error('Invalid length: should not be negative');
  }

  if (n > this.text.length) {
    return;
  }
  this.index -= this.text.length - n;
  this.text = this.text.substr(0, n);
};

/**
 * UNPUT action.
 *
 * @param {string} s
 *
 * @public
 */
Lexer.prototype.unput = function (s) {
  this.source = this.source.substr(0, this.index) + s + this.source.substr(this.index);
  this.lineOffsets = null;
};

/**
 * INPUT action.
 *
 * @param {number} n
 *
 * @return String read from current position (up to N characters).
 *
 * @public
 */
Lexer.prototype.input = function (n) {
  var value = this.source.substr(this.index, n === undefined ? 1 : n);
  this.index += value.length;
  return value;
};

/**
 * TERMINATE action.
 *
 * @public
 */
Lexer.prototype.terminate = function () {
  if (typeof this.output.flush === 'function') {
    this.output.flush();
  }
  this.reset();
  return Lexer.EOF;
};

/**
 * RESTART action.
 *
 * @public
 */
Lexer.prototype.restart = function (newSource) {
  if (newSource !== undefined) {
    if (typeof newSource !== 'string') {
      throw new Error('Invalid source: should be a string');
    }
    this.source = newSource;
    this.lineOffsets = null;
  }
  this.index = 0;
  this.tokenStart = 0;
};

/**
 * Pust State.
 *
 * @param {string} newState
 *
 * @public
 */
Lexer.prototype.pushState = function (newState) {
  if (!this.states[newState]) {
    throw new Error('State "' + newState + '" is not registered');
  }
  this.stateStack.push(this.state);
  this.begin(newState);
};

/**
 * Get top state.
 *
 * @return {string} top state
 *
 * @public
 */
Lexer.prototype.topState = function () {
  if (!this.stateStack.length) {
    return undefined;
  }
  return this.stateStack[this.stateStack.length - 1];
};

/**
 * Pop state.
 *
 * @public
 */
Lexer.prototype.popState = function () {
  if (!this.stateStack.length) {
    throw new Error('Unable to pop state');
  }
  var oldState = this.stateStack.pop();
  this.begin(oldState);
};

/**
 * Switch state.
 *
 * @param {string} [newState] Switch to specific state or initial if omitted.
 *
 * @public
 */
Lexer.prototype.switchState = function (newState) {
  this.begin(newState);
};

/**
 * Scan for one token.
 *
 * @private
 */
Lexer.prototype.scan = function () {
  var isEOF = this.index >= this.source.length;

  var matchedRule;
  var matchedIndex;
  var matchedValue = '';
  var matchedEnd = 0;
  var matchedValueLength = 0; // could be 1 char more than matchedValue for expressions with $ at end

  var state = this.state;
  if (state !== this.scanState) {
    this.scanState = state;
    this.scanRules = this.rules[state] || [];
    this.scanDispatch = this.getDispatch(state);
  }
  var rules = this.scanRules;
  var dispatch = this.scanDispatch;
  var rejectedRules = this.rejectedRules;
  var hasRejected = rejectedRules.length !== 0;
  var source = this.source;
  var sourceLength = source.length;
  var position = this.index;

  var candidates;
  if (isEOF) {
    candidates = dispatch.eof;
  } else {
    var charCode = source.charCodeAt(position);
    candidates = charCode < ASCII_LIMIT ? dispatch.byCharCode[charCode] : dispatch.nonAscii;
  }

  var candidateCount = candidates.length;
  for (var candidate = 0; candidate < candidateCount; candidate++) {
    var ruleIndex = candidates[candidate];
    if (hasRejected && rejectedRules.indexOf(ruleIndex) !== -1) {
      continue;
    }

    var rule = rules[ruleIndex];

    if (isEOF) {
      matchedRule = rule;
      matchedIndex = ruleIndex;
      // no need to search for other EOF rules
      break;
    }

    if (rule.fixedWidth <= matchedValueLength) {
      continue;
    }

    var matchEnd;

    var head = rule.classHead;
    if (head !== null) {
      if (charCode >= ASCII_LIMIT || head[charCode] !== 1) {
        continue;
      }
      matchEnd = position + 1;
      var tail = rule.classTail;
      if (tail !== null) {
        var next;
        while (matchEnd < sourceLength && (next = source.charCodeAt(matchEnd)) < ASCII_LIMIT && tail[next] === 1) {
          matchEnd++;
        }
      }
    } else if (rule.literalLower !== null) {
      if (!this.matchesLiteral(rule, position)) {
        continue;
      }
      matchEnd = position + rule.literalLower.length;
    } else {
      var expression = rule.expression;
      expression.lastIndex = position;
      // test() leaves the end in lastIndex without building a match array
      if (!expression.test(source)) {
        continue;
      }
      matchEnd = expression.lastIndex;
    }

    var curMatchLength = matchEnd - position + rule.trailingContextWidth;
    if (curMatchLength > matchedValueLength) {
      matchedRule = rule;
      matchedIndex = ruleIndex;
      matchedEnd = matchEnd;
      matchedValueLength = curMatchLength;
    }
  }

  if (matchedRule && !isEOF) {
    matchedValue = source.substring(position, matchedEnd);
  }

  if (matchedRule && this.debugEnabled) {
    this.logAccept(this.state, matchedRule.expression, matchedValue);
  }

  this.ruleIndex = matchedIndex;
  var carriedText = this.readMore ? this.text : '';
  var carriedMore = this.readMore;
  if (!carriedMore) {
    this.tokenStart = this.index;
  }
  this.text = carriedText;
  this.readMore = false;

  if (!matchedRule) {
    if (!isEOF) {
      this.text += this.source.charAt(this.index);
      if (!this.defaultRuleEnabled) {
        this.error('scanner jammed');
      }
      this.index++;
      return this.echo();
    } else {
      this.text = '';
      return this.terminate();
    }
  }

  this.text = carriedText + matchedValue;
  this.index += matchedValue.length;

  var rejectedBefore = this.rejectedRules.length;
  var actionResult = matchedRule.action ? matchedRule.action(this) : this.discard();
  var hasRejection = this.rejectedRules.length > rejectedBefore;

  // reset reject state if there is no rejection in last action
  if (hasRejection) {
    this.index -= matchedValue.length;
    this.text = carriedText;
    this.readMore = carriedMore;
    // ignore result if there is rejection in action
    return;
  }

  if (rejectedRules.length) {
    this.rejectedRules = [];
  }

  // rule action could change buffer or position, so EOF state could be changed too
  // we need revalidate EOF only if EOF was identified before action were executed
  if (isEOF) {
    isEOF = this.index >= this.source.length;
  }

  return isEOF ? this.terminate() : actionResult;
};

/**
 * Report a message against the position the current token starts at, in the
 * shape a compiler front end would print.
 *
 * @param {string} message
 *
 * @public
 */
Lexer.prototype.error = function (message) {
  var line = this.getLine();
  var column = this.getColumn();

  var error = new Error(message + ' at line ' + line + ', column ' + column);

  error.line = line;
  error.column = column;
  error.text = this.text;

  throw error;
};

/**
 * Offset at which every line of the source begins, built once per source.
 *
 * @private
 */
Lexer.prototype.getLineOffsets = function () {
  if (this.lineOffsets === null) {
    var offsets = [0];

    for (var index = 0; index < this.source.length; index++) {
      if (this.source.charCodeAt(index) === NEWLINE) {
        offsets.push(index + 1);
      }
    }

    this.lineOffsets = offsets;
  }

  return this.lineOffsets;
};

/**
 * Zero based line holding the given position.
 *
 * @private
 */
Lexer.prototype.getLineAt = function (position) {
  var offsets = this.getLineOffsets();
  var low = 0;
  var high = offsets.length - 1;

  while (low < high) {
    var middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
};

/**
 * @private
 */
Lexer.prototype.logAccept = function (state, expression, value) {
  console.log(
    ' - [' + state + '] accepting rule'+
    ' /' + this.encodeString(expression.source) + '/' +
    ' ("' + this.encodeString(value) + '")'
  );
}

/**
 * @private
 */
Lexer.prototype.encodeString = function (s) {
  return s.replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\0/g, '\\0');
};

/**
 * @private
 */
Lexer.prototype.expandDefinitions = function (source) {
  for (var name in this.definitions) {
    var body = '(?:' + this.definitions[name] + ')';
    var reference = new RegExp(BRACED_ESCAPE + '|\\{' + name + '\\}', 'g');
    source = source.replace(reference, function (match) {
      // an escape matched first, so its braces are its own
      return match.charAt(0) === '\\' ? match : body;
    });
  }
  return source;
};

/**
 * @private
 */
Lexer.prototype.compileRuleExpression = function (source, flags) {
  if (this.getTrailingContextWidth(source)) {
    source = source.slice(0, -1) + TRAILING_NEWLINE;
  }

  if (this.ignoreCase && flags.indexOf('i') === -1) {
    flags += 'i';
  }

  // sticky flag required for engine to work
  // multiline flag required to be able to match line start
  if (this.unicode && flags.indexOf('u') === -1) {
    try {
      return new RegExp(source, flags + 'uym');
    } catch (error) {
      // unicode mode refuses some patterns it has no need to, an escaped dash
      // outside a character class among them; those keep their old meaning
    }
  }

  return new RegExp(source, flags + 'ym');
};

/**
 * @private
 */
Lexer.prototype.escapeRegExp = function (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Width of a rule's trailing context, which counts toward the longest match
 * even though it is not consumed. Only a trailing "$" is supported, standing
 * for one newline. "^" is a position, not trailing context, and adds nothing.
 *
 * @private
 */
Lexer.prototype.getTrailingContextWidth = function (source) {
  if (source.charAt(source.length - 1) !== '$') {
    return 0;
  }

  var backslashes = 0;
  for (var index = source.length - 2; index >= 0 && source.charAt(index) === '\\'; index--) {
    backslashes++;
  }

  return backslashes % 2 === 0 ? 1 : 0;
};

/**
 * @private
 */
Lexer.prototype.matchesLiteral = function (rule, index) {
  var lower = rule.literalLower;
  var upper = rule.literalUpper;
  var source = this.source;

  for (var offset = 0; offset < lower.length; offset++) {
    var code = source.charCodeAt(index + offset);
    if (code !== lower[offset] && code !== upper[offset]) {
      return false;
    }
  }

  return true;
};

/**
 * @private
 */
Lexer.prototype.getDispatch = function (state) {
  var dispatch = this.dispatches[state];
  if (!dispatch) {
    dispatch = this.dispatches[state] = this.buildDispatch(this.rules[state] || []);
  }
  return dispatch;
};

/**
 * Index rules by the characters a match can start with, so that a scan only
 * tries the rules that can possibly apply. Declaration order is preserved
 * within every bucket, keeping longest-match ties on the earliest rule.
 *
 * @private
 */
Lexer.prototype.buildDispatch = function (rules) {
  var byCharCode = new Array(ASCII_LIMIT);
  var nonAscii = [];
  var eof = [];
  var fallbackEof = [];
  var charCode;

  for (charCode = 0; charCode < ASCII_LIMIT; charCode++) {
    byCharCode[charCode] = [];
  }

  for (var index = 0; index < rules.length; index++) {
    var rule = rules[index];

    if (rule.isEOF) {
      (rule.isFallbackEOF ? fallbackEof : eof).push(index);
      continue;
    }

    if (rule.firstCharCodes === null) {
      for (charCode = 0; charCode < ASCII_LIMIT; charCode++) {
        byCharCode[charCode].push(index);
      }
      nonAscii.push(index);
      continue;
    }

    // case folding can cross the ASCII boundary (K and U+212A), so widen
    var reachesNonAscii = rule.expression.ignoreCase;
    for (var codeIndex = 0; codeIndex < rule.firstCharCodes.length; codeIndex++) {
      charCode = rule.firstCharCodes[codeIndex];
      if (charCode < ASCII_LIMIT) {
        byCharCode[charCode].push(index);
      } else {
        reachesNonAscii = true;
      }
    }
    if (reachesNonAscii) {
      nonAscii.push(index);
    }
  }

  return { byCharCode: byCharCode, nonAscii: nonAscii, eof: eof.concat(fallbackEof) };
};

var UNKNOWN = null;

var ASCII_UPPER_TO_LOWER = 32;

function codeRange(from, to) {
  var codes = [];
  for (var code = from; code <= to; code++) {
    codes.push(code);
  }
  return codes;
}

var DIGIT_CODES = codeRange(48, 57);
var WORD_CODES = DIGIT_CODES.concat(codeRange(65, 90), codeRange(97, 122), [95]);
var SPACE_CODES = [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];

var CLASS_ESCAPES = { d: DIGIT_CODES, w: WORD_CODES, s: SPACE_CODES };
var CONTROL_ESCAPES = { n: 10, r: 13, t: 9, f: 12, v: 11, '0': 0 };
var ZERO_WIDTH_ESCAPES = { b: true, B: true };
var UNSUPPORTED_ESCAPE = /[DWScpPk1-9]/;
var COUNTED_QUANTIFIER = /^\d+(,\d*)?$/;
var HEX_DIGITS = /^[0-9a-f]+$/i;

function appendCodes(target, codes) {
  for (var index = 0; index < codes.length; index++) {
    target.push(codes[index]);
  }
}

function uniqueCodes(codes) {
  var seen = {};
  var result = [];
  for (var index = 0; index < codes.length; index++) {
    if (!seen[codes[index]]) {
      seen[codes[index]] = true;
      result.push(codes[index]);
    }
  }
  return result;
}

function withBothCases(codes) {
  var result = codes.slice();
  for (var index = 0; index < codes.length; index++) {
    var code = codes[index];
    if (code >= 65 && code <= 90) {
      result.push(code + ASCII_UPPER_TO_LOWER);
    } else if (code >= 97 && code <= 122) {
      result.push(code - ASCII_UPPER_TO_LOWER);
    }
  }
  return result;
}

function readHexEscape(source, start, length) {
  var digits = source.substr(start, length);
  if (digits.length !== length || !HEX_DIGITS.test(digits)) {
    return UNKNOWN;
  }
  return { codes: [parseInt(digits, 16)], end: start + length };
}

function readEscape(source, index) {
  var escaped = source.charAt(index + 1);

  if (ZERO_WIDTH_ESCAPES[escaped]) {
    return { codes: [], end: index + 2 };
  }
  if (CLASS_ESCAPES[escaped]) {
    return { codes: CLASS_ESCAPES[escaped], end: index + 2 };
  }
  var control = CONTROL_ESCAPES[escaped];
  if (control !== undefined) {
    return { codes: [control], end: index + 2 };
  }
  if (escaped === 'x') {
    return readHexEscape(source, index + 2, 2);
  }
  if (escaped === 'u') {
    return readHexEscape(source, index + 2, 4);
  }
  if (escaped === '' || UNSUPPORTED_ESCAPE.test(escaped)) {
    return UNKNOWN;
  }
  return { codes: [source.charCodeAt(index + 1)], end: index + 2 };
}

function readClassMember(source, index) {
  if (source.charAt(index) !== '\\') {
    return { codes: [source.charCodeAt(index)], end: index + 1 };
  }
  if (source.charAt(index + 1) === 'b') {
    return { codes: [8], end: index + 2 };
  }
  var escape = readEscape(source, index);
  if (escape === UNKNOWN || !escape.codes.length) {
    return UNKNOWN;
  }
  return escape;
}

function isRangeStart(source, member, cursor) {
  return member.codes.length === 1
    && source.charAt(cursor) === '-'
    && cursor + 1 < source.length
    && source.charAt(cursor + 1) !== ']';
}

function readCharClass(source, index) {
  // a negated class matches nearly everything, so narrowing buys nothing
  if (source.charAt(index + 1) === '^') {
    return UNKNOWN;
  }

  var codes = [];
  var cursor = index + 1;

  while (cursor < source.length && source.charAt(cursor) !== ']') {
    var member = readClassMember(source, cursor);
    if (member === UNKNOWN) {
      return UNKNOWN;
    }
    cursor = member.end;

    if (isRangeStart(source, member, cursor)) {
      var upper = readClassMember(source, cursor + 1);
      if (upper === UNKNOWN || upper.codes.length !== 1) {
        return UNKNOWN;
      }
      appendCodes(codes, codeRange(member.codes[0], upper.codes[0]));
      cursor = upper.end;
    } else {
      appendCodes(codes, member.codes);
    }
  }

  if (cursor >= source.length) {
    return UNKNOWN;
  }
  return { codes: codes, end: cursor + 1 };
}

function findGroupEnd(source, index) {
  var depth = 0;
  var inClass = false;

  for (var cursor = index; cursor < source.length; cursor++) {
    var character = source.charAt(cursor);
    if (character === '\\') {
      cursor++;
    } else if (inClass) {
      inClass = character !== ']';
    } else if (character === '[') {
      inClass = true;
    } else if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth--;
      if (depth === 0) {
        return cursor;
      }
    }
  }
  return -1;
}

function groupBodyStart(source, index) {
  if (source.substr(index, 3) === '(?:') {
    return index + 3;
  }
  if (source.substr(index, 2) === '(?') {
    return source.indexOf('>', index) + 1;
  }
  return index + 1;
}

function isLookaround(source, index) {
  var prefix = source.substr(index, 4);
  return prefix.substr(0, 3) === '(?=' || prefix.substr(0, 3) === '(?!'
    || prefix === '(?<=' || prefix === '(?<!';
}

function readGroup(source, index) {
  var end = findGroupEnd(source, index);
  if (end === -1) {
    return UNKNOWN;
  }
  // lookaround is zero-width; the following atom still bounds the first character
  if (isLookaround(source, index)) {
    return { codes: [], end: end + 1 };
  }

  var bodyStart = groupBodyStart(source, index);
  if (bodyStart <= index) {
    return UNKNOWN;
  }
  var codes = expressionFirstCodes(source.slice(bodyStart, end));
  if (codes === UNKNOWN) {
    return UNKNOWN;
  }
  return { codes: codes, end: end + 1 };
}

function readAtom(source, index) {
  var character = source.charAt(index);

  if (character === '^' || character === '$') {
    return { codes: [], end: index + 1 };
  }
  if (character === '\\') {
    return readEscape(source, index);
  }
  if (character === '[') {
    return readCharClass(source, index);
  }
  if (character === '(') {
    return readGroup(source, index);
  }
  if (character === '.' || character === '*' || character === '+' || character === '?' || character === ')') {
    return UNKNOWN;
  }
  return { codes: [source.charCodeAt(index)], end: index + 1 };
}

function readQuantifier(source, index) {
  var character = source.charAt(index);
  var end;
  var optional;

  if (character === '*' || character === '?') {
    optional = true;
    end = index + 1;
  } else if (character === '+') {
    optional = false;
    end = index + 1;
  } else if (character === '{') {
    var close = source.indexOf('}', index);
    var body = close === -1 ? '' : source.slice(index + 1, close);
    if (!COUNTED_QUANTIFIER.test(body)) {
      return { optional: false, end: index };
    }
    optional = parseInt(body, 10) === 0;
    end = close + 1;
  } else {
    return { optional: false, end: index };
  }

  if (source.charAt(end) === '?') {
    end++;
  }
  return { optional: optional, end: end };
}

function splitAlternatives(source) {
  var alternatives = [];
  var depth = 0;
  var inClass = false;
  var start = 0;

  for (var cursor = 0; cursor < source.length; cursor++) {
    var character = source.charAt(cursor);
    if (character === '\\') {
      cursor++;
    } else if (inClass) {
      inClass = character !== ']';
    } else if (character === '[') {
      inClass = true;
    } else if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth--;
    } else if (character === '|' && depth === 0) {
      alternatives.push(source.slice(start, cursor));
      start = cursor + 1;
    }
  }

  alternatives.push(source.slice(start));
  return alternatives;
}

function alternativeFirstCodes(source) {
  var codes = [];
  var cursor = 0;

  while (cursor < source.length) {
    var atom = readAtom(source, cursor);
    if (atom === UNKNOWN) {
      return UNKNOWN;
    }
    var quantifier = readQuantifier(source, atom.end);
    cursor = quantifier.end;

    if (atom.codes.length) {
      appendCodes(codes, atom.codes);
      if (!quantifier.optional) {
        return codes;
      }
    }
  }

  // every atom was zero-width or optional, so the expression can match empty
  return UNKNOWN;
}

function expressionFirstCodes(source) {
  var alternatives = splitAlternatives(source);
  var codes = [];

  for (var index = 0; index < alternatives.length; index++) {
    var alternativeCodes = alternativeFirstCodes(alternatives[index]);
    if (alternativeCodes === UNKNOWN) {
      return UNKNOWN;
    }
    appendCodes(codes, alternativeCodes);
  }

  return codes;
}

/**
 * @param {RegExp} expression
 *
 * @return {number[]|null} Character codes a match can start with, or null when unknown.
 */

/**
 * Character codes a rule expression can start with. The result is always a
 * superset of the true set; null means the caller must always try the rule.
 *
 * @private
 */
var CHAR_CLASS_BODY = '(?:[^\\\\\\]]|\\\\[tnrfv\\-\\]\\\\^/])+';
var SINGLE_CLASS = new RegExp('^\\[(' + CHAR_CLASS_BODY + ')\\](\\+?)$');
var PAIRED_CLASS = new RegExp('^\\[(' + CHAR_CLASS_BODY + ')\\]\\[(' + CHAR_CLASS_BODY + ')\\]\\*$');

/**
 * Which ASCII characters a class body accepts, or null when it could reach
 * beyond ASCII and a table would answer for characters it has not seen.
 *
 * @private
 */
Lexer.prototype.getCharClassTable = function (body) {
  if (body.charAt(0) === '^' || !isAscii(body)) {
    return null;
  }

  var probe = new RegExp('^[' + body + ']$');
  var table = new Array(ASCII_LIMIT);
  for (var code = 0; code < ASCII_LIMIT; code++) {
    table[code] = probe.test(String.fromCharCode(code)) ? 1 : 0;
  }

  return table;
};

/**
 * Tables for a pattern that is one character class, optionally repeated, or a
 * class followed by a repeated one. Head answers for the first character, tail
 * for every further one, so such a rule matches by walking character codes
 * instead of entering the regular expression engine.
 *
 * @private
 */
Lexer.prototype.getCharClassTables = function (expression) {
  if (expression.ignoreCase || expression.unicode) {
    return null;
  }

  var paired = PAIRED_CLASS.exec(expression.source);
  if (paired) {
    var pairedHead = this.getCharClassTable(paired[1]);
    var pairedTail = this.getCharClassTable(paired[2]);
    return pairedHead && pairedTail ? { head: pairedHead, tail: pairedTail } : null;
  }

  var single = SINGLE_CLASS.exec(expression.source);
  if (!single) {
    return null;
  }

  var head = this.getCharClassTable(single[1]);
  return head ? { head: head, tail: single[2] ? head : null } : null;
};

Lexer.prototype.getFirstCharCodes = function (expression) {
  var codes = expressionFirstCodes(expression.source);
  if (codes === UNKNOWN || !codes.length) {
    return UNKNOWN;
  }
  return uniqueCodes(expression.ignoreCase ? withBothCases(codes) : codes);
};

if (typeof module === 'object' && typeof module.exports === 'object') {
  module.exports = Lexer;
} else {
  root.Lexer = Lexer;
}
}(typeof self === 'undefined' ? this : self));

  };
  __modules["dist/cjs/options.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSupportedOptions = exports.getOption = void 0;
var types_1 = require("./types");
var callbacks_1 = require("./callbacks");
/* eslint-disable */
var OPTIONS = [
    { name: 'add-host', path: 'extra_hosts', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'attach', short: 'a', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notImplementedInCompose },
    { name: 'blkio-weight', path: 'blkio_config.weight', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'blkio-weight-device', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'cap-add', path: 'cap_add', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'cap-drop', path: 'cap_drop', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'cgroupns', path: 'cgroup', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'cgroup-parent', path: 'cgroup_parent', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'cidfile', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'cpu-count', path: 'cpu_count', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'cpu-percent', path: 'cpu_percent', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'float', action: callbacks_1.processOptionWithArgs },
    { name: 'cpu-period', path: 'cpu_period', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'cpu-quota', path: 'cpu_quota', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'cpu-rt-period', path: 'cpu_rt_period', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'cpu-rt-runtime', path: 'cpu_rt_runtime', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'cpu-shares', short: 'c', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'cpus', path: 'cpus', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'float', action: callbacks_1.processOptionWithArgs },
    { name: 'cpuset-cpus', path: 'cpuset', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'cpuset-mems', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'detach', short: 'd', path: '', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.notImplementedInCompose },
    { name: 'detach-keys', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'device', path: 'devices', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'device-cgroup-rule', path: 'device_cgroup_rules', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'device-read-bps', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'device-read-iops', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'device-write-bps', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'device-write-iops', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'disable-content-trust', path: '', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'dns', path: 'dns', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'dns-option', path: 'dns_opt', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'dns-search', path: 'dns_search', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'domainname', path: 'domainname', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'entrypoint', path: 'entrypoint', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'env', short: 'e', path: 'environment', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'env-file', path: 'env_file', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'expose', path: 'expose', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'gpus', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'group-add', path: 'group_add', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'health-cmd', path: 'healthcheck.test', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'health-interval', path: 'healthcheck.interval', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'health-retries', path: 'healthcheck.retries', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'health-start-period', path: 'healthcheck.start_period', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'health-timeout', path: 'healthcheck.timeout', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'hostname', short: 'h', path: 'hostname', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'init', path: 'init', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.processBoolean },
    { name: 'interactive', short: 'i', path: 'stdin_open', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.processBoolean },
    { name: 'io-maxbandwidth', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'io-maxiops', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'ip', path: 'networks.default.ipv4_address', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'ip6', path: 'networks.default.ipv6_address', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'ipc', path: 'ipc', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'isolation', path: 'isolation', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'kernel-memory', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'label-file', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notImplementedInCompose },
    { name: 'label', short: 'l', path: 'labels', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'link', path: 'links', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'link-local-ip', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'log-driver', path: 'logging.driver', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'log-opt', path: 'logging.options', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processLoggingOption },
    { name: 'mac-address', path: 'mac_address', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'memory', short: 'm', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'memory-swap', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'memory-swappiness', path: 'mem_swappiness', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'memory-reservation', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'mount', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'name', path: 'container_name', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'network', path: 'networks', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processNetworkOption },
    { name: 'network-alias', path: 'networks.default.aliases', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'no-healthcheck', path: '', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'oom-kill-disable', path: 'oom_kill_disable', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.processBoolean },
    { name: 'oom-score-adj', path: 'oom_score_adj', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'pid', path: 'pid', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'pids-limit', path: 'pids_limit', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'platform', path: 'platform', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'privileged', path: 'privileged', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.processBoolean },
    { name: 'publish', short: 'p', path: 'ports', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'publish-all', short: 'P', path: '', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.notImplementedInCompose },
    { name: 'pull', path: 'pull_policy', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'quiet', short: 'q', path: '', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.notImplementedInCompose },
    { name: 'read-only', path: 'read_only', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.processBoolean },
    { name: 'restart', path: 'restart', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'rm', path: '', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.notImplementedInCompose },
    { name: 'runtime', path: 'runtime', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'security-opt', path: 'security_opt', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'shm-size', path: 'shm_size', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processOptionWithArgs },
    { name: 'stop-signal', path: 'stop_signal', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'stop-timeout', path: 'stop_grace_period', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'storage-opt', path: 'storage_opt', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processStorageOption },
    { name: 'tmpfs', path: 'tmpfs', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'tty', short: 't', path: 'tty', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.processBoolean },
    { name: 'sysctl', path: 'sysctls', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'ulimit', path: 'ulimits', type: types_1.OptionType.withArgs, multiValue: false, composeType: 'int', action: callbacks_1.processUlimitOption },
    { name: 'user', short: 'u', path: 'user', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'userns', path: 'userns_mode', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'uts', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'volume-driver', path: '', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.notYetImplemented },
    { name: 'volumes-from', path: 'volumes_from', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'volume', short: 'v', path: 'volumes', type: types_1.OptionType.withArgs, multiValue: true, action: callbacks_1.processOptionWithArgs },
    { name: 'workdir', short: 'w', path: 'working_dir', type: types_1.OptionType.withArgs, multiValue: false, action: callbacks_1.processOptionWithArgs },
    { name: 'help', path: '', type: types_1.OptionType.flag, multiValue: false, action: callbacks_1.notImplementedInCompose },
];
/* eslint-enable */
var AllOptions = {};
OPTIONS.forEach(function (opt) { return (AllOptions[opt.name] = opt); });
var getOption = function (optionName) {
    return AllOptions[optionName] || OPTIONS.find(function (o) { return o.short === optionName; });
};
exports.getOption = getOption;
var getSupportedOptions = function () {
    var implemented = OPTIONS.filter(function (opt) { return opt.action !== callbacks_1.notYetImplemented && opt.action !== callbacks_1.notImplementedInCompose; }).map(function (opt) { return new types_1.SupportedOption(opt.name, opt.path, opt.short); });
    return implemented;
};
exports.getSupportedOptions = getSupportedOptions;
//# sourceMappingURL=options.js.map
  };
  __modules["dist/cjs/types.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptionType = exports.ParseResult = exports.MessageType = exports.SupportedOption = exports.ComposerizeResult = void 0;
/**
 * The result of a conversion. The result contains the docker-compose.yml and
 * additional {@link Message}s.
 */
var ComposerizeResult = /** @class */ (function () {
    function ComposerizeResult(yaml, messages) {
        this.yaml = yaml;
        this.messages = messages;
    }
    return ComposerizeResult;
}());
exports.ComposerizeResult = ComposerizeResult;
/**
 * A docker option which is supported by this library with it's corresponding docker-compose equivalent.
 */
var SupportedOption = /** @class */ (function () {
    function SupportedOption(dockerOption, composeEquivalent, shortOption) {
        this.dockerOption = dockerOption;
        this.composeEquivalent = composeEquivalent;
        if (shortOption !== undefined) {
            this.dockerOption += '/' + shortOption;
        }
    }
    return SupportedOption;
}());
exports.SupportedOption = SupportedOption;
/**
 * The type of a returned {@link Message}.
 */
var MessageType;
(function (MessageType) {
    MessageType["notImplemented"] = "notImplemented";
    MessageType["notTranslatable"] = "notTranslatable";
    MessageType["errorDuringConversion"] = "errorDuringConversion";
})(MessageType = exports.MessageType || (exports.MessageType = {}));
/**
 * @internal
 */
var ParseResult = /** @class */ (function () {
    function ParseResult() {
        this.serviceName = '';
        this.properties = [];
        this.messages = [];
        this.additionalComposeObjects = [];
    }
    return ParseResult;
}());
exports.ParseResult = ParseResult;
/**
 * @internal
 */
var OptionType;
(function (OptionType) {
    OptionType[OptionType["flag"] = 0] = "flag";
    OptionType[OptionType["withArgs"] = 1] = "withArgs";
})(OptionType = exports.OptionType || (exports.OptionType = {}));
//# sourceMappingURL=types.js.map
  };
  __modules["dist/cjs/callbacks.js"] = function (module, exports, require) {
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processUlimitOption = exports.processNetworkOption = exports.processStorageOption = exports.processLoggingOption = exports.processOptionWithArgs = exports.processBoolean = exports.notImplementedInCompose = exports.notYetImplemented = void 0;
var types_1 = require("./types");
var set_value_1 = __importDefault(require("set-value"));
var getValue = function (value, opt) {
    if (typeof value === 'string') {
        if (opt.multiValue) {
            if (opt.composeType !== undefined && /^\-?\d+$/.test(value)) {
                try {
                    return opt.composeType === 'int' ? [parseInt(value)] : [parseFloat(value)];
                }
                catch (e) {
                    return [value];
                }
            }
            return [value];
        }
        if (opt.composeType !== undefined && /^\-?\d+$/.test(value)) {
            try {
                return opt.composeType === 'int' ? parseInt(value) : parseFloat(value);
            }
            catch (e) {
                return value;
            }
        }
    }
    return value;
};
var notYetImplemented = function (opt) {
    return {
        type: types_1.MessageType.notImplemented,
        value: "The option \"--".concat(opt.name).concat(opt.short !== undefined ? '/-' + opt.short : '', "\" is not yet implemented."),
    };
};
exports.notYetImplemented = notYetImplemented;
var notImplementedInCompose = function (opt) {
    return {
        type: types_1.MessageType.notTranslatable,
        value: "The option \"--".concat(opt.name).concat(opt.short !== undefined ? '/-' + opt.short : '', "\" could not be translated to docker-compose.yml."),
    };
};
exports.notImplementedInCompose = notImplementedInCompose;
var processBoolean = function (opt) {
    var valueToSet = {};
    (0, set_value_1.default)(valueToSet, opt.path, true);
    return { path: opt.path, value: valueToSet, multiValue: opt.multiValue, additionalObject: undefined };
};
exports.processBoolean = processBoolean;
var processOptionWithArgs = function (opt, value) {
    var val = getValue(value, opt);
    var valueToSet = {};
    (0, set_value_1.default)(valueToSet, opt.path, val);
    return { path: opt.path, value: valueToSet, multiValue: opt.multiValue, additionalObject: undefined };
};
exports.processOptionWithArgs = processOptionWithArgs;
var processLoggingOption = function (opt, value) {
    var _a;
    var val = value.split('=');
    return (0, exports.processOptionWithArgs)(opt, (_a = {}, _a[val[0]] = val[1], _a));
};
exports.processLoggingOption = processLoggingOption;
var processStorageOption = function (opt, value) {
    var _a;
    var val = value.split('=');
    return (0, exports.processOptionWithArgs)(opt, (_a = {}, _a[val[0]] = val[1], _a));
};
exports.processStorageOption = processStorageOption;
var processNetworkOption = function (opt, value) {
    var _a, _b;
    var result = (0, exports.processOptionWithArgs)(opt, (_a = {}, _a[value] = {}, _a));
    // We have to return the networks block as additional object too
    result.additionalObject = {
        networks: (_b = {}, _b[value] = {}, _b),
    };
    return result;
};
exports.processNetworkOption = processNetworkOption;
var processUlimitOption = function (opt, value) {
    var _a, _b;
    var parts = value.match(/(?<type>[^=]+)=(?<hardLimit>[^:]+)(:(?<softLimit>\S+))?/);
    if (parts !== null) {
        if (parts.length === 5) {
            if (parts.groups.softLimit === undefined) {
                return (0, exports.processOptionWithArgs)(opt, (_a = {},
                    _a[parts.groups.type] = parseInt(parts.groups.hardLimit),
                    _a));
            }
            return (0, exports.processOptionWithArgs)(opt, (_b = {},
                _b[parts.groups.type] = {
                    hard: parseInt(parts.groups.hardLimit),
                    soft: parseInt(parts.groups.softLimit),
                },
                _b));
        }
    }
    return {
        type: types_1.MessageType.errorDuringConversion,
        value: "The option \"--".concat(opt.name).concat(opt.short !== undefined ? '/-' + opt.short : '', "\" could not be translated to docker-compose.yml. The not translatable value was \"").concat(value, "\""),
    };
};
exports.processUlimitOption = processUlimitOption;
//# sourceMappingURL=callbacks.js.map
  };
  __modules["set-value/index.js"] = function (module, exports, require) {
/*!
 * set-value <https://github.com/jonschlinkert/set-value>
 *
 * Copyright (c) Jon Schlinkert (https://github.com/jonschlinkert).
 * Released under the MIT License.
 */

'use strict';

const { deleteProperty } = Reflect;
const isPrimitive = require('is-primitive');
const isPlainObject = require('is-plain-object');

const isObject = value => {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
};

const isUnsafeKey = key => {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
};

const validateKey = key => {
  if (!isPrimitive(key)) {
    throw new TypeError('Object keys must be strings or symbols');
  }

  if (isUnsafeKey(key)) {
    throw new Error(`Cannot set unsafe key: "${key}"`);
  }
};

const toStringKey = input => {
  return Array.isArray(input) ? input.flat().map(String).join(',') : input;
};

const createMemoKey = (input, options) => {
  if (typeof input !== 'string' || !options) return input;
  let key = input + ';';
  if (options.arrays !== undefined) key += `arrays=${options.arrays};`;
  if (options.separator !== undefined) key += `separator=${options.separator};`;
  if (options.split !== undefined) key += `split=${options.split};`;
  if (options.merge !== undefined) key += `merge=${options.merge};`;
  if (options.preservePaths !== undefined) key += `preservePaths=${options.preservePaths};`;
  return key;
};

const memoize = (input, options, fn) => {
  const key = toStringKey(options ? createMemoKey(input, options) : input);
  validateKey(key);

  const value = setValue.cache.get(key) || fn();
  setValue.cache.set(key, value);
  return value;
};

const splitString = (input, options = {}) => {
  const sep = options.separator || '.';
  const preserve = sep === '/' ? false : options.preservePaths;

  if (typeof input === 'string' && preserve !== false && /\//.test(input)) {
    return [input];
  }

  const parts = [];
  let part = '';

  const push = part => {
    let number;
    if (part.trim() !== '' && Number.isInteger((number = Number(part)))) {
      parts.push(number);
    } else {
      parts.push(part);
    }
  };

  for (let i = 0; i < input.length; i++) {
    const value = input[i];

    if (value === '\\') {
      part += input[++i];
      continue;
    }

    if (value === sep) {
      push(part);
      part = '';
      continue;
    }

    part += value;
  }

  if (part) {
    push(part);
  }

  return parts;
};

const split = (input, options) => {
  if (options && typeof options.split === 'function') return options.split(input);
  if (typeof input === 'symbol') return [input];
  if (Array.isArray(input)) return input;
  return memoize(input, options, () => splitString(input, options));
};

const assignProp = (obj, prop, value, options) => {
  validateKey(prop);

  // Delete property when "value" is undefined
  if (value === undefined) {
    deleteProperty(obj, prop);

  } else if (options && options.merge) {
    const merge = options.merge === 'function' ? options.merge : Object.assign;

    // Only merge plain objects
    if (merge && isPlainObject(obj[prop]) && isPlainObject(value)) {
      obj[prop] = merge(obj[prop], value);
    } else {
      obj[prop] = value;
    }

  } else {
    obj[prop] = value;
  }

  return obj;
};

const setValue = (target, path, value, options) => {
  if (!path || !isObject(target)) return target;

  const keys = split(path, options);
  let obj = target;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const next = keys[i + 1];

    validateKey(key);

    if (next === undefined) {
      assignProp(obj, key, value, options);
      break;
    }

    if (typeof next === 'number' && !Array.isArray(obj[key])) {
      obj = obj[key] = [];
      continue;
    }

    if (!isObject(obj[key])) {
      obj[key] = {};
    }

    obj = obj[key];
  }

  return target;
};

setValue.split = split;
setValue.cache = new Map();
setValue.clear = () => {
  setValue.cache = new Map();
};

module.exports = setValue;

  };
  __modules["is-primitive/index.js"] = function (module, exports, require) {
/*!
 * is-primitive <https://github.com/jonschlinkert/is-primitive>
 *
 * Copyright (c) 2014-present, Jon Schlinkert.
 * Released under the MIT License.
 */

'use strict';

module.exports = function isPrimitive(val) {
  if (typeof val === 'object') {
    return val === null;
  }
  return typeof val !== 'function';
};

  };
  __modules["is-plain-object/index.js"] = function (module, exports, require) {
/*!
 * is-plain-object <https://github.com/jonschlinkert/is-plain-object>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */

'use strict';

var isObject = require('isobject');

function isObjectObject(o) {
  return isObject(o) === true
    && Object.prototype.toString.call(o) === '[object Object]';
}

module.exports = function isPlainObject(o) {
  var ctor,prot;

  if (isObjectObject(o) === false) return false;

  // If has modified constructor
  ctor = o.constructor;
  if (typeof ctor !== 'function') return false;

  // If has modified prototype
  prot = ctor.prototype;
  if (isObjectObject(prot) === false) return false;

  // If constructor does not have an Object-specific method
  if (prot.hasOwnProperty('isPrototypeOf') === false) {
    return false;
  }

  // Most likely a plain Object
  return true;
};

  };
  __modules["isobject/index.js"] = function (module, exports, require) {
/*!
 * isobject <https://github.com/jonschlinkert/isobject>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */

'use strict';

module.exports = function isObject(val) {
  return val != null && typeof val === 'object' && Array.isArray(val) === false;
};

  };
  __modules["dist/cjs/util.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isResult = void 0;
var isResult = function (obj) { return obj.hasOwnProperty('path'); };
exports.isResult = isResult;
//# sourceMappingURL=util.js.map
  };
  __modules["dist/cjs/cidr.js"] = function (module, exports, require) {
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalize = void 0;
var ip_cidr_1 = __importDefault(require("ip-cidr"));
//const IPCIDR = require('ip-cidr');
var abbreviate = function (a) {
    a = a.replace(/0000/g, 'g');
    a = a.replace(/\:000/g, ':');
    a = a.replace(/\:00/g, ':');
    a = a.replace(/\:0/g, ':');
    a = a.replace(/g/g, '0');
    a = a.replace(/^0*/, '');
    var sections = a.split(/\:/g);
    var zPreviousFlag = false;
    var zeroStartIndex = -1;
    var zeroLength = 0;
    var zStartIndex = -1;
    var zLength = 0;
    for (var i = 0; i < 8; ++i) {
        var section = sections[i];
        var zFlag = section === '0';
        if (zFlag && !zPreviousFlag) {
            zStartIndex = i;
        }
        if (!zFlag && zPreviousFlag) {
            zLength = i - zStartIndex;
        }
        if (zLength > 1 && zLength > zeroLength) {
            zeroStartIndex = zStartIndex;
            zeroLength = zLength;
        }
        zPreviousFlag = section === '0';
    }
    if (zPreviousFlag) {
        zLength = 8 - zStartIndex;
    }
    if (zLength > 1 && zLength > zeroLength) {
        zeroStartIndex = zStartIndex;
        zeroLength = zLength;
    }
    //console.log(zeroStartIndex, zeroLength);
    //console.log(sections);
    if (zeroStartIndex >= 0 && zeroLength > 1) {
        sections.splice(zeroStartIndex, zeroLength, 'g');
    }
    //console.log(sections);
    a = sections.join(':');
    //console.log(a);
    a = a.replace(/\:g\:/g, '::');
    a = a.replace(/\:g/g, '::');
    a = a.replace(/g\:/g, '::');
    a = a.replace(/g/g, '::');
    //console.log(a);
    return a;
};
var normalize = function (address) {
    if (ip_cidr_1.default.isValidCIDR(address)) {
        var cidr = new ip_cidr_1.default(address);
        var start = cidr.start();
        if (!cidr.addressStart.v4) {
            start = abbreviate(start);
        }
        return start + cidr.addressStart.subnet;
    }
    return '';
};
exports.normalize = normalize;
//# sourceMappingURL=cidr.js.map
  };
  __modules["ip-cidr/index.js"] = function (module, exports, require) {
"use strict";

const ipAddress = require('ip-address');
const BigInteger = require('jsbn').BigInteger;

class IPCIDR {
  constructor(cidr) {
    if(typeof cidr !== 'string' || !cidr.match('/')) {
      throw new Error('Invalid CIDR address.');
    }

    const address = this.constructor.createAddress(cidr);
    this.cidr = address.address;
    this.ipAddressType = address.constructor;
    this.address = address;
    this.addressStart = address.startAddress();
    this.addressEnd = address.endAddress();    
    this.addressStart.subnet = this.addressEnd.subnet = this.address.subnet;
    this.addressStart.subnetMask = this.addressEnd.subnetMask = this.address.subnetMask;
    this.size = new BigInteger(this.addressEnd.bigInteger().subtract(this.addressStart.bigInteger()).add(new BigInteger('1')).toString());
  }
  
  contains(address) {
    try {
      if(!(address instanceof ipAddress.Address6) && !(address instanceof ipAddress.Address4)) {
        if(typeof address == 'object') {
          address = this.ipAddressType.fromBigInteger(address);
        }
        else {
          address = this.constructor.createAddress(address);
        }
      }

      return address.isInSubnet(this.address)
    }
    catch(err) {
      return false;
    }   
  }

  start(options) {
    return this.constructor.formatIP(this.addressStart, options);
  }

  end(options) {
    return this.constructor.formatIP(this.addressEnd, options);
  }

  toString() {
    return this.cidr;
  }

  toRange(options) {
    return [this.constructor.formatIP(this.addressStart, options), this.constructor.formatIP(this.addressEnd, options)];
  }

  toObject(options) {
    return {
      start: this.constructor.formatIP(this.addressStart, options),
      end: this.constructor.formatIP(this.addressEnd, options)
    };
  }

  toArray(options, results) {
    options = options || {};
    const list = [];
    const start = this.constructor.formatIP(this.addressStart, { type: 'bigInteger' });
    const end = this.constructor.formatIP(this.addressEnd, { type: 'bigInteger' });
    const length = end.subtract(start).add(new BigInteger('1'));
    const info = this.getChunkInfo(length, options);

    if(results)  {
      Object.assign(results, info);
    }

    this.loopInfo(info, (val) => {
      const num = start.add(val);
      const ip = this.constructor.formatIP(this.ipAddressType.fromBigInteger(num), options);
      list.push(ip);
    });

    return list;
  }
  
  loop(fn, options, results) {
    options = options || {};
    const promise = [];
    const start = this.constructor.formatIP(this.addressStart, { type: 'bigInteger' });
    const end = this.constructor.formatIP(this.addressEnd, { type: 'bigInteger' });
    const length = end.subtract(start).add(new BigInteger('1'));
    const info = this.getChunkInfo(length, options);
    
    if(results)  {
      Object.assign(results, info);
    }

    this.loopInfo(info, (val) => {
      const num = start.add(val);
      const ip = this.constructor.formatIP(this.ipAddressType.fromBigInteger(num), options);
      promise.push(fn(ip));
    });

    return Promise.all(promise);
  }

  loopInfo(info, fn) {
    let i = info.from;

    while(i.compareTo(info.to) < 0) {
      fn(i);
      i = i.add(new BigInteger('1'));
    }
  }

  getChunkInfo(length, options) {
    let from = options.from;
    let limit = options.limit;
    let to = options.to;
    let maxLength;
    const addressBigInteger = this.constructor.formatIP(this.address, { type: 'bigInteger' });

    const getBigInteger = (val) => {
      if(typeof val == 'string' && val.match(/:|\./)) {
        return this.constructor.formatIP(this.constructor.createAddress(val), { type: 'bigInteger' }).subtract(addressBigInteger);
      }
      else if(typeof val != 'object') {
        return new BigInteger(val + '');
      }

      return val;
    }

    from = getBigInteger(from !== undefined? from: 0);

    if(to !== undefined) {
      to = getBigInteger(to);
      limit = to.subtract(from);
    }
    else {
      limit = limit !== undefined? getBigInteger(limit): length;
    }   

    maxLength = length.subtract(from);
    
    if(limit.compareTo(maxLength) > 0) {
      limit = maxLength;
    }
    
    to = from.add(limit);
    return {
      from: from,
      to: to,
      limit: limit,
      length: length
    };
  }
}

IPCIDR.formatIP = function(address, options) {
  options = options || {};

  if (options.type == "bigInteger") {
    return new BigInteger(address.bigInteger().toString());
  }
  else if (options.type == "addressObject") {
    return address;
  }

  return address.addressMinusSuffix;
}

IPCIDR.createAddress = function (val) {
  if(typeof val !== 'string') {
    throw new Error('Invalid IP address.');
  }

  val.match(/:.\./) && (val = val.split(':').pop());
  const ipAddressType = val.match(":")? ipAddress.Address6: ipAddress.Address4;
  let ip = new ipAddressType(val);

  if(ip.v4 && val.match(":") && ip.address4) {
    ip = ip.address4;
  }

  if(ip.v4) {
    const parts = ip.addressMinusSuffix.split('.');

    for(let i = 0; i < parts.length; i++) {
      const part = parts[i].split('/')[0];

      if(part[0] == '0' && part.length > 1) {
        throw new Error('Invalid IPv4 address.');
      }
    }
  }

  return ip
}

IPCIDR.isValidAddress = function (address) {
  try {
    return !!this.createAddress(address);
  }
  catch(err) {
    return false;
  }
}

IPCIDR.isValidCIDR = function (address) {
  if(typeof address !== 'string' || !address.match('/')) {
    return false;
  }

  try {
    return !!this.createAddress(address);
  }
  catch(err) {
    return false;
  }
}

module.exports = IPCIDR;

  };
  __modules["ip-address/dist/ip-address.js"] = function (module, exports, require) {
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.v6 = exports.Address6 = exports.Address4 = void 0;
var ipv4_1 = require("./lib/ipv4");
Object.defineProperty(exports, "Address4", { enumerable: true, get: function () { return ipv4_1.Address4; } });
var ipv6_1 = require("./lib/ipv6");
Object.defineProperty(exports, "Address6", { enumerable: true, get: function () { return ipv6_1.Address6; } });
var helpers = __importStar(require("./lib/v6/helpers"));
exports.v6 = { helpers: helpers };
//# sourceMappingURL=ip-address.js.map
  };
  __modules["ip-address/dist/lib/ipv4.js"] = function (module, exports, require) {
"use strict";
/* eslint-disable no-param-reassign */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Address4 = void 0;
var common = __importStar(require("./common"));
var constants = __importStar(require("./v4/constants"));
var address_error_1 = require("./address-error");
var jsbn_1 = require("jsbn");
var sprintf_js_1 = require("sprintf-js");
/**
 * Represents an IPv4 address
 * @class Address4
 * @param {string} address - An IPv4 address string
 */
var Address4 = /** @class */ (function () {
    function Address4(address) {
        this.groups = constants.GROUPS;
        this.parsedAddress = [];
        this.parsedSubnet = '';
        this.subnet = '/32';
        this.subnetMask = 32;
        this.v4 = true;
        /**
         * Returns true if the address is correct, false otherwise
         * @memberof Address4
         * @instance
         * @returns {Boolean}
         */
        this.isCorrect = common.isCorrect(constants.BITS);
        /**
         * Returns true if the given address is in the subnet of the current address
         * @memberof Address4
         * @instance
         * @returns {boolean}
         */
        this.isInSubnet = common.isInSubnet;
        this.address = address;
        var subnet = constants.RE_SUBNET_STRING.exec(address);
        if (subnet) {
            this.parsedSubnet = subnet[0].replace('/', '');
            this.subnetMask = parseInt(this.parsedSubnet, 10);
            this.subnet = "/" + this.subnetMask;
            if (this.subnetMask < 0 || this.subnetMask > constants.BITS) {
                throw new address_error_1.AddressError('Invalid subnet mask.');
            }
            address = address.replace(constants.RE_SUBNET_STRING, '');
        }
        this.addressMinusSuffix = address;
        this.parsedAddress = this.parse(address);
    }
    Address4.isValid = function (address) {
        try {
            // eslint-disable-next-line no-new
            new Address4(address);
            return true;
        }
        catch (e) {
            return false;
        }
    };
    /*
     * Parses a v4 address
     */
    Address4.prototype.parse = function (address) {
        var groups = address.split('.');
        if (!address.match(constants.RE_ADDRESS)) {
            throw new address_error_1.AddressError('Invalid IPv4 address.');
        }
        return groups;
    };
    /**
     * Returns the correct form of an address
     * @memberof Address4
     * @instance
     * @returns {String}
     */
    Address4.prototype.correctForm = function () {
        return this.parsedAddress.map(function (part) { return parseInt(part, 10); }).join('.');
    };
    /**
     * Converts a hex string to an IPv4 address object
     * @memberof Address4
     * @static
     * @param {string} hex - a hex string to convert
     * @returns {Address4}
     */
    Address4.fromHex = function (hex) {
        var padded = hex.replace(/:/g, '').padStart(8, '0');
        var groups = [];
        var i;
        for (i = 0; i < 8; i += 2) {
            var h = padded.slice(i, i + 2);
            groups.push(parseInt(h, 16));
        }
        return new Address4(groups.join('.'));
    };
    /**
     * Converts an integer into a IPv4 address object
     * @memberof Address4
     * @static
     * @param {integer} integer - a number to convert
     * @returns {Address4}
     */
    Address4.fromInteger = function (integer) {
        return Address4.fromHex(integer.toString(16));
    };
    /**
     * Converts an IPv4 address object to a hex string
     * @memberof Address4
     * @instance
     * @returns {String}
     */
    Address4.prototype.toHex = function () {
        return this.parsedAddress.map(function (part) { return sprintf_js_1.sprintf('%02x', parseInt(part, 10)); }).join(':');
    };
    /**
     * Converts an IPv4 address object to an array of bytes
     * @memberof Address4
     * @instance
     * @returns {Array}
     */
    Address4.prototype.toArray = function () {
        return this.parsedAddress.map(function (part) { return parseInt(part, 10); });
    };
    /**
     * Converts an IPv4 address object to an IPv6 address group
     * @memberof Address4
     * @instance
     * @returns {String}
     */
    Address4.prototype.toGroup6 = function () {
        var output = [];
        var i;
        for (i = 0; i < constants.GROUPS; i += 2) {
            var hex = sprintf_js_1.sprintf('%02x%02x', parseInt(this.parsedAddress[i], 10), parseInt(this.parsedAddress[i + 1], 10));
            output.push(sprintf_js_1.sprintf('%x', parseInt(hex, 16)));
        }
        return output.join(':');
    };
    /**
     * Returns the address as a BigInteger
     * @memberof Address4
     * @instance
     * @returns {BigInteger}
     */
    Address4.prototype.bigInteger = function () {
        return new jsbn_1.BigInteger(this.parsedAddress.map(function (n) { return sprintf_js_1.sprintf('%02x', parseInt(n, 10)); }).join(''), 16);
    };
    /**
     * Helper function getting start address.
     * @memberof Address4
     * @instance
     * @returns {BigInteger}
     */
    Address4.prototype._startAddress = function () {
        return new jsbn_1.BigInteger(this.mask() + '0'.repeat(constants.BITS - this.subnetMask), 2);
    };
    /**
     * The first address in the range given by this address' subnet.
     * Often referred to as the Network Address.
     * @memberof Address4
     * @instance
     * @returns {Address4}
     */
    Address4.prototype.startAddress = function () {
        return Address4.fromBigInteger(this._startAddress());
    };
    /**
     * The first host address in the range given by this address's subnet ie
     * the first address after the Network Address
     * @memberof Address4
     * @instance
     * @returns {Address4}
     */
    Address4.prototype.startAddressExclusive = function () {
        var adjust = new jsbn_1.BigInteger('1');
        return Address4.fromBigInteger(this._startAddress().add(adjust));
    };
    /**
     * Helper function getting end address.
     * @memberof Address4
     * @instance
     * @returns {BigInteger}
     */
    Address4.prototype._endAddress = function () {
        return new jsbn_1.BigInteger(this.mask() + '1'.repeat(constants.BITS - this.subnetMask), 2);
    };
    /**
     * The last address in the range given by this address' subnet
     * Often referred to as the Broadcast
     * @memberof Address4
     * @instance
     * @returns {Address4}
     */
    Address4.prototype.endAddress = function () {
        return Address4.fromBigInteger(this._endAddress());
    };
    /**
     * The last host address in the range given by this address's subnet ie
     * the last address prior to the Broadcast Address
     * @memberof Address4
     * @instance
     * @returns {Address4}
     */
    Address4.prototype.endAddressExclusive = function () {
        var adjust = new jsbn_1.BigInteger('1');
        return Address4.fromBigInteger(this._endAddress().subtract(adjust));
    };
    /**
     * Converts a BigInteger to a v4 address object
     * @memberof Address4
     * @static
     * @param {BigInteger} bigInteger - a BigInteger to convert
     * @returns {Address4}
     */
    Address4.fromBigInteger = function (bigInteger) {
        return Address4.fromInteger(parseInt(bigInteger.toString(), 10));
    };
    /**
     * Returns the first n bits of the address, defaulting to the
     * subnet mask
     * @memberof Address4
     * @instance
     * @returns {String}
     */
    Address4.prototype.mask = function (mask) {
        if (mask === undefined) {
            mask = this.subnetMask;
        }
        return this.getBitsBase2(0, mask);
    };
    /**
     * Returns the bits in the given range as a base-2 string
     * @memberof Address4
     * @instance
     * @returns {string}
     */
    Address4.prototype.getBitsBase2 = function (start, end) {
        return this.binaryZeroPad().slice(start, end);
    };
    /**
     * Returns true if the given address is a multicast address
     * @memberof Address4
     * @instance
     * @returns {boolean}
     */
    Address4.prototype.isMulticast = function () {
        return this.isInSubnet(new Address4('224.0.0.0/4'));
    };
    /**
     * Returns a zero-padded base-2 string representation of the address
     * @memberof Address4
     * @instance
     * @returns {string}
     */
    Address4.prototype.binaryZeroPad = function () {
        return this.bigInteger().toString(2).padStart(constants.BITS, '0');
    };
    /**
     * Groups an IPv4 address for inclusion at the end of an IPv6 address
     * @returns {String}
     */
    Address4.prototype.groupForV6 = function () {
        var segments = this.parsedAddress;
        return this.address.replace(constants.RE_ADDRESS, sprintf_js_1.sprintf('<span class="hover-group group-v4 group-6">%s</span>.<span class="hover-group group-v4 group-7">%s</span>', segments.slice(0, 2).join('.'), segments.slice(2, 4).join('.')));
    };
    return Address4;
}());
exports.Address4 = Address4;
//# sourceMappingURL=ipv4.js.map
  };
  __modules["ip-address/dist/lib/common.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCorrect = exports.isInSubnet = void 0;
function isInSubnet(address) {
    if (this.subnetMask < address.subnetMask) {
        return false;
    }
    if (this.mask(address.subnetMask) === address.mask()) {
        return true;
    }
    return false;
}
exports.isInSubnet = isInSubnet;
function isCorrect(defaultBits) {
    return function () {
        if (this.addressMinusSuffix !== this.correctForm()) {
            return false;
        }
        if (this.subnetMask === defaultBits && !this.parsedSubnet) {
            return true;
        }
        return this.parsedSubnet === String(this.subnetMask);
    };
}
exports.isCorrect = isCorrect;
//# sourceMappingURL=common.js.map
  };
  __modules["ip-address/dist/lib/v4/constants.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RE_SUBNET_STRING = exports.RE_ADDRESS = exports.GROUPS = exports.BITS = void 0;
exports.BITS = 32;
exports.GROUPS = 4;
exports.RE_ADDRESS = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/g;
exports.RE_SUBNET_STRING = /\/\d{1,2}$/;
//# sourceMappingURL=constants.js.map
  };
  __modules["ip-address/dist/lib/address-error.js"] = function (module, exports, require) {
"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddressError = void 0;
var AddressError = /** @class */ (function (_super) {
    __extends(AddressError, _super);
    function AddressError(message, parseMessage) {
        var _this = _super.call(this, message) || this;
        _this.name = 'AddressError';
        if (parseMessage !== null) {
            _this.parseMessage = parseMessage;
        }
        return _this;
    }
    return AddressError;
}(Error));
exports.AddressError = AddressError;
//# sourceMappingURL=address-error.js.map
  };
  __modules["jsbn/index.js"] = function (module, exports, require) {
(function(){

    // Copyright (c) 2005  Tom Wu
    // All Rights Reserved.
    // See "LICENSE" for details.

    // Basic JavaScript BN library - subset useful for RSA encryption.

    // Bits per digit
    var dbits;

    // JavaScript engine analysis
    var canary = 0xdeadbeefcafe;
    var j_lm = ((canary&0xffffff)==0xefcafe);

    // (public) Constructor
    function BigInteger(a,b,c) {
      if(a != null)
        if("number" == typeof a) this.fromNumber(a,b,c);
        else if(b == null && "string" != typeof a) this.fromString(a,256);
        else this.fromString(a,b);
    }

    // return new, unset BigInteger
    function nbi() { return new BigInteger(null); }

    // am: Compute w_j += (x*this_i), propagate carries,
    // c is initial carry, returns final carry.
    // c < 3*dvalue, x < 2*dvalue, this_i < dvalue
    // We need to select the fastest one that works in this environment.

    // am1: use a single mult and divide to get the high bits,
    // max digit bits should be 26 because
    // max internal value = 2*dvalue^2-2*dvalue (< 2^53)
    function am1(i,x,w,j,c,n) {
      while(--n >= 0) {
        var v = x*this[i++]+w[j]+c;
        c = Math.floor(v/0x4000000);
        w[j++] = v&0x3ffffff;
      }
      return c;
    }
    // am2 avoids a big mult-and-extract completely.
    // Max digit bits should be <= 30 because we do bitwise ops
    // on values up to 2*hdvalue^2-hdvalue-1 (< 2^31)
    function am2(i,x,w,j,c,n) {
      var xl = x&0x7fff, xh = x>>15;
      while(--n >= 0) {
        var l = this[i]&0x7fff;
        var h = this[i++]>>15;
        var m = xh*l+h*xl;
        l = xl*l+((m&0x7fff)<<15)+w[j]+(c&0x3fffffff);
        c = (l>>>30)+(m>>>15)+xh*h+(c>>>30);
        w[j++] = l&0x3fffffff;
      }
      return c;
    }
    // Alternately, set max digit bits to 28 since some
    // browsers slow down when dealing with 32-bit numbers.
    function am3(i,x,w,j,c,n) {
      var xl = x&0x3fff, xh = x>>14;
      while(--n >= 0) {
        var l = this[i]&0x3fff;
        var h = this[i++]>>14;
        var m = xh*l+h*xl;
        l = xl*l+((m&0x3fff)<<14)+w[j]+c;
        c = (l>>28)+(m>>14)+xh*h;
        w[j++] = l&0xfffffff;
      }
      return c;
    }
    var inBrowser = typeof navigator !== "undefined";
    if(inBrowser && j_lm && (navigator.appName == "Microsoft Internet Explorer")) {
      BigInteger.prototype.am = am2;
      dbits = 30;
    }
    else if(inBrowser && j_lm && (navigator.appName != "Netscape")) {
      BigInteger.prototype.am = am1;
      dbits = 26;
    }
    else { // Mozilla/Netscape seems to prefer am3
      BigInteger.prototype.am = am3;
      dbits = 28;
    }

    BigInteger.prototype.DB = dbits;
    BigInteger.prototype.DM = ((1<<dbits)-1);
    BigInteger.prototype.DV = (1<<dbits);

    var BI_FP = 52;
    BigInteger.prototype.FV = Math.pow(2,BI_FP);
    BigInteger.prototype.F1 = BI_FP-dbits;
    BigInteger.prototype.F2 = 2*dbits-BI_FP;

    // Digit conversions
    var BI_RM = "0123456789abcdefghijklmnopqrstuvwxyz";
    var BI_RC = new Array();
    var rr,vv;
    rr = "0".charCodeAt(0);
    for(vv = 0; vv <= 9; ++vv) BI_RC[rr++] = vv;
    rr = "a".charCodeAt(0);
    for(vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;
    rr = "A".charCodeAt(0);
    for(vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;

    function int2char(n) { return BI_RM.charAt(n); }
    function intAt(s,i) {
      var c = BI_RC[s.charCodeAt(i)];
      return (c==null)?-1:c;
    }

    // (protected) copy this to r
    function bnpCopyTo(r) {
      for(var i = this.t-1; i >= 0; --i) r[i] = this[i];
      r.t = this.t;
      r.s = this.s;
    }

    // (protected) set from integer value x, -DV <= x < DV
    function bnpFromInt(x) {
      this.t = 1;
      this.s = (x<0)?-1:0;
      if(x > 0) this[0] = x;
      else if(x < -1) this[0] = x+this.DV;
      else this.t = 0;
    }

    // return bigint initialized to value
    function nbv(i) { var r = nbi(); r.fromInt(i); return r; }

    // (protected) set from string and radix
    function bnpFromString(s,b) {
      var k;
      if(b == 16) k = 4;
      else if(b == 8) k = 3;
      else if(b == 256) k = 8; // byte array
      else if(b == 2) k = 1;
      else if(b == 32) k = 5;
      else if(b == 4) k = 2;
      else { this.fromRadix(s,b); return; }
      this.t = 0;
      this.s = 0;
      var i = s.length, mi = false, sh = 0;
      while(--i >= 0) {
        var x = (k==8)?s[i]&0xff:intAt(s,i);
        if(x < 0) {
          if(s.charAt(i) == "-") mi = true;
          continue;
        }
        mi = false;
        if(sh == 0)
          this[this.t++] = x;
        else if(sh+k > this.DB) {
          this[this.t-1] |= (x&((1<<(this.DB-sh))-1))<<sh;
          this[this.t++] = (x>>(this.DB-sh));
        }
        else
          this[this.t-1] |= x<<sh;
        sh += k;
        if(sh >= this.DB) sh -= this.DB;
      }
      if(k == 8 && (s[0]&0x80) != 0) {
        this.s = -1;
        if(sh > 0) this[this.t-1] |= ((1<<(this.DB-sh))-1)<<sh;
      }
      this.clamp();
      if(mi) BigInteger.ZERO.subTo(this,this);
    }

    // (protected) clamp off excess high words
    function bnpClamp() {
      var c = this.s&this.DM;
      while(this.t > 0 && this[this.t-1] == c) --this.t;
    }

    // (public) return string representation in given radix
    function bnToString(b) {
      if(this.s < 0) return "-"+this.negate().toString(b);
      var k;
      if(b == 16) k = 4;
      else if(b == 8) k = 3;
      else if(b == 2) k = 1;
      else if(b == 32) k = 5;
      else if(b == 4) k = 2;
      else return this.toRadix(b);
      var km = (1<<k)-1, d, m = false, r = "", i = this.t;
      var p = this.DB-(i*this.DB)%k;
      if(i-- > 0) {
        if(p < this.DB && (d = this[i]>>p) > 0) { m = true; r = int2char(d); }
        while(i >= 0) {
          if(p < k) {
            d = (this[i]&((1<<p)-1))<<(k-p);
            d |= this[--i]>>(p+=this.DB-k);
          }
          else {
            d = (this[i]>>(p-=k))&km;
            if(p <= 0) { p += this.DB; --i; }
          }
          if(d > 0) m = true;
          if(m) r += int2char(d);
        }
      }
      return m?r:"0";
    }

    // (public) -this
    function bnNegate() { var r = nbi(); BigInteger.ZERO.subTo(this,r); return r; }

    // (public) |this|
    function bnAbs() { return (this.s<0)?this.negate():this; }

    // (public) return + if this > a, - if this < a, 0 if equal
    function bnCompareTo(a) {
      var r = this.s-a.s;
      if(r != 0) return r;
      var i = this.t;
      r = i-a.t;
      if(r != 0) return (this.s<0)?-r:r;
      while(--i >= 0) if((r=this[i]-a[i]) != 0) return r;
      return 0;
    }

    // returns bit length of the integer x
    function nbits(x) {
      var r = 1, t;
      if((t=x>>>16) != 0) { x = t; r += 16; }
      if((t=x>>8) != 0) { x = t; r += 8; }
      if((t=x>>4) != 0) { x = t; r += 4; }
      if((t=x>>2) != 0) { x = t; r += 2; }
      if((t=x>>1) != 0) { x = t; r += 1; }
      return r;
    }

    // (public) return the number of bits in "this"
    function bnBitLength() {
      if(this.t <= 0) return 0;
      return this.DB*(this.t-1)+nbits(this[this.t-1]^(this.s&this.DM));
    }

    // (protected) r = this << n*DB
    function bnpDLShiftTo(n,r) {
      var i;
      for(i = this.t-1; i >= 0; --i) r[i+n] = this[i];
      for(i = n-1; i >= 0; --i) r[i] = 0;
      r.t = this.t+n;
      r.s = this.s;
    }

    // (protected) r = this >> n*DB
    function bnpDRShiftTo(n,r) {
      for(var i = n; i < this.t; ++i) r[i-n] = this[i];
      r.t = Math.max(this.t-n,0);
      r.s = this.s;
    }

    // (protected) r = this << n
    function bnpLShiftTo(n,r) {
      var bs = n%this.DB;
      var cbs = this.DB-bs;
      var bm = (1<<cbs)-1;
      var ds = Math.floor(n/this.DB), c = (this.s<<bs)&this.DM, i;
      for(i = this.t-1; i >= 0; --i) {
        r[i+ds+1] = (this[i]>>cbs)|c;
        c = (this[i]&bm)<<bs;
      }
      for(i = ds-1; i >= 0; --i) r[i] = 0;
      r[ds] = c;
      r.t = this.t+ds+1;
      r.s = this.s;
      r.clamp();
    }

    // (protected) r = this >> n
    function bnpRShiftTo(n,r) {
      r.s = this.s;
      var ds = Math.floor(n/this.DB);
      if(ds >= this.t) { r.t = 0; return; }
      var bs = n%this.DB;
      var cbs = this.DB-bs;
      var bm = (1<<bs)-1;
      r[0] = this[ds]>>bs;
      for(var i = ds+1; i < this.t; ++i) {
        r[i-ds-1] |= (this[i]&bm)<<cbs;
        r[i-ds] = this[i]>>bs;
      }
      if(bs > 0) r[this.t-ds-1] |= (this.s&bm)<<cbs;
      r.t = this.t-ds;
      r.clamp();
    }

    // (protected) r = this - a
    function bnpSubTo(a,r) {
      var i = 0, c = 0, m = Math.min(a.t,this.t);
      while(i < m) {
        c += this[i]-a[i];
        r[i++] = c&this.DM;
        c >>= this.DB;
      }
      if(a.t < this.t) {
        c -= a.s;
        while(i < this.t) {
          c += this[i];
          r[i++] = c&this.DM;
          c >>= this.DB;
        }
        c += this.s;
      }
      else {
        c += this.s;
        while(i < a.t) {
          c -= a[i];
          r[i++] = c&this.DM;
          c >>= this.DB;
        }
        c -= a.s;
      }
      r.s = (c<0)?-1:0;
      if(c < -1) r[i++] = this.DV+c;
      else if(c > 0) r[i++] = c;
      r.t = i;
      r.clamp();
    }

    // (protected) r = this * a, r != this,a (HAC 14.12)
    // "this" should be the larger one if appropriate.
    function bnpMultiplyTo(a,r) {
      var x = this.abs(), y = a.abs();
      var i = x.t;
      r.t = i+y.t;
      while(--i >= 0) r[i] = 0;
      for(i = 0; i < y.t; ++i) r[i+x.t] = x.am(0,y[i],r,i,0,x.t);
      r.s = 0;
      r.clamp();
      if(this.s != a.s) BigInteger.ZERO.subTo(r,r);
    }

    // (protected) r = this^2, r != this (HAC 14.16)
    function bnpSquareTo(r) {
      var x = this.abs();
      var i = r.t = 2*x.t;
      while(--i >= 0) r[i] = 0;
      for(i = 0; i < x.t-1; ++i) {
        var c = x.am(i,x[i],r,2*i,0,1);
        if((r[i+x.t]+=x.am(i+1,2*x[i],r,2*i+1,c,x.t-i-1)) >= x.DV) {
          r[i+x.t] -= x.DV;
          r[i+x.t+1] = 1;
        }
      }
      if(r.t > 0) r[r.t-1] += x.am(i,x[i],r,2*i,0,1);
      r.s = 0;
      r.clamp();
    }

    // (protected) divide this by m, quotient and remainder to q, r (HAC 14.20)
    // r != q, this != m.  q or r may be null.
    function bnpDivRemTo(m,q,r) {
      var pm = m.abs();
      if(pm.t <= 0) return;
      var pt = this.abs();
      if(pt.t < pm.t) {
        if(q != null) q.fromInt(0);
        if(r != null) this.copyTo(r);
        return;
      }
      if(r == null) r = nbi();
      var y = nbi(), ts = this.s, ms = m.s;
      var nsh = this.DB-nbits(pm[pm.t-1]);   // normalize modulus
      if(nsh > 0) { pm.lShiftTo(nsh,y); pt.lShiftTo(nsh,r); }
      else { pm.copyTo(y); pt.copyTo(r); }
      var ys = y.t;
      var y0 = y[ys-1];
      if(y0 == 0) return;
      var yt = y0*(1<<this.F1)+((ys>1)?y[ys-2]>>this.F2:0);
      var d1 = this.FV/yt, d2 = (1<<this.F1)/yt, e = 1<<this.F2;
      var i = r.t, j = i-ys, t = (q==null)?nbi():q;
      y.dlShiftTo(j,t);
      if(r.compareTo(t) >= 0) {
        r[r.t++] = 1;
        r.subTo(t,r);
      }
      BigInteger.ONE.dlShiftTo(ys,t);
      t.subTo(y,y);  // "negative" y so we can replace sub with am later
      while(y.t < ys) y[y.t++] = 0;
      while(--j >= 0) {
        // Estimate quotient digit
        var qd = (r[--i]==y0)?this.DM:Math.floor(r[i]*d1+(r[i-1]+e)*d2);
        if((r[i]+=y.am(0,qd,r,j,0,ys)) < qd) {   // Try it out
          y.dlShiftTo(j,t);
          r.subTo(t,r);
          while(r[i] < --qd) r.subTo(t,r);
        }
      }
      if(q != null) {
        r.drShiftTo(ys,q);
        if(ts != ms) BigInteger.ZERO.subTo(q,q);
      }
      r.t = ys;
      r.clamp();
      if(nsh > 0) r.rShiftTo(nsh,r); // Denormalize remainder
      if(ts < 0) BigInteger.ZERO.subTo(r,r);
    }

    // (public) this mod a
    function bnMod(a) {
      var r = nbi();
      this.abs().divRemTo(a,null,r);
      if(this.s < 0 && r.compareTo(BigInteger.ZERO) > 0) a.subTo(r,r);
      return r;
    }

    // Modular reduction using "classic" algorithm
    function Classic(m) { this.m = m; }
    function cConvert(x) {
      if(x.s < 0 || x.compareTo(this.m) >= 0) return x.mod(this.m);
      else return x;
    }
    function cRevert(x) { return x; }
    function cReduce(x) { x.divRemTo(this.m,null,x); }
    function cMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }
    function cSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

    Classic.prototype.convert = cConvert;
    Classic.prototype.revert = cRevert;
    Classic.prototype.reduce = cReduce;
    Classic.prototype.mulTo = cMulTo;
    Classic.prototype.sqrTo = cSqrTo;

    // (protected) return "-1/this % 2^DB"; useful for Mont. reduction
    // justification:
    //         xy == 1 (mod m)
    //         xy =  1+km
    //   xy(2-xy) = (1+km)(1-km)
    // x[y(2-xy)] = 1-k^2m^2
    // x[y(2-xy)] == 1 (mod m^2)
    // if y is 1/x mod m, then y(2-xy) is 1/x mod m^2
    // should reduce x and y(2-xy) by m^2 at each step to keep size bounded.
    // JS multiply "overflows" differently from C/C++, so care is needed here.
    function bnpInvDigit() {
      if(this.t < 1) return 0;
      var x = this[0];
      if((x&1) == 0) return 0;
      var y = x&3;       // y == 1/x mod 2^2
      y = (y*(2-(x&0xf)*y))&0xf; // y == 1/x mod 2^4
      y = (y*(2-(x&0xff)*y))&0xff;   // y == 1/x mod 2^8
      y = (y*(2-(((x&0xffff)*y)&0xffff)))&0xffff;    // y == 1/x mod 2^16
      // last step - calculate inverse mod DV directly;
      // assumes 16 < DB <= 32 and assumes ability to handle 48-bit ints
      y = (y*(2-x*y%this.DV))%this.DV;       // y == 1/x mod 2^dbits
      // we really want the negative inverse, and -DV < y < DV
      return (y>0)?this.DV-y:-y;
    }

    // Montgomery reduction
    function Montgomery(m) {
      this.m = m;
      this.mp = m.invDigit();
      this.mpl = this.mp&0x7fff;
      this.mph = this.mp>>15;
      this.um = (1<<(m.DB-15))-1;
      this.mt2 = 2*m.t;
    }

    // xR mod m
    function montConvert(x) {
      var r = nbi();
      x.abs().dlShiftTo(this.m.t,r);
      r.divRemTo(this.m,null,r);
      if(x.s < 0 && r.compareTo(BigInteger.ZERO) > 0) this.m.subTo(r,r);
      return r;
    }

    // x/R mod m
    function montRevert(x) {
      var r = nbi();
      x.copyTo(r);
      this.reduce(r);
      return r;
    }

    // x = x/R mod m (HAC 14.32)
    function montReduce(x) {
      while(x.t <= this.mt2) // pad x so am has enough room later
        x[x.t++] = 0;
      for(var i = 0; i < this.m.t; ++i) {
        // faster way of calculating u0 = x[i]*mp mod DV
        var j = x[i]&0x7fff;
        var u0 = (j*this.mpl+(((j*this.mph+(x[i]>>15)*this.mpl)&this.um)<<15))&x.DM;
        // use am to combine the multiply-shift-add into one call
        j = i+this.m.t;
        x[j] += this.m.am(0,u0,x,i,0,this.m.t);
        // propagate carry
        while(x[j] >= x.DV) { x[j] -= x.DV; x[++j]++; }
      }
      x.clamp();
      x.drShiftTo(this.m.t,x);
      if(x.compareTo(this.m) >= 0) x.subTo(this.m,x);
    }

    // r = "x^2/R mod m"; x != r
    function montSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

    // r = "xy/R mod m"; x,y != r
    function montMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }

    Montgomery.prototype.convert = montConvert;
    Montgomery.prototype.revert = montRevert;
    Montgomery.prototype.reduce = montReduce;
    Montgomery.prototype.mulTo = montMulTo;
    Montgomery.prototype.sqrTo = montSqrTo;

    // (protected) true iff this is even
    function bnpIsEven() { return ((this.t>0)?(this[0]&1):this.s) == 0; }

    // (protected) this^e, e < 2^32, doing sqr and mul with "r" (HAC 14.79)
    function bnpExp(e,z) {
      if(e > 0xffffffff || e < 1) return BigInteger.ONE;
      var r = nbi(), r2 = nbi(), g = z.convert(this), i = nbits(e)-1;
      g.copyTo(r);
      while(--i >= 0) {
        z.sqrTo(r,r2);
        if((e&(1<<i)) > 0) z.mulTo(r2,g,r);
        else { var t = r; r = r2; r2 = t; }
      }
      return z.revert(r);
    }

    // (public) this^e % m, 0 <= e < 2^32
    function bnModPowInt(e,m) {
      var z;
      if(e < 256 || m.isEven()) z = new Classic(m); else z = new Montgomery(m);
      return this.exp(e,z);
    }

    // protected
    BigInteger.prototype.copyTo = bnpCopyTo;
    BigInteger.prototype.fromInt = bnpFromInt;
    BigInteger.prototype.fromString = bnpFromString;
    BigInteger.prototype.clamp = bnpClamp;
    BigInteger.prototype.dlShiftTo = bnpDLShiftTo;
    BigInteger.prototype.drShiftTo = bnpDRShiftTo;
    BigInteger.prototype.lShiftTo = bnpLShiftTo;
    BigInteger.prototype.rShiftTo = bnpRShiftTo;
    BigInteger.prototype.subTo = bnpSubTo;
    BigInteger.prototype.multiplyTo = bnpMultiplyTo;
    BigInteger.prototype.squareTo = bnpSquareTo;
    BigInteger.prototype.divRemTo = bnpDivRemTo;
    BigInteger.prototype.invDigit = bnpInvDigit;
    BigInteger.prototype.isEven = bnpIsEven;
    BigInteger.prototype.exp = bnpExp;

    // public
    BigInteger.prototype.toString = bnToString;
    BigInteger.prototype.negate = bnNegate;
    BigInteger.prototype.abs = bnAbs;
    BigInteger.prototype.compareTo = bnCompareTo;
    BigInteger.prototype.bitLength = bnBitLength;
    BigInteger.prototype.mod = bnMod;
    BigInteger.prototype.modPowInt = bnModPowInt;

    // "constants"
    BigInteger.ZERO = nbv(0);
    BigInteger.ONE = nbv(1);

    // Copyright (c) 2005-2009  Tom Wu
    // All Rights Reserved.
    // See "LICENSE" for details.

    // Extended JavaScript BN functions, required for RSA private ops.

    // Version 1.1: new BigInteger("0", 10) returns "proper" zero
    // Version 1.2: square() API, isProbablePrime fix

    // (public)
    function bnClone() { var r = nbi(); this.copyTo(r); return r; }

    // (public) return value as integer
    function bnIntValue() {
      if(this.s < 0) {
        if(this.t == 1) return this[0]-this.DV;
        else if(this.t == 0) return -1;
      }
      else if(this.t == 1) return this[0];
      else if(this.t == 0) return 0;
      // assumes 16 < DB < 32
      return ((this[1]&((1<<(32-this.DB))-1))<<this.DB)|this[0];
    }

    // (public) return value as byte
    function bnByteValue() { return (this.t==0)?this.s:(this[0]<<24)>>24; }

    // (public) return value as short (assumes DB>=16)
    function bnShortValue() { return (this.t==0)?this.s:(this[0]<<16)>>16; }

    // (protected) return x s.t. r^x < DV
    function bnpChunkSize(r) { return Math.floor(Math.LN2*this.DB/Math.log(r)); }

    // (public) 0 if this == 0, 1 if this > 0
    function bnSigNum() {
      if(this.s < 0) return -1;
      else if(this.t <= 0 || (this.t == 1 && this[0] <= 0)) return 0;
      else return 1;
    }

    // (protected) convert to radix string
    function bnpToRadix(b) {
      if(b == null) b = 10;
      if(this.signum() == 0 || b < 2 || b > 36) return "0";
      var cs = this.chunkSize(b);
      var a = Math.pow(b,cs);
      var d = nbv(a), y = nbi(), z = nbi(), r = "";
      this.divRemTo(d,y,z);
      while(y.signum() > 0) {
        r = (a+z.intValue()).toString(b).substr(1) + r;
        y.divRemTo(d,y,z);
      }
      return z.intValue().toString(b) + r;
    }

    // (protected) convert from radix string
    function bnpFromRadix(s,b) {
      this.fromInt(0);
      if(b == null) b = 10;
      var cs = this.chunkSize(b);
      var d = Math.pow(b,cs), mi = false, j = 0, w = 0;
      for(var i = 0; i < s.length; ++i) {
        var x = intAt(s,i);
        if(x < 0) {
          if(s.charAt(i) == "-" && this.signum() == 0) mi = true;
          continue;
        }
        w = b*w+x;
        if(++j >= cs) {
          this.dMultiply(d);
          this.dAddOffset(w,0);
          j = 0;
          w = 0;
        }
      }
      if(j > 0) {
        this.dMultiply(Math.pow(b,j));
        this.dAddOffset(w,0);
      }
      if(mi) BigInteger.ZERO.subTo(this,this);
    }

    // (protected) alternate constructor
    function bnpFromNumber(a,b,c) {
      if("number" == typeof b) {
        // new BigInteger(int,int,RNG)
        if(a < 2) this.fromInt(1);
        else {
          this.fromNumber(a,c);
          if(!this.testBit(a-1))    // force MSB set
            this.bitwiseTo(BigInteger.ONE.shiftLeft(a-1),op_or,this);
          if(this.isEven()) this.dAddOffset(1,0); // force odd
          while(!this.isProbablePrime(b)) {
            this.dAddOffset(2,0);
            if(this.bitLength() > a) this.subTo(BigInteger.ONE.shiftLeft(a-1),this);
          }
        }
      }
      else {
        // new BigInteger(int,RNG)
        var x = new Array(), t = a&7;
        x.length = (a>>3)+1;
        b.nextBytes(x);
        if(t > 0) x[0] &= ((1<<t)-1); else x[0] = 0;
        this.fromString(x,256);
      }
    }

    // (public) convert to bigendian byte array
    function bnToByteArray() {
      var i = this.t, r = new Array();
      r[0] = this.s;
      var p = this.DB-(i*this.DB)%8, d, k = 0;
      if(i-- > 0) {
        if(p < this.DB && (d = this[i]>>p) != (this.s&this.DM)>>p)
          r[k++] = d|(this.s<<(this.DB-p));
        while(i >= 0) {
          if(p < 8) {
            d = (this[i]&((1<<p)-1))<<(8-p);
            d |= this[--i]>>(p+=this.DB-8);
          }
          else {
            d = (this[i]>>(p-=8))&0xff;
            if(p <= 0) { p += this.DB; --i; }
          }
          if((d&0x80) != 0) d |= -256;
          if(k == 0 && (this.s&0x80) != (d&0x80)) ++k;
          if(k > 0 || d != this.s) r[k++] = d;
        }
      }
      return r;
    }

    function bnEquals(a) { return(this.compareTo(a)==0); }
    function bnMin(a) { return(this.compareTo(a)<0)?this:a; }
    function bnMax(a) { return(this.compareTo(a)>0)?this:a; }

    // (protected) r = this op a (bitwise)
    function bnpBitwiseTo(a,op,r) {
      var i, f, m = Math.min(a.t,this.t);
      for(i = 0; i < m; ++i) r[i] = op(this[i],a[i]);
      if(a.t < this.t) {
        f = a.s&this.DM;
        for(i = m; i < this.t; ++i) r[i] = op(this[i],f);
        r.t = this.t;
      }
      else {
        f = this.s&this.DM;
        for(i = m; i < a.t; ++i) r[i] = op(f,a[i]);
        r.t = a.t;
      }
      r.s = op(this.s,a.s);
      r.clamp();
    }

    // (public) this & a
    function op_and(x,y) { return x&y; }
    function bnAnd(a) { var r = nbi(); this.bitwiseTo(a,op_and,r); return r; }

    // (public) this | a
    function op_or(x,y) { return x|y; }
    function bnOr(a) { var r = nbi(); this.bitwiseTo(a,op_or,r); return r; }

    // (public) this ^ a
    function op_xor(x,y) { return x^y; }
    function bnXor(a) { var r = nbi(); this.bitwiseTo(a,op_xor,r); return r; }

    // (public) this & ~a
    function op_andnot(x,y) { return x&~y; }
    function bnAndNot(a) { var r = nbi(); this.bitwiseTo(a,op_andnot,r); return r; }

    // (public) ~this
    function bnNot() {
      var r = nbi();
      for(var i = 0; i < this.t; ++i) r[i] = this.DM&~this[i];
      r.t = this.t;
      r.s = ~this.s;
      return r;
    }

    // (public) this << n
    function bnShiftLeft(n) {
      var r = nbi();
      if(n < 0) this.rShiftTo(-n,r); else this.lShiftTo(n,r);
      return r;
    }

    // (public) this >> n
    function bnShiftRight(n) {
      var r = nbi();
      if(n < 0) this.lShiftTo(-n,r); else this.rShiftTo(n,r);
      return r;
    }

    // return index of lowest 1-bit in x, x < 2^31
    function lbit(x) {
      if(x == 0) return -1;
      var r = 0;
      if((x&0xffff) == 0) { x >>= 16; r += 16; }
      if((x&0xff) == 0) { x >>= 8; r += 8; }
      if((x&0xf) == 0) { x >>= 4; r += 4; }
      if((x&3) == 0) { x >>= 2; r += 2; }
      if((x&1) == 0) ++r;
      return r;
    }

    // (public) returns index of lowest 1-bit (or -1 if none)
    function bnGetLowestSetBit() {
      for(var i = 0; i < this.t; ++i)
        if(this[i] != 0) return i*this.DB+lbit(this[i]);
      if(this.s < 0) return this.t*this.DB;
      return -1;
    }

    // return number of 1 bits in x
    function cbit(x) {
      var r = 0;
      while(x != 0) { x &= x-1; ++r; }
      return r;
    }

    // (public) return number of set bits
    function bnBitCount() {
      var r = 0, x = this.s&this.DM;
      for(var i = 0; i < this.t; ++i) r += cbit(this[i]^x);
      return r;
    }

    // (public) true iff nth bit is set
    function bnTestBit(n) {
      var j = Math.floor(n/this.DB);
      if(j >= this.t) return(this.s!=0);
      return((this[j]&(1<<(n%this.DB)))!=0);
    }

    // (protected) this op (1<<n)
    function bnpChangeBit(n,op) {
      var r = BigInteger.ONE.shiftLeft(n);
      this.bitwiseTo(r,op,r);
      return r;
    }

    // (public) this | (1<<n)
    function bnSetBit(n) { return this.changeBit(n,op_or); }

    // (public) this & ~(1<<n)
    function bnClearBit(n) { return this.changeBit(n,op_andnot); }

    // (public) this ^ (1<<n)
    function bnFlipBit(n) { return this.changeBit(n,op_xor); }

    // (protected) r = this + a
    function bnpAddTo(a,r) {
      var i = 0, c = 0, m = Math.min(a.t,this.t);
      while(i < m) {
        c += this[i]+a[i];
        r[i++] = c&this.DM;
        c >>= this.DB;
      }
      if(a.t < this.t) {
        c += a.s;
        while(i < this.t) {
          c += this[i];
          r[i++] = c&this.DM;
          c >>= this.DB;
        }
        c += this.s;
      }
      else {
        c += this.s;
        while(i < a.t) {
          c += a[i];
          r[i++] = c&this.DM;
          c >>= this.DB;
        }
        c += a.s;
      }
      r.s = (c<0)?-1:0;
      if(c > 0) r[i++] = c;
      else if(c < -1) r[i++] = this.DV+c;
      r.t = i;
      r.clamp();
    }

    // (public) this + a
    function bnAdd(a) { var r = nbi(); this.addTo(a,r); return r; }

    // (public) this - a
    function bnSubtract(a) { var r = nbi(); this.subTo(a,r); return r; }

    // (public) this * a
    function bnMultiply(a) { var r = nbi(); this.multiplyTo(a,r); return r; }

    // (public) this^2
    function bnSquare() { var r = nbi(); this.squareTo(r); return r; }

    // (public) this / a
    function bnDivide(a) { var r = nbi(); this.divRemTo(a,r,null); return r; }

    // (public) this % a
    function bnRemainder(a) { var r = nbi(); this.divRemTo(a,null,r); return r; }

    // (public) [this/a,this%a]
    function bnDivideAndRemainder(a) {
      var q = nbi(), r = nbi();
      this.divRemTo(a,q,r);
      return new Array(q,r);
    }

    // (protected) this *= n, this >= 0, 1 < n < DV
    function bnpDMultiply(n) {
      this[this.t] = this.am(0,n-1,this,0,0,this.t);
      ++this.t;
      this.clamp();
    }

    // (protected) this += n << w words, this >= 0
    function bnpDAddOffset(n,w) {
      if(n == 0) return;
      while(this.t <= w) this[this.t++] = 0;
      this[w] += n;
      while(this[w] >= this.DV) {
        this[w] -= this.DV;
        if(++w >= this.t) this[this.t++] = 0;
        ++this[w];
      }
    }

    // A "null" reducer
    function NullExp() {}
    function nNop(x) { return x; }
    function nMulTo(x,y,r) { x.multiplyTo(y,r); }
    function nSqrTo(x,r) { x.squareTo(r); }

    NullExp.prototype.convert = nNop;
    NullExp.prototype.revert = nNop;
    NullExp.prototype.mulTo = nMulTo;
    NullExp.prototype.sqrTo = nSqrTo;

    // (public) this^e
    function bnPow(e) { return this.exp(e,new NullExp()); }

    // (protected) r = lower n words of "this * a", a.t <= n
    // "this" should be the larger one if appropriate.
    function bnpMultiplyLowerTo(a,n,r) {
      var i = Math.min(this.t+a.t,n);
      r.s = 0; // assumes a,this >= 0
      r.t = i;
      while(i > 0) r[--i] = 0;
      var j;
      for(j = r.t-this.t; i < j; ++i) r[i+this.t] = this.am(0,a[i],r,i,0,this.t);
      for(j = Math.min(a.t,n); i < j; ++i) this.am(0,a[i],r,i,0,n-i);
      r.clamp();
    }

    // (protected) r = "this * a" without lower n words, n > 0
    // "this" should be the larger one if appropriate.
    function bnpMultiplyUpperTo(a,n,r) {
      --n;
      var i = r.t = this.t+a.t-n;
      r.s = 0; // assumes a,this >= 0
      while(--i >= 0) r[i] = 0;
      for(i = Math.max(n-this.t,0); i < a.t; ++i)
        r[this.t+i-n] = this.am(n-i,a[i],r,0,0,this.t+i-n);
      r.clamp();
      r.drShiftTo(1,r);
    }

    // Barrett modular reduction
    function Barrett(m) {
      // setup Barrett
      this.r2 = nbi();
      this.q3 = nbi();
      BigInteger.ONE.dlShiftTo(2*m.t,this.r2);
      this.mu = this.r2.divide(m);
      this.m = m;
    }

    function barrettConvert(x) {
      if(x.s < 0 || x.t > 2*this.m.t) return x.mod(this.m);
      else if(x.compareTo(this.m) < 0) return x;
      else { var r = nbi(); x.copyTo(r); this.reduce(r); return r; }
    }

    function barrettRevert(x) { return x; }

    // x = x mod m (HAC 14.42)
    function barrettReduce(x) {
      x.drShiftTo(this.m.t-1,this.r2);
      if(x.t > this.m.t+1) { x.t = this.m.t+1; x.clamp(); }
      this.mu.multiplyUpperTo(this.r2,this.m.t+1,this.q3);
      this.m.multiplyLowerTo(this.q3,this.m.t+1,this.r2);
      while(x.compareTo(this.r2) < 0) x.dAddOffset(1,this.m.t+1);
      x.subTo(this.r2,x);
      while(x.compareTo(this.m) >= 0) x.subTo(this.m,x);
    }

    // r = x^2 mod m; x != r
    function barrettSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

    // r = x*y mod m; x,y != r
    function barrettMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }

    Barrett.prototype.convert = barrettConvert;
    Barrett.prototype.revert = barrettRevert;
    Barrett.prototype.reduce = barrettReduce;
    Barrett.prototype.mulTo = barrettMulTo;
    Barrett.prototype.sqrTo = barrettSqrTo;

    // (public) this^e % m (HAC 14.85)
    function bnModPow(e,m) {
      var i = e.bitLength(), k, r = nbv(1), z;
      if(i <= 0) return r;
      else if(i < 18) k = 1;
      else if(i < 48) k = 3;
      else if(i < 144) k = 4;
      else if(i < 768) k = 5;
      else k = 6;
      if(i < 8)
        z = new Classic(m);
      else if(m.isEven())
        z = new Barrett(m);
      else
        z = new Montgomery(m);

      // precomputation
      var g = new Array(), n = 3, k1 = k-1, km = (1<<k)-1;
      g[1] = z.convert(this);
      if(k > 1) {
        var g2 = nbi();
        z.sqrTo(g[1],g2);
        while(n <= km) {
          g[n] = nbi();
          z.mulTo(g2,g[n-2],g[n]);
          n += 2;
        }
      }

      var j = e.t-1, w, is1 = true, r2 = nbi(), t;
      i = nbits(e[j])-1;
      while(j >= 0) {
        if(i >= k1) w = (e[j]>>(i-k1))&km;
        else {
          w = (e[j]&((1<<(i+1))-1))<<(k1-i);
          if(j > 0) w |= e[j-1]>>(this.DB+i-k1);
        }

        n = k;
        while((w&1) == 0) { w >>= 1; --n; }
        if((i -= n) < 0) { i += this.DB; --j; }
        if(is1) {    // ret == 1, don't bother squaring or multiplying it
          g[w].copyTo(r);
          is1 = false;
        }
        else {
          while(n > 1) { z.sqrTo(r,r2); z.sqrTo(r2,r); n -= 2; }
          if(n > 0) z.sqrTo(r,r2); else { t = r; r = r2; r2 = t; }
          z.mulTo(r2,g[w],r);
        }

        while(j >= 0 && (e[j]&(1<<i)) == 0) {
          z.sqrTo(r,r2); t = r; r = r2; r2 = t;
          if(--i < 0) { i = this.DB-1; --j; }
        }
      }
      return z.revert(r);
    }

    // (public) gcd(this,a) (HAC 14.54)
    function bnGCD(a) {
      var x = (this.s<0)?this.negate():this.clone();
      var y = (a.s<0)?a.negate():a.clone();
      if(x.compareTo(y) < 0) { var t = x; x = y; y = t; }
      var i = x.getLowestSetBit(), g = y.getLowestSetBit();
      if(g < 0) return x;
      if(i < g) g = i;
      if(g > 0) {
        x.rShiftTo(g,x);
        y.rShiftTo(g,y);
      }
      while(x.signum() > 0) {
        if((i = x.getLowestSetBit()) > 0) x.rShiftTo(i,x);
        if((i = y.getLowestSetBit()) > 0) y.rShiftTo(i,y);
        if(x.compareTo(y) >= 0) {
          x.subTo(y,x);
          x.rShiftTo(1,x);
        }
        else {
          y.subTo(x,y);
          y.rShiftTo(1,y);
        }
      }
      if(g > 0) y.lShiftTo(g,y);
      return y;
    }

    // (protected) this % n, n < 2^26
    function bnpModInt(n) {
      if(n <= 0) return 0;
      var d = this.DV%n, r = (this.s<0)?n-1:0;
      if(this.t > 0)
        if(d == 0) r = this[0]%n;
        else for(var i = this.t-1; i >= 0; --i) r = (d*r+this[i])%n;
      return r;
    }

    // (public) 1/this % m (HAC 14.61)
    function bnModInverse(m) {
      var ac = m.isEven();
      if((this.isEven() && ac) || m.signum() == 0) return BigInteger.ZERO;
      var u = m.clone(), v = this.clone();
      var a = nbv(1), b = nbv(0), c = nbv(0), d = nbv(1);
      while(u.signum() != 0) {
        while(u.isEven()) {
          u.rShiftTo(1,u);
          if(ac) {
            if(!a.isEven() || !b.isEven()) { a.addTo(this,a); b.subTo(m,b); }
            a.rShiftTo(1,a);
          }
          else if(!b.isEven()) b.subTo(m,b);
          b.rShiftTo(1,b);
        }
        while(v.isEven()) {
          v.rShiftTo(1,v);
          if(ac) {
            if(!c.isEven() || !d.isEven()) { c.addTo(this,c); d.subTo(m,d); }
            c.rShiftTo(1,c);
          }
          else if(!d.isEven()) d.subTo(m,d);
          d.rShiftTo(1,d);
        }
        if(u.compareTo(v) >= 0) {
          u.subTo(v,u);
          if(ac) a.subTo(c,a);
          b.subTo(d,b);
        }
        else {
          v.subTo(u,v);
          if(ac) c.subTo(a,c);
          d.subTo(b,d);
        }
      }
      if(v.compareTo(BigInteger.ONE) != 0) return BigInteger.ZERO;
      if(d.compareTo(m) >= 0) return d.subtract(m);
      if(d.signum() < 0) d.addTo(m,d); else return d;
      if(d.signum() < 0) return d.add(m); else return d;
    }

    var lowprimes = [2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97,101,103,107,109,113,127,131,137,139,149,151,157,163,167,173,179,181,191,193,197,199,211,223,227,229,233,239,241,251,257,263,269,271,277,281,283,293,307,311,313,317,331,337,347,349,353,359,367,373,379,383,389,397,401,409,419,421,431,433,439,443,449,457,461,463,467,479,487,491,499,503,509,521,523,541,547,557,563,569,571,577,587,593,599,601,607,613,617,619,631,641,643,647,653,659,661,673,677,683,691,701,709,719,727,733,739,743,751,757,761,769,773,787,797,809,811,821,823,827,829,839,853,857,859,863,877,881,883,887,907,911,919,929,937,941,947,953,967,971,977,983,991,997];
    var lplim = (1<<26)/lowprimes[lowprimes.length-1];

    // (public) test primality with certainty >= 1-.5^t
    function bnIsProbablePrime(t) {
      var i, x = this.abs();
      if(x.t == 1 && x[0] <= lowprimes[lowprimes.length-1]) {
        for(i = 0; i < lowprimes.length; ++i)
          if(x[0] == lowprimes[i]) return true;
        return false;
      }
      if(x.isEven()) return false;
      i = 1;
      while(i < lowprimes.length) {
        var m = lowprimes[i], j = i+1;
        while(j < lowprimes.length && m < lplim) m *= lowprimes[j++];
        m = x.modInt(m);
        while(i < j) if(m%lowprimes[i++] == 0) return false;
      }
      return x.millerRabin(t);
    }

    // (protected) true if probably prime (HAC 4.24, Miller-Rabin)
    function bnpMillerRabin(t) {
      var n1 = this.subtract(BigInteger.ONE);
      var k = n1.getLowestSetBit();
      if(k <= 0) return false;
      var r = n1.shiftRight(k);
      t = (t+1)>>1;
      if(t > lowprimes.length) t = lowprimes.length;
      var a = nbi();
      for(var i = 0; i < t; ++i) {
        //Pick bases at random, instead of starting at 2
        a.fromInt(lowprimes[Math.floor(Math.random()*lowprimes.length)]);
        var y = a.modPow(r,this);
        if(y.compareTo(BigInteger.ONE) != 0 && y.compareTo(n1) != 0) {
          var j = 1;
          while(j++ < k && y.compareTo(n1) != 0) {
            y = y.modPowInt(2,this);
            if(y.compareTo(BigInteger.ONE) == 0) return false;
          }
          if(y.compareTo(n1) != 0) return false;
        }
      }
      return true;
    }

    // protected
    BigInteger.prototype.chunkSize = bnpChunkSize;
    BigInteger.prototype.toRadix = bnpToRadix;
    BigInteger.prototype.fromRadix = bnpFromRadix;
    BigInteger.prototype.fromNumber = bnpFromNumber;
    BigInteger.prototype.bitwiseTo = bnpBitwiseTo;
    BigInteger.prototype.changeBit = bnpChangeBit;
    BigInteger.prototype.addTo = bnpAddTo;
    BigInteger.prototype.dMultiply = bnpDMultiply;
    BigInteger.prototype.dAddOffset = bnpDAddOffset;
    BigInteger.prototype.multiplyLowerTo = bnpMultiplyLowerTo;
    BigInteger.prototype.multiplyUpperTo = bnpMultiplyUpperTo;
    BigInteger.prototype.modInt = bnpModInt;
    BigInteger.prototype.millerRabin = bnpMillerRabin;

    // public
    BigInteger.prototype.clone = bnClone;
    BigInteger.prototype.intValue = bnIntValue;
    BigInteger.prototype.byteValue = bnByteValue;
    BigInteger.prototype.shortValue = bnShortValue;
    BigInteger.prototype.signum = bnSigNum;
    BigInteger.prototype.toByteArray = bnToByteArray;
    BigInteger.prototype.equals = bnEquals;
    BigInteger.prototype.min = bnMin;
    BigInteger.prototype.max = bnMax;
    BigInteger.prototype.and = bnAnd;
    BigInteger.prototype.or = bnOr;
    BigInteger.prototype.xor = bnXor;
    BigInteger.prototype.andNot = bnAndNot;
    BigInteger.prototype.not = bnNot;
    BigInteger.prototype.shiftLeft = bnShiftLeft;
    BigInteger.prototype.shiftRight = bnShiftRight;
    BigInteger.prototype.getLowestSetBit = bnGetLowestSetBit;
    BigInteger.prototype.bitCount = bnBitCount;
    BigInteger.prototype.testBit = bnTestBit;
    BigInteger.prototype.setBit = bnSetBit;
    BigInteger.prototype.clearBit = bnClearBit;
    BigInteger.prototype.flipBit = bnFlipBit;
    BigInteger.prototype.add = bnAdd;
    BigInteger.prototype.subtract = bnSubtract;
    BigInteger.prototype.multiply = bnMultiply;
    BigInteger.prototype.divide = bnDivide;
    BigInteger.prototype.remainder = bnRemainder;
    BigInteger.prototype.divideAndRemainder = bnDivideAndRemainder;
    BigInteger.prototype.modPow = bnModPow;
    BigInteger.prototype.modInverse = bnModInverse;
    BigInteger.prototype.pow = bnPow;
    BigInteger.prototype.gcd = bnGCD;
    BigInteger.prototype.isProbablePrime = bnIsProbablePrime;

    // JSBN-specific extension
    BigInteger.prototype.square = bnSquare;

    // Expose the Barrett function
    BigInteger.prototype.Barrett = Barrett

    // BigInteger interfaces not implemented in jsbn:

    // BigInteger(int signum, byte[] magnitude)
    // double doubleValue()
    // float floatValue()
    // int hashCode()
    // long longValue()
    // static BigInteger valueOf(long val)

    // Random number generator - requires a PRNG backend, e.g. prng4.js

    // For best results, put code like
    // <body onClick='rng_seed_time();' onKeyPress='rng_seed_time();'>
    // in your main HTML document.

    var rng_state;
    var rng_pool;
    var rng_pptr;

    // Mix in a 32-bit integer into the pool
    function rng_seed_int(x) {
      rng_pool[rng_pptr++] ^= x & 255;
      rng_pool[rng_pptr++] ^= (x >> 8) & 255;
      rng_pool[rng_pptr++] ^= (x >> 16) & 255;
      rng_pool[rng_pptr++] ^= (x >> 24) & 255;
      if(rng_pptr >= rng_psize) rng_pptr -= rng_psize;
    }

    // Mix in the current time (w/milliseconds) into the pool
    function rng_seed_time() {
      rng_seed_int(new Date().getTime());
    }

    // Initialize the pool with junk if needed.
    if(rng_pool == null) {
      rng_pool = new Array();
      rng_pptr = 0;
      var t;
      if(typeof window !== "undefined" && window.crypto) {
        if (window.crypto.getRandomValues) {
          // Use webcrypto if available
          var ua = new Uint8Array(32);
          window.crypto.getRandomValues(ua);
          for(t = 0; t < 32; ++t)
            rng_pool[rng_pptr++] = ua[t];
        }
        else if(navigator.appName == "Netscape" && navigator.appVersion < "5") {
          // Extract entropy (256 bits) from NS4 RNG if available
          var z = window.crypto.random(32);
          for(t = 0; t < z.length; ++t)
            rng_pool[rng_pptr++] = z.charCodeAt(t) & 255;
        }
      }
      while(rng_pptr < rng_psize) {  // extract some randomness from Math.random()
        t = Math.floor(65536 * Math.random());
        rng_pool[rng_pptr++] = t >>> 8;
        rng_pool[rng_pptr++] = t & 255;
      }
      rng_pptr = 0;
      rng_seed_time();
      //rng_seed_int(window.screenX);
      //rng_seed_int(window.screenY);
    }

    function rng_get_byte() {
      if(rng_state == null) {
        rng_seed_time();
        rng_state = prng_newstate();
        rng_state.init(rng_pool);
        for(rng_pptr = 0; rng_pptr < rng_pool.length; ++rng_pptr)
          rng_pool[rng_pptr] = 0;
        rng_pptr = 0;
        //rng_pool = null;
      }
      // TODO: allow reseeding after first request
      return rng_state.next();
    }

    function rng_get_bytes(ba) {
      var i;
      for(i = 0; i < ba.length; ++i) ba[i] = rng_get_byte();
    }

    function SecureRandom() {}

    SecureRandom.prototype.nextBytes = rng_get_bytes;

    // prng4.js - uses Arcfour as a PRNG

    function Arcfour() {
      this.i = 0;
      this.j = 0;
      this.S = new Array();
    }

    // Initialize arcfour context from key, an array of ints, each from [0..255]
    function ARC4init(key) {
      var i, j, t;
      for(i = 0; i < 256; ++i)
        this.S[i] = i;
      j = 0;
      for(i = 0; i < 256; ++i) {
        j = (j + this.S[i] + key[i % key.length]) & 255;
        t = this.S[i];
        this.S[i] = this.S[j];
        this.S[j] = t;
      }
      this.i = 0;
      this.j = 0;
    }

    function ARC4next() {
      var t;
      this.i = (this.i + 1) & 255;
      this.j = (this.j + this.S[this.i]) & 255;
      t = this.S[this.i];
      this.S[this.i] = this.S[this.j];
      this.S[this.j] = t;
      return this.S[(t + this.S[this.i]) & 255];
    }

    Arcfour.prototype.init = ARC4init;
    Arcfour.prototype.next = ARC4next;

    // Plug in your RNG constructor here
    function prng_newstate() {
      return new Arcfour();
    }

    // Pool size must be a multiple of 4 and greater than 32.
    // An array of bytes the size of the pool will be passed to init()
    var rng_psize = 256;

    if (typeof exports !== 'undefined') {
        exports = module.exports = {
            default: BigInteger,
            BigInteger: BigInteger,
            SecureRandom: SecureRandom,
        };
    } else {
        this.jsbn = {
          BigInteger: BigInteger,
          SecureRandom: SecureRandom
        };
    }

}).call(this);

  };
  __modules["sprintf-js/src/sprintf.js"] = function (module, exports, require) {
/* global window, exports, define */

!function() {
    'use strict'

    var re = {
        not_string: /[^s]/,
        not_bool: /[^t]/,
        not_type: /[^T]/,
        not_primitive: /[^v]/,
        number: /[diefg]/,
        numeric_arg: /[bcdiefguxX]/,
        json: /[j]/,
        not_json: /[^j]/,
        text: /^[^\x25]+/,
        modulo: /^\x25{2}/,
        placeholder: /^\x25(?:([1-9]\d*)\$|\(([^)]+)\))?(\+)?(0|'[^$])?(-)?(\d+)?(?:\.(\d+))?([b-gijostTuvxX])/,
        key: /^([a-z_][a-z_\d]*)/i,
        key_access: /^\.([a-z_][a-z_\d]*)/i,
        index_access: /^\[(\d+)\]/,
        sign: /^[+-]/
    }

    function sprintf(key) {
        // `arguments` is not an array, but should be fine for this call
        return sprintf_format(sprintf_parse(key), arguments)
    }

    function vsprintf(fmt, argv) {
        return sprintf.apply(null, [fmt].concat(argv || []))
    }

    function sprintf_format(parse_tree, argv) {
        var cursor = 1, tree_length = parse_tree.length, arg, output = '', i, k, ph, pad, pad_character, pad_length, is_positive, sign
        for (i = 0; i < tree_length; i++) {
            if (typeof parse_tree[i] === 'string') {
                output += parse_tree[i]
            }
            else if (typeof parse_tree[i] === 'object') {
                ph = parse_tree[i] // convenience purposes only
                if (ph.keys) { // keyword argument
                    arg = argv[cursor]
                    for (k = 0; k < ph.keys.length; k++) {
                        if (arg == undefined) {
                            throw new Error(sprintf('[sprintf] Cannot access property "%s" of undefined value "%s"', ph.keys[k], ph.keys[k-1]))
                        }
                        arg = arg[ph.keys[k]]
                    }
                }
                else if (ph.param_no) { // positional argument (explicit)
                    arg = argv[ph.param_no]
                }
                else { // positional argument (implicit)
                    arg = argv[cursor++]
                }

                if (re.not_type.test(ph.type) && re.not_primitive.test(ph.type) && arg instanceof Function) {
                    arg = arg()
                }

                if (re.numeric_arg.test(ph.type) && (typeof arg !== 'number' && isNaN(arg))) {
                    throw new TypeError(sprintf('[sprintf] expecting number but found %T', arg))
                }

                if (re.number.test(ph.type)) {
                    is_positive = arg >= 0
                }

                switch (ph.type) {
                    case 'b':
                        arg = parseInt(arg, 10).toString(2)
                        break
                    case 'c':
                        arg = String.fromCharCode(parseInt(arg, 10))
                        break
                    case 'd':
                    case 'i':
                        arg = parseInt(arg, 10)
                        break
                    case 'j':
                        arg = JSON.stringify(arg, null, ph.width ? parseInt(ph.width) : 0)
                        break
                    case 'e':
                        arg = ph.precision ? parseFloat(arg).toExponential(ph.precision) : parseFloat(arg).toExponential()
                        break
                    case 'f':
                        arg = ph.precision ? parseFloat(arg).toFixed(ph.precision) : parseFloat(arg)
                        break
                    case 'g':
                        arg = ph.precision ? String(Number(arg.toPrecision(ph.precision))) : parseFloat(arg)
                        break
                    case 'o':
                        arg = (parseInt(arg, 10) >>> 0).toString(8)
                        break
                    case 's':
                        arg = String(arg)
                        arg = (ph.precision ? arg.substring(0, ph.precision) : arg)
                        break
                    case 't':
                        arg = String(!!arg)
                        arg = (ph.precision ? arg.substring(0, ph.precision) : arg)
                        break
                    case 'T':
                        arg = Object.prototype.toString.call(arg).slice(8, -1).toLowerCase()
                        arg = (ph.precision ? arg.substring(0, ph.precision) : arg)
                        break
                    case 'u':
                        arg = parseInt(arg, 10) >>> 0
                        break
                    case 'v':
                        arg = arg.valueOf()
                        arg = (ph.precision ? arg.substring(0, ph.precision) : arg)
                        break
                    case 'x':
                        arg = (parseInt(arg, 10) >>> 0).toString(16)
                        break
                    case 'X':
                        arg = (parseInt(arg, 10) >>> 0).toString(16).toUpperCase()
                        break
                }
                if (re.json.test(ph.type)) {
                    output += arg
                }
                else {
                    if (re.number.test(ph.type) && (!is_positive || ph.sign)) {
                        sign = is_positive ? '+' : '-'
                        arg = arg.toString().replace(re.sign, '')
                    }
                    else {
                        sign = ''
                    }
                    pad_character = ph.pad_char ? ph.pad_char === '0' ? '0' : ph.pad_char.charAt(1) : ' '
                    pad_length = ph.width - (sign + arg).length
                    pad = ph.width ? (pad_length > 0 ? pad_character.repeat(pad_length) : '') : ''
                    output += ph.align ? sign + arg + pad : (pad_character === '0' ? sign + pad + arg : pad + sign + arg)
                }
            }
        }
        return output
    }

    var sprintf_cache = Object.create(null)

    function sprintf_parse(fmt) {
        if (sprintf_cache[fmt]) {
            return sprintf_cache[fmt]
        }

        var _fmt = fmt, match, parse_tree = [], arg_names = 0
        while (_fmt) {
            if ((match = re.text.exec(_fmt)) !== null) {
                parse_tree.push(match[0])
            }
            else if ((match = re.modulo.exec(_fmt)) !== null) {
                parse_tree.push('%')
            }
            else if ((match = re.placeholder.exec(_fmt)) !== null) {
                if (match[2]) {
                    arg_names |= 1
                    var field_list = [], replacement_field = match[2], field_match = []
                    if ((field_match = re.key.exec(replacement_field)) !== null) {
                        field_list.push(field_match[1])
                        while ((replacement_field = replacement_field.substring(field_match[0].length)) !== '') {
                            if ((field_match = re.key_access.exec(replacement_field)) !== null) {
                                field_list.push(field_match[1])
                            }
                            else if ((field_match = re.index_access.exec(replacement_field)) !== null) {
                                field_list.push(field_match[1])
                            }
                            else {
                                throw new SyntaxError('[sprintf] failed to parse named argument key')
                            }
                        }
                    }
                    else {
                        throw new SyntaxError('[sprintf] failed to parse named argument key')
                    }
                    match[2] = field_list
                }
                else {
                    arg_names |= 2
                }
                if (arg_names === 3) {
                    throw new Error('[sprintf] mixing positional and named placeholders is not (yet) supported')
                }

                parse_tree.push(
                    {
                        placeholder: match[0],
                        param_no:    match[1],
                        keys:        match[2],
                        sign:        match[3],
                        pad_char:    match[4],
                        align:       match[5],
                        width:       match[6],
                        precision:   match[7],
                        type:        match[8]
                    }
                )
            }
            else {
                throw new SyntaxError('[sprintf] unexpected placeholder')
            }
            _fmt = _fmt.substring(match[0].length)
        }
        return sprintf_cache[fmt] = parse_tree
    }

    /**
     * export to either browser or node.js
     */
    /* eslint-disable quote-props */
    if (typeof exports !== 'undefined') {
        exports['sprintf'] = sprintf
        exports['vsprintf'] = vsprintf
    }
    if (typeof window !== 'undefined') {
        window['sprintf'] = sprintf
        window['vsprintf'] = vsprintf

        if (typeof define === 'function' && define['amd']) {
            define(function() {
                return {
                    'sprintf': sprintf,
                    'vsprintf': vsprintf
                }
            })
        }
    }
    /* eslint-enable quote-props */
}(); // eslint-disable-line

  };
  __modules["ip-address/dist/lib/ipv6.js"] = function (module, exports, require) {
"use strict";
/* eslint-disable prefer-destructuring */
/* eslint-disable no-param-reassign */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __spreadArrays = (this && this.__spreadArrays) || function () {
    for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
    for (var r = Array(s), k = 0, i = 0; i < il; i++)
        for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
    return r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Address6 = void 0;
var common = __importStar(require("./common"));
var constants4 = __importStar(require("./v4/constants"));
var constants6 = __importStar(require("./v6/constants"));
var helpers = __importStar(require("./v6/helpers"));
var ipv4_1 = require("./ipv4");
var regular_expressions_1 = require("./v6/regular-expressions");
var address_error_1 = require("./address-error");
var jsbn_1 = require("jsbn");
var sprintf_js_1 = require("sprintf-js");
function assert(condition) {
    if (!condition) {
        throw new Error('Assertion failed.');
    }
}
function addCommas(number) {
    var r = /(\d+)(\d{3})/;
    while (r.test(number)) {
        number = number.replace(r, '$1,$2');
    }
    return number;
}
function spanLeadingZeroes4(n) {
    n = n.replace(/^(0{1,})([1-9]+)$/, '<span class="parse-error">$1</span>$2');
    n = n.replace(/^(0{1,})(0)$/, '<span class="parse-error">$1</span>$2');
    return n;
}
/*
 * A helper function to compact an array
 */
function compact(address, slice) {
    var s1 = [];
    var s2 = [];
    var i;
    for (i = 0; i < address.length; i++) {
        if (i < slice[0]) {
            s1.push(address[i]);
        }
        else if (i > slice[1]) {
            s2.push(address[i]);
        }
    }
    return s1.concat(['compact']).concat(s2);
}
function paddedHex(octet) {
    return sprintf_js_1.sprintf('%04x', parseInt(octet, 16));
}
function unsignByte(b) {
    // eslint-disable-next-line no-bitwise
    return b & 0xff;
}
/**
 * Represents an IPv6 address
 * @class Address6
 * @param {string} address - An IPv6 address string
 * @param {number} [groups=8] - How many octets to parse
 * @example
 * var address = new Address6('2001::/32');
 */
var Address6 = /** @class */ (function () {
    function Address6(address, optionalGroups) {
        this.addressMinusSuffix = '';
        this.parsedSubnet = '';
        this.subnet = '/128';
        this.subnetMask = 128;
        this.v4 = false;
        this.zone = '';
        // #region Attributes
        /**
         * Returns true if the given address is in the subnet of the current address
         * @memberof Address6
         * @instance
         * @returns {boolean}
         */
        this.isInSubnet = common.isInSubnet;
        /**
         * Returns true if the address is correct, false otherwise
         * @memberof Address6
         * @instance
         * @returns {boolean}
         */
        this.isCorrect = common.isCorrect(constants6.BITS);
        if (optionalGroups === undefined) {
            this.groups = constants6.GROUPS;
        }
        else {
            this.groups = optionalGroups;
        }
        this.address = address;
        var subnet = constants6.RE_SUBNET_STRING.exec(address);
        if (subnet) {
            this.parsedSubnet = subnet[0].replace('/', '');
            this.subnetMask = parseInt(this.parsedSubnet, 10);
            this.subnet = "/" + this.subnetMask;
            if (Number.isNaN(this.subnetMask) ||
                this.subnetMask < 0 ||
                this.subnetMask > constants6.BITS) {
                throw new address_error_1.AddressError('Invalid subnet mask.');
            }
            address = address.replace(constants6.RE_SUBNET_STRING, '');
        }
        else if (/\//.test(address)) {
            throw new address_error_1.AddressError('Invalid subnet mask.');
        }
        var zone = constants6.RE_ZONE_STRING.exec(address);
        if (zone) {
            this.zone = zone[0];
            address = address.replace(constants6.RE_ZONE_STRING, '');
        }
        this.addressMinusSuffix = address;
        this.parsedAddress = this.parse(this.addressMinusSuffix);
    }
    Address6.isValid = function (address) {
        try {
            // eslint-disable-next-line no-new
            new Address6(address);
            return true;
        }
        catch (e) {
            return false;
        }
    };
    /**
     * Convert a BigInteger to a v6 address object
     * @memberof Address6
     * @static
     * @param {BigInteger} bigInteger - a BigInteger to convert
     * @returns {Address6}
     * @example
     * var bigInteger = new BigInteger('1000000000000');
     * var address = Address6.fromBigInteger(bigInteger);
     * address.correctForm(); // '::e8:d4a5:1000'
     */
    Address6.fromBigInteger = function (bigInteger) {
        var hex = bigInteger.toString(16).padStart(32, '0');
        var groups = [];
        var i;
        for (i = 0; i < constants6.GROUPS; i++) {
            groups.push(hex.slice(i * 4, (i + 1) * 4));
        }
        return new Address6(groups.join(':'));
    };
    /**
     * Convert a URL (with optional port number) to an address object
     * @memberof Address6
     * @static
     * @param {string} url - a URL with optional port number
     * @example
     * var addressAndPort = Address6.fromURL('http://[ffff::]:8080/foo/');
     * addressAndPort.address.correctForm(); // 'ffff::'
     * addressAndPort.port; // 8080
     */
    Address6.fromURL = function (url) {
        var host;
        var port = null;
        var result;
        // If we have brackets parse them and find a port
        if (url.indexOf('[') !== -1 && url.indexOf(']:') !== -1) {
            result = constants6.RE_URL_WITH_PORT.exec(url);
            if (result === null) {
                return {
                    error: 'failed to parse address with port',
                    address: null,
                    port: null,
                };
            }
            host = result[1];
            port = result[2];
            // If there's a URL extract the address
        }
        else if (url.indexOf('/') !== -1) {
            // Remove the protocol prefix
            url = url.replace(/^[a-z0-9]+:\/\//, '');
            // Parse the address
            result = constants6.RE_URL.exec(url);
            if (result === null) {
                return {
                    error: 'failed to parse address from URL',
                    address: null,
                    port: null,
                };
            }
            host = result[1];
            // Otherwise just assign the URL to the host and let the library parse it
        }
        else {
            host = url;
        }
        // If there's a port convert it to an integer
        if (port) {
            port = parseInt(port, 10);
            // squelch out of range ports
            if (port < 0 || port > 65536) {
                port = null;
            }
        }
        else {
            // Standardize `undefined` to `null`
            port = null;
        }
        return {
            address: new Address6(host),
            port: port,
        };
    };
    /**
     * Create an IPv6-mapped address given an IPv4 address
     * @memberof Address6
     * @static
     * @param {string} address - An IPv4 address string
     * @returns {Address6}
     * @example
     * var address = Address6.fromAddress4('192.168.0.1');
     * address.correctForm(); // '::ffff:c0a8:1'
     * address.to4in6(); // '::ffff:192.168.0.1'
     */
    Address6.fromAddress4 = function (address) {
        var address4 = new ipv4_1.Address4(address);
        var mask6 = constants6.BITS - (constants4.BITS - address4.subnetMask);
        return new Address6("::ffff:" + address4.correctForm() + "/" + mask6);
    };
    /**
     * Return an address from ip6.arpa form
     * @memberof Address6
     * @static
     * @param {string} arpaFormAddress - an 'ip6.arpa' form address
     * @returns {Adress6}
     * @example
     * var address = Address6.fromArpa(e.f.f.f.3.c.2.6.f.f.f.e.6.6.8.e.1.0.6.7.9.4.e.c.0.0.0.0.1.0.0.2.ip6.arpa.)
     * address.correctForm(); // '2001:0:ce49:7601:e866:efff:62c3:fffe'
     */
    Address6.fromArpa = function (arpaFormAddress) {
        // remove ending ".ip6.arpa." or just "."
        var address = arpaFormAddress.replace(/(\.ip6\.arpa)?\.$/, '');
        var semicolonAmount = 7;
        // correct ip6.arpa form with ending removed will be 63 characters
        if (address.length !== 63) {
            throw new address_error_1.AddressError("Invalid 'ip6.arpa' form.");
        }
        var parts = address.split('.').reverse();
        for (var i = semicolonAmount; i > 0; i--) {
            var insertIndex = i * 4;
            parts.splice(insertIndex, 0, ':');
        }
        address = parts.join('');
        return new Address6(address);
    };
    /**
     * Return the Microsoft UNC transcription of the address
     * @memberof Address6
     * @instance
     * @returns {String} the Microsoft UNC transcription of the address
     */
    Address6.prototype.microsoftTranscription = function () {
        return sprintf_js_1.sprintf('%s.ipv6-literal.net', this.correctForm().replace(/:/g, '-'));
    };
    /**
     * Return the first n bits of the address, defaulting to the subnet mask
     * @memberof Address6
     * @instance
     * @param {number} [mask=subnet] - the number of bits to mask
     * @returns {String} the first n bits of the address as a string
     */
    Address6.prototype.mask = function (mask) {
        if (mask === void 0) { mask = this.subnetMask; }
        return this.getBitsBase2(0, mask);
    };
    /**
     * Return the number of possible subnets of a given size in the address
     * @memberof Address6
     * @instance
     * @param {number} [size=128] - the subnet size
     * @returns {String}
     */
    // TODO: probably useful to have a numeric version of this too
    Address6.prototype.possibleSubnets = function (subnetSize) {
        if (subnetSize === void 0) { subnetSize = 128; }
        var availableBits = constants6.BITS - this.subnetMask;
        var subnetBits = Math.abs(subnetSize - constants6.BITS);
        var subnetPowers = availableBits - subnetBits;
        if (subnetPowers < 0) {
            return '0';
        }
        return addCommas(new jsbn_1.BigInteger('2', 10).pow(subnetPowers).toString(10));
    };
    /**
     * Helper function getting start address.
     * @memberof Address6
     * @instance
     * @returns {BigInteger}
     */
    Address6.prototype._startAddress = function () {
        return new jsbn_1.BigInteger(this.mask() + '0'.repeat(constants6.BITS - this.subnetMask), 2);
    };
    /**
     * The first address in the range given by this address' subnet
     * Often referred to as the Network Address.
     * @memberof Address6
     * @instance
     * @returns {Address6}
     */
    Address6.prototype.startAddress = function () {
        return Address6.fromBigInteger(this._startAddress());
    };
    /**
     * The first host address in the range given by this address's subnet ie
     * the first address after the Network Address
     * @memberof Address6
     * @instance
     * @returns {Address6}
     */
    Address6.prototype.startAddressExclusive = function () {
        var adjust = new jsbn_1.BigInteger('1');
        return Address6.fromBigInteger(this._startAddress().add(adjust));
    };
    /**
     * Helper function getting end address.
     * @memberof Address6
     * @instance
     * @returns {BigInteger}
     */
    Address6.prototype._endAddress = function () {
        return new jsbn_1.BigInteger(this.mask() + '1'.repeat(constants6.BITS - this.subnetMask), 2);
    };
    /**
     * The last address in the range given by this address' subnet
     * Often referred to as the Broadcast
     * @memberof Address6
     * @instance
     * @returns {Address6}
     */
    Address6.prototype.endAddress = function () {
        return Address6.fromBigInteger(this._endAddress());
    };
    /**
     * The last host address in the range given by this address's subnet ie
     * the last address prior to the Broadcast Address
     * @memberof Address6
     * @instance
     * @returns {Address6}
     */
    Address6.prototype.endAddressExclusive = function () {
        var adjust = new jsbn_1.BigInteger('1');
        return Address6.fromBigInteger(this._endAddress().subtract(adjust));
    };
    /**
     * Return the scope of the address
     * @memberof Address6
     * @instance
     * @returns {String}
     */
    Address6.prototype.getScope = function () {
        var scope = constants6.SCOPES[this.getBits(12, 16).intValue()];
        if (this.getType() === 'Global unicast' && scope !== 'Link local') {
            scope = 'Global';
        }
        return scope || 'Unknown';
    };
    /**
     * Return the type of the address
     * @memberof Address6
     * @instance
     * @returns {String}
     */
    Address6.prototype.getType = function () {
        for (var _i = 0, _a = Object.keys(constants6.TYPES); _i < _a.length; _i++) {
            var subnet = _a[_i];
            if (this.isInSubnet(new Address6(subnet))) {
                return constants6.TYPES[subnet];
            }
        }
        return 'Global unicast';
    };
    /**
     * Return the bits in the given range as a BigInteger
     * @memberof Address6
     * @instance
     * @returns {BigInteger}
     */
    Address6.prototype.getBits = function (start, end) {
        return new jsbn_1.BigInteger(this.getBitsBase2(start, end), 2);
    };
    /**
     * Return the bits in the given range as a base-2 string
     * @memberof Address6
     * @instance
     * @returns {String}
     */
    Address6.prototype.getBitsBase2 = function (start, end) {
        return this.binaryZeroPad().slice(start, end);
    };
    /**
     * Return the bits in the given range as a base-16 string
     * @memberof Address6
     * @instance
     * @returns {String}
     */
    Address6.prototype.getBitsBase16 = function (start, end) {
        var length = end - start;
        if (length % 4 !== 0) {
            throw new Error('Length of bits to retrieve must be divisible by four');
        }
        return this.getBits(start, end)
            .toString(16)
            .padStart(length / 4, '0');
    };
    /**
     * Return the bits that are set past the subnet mask length
     * @memberof Address6
     * @instance
     * @returns {String}
     */
    Address6.prototype.getBitsPastSubnet = function () {
        return this.getBitsBase2(this.subnetMask, constants6.BITS);
    };
    /**
     * Return the reversed ip6.arpa form of the address
     * @memberof Address6
     * @param {Object} options
     * @param {boolean} options.omitSuffix - omit the "ip6.arpa" suffix
     * @instance
     * @returns {String}
     */
    Address6.prototype.reverseForm = function (options) {
        if (!options) {
            options = {};
        }
        var characters = Math.floor(this.subnetMask / 4);
        var reversed = this.canonicalForm()
            .replace(/:/g, '')
            .split('')
            .slice(0, characters)
            .reverse()
            .join('.');
        if (characters > 0) {
            if (options.omitSuffix) {
                return reversed;
            }
            return sprintf_js_1.sprintf('%s.ip6.arpa.', reversed);
        }
        if (options.omitSuffix) {
            return '';
        }
        return 'ip6.arpa.';
    };
    /**
     * Return the correct form of the address
     * @memberof Address6
     * @instance
     * @returns {String}
     */
    Address6.prototype.correctForm = function () {
        var i;
        var groups = [];
        var zeroCounter = 0;
        var zeroes = [];
        for (i = 0; i < this.parsedAddress.length; i++) {
            var value = parseInt(this.parsedAddress[i], 16);
            if (value === 0) {
                zeroCounter++;
            }
            if (value !== 0 && zeroCounter > 0) {
                if (zeroCounter > 1) {
                    zeroes.push([i - zeroCounter, i - 1]);
                }
                zeroCounter = 0;
            }
        }
        // Do we end with a string of zeroes?
        if (zeroCounter > 1) {
            zeroes.push([this.parsedAddress.length - zeroCounter, this.parsedAddress.length - 1]);
        }
        var zeroLengths = zeroes.map(function (n) { return n[1] - n[0] + 1; });
        if (zeroes.length > 0) {
            var index = zeroLengths.indexOf(Math.max.apply(Math, zeroLengths));
            groups = compact(this.parsedAddress, zeroes[index]);
        }
        else {
            groups = this.parsedAddress;
        }
        for (i = 0; i < groups.length; i++) {
            if (groups[i] !== 'compact') {
                groups[i] = parseInt(groups[i], 16).toString(16);
            }
        }
        var correct = groups.join(':');
        correct = correct.replace(/^compact$/, '::');
        correct = correct.replace(/^compact|compact$/, ':');
        correct = correct.replace(/compact/, '');
        return correct;
    };
    /**
     * Return a zero-padded base-2 string representation of the address
     * @memberof Address6
     * @instance
     * @returns {String}
     * @example
     * var address = new Address6('2001:4860:4001:803::1011');
     * address.binaryZeroPad();
     * // '0010000000000001010010000110000001000000000000010000100000000011
     * //  0000000000000000000000000000000000000000000000000001000000010001'
     */
    Address6.prototype.binaryZeroPad = function () {
        return this.bigInteger().toString(2).padStart(constants6.BITS, '0');
    };
    // TODO: Improve the semantics of this helper function
    Address6.prototype.parse4in6 = function (address) {
        var groups = address.split(':');
        var lastGroup = groups.slice(-1)[0];
        var address4 = lastGroup.match(constants4.RE_ADDRESS);
        if (address4) {
            this.parsedAddress4 = address4[0];
            this.address4 = new ipv4_1.Address4(this.parsedAddress4);
            for (var i = 0; i < this.address4.groups; i++) {
                if (/^0[0-9]+/.test(this.address4.parsedAddress[i])) {
                    throw new address_error_1.AddressError("IPv4 addresses can't have leading zeroes.", address.replace(constants4.RE_ADDRESS, this.address4.parsedAddress.map(spanLeadingZeroes4).join('.')));
                }
            }
            this.v4 = true;
            groups[groups.length - 1] = this.address4.toGroup6();
            address = groups.join(':');
        }
        return address;
    };
    // TODO: Make private?
    Address6.prototype.parse = function (address) {
        address = this.parse4in6(address);
        var badCharacters = address.match(constants6.RE_BAD_CHARACTERS);
        if (badCharacters) {
            throw new address_error_1.AddressError(sprintf_js_1.sprintf('Bad character%s detected in address: %s', badCharacters.length > 1 ? 's' : '', badCharacters.join('')), address.replace(constants6.RE_BAD_CHARACTERS, '<span class="parse-error">$1</span>'));
        }
        var badAddress = address.match(constants6.RE_BAD_ADDRESS);
        if (badAddress) {
            throw new address_error_1.AddressError(sprintf_js_1.sprintf('Address failed regex: %s', badAddress.join('')), address.replace(constants6.RE_BAD_ADDRESS, '<span class="parse-error">$1</span>'));
        }
        var groups = [];
        var halves = address.split('::');
        if (halves.length === 2) {
            var first = halves[0].split(':');
            var last = halves[1].split(':');
            if (first.length === 1 && first[0] === '') {
                first = [];
            }
            if (last.length === 1 && last[0] === '') {
                last = [];
            }
            var remaining = this.groups - (first.length + last.length);
            if (!remaining) {
                throw new address_error_1.AddressError('Error parsing groups');
            }
            this.elidedGroups = remaining;
            this.elisionBegin = first.length;
            this.elisionEnd = first.length + this.elidedGroups;
            groups = groups.concat(first);
            for (var i = 0; i < remaining; i++) {
                groups.push('0');
            }
            groups = groups.concat(last);
        }
        else if (halves.length === 1) {
            groups = address.split(':');
            this.elidedGroups = 0;
        }
        else {
            throw new address_error_1.AddressError('Too many :: groups found');
        }
        groups = groups.map(function (group) { return sprintf_js_1.sprintf('%x', parseInt(group, 16)); });
        if (groups.length !== this.groups) {
            throw new address_error_1.AddressError('Incorrect number of groups found');
        }
        return groups;
    };
    /**
     * Return the canonical form of the address
     * @memberof Address6
     * @instance
     * @returns {String}
     */
    Address6.prototype.canonicalForm = function () {
        return this.parsedAddress.map(paddedHex).join(':');
    };
    /**
     * Return the decimal form of the address
     * @memberof Address6
     * @instance
     * @returns {String}
     */
    Address6.prototype.decimal = function () {
        return this.parsedAddress.map(function (n) { return sprintf_js_1.sprintf('%05d', parseInt(n, 16)); }).join(':');
    };
    /**
     * Return the address as a BigInteger
     * @memberof Address6
     * @instance
     * @returns {BigInteger}
     */
    Address6.prototype.bigInteger = function () {
        return new jsbn_1.BigInteger(this.parsedAddress.map(paddedHex).join(''), 16);
    };
    /**
     * Return the last two groups of this address as an IPv4 address string
     * @memberof Address6
     * @instance
     * @returns {Address4}
     * @example
     * var address = new Address6('2001:4860:4001::1825:bf11');
     * address.to4().correctForm(); // '24.37.191.17'
     */
    Address6.prototype.to4 = function () {
        var binary = this.binaryZeroPad().split('');
        return ipv4_1.Address4.fromHex(new jsbn_1.BigInteger(binary.slice(96, 128).join(''), 2).toString(16));
    };
    /**
     * Return the v4-in-v6 form of the address
     * @memberof Address6
     * @instance
     * @returns {String}
     */
    Address6.prototype.to4in6 = function () {
        var address4 = this.to4();
        var address6 = new Address6(this.parsedAddress.slice(0, 6).join(':'), 6);
        var correct = address6.correctForm();
        var infix = '';
        if (!/:$/.test(correct)) {
            infix = ':';
        }
        return correct + infix + address4.address;
    };
    /**
     * Return an object containing the Teredo properties of the address
     * @memberof Address6
     * @instance
     * @returns {Object}
     */
    Address6.prototype.inspectTeredo = function () {
        /*
        - Bits 0 to 31 are set to the Teredo prefix (normally 2001:0000::/32).
        - Bits 32 to 63 embed the primary IPv4 address of the Teredo server that
          is used.
        - Bits 64 to 79 can be used to define some flags. Currently only the
          higher order bit is used; it is set to 1 if the Teredo client is
          located behind a cone NAT, 0 otherwise. For Microsoft's Windows Vista
          and Windows Server 2008 implementations, more bits are used. In those
          implementations, the format for these 16 bits is "CRAAAAUG AAAAAAAA",
          where "C" remains the "Cone" flag. The "R" bit is reserved for future
          use. The "U" bit is for the Universal/Local flag (set to 0). The "G" bit
          is Individual/Group flag (set to 0). The A bits are set to a 12-bit
          randomly generated number chosen by the Teredo client to introduce
          additional protection for the Teredo node against IPv6-based scanning
          attacks.
        - Bits 80 to 95 contains the obfuscated UDP port number. This is the
          port number that is mapped by the NAT to the Teredo client with all
          bits inverted.
        - Bits 96 to 127 contains the obfuscated IPv4 address. This is the
          public IPv4 address of the NAT with all bits inverted.
        */
        var prefix = this.getBitsBase16(0, 32);
        var udpPort = this.getBits(80, 96).xor(new jsbn_1.BigInteger('ffff', 16)).toString();
        var server4 = ipv4_1.Address4.fromHex(this.getBitsBase16(32, 64));
        var client4 = ipv4_1.Address4.fromHex(this.getBits(96, 128).xor(new jsbn_1.BigInteger('ffffffff', 16)).toString(16));
        var flags = this.getBits(64, 80);
        var flagsBase2 = this.getBitsBase2(64, 80);
        var coneNat = flags.testBit(15);
        var reserved = flags.testBit(14);
        var groupIndividual = flags.testBit(8);
        var universalLocal = flags.testBit(9);
        var nonce = new jsbn_1.BigInteger(flagsBase2.slice(2, 6) + flagsBase2.slice(8, 16), 2).toString(10);
        return {
            prefix: sprintf_js_1.sprintf('%s:%s', prefix.slice(0, 4), prefix.slice(4, 8)),
            server4: server4.address,
            client4: client4.address,
            flags: flagsBase2,
            coneNat: coneNat,
            microsoft: {
                reserved: reserved,
                universalLocal: universalLocal,
                groupIndividual: groupIndividual,
                nonce: nonce,
            },
            udpPort: udpPort,
        };
    };
    /**
     * Return an object containing the 6to4 properties of the address
     * @memberof Address6
     * @instance
     * @returns {Object}
     */
    Address6.prototype.inspect6to4 = function () {
        /*
        - Bits 0 to 15 are set to the 6to4 prefix (2002::/16).
        - Bits 16 to 48 embed the IPv4 address of the 6to4 gateway that is used.
        */
        var prefix = this.getBitsBase16(0, 16);
        var gateway = ipv4_1.Address4.fromHex(this.getBitsBase16(16, 48));
        return {
            prefix: sprintf_js_1.sprintf('%s', prefix.slice(0, 4)),
            gateway: gateway.address,
        };
    };
    /**
     * Return a v6 6to4 address from a v6 v4inv6 address
     * @memberof Address6
     * @instance
     * @returns {Address6}
     */
    Address6.prototype.to6to4 = function () {
        if (!this.is4()) {
            return null;
        }
        var addr6to4 = [
            '2002',
            this.getBitsBase16(96, 112),
            this.getBitsBase16(112, 128),
            '',
            '/16',
        ].join(':');
        return new Address6(addr6to4);
    };
    /**
     * Return a byte array
     * @memberof Address6
     * @instance
     * @returns {Array}
     */
    Address6.prototype.toByteArray = function () {
        var byteArray = this.bigInteger().toByteArray();
        // work around issue where `toByteArray` returns a leading 0 element
        if (byteArray.length === 17 && byteArray[0] === 0) {
            return byteArray.slice(1);
        }
        return byteArray;
    };
    /**
     * Return an unsigned byte array
     * @memberof Address6
     * @instance
     * @returns {Array}
     */
    Address6.prototype.toUnsignedByteArray = function () {
        return this.toByteArray().map(unsignByte);
    };
    /**
     * Convert a byte array to an Address6 object
     * @memberof Address6
     * @static
     * @returns {Address6}
     */
    Address6.fromByteArray = function (bytes) {
        return this.fromUnsignedByteArray(bytes.map(unsignByte));
    };
    /**
     * Convert an unsigned byte array to an Address6 object
     * @memberof Address6
     * @static
     * @returns {Address6}
     */
    Address6.fromUnsignedByteArray = function (bytes) {
        var BYTE_MAX = new jsbn_1.BigInteger('256', 10);
        var result = new jsbn_1.BigInteger('0', 10);
        var multiplier = new jsbn_1.BigInteger('1', 10);
        for (var i = bytes.length - 1; i >= 0; i--) {
            result = result.add(multiplier.multiply(new jsbn_1.BigInteger(bytes[i].toString(10), 10)));
            multiplier = multiplier.multiply(BYTE_MAX);
        }
        return Address6.fromBigInteger(result);
    };
    /**
     * Returns true if the address is in the canonical form, false otherwise
     * @memberof Address6
     * @instance
     * @returns {boolean}
     */
    Address6.prototype.isCanonical = function () {
        return this.addressMinusSuffix === this.canonicalForm();
    };
    /**
     * Returns true if the address is a link local address, false otherwise
     * @memberof Address6
     * @instance
     * @returns {boolean}
     */
    Address6.prototype.isLinkLocal = function () {
        // Zeroes are required, i.e. we can't check isInSubnet with 'fe80::/10'
        if (this.getBitsBase2(0, 64) ===
            '1111111010000000000000000000000000000000000000000000000000000000') {
            return true;
        }
        return false;
    };
    /**
     * Returns true if the address is a multicast address, false otherwise
     * @memberof Address6
     * @instance
     * @returns {boolean}
     */
    Address6.prototype.isMulticast = function () {
        return this.getType() === 'Multicast';
    };
    /**
     * Returns true if the address is a v4-in-v6 address, false otherwise
     * @memberof Address6
     * @instance
     * @returns {boolean}
     */
    Address6.prototype.is4 = function () {
        return this.v4;
    };
    /**
     * Returns true if the address is a Teredo address, false otherwise
     * @memberof Address6
     * @instance
     * @returns {boolean}
     */
    Address6.prototype.isTeredo = function () {
        return this.isInSubnet(new Address6('2001::/32'));
    };
    /**
     * Returns true if the address is a 6to4 address, false otherwise
     * @memberof Address6
     * @instance
     * @returns {boolean}
     */
    Address6.prototype.is6to4 = function () {
        return this.isInSubnet(new Address6('2002::/16'));
    };
    /**
     * Returns true if the address is a loopback address, false otherwise
     * @memberof Address6
     * @instance
     * @returns {boolean}
     */
    Address6.prototype.isLoopback = function () {
        return this.getType() === 'Loopback';
    };
    // #endregion
    // #region HTML
    /**
     * @returns {String} the address in link form with a default port of 80
     */
    Address6.prototype.href = function (optionalPort) {
        if (optionalPort === undefined) {
            optionalPort = '';
        }
        else {
            optionalPort = sprintf_js_1.sprintf(':%s', optionalPort);
        }
        return sprintf_js_1.sprintf('http://[%s]%s/', this.correctForm(), optionalPort);
    };
    /**
     * @returns {String} a link suitable for conveying the address via a URL hash
     */
    Address6.prototype.link = function (options) {
        if (!options) {
            options = {};
        }
        if (options.className === undefined) {
            options.className = '';
        }
        if (options.prefix === undefined) {
            options.prefix = '/#address=';
        }
        if (options.v4 === undefined) {
            options.v4 = false;
        }
        var formFunction = this.correctForm;
        if (options.v4) {
            formFunction = this.to4in6;
        }
        if (options.className) {
            return sprintf_js_1.sprintf('<a href="%1$s%2$s" class="%3$s">%2$s</a>', options.prefix, formFunction.call(this), options.className);
        }
        return sprintf_js_1.sprintf('<a href="%1$s%2$s">%2$s</a>', options.prefix, formFunction.call(this));
    };
    /**
     * Groups an address
     * @returns {String}
     */
    Address6.prototype.group = function () {
        if (this.elidedGroups === 0) {
            // The simple case
            return helpers.simpleGroup(this.address).join(':');
        }
        assert(typeof this.elidedGroups === 'number');
        assert(typeof this.elisionBegin === 'number');
        // The elided case
        var output = [];
        var _a = this.address.split('::'), left = _a[0], right = _a[1];
        if (left.length) {
            output.push.apply(output, helpers.simpleGroup(left));
        }
        else {
            output.push('');
        }
        var classes = ['hover-group'];
        for (var i = this.elisionBegin; i < this.elisionBegin + this.elidedGroups; i++) {
            classes.push(sprintf_js_1.sprintf('group-%d', i));
        }
        output.push(sprintf_js_1.sprintf('<span class="%s"></span>', classes.join(' ')));
        if (right.length) {
            output.push.apply(output, helpers.simpleGroup(right, this.elisionEnd));
        }
        else {
            output.push('');
        }
        if (this.is4()) {
            assert(this.address4 instanceof ipv4_1.Address4);
            output.pop();
            output.push(this.address4.groupForV6());
        }
        return output.join(':');
    };
    // #endregion
    // #region Regular expressions
    /**
     * Generate a regular expression string that can be used to find or validate
     * all variations of this address
     * @memberof Address6
     * @instance
     * @param {boolean} substringSearch
     * @returns {string}
     */
    Address6.prototype.regularExpressionString = function (substringSearch) {
        if (substringSearch === void 0) { substringSearch = false; }
        var output = [];
        // TODO: revisit why this is necessary
        var address6 = new Address6(this.correctForm());
        if (address6.elidedGroups === 0) {
            // The simple case
            output.push(regular_expressions_1.simpleRegularExpression(address6.parsedAddress));
        }
        else if (address6.elidedGroups === constants6.GROUPS) {
            // A completely elided address
            output.push(regular_expressions_1.possibleElisions(constants6.GROUPS));
        }
        else {
            // A partially elided address
            var halves = address6.address.split('::');
            if (halves[0].length) {
                output.push(regular_expressions_1.simpleRegularExpression(halves[0].split(':')));
            }
            assert(typeof address6.elidedGroups === 'number');
            output.push(regular_expressions_1.possibleElisions(address6.elidedGroups, halves[0].length !== 0, halves[1].length !== 0));
            if (halves[1].length) {
                output.push(regular_expressions_1.simpleRegularExpression(halves[1].split(':')));
            }
            output = [output.join(':')];
        }
        if (!substringSearch) {
            output = __spreadArrays([
                '(?=^|',
                regular_expressions_1.ADDRESS_BOUNDARY,
                '|[^\\w\\:])('
            ], output, [
                ')(?=[^\\w\\:]|',
                regular_expressions_1.ADDRESS_BOUNDARY,
                '|$)',
            ]);
        }
        return output.join('');
    };
    /**
     * Generate a regular expression that can be used to find or validate all
     * variations of this address.
     * @memberof Address6
     * @instance
     * @param {boolean} substringSearch
     * @returns {RegExp}
     */
    Address6.prototype.regularExpression = function (substringSearch) {
        if (substringSearch === void 0) { substringSearch = false; }
        return new RegExp(this.regularExpressionString(substringSearch), 'i');
    };
    return Address6;
}());
exports.Address6 = Address6;
//# sourceMappingURL=ipv6.js.map
  };
  __modules["ip-address/dist/lib/v6/constants.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RE_URL_WITH_PORT = exports.RE_URL = exports.RE_ZONE_STRING = exports.RE_SUBNET_STRING = exports.RE_BAD_ADDRESS = exports.RE_BAD_CHARACTERS = exports.TYPES = exports.SCOPES = exports.GROUPS = exports.BITS = void 0;
exports.BITS = 128;
exports.GROUPS = 8;
/**
 * Represents IPv6 address scopes
 * @memberof Address6
 * @static
 */
exports.SCOPES = {
    0: 'Reserved',
    1: 'Interface local',
    2: 'Link local',
    4: 'Admin local',
    5: 'Site local',
    8: 'Organization local',
    14: 'Global',
    15: 'Reserved',
};
/**
 * Represents IPv6 address types
 * @memberof Address6
 * @static
 */
exports.TYPES = {
    'ff01::1/128': 'Multicast (All nodes on this interface)',
    'ff01::2/128': 'Multicast (All routers on this interface)',
    'ff02::1/128': 'Multicast (All nodes on this link)',
    'ff02::2/128': 'Multicast (All routers on this link)',
    'ff05::2/128': 'Multicast (All routers in this site)',
    'ff02::5/128': 'Multicast (OSPFv3 AllSPF routers)',
    'ff02::6/128': 'Multicast (OSPFv3 AllDR routers)',
    'ff02::9/128': 'Multicast (RIP routers)',
    'ff02::a/128': 'Multicast (EIGRP routers)',
    'ff02::d/128': 'Multicast (PIM routers)',
    'ff02::16/128': 'Multicast (MLDv2 reports)',
    'ff01::fb/128': 'Multicast (mDNSv6)',
    'ff02::fb/128': 'Multicast (mDNSv6)',
    'ff05::fb/128': 'Multicast (mDNSv6)',
    'ff02::1:2/128': 'Multicast (All DHCP servers and relay agents on this link)',
    'ff05::1:2/128': 'Multicast (All DHCP servers and relay agents in this site)',
    'ff02::1:3/128': 'Multicast (All DHCP servers on this link)',
    'ff05::1:3/128': 'Multicast (All DHCP servers in this site)',
    '::/128': 'Unspecified',
    '::1/128': 'Loopback',
    'ff00::/8': 'Multicast',
    'fe80::/10': 'Link-local unicast',
};
/**
 * A regular expression that matches bad characters in an IPv6 address
 * @memberof Address6
 * @static
 */
exports.RE_BAD_CHARACTERS = /([^0-9a-f:/%])/gi;
/**
 * A regular expression that matches an incorrect IPv6 address
 * @memberof Address6
 * @static
 */
exports.RE_BAD_ADDRESS = /([0-9a-f]{5,}|:{3,}|[^:]:$|^:[^:]|\/$)/gi;
/**
 * A regular expression that matches an IPv6 subnet
 * @memberof Address6
 * @static
 */
exports.RE_SUBNET_STRING = /\/\d{1,3}(?=%|$)/;
/**
 * A regular expression that matches an IPv6 zone
 * @memberof Address6
 * @static
 */
exports.RE_ZONE_STRING = /%.*$/;
exports.RE_URL = new RegExp(/^\[{0,1}([0-9a-f:]+)\]{0,1}/);
exports.RE_URL_WITH_PORT = new RegExp(/\[([0-9a-f:]+)\]:([0-9]{1,5})/);
//# sourceMappingURL=constants.js.map
  };
  __modules["ip-address/dist/lib/v6/helpers.js"] = function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.simpleGroup = exports.spanLeadingZeroes = exports.spanAll = exports.spanAllZeroes = void 0;
var sprintf_js_1 = require("sprintf-js");
/**
 * @returns {String} the string with all zeroes contained in a <span>
 */
function spanAllZeroes(s) {
    return s.replace(/(0+)/g, '<span class="zero">$1</span>');
}
exports.spanAllZeroes = spanAllZeroes;
/**
 * @returns {String} the string with each character contained in a <span>
 */
function spanAll(s, offset) {
    if (offset === void 0) { offset = 0; }
    var letters = s.split('');
    return letters
        .map(function (n, i) {
        return sprintf_js_1.sprintf('<span class="digit value-%s position-%d">%s</span>', n, i + offset, spanAllZeroes(n));
    } // XXX Use #base-2 .value-0 instead?
    )
        .join('');
}
exports.spanAll = spanAll;
function spanLeadingZeroesSimple(group) {
    return group.replace(/^(0+)/, '<span class="zero">$1</span>');
}
/**
 * @returns {String} the string with leading zeroes contained in a <span>
 */
function spanLeadingZeroes(address) {
    var groups = address.split(':');
    return groups.map(function (g) { return spanLeadingZeroesSimple(g); }).join(':');
}
exports.spanLeadingZeroes = spanLeadingZeroes;
/**
 * Groups an address
 * @returns {String} a grouped address
 */
function simpleGroup(addressString, offset) {
    if (offset === void 0) { offset = 0; }
    var groups = addressString.split(':');
    return groups.map(function (g, i) {
        if (/group-v4/.test(g)) {
            return g;
        }
        return sprintf_js_1.sprintf('<span class="hover-group group-%d">%s</span>', i + offset, spanLeadingZeroesSimple(g));
    });
}
exports.simpleGroup = simpleGroup;
//# sourceMappingURL=helpers.js.map
  };
  __modules["ip-address/dist/lib/v6/regular-expressions.js"] = function (module, exports, require) {
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.possibleElisions = exports.simpleRegularExpression = exports.ADDRESS_BOUNDARY = exports.padGroup = exports.groupPossibilities = void 0;
var v6 = __importStar(require("./constants"));
var sprintf_js_1 = require("sprintf-js");
function groupPossibilities(possibilities) {
    return sprintf_js_1.sprintf('(%s)', possibilities.join('|'));
}
exports.groupPossibilities = groupPossibilities;
function padGroup(group) {
    if (group.length < 4) {
        return sprintf_js_1.sprintf('0{0,%d}%s', 4 - group.length, group);
    }
    return group;
}
exports.padGroup = padGroup;
exports.ADDRESS_BOUNDARY = '[^A-Fa-f0-9:]';
function simpleRegularExpression(groups) {
    var zeroIndexes = [];
    groups.forEach(function (group, i) {
        var groupInteger = parseInt(group, 16);
        if (groupInteger === 0) {
            zeroIndexes.push(i);
        }
    });
    // You can technically elide a single 0, this creates the regular expressions
    // to match that eventuality
    var possibilities = zeroIndexes.map(function (zeroIndex) {
        return groups
            .map(function (group, i) {
            if (i === zeroIndex) {
                var elision = i === 0 || i === v6.GROUPS - 1 ? ':' : '';
                return groupPossibilities([padGroup(group), elision]);
            }
            return padGroup(group);
        })
            .join(':');
    });
    // The simplest case
    possibilities.push(groups.map(padGroup).join(':'));
    return groupPossibilities(possibilities);
}
exports.simpleRegularExpression = simpleRegularExpression;
function possibleElisions(elidedGroups, moreLeft, moreRight) {
    var left = moreLeft ? '' : ':';
    var right = moreRight ? '' : ':';
    var possibilities = [];
    // 1. elision of everything (::)
    if (!moreLeft && !moreRight) {
        possibilities.push('::');
    }
    // 2. complete elision of the middle
    if (moreLeft && moreRight) {
        possibilities.push('');
    }
    if ((moreRight && !moreLeft) || (!moreRight && moreLeft)) {
        // 3. complete elision of one side
        possibilities.push(':');
    }
    // 4. elision from the left side
    possibilities.push(sprintf_js_1.sprintf('%s(:0{1,4}){1,%d}', left, elidedGroups - 1));
    // 5. elision from the right side
    possibilities.push(sprintf_js_1.sprintf('(0{1,4}:){1,%d}%s', elidedGroups - 1, right));
    // 6. no elision
    possibilities.push(sprintf_js_1.sprintf('(0{1,4}:){%d}0{1,4}', elidedGroups - 1));
    // 7. elision (including sloppy elision) from the middle
    for (var groups = 1; groups < elidedGroups - 1; groups++) {
        for (var position = 1; position < elidedGroups - groups; position++) {
            possibilities.push(sprintf_js_1.sprintf('(0{1,4}:){%d}:(0{1,4}:){%d}0{1,4}', position, elidedGroups - position - groups - 1));
        }
    }
    return groupPossibilities(possibilities);
}
exports.possibleElisions = possibleElisions;
//# sourceMappingURL=regular-expressions.js.map
  };
  __modules["yamljs/lib/Yaml.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var Dumper, Parser, Utils, Yaml;

Parser = require('./Parser');

Dumper = require('./Dumper');

Utils = require('./Utils');

Yaml = (function() {
  function Yaml() {}

  Yaml.parse = function(input, exceptionOnInvalidType, objectDecoder) {
    if (exceptionOnInvalidType == null) {
      exceptionOnInvalidType = false;
    }
    if (objectDecoder == null) {
      objectDecoder = null;
    }
    return new Parser().parse(input, exceptionOnInvalidType, objectDecoder);
  };

  Yaml.parseFile = function(path, callback, exceptionOnInvalidType, objectDecoder) {
    var input;
    if (callback == null) {
      callback = null;
    }
    if (exceptionOnInvalidType == null) {
      exceptionOnInvalidType = false;
    }
    if (objectDecoder == null) {
      objectDecoder = null;
    }
    if (callback != null) {
      return Utils.getStringFromFile(path, (function(_this) {
        return function(input) {
          var result;
          result = null;
          if (input != null) {
            result = _this.parse(input, exceptionOnInvalidType, objectDecoder);
          }
          callback(result);
        };
      })(this));
    } else {
      input = Utils.getStringFromFile(path);
      if (input != null) {
        return this.parse(input, exceptionOnInvalidType, objectDecoder);
      }
      return null;
    }
  };

  Yaml.dump = function(input, inline, indent, exceptionOnInvalidType, objectEncoder) {
    var yaml;
    if (inline == null) {
      inline = 2;
    }
    if (indent == null) {
      indent = 4;
    }
    if (exceptionOnInvalidType == null) {
      exceptionOnInvalidType = false;
    }
    if (objectEncoder == null) {
      objectEncoder = null;
    }
    yaml = new Dumper();
    yaml.indentation = indent;
    return yaml.dump(input, inline, 0, exceptionOnInvalidType, objectEncoder);
  };

  Yaml.stringify = function(input, inline, indent, exceptionOnInvalidType, objectEncoder) {
    return this.dump(input, inline, indent, exceptionOnInvalidType, objectEncoder);
  };

  Yaml.load = function(path, callback, exceptionOnInvalidType, objectDecoder) {
    return this.parseFile(path, callback, exceptionOnInvalidType, objectDecoder);
  };

  return Yaml;

})();

if (typeof window !== "undefined" && window !== null) {
  window.YAML = Yaml;
}

if (typeof window === "undefined" || window === null) {
  this.YAML = Yaml;
}

module.exports = Yaml;

  };
  __modules["yamljs/lib/Parser.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var Inline, ParseException, ParseMore, Parser, Pattern, Utils;

Inline = require('./Inline');

Pattern = require('./Pattern');

Utils = require('./Utils');

ParseException = require('./Exception/ParseException');

ParseMore = require('./Exception/ParseMore');

Parser = (function() {
  Parser.prototype.PATTERN_FOLDED_SCALAR_ALL = new Pattern('^(?:(?<type>![^\\|>]*)\\s+)?(?<separator>\\||>)(?<modifiers>\\+|\\-|\\d+|\\+\\d+|\\-\\d+|\\d+\\+|\\d+\\-)?(?<comments> +#.*)?$');

  Parser.prototype.PATTERN_FOLDED_SCALAR_END = new Pattern('(?<separator>\\||>)(?<modifiers>\\+|\\-|\\d+|\\+\\d+|\\-\\d+|\\d+\\+|\\d+\\-)?(?<comments> +#.*)?$');

  Parser.prototype.PATTERN_SEQUENCE_ITEM = new Pattern('^\\-((?<leadspaces>\\s+)(?<value>.+?))?\\s*$');

  Parser.prototype.PATTERN_ANCHOR_VALUE = new Pattern('^&(?<ref>[^ ]+) *(?<value>.*)');

  Parser.prototype.PATTERN_COMPACT_NOTATION = new Pattern('^(?<key>' + Inline.REGEX_QUOTED_STRING + '|[^ \'"\\{\\[].*?) *\\:(\\s+(?<value>.+?))?\\s*$');

  Parser.prototype.PATTERN_MAPPING_ITEM = new Pattern('^(?<key>' + Inline.REGEX_QUOTED_STRING + '|[^ \'"\\[\\{].*?) *\\:(\\s+(?<value>.+?))?\\s*$');

  Parser.prototype.PATTERN_DECIMAL = new Pattern('\\d+');

  Parser.prototype.PATTERN_INDENT_SPACES = new Pattern('^ +');

  Parser.prototype.PATTERN_TRAILING_LINES = new Pattern('(\n*)$');

  Parser.prototype.PATTERN_YAML_HEADER = new Pattern('^\\%YAML[: ][\\d\\.]+.*\n', 'm');

  Parser.prototype.PATTERN_LEADING_COMMENTS = new Pattern('^(\\#.*?\n)+', 'm');

  Parser.prototype.PATTERN_DOCUMENT_MARKER_START = new Pattern('^\\-\\-\\-.*?\n', 'm');

  Parser.prototype.PATTERN_DOCUMENT_MARKER_END = new Pattern('^\\.\\.\\.\\s*$', 'm');

  Parser.prototype.PATTERN_FOLDED_SCALAR_BY_INDENTATION = {};

  Parser.prototype.CONTEXT_NONE = 0;

  Parser.prototype.CONTEXT_SEQUENCE = 1;

  Parser.prototype.CONTEXT_MAPPING = 2;

  function Parser(offset) {
    this.offset = offset != null ? offset : 0;
    this.lines = [];
    this.currentLineNb = -1;
    this.currentLine = '';
    this.refs = {};
  }

  Parser.prototype.parse = function(value, exceptionOnInvalidType, objectDecoder) {
    var alias, allowOverwrite, block, c, context, data, e, first, i, indent, isRef, j, k, key, l, lastKey, len, len1, len2, len3, lineCount, m, matches, mergeNode, n, name, parsed, parsedItem, parser, ref, ref1, ref2, refName, refValue, val, values;
    if (exceptionOnInvalidType == null) {
      exceptionOnInvalidType = false;
    }
    if (objectDecoder == null) {
      objectDecoder = null;
    }
    this.currentLineNb = -1;
    this.currentLine = '';
    this.lines = this.cleanup(value).split("\n");
    data = null;
    context = this.CONTEXT_NONE;
    allowOverwrite = false;
    while (this.moveToNextLine()) {
      if (this.isCurrentLineEmpty()) {
        continue;
      }
      if ("\t" === this.currentLine[0]) {
        throw new ParseException('A YAML file cannot contain tabs as indentation.', this.getRealCurrentLineNb() + 1, this.currentLine);
      }
      isRef = mergeNode = false;
      if (values = this.PATTERN_SEQUENCE_ITEM.exec(this.currentLine)) {
        if (this.CONTEXT_MAPPING === context) {
          throw new ParseException('You cannot define a sequence item when in a mapping');
        }
        context = this.CONTEXT_SEQUENCE;
        if (data == null) {
          data = [];
        }
        if ((values.value != null) && (matches = this.PATTERN_ANCHOR_VALUE.exec(values.value))) {
          isRef = matches.ref;
          values.value = matches.value;
        }
        if (!(values.value != null) || '' === Utils.trim(values.value, ' ') || Utils.ltrim(values.value, ' ').indexOf('#') === 0) {
          if (this.currentLineNb < this.lines.length - 1 && !this.isNextLineUnIndentedCollection()) {
            c = this.getRealCurrentLineNb() + 1;
            parser = new Parser(c);
            parser.refs = this.refs;
            data.push(parser.parse(this.getNextEmbedBlock(null, true), exceptionOnInvalidType, objectDecoder));
          } else {
            data.push(null);
          }
        } else {
          if (((ref = values.leadspaces) != null ? ref.length : void 0) && (matches = this.PATTERN_COMPACT_NOTATION.exec(values.value))) {
            c = this.getRealCurrentLineNb();
            parser = new Parser(c);
            parser.refs = this.refs;
            block = values.value;
            indent = this.getCurrentLineIndentation();
            if (this.isNextLineIndented(false)) {
              block += "\n" + this.getNextEmbedBlock(indent + values.leadspaces.length + 1, true);
            }
            data.push(parser.parse(block, exceptionOnInvalidType, objectDecoder));
          } else {
            data.push(this.parseValue(values.value, exceptionOnInvalidType, objectDecoder));
          }
        }
      } else if ((values = this.PATTERN_MAPPING_ITEM.exec(this.currentLine)) && values.key.indexOf(' #') === -1) {
        if (this.CONTEXT_SEQUENCE === context) {
          throw new ParseException('You cannot define a mapping item when in a sequence');
        }
        context = this.CONTEXT_MAPPING;
        if (data == null) {
          data = {};
        }
        Inline.configure(exceptionOnInvalidType, objectDecoder);
        try {
          key = Inline.parseScalar(values.key);
        } catch (error) {
          e = error;
          e.parsedLine = this.getRealCurrentLineNb() + 1;
          e.snippet = this.currentLine;
          throw e;
        }
        if ('<<' === key) {
          mergeNode = true;
          allowOverwrite = true;
          if (((ref1 = values.value) != null ? ref1.indexOf('*') : void 0) === 0) {
            refName = values.value.slice(1);
            if (this.refs[refName] == null) {
              throw new ParseException('Reference "' + refName + '" does not exist.', this.getRealCurrentLineNb() + 1, this.currentLine);
            }
            refValue = this.refs[refName];
            if (typeof refValue !== 'object') {
              throw new ParseException('YAML merge keys used with a scalar value instead of an object.', this.getRealCurrentLineNb() + 1, this.currentLine);
            }
            if (refValue instanceof Array) {
              for (i = j = 0, len = refValue.length; j < len; i = ++j) {
                value = refValue[i];
                if (data[name = String(i)] == null) {
                  data[name] = value;
                }
              }
            } else {
              for (key in refValue) {
                value = refValue[key];
                if (data[key] == null) {
                  data[key] = value;
                }
              }
            }
          } else {
            if ((values.value != null) && values.value !== '') {
              value = values.value;
            } else {
              value = this.getNextEmbedBlock();
            }
            c = this.getRealCurrentLineNb() + 1;
            parser = new Parser(c);
            parser.refs = this.refs;
            parsed = parser.parse(value, exceptionOnInvalidType);
            if (typeof parsed !== 'object') {
              throw new ParseException('YAML merge keys used with a scalar value instead of an object.', this.getRealCurrentLineNb() + 1, this.currentLine);
            }
            if (parsed instanceof Array) {
              for (l = 0, len1 = parsed.length; l < len1; l++) {
                parsedItem = parsed[l];
                if (typeof parsedItem !== 'object') {
                  throw new ParseException('Merge items must be objects.', this.getRealCurrentLineNb() + 1, parsedItem);
                }
                if (parsedItem instanceof Array) {
                  for (i = m = 0, len2 = parsedItem.length; m < len2; i = ++m) {
                    value = parsedItem[i];
                    k = String(i);
                    if (!data.hasOwnProperty(k)) {
                      data[k] = value;
                    }
                  }
                } else {
                  for (key in parsedItem) {
                    value = parsedItem[key];
                    if (!data.hasOwnProperty(key)) {
                      data[key] = value;
                    }
                  }
                }
              }
            } else {
              for (key in parsed) {
                value = parsed[key];
                if (!data.hasOwnProperty(key)) {
                  data[key] = value;
                }
              }
            }
          }
        } else if ((values.value != null) && (matches = this.PATTERN_ANCHOR_VALUE.exec(values.value))) {
          isRef = matches.ref;
          values.value = matches.value;
        }
        if (mergeNode) {

        } else if (!(values.value != null) || '' === Utils.trim(values.value, ' ') || Utils.ltrim(values.value, ' ').indexOf('#') === 0) {
          if (!(this.isNextLineIndented()) && !(this.isNextLineUnIndentedCollection())) {
            if (allowOverwrite || data[key] === void 0) {
              data[key] = null;
            }
          } else {
            c = this.getRealCurrentLineNb() + 1;
            parser = new Parser(c);
            parser.refs = this.refs;
            val = parser.parse(this.getNextEmbedBlock(), exceptionOnInvalidType, objectDecoder);
            if (allowOverwrite || data[key] === void 0) {
              data[key] = val;
            }
          }
        } else {
          val = this.parseValue(values.value, exceptionOnInvalidType, objectDecoder);
          if (allowOverwrite || data[key] === void 0) {
            data[key] = val;
          }
        }
      } else {
        lineCount = this.lines.length;
        if (1 === lineCount || (2 === lineCount && Utils.isEmpty(this.lines[1]))) {
          try {
            value = Inline.parse(this.lines[0], exceptionOnInvalidType, objectDecoder);
          } catch (error) {
            e = error;
            e.parsedLine = this.getRealCurrentLineNb() + 1;
            e.snippet = this.currentLine;
            throw e;
          }
          if (typeof value === 'object') {
            if (value instanceof Array) {
              first = value[0];
            } else {
              for (key in value) {
                first = value[key];
                break;
              }
            }
            if (typeof first === 'string' && first.indexOf('*') === 0) {
              data = [];
              for (n = 0, len3 = value.length; n < len3; n++) {
                alias = value[n];
                data.push(this.refs[alias.slice(1)]);
              }
              value = data;
            }
          }
          return value;
        } else if ((ref2 = Utils.ltrim(value).charAt(0)) === '[' || ref2 === '{') {
          try {
            return Inline.parse(value, exceptionOnInvalidType, objectDecoder);
          } catch (error) {
            e = error;
            e.parsedLine = this.getRealCurrentLineNb() + 1;
            e.snippet = this.currentLine;
            throw e;
          }
        }
        throw new ParseException('Unable to parse.', this.getRealCurrentLineNb() + 1, this.currentLine);
      }
      if (isRef) {
        if (data instanceof Array) {
          this.refs[isRef] = data[data.length - 1];
        } else {
          lastKey = null;
          for (key in data) {
            lastKey = key;
          }
          this.refs[isRef] = data[lastKey];
        }
      }
    }
    if (Utils.isEmpty(data)) {
      return null;
    } else {
      return data;
    }
  };

  Parser.prototype.getRealCurrentLineNb = function() {
    return this.currentLineNb + this.offset;
  };

  Parser.prototype.getCurrentLineIndentation = function() {
    return this.currentLine.length - Utils.ltrim(this.currentLine, ' ').length;
  };

  Parser.prototype.getNextEmbedBlock = function(indentation, includeUnindentedCollection) {
    var data, indent, isItUnindentedCollection, newIndent, removeComments, removeCommentsPattern, unindentedEmbedBlock;
    if (indentation == null) {
      indentation = null;
    }
    if (includeUnindentedCollection == null) {
      includeUnindentedCollection = false;
    }
    this.moveToNextLine();
    if (indentation == null) {
      newIndent = this.getCurrentLineIndentation();
      unindentedEmbedBlock = this.isStringUnIndentedCollectionItem(this.currentLine);
      if (!(this.isCurrentLineEmpty()) && 0 === newIndent && !unindentedEmbedBlock) {
        throw new ParseException('Indentation problem.', this.getRealCurrentLineNb() + 1, this.currentLine);
      }
    } else {
      newIndent = indentation;
    }
    data = [this.currentLine.slice(newIndent)];
    if (!includeUnindentedCollection) {
      isItUnindentedCollection = this.isStringUnIndentedCollectionItem(this.currentLine);
    }
    removeCommentsPattern = this.PATTERN_FOLDED_SCALAR_END;
    removeComments = !removeCommentsPattern.test(this.currentLine);
    while (this.moveToNextLine()) {
      indent = this.getCurrentLineIndentation();
      if (indent === newIndent) {
        removeComments = !removeCommentsPattern.test(this.currentLine);
      }
      if (removeComments && this.isCurrentLineComment()) {
        continue;
      }
      if (this.isCurrentLineBlank()) {
        data.push(this.currentLine.slice(newIndent));
        continue;
      }
      if (isItUnindentedCollection && !this.isStringUnIndentedCollectionItem(this.currentLine) && indent === newIndent) {
        this.moveToPreviousLine();
        break;
      }
      if (indent >= newIndent) {
        data.push(this.currentLine.slice(newIndent));
      } else if (Utils.ltrim(this.currentLine).charAt(0) === '#') {

      } else if (0 === indent) {
        this.moveToPreviousLine();
        break;
      } else {
        throw new ParseException('Indentation problem.', this.getRealCurrentLineNb() + 1, this.currentLine);
      }
    }
    return data.join("\n");
  };

  Parser.prototype.moveToNextLine = function() {
    if (this.currentLineNb >= this.lines.length - 1) {
      return false;
    }
    this.currentLine = this.lines[++this.currentLineNb];
    return true;
  };

  Parser.prototype.moveToPreviousLine = function() {
    this.currentLine = this.lines[--this.currentLineNb];
  };

  Parser.prototype.parseValue = function(value, exceptionOnInvalidType, objectDecoder) {
    var e, foldedIndent, matches, modifiers, pos, ref, ref1, val;
    if (0 === value.indexOf('*')) {
      pos = value.indexOf('#');
      if (pos !== -1) {
        value = value.substr(1, pos - 2);
      } else {
        value = value.slice(1);
      }
      if (this.refs[value] === void 0) {
        throw new ParseException('Reference "' + value + '" does not exist.', this.currentLine);
      }
      return this.refs[value];
    }
    if (matches = this.PATTERN_FOLDED_SCALAR_ALL.exec(value)) {
      modifiers = (ref = matches.modifiers) != null ? ref : '';
      foldedIndent = Math.abs(parseInt(modifiers));
      if (isNaN(foldedIndent)) {
        foldedIndent = 0;
      }
      val = this.parseFoldedScalar(matches.separator, this.PATTERN_DECIMAL.replace(modifiers, ''), foldedIndent);
      if (matches.type != null) {
        Inline.configure(exceptionOnInvalidType, objectDecoder);
        return Inline.parseScalar(matches.type + ' ' + val);
      } else {
        return val;
      }
    }
    if ((ref1 = value.charAt(0)) === '[' || ref1 === '{' || ref1 === '"' || ref1 === "'") {
      while (true) {
        try {
          return Inline.parse(value, exceptionOnInvalidType, objectDecoder);
        } catch (error) {
          e = error;
          if (e instanceof ParseMore && this.moveToNextLine()) {
            value += "\n" + Utils.trim(this.currentLine, ' ');
          } else {
            e.parsedLine = this.getRealCurrentLineNb() + 1;
            e.snippet = this.currentLine;
            throw e;
          }
        }
      }
    } else {
      if (this.isNextLineIndented()) {
        value += "\n" + this.getNextEmbedBlock();
      }
      return Inline.parse(value, exceptionOnInvalidType, objectDecoder);
    }
  };

  Parser.prototype.parseFoldedScalar = function(separator, indicator, indentation) {
    var isCurrentLineBlank, j, len, line, matches, newText, notEOF, pattern, ref, text;
    if (indicator == null) {
      indicator = '';
    }
    if (indentation == null) {
      indentation = 0;
    }
    notEOF = this.moveToNextLine();
    if (!notEOF) {
      return '';
    }
    isCurrentLineBlank = this.isCurrentLineBlank();
    text = '';
    while (notEOF && isCurrentLineBlank) {
      if (notEOF = this.moveToNextLine()) {
        text += "\n";
        isCurrentLineBlank = this.isCurrentLineBlank();
      }
    }
    if (0 === indentation) {
      if (matches = this.PATTERN_INDENT_SPACES.exec(this.currentLine)) {
        indentation = matches[0].length;
      }
    }
    if (indentation > 0) {
      pattern = this.PATTERN_FOLDED_SCALAR_BY_INDENTATION[indentation];
      if (pattern == null) {
        pattern = new Pattern('^ {' + indentation + '}(.*)$');
        Parser.prototype.PATTERN_FOLDED_SCALAR_BY_INDENTATION[indentation] = pattern;
      }
      while (notEOF && (isCurrentLineBlank || (matches = pattern.exec(this.currentLine)))) {
        if (isCurrentLineBlank) {
          text += this.currentLine.slice(indentation);
        } else {
          text += matches[1];
        }
        if (notEOF = this.moveToNextLine()) {
          text += "\n";
          isCurrentLineBlank = this.isCurrentLineBlank();
        }
      }
    } else if (notEOF) {
      text += "\n";
    }
    if (notEOF) {
      this.moveToPreviousLine();
    }
    if ('>' === separator) {
      newText = '';
      ref = text.split("\n");
      for (j = 0, len = ref.length; j < len; j++) {
        line = ref[j];
        if (line.length === 0 || line.charAt(0) === ' ') {
          newText = Utils.rtrim(newText, ' ') + line + "\n";
        } else {
          newText += line + ' ';
        }
      }
      text = newText;
    }
    if ('+' !== indicator) {
      text = Utils.rtrim(text);
    }
    if ('' === indicator) {
      text = this.PATTERN_TRAILING_LINES.replace(text, "\n");
    } else if ('-' === indicator) {
      text = this.PATTERN_TRAILING_LINES.replace(text, '');
    }
    return text;
  };

  Parser.prototype.isNextLineIndented = function(ignoreComments) {
    var EOF, currentIndentation, ret;
    if (ignoreComments == null) {
      ignoreComments = true;
    }
    currentIndentation = this.getCurrentLineIndentation();
    EOF = !this.moveToNextLine();
    if (ignoreComments) {
      while (!EOF && this.isCurrentLineEmpty()) {
        EOF = !this.moveToNextLine();
      }
    } else {
      while (!EOF && this.isCurrentLineBlank()) {
        EOF = !this.moveToNextLine();
      }
    }
    if (EOF) {
      return false;
    }
    ret = false;
    if (this.getCurrentLineIndentation() > currentIndentation) {
      ret = true;
    }
    this.moveToPreviousLine();
    return ret;
  };

  Parser.prototype.isCurrentLineEmpty = function() {
    var trimmedLine;
    trimmedLine = Utils.trim(this.currentLine, ' ');
    return trimmedLine.length === 0 || trimmedLine.charAt(0) === '#';
  };

  Parser.prototype.isCurrentLineBlank = function() {
    return '' === Utils.trim(this.currentLine, ' ');
  };

  Parser.prototype.isCurrentLineComment = function() {
    var ltrimmedLine;
    ltrimmedLine = Utils.ltrim(this.currentLine, ' ');
    return ltrimmedLine.charAt(0) === '#';
  };

  Parser.prototype.cleanup = function(value) {
    var count, i, indent, j, l, len, len1, line, lines, ref, ref1, ref2, smallestIndent, trimmedValue;
    if (value.indexOf("\r") !== -1) {
      value = value.split("\r\n").join("\n").split("\r").join("\n");
    }
    count = 0;
    ref = this.PATTERN_YAML_HEADER.replaceAll(value, ''), value = ref[0], count = ref[1];
    this.offset += count;
    ref1 = this.PATTERN_LEADING_COMMENTS.replaceAll(value, '', 1), trimmedValue = ref1[0], count = ref1[1];
    if (count === 1) {
      this.offset += Utils.subStrCount(value, "\n") - Utils.subStrCount(trimmedValue, "\n");
      value = trimmedValue;
    }
    ref2 = this.PATTERN_DOCUMENT_MARKER_START.replaceAll(value, '', 1), trimmedValue = ref2[0], count = ref2[1];
    if (count === 1) {
      this.offset += Utils.subStrCount(value, "\n") - Utils.subStrCount(trimmedValue, "\n");
      value = trimmedValue;
      value = this.PATTERN_DOCUMENT_MARKER_END.replace(value, '');
    }
    lines = value.split("\n");
    smallestIndent = -1;
    for (j = 0, len = lines.length; j < len; j++) {
      line = lines[j];
      if (Utils.trim(line, ' ').length === 0) {
        continue;
      }
      indent = line.length - Utils.ltrim(line).length;
      if (smallestIndent === -1 || indent < smallestIndent) {
        smallestIndent = indent;
      }
    }
    if (smallestIndent > 0) {
      for (i = l = 0, len1 = lines.length; l < len1; i = ++l) {
        line = lines[i];
        lines[i] = line.slice(smallestIndent);
      }
      value = lines.join("\n");
    }
    return value;
  };

  Parser.prototype.isNextLineUnIndentedCollection = function(currentIndentation) {
    var notEOF, ret;
    if (currentIndentation == null) {
      currentIndentation = null;
    }
    if (currentIndentation == null) {
      currentIndentation = this.getCurrentLineIndentation();
    }
    notEOF = this.moveToNextLine();
    while (notEOF && this.isCurrentLineEmpty()) {
      notEOF = this.moveToNextLine();
    }
    if (false === notEOF) {
      return false;
    }
    ret = false;
    if (this.getCurrentLineIndentation() === currentIndentation && this.isStringUnIndentedCollectionItem(this.currentLine)) {
      ret = true;
    }
    this.moveToPreviousLine();
    return ret;
  };

  Parser.prototype.isStringUnIndentedCollectionItem = function() {
    return this.currentLine === '-' || this.currentLine.slice(0, 2) === '- ';
  };

  return Parser;

})();

module.exports = Parser;

  };
  __modules["yamljs/lib/Inline.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var DumpException, Escaper, Inline, ParseException, ParseMore, Pattern, Unescaper, Utils,
  indexOf = [].indexOf || function(item) { for (var i = 0, l = this.length; i < l; i++) { if (i in this && this[i] === item) return i; } return -1; };

Pattern = require('./Pattern');

Unescaper = require('./Unescaper');

Escaper = require('./Escaper');

Utils = require('./Utils');

ParseException = require('./Exception/ParseException');

ParseMore = require('./Exception/ParseMore');

DumpException = require('./Exception/DumpException');

Inline = (function() {
  function Inline() {}

  Inline.REGEX_QUOTED_STRING = '(?:"(?:[^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|\'(?:[^\']*(?:\'\'[^\']*)*)\')';

  Inline.PATTERN_TRAILING_COMMENTS = new Pattern('^\\s*#.*$');

  Inline.PATTERN_QUOTED_SCALAR = new Pattern('^' + Inline.REGEX_QUOTED_STRING);

  Inline.PATTERN_THOUSAND_NUMERIC_SCALAR = new Pattern('^(-|\\+)?[0-9,]+(\\.[0-9]+)?$');

  Inline.PATTERN_SCALAR_BY_DELIMITERS = {};

  Inline.settings = {};

  Inline.configure = function(exceptionOnInvalidType, objectDecoder) {
    if (exceptionOnInvalidType == null) {
      exceptionOnInvalidType = null;
    }
    if (objectDecoder == null) {
      objectDecoder = null;
    }
    this.settings.exceptionOnInvalidType = exceptionOnInvalidType;
    this.settings.objectDecoder = objectDecoder;
  };

  Inline.parse = function(value, exceptionOnInvalidType, objectDecoder) {
    var context, result;
    if (exceptionOnInvalidType == null) {
      exceptionOnInvalidType = false;
    }
    if (objectDecoder == null) {
      objectDecoder = null;
    }
    this.settings.exceptionOnInvalidType = exceptionOnInvalidType;
    this.settings.objectDecoder = objectDecoder;
    if (value == null) {
      return '';
    }
    value = Utils.trim(value);
    if (0 === value.length) {
      return '';
    }
    context = {
      exceptionOnInvalidType: exceptionOnInvalidType,
      objectDecoder: objectDecoder,
      i: 0
    };
    switch (value.charAt(0)) {
      case '[':
        result = this.parseSequence(value, context);
        ++context.i;
        break;
      case '{':
        result = this.parseMapping(value, context);
        ++context.i;
        break;
      default:
        result = this.parseScalar(value, null, ['"', "'"], context);
    }
    if (this.PATTERN_TRAILING_COMMENTS.replace(value.slice(context.i), '') !== '') {
      throw new ParseException('Unexpected characters near "' + value.slice(context.i) + '".');
    }
    return result;
  };

  Inline.dump = function(value, exceptionOnInvalidType, objectEncoder) {
    var ref, result, type;
    if (exceptionOnInvalidType == null) {
      exceptionOnInvalidType = false;
    }
    if (objectEncoder == null) {
      objectEncoder = null;
    }
    if (value == null) {
      return 'null';
    }
    type = typeof value;
    if (type === 'object') {
      if (value instanceof Date) {
        return value.toISOString();
      } else if (objectEncoder != null) {
        result = objectEncoder(value);
        if (typeof result === 'string' || (result != null)) {
          return result;
        }
      }
      return this.dumpObject(value);
    }
    if (type === 'boolean') {
      return (value ? 'true' : 'false');
    }
    if (Utils.isDigits(value)) {
      return (type === 'string' ? "'" + value + "'" : String(parseInt(value)));
    }
    if (Utils.isNumeric(value)) {
      return (type === 'string' ? "'" + value + "'" : String(parseFloat(value)));
    }
    if (type === 'number') {
      return (value === 2e308 ? '.Inf' : (value === -2e308 ? '-.Inf' : (isNaN(value) ? '.NaN' : value)));
    }
    if (Escaper.requiresDoubleQuoting(value)) {
      return Escaper.escapeWithDoubleQuotes(value);
    }
    if (Escaper.requiresSingleQuoting(value)) {
      return Escaper.escapeWithSingleQuotes(value);
    }
    if ('' === value) {
      return '""';
    }
    if (Utils.PATTERN_DATE.test(value)) {
      return "'" + value + "'";
    }
    if ((ref = value.toLowerCase()) === 'null' || ref === '~' || ref === 'true' || ref === 'false') {
      return "'" + value + "'";
    }
    return value;
  };

  Inline.dumpObject = function(value, exceptionOnInvalidType, objectSupport) {
    var j, key, len1, output, val;
    if (objectSupport == null) {
      objectSupport = null;
    }
    if (value instanceof Array) {
      output = [];
      for (j = 0, len1 = value.length; j < len1; j++) {
        val = value[j];
        output.push(this.dump(val));
      }
      return '[' + output.join(', ') + ']';
    } else {
      output = [];
      for (key in value) {
        val = value[key];
        output.push(this.dump(key) + ': ' + this.dump(val));
      }
      return '{' + output.join(', ') + '}';
    }
  };

  Inline.parseScalar = function(scalar, delimiters, stringDelimiters, context, evaluate) {
    var i, joinedDelimiters, match, output, pattern, ref, ref1, strpos, tmp;
    if (delimiters == null) {
      delimiters = null;
    }
    if (stringDelimiters == null) {
      stringDelimiters = ['"', "'"];
    }
    if (context == null) {
      context = null;
    }
    if (evaluate == null) {
      evaluate = true;
    }
    if (context == null) {
      context = {
        exceptionOnInvalidType: this.settings.exceptionOnInvalidType,
        objectDecoder: this.settings.objectDecoder,
        i: 0
      };
    }
    i = context.i;
    if (ref = scalar.charAt(i), indexOf.call(stringDelimiters, ref) >= 0) {
      output = this.parseQuotedScalar(scalar, context);
      i = context.i;
      if (delimiters != null) {
        tmp = Utils.ltrim(scalar.slice(i), ' ');
        if (!(ref1 = tmp.charAt(0), indexOf.call(delimiters, ref1) >= 0)) {
          throw new ParseException('Unexpected characters (' + scalar.slice(i) + ').');
        }
      }
    } else {
      if (!delimiters) {
        output = scalar.slice(i);
        i += output.length;
        strpos = output.indexOf(' #');
        if (strpos !== -1) {
          output = Utils.rtrim(output.slice(0, strpos));
        }
      } else {
        joinedDelimiters = delimiters.join('|');
        pattern = this.PATTERN_SCALAR_BY_DELIMITERS[joinedDelimiters];
        if (pattern == null) {
          pattern = new Pattern('^(.+?)(' + joinedDelimiters + ')');
          this.PATTERN_SCALAR_BY_DELIMITERS[joinedDelimiters] = pattern;
        }
        if (match = pattern.exec(scalar.slice(i))) {
          output = match[1];
          i += output.length;
        } else {
          throw new ParseException('Malformed inline YAML string (' + scalar + ').');
        }
      }
      if (evaluate) {
        output = this.evaluateScalar(output, context);
      }
    }
    context.i = i;
    return output;
  };

  Inline.parseQuotedScalar = function(scalar, context) {
    var i, match, output;
    i = context.i;
    if (!(match = this.PATTERN_QUOTED_SCALAR.exec(scalar.slice(i)))) {
      throw new ParseMore('Malformed inline YAML string (' + scalar.slice(i) + ').');
    }
    output = match[0].substr(1, match[0].length - 2);
    if ('"' === scalar.charAt(i)) {
      output = Unescaper.unescapeDoubleQuotedString(output);
    } else {
      output = Unescaper.unescapeSingleQuotedString(output);
    }
    i += match[0].length;
    context.i = i;
    return output;
  };

  Inline.parseSequence = function(sequence, context) {
    var e, i, isQuoted, len, output, ref, value;
    output = [];
    len = sequence.length;
    i = context.i;
    i += 1;
    while (i < len) {
      context.i = i;
      switch (sequence.charAt(i)) {
        case '[':
          output.push(this.parseSequence(sequence, context));
          i = context.i;
          break;
        case '{':
          output.push(this.parseMapping(sequence, context));
          i = context.i;
          break;
        case ']':
          return output;
        case ',':
        case ' ':
        case "\n":
          break;
        default:
          isQuoted = ((ref = sequence.charAt(i)) === '"' || ref === "'");
          value = this.parseScalar(sequence, [',', ']'], ['"', "'"], context);
          i = context.i;
          if (!isQuoted && typeof value === 'string' && (value.indexOf(': ') !== -1 || value.indexOf(":\n") !== -1)) {
            try {
              value = this.parseMapping('{' + value + '}');
            } catch (error) {
              e = error;
            }
          }
          output.push(value);
          --i;
      }
      ++i;
    }
    throw new ParseMore('Malformed inline YAML string ' + sequence);
  };

  Inline.parseMapping = function(mapping, context) {
    var done, i, key, len, output, shouldContinueWhileLoop, value;
    output = {};
    len = mapping.length;
    i = context.i;
    i += 1;
    shouldContinueWhileLoop = false;
    while (i < len) {
      context.i = i;
      switch (mapping.charAt(i)) {
        case ' ':
        case ',':
        case "\n":
          ++i;
          context.i = i;
          shouldContinueWhileLoop = true;
          break;
        case '}':
          return output;
      }
      if (shouldContinueWhileLoop) {
        shouldContinueWhileLoop = false;
        continue;
      }
      key = this.parseScalar(mapping, [':', ' ', "\n"], ['"', "'"], context, false);
      i = context.i;
      done = false;
      while (i < len) {
        context.i = i;
        switch (mapping.charAt(i)) {
          case '[':
            value = this.parseSequence(mapping, context);
            i = context.i;
            if (output[key] === void 0) {
              output[key] = value;
            }
            done = true;
            break;
          case '{':
            value = this.parseMapping(mapping, context);
            i = context.i;
            if (output[key] === void 0) {
              output[key] = value;
            }
            done = true;
            break;
          case ':':
          case ' ':
          case "\n":
            break;
          default:
            value = this.parseScalar(mapping, [',', '}'], ['"', "'"], context);
            i = context.i;
            if (output[key] === void 0) {
              output[key] = value;
            }
            done = true;
            --i;
        }
        ++i;
        if (done) {
          break;
        }
      }
    }
    throw new ParseMore('Malformed inline YAML string ' + mapping);
  };

  Inline.evaluateScalar = function(scalar, context) {
    var cast, date, exceptionOnInvalidType, firstChar, firstSpace, firstWord, objectDecoder, raw, scalarLower, subValue, trimmedScalar;
    scalar = Utils.trim(scalar);
    scalarLower = scalar.toLowerCase();
    switch (scalarLower) {
      case 'null':
      case '':
      case '~':
        return null;
      case 'true':
        return true;
      case 'false':
        return false;
      case '.inf':
        return 2e308;
      case '.nan':
        return 0/0;
      case '-.inf':
        return 2e308;
      default:
        firstChar = scalarLower.charAt(0);
        switch (firstChar) {
          case '!':
            firstSpace = scalar.indexOf(' ');
            if (firstSpace === -1) {
              firstWord = scalarLower;
            } else {
              firstWord = scalarLower.slice(0, firstSpace);
            }
            switch (firstWord) {
              case '!':
                if (firstSpace !== -1) {
                  return parseInt(this.parseScalar(scalar.slice(2)));
                }
                return null;
              case '!str':
                return Utils.ltrim(scalar.slice(4));
              case '!!str':
                return Utils.ltrim(scalar.slice(5));
              case '!!int':
                return parseInt(this.parseScalar(scalar.slice(5)));
              case '!!bool':
                return Utils.parseBoolean(this.parseScalar(scalar.slice(6)), false);
              case '!!float':
                return parseFloat(this.parseScalar(scalar.slice(7)));
              case '!!timestamp':
                return Utils.stringToDate(Utils.ltrim(scalar.slice(11)));
              default:
                if (context == null) {
                  context = {
                    exceptionOnInvalidType: this.settings.exceptionOnInvalidType,
                    objectDecoder: this.settings.objectDecoder,
                    i: 0
                  };
                }
                objectDecoder = context.objectDecoder, exceptionOnInvalidType = context.exceptionOnInvalidType;
                if (objectDecoder) {
                  trimmedScalar = Utils.rtrim(scalar);
                  firstSpace = trimmedScalar.indexOf(' ');
                  if (firstSpace === -1) {
                    return objectDecoder(trimmedScalar, null);
                  } else {
                    subValue = Utils.ltrim(trimmedScalar.slice(firstSpace + 1));
                    if (!(subValue.length > 0)) {
                      subValue = null;
                    }
                    return objectDecoder(trimmedScalar.slice(0, firstSpace), subValue);
                  }
                }
                if (exceptionOnInvalidType) {
                  throw new ParseException('Custom object support when parsing a YAML file has been disabled.');
                }
                return null;
            }
            break;
          case '0':
            if ('0x' === scalar.slice(0, 2)) {
              return Utils.hexDec(scalar);
            } else if (Utils.isDigits(scalar)) {
              return Utils.octDec(scalar);
            } else if (Utils.isNumeric(scalar)) {
              return parseFloat(scalar);
            } else {
              return scalar;
            }
            break;
          case '+':
            if (Utils.isDigits(scalar)) {
              raw = scalar;
              cast = parseInt(raw);
              if (raw === String(cast)) {
                return cast;
              } else {
                return raw;
              }
            } else if (Utils.isNumeric(scalar)) {
              return parseFloat(scalar);
            } else if (this.PATTERN_THOUSAND_NUMERIC_SCALAR.test(scalar)) {
              return parseFloat(scalar.replace(',', ''));
            }
            return scalar;
          case '-':
            if (Utils.isDigits(scalar.slice(1))) {
              if ('0' === scalar.charAt(1)) {
                return -Utils.octDec(scalar.slice(1));
              } else {
                raw = scalar.slice(1);
                cast = parseInt(raw);
                if (raw === String(cast)) {
                  return -cast;
                } else {
                  return -raw;
                }
              }
            } else if (Utils.isNumeric(scalar)) {
              return parseFloat(scalar);
            } else if (this.PATTERN_THOUSAND_NUMERIC_SCALAR.test(scalar)) {
              return parseFloat(scalar.replace(',', ''));
            }
            return scalar;
          default:
            if (date = Utils.stringToDate(scalar)) {
              return date;
            } else if (Utils.isNumeric(scalar)) {
              return parseFloat(scalar);
            } else if (this.PATTERN_THOUSAND_NUMERIC_SCALAR.test(scalar)) {
              return parseFloat(scalar.replace(',', ''));
            }
            return scalar;
        }
    }
  };

  return Inline;

})();

module.exports = Inline;

  };
  __modules["yamljs/lib/Pattern.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var Pattern;

Pattern = (function() {
  Pattern.prototype.regex = null;

  Pattern.prototype.rawRegex = null;

  Pattern.prototype.cleanedRegex = null;

  Pattern.prototype.mapping = null;

  function Pattern(rawRegex, modifiers) {
    var _char, capturingBracketNumber, cleanedRegex, i, len, mapping, name, part, subChar;
    if (modifiers == null) {
      modifiers = '';
    }
    cleanedRegex = '';
    len = rawRegex.length;
    mapping = null;
    capturingBracketNumber = 0;
    i = 0;
    while (i < len) {
      _char = rawRegex.charAt(i);
      if (_char === '\\') {
        cleanedRegex += rawRegex.slice(i, +(i + 1) + 1 || 9e9);
        i++;
      } else if (_char === '(') {
        if (i < len - 2) {
          part = rawRegex.slice(i, +(i + 2) + 1 || 9e9);
          if (part === '(?:') {
            i += 2;
            cleanedRegex += part;
          } else if (part === '(?<') {
            capturingBracketNumber++;
            i += 2;
            name = '';
            while (i + 1 < len) {
              subChar = rawRegex.charAt(i + 1);
              if (subChar === '>') {
                cleanedRegex += '(';
                i++;
                if (name.length > 0) {
                  if (mapping == null) {
                    mapping = {};
                  }
                  mapping[name] = capturingBracketNumber;
                }
                break;
              } else {
                name += subChar;
              }
              i++;
            }
          } else {
            cleanedRegex += _char;
            capturingBracketNumber++;
          }
        } else {
          cleanedRegex += _char;
        }
      } else {
        cleanedRegex += _char;
      }
      i++;
    }
    this.rawRegex = rawRegex;
    this.cleanedRegex = cleanedRegex;
    this.regex = new RegExp(this.cleanedRegex, 'g' + modifiers.replace('g', ''));
    this.mapping = mapping;
  }

  Pattern.prototype.exec = function(str) {
    var index, matches, name, ref;
    this.regex.lastIndex = 0;
    matches = this.regex.exec(str);
    if (matches == null) {
      return null;
    }
    if (this.mapping != null) {
      ref = this.mapping;
      for (name in ref) {
        index = ref[name];
        matches[name] = matches[index];
      }
    }
    return matches;
  };

  Pattern.prototype.test = function(str) {
    this.regex.lastIndex = 0;
    return this.regex.test(str);
  };

  Pattern.prototype.replace = function(str, replacement) {
    this.regex.lastIndex = 0;
    return str.replace(this.regex, replacement);
  };

  Pattern.prototype.replaceAll = function(str, replacement, limit) {
    var count;
    if (limit == null) {
      limit = 0;
    }
    this.regex.lastIndex = 0;
    count = 0;
    while (this.regex.test(str) && (limit === 0 || count < limit)) {
      this.regex.lastIndex = 0;
      str = str.replace(this.regex, replacement);
      count++;
    }
    return [str, count];
  };

  return Pattern;

})();

module.exports = Pattern;

  };
  __modules["yamljs/lib/Unescaper.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var Pattern, Unescaper, Utils;

Utils = require('./Utils');

Pattern = require('./Pattern');

Unescaper = (function() {
  function Unescaper() {}

  Unescaper.PATTERN_ESCAPED_CHARACTER = new Pattern('\\\\([0abt\tnvfre "\\/\\\\N_LP]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})');

  Unescaper.unescapeSingleQuotedString = function(value) {
    return value.replace(/\'\'/g, '\'');
  };

  Unescaper.unescapeDoubleQuotedString = function(value) {
    if (this._unescapeCallback == null) {
      this._unescapeCallback = (function(_this) {
        return function(str) {
          return _this.unescapeCharacter(str);
        };
      })(this);
    }
    return this.PATTERN_ESCAPED_CHARACTER.replace(value, this._unescapeCallback);
  };

  Unescaper.unescapeCharacter = function(value) {
    var ch;
    ch = String.fromCharCode;
    switch (value.charAt(1)) {
      case '0':
        return ch(0);
      case 'a':
        return ch(7);
      case 'b':
        return ch(8);
      case 't':
        return "\t";
      case "\t":
        return "\t";
      case 'n':
        return "\n";
      case 'v':
        return ch(11);
      case 'f':
        return ch(12);
      case 'r':
        return ch(13);
      case 'e':
        return ch(27);
      case ' ':
        return ' ';
      case '"':
        return '"';
      case '/':
        return '/';
      case '\\':
        return '\\';
      case 'N':
        return ch(0x0085);
      case '_':
        return ch(0x00A0);
      case 'L':
        return ch(0x2028);
      case 'P':
        return ch(0x2029);
      case 'x':
        return Utils.utf8chr(Utils.hexDec(value.substr(2, 2)));
      case 'u':
        return Utils.utf8chr(Utils.hexDec(value.substr(2, 4)));
      case 'U':
        return Utils.utf8chr(Utils.hexDec(value.substr(2, 8)));
      default:
        return '';
    }
  };

  return Unescaper;

})();

module.exports = Unescaper;

  };
  __modules["yamljs/lib/Utils.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var Pattern, Utils,
  hasProp = {}.hasOwnProperty;

Pattern = require('./Pattern');

Utils = (function() {
  function Utils() {}

  Utils.REGEX_LEFT_TRIM_BY_CHAR = {};

  Utils.REGEX_RIGHT_TRIM_BY_CHAR = {};

  Utils.REGEX_SPACES = /\s+/g;

  Utils.REGEX_DIGITS = /^\d+$/;

  Utils.REGEX_OCTAL = /[^0-7]/gi;

  Utils.REGEX_HEXADECIMAL = /[^a-f0-9]/gi;

  Utils.PATTERN_DATE = new Pattern('^' + '(?<year>[0-9][0-9][0-9][0-9])' + '-(?<month>[0-9][0-9]?)' + '-(?<day>[0-9][0-9]?)' + '(?:(?:[Tt]|[ \t]+)' + '(?<hour>[0-9][0-9]?)' + ':(?<minute>[0-9][0-9])' + ':(?<second>[0-9][0-9])' + '(?:\.(?<fraction>[0-9]*))?' + '(?:[ \t]*(?<tz>Z|(?<tz_sign>[-+])(?<tz_hour>[0-9][0-9]?)' + '(?::(?<tz_minute>[0-9][0-9]))?))?)?' + '$', 'i');

  Utils.LOCAL_TIMEZONE_OFFSET = new Date().getTimezoneOffset() * 60 * 1000;

  Utils.trim = function(str, _char) {
    var regexLeft, regexRight;
    if (_char == null) {
      _char = '\\s';
    }
    regexLeft = this.REGEX_LEFT_TRIM_BY_CHAR[_char];
    if (regexLeft == null) {
      this.REGEX_LEFT_TRIM_BY_CHAR[_char] = regexLeft = new RegExp('^' + _char + '' + _char + '*');
    }
    regexLeft.lastIndex = 0;
    regexRight = this.REGEX_RIGHT_TRIM_BY_CHAR[_char];
    if (regexRight == null) {
      this.REGEX_RIGHT_TRIM_BY_CHAR[_char] = regexRight = new RegExp(_char + '' + _char + '*$');
    }
    regexRight.lastIndex = 0;
    return str.replace(regexLeft, '').replace(regexRight, '');
  };

  Utils.ltrim = function(str, _char) {
    var regexLeft;
    if (_char == null) {
      _char = '\\s';
    }
    regexLeft = this.REGEX_LEFT_TRIM_BY_CHAR[_char];
    if (regexLeft == null) {
      this.REGEX_LEFT_TRIM_BY_CHAR[_char] = regexLeft = new RegExp('^' + _char + '' + _char + '*');
    }
    regexLeft.lastIndex = 0;
    return str.replace(regexLeft, '');
  };

  Utils.rtrim = function(str, _char) {
    var regexRight;
    if (_char == null) {
      _char = '\\s';
    }
    regexRight = this.REGEX_RIGHT_TRIM_BY_CHAR[_char];
    if (regexRight == null) {
      this.REGEX_RIGHT_TRIM_BY_CHAR[_char] = regexRight = new RegExp(_char + '' + _char + '*$');
    }
    regexRight.lastIndex = 0;
    return str.replace(regexRight, '');
  };

  Utils.isEmpty = function(value) {
    return !value || value === '' || value === '0' || (value instanceof Array && value.length === 0) || this.isEmptyObject(value);
  };

  Utils.isEmptyObject = function(value) {
    var k;
    return value instanceof Object && ((function() {
      var results;
      results = [];
      for (k in value) {
        if (!hasProp.call(value, k)) continue;
        results.push(k);
      }
      return results;
    })()).length === 0;
  };

  Utils.subStrCount = function(string, subString, start, length) {
    var c, i, j, len, ref, sublen;
    c = 0;
    string = '' + string;
    subString = '' + subString;
    if (start != null) {
      string = string.slice(start);
    }
    if (length != null) {
      string = string.slice(0, length);
    }
    len = string.length;
    sublen = subString.length;
    for (i = j = 0, ref = len; 0 <= ref ? j < ref : j > ref; i = 0 <= ref ? ++j : --j) {
      if (subString === string.slice(i, sublen)) {
        c++;
        i += sublen - 1;
      }
    }
    return c;
  };

  Utils.isDigits = function(input) {
    this.REGEX_DIGITS.lastIndex = 0;
    return this.REGEX_DIGITS.test(input);
  };

  Utils.octDec = function(input) {
    this.REGEX_OCTAL.lastIndex = 0;
    return parseInt((input + '').replace(this.REGEX_OCTAL, ''), 8);
  };

  Utils.hexDec = function(input) {
    this.REGEX_HEXADECIMAL.lastIndex = 0;
    input = this.trim(input);
    if ((input + '').slice(0, 2) === '0x') {
      input = (input + '').slice(2);
    }
    return parseInt((input + '').replace(this.REGEX_HEXADECIMAL, ''), 16);
  };

  Utils.utf8chr = function(c) {
    var ch;
    ch = String.fromCharCode;
    if (0x80 > (c %= 0x200000)) {
      return ch(c);
    }
    if (0x800 > c) {
      return ch(0xC0 | c >> 6) + ch(0x80 | c & 0x3F);
    }
    if (0x10000 > c) {
      return ch(0xE0 | c >> 12) + ch(0x80 | c >> 6 & 0x3F) + ch(0x80 | c & 0x3F);
    }
    return ch(0xF0 | c >> 18) + ch(0x80 | c >> 12 & 0x3F) + ch(0x80 | c >> 6 & 0x3F) + ch(0x80 | c & 0x3F);
  };

  Utils.parseBoolean = function(input, strict) {
    var lowerInput;
    if (strict == null) {
      strict = true;
    }
    if (typeof input === 'string') {
      lowerInput = input.toLowerCase();
      if (!strict) {
        if (lowerInput === 'no') {
          return false;
        }
      }
      if (lowerInput === '0') {
        return false;
      }
      if (lowerInput === 'false') {
        return false;
      }
      if (lowerInput === '') {
        return false;
      }
      return true;
    }
    return !!input;
  };

  Utils.isNumeric = function(input) {
    this.REGEX_SPACES.lastIndex = 0;
    return typeof input === 'number' || typeof input === 'string' && !isNaN(input) && input.replace(this.REGEX_SPACES, '') !== '';
  };

  Utils.stringToDate = function(str) {
    var date, day, fraction, hour, info, minute, month, second, tz_hour, tz_minute, tz_offset, year;
    if (!(str != null ? str.length : void 0)) {
      return null;
    }
    info = this.PATTERN_DATE.exec(str);
    if (!info) {
      return null;
    }
    year = parseInt(info.year, 10);
    month = parseInt(info.month, 10) - 1;
    day = parseInt(info.day, 10);
    if (info.hour == null) {
      date = new Date(Date.UTC(year, month, day));
      return date;
    }
    hour = parseInt(info.hour, 10);
    minute = parseInt(info.minute, 10);
    second = parseInt(info.second, 10);
    if (info.fraction != null) {
      fraction = info.fraction.slice(0, 3);
      while (fraction.length < 3) {
        fraction += '0';
      }
      fraction = parseInt(fraction, 10);
    } else {
      fraction = 0;
    }
    if (info.tz != null) {
      tz_hour = parseInt(info.tz_hour, 10);
      if (info.tz_minute != null) {
        tz_minute = parseInt(info.tz_minute, 10);
      } else {
        tz_minute = 0;
      }
      tz_offset = (tz_hour * 60 + tz_minute) * 60000;
      if ('-' === info.tz_sign) {
        tz_offset *= -1;
      }
    }
    date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
    if (tz_offset) {
      date.setTime(date.getTime() - tz_offset);
    }
    return date;
  };

  Utils.strRepeat = function(str, number) {
    var i, res;
    res = '';
    i = 0;
    while (i < number) {
      res += str;
      i++;
    }
    return res;
  };

  Utils.getStringFromFile = function(path, callback) {
    var data, fs, j, len1, name, ref, req, xhr;
    if (callback == null) {
      callback = null;
    }
    xhr = null;
    if (typeof window !== "undefined" && window !== null) {
      if (window.XMLHttpRequest) {
        xhr = new XMLHttpRequest();
      } else if (window.ActiveXObject) {
        ref = ["Msxml2.XMLHTTP.6.0", "Msxml2.XMLHTTP.3.0", "Msxml2.XMLHTTP", "Microsoft.XMLHTTP"];
        for (j = 0, len1 = ref.length; j < len1; j++) {
          name = ref[j];
          try {
            xhr = new ActiveXObject(name);
          } catch (error) {}
        }
      }
    }
    if (xhr != null) {
      if (callback != null) {
        xhr.onreadystatechange = function() {
          if (xhr.readyState === 4) {
            if (xhr.status === 200 || xhr.status === 0) {
              return callback(xhr.responseText);
            } else {
              return callback(null);
            }
          }
        };
        xhr.open('GET', path, true);
        return xhr.send(null);
      } else {
        xhr.open('GET', path, false);
        xhr.send(null);
        if (xhr.status === 200 || xhr.status === 0) {
          return xhr.responseText;
        }
        return null;
      }
    } else {
      req = require;
      fs = req('fs');
      if (callback != null) {
        return fs.readFile(path, function(err, data) {
          if (err) {
            return callback(null);
          } else {
            return callback(String(data));
          }
        });
      } else {
        data = fs.readFileSync(path);
        if (data != null) {
          return String(data);
        }
        return null;
      }
    }
  };

  return Utils;

})();

module.exports = Utils;

  };
  __modules["yamljs/lib/Escaper.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var Escaper, Pattern;

Pattern = require('./Pattern');

Escaper = (function() {
  var ch;

  function Escaper() {}

  Escaper.LIST_ESCAPEES = ['\\', '\\\\', '\\"', '"', "\x00", "\x01", "\x02", "\x03", "\x04", "\x05", "\x06", "\x07", "\x08", "\x09", "\x0a", "\x0b", "\x0c", "\x0d", "\x0e", "\x0f", "\x10", "\x11", "\x12", "\x13", "\x14", "\x15", "\x16", "\x17", "\x18", "\x19", "\x1a", "\x1b", "\x1c", "\x1d", "\x1e", "\x1f", (ch = String.fromCharCode)(0x0085), ch(0x00A0), ch(0x2028), ch(0x2029)];

  Escaper.LIST_ESCAPED = ['\\\\', '\\"', '\\"', '\\"', "\\0", "\\x01", "\\x02", "\\x03", "\\x04", "\\x05", "\\x06", "\\a", "\\b", "\\t", "\\n", "\\v", "\\f", "\\r", "\\x0e", "\\x0f", "\\x10", "\\x11", "\\x12", "\\x13", "\\x14", "\\x15", "\\x16", "\\x17", "\\x18", "\\x19", "\\x1a", "\\e", "\\x1c", "\\x1d", "\\x1e", "\\x1f", "\\N", "\\_", "\\L", "\\P"];

  Escaper.MAPPING_ESCAPEES_TO_ESCAPED = (function() {
    var i, j, mapping, ref;
    mapping = {};
    for (i = j = 0, ref = Escaper.LIST_ESCAPEES.length; 0 <= ref ? j < ref : j > ref; i = 0 <= ref ? ++j : --j) {
      mapping[Escaper.LIST_ESCAPEES[i]] = Escaper.LIST_ESCAPED[i];
    }
    return mapping;
  })();

  Escaper.PATTERN_CHARACTERS_TO_ESCAPE = new Pattern('[\\x00-\\x1f]|\xc2\x85|\xc2\xa0|\xe2\x80\xa8|\xe2\x80\xa9');

  Escaper.PATTERN_MAPPING_ESCAPEES = new Pattern(Escaper.LIST_ESCAPEES.join('|').split('\\').join('\\\\'));

  Escaper.PATTERN_SINGLE_QUOTING = new Pattern('[\\s\'":{}[\\],&*#?]|^[-?|<>=!%@`]');

  Escaper.requiresDoubleQuoting = function(value) {
    return this.PATTERN_CHARACTERS_TO_ESCAPE.test(value);
  };

  Escaper.escapeWithDoubleQuotes = function(value) {
    var result;
    result = this.PATTERN_MAPPING_ESCAPEES.replace(value, (function(_this) {
      return function(str) {
        return _this.MAPPING_ESCAPEES_TO_ESCAPED[str];
      };
    })(this));
    return '"' + result + '"';
  };

  Escaper.requiresSingleQuoting = function(value) {
    return this.PATTERN_SINGLE_QUOTING.test(value);
  };

  Escaper.escapeWithSingleQuotes = function(value) {
    return "'" + value.replace(/'/g, "''") + "'";
  };

  return Escaper;

})();

module.exports = Escaper;

  };
  __modules["yamljs/lib/Exception/ParseException.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var ParseException,
  extend = function(child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; },
  hasProp = {}.hasOwnProperty;

ParseException = (function(superClass) {
  extend(ParseException, superClass);

  function ParseException(message, parsedLine, snippet) {
    this.message = message;
    this.parsedLine = parsedLine;
    this.snippet = snippet;
  }

  ParseException.prototype.toString = function() {
    if ((this.parsedLine != null) && (this.snippet != null)) {
      return '<ParseException> ' + this.message + ' (line ' + this.parsedLine + ': \'' + this.snippet + '\')';
    } else {
      return '<ParseException> ' + this.message;
    }
  };

  return ParseException;

})(Error);

module.exports = ParseException;

  };
  __modules["yamljs/lib/Exception/ParseMore.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var ParseMore,
  extend = function(child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; },
  hasProp = {}.hasOwnProperty;

ParseMore = (function(superClass) {
  extend(ParseMore, superClass);

  function ParseMore(message, parsedLine, snippet) {
    this.message = message;
    this.parsedLine = parsedLine;
    this.snippet = snippet;
  }

  ParseMore.prototype.toString = function() {
    if ((this.parsedLine != null) && (this.snippet != null)) {
      return '<ParseMore> ' + this.message + ' (line ' + this.parsedLine + ': \'' + this.snippet + '\')';
    } else {
      return '<ParseMore> ' + this.message;
    }
  };

  return ParseMore;

})(Error);

module.exports = ParseMore;

  };
  __modules["yamljs/lib/Exception/DumpException.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var DumpException,
  extend = function(child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; },
  hasProp = {}.hasOwnProperty;

DumpException = (function(superClass) {
  extend(DumpException, superClass);

  function DumpException(message, parsedLine, snippet) {
    this.message = message;
    this.parsedLine = parsedLine;
    this.snippet = snippet;
  }

  DumpException.prototype.toString = function() {
    if ((this.parsedLine != null) && (this.snippet != null)) {
      return '<DumpException> ' + this.message + ' (line ' + this.parsedLine + ': \'' + this.snippet + '\')';
    } else {
      return '<DumpException> ' + this.message;
    }
  };

  return DumpException;

})(Error);

module.exports = DumpException;

  };
  __modules["yamljs/lib/Dumper.js"] = function (module, exports, require) {
// Generated by CoffeeScript 1.12.4
var Dumper, Inline, Utils;

Utils = require('./Utils');

Inline = require('./Inline');

Dumper = (function() {
  function Dumper() {}

  Dumper.indentation = 4;

  Dumper.prototype.dump = function(input, inline, indent, exceptionOnInvalidType, objectEncoder) {
    var i, key, len, output, prefix, value, willBeInlined;
    if (inline == null) {
      inline = 0;
    }
    if (indent == null) {
      indent = 0;
    }
    if (exceptionOnInvalidType == null) {
      exceptionOnInvalidType = false;
    }
    if (objectEncoder == null) {
      objectEncoder = null;
    }
    output = '';
    prefix = (indent ? Utils.strRepeat(' ', indent) : '');
    if (inline <= 0 || typeof input !== 'object' || input instanceof Date || Utils.isEmpty(input)) {
      output += prefix + Inline.dump(input, exceptionOnInvalidType, objectEncoder);
    } else {
      if (input instanceof Array) {
        for (i = 0, len = input.length; i < len; i++) {
          value = input[i];
          willBeInlined = inline - 1 <= 0 || typeof value !== 'object' || Utils.isEmpty(value);
          output += prefix + '-' + (willBeInlined ? ' ' : "\n") + this.dump(value, inline - 1, (willBeInlined ? 0 : indent + this.indentation), exceptionOnInvalidType, objectEncoder) + (willBeInlined ? "\n" : '');
        }
      } else {
        for (key in input) {
          value = input[key];
          willBeInlined = inline - 1 <= 0 || typeof value !== 'object' || Utils.isEmpty(value);
          output += prefix + Inline.dump(key, exceptionOnInvalidType, objectEncoder) + ':' + (willBeInlined ? ' ' : "\n") + this.dump(value, inline - 1, (willBeInlined ? 0 : indent + this.indentation), exceptionOnInvalidType, objectEncoder) + (willBeInlined ? "\n" : '');
        }
      }
    }
    return output;
  };

  return Dumper;

})();

module.exports = Dumper;

  };
  __modules["deepmerge-ts/dist/node/index.cjs"] = function (module, exports, require) {
'use strict';

/**
 * Special values that tell deepmerge to perform a certain action.
 */
const actions = {
    defaultMerge: Symbol("deepmerge-ts: default merge"),
    skip: Symbol("deepmerge-ts: skip"),
};
/**
 * Special values that tell deepmergeInto to perform a certain action.
 */
const actionsInto = {
    defaultMerge: actions.defaultMerge,
};

/**
 * The default function to update meta data.
 */
function defaultMetaDataUpdater(previousMeta, metaMeta) {
    return metaMeta;
}

/**
 * Get the type of the given object.
 *
 * @param object - The object to get the type of.
 * @returns The type of the given object.
 */
function getObjectType(object) {
    if (typeof object !== "object" || object === null) {
        return 0 /* ObjectType.NOT */;
    }
    if (Array.isArray(object)) {
        return 2 /* ObjectType.ARRAY */;
    }
    if (isRecord(object)) {
        return 1 /* ObjectType.RECORD */;
    }
    if (object instanceof Set) {
        return 3 /* ObjectType.SET */;
    }
    if (object instanceof Map) {
        return 4 /* ObjectType.MAP */;
    }
    return 5 /* ObjectType.OTHER */;
}
/**
 * Get the keys of the given objects including symbol keys.
 *
 * Note: Only keys to enumerable properties are returned.
 *
 * @param objects - An array of objects to get the keys of.
 * @returns A set containing all the keys of all the given objects.
 */
function getKeys(objects) {
    const keys = new Set();
    /* eslint-disable functional/no-loop-statements, functional/no-expression-statements -- using a loop here is more efficient. */
    for (const object of objects) {
        for (const key of [
            ...Object.keys(object),
            ...Object.getOwnPropertySymbols(object),
        ]) {
            keys.add(key);
        }
    }
    /* eslint-enable functional/no-loop-statements, functional/no-expression-statements */
    return keys;
}
/**
 * Does the given object have the given property.
 *
 * @param object - The object to test.
 * @param property - The property to test.
 * @returns Whether the object has the property.
 */
function objectHasProperty(object, property) {
    return (typeof object === "object" &&
        Object.prototype.propertyIsEnumerable.call(object, property));
}
/**
 * Get an iterable object that iterates over the given iterables.
 */
function getIterableOfIterables(iterables) {
    return {
        // eslint-disable-next-line functional/functional-parameters
        *[Symbol.iterator]() {
            // eslint-disable-next-line functional/no-loop-statements
            for (const iterable of iterables) {
                // eslint-disable-next-line functional/no-loop-statements
                for (const value of iterable) {
                    yield value;
                }
            }
        },
    };
}
const validRecordToStringValues = new Set([
    "[object Object]",
    "[object Module]",
]);
/**
 * Does the given object appear to be a record.
 */
function isRecord(value) {
    // All records are objects.
    if (!validRecordToStringValues.has(Object.prototype.toString.call(value))) {
        return false;
    }
    const { constructor } = value;
    // If has modified constructor.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (constructor === undefined) {
        return true;
    }
    // eslint-disable-next-line prefer-destructuring
    const prototype = constructor.prototype;
    // If has modified prototype.
    if (prototype === null ||
        typeof prototype !== "object" ||
        !validRecordToStringValues.has(Object.prototype.toString.call(prototype))) {
        return false;
    }
    // If constructor does not have an Object-specific method.
    // eslint-disable-next-line sonarjs/prefer-single-boolean-return, no-prototype-builtins
    if (!prototype.hasOwnProperty("isPrototypeOf")) {
        return false;
    }
    // Most likely a record.
    return true;
}

/**
 * The default strategy to merge records.
 *
 * @param values - The records.
 */
function mergeRecords$2(values, utils, meta) {
    const result = {};
    /* eslint-disable functional/no-loop-statements, functional/no-conditional-statements, functional/no-expression-statements, functional/immutable-data -- using imperative code here is more performant. */
    for (const key of getKeys(values)) {
        const propValues = [];
        for (const value of values) {
            if (objectHasProperty(value, key)) {
                propValues.push(value[key]);
            }
        }
        if (propValues.length === 0) {
            continue;
        }
        const updatedMeta = utils.metaDataUpdater(meta, {
            key,
            parents: values,
        });
        const propertyResult = mergeUnknowns(propValues, utils, updatedMeta);
        if (propertyResult === actions.skip) {
            continue;
        }
        if (key === "__proto__") {
            Object.defineProperty(result, key, {
                value: propertyResult,
                configurable: true,
                enumerable: true,
                writable: true,
            });
        }
        else {
            result[key] = propertyResult;
        }
    }
    /* eslint-enable functional/no-loop-statements, functional/no-conditional-statements, functional/no-expression-statements, functional/immutable-data */
    return result;
}
/**
 * The default strategy to merge arrays.
 *
 * @param values - The arrays.
 */
function mergeArrays$2(values) {
    return values.flat();
}
/**
 * The default strategy to merge sets.
 *
 * @param values - The sets.
 */
function mergeSets$2(values) {
    return new Set(getIterableOfIterables(values));
}
/**
 * The default strategy to merge maps.
 *
 * @param values - The maps.
 */
function mergeMaps$2(values) {
    return new Map(getIterableOfIterables(values));
}
/**
 * Get the last value in the given array.
 */
function mergeOthers$2(values) {
    return values.at(-1);
}

var defaultMergeFunctions = /*#__PURE__*/Object.freeze({
    __proto__: null,
    mergeArrays: mergeArrays$2,
    mergeMaps: mergeMaps$2,
    mergeOthers: mergeOthers$2,
    mergeRecords: mergeRecords$2,
    mergeSets: mergeSets$2
});

/**
 * Deeply merge objects.
 *
 * @param objects - The objects to merge.
 */
function deepmerge(
// eslint-disable-next-line functional/functional-parameters
...objects) {
    return deepmergeCustom({})(...objects);
}
function deepmergeCustom(options, rootMetaData) {
    const utils = getUtils(options, customizedDeepmerge);
    /**
     * The customized deepmerge function.
     */
    function customizedDeepmerge(
    // eslint-disable-next-line functional/functional-parameters
    ...objects) {
        return mergeUnknowns(objects, utils, rootMetaData);
    }
    return customizedDeepmerge;
}
/**
 * The the utils that are available to the merge functions.
 *
 * @param options - The options the user specified
 */
function getUtils(options, customizedDeepmerge) {
    return {
        defaultMergeFunctions,
        mergeFunctions: {
            ...defaultMergeFunctions,
            ...Object.fromEntries(Object.entries(options)
                .filter(([key, option]) => Object.hasOwn(defaultMergeFunctions, key))
                .map(([key, option]) => option === false
                ? [key, mergeOthers$2]
                : [key, option])),
        },
        metaDataUpdater: (options.metaDataUpdater ??
            defaultMetaDataUpdater),
        deepmerge: customizedDeepmerge,
        useImplicitDefaultMerging: options.enableImplicitDefaultMerging ?? false,
        actions,
    };
}
/**
 * Merge unknown things.
 *
 * @param values - The values.
 */
function mergeUnknowns(values, utils, meta) {
    if (values.length === 0) {
        return undefined;
    }
    if (values.length === 1) {
        return mergeOthers$1(values, utils, meta);
    }
    const type = getObjectType(values[0]);
    /* eslint-disable functional/no-loop-statements, functional/no-conditional-statements -- using imperative code here is more performant. */
    if (type !== 0 /* ObjectType.NOT */ && type !== 5 /* ObjectType.OTHER */) {
        for (let m_index = 1; m_index < values.length; m_index++) {
            if (getObjectType(values[m_index]) === type) {
                continue;
            }
            return mergeOthers$1(values, utils, meta);
        }
    }
    /* eslint-enable functional/no-loop-statements, functional/no-conditional-statements */
    switch (type) {
        case 1 /* ObjectType.RECORD */: {
            return mergeRecords$1(values, utils, meta);
        }
        case 2 /* ObjectType.ARRAY */: {
            return mergeArrays$1(values, utils, meta);
        }
        case 3 /* ObjectType.SET */: {
            return mergeSets$1(values, utils, meta);
        }
        case 4 /* ObjectType.MAP */: {
            return mergeMaps$1(values, utils, meta);
        }
        default: {
            return mergeOthers$1(values, utils, meta);
        }
    }
}
/**
 * Merge records.
 *
 * @param values - The records.
 */
function mergeRecords$1(values, utils, meta) {
    const result = utils.mergeFunctions.mergeRecords(values, utils, meta);
    if (result === actions.defaultMerge ||
        (utils.useImplicitDefaultMerging &&
            result === undefined &&
            utils.mergeFunctions.mergeRecords !==
                utils.defaultMergeFunctions.mergeRecords)) {
        return utils.defaultMergeFunctions.mergeRecords(values, utils, meta);
    }
    return result;
}
/**
 * Merge arrays.
 *
 * @param values - The arrays.
 */
function mergeArrays$1(values, utils, meta) {
    const result = utils.mergeFunctions.mergeArrays(values, utils, meta);
    if (result === actions.defaultMerge ||
        (utils.useImplicitDefaultMerging &&
            result === undefined &&
            utils.mergeFunctions.mergeArrays !==
                utils.defaultMergeFunctions.mergeArrays)) {
        return utils.defaultMergeFunctions.mergeArrays(values);
    }
    return result;
}
/**
 * Merge sets.
 *
 * @param values - The sets.
 */
function mergeSets$1(values, utils, meta) {
    const result = utils.mergeFunctions.mergeSets(values, utils, meta);
    if (result === actions.defaultMerge ||
        (utils.useImplicitDefaultMerging &&
            result === undefined &&
            utils.mergeFunctions.mergeSets !== utils.defaultMergeFunctions.mergeSets)) {
        return utils.defaultMergeFunctions.mergeSets(values);
    }
    return result;
}
/**
 * Merge maps.
 *
 * @param values - The maps.
 */
function mergeMaps$1(values, utils, meta) {
    const result = utils.mergeFunctions.mergeMaps(values, utils, meta);
    if (result === actions.defaultMerge ||
        (utils.useImplicitDefaultMerging &&
            result === undefined &&
            utils.mergeFunctions.mergeMaps !== utils.defaultMergeFunctions.mergeMaps)) {
        return utils.defaultMergeFunctions.mergeMaps(values);
    }
    return result;
}
/**
 * Merge other things.
 *
 * @param values - The other things.
 */
function mergeOthers$1(values, utils, meta) {
    const result = utils.mergeFunctions.mergeOthers(values, utils, meta);
    if (result === actions.defaultMerge ||
        (utils.useImplicitDefaultMerging &&
            result === undefined &&
            utils.mergeFunctions.mergeOthers !==
                utils.defaultMergeFunctions.mergeOthers)) {
        return utils.defaultMergeFunctions.mergeOthers(values);
    }
    return result;
}

/**
 * The default strategy to merge records into a target record.
 *
 * @param m_target - The result will be mutated into this record
 * @param values - The records (including the target's value if there is one).
 */
function mergeRecords(m_target, values, utils, meta) {
    for (const key of getKeys(values)) {
        const propValues = [];
        for (const value of values) {
            if (objectHasProperty(value, key)) {
                propValues.push(value[key]);
            }
        }
        if (propValues.length === 0) {
            continue;
        }
        const updatedMeta = utils.metaDataUpdater(meta, {
            key,
            parents: values,
        });
        const propertyTarget = { value: propValues[0] };
        mergeUnknownsInto(propertyTarget, propValues, utils, updatedMeta);
        if (key === "__proto__") {
            Object.defineProperty(m_target, key, {
                value: propertyTarget.value,
                configurable: true,
                enumerable: true,
                writable: true,
            });
        }
        else {
            m_target.value[key] = propertyTarget.value;
        }
    }
}
/**
 * The default strategy to merge arrays into a target array.
 *
 * @param m_target - The result will be mutated into this array
 * @param values - The arrays (including the target's value if there is one).
 */
function mergeArrays(m_target, values) {
    m_target.value.push(...values.slice(1).flat());
}
/**
 * The default strategy to merge sets into a target set.
 *
 * @param m_target - The result will be mutated into this set
 * @param values - The sets (including the target's value if there is one).
 */
function mergeSets(m_target, values) {
    for (const value of getIterableOfIterables(values.slice(1))) {
        m_target.value.add(value);
    }
}
/**
 * The default strategy to merge maps into a target map.
 *
 * @param m_target - The result will be mutated into this map
 * @param values - The maps (including the target's value if there is one).
 */
function mergeMaps(m_target, values) {
    for (const [key, value] of getIterableOfIterables(values.slice(1))) {
        m_target.value.set(key, value);
    }
}
/**
 * Set the target to the last value.
 */
function mergeOthers(m_target, values) {
    m_target.value = values.at(-1);
}

var defaultMergeIntoFunctions = /*#__PURE__*/Object.freeze({
    __proto__: null,
    mergeArrays: mergeArrays,
    mergeMaps: mergeMaps,
    mergeOthers: mergeOthers,
    mergeRecords: mergeRecords,
    mergeSets: mergeSets
});

function deepmergeInto(target, ...objects) {
    return void deepmergeIntoCustom({})(target, ...objects);
}
function deepmergeIntoCustom(options, rootMetaData) {
    const utils = getIntoUtils(options, customizedDeepmergeInto);
    /**
     * The customized deepmerge function.
     */
    function customizedDeepmergeInto(target, ...objects) {
        mergeUnknownsInto({ value: target }, [target, ...objects], utils, rootMetaData);
    }
    return customizedDeepmergeInto;
}
/**
 * The the utils that are available to the merge functions.
 *
 * @param options - The options the user specified
 */
function getIntoUtils(options, customizedDeepmergeInto) {
    return {
        defaultMergeFunctions: defaultMergeIntoFunctions,
        mergeFunctions: {
            ...defaultMergeIntoFunctions,
            ...Object.fromEntries(Object.entries(options)
                .filter(([key, option]) => Object.hasOwn(defaultMergeIntoFunctions, key))
                .map(([key, option]) => option === false
                ? [key, mergeOthers]
                : [key, option])),
        },
        metaDataUpdater: (options.metaDataUpdater ??
            defaultMetaDataUpdater),
        deepmergeInto: customizedDeepmergeInto,
        actions: actionsInto,
    };
}
/**
 * Merge unknown things into a target.
 *
 * @param m_target - The target to merge into.
 * @param values - The values.
 */
function mergeUnknownsInto(m_target, values, utils, meta
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
) {
    if (values.length === 0) {
        return;
    }
    if (values.length === 1) {
        return void mergeOthersInto(m_target, values, utils, meta);
    }
    const type = getObjectType(m_target.value);
    if (type !== 0 /* ObjectType.NOT */ && type !== 5 /* ObjectType.OTHER */) {
        for (let m_index = 1; m_index < values.length; m_index++) {
            if (getObjectType(values[m_index]) === type) {
                continue;
            }
            return void mergeOthersInto(m_target, values, utils, meta);
        }
    }
    switch (type) {
        case 1 /* ObjectType.RECORD */: {
            return void mergeRecordsInto(m_target, values, utils, meta);
        }
        case 2 /* ObjectType.ARRAY */: {
            return void mergeArraysInto(m_target, values, utils, meta);
        }
        case 3 /* ObjectType.SET */: {
            return void mergeSetsInto(m_target, values, utils, meta);
        }
        case 4 /* ObjectType.MAP */: {
            return void mergeMapsInto(m_target, values, utils, meta);
        }
        default: {
            return void mergeOthersInto(m_target, values, utils, meta);
        }
    }
}
/**
 * Merge records into a target record.
 *
 * @param m_target - The target to merge into.
 * @param values - The records.
 */
function mergeRecordsInto(m_target, values, utils, meta) {
    const action = utils.mergeFunctions.mergeRecords(m_target, values, utils, meta);
    if (action === actionsInto.defaultMerge) {
        utils.defaultMergeFunctions.mergeRecords(m_target, values, utils, meta);
    }
}
/**
 * Merge arrays into a target array.
 *
 * @param m_target - The target to merge into.
 * @param values - The arrays.
 */
function mergeArraysInto(m_target, values, utils, meta) {
    const action = utils.mergeFunctions.mergeArrays(m_target, values, utils, meta);
    if (action === actionsInto.defaultMerge) {
        utils.defaultMergeFunctions.mergeArrays(m_target, values);
    }
}
/**
 * Merge sets into a target set.
 *
 * @param m_target - The target to merge into.
 * @param values - The sets.
 */
function mergeSetsInto(m_target, values, utils, meta) {
    const action = utils.mergeFunctions.mergeSets(m_target, values, utils, meta);
    if (action === actionsInto.defaultMerge) {
        utils.defaultMergeFunctions.mergeSets(m_target, values);
    }
}
/**
 * Merge maps into a target map.
 *
 * @param m_target - The target to merge into.
 * @param values - The maps.
 */
function mergeMapsInto(m_target, values, utils, meta) {
    const action = utils.mergeFunctions.mergeMaps(m_target, values, utils, meta);
    if (action === actionsInto.defaultMerge) {
        utils.defaultMergeFunctions.mergeMaps(m_target, values);
    }
}
/**
 * Merge other things into a target.
 *
 * @param m_target - The target to merge into.
 * @param values - The other things.
 */
function mergeOthersInto(m_target, values, utils, meta) {
    const action = utils.mergeFunctions.mergeOthers(m_target, values, utils, meta);
    if (action === actionsInto.defaultMerge ||
        m_target.value === actionsInto.defaultMerge) {
        utils.defaultMergeFunctions.mergeOthers(m_target, values);
    }
}

exports.deepmerge = deepmerge;
exports.deepmergeCustom = deepmergeCustom;
exports.deepmergeInto = deepmergeInto;
exports.deepmergeIntoCustom = deepmergeIntoCustom;
exports.getKeys = getKeys;
exports.getObjectType = getObjectType;
exports.objectHasProperty = objectHasProperty;

  };
  root["composerize"] = (function () { var __v = __req("dist/cjs/index.js"); return __v == null ? __v : __v["composerize"]; })();
})(typeof globalThis !== 'undefined' ? globalThis : this);
