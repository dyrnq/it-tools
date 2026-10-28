//! 工具注册表 —— 全站唯一的工具事实来源。
//!
//! 左侧导航、首页卡片、搜索索引、路由分发、工具页表单渲染全部由 [`TOOLS`] 驱动，
//! 新增一个工具只需在这里加一条 + 写一份实现（JS 模块或 Rust handler）。

pub mod categories;
pub mod libs;
pub mod tools;

pub use categories::Category;
pub use tools::TOOLS;

use serde::Serialize;

/// 表单字段类型。`tool.html` 据此用 layui 渲染通用表单。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    /// 单行输入
    Text,
    /// 多行文本域
    Multiline,
    /// 数字输入
    Number,
    /// 下拉选择，需配合 [`ApiField::options`]
    Select,
    /// 文件上传（multipart 表单）
    File,
    /// 开关。提交时永远是 JSON 的 `true` / `false`（不勾也要发 false，
    /// 不能因为没勾就把这个键省掉 —— handler 分不清「false」和「没传」）。
    //-
    //- 现在还没有工具用它 —— 表单字段就那么几种时，JSON→C# 那类要九个开关的
    //- 工具根本没法做。先把渲染与提交这一半铺好（模板 + app.js 都已支持），
    //- 下一个带开关的服务端工具直接就能挂上。
    #[allow(dead_code)]
    Boolean,
}

/// 一个 API 工具的输入字段描述。
#[derive(Debug, Clone, Copy)]
pub struct ApiField {
    /// 字段名，同时作为提交到 handler 的 JSON 键
    pub name: &'static str,
    /// i18n key，形如 `field.text`
    pub label_key: &'static str,
    pub kind: FieldKind,
    /// 表单初始值
    pub default: Option<&'static str>,
    /// `(值, 显示文案)`，仅 `Select` 使用
    pub options: &'static [(&'static str, &'static str)],
}

/// 走服务端实现的工具的接口契约。
#[derive(Debug, Clone, Copy)]
pub struct ApiSpec {
    /// 对应 `/api/tools/{endpoint}`
    pub endpoint: &'static str,
    pub fields: &'static [ApiField],
}

/// 工具的实现方式 —— 对应 _docs/arch.md 第 6 条：
/// 能用 JS 做的用 JS，做不了的才由 Rust 暴露接口。
#[derive(Debug, Clone, Copy)]
pub enum ImplKind {
    /// 加载 `/assets/js/tools/{slug}.js`，模块自行接管页面正文
    Js,
    /// 渲染通用表单，ajax 提交到 `/api/tools/{endpoint}`
    Api(ApiSpec),
    /// 纯静态内容，直接由模板渲染
    Static,
}

impl ImplKind {
    pub fn api_spec(&self) -> Option<&ApiSpec> {
        match self {
            ImplKind::Api(spec) => Some(spec),
            _ => None,
        }
    }
}

/// API 工具结果区的形状。
///
/// 参考实现里每个工具的结果区长得都不一样 —— 不是笼统的「一个输出框」：
///
/// | 形状 | 原版组件 | 用它的工具 |
/// |---|---|---|
/// | `Card` | `c-card` + 一张两列表格 | 我们自己加的服务端工具（没有原版可对） |
/// | `Rows` | `input-copyable` 一行一个格式 | date-time-converter、hash-text |
/// | `Text` | 只读**单行**输入框（标签在上） | hmac-generator |
/// | `TextArea` | 只读**多行**文本框（标签在上、等宽） | encryption |
/// | `Bare` | 只读单行输入框，**没有标签**、文字居中 | bcrypt |
/// | `Lines` | 一张装着几行字的 `c-card` | mac-address-lookup |
/// | `KeyPair` | 两个 `<h3>` + 两张代码卡 | rsa-key-pair-generator |
/// | `Tokens` | 一行三个令牌按钮 | otp-code-generator-and-validator |
///
/// 以前所有 API 工具都走 `Card` 这一条路 —— 一张「Output」卡片装下所有结果。
/// 那样对齐不了任何一个有原版可对的工具：原版的哈希是一个**只读输入框**，
/// 不是卡片里的一行字；原版的密钥是**两张带标题的代码卡**，不是一张表。
///
/// 「只读输入框」这一族还分三份，因为原版自己就分了三份：
/// hmac 的结果是**单行**的（`input-copyable` 落到 `c-input-text` 上，
/// `type="textarea"` 没生效，还是个单行框）；encryption 的结果是
/// **三行等宽**的文本域（`multiline monospace readonly autosize`）；
/// bcrypt 的结果**连标签都没有** —— 原版写的是
/// `<c-input-text :value="hashed" readonly text-center />`，
/// 没有 `label` 就没有标签，文字还是居中的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultKind {
    /// 一张白卡片，里面是主结果 + 补充信息表
    Card,
    /// 一行一个格式：标签在左、只读输入框、框里浮一个复制图标
    Rows,
    /// 一个只读**单行**输入框（标签在上），像原版的 `c-input-text`
    Text,
    /// 一个只读**多行**文本框（标签在上、等宽）
    TextArea,
    /// 一个只读单行输入框，**没有标签**、文字居中
    Bare,
    /// 一张卡片，里面一行行普通文字
    Lines,
    /// 两张代码卡，各带一个标题（`<h3>`）
    KeyPair,
    /// 一行三个令牌（上一个 / 当前 / 下一个）
    Tokens,
}

/// 一个工具的注册信息。
#[derive(Debug, Clone, Copy)]
pub struct Tool {
    /// 标识符，同时也是前端 JS 模块名 `js/tools/{slug}.js`
    pub slug: &'static str,
    /// 路由路径。注意有些工具的 slug 与 path 不同
    /// （如 `json-viewer` → `/json-prettify`）
    pub path: &'static str,
    /// i18n key，按**路由名**取：`tools.{path 去斜杠}.title`
    pub name_key: &'static str,
    pub desc_key: &'static str,
    pub category: Category,
    /// 图标名，对应 `static/img/icons.svg` 里的 `<symbol id="i-{icon}">`
    pub icon: &'static str,
    pub keywords: &'static [&'static str],
    /// 历史路由。直接访问旧路径是 **303**（顺带把语言写进 Cookie），
    /// `GET /redirect/{旧路径}` 是 **301**。
    pub redirect_from: &'static [&'static str],
    pub is_new: bool,
    pub impl_kind: ImplKind,
}

impl Tool {
    /// i18n 命名空间，如 `/hash-text` → `tools.hash-text`
    #[allow(dead_code)] // 注册表完整性单测用
    pub fn i18n_base(&self) -> String {
        format!("tools.{}", self.path.trim_start_matches('/'))
    }

    /// 前端 JS 模块的 URL
    pub fn script_url(&self) -> String {
        format!("/assets/js/tools/{}.js", self.slug)
    }

    /// 该工具依赖的第三方库 URL（见 `static/lib/manifest.tsv`），
    /// 模板必须在工具模块**之前**引入 —— 库是同步执行的 IIFE，
    /// 顺序反了模块里读到的就是 undefined。
    pub fn lib_urls(&self) -> Vec<String> {
        libs::lib_urls(self.slug)
    }

    /// 接口地址，仅 `ImplKind::Api` 有意义
    pub fn api_url(&self) -> Option<String> {
        self.impl_kind
            .api_spec()
            .map(|spec| format!("/api/tools/{}", spec.endpoint))
    }

    /// 这个 API 工具是不是「输入即算」。
    ///
    /// 参考实现的工具都是改一个输入就立刻出结果（hash-text、hmac-generator、
    /// date-time-converter 都是这样）。服务端实现的工具也该有同样的手感，
    /// 所以表单改动后会自动提交一次（Run 按钮仍然保留）。
    ///
    /// 但不是全部都算 —— 下面这些是「按一次算一次」的动作型工具，
    /// 自动触发会白烧 CPU 或者反复打网络：
    ///   * rsa-key-pair-generator / ssh-key-pair-generator / csr-generator /
    ///     x509-certificate-generator —— 生成密钥/证书，秒级 CPU
    ///   * bcrypt / argon2 —— 高 cost 下一次哈希要几百毫秒到几秒
    ///   * htpasswd / otp-code-generator-and-validator —— 本质是「生成」按钮
    ///   * benchmark-builder —— 服务端计时，跑一轮要几秒
    ///   * dns-query —— 每敲一个键就发一次 DNS 查询
    pub fn api_live(&self) -> bool {
        if self.impl_kind.api_spec().is_none() {
            return false;
        }
        matches!(
            self.slug,
            "hash-text"
                | "encryption"
                | "hmac-generator"
                | "date-time-converter"
                | "jasypt"
                | "mac-address-lookup"
                | "ssl-certificate-decoder"
                | "iana-timezone-index"
                | "ipv6-address-converter"
                | "ipv6-subnet-calculator"
                | "week-number-converter"
                | "pdf-signature-checker"
                | "crc-calculator"
                | "ip-cidr-to-range"
                | "ip-range-to-cidr"
                | "ipv4-subnets-list"
                | "cidr-in-cidr"
                | "ip-include-exclude"
        )
    }

    /// 这个 API 工具要不要**定时刷新**结果，以及在什么条件下刷新。
    ///
    /// 参考实现的 date-time-converter：输入框空着的时候，十行结果显示的是
    /// **当前时刻**，而且是**每秒都在跳**的（VueUse 的 `useNow`）。
    /// 输入框一有值，就换成解析出来的时刻，不再跳了 —— 实测原版：
    /// 空着的时候每秒跳一格，填了 `2023-04-12T23:10:24+02:00` 之后连采四帧纹丝不动。
    ///
    /// 我们这边结果是服务端算的（一次请求一张表），所以「跳」只能是
    /// 前端定时再问一次服务端 —— 见 `static/js/app.js` 的 `initApiForm`。
    ///
    /// 返回值是 `(字段名, 间隔毫秒)`：那个字段**为空**时才刷新。
    /// 「为空」的判据跟服务端一致（服务端也是拿空字符串当「现在」；
    /// 只打了空格的那种在两边都不算「现在」）。
    pub fn api_refresh(&self) -> Option<(&'static str, u64)> {
        if self.impl_kind.api_spec().is_none() {
            return None;
        }
        match self.slug {
            // 一秒一个刻度 —— 跟参考实现一样（`useNow` 默认也是一秒）。
            "date-time-converter" => Some(("date", 1000)),
            _ => None,
        }
    }

    /// 这个 API 工具的结果是不是「一行一个格式」那种排法。
    ///
    /// 参考实现里 date-time-converter 的结果是这样的：输入框下面一条分隔线，
    /// 然后每个格式占一行 —— 左边是格式名（150px，右对齐），右边是一个只读输入框，
    /// 复制图标叠在输入框里。每行都能单独复制。
    ///
    /// 通用 API 表单默认把结果塞进下面那张「Output」卡片（一个总复制按钮 +
    /// 一张两列表格），那套排法适合「一个结果 + 若干补充信息」的工具
    /// （RSA 私钥、密文、哈希）。日期转换是「同一个时刻的多种写法」，
    /// 每一种都同等重要，挤进一张表里反而不如一行一个清楚，所以单独走行式渲染。
    ///
    /// 服务端在 `rows` 里按常见顺序给出各个格式，顺序写死在
    /// `src/tools/date_time_converter.rs` 里（字母序不符合阅读习惯）。
    ///
    /// hash-text 也走这条路：参考实现里它是一列「算法名 + 只读框 + 复制图标」，
    /// 挤进一张两列表格反而看不出每行能单独复制。
    /// 它只在「一次算完所有」时给 rows —— 用户单独选了某个算法时
    /// 服务端只回一个 output，rows 是空的，前端会落回普通输出。
    /// 这个 API 工具的表单标签是不是「在左边」，返回标签列的宽度。
    ///
    /// 参考实现的 `c-input-text` 默认是**标签在上**（label-position="top"），
    /// 只有 bcrypt（label-position="left" label-width="120px"）、
    /// rsa-key-pair-generator（n-form-item label-placement="left" label-width="100"）
    /// 和 otp-code-generator-and-validator（label-width="90px"）这三个
    /// 显式写成了左标签。
    ///
    /// 通用表单默认按「标签在上」渲染（`c-input-text` 的默认值），
    /// 这三个工具要单独改成两列。返回 None 就是默认。
    pub fn api_left_label(&self) -> Option<&'static str> {
        match self.slug {
            "bcrypt" => Some("120px"),
            "rsa-key-pair-generator" => Some("100px"),
            "otp-code-generator-and-validator" => Some("90px"),
            _ => None,
        }
    }

    pub fn api_rows(&self) -> bool {
        self.api_result_kind() == ResultKind::Rows
    }

    /// 左标签那一列**怎么对齐**。
    ///
    /// 参考实现里 `c-input-text` 的 `label-align` 默认是 'left'，
    /// 但显式写了 `label-align="right"` 的几个工具（bcrypt、otp）都是右对齐；
    /// naive-ui 的 `n-form-item` 没有 `label-align` 这个属性，
    /// 实测它的标签一律**右对齐**（rsa-key-pair-generator 量出来就是 right）。
    ///
    /// 我们这三个左标签工具（bcrypt / rsa / otp）用的都是右对齐。
    pub fn api_left_label_align(&self) -> &'static str {
        match self.slug {
            _ => "right",
        }
    }

    /// 「一行一个格式」的结果里，标签列有多宽。
    ///
    /// 两个走行式的工具宽度不一样：
    /// date-time-converter 的行标签是 input-copyable 显式写的
    /// `label-width="150px"`；hash-text 的是 `n-input-group-label`
    /// （自带 120px 宽的边框单元格）。
    pub fn api_row_label_width(&self) -> &'static str {
        match self.slug {
            "hash-text" => "120px",
            _ => "150px",
        }
    }

    /// 「一行一个格式」的结果里，标签列**怎么对齐**。
    ///
    /// 这两个工具的结果行用的是**不同的组件**，对齐方向也就相反：
    ///
    /// - date-time-converter 用 `input-copyable`，显式写了
    ///   `label-position="left" label-width="150px" label-align="right"` → **右**对齐；
    /// - hash-text 用 `n-input-group-label`（带边框的格子），naive-ui 里
    ///   格子里的文字是**左**对齐（实测 start）→ **左**对齐。
    ///
    /// 别把「原版都是左标签」当成「原版都是右对齐」—— 位置和对齐是两件事。
    pub fn api_row_label_align(&self) -> &'static str {
        match self.slug {
            "hash-text" => "left",
            _ => "right",
        }
    }

    /// 这个 API 工具的结果区用哪种形状（见 [`ResultKind`]）。
    ///
    /// 上面对到原版的那几个工具有原版可对 —— 剩下的服务端工具是我们自己加的
    /// （argon2、jasypt、csr-generator…），没有原版可对，就走默认的 `Card`。
    pub fn api_result_kind(&self) -> ResultKind {
        match self.slug {
            "date-time-converter" | "hash-text" => ResultKind::Rows,
            "hmac-generator" => ResultKind::Text,
            "encryption" => ResultKind::TextArea,
            "bcrypt" => ResultKind::Bare,
            "mac-address-lookup" => ResultKind::Lines,
            "rsa-key-pair-generator" => ResultKind::KeyPair,
            "otp-code-generator-and-validator" => ResultKind::Tokens,
            _ => ResultKind::Card,
        }
    }

    /// 这个工具里哪些字段**并排占一半宽度**。
    ///
    /// 原版有些工具把两个下拉框并排放（`hmac-generator` 的
    /// 「Hashing function」和「Output encoding」就是一个 `flex gap-2` 的行，
    /// 两个框各占一半）。我们默认把字段竖着排下来，那两个框就分成了两行。
    ///
    /// 这里登记的字段名必须**相邻**（模板按顺序渲染），否则并排的两栏
    /// 中间会夹着别的字段。返回空表 = 全部竖排。
    pub fn api_half_fields(&self) -> &'static [&'static str] {
        match self.slug {
            // 「Hashing function」+「Output encoding」——原版就是并排的。
            "hmac-generator" => &["algorithm", "output_encoding"],
            _ => &[],
        }
    }

    /// 这个 API 工具的输入区里，哪些字段**并排一行**，以及各自占多宽。
    ///
    /// 返回的是 `(字段名, flex 宽度)`：宽度直接写进元素的 `style="flex: …"`。
    ///
    /// 参考实现的 date-time-converter 输入区是
    /// `<div flex gap-2>` 里一个 `c-input-text`（占满剩余宽度）加一个
    /// `c-select`（`style="flex: 0 0 170px"`）—— **两个控件都没有标签**，
    /// 也**不是上下排**。我们默认把字段竖着排、每个都配个标签，
    /// 于是那一页的输入区比原版多出两行字、也窄一截。
    pub fn api_inline_fields(&self) -> &'static [(&'static str, &'static str)] {
        match self.slug {
            "date-time-converter" => &[("date", "1 1 auto"), ("format", "0 0 170px")],
            _ => &[],
        }
    }

    /// 这个 API 工具里哪些字段用**左标签**（其余字段是上标签）。
    ///
    /// 空表 = 全部字段都用左标签（见 [`Tool::api_left_label`]）。
    ///
    /// otp 是个典型的混合：原版只有右栏的「Count:」和「Padded hex:」是
    /// 左标签（90px、右对齐），左栏的「Secret」/「Secret in hexadecimal」/
    /// 「Epoch」都是上标签。我们整张表单都用左标签，于是左栏多了三行字。
    pub fn api_left_label_fields(&self) -> &'static [&'static str] {
        match self.slug {
            "otp-code-generator-and-validator" => &["counter"],
            _ => &[],
        }
    }

    /// 这个 API 工具的输入区里，哪些字段**不配标签**。
    ///
    /// 参考实现里有一批输入框根本不带 label —— 原版靠占位符说明这个框是干嘛的
    /// （`c-input-text` 的 `placeholder` 就是那句说明）。我们默认每个字段都配
    /// 一个标签，原版没有的地方就多出来一行字。
    pub fn api_label_less_fields(&self) -> &'static [&'static str] {
        match self.slug {
            // 原版的输入区是一个没标签的输入框 + 一个没标签的下拉框。
            "date-time-converter" => &["date", "format"],
            _ => &[],
        }
    }

    /// API 工具结果区要用的标题（语言包里的 `result.*` 键）。
    ///
    /// 参考实现的结果区各有各的名字 —— hmac-generator 写的是
    /// 「HMAC of your text」、encryption 写的是「Your text encrypted:」，
    /// 不是笼统的「Output」。
    ///
    /// 一个工具可能要不止一个标题：rsa 的公钥私钥各一个，otp 的三个令牌各一个。
    /// 顺序跟 [`ResultKind`] 对应 —— `KeyPair` 是「公钥、私钥」，
    /// `Tokens` 是「上一个、当前、下一个」。
    pub fn api_result_labels(&self) -> &'static [&'static str] {
        match self.slug {
            "hmac-generator" => &["result.hmac"],
            // 加密与解密的结果标题不一样 —— 服务端按 mode 选，
            // 这里两个都登记，语言包对账时才算「有人读」。
            "encryption" => &["result.encrypted", "result.decrypted"],
            "date-time-converter" => &["result.converted"],
            "mac-address-lookup" => &["result.vendor"],
            "bcrypt" => &["result.hash"],
            "rsa-key-pair-generator" => &["result.public_key", "result.private_key"],
            "otp-code-generator-and-validator" => {
                &["result.previous", "result.current_otp", "result.next"]
            }
            "pdf-signature-checker" => &["result.signature"],
            _ => &[],
        }
    }

    /// 结果区的**主**标题（几个标题里的第一个）。None 就是用默认的「Output」。
    pub fn api_result_label(&self) -> Option<&'static str> {
        self.api_result_labels().first().copied()
    }

    /// 这一页要不要把**所有**卡片外壳都摘掉。
    ///
    /// 参考实现里有一批工具的正文是直接躺在页面背景上的 —— 标签、输入框、
    /// 结果都排在同一层，中间没有白底卡片。我们默认给每块内容套了 `.card`
    /// （白底 + 边框 + 20px 24px 内边距），对这一批工具就得把壳摘掉，
    /// 否则页面上凭空多出一圈边框。
    ///
    /// 名单是量出来的：用 CDP 打开原版那一页，数正文里一共有几张卡片、
    /// 第一个输入框外面套了几层卡片。数量对得上才算齐。
    pub fn plain_shell(&self) -> bool {
        matches!(
            self.slug,
            "bip39-generator"
                | "chmod-calculator"
                | "date-time-converter"
                | "email-normalizer"
                | "git-memo"
                | "hmac-generator"
                | "ipv4-address-converter"
                | "ipv4-range-expander"
                | "ipv4-subnet-calculator"
                | "ipv6-ula-generator"
                | "json-diff"
                | "math-evaluator"
                | "numeronym-generator"
                | "otp-code-generator-and-validator"
                | "pdf-signature-checker"
                | "phone-parser-and-formatter"
                | "regex-memo"
                | "slugify-string"
                | "temperature-converter"
                | "text-to-nato-alphabet"
                | "uuid-generator"
        )
    }

    /// 只摘掉**输入区**的卡片外壳，结果区仍保留卡片。
    ///
    /// 参考实现里输入框多数不在卡片里（`c-input-text` 直接排在 `n-form-item`
    /// 下面），但输出区通常在一张 `c-card` 里（`TextareaCopyable` 组件自带一张卡）。
    /// 我们给输入区也套了一张，多出来的那圈边框就是差异所在。
    pub fn plain_input(&self) -> bool {
        matches!(
            self.slug,
            "basic-auth-generator"
                | "docker-run-to-docker-compose-converter"
                | "emoji-picker"
                | "eta-calculator"
                | "http-status-codes"
                | "iban-validator-and-parser"
                | "json-minify"
                | "json-viewer"
                | "json-to-csv"
                | "json-to-toml"
                | "json-to-xml"
                | "json-to-yaml-converter"
                | "mac-address-generator"
                | "mac-address-lookup"
                | "markdown-to-html"
                | "meta-tag-generator"
                | "password-strength-analyser"
                | "rsa-key-pair-generator"
                | "safelink-decoder"
                | "sql-prettify"
                | "string-obfuscator"
                | "toml-to-json"
                | "toml-to-yaml"
                | "ulid-generator"
                | "user-agent-parser"
                | "xml-formatter"
                | "xml-to-json"
                | "yaml-viewer"
                | "yaml-to-json-converter"
                | "yaml-to-toml"
        )
    }
}

/// 按路由路径查工具
#[allow(dead_code)] // 注册表完整性单测用
pub fn by_path(path: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.path == path)
}

/// 按 slug 查工具
pub fn by_slug(slug: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.slug == slug)
}

/// 查历史路由应重定向到哪
pub fn redirect_target(path: &str) -> Option<&'static str> {
    TOOLS
        .iter()
        .find(|t| t.redirect_from.contains(&path))
        .map(|t| t.path)
}

/// 某分类下的工具，按注册表顺序
pub fn by_category(category: Category) -> impl Iterator<Item = &'static Tool> {
    TOOLS.iter().filter(move |t| t.category == category)
}
