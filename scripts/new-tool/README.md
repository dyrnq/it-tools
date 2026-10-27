# 新工具并入流程

一批新工具是**并行**做的（每个工具一个 agent），但 `src/registry/tools.rs` 与
`locales/*.yml` 是**所有工具共享**的文件 —— 多个 agent 同时改会互相覆盖，
最后谁的内容都不完整。

所以拆成两步：

1. **每个工具只交这些文件**到 `new-tool/`（这个目录在 `.gitignore` 里，是暂存区）：
   - `new-tool/<slug>.js` → 实际写到 `static/js/tools/<slug>.js`
   - `new-tool/i18n/<slug>.json` → 界面文案的中文
   - `new-tool/<slug>.registry.txt` → 注册表片段
   - `new-tool/<slug>.meta.txt` → 标题与描述（中英）
   - `new-tool/<slug>.fields.txt` → 表单字段 / 下拉项 / 结果区文案（`key: 英文 | 中文`）

   **不要**碰 `src/registry/tools.rs`、`locales/*.yml`、`src/lib.rs`、
   `static/lib/manifest.tsv`（除非确实要加 vendor 库）。

2. **统一并入**（本目录的脚本，顺序有讲究）：

```bash
python3 scripts/new-tool/integrate.py        # 注册表条目 + tools.<slug>.title/description
python3 scripts/new-tool/gen-locales.py      # 重新生成 ui.tool 段
python3 scripts/new-tool/merge-fields.py     # field.* / opt.* / out.* 的文案
```

这些脚本都支持 `--check`（只检查不写），**连着跑两次结果不变** —— 这是幂等性
的验收标准。加了新工具之后跑 `--check` 应该全过。

## 每个脚本干什么

| 脚本 | 改哪 | 说明 |
|---|---|---|
| `integrate.py` | `src/registry/tools.rs`、`locales/{en,zh-CN}.yml` | 把注册表片段插到 `TOOLS` 末尾；把标题/描述插进语言包的 `tools:` 段。注册表片段有两种写法都认（带 `Tool { … },` 外壳的、只有字段的），并按注册表的 house style 重排缩进（`Tool {` 4 空格、字段 8 空格）。已存在的条目会跳过。 |
| `gen-locales.py` | `locales/{en,zh-CN}.yml` 的 `ui.tool` 段 | **英文从 JS 源码里读**（`t()` 的第二个参数），中文从 `new-tool/i18n/<slug>.json` 读。英文不经过人手转录，就不会出现「代码改了、语言包没改」的漂移。键对不上（缺键 / 多键）直接报错。 |
| `merge-fields.py` | `locales/{en,zh-CN}.yml` 的 `field:` / `opt:` / `out:` 段 | 把 worker 交上来的 `new-tool/<slug>.fields.txt` 并进去（`key: 英文 | 中文`，竖线右边可省略）。 |

## 交上来的东西长什么样

`new-tool/<slug>.registry.txt` —— 缩进随意，脚本会重排：

```
    Tool {
        slug: "csv-to-json",
        path: "/csv-to-json",
        name_key: "tools.csv-to-json.title",
        desc_key: "tools.csv-to-json.description",
        category: Category::Development,
        icon: "file-digit",
        keywords: &["csv", "to", "json"],
        redirect_from: &[],
        is_new: true,
        impl_kind: ImplKind::Js,
    },
```

`new-tool/<slug>.meta.txt` —— 冒号分隔，四个字段：

```
title: CSV to JSON
description: Convert CSV to JSON with RFC 4180 quoted fields.
title_zh: CSV 转 JSON
description_zh: 按 RFC 4180 解析 CSV 并转成 JSON 对象。
```

`new-tool/i18n/<slug>.json` —— 键是 `t()` 用的那个键，值是中文：

```json
{
  "input": "CSV 内容",
  "output": "JSON"
}
```

## 跑完之后

```bash
cargo test --offline                      # 注册表完整性、i18n 覆盖、页面渲染
cd test/js && node harness.js             # JS 工具的挂载/卸载/逻辑用例
cd test/js && node check-vendor.js        # vendor 产物
```
