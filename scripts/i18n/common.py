"""多语言包的公共部分：读语言包、拍平/嵌套、解析工具注册表。

语言包的结构在 `locales/<code>.yml`（嵌套 YAML），但合并、查覆盖率这类活儿
都得按**扁平的点号键**来干 —— `ui.tool.case-converter.input` 这样一个键一条，
跟它在 YAML 里嵌了几层没关系。这个文件放这几样公用工具。
"""
import os
import re

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOCALES_DIR = os.path.join(ROOT, 'locales')
# 翻译片段的暂存区（跟 new-tool/i18n 一样，合并进 locales/ 之后就没用了）
SRC_DIR = os.path.join(ROOT, 'new-tool', 'i18n')
REGISTRY = os.path.join(ROOT, 'src', 'registry', 'tools.rs')
I18N_RS = os.path.join(ROOT, 'src', 'i18n.rs')

# 语言包里顶层段的固定顺序
#
# 顺序跟 locales/*.yml 里手写的一样 —— 少写一个段，dump_locale 就会把那个段
# 挪到末尾，文件跟合并结果对不上，merge.py --check 一直红。
SECTIONS = ['tools', 'ui', 'field', 'result', 'opt', 'out']


class Yaml12(yaml.SafeLoader):
    """按 **YAML 1.2** 读 —— 跟 Rust 那边的 serde_yaml 对齐。

    PyYAML 认的是 YAML 1.1：`yes` / `no` / `on` / `off` / `y` / `n` 都当布尔值；
    serde_yaml 认的是 1.2：只有 `true` / `false` 是布尔值。

    差一点的**后果**是键名变了：语言包里写 `yes:`，
    PyYAML 读出来的键是 `True`、serde_yaml 读出来是 `yes` ——
    两边说的不是同一个键。工单按 PyYAML 的看法发，译文就落在
    没人查的键上；页面上找的是 `yes`，找不到，**显示英文**，
    而且不报任何错。所以这里必须用 1.2 的规则读。
    """
    yaml_implicit_resolvers = {
        k: [(t, r) for (t, r) in v if t != 'tag:yaml.org,2002:bool']
        if k in 'yYnNoO'
        else list(v)
        for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }


Yaml12.add_implicit_resolver(
    'tag:yaml.org,2002:bool',
    re.compile(r'^(?:true|True|TRUE|false|False|FALSE)$'),
    list('tTfF'),
)


def scalar_key(key):
    """键 -> 字符串。跟 Rust 的 `i18n.rs::scalar_key` 对齐。

    Rust 那边把非字符串的键用 serde_yaml 重新序列化一遍：
    布尔值出来是 `true` / `false`（小写），空值出来是 `null`。
    Python 默认给的是 `True` / `False` / `None` —— 大小写对不上，
    键就又成了两个。这里跟着 Rust 的写法。
    """
    if isinstance(key, str):
        return key
    if key is True:
        return 'true'
    if key is False:
        return 'false'
    if key is None:
        return 'null'
    return str(key)


def scalar_value(value):
    """值 -> 字符串。跟 Rust 的 `i18n.rs::flatten` 对齐。

    空值那一整条**丢掉**（Rust 那边是 `_ => {}`），
    布尔值写成 `true` / `false`。
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if value is None:
        return None
    return str(value)


def flatten(node, prefix=''):
    """嵌套 dict -> {点号键: 字符串}。"""
    out = {}
    if not isinstance(node, dict):
        return out
    for key, value in node.items():
        full = f'{prefix}{scalar_key(key)}'
        if isinstance(value, dict):
            out.update(flatten(value, full + '.'))
        else:
            text = scalar_value(value)
            if text is not None:
                out[full] = text
    return out


def load_locale(lang):
    """读一个语言包，返回 {点号键: 字符串}。文件不在就返回空 dict。"""
    path = os.path.join(LOCALES_DIR, f'{lang}.yml')
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as fh:
        return flatten(yaml.load(fh, Loader=Yaml12) or {})


def nest(flat):
    """{点号键: 值} -> 嵌套 dict。"""
    root = {}
    for key, value in flat.items():
        parts = key.split('.')
        node = root
        for part in parts[:-1]:
            nxt = node.setdefault(part, {})
            if not isinstance(nxt, dict):
                raise SystemExit(f'键冲突：{key} —— {part} 既是值又是命名空间')
            node = nxt
        last = parts[-1]
        if last in node:
            raise SystemExit(f'键冲突：{key}')
        node[last] = value
    return root


def yaml_scalar(value):
    """单引号标量；单引号本身要写成两个。"""
    return "'" + str(value).replace("'", "''") + "'"


# YAML 1.1（PyYAML 用的那套）把这一堆词当**布尔值**：不引号写出去，
# 读回来键就变成了 True / False，语言包的键名也就跟着变了。
# Rust 那边用的是 YAML 1.2（serde_yaml），只认 true/false —— 两边对不上，
# 所以这类键必须加引号，两边才读成同一个名字。
RESERVED_KEYS = {
    'y', 'Y', 'yes', 'Yes', 'YES', 'n', 'N', 'no', 'No', 'NO',
    'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
    'on', 'On', 'ON', 'off', 'Off', 'OFF',
    'null', 'Null', 'NULL', '~', '',
}

PLAIN_KEY = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]*$')
# 长得像数字/日期的键不加引号也会被读成别的类型
NUMBER_LIKE = re.compile(r'^[-+]?[0-9]')
DATE_LIKE = re.compile(r'^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}')


def yaml_key(key):
    """键要不要加引号。

    加了 PyYAML 与 serde_yaml 读出来是同一个字符串；不加的话，
    `yes` / `no` / `123` / `2024-01-01` 这类键两边读出来不一样 ——
    症状是「英文语言包有这条，中文语言包没有」，页面上退回英文。
    """
    if PLAIN_KEY.match(key) and key not in RESERVED_KEYS:
        if NUMBER_LIKE.match(key) or DATE_LIKE.match(key):
            return yaml_scalar(key)
        return key
    return yaml_scalar(key)


def dump_block(node, indent):
    """嵌套 dict -> YAML 文本行（键按字典序）。"""
    lines = []
    pad = ' ' * indent
    for key in sorted(node):
        value = node[key]
        if isinstance(value, dict):
            if not value:
                continue
            lines.append(f'{pad}{yaml_key(key)}:')
            lines.extend(dump_block(value, indent + 2))
        else:
            lines.append(f'{pad}{yaml_key(key)}: {yaml_scalar(value)}')
    return lines


def dump_locale(flat, header=''):
    """扁平键 -> 完整的语言包文本（顶层段按 SECTIONS 的顺序）。"""
    nested = nest(flat)
    lines = []
    if header:
        lines.extend(f'# {line}' if line else '#' for line in header.split('\n'))
        lines.append('')
    for section in SECTIONS:
        if section not in nested:
            continue
        lines.append(f'{section}:')
        lines.extend(dump_block(nested[section], 2))
        lines.append('')
    # 顶层段不在 SECTIONS 里的（以后加了新段也不会被悄悄丢掉）
    for section in sorted(set(nested) - set(SECTIONS)):
        lines.append(f'{section}:')
        lines.extend(dump_block(nested[section], 2))
        lines.append('')
    return '\n'.join(lines).rstrip('\n') + '\n'


def available_languages():
    """从 `src/i18n.rs` 的 AVAILABLE 常量里读语言表。

    语言表只该有一个地方说了算 —— 那个常量同时决定了导航栏的下拉、
    协商语言的候选和语言包的加载。脚本自己去读它，免得两处各写一份、
    改了一处忘了另一处。
    """
    src = open(I18N_RS, encoding='utf-8').read()
    match = re.search(r'pub const AVAILABLE[^=]*=\s*&\[(.*?)\];', src, re.S)
    if not match:
        raise SystemExit('src/i18n.rs 里找不到 AVAILABLE 常量')
    return re.findall(r'\("([^"]+)"\s*,\s*"([^"]+)"\)', match.group(1))


def parse_registry():
    """解析 `src/registry/tools.rs`，返回工具条目列表。

    注册表是 Rust 代码，但这里只需要四个字段 —— slug、路由名、标题键、
    实现方式。跟注册表同步的是「键名」这一层，格式变了这里会读错，
    所以读出来的条数会跟注册表里的 `TOOLS.len()` 对一遍。
    """
    src = open(REGISTRY, encoding='utf-8').read()
    tools = []
    for block in re.split(r'\n    Tool \{', src)[1:]:
        block = block.split('\n    },', 1)[0]
        entry = {}
        for field in ('slug', 'path', 'name_key', 'desc_key'):
            m = re.search(rf'{field}:\s*"([^"]+)"', block)
            if not m:
                raise SystemExit(f'注册表条目里没有 {field}：{block[:80]}')
            entry[field] = m.group(1)
        entry['route'] = entry['name_key'][len('tools.'):-len('.title')]
        if 'ImplKind::Api' in block:
            entry['kind'] = 'api'
        elif 'ImplKind::Static' in block:
            entry['kind'] = 'static'
        else:
            entry['kind'] = 'js'
        tools.append(entry)
    return tools


# `out.<命名空间>` 归哪个工具。
#
# 命名空间跟的是**服务端模块名**（`src/tools/<模块>.rs`），不是路由名 ——
# 所以 `argon2-hash-generator` 这个工具的结果区键叫 `out.argon2.*`。
# 有两个命名空间是几个工具共用的（`ipv6` 给两个 IPv6 工具，`jwt` 给解析/生成两个
# JWT 工具），只列一个「归属者」，免得两批人各译一遍、两份对不上。
# `out.common` 是所有 API 工具共用的，不归任何工具 —— 算核心文案。
OUT_OWNERS = {
    'argon2-hash-generator': ['argon2'],
    'bcrypt': ['bcrypt'],
    'csr-generator': ['csr-generator'],
    'date-time-converter': ['date-converter'],
    'dns-query': ['dns-query'],
    'encryption': ['encryption'],
    'hash-text': ['hash-text'],
    'hmac-generator': ['hmac-generator'],
    'htpasswd': ['htpasswd'],
    'iana-timezone-index': ['iana-timezone-index'],
    'ipv6-address-converter': ['ipv6', 'ipv6-address-converter'],
    'ipv6-subnet-calculator': ['ipv6-subnet-calculator'],
    'jasypt': ['jasypt'],
    'jwt-parser': ['jwt'],
    'mac-address-lookup': ['mac-address-lookup'],
    'otp-code-generator-and-validator': ['otp-generator'],
    'pdf-signature-checker': ['pdf-signature-checker'],
    'rsa-key-pair-generator': ['rsa-key-pair-generator'],
    'ssh-key-pair-generator': ['ssh-key-pair-generator'],
    'ssl-certificate-decoder': ['ssl-certificate-decoder'],
    'week-number-converter': ['week-number-converter'],
    'x509-certificate-generator': ['x509-certificate-generator'],
}


def tool_keys(tool, en):
    """一个工具在语言包里占哪些键。

    - `ui.tool.<slug>.*` —— JS 工具自己的界面文案（按 **slug**，不是路由名）
    - `tools.<路由名>.title/description` —— 卡片与工具页的标题描述
    - `out.<命名空间>.*` —— 服务端结果区的文案
    """
    keys = []
    prefix = f"ui.tool.{tool['slug']}."
    keys.extend(k for k in en if k.startswith(prefix))
    keys.append(tool['name_key'])
    keys.append(tool['desc_key'])
    for namespace in OUT_OWNERS.get(tool['slug'], []):
        prefix = f'out.{namespace}.'
        keys.extend(k for k in en if k.startswith(prefix))
    return sorted(set(keys))
