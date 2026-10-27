//! Tera 模板引擎实例。
//!
//! 模板在编译期由 rust-embed 打包，启动时一次性注册进 Tera ——
//! `{% extends %}` / `{% import %}` 需要模板之间互相可见，因此不能用 `Tera::one_off`。

use std::sync::Arc;

use tera::{Context, Tera};

use crate::embed::Templates;

/// 自动转义的模板（HTML 输出）
const AUTOESCAPE_SUFFIX: &str = ".html";

/// 必须先于其他模板注册的模板，顺序也有讲究。
///
/// `add_raw_template` 在解析阶段就要能看见 `{% extends %}` / `{% import %}` 指向的模板，
/// 所以先注册没有依赖的 macros.html，再注册 extends 它的 base.html，最后才是各页面。
const PARENTS: &[&str] = &["macros.html", "base.html"];

pub fn build() -> anyhow::Result<Arc<Tera>> {
    let mut tera = Tera::default();
    tera.autoescape_on(vec![AUTOESCAPE_SUFFIX]);

    let mut names: Vec<String> = Vec::new();

    for name in PARENTS {
        add_one(&mut tera, name, &mut names)?;
    }
    for file in Templates::iter() {
        let name = file.to_string();
        if PARENTS.contains(&name.as_str()) {
            continue;
        }
        add_one(&mut tera, &name, &mut names)?;
    }

    log::info!("已加载 {} 个模板", names.len());
    Ok(Arc::new(tera))
}

fn add_one(tera: &mut Tera, name: &str, names: &mut Vec<String>) -> anyhow::Result<()> {
    let Some(raw) = Templates::get(name) else {
        return Err(anyhow::anyhow!("模板 {name} 未嵌入二进制"));
    };
    let body = String::from_utf8(raw.data.to_vec())
        .map_err(|e| anyhow::anyhow!("模板 {name} 不是合法 UTF-8: {e}"))?;
    tera.add_raw_template(name, &body)
        .map_err(|e| anyhow::anyhow!("注册模板 {name} 失败: {}", cause_chain(&e)))?;
    names.push(name.to_string());
    Ok(())
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
        // extends / import 关系在注册期就会校验，链接断了这里会报错
        assert!(tera.get_template_names().any(|n| n.ends_with("base.html")));
        assert!(tera.get_template_names().any(|n| n.ends_with("index.html")));
        assert!(tera
            .get_template_names()
            .any(|n| n.ends_with("macros.html")));
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
