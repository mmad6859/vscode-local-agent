// Copy this file to .localagent/hooks.js to activate it (that exact path/filename is what the
// extension loads — .example.js itself is never picked up). It's a plain Node CommonJS module,
// reloaded fresh on every chat turn, so edits take effect immediately without reloading VS Code.
//
// Both exports are optional — define only the one(s) you need.

/**
 * Runs before every tool call, including inside subagents.
 * Return { block: "reason" } to refuse the call (the model sees the reason and can react to it).
 * Return { args: {...} } to rewrite the arguments before they run.
 * Return nothing to let the call proceed unchanged.
 */
async function beforeToolCall({ name, args }) {
  // Example: never allow the agent to touch .env files, no matter what it's asked to do.
  if ((name === 'write_file' || name === 'edit_file' || name === 'read_file') && /\.env(\.|$)/.test(args.path || '')) {
    return { block: `${args.path} looks like an env/secrets file — refusing to touch it.` };
  }

  // Example: log every shell command this agent runs, for your own audit trail.
  if (name === 'run_terminal_command') {
    console.log(`[local-harness-agent] running: ${args.command}`);
  }
}

/**
 * Runs after every tool call, including inside subagents, with the result that already ran.
 * Return a string to replace what the model sees. Return nothing to leave it unchanged.
 */
async function afterToolCall({ name, args, result }) {
  // Example: redact anything that looks like an API key before it ever reaches the model.
  if (typeof result === 'string') {
    return result.replace(/([A-Za-z0-9_-]*(?:key|token|secret)[A-Za-z0-9_-]*\s*[:=]\s*)['"]?[A-Za-z0-9._-]{16,}['"]?/gi, '$1[REDACTED]');
  }
}

module.exports = { beforeToolCall, afterToolCall };
