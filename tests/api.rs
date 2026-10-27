//! 服务端工具接口的集成测试。
//!
//! 打的是真的 HTTP 入口（`POST /api/tools/{endpoint}`、`/api/jwt/*`），
//! 走的是前端 ajax 走的那条路 —— 请求体怎么拼、错误信封长什么样、
//! 错误文案按什么语言出，都在这里钉住。

mod common;

use actix_web::http::StatusCode;
use actix_web::test::TestRequest;
use actix_web::test::call_service;
use common::init_app;

/// 发一个 JSON 请求，返回 (状态码, 响应体 JSON)
async fn post_json(
    app: &impl actix_web::dev::Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse,
        Error = actix_web::Error,
    >,
    uri: &str,
    body: &str,
) -> (StatusCode, serde_json::Value) {
    let (status, text) = post_json_text(app, uri, body).await;
    let json = serde_json::from_str(&text).unwrap_or_else(|e| panic!("响应体不是 JSON（{e}）：{text}"));
    (status, json)
}

/// 发一个 JSON 请求，返回 (状态码, 响应体原文)
async fn post_json_text(
    app: &impl actix_web::dev::Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse,
        Error = actix_web::Error,
    >,
    uri: &str,
    body: &str,
) -> (StatusCode, String) {
    let resp = call_service(
        app,
        TestRequest::post()
            .uri(uri)
            .insert_header(("Content-Type", "application/json"))
            .set_payload(body.to_string())
            .to_request(),
    )
    .await;
    let status = resp.status();
    (status, common::text(resp).await)
}

#[actix_web::test]
async fn hash_text_computes_the_digest() {
    let app = init_app!();
    let (status, json) = post_json(
        &app,
        "/api/tools/hash-text",
        r#"{"text":"abc","algorithm":"sha256"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["ok"], true);
    assert_eq!(
        json["data"]["output"],
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(json["data"]["meta"]["algorithm"], "sha256");
}

/// 不指定算法时一次算完所有 —— 跟原版 hash-text 的并排视图对应。
#[actix_web::test]
async fn hash_text_returns_every_algorithm_by_default() {
    let app = init_app!();
    let (status, json) = post_json(&app, "/api/tools/hash-text", r#"{"text":"abc"}"#).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["data"]["table"]["md5"], "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(
        json["data"]["table"]["sha1"],
        "a9993e364706816aba3e25717850c26c9cd0d89d"
    );
    // md5 + sha1 + sha224/256/384/512 + sha3 ×4 + ripemd160 + blake2b/s + blake3
    // + keccak ×2 + xxhash ×4 + 三个校验和
    assert_eq!(json["data"]["meta"]["count"], 23);
    // rows 是给「一行一个格式」那种界面用的，条数得跟 table 一样
    assert_eq!(
        json["data"]["rows"].as_array().unwrap().len(),
        json["data"]["meta"]["count"]
    );
}

/// 工具接口认表单编码 —— 前端退化到没有 fetch 时会走这条。
#[actix_web::test]
async fn tool_endpoints_also_accept_form_encoded_bodies() {
    let app = init_app!();
    let resp = call_service(
        &app,
        TestRequest::post()
            .uri("/api/tools/hash-text")
            .insert_header((
                "Content-Type",
                "application/x-www-form-urlencoded",
            ))
            .set_payload("text=abc&algorithm=md5")
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = common::json(resp).await;
    assert_eq!(json["data"]["output"], "900150983cd24fb0d6963f7d28e17f72");
}

/// 输入不合法时是 400 + 统一的错误信封，不是 500。
#[actix_web::test]
async fn invalid_input_comes_back_as_a_400_with_an_error_envelope() {
    let app = init_app!();
    let (status, json) = post_json(
        &app,
        "/api/tools/hash-text",
        r#"{"text":"abc","algorithm":"nope"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"]["kind"], "invalid input");
    assert_eq!(json["error"]["message"], "Unsupported algorithm: nope");
}

/// 错误文案要按请求语言出。
///
/// 前端把 `error.message` 原样显示出来 —— 英文界面下冒出一句中文
/// 就是半截翻译，跟页面上的字对不上。
#[actix_web::test]
async fn error_messages_follow_the_request_language() {
    let app = init_app!();
    let resp = call_service(
        &app,
        TestRequest::post()
            .uri("/api/tools/hash-text")
            .insert_header(("Content-Type", "application/json"))
            .insert_header(("Accept-Language", "zh-CN,zh;q=0.9"))
            .set_payload(r#"{"text":"abc","algorithm":"nope"}"#)
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let json = common::json(resp).await;
    assert_eq!(json["error"]["message"], "不支持的算法: nope");
}

/// 认不出来的工具名是 404，跟「输入不合法」要分得开。
#[actix_web::test]
async fn unknown_endpoints_are_404() {
    let app = init_app!();
    let (status, json) = post_json(&app, "/api/tools/no-such-tool", r#"{}"#).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"]["kind"], "unknown tool");
}

/// 请求体不是合法 JSON 时不能 500。
///
/// 解析失败会被包成 `{"__parse_error": ...}` 交回工具，工具照常按
/// 自己的规则处理 —— 这里守的是「任何畸形输入都得到一个 JSON 信封，
/// 绝不 500」。
#[actix_web::test]
async fn malformed_bodies_never_become_a_500() {
    let app = init_app!();
    for body in ["{not json", "", "[]", "null", "\"just a string\""] {
        let (status, json) = post_json(&app, "/api/tools/hash-text", body).await;
        assert!(
            status.is_success() || status.is_client_error(),
            "畸形请求体 {body:?} 打出了 {status}"
        );
        assert!(
            json.get("ok").is_some(),
            "畸形请求体 {body:?} 的响应里没有 ok 字段: {json}"
        );
    }
}

/// JWT 的算法清单以服务端为准。
#[actix_web::test]
async fn jwt_algorithms_are_listed_by_the_server() {
    let app = init_app!();
    let resp = call_service(
        &app,
        TestRequest::get().uri("/api/jwt/algorithms").to_request(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = common::json(resp).await;
    assert_eq!(json["ok"], true);
    let algs = json["data"]["algorithms"].as_array().expect("算法表该是数组");
    assert_eq!(algs.len(), 12);
    for alg in algs {
        for key in ["alg", "family", "keyType", "verify"] {
            assert!(!alg[key].is_null(), "算法条目缺 {key}: {alg}");
        }
    }
}

/// 签名 → 验签，闭环走一遍。
#[actix_web::test]
async fn jwt_signs_and_verifies() {
    let app = init_app!();

    let (status, json) = post_json(
        &app,
        "/api/jwt/sign",
        r#"{"alg":"HS256","payload":"{\"sub\":\"42\"}","secret":"s3cret"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = json["data"]["token"].as_str().expect("该返回一个 token");
    assert_eq!(token.split('.').count(), 3, "JWT 该是三段: {token}");
    assert_eq!(json["data"]["payload"]["sub"], "42");

    let (status, json) = post_json(
        &app,
        "/api/jwt/verify",
        &format!(r#"{{"token":"{token}","secret":"s3cret"}}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["data"]["valid"], true);
    assert_eq!(json["data"]["alg"], "HS256");
}

/// 用错的密钥验签要验不过 —— 不然「验签」这个功能等于没有。
#[actix_web::test]
async fn jwt_verification_fails_with_the_wrong_secret() {
    let app = init_app!();
    let (status, json) = post_json(
        &app,
        "/api/jwt/sign",
        r#"{"alg":"HS256","payload":"{\"sub\":\"42\"}","secret":"s3cret"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = json["data"]["token"].as_str().unwrap();

    let (status, json) = post_json(
        &app,
        "/api/jwt/verify",
        &format!(r#"{{"token":"{token}","secret":"wrong"}}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["data"]["valid"], false);
}

/// 生成密钥对：私钥、公钥、JWK 三份都要在。
#[actix_web::test]
async fn jwt_generates_a_key_pair() {
    let app = init_app!();
    let (status, json) = post_json(&app, "/api/jwt/keygen", r#"{"alg":"ES256"}"#).await;
    assert_eq!(status, StatusCode::OK);
    for key in ["privateKey", "publicKey", "privateKeyJwk", "publicKeyJwk"] {
        assert!(!json["data"][key].is_null(), "密钥对里缺 {key}");
    }
    assert!(json["data"]["privateKey"]
        .as_str()
        .unwrap()
        .contains("PRIVATE KEY"));
}

/// 错误消息里不能带密钥材料。
///
/// 密钥只在请求体与响应体里来回走，错误消息是要显示给用户看的 ——
/// 一旦把私钥拼进错误消息，它就会进日志、进浏览器历史、进截图。
#[actix_web::test]
async fn errors_never_echo_the_key_material_back() {
    let app = init_app!();
    let secret = "SUPER-SECRET-KEY-MATERIAL";
    let (status, text) = post_json_text(
        &app,
        "/api/jwt/sign",
        &format!(
            r#"{{"alg":"RS256","payload":"{{\"sub\":\"42\"}}","secret":"{secret}","privateKey":"-----BEGIN PRIVATE KEY-----\n{secret}\n-----END PRIVATE KEY-----\n"}}"#
        ),
    )
    .await;
    assert!(
        status.is_client_error(),
        "这一条本该是 4xx，实际 {status}：{text}"
    );
    assert!(
        !text.contains(secret),
        "响应里带出了密钥材料: {text}"
    );
}

/// 认不出来的动作是 4xx，不是 500。
#[actix_web::test]
async fn unknown_jwt_actions_are_rejected() {
    let app = init_app!();
    let (status, json) = post_json(&app, "/api/jwt/no-such-action", r#"{}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"]["kind"], "invalid input");
}
