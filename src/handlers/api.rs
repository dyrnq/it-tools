//! `/api/*` 接口层。
//!
//! 所有走服务端的工具共用一个入口：`POST /api/tools/{endpoint}`，
//! 由 [`crate::tools::dispatch`] 分发到具体实现。新增 API 工具无需改动本文件，
//! 只需在 `tools::dispatch` 里注册一行。

use actix_web::http::StatusCode;
use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::{json, Value};

use crate::registry;
use crate::tools::{self, ToolError};

use super::query_param;

/// `POST /api/tools/{endpoint}`
///
/// 接受 JSON / urlencoded / multipart 三种提交格式，统一入口。
pub async fn tool_endpoint(
    req: HttpRequest,
    endpoint: web::Path<String>,
    payload: web::Payload,
) -> HttpResponse {
    let endpoint = endpoint.into_inner();

    // 只接受注册表里声明为 Api 的工具
    let Some(tool) = registry::TOOLS.iter().find(|t| {
        t.impl_kind
            .api_spec()
            .is_some_and(|s| s.endpoint == endpoint)
    }) else {
        return error(StatusCode::NOT_FOUND, "unknown tool", &endpoint);
    };

    let content_type = req
        .headers()
        .get(actix_web::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let value = if content_type.starts_with("multipart/form-data") {
        // 文件类工具（pdf-signature-checker）走这条路。
        // 只取第一个文件字段的原始字节，包成 `{"file": "<base64>"}` 交给 handler ——
        // handler 要的是 PDF 的字节本身，不是 multipart 的结构细节。
        match read_multipart_file(&req, payload).await {
            Ok(bytes) => json!({ "file": base64_encode(&bytes) }),
            Err(msg) => return error(StatusCode::BAD_REQUEST, "invalid input", &msg),
        }
    } else {
        // body 只读一次：按 Content-Type 决定怎么解析
        let bytes = match web::Payload::to_bytes(payload).await {
            Ok(b) => b,
            Err(e) => {
                let msg = e.to_string();
                return error(StatusCode::BAD_REQUEST, "cannot read body", &msg);
            }
        };
        if content_type.starts_with("application/x-www-form-urlencoded") {
            parse_form(&bytes)
        } else {
            parse_json(&bytes)
        }
    };

    // 把请求语言塞进 payload，工具实现靠它挑结果表的表头文案。
    //
    // 优先级与页面本身一致（`?lang=` > Cookie > Accept-Language > 英文），
    // 否则会出现「页面是中文、工具输出却是英文」这种半截翻译。
    let cookie = req.cookie("lang").map(|c| c.into_owned());
    let lang = crate::i18n::negotiate(
        query_param(req.query_string(), "lang").as_deref(),
        cookie.as_ref().map(|c| c.value()),
        req.headers()
            .get(actix_web::http::header::ACCEPT_LANGUAGE)
            .and_then(|v| v.to_str().ok()),
        crate::i18n::FALLBACK,
    );
    let value = with_lang(value, &lang);

    match tools::dispatch(&endpoint, value).await {
        Some(Ok(result)) => HttpResponse::Ok()
            .content_type("application/json; charset=utf-8")
            .json(json!({ "ok": true, "data": result })),
        Some(Err(ToolError::Internal(msg))) => {
            log::error!("工具 {} 执行失败: {msg}", tool.slug);
            error(StatusCode::INTERNAL_SERVER_ERROR, "internal error", &msg)
        }
        // 其余都是「输入不合法」：文案在语言包里，按请求语言渲染。
        Some(Err(e)) => error(StatusCode::BAD_REQUEST, "invalid input", &e.localize(&lang)),
        None => error(
            StatusCode::NOT_IMPLEMENTED,
            "not implemented",
            &format!("{endpoint} 尚未实现"),
        ),
    }
}

/// `POST /api/jwt/{action}`
///
/// JWT 的签名 / 验签 / 密钥生成 / 密钥格式转换。`action` 取
/// `sign` · `verify` · `keygen` · `convert`。
///
/// 与 `/api/tools/{endpoint}` 分开是因为那一条只放注册表里声明为 Api 的工具，
/// 而 JWT 这套密码学是给 JS 工具（jwt-generator / jwt-parser）调用的，
/// 界面不是通用表单。
///
/// 密钥材料只在请求体与响应体里来回走，**不写进日志**。
pub async fn jwt_endpoint(
    req: HttpRequest,
    action: web::Path<String>,
    payload: web::Payload,
) -> HttpResponse {
    let action = action.into_inner();

    let bytes = match web::Payload::to_bytes(payload).await {
        Ok(b) => b,
        Err(e) => {
            let msg = e.to_string();
            return error(StatusCode::BAD_REQUEST, "cannot read body", &msg);
        }
    };
    let value = parse_json(&bytes);

    // 错误文案也要按请求语言渲染 —— 前端把 `error.message` 原样显示出来，
    // 英文界面下冒出一句中文就是半截翻译。
    let cookie = req.cookie("lang").map(|c| c.into_owned());
    let lang = crate::i18n::negotiate(
        query_param(req.query_string(), "lang").as_deref(),
        cookie.as_ref().map(|c| c.value()),
        req.headers()
            .get(actix_web::http::header::ACCEPT_LANGUAGE)
            .and_then(|v| v.to_str().ok()),
        crate::i18n::FALLBACK,
    );

    match crate::tools::jwt::handle(&action, value).await {
        Ok(result) => HttpResponse::Ok()
            .content_type("application/json; charset=utf-8")
            .json(json!({ "ok": true, "data": result })),
        Err(ToolError::Internal(msg)) => {
            // 只记错误本身，不记请求体 —— 请求体里可能有私钥
            log::error!("jwt/{action} 执行失败: {msg}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "internal error", &msg)
        }
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid input", &e.localize(&lang)),
    }
}

/// `GET /api/jwt/algorithms` —— 支持的算法清单。
///
/// 前端的下拉框从这里取，算法表只有一份（服务端的）。
pub async fn jwt_algorithms() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("application/json; charset=utf-8")
        .json(json!({ "ok": true, "data": crate::tools::jwt::algorithms() }))
}

/// 读 multipart 上传的**第一个文件字段**的原始字节。
///
/// 只取第一个是有意的：注册表里目前只有 `pdf-signature-checker` 一个文件字段，
/// 而 `FieldKind::File` 也不支持多文件。真要支持多文件时，应该在这里按字段名
/// 挑，而不是无脑拿第一个 —— 顺序依赖多文件会变成一个很难查的 bug。
///
/// `payload` 是 move 进来的，所以 multipart 分支和 JSON 分支天然互斥：
/// 流只能被消费一次，`Multipart::new` 自己从 Content-Type 里解析 boundary，
/// 解析不了会把错误作为流的第一个 item 抛出来，这里统一变成 400。
async fn read_multipart_file(req: &HttpRequest, payload: web::Payload) -> Result<Vec<u8>, String> {
    use futures_util::TryStreamExt;

    // actix-web 的 PayloadConfig 默认限制 64MB，这里不额外收窄。
    // PDF 签名检查读的是签名结构本身，不会把整个文件解到内存里做全量渲染。
    let mut mp = actix_multipart::Multipart::new(req.headers(), payload.into_inner());
    while let Some(mut field) = mp.try_next().await.map_err(|e| e.to_string())? {
        let is_file = field
            .content_disposition()
            .and_then(|cd| cd.get_filename())
            .is_some();
        if !is_file {
            // 非文件字段也要把内容读完，否则流的位置会错乱
            while field.try_next().await.map_err(|e| e.to_string())?.is_some() {}
            continue;
        }
        let mut buf = Vec::new();
        while let Some(chunk) = field.try_next().await.map_err(|e| e.to_string())? {
            buf.extend_from_slice(&chunk);
        }
        if buf.is_empty() {
            return Err("上传的文件为空".to_string());
        }
        return Ok(buf);
    }
    Err("请求里没有文件字段".to_string())
}

/// 标准 base64（`+` `/`，带 `=` 填充）。PDF 字节经 JSON 传输会膨胀约 4/3，
/// 所以上传上限要按 base64 之后的长度算，不是原始文件大小。
fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 客户端语言包。`static/js/app.js` 里的 `ItTools.i18n()` 读这个全局变量。
///
/// 单独出一个 `/i18n.js` 而不是内联进页面，是为了让语言切换后
/// 浏览器直接换文件重新拉取，页面本身不必重新加载。
///
/// 语言来源的优先级必须和页面一致（`?lang=` > Cookie > Accept-Language > 默认），
/// 否则会出现「页面是中文、工具里的文案却是英文」这种半截翻译 ——
/// 页面上的文字是服务端渲染的，工具里的文字是这个文件里的，两边得是同一个语言。
pub async fn i18n_js(req: HttpRequest) -> HttpResponse {
    let cookie = req.cookie("lang").map(|c| c.into_owned());
    let lang = crate::i18n::negotiate(
        query_param(req.query_string(), "lang").as_deref(),
        cookie.as_ref().map(|c| c.value()),
        req.headers()
            .get(actix_web::http::header::ACCEPT_LANGUAGE)
            .and_then(|v| v.to_str().ok()),
        crate::i18n::FALLBACK,
    );
    // serde_json 负责引号与转义；这里以独立 .js 文件提供，不存在 `</script>` 截断问题
    let body = format!(
        "window.__IT_TOOLS_I18N__={};",
        serde_json::to_string(&crate::i18n::ui_bundle(&lang)).unwrap_or_else(|_| "{}".into())
    );
    HttpResponse::Ok()
        .content_type("application/javascript; charset=utf-8")
        // 语言包内容很少变，但语言一换文件名不变，需要能重新校验
        .insert_header((
            actix_web::http::header::CACHE_CONTROL,
            "public, max-age=300",
        ))
        .body(body)
}

/// 搜索索引：命令面板与首页收藏区的数据源
pub async fn registry_json(req: HttpRequest) -> HttpResponse {
    // Cookie 必须先转成 owned，borrow 的生命周期才够长到传进 negotiate。
    let cookie = req.cookie("lang").map(|c| c.into_owned());
    let lang = crate::i18n::negotiate(
        None,
        cookie.as_ref().map(|c| c.value()),
        req.headers()
            .get(actix_web::http::header::ACCEPT_LANGUAGE)
            .and_then(|v| v.to_str().ok()),
        "en",
    );
    let nav = crate::handlers::view::nav_view(&lang);
    HttpResponse::Ok()
        .content_type("application/json; charset=utf-8")
        .json(json!({
            "lang": lang,
            "tools": nav.search,
        }))
}

fn error(status: StatusCode, kind: &str, detail: &str) -> HttpResponse {
    HttpResponse::build(status)
        .content_type("application/json; charset=utf-8")
        .json(json!({
            "ok": false,
            "error": { "kind": kind, "message": detail }
        }))
}

/// 把请求语言写进 payload 的 `__lang` 键。
///
/// 工具实现拿不到 `HttpRequest`，读不到 `Accept-Language` 与 Cookie ——
/// 结果表的表头文案要按语言挑，只能靠这个键把它传下去。
///
/// payload 不是对象时（比如手写请求把 body 写成 `[]`）包一层再塞：
/// 那样工具那边拿到的是「一个只有语言的空表单」，而不是 panic。
fn with_lang(mut value: Value, lang: &str) -> Value {
    if !value.is_object() {
        value = json!({});
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            crate::tools::util::LANG_KEY.to_string(),
            Value::String(lang.to_string()),
        );
    }
    value
}

fn parse_json(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        return json!({});
    }
    serde_json::from_slice(bytes).unwrap_or_else(|e| json!({ "__parse_error": e.to_string() }))
}

fn parse_form(bytes: &[u8]) -> Value {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return json!({});
    };
    Value::Object(
        url_decode_pairs(text)
            .into_iter()
            .map(|(k, v)| (k, json!(v)))
            .collect(),
    )
}

/// `a=1&b=2` 解析
fn url_decode_pairs(input: &str) -> Vec<(String, String)> {
    input
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let mut it = pair.splitn(2, '=');
            let k = it.next()?;
            let v = it.next().unwrap_or("");
            Some((percent_decode(k), percent_decode(v)))
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `/i18n.js` 是 `ItTools.i18n()` 的唯一数据源，缺了它前端会静默退回英文，
    /// 所以在这里守住「键是裸名（无 `ui.` 前缀）」和「按请求语言返回」两件事。
    #[actix_web::test]
    async fn i18n_js_serves_bare_keys_in_negotiated_language() {
        use actix_web::body::to_bytes;
        use actix_web::test::TestRequest;

        let resp = i18n_js(
            TestRequest::default()
                .insert_header(("Accept-Language", "zh-CN,zh;q=0.9"))
                .to_http_request(),
        )
        .await;
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get(actix_web::http::header::CONTENT_TYPE)
                .unwrap(),
            "application/javascript; charset=utf-8"
        );
        let body = to_bytes(resp.into_body()).await.unwrap();
        let js = String::from_utf8(body.to_vec()).unwrap();

        assert!(js.starts_with("window.__IT_TOOLS_I18N__="), "缺少全局赋值");
        let json = js
            .trim_start_matches("window.__IT_TOOLS_I18N__=")
            .trim_end_matches(';');
        let map: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(map["copy"], "复制");
        assert_eq!(map["output"], "输出");
        // 必须是裸键，前端按 i18n('copy', ...) 查
        assert!(map.get("ui.copy").is_none(), "不应带 ui. 前缀");
        let obj = map.as_object().unwrap();
        // 只下发 ui. 段：不该混进 tools.<slug>.title 这类工具元数据。
        //
        // 键里带点号是**允许**的：JS 工具的界面文案按 ui.tool.<slug>.<用途> 分层
        // （`tool.text-to-nato-alphabet.input` 之类），前端是拿整个字符串当键查的
        // ——i18n('tool.xxx.yyy', '英文兜底')——不是逐段下钻，所以点号只是名字的一部分。
        // 真正要守住的是「tools.* 那一段没被顺带下发」。
        assert!(
            obj.keys().all(|k| !k.starts_with("tools.")),
            "混进了工具元数据: {:?}",
            obj.keys().filter(|k| k.starts_with("tools.")).collect::<Vec<_>>()
        );
        // 分层的工具文案确实在包里（前端按这条键取）
        assert_eq!(
            map["tool.text-to-nato-alphabet.input"],
            "要转成拼读字母表的文本"
        );
        // 条数用中英两版互相对齐来钉，而不是写死一个魔数 ——
        // 写死的话每加一条文案就得改一次断言，久了就没人愿意加了。
        let en = crate::i18n::ui_bundle(crate::i18n::FALLBACK);
        assert_eq!(obj.len(), en.len(), "zh 与 en 的 ui. 条数应一致");
        assert_eq!(map["toggle_category"], "折叠/展开分类");
    }

    /// `?lang=` 要压过 Cookie 与 Accept-Language。
    ///
    /// 页面上的文字是服务端渲染的（按同一个 `?lang=` 选语言），工具里的文字来自
    /// 这个文件 —— 两边必须是同一种语言。语言下拉会同时写 cookie，所以正常操作
    /// 下两边一致；但分享出去的链接只有 query 参数，没有 cookie，这时
    /// 「页面中文、工具英文」就露出来了。
    #[actix_web::test]
    async fn i18n_js_honours_the_lang_query_param() {
        use actix_web::body::to_bytes;
        use actix_web::test::TestRequest;

        let resp = i18n_js(
            TestRequest::default()
                .uri("/i18n.js?lang=zh-CN")
                .insert_header(("Accept-Language", "en-US,en;q=0.9"))
                .to_http_request(),
        )
        .await;
        let body = to_bytes(resp.into_body()).await.unwrap();
        let js = String::from_utf8(body.to_vec()).unwrap();
        let json = js
            .trim_start_matches("window.__IT_TOOLS_I18N__=")
            .trim_end_matches(';');
        let map: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(map["copy"], "复制");
    }

    /// 反过来：没有 `?lang=` 时仍按 Accept-Language 走（老行为不能坏）。
    #[actix_web::test]
    async fn i18n_js_falls_back_to_accept_language() {
        use actix_web::body::to_bytes;
        use actix_web::test::TestRequest;

        let resp = i18n_js(
            TestRequest::default()
                .insert_header(("Accept-Language", "zh-CN,zh;q=0.9"))
                .to_http_request(),
        )
        .await;
        let body = to_bytes(resp.into_body()).await.unwrap();
        let js = String::from_utf8(body.to_vec()).unwrap();
        let json = js
            .trim_start_matches("window.__IT_TOOLS_I18N__=")
            .trim_end_matches(';');
        let map: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(map["copy"], "复制");
    }

    /// 语言包可以只译一部分 —— `i18n::t()` 逐键回退的前提。
    ///
    /// 客户端这边同理：`/i18n.js` 下发的键少没关系，前端 `i18n(key, fallback)`
    /// 拿不到就用 JS 源码里写着的英文兜底。但**下发的键不能比英文多** ——
    /// 多出来的键在英文语言包里没有对应文案，回退时无处可退，
    /// 页面上露出来的就是一个没人认得的键名。
    #[actix_web::test]
    async fn partial_language_bundles_stay_a_subset_of_english() {
        use actix_web::body::to_bytes;
        use actix_web::test::TestRequest;

        let en = crate::i18n::ui_bundle(crate::i18n::FALLBACK);
        for &(code, _) in crate::i18n::AVAILABLE {
            let resp = i18n_js(
                TestRequest::default()
                    .uri(&format!("/i18n.js?lang={code}"))
                    .to_http_request(),
            )
            .await;
            let body = to_bytes(resp.into_body()).await.unwrap();
            let js = String::from_utf8(body.to_vec()).unwrap();
            let json = js
                .trim_start_matches("window.__IT_TOOLS_I18N__=")
                .trim_end_matches(';');
            let map: serde_json::Value = serde_json::from_str(json).unwrap();
            let obj = map.as_object().expect("语言包该是个对象");
            for key in obj.keys() {
                assert!(
                    en.contains_key(key),
                    "{code} 的语言包里有 {key}，英文语言包里没有 —— 页面会露出键名"
                );
            }
            // 译文不能就是键名本身：那正是「没译」的样子
            for (key, value) in obj {
                let text = value.as_str().unwrap_or_default();
                assert_ne!(text, key, "{code} 的 {key} 的值就是键名 —— 这条没译");
            }
        }
    }

    /// 语言表里登记了的语言，**界面框架**得真的译过。
    ///
    /// 逐键回退既是语言包好用的地方，也是它危险的地方：语言包忘了合并、
    /// 或者合并进来的是空的，页面会**整页退回英文**，而且不报任何错 ——
    /// 加了语言、编译通过、页面照常渲染，只是全变成了英文。
    /// 所以这里钉住：框架那批键（`ui.*` 里除工具文案以外的那些）
    /// 在每个语言里都得在，而且得是它自己的译文。
    #[actix_web::test]
    async fn every_language_translates_the_chrome_itself() {
        use actix_web::body::to_bytes;
        use actix_web::test::TestRequest;

        let en = crate::i18n::ui_bundle(crate::i18n::FALLBACK);
        // 框架的键 = `ui.*` 但不是 `ui.tool.*`（后者是各个工具自己的文案，可以只译一部分）
        let chrome: Vec<&String> = en.keys().filter(|k| !k.starts_with("tool.")).collect();
        assert!(chrome.len() > 20, "框架的键只有 {} 条 —— 扫描多半没对上", chrome.len());

        for &(code, _) in crate::i18n::AVAILABLE {
            let resp = i18n_js(
                TestRequest::default()
                    .uri(&format!("/i18n.js?lang={code}"))
                    .to_http_request(),
            )
            .await;
            let body = to_bytes(resp.into_body()).await.unwrap();
            let js = String::from_utf8(body.to_vec()).unwrap();
            let json = js
                .trim_start_matches("window.__IT_TOOLS_I18N__=")
                .trim_end_matches(';');
            let map: serde_json::Value = serde_json::from_str(json).unwrap();

            let missing: Vec<&&String> = chrome.iter().filter(|k| !map.get(**k).is_some()).collect();
            assert!(
                missing.is_empty(),
                "{code} 的语言包缺这几条框架文案（{} 条）：\n  {}",
                missing.len(),
                missing
                    .iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>()
                    .join("\n  ")
            );
            if code != "en" {
                // 框架文案得是这个语言自己的，不能整段照抄英文。
                //
                // 例外是**品牌名**：`site_name` 是 "IT - TOOLS"，
                // 产品叫这个名字，各语言都这么叫 —— 译了反而不对。
                //
                // 另外有些词在两种语言里本来就长得一样（法语的 "Sources"、
                // 西语的 "Error"），所以不能要求「一条都不许相同」，
                // 只要求**大部分**是译过的：整段照抄英文才是真问题。
                const BRAND: &[&str] = &["site_name"];
                let untranslated: Vec<&&String> = chrome
                    .iter()
                    .filter(|k| !BRAND.contains(&k.as_str()))
                    .filter(|k| map.get(**k) == en.get(**k))
                    .collect();
                let translatable = chrome.len() - BRAND.len();
                assert!(
                    untranslated.len() * 5 <= translatable,
                    "{code} 的框架文案有 {} 条没译（总共 {} 条可译）：\n  {}",
                    untranslated.len(),
                    translatable,
                    untranslated
                        .iter()
                        .map(|k| k.as_str())
                        .collect::<Vec<_>>()
                        .join("\n  ")
                );
            }
        }
    }

    #[test]
    fn parses_urlencoded_pairs() {
        let got = url_decode_pairs("text=hello+world&algorithm=sha256&n=");
        assert_eq!(got[0], ("text".into(), "hello world".into()));
        assert_eq!(got[1], ("algorithm".into(), "sha256".into()));
        assert_eq!(got[2], ("n".into(), String::new()));
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%20b%2Bc"), "a b+c");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn empty_body_is_empty_object() {
        assert_eq!(parse_json(b""), json!({}));
        assert_eq!(parse_form(b""), json!({}));
    }
}
