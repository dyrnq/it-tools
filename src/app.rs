//! actix App 工厂与共享状态。

use actix_web::{web, App, HttpResponse};
use std::sync::Arc;
use tera::Tera;

use crate::handlers::{api, assets, pages};
use crate::registry;
use crate::settings::Settings;

/// 通过 `app_data` 共享的运行期状态
#[derive(Clone)]
pub struct AppState {
    pub settings: Settings,
    /// 无 localStorage 时的默认主题
    pub default_dark: bool,
    /// 启动时一次性注册好的模板实例
    pub tera: Arc<Tera>,
}

/// 注册全部路由
pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/")
            .route(web::get().to(pages::index))
            .route(web::head().to(pages::index)),
    )
    .service(
        web::resource("/about")
            .route(web::get().to(pages::about))
            .route(web::head().to(pages::about)),
    )
    // rust-embed 静态资源
    .service(
        web::resource("/assets/{tail:.*}")
            .route(web::get().to(assets::serve))
            .route(web::head().to(assets::serve)),
    )
    // 服务端工具接口
    .service(web::resource("/api/tools/{endpoint}").route(web::post().to(api::tool_endpoint)))
    // JWT 的签名 / 验签 / 密钥生成（上游 PR #1453）。
    //
    // 单独一条路由，而不是走 `/api/tools/{endpoint}`：那条路只放注册表里声明为
    // Api 的工具，而 jwt-generator 是 JS 工具（界面是自己写的，不是通用表单）。
    //
    // 密码学放服务端而不是浏览器，是因为 WebCrypto 只在**安全上下文**里存在
    // （https 或 localhost）。本服务通常跑在内网的明文 http 上，浏览器端压根
    // 没有 crypto.subtle —— 放在前端会直接坏掉。
    // 支持的算法清单：前端的算法下拉框从这里取，算法表只有一份。
    // 必须排在 `/api/jwt/{action}` **前面** —— actix 是按注册顺序匹配的，
    // 路径一旦被 `{action}` 吃掉，后面的服务就不会再看了（GET 会得到 405）。
    .service(web::resource("/api/jwt/algorithms").route(web::get().to(api::jwt_algorithms)))
    .service(web::resource("/api/jwt/{action}").route(web::post().to(api::jwt_endpoint)))
    // 搜索索引 / 健康检查
    .service(web::resource("/registry.json").route(web::get().to(api::registry_json)))
    .service(web::resource("/i18n.js").route(web::get().to(api::i18n_js)))
    .service(web::resource("/healthz").route(web::get().to(health)))
    // 历史路由 301
    .service(web::resource("/redirect/{tail:.*}").route(web::get().to(assets::legacy_redirect)))
    // 工具页：路径由注册表决定，这里统一在 default_service 里兜底处理，
    // 因为每个工具的路由需要在启动时从注册表生成。
    .default_service(web::route().to(tool_dispatch));
}

/// 健康检查：**只**说「活着」。
///
/// 这里不报工具数量 —— 数量是统计项，加了工具就得回来改，
/// 而健康检查要回答的问题只有一个：服务还在不在。
async fn health() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "ok": true,
    }))
}

/// 未匹配到固定路由时：先看是不是工具路径 / 历史别名，否则 404。
async fn tool_dispatch(
    req: actix_web::HttpRequest,
    state: web::Data<AppState>,
) -> actix_web::HttpResponse {
    let path = req.path();

    if let Some(target) = registry::redirect_target(path) {
        return handlers_redirect(&req, target, state.get_ref());
    }

    let Some(slug) = registry::TOOLS
        .iter()
        .find(|t| t.path == path)
        .map(|t| t.slug)
    else {
        let lang = crate::handlers::resolve_lang(&req, &state.settings);
        return pages::not_found_page(&req, state.get_ref(), &lang).await;
    };

    pages::tool(req, state, slug.to_string()).await
}

/// 301 并顺带带上语言 Cookie
fn handlers_redirect(req: &actix_web::HttpRequest, to: &str, state: &AppState) -> HttpResponse {
    let lang = crate::handlers::resolve_lang(req, &state.settings);
    crate::handlers::redirect_with_lang(req, to, &lang)
}

/// 组装并启动 HTTP 服务
pub async fn run(cli: crate::settings::Cli) -> std::io::Result<()> {
    let settings = Settings::from(cli.clone());
    let addr = cli.addr();
    let tera = crate::templates::build().map_err(|e| {
        log::error!("模板初始化失败: {e:#}");
        std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
    })?;
    let state = web::Data::new(AppState {
        settings,
        // 没有 JS、也读不到系统偏好的客户端才用这个兜底。
        // 正常情况下主题由 templates/base.html 的内联脚本按
        // prefers-color-scheme 决定（原版 useDark() 的 'auto' 行为）。
        default_dark: false,
        tera,
    });

    log::info!("it-tools 启动于 http://{addr}");

    actix_web::HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .app_data(web::JsonConfig::default().limit(64 * 1024 * 1024))
            .app_data(web::PayloadConfig::default().limit(64 * 1024 * 1024))
            .configure(configure)
    })
    .bind(addr)?
    .run()
    .await
}
