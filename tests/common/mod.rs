//! 集成测试的公共装置。
//!
//! 这里组装的是**整个 App**（跟 `app::run` 里那份一模一样），
//! 不是单个 handler —— 路由表、404 兜底、静态资源挂载点、重定向
//! 都在射程内。单元测试打的是 handler 本身，集成测试打的是「这个服务」。
#![allow(dead_code)]

use actix_web::dev::ServiceResponse;
use actix_web::web;

use it_tools::app::AppState;
use it_tools::settings::Settings;

/// 造一份运行期状态。
///
/// 默认语言锁成英文 —— 「语言协商」那几条测试需要一条确定的基线。
pub fn state() -> web::Data<AppState> {
    web::Data::new(AppState {
        settings: Settings {
            default_lang: "en".into(),
        },
        default_dark: false,
        tera: it_tools::templates::build().expect("模板应能全部加载"),
    })
}

/// 响应体读成文本
pub async fn text(resp: ServiceResponse) -> String {
    let bytes = actix_web::body::to_bytes(resp.into_body())
        .await
        .expect("读响应体");
    String::from_utf8(bytes.to_vec()).expect("响应体该是 UTF-8")
}

/// 响应体读成 JSON
pub async fn json(resp: ServiceResponse) -> serde_json::Value {
    let body = text(resp).await;
    serde_json::from_str(&body).unwrap_or_else(|e| panic!("响应体不是 JSON（{e}）：{body}"))
}

/// 组装出跟线上一样的 App。
///
/// 之所以是宏而不是函数：`init_service` 返回的类型里带着 `actix_http::Request`，
/// 而 actix-http 只是 actix-web 的传递依赖 —— 写那个返回类型得先把它
/// 提成直接依赖（dev-dependencies 里已经加了）。宏在调用处展开，
/// 类型交给编译器推断，测试文件里也就不必再写一遍那串约束。
macro_rules! init_app {
    () => {
        actix_web::test::init_service(
            actix_web::App::new()
                .app_data($crate::common::state())
                .configure(it_tools::app::configure),
        )
        .await
    };
}

// 让别的测试文件能按路径用：`use common::init_app;`
// （macro_rules 宏默认是私有的，`pub` 导不出去 —— crate 内可见就够了。）
pub(crate) use init_app;
