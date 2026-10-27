//! HTTP 处理器。

pub mod api;
pub mod assets;
pub mod pages;
pub mod view;

use actix_web::HttpResponse;

use crate::i18n;
use crate::settings::Settings;

/// 解析本次请求使用的语言，写入响应，供页面与 Cookie 复用。
///
/// 优先级：`?lang=` > Cookie > `Accept-Language` > 启动参数默认值。
pub fn resolve_lang(req: &actix_web::HttpRequest, settings: &Settings) -> String {
    let query = query_param(req.query_string(), "lang");
    let cookie = req.cookie("lang").map(|c| c.value().to_owned());
    let accept = req
        .headers()
        .get(actix_web::http::header::ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok());

    i18n::negotiate(
        query.as_deref(),
        cookie.as_deref(),
        accept,
        &settings.default_lang,
    )
}

/// 从 `a=1&b=2` 里取一个参数。只解 `%20` 这类转义，`+` 不做空格处理 ——
/// 这里只用来读 `?lang=`。
pub(crate) fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        if k != key {
            return None;
        }
        Some(percent_decode(v))
    })
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
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 带语言 Cookie 的重定向
pub fn redirect_with_lang(_req: &actix_web::HttpRequest, to: &str, lang: &str) -> HttpResponse {
    HttpResponse::SeeOther()
        .cookie(
            actix_web::cookie::Cookie::build("lang", lang)
                .path("/")
                .finish(),
        )
        .insert_header((actix_web::http::header::LOCATION, to.to_string()))
        .finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_query_param() {
        assert_eq!(query_param("lang=zh-CN", "lang").as_deref(), Some("zh-CN"));
        assert_eq!(query_param("a=1&lang=en", "lang").as_deref(), Some("en"));
        assert_eq!(query_param("a=1", "lang"), None);
        assert_eq!(
            query_param("lang=zh%2DCN", "lang").as_deref(),
            Some("zh-CN")
        );
        assert_eq!(query_param("", "lang"), None);
    }
}
