//! Tera 模板引擎实例。
//!
//! 模板在编译期由 rust-embed 打包，启动时一次性注册进 Tera ——
//! `{% extends %}` / `{% include %}` 需要模板之间互相可见，因此不能用 `Tera::one_off`。

use std::sync::Arc;

use tera::{Context, Kwargs, State, Tera, TeraResult, Value};

use crate::embed::Templates;

/// 自动转义的模板（HTML 输出）
const AUTOESCAPE_SUFFIX: &str = ".html";

pub fn build() -> anyhow::Result<Arc<Tera>> {
    let mut tera = Tera::default();
    tera.autoescape_on(vec![AUTOESCAPE_SUFFIX]);
    // 转义口径照 tera 1 的来，别用 tera 2 的默认值（见 escape_html 的注释）。
    tera.set_escape_fn(escape_html);
    // 过滤器也得在注册模板**之前**装好 —— tera 2 在注册期就检查
    // 「这个模板用到的过滤器有没有」。
    tera.register_filter("json_encode", json_encode);

    // 所有模板**一次性**交给 tera，不能一个一个 add_raw_template。
    //
    // tera 2 的 `add_raw_templates` 是「先全部解析，再统一校验」：extends /
    // include 指向的模板、组件、过滤器、测试都要在这一步能对上。分批加的话，
    // 第二批里的模板去 include 第一批之外的模板就会报
    // `Unknown template` —— 组件也一样（组件是全局的，谁先谁后无所谓）。
    let mut raw: Vec<(String, String)> = Vec::new();
    for file in Templates::iter() {
        let name = file.to_string();
        let body = read_template(&name)?;
        raw.push((name, body));
    }

    tera.add_raw_templates(raw)
        .map_err(|e| anyhow::anyhow!("注册模板失败: {}", cause_chain(&e)))?;

    log::info!("已加载 {} 个模板", tera.get_template_names().count());
    Ok(Arc::new(tera))
}

/// 读出一个嵌入的模板
fn read_template(name: &str) -> anyhow::Result<String> {
    let Some(file) = Templates::get(name) else {
        return Err(anyhow::anyhow!("模板 {name} 未嵌入二进制"));
    };
    String::from_utf8(file.data.to_vec())
        .map_err(|e| anyhow::anyhow!("模板 {name} 不是合法 UTF-8: {e}"))
}

/// HTML 转义。
///
/// tera 1 的默认转义是 `& < > " ' /` 六个字符，其中 `'` → `&#x27;`、
/// `/` → `&#x2F;`；tera 2 的默认只转 `& < > " '`（`'` → `&#39;`），
/// `/` 原样输出。
///
/// 页面里到处是带斜杠的文案 —— 侧栏的「Encrypt / decrypt text」、
/// 卡片描述里的「encoder/decoder」—— 转义口径一变，成千上行的 HTML
/// 就跟着变：看着一样，字节不一样，缓存、快照、E2E 断言全得跟着改。
/// 这里照 tera 1 的口径自己写一份装到 Tera 上，升级前后页面**逐字节相同**。
fn escape_html(input: &str, out: &mut dyn std::io::Write) -> std::io::Result<()> {
    for c in input.as_bytes() {
        match c {
            b'&' => out.write_all(b"&amp;")?,
            b'<' => out.write_all(b"&lt;")?,
            b'>' => out.write_all(b"&gt;")?,
            b'"' => out.write_all(b"&quot;")?,
            b'\'' => out.write_all(b"&#x27;")?,
            b'/' => out.write_all(b"&#x2F;")?,
            _ => out.write_all(&[*c])?,
        }
    }
    Ok(())
}

/// 把值编码成 JSON。
///
/// tera 1 内置了这个过滤器，tera 2 把它连同别的「需要额外依赖的过滤器」一起
/// 搬去了 tera-contrib（json_encode 要 serde_json）。我们只用到这一个，
/// 自己写一份就行，不必为此多引一个 crate —— 逻辑跟 tera-contrib 的那份一样。
///
/// 拿到的已经是 tera 自己的 `Value`（不是 serde_json::Value），但 tera::Value
/// 实现了 Serialize，交给 serde_json 就行。
fn json_encode(value: &Value, _kwargs: Kwargs, _state: &State) -> TeraResult<String> {
    serde_json::to_string(value).map_err(|e| tera::Error::message(format!("编码 JSON 失败: {e}")))
}

/// Tera 的 `Error` 只是顶层摘要，真正的行列信息藏在 `source()` 链里，
/// 这里摊平成人能读的一串，模板写错时才能直接定位。
fn cause_chain(e: &dyn std::error::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut cur = e.source();
    while let Some(s) = cur {
        let text = s.to_string();
        // 重复的顶层摘要去掉，只留有增量信息的那几层
        if parts.last().map(|p| p != &text).unwrap_or(true) {
            parts.push(text);
        }
        cur = s.source();
    }
    parts.join("\n  caused by: ")
}

/// 渲染并包成 actix 响应
pub fn render(
    tera: &Tera,
    template: &str,
    ctx: &Context,
) -> Result<actix_web::HttpResponse, actix_web::Error> {
    match tera.render(template, ctx) {
        Ok(html) => Ok(actix_web::HttpResponse::Ok()
            .content_type("text/html; charset=utf-8")
            .body(html)),
        Err(e) => {
            // 同样的道理：光有 "Failed to render" 没法定位，日志里要带上完整原因链
            log::error!("渲染 {template} 失败: {}", cause_chain(&e));
            Ok(actix_web::HttpResponse::InternalServerError().body("template error"))
        }
    }
}

/// 构造模板上下文
pub fn context(value: &serde_json::Value) -> Context {
    Context::from_serialize(value).unwrap_or_else(|e| {
        log::error!("构造模板上下文失败: {e}");
        Context::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn all_templates_register_and_link() {
        let tera = build().expect("模板应能全部加载");
        // extends / include 关系在注册期就会校验，链接断了这里会报错
        assert!(tera.get_template_names().any(|n| n.ends_with("base.html")));
        assert!(tera.get_template_names().any(|n| n.ends_with("index.html")));
        assert!(tera
            .get_template_names()
            .any(|n| n.ends_with("components.html")));
    }

    /// 表单里的开关字段。
    ///
    /// `FieldKind::Boolean` 现在还没有工具在用（要等 JSON→C# 那类一堆开关的
    /// 服务端工具），但渲染这一半要先铺好 —— 模板漏了这个分支，等到真有工具
    /// 用的时候才发现，表单会静默地少一个字段。
    #[test]
    fn boolean_fields_render_a_checkbox() {
        let tera = build().expect("模板应能全部加载");
        let mut ctx = Context::new();
        ctx.insert(
            "tool",
            &json!({
                "fields": [
                    {"name": "on",  "label": "Turn on",  "kind": "boolean", "default": "true",  "options": []},
                    {"name": "off", "label": "Turn off", "kind": "boolean", "default": "false", "options": []},
                    {"name": "text", "label": "Some text", "kind": "text", "default": null, "options": []},
                ],
                // 结果区的形状与标题（见 Tool::api_result_kind / api_result_labels）。
                // 少了这两个键模板会直接渲染失败 —— 这里显式补上，
                // 免得以后再加形状时忘了同步这个测试的上下文。
                "api_result_kind": "card",
                "api_result_labels": [],
                "api_result_label": null,
                "api_live": false,
                "api_rows": false,
                "api_left_label": null,
                // 左标签那一列的对齐方式（见 Tool::api_left_label_align）。
                "api_left_label_align": "right",
                // 走行式结果时标签列的宽度（见 Tool::api_row_label_width）。
                "api_row_label_width": "150px",
                // 哪些字段并排占一半（见 Tool::api_half_fields）。空表 = 全部竖排。
                "api_half_fields": [],
            }),
        );
        ctx.insert(
            "base",
            &json!({"ui": {"run": "Run", "clear": "Clear", "output": "Output", "copy": "Copy"}}),
        );
        let html = tera
            .render("tool_api_form.html", &ctx)
            .expect("表单应能渲染");

        assert!(html.contains(r#"id="f-on" name="on""#), "{html}");
        assert!(html.contains(r#"id="f-off" name="off""#), "{html}");
        // default 为 "true" 的那个默认勾上，另一个不勾
        assert!(html.contains(r#"id="f-on" name="on""#), "{html}");
        let on_at = html.find(r#"id="f-on""#).expect("找不到 on 字段");
        assert!(
            html[on_at..].contains("checked"),
            "default=true 的开关应默认勾上: {html}"
        );
        let off_at = html.find(r#"id="f-off""#).expect("找不到 off 字段");
        assert!(
            !html[off_at..].contains("checked"),
            "default=false 的开关不该勾上: {html}"
        );
        // 普通文本框不受影响
        assert!(html.contains(r#"id="f-text""#), "{html}");
    }
}
