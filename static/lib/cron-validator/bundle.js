/* 由 scripts/vendor-js-libs.sh 自动生成，请勿手改。
 * 源包: package  入口: lib/index.js
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

  var __alias = {};
  __modules["lib/index.js"] = function (module, exports, require) {
"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidCron = void 0;
// This comes from the fact that parseInt trims characters coming
// after digits and consider it a valid int, so `1*` becomes `1`.
var safeParseInt = function (value) {
    if (/^\d+$/.test(value)) {
        return Number(value);
    }
    else {
        return NaN;
    }
};
var isWildcard = function (value) {
    return value === '*';
};
var isQuestionMark = function (value) {
    return value === '?';
};
var isInRange = function (value, start, stop) {
    return value >= start && value <= stop;
};
var isValidRange = function (value, start, stop) {
    var sides = value.split('-');
    switch (sides.length) {
        case 1:
            return isWildcard(value) || isInRange(safeParseInt(value), start, stop);
        case 2:
            var _a = sides.map(function (side) { return safeParseInt(side); }), small = _a[0], big = _a[1];
            return small <= big && isInRange(small, start, stop) && isInRange(big, start, stop);
        default:
            return false;
    }
};
var isValidStep = function (value) {
    return value === undefined || (value.search(/[^\d]/) === -1 && safeParseInt(value) > 0);
};
var validateForRange = function (value, start, stop) {
    if (value.search(/[^\d-,\/*]/) !== -1) {
        return false;
    }
    var list = value.split(',');
    return list.every(function (condition) {
        var splits = condition.split('/');
        // Prevents `*/ * * * *` from being accepted.
        if (condition.trim().endsWith('/')) {
            return false;
        }
        // Prevents `*/*/* * * * *` from being accepted
        if (splits.length > 2) {
            return false;
        }
        // If we don't have a `/`, right will be undefined which is considered a valid step if we don't a `/`.
        var left = splits[0], right = splits[1];
        return isValidRange(left, start, stop) && isValidStep(right);
    });
};
var hasValidSeconds = function (seconds) {
    return validateForRange(seconds, 0, 59);
};
var hasValidMinutes = function (minutes) {
    return validateForRange(minutes, 0, 59);
};
var hasValidHours = function (hours) {
    return validateForRange(hours, 0, 23);
};
var hasValidDays = function (days, allowBlankDay) {
    return (allowBlankDay && isQuestionMark(days)) || validateForRange(days, 1, 31);
};
var monthAlias = {
    jan: '1',
    feb: '2',
    mar: '3',
    apr: '4',
    may: '5',
    jun: '6',
    jul: '7',
    aug: '8',
    sep: '9',
    oct: '10',
    nov: '11',
    dec: '12'
};
var hasValidMonths = function (months, alias) {
    // Prevents alias to be used as steps
    if (months.search(/\/[a-zA-Z]/) !== -1) {
        return false;
    }
    if (alias) {
        var remappedMonths = months.toLowerCase().replace(/[a-z]{3}/g, function (match) {
            return monthAlias[match] === undefined ? match : monthAlias[match];
        });
        // If any invalid alias was used, it won't pass the other checks as there will be non-numeric values in the months
        return validateForRange(remappedMonths, 1, 12);
    }
    return validateForRange(months, 1, 12);
};
var weekdaysAlias = {
    sun: '0',
    mon: '1',
    tue: '2',
    wed: '3',
    thu: '4',
    fri: '5',
    sat: '6'
};
var hasValidWeekdays = function (weekdays, alias, allowBlankDay, allowSevenAsSunday) {
    // If there is a question mark, checks if the allowBlankDay flag is set
    if (allowBlankDay && isQuestionMark(weekdays)) {
        return true;
    }
    else if (!allowBlankDay && isQuestionMark(weekdays)) {
        return false;
    }
    // Prevents alias to be used as steps
    if (weekdays.search(/\/[a-zA-Z]/) !== -1) {
        return false;
    }
    if (alias) {
        var remappedWeekdays = weekdays.toLowerCase().replace(/[a-z]{3}/g, function (match) {
            return weekdaysAlias[match] === undefined ? match : weekdaysAlias[match];
        });
        // If any invalid alias was used, it won't pass the other checks as there will be non-numeric values in the weekdays
        return validateForRange(remappedWeekdays, 0, allowSevenAsSunday ? 7 : 6);
    }
    return validateForRange(weekdays, 0, allowSevenAsSunday ? 7 : 6);
};
var hasCompatibleDayFormat = function (days, weekdays, allowBlankDay) {
    return !(allowBlankDay && isQuestionMark(days) && isQuestionMark(weekdays));
};
var split = function (cron) {
    return cron.trim().split(/\s+/);
};
var defaultOptions = {
    alias: false,
    seconds: false,
    allowBlankDay: false,
    allowSevenAsSunday: false
};
exports.isValidCron = function (cron, options) {
    options = __assign(__assign({}, defaultOptions), options);
    var splits = split(cron);
    if (splits.length > (options.seconds ? 6 : 5) || splits.length < 5) {
        return false;
    }
    var checks = [];
    if (splits.length === 6) {
        var seconds = splits.shift();
        if (seconds) {
            checks.push(hasValidSeconds(seconds));
        }
    }
    // We could only check the steps gradually and return false on the first invalid block,
    // However, this won't have any performance impact so why bother for now.
    var minutes = splits[0], hours = splits[1], days = splits[2], months = splits[3], weekdays = splits[4];
    checks.push(hasValidMinutes(minutes));
    checks.push(hasValidHours(hours));
    checks.push(hasValidDays(days, options.allowBlankDay));
    checks.push(hasValidMonths(months, options.alias));
    checks.push(hasValidWeekdays(weekdays, options.alias, options.allowBlankDay, options.allowSevenAsSunday));
    checks.push(hasCompatibleDayFormat(days, weekdays, options.allowBlankDay));
    return checks.every(Boolean);
};
//# sourceMappingURL=index.js.map
  };
  root["cronValidator"] = __req("lib/index.js");
})(typeof globalThis !== 'undefined' ? globalThis : this);
