# it-tools (Rust)

A Rust rewrite of [IT Tools](https://it-tools.tech/): **actix-web + tera + rust-embed**.
The build artifact is a **single executable** with every static asset embedded in it —
drop it on any machine and run it.

Repository: <https://github.com/dyrnq/it-tools>

- The original's full tool set, same UI as the original (sidebar on the left, content on the right)
- Languages: English / 简体中文 / Deutsch / Français / 日本語 / Español / 한국어
  (a language pack may be **partially** translated — every missing key falls back to English
  **key by key**, so no key names ever leak onto the page)
- The frontend is plain server-side templates + layui — **no Node.js build step**

The original project [CorentinTh/it-tools](https://github.com/CorentinTh/it-tools) is GPLv3.
This port keeps that license; see [`LICENSE`](LICENSE) for the copyright and attribution.

## Quick start

```bash
./run.sh                      # dev mode, port 8080
./run.sh --port 9000 --host 0.0.0.0
```

`run.sh` runs a plain `cargo run` (debug profile). rust-embed re-reads `static/` and
`templates/` from disk on every request, so an edit shows up on refresh — no recompile.
On the first run, if layui is missing it runs `scripts/bump-layui.sh` to download it.

For a release deployment:

```bash
cargo build --release
./target/release/it-tools --port 8080
```

A release build has every frontend asset embedded in the binary — **the whole directory can
be reduced to that one file**.

### Configuration

The CLI flag and the environment variable always have the same name; the flag wins:

| Flag            | Environment variable | Default      | Description          |
| --------------- | -------------------- | ------------ | -------------------- |
| `--host`        | `IT_TOOLS_HOST`      | `127.0.0.1`  | Listen address       |
| `--port` / `-p` | `IT_TOOLS_PORT`      | `8080`       | Listen port          |
| `--lang`        | `IT_TOOLS_LANG`      | `en`         | Default language     |

## Routes

| Route                      | Description                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /`                   | Home page: favourites (client-rendered) + cards for every tool                              |
| `GET /{tool.path}`        | Tool page, dispatched by slug                                                               |
| `POST /api/tools/{slug}`  | Endpoint for tools implemented in Rust                                                      |
| `POST /api/jwt/{action}`  | JWT sign / verify / keygen / key-format conversion (`sign`·`verify`·`keygen`·`convert`)       |
| `GET /api/jwt/algorithms` | The list of supported signing algorithms (the data source for the frontend dropdown)          |
| `GET /assets/*`           | Embedded static assets (with ETag / 304 / Cache-Control)                                    |
| `GET /i18n.js`            | Client-side language pack; sets `window.__IT_TOOLS_I18N__`                                    |
| `GET /registry.json`      | Search index (name / description / category / keywords)                                      |
| `GET /healthz`            | Health check; returns `{"ok":true}`                                                        |
| `GET /about`              | About page                                                                                  |
| everything else            | 404 page (the status code really is 404)                                                     |

Some tools keep their old route aliases (e.g. `/hash` → `/hash-text`); the full list lives
in the registry's `redirect_from`. Hitting an old path directly gives a **303** (it also
drops the language into a cookie); `GET /redirect/{old-path}` gives a **301**, for cases that
want a permanent redirect.

> **This service has no authentication at all**: anyone who can reach the port can use it,
> including the tools that take secrets in the request body — RSA key generation, bcrypt,
> argon2, JWT signing. It is meant for an intranet;
> **do not expose it to the public internet** (if you must, put an HTTP Basic / Bearer
> middleware in front of it). Key material only travels in request and response bodies; it
> is never written to the logs.

### Deployment prerequisites

- **Outbound DNS (UDP/TCP 53)**: the `dns-query` tool sends real DNS queries through
  `hickory-resolver`, reading the **machine's / system's `resolv.conf`** — not a hardcoded
  public resolver. On a network where outbound 53 is blocked, that one tool reports a
  failed query instead of returning a fake answer; the other tools are unaffected.
  Fill in an IP in the form to pin a server (the system configuration is used when the
  field is left empty).

## Docker

The image is published on Docker Hub as
[`dyrnq/it-tools`](https://hub.docker.com/r/dyrnq/it-tools) — `linux/amd64` and `linux/arm64`,
Alpine base, the same static binary as the release assets.

```bash
docker pull dyrnq/it-tools
docker run -d --name it-tools -p 8080:8080 dyrnq/it-tools
```

There are two tags:

- `dyrnq/it-tools:latest` — the latest **release**. This is what the plain `docker pull` above
  gets.
- `dyrnq/it-tools:main` — the latest build of the `main` branch, pushed by the CI pipeline.
  A rolling tag: every push to `main` replaces it. Use it when you want the newest code
  rather than the newest release.

Inside the container the service listens on `0.0.0.0:8080`, so it lands on
<http://localhost:8080>. `IT_TOOLS_HOST` / `IT_TOOLS_PORT` (or the CLI flags, which win over
the environment) change that:

```bash
docker run -d -p 9000:9000 -e IT_TOOLS_PORT=9000 dyrnq/it-tools
```

> The service has **no authentication** — see the warning above. Keep it on an intranet.

The image carries **no `HEALTHCHECK`**; the `/healthz` endpoint is there if you want to add
one in your own wrapper.

### Building the image yourself

`buildx.sh` is the same script the release pipeline uses. It ships a **prebuilt binary** — the
image compiles nothing (compiling for `arm64` would mean emulating the compiler under QEMU,
which takes forever). So put the binaries in place first:

```bash
mkdir -p dist/amd64 dist/arm64
cp target/x86_64-unknown-linux-musl/release/it-tools dist/amd64/it-tools
cp target/aarch64-unknown-linux-musl/release/it-tools dist/arm64/it-tools

./buildx.sh --push false                      # build only
./buildx.sh --push true --version v0.1.0      # build and push to Docker Hub
```

| Option                     | Default                   | Description                                          |
| -------------------------- | ------------------------- | ---------------------------------------------------- |
| `--base` / `--base-image`  | `alpine:3.22`             | Base image                                           |
| `--version` / `--ver`      | the git tag / `sha-…`     | Version tag                                          |
| `--push`                   | `false`                   | `true` = push to Docker Hub                          |
| `--load`                   | `false`                   | `true` = load into the local Docker (one platform)   |
| `--no-latest`              | off                       | Don't also tag `:latest` (the CI `main` image uses this) |
| `--platforms`              | `linux/amd64,linux/arm64` | Target platforms                                     |
| `--repo`                   | `dyrnq`                   | Docker Hub namespace                                 |
| `--image-name` / `--image` | `it-tools`                | Image name                                           |

`docker/Dockerfile` is a **template**: `buildx.sh` replaces `__BASE_IMAGE__` with the real base
image and writes `docker/Dockerfile.<base>` before building. The layout in the build context is
`dist/<arch>/it-tools` — the Dockerfile picks the right one per platform through `TARGETARCH`.

## Directory layout

```bash
├── build.rs               # rust-embed's rerun-if-changed
├── run.sh                 # dev launcher (debug build, assets read from disk)
├── buildx.sh              # builds the Docker image (see the Docker section)
├── .dockerignore          # the image only needs dist/ — the rest is dead weight
├── docker/Dockerfile      # image template (the base image is substituted when building)
├── dist/                  # the prebuilt binaries the image is built from (not in git)
├── data/                  # static data for tools (the OUI table for mac-address-lookup)
│                          #   —— its own root, deliberately NOT served under /assets
├── locales/               # i18n language packs (en / zh-CN / de / fr / ja / es / ko)
├── templates/             # Tera templates
├── static/                # frontend assets
│   ├── css/app.css        # theme variables + layout
│   ├── js/app.js          # theme / sidebar / search / favourites / generic API form
│   ├── js/tools/<slug>.js # one module per JS tool
│   ├── content/*.md       # the static "memo" pages (git-memo, regex-memo, …)
│   └── lib/               # vendored third-party libraries (layui and friends)
│                          #   + manifest.tsv (slug → artifact path)
├── scripts/bump-layui.sh  # downloads layui into static/lib/layui
├── scripts/build-oui.sh   # regenerates data/oui.txt
├── scripts/vendor-js-libs.sh  # downloads the vendored JS libraries
├── scripts/i18n/          # translation work orders and merging (see below)
├── scripts/new-tool/      # scripts that merge in tools built in parallel (see below)
├── scripts/test/          # end-to-end tests (boots the real binary and talks HTTP to it)
├── test/js/               # tests for the JS tools (jsdom)
├── tests/                 # Rust integration tests (drive the whole App)
├── .github/workflows/     # CI and release pipelines
└── src/
    ├── lib.rs             # library entry point: module declarations + registry integrity tests
    ├── main.rs            # binary entry point: CLI parsing + server startup
    ├── settings.rs        # runtime configuration
    ├── embed.rs           # four rust-embed handles (static / templates / locales / data)
    ├── app.rs             # the actix App factory and its routes
    ├── registry/          # ★ the tool registry — the single source of truth
    ├── i18n.rs            # language pack loading and fallback
    ├── templates.rs       # Tera assembly (the parent template must be registered first)
    ├── markdown.rs        # the Markdown renderer for the memo pages
    ├── handlers/          # pages / API / static assets
    └── tools/             # ★ Rust-side tools, one .rs per tool
```

## Adding a tool

**The registry is the single source of truth**: the sidebar, the home page cards, the search
index, the routing and the form rendering are all driven by it.

### 1. JS tools (if it can be done in JS, do it in JS)

Add one entry to `src/registry/tools.rs`:

```rust
Tool {
    slug: "my-tool",
    path: "/my-tool",
    name_key: "tools.my-tool.title",        // the i18n key follows the **route name**
    desc_key: "tools.my-tool.description",
    category: Category::Text,
    icon: "text",
    keywords: &["keyword"],                   // used for search
    redirect_from: &[],
    is_new: false,
    impl_kind: ImplKind::Js,
},
```

Then write `static/js/tools/my-tool.js`:

```js
window.ItTools.register('my-tool', function (root) {
  // root is the tool page's content container
  return { destroy() {} };
});
```

`tool.html` picks it up automatically: it adds `data-tool-script` and the matching
`<script src=...>`. The page skeleton, icon, title and keyword tags are all generated for
you.

### 2. Rust API tools (only when JS genuinely cannot do it)

Change the registry entry to:

```rust
impl_kind: ImplKind::Api(ApiSpec {
    endpoint: "my-tool",
    fields: &[
        ApiField { name: "text", label_key: "field.text",
                   kind: FieldKind::Multiline, default: None, options: &[] },
    ],
}),
```

Then register the handler in `src/tools/mod.rs` and write `src/tools/my_tool.rs`.
The form is rendered by `tool_api_form.html` from `fields`, and submission is handled by
`app.js` — **a new API tool needs no frontend code at all**.

> The `api_tools_all_have_a_handler` and `js_tools_have_a_script_file` unit tests in
> `src/lib.rs` check that the registry and the actual implementations agree. Add a tool and
> forget the implementation, and they go red.

#### The result area of an API tool has to be i18n'd too

The result area of a server-side tool (the row titles of the result table, the sentence-like
values inside it, the main `output`) **must not hardcode Chinese** — otherwise Chinese leaks
into the English UI. The language is decided **on the server**, not translated in the
frontend:

```rust
// The requested language: ?lang= > Cookie > Accept-Language > en
// handlers/api.rs puts it into the payload under the __lang key
let lang = util::lang(&payload);

// One row of the result table — the row title is a **key from the language pack**;
// only the key appears in the code
util::row(&mut table, &payload, "out.my-tool.network", json!(network));

// A sentence-like value
let note = crate::i18n::t(lang, "out.my-tool.note");
```

Keys have the form `out.<route-name>.<name>`, and the text lives in the **top-level `out:`
section** of the language pack — deliberately not under `ui:`, because `ui:` is shipped to
the browser while these strings only ever live on the server.

The `dead_keys` scanner in `src/i18n.rs` understands `out.*`: it reads the **string
literals** in `src/tools/*.rs` (with its own lexer, which skips comments and tells
character literals apart from lifetimes), so "every `out.*` key in the language pack has to be
referenced by some code" is checked automatically.

When you change wording, **change the code and the language pack together** — changing only
one side is caught by the unit tests.

#### Error messages have to be i18n'd too

The frontend displays `error.message` **verbatim**, so a hardcoded Chinese error message
means Chinese in the English UI. The `ToolError::Invalid(String)` variant has been deleted —
the compiler enforces that — and there is now exactly one way to write it:

```rust
// src/tools/mod.rs
pub enum ToolError {
    InvalidKeyed { key: &'static str, args: Vec<(String, String)> },
    Internal(String),
}
impl ToolError {
    pub fn invalid(key: &'static str, args: &[(&str, &str)]) -> Self;
    pub fn localize(&self, lang: &str) -> String;
}

// inside a tool
return Err(ToolError::invalid(
    "out.my-tool.err.bad_cost",
    &[("cost", &cost.to_string())],
));
```

- The key has the shape `out.<namespace>.err.<name>`; the namespace is the same segment the
  tool's result-area keys use.
- Placeholders correspond **by name** (`{cost}`) — the two languages have different word
  order, so positional arguments do not work.
- `ToolError::Internal` is for developers (a library blew up, a panic message); it only goes
  to the log. But if user input can actually trigger it, it should be `ToolError::invalid`.
- Never build **keys, private keys or passphrases into error messages**.

`t_args(lang, key, args)` in `src/i18n.rs` substitutes the `{name}` placeholders. A
placeholder it cannot fill is left in place — when the template and the arguments disagree,
showing a `{count}` is easier to diagnose than a whole missing sentence.

Every `ToolError::invalid(...)` call site in `src/tools/` gets its own key in the `out:`
section of the language packs, one namespace per tool — the JWT actions are no exception
(`sign`·`verify`·`keygen`·`convert`).

> **Two easy traps**:
> ① `err.to_string()` returns the **key**, not the message (the `#[error("{key}")]` on
> `InvalidKeyed` is deliberate — the log should show which key went wrong).
> Use `err.localize(lang)` for user-facing text, and do not assert on message text with
> `to_string()` in unit tests.
> ② "this field was not provided" and "this field was provided but is empty" are **two
> different things** — `util::req_str` counts both as "not provided". For tools like
> `otp-generator` whose secret has to tell them apart, use `opt_str` first to check that
> the field is present, and only then whether its content is empty.

## Tests

The tests are split into layers, and each one catches a class of failure the others cannot:

| Layer            | Command                                 | What it covers                                                                                                                             |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests       | `cargo test`                            | Registry integrity, i18n key coverage, page rendering, tool logic (577)                                                                     |
| Integration tests| `cargo test --test pages --test api`    | Drives the **whole App**: the route table, the 404 fallback, static assets, redirects, language negotiation, API envelopes (30)                |
| End-to-end       | `scripts/test/integration-test.sh`      | Boots the **real release binary** and talks HTTP to it: whether the assets really are embedded, behaviour over real TCP, whether SIGTERM is handled (25) |
| JS tests         | `cd test/js && npm test`                | Mount/unmount/logic cases for every module under `static/js/tools/`                                                                        |

```bash
cargo test                            # unit + integration
cd test/js && npm ci && npm test      # the JS tool modules
cd test/js && node fuzz-diff.js       # randomised differential test of the text-diff edit script
cd test/js && node check-vendor.js    # every vendored artifact loads and passes its self-check
bash scripts/test/integration-test.sh # end-to-end (needs cargo build --release first)
```

Every module under `static/js/tools/` has to clear three hurdles: it registers, it mounts
without throwing, it unmounts without throwing; testable pure logic also runs the `__cases`
it declares itself. **Node and jsdom are used only to run the tests** — the shipped artifact
does not depend on Node, and there is no build step in `static/js/`.

### Why the integration tests come in two layers

The Rust layer under `tests/` drives the App **in-process**: routing, the 404 fallback, the
static asset mount points and language negotiation are all in range, but it sidesteps the
fact of "actually starting a process".

`scripts/test/integration-test.sh` covers exactly that: it starts the release binary **in a
temporary directory** (no `static/`, no `templates/` in the working directory) and the
assets are still served — which is what proves they are really embedded in the binary rather
than read off disk by luck.

### CI

`.github/workflows/ci.yml` has one job per layer above:

- `unit-tests` — runs `cargo build --release` + `cargo test --release` on each of ubuntu,
  macOS and Windows;
- `js-tests` — `npm ci` + `npm test` on ubuntu (the lockfile is committed, so the versions
  are pinned);
- `integration-tests` — runs the end-to-end script on ubuntu;
- `build-musl` — cross-compiles the static musl binary for `x86_64` and `aarch64`;
- `docker` — packages those two binaries into the multi-architecture image and pushes it.

The `docker` job waits for the tests to be green, **runs the amd64 image locally first**
(a pushed tag is public the moment it is pushed) and then builds without pushing, logs into
Docker Hub and builds with pushing. Its tag is fixed: `dyrnq/it-tools:main`, a rolling tag
that always points at the newest build of the `main` branch. Pull requests are skipped —
PR code should not take over that tag. The `:latest` tag is left to the release pipeline, so
a plain `docker pull dyrnq/it-tools` keeps giving you the newest *release*.

`.github/workflows/release.yml` produces binaries for every platform in its matrix plus a
GitHub Release when
a `v*` tag is pushed, and its `verify` job **re-runs the Rust tests and the end-to-end
suite before shipping** (a tag you cannot take back is a bad place to discover the binary
is broken). The JS layer is not re-run there — it does not touch the binary, and CI
already ran it on the same commit. It differs from the acme-tiny-rs pipeline in exactly
two places: there is no crates.io publish step (this is an application, not a library),
and the aarch64-glibc and armv7 cross builds are marked experimental (the C dependencies
`ring` / `zstd-sys` cannot be verified offline on this machine, and a target that fails
to build should not hold up the others).

That workflow publishes the Docker image as well. Its `docker` job takes the two static
musl binaries out of the `build` job, **runs the amd64 image locally first** (a broken
`latest` is public the moment it is pushed), and then builds without pushing, logs into
Docker Hub and builds with pushing — `docker.io/dyrnq/it-tools`, `linux/amd64` +
`linux/arm64`. The build itself is the `buildx.sh` described above.

The registry integrity test lists **all** the tools that are not implemented yet, not just
the first one — which is useful while the work is done in stages (all of them are implemented
now, so the output below is kept as a memento):

```
$ cargo test js_tools_have_a_script_file
还有 3 个工具没实现:
  emoji-picker
  regex-tester
  text-diff
```

## Conventions for writing a JS tool

**How to hand over a batch of tools built in parallel**: each tool contributes its files to
the `new-tool/` staging area (git-ignored, a scratch area), and the scripts under
`scripts/new-tool/` merge them in — because `src/registry/tools.rs` and `locales/*.yml`
are shared by every tool, and several people editing them at once overwrite each other's
work.

| Artifact                                    | What it holds                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `new-tool/<slug>.js`                        | the module itself → `static/js/tools/<slug>.js`                           |
| `new-tool/i18n/<slug>.json`                 | the Chinese UI wording (`{ "input": "CSV 内容" }`)                        |
| `new-tool/<slug>.registry.txt`              | the registry fragment (the `Tool { … }` entry)                             |
| `new-tool/<slug>.meta.txt`                  | the title and description, in English and Chinese                          |
| `new-tool/<slug>.fields.txt`                | form-field / option / result-area text, one `key: English \| 中文` per line |

```bash
python3 scripts/new-tool/integrate.py      # registry entry + tools.<slug>.title/description
python3 scripts/new-tool/gen-locales.py    # regenerate the ui.tool section (English read from the JS source)
python3 scripts/new-tool/merge-fields.py   # field.* / opt.* / out.* wording
```

All of them take `--check` (check without writing) and are **idempotent** — running them
twice in a row must not change anything. That is the acceptance criterion.

> Do not touch `src/registry/tools.rs`, `locales/*.yml` or `static/lib/manifest.tsv`
> directly while a batch is in flight — hand the fragment over instead.

Modules go through `ItTools.dom` (`h` / `icon` / `clear`) and `ItTools.util` (`field` /
`copyButton` / `passwordInput` / `randomInt` / `randomBytes` / `base64ToBytes` /
`utf8Bytes` and friends) instead of reinventing the wheel:

```js
(function () {
  'use strict';
  var D = window.ItTools.dom;
  var U = window.ItTools.util;

  window.ItTools.register('my-tool', function (root) { /* ... */ });

  // Expose the pure logic; the harness runs the cases against it
  window.ItTools.logic['my-tool'] = {
    convert: convert,
    __cases: function (assert) { assert.eq(convert(1), 'one', 'English number'); }
  };
})();
```

Two hard rules:

- **Randomness always goes through `U.randomInt` / `U.randomBytes`** (crypto). Do not use
  `Math.random`.
- **Anything that needs cleaning up must be cleaned up in `destroy()`** — event listeners,
  `requestAnimationFrame`, `MediaStream` tracks, `srcObject` — otherwise navigating to and
  from a tool page leaks them.

### UI text has to be i18n'd

Text the user can see in a tool module must not be hardcoded; always go through
`ItTools.t('<slug>')`:

```js
var t = window.ItTools.t('case-converter');

U.field(t('input', 'Your string:'), textarea, { hint: t('input_hint', '…') });
D.outputCard(t('result', 'Result'));
D.h('button.layui-btn', { type: 'button', text: t('copy', 'Copy') });
```

- In the language packs the key is `ui.tool.<slug>.<key>` (in `locales/en.yml` and
  `locales/zh-CN.yml`); the `ui.` prefix is stripped when the pack is shipped to the
  frontend, so the frontend looks up `tool.<slug>.<key>`.
- The second argument is the **English fallback**, used when the pack has no such entry.
- **Keys must be literals** and cannot be built at runtime (`'a.' + x` does not work) — the
  language packs are reconciled entry by entry.

Four unit tests in `src/i18n.rs` keep an eye on this: every `t()` in the code must have a
matching entry in both language packs, the English fallback must be **character-for-character
identical** to the English in the pack, and the packs must not contain orphan entries that
nobody reads. So when you change wording, **change the code and the language pack
together** — changing only one side is caught by the unit tests.

### Adding a language

A language pack may be **only partially translated** — `i18n::t()` falls back to English
**key by key**, so a missing entry shows the English text and no key name ever appears on
the page. A new language can therefore start with the framework and the common words and be
filled in gradually.

`locales/{de,fr,ja,es,ko}.yml` are generated by the scripts under `scripts/i18n/` from
**translation fragments**:

```bash
python3 scripts/i18n/work-order.py --batches 8            # cut the tools into work orders
python3 scripts/i18n/work-order.py --list                 # just the key count per tool
python3 scripts/i18n/merge.py                             # merge the fragments into locales/<code>.yml
python3 scripts/i18n/merge.py --lang de                   # only one language (repeatable)
python3 scripts/i18n/merge.py --rebuild                   # drop the existing files and rebuild from fragments
python3 scripts/i18n/merge.py --check                     # check without writing
python3 scripts/i18n/merge.py --coverage                  # how much each language has covered
python3 scripts/i18n/merge.py --missing de                # list what de is still missing
python3 scripts/i18n/check-fragment.py --lang de --batch 01   # check one fragment
```

- The fragments live in `new-tool/i18n/<code>/<slug>.json` (a **staging area** that can be
  deleted once merged); their content is "full dotted key → translation". `merge.py` merges
  them into the language packs — `locales/*.yml` is shared by every tool, and several people
  editing it at once overwrite each other's work.
- Mind the two different things that live under `new-tool/i18n/`: `<slug>.json` (one file
  per tool) is the **Chinese** wording of a tool's UI, merged by `gen-locales.py`; the
  `<code>/<slug>.json` subdirectories are the **translation fragments** for one target
  language, merged by `merge.py`. The Chinese pack is not managed by `merge.py` (that
  script refuses `zh-CN` on purpose — the two scripts would fight over the same file), and
  the English pack is the source of truth.
- **When the work orders are regenerated, keep the existing batching** and only refresh each
  tool's keys — a batch is a live assignment (who does which tools was agreed on with
  people), and re-shuffling it because the key count moved means reassigning work that has
  already been handed out. To really re-batch, delete `new-tool/i18n/work/batch-*.json` and
  run it again.
- **Pin the terminology down**: the same concept uses the same word in every language
  (`Secret` / 密钥 / Geheimnis / Secret / シークレット / Secreto / 시크릿 and the like), and
  the form of address is pinned too (informal *du* in German, *vous* in French, *tú* in
  Spanish) — terminology is what drifts most easily under parallel translation, and nothing
  catches the drift except a comparison table.
- The language list is written in exactly one place, `AVAILABLE` in `src/i18n.rs` — the
  navbar dropdown, the language negotiation and the pack loading all read from there.

### When using a third-party library

Which libraries a tool needs is declared in `static/lib/manifest.tsv` (slug → artifact
path); **never load them dynamically inside a module**. The template generates the
`<script>` tags from that table and puts them **before** the tool module, and the node tests
read the same table — so there is never a state where "the page got the library but the
tests did not". Four unit tests in `src/registry/libs.rs` guard it: the slug must be a real
JS tool, the artifact must really be under `static/lib/`, and — the reverse one — a JS tool
that is not implemented yet goes red unless the table names it, so a missing declaration
cannot slip through.

The libraries themselves are downloaded by `scripts/vendor-js-libs.sh`. Do not pick an
artifact by guessing from the file name: npm packages are a mix of "deprecated, the path
moved" throw-on-load placeholders, pure ESM re-export stubs, and packages whose "browser
build" label looks convincing but never actually attaches anything to `window`. **Load it
and check — don't guess**:

```bash
cd test/js && node check-vendor.js   # every artifact really runs in jsdom + functional assertions
```

Always run that after changing the manifest in `vendor-js-libs.sh`; the comments there
record several instances of "picked it from memory, it blew up".

## Known pitfalls (all of them are written into the code comments)

Tera 1.20 differs from Jinja2 in a few ways that are worth knowing before writing a template:

- No inline `if` expressions: `{{ "x" if cond else "y" }}` is a syntax error
- Comments are `{# ... #}`, not Jinja's `{% /* ... */ %}`
- Macros only accept **keyword arguments**: `m::icon(icon_name="home")`, and a call has to
  use the `::` namespace; a bare macro call within the same file will not resolve, but a
  self-referencing `{% import %}` recurses **infinitely** (stack overflow)
- No object literals: `{{ {"a": b} }}` is invalid — build it on the Rust side and pass it
  through `| json_encode`
- `{% for a, b in x %}` cannot destructure a tuple; pass an object or an array
- The `replace` filter only accepts a String; convert integers on the Rust side first
- **`escape_html` encodes `/` as `&#x2F;`** (tera-1.20.1/src/utils.rs:17). Browsers decode
  it correctly, but paths coming out of the registry should be marked `| safe` explicitly,
  or the raw HTML will not match

### YAML 1.1 and 1.2 disagree, and the key names change

**PyYAML treats `yes` / `no` / `on` / `off` / `y` / `n` as booleans, serde_yaml treats them
as strings.** The same `yes:` key reads back as `True` in Python and as `yes` in Rust — two
different keys.

The consequence is subtle: the work order is generated from Python's reading, so the
translation lands on `True`; the frontend looks up `yes`, does not find it, and falls back
to the English text. **The page looks perfectly fine — those few entries just stay English,
and nothing reports an error.**

So:

- Scripts read the language packs through `Yaml12` from `scripts/i18n/common.py` (the 1.2
  rules, matching serde_yaml); do not use `yaml.safe_load` directly;
- When writing a language pack, **quote these keys** (`'yes':`) — quoting makes both
  readings agree. `yaml_key()` in `common.py` takes care of that, and `gen-locales.py` uses
  it too;
- `no_language_pack_has_tool_keys_the_code_never_asks_for` in `src/i18n.rs` guards this: any
  language pack that contains "a key the tool code never asks for" goes red.

There is one more pitfall on the JS side: `window.ItTools` in `app.js` **must be assigned
after all the helper definitions**. `var Dom = {...}` is written further down, but `var` is
hoisted to the top of the scope, so assigning earlier captures a not-yet-initialised
`undefined` (`ItTools.dom === undefined`) — and it does not throw; it only blows up later,
when something actually uses it.

## License

GPL-3.0-only. The tool logic and the language packs are ported from it-tools; the
copyright headers and attribution are preserved in [LICENSE](LICENSE).
