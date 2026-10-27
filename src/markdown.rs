//! 服务端 Markdown 渲染。
//!
//! `ImplKind::Static` 那批工具（git-memo / regex-memo …）的内容是仓库里的
//! `.md` 文件。模板里直接塞原文，页面上就是一屏 `##` 和 ``` 围栏 ——
//! 上游（Vue 版）靠 vite 把 `.md` 编译成组件模板，最终显示的是渲染过的
//! HTML，这里在服务端把这一段补上。
//!
//! 参考实现：src/tools/git-memo/、src/tools/regex-memo/（it-tools, GPLv3）

use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};

/// Markdown 解析选项。
///
/// 速查表里用到了表格（正则速查表整张就是一张大表），所以必须开
/// `ENABLE_TABLES`。删除线、任务列表是 GFM 的常见写法，一并打开，
/// 免得内容里的 `~~old~~` 原样显示出来。
fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// 把 Markdown 渲染成 HTML。
///
/// **原始 HTML 一律转义成文本**（跟 markdown-to-html 工具的 `html: false`
/// 一个口径）：内容虽然是自己仓库里的文件，但渲染这条路不该变成一个
/// 能塞标签的口子 —— 万一以后内容改成从别处来，这个转义就是唯一的防线。
///
/// 链接协议也一起限制：`javascript:`、`data:` 这类不安全的协议不渲染成
/// 可点的链接，只留文字。
pub fn to_html(markdown: &str) -> String {
    let parser = Parser::new_ext(markdown, options());
    let mut out = String::new();
    // 链接里的文字要不要插 <wbr>（见 with_breaks）。
    let mut in_link = false;
    html::push_html(
        &mut out,
        parser.flat_map(|event| {
            let events: Vec<Event> = match event {
                // pulldown-cmark 0.13 没有 ENABLE_HTML 开关，原始 HTML 一定会
                // 被解析成 Event::Html / Event::InlineHtml，要转义只能在这里换掉。
                Event::Html(s) | Event::InlineHtml(s) => vec![Event::Text(s)],
                Event::Start(tag @ Tag::Link { .. }) => {
                    in_link = true;
                    vec![Event::Start(guard_url(tag))]
                }
                Event::Start(tag @ Tag::Image { .. }) => vec![Event::Start(guard_url(tag))],
                Event::End(TagEnd::Link) => {
                    in_link = false;
                    vec![Event::End(TagEnd::Link)]
                }
                Event::Text(s) if in_link => with_breaks(s),
                event => vec![event],
            };
            events.into_iter()
        }),
    );
    out
}

/// 在链接文字的「路径斜杠」后面插 `<wbr>`（可换行点）。
///
/// 速查表的参考链接整条都是 URL，窄屏上放不下。浏览器的换行规则**不在斜杠
/// 后面断**（`/` 在 UAX #14 里是 SY 类），于是它只能挑一个「实在没别的办法」
/// 的位置硬断 —— 断在词中间：
///
/// ```text
/// https://www.smashingmagazine.com/ad
/// vanced-regular-expressions/
/// ```
///
/// 插一个 `<wbr>` 就等于在斜杠后面手动加了一个换行机会，浏览器就会断在
/// `com/` 后面（路径分段的地方），而不是把 `advanced` 拆成 `ad` + `vanced`。
///
/// `://` 里的两个斜杠不插 —— 否则 `https://` 自己会被拆成 `https:/` + `/`。
fn with_breaks(s: CowStr) -> Vec<Event> {
    let bytes = s.as_ref().as_bytes();
    if !bytes.contains(&b'/') {
        return vec![Event::Text(s)];
    }
    let text = s.as_ref();
    // 只给「整条就是网址」的链接文字加换行点。
    // 「Meridiems (AM/PM)」这种带斜杠的普通词不算 —— 给它加换行点的话，
    // 窄屏上会断成「Meridiems (AM/」「PM)」，括号里被拆开更难看。
    if !text.contains("://") && !text.starts_with("www.") {
        return vec![Event::Text(s)];
    }
    let mut out = Vec::new();
    let mut cut = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b != b'/' {
            continue;
        }
        let prev_is_slash = i > 0 && bytes[i - 1] == b'/';
        let next_is_slash = bytes.get(i + 1) == Some(&b'/');
        if prev_is_slash || next_is_slash {
            continue;
        }
        out.push(Event::Text(CowStr::from(text[cut..=i].to_string())));
        out.push(Event::InlineHtml(CowStr::from("<wbr>")));
        cut = i + 1;
    }
    if cut < text.len() {
        out.push(Event::Text(CowStr::from(text[cut..].to_string())));
    }
    out
}

/// 把链接目标里不安全的协议换成 `#`。
///
/// Markdown 的链接目标可以写 `[x](javascript:alert(1))`，渲染出来就是一个
/// 可点的危险链接。转义只管文本，管不到属性值，所以这里再过一道。
///
/// 在**事件流**上改，而不是渲染完再拿字符串找 `href="` —— 后者会把正文里
/// 恰好写着 `href="..."` 的文字也当成链接改掉。
fn guard_url(tag: Tag) -> Tag {
    match tag {
        Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        } => Tag::Link {
            link_type,
            dest_url: safe_url(dest_url),
            title,
            id,
        },
        Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        } => Tag::Image {
            link_type,
            dest_url: safe_url(dest_url),
            title,
            id,
        },
        other => other,
    }
}

/// 不安全的协议换成 `#`。
fn safe_url(url: CowStr) -> CowStr {
    if is_safe_url(&url) {
        url
    } else {
        CowStr::from("#")
    }
}

/// URL 协议是否安全。
///
/// 相对路径、`#锚点`、`mailto:` 之类放行；带协议的只放行 `http` / `https`
/// 等少数几个。
fn is_safe_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    // 协议写在 `:` 前面。冒号后面不能再出现冒号或斜杠 —— 那样就不是协议了，
    // 例如 `foo/bar:baz` 里的冒号是路径的一部分。
    let Some(colon) = lower.find(':') else {
        // 没有冒号 —— 相对路径，放行
        return true;
    };
    let scheme = &lower[..colon];
    if scheme.contains('/') || scheme.contains('?') || scheme.contains('#') {
        return true;
    }
    matches!(scheme, "http" | "https" | "mailto" | "ftp")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_headings_and_paragraphs() {
        let html = to_html("## Configuration\n\nSet the global config\n");
        assert!(html.contains("<h2>Configuration</h2>"), "{html}");
        assert!(html.contains("<p>Set the global config</p>"), "{html}");
        assert!(!html.contains("##"), "标题标记不该出现在结果里: {html}");
    }

    #[test]
    fn renders_tables() {
        let html = to_html("Expression | Description\n:--|:--\n`\\d` | digit\n");
        assert!(html.contains("<table>"), "{html}");
        // `:--` 是对齐标记，渲染出来是 th 上的行内样式
        assert!(html.contains(">Expression</th>"), "{html}");
        assert!(html.contains("<code>\\d</code>"), "{html}");
    }

    #[test]
    fn renders_fenced_code_blocks() {
        let html = to_html("```shell\ngit config --global user.name \"[name]\"\n```\n");
        assert!(html.contains("<pre><code class=\"language-shell\">"), "{html}");
        assert!(html.contains("git config --global"), "{html}");
        assert!(!html.contains("```"), "围栏不该出现在结果里: {html}");
    }

    #[test]
    fn escapes_raw_html() {
        let html = to_html("<script>alert(1)</script>\n");
        assert!(!html.contains("<script>"), "原始 HTML 必须被转义: {html}");
        assert!(html.contains("&lt;script&gt;"), "{html}");
    }

    #[test]
    fn escapes_inline_html() {
        let html = to_html("text <b>bold</b> more\n");
        assert!(!html.contains("<b>"), "行内 HTML 必须被转义: {html}");
        assert!(html.contains("&lt;b&gt;"), "{html}");
    }

    #[test]
    fn keeps_safe_links_clickable() {
        let html = to_html("[it-tools](https://it-tools.tech)\n");
        assert!(html.contains("href=\"https://it-tools.tech\""), "{html}");
    }

    #[test]
    fn neutralizes_dangerous_link_protocols() {
        let html = to_html("[x](javascript:alert(1))\n");
        assert!(!html.contains("javascript:"), "{html}");
        assert!(html.contains("href=\"#\""), "{html}");

        let html = to_html("[x](data:text/html;base64,PHNjcmlwdD4=)\n");
        assert!(!html.contains("data:text/html"), "{html}");
    }

    #[test]
    fn keeps_relative_links() {
        let html = to_html("[x](/hash-text) and [y](relative/path)\n");
        assert!(html.contains("href=\"/hash-text\""), "{html}");
        assert!(html.contains("href=\"relative/path\""), "{html}");
    }

    #[test]
    fn links_get_a_break_opportunity_after_each_path_slash() {
        // 窄屏上整条 URL 放不下时，浏览器该在路径分段处断，而不是把词拆开
        let html = to_html("[https://example.com/a/b](https://example.com/a/b)\n");
        assert!(html.contains(">https://example.com/<wbr>a/<wbr>b</a>"), "{html}");
    }

    #[test]
    fn the_scheme_slashes_are_left_alone() {
        // "://" 里的斜杠不插 <wbr>，否则 https:// 自己会被拆成 "https:/" + "/"
        let html = to_html("[https://example.com/a](https://example.com/a)\n");
        assert!(html.contains(">https://example.com/<wbr>a</a>"), "{html}");
        assert!(!html.contains("https:/<wbr>"), "{html}");
    }

    #[test]
    fn text_outside_links_gets_no_break_opportunities() {
        let html = to_html("see a/b/c for details\n");
        assert!(!html.contains("<wbr>"), "{html}");
    }

    #[test]
    fn link_words_that_only_contain_a_slash_are_left_alone() {
        // 「Meridiems (AM/PM)」不是网址 —— 加了换行点反而会断成
        // 「Meridiems (AM/」「PM)」，括号里被拆开
        let html = to_html("[Meridiems (AM/PM)](https://example.com/x)\n");
        assert!(!html.contains("<wbr>"), "{html}");
    }

    #[test]
    fn text_that_looks_like_a_link_is_left_alone() {
        // 正文里正好写着 href="..." 的时候，不该被当成链接改掉
        let html = to_html("set `href=\"x\"` in the config\n");
        assert!(html.contains("href="), "{html}");
    }

    #[test]
    fn a_colon_inside_a_path_is_not_a_scheme() {
        // `foo/bar:baz` 里的冒号是路径的一部分，不是协议
        assert!(is_safe_url("foo/bar:baz"));
        assert!(is_safe_url("a.b.c"));
        assert!(is_safe_url("#anchor"));
        assert!(!is_safe_url("javascript:x"));
        assert!(!is_safe_url("JavaScript:x"));
        assert!(!is_safe_url("vbscript:x"));
    }

    /// 表格单元格里可以放带竖线的代码。
    ///
    /// 表格是按 `|` 分单元格的，代码里的竖线不转义就会把单元格劈开。
    /// GFM 的规矩是转义成 `\|`，渲染出来还是 `|`。
    #[test]
    fn table_cells_can_hold_pipes() {
        let html = to_html("| a | b |\n|:--|:--|\n| `x \\| y` | z |\n");
        assert!(html.contains("<td style=\"text-align: left\"><code>x | y</code></td>"), "{html}");
    }
}
