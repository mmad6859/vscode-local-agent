# Local Harness Agent (VS Code chat participant)

Puts your local Ollama-backed harness inside VS Code's native Chat view,
`@`-mentionable exactly like the built-in `@workspace` or `@terminal`
participants — no cloud calls, no API key.

## Prerequisites

- VS Code 1.95 or newer
- Node.js 18+ and npm
- [Ollama](https://ollama.com/download) installed and running, with a
  tool-capable model pulled: `ollama pull qwen2.5:7b`

## Run it (development mode)

```bash
cd vscode-local-agent
npm install
npm run compile
```

Then open this folder in VS Code and press **F5**. That launches a second
"Extension Development Host" window with the extension active. Open the
Chat view in that window (the chat icon in the activity bar, or
`Ctrl+Alt+I` / `Cmd+Alt+I`) and type:

```
@localagent check what files exist in this folder
```

You'll see the same confirm-before-execute prompt as the terminal version,
now as a VS Code dialog, before any command, write, or edit actually runs.

## Install it as a regular extension (any project, this PC)

Development mode only works while this folder is open. To use `@localagent`
in **any** VS Code window/project on this machine, package and install it:

```bash
cd vscode-local-agent
npm install
npm run package
```

This produces a versioned `.vsix` file in the project folder. Install it with:

```bash
code --install-extension local-harness-agent-<version>.vsix
```

(or, in VS Code, open the Extensions view → `...` menu →
**Install from VSIX...** and pick the file). Reload any open VS Code windows
— `@localagent` is now available everywhere, no need to keep this folder open.

## Install it on another PC

The `.vsix` file is a self-contained, portable package — copy it to the other
machine (USB drive, shared folder, Slack/email, etc.) and repeat the install
step there. On the other PC you only need:

- VS Code 1.95+
- [Ollama](https://ollama.com/download) installed and running, with the
  model pulled: `ollama pull qwen2.5:7b`

Then run the same install command, pointing at the copied file:

```bash
code --install-extension local-harness-agent-<version>.vsix
```

No Node.js, npm, or source code is required on the target PC — the compiled
extension is bundled inside the `.vsix`. Your `.localagent/` folder (commands
and hooks, see below) lives in each *workspace*, not inside the extension, so
copy that folder alongside your project if you want the same commands/hooks
available on the other PC too.

## Make changes and install a new VSIX version

Run these steps on the development PC whenever the extension code changes:

1. Edit the source files and test the changes in development mode if needed.
2. Bump the `version` in `package.json` (for example, `0.0.6` to `0.0.7`).
  Use a new version for every package so VS Code can identify the update.
3. Compile and package the extension:

  ```bash
  npm run compile
  npm run package
  ```

4. Install the new package on the development PC:

  ```bash
  code --install-extension local-harness-agent-<version>.vsix --force
  ```

5. Copy that same `.vsix` file to each other PC and run the install command
  there with `--force`:

  ```bash
  code --install-extension local-harness-agent-<version>.vsix --force
  ```

6. Run **Developer: Reload Window** in every open VS Code window using the
  extension, or restart VS Code. Existing chat sessions do not load updated
  extension code until the window reloads.

For example, after changing the version to `0.0.7`:

```bash
npm run compile
npm run package
code --install-extension local-harness-agent-0.0.7.vsix --force
```

## Configuration

Open Settings (`Ctrl+,`) and search "Local Agent" to change:

- `localAgent.model` — which pulled Ollama model to use (default `qwen2.5:7b`)
- `localAgent.baseUrl` — Ollama's OpenAI-compatible endpoint (default `http://localhost:11434/v1/chat/completions`)
- `localAgent.maxTurns` — safety cap on tool-calling round-trips per message
- `localAgent.streaming` — stream partial responses token-by-token instead of waiting for the full reply. Disable this if the agent starts describing edits in prose instead of calling `write_file`/`edit_file` — some Ollama/model combinations drop `tool_calls` while streaming
- `localAgent.numCtx` — context window size (tokens) requested from Ollama. Bump this for larger workspaces/files, or the model may silently truncate context and write back incomplete files
- `localAgent.headroomEnabled` — compress conversation context and large tool outputs via a local [Headroom](heardoom_server/README.md) proxy before they reach Ollama. Requires that proxy running separately; safely no-ops if it isn't reachable
- `localAgent.headroomBaseUrl` — base URL of the Headroom proxy (default `http://localhost:8787`)
- `localAgent.headroomMinCharsToCompress` — minimum tool-result length before Headroom compresses it
- `localAgent.subagentsEnabled` — let the agent delegate self-contained subtasks to a `spawn_subagent` tool (see [Subagents](#subagents) below). Off by default
- `localAgent.subagentMaxTurns` — turn cap for a single subagent, independent of `localAgent.maxTurns`

## Custom commands

Drop `.md` files under a `.localagent/commands/` folder **in your workspace**
(not the extension folder) to define your own slash commands. Each filename
becomes the command:

```
.localagent/commands/explain.md   →   /explain
.localagent/commands/review.md    →   /review
```

A command file looks like this:

```markdown
---
description: Explain how a part of the codebase works
---
Explain how the following works in this codebase, tracing the actual data
flow through the relevant files rather than describing it in the abstract:
$ARGUMENTS
```

The optional `description:` frontmatter shows up when you type `/commands`
to list everything that's loaded. `$ARGUMENTS` is replaced with whatever you
type after the command name — `/explain the tool-calling loop` sends the
file's body with `$ARGUMENTS` swapped for `the tool-calling loop`. If a
command file doesn't use `$ARGUMENTS`, anything you typed after the command
name is appended below the body instead.

Commands are re-read from disk on every chat turn, so editing a command file
takes effect immediately — no window reload needed.

## Hooks

Copy `.localagent/hooks.example.js` (shipped alongside this README) to
`.localagent/hooks.js` **in your workspace** to activate it — only that exact
filename is loaded. It's a plain Node `module.exports`, so no build step or
extra dependency is required:

```js
async function beforeToolCall({ name, args }) {
  // Refuse to touch .env files no matter what the agent is asked to do.
  if ((name === 'write_file' || name === 'edit_file') && /\.env(\.|$)/.test(args.path || '')) {
    return { block: `${args.path} looks like a secrets file — refusing.` };
  }
}

async function afterToolCall({ name, args, result }) {
  // Redact anything that looks like a key/token/secret before the model sees it.
  return result.replace(/(key|token|secret)\s*[:=]\s*['"]?[\w.-]{16,}['"]?/gi, '$1=[REDACTED]');
}

module.exports = { beforeToolCall, afterToolCall };
```

Both exports are optional — define only the one you need:

- **`beforeToolCall({ name, args })`** runs before every tool call (including
  inside a subagent). Return `{ block: "reason" }` to refuse the call — the
  model sees that reason as the tool's result and can react to it — or
  `{ args: {...} }` to rewrite the arguments before they run. Returning
  nothing lets the call proceed unchanged.
- **`afterToolCall({ name, args, result })`** runs after the call has already
  executed. Return a string to replace what the model sees; return nothing to
  leave the result unchanged.

Hooks are re-`require()`'d fresh on every chat turn (with the module cache
cleared first), so edits to `hooks.js` take effect immediately without
reloading VS Code.

## Subagents

Set `localAgent.subagentsEnabled: true` to give the agent a `spawn_subagent`
tool. Calling it starts a *fresh*, self-contained tool-calling loop — its own
message history, its own turn budget (`localAgent.subagentMaxTurns`) — for a
single delegated subtask, and only its final text answer is returned to the
main agent; none of its intermediate tool calls appear in your context.

Use this for exploratory or mechanical work you don't need to watch step by
step, e.g. "find every usage of X and summarize them" or "review this file
for bugs." A subagent shares the same approval prompts, hooks, and Headroom
compression as the main agent — file writes still ask you to Allow/Deny —
and it cannot itself call `spawn_subagent` (nesting is disabled by design, to
keep the tool call tree bounded).

## Project layout

```
src/
  extension.ts    — orchestrates a chat turn: builds context, runs the main tool-calling loop
  ollamaClient.ts — calls Ollama's OpenAI-compatible endpoint (streaming and non-streaming)
  tools.ts        — tool schemas + implementations + executeToolCall (shared by the main loop and subagents)
  subagent.ts      — runs a nested tool-calling loop for spawn_subagent
  hooks.ts        — loads .localagent/hooks.js and runs beforeToolCall/afterToolCall
  commands.ts     — loads .localagent/commands/*.md and expands "/name args"
  headroom.ts     — optional context/tool-result compression via a local Headroom proxy
```

## Notes / next steps

- **MCP support**: tools are currently a fixed set hardcoded in `src/tools.ts`.
  Adding an MCP client (`@modelcontextprotocol/sdk`) would let the agent
  connect to any MCP server — GitHub, SharePoint/Graph, a database, etc. —
  and merge their tools into the same array sent to Ollama, without writing
  a new hand-rolled tool for each one.
- **More built-in tools**: add entries to the `TOOLS` array in `src/tools.ts`
  and a matching `case` in `executeToolCall` — e.g. a `move_file` tool using
  `vscode.workspace.fs.rename`, which the fixed six don't currently cover.
- **Real diffs on approval**: the Allow/Deny prompts currently describe an
  edit in words ("replace N chars with M chars"); wiring the `vscode.diff`
  command into the approval flow would let you actually see the change
  before approving it.