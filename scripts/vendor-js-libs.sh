#!/usr/bin/env bash
# 把 S3 需要的第三方 JS 库 vendor 到 static/lib/（供 rust-embed 打进二进制）。
#
# 关键约束：本项目**没有 Node 构建步骤**，所以每个包都必须挑到能直接用
# <script src> 加载的产物。下面清单里的每个文件都不是凭印象写的，是逐个下下来
# 核对过 package.json 的 browser/main 字段和实际目录结构后选的。
#
# 用法: scripts/vendor-js-libs.sh            下载并覆盖 static/lib/<name>/
#      scripts/vendor-js-libs.sh --list     只打印清单
#
# 加新库时注意三件事：
#   1. 优先挑 UMD/IIFE 产物（dist/*.min.js、umd/index.js、bundle/*.js），
#      它们会自己往 window 上挂全局；
#   2. 只发 ESM 的包在这里用不了 —— 既没有 node_modules 解析，也没有打包器。
#      CommonJS 的包标 @cjs:，由 scripts/cjs-bundle.js 打成单文件；
#   3. 纯数据的包（json）标 @data:，运行时 fetch。
#
# 挑文件别靠名字猜：npm 包里混着「已弃用、路径挪走」的抛错占位、纯 ESM 重导出桩，
# 还有「浏览器产物」三个字写得很像样、实际根本不往 window 上挂东西的
# （mathjs 的 dist/math.min.js 只 throw；xml-formatter 的 dist/browser/*.js 是
# browserify 整包，返回值被丢在闭包里，script 标签加载后只多一个 require 全局）。
# 改完清单务必跑一遍 `cd test/js && node check-vendor.js`，它把每个产物真加载一遍。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CODE_BASE="$(dirname "$SCRIPT_DIR")"
LIB="${CODE_BASE}/static/lib"

# figlet 的字体：1.7.0 全量 289 个 .flf 有 3.4MB，全打进单文件二进制不划算
# （而这里其它静态资源加起来才 5MB）。it-tools 自己也是从 unpkg 按需拉的，
# 这里照搬同样的做法 —— 只随包带一份常用字体，运行时按需 fetch 各自的 .flf。
# 想加字体就往这里加，名字写错了脚本会当场报错，不会等到页面上才白屏。
FIGLET_FONTS=(
  Standard Slant Big Banner Bigfig Shadow Speed Small Ghost Blocks
  Alphabet Acrobatic Banner3 Banner3-D Caligraphy "Delta Corps Priest 1" Digital
  Doom Epic Fraktur Georgia11 Graffiti Keyboard Mini Roman Script
  Slide "Small Shadow" "Star Wars" "Star Strips" Stop Straight
  "Stronger Than All" Univers Varsity "Big Money-nw" Bloody 3D-ASCII 3x5
  "Big Chief" Cyberlarge Cybermedium Reverse Stampatello
)
FIGLET_FONTS_CSV=""
for f in "${FIGLET_FONTS[@]}"; do
  FIGLET_FONTS_CSV+="${FIGLET_FONTS_CSV:+,}fonts/${f}.flf"
done

# 格式: 目标目录|包名@版本|产物说明|额外文件(逗号分隔)
#
#   普通条目  : 直接拷文件，末尾 @ 表示整目录递归拷
#   @cjs:入口 : 包只发 CommonJS，用 scripts/cjs-bundle.js 打成单文件（见该脚本头部说明）。
#               它的 npm 依赖不用在这里列，脚本会顺着 package.json 自动读到闭包。
#   @data:文件: 纯数据，运行时 fetch
#   第四栏    : 主产物之外还要从包里额外拷走的文件（figlet 的字体走这里）
#
# CJS_BUILTIN：这些包会 require 到 Node 内置模块，但只在浏览器走不到的分支上用到
# （见 cjs-bundle.js 的 --builtin 说明），可以放行。
# 全局名一栏是这个包在 window 上挂出什么，check-vendor.js 会逐个核对。
MANIFEST=(
  "uuid|uuid@9.0.0|@cjs:dist/commonjs-browser/index.js"
  "ulid|ulid@2.3.0|dist/index.umd.js"
  "nanoid|nanoid@3.3.6|@cjs:index.browser.cjs"
  "bip39|@it-tools/bip39@0.0.4|@cjs:umd/index.js"
  "colord|colord@2.9.3|@cjs:index.js"
  "yaml|yaml@2.2.1|@cjs:dist/index.js"
  # 参考项目用的是 iarna-toml-esm，但那个包名里的 "esm" 是字面意思：它只有 ESM，
# 连自带的 toml.cjs 都 require 了 ESM 的 parse.js，在没有打包器的页面上用不了。
# @iarna/toml 是同一套代码的 CJS 版，API 一模一样。
"toml|@iarna/toml@3.0.0|@cjs:toml.js"
  "xml-js|xml-js@1.6.11|dist/xml-js.min.js"
  "xml-formatter|xml-formatter@3.3.2|@cjs:dist/cjs/index.js"
  "json5|json5@2.2.3|dist/index.min.js"
  # jsonrepair：修 JSON 的库（上游 #1539 拿它做 json-viewer 的「修复 JSON」开关）。
  # lib/umd/jsonrepair.min.js 是**自包含 UMD**（零依赖，7KB），挂出全局
  # JSONRepair（是个**对象**，真正的函数在 .jsonrepair 上，不是全局函数本身）。
  # lib/esm 与 lib/cjs 那两份都加载不了（纯 ESM / CommonJS）。
  "jsonrepair|jsonrepair@3.15.0|lib/umd/jsonrepair.min.js|LICENSE.md"
  "markdown-it|markdown-it@14.0.0|dist/markdown-it.min.js"
  "sql-formatter|sql-formatter@13.0.0|dist/sql-formatter.min.js"
  "cronstrue|cronstrue@2.26.0|dist/cronstrue.min.js,locales/@"
  "mathjs|mathjs@11.9.1|lib/browser/math.js"
  "ua-parser-js|ua-parser-js@1.0.35|dist/ua-parser.min.js"
  "ibantools|ibantools@4.3.3|@cjs:build/ibantools.js"
  "regexper-render|@regexper/render@1.0.0|dist/regexper.js"
  "qrcode|qrcode@1.5.1|build/qrcode.js"
  "libphonenumber-js|libphonenumber-js@1.10.28|bundle/libphonenumber-max.js"
  "emojilib|emojilib@3.0.10|@data:dist/emoji-en-US.json"
  "unicode-emoji-json|unicode-emoji-json@0.4.0|@data:data-by-emoji.json"
  "mime-db|mime-db@1.52.0|@data:db.json"
  "country-code-lookup|country-code-lookup@0.1.0|@cjs:index.js"
  "cron-validator|cron-validator@1.3.1|@cjs:lib/index.js"
  "randexp|randexp@0.5.3|@cjs:lib/randexp.js"
  "oggen|@it-tools/oggen@1.3.0|@cjs:dist/index.cjs"
  "composerize|composerize-ts@0.6.2|@cjs:dist/cjs/index.js"
  "email-normalizer|email-normalizer@1.0.0|@cjs:dist/index.cjs"
  "date-fns|date-fns@2.29.3|@cjs:formatRelative/index.js"
  "figlet|figlet@1.7.0|@cjs:lib/figlet.js|${FIGLET_FONTS_CSV}"
  # turndown：HTML → Markdown。lib/turndown.browser.umd.js 是零 import 的自包含 UMD，
  # 挂出全局 TurndownService（内部用 DOMParser，只能在浏览器跑）。
  "turndown|turndown@7.2.4|lib/turndown.browser.umd.js|LICENSE"
  # GFM 插件（表格 / 删除线 / 任务列表 / 高亮代码块）。
  # 用的是上游 it-tools 那个 fork（@guyplusplus/turndown-plugin-gfm），不是 npm 上的
  # turndown-plugin-gfm —— fork 的表格规则更强：没有表头的表格也转、支持 colspan、
  # 单元格里的竖线会转义（上游那版不转义，| 会把表格拆散）。
  # dist/ 那份是自包含 IIFE（零 require），挂出全局 TurndownPluginGfmService。
  "turndown-plugin-gfm|@guyplusplus/turndown-plugin-gfm@1.0.7|dist/turndown-plugin-gfm.js|LICENSE"
  # js-beautify：产物是 js/lib/beautifier.js（自包含 UMD），不是 js/index.js ——
  # 后者是 Node 入口，会拉 glob / nopt / editorconfig，浏览器里加载不了。
  # 挂出的全局是**对象**：beautifier.js(...) / beautifier.css(...) / beautifier.html(...)。
  "js-beautify|js-beautify@1.15.4|js/lib/beautifier.js|LICENSE"
  # exifreader 4.x 的 dist/exif-reader.js 是自包含 UMD（整库打进一个文件），
  # 挂出全局 ExifReader（对象）。传 ArrayBuffer 时 load() 是**同步**返回的。
  "exifreader|exifreader@4.20.0|dist/exif-reader.js|LICENSE"
  # convert 的 dist/index.js 是 UMD（dist/index.mjs 是纯 ESM，<script> 加载不了）。
  # 挂出全局 convert —— 是**命名空间对象**，换算函数在 .default 上。
  "convert|convert@5.4.1|dist/index.js|LICENSE"
)

# CJS 包打完包后挂出的全局名
declare -A CJS_GLOBAL=(
  [uuid]=uuid [nanoid]=nanoid [bip39]=BIP39 [colord]=Colord [yaml]=YAML
  [toml]=TOML [ibantools]=ibantools [country-code-lookup]=countryCodeLookup
  [cron-validator]=cronValidator [randexp]=RandExp [oggen]=oggen
  [composerize]=composerize [email-normalizer]=emailNormalizer [date-fns]=dateFns
  [xml-formatter]=xmlFormatter [figlet]=figlet
)

# 每个库可以放行的 Node 内置模块（逗号分隔）
declare -A CJS_BUILTIN=(
  [toml]=stream
)

# 每个库要挂成全局的是入口导出的哪个字段（缺省挂整个命名空间）
declare -A CJS_EXPORT=(
  [colord]=colord
  [oggen]=generateMeta
  [composerize]=composerize
)

if [ "${1:-}" = "--list" ]; then
  printf '%-24s %-26s %s\n' 目标 包 产物
  for row in "${MANIFEST[@]}"; do
    IFS='|' read -r dir spec files <<<"$row"
    printf '%-24s %-26s %s\n' "$dir" "$spec" "$files"
  done
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 清单第四栏：主产物之外还要从包里额外拷走的文件（figlet 的 .flf 字体走这里）
copy_extra() {
  local dir="$1" spec="$2" pkg="$3" target="$4" extra="$5" f
  IFS=',' read -ra xs <<<"$extra"
  for f in "${xs[@]}"; do
    if [ ! -e "${pkg}/${f}" ]; then
      echo "  ✗ ${spec} 里没有 ${f}" >&2
      exit 1
    fi
    mkdir -p "${target}/$(dirname "$f")"
    cp "${pkg}/${f}" "${target}/$(dirname "$f")/"
  done
}

echo "vendor 到 ${LIB}"
for row in "${MANIFEST[@]}"; do
  IFS='|' read -r dir spec files extra <<<"$row"
  work="$TMP/${dir}"
  mkdir -p "$work"

  if ! tgz="$(cd "$work" && npm pack "$spec" --silent 2>/dev/null | tail -1)" || [ -z "$tgz" ]; then
    echo "  ✗ ${spec} 下载失败" >&2
    exit 1
  fi
  tar -xzf "$work/$tgz" -C "$work" 2>/dev/null
  pkg="$work/package"

  target="${LIB}/${dir}"
  rm -rf "$target"
  mkdir -p "$target"

  IFS=',' read -ra parts <<<"$files"

  # @cjs:入口 —— 包只发 CommonJS，交给 cjs-bundle.js 打成单文件
  if [[ "${files}" == @cjs:* ]]; then
    main_entry="${files#@cjs:}"
    bare_args=()
    # 依赖闭包完全从 package.json 的 dependencies 一路读出来，清单里不写依赖：
    # composerize 一条链上就拖着 yamljs / ip-cidr / deepmerge-ts / jsbn / ip-address …，
    # 手写清单永远追不全（追了三次还是漏）。版本直接把依赖自己声明的 range 交给
    # npm 去解析，不必在这里复现一套 semver 解析器。
    unset packed   # 上一条清单用过的表不能漏进这一条
    declare -A packed=()
    queue=()
    while read -r sub; do
      [ -n "$sub" ] && queue+=("$sub")
    done < <(node -e "const p=require('${pkg}/package.json');console.log(Object.entries(p.dependencies||{}).map(([k,v])=>k+'@'+v).join('\n'))" 2>/dev/null)
    while [ ${#queue[@]} -gt 0 ]; do
      dep="${queue[0]}"
      queue=("${queue[@]:1}")
      # 拆出名字与版本/范围：作用域包的名字自带 @，只能从**最后一个** @ 切
      depname="${dep%@*}"; depver="${dep##*@}"
      [ "$depname" = "$dep" ] && depver="latest"
      [ -n "${packed[$depname]:-}" ] && continue
      depwork="$work/.dep_${depname//\//_}"
      mkdir -p "$depwork"
      dep_tgz="$(cd "$depwork" && npm pack "${depname}@${depver}" --silent 2>/dev/null | tail -1)"
      if [ -z "$dep_tgz" ]; then
        echo "  ✗ ${dir} 的依赖 ${depname}@${depver} 下载失败" >&2
        exit 1
      fi
      tar -xzf "$depwork/$dep_tgz" -C "$depwork" 2>/dev/null
      packed[$depname]=1
      bare_args+=(--bare "${depname}=${depwork}/package")
      # 它声明的依赖也排进队（devDependencies 不进：浏览器里用不到）
      while read -r sub; do
        [ -n "$sub" ] && [ -z "${packed[${sub%@*}]:-}" ] && queue+=("$sub")
      done < <(node -e "const p=require('${depwork}/package/package.json');console.log(Object.entries(p.dependencies||{}).map(([k,v])=>k+'@'+v).join('\n'))" 2>/dev/null)
    done
    builtin_args=()
    IFS=',' read -ra bs <<<"${CJS_BUILTIN[$dir]:-}"
    for b in ${bs[@]+"${bs[@]}"}; do
      [ -n "$b" ] && builtin_args+=(--builtin "$b")
    done
    node "${SCRIPT_DIR}/cjs-bundle.js" "$pkg" "$main_entry" "${target}/bundle.js" "${CJS_GLOBAL[$dir]}" \
      ${bare_args[@]+"${bare_args[@]}"} ${builtin_args[@]+"${builtin_args[@]}"} \
      ${CJS_EXPORT[$dir]:+--export "${CJS_EXPORT[$dir]}"}
    [ -n "$extra" ] && copy_extra "$dir" "$spec" "$pkg" "$target" "$extra"
    printf '  ✓ %-22s %-26s %s\n' "$dir" "$spec" "$(du -sh "$target" | cut -f1)"
    continue
  fi

  # @data:文件 —— 纯数据，运行时 fetch，不用 script 标签
  if [[ "${files}" == @data:* ]]; then
    cp "${pkg}/${files#@data:}" "$target/"
    printf '  ✓ %-22s %-26s %s\n' "$dir" "$spec" "$(du -sh "$target" | cut -f1)"
    continue
  fi

  for part in "${parts[@]}"; do
    # 结尾的 @ 只是标记「这是目录，递归拷」，路径本身要去掉它
    case "$part" in
      *@) rel="${part%@}" ;;
      *)  rel="$part" ;;
    esac
    src="${pkg}/${rel}"
    if [ ! -e "$src" ]; then
      # 猜错了路径就地把包里有什么列出来，省得来回试
      echo "  ✗ ${spec} 里没有 ${part}" >&2
      echo "    包内文件（最多 20 个）:" >&2
      (cd "$pkg" && find . -type f -not -path '*/node_modules/*' | sed 's|^\./|      |' | head -20) >&2
      exit 1
    fi
    if [ "${part: -1}" = "@" ]; then
      cp -r "$src" "$target/"
    else
      mkdir -p "$target/$(dirname "$part")"
      cp "$src" "$target/$part"
    fi
  done

  # 第四栏（额外文件）对普通条目同样有效 —— 之前只有 @cjs: 那条路拷，
  # 于是「普通包想顺带带上 LICENSE」是做不到的。
  [ -n "$extra" ] && copy_extra "$dir" "$spec" "$pkg" "$target" "$extra"

  printf '  ✓ %-22s %-26s %s\n' "$dir" "$spec" "$(du -sh "$target" | cut -f1)"
done

echo
echo "合计: $(du -sh "$LIB" | cut -f1)"
echo "提示: @cjs: 的包已打成单文件 bundle.js，加载后挂出对应全局（见 CJS_GLOBAL）。"