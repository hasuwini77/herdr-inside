# 01. The socket API

Everything that controls Herdr from outside goes through one local socket: the `herdr` CLI subcommands, plugins, hooks, and your own scripts. This chapter shows the wire format, so you can talk to it without any wrapper.

Pinned to Herdr v0.9.5 (`2ecf19a`). Links point at that tag.

## Where the socket lives

Herdr listens on a Unix domain socket (a named pipe on Windows). The path is resolved in this order, in [`active_api_socket_path`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/session.rs#L163-L183):

1. `--session <name>` on the CLI: `<config dir>/sessions/<name>/herdr.sock`
2. `HERDR_SOCKET_PATH`, if set
3. the default session: `<config dir>/herdr.sock`

In a Herdr pane `HERDR_SOCKET_PATH` is set (I checked in a live pane), and the bundled agent hook scripts read it, for example [`codex/herdr-agent-state.sh`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/integration/assets/codex/herdr-agent-state.sh). That is why a script run from a pane just works. The server restricts the socket file to mode `0600`, owner only ([`server.rs` L29](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/server.rs#L29), [L304-L306](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/server.rs#L304-L306)).

There is a second socket next to it, `herdr-client.sock`. The path is derived from the API socket name by [inserting `-client`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/server/socket_paths.rs#L50-L59). That one is for the attached terminal client. This chapter is only about the API socket.

## Transport: one line in, one line out

The framing is newline-delimited JSON. The Rust client does exactly this ([`client.rs` L185-L191](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/client.rs#L185-L191), [L222-L229](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/client.rs#L222-L229)): write the JSON, write `\n`, read one line back.

```rust
stream.write_all(serde_json::to_string(request)?.as_bytes())?;
stream.write_all(b"\n")?;
stream.flush()?;
```

The server side reads the first line only, then handles that one request ([`handle_connection_with_stop`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/server.rs#L328-L345)). So the model is **one request per connection**. Open, send, read, close. If you write two request lines on one connection, you get one response and the connection closes. I checked this live with two `ping` lines.

Limits for the request line, from [`server.rs` L32-L34](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/server.rs#L32-L34):

| Limit | Value |
|---|---|
| Time to deliver the line | 5 seconds |
| Max line size | 1 MiB |
| Write timeout | 5 seconds |

The exception is `events.subscribe`, which keeps the connection open. See below.

## Request shape

A request has an `id` you choose, a `method`, and `params`. In Rust the method is a [tagged enum, flattened into the request](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema.rs#L35-L46), which is why it looks flat on the wire:

```json
{"id":"lab:ping","method":"ping","params":{}}
```

`params` is always present. Methods with no arguments take `{}`.

## Response shape

A success has the same `id` and a `result` with a `type` tag ([`SuccessResponse`, `ResponseResult`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/response.rs#L24-L45)). The `type` is snake_case:

```json
{"id":"lab:ping","result":{"type":"pong","version":"0.9.5","protocol":22,"capabilities":{"live_handoff":true}}}
```

An error has the same `id` and an `error` object with a `code` and a `message` ([`ErrorBody`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/response.rs#L36-L41)):

```json
{"id":"lab:bad","error":{"code":"invalid_request","message":"invalid request: unknown variant `nope`"}}
```

So you tell the two apart by checking for `error` versus `result`. There is no `ok: true` flag.

When the line is not valid JSON or has no string `id`, the server cannot echo an id and returns `"id":""` ([`server.rs` L355-L377](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/server.rs#L355-L377)).

## Methods: `group.verb`

The `Method` enum lists every method with its wire name ([`schema.rs` L43-L252](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema.rs#L43-L252)). At v0.9.5 there are 102. The names are dotted and grouped by noun:

| Group | Count | Examples |
|---|---|---|
| `pane.*` | 35 | `pane.list`, `pane.read`, `pane.send_text`, `pane.close` |
| `agent.*` | 12 | `agent.list`, `agent.get`, `agent.wait`, `agent.prompt` |
| `plugin.*` | 11 | `plugin.list`, `plugin.action.invoke` |
| `workspace.*` | 9 | `workspace.list`, `workspace.create` |
| `tab.*` | 7 | `tab.list`, `tab.focus` |
| `server.*` | 6 | `server.stop`, `server.reload_config` |
| `events.*` | 2 | `events.subscribe`, `events.wait` |
| other | 20 | `ping`, `session.snapshot`, `layout.apply`, `worktree.*` |

Most nouns follow a `list` / `get` / mutate pattern. If you want only reads, stick to `ping`, `*.list`, `*.get`, `session.snapshot`. Be careful with `agent.read` and `pane.read`: they return terminal text.

The server also keeps a list of methods that change the UI ([`request_changes_ui`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/mod.rs#L22-L81)). It is a handy "this one writes" index when you are deciding what is safe to call.

## The schema

You do not have to read Rust. The binary prints its own JSON Schema:

```bash
herdr api schema          # short summary: protocol, schema_version, schema names
herdr api schema --json   # full document
```

The summary lists `request`, `success_response`, `error_response`, `event` and `subscription_event`. The same file is in the repo at [`docs/next/api/herdr-api.schema.json`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/api/herdr-api.schema.json). It is generated from the Rust types with `schemars`, so it matches the code.

## Events: the one long-lived connection

`events.subscribe` takes a list of subscriptions. The server answers once with `subscription_started`, then pushes one JSON line per event on the same connection ([`stream_subscriptions`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/server.rs#L914-L1000)):

```json
{"id":"sub_1","method":"events.subscribe","params":{"subscriptions":[{"type":"workspace.created"}]}}
{"id":"sub_1","result":{"type":"subscription_started"}}
```

Subscription types are listed in [`events.rs` L16-L90](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/events.rs#L16-L90): `workspace.*`, `tab.*`, `pane.*`, `worktree.*` and `layout.updated`. Some take a filter, for example `pane.agent_status_changed` takes a `pane_id`.

Two behaviours matter if you build a watcher:

- **All or nothing.** If one subscription is invalid, the whole request fails and the connection closes. I subscribed with a valid entry plus a pane id that does not exist, and got `pane_not_found` and a closed connection.
- **History is bounded.** The server keeps the last [512 events](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/event_hub.rs#L19). A subscriber that falls behind gets an error with code [`events_lost`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/subscriptions.rs#L330-L334) and is disconnected. The message tells you to resubscribe and resync with `session.snapshot`.

`events.wait` is the one-shot version: it blocks until a matching event or a timeout, then returns one response.

## Try it

The lab is [`labs/01-socket.mjs`](../labs/01-socket.mjs). Zero dependencies, Node 20+. Run it from a pane inside Herdr:

```bash
node labs/01-socket.mjs
```

It calls `ping`, `workspace.list`, `agent.list`, and one deliberately unknown method. For each call it prints the request line it sent and the response line it got. It only reads. String values (labels, titles, paths) are masked as `<string>` so the output is safe to paste into an issue. Use `--raw` to see everything.

No Herdr at hand? Run it on invented data:

```bash
node labs/01-socket.mjs --fixture
```

Things to try next: change the method in the lab to `pane.list` or `tab.list` and compare the `result.type`. Open [`fixtures/01-responses.json`](../fixtures/01-responses.json) to see the response shapes.

## Gotchas

- **One request per connection.** A second line on the same connection is ignored and the connection closes. Open a new socket per call.
- **`protocol` is an integer, and it moves.** At 0.9.5 the live server reports `22`. Do not hardcode the value you saw in an old doc example.
- **`capabilities` can be missing.** It is optional in the `pong` result ([`response.rs` L47-L52](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/response.rs#L47-L52)), so guard for `undefined`.
- **Invalid input gets `id: ""`.** Non-JSON, or JSON without an `id`, comes back with an empty id. Do not match responses by id on the error path.
- **Transport errors may have no response.** Invalid UTF-8 or an oversized line closes the connection with nothing written ([`server.rs` L738-L785](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/server.rs#L738-L785)). Treat "closed with no line" as an error.
- **Ids are opaque strings.** Do not parse `w1:p2` style ids. Real workspace ids on a long-lived session do not all look like `w1`.
- **Agent fields are optional.** In `agent.list`, fields such as `name`, `title` and `agent` are omitted when empty ([`agents.rs` L187-L217](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/agents.rs#L187-L217)). Use `?? 'none'`, not direct access.
