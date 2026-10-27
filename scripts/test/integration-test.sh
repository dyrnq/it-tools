#!/usr/bin/env bash
# it-tools 端到端集成测试
#
# cargo test 打的是进程内的函数；这个脚本打的是**真的进程**：
# 起一个 release 二进制，用 HTTP 打它。它守的是「发布出去的那个产物能不能用」：
#
#   · 静态资源有没有真的嵌进二进制 —— 服务是在临时目录里起的，
#     工作目录里没有任何 static/，资源照样发得出去才算数；
#   · 真实 TCP 上的行为对不对 —— 状态码、Location、ETag/304；
#   · 命令行参数、优雅退出（SIGTERM 收不收得住）。
#
# 用法：
#   scripts/test/integration-test.sh            # 用现成的 release 二进制
#   scripts/test/integration-test.sh --build    # 先 cargo build --release
#   IT_TOOLS_TEST_PORT=18081 scripts/test/integration-test.sh
#
# 退出码：全部通过为 0，只要有失败就是 1。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

BINARY="${IT_TOOLS_TEST_BIN:-${PROJECT_DIR}/target/release/it-tools}"
HOST="127.0.0.1"
PORT="${IT_TOOLS_TEST_PORT:-18080}"
BASE="http://${HOST}:${PORT}"

GREEN=$'\033[32m'
RED=$'\033[31m'
NC=$'\033[0m'

PASSED=0
FAILED=0
WORKDIR=""
SERVER_PID=""

cleanup() {
    if [ -n "${SERVER_PID}" ]; then
        kill -TERM "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi
    # 万一上面的 kill 没收拾干净（脚本被强杀时走不到这里），按端口兜底
    pkill -f "it-tools --host ${HOST} --port ${PORT}" 2>/dev/null || true
    if [ -n "${WORKDIR}" ]; then
        rm -rf "${WORKDIR}"
    fi
}
trap cleanup EXIT

# --- 小工具 ---------------------------------------------------------------

http_code() {
    curl -s -o /dev/null -w '%{http_code}' "$@"
}

# 从 JSON 里取点号路径的值，取不到就是空串。
#
# 用 python3 而不是 jq：脚本里本来就有一处 python3，CI 的镜像里一定有，
# 不再多引一个 jq 依赖。
json_path() {
    python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
# 路径写成 jq 那样的 .a.b —— 开头的点要去掉，
# 不然 ".ok".split(".") 的第一段是空串，一进去就「找不到」。
for k in sys.argv[1].lstrip(".").split("."):
    if not isinstance(d, dict) or k not in d:
        sys.exit(0)
    d = d[k]
if isinstance(d, bool):
    print("true" if d else "false")
elif d is None:
    pass
elif isinstance(d, str):
    print(d)
else:
    print(json.dumps(d, ensure_ascii=False))
' "$2" <<<"$1" 2>/dev/null
}

# 跑一条测试。失败时把输出打出来 —— CI 里只看一个 FAILED 是没法定位的。
run_test() {
    local name="$1"
    shift
    printf '  %-44s' "${name}"
    if "$@" >"${WORKDIR}/last.log" 2>&1; then
        echo -e "${GREEN}OK${NC}"
        PASSED=$((PASSED + 1))
        return 0
    fi
    echo -e "${RED}FAILED${NC}"
    FAILED=$((FAILED + 1))
    sed 's/^/        │ /' "${WORKDIR}/last.log" | head -20
    return 1
}

fail() {
    echo "$1"
    return 1
}

# --- 准备 -----------------------------------------------------------------

echo "=== it-tools 集成测试 ==="
echo ""

if [ "${1:-}" = "--build" ]; then
    echo "构建 release 二进制…"
    (cd "${PROJECT_DIR}" && cargo build --release) || exit 1
fi

if [ ! -x "${BINARY}" ]; then
    echo "找不到可执行文件: ${BINARY}"
    echo "先跑一次 'cargo build --release'，或者用 --build。"
    exit 1
fi

WORKDIR="$(mktemp -d)"

# --- 起服务 ---------------------------------------------------------------
#
# 刻意在临时目录里起：工作目录里没有 static/、没有 templates/，
# 服务照样能把资源发出去 —— 这才说明资源真的嵌在二进制里了。
echo "启动服务 ${BASE}（工作目录 ${WORKDIR}）…"
(cd "${WORKDIR}" && exec "${BINARY}" --host "${HOST}" --port "${PORT}" --lang en) \
    >"${WORKDIR}/server.log" 2>&1 &
SERVER_PID=$!

ready=0
for _ in $(seq 1 60); do
    if [ "$(http_code "${BASE}/healthz")" = "200" ]; then
        ready=1
        break
    fi
    sleep 0.25
done
if [ "${ready}" != "1" ]; then
    echo "服务没起来，日志："
    cat "${WORKDIR}/server.log"
    exit 1
fi
echo "服务就绪（pid ${SERVER_PID}）"
echo ""

# --- 测试 -----------------------------------------------------------------

echo "--- 页面与路由 ---"

t_home() {
    local code body
    code="$(http_code "${BASE}/")"
    [ "${code}" = "200" ] || fail "首页返回 ${code}"
    body="$(curl -s "${BASE}/")"
    grep -q 'class="tool-card"' <<<"${body}" || fail "首页里没有工具卡片"
}

t_about() {
    local code
    code="$(http_code "${BASE}/about")"
    [ "${code}" = "200" ] || fail "关于页返回 ${code}"
}

t_healthz() {
    local out
    out="$(curl -s "${BASE}/healthz")"
    grep -q '"ok":true' <<<"${out}" || fail "健康检查没返回 ok: ${out}"
    # 健康检查只回答「活着吗」—— 不该混进工具数量之类的统计项
    if grep -q '"tools"' <<<"${out}"; then
        fail "健康检查里混进了统计项: ${out}"
    fi
}

t_registry_json() {
    local out
    out="$(curl -s "${BASE}/registry.json")"
    # 用 python 确认是合法 JSON（curl 拿到的不一定就是 JSON）
    python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["tools"], "工具列表是空的"' \
        <<<"${out}" || fail "搜索索引不是合法 JSON"
}

t_i18n_js() {
    local out
    out="$(curl -s "${BASE}/i18n.js")"
    grep -q 'window.__IT_TOOLS_I18N__=' <<<"${out}" || fail "语言包不是预期的那一行"
}

t_tool_page() {
    local body
    body="$(curl -s "${BASE}/hash-text")"
    grep -q 'data-tool-api="/api/tools/hash-text"' <<<"${body}" || fail "工具页没有带上接口地址"
}

# 日期转换页在输入框空着的时候要每秒刷新一次（参考实现那一格是跳着的）。
# 这一条守的是**模板真的编进二进制了** —— 开发模式读的是磁盘上的模板，
# 发布出去的产物读的是 rust-embed 里那份，改模板忘了重新编，这里就红。
t_date_converter_refreshes() {
    local body
    body="$(curl -s "${BASE}/date-converter")"
    grep -q 'data-refresh="1000"' <<<"${body}" || fail "日期转换页没有带上刷新间隔"
    grep -q 'data-refresh-field="date"' <<<"${body}" || fail "日期转换页没有带上刷新字段"
    # 别的工具不该带：白跳的请求是最难查的那种浪费。
    if grep -q 'data-refresh' <<<"$(curl -s "${BASE}/hash-text")"; then
        fail "hash-text 不该有定时刷新"
    fi
    return 0
}

t_legacy_redirect() {
    local code loc
    code="$(http_code "${BASE}/hash")"
    [ "${code}" = "303" ] || fail "旧路由返回 ${code}（应该是 303）"
    loc="$(curl -s -o /dev/null -w '%{redirect_url}' "${BASE}/hash")"
    [ "${loc}" = "${BASE}/hash-text" ] || fail "Location 是 ${loc}"
}

t_unknown_page_is_404() {
    local code
    code="$(http_code "${BASE}/no-such-tool")"
    [ "${code}" = "404" ] || fail "不存在的页面返回 ${code}"
}

t_head_request() {
    local code
    code="$(http_code -I "${BASE}/")"
    [ "${code}" = "200" ] || fail "HEAD / 返回 ${code}"
}

run_test "首页渲染出工具卡片"            t_home
run_test "关于页"                        t_about
run_test "健康检查"                      t_healthz
run_test "搜索索引 registry.json"        t_registry_json
run_test "客户端语言包 /i18n.js"         t_i18n_js
run_test "工具页带接口地址"              t_tool_page
run_test "日期转换页带定时刷新"          t_date_converter_refreshes
run_test "旧路由 303 跳转"               t_legacy_redirect
run_test "不存在的页面 404"              t_unknown_page_is_404
run_test "HEAD 请求"                     t_head_request

echo ""
echo "--- 静态资源 ---"

t_assets_are_embedded() {
    # 服务是在临时目录里起的 —— 这里还能拿到 app.js，说明资源真的嵌进二进制了
    local body
    body="$(curl -s "${BASE}/assets/js/app.js")"
    [ -n "${body}" ] || fail "app.js 是空的"
    grep -q 'ItTools' <<<"${body}" || fail "app.js 的内容不对"
}

t_icon_sprite() {
    local code
    code="$(http_code "${BASE}/assets/img/icons.svg")"
    [ "${code}" = "200" ] || fail "图标雪碧图返回 ${code}"
}

t_missing_asset_is_404() {
    local code
    code="$(http_code "${BASE}/assets/js/no-such-file.js")"
    [ "${code}" = "404" ] || fail "不存在的资源返回 ${code}"
}

t_etag_304() {
    local etag code
    etag="$(curl -sI "${BASE}/assets/js/app.js" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')"
    [ -n "${etag}" ] || fail "静态资源没有 ETag"
    code="$(http_code -H "If-None-Match: ${etag}" "${BASE}/assets/js/app.js")"
    [ "${code}" = "304" ] || fail "带 If-None-Match 期望 304，得到 ${code}"
}

run_test "静态资源嵌在二进制里"          t_assets_are_embedded
run_test "图标雪碧图"                    t_icon_sprite
run_test "不存在的资源 404"              t_missing_asset_is_404
run_test "ETag 协商缓存 304"             t_etag_304

echo ""
echo "--- 服务端工具接口 ---"

# 工具接口的**信封形状**是前后端共用的契约：
#
#   成功 {"ok": true,  "data": {"output": …, "table"?: …, "rows"?: …, "meta"?: …}}
#   失败 {"ok": false, "error": {"kind": …, "message": …}}
#
# 前端那边（test/js/api-form.js）用的是**手写的假响应** —— 那边验的是
# 「前端怎么消费这个信封」，验不到「服务端真的这么发」。所以**形状以本文件为准**：
# 这里打的是真的二进制，键名对不上就是真的对不上。前端那边的假响应要跟着这里改。
t_api_hash_text() {
    local out
    out="$(curl -s -X POST "${BASE}/api/tools/hash-text" \
        -H 'Content-Type: application/json' \
        -d '{"text":"abc","algorithm":"sha256"}')"
    [ "$(json_path "${out}" '.ok')" = "true" ] \
        || fail "成功信封的 ok 不是 true: ${out}"
    [ "$(json_path "${out}" '.data.output')" = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" ] \
        || fail "摘要算错了: ${out}"
    [ "$(json_path "${out}" '.data.meta.algorithm')" = "sha256" ] \
        || fail "data.meta.algorithm 不对: ${out}"
}

t_api_hash_text_all_algorithms() {
    local out
    out="$(curl -s -X POST "${BASE}/api/tools/hash-text" \
        -H 'Content-Type: application/json' -d '{"text":"abc"}')"
    [ "$(json_path "${out}" '.data.table.md5')" = "900150983cd24fb0d6963f7d28e17f72" ] \
        || fail "没有一次算完所有算法: ${out}"
    # table / rows 两个键都点名 —— 键名改了这里会红，前端那边也得跟着改
    [ -n "$(json_path "${out}" '.data.table')" ] || fail "信封里没有 data.table: ${out}"
    [ -n "$(json_path "${out}" '.data.rows')" ] || fail "信封里没有 data.rows: ${out}"
}

t_api_invalid_input_is_400() {
    local code out
    out="$(curl -s -X POST "${BASE}/api/tools/hash-text" \
        -H 'Content-Type: application/json' \
        -d '{"text":"abc","algorithm":"nope"}')"
    code="$(http_code -X POST "${BASE}/api/tools/hash-text" \
        -H 'Content-Type: application/json' \
        -d '{"text":"abc","algorithm":"nope"}')"
    [ "${code}" = "400" ] || fail "非法输入返回 ${code}"
    [ "$(json_path "${out}" '.ok')" = "false" ] \
        || fail "错误信封的 ok 不是 false: ${out}"
    [ "$(json_path "${out}" '.error.kind')" = "invalid input" ] \
        || fail "错误信封里没有 error.kind: ${out}"
    [ "$(json_path "${out}" '.error.message')" = "Unsupported algorithm: nope" ] \
        || fail "错误消息不对: ${out}"
}

t_api_unknown_endpoint_is_404() {
    local code
    code="$(http_code -X POST "${BASE}/api/tools/no-such-tool" \
        -H 'Content-Type: application/json' -d '{}')"
    [ "${code}" = "404" ] || fail "不存在的接口返回 ${code}"
}

t_jwt_algorithms() {
    local out
    out="$(curl -s "${BASE}/api/jwt/algorithms")"
    grep -q 'HS256' <<<"${out}" || fail "算法表里没有 HS256: ${out}"
}

t_jwt_sign() {
    local out
    out="$(curl -s -X POST "${BASE}/api/jwt/sign" \
        -H 'Content-Type: application/json' \
        -d '{"alg":"HS256","payload":"{\"sub\":\"42\"}","secret":"s3cret"}')"
    grep -q '"token"' <<<"${out}" || fail "签名没返回 token: ${out}"
}

run_test "hash-text 算摘要"              t_api_hash_text
run_test "hash-text 一次算完所有算法"    t_api_hash_text_all_algorithms
run_test "非法输入 400 + 错误信封"       t_api_invalid_input_is_400
run_test "不存在的接口 404"              t_api_unknown_endpoint_is_404
run_test "JWT 算法表"                    t_jwt_algorithms
run_test "JWT 签名"                      t_jwt_sign

echo ""
echo "--- 语言协商 ---"

t_accept_language() {
    local body
    body="$(curl -s -H 'Accept-Language: zh-CN,zh;q=0.9' "${BASE}/")"
    grep -q '<html lang="zh-CN"' <<<"${body}" || fail "Accept-Language 没生效"
}

t_lang_query_beats_accept_language() {
    local body
    body="$(curl -s -H 'Accept-Language: en-US,en;q=0.9' "${BASE}/?lang=zh-CN")"
    grep -q '<html lang="zh-CN"' <<<"${body}" || fail "?lang= 没压过 Accept-Language"
}

t_lang_cookie() {
    local body
    body="$(curl -s -H 'Accept-Language: en-US,en;q=0.9' -H 'Cookie: lang=zh-CN' "${BASE}/")"
    grep -q '<html lang="zh-CN"' <<<"${body}" || fail "Cookie 没生效"
}

run_test "Accept-Language 协商语言"      t_accept_language
run_test "?lang= 压过 Accept-Language"   t_lang_query_beats_accept_language
run_test "Cookie 里的语言"               t_lang_cookie

echo ""
echo "--- 命令行 ---"

t_cli_help() {
    "${BINARY}" --help | grep -q -- '--port' || fail "--help 里没有 --port"
}

t_cli_version() {
    "${BINARY}" --version | grep -q 'it-tools' || fail "--version 的输出不对"
}

t_shuts_down_on_sigterm() {
    # 收 SIGTERM 要收得住 —— 容器编排（docker stop / k8s）就靠这个。
    # 这里另起一个进程试，不动正在跑的那个。
    local port pid code
    port=$((PORT + 1))
    "${BINARY}" --host "${HOST}" --port "${port}" --lang en >"${WORKDIR}/sigterm.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 40); do
        code="$(http_code "http://${HOST}:${port}/healthz")"
        [ "${code}" = "200" ] && break
        sleep 0.25
    done
    kill -TERM "${pid}" 2>/dev/null || true
    for _ in $(seq 1 40); do
        if ! kill -0 "${pid}" 2>/dev/null; then
            wait "${pid}" 2>/dev/null || true
            return 0
        fi
        sleep 0.25
    done
    kill -KILL "${pid}" 2>/dev/null || true
    fail "收到 SIGTERM 之后进程还活着"
}

run_test "--help"                        t_cli_help
run_test "--version"                     t_cli_version
run_test "SIGTERM 能收得住"              t_shuts_down_on_sigterm

# --- 收尾 -----------------------------------------------------------------

echo ""
echo "--- 结果 ---"
echo "通过 ${PASSED}，失败 ${FAILED}"
if [ "${FAILED}" -ne 0 ]; then
    echo "服务日志："
    tail -30 "${WORKDIR}/server.log"
    exit 1
fi
exit 0
