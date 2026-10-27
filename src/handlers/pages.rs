//! 页面渲染：首页、工具页、关于页、404。

use actix_web::{web, HttpRequest, HttpResponse};
use serde::Serialize;
use serde_json::json;

use crate::handlers::view::{self, UiStrings};
use crate::i18n;
use crate::registry;
use crate::templates;
use crate::AppState;

/// 所有页面共用的模板上下文
/// 语言下拉的一项。Tera 的 `{% for a, b in ... %}` 只能解构对象/映射，
/// 解构不了元组，所以这里传对象数组而不是 `[("en", "English")]`。
#[derive(Debug, Clone, Serialize)]
pub struct Language {
    pub code: &'static str,
    pub label: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct Base {
    pub lang: String,
    pub title: String,
    pub description: String,
    pub ui: UiStrings,
    /// 可选语言，供语言下拉渲染
    pub languages: Vec<Language>,
    /// 侧栏 + 命令面板数据
    pub nav: view::NavView,
    pub is_dark: bool,
    pub current_path: String,
    /// 内联的 Tabler 图标雪碧图，`<symbol id="i-*">`
    pub icon_sprite: String,
    /// 命令面板的界面文案（Tera 不能写对象字面量，所以在 Rust 侧拼好）
    pub palette_i18n: serde_json::Value,
    /// 主题按钮的 tooltip：说的是「点下去会变成什么」，
    /// 所以浅色下是「深色模式」、深色下是「浅色模式」。
    /// 服务端只知道默认主题，实际主题由客户端 localStorage 决定，app.js 会再纠正一次。
    pub toggle_theme_label: String,
    /// 侧栏底部显示的版本号（取自 Cargo.toml）。
    pub version: &'static str,
    /// `ui.copyright` 是带 `{year}` 占位符的模板串，这里已经填好年份。
    pub copyright: String,
}

fn icon_sprite() -> String {
    static ONCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        crate::embed::StaticAsset::get("img/icons.svg")
            .map(|f| String::from_utf8_lossy(&f.data).into_owned())
            .unwrap_or_default()
    })
    .clone()
}

fn base(req: &HttpRequest, state: &AppState, lang: &str, title: &str, description: &str) -> Base {
    let ui = UiStrings::for_lang(lang);
    let nav = view::nav_view(lang);
    // tooltip 说「点下去会变成什么」，所以是当前主题的对面
    let toggle_theme_label = if state.default_dark {
        ui.light_mode.clone()
    } else {
        ui.dark_mode.clone()
    };
    // 侧栏底部的版权行：年份每次请求取当前年份（编译进二进制的年份会过期）
    let copyright = ui
        .copyright
        .replace("{year}", &chrono::Utc::now().format("%Y").to_string());
    Base {
        lang: lang.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        palette_i18n: ui.palette_labels(),
        toggle_theme_label,
        version: env!("CARGO_PKG_VERSION"),
        copyright,
        ui,
        languages: i18n::AVAILABLE
            .iter()
            .map(|(code, label)| Language { code, label })
            .collect(),
        nav,
        is_dark: state.default_dark,
        current_path: req.path().to_string(),
        icon_sprite: icon_sprite(),
    }
}

fn page_state(req: &HttpRequest, state: &AppState) -> String {
    super::resolve_lang(req, &state.settings)
}

/// 首页：收藏（客户端渲染）+ 全部工具
pub async fn index(req: HttpRequest, state: web::Data<AppState>) -> HttpResponse {
    let lang = page_state(&req, &state);

    let ui = UiStrings::for_lang(&lang);
    let ctx = json!({
        "page": "home",
        "base": base(&req, &state, &lang, &ui.site_name, &ui.tagline),
    });
    render(&state, "index.html", ctx)
}

/// 工具页（按 slug）。路由在 `app::tool_dispatch` 里由注册表解析，因此直接收 `String`。
pub async fn tool(req: HttpRequest, state: web::Data<AppState>, slug: String) -> HttpResponse {
    let lang = page_state(&req, &state);
    let Some(tool) = registry::by_slug(&slug) else {
        return not_found_page(&req, &state, &lang).await;
    };

    let tv = view::tool_view(tool, &lang);
    let ctx = json!({
        "page": "tool",
        "base": base(
            &req, &state, &lang,
            &format!("{} - IT Tools", tv.name),
            &tv.description,
        ),
        "tool": tv,
    });
    render(&state, "tool.html", ctx)
}

/// 关于页
pub async fn about(req: HttpRequest, state: web::Data<AppState>) -> HttpResponse {
    let lang = page_state(&req, &state);
    let title = format!("{} - IT Tools", i18n::t(&lang, "ui.about"));
    let ctx = json!({
        "page": "about",
        "base": base(&req, &state, &lang, &title, ""),
    });
    render(&state, "about.html", ctx)
}

/// 404 页面。模板本身渲染出来是 200，状态码在这里改成 404。
pub async fn not_found_page(req: &HttpRequest, state: &AppState, lang: &str) -> HttpResponse {
    let ctx = json!({
        "page": "404",
        "base": base(req, state, lang, "404 - IT Tools", ""),
    });
    let resp = render(state, "404.html", ctx);
    if resp.status().is_success() {
        HttpResponse::NotFound().body(resp.into_body())
    } else {
        resp
    }
}

fn render(state: &AppState, template: &str, ctx: serde_json::Value) -> HttpResponse {
    let tera_ctx = templates::context(&ctx);
    templates::render(&state.tera, template, &tera_ctx).unwrap_or_else(|e| {
        log::error!("页面渲染失败 ({template}): {e}");
        HttpResponse::InternalServerError().body("template error")
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::body::to_bytes;
    use actix_web::test::TestRequest;

    fn state() -> web::Data<AppState> {
        web::Data::new(AppState {
            settings: crate::settings::Settings {
                default_lang: "en".into(),
            },
            default_dark: true,
            tera: crate::templates::build().expect("模板应能全部加载"),
        })
    }

    async fn text(resp: HttpResponse) -> String {
        let body = to_bytes(resp.into_body()).await.unwrap();
        String::from_utf8(body.to_vec()).unwrap()
    }

    /// 取正文，并要求状态码是 200
    async fn html(resp: HttpResponse) -> String {
        let status = resp.status();
        let body = text(resp).await;
        assert_eq!(status, 200, "渲染失败：{body}");
        body
    }

    #[actix_web::test]
    async fn index_lists_every_tool() {
        let resp = index(TestRequest::default().to_http_request(), state()).await;
        let body = html(resp).await;
        // 每个工具只出现一张卡片 —— 首页不再有「最新工具」分区，
        // 所以 is_new 的工具也不再重复出现一次。
        assert_eq!(
            body.matches(r#"class="tool-card""#).count(),
            registry::TOOLS.len()
        );
        // 「最新工具」分区已被移除：它的标题文案不该再出现在首页上
        assert!(!body.contains("Newest tools"), "首页不该再渲染「最新工具」分区");
        assert!(body.contains("data-theme=\"dark\""));
        // hash-text 的图标是 eye-off，符号表与 <use> 都该出现
        assert!(body.contains(r##"<symbol id="i-eye-off""##));
        assert!(body.contains(r##"<use href="/assets/img/icons.svg#i-eye-off""##));
    }

    /// 「新」徽章必须真的渲染出来。
    ///
    /// 徽章由模板里的 `{% if card.is_new %}` 判断，键名一旦写成驼峰
    /// `card.isNew`，Tera 取不到这个键就会**静默地**什么都不渲染 ——
    /// 不报错、状态码 200、控制台干净，徽章就这么凭空消失了。
    /// 所以这里钉死：is_new 的工具一个都不能少。
    #[actix_web::test]
    async fn new_tools_carry_their_badge() {
        let resp = index(TestRequest::default().to_http_request(), state()).await;
        let body = html(resp).await;
        let is_new = registry::TOOLS.iter().filter(|t| t.is_new).count();
        assert!(is_new > 0, "注册表里得有 is_new 的工具，否则这条断言没意义");
        assert_eq!(
            body.matches(r#"class="badge-new""#).count(),
            is_new,
            "「新」徽章数量对不上 —— 模板里的键名多半又写错了"
        );
    }

    /// 页面与工具文案必须是同一种语言。
    ///
    /// 页面上的字是服务端渲染的，工具里的字来自 `/i18n.js` —— 两边各选各的语言，
    /// 就会出现「页面中文、工具英文」的半截翻译。所以模板里拉语言包时必须把
    /// 当前语言带上（`/i18n.js?lang=zh-CN`）。
    #[actix_web::test]
    async fn the_page_asks_for_the_language_pack_in_its_own_language() {
        for (lang, marker) in [("zh-CN", "大小写转换"), ("en", "Case converter")] {
            let resp = tool(
                TestRequest::default()
                    .uri(&format!("/case-converter?lang={lang}"))
                    .to_http_request(),
                state(),
                "case-converter".into(),
            )
            .await;
            let body = html(resp).await;
            assert!(
                body.contains(marker),
                "页面本身没有渲染成 {lang}（找 {marker:?}）"
            );
            assert!(
                body.contains(&format!(r#"src="/i18n.js?lang={lang}""#)),
                "语言包没有按 {lang} 来拉 —— 工具里的文案会跟页面不是一个语言"
            );
        }
    }

    #[actix_web::test]
    async fn api_tool_page_carries_its_endpoint() {
        let resp = tool(
            TestRequest::default().to_http_request(),
            state(),
            "hash-text".into(),
        )
        .await;
        let body = html(resp).await;
        assert!(body.contains(r#"data-tool-api="/api/tools/hash-text""#));
        // 服务端渲染了表单字段，不需要等 JS
        assert!(body.contains(r#"id="api-form""#));
        assert!(body.contains(r#"name="text""#));
    }

    #[actix_web::test]
    async fn js_tool_page_links_its_module() {
        let resp = tool(
            TestRequest::default().to_http_request(),
            state(),
            "case-converter".into(),
        )
        .await;
        let body = html(resp).await;
        assert!(body.contains(r#"data-tool-script="/assets/js/tools/case-converter.js""#));
        assert!(body.contains(r#"src="/assets/js/tools/case-converter.js""#));
    }

    #[actix_web::test]
    async fn slug_different_from_path_still_resolves() {
        // json-viewer 的路由名是 /json-prettify，两处都不能错
        let resp = index(TestRequest::default().to_http_request(), state()).await;
        assert!(html(resp).await.contains(r#"href="/json-prettify""#));

        let resp = tool(
            TestRequest::default().to_http_request(),
            state(),
            "json-viewer".into(),
        )
        .await;
        assert!(html(resp).await.contains("data-slug=\"json-viewer\""));
    }

    #[actix_web::test]
    async fn about_and_404_render() {
        let body = html(about(TestRequest::default().to_http_request(), state()).await).await;
        assert!(body.contains("GPL-3.0"));

        let resp = not_found_page(
            &TestRequest::default().to_http_request(),
            state().get_ref(),
            "en",
        )
        .await;
        assert_eq!(resp.status(), 404);
        assert!(text(resp).await.contains("404"));
    }

    #[actix_web::test]
    async fn language_is_negotiated_per_request() {
        let req = TestRequest::default()
            .insert_header(("Accept-Language", "zh-CN,zh;q=0.9"))
            .to_http_request();
        let body = html(index(req, state()).await).await;
        assert!(body.contains(r#"<html lang="zh-CN""#));
        assert!(body.contains("加密"), "中文语言包没生效");
        // 首页标题与 meta description 也必须走语言包，不能写死英文
        assert!(body.contains(r#"content="开发者 handy 工具箱""#));
        assert!(!body.contains(r#"content="Handy tools for developers""#));
    }

    /// 登记在册的每一种语言都要能把自己渲染出来。
    ///
    /// 语言表加了一条、却忘了放语言包 —— 这种事不会报错：协商照样协商到那个语言，
    /// 页面也照样渲染，只是**整页都是英文**。所以这里逐个语言看一眼：
    /// `html lang` 要对，页面里要出现该语言自己的 tagline，
    /// 而且不能漏出英文的 tagline。
    #[actix_web::test]
    async fn every_registered_language_renders_in_its_own_language() {
        for &(code, _) in crate::i18n::AVAILABLE {
            let req = TestRequest::default()
                .insert_header(("Accept-Language", code))
                .to_http_request();
            let body = html(index(req, state()).await).await;
            assert!(
                body.contains(&format!(r#"<html lang="{code}""#)),
                "{code} 没协商上"
            );
            let tagline = crate::i18n::t(code, "ui.tagline");
            assert!(
                body.contains(tagline.as_str()),
                "{code} 的 tagline 没出现在页面上：{tagline}"
            );
            if code != "en" {
                assert!(
                    !body.contains("Handy tools for developers"),
                    "{code} 的页面上漏出了英文的 tagline"
                );
            }
        }
    }

    /// 语言下拉要列出**全部**语言 —— 少一个，那种语言就没人点得到。
    #[actix_web::test]
    async fn the_language_dropdown_lists_every_language() {
        let body = html(index(TestRequest::default().to_http_request(), state()).await).await;
        for &(code, _) in crate::i18n::AVAILABLE {
            assert!(
                body.contains(&format!(r#"<option value="{code}""#)),
                "语言下拉里没有 {code}"
            );
        }
    }
}
