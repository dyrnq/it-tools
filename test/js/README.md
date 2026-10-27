# JS 工具模块的测试

`static/js/tools/` 下每个模块都要能**加载 → 注册 → 挂载 → 卸载**且不抛异常，
其中可测的纯逻辑还要跑它自己声明的用例。

```bash
cd test/js
npm install          # 只装 jsdom，dev 依赖（CI 用 npm ci，装的是 lockfile 里钉死的版本）
npm test                      # harness + api-form + sidebar + theme + big-integers + fuzz-diff + check-vendor
node harness.js             # 测全部模块
node harness.js text-diff   # 只测指定模块
node api-form.js            # API 工具表单的渲染与错误信封
node sidebar.js             # 侧栏分类折叠
node theme.js               # 深/浅色主题切换（图标、存档、tooltip）
node big-integers.js        # 超范围整数的无损往返（12 个转换器）
node fuzz-diff.js           # text-diff 的编辑脚本随机校验
node fuzz-diff.js 5000      # 加大样本量
node check-vendor.js        # 第三方库产物能加载且功能自检通过
```

**这里用到 Node 与 jsdom，只是为了跑测试。** 发行产物
（`cargo build --release`）不依赖 Node，`static/js/` 里也没有任何构建步骤 ——
浏览器直接吃这些手写模块，依赖表对页面来说只有 layui 一个。

## harness.js 怎么知道要预加载哪些库

读的是 `static/lib/manifest.tsv`，和浏览器渲染工具页用的是同一张表（`src/registry/libs.rs`）。
jsdom 不会自己去取 `<script src>`，所以测试里手动把库喂进 window。共用一张表是刻意的：
各写各的迟早会出现「页面加了库、测试忘了加」，而症状是模块里 `window.YAML` 是 undefined，
报错跟真实故障长得一模一样。

## 为什么要单独一个 check-vendor.js

`npm pack` 下来的包里混着 ESM 桩文件、CommonJS、以及「deprecated，路径已挪走」的
抛错占位文件。光看文件名（`*.min.js` 之类的）挑很容易挑中坏的那个 ——
mathjs 的 `dist/math.min.js` 就是一个只会 throw 的弃用占位，libphonenumber-js 的
`max/index.js` 是纯 ESM 重导出。

`check-vendor.js` 把每个产物丢进 jsdom 真跑一遍，看 `window` 上多了什么，再对每个库做
一次**功能**断言。「没抛异常」和「能用」之间差得很远：一个只 export 了 `{}` 的空壳
也能安静地加载。断言里的期望值都是在真跑过之后才写下来的 ——
凭印象写期望值这件事本身已经在这个文件上错过好几轮了。

## 为什么要单独一个 fuzz-diff.js

`harness.js` 跑的是各模块自己声明的 `__cases`，断言和实现是同一个人写的 ——
实现理解错了题意，断言往往错得一模一样，两边一起绿，什么也证明不了。

`text-diff` 的 Hirschberg LCS 就是这种情况：光「不抛异常」和几个手写例子，
根本挡不住**编辑脚本非最优**（切分点挑错，输出仍然合法、仍然能还原 b，
但「明明只改了两行」会显示成改了几百行）。这类 bug 只有拿一份
**独立写的参照实现**去对拍才抓得住。

所以 `fuzz-diff.js` 另写了一份朴素 O(N×M) DP，对随机样本同时验两件事：
脚本是合法单调对齐（能逐行还原 b），且 `same` 条数正好等于参照算出的 LCS。
样本刻意用很小的字母表（二元、三元）—— 重复行越多，分治越容易挑错切分点。

随机数用固定种子的 LCG，不用 `Math.random`：失败能靠种子复现。

## 为什么要单独一个 big-integers.js

`9223372036854775807` 这样的整数，从 JSON / YAML / TOML 的解析器里过一遍，
会被 JS 的 53 位尾数舍成 `...776000` —— **没有任何一步会报错**。
转换器就这么把用户的数据改了，而工具看上去一切正常：没有红字，没有异常栈，
只有输出里悄悄少掉的几个数字。`@iarna/toml` 更糟，它对超范围整数返回 BigInt，
而它自己算出来的那个 BigInt 就是错的（`17478252242305210114` 会被它读成
`-968491831404341502`，连符号都反了），于是 `toml-to-json` 直接抛
`TypeError: Do not know how to serialize a BigInt` —— 一份完全合法的 TOML
把整个工具打到罢工。

修法是输入侧保护 + 输出侧还原（`ItTools.util` 的 `guardBigIntegers` /
`restoreBigIntegers` / `restoreBigIntegerValue`，用私用区字符 U+E000 当哨兵）。
但这条线横跨好几个工具模块，守卫本身又住在 `app.js` 里 —— `harness.js` 只跑
工具模块自带的 `__cases`，**哪个工具漏了接线，从模块内部是看不见的**：
漏接的那个工具照样加载成功、挂载成功、自己的用例全绿，只是默默改着用户的数据。

所以这个文件从外面拿真实输入挨个打一遍，除了「必须原样出来」，还钉了三件容易被
一次莽撞的修复弄坏的事：

- **不该动的没动** —— 浮点数、指数、字符串里的长数字、`#` 后面的注释、
  YAML 时间戳里的 `1979-05-27T07:32:00Z`、TOML 的 `"""` 多行块。
  保护写得太宽，最先遭殃的就是这些：把 `1979-05-27T07:32:00Z` 当成两个整数，
  时间戳当场变字符串。
- **普通数据一点不受影响** —— 保护只在真的超范围时才动手，`{"a":1}` 必须原样返回。
- **`json-diff` 不会被哨兵骗** —— 两个末位差 1 的大整数，在没有保护时会被 `Number`
  舍成同一个值，于是「有差异」被误判成「无差异」。这条正是本文件存在的理由。

反过来说，光「跑绿」不算数：把 `guardBigIntegers` 临时换成恒等函数，这 58 项里
有 20 项会红（12 个转换器 + 2 条 diff）。测试要是拆了保护还能全绿，那就是没在测东西。

## harness 里的「只挂一次」「打字不炸」「点按钮不炸」

这三条是后来补的，补的起因是一个**每个工具页都在犯**、但肉眼看不出来的问题。

`tool.html` 末尾有一行内联脚本 `window.ItTools.mountAll();`，而 `app.js` 的 `boot()` 里
也有一行。`app.js` 是在解析途中加载的，那时 `document.readyState` 还是 `loading`，
所以 `boot()` 一定排在 `DOMContentLoaded` 上 —— 也就是说**每个工具页都会挂载两次**：
内联脚本挂一次，DOMContentLoaded 时 `boot()` 再挂一次，第一次刚建好的实例当场被
`destroy()` 掉。后果是 `mount` 里的副作用白跑一遍（拉库文件、生成数据、挂全局监听
都得重来），异步拉的数据还会写进已经被清空的 DOM。

`harness.js` 原来只测「手动调一次 `mountAll()`」，看不出这个 —— 它跟浏览器的脚本
顺序根本不是一回事。现在多了一条 `页面加载顺序 · 只挂一次`：照着真实顺序走一遍
（内联脚本 → 等 `DOMContentLoaded` → `boot()`），数 mount 发生了几次。
app.js 那边加的守卫是「同一个 slug 已经在页面上了就别再挂」。

「打字不炸」「点按钮不炸」两条针对的是另一类问题：**jsdom 会把事件监听器里抛出的
异常吞掉**（不往外抛，只报到 virtual console），所以在 Node 里点按钮、敲字，
`try/catch` 根本抓不到东西 —— 之前的「把工具挨个点一遍没炸」就是这么测出来的，
其实什么都没测到。现在 `bootWindow` 挂了 virtual console，把异常收在 `w.__errors` 里，
两条检查盯的就是它；工具自己抛出来的异常还会被最后那次「迟到的异常」再扫一遍
（防抖、fetch 回调里的异常是同步检查抓不到的）。

这两条同时定下了一条规矩：**工具不能把异常抛给用户**。输入不合法时应该显示一行
提示，而不是让整块工具白掉 —— 用户看到的是「敲一个字工具没了」，而不是「输入有误」。

顺带一提：「打字不炸」会改工具的状态（写进 `localStorage` 的东西也会跟着变，
`benchmark-builder` 就会），所以 `__cases` 必须跑在它前面 —— 用例断言的是
「刚打开页面」时的行为。

## 为什么要单独一个 sidebar.js

侧栏分类折叠曾经**看起来能点、其实点了没反应**，而且三处独立的写法互相打架，
每一个单看都没错：

- 折叠状态是从 `aria-expanded` 推出来的，某一处把方向搞反了，就把当前状态原样
  写回去 —— `localStorage` 照写，界面纹丝不动；
- `renderFavorites` 里侧栏和首页各有一个 `var section`，`var` 是函数级的，
  后一个覆盖前一个，于是侧栏的点击回调把 `dataset.collapsed` 写到了首页那块
  节点上（工具页上则直接抛 `null` 异常）；
- `boot()` 每跑一遍就多挂一遍监听，两遍的话一次点击触发两个 handler，
  各自翻一次状态，等于没翻。

这类 bug 的共同点是**症状与原因隔了三层**，手点很难看出是哪一层坏了。
所以这个文件不只测「折叠能用」，还把状态写进 `localStorage` 再重开一遍页面，
确认刷新后还在 —— 三个坑分别对应三条断言。

顺带一提：jsdom 不会去取外链样式表，`getComputedStyle` 看不到
`.nav-group[data-collapsed='true'] .nav-list { display: none }`。
想断言「真的藏起来了」就得把 `static/css/app.css` 手动塞进 `<style>`。
