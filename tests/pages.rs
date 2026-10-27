//! 页面的集成测试：路由表、静态资源、重定向、语言协商。
//!
//! 打的是**整个 App**（跟线上跑的是同一份装配），不是单个 handler ——
//! 「这个 URL 到底返回什么」这种事，只有把路由表整个装起来才问得出来。

mod common;

use actix_web::http::StatusCode;
use actix_web::test::TestRequest;
use actix_web::test::{call_service, read_body};
use common::init_app;
use it_tools::registry::TOOLS;

#[actix_web::test]
async fn home_page_lists_every_tool() {
    let app = init_app!();
    let resp = call_service(&app, TestRequest::get().uri("/").to_request()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()
            .get(actix_web::http::header::CONTENT_TYPE)
            .unwrap(),
        "text/html; charset=utf-8"
    );

    let body = common::text(resp).await;
    // 每个工具一张卡片，一张不多一张不少
    assert_eq!(body.matches(r#"class="tool-card""#).count(), TOOLS.len());
    assert!(body.contains(r#"<html lang="en""#));
}

#[actix_web::test]
async fn about_page_renders() {
    let app = init_app!();
    let resp = call_service(&app, TestRequest::get().uri("/about").to_request()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = common::text(resp).await;
    assert!(body.contains("GPL-3.0"), "关于页里没有许可证声明");
}

/// 健康检查只回答「活着吗」，**不带工具数量**。
///
/// 数量是统计项：加了工具就得回来改一处，而健康检查根本不需要知道有多少工具。
/// 所以这里盯的是「payload 里只有 ok 一个字段」—— 哪天又混进统计项，测试会红。
#[actix_web::test]
async fn healthz_only_says_ok() {
    let app = init_app!();
    let resp = call_service(&app, TestRequest::get().uri("/healthz").to_request()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = common::json(resp).await;
    assert_eq!(json["ok"], true);
    let obj = json.as_object().expect("健康检查该是个 JSON 对象");
    assert_eq!(obj.len(), 1, "健康检查只该有 ok 一个字段，实际：{json}");
}

#[actix_web::test]
async fn registry_json_is_the_search_index() {
    let app = init_app!();
    let resp = call_service(&app, TestRequest::get().uri("/registry.json").to_request()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = common::json(resp).await;
    let tools = json["tools"].as_array().expect("tools 该是数组");
    assert_eq!(tools.len(), TOOLS.len());
    // 每一项都要带搜索要用的字段 —— 命令面板和首页收藏区都吃这份数据
    for entry in tools {
        for key in ["path", "name", "description", "category", "icon", "keywords"] {
            assert!(!entry[key].is_null(), "搜索条目缺 {key}: {entry}");
        }
    }
}

/// 命令面板的条目数据（首页内嵌的那份 JSON）必须带 **path**。
///
/// app.js 就是照着 `path` 拼跳转链接的（static/js/app.js 的 renderGroup）。
/// 两边字段名对不上时，面板里的条目会变成「点了没反应」的按钮 ——
/// 而首页看上去一切正常，面板也照常打开、结果照常列出来。
/// 这一条就是那道缝的守门人。
#[actix_web::test]
async fn the_palette_entries_carry_the_path_the_javascript_expects() {
    let app = init_app!();
    let resp = call_service(&app, TestRequest::get().uri("/").to_request()).await;
    let body = common::text(resp).await;
    const OPEN: &str = r#"<script id="palette-data" type="application/json">"#;
    let start = body.find(OPEN).expect("首页里没有 palette-data");
    let rest = &body[start + OPEN.len()..];
    let end = rest.find("</script>").expect("palette-data 没有闭合");
    let entries: serde_json::Value =
        serde_json::from_str(&rest[..end]).expect("palette-data 该是 JSON");
    let list = entries.as_array().expect("palette-data 该是数组");
    assert_eq!(list.len(), TOOLS.len(), "面板里的条目数该跟工具数一样");

    for entry in list {
        let path = entry["path"]
            .as_str()
            .unwrap_or_else(|| panic!("面板条目缺 path: {entry}"));
        assert!(
            TOOLS.iter().any(|t| t.path == path),
            "面板条目指向了一个不存在的工具: {path}"
        );
    }
}

/// 日期转换页在输入框**空着**的时候要每秒刷新一次。
///
/// 参考实现里那一格显示的是「此刻」，而且是**跳着的**（VueUse 的 `useNow`）：
/// 空着输入框时连采五帧，每秒一格；填了值就换成解析出来的时刻，不再跳。
/// 我们这边结果是服务端算的，所以「跳」由前端定时再问一次服务端来实现
/// （见 `static/js/app.js` 的 `initApiForm`）。
#[actix_web::test]
async fn the_date_converter_refreshes_itself_while_the_input_is_empty() {
    let app = init_app!();
    let resp = call_service(&app, TestRequest::get().uri("/date-converter").to_request()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = common::text(resp).await;
    assert!(body.contains(r#"data-refresh="1000""#), "页面没带刷新间隔");
    assert!(
        body.contains(r#"data-refresh-field="date""#),
        "页面没带刷新字段"
    );
}

/// 别的工具不该带定时刷新 —— 白跳的请求是最难查的那种浪费。
#[actix_web::test]
async fn other_tools_do_not_refresh_on_a_timer() {
    let app = init_app!();
    for path in ["/hash-text", "/hmac-generator", "/bcrypt"] {
        let resp = call_service(&app, TestRequest::get().uri(path).to_request()).await;
        let body = common::text(resp).await;
        assert!(!body.contains("data-refresh"), "{path} 不该有定时刷新");
    }
}

/// 每个注册在册的工具都要能打开自己的页面。
///
/// 这一条是「注册表 ↔ 页面」之间那道缝的守门人：注册表加了一条工具，
/// 忘了写进页面，或者 slug 跟路由对不上，页面就会 404 —— 而这在
/// 首页上完全看不出来（首页照样列出它，点进去才发现是死的）。
#[actix_web::test]
async fn every_tool_page_renders() {
    let app = init_app!();
    for tool in TOOLS {
        let resp = call_service(&app, TestRequest::get().uri(tool.path).to_request()).await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "{} 打不开",
            tool.path
        );
        let body = common::text(resp).await;
        assert!(
            body.contains(&format!(r#"data-slug="{}""#, tool.slug)),
            "{} 的页面里没有自己的 slug",
            tool.path
        );
    }
}

#[actix_web::test]
async fn js_tool_page_links_its_module() {
    let app = init_app!();
    let resp = call_service(
        &app,
        TestRequest::get().uri("/case-converter").to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = common::text(resp).await;
    assert!(body.contains(r#"data-tool-script="/assets/js/tools/case-converter.js""#));
    assert!(body.contains(r#"src="/assets/js/tools/case-converter.js""#));
}

#[actix_web::test]
async fn api_tool_page_carries_its_endpoint() {
    let app = init_app!();
    let resp = call_service(&app, TestRequest::get().uri("/hash-text").to_request()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = common::text(resp).await;
    assert!(body.contains(r#"data-tool-api="/api/tools/hash-text""#));
    // 表单是服务端渲染的：不依赖 JS 也能看到输入框
    assert!(body.contains(r#"id="api-form""#));
    assert!(body.contains(r#"name="text""#));
}

/// slug 与路由名不同的那几个，路由要认 slug 也认路径。
#[actix_web::test]
async fn slug_different_from_path_still_resolves() {
    let app = init_app!();
    let resp = call_service(&app, TestRequest::get().uri("/json-prettify").to_request()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = common::text(resp).await;
    assert!(body.contains(r#"data-slug="json-viewer""#));
}

/// 旧路由别名：跳到新路由去。
///
/// `/hash` 这种是 303（见 `handlers::redirect_with_lang` ——
/// 顺带把语言 Cookie 一起带上）；`/redirect/hash` 那种是 301。
#[actix_web::test]
async fn legacy_paths_redirect_to_the_current_ones() {
    let app = init_app!();

    let resp = call_service(&app, TestRequest::get().uri("/hash").to_request()).await;
    assert_eq!(resp.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        resp.headers()
            .get(actix_web::http::header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap(),
        "/hash-text"
    );

    let resp = call_service(&app, TestRequest::get().uri("/redirect/hash").to_request()).await;
    assert_eq!(resp.status(), StatusCode::MOVED_PERMANENTLY);
    assert_eq!(
        resp.headers()
            .get(actix_web::http::header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap(),
        "/hash-text"
    );
}

#[actix_web::test]
async fn unknown_paths_are_404_pages() {
    let app = init_app!();
    for path in ["/no-such-tool", "/redirect/no-such-alias", "/assets/js/nope.js"] {
        let resp = call_service(&app, TestRequest::get().uri(path).to_request()).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{path} 不该是别的状态");
    }

    // 404 也要是一张能看的页面，而不是 actix 的默认白页
    let resp = call_service(&app, TestRequest::get().uri("/no-such-tool").to_request()).await;
    let body = common::text(resp).await;
    assert!(body.contains("404"), "404 页面里没有 404");
    assert!(body.contains("notfound"), "404 页面没渲染出来");
}

/// 静态资源要带 ETag，并且认 `If-None-Match`。
///
/// 缓存策略见 `handlers::assets` 的 CACHE_POLICY：一律回源协商，
/// 不发长缓存 —— 前提就是这条 304 的路走通了。
#[actix_web::test]
async fn static_assets_are_served_with_an_etag() {
    let app = init_app!();
    let resp = call_service(
        &app,
        TestRequest::get().uri("/assets/js/app.js").to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let etag = resp
        .headers()
        .get(actix_web::http::header::ETAG)
        .expect("静态资源该带 ETag")
        .to_str()
        .unwrap()
        .to_string();
    assert!(etag.starts_with('"'), "ETag 的形状不对: {etag}");
    assert_eq!(
        resp.headers()
            .get(actix_web::http::header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap(),
        "text/javascript"
    );

    let resp = call_service(
        &app,
        TestRequest::get()
            .uri("/assets/js/app.js")
            .insert_header(("If-None-Match", etag))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);
}

#[actix_web::test]
async fn head_requests_are_answered() {
    let app = init_app!();
    let resp = call_service(
        &app,
        TestRequest::default()
            .method(actix_web::http::Method::HEAD)
            .uri("/")
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
}

/// 语言协商：`?lang=` > Cookie > `Accept-Language` > 启动参数。
///
/// 优先级错了会出现「页面中文、工具英文」这种半截翻译 ——
/// 页面上的字是服务端渲染的，工具里的字来自 `/i18n.js`，两边各选各的。
#[actix_web::test]
async fn the_language_is_negotiated_per_request() {
    let app = init_app!();

    // Accept-Language
    let resp = call_service(
        &app,
        TestRequest::get()
            .uri("/")
            .insert_header(("Accept-Language", "zh-CN,zh;q=0.9"))
            .to_request(),
    )
    .await;
    let body = common::text(resp).await;
    assert!(body.contains(r#"<html lang="zh-CN""#));
    assert!(body.contains("加密"), "中文语言包没生效");

    // ?lang= 压过 Accept-Language
    let resp = call_service(
        &app,
        TestRequest::get()
            .uri("/?lang=zh-CN")
            .insert_header(("Accept-Language", "en-US,en;q=0.9"))
            .to_request(),
    )
    .await;
    let body = common::text(resp).await;
    assert!(body.contains(r#"<html lang="zh-CN""#));

    // Cookie 压过 Accept-Language
    let resp = call_service(
        &app,
        TestRequest::get()
            .uri("/")
            .insert_header(("Accept-Language", "en-US,en;q=0.9"))
            .insert_header(("Cookie", "lang=zh-CN"))
            .to_request(),
    )
    .await;
    let body = common::text(resp).await;
    assert!(body.contains(r#"<html lang="zh-CN""#));
}

/// 工具接口只收 POST，GET 应该是 405 而不是 404 —— 路由挂错了位置的话
/// 表现也是「打不开」，但 405 说明路由在、只是方法不对。
#[actix_web::test]
async fn api_endpoints_reject_the_wrong_method() {
    let app = init_app!();
    let resp = call_service(
        &app,
        TestRequest::get().uri("/api/tools/hash-text").to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
}

/// 客户端语言包跟页面必须是同一种语言。
#[actix_web::test]
async fn the_client_bundle_follows_the_same_language() {
    let app = init_app!();
    let resp = call_service(
        &app,
        TestRequest::get()
            .uri("/i18n.js?lang=zh-CN")
            .insert_header(("Accept-Language", "en-US,en;q=0.9"))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = common::text(resp).await;
    assert!(body.starts_with("window.__IT_TOOLS_I18N__="));
    let json = body
        .trim_start_matches("window.__IT_TOOLS_I18N__=")
        .trim_end_matches(';');
    let map: serde_json::Value = serde_json::from_str(json).expect("语言包该是 JSON");
    assert_eq!(map["copy"], "复制");
}

/// 页面正文里不能有没渲染的模板语法。
///
/// Tera 渲染失败时 `templates::render` 会返回 500 + "template error"，
/// 但**变量取不到**是另一回事：Tera 取不到就渲染成空字符串，页面看着
/// 少了一块，什么都不报错。所以这里扫一遍有没有 `{{` 漏到正文里。
#[actix_web::test]
async fn no_template_markup_leaks_into_the_page() {
    let app = init_app!();
    for path in ["/", "/about", "/hash-text", "/case-converter"] {
        let resp = call_service(&app, TestRequest::get().uri(path).to_request()).await;
        assert_eq!(resp.status(), StatusCode::OK, "{path} 打不开");
        let body = common::text(resp).await;
        assert!(
            !body.contains("{{"),
            "{path} 的正文里漏出了模板语法"
        );
        assert!(!body.contains("{%"), "{path} 的正文里漏出了模板语法");
    }
}

/// 响应体读出来必须是文本 —— 顺带盯住「页面返回了二进制」这类事故。
#[actix_web::test]
async fn the_home_page_is_served_as_text() {
    let app = init_app!();
    let resp = call_service(&app, TestRequest::get().uri("/").to_request()).await;
    let body = read_body(resp).await;
    assert!(body.starts_with(b"<!DOCTYPE html>"), "首页不是一段 HTML");
}
