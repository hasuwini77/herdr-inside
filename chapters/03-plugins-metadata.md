# 03. Plugins and sidebar metadata

Herdr v0.9.5. Two ideas in this chapter. A plugin is a folder with a manifest that Herdr can run. Sidebar metadata is a small API any process can call to attach text to a pane. A plugin is only one of the callers.

## What a plugin is

A plugin is a directory with a `herdr-plugin.toml` and some commands. There is no SDK. The docs say the whole Herdr CLI is the plugin API ([plugins.mdx#L11-L24](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/plugins.mdx#L11-L24)). Plugins are not sandboxed: they run as your user.

The manifest is parsed into this struct. `id`, `name`, `version` and `min_herdr_version` are required, and Herdr refuses a plugin whose `min_herdr_version` is newer than the running binary ([manifest.rs#L12-L35](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api/plugins/manifest.rs#L12-L35), [manifest.rs#L227-L256](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api/plugins/manifest.rs#L227-L256)).

```rust
struct RawPluginManifest {
    id: String,
    name: String,
    version: String,
    min_herdr_version: Option<String>,
    description: Option<String>,
    platforms: Option<Vec<RawPlatform>>,
    build: Vec<RawPluginManifestBuild>,
    startup: Vec<RawPluginManifestStartup>,
    actions: Vec<RawPluginManifestAction>,
    events: Vec<RawPluginManifestEventHook>,
    panes: Vec<RawPluginManifestPane>,
    link_handlers: Vec<RawPluginManifestLinkHandler>,
}
```

A small manifest, shaped like the one in herdr-spinner (see below):

```toml
id = "example.hello"
name = "Hello"
version = "0.1.0"
min_herdr_version = "0.8.0"
platforms = ["linux", "macos"]

[[startup]]
command = ["sh", "run.sh"]

[[actions]]
id = "restart"
title = "Restart hello"
contexts = ["workspace"]
command = ["sh", "run.sh", "--restart"]
```

`command` is an argv array. Herdr does not run it through a shell ([plugins.mdx#L54-L121](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/plugins.mdx#L54-L121)). That is why herdr-spinner ships a `run.sh`: it needs a shell to find `node`.

| Manifest key | What it declares |
| --- | --- |
| `[[build]]` | Commands run during a GitHub install, before registration |
| `[[startup]]` | Run once after the session is restored and the socket is ready |
| `[[actions]]` | Named commands you can invoke or bind to a key |
| `[[events]]` | Commands run on a Herdr event |
| `[[panes]]` | Terminal panes the plugin can open |
| `[[link_handlers]]` | Route clicked URLs to an action |

Startup hooks are documented as one-shot commands, not supervised daemons ([plugins.mdx#L247-L263](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/plugins.mdx#L247-L263)). A plugin that wants a long-running process has to detach it itself. herdr-spinner does this and says so in its README.

## Install, link, update

Two ways in:

```bash
herdr plugin install owner/repo[/subdir] [--ref REF] [--yes]   # from GitHub
herdr plugin link /path/to/plugin                              # a local folder
```

- **install** takes GitHub shorthand only. It runs `git init`, `git fetch --depth 1 origin <ref or HEAD>`, then `git checkout --detach FETCH_HEAD` ([cli/plugin.rs#L1069-L1089](https://github.com/herdrdev/herdr/blob/v0.9.5/src/cli/plugin.rs#L1069-L1089)). Each install goes into a fresh directory under the Herdr config dir, named after the process id and a counter ([plugin_paths.rs#L22-L41](https://github.com/herdrdev/herdr/blob/v0.9.5/src/plugin_paths.rs#L22-L41)).
- **link** registers your working directory in place. It does not run `[[build]]` commands ([plugins.mdx#L232-L245](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/plugins.mdx#L232-L245)). Both commands also work when no server is running: the CLI falls back to the registry file ([cli/plugin.rs#L51-L85](https://github.com/herdrdev/herdr/blob/v0.9.5/src/cli/plugin.rs#L51-L85)).

Every plugin gets a config dir and a state dir, created for you ([plugin_paths.rs#L44-L63](https://github.com/herdrdev/herdr/blob/v0.9.5/src/plugin_paths.rs#L44-L63)). Your code gets them as `HERDR_PLUGIN_CONFIG_DIR` and `HERDR_PLUGIN_STATE_DIR`, next to `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` ([plugins.mdx#L265-L297](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/plugins.mdx#L265-L297)).

### How `herdr plugin update` works

`update` only touches GitHub installs. With no arguments it takes every one; with arguments it takes plugin ids or `owner/repo` sources, and refuses a linked plugin ([cli/plugin.rs#L224-L290](https://github.com/herdrdev/herdr/blob/v0.9.5/src/cli/plugin.rs#L224-L290)). For each plugin it re-runs the install path with the ref that was recorded at install time. If the fetched commit equals the stored one it stops there:

```rust
if updating
    && existing
        .as_ref()
        .and_then(|plugin| plugin.source.resolved_commit.as_deref())
        == Some(resolved_commit.as_str())
{
    println!("{} is already up to date.", preview_plugin.plugin_id);
    return Ok(true);
}
```

([cli/plugin.rs#L349-L357](https://github.com/herdrdev/herdr/blob/v0.9.5/src/cli/plugin.rs#L349-L357)). A new commit gets a new installation directory. Running commands keep their old files because each install directory is held by a shared file lock on an `.in-use` marker ([plugin_installations.rs#L9-L21](https://github.com/herdrdev/herdr/blob/v0.9.5/src/plugin_installations.rs#L9-L21)). A daemon you started from the old version keeps running the old code until you restart it. Startup hooks only run again at the next server start ([plugins.mdx#L195-L205](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/plugins.mdx#L195-L205)).

## Plugin panes

`[[panes]]` entries are terminal commands that Herdr hosts. `placement` is one of `overlay` (the default), `popup`, `split`, `tab`, `zoomed` ([schema/plugins.rs#L445-L452](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/plugins.rs#L445-L452)). Open one with `herdr plugin pane open --plugin <id> --entrypoint <pane id>`. Except for `popup`, they are ordinary panes once open ([plugins.mdx#L299-L343](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/plugins.mdx#L299-L343)).

## Sidebar metadata

Any process that can reach the socket can attach metadata to a pane. The method is `pane.report_metadata`. The socket speaks one JSON object per line ([socket-api.mdx#L610-L622](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx#L610-L622)).

```json
{"id":"1","method":"pane.report_metadata","params":{"pane_id":"<id>","source":"user:demo","tokens":{"build":"green 4/4"},"ttl_ms":5000}}
```

The params struct ([schema/panes.rs#L401-L428](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/panes.rs#L401-L428)):

| Field | Meaning |
| --- | --- |
| `pane_id`, `source` | Required. `source` is 1-80 chars of letters, digits, `: . _ -` ([api_helpers.rs#L210-L227](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api_helpers.rs#L210-L227)) |
| `tokens` | Map of name to string. A string sets, `null` clears, omitted keys stay |
| `title`, `display_agent`, `state_labels` | Presentation overrides. `state_labels` keys: `idle working blocked done unknown` |
| `clear_title`, `clear_display_agent`, `clear_state_labels` | Remove those overrides |
| `seq` | Drop reports that arrive out of order, per source |
| `ttl_ms` | Expiry, 1 to 86400000 |

Limits, from the same file ([api_helpers.rs#L202-L208](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api_helpers.rs#L202-L208), [api_helpers.rs#L244-L279](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api_helpers.rs#L244-L279)): a request may touch 16 tokens, a pane may hold 32. Names are 1-32 chars of letters, digits, `_` and `-`. Values are trimmed, stripped of control characters and cut at 80 characters. An empty value clears the key.

### TTL

The handler turns `ttl_ms` into a `Duration`, then stamps each token it sets with `now + ttl` ([api_helpers.rs#L229-L242](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api_helpers.rs#L229-L242), [metadata_tokens.rs#L44-L66](https://github.com/herdrdev/herdr/blob/v0.9.5/src/metadata_tokens.rs#L44-L66)):

```rust
let expires_at = ttl.and_then(|ttl| now.checked_add(ttl));
// ...
Some(value) => {
    let token = MetadataToken { value, expires_at };
```

The server keeps the earliest deadline and removes due tokens itself ([metadata_tokens.rs#L91-L102](https://github.com/herdrdev/herdr/blob/v0.9.5/src/metadata_tokens.rs#L91-L102), [app/runtime.rs#L43-L70](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/runtime.rs#L43-L70)). So the sender does not have to clean up. The deadline belongs to each token, set by the report that last wrote it. A report without `ttl_ms` removes the expiry from that key, and the token then stays until cleared. A unit test pins this ([metadata_tokens.rs#L241-L257](https://github.com/herdrdev/herdr/blob/v0.9.5/src/metadata_tokens.rs#L241-L257)).

Tokens are also not saved across a server restart ([socket-api.mdx#L769](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx#L769)).

### Showing a token in the sidebar

A custom token in `rows` is a string starting with `$`. Anything else that is not a built-in name is a config error ([config/sidebar.rs#L221-L240](https://github.com/herdrdev/herdr/blob/v0.9.5/src/config/sidebar.rs#L221-L240)). Agent rows use `ui.sidebar.agents.rows`; workspace tokens go in `ui.sidebar.spaces.rows` ([config-reference.json#L1070-L1094](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/data/config-reference.json#L1070-L1094)).

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  [{ token = "$build", fg = "#a6e3a1", dim = false }, "agent"],
]
```

Entries are token strings or inline tables with `fg`, `bold`, `dim` and up to 16 `rules` (`equals`, `contains`, `starts_with`, `gt`, `lt`). At most 16 rows and 16 tokens per row.

## Worked example: herdr-spinner

[herdr-spinner](https://github.com/hasuwini77/herdr-spinner/blob/fa78b2b/spinner.js) animates the sidebar with a `$spin` token. Herdr's own working icon is a static glyph. The plugin gives you motion with no Herdr patch.

**Manifest.** [`herdr-plugin.toml`](https://github.com/hasuwini77/herdr-spinner/blob/fa78b2b/herdr-plugin.toml) declares one `[[startup]]` command (`sh run.sh`) and five `[[actions]]`: restart, stop, next style, next theme, reset theme. `min_herdr_version` is `0.8.0`.

**Daemon.** `run.sh` finds Node, kills any older copy, detaches `spinner.js` and exits, so the startup hook returns at once.

**Loop.** Every second the daemon runs `herdr api snapshot` and collects the panes whose `agent_status` is `working`. Every frame it spawns one CLI call per such pane:

```js
const setFrame = (pane, frame) =>
  report(pane, ["--token", `${TOKEN}=${frame}`, "--ttl-ms", String(TTL_MS)]);
// report() runs: herdr pane report-metadata <pane> --source <plugin id> ...
```

Frame rate is 160 ms by default (6.25 fps). The TTL is `max(1000, 8 * interval)`, so 1280 ms by default:

```js
TTL_MS = Math.max(1000, cfg.intervalMs * 8);
```

**Why the TTL matters.** If the daemon is killed, the next frame never arrives. Herdr drops the token about 1.3 seconds after the last one. The glyph vanishes, and a pane is never shown as working because of a stale frame. When a pane leaves `working`, or on SIGTERM, the daemon sends `--clear-token spin` first. The TTL is the backstop for crashes.

An earlier Python version of this plugin ran at 4 fps with a 1200 ms TTL. It wrote the glyph into `state_labels` instead of a `$spin` token. The mechanism is the same: a short TTL, refreshed on every frame.

Does this still fit v0.9.5? Yes. Every call it makes (`pane.report_metadata` with a token and a TTL, `$name` in rows) is in the source above.

## Try it

Run the lab inside any Herdr pane. It writes a three-step countdown to a token called `herdr_inside_lab`, prints each request it sends, and then stops without clearing anything.

```bash
node labs/03-metadata-token.mjs --dry-run   # print the requests, no connection
node labs/03-metadata-token.mjs             # send them to the pane in HERDR_PANE_ID
```

Add the `rows` line the script prints to your config, run `herdr config check`, and reload. Then run the lab again and watch the text count down and vanish. You can also confirm without touching config: `herdr pane get "$HERDR_PANE_ID"` lists the token while it is alive, and not after about 2.5 seconds.

The lab only writes to your own pane, with a 2.5 second TTL.

## Gotchas

- **Leaving out `ttl_ms` makes a token permanent.** A later report without it cancels an earlier expiry on that key. A heartbeat sender should send the TTL every time.
- **Tokens show only if a row names them.** Setting a token succeeds even when no row uses it.
- **Sequence numbers drop reports silently.** A stale `seq` returns `ok` and changes nothing ([app/api/panes.rs#L1803-L1805](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api/panes.rs#L1803-L1805)).
- **The `agent` and `applies_to_source` guards apply to presentation fields only**, not to tokens ([socket-api.mdx#L753](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx#L753)). Two plugins that use the same token name overwrite each other.
- **Use a distinct `source`.** `seq` is tracked per source, and a pane remembers at most 32 sequenced sources for its lifetime ([metadata_tokens.rs#L15-L38](https://github.com/herdrdev/herdr/blob/v0.9.5/src/metadata_tokens.rs#L15-L38)).
- **An old daemon outlives `plugin update`.** New code only runs after you restart the process.
- **Per-frame process spawns cost CPU.** herdr-spinner's README measures about 1% of a core per animated pane. A direct socket client, like the lab, skips the spawn.
