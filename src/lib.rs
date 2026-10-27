//! IT Tools —— 开发者工具箱的 Rust 实现。
//!
//! - Web: `actix-web`
//! - 模板: `tera`
//! - 前端资源: `rust-embed`（编译期打包进二进制，部署时只有一个可执行文件）
//! - 前端 UI: layui，无 Node.js 构建步骤
//!
//! 工具实现遵循 _docs/arch.md：能在 JS 里做的用 JS 做（必要时引入前端依赖库），
//! JS 做不了的才由 Rust 暴露接口，经 ajax 调用。分发逻辑见 `src/registry`。
//!
//! # 为什么拆成 lib + bin
//!
//! 可执行文件（`src/main.rs`）只做两件事：解析命令行、把服务跑起来。
//! 真正的实现都在这个库里，好处有两个：
//!
//! * 集成测试（`tests/`）能用 `actix_web::test` 把**整个 App** 组装起来打请求 ——
//!   路由、404 兜底、静态资源、重定向都在射程内。只有 bin target 的话，
//!   这些代码没法被测试 crate 引用，集成测试就只能去起真的进程。
//! * 单元测试（`#[cfg(test)]`）跑的是库里那份，跟线上跑的是同一份代码。

pub mod app;
pub mod embed;
pub mod handlers;
pub mod i18n;
pub mod markdown;
pub mod registry;
pub mod settings;
pub mod templates;
pub mod tools;

/// 页面与 API 共用的运行期状态。
///
/// 放在 crate 根上再导出一次，是为了保住 `crate::AppState` 这种写法
/// （`handlers::pages` 里就是这么引的）。
pub use app::AppState;

#[cfg(test)]
mod registry_tests {
    use crate::embed;
    use crate::registry::{self, Category, ImplKind, TOOLS};
    use crate::tools;
    use std::collections::HashSet;

    /// 工具的来历：上游的参考实现，加上上游还没有、但上游 issue 明确要了的工具
    /// （`ssl-certificate-decoder` ← #1459，`iana-timezone-index` ← #1593，
    /// `email-header-parser` ← #1396，`dns-record-generator` ← #1387，
    /// `htpasswd` ← #1490，`jasypt` ← #1738），
    /// 以及上游 PR #363 带来的 `argon2-hash-generator`、
    /// 上游 PR #1453 带来的 `jwt-generator`，
    /// 再加上从上游开放 PR 里挑出来的新工具（见 _docs/new-tool-candidates.md）。
    ///
    /// 这里**不**钉工具总数：加了工具就得回来改一行数字，这种「统计项」迟早会忘。
    /// 真正要守的是「上面那几个工具不能丢」，所以只点名查它们。
    #[test]
    fn has_all_tools() {
        for slug in [
            "ssl-certificate-decoder",
            "iana-timezone-index",
            "argon2-hash-generator",
            "jwt-generator",
        ] {
            assert!(
                TOOLS.iter().any(|t| t.slug == slug),
                "少了新增的 {slug}"
            );
        }
    }

    #[test]
    fn slugs_and_paths_are_unique() {
        let mut slugs = HashSet::new();
        let mut paths = HashSet::new();
        for t in TOOLS {
            assert!(slugs.insert(t.slug), "slug 重复: {}", t.slug);
            assert!(paths.insert(t.path), "path 重复: {}", t.path);
        }
    }

    #[test]
    fn every_tool_belongs_to_a_known_category() {
        for t in TOOLS {
            assert!(
                Category::ALL.contains(&t.category),
                "{} 的分类 {:?} 不在 Category::ALL 里",
                t.slug,
                t.category
            );
        }
    }

    #[test]
    fn i18n_base_matches_path() {
        for t in TOOLS {
            let base = t.i18n_base();
            let expected = format!("tools.{}", t.path.trim_start_matches('/'));
            assert_eq!(base, expected);
            assert!(
                t.name_key.starts_with(&base),
                "{}: name_key 与 path 不符",
                t.slug
            );
            assert!(
                t.desc_key.starts_with(&base),
                "{}: desc_key 与 path 不符",
                t.slug
            );
        }
    }

    #[test]
    fn every_tool_has_keywords_and_icon() {
        for t in TOOLS {
            assert!(!t.keywords.is_empty(), "{} 没有关键词", t.slug);
            assert!(!t.icon.is_empty(), "{} 没有图标", t.slug);
        }
    }

    #[test]
    fn redirect_targets_do_not_collide() {
        let mut seen = HashSet::new();
        for t in TOOLS {
            for r in t.redirect_from {
                assert!(seen.insert(*r), "历史路由重复: {r}");
                assert!(
                    !TOOLS.iter().any(|o| o.path == *r),
                    "历史路由 {r} 与真实路由冲突"
                );
            }
        }
    }

    /// 把缺失项一次性列全，而不是撞到第一个就 panic —— 分阶段推进时
    /// 「还差哪些」比「第一个是谁」有用得多。
    fn assert_all_present(missing: &[String]) {
        assert!(
            missing.is_empty(),
            "还有 {} 个工具没实现:\n  {}",
            missing.len(),
            missing.join("\n  ")
        );
    }

    #[test]
    fn js_tools_have_a_script_file() {
        let missing: Vec<String> = TOOLS
            .iter()
            .filter(|t| matches!(t.impl_kind, ImplKind::Js))
            // 开发期从磁盘读，release 期从嵌入表读，两种情况行为一致
            .filter(|t| {
                let rel = t.script_url();
                let rel = rel.trim_start_matches("/assets/");
                embed::StaticAsset::get(rel).is_none()
            })
            .map(|t| t.slug.to_string())
            .collect();
        assert_all_present(&missing);
    }

    #[test]
    fn api_tools_all_have_a_handler() {
        let missing: Vec<String> = TOOLS
            .iter()
            .filter_map(|t| match t.impl_kind {
                ImplKind::Api(spec) if !tools::IMPLEMENTED.contains(&spec.endpoint) => {
                    Some(t.slug.to_string())
                }
                _ => None,
            })
            .collect();
        assert_all_present(&missing);
    }

    #[test]
    fn static_tools_have_embedded_content() {
        for t in TOOLS {
            if matches!(t.impl_kind, ImplKind::Static) {
                assert!(
                    embed::StaticAsset::get(&format!("content/{}.md", t.slug)).is_some(),
                    "{} 是静态工具但缺少 content/{}.md",
                    t.slug,
                    t.slug
                );
            }
        }
    }

    /// 「定时刷新」只给**输入框空着时显示当前时刻**的工具开，
    /// 而且那个刷新字段必须真的在表单里。
    ///
    /// 字段名写错的话前端会静默地不跳（`form.elements[字段名]` 取不到就是 undefined），
    /// 页面上看不出来 —— 所以在这儿钉住。
    #[test]
    fn a_refreshing_tool_names_a_field_that_exists() {
        for t in TOOLS {
            let Some((field, ms)) = t.api_refresh() else {
                continue;
            };
            let spec = t
                .impl_kind
                .api_spec()
                .expect("带定时刷新的必须是 API 工具");
            assert!(
                spec.fields.iter().any(|f| f.name == field),
                "{} 的刷新字段 {field} 不在表单里",
                t.slug
            );
            assert!(ms >= 200, "{} 的刷新间隔太密了：{ms}ms", t.slug);
        }
    }

    /// 反向检查：`static/js/tools/` 下不该有注册表不认识的模块。
    ///
    /// 多出来一个文件不会让任何页面加载它，功能上完全静默，
    /// 只有靠这个断言才能发现（例如误把 Api 工具当成 Js 工具去写）。
    #[test]
    fn no_orphan_js_modules() {
        let expected: std::collections::HashSet<String> = TOOLS
            .iter()
            .filter(|t| matches!(t.impl_kind, ImplKind::Js))
            .map(|t| format!("js/tools/{}.js", t.slug))
            .collect();

        let orphans: Vec<String> = embed::StaticAsset::iter()
            .map(|f| f.to_string())
            .filter(|rel| rel.starts_with("js/tools/") && rel.ends_with(".js"))
            .filter(|rel| !expected.contains(rel))
            .collect();

        assert!(
            orphans.is_empty(),
            "这些模块没有对应的 Js 工具，永远不会被加载:\n  {}",
            orphans.join("\n  ")
        );
    }

    #[test]
    fn tool_lookups_work() {
        assert_eq!(registry::by_path("/hash-text").unwrap().slug, "hash-text");
        assert_eq!(registry::by_slug("hash-text").unwrap().path, "/hash-text");
        // slug 与 path 不同的那批
        assert_eq!(
            registry::by_slug("json-viewer").unwrap().path,
            "/json-prettify"
        );
        assert_eq!(
            registry::by_path("/json-prettify").unwrap().slug,
            "json-viewer"
        );
    }

    #[test]
    fn redirect_lookup_works() {
        assert_eq!(registry::redirect_target("/hash"), Some("/hash-text"));
        assert_eq!(registry::redirect_target("/nope"), None);
    }

    /// 分类的**结构**要站得住，但这里**不钉数字**。
    ///
    /// 以前这条测试写的是「每个分类各有多少个工具」—— 加一个工具就得回来改一遍，
    /// 迟早有人忘了改；这种「统计项」本来就是给自己埋的雷，
    /// 忘了改还只是测试红，忘了改还顺手改错就没人知道了。
    ///
    /// 「少了工具」另有地方拦：注册表里删掉一个工具，它在语言包里留下的
    /// `tools.<路由>.title/description` 就没人读了，
    /// `i18n::tests::every_locale_key_is_read_by_somebody` 会当场把键名列出来。
    /// 所以这里只守结构：每个分类都得有东西，各分类加起来得等于总数。
    #[test]
    fn every_category_has_tools() {
        for cat in Category::ALL {
            let n = registry::by_category(cat).count();
            assert!(n > 0, "分类 {:?} 一个工具都没有", cat);
        }
        let sum: usize = Category::ALL
            .iter()
            .map(|c| registry::by_category(*c).count())
            .sum();
        assert_eq!(
            sum,
            TOOLS.len(),
            "各分类的工具数加起来跟总数对不上 —— 有工具被算重了或漏了"
        );
    }
}

#[cfg(test)]
mod locale_tests {
    use crate::i18n;
    use crate::registry::{self, TOOLS};

    #[test]
    fn every_tool_title_exists_in_english() {
        for t in TOOLS {
            assert!(
                i18n::has("en", t.name_key),
                "en.yml 缺少 {} ({})",
                t.name_key,
                t.slug
            );
            assert!(
                i18n::has("en", t.desc_key),
                "en.yml 缺少 {} ({})",
                t.desc_key,
                t.slug
            );
        }
    }

    #[test]
    fn every_tool_title_exists_in_chinese() {
        for t in TOOLS {
            assert!(
                i18n::has("zh-CN", t.name_key),
                "zh-CN.yml 缺少 {} ({})",
                t.name_key,
                t.slug
            );
            assert!(
                i18n::has("zh-CN", t.desc_key),
                "zh-CN.yml 缺少 {} ({})",
                t.desc_key,
                t.slug
            );
        }
    }

    #[test]
    fn every_category_has_a_label() {
        for cat in registry::Category::ALL {
            assert!(
                i18n::has("en", cat.name_key()),
                "en.yml 缺少分类 {}",
                cat.name_key()
            );
            assert!(
                i18n::has("zh-CN", cat.name_key()),
                "zh-CN.yml 缺少分类 {}",
                cat.name_key()
            );
        }
    }

    #[test]
    fn api_tool_field_labels_exist() {
        use crate::registry::{FieldKind, ImplKind};
        for t in TOOLS {
            let ImplKind::Api(spec) = t.impl_kind else {
                continue;
            };
            for f in spec.fields {
                assert!(
                    i18n::has("en", f.label_key),
                    "en.yml 缺少字段文案 {} ({})",
                    f.label_key,
                    t.slug
                );
                assert!(
                    i18n::has("zh-CN", f.label_key),
                    "zh-CN.yml 缺少字段文案 {} ({})",
                    f.label_key,
                    t.slug
                );
                if f.kind == FieldKind::Select {
                    assert!(!f.options.is_empty(), "{} 的下拉字段没有选项", f.name);
                }
            }
        }
    }

    /// 下拉项的英文文案，注册表里写死的兜底必须跟 en.yml 一致。
    ///
    /// 注册表里那份是**兜底**：语言包里没有这条时才用它。两边一旦不一致，
    /// 英文界面显示的是注册表的字、中文界面显示的是语言包的字 —— 同一个下拉框
    /// 两种语言两个说法，还很难看出来是哪边写错了。
    ///
    /// 键的拼法跟 `handlers::view` 取文案时一样（字段名里的 - 和 _ 换成 .）。
    #[test]
    fn dropdown_labels_match_the_english_locale() {
        use crate::registry::ImplKind;
        let mut problems = Vec::new();
        for t in TOOLS {
            let ImplKind::Api(spec) = t.impl_kind else {
                continue;
            };
            for f in spec.fields {
                let base = format!("opt.{}", f.name.replace(['-', '_'], "."));
                for (value, fallback) in f.options {
                    let key = format!("{base}.{value}");
                    match i18n::t("en", &key) {
                        // 语言包里没有这条 —— 兜底就是唯一来源，不算不一致
                        ref v if *v == key => {}
                        v if v == *fallback => {}
                        v => problems.push(format!(
                            "{}: en.yml 的 {key} 是 {v:?}，注册表里写的兜底是 {fallback:?}",
                            t.slug
                        )),
                    }
                }
            }
        }
        assert!(problems.is_empty(), "{}", problems.join("\n"));
    }
}
