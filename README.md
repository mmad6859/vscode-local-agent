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
now as a VS Code dialog, before any command actually runs.

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
extension is bundled inside the `.vsix`.

## Make changes and install a new VSIX version

Run these steps on the development PC whenever the extension code changes:

1. Edit the source files and test the changes in development mode if needed.
2. Bump the `version` in `package.json` (for example, `0.0.4` to `0.0.5`).
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

For example, after changing the version to `0.0.5`:

```bash
npm run compile
npm run package
code --install-extension local-harness-agent-0.0.5.vsix --force
```

## Configuration

Open Settings (`Ctrl+,`) and search "Local Agent" to change:

- `localAgent.model` — which pulled Ollama model to use (default `qwen2.5:7b`)
- `localAgent.baseUrl` — Ollama's endpoint (default `http://localhost:11434/v1/chat/completions`)
- `localAgent.maxTurns` — safety cap on tool-calling round-trips per message

## Notes / next steps

- **Streaming**: responses currently arrive all at once per turn rather than
  token-by-token. Ollama's endpoint supports `"stream": true`; wiring that up
  to `stream.markdown()` incrementally is the natural next improvement.
- **More tools**: add entries to the `TOOLS` array and a matching case in the
  tool-call loop in `src/extension.ts` — e.g. a `read_file` / `write_file`
  tool using `vscode.workspace.fs` instead of shelling out, which is both
  safer and lets VS Code show proper diffs.
