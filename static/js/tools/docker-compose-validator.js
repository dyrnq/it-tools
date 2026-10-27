/* ==========================================================================
   Docker Compose 文件校验（docker-compose-validator）

   贴一份 docker-compose.yml，逐条列出语法错误与语义问题：级别、位置、说明、
   建议修法。语法错误来自 YAML 解析器，语义检查是自己写的规则。

   ---- 与上游 PR #965 的三处取舍 ----

   1. **放弃 Monaco 编辑器，改用普通 textarea**。
      上游用 `c-monaco-editor`，而 Monaco 是静态 import 进入口包的，入口又没有
      manualChunks —— 结果是**全站每一个页面**都要下载 Monaco 的那几 MB 静态
      资源。一个只在 Development 分类里用一次的校验器，让首页、加密工具、进制
      转换全都要为它买单，这是明显的回归。这里一个字节都不多下。

   2. **校验逻辑拆成纯函数**。
      上游把校验塞在 Vue 组件的 computed 里，测不了 —— 上游给这个工具的测试是
      假绿（真断言被注释掉，换成了 expect(true)）。这里拆成
      `validateCompose(parsed, locate)`：输入是**解析后的对象**加一个定位函数，
      输出是**问题列表**。不碰 DOM、不碰 window，同样的输入必然给出同样的输出。

   3. **不引 composeverter**。
      上游靠 `composeverter` 做 schema 校验，它把整个 compose spec 的 JSON schema
      打包进来（一兆多），报出来的也只有一句 message 加一个行号，没有「哪条规则
      不对、该怎么改」。这里自己写规则：规则集小得多，报错能给出**位置**和
      **建议修法**。

   ---- 为什么 `version` 只警告不报错 ----
   Compose Specification 从 2021 年起就不再需要 `version` 键，留着它**不会**让
   compose 起不来（老的 docker-compose 还会拿它选 schema 版本）。所以它是
   「过时」而不是「错误」—— 报成错误会让一堆老文件全线变红，而那只是历史包袱，
   警告刚好。

   ---- 为什么端口越界算错误、未知顶层键只算警告 ----
   端口越界（99999:80）会让 `docker compose up` **直接失败**：端口号超出 16 位
   无符号整数的范围，绑定必然失败，属于「跑不起来」，所以是错误。
   未知顶层键相反 —— compose 会直接忽略它，文件照样能起来，最多只是拼写错误
   （真拼错了 services 那种，会因为少了 services 而在另一条规则里报错），
   所以只给警告。

   ---- 为什么用 yaml 库而不是手写 YAML 解析 ----
   手写 YAML 解析器写不对。而 `yaml@2.x` 已经 vendored 在
   `static/lib/yaml/bundle.js`（全局名 `window.YAML`），`parseDocument` 直接给出
   带行列的语法错误，不必再引依赖。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('docker-compose-validator');

  /* ---------- 常量 ---------- */

  /** Compose Specification 认的顶层键。x-* 前缀的是扩展字段，任意名字都合法。 */
  var TOP_LEVEL_KEYS = ['version', 'services', 'networks', 'volumes', 'configs', 'secrets', 'name', 'include'];

  /** 顶层这几段必须是映射（名字 → 定义），不是列表也不是标量。 */
  var TOP_LEVEL_SECTIONS = ['networks', 'volumes', 'configs', 'secrets'];

  /** restart 的合法取值。on-failure 允许带次数后缀（on-failure:3），这里只比前缀。 */
  var RESTART_VALUES = ['no', 'always', 'on-failure', 'unless-stopped'];

  /** 短语法卷的挂载选项。 */
  var MOUNT_OPTIONS = ['ro', 'rw', 'z', 'Z', 'nocopy', 'consistent', 'cached', 'delegated'];

  /** 长语法卷的 type 合法取值。 */
  var VOLUME_TYPES = ['volume', 'bind', 'tmpfs', 'npipe', 'cluster'];

  /** 端口号的合法区间。 */
  var PORT_MIN = 1;
  var PORT_MAX = 65535;

  /** 样例：一份没问题的 compose 文件。 */
  var VALID_SAMPLE = [
    'services:',
    '  web:',
    '    image: nginx:alpine',
    '    container_name: web',
    '    ports:',
    '      - "8080:80"',
    '    volumes:',
    '      - "./html:/usr/share/nginx/html:ro"',
    '    depends_on:',
    '      - api',
    '    restart: unless-stopped',
    '    networks:',
    '      - frontend',
    '',
    '  api:',
    '    image: node:20-alpine',
    '    working_dir: /app',
    '    command: ["node", "server.js"]',
    '    environment:',
    '      NODE_ENV: production',
    '    depends_on:',
    '      db:',
    '        condition: service_healthy',
    '    volumes:',
    '      - "./app:/app"',
    '    networks:',
    '      - frontend',
    '      - backend',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "curl -f http://localhost/ || exit 1"]',
    '      interval: 30s',
    '',
    '  db:',
    '    image: postgres:16-alpine',
    '    environment:',
    '      POSTGRES_PASSWORD: secret',
    '    volumes:',
    '      - "pgdata:/var/lib/postgresql/data"',
    '    networks:',
    '      - backend',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
    '      interval: 10s',
    '',
    'networks:',
    '  frontend:',
    '  backend:',
    '',
    'volumes:',
    '  pgdata:'
  ].join('\n');

  /** 样例：一份到处是错的 compose 文件，用来展示这个工具在干什么。 */
  var BROKEN_SAMPLE = [
    'version: "3.9"',
    'services:',
    '  web:',
    '    container_name: web',
    '    ports:',
    '      - "8080:80"',
    '      - "99999:81"',
    '    depends_on:',
    '      - api',
    '    restart: sometimes',
    '',
    '  api:',
    '    image: node:20-alpine',
    '    container_name: web',
    '    depends_on:',
    '      - database',
    '    volumes:',
    '      - "data:"',
    '    networks:',
    '      - backend',
    '',
    'volume:',
    '  pgdata:'
  ].join('\n');

  /* ---------- 小工具 ---------- */

  /** 路径 → 查表用的键。JSON.stringify 是这里唯一能无歧义区分
      ['services','web'] 与 ['services','web',0] 的写法。 */
  function pathKey(path) {
    return JSON.stringify(path);
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** 取第一行。yaml 库的报错是多行的，后面还带着源码片段和 ^ 指示符，
      整段甩给用户反而更难读。 */
  function firstLine(text) {
    return String(text === null || text === undefined ? '' : text).split('\n')[0];
  }

  /** 值的类型名（给「类型不对」那条报错用）。 */
  function describeType(value) {
    if (value === null) return t('type_null', 'null');
    if (value === undefined) return t('type_null', 'null');
    if (Array.isArray(value)) return t('type_list', 'a list');
    if (typeof value === 'object') return t('type_mapping', 'a mapping');
    if (typeof value === 'string') return t('type_string', 'a string');
    if (typeof value === 'number') return t('type_number', 'a number');
    if (typeof value === 'boolean') return t('type_boolean', 'a boolean');
    return t('type_other', 'a value of another type');
  }

  /* ---------- 位置定位 ---------- */

  /**
   * 遍历 YAML 的 AST，给每个节点记下它在源码里的偏移量。
   *
   * 之所以要啃 AST 而不是用 toJS 出来的普通对象：只有 AST 的节点上才有 range，
   * toJS 把一切都拍平成普通 JS 值，行号信息全丢了。
   *
   * @param {*} node YAML 节点
   * @param {Array} path 到这个节点的路径
   * @param {Object} out 路径 → {key, value} 偏移量的表
   * @param {Object} lib yaml 库
   */
  function collectLocations(node, path, out, lib) {
    if (!node || typeof node !== 'object') return;
    if (lib.isMap(node)) {
      for (var i = 0; i < node.items.length; i++) {
        var pair = node.items[i];
        // 键要按 toJS 的口径转成字符串：toJS 建的是普通对象，键一律是字符串形态
        var key = pair.key && pair.key.value !== undefined ? String(pair.key.value) : null;
        var childPath = path.concat([key]);
        out[pathKey(childPath)] = {
          key: pair.key && pair.key.range ? pair.key.range[0] : null,
          value: pair.value && pair.value.range ? pair.value.range[0] : null
        };
        collectLocations(pair.value, childPath, out, lib);
      }
    } else if (lib.isSeq(node)) {
      for (var j = 0; j < node.items.length; j++) {
        var item = node.items[j];
        var itemPath = path.concat([j]);
        out[pathKey(itemPath)] = {
          key: null,
          value: item && item.range ? item.range[0] : null
        };
        collectLocations(item, itemPath, out, lib);
      }
    }
  }

  /**
   * 造一个定位函数：给一条路径，返回它在源码里的 {line, col}（都是 1 起）。
   * 定位不到就返回 null —— 调用方要能处理「整篇文件」这种没有位置的问题。
   *
   * @param {Object} lineCounter yaml 的 LineCounter
   * @param {Object} locations 路径 → 偏移量
   * @returns {function(Array): ({line:number, col:number}|null)}
   */
  function makeLocator(lineCounter, locations) {
    return function (path) {
      var entry = locations[pathKey(path)];
      if (!entry) return null;
      // 映射条目优先用**键**的偏移：值节点的偏移落在嵌套映射的第一行
      // （`web:` 的下一行），指到键上才是「这条服务定义在哪儿」。
      var offset = entry.key !== null && entry.key !== undefined ? entry.key : entry.value;
      if (offset === null || offset === undefined) return null;
      var pos = lineCounter.linePos(offset);
      if (!pos) return null;
      return { line: pos.line, col: pos.col };
    };
  }

  /* ---------- 端口 ---------- */

  /**
   * 拆一条 ports 短语法。
   * 支持 "HOST:CONTAINER" / "IP:HOST:CONTAINER" / "CONTAINER" / 纯端口号，
   * 端口可以带范围（"3000-3005"）与协议后缀（"80:80/tcp"）。
   *
   * @param {string} text
   * @returns {{ip:?string, host:?string, container:?string, bad:?string}}
   */
  function parsePortSpec(text) {
    var s = String(text);
    var slash = s.indexOf('/');
    if (slash >= 0) {
      var proto = s.slice(slash + 1).toLowerCase();
      s = s.slice(0, slash);
      if (['tcp', 'udp', 'sctp'].indexOf(proto) < 0) return { bad: 'protocol' };
    }
    var parts;
    if (s.charAt(0) === '[') {
      // IPv6：[::1]:8080:80
      var close = s.indexOf(']');
      if (close < 0) return { bad: 'format' };
      var ip = s.slice(1, close);
      var rest = s.slice(close + 1);
      if (rest.charAt(0) !== ':') return { bad: 'format' };
      parts = [ip].concat(rest.slice(1).split(':'));
    } else {
      parts = s.split(':');
    }
    if (parts.length === 1) return { container: parts[0] };
    if (parts.length === 2) return { host: parts[0], container: parts[1] };
    if (parts.length === 3) return { ip: parts[0], host: parts[1], container: parts[2] };
    return { bad: 'toomany' };
  }

  /**
   * 端口号（或端口范围）合不合法。
   * @param {*} value
   * @returns {'ok'|'out_of_range'|'invalid'}
   */
  function checkPortValue(value) {
    var m = /^(\d+)(?:-(\d+))?$/.exec(String(value));
    if (!m) return 'invalid';
    var lo = Number(m[1]);
    var hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo < PORT_MIN || lo > PORT_MAX || hi < PORT_MIN || hi > PORT_MAX) return 'out_of_range';
    if (hi < lo) return 'invalid';
    return 'ok';
  }

  /**
   * 端口号（或端口范围）的数值区间，合法的才有。
   * @param {*} value
   * @returns {{min:number,max:number}|null}
   */
  function portRange(value) {
    var m = /^(\d+)(?:-(\d+))?$/.exec(String(value));
    if (!m) return null;
    var lo = Number(m[1]);
    var hi = m[2] === undefined ? lo : Number(m[2]);
    return { min: lo, max: hi };
  }

  /* ---------- 卷 ---------- */

  /**
   * 拆一条 volumes 短语法，按冒号切。
   * Windows 盘符（"C:\data:/data"）会多切一刀，这里把它粘回去。
   *
   * @param {string} text
   * @returns {string[]}
   */
  function splitVolumeSpec(text) {
    var parts = String(text).split(':');
    if (parts.length >= 3 && /^[A-Za-z]$/.test(parts[0]) && /^[\\/]/.test(parts[1] || '')) {
      parts.splice(0, 2, parts[0] + ':' + parts[1]);
    }
    return parts;
  }

  /**
   * 短语法里的 source 是不是「命名卷」（要在顶层 volumes 里声明的那种）。
   * 绝对路径、相对路径、变量展开、Windows 盘符都是绑定挂载，不是命名卷。
   *
   * @param {string} source
   * @returns {boolean}
   */
  function isNamedVolume(source) {
    if (!source) return false;
    if (/^[./~$]/.test(source)) return false;
    if (/^[A-Za-z]:[\\/]/.test(source)) return false;
    return true;
  }

  /* ---------- 校验（纯函数） ---------- */

  /**
   * 校验一份解析好的 compose 文件。
   *
   * 这是本工具的核心：**纯函数** —— 不碰 DOM、不碰 window、不读全局状态，
   * 输入相同则输出必然相同，因此可以单测。
   *
   * @param {*} parsed 解析后的 compose 对象（toJS 的结果）
   * @param {function(Array): ({line:number,col:number}|null)} [locate] 路径 → 位置
   * @returns {Array} 问题列表，每条 {level, line, col, message, suggestion}
   */
  function validateCompose(parsed, locate) {
    var issues = [];
    var locateAt = typeof locate === 'function' ? locate : function () { return null; };

    function push(level, path, message, suggestion) {
      var pos = path ? locateAt(path) : null;
      issues.push({
        level: level,
        line: pos ? pos.line : null,
        col: pos ? pos.col : null,
        message: message,
        suggestion: suggestion || null
      });
    }

    function error(path, message, suggestion) { push('error', path, message, suggestion); }
    function warn(path, message, suggestion) { push('warning', path, message, suggestion); }

    /** 「类型不对」这类错误都走这里：结构一样，只有期望类型与实际类型不同。 */
    function typeError(path, key, expected, actual, suggestion) {
      error(path,
        t('err_type', '{key} must be {expected}, but it is {actual}.')
          .replace('{key}', function () { return key; })
          .replace('{expected}', function () { return expected; })
          .replace('{actual}', function () { return actual; }),
        suggestion || t('fix_type', 'Check the Compose Specification for the expected shape of "{key}".')
          .replace('{key}', function () { return key; }));
    }

    /** 服务内部某个键的类型不对。 */
    function svcTypeError(path, serviceName, key, expected, actual, suggestion) {
      error(path,
        t('err_type_in_service', 'The "{key}" of the service "{name}" must be {expected}, but it is {actual}.')
          .replace('{key}', function () { return key; })
          .replace('{name}', function () { return serviceName; })
          .replace('{expected}', function () { return expected; })
          .replace('{actual}', function () { return actual; }),
        suggestion || t('fix_type', 'Check the Compose Specification for the expected shape of "{key}".')
          .replace('{key}', function () { return key; }));
    }

    /* ---- 根节点 ---- */

    if (parsed === null || parsed === undefined) {
      error(null,
        t('err_root_empty', 'The document is empty — there is nothing to validate.'),
        t('fix_add_services', 'Add a "services" section with at least one service.'));
      return issues;
    }
    if (!isPlainObject(parsed)) {
      error(null,
        t('err_root_not_mapping', 'The root node must be a mapping, but it is {actual}.')
          .replace('{actual}', function () { return describeType(parsed); }),
        t('fix_root_not_mapping', 'The root of a Compose file must be a mapping of top-level keys.'));
      return issues;
    }

    /* ---- 顶层 ---- */

    if (has(parsed, 'version')) {
      warn(['version'],
        t('warn_version', 'The "version" key is obsolete in the Compose Specification.'),
        t('fix_version', 'Remove the "version" key — the Compose Specification does not use it.'));
    }

    Object.keys(parsed).forEach(function (key) {
      if (TOP_LEVEL_KEYS.indexOf(key) >= 0) return;
      if (key.indexOf('x-') === 0) return;   // 扩展字段，Compose 允许任意 x- 前缀
      warn([key],
        t('warn_unknown_top_key', '"{key}" is not a known top-level Compose key.')
          .replace('{key}', function () { return key; }),
        t('fix_unknown_top_key', 'Legal top-level keys are: {list}.')
          .replace('{list}', function () { return TOP_LEVEL_KEYS.join(', '); }));
    });

    TOP_LEVEL_SECTIONS.forEach(function (key) {
      if (!has(parsed, key)) return;
      if (!isPlainObject(parsed[key])) {
        typeError([key], key, t('type_mapping', 'a mapping'), describeType(parsed[key]),
          t('fix_top_mapping', 'Write "{key}" as a mapping of names to definitions.')
            .replace('{key}', function () { return key; }));
      }
    });

    if (!has(parsed, 'services')) {
      error(null,
        t('err_services_missing', 'The "services" key is missing.'),
        t('fix_add_services', 'Add a "services" section with at least one service.'));
      return issues;   // 没有 services，后面的逐服务检查全都没有意义
    }

    var services = parsed.services;
    if (!isPlainObject(services)) {
      typeError(['services'], 'services', t('type_mapping', 'a mapping'), describeType(services),
        t('fix_services_mapping', 'Write "services" as a mapping of service names to definitions.'));
      return issues;
    }

    var serviceNames = Object.keys(services);
    if (!serviceNames.length) {
      error(['services'],
        t('err_services_empty', 'The "services" mapping is empty — at least one service is required.'),
        t('fix_services_empty', 'Declare at least one service under "services".'));
      return issues;
    }

    /* ---- 跨服务的检查要用的账本 ---- */

    /** container_name → 服务名。用 null 原型：键是用户写的，
        不能让 "__proto__" 这种键碰到普通对象的原型。 */
    var containerNames = Object.create(null);
    /** 已经占用的宿主端口：[{min, max, service}]。 */
    var hostPorts = [];

    /** 顶层某个命名卷有没有声明。 */
    function volumeDeclared(name) {
      return isPlainObject(parsed.volumes) && has(parsed.volumes, name);
    }

    /** 顶层某个网络有没有声明。 */
    function networkDeclared(name) {
      return isPlainObject(parsed.networks) && has(parsed.networks, name);
    }

    /**
     * 记下宿主端口占用；跟已有的占用撞上了就是一条错误。
     * Docker 自己也会拒绝这种重复绑定，所以这是错误而不是警告。
     */
    function claimHostPort(path, portText, serviceName) {
      var range = portRange(portText);
      if (!range) return;
      for (var i = 0; i < hostPorts.length; i++) {
        var other = hostPorts[i];
        if (range.min <= other.max && other.min <= range.max) {
          error(path,
            t('err_port_conflict', 'The host port {port} is already used by the service "{other}".')
              .replace('{port}', function () { return String(portText); })
              .replace('{other}', function () { return other.service; }),
            t('fix_port_conflict', 'Use a different host port, or publish it on a different IP address.'));
          return;
        }
      }
      hostPorts.push({ min: range.min, max: range.max, service: serviceName });
    }

    /* ---- 逐个服务 ---- */

    serviceNames.forEach(function (name) {
      var svc = services[name];
      var base = ['services', name];

      if (!isPlainObject(svc)) {
        error(base,
          t('err_service_not_mapping', 'The service "{name}" must be a mapping, but it is {actual}.')
            .replace('{name}', function () { return name; })
            .replace('{actual}', function () { return describeType(svc); }),
          t('fix_service_not_mapping', 'Write the service as a mapping of Compose keys.'));
        return;
      }

      /* ---- image / build ---- */

      var hasImage = has(svc, 'image');
      var hasBuild = has(svc, 'build');
      var imageOk = hasImage && typeof svc.image === 'string' && svc.image.trim() !== '';

      if (!hasImage && !hasBuild) {
        error(base,
          t('err_no_image_build', 'The service "{name}" defines neither "image" nor "build".')
            .replace('{name}', function () { return name; }),
          t('fix_no_image_build', 'Add an "image" key, or a "build" section describing how to build the image.'));
      } else if (hasImage && !imageOk) {
        svcTypeError(base.concat(['image']), name, 'image',
          t('type_non_empty_string', 'a non-empty string'), describeType(svc.image),
          t('fix_image', 'Write the image reference as a string, for example "nginx:alpine".'));
      }

      if (hasBuild) {
        var build = svc.build;
        if (typeof build === 'string') {
          // 短写法：build 目录的路径
        } else if (isPlainObject(build)) {
          if (!has(build, 'context') && !has(build, 'dockerfile')) {
            warn(base.concat(['build']),
              t('warn_build_no_context', 'The "build" of the service "{name}" has neither "context" nor "dockerfile".')
                .replace('{name}', function () { return name; }),
              t('fix_build_no_context', 'Add a "context" key with the path to the build context.'));
          }
        } else {
          svcTypeError(base.concat(['build']), name, 'build',
            t('type_string_or_mapping', 'a string or a mapping'), describeType(build),
            t('fix_build', 'Write "build" as a context path or as a mapping with "context" and "dockerfile".'));
        }
      }

      /* ---- container_name ---- */

      if (has(svc, 'container_name')) {
        var cn = svc.container_name;
        if (typeof cn !== 'string' || cn.trim() === '') {
          svcTypeError(base.concat(['container_name']), name, 'container_name',
            t('type_string', 'a string'), describeType(cn),
            t('fix_container_name', 'Write the container name as a string.'));
        } else if (has(containerNames, cn)) {
          error(base.concat(['container_name']),
            t('err_dup_container_name', 'The container name "{name}" is already used by the service "{other}".')
              .replace('{name}', function () { return cn; })
              .replace('{other}', function () { return containerNames[cn]; }),
            t('fix_dup_container_name', 'Give each service a different "container_name", or remove it.'));
        } else {
          containerNames[cn] = name;
        }
      }

      /* ---- ports ---- */

      if (has(svc, 'ports')) {
        var ports = svc.ports;
        if (Array.isArray(ports)) {
          ports.forEach(function (entry, i) {
            checkPortEntry(base.concat(['ports', i]), name, entry);
          });
        } else if (typeof ports === 'string' || typeof ports === 'number') {
          checkPortEntry(base.concat(['ports']), name, ports);
        } else {
          svcTypeError(base.concat(['ports']), name, 'ports',
            t('type_ports', 'a string, a number or a list'), describeType(ports),
            t('fix_ports', 'Write "ports" as a string, a number or a list of them.'));
        }
      }

      /* ---- volumes ---- */

      if (has(svc, 'volumes')) {
        var vols = svc.volumes;
        if (Array.isArray(vols)) {
          vols.forEach(function (entry, i) {
            checkVolumeEntry(base.concat(['volumes', i]), name, entry);
          });
        } else if (typeof vols === 'string') {
          checkVolumeEntry(base.concat(['volumes']), name, vols);
        } else {
          svcTypeError(base.concat(['volumes']), name, 'volumes',
            t('type_string_or_list', 'a string or a list'), describeType(vols),
            t('fix_volumes', 'Write "volumes" as a list of volume specifications.'));
        }
      }

      /* ---- depends_on（交叉引用，本工具的核心价值） ---- */

      if (has(svc, 'depends_on')) {
        var dep = svc.depends_on;
        if (Array.isArray(dep)) {
          dep.forEach(function (entry, i) {
            if (typeof entry !== 'string' || entry === '') {
              svcTypeError(base.concat(['depends_on', i]), name, 'depends_on',
                t('type_service_name', 'a service name'), describeType(entry),
                t('fix_depends_on_item', 'Write the entry as the name of another service.'));
              return;
            }
            checkDependency(base.concat(['depends_on', i]), name, entry);
          });
        } else if (isPlainObject(dep)) {
          Object.keys(dep).forEach(function (entry) {
            checkDependency(base.concat(['depends_on', entry]), name, entry);
          });
        } else {
          svcTypeError(base.concat(['depends_on']), name, 'depends_on',
            t('type_list_or_mapping', 'a list or a mapping'), describeType(dep),
            t('fix_depends_on_type', 'Write "depends_on" as a list of service names, or as a mapping.'));
        }
      }

      /* ---- env_file ---- */

      if (has(svc, 'env_file')) {
        var envFile = svc.env_file;
        var envList = Array.isArray(envFile) ? envFile : [envFile];
        if (!Array.isArray(envFile) && typeof envFile !== 'string') {
          svcTypeError(base.concat(['env_file']), name, 'env_file',
            t('type_env_file', 'a string or a list of strings'), describeType(envFile),
            t('fix_env_file', 'Write "env_file" as a path or a list of paths.'));
        } else {
          envList.forEach(function (entry, i) {
            if (typeof entry !== 'string') {
              svcTypeError(base.concat(['env_file', i]), name, 'env_file',
                t('type_env_file', 'a string or a list of strings'), describeType(entry),
                t('fix_env_file', 'Write "env_file" as a path or a list of paths.'));
            }
          });
        }
      }

      /* ---- restart ---- */

      if (has(svc, 'restart')) {
        var restart = svc.restart;
        if (restart === false) {
          // YAML 1.1 的解析器会把 `no` 当成布尔 false，等价于 "no"，放过
        } else if (typeof restart !== 'string') {
          svcTypeError(base.concat(['restart']), name, 'restart',
            t('type_string', 'a string'), describeType(restart),
            t('fix_restart', 'Write the restart policy as a string.'));
        } else if (RESTART_VALUES.indexOf(restart.split(':')[0]) < 0) {
          error(base.concat(['restart']),
            t('err_restart_value', 'The restart policy "{value}" of the service "{name}" is not valid.')
              .replace('{value}', function () { return restart; })
              .replace('{name}', function () { return name; }),
            t('fix_restart_value', 'Use one of: no, always, on-failure, unless-stopped.'));
        }
      }

      /* ---- deploy.replicas ---- */

      if (has(svc, 'deploy')) {
        var deploy = svc.deploy;
        if (!isPlainObject(deploy)) {
          svcTypeError(base.concat(['deploy']), name, 'deploy',
            t('type_mapping', 'a mapping'), describeType(deploy),
            t('fix_deploy', 'Write "deploy" as a mapping.'));
        } else if (has(deploy, 'replicas')) {
          var replicas = deploy.replicas;
          if (typeof replicas !== 'number' || !isFinite(replicas) || Math.floor(replicas) !== replicas) {
            svcTypeError(base.concat(['deploy', 'replicas']), name, 'deploy.replicas',
              t('type_integer', 'an integer'), describeType(replicas),
              t('fix_replicas', 'Write the replica count as an integer greater than or equal to 0.'));
          } else if (replicas < 0) {
            error(base.concat(['deploy', 'replicas']),
              t('err_replicas_negative', 'The "deploy.replicas" of the service "{name}" must not be negative.')
                .replace('{name}', function () { return name; }),
              t('fix_replicas', 'Write the replica count as an integer greater than or equal to 0.'));
          }
        }
      }

      /* ---- healthcheck.test ---- */

      if (has(svc, 'healthcheck')) {
        var health = svc.healthcheck;
        if (!isPlainObject(health)) {
          svcTypeError(base.concat(['healthcheck']), name, 'healthcheck',
            t('type_mapping', 'a mapping'), describeType(health),
            t('fix_healthcheck', 'Write "healthcheck" as a mapping.'));
        } else if (has(health, 'test')) {
          var test = health.test;
          if (typeof test !== 'string' && !Array.isArray(test)) {
            svcTypeError(base.concat(['healthcheck', 'test']), name, 'healthcheck.test',
              t('type_string_or_list', 'a string or a list'), describeType(test),
              t('fix_healthcheck_test', 'Write the health check command as a string or a list.'));
          }
        }
      }

      /* ---- networks（引用的网络没在顶层声明） ---- */

      if (has(svc, 'networks')) {
        var nets = svc.networks;
        // 每项记下自己的路径：列表写法用下标，映射写法用网络名 —— 定位要指到那一行
        var netRefs = [];
        if (Array.isArray(nets)) {
          nets.forEach(function (net, i) { netRefs.push({ net: net, path: base.concat(['networks', i]) }); });
        } else if (isPlainObject(nets)) {
          Object.keys(nets).forEach(function (net) { netRefs.push({ net: net, path: base.concat(['networks', net]) }); });
        } else {
          svcTypeError(base.concat(['networks']), name, 'networks',
            t('type_list_or_mapping', 'a list or a mapping'), describeType(nets),
            t('fix_networks', 'Write "networks" as a list of network names, or as a mapping.'));
        }
        netRefs.forEach(function (ref) {
          if (typeof ref.net !== 'string' || ref.net === '') return;
          if (!networkDeclared(ref.net)) {
            warn(ref.path,
              t('warn_undeclared_network', 'The network "{name}" used by the service "{service}" is not declared in the top-level "networks".')
                .replace('{name}', function () { return ref.net; })
                .replace('{service}', function () { return name; }),
              t('fix_undeclared_network', 'Declare the network in the top-level "networks" section.'));
          }
        });
      }
    });

    /* ---- 单条 ports ---- */

    function checkPortEntry(path, serviceName, entry) {
      if (typeof entry === 'number') {
        // 纯数字：只有容器端口（随机映射到宿主端口）
        if (checkPortValue(entry) !== 'ok') {
          error(path,
            t('err_port_range', 'The port "{value}" of the service "{name}" is out of range (1-65535).')
              .replace('{value}', function () { return String(entry); })
              .replace('{name}', function () { return serviceName; }),
            t('fix_port_range', 'Use a port between 1 and 65535.'));
        }
        return;
      }
      if (typeof entry !== 'string') {
        svcTypeError(path, serviceName, 'ports',
          t('type_string_or_number', 'a string or a number'), describeType(entry),
          t('fix_ports', 'Write "ports" as a string, a number or a list of them.'));
        return;
      }
      if (entry.trim() === '') {
        error(path,
          t('err_port_format', 'The port "{value}" of the service "{name}" is not a valid port specification.')
            .replace('{value}', function () { return entry; })
            .replace('{name}', function () { return serviceName; }),
          t('fix_port_format', 'Use "HOST:CONTAINER", "IP:HOST:CONTAINER", "CONTAINER" or a port number.'));
        return;
      }

      var spec = parsePortSpec(entry);
      if (spec.bad === 'protocol') {
        error(path,
          t('err_port_protocol', 'The port "{value}" of the service "{name}" uses an unsupported protocol.')
            .replace('{value}', function () { return entry; })
            .replace('{name}', function () { return serviceName; }),
          t('fix_port_protocol', 'Use one of the supported protocols: tcp, udp, sctp.'));
        return;
      }
      if (spec.bad === 'format') {
        error(path,
          t('err_port_format', 'The port "{value}" of the service "{name}" is not a valid port specification.')
            .replace('{value}', function () { return entry; })
            .replace('{name}', function () { return serviceName; }),
          t('fix_port_format', 'Use "HOST:CONTAINER", "IP:HOST:CONTAINER", "CONTAINER" or a port number.'));
        return;
      }
      if (spec.bad === 'toomany') {
        error(path,
          t('err_port_too_many', 'The port "{value}" of the service "{name}" has too many parts.')
            .replace('{value}', function () { return entry; })
            .replace('{name}', function () { return serviceName; }),
          t('fix_port_too_many', 'Use "HOST:CONTAINER" or "IP:HOST:CONTAINER".'));
        return;
      }

      if (spec.container !== undefined && spec.container !== '') {
        var cState = checkPortValue(spec.container);
        if (cState === 'out_of_range') {
          error(path,
            t('err_port_range', 'The port "{value}" of the service "{name}" is out of range (1-65535).')
              .replace('{value}', function () { return spec.container; })
              .replace('{name}', function () { return serviceName; }),
            t('fix_port_range', 'Use a port between 1 and 65535.'));
        } else if (cState === 'invalid') {
          error(path,
            t('err_port_format', 'The port "{value}" of the service "{name}" is not a valid port specification.')
              .replace('{value}', function () { return spec.container; })
              .replace('{name}', function () { return serviceName; }),
            t('fix_port_format', 'Use "HOST:CONTAINER", "IP:HOST:CONTAINER", "CONTAINER" or a port number.'));
        }
      }

      if (spec.host !== undefined && spec.host !== '') {
        var hState = checkPortValue(spec.host);
        if (hState === 'out_of_range') {
          error(path,
            t('err_port_range', 'The port "{value}" of the service "{name}" is out of range (1-65535).')
              .replace('{value}', function () { return spec.host; })
              .replace('{name}', function () { return serviceName; }),
            t('fix_port_range', 'Use a port between 1 and 65535.'));
          return;
        }
        if (hState === 'invalid') {
          error(path,
            t('err_port_format', 'The port "{value}" of the service "{name}" is not a valid port specification.')
              .replace('{value}', function () { return spec.host; })
              .replace('{name}', function () { return serviceName; }),
            t('fix_port_format', 'Use "HOST:CONTAINER", "IP:HOST:CONTAINER", "CONTAINER" or a port number.'));
          return;
        }
        claimHostPort(path, spec.host, serviceName);
        // 宿主端口与容器端口相同：端口映射没有意义，写的人多半是漏了其中一个
        if (spec.container !== undefined && spec.container !== '' &&
            spec.container === spec.host && portRange(spec.host) && portRange(spec.host).min === portRange(spec.host).max) {
          warn(path,
            t('warn_same_port', 'The host port and the container port are both {port} — binding the same port has no effect.')
              .replace('{port}', function () { return spec.host; }),
            t('fix_same_port', 'Use a host port different from the container port.'));
        }
      }
    }

    /* ---- 单条 volumes ---- */

    function checkVolumeEntry(path, serviceName, entry) {
      if (isPlainObject(entry)) {
        /* 长语法 */
        if (!has(entry, 'target') || entry.target === '' || entry.target === null) {
          error(path,
            t('err_volume_long_target', 'The long syntax volume of the service "{name}" has no "target".')
              .replace('{name}', function () { return serviceName; }),
            t('fix_volume_long_target', 'Add a "target" key with the path inside the container.'));
        }
        if (has(entry, 'type') && VOLUME_TYPES.indexOf(entry.type) < 0) {
          warn(path,
            t('warn_unknown_volume_type', 'The volume type "{value}" is not one of the known types.')
              .replace('{value}', function () { return String(entry.type); }),
            t('fix_unknown_volume_type', 'Known types are: volume, bind, tmpfs, npipe, cluster.'));
        }
        if (entry.type === 'volume' && typeof entry.source === 'string' && entry.source && !volumeDeclared(entry.source)) {
          warn(path,
            t('warn_undeclared_volume', 'The volume "{name}" used by the service "{service}" is not declared in the top-level "volumes".')
              .replace('{name}', function () { return entry.source; })
              .replace('{service}', function () { return serviceName; }),
            t('fix_undeclared_volume', 'Declare the volume in the top-level "volumes" section.'));
        }
        return;
      }

      if (typeof entry !== 'string') {
        svcTypeError(path, serviceName, 'volumes',
          t('type_string_or_mapping', 'a string or a mapping'), describeType(entry),
          t('fix_volumes', 'Write "volumes" as a list of volume specifications.'));
        return;
      }

      var parts = splitVolumeSpec(entry);
      if (parts.length === 1) {
        // 匿名卷：只有一个容器内路径
        if (parts[0] === '') {
          error(path,
            t('err_volume_no_target', 'The volume "{value}" of the service "{name}" has no path after ":".')
              .replace('{value}', function () { return entry; })
              .replace('{name}', function () { return serviceName; }),
            t('fix_volume_no_target', 'Add the path inside the container after ":".'));
        }
        return;
      }
      if (parts.length > 3) {
        error(path,
          t('err_volume_format', 'The volume "{value}" of the service "{name}" is not a valid short syntax.')
            .replace('{value}', function () { return entry; })
            .replace('{name}', function () { return serviceName; }),
          t('fix_volume_format', 'Use "source:target[:mode]" or the long syntax mapping.'));
        return;
      }

      var source = parts[0];
      var target = parts[1];
      var mode = parts[2];

      if (target === '') {
        error(path,
          t('err_volume_no_target', 'The volume "{value}" of the service "{name}" has no path after ":".')
            .replace('{value}', function () { return entry; })
            .replace('{name}', function () { return serviceName; }),
          t('fix_volume_no_target', 'Add the path inside the container after ":".'));
        return;
      }

      if (mode !== undefined) {
        mode.split(',').forEach(function (opt) {
          if (opt === '' || MOUNT_OPTIONS.indexOf(opt) >= 0) return;
          warn(path,
            t('warn_unknown_mount_option', 'The mount option "{value}" is not a known option.')
              .replace('{value}', function () { return opt; }),
            t('fix_unknown_mount_option', 'Known options are: ro, rw, z, Z, nocopy, consistent, cached, delegated.'));
        });
      }

      if (isNamedVolume(source) && !volumeDeclared(source)) {
        warn(path,
          t('warn_undeclared_volume', 'The volume "{name}" used by the service "{service}" is not declared in the top-level "volumes".')
            .replace('{name}', function () { return source; })
            .replace('{service}', function () { return serviceName; }),
          t('fix_undeclared_volume', 'Declare the volume in the top-level "volumes" section.'));
      }
    }

    /* ---- depends_on 的交叉引用 ---- */

    function checkDependency(path, serviceName, dep) {
      if (has(services, dep)) return;
      error(path,
        t('err_depends_on_unknown', 'The service "{name}" depends on "{dep}", which is not defined.')
          .replace('{name}', function () { return serviceName; })
          .replace('{dep}', function () { return dep; }),
        t('fix_depends_on_unknown', 'Add a service named "{dep}", or fix the spelling.')
          .replace('{dep}', function () { return dep; }));
    }

    return issues;
  }

  /* ---------- 解析 + 校验的入口 ---------- */

  /**
   * 按位置排一遍：定位得到的问题按源码顺序读起来最省事，
   * 定位不到的（整篇文件级别的）排在最前面。
   *
   * @param {Array} issues
   * @returns {Array} 新数组，原数组不动
   */
  function sortIssues(issues) {
    return issues.slice().sort(function (a, b) {
      var la = (a.line === null || a.line === undefined) ? -1 : a.line;
      var lb = (b.line === null || b.line === undefined) ? -1 : b.line;
      if (la !== lb) return la - lb;
      var ca = (a.col === null || a.col === undefined) ? -1 : a.col;
      var cb = (b.col === null || b.col === undefined) ? -1 : b.col;
      return ca - cb;
    });
  }

  /**
   * 解析一份 compose 文件并校验它。
   * 语法错误与语义问题分开返回：语法坏了的时候解析出来的对象是残缺的，
   * 这时候再报「语义错误」全是噪音，反而把真正的语法错误淹了。
   *
   * @param {string} src
   * @returns {{syntax:Array, semantic:Array, parsed:*, empty:boolean}}
   */
  function analyze(src) {
    var text = src === null || src === undefined ? '' : String(src);
    var result = { syntax: [], semantic: [], parsed: null, empty: false };

    if (!text.trim()) {
      result.empty = true;
      result.semantic.push({
        level: 'error', line: null, col: null,
        message: t('err_empty_input', 'The input is empty — paste a Docker Compose file to validate.'),
        suggestion: t('fix_empty_input', 'Paste a Docker Compose file, or load a sample.')
      });
      return result;
    }

    var lib = window.YAML;
    if (!lib) {
      result.semantic.push({
        level: 'error', line: null, col: null,
        message: t('err_no_yaml_lib', 'The YAML library did not load, so the file cannot be parsed.'),
        suggestion: t('fix_no_yaml_lib', 'Reload the page — the YAML library failed to load.')
      });
      return result;
    }

    var lineCounter = new lib.LineCounter();
    var doc;
    try {
      doc = lib.parseDocument(text, { lineCounter: lineCounter });
    } catch (e) {
      result.syntax.push({
        level: 'error', line: null, col: null,
        message: t('err_yaml_parse_failed', 'The YAML could not be parsed: {message}')
          .replace('{message}', function () { return firstLine(e && e.message ? e.message : e); }),
        suggestion: t('fix_yaml_syntax', 'Fix the YAML syntax, then validate again.')
      });
      return result;
    }

    (doc.errors || []).forEach(function (err) {
      var pos = (err.linePos && err.linePos.length) ? err.linePos[0] : null;
      result.syntax.push({
        level: 'error',
        line: pos ? pos.line : null,
        col: pos ? pos.col : null,
        message: t('err_yaml_syntax', 'YAML syntax error: {message}')
          .replace('{message}', function () { return firstLine(err && err.message ? err.message : err); }),
        suggestion: t('fix_yaml_syntax', 'Fix the YAML syntax, then validate again.')
      });
    });
    if (result.syntax.length) return result;

    var parsed;
    try {
      parsed = doc.toJS();
    } catch (e) {
      result.syntax.push({
        level: 'error', line: null, col: null,
        message: t('err_yaml_parse_failed', 'The YAML could not be parsed: {message}')
          .replace('{message}', function () { return firstLine(e && e.message ? e.message : e); }),
        suggestion: t('fix_yaml_syntax', 'Fix the YAML syntax, then validate again.')
      });
      return result;
    }
    result.parsed = parsed;

    var locations = {};
    collectLocations(doc.contents, [], locations, lib);
    result.semantic = sortIssues(validateCompose(parsed, makeLocator(lineCounter, locations)));
    return result;
  }

  /* ---------- UI ---------- */

  window.ItTools.register('docker-compose-validator', function (root) {
    var input = D.h('textarea.layui-textarea', {
      rows: 16,
      spellcheck: 'false',
      placeholder: t('input_ph', 'Paste your docker-compose.yml here...'),
      style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      'aria-label': t('aria_label', 'Your Docker Compose file')
    });
    input.value = VALID_SAMPLE;

    var summary = D.h('p.field-label');
    var body = D.h('div');
    var copyBtn = U.copyButton(function () { return reportText(analyze(input.value)); }, t('copy_report', 'Copy report'));

    function issueTable(title, issues) {
      if (!issues.length) return null;
      var table = D.h('table.kv-table');
      table.appendChild(D.h('thead', null, D.h('tr', null,
        D.h('th', { text: t('col_level', 'Level') }),
        D.h('th', { text: t('col_location', 'Location') }),
        D.h('th', { text: t('col_message', 'Description') }),
        D.h('th', { text: t('col_suggestion', 'Suggested fix') })
      )));
      var tbody = D.h('tbody');
      issues.forEach(function (issue) {
        tbody.appendChild(D.h('tr', null,
          D.h('td', null, D.h('span', {
            class: issue.level === 'error' ? 'form-status is-error' : 'form-status is-warn',
            text: issue.level === 'error' ? t('level_error', 'Error') : t('level_warning', 'Warning')
          })),
          D.h('td.val', { text: formatLocation(issue) }),
          D.h('td', { text: issue.message }),
          D.h('td', { text: issue.suggestion || '' })
        ));
      });
      table.appendChild(tbody);
      return D.h('div', null, D.h('p.field-label', { text: title }), table);
    }

    function formatLocation(issue) {
      if (issue.line === null || issue.line === undefined) return t('location_global', 'whole file');
      return issue.col ? issue.line + ':' + issue.col : String(issue.line);
    }

    function render() {
      var r = analyze(input.value);
      D.clear(body);

      var all = r.syntax.concat(r.semantic);
      var errors = all.filter(function (i) { return i.level === 'error'; }).length;
      var warnings = all.filter(function (i) { return i.level === 'warning'; }).length;

      summary.textContent = all.length
        ? t('summary_problems', 'Errors: {errors}, warnings: {warnings}.')
          .replace('{errors}', function () { return String(errors); })
          .replace('{warnings}', function () { return String(warnings); })
        : t('summary_ok', 'No problem found — the file looks valid.');

      var syntaxBlock = issueTable(t('section_syntax', 'Syntax errors'), r.syntax);
      if (syntaxBlock) body.appendChild(syntaxBlock);

      if (r.syntax.length) {
        body.appendChild(D.h('p.field-hint', { text: t('syntax_skipped', 'Semantic checks were skipped because the file has syntax errors.') }));
      } else {
        var semanticBlock = issueTable(t('section_semantic', 'Semantic checks'), r.semantic);
        if (semanticBlock) body.appendChild(semanticBlock);
      }
    }

    /** 把问题列表摊成纯文本，给「复制报告」用。 */
    function reportText(r) {
      var lines = [];
      ['syntax', 'semantic'].forEach(function (kind) {
        r[kind].forEach(function (issue) {
          var level = issue.level === 'error' ? t('level_error', 'Error') : t('level_warning', 'Warning');
          lines.push('[' + level + '] ' + formatLocation(issue) + ' — ' + issue.message);
          if (issue.suggestion) lines.push('    ' + issue.suggestion);
        });
      });
      return lines.join('\n');
    }

    var off = D.on(input, 'input', render);

    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Docker Compose file (YAML)'), input, { wide: true }),
      D.h('div.form-actions', null,
        D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button', text: t('sample', 'Valid sample'),
          onclick: function () { input.value = VALID_SAMPLE; render(); }
        }),
        D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button', text: t('sample_broken', 'Sample with problems'),
          onclick: function () { input.value = BROKEN_SAMPLE; render(); }
        }),
        D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button', text: t('clear', 'Clear'),
          onclick: function () { input.value = ''; render(); }
        })
      ),
      D.h('p.field-hint', {
        text: t('hint', 'Checks the Compose Specification: syntax, service definitions, cross references between services, ports, volumes and networks.')
      })
    ));

    root.appendChild(D.h('div.card', null,
      D.h('div', null,
        D.h('span.output-label', { text: t('result', 'Validation result') }),
        D.h('div.form-actions', null, copyBtn)
      ),
      summary,
      body
    ));

    render();

    return {
      destroy: function () {
        off();
        D.clear(root);
      }
    };
  });

  /* ---------- 纯逻辑（单测直接调） ---------- */

  window.ItTools.logic['docker-compose-validator'] = {
    VALID_SAMPLE: VALID_SAMPLE,
    BROKEN_SAMPLE: BROKEN_SAMPLE,
    TOP_LEVEL_KEYS: TOP_LEVEL_KEYS,
    RESTART_VALUES: RESTART_VALUES,
    parsePortSpec: parsePortSpec,
    checkPortValue: checkPortValue,
    splitVolumeSpec: splitVolumeSpec,
    isNamedVolume: isNamedVolume,
    describeType: describeType,
    sortIssues: sortIssues,
    validateCompose: validateCompose,
    analyze: analyze,

    __cases: function (assert) {
      function countErrors(r) {
        return r.syntax.concat(r.semantic).filter(function (i) { return i.level === 'error'; }).length;
      }
      function countWarnings(r) {
        return r.syntax.concat(r.semantic).filter(function (i) { return i.level === 'warning'; }).length;
      }
      function messagesOf(issues) {
        return issues.map(function (i) { return i.message; }).join(' | ');
      }

      /* ---- 正确的 compose 文件：零错误 ---- */
      var good = analyze(VALID_SAMPLE);
      assert.eq(good.syntax.length, 0, '样例没有语法错误：' + messagesOf(good.syntax));
      assert.eq(countErrors(good), 0, '样例没有语义错误：' + messagesOf(good.semantic));
      assert.eq(countWarnings(good), 0, '样例连警告都没有：' + messagesOf(good.semantic));

      /* ---- services 缺失 ---- */
      var noServices = analyze('name: demo\n');
      assert.eq(countErrors(noServices), 1, '缺 services → 一条错误');
      assert(/services/.test(messagesOf(noServices.semantic)), '说的是 services：' + messagesOf(noServices.semantic));

      /* ---- image 与 build 都缺 ---- */
      var noImage = analyze('services:\n  web:\n    ports:\n      - "8080:80"\n');
      assert.eq(countErrors(noImage), 1, '既没 image 也没 build → 一条错误');
      assert(/image/.test(messagesOf(noImage.semantic)), '说的是 image：' + messagesOf(noImage.semantic));

      /* ---- depends_on 指向不存在的服务（交叉引用，本工具的核心价值） ---- */
      var badDep = analyze('services:\n  web:\n    image: nginx\n    depends_on:\n      - db\n');
      assert.eq(countErrors(badDep), 1, 'depends_on 指向不存在的服务 → 一条错误');
      assert(/db/.test(messagesOf(badDep.semantic)), '报的是那个服务名：' + messagesOf(badDep.semantic));

      /* ---- 端口越界 ---- */
      var badPort = analyze('services:\n  web:\n    image: nginx\n    ports:\n      - "99999:80"\n');
      assert.eq(countErrors(badPort), 1, '端口越界 → 一条错误');
      assert(/99999/.test(messagesOf(badPort.semantic)), '报的是那个端口号：' + messagesOf(badPort.semantic));

      /* ---- container_name 重复 ---- */
      var dupName = analyze(
        'services:\n  a:\n    image: nginx\n    container_name: same\n' +
        '  b:\n    image: redis\n    container_name: same\n');
      assert.eq(countErrors(dupName), 1, 'container_name 重复 → 一条错误');

      /* ---- 非法 YAML：走语法错误分支，不抛异常 ---- */
      var threw = false;
      var broken = null;
      try { broken = analyze('a: [1, 2'); } catch (e) { threw = true; }
      assert(!threw, '非法 YAML 不能抛异常');
      assert(broken && broken.syntax.length > 0, '非法 YAML 走语法错误分支');
      assert(broken.syntax[0].line >= 1, '语法错误带行号，实际：' + JSON.stringify(broken.syntax[0]));

      /* ---- 空输入：明确报错，不抛异常 ---- */
      threw = false;
      var empty = null;
      try { empty = analyze(''); } catch (e) { threw = true; }
      assert(!threw, '空输入不能抛异常');
      assert(empty && empty.semantic.length === 1, '空输入给一条明确错误');
      assert.eq(empty.semantic[0].level, 'error', '空输入是错误');
      assert.eq(empty.empty, true, '空输入被标记出来');

      /* ---- version 只警告不报错 ---- */
      var withVersion = analyze('version: "3.9"\nservices:\n  web:\n    image: nginx\n');
      assert.eq(countErrors(withVersion), 0, 'version 不是错误');
      assert.eq(countWarnings(withVersion), 1, 'version 是一条警告');

      /* ---- 未知顶层键只警告 ---- */
      var unknownKey = analyze('servcies:\n  web:\n    image: nginx\n');
      assert(countWarnings(unknownKey) >= 1, '未知顶层键给警告');
      assert(/servcies/.test(messagesOf(unknownKey.semantic)), '报的是那个键名：' + messagesOf(unknownKey.semantic));

      /* ---- 根节点不是映射 ---- */
      var arrayRoot = analyze('- a\n- b\n');
      assert.eq(countErrors(arrayRoot), 1, '根节点是数组 → 一条错误');
      var scalarRoot = analyze('hello\n');
      assert.eq(countErrors(scalarRoot), 1, '根节点是标量 → 一条错误');

      /* ---- 宿主端口冲突 ---- */
      var conflict = analyze(
        'services:\n  a:\n    image: nginx\n    ports:\n      - "8080:80"\n' +
        '  b:\n    image: redis\n    ports:\n      - "8080:81"\n');
      assert.eq(countErrors(conflict), 1, '两个 service 抢同一个宿主端口 → 一条错误');

      /* ---- 宿主端口与容器端口相同 → 警告 ---- */
      var samePort = analyze('services:\n  web:\n    image: nginx\n    ports:\n      - "80:80"\n');
      assert.eq(countErrors(samePort), 0, '端口相同不是错误');
      assert.eq(countWarnings(samePort), 1, '端口相同是一条警告');

      /* ---- restart 取值 ---- */
      var badRestart = analyze('services:\n  web:\n    image: nginx\n    restart: sometimes\n');
      assert.eq(countErrors(badRestart), 1, '非法 restart → 一条错误');
      var goodRestart = analyze('services:\n  web:\n    image: nginx\n    restart: unless-stopped\n');
      assert.eq(countErrors(goodRestart), 0, '合法 restart 没有错误');

      /* ---- deploy.replicas ---- */
      var negReplicas = analyze('services:\n  web:\n    image: nginx\n    deploy:\n      replicas: -1\n');
      assert.eq(countErrors(negReplicas), 1, '负数 replicas → 一条错误');
      var badReplicas = analyze('services:\n  web:\n    image: nginx\n    deploy:\n      replicas: many\n');
      assert.eq(countErrors(badReplicas), 1, '非整数 replicas → 一条错误');

      /* ---- 短语法卷冒号后必须有路径 ---- */
      var badVolume = analyze('services:\n  web:\n    image: nginx\n    volumes:\n      - "data:"\n');
      assert.eq(countErrors(badVolume), 1, '卷短语法缺目标路径 → 一条错误');

      /* ---- 顶层没声明的网络 / 卷 → 警告 ---- */
      var undeclared = analyze(
        'services:\n  web:\n    image: nginx\n    networks:\n      - backend\n    volumes:\n      - "data:/data"\n');
      assert.eq(countErrors(undeclared), 0, '没声明的网络与卷不是错误');
      assert(countWarnings(undeclared) >= 2, '没声明的网络与卷各给一条警告');

      /* ---- depends_on 的映射写法也算交叉引用 ---- */
      var depMap = analyze(
        'services:\n  web:\n    image: nginx\n    depends_on:\n      db:\n        condition: service_healthy\n');
      assert.eq(countErrors(depMap), 1, 'depends_on 的映射写法同样要查交叉引用');

      /* ---- 纯函数：不依赖 YAML 也能用 ---- */
      var calls = [];
      var located = validateCompose({ services: { web: {} } }, function (path) {
        calls.push(path);
        return { line: 7, col: 3 };
      });
      assert.eq(located.length, 1, '纯函数直接可用');
      assert.eq(located[0].line, 7, '位置来自定位函数');
      assert.eq(located[0].col, 3, '列号也来自定位函数');
      assert(calls.length > 0, '定位函数被调用过');
      var noLocator = validateCompose({ services: {} });
      assert.eq(noLocator.length, 1, '不给定位函数也能用（位置为空）');
      assert.eq(noLocator[0].line, null, '没有定位函数时行号为空');

      /* ---- 问题按位置排序 ---- */
      var sorted = analyze(BROKEN_SAMPLE).semantic;
      var lines = sorted.map(function (i) { return i.line === null ? -1 : i.line; });
      var ordered = true;
      for (var si = 1; si < lines.length; si++) {
        if (lines[si] < lines[si - 1]) { ordered = false; break; }
      }
      assert(ordered, '问题按行号排好序了，实际：' + JSON.stringify(lines));
      assert(countErrors(analyze(BROKEN_SAMPLE)) >= 5, '问题样例里能查出好几条错误');
      assert(countWarnings(analyze(BROKEN_SAMPLE)) >= 2, '问题样例里也能查出警告');

      /* ---- 空端口串 ---- */
      var emptyPort = analyze('services:\n  web:\n    image: nginx\n    ports:\n      - ""\n');
      assert.eq(countErrors(emptyPort), 1, '空端口串 → 一条错误');

      /* ---- networks 的映射写法也要查顶层声明 ---- */
      var netMap = analyze(
        'services:\n  web:\n    image: nginx\n    networks:\n      backend:\n        aliases:\n          - db\n');
      assert.eq(countErrors(netMap), 0, '没声明的网络不是错误');
      assert.eq(countWarnings(netMap), 1, 'networks 的映射写法同样给一条警告');
      assert(netMap.semantic[0].line >= 1, '网络那条警告带行号');

      /* ---- 端口解析的小工具 ---- */
      assert.eq(parsePortSpec('80').container, '80', '只有容器端口');
      assert.eq(parsePortSpec('8080:80').host, '8080', '宿主端口');
      assert.eq(parsePortSpec('8080:80').container, '80', '容器端口');
      assert.eq(parsePortSpec('127.0.0.1:8080:80').ip, '127.0.0.1', '带 IP');
      assert.eq(parsePortSpec('80:80/tcp').container, '80', '带协议后缀');
      assert.eq(parsePortSpec('80:80/xyz').bad, 'protocol', '不支持的协议');
      assert.eq(parsePortSpec('1:2:3:4').bad, 'toomany', '段数太多');
      assert.eq(checkPortValue('80'), 'ok', '合法端口');
      assert.eq(checkPortValue('99999'), 'out_of_range', '端口越界');
      assert.eq(checkPortValue('0'), 'out_of_range', '端口 0 也不合法');
      assert.eq(checkPortValue('abc'), 'invalid', '端口不是数字');

      /* ---- 卷短语法的切分 ---- */
      assert.eq(splitVolumeSpec('/host:/container'), ['/host', '/container'], '两段');
      assert.eq(splitVolumeSpec('/host:/container:ro'), ['/host', '/container', 'ro'], '三段');
      assert.eq(splitVolumeSpec('/data'), ['/data'], '匿名卷');
      assert.eq(splitVolumeSpec('C:\\data:/container'), ['C:\\data', '/container'], 'Windows 盘符不被切开');
      assert.eq(isNamedVolume('data'), true, '命名卷');
      assert.eq(isNamedVolume('./data'), false, '相对路径是绑定挂载');
      assert.eq(isNamedVolume('/data'), false, '绝对路径是绑定挂载');
    }
  };
})();
