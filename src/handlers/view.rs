//! 视图模型：把注册表里的静态数据 + 当前语言，组装成模板要用的结构。

use serde::Serialize;

use crate::i18n;
use crate::registry::{self, Category, ImplKind, Tool};

/// 界面文案。集中从 `ui.*` 语言包键取值，模板里直接 `base.ui.xxx`。
#[derive(Debug, Clone, Serialize)]
pub struct UiStrings {
    pub tagline: String,
    pub site_name: String,
    /// 跳到主内容（键盘用户专用，视觉上藏起来）。
    ///
    /// 之前这里用的是 `tools`（也就是「工具」），链接指向 `#main-content` ——
    /// 标签说的是链接**去哪**，不是那一片叫什么，所以单独给一条。
    pub skip_to_content: String,
    pub favorites: String,
    pub all_tools: String,
    pub new_badge: String,
    pub add_favorite: String,
    pub remove_favorite: String,
    pub drag_hint: String,
    pub search: String,
    pub search_placeholder: String,
    pub toggle_menu: String,
    pub toggle_category: String,
    pub home: String,
    pub buy_me_a_coffee: String,
    pub support: String,
    pub about: String,
    pub github: String,
    pub dark_mode: String,
    pub light_mode: String,
    pub language: String,
    pub promo_title: String,
    pub promo_body: String,
    pub categories: String,
    pub tools: String,
    pub actions: String,
    pub random_tool: String,
    pub toggle_theme: String,
    pub no_results: String,
    pub run: String,
    pub copy: String,
    pub copied: String,
    pub clear: String,
    pub download: String,
    pub input: String,
    pub output: String,
    pub error: String,
    pub loading: String,
    pub not_found: String,
    pub maybe_cache: String,
    pub back_home: String,
    pub footer_note: String,
    pub sources: String,
    pub about_stack: String,
    pub about_license: String,
    pub about_stack_rust: String,
    pub about_stack_front: String,
    pub about_stack_icons: String,
    /// 侧栏底部版权行里那个链接的文字（“Rust port of it-tools”之类）。
    pub copyright_link: String,
    /// 侧栏底部的版权行，带 `{year}` 占位符（由 pages.rs 填年份）。
    pub copyright: String,
}

impl UiStrings {
    pub fn for_lang(lang: &str) -> Self {
        let u = |k: &str| i18n::t(lang, &format!("ui.{k}"));
        Self {
            tagline: u("tagline"),
            site_name: u("site_name"),
            skip_to_content: u("skip_to_content"),
            favorites: u("favorites"),
            all_tools: u("all_tools"),
            new_badge: u("new_badge"),
            add_favorite: u("add_favorite"),
            remove_favorite: u("remove_favorite"),
            drag_hint: u("drag_hint"),
            search: u("search"),
            search_placeholder: u("search_placeholder"),
            toggle_menu: u("toggle_menu"),
            toggle_category: u("toggle_category"),
            home: u("home"),
            buy_me_a_coffee: u("buy_me_a_coffee"),
            support: u("support"),
            about: u("about"),
            github: u("github"),
            dark_mode: u("dark_mode"),
            light_mode: u("light_mode"),
            language: u("language"),
            promo_title: u("promo_title"),
            promo_body: u("promo_body"),
            categories: u("categories"),
            tools: u("tools"),
            actions: u("actions"),
            random_tool: u("random_tool"),
            toggle_theme: u("toggle_theme"),
            no_results: u("no_results"),
            run: u("run"),
            copy: u("copy"),
            copied: u("copied"),
            clear: u("clear"),
            download: u("download"),
            input: u("input"),
            output: u("output"),
            error: u("error"),
            loading: u("loading"),
            not_found: u("not_found"),
            maybe_cache: u("maybe_cache"),
            back_home: u("back_home"),
            footer_note: u("footer_note"),
            sources: u("sources"),
            about_stack: u("about_stack"),
            about_license: u("about_license"),
            about_stack_rust: u("about_stack_rust"),
            about_stack_front: u("about_stack_front"),
            about_stack_icons: u("about_stack_icons"),
            copyright_link: u("copyright_link"),
            copyright: u("copyright"),
        }
    }

    /// 命令面板要用的少量文案。
    ///
    /// Tera 没有字面量对象语法（`{{ { "a": b } }}`），所以在 Rust 侧拼好，
    /// 模板里只做 `| json_encode`。
    pub fn palette_labels(&self) -> serde_json::Value {
        serde_json::json!({
            "tools": self.tools,
            "actions": self.actions,
            "random_tool": self.random_tool,
            "toggle_theme": self.toggle_theme,
            "about": self.about,
            "home": self.home,
            "no_results": self.no_results,
            "search": self.search,
            "run": self.run,
            "copy": self.copy,
            "copied": self.copied,
            "loading": self.loading,
            "output": self.output,
            "favorites": self.favorites,
        })
    }
}

/// 工具页表单字段（仅 `ImplKind::Api` 使用）
#[derive(Debug, Clone, Serialize)]
pub struct FieldView {
    pub name: String,
    pub label: String,
    /// `text` | `multiline` | `number` | `select` | `file`
    pub kind: String,
    /// 表单初始值
    pub default: Option<String>,
    pub options: Vec<OptionView>,
    /// 这个字段是不是和别的字段并排一行（见 `Tool::api_inline_fields`）。
    pub inline: bool,
    /// 并排时占多宽（CSS 的 flex 值，如 `1fr` / `170px`）。
    pub inline_width: Option<&'static str>,
    /// 这个字段**不配标签**（见 `Tool::api_label_less_fields`）。
    pub label_less: bool,
    /// 这个字段的标签在**左边**（见 `Tool::api_left_label` / `api_left_label_fields`）。
    pub left_label: bool,
}

/// `<select>` 的一个选项。同样因为 Tera 解构不了元组，传对象而不是 `(value, label)`。
#[derive(Debug, Clone, Serialize)]
pub struct OptionView {
    pub value: String,
    pub label: String,
}

/// 一个工具的模板视图
#[derive(Debug, Clone, Serialize)]
pub struct ToolView {
    pub slug: String,
    pub path: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub category_key: String,
    pub icon: String,
    pub keywords: Vec<String>,
    pub is_new: bool,
    /// `js` | `api` | `static`
    pub impl_kind: &'static str,
    pub script_url: Option<String>,
    /// 依赖的第三方库，须在 `script_url` **之前**加载
    pub lib_urls: Vec<String>,
    pub api_url: Option<String>,
    /// API 工具是否「输入即算」：改一个输入就自动提交一次（见 `Tool::api_live`）。
    pub api_live: bool,
    /// API 工具的定时刷新：那个字段**为空**时，每隔这么久刷新一次结果
    /// （见 `Tool::api_refresh`）。字段名与间隔各占一个，是为了让模板不用解元组。
    pub api_refresh_field: Option<String>,
    pub api_refresh_ms: Option<u64>,
    /// API 工具的结果是否「一行一个格式」地渲染（见 `Tool::api_rows`）。
    pub api_rows: bool,
    /// API 工具的表单标签是否在左边，以及标签列宽（见 `Tool::api_left_label`）。
    pub api_left_label: Option<&'static str>,
    /// 左标签那一列的对齐方式（见 `Tool::api_left_label_align`）。
    pub api_left_label_align: &'static str,
    /// 「一行一个格式」的结果里标签列的宽度（见 `Tool::api_row_label_width`）。
    pub api_row_label_width: &'static str,
    /// 「一行一个格式」的结果里标签列的对齐（见 `Tool::api_row_label_align`）。
    pub api_row_label_align: &'static str,
    /// API 工具结果区的标题（见 `Tool::api_result_label`）。None 表示用默认的「Output」。
    pub api_result_label: Option<String>,
    /// API 工具结果区的形状（见 `Tool::api_result_kind`）：`card` / `rows` / `text` /
    /// `textarea` / `bare` / `lines` / `keypair` / `tokens`。
    /// 模板按它挑结果区的骨架。
    pub api_result_kind: &'static str,
    /// 哪些字段并排占一半宽度（见 `Tool::api_half_fields`）。
    pub api_half_fields: Vec<&'static str>,
    /// 结果区要用的**全部**标题，按出现顺序（见 `Tool::api_result_labels`）。
    /// rsa 要「公钥 / 私钥」两个，otp 要「上一个 / 当前 / 下一个」三个。
    pub api_result_labels: Vec<String>,
    /// 这一页是不是没有卡片外壳（见 `Tool::plain_shell`）。
    pub plain_shell: bool,
    /// 这一页的输入区是不是没有卡片外壳（见 `Tool::plain_input`）。
    pub plain_input: bool,
    pub fields: Vec<FieldView>,
    /// `ImplKind::Static` 的内容，已渲染成 HTML
    pub content: Option<String>,
}

pub fn tool_view(tool: &Tool, lang: &str) -> ToolView {
    let name = i18n::t(lang, tool.name_key);
    let description = i18n::t(lang, tool.desc_key);
    // 语言包缺 key 时 i18n::t 会原样返回 key，这时退回注册表里的兜底文案
    let name = if name == tool.name_key {
        tool.path.trim_start_matches('/').to_string()
    } else {
        name
    };
    let description = if description == tool.desc_key {
        String::new()
    } else {
        description
    };

    let (impl_kind, fields) = match tool.impl_kind {
        ImplKind::Js => ("js", Vec::new()),
        ImplKind::Static => ("static", Vec::new()),
        ImplKind::Api(spec) => (
            "api",
            spec.fields
                .iter()
                .map(|f| {
                    let inline_width = tool
                        .api_inline_fields()
                        .iter()
                        .find(|(name, _)| *name == f.name)
                        .map(|(_, w)| *w);
                    // 左标签是「整张表单」还是「只有某几个字段」由注册表决定
                    let left_fields = tool.api_left_label_fields();
                    let left_label = tool.api_left_label().is_some()
                        && (left_fields.is_empty() || left_fields.contains(&f.name));
                    FieldView {
                        name: f.name.to_string(),
                        label: i18n::t(lang, f.label_key),
                        kind: format!("{:?}", f.kind).to_lowercase(),
                        default: f.default.map(str::to_string),
                        options: f
                            .options
                            .iter()
                            .map(|(v, l)| {
                                // 下拉项的显示文案同样走 i18n，key 形如 `opt.aes-gcm`
                                let key = format!("opt.{}", f.name.replace(['-', '_'], "."));
                                let label_key = format!("{key}.{v}");
                                let translated = i18n::t(lang, &label_key);
                                let label = if translated == label_key {
                                    (*l).to_string()
                                } else {
                                    translated
                                };
                                OptionView {
                                    value: v.to_string(),
                                    label,
                                }
                            })
                            .collect(),
                        inline: inline_width.is_some(),
                        inline_width,
                        label_less: tool.api_label_less_fields().contains(&f.name),
                        left_label,
                    }
                })
                .collect(),
        ),
    };

    ToolView {
        slug: tool.slug.to_string(),
        path: tool.path.to_string(),
        name,
        description,
        category: tool.category.id().to_string(),
        category_key: tool.category.name_key().to_string(),
        icon: tool.icon.to_string(),
        keywords: tool.keywords.iter().map(|k| k.to_string()).collect(),
        is_new: tool.is_new,
        impl_kind,
        script_url: match tool.impl_kind {
            ImplKind::Js => Some(tool.script_url()),
            _ => None,
        },
        lib_urls: match tool.impl_kind {
            ImplKind::Js => tool.lib_urls(),
            _ => Vec::new(),
        },
        api_url: tool.api_url(),
        api_live: tool.api_live(),
        api_refresh_field: tool.api_refresh().map(|(field, _)| field.to_string()),
        api_refresh_ms: tool.api_refresh().map(|(_, ms)| ms),
        api_rows: tool.api_rows(),
        api_left_label: tool.api_left_label(),
        api_left_label_align: tool.api_left_label_align(),
        api_row_label_width: tool.api_row_label_width(),
        api_row_label_align: tool.api_row_label_align(),
        api_result_label: tool.api_result_label().and_then(|k| {
            // 语言包里没有这一条时 i18n::t 会把 key 原样返回 —— 那就当没有，
            // 让模板退回默认的「Output」。
            let v = i18n::t(lang, k);
            if v == k {
                None
            } else {
                Some(v)
            }
        }),
        api_result_kind: match tool.api_result_kind() {
            crate::registry::ResultKind::Card => "card",
            crate::registry::ResultKind::Rows => "rows",
            crate::registry::ResultKind::Text => "text",
            crate::registry::ResultKind::TextArea => "textarea",
            crate::registry::ResultKind::Bare => "bare",
            crate::registry::ResultKind::Lines => "lines",
            crate::registry::ResultKind::KeyPair => "keypair",
            crate::registry::ResultKind::Tokens => "tokens",
        },
        api_half_fields: tool.api_half_fields().to_vec(),
        api_result_labels: tool
            .api_result_labels()
            .iter()
            .map(|k| {
                let v = i18n::t(lang, k);
                if v == *k {
                    // 语言包里缺这一条 —— 留空，模板会用主标题顶上，
                    // 总比显示一个 key 字符串强。
                    String::new()
                } else {
                    v
                }
            })
            .collect(),
        plain_shell: tool.plain_shell(),
        plain_input: tool.plain_input(),
        fields,
        content: match tool.impl_kind {
            ImplKind::Static => static_content(tool.slug),
            _ => None,
        },
    }
}

/// 读取 `static/content/{slug}.md`，渲染成 HTML
///
/// 内容是 Markdown（上游也是 `.md`），直接塞进模板就是一堆 `##` 和 ``` 围栏。
fn static_content(slug: &str) -> Option<String> {
    let file = crate::embed::StaticAsset::get(&format!("content/{slug}.md"))?;
    let markdown = String::from_utf8(file.data.to_vec()).ok()?;
    Some(crate::markdown::to_html(&markdown))
}

/// 首页/侧栏用的分类分组
#[derive(Debug, Clone, Serialize)]
pub struct CategoryView {
    pub id: String,
    pub label: String,
    pub tools: Vec<ToolView>,
}

pub fn category_views(lang: &str) -> Vec<CategoryView> {
    Category::ALL
        .iter()
        .map(|&cat| {
            let key = cat.name_key();
            let label = i18n::t(lang, key);
            CategoryView {
                id: cat.id().to_string(),
                label: if label == key {
                    cat.label().to_string()
                } else {
                    label
                },
                tools: registry::by_category(cat)
                    .map(|t| tool_view(t, lang))
                    .collect(),
            }
        })
        .collect()
}

/// 侧栏 + 命令面板共用的导航数据
#[derive(Debug, Clone, Serialize)]
pub struct NavView {
    pub categories: Vec<CategoryView>,
    pub search: Vec<SearchEntry>,
}

/// 命令面板的模糊搜索条目（名称 / 描述 / 关键词）
#[derive(Debug, Clone, Serialize)]
pub struct SearchEntry {
    pub path: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub icon: String,
    pub keywords: Vec<String>,
}

pub fn nav_view(lang: &str) -> NavView {
    let categories = category_views(lang);
    let search = categories
        .iter()
        .flat_map(|c| c.tools.iter())
        .map(|t| SearchEntry {
            path: t.path.clone(),
            name: t.name.clone(),
            description: t.description.clone(),
            category: t.category.clone(),
            icon: t.icon.clone(),
            keywords: t.keywords.clone(),
        })
        .collect();
    NavView {
        categories,
        search,
    }
}

#[cfg(test)]
mod tests {
    use crate::registry::{ImplKind, TOOLS};

    /// 把 `<code>…</code>` / `<pre>…</pre>` 的**内容**摘掉，只留标签。
    ///
    /// Markdown 速查表里有一行专门讲「围栏代码块怎么写」，那一格里的 ```
    /// 是**正文** —— 它就是要给人看围栏符号的，渲染之后自然还在。
    /// 真正要抓的是「没渲染的 Markdown 源码漏到了页面上」，那只会出现在
    /// 代码元素之外。
    fn without_code_contents(html: &str) -> String {
        let mut out = String::with_capacity(html.len());
        let mut i = 0;
        while i < html.len() {
            let Some(rel) = html[i..].find('<') else {
                out.push_str(&html[i..]);
                break;
            };
            let at = i + rel;
            out.push_str(&html[i..at]);
            let Some(gt) = html[at..].find('>') else {
                out.push_str(&html[at..]);
                break;
            };
            let tag = &html[at..at + gt + 1];
            let name = tag
                .trim_start_matches('<')
                .trim_start_matches('/')
                .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .next()
                .unwrap_or("");
            if matches!(name, "code" | "pre") && !tag.starts_with("</") {
                out.push_str(tag);
                match html[at..].find(&format!("</{name}")) {
                    Some(end) => i = at + end,
                    None => {
                        out.push_str(&html[at..]);
                        break;
                    }
                }
            } else {
                out.push_str(tag);
                i = at + gt + 1;
            }
        }
        out
    }

    /// 速查表的内容是 Markdown，模板里显示的必须是**渲染过的 HTML**。
    ///
    /// 之前是直接塞原文，页面上就是一屏 `##` 和 ``` 围栏 ——
    /// 这个断言就是为了守住那条界线。
    #[test]
    fn static_tools_render_their_markdown() {
        let mut checked = 0;
        for t in TOOLS {
            if !matches!(t.impl_kind, ImplKind::Static) {
                continue;
            }
            let html = super::static_content(t.slug)
                .unwrap_or_else(|| panic!("{} 读不到内容", t.slug));
            assert!(
                html.contains("<h"),
                "{} 的内容里没有渲染出的标题:\n{}",
                t.slug,
                html.chars().take(300).collect::<String>()
            );
            let outside_code = without_code_contents(&html);
            assert!(
                !outside_code.contains("```"),
                "{} 的内容里还留着代码围栏:\n{}",
                t.slug,
                outside_code.chars().take(300).collect::<String>()
            );
            checked += 1;
        }
        assert!(checked > 0, "一个静态工具都没有，测试没意义");
    }
}
