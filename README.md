# Herdr from the inside

Herdr runs your coding agents in panes and tells you which one needs you. This repo explains how it does that, read from its source, with small labs you can run against your own Herdr.

Unofficial. Not affiliated with the Herdr maintainers. Pinned to **Herdr v0.9.5** (`2ecf19a`).

## Chapters

| # | Chapter | Lab |
|---|---|---|
| 01 | [The socket API](chapters/01-socket-api.md) | `node labs/01-socket.mjs` |
| 02 | [How Herdr knows an agent is working](chapters/02-agent-status.md) | `node labs/02-status-watch.mjs` |
| 03 | [Plugins and sidebar metadata](chapters/03-plugins-metadata.md) | `node labs/03-metadata-token.mjs` |

New chapters land as pull requests. The [changelog notes](whats-new/) track each release.

## Run the labs

Labs need Node 20+ and a running Herdr. They have no dependencies. Run them from a pane inside Herdr, so `HERDR_SOCKET_PATH` is set.

```bash
git clone https://github.com/hasuwini77/herdr-inside
cd herdr-inside
node labs/01-socket.mjs
```

Every lab only reads, except lab 03, which writes one short-lived token to your own pane.

## How claims are checked

Every claim about Herdr points to a file at the pinned tag. If a behaviour changes in a later release, the chapter says so and links the changelog entry.

## License

MIT for this repo's text and labs. Quoted Herdr code stays Apache-2.0; see [NOTICE](NOTICE).
