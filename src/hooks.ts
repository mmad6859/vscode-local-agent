import * as vscode from 'vscode';
import * as path from 'node:path';

export interface HookModule {
  /**
   * Called before every tool call. Return { block: "reason" } to refuse the call (the model sees
   * that reason as the tool's result and can react to it), or { args: {...} } to rewrite the
   * arguments before they run. Returning nothing/undefined lets the call proceed unchanged.
   */
  beforeToolCall?: (
    call: { name: string; args: any }
  ) => Promise<{ block?: string; args?: any } | void> | { block?: string; args?: any } | void;
  /**
   * Called after every tool call with its (already-executed) result. Return a string to replace
   * the result the model sees (e.g. to redact a secret or append a note); return nothing to leave
   * it unchanged.
   */
  afterToolCall?: (call: { name: string; args: any; result: string }) => Promise<string | void> | string | void;
}

const HOOKS_RELATIVE_PATH = '.localagent/hooks.js';

/**
 * Loads the user's .localagent/hooks.js as a plain CommonJS module, if present. Cache-busted on
 * every load so edits take effect without reloading the extension host — the file is small and
 * read once per chat turn, so re-requiring it every time costs nothing noticeable.
 */
export async function loadHooks(stream?: vscode.ChatResponseStream): Promise<HookModule | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return undefined;
  }

  const hooksPath = path.join(root, HOOKS_RELATIVE_PATH);
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(hooksPath));
  } catch {
    return undefined; // No hooks file — perfectly normal, not an error.
  }

  try {
    delete require.cache[require.resolve(hooksPath)];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(hooksPath);
    if (typeof mod.beforeToolCall !== 'function' && typeof mod.afterToolCall !== 'function') {
      stream?.markdown(`⚠️ \`${HOOKS_RELATIVE_PATH}\` doesn't export \`beforeToolCall\` or \`afterToolCall\` — ignoring it.\n\n`);
      return undefined;
    }
    return mod as HookModule;
  } catch (err: any) {
    stream?.markdown(`⚠️ Failed to load \`${HOOKS_RELATIVE_PATH}\`: ${err.message}\n\n`);
    return undefined;
  }
}

/** Runs beforeToolCall (if defined); returns either a block reason or the (possibly rewritten) args. */
export async function runBeforeHook(
  hooks: HookModule | undefined,
  name: string,
  args: any
): Promise<{ blocked: string } | { args: any }> {
  if (!hooks?.beforeToolCall) {
    return { args };
  }
  try {
    const outcome = await hooks.beforeToolCall({ name, args });
    if (outcome && typeof outcome === 'object' && 'block' in outcome && outcome.block) {
      return { blocked: outcome.block };
    }
    if (outcome && typeof outcome === 'object' && 'args' in outcome && outcome.args) {
      return { args: outcome.args };
    }
    return { args };
  } catch (err: any) {
    return { blocked: `beforeToolCall hook threw: ${err.message}` };
  }
}

/** Runs afterToolCall (if defined); returns the (possibly rewritten) result. */
export async function runAfterHook(hooks: HookModule | undefined, name: string, args: any, result: string): Promise<string> {
  if (!hooks?.afterToolCall) {
    return result;
  }
  try {
    const rewritten = await hooks.afterToolCall({ name, args, result });
    return typeof rewritten === 'string' ? rewritten : result;
  } catch (err: any) {
    return `${result}\n\n(afterToolCall hook threw: ${err.message})`;
  }
}
