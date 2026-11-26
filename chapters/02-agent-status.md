# 02. How Herdr knows an agent is working

Herdr version: v0.9.5. Source links point at the `v0.9.5` tag of [herdrdev/herdr](https://github.com/herdrdev/herdr/tree/v0.9.5).

The sidebar dot next to a pane says `working`, `blocked`, `done` or `idle`. Nobody tells Herdr this directly for most agents. Herdr works it out. This chapter shows how, and why it is sometimes wrong.

## Three questions, three answers

1. Which agent is in this pane? Answer: the foreground process name.
2. What is it doing? Answer: rules matched against the bottom of the terminal buffer, or a report from an integration.
3. Which answer wins if both exist? Answer: the integration, with one exception.

## The status values

The API enum has five values ([`src/api/schema/common.rs#L160-L167`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/common.rs#L160-L167)):

```rust
pub enum AgentStatus { Idle, Working, Blocked, Done, Unknown }
```

The detector itself only knows four. There is no `Done` ([`src/detect/mod.rs#L11-L20`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/mod.rs#L11-L20)): `Idle`, `Working`, `Blocked`, `Unknown`.

`Done` is made up at the edge. It means "idle, and you have not looked at this pane yet" ([`src/app/api_helpers.rs#L96-L107`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api_helpers.rs#L96-L107)):

```rust
match (state, seen) {
    (AgentState::Idle, false) => AgentStatus::Done,
    (AgentState::Idle, true)  => AgentStatus::Idle,
    (AgentState::Working, _)  => AgentStatus::Working,
    (AgentState::Blocked, _)  => AgentStatus::Blocked,
    (AgentState::Unknown, _)  => AgentStatus::Unknown,
}
```

So `done` goes back to `idle` when you focus the pane. No agent output changed.

## Step 1: which agent?

Herdr asks the OS for the pane's foreground process group and matches process names to an agent. The mapping is a plain `match` on the basename ([`src/detect/mod.rs#L198-L205`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/mod.rs#L198-L205)):

```rust
"pi" => Some(Agent::Pi),
"claude" | "claude-code" => Some(Agent::Claude),
"codex" => Some(Agent::Codex),
```

It first checks the process that leads the foreground group, then scores the other processes in the group ([`src/detect/mod.rs#L254-L286`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/mod.rs#L254-L286)). The docs list consequences:

- A wrapper can hide the agent. Set `HERDR_AGENT=claude` on the wrapper command to tell Herdr which manifest to use.
- tmux inside a pane hides the agent. Herdr sees `tmux`.

Both are in [`agents.mdx`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/agents.mdx#L68-L72).

Version 0.9.5 knows 24 agents ([`src/detect/mod.rs#L35-L60`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/mod.rs#L35-L60) lists the enum). A new agent needs a new Herdr binary, because process names live in the binary.

## Step 2a: screen detection

Every identified pane is re-read on a short timer. Herdr takes the live bottom of the terminal buffer (not the scrollback you are looking at) and runs it through a TOML manifest per agent. `herdr pane read <pane> --source detection` prints exactly that text ([`socket-api.mdx`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx#L843-L855)).

The manifests ship inside the binary at [`src/detect/manifests/`](https://github.com/herdrdev/herdr/tree/v0.9.5/src/detect/manifests), one file per agent. Each file is a list of rules with a state, a priority and a region of the screen. Here are two from Claude Code ([`claude.toml#L16-L25`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/manifests/claude.toml#L16-L25), [`#L79-L95`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/manifests/claude.toml#L79-L95)):

```toml
[[rules]]
id = "live_turn_working"
state = "working"
priority = 970
region = "bottom_non_empty_lines(12)"
visible_working = true
any = [
  { line_regex = ['^\s*[⏸⏵].*esc to interrupt(?:\s|·|$)'] },
  # ...spinner line like "✻ Thinking… (12s"
]

[[rules]]
id = "live_blocked_form"
state = "blocked"
priority = 980
region = "after_last_horizontal_rule"
visible_blocker = true
contains = ["esc to cancel"]
# ...and one of: "enter to confirm", or "enter to select" + a navigate hint
```

How to read it:

- `esc to interrupt` in the bottom 12 non-empty lines means Claude is mid-turn.
- `esc to cancel` plus a confirm hint, below the last horizontal rule, means a dialog waits for you.
- If several rules match, the highest `priority` wins ([`src/detect/manifest.rs#L465`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/manifest.rs#L465)). Blocked (980) beats working (970).
- `visible_blocker = true` marks the match as live chrome, not stray text. This flag matters in the next section.

If no rule matches for a known agent, the result is `idle`. The docs call this `default_known_agent_idle_fallback` ([`agents.mdx#L74-L78`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/agents.mdx#L74-L78)). So an unknown dialog looks idle, not blocked.

Two smoothing rules keep the dot from flickering:

- A working-to-idle change is held back until three further reads agree, or 700 ms pass ([`src/pane/agent_detection.rs#L8-L9`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/pane/agent_detection.rs#L8-L9), [`#L39-L80`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/pane/agent_detection.rs#L39-L80)).
- When Herdr first sees an agent process, it sets the state to `Unknown` and does not read the screen for 3 seconds ([`src/pane.rs#L1108-L1112`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/pane.rs#L1108-L1112), [`#L1141-L1156`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/pane.rs#L1141-L1156)).

## Step 2b: integration hooks

`herdr integration install <agent>` writes a small script or plugin for that agent. The agent runs it on its own lifecycle events, and the script sends a report to Herdr's socket (`pane.report_agent` or `pane.report_agent_session`, see [`src/api/schema.rs#L204-L207`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema.rs#L204-L207)).

There are two kinds, and this is the surprise at v0.9.5:

- Session identity only. The hook says which session is in the pane so Herdr can resume it. It does not say working or blocked. Claude Code and Codex are in this group. The Claude script exits unless the event is `SessionStart` ([`herdr-agent-state.sh`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/integration/assets/claude/herdr-agent-state.sh#L54)). The 0.9.5 changelog says it for Codex: "Herdr no longer installs Codex turn hooks, and Codex status comes from screen detection again" ([`CHANGELOG.md#L11`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/CHANGELOG.md#L11)).
- Full lifecycle. The hook reports every state. Six agents: pi, omp, mastracode, opencode, kilo, kimi ([`src/detect/mod.rs#L330-L339`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/mod.rs#L330-L339)).

So for Claude Code, the status you see in 0.9.5 is screen detection. Claude's old state hooks (`PreToolUse`, `Stop`, `PermissionRequest`) are on a removal list that the installer cleans out of `settings.json` ([`claude_settings.rs#L26-L59`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/integration/claude_settings.rs#L26-L59)).

## How the two sources combine

One function decides ([`src/terminal/state.rs#L2404-L2418`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/terminal/state.rs#L2404-L2418)):

```rust
let state = if self.visible_blocker_overrides_hook() {
    AgentState::Blocked
} else {
    self.hook_authority.as_ref()
        .filter(|authority| self.hook_authority_is_effective(authority))
        .map(|authority| authority.state)
        .unwrap_or(self.fallback_state)
};
```

In words:

1. If a hook has reported state and is still valid, use the hook's state.
2. Otherwise use the screen's state (`fallback_state`).
3. Exception: a visible blocker on screen beats a non-blocked hook, for the same agent, when the screen read is not older than the hook report ([`#L2078-L2089`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/terminal/state.rs#L2078-L2089)).
4. For the six full-lifecycle agents the exception is off, and the screen is ignored ([`#L2078-L2081`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/terminal/state.rs#L2078-L2081)). The API shows this as `screen_detection_skipped: true` on the agent ([`src/api/schema/agents.rs#L202-L203`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/agents.rs#L202-L203)).

The exception exists because a hook can miss a permission prompt, and the screen cannot.

## Why status can be wrong

- Unknown prompt shapes read as `idle`. No rule matches, so the fallback is idle. The docs warn that automation which trusts this "can type into an approval dialog" ([`agents.mdx#L78`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/agents.mdx#L78)).
- Quoted text looks like a dialog. The Claude rule for MCP background tasks carries a `not` list (`do you want to proceed?`, `esc to cancel`, ...) so that text in the conversation does not trigger it ([`claude.toml#L35-L51`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/manifests/claude.toml#L35-L51)). The changelog has many fixes of this kind, for example Codex showing blocked because "earlier output quotes a confirmation prompt" ([`CHANGELOG.md#L226`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/CHANGELOG.md#L226)) and Claude flickering to blocked from custom status text ([`#L693`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/CHANGELOG.md#L693)).
- Boot window. For the first 3 seconds after an agent starts, the state is `unknown`, whatever is on screen. A script that waits for `idle` before sending input can act too early or too late around that window.
- Idle is not finished. Antigravity and Grok count as idle at their prompt even with background tasks running, so `agent wait --until idle` returns early ([`agents.mdx#L80`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/agents.mdx#L80)).
- Screen text is not always the live screen. Claude's transcript viewer (`ctrl+o`) has its own rule with `skip_state_update`, so the state freezes while the viewer is open ([`claude.toml#L64-L76`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/detect/manifests/claude.toml#L64-L76)).
- Rules can change under you. Herdr fetches rule updates from herdr.dev and applies them without a restart; local files in `~/.config/herdr/agent-detection/<agent>.toml` override both ([`agents.mdx#L84-L96`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/agents.mdx#L84-L96)).

When a pane looks wrong, ask Herdr why:

```bash
herdr agent explain <pane>
herdr agent explain --file screen.txt --agent claude --json   # offline, no server
```

It prints the matched rule, its priority and region, and the fallback reason ([`agents.mdx#L100-L106`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/agents.mdx#L100-L106)). I did not run it against the live session for this chapter. Treat the flags as described in the docs.

## Try it

The lab watches status changes without touching your panes. It polls `agent.list` once a second on a fresh connection and prints one line per change: time, pane id, agent, old and new status. It never sends input, and it prints no titles, paths or workspace names.

```bash
# Live, inside a Herdr pane (needs HERDR_SOCKET_PATH). Stops after 30 s.
node labs/02-status-watch.mjs --seconds 30

# No Herdr needed. Replays an invented sequence from fixtures/02-status-sequence.json.
node labs/02-status-watch.mjs --fixture fixtures/02-status-sequence.json
```

The fixture output looks like this:

```text
00:00:00  w1:p1   claude     new -> idle
00:00:00  w1:p2   codex      new -> idle
00:00:01  w1:p1   claude     idle -> working
00:00:04  w1:p1   claude     working -> blocked
00:00:06  w1:p1   claude     blocked -> working
00:00:07  w1:p2   codex      idle -> working
00:00:12  w1:p1   claude     working -> done
00:00:15  w1:p1   claude     done -> idle
00:00:16  w1:p2   codex      working -> done
```

Things to try in a live session:

- Start a long Claude turn in one pane and watch `idle -> working -> done`.
- Focus the pane that shows `done` and watch it change to `idle` with no agent output.
- Trigger a permission prompt and watch `blocked`.

Why polling and not `events.subscribe`? The `pane.agent_status_changed` subscription takes a required `pane_id` ([`src/api/schema/events.rs#L75-L80`](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/events.rs#L75-L80)), and one bad pane id rejects the whole request ([`socket-api.mdx#L789-L792`](https://github.com/herdrdev/herdr/blob/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx#L789-L792)). Polling also sees panes created after the lab started. This repo does not cover subscriptions yet.

## Gotchas

- `done` is a view state, not an agent state. It clears when you focus the pane.
- In 0.9.5, Claude Code and Codex status is screen detection only. Installing their integration gives you session resume, not better status.
- The detector reads text, so a new agent release that changes its UI can break a rule until a manifest update lands.
- A fallback `idle` can hide a real dialog. Do not auto-approve or auto-type on `idle` alone.
- Reading status over the socket is safe. Sending keys or prompts is not. Keep monitors read-only.
