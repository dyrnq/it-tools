/* ==========================================================================
   ASCII 艺术字生成（ascii-text-drawer）

   用 FIGlet 把一段文字画成 44 款字体之一的 ASCII 艺术字，可复制、可下载 txt。

   参考实现：src/tools/ascii-text-drawer/（it-tools, GPLv3）
   与原版的差别：
   1. 原版字体从 `//unpkg.com/figlet@1.6.0/fonts/` 现拉。这里改成随包发的 44 个
      .flf（scripts/vendor-js-libs.sh 的 FIGLET_FONTS），从
      /assets/lib/figlet/fonts/<name>.flf 取，离线可用、也不会被 CDN 拖慢。
      名字里有空格（`Delta Corps Priest 1`），URL 要 encodeURIComponent。
   2. 原版列了 200 多个字体，但那个字体表并不存在（它连的是 unpkg 上的全量包，
      名字对不上时 figlet 直接报 "Font not found"）。这里只给随包确实有的 44 个。
   3. 原版输入即渲染，字体还在下载时就先显示一个 spinner，等下载完再跳。
      这里第一次用到某款字体才去 fetch，解析完缓存在 figlet.figFonts 里，
      之后切字体是同步的。
   4. 上游 PR #960 加了「按编程语言输出」：把画好的艺术字包成 Bash / Python /
      C / Java … 的代码。这里也做了，但**转义规则跟上游不一样** ——
      上游用「要转义的字符集合」拼一个正则统一加反斜杠，可是：
        · C# 那边用的是逐字字符串 @"..."，里面反斜杠**不是**转义符，
          上游给的 `Console.WriteLine(@"a\"b")` 直接编译不过（逐字字符串里
          双引号要写成两个）；
        · PowerShell 用单引号字符串，里面反斜杠也是字面量，
          上游把 `\` 变成 `\\` 等于把用户的艺术字改掉了；
        · C 用 `printf("...")`，艺术字里有个 `%` 就会被当成格式符。
      所以这里每种语言自带一条转义函数，按它自己的字符串字面量语法来。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('ascii-text-drawer');

  var FONT_PATH_PREFIX = '/assets/lib/figlet/fonts/';

  /** 随包的 44 个字体，顺序取自 scripts/vendor-js-libs.sh 的 FIGLET_FONTS */
  var FONTS = [
    'Standard', 'Slant', 'Big', 'Banner', 'Bigfig', 'Shadow', 'Speed', 'Small', 'Ghost', 'Blocks',
    'Alphabet', 'Acrobatic', 'Banner3', 'Banner3-D', 'Caligraphy', 'Delta Corps Priest 1', 'Digital',
    'Doom', 'Epic', 'Fraktur', 'Georgia11', 'Graffiti', 'Keyboard', 'Mini', 'Roman', 'Script',
    'Slide', 'Small Shadow', 'Star Wars', 'Star Strips', 'Stop', 'Straight',
    'Stronger Than All', 'Univers', 'Varsity', 'Big Money-nw', 'Bloody', '3D-ASCII', '3x5',
    'Big Chief', 'Cyberlarge', 'Cybermedium', 'Reverse', 'Stampatello'
  ];

  var DEFAULT_FONT = 'Standard';
  var MAX_WIDTH = 10000;

  /** 字体清单的一份拷贝，外部改不到内部状态 */
  function availableFonts() { return FONTS.slice(); }

  /**
   * 字体名 → 实际请求的 URL。名字里有空格和撇号，必须 encodeURIComponent。
   * @param {string} name
   * @returns {string}
   */
  function resolveFontPath(name) {
    if (typeof name !== 'string' || name === '') throw new Error('Font name must be a non-empty string');
    return FONT_PATH_PREFIX + encodeURIComponent(name) + '.flf';
  }

  function isKnownFont(name) { return FONTS.indexOf(name) !== -1; }

  /** 宽度：0 表示不折行；其余夹到 0..10000 的整数。非法输入给默认值 0 */
  function sanitizeWidth(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_WIDTH, Math.floor(n));
  }

  /**
   * 传给 figlet.text 的参数。抽成纯函数是为了能单测 —— 真渲染要等字体文件
   * fetch 回来，测试环境里 fetch 永远不会 resolve。
   * @returns {{font:string, width:number, whitespaceBreak:boolean}}
   */
  function buildPayload(fontName, width) {
    return {
      font: isKnownFont(fontName) ? fontName : DEFAULT_FONT,
      width: sanitizeWidth(width),
      whitespaceBreak: true
    };
  }

  /** 下载用的文件名：ascii-art-<font 净化>.<ext> */
  function downloadFilename(fontName, ext) {
    var safe = String(fontName || DEFAULT_FONT).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'art';
    var suffix = ext ? String(ext).replace(/[^\w-]+/g, '') : 'txt';
    return 'ascii-art-' + safe + '.' + (suffix || 'txt');
  }

  /* ---------- 按编程语言输出（上游 PR #960） ---------- */

  /**
   * 双引号字符串字面量：反斜杠与双引号都要加反斜杠。
   *
   * 顺序要紧：先转义反斜杠，再转义双引号 —— 反过来做的话，
   * 第二步补上的那个反斜杠会被第一步再加一遍（`\"` 变成 `\\"`）。
   */
  function escapeDoubleQuoted(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * 单引号字符串字面量里「双写单引号」的那种：PowerShell / VB / SQL。
   * 这几种语言里反斜杠是字面量，**不能**加反斜杠。
   */
  function escapeSingleDoubled(s) {
    return String(s).replace(/'/g, "''");
  }

  /** 同上，但反过来：双引号双写。VB 的普通字符串与 C# 的逐字字符串都是这个规则。 */
  function escapeDoubleDoubled(s) {
    return String(s).replace(/"/g, '""');
  }

  /**
   * POSIX shell 的单引号字符串：单引号没法在单引号里出现，
   * 只能「关掉引号 → 转义一个单引号 → 再开引号」。
   * 用单引号（而不是双引号）还有个额外好处：`$(...)` 与反引号在单引号里
   * 不会被 shell 当成命令替换 —— 艺术字里带 `$` 也不会被人拿去执行。
   */
  function escapePosixSingle(s) {
    return String(s).replace(/'/g, "'\\''");
  }

  /**
   * PHP / Kotlin 的双引号字符串里 `$` 会开始变量插值（`"$HOME"` 会被换成变量值），
   * 所以要转义成 `\$`。
   *
   * 顺序要紧：先走 escapeDoubleQuoted（那里已经处理过反斜杠），
   * 再补 `\$` —— 反过来做的话，这个补上去的反斜杠会被再翻倍一次。
   */
  function escapeDollar(s) {
    return escapeDoubleQuoted(s).replace(/\$/g, '\\$');
  }

  /**
   * Ruby 的双引号字符串里 `#{` 与 `#$` 都会开始插值，
   * 所以 `#` 要转义成 `\#`（Ruby 里 `\#` 就是字面的 #）。
   */
  function escapeHash(s) {
    return escapeDoubleQuoted(s).replace(/#/g, '\\#');
  }

  /** HTML/XML 文本：& < > ' " 都要换成实体。 */
  function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c];
    });
  }

  /**
   * 可输出的语言。每一项自带一条转义函数 —— 转义规则**不能**统一：
   * 有的语言双引号字符串里反斜杠是转义符，有的是字面量；
   * 有的单引号字符串里单引号要双写，有的要另开一段。
   *
   * 每种语言把艺术字**逐行**包起来（而不是把整幅图塞进一个字符串里）：
   * 图画艺术字本来就有几十行，一个字符串字面量跨几十行在多数语言里
   * 根本不是合法语法（Python 的单行字符串、C 的字符串字面量都不允许裸换行）。
   *
   * `ext` 是下载时的文件后缀。
   */
  var LANGUAGES = [
    {
      id: 'raw',
      label: t('language_raw', 'Raw text'),
      ext: 'txt',
      render: function (art) { return art; }
    },
    {
      id: 'bash',
      label: 'Bash',
      ext: 'sh',
      render: function (art) {
        // printf 而不是 echo：echo 的第一个参数即使是引起来的也会被当成选项
        // （`echo '-n'` 在 bash 里什么都不打印）。
        return art.split('\n').map(function (line) {
          return "printf '%s\\n' '" + escapePosixSingle(line) + "'";
        }).join('\n');
      }
    },
    {
      id: 'pwsh',
      label: 'PowerShell',
      ext: 'ps1',
      render: function (art) {
        return art.split('\n').map(function (line) {
          return "Write-Output '" + escapeSingleDoubled(line) + "'";
        }).join('\n');
      }
    },
    {
      id: 'c',
      label: 'C',
      ext: 'c',
      render: function (art) {
        // printf("%s\n", …) 而不是 printf("…")：格式串里带 % 会被当成格式符。
        return '#include <stdio.h>\n\nint main(void) {\n' + art.split('\n').map(function (line) {
          return '    printf("%s\\n", "' + escapeDoubleQuoted(line) + '");';
        }).join('\n') + '\n    return 0;\n}';
      }
    },
    {
      id: 'cpp',
      label: 'C++',
      ext: 'cpp',
      render: function (art) {
        return '#include <iostream>\n\nint main() {\n' + art.split('\n').map(function (line) {
          return '    std::cout << "' + escapeDoubleQuoted(line) + '\\n";';
        }).join('\n') + '\n    return 0;\n}';
      }
    },
    {
      id: 'csharp',
      label: 'C#',
      ext: 'cs',
      render: function (art) {
        // 逐字字符串 @"…"：里面的双引号要写成两个，反斜杠是字面量。
        // 类不加 public：下载下来的文件名是 ascii-art-<字体>.cs，
        // 而 public 类要求文件名与类名一致 —— 加了 public 就编译不过。
        return 'using System;\n\nclass Program {\n    static void Main() {\n' + art.split('\n').map(function (line) {
          return '        Console.WriteLine(@"' + escapeDoubleDoubled(line) + '");';
        }).join('\n') + '\n    }\n}';
      }
    },
    {
      id: 'vbnet',
      label: 'VB.NET',
      ext: 'vb',
      render: function (art) {
        return 'Imports System\n\nModule Program\n    Sub Main()\n' + art.split('\n').map(function (line) {
          return '        Console.WriteLine("' + escapeDoubleDoubled(line) + '")';
        }).join('\n') + '\n    End Sub\nEnd Module';
      }
    },
    {
      id: 'node',
      label: 'Node.js',
      ext: 'js',
      render: function (art) {
        return art.split('\n').map(function (line) {
          return 'console.log("' + escapeDoubleQuoted(line) + '");';
        }).join('\n');
      }
    },
    {
      id: 'python',
      label: 'Python',
      ext: 'py',
      render: function (art) {
        return art.split('\n').map(function (line) {
          return 'print("' + escapeDoubleQuoted(line) + '")';
        }).join('\n');
      }
    },
    {
      id: 'html',
      label: 'HTML',
      ext: 'html',
      render: function (art) {
        return '<pre>\n' + art.split('\n').map(escapeXml).join('\n') + '\n</pre>';
      }
    },
    {
      id: 'rust',
      label: 'Rust',
      ext: 'rs',
      render: function (art) {
        // 艺术字放在**参数位**而不是格式串里：`println!("{}")` 里带花括号
        // 会被 Rust 当成格式占位符，编译不过。
        return 'fn main() {\n' + art.split('\n').map(function (line) {
          return '    println!("{}", "' + escapeDoubleQuoted(line) + '");';
        }).join('\n') + '\n}';
      }
    },
    {
      id: 'go',
      label: 'Go',
      ext: 'go',
      render: function (art) {
        return 'package main\n\nimport "fmt"\n\nfunc main() {\n' + art.split('\n').map(function (line) {
          return '\tfmt.Println("' + escapeDoubleQuoted(line) + '")';
        }).join('\n') + '\n}';
      }
    },
    {
      id: 'ruby',
      label: 'Ruby',
      ext: 'rb',
      render: function (art) {
        // Ruby 的双引号字符串里 #{ 与 #$ 都会插值，# 要转义
        return art.split('\n').map(function (line) {
          return 'puts "' + escapeHash(line) + '"';
        }).join('\n');
      }
    },
    {
      id: 'php',
      label: 'PHP',
      ext: 'php',
      render: function (art) {
        return '<?php\n' + art.split('\n').map(function (line) {
          return 'echo "' + escapeDollar(line) + '\\n";';
        }).join('\n') + '\n?>';
      }
    },
    {
      id: 'swift',
      label: 'Swift',
      ext: 'swift',
      render: function (art) {
        return art.split('\n').map(function (line) {
          return 'print("' + escapeDoubleQuoted(line) + '")';
        }).join('\n');
      }
    },
    {
      id: 'kotlin',
      label: 'Kotlin',
      ext: 'kt',
      render: function (art) {
        // Kotlin 的双引号字符串里 $ 是模板插值的开头，要转义
        return art.split('\n').map(function (line) {
          return 'println("' + escapeDollar(line) + '")';
        }).join('\n');
      }
    },
    {
      id: 'sql',
      label: 'SQL',
      ext: 'sql',
      render: function (art) {
        // 一行一条 SELECT（带分号）：整幅图塞进一条 SELECT 是串不起来的。
        return art.split('\n').map(function (line) {
          return "SELECT '" + escapeSingleDoubled(line) + "';";
        }).join('\n');
      }
    },
    {
      id: 'java',
      label: 'Java',
      ext: 'java',
      render: function (art) {
        // 类不加 public：下载下来的文件名是 ascii-art-<字体>.java，
        // 而 public 类要求文件名与类名一致 —— 加了 public 就编译不过。
        return 'class Main {\n    public static void main(String[] args) {\n' + art.split('\n').map(function (line) {
          return '        System.out.println("' + escapeDoubleQuoted(line) + '");';
        }).join('\n') + '\n    }\n}';
      }
    }
  ];

  var DEFAULT_LANGUAGE = 'raw';

  /** 语言 id → 语言定义；认不出来返回 null（不静默退回 raw，调用方自己决定） */
  function getLanguage(id) {
    for (var i = 0; i < LANGUAGES.length; i++) {
      if (LANGUAGES[i].id === id) return LANGUAGES[i];
    }
    return null;
  }

  /** 下拉框用的选项（拷贝，外部改不到内部状态） */
  function languageOptions() {
    return LANGUAGES.map(function (lang) {
      return { id: lang.id, label: lang.label, ext: lang.ext };
    });
  }

  /**
   * 艺术字 → 所选语言的代码。
   *
   * 认不出来的语言 id 就原样返回艺术字 —— 跟上游一样，
   * 但这里不会「悄悄给一段不是用户选的东西」。
   * @param {string} art
   * @param {string} languageId
   * @returns {string}
   */
  function translateToLanguage(art, languageId) {
    var text = art === null || art === undefined ? '' : String(art);
    if (!text) return '';
    var lang = getLanguage(languageId);
    if (!lang) return text;
    // figlet 的输出以换行结尾；直接按 \n 切会多出一个空行，
    // 每种语言都会因此多出一条空语句。这里只去掉**一个**结尾换行。
    if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
    return lang.render(text);
  }

  /**
   * 确保某款字体已经解析进 figlet 的缓存。命中缓存直接回调，不命中才 fetch。
   * 注意 figlet.parseFont 本身就会把字体塞进 figFonts —— 所以必须走
   * parseFont 这条路，浏览器里没有 textSync（它要 fs 同步读文件）。
   * @param {string} name
   * @param {(err: Error|null, data: (string|null)) => void} cb
   */
  function ensureFont(name, cb) {
    var figlet = window.figlet;
    if (!figlet || typeof figlet.parseFont !== 'function') { cb(new Error('figlet is not loaded.'), null); return; }
    if (figlet.figFonts && figlet.figFonts[name]) { cb(null, null); return; } // 已在缓存里

    fetch(resolveFontPath(name)).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + resolveFontPath(name));
      return res.text();
    }).then(function (text) {
      figlet.parseFont(name, text); // 副作用：注册进 figFonts
      cb(null, text);
    }).catch(function (err) {
      cb(err, null);
    });
  }

  /** 字体在不在缓存里（UI 用它显示「已缓存」） */
  function isFontCached(name) {
    var figlet = window.figlet;
    return !!(figlet && figlet.figFonts && figlet.figFonts[name]);
  }

  /** 选中的输出语言记在 localStorage 里（对应上游的 useStorage） */
  var LANGUAGE_KEY = 'ascii-text-drawer:language';

  function readStored(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : raw;
    } catch (e) {
      return fallback; // 隐私模式下 localStorage 直接抛
    }
  }

  function writeStored(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式 */ }
  }

  window.ItTools.register('ascii-text-drawer', function (root) {
    // 兜底：万一字体没进缓存，figlet 自己要去 loadFont，默认路径得指向我们的字体目录，
    // 而不是它内置的 './fonts'（那是给 npm 包用的相对路径，页面上不存在）。
    if (window.figlet && typeof window.figlet.defaults === 'function') {
      window.figlet.defaults({ fontPath: FONT_PATH_PREFIX });
    }

    var textInput = D.h('textarea.layui-textarea', {
      rows: 4, spellcheck: 'false', placeholder: t('input_ph', 'Your text to draw')
    });
    textInput.value = 'Ascii ART';

    var fontSelect = D.h('select.layui-input', null, availableFonts().slice().sort().map(function (f) {
      return D.h('option', { value: f, text: f });
    }));
    fontSelect.value = DEFAULT_FONT;

    // 存下来的语言 id 可能是旧版本留下的、现在已不存在的语言 —— 认不出来就回 raw。
    var storedLanguage = readStored(LANGUAGE_KEY, DEFAULT_LANGUAGE);
    if (!getLanguage(storedLanguage)) storedLanguage = DEFAULT_LANGUAGE;

    var langSelect = D.h('select.layui-input', null, languageOptions().map(function (lang) {
      return D.h('option', { value: lang.id, text: lang.label });
    }));
    langSelect.value = storedLanguage;

    var widthInput = D.h('input.layui-input', { type: 'number', min: '0', max: String(MAX_WIDTH), value: '80' });
    var fontHint = D.h('p.field-hint', { text: t('fonts_bundled', '{n} fonts bundled').replace('{n}', availableFonts().length) });
    var fontField = U.field(t('font', 'Font:'), fontSelect);
    fontField.appendChild(fontHint); // hint 要跟着渲染状态变，所以不用 U.field 的 hint 参数
    var langField = U.field(t('language', 'Output language:'), langSelect, {
      hint: t('language_hint', 'Each line of the art is wrapped separately')
    });

    var statusBox = D.h('span.muted');
    var outputBox = U.codeBlock();
    var outputLabel = D.h('div.code-label', { text: t('ascii_art_text', 'Ascii Art text:') });
    var downloadBtn = D.h('button.layui-btn.layui-btn-primary', { type: 'button', text: t('download', 'Download') });
    var copyBtn = U.copyButton(function () { return outputBox.value; }, window.ItTools.i18n('copy', 'Copy'));

    var token = 0; // 防止慢请求回来后覆盖更新的输出
    var rawArt = ''; // figlet 画出来的原始艺术字（还没按语言包装）

    /** 当前语言的后缀（raw 时是 txt） */
    function currentExt() {
      var lang = getLanguage(langSelect.value);
      return lang ? lang.ext : 'txt';
    }

    /**
     * 把已经画好的艺术字按当前语言包一遍，写进输出框。
     *
     * 单独拎出来是因为**切语言不用重新画**：艺术字已经在那儿了，
     * 重新走一遍 figlet 只会白白再排一次版（上游是整个 watchEffect 重跑）。
     */
    function applyLanguage() {
      var lang = getLanguage(langSelect.value);
      outputBox.value = translateToLanguage(rawArt, langSelect.value);
      outputLabel.textContent = lang && lang.id !== DEFAULT_LANGUAGE
        ? t('generated_code', 'Generated code:')
        : t('ascii_art_text', 'Ascii Art text:');
      downloadBtn.textContent = t('download', 'Download') + ' .' + currentExt();
    }

    function render() {
      var mine = ++token;
      var font = fontSelect.value;
      var payload = buildPayload(font, widthInput.value);
      statusBox.textContent = '';
      fontHint.textContent = isFontCached(font)
        ? t('fonts_bundled_cached', '{n} fonts bundled — this one is already loaded').replace('{n}', availableFonts().length)
        : t('fonts_bundled', '{n} fonts bundled').replace('{n}', availableFonts().length);

      if (!textInput.value) {
        rawArt = '';
        outputBox.value = '';
        statusBox.textContent = t('status_empty', 'Type something to draw.');
        return;
      }

      ensureFont(font, function (err) {
        if (mine !== token) return; // 已经有更新的请求了
        if (err) {
          rawArt = '';
          outputBox.value = '';
          statusBox.textContent = t('status_font_error', 'Could not load font "{font}": {error}')
            .replace('{font}', font).replace('{error}', err.message);
          return;
        }
        statusBox.textContent = t('status_rendering', 'Rendering with {font}…').replace('{font}', font);
        var p = window.figlet.text(textInput.value, payload, function (e, out) {
          if (mine !== token) return;
          if (e) {
            rawArt = '';
            outputBox.value = '';
            statusBox.textContent = t('status_error', 'Current settings resulted in error: {error}')
              .replace('{error}', e.message || e);
            return;
          }
          rawArt = out || '';
          applyLanguage();
          statusBox.textContent = out ? '' : t('status_nothing', 'Nothing drawn (empty text).');
        });
        // figlet.text 内部会 reject，加载失败时这个 Promise 没人接就成 unhandledrejection
        if (p && typeof p.catch === 'function') p.catch(function () { /* 错误已经走回调了 */ });
      });
    }

    var offs = [
      D.on(textInput, 'input', render),
      D.on(fontSelect, 'change', render),
      D.on(widthInput, 'input', render),
      D.on(langSelect, 'change', function () {
        writeStored(LANGUAGE_KEY, langSelect.value);
        applyLanguage();
      }),
      D.on(downloadBtn, 'click', function () {
        if (!outputBox.value) return;
        window.ItTools.download(downloadFilename(fontSelect.value, currentExt()), outputBox.value, 'text/plain;charset=utf-8');
      })
    ];

    // 两块面板：左边输入、右边输出。子块必须待在卡片里，
    // 否则 .tool-content 的 flex 会把它们各自当成一块独立面板。
    // 原版这一页只有一张卡：输入 → 分隔线 → 字体/宽度 → 分隔线 → 输出。
    // 拆成两张卡会把中间那两条分隔线变成卡与卡之间的空隙，看着不像原版。
    root.appendChild(D.h('div.card', null,
      U.field(t('input', 'Your text:'), textInput, { wide: true }),
      U.divider(),
      D.h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
        fontField,
        langField,
        U.field(t('width', 'Width:'), widthInput, { hint: t('width_hint', '0 = no wrapping') })),
      U.divider(),
      D.h('div.field', null,
        outputLabel,
        outputBox.card,
        D.h('div.form-actions', null, copyBtn, downloadBtn, statusBox))
    ));

    applyLanguage(); // 先把按钮上的后缀与输出标题摆对（此时还没有艺术字）
    render();

    return {
      destroy: function () {
        offs.forEach(function (off) { off(); });
        D.clear(root);
      }
    };
  });

  window.ItTools.logic['ascii-text-drawer'] = {
    FONTS: FONTS,
    FONT_PATH_PREFIX: FONT_PATH_PREFIX,
    DEFAULT_FONT: DEFAULT_FONT,
    DEFAULT_LANGUAGE: DEFAULT_LANGUAGE,
    LANGUAGES: LANGUAGES,
    availableFonts: availableFonts,
    resolveFontPath: resolveFontPath,
    isKnownFont: isKnownFont,
    sanitizeWidth: sanitizeWidth,
    buildPayload: buildPayload,
    downloadFilename: downloadFilename,
    ensureFont: ensureFont,
    isFontCached: isFontCached,
    getLanguage: getLanguage,
    languageOptions: languageOptions,
    translateToLanguage: translateToLanguage,
    escapeDoubleQuoted: escapeDoubleQuoted,
    escapeSingleDoubled: escapeSingleDoubled,
    escapeDoubleDoubled: escapeDoubleDoubled,
    escapePosixSingle: escapePosixSingle,
    escapeDollar: escapeDollar,
    escapeHash: escapeHash,
    escapeXml: escapeXml,
    __cases: function (assert) {
      /* ---- 字体清单 ---- */
      var fonts = availableFonts();
      assert.eq(fonts.length, 44, '随包 44 个字体');
      assert.eq(fonts.filter(function (f, i) { return fonts.indexOf(f) !== i; }), [], '没有重名');
      assert.eq(fonts[0], 'Standard', '第一个是 Standard');
      assert(fonts.indexOf('Delta Corps Priest 1') !== -1, '带空格的名字也在');
      assert(fonts.indexOf('Big Money-nw') !== -1, '带连字符的名字也在');
      assert(isKnownFont('Standard') && isKnownFont('Stampatello'), 'isKnownFont 认得出已知的');
      assert(!isKnownFont('Pawp'), '没随包的字体（参考实现里有）不算已知');
      assert(!isKnownFont(''), '空串不是字体');
      assert(!isKnownFont(null), 'null 不是字体');

      /* ---- 外部改不到内部状态 ---- */
      fonts.push('Bogus');
      assert.eq(availableFonts().length, 44, 'availableFonts 给的是拷贝');

      /* ---- URL 拼装：空格和撇号必须转义 ---- */
      assert.eq(resolveFontPath('Standard'), '/assets/lib/figlet/fonts/Standard.flf', '普通字体名');
      assert.eq(resolveFontPath('Delta Corps Priest 1'), '/assets/lib/figlet/fonts/Delta%20Corps%20Priest%201.flf',
        '带空格的名字要 encodeURIComponent');
      assert.eq(resolveFontPath("Patorjk's Cheese"), '/assets/lib/figlet/fonts/Patorjk\'s%20Cheese.flf', '撇号不编码（它在 URL 里合法）');
      assert.eq(resolveFontPath('Big Money-nw'), '/assets/lib/figlet/fonts/Big%20Money-nw.flf', '连字符原样保留');
      var threw = false;
      try { resolveFontPath(''); } catch (e) { threw = true; }
      assert(threw, '空字体名要报错，不能拼出 .flf 这种半截 URL');
      threw = false;
      try { resolveFontPath(null); } catch (e2) { threw = true; }
      assert(threw, 'null 字体名要报错');
      threw = false;
      try { resolveFontPath(42); } catch (e3) { threw = true; }
      assert(threw, '数字字体名要报错');

      /* ---- 宽度 ---- */
      assert.eq(sanitizeWidth(80), 80, '正常宽度');
      assert.eq(sanitizeWidth('80'), 80, '字符串也能吃');
      assert.eq(sanitizeWidth(0), 0, '0 表示不折行');
      assert.eq(sanitizeWidth(-5), 0, '负数当 0');
      assert.eq(sanitizeWidth(99999), 10000, '超上限夹住');
      assert.eq(sanitizeWidth(80.7), 80, '小数截断');
      assert.eq(sanitizeWidth(''), 0, '空串当 0');
      assert.eq(sanitizeWidth('abc'), 0, '非数字当 0');
      assert.eq(sanitizeWidth(NaN), 0, 'NaN 当 0');

      /* ---- figlet 参数 ---- */
      assert.eq(buildPayload('Standard', 80), { font: 'Standard', width: 80, whitespaceBreak: true }, '正常参数');
      assert.eq(buildPayload('Nope', 80).font, 'Standard', '未知字体退回 Standard，不去请求一个必然 404 的文件');
      assert.eq(buildPayload('Standard', -1).width, 0, '宽度非法时按 0 处理');
      assert.eq(buildPayload(undefined, 80).font, 'Standard', '字体缺省用 Standard');
      assert.eq(buildPayload('Standard', 80).whitespaceBreak, true, 'whitespaceBreak 开着，长句子才会折行');

      /* ---- 下载文件名 ---- */
      assert.eq(downloadFilename('Standard'), 'ascii-art-Standard.txt', '普通字体');
      assert.eq(downloadFilename('Delta Corps Priest 1'), 'ascii-art-Delta-Corps-Priest-1.txt', '空格换成连字符');
      assert.eq(downloadFilename(''), 'ascii-art-Standard.txt', '空名退回默认字体');
      assert.eq(downloadFilename('!!!'), 'ascii-art-art.txt', '净化后什么都不剩时也有兜底');
      assert(downloadFilename('Standard').indexOf('/') === -1, '文件名里不能有路径分隔符');

      /* ---- 字体缓存 ---- */
      assert(isFontCached('Standard') === false, '一开始没有字体进缓存');
      var cachedCb = null;
      ensureFont('Standard', function (err) { cachedCb = err; });
      assert(isFontCached('Standard') === false, '测试环境里 fetch 永不 resolve，缓存不会被偷偷填上');
      assert(cachedCb === null, 'ensureFont 是异步的，调用后立刻返回');

      /* ---- 按编程语言输出：语言表 ---- */
      var langs = LANGUAGES;
      assert.eq(langs.length, 18, '18 种输出语言');
      assert.eq(langs.map(function (l) { return l.id; }).filter(function (id, i, a) { return a.indexOf(id) !== i; }), [],
        '语言 id 不重名');
      assert.eq(langs.filter(function (l) { return !l.ext || !l.render; }), [], '每种语言都有后缀与渲染函数');
      assert.eq(getLanguage('python').ext, 'py', 'Python 的后缀是 py');
      assert.eq(getLanguage('nope'), null, '认不出来的语言返回 null');
      assert.eq(languageOptions().length, 18, '下拉有 18 项');
      assert.eq(languageOptions()[0].id, 'raw', '第一项是 raw');
      assert.eq(languageOptions()[0].label, t('language_raw', 'Raw text'), 'raw 的显示名走 i18n');

      /* ---- 按编程语言输出：转义规则 ---- */
      // 双引号字符串：反斜杠与双引号都加反斜杠
      assert.eq(escapeDoubleQuoted('a"b'), 'a\\"b', '双引号被转义');
      assert.eq(escapeDoubleQuoted('a\\b'), 'a\\\\b', '反斜杠被转义');
      // 顺序要紧：先转义反斜杠再转义双引号，反过来会多出一个反斜杠
      assert.eq(escapeDoubleQuoted('\\"'), '\\\\\\"', '反斜杠+双引号：三个反斜杠加一个引号');
      // 单引号双写：PowerShell / VB / SQL —— 这几种语言里反斜杠是字面量
      assert.eq(escapeSingleDoubled("it's"), "it''s", '单引号双写');
      assert.eq(escapeSingleDoubled('a\\b'), 'a\\b', '反斜杠原样留着（PowerShell 里它不是转义符）');
      assert.eq(escapeDoubleDoubled('a"b'), 'a""b', '双引号双写');
      assert.eq(escapeDoubleDoubled('a\\b'), 'a\\b', '反斜杠原样留着（C# 逐字字符串里它不是转义符）');
      // POSIX shell：单引号没法出现在单引号里，只能关掉-转义-再开
      assert.eq(escapePosixSingle("it's"), "it'\\''s", 'POSIX 单引号转义');
      assert.eq(escapePosixSingle('$(whoami)'), '$(whoami)', '命令替换原样留着（单引号里 shell 不会执行它）');
      // $ 与 # 在某些语言的双引号字符串里会开始插值
      assert.eq(escapeDollar('$HOME'), '\\$HOME', 'PHP/Kotlin：$ 要转义');
      assert.eq(escapeDollar('a\\b'), 'a\\\\b', '转义 $ 之前先把反斜杠处理掉');
      assert.eq(escapeHash('#{x}'), '\\#{x}', 'Ruby：# 要转义');
      assert.eq(escapeHash('a\\b'), 'a\\\\b', '转义 # 之前先把反斜杠处理掉');
      // HTML
      assert.eq(escapeXml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&apos;&lt;/b&gt;', 'HTML 实体转义');

      /* ---- 按编程语言输出：逐种语言的实际产物 ---- */
      assert.eq(translateToLanguage('A\nB', 'raw'), 'A\nB', 'raw 就是原样');
      assert.eq(translateToLanguage('', 'python'), '', '空艺术字产出空串');
      assert.eq(translateToLanguage(null, 'python'), '', 'null 艺术字产出空串');
      assert.eq(translateToLanguage('A\nB', 'nope'), 'A\nB', '认不出来的语言原样返回');
      assert.eq(translateToLanguage('A\nB\n', 'python'), 'print("A")\nprint("B")',
        '结尾的换行不会多切出一个空语句');
      assert.eq(translateToLanguage('a"b', 'python'), 'print("a\\"b")', 'Python');
      assert.eq(translateToLanguage('a"b', 'node'), 'console.log("a\\"b");', 'Node.js');
      assert.eq(translateToLanguage('a"b', 'kotlin'), 'println("a\\"b")', 'Kotlin');
      assert.eq(translateToLanguage('a"b', 'swift'), 'print("a\\"b")', 'Swift');
      assert.eq(translateToLanguage('a"b', 'ruby'), 'puts "a\\"b"', 'Ruby');
      assert.eq(translateToLanguage('a"b', 'php'), '<?php\necho "a\\"b\\n";\n?>', 'PHP');
      assert.eq(translateToLanguage("it's", 'pwsh'), "Write-Output 'it''s'", 'PowerShell');
      assert.eq(translateToLanguage("it's", 'sql'), "SELECT 'it''s';", 'SQL');
      assert.eq(translateToLanguage("it's", 'bash'), "printf '%s\\n' 'it'\\''s'", 'Bash');
      assert.eq(translateToLanguage('$(whoami)', 'bash'), "printf '%s\\n' '$(whoami)'", 'Bash 里命令替换不会被执行');
      assert.eq(translateToLanguage('<b>', 'html'), '<pre>\n&lt;b&gt;\n</pre>', 'HTML');
      // 花括号在 Rust 的格式串里是占位符
      assert.eq(translateToLanguage('{x}', 'rust'), 'fn main() {\n    println!("{}", "{x}");\n}',
        'Rust：艺术字放在参数位，花括号不会被当成格式占位符');
      // $ 在 PHP / Kotlin 的双引号字符串里会开始插值
      assert.eq(translateToLanguage('$HOME', 'php'), '<?php\necho "\\$HOME\\n";\n?>', 'PHP：$ 被转义');
      assert.eq(translateToLanguage('$HOME', 'kotlin'), 'println("\\$HOME")', 'Kotlin：$ 被转义');
      // # 在 Ruby 的双引号字符串里会开始插值
      assert.eq(translateToLanguage('#{x}', 'ruby'), 'puts "\\#{x}"', 'Ruby：# 被转义');

      /* ---- 产出的是**能跑的完整程序**，不是几行片段 ---- */
      assert.eq(translateToLanguage('a"b', 'rust'), 'fn main() {\n    println!("{}", "a\\"b");\n}', 'Rust');
      assert.eq(translateToLanguage('a"b', 'java'),
        'class Main {\n    public static void main(String[] args) {\n        System.out.println("a\\"b");\n    }\n}',
        'Java');
      assert.eq(translateToLanguage('a"b', 'go'),
        'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("a\\"b")\n}', 'Go');
      assert.eq(translateToLanguage('a"b', 'c'),
        '#include <stdio.h>\n\nint main(void) {\n    printf("%s\\n", "a\\"b");\n    return 0;\n}', 'C');
      assert.eq(translateToLanguage('a"b', 'cpp'),
        '#include <iostream>\n\nint main() {\n    std::cout << "a\\"b\\n";\n    return 0;\n}', 'C++');
      // C# 用逐字字符串 @"…"：双引号要双写，反斜杠是字面量
      assert.eq(translateToLanguage('a"b', 'csharp'),
        'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine(@"a""b");\n    }\n}', 'C#');
      assert.eq(translateToLanguage('a\\b', 'csharp'),
        'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine(@"a\\b");\n    }\n}',
        'C# 的反斜杠是字面量，不加反斜杠');
      assert.eq(translateToLanguage('a"b', 'vbnet'),
        'Imports System\n\nModule Program\n    Sub Main()\n        Console.WriteLine("a""b")\n    End Sub\nEnd Module',
        'VB.NET');
      assert.eq(translateToLanguage('100%', 'c'),
        '#include <stdio.h>\n\nint main(void) {\n    printf("%s\\n", "100%");\n    return 0;\n}',
        'C 用 printf("%s\\n", …)：% 不会被当成格式符');
      // public 类要求文件名与类名一致，而下载下来的文件名是 ascii-art-<字体>.java，
      // 所以类必须不带 public。
      assert(translateToLanguage('a', 'java').indexOf('public class') === -1, 'Java 的类不带 public');
      assert(translateToLanguage('a', 'csharp').indexOf('public class') === -1, 'C# 的类不带 public');

      /* ---- 下载文件名跟着语言走 ---- */
      assert.eq(downloadFilename('Standard', 'py'), 'ascii-art-Standard.py', '后缀跟着语言走');
      assert.eq(downloadFilename('Standard'), 'ascii-art-Standard.txt', '不给后缀就是 txt');
      assert.eq(downloadFilename('Standard', ''), 'ascii-art-Standard.txt', '空后缀退回 txt');
      assert.eq(downloadFilename('Standard', '..'), 'ascii-art-Standard.txt', '后缀里不能有路径');
      assert(downloadFilename('Standard', 'p/../x').indexOf('/') === -1, '后缀里的斜杠被去掉');
    }
  };
})();