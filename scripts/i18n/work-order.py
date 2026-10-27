#!/usr/bin/env python3
"""给翻译的人（或 agent）派活：切出「要译哪些键、英文原文是什么」。

一批工具是并行译的，但 `locales/*.yml` 是共享文件 —— 多人同时改会互相覆盖。
所以流程跟 `scripts/new-tool/` 一样：每个人/每个 agent 只写自己那几份
**翻译片段**（`new-tool/i18n/<code>/<slug>.json`），最后由
`scripts/i18n/merge.py` 统一并进语言包。

这个脚本把工具按「键数」均衡地切成若干批，每批生成一份工单
（英文原文 + 键清单），工单放在 `new-tool/i18n/work/`。

用法：
    python3 scripts/i18n/work-order.py --batches 8
    python3 scripts/i18n/work-order.py --list                   # 只看每个工具有多少键

重新生成时**沿用**已有的分批（谁做哪几个工具是跟人对好的），
只刷新每个工具的键 —— 分批是「活」的分配，重排等于把派出去的活换了一遍。
要重新分批就把 `new-tool/i18n/work/batch-*.json` 删了再跑。
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

WORK_DIR = os.path.join(C.SRC_DIR, 'work')


def core_keys(en, tools):
    """不属于任何一个工具的键：站点框架、表单字段、下拉项、通用报错。"""
    owned = set()
    for tool in tools:
        owned.update(C.tool_keys(tool, en))
    return sorted(set(en) - owned)


def split_batches(tools, en, count):
    """把工具切成 count 批，每批的键数尽量均衡。

    贪心：每次把下一个「键最多的工具」放进当前最空的那批。
    这样大工具（meta-tag-generator 那种一百多键的）不会全堆在一批里。
    """
    sized = sorted(
        ((len(C.tool_keys(t, en)), t['slug']) for t in tools),
        reverse=True,
    )
    batches = [[] for _ in range(count)]
    loads = [0] * count
    for size, slug in sized:
        index = loads.index(min(loads))
        batches[index].append(slug)
        loads[index] += size
    return [sorted(b) for b in batches]


def existing_assignment():
    """工单里已经分好的「哪批做哪些工具」。

    重新生成工单时**沿用**已有的分法，只刷新每个工具的键 ——
    分批是**活**的分配：谁做哪几个工具，是跟人（或者 agent）对好的。
    键数变了一点就重排，等于把已经派出去的活又换了一遍，
    正在做的人手里那份工单就跟磁盘上的对不上了。
    """
    out = {}
    if not os.path.isdir(WORK_DIR):
        return out
    for name in sorted(os.listdir(WORK_DIR)):
        if not (name.startswith('batch-') and name.endswith('.json')):
            continue
        with open(os.path.join(WORK_DIR, name), encoding='utf-8') as fh:
            data = json.load(fh)
        out[name.replace('.json', '')] = [t['slug'] for t in data['tools']]
    return out


def keep_assignment(tools, en, count):
    """沿用已有的分批，只把新工具补进去。

    返回每批的工具列表；没有旧工单时才真分一次。
    """
    old = existing_assignment()
    if not old:
        return split_batches(tools, en, count)

    names = sorted(old)
    batches = {name: list(old[name]) for name in names}
    assigned = {slug for name in names for slug in batches[name]}

    # 注册表里还在、但旧工单里没有的工具 → 放进当前最空的那批
    by_slug = {t['slug']: t for t in tools}
    fresh = [t for t in tools if t['slug'] not in assigned]
    if fresh:
        loads = {name: sum(len(C.tool_keys(by_slug[s], en)) for s in batches[name]) for name in names}
        for tool in sorted(fresh, key=lambda t: -len(C.tool_keys(t, en))):
            target = min(names, key=lambda n: loads[n])
            batches[target].append(tool['slug'])
            loads[target] += len(C.tool_keys(tool, en))

    # 注册表里已经没有的工具 → 从工单里去掉
    for name in names:
        batches[name] = [s for s in batches[name] if s in by_slug]

    return [sorted(batches[name]) for name in names]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--batches', type=int, default=8, help='切成几批')
    parser.add_argument('--list', action='store_true', help='只列每个工具的键数')
    args = parser.parse_args()

    en = C.load_locale('en')
    tools = C.parse_registry()
    by_slug = {t['slug']: t for t in tools}

    if args.list:
        sized = sorted(
            ((len(C.tool_keys(t, en)), t['slug'], t['kind']) for t in tools),
            reverse=True,
        )
        for size, slug, kind in sized:
            print(f'{size:5}  {kind:6}  {slug}')
        print(f'合计 {sum(s for s, _, _ in sized)} 键（工具相关），'
              f'另有 {len(core_keys(en, tools))} 条核心文案')
        return 0

    batches = keep_assignment(tools, en, args.batches)
    targets = [os.path.join(WORK_DIR, f'batch-{i + 1:02d}.json') for i in range(len(batches))]

    for path, slugs in zip(targets, batches):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        payload = {
            'batch': os.path.basename(path).replace('.json', ''),
            'tools': [
                {
                    'slug': slug,
                    'kind': by_slug[slug]['kind'],
                    'keys': {k: en[k] for k in C.tool_keys(by_slug[slug], en)},
                }
                for slug in slugs
            ],
        }
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        total = sum(len(t['keys']) for t in payload['tools'])
        print(f'{path}: {len(slugs)} 个工具 / {total} 键')

    core = {k: en[k] for k in core_keys(en, tools)}
    core_path = os.path.join(WORK_DIR, 'core.json')
    with open(core_path, 'w', encoding='utf-8') as fh:
        json.dump({'keys': core}, fh, ensure_ascii=False, indent=2)
    print(f'{core_path}: {len(core)} 键')
    return 0


if __name__ == '__main__':
    sys.exit(main())
