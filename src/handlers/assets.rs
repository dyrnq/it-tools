//! rust-embed 静态资源服务。
//!
//! rust-embed 8.x 没有现成的 actix Resource，这里自己实现：查表 → MIME → ETag → 304。
//! `Cache-Control` 一律走协商缓存（ETag + 304），改完刷新即见 —— 理由见 CACHE_POLICY。

use actix_web::http::header::{
    HeaderValue, CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH, LOCATION,
};
use actix_web::{web, HttpRequest, HttpResponse};

use crate::embed::StaticAsset;

/// 所有静态资源的缓存策略：每次使用前都回源校验，命中就是一发 304。
///
/// 早先这里给 `lib/` 和 `img/icons.svg` 发 30 天 `immutable`，本意是「这些文件
/// 版本锁死、不会变」，但前提不成立：
///
/// - **没有任何内容指纹。** 本项目没有构建步骤（_docs/arch.md 的硬约束），URL 里既没有
///   hash 也没有版本号 —— `lib/bip39/x.min.js` 升了版本，路径一字不变。
/// - **`img/icons.svg` 是手工维护的**，每次发版都可能加符号，而全站每个图标都是
///   `<use href="/assets/img/icons.svg#i-xxx">`，正好是最容易被忽略更新的那一个。
///
/// 长缓存 + 无指纹 = 静默失效：服务端加了新符号，老用户那边 `<use>` 解析不到，
/// 图标直接不显示，而且**没有任何报错**，只有肉眼能看出来。所以宁可每次多一发 304。
const CACHE_POLICY: &str = "public, max-age=0, must-revalidate";

/// `/assets/{tail:.*}`
pub async fn serve(req: HttpRequest, tail: web::Path<String>) -> HttpResponse {
    let rel = tail.into_inner();
    let Some(file) = StaticAsset::get(&rel) else {
        return HttpResponse::NotFound().body("not found");
    };

    // ETag 取内容 sha256 的前 16 字节（hex 后 32 字符）。
    let digest = hex::encode(&file.metadata.sha256_hash()[..16]);
    let etag = match HeaderValue::from_str(&format!("\"{digest}\"")) {
        Ok(v) => v,
        Err(_) => return HttpResponse::NotFound().body("not found"),
    };

    // 协商缓存：客户端带匹配的 ETag 就直接 304。
    if req
        .headers()
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .map(|t| t.trim().trim_start_matches("W/").trim_matches('"'))
                .any(|t| t == digest)
        })
    {
        return HttpResponse::NotModified()
            .insert_header((ETAG, etag))
            .insert_header((CACHE_CONTROL, CACHE_POLICY))
            .finish();
    }

    let mime = mime_guess::from_path(&rel)
        .first_or_octet_stream()
        .to_string();

    HttpResponse::Ok()
        .insert_header((CONTENT_TYPE, mime))
        .insert_header((ETAG, etag))
        // 一律回源协商，不给长缓存。详见 CACHE_POLICY 那段说明。
        .insert_header((CACHE_CONTROL, CACHE_POLICY))
        .body(file.data.into_owned())
}

/// `/redirect/{tail:.*}` —— 历史路由 301 到新路径。
pub async fn legacy_redirect(tail: web::Path<String>) -> HttpResponse {
    let path = format!("/{}", tail.into_inner());
    match crate::registry::redirect_target(&path) {
        Some(target) => HttpResponse::MovedPermanently()
            .insert_header((LOCATION, target.to_string()))
            .finish(),
        None => HttpResponse::NotFound().body("not found"),
    }
}
