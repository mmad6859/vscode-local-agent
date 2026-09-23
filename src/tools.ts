import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { compressToolResult } from './headroom';
import { runBeforeHook, runAfterHook, HookModule } from './hooks';

const execAsync = promisify(exec);

export const TOOLS: any[] = [
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
      description:
        'Execute a shell command in the current workspace folder and return its stdout/stderr.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a workspace-relative file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a brand-new workspace-relative file. Fails if the file already exists unless ' +
        'overwrite is set to true. For any change to an EXISTING file, use edit_file instead — ' +
        'do not use write_file to modify a file that already exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          overwrite: {
            type: 'boolean',
            description: 'Set true only if you intend a full, deliberate replacement of an existing file.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Make a targeted edit to an existing workspace-relative file by replacing one exact, unique ' +
        'occurrence of old_string with new_string. This is the preferred way to change an existing ' +
        'file — you only need to include the lines that change, not the whole file. old_string must ' +
        "match the file's current exact text (use read_file first if unsure) and must be unique in " +
        'the file; include enough surrounding lines to make it unique if it is not.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders under a workspace-relative directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_workspace',
      description: 'Search workspace text files for a literal or regex pattern.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, isRegex: { type: 'boolean' } },
        required: ['query'],
      },
    },
  },
];

/** Only offered to the model when Headroom compression is enabled, since it depends on that feature's cache. */
export const HEADROOM_RETRIEVE_TOOL = {
  type: 'function',
  function: {
    name: 'headroom_retrieve',
    description:
      'Retrieve the full original content of a tool result that Headroom compressed earlier in this turn.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
};

/** Only offered to the top-level agent (never to a subagent, which cannot itself spawn one) when subagents are enabled. */
export const SPAWN_SUBAGENT_TOOL = {
  type: 'function',
  function: {
    name: 'spawn_subagent',
    description:
      'Delegate a focused, self-contained subtask to a fresh subagent with its own tool-calling loop ' +
      '(read_file, list_directory, search_workspace, run_terminal_command, write_file, edit_file — file ' +
      'writes still ask the user for approval). Use this to offload a well-defined chunk of exploratory ' +
      'or mechanical work (e.g. "find every usage of X and summarize them", "review this file for bugs") ' +
      'without filling up your own context with the intermediate steps. Only the subagent\'s final answer ' +
      'is returned to you — you will not see its intermediate tool calls. The subagent cannot spawn ' +
      'further subagents, so do not delegate a task that itself needs delegating.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'A complete, self-contained description of the subtask. The subagent has no access to this ' +
            'conversation, so include everything it needs to know.',
        },
      },
      required: ['task'],
    },
  },
};

export interface ToolContext {
  stream: vscode.ChatResponseStream;
  headroomEnabled: boolean;
  headroomBaseUrl: string;
  headroomMinChars: number;
  headroomMemory: Map<string, string>;
  filesByName: Map<string, string>;
  hooks: HookModule | undefined;
  /** 0 = the main agent, 1 = inside a subagent. Subagents cannot spawn further subagents. */
  depth: number;
  subagentsEnabled: boolean;
  /** Injected by extension.ts to avoid a circular import between tools.ts and subagent.ts. */
  runSubagent?: (task: string, ctx: ToolContext) => Promise<string>;
}

export function buildToolsForRequest(opts: { headroomEnabled: boolean; subagentsEnabled: boolean; depth: number }): any[] {
  const tools = [...TOOLS];
  if (opts.headroomEnabled) {
    tools.push(HEADROOM_RETRIEVE_TOOL);
  }
  if (opts.subagentsEnabled && opts.depth === 0) {
    tools.push(SPAWN_SUBAGENT_TOOL);
  }
  return tools;
}

/** If a shell command is just re-reading a file we already have attached content for, skip the shell entirely. */
export function matchAttachedFile(command: string, filesByName: Map<string, string>): string | undefined {
  for (const [name, content] of filesByName) {
    if (command.toLowerCase().includes(name)) {
      return content;
    }
  }
  return undefined;
}

/**
 * Ask the user to approve a proposed shell command (VS Code's equivalent of the
 * "Allow? [y/N]" prompt in the terminal version), then run it if approved.
 */
async function runTerminalCommand(command: string): Promise<string> {
  const choice = await vscode.window.showWarningMessage(
    `Local agent wants to run: ${command}`,
    { modal: true },
    'Allow',
    'Deny'
  );

  if (choice !== 'Allow') {
    return 'Command blocked by user.';
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30_000 });
    return stdout || stderr || '(no output)';
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

function resolveWorkspacePath(relPath: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error('No workspace folder open.');
  }
  return vscode.Uri.joinPath(root, relPath);
}

async function readFileTool(relPath: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(resolveWorkspacePath(relPath));
  return Buffer.from(bytes).toString('utf8');
}

async function listDirectoryTool(relPath: string): Promise<string> {
  const entries = await vscode.workspace.fs.readDirectory(resolveWorkspacePath(relPath));
  const names = entries.map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name));
  return names.length ? names.join('\n') : '(empty directory)';
}

/**
 * Gates file writes behind the same Allow/Deny approval used for shell commands.
 * Refuses to touch an existing file unless overwrite:true was explicitly passed — this is what
 * stops a "lazy" partial response from silently wiping a file, instead of only warning about it.
 */
async function writeFileTool(relPath: string, content: string, overwrite: boolean): Promise<string> {
  const uri = resolveWorkspacePath(relPath);
  let existed = true;
  let existingContent = '';
  try {
    existingContent = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    existed = false;
  }

  if (existed && !overwrite) {
    return (
      `Error: ${relPath} already exists. Use edit_file for a targeted change, or call write_file ` +
      'again with overwrite: true only if you genuinely intend to replace the entire file.'
    );
  }

  // A drastic size drop usually means the model's context got truncated and it only echoed back part of the file.
  const looksTruncated = existed && existingContent.length > 200 && content.length < existingContent.length * 0.5;
  const sizeNote = `${existingContent.length} -> ${content.length} chars`;
  const warning = looksTruncated
    ? `⚠️ Local agent wants to overwrite ${relPath} (${sizeNote}) — this looks much shorter than the original, possibly a truncated rewrite. Overwrite anyway?`
    : `Local agent wants to ${existed ? 'overwrite' : 'create'} ${relPath} (${content.length} chars).`;

  const choice = await vscode.window.showWarningMessage(warning, { modal: true }, 'Allow', 'Deny');
  if (choice !== 'Allow') {
    return 'Write blocked by user.';
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  return `Wrote ${content.length} chars to ${relPath}.`;
}

/**
 * Edits an existing file by exact string replacement instead of requiring the model to
 * reproduce the entire file. The model only needs to specify what changed, so there's no
 * way for it to accidentally drop content it never meant to touch.
 */
async function editFileTool(relPath: string, oldString: string, newString: string): Promise<string> {
  const uri = resolveWorkspacePath(relPath);
  const original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

  const occurrences = original.split(oldString).length - 1;
  if (occurrences === 0) {
    return (
      `Error: old_string not found in ${relPath}. It must match the file's current content ` +
      'exactly, including whitespace. Call read_file first to get the exact text.'
    );
  }
  if (occurrences > 1) {
    return (
      `Error: old_string appears ${occurrences} times in ${relPath} — it must be unique. ` +
      'Include more surrounding context to pinpoint a single location.'
    );
  }

  const updated = original.replace(oldString, newString);

  const choice = await vscode.window.showWarningMessage(
    `Local agent wants to edit ${relPath} — replace ${oldString.length} chars with ${newString.length} chars.`,
    { modal: true },
    'Allow',
    'Deny'
  );
  if (choice !== 'Allow') {
    return 'Edit blocked by user.';
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
  return `Edited ${relPath}: replaced ${oldString.length} chars with ${newString.length} chars.`;
}

async function searchWorkspaceTool(query: string, isRegex: boolean): Promise<string> {
  const pattern = isRegex ? new RegExp(query) : undefined;
  const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,out,dist,.git}/**', 200);
  const hits: string[] = [];

  for (const uri of files) {
    if (hits.length >= 100) {
      break;
    }
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      continue;
    }
    const relPath = vscode.workspace.asRelativePath(uri);
    text.split('\n').forEach((line, i) => {
      const match = pattern ? pattern.test(line) : line.includes(query);
      if (match && hits.length < 100) {
        hits.push(`${relPath}:${i + 1}: ${line.trim()}`);
      }
    });
  }

  return hits.length ? hits.join('\n') : 'No matches.';
}

/** Some models emit `{"name": ..., "arguments": {...}}` as plain text instead of a real tool_calls entry; recover those. */
export function extractFakeToolCalls(
  content: string,
  toolNames: Set<string>
): { id: string; type: 'function'; function: { name: string; arguments: string } }[] {
  const calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
  const marker = /\{\s*"name"\s*:\s*"/g;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(content))) {
    const start = match.index;
    let depth = 0;
    let end = -1;
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') {
        depth++;
      } else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      break;
    }
    marker.lastIndex = end + 1;

    try {
      const parsed = JSON.parse(content.slice(start, end + 1));
      if (parsed && typeof parsed.name === 'string' && toolNames.has(parsed.name) && parsed.arguments) {
        calls.push({
          id: `fallback-${calls.length}`,
          type: 'function',
          function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments) },
        });
      }
    } catch {
      // Not a complete/valid JSON object — skip it.
    }
  }

  return calls;
}

/**
 * Dispatches a single tool call to its implementation, wrapping it with the user's before/after
 * hooks (if any) and Headroom compression (if enabled). This is the one place tool-execution
 * logic lives, called identically by the main agent loop and by every subagent — so hooks and
 * Headroom "just work" for subagents without any separate wiring.
 */
export async function executeToolCall(name: string, rawArgs: any, ctx: ToolContext): Promise<string> {
  const before = await runBeforeHook(ctx.hooks, name, rawArgs);
  if ('blocked' in before) {
    return `Blocked by beforeToolCall hook: ${before.blocked}`;
  }
  const args = before.args;

  let result: string;
  switch (name) {
    case 'run_terminal_command': {
      const attachedMatch = matchAttachedFile(args.command, ctx.filesByName);
      if (attachedMatch !== undefined) {
        ctx.stream.progress('Using already-attached file content instead of running a command…');
        result = attachedMatch;
      } else {
        ctx.stream.progress(`Running: ${args.command}`);
        result = await runTerminalCommand(args.command);
        if (ctx.headroomEnabled) {
          result = await compressToolResult(
            `run_terminal_command:${args.command}`,
            result,
            ctx.headroomBaseUrl,
            ctx.headroomMinChars,
            ctx.headroomMemory
          );
        }
      }
      break;
    }
    case 'read_file':
      ctx.stream.progress(`Reading ${args.path}…`);
      result = await readFileTool(args.path).catch((err: any) => `Error: ${err.message}`);
      if (ctx.headroomEnabled) {
        result = await compressToolResult(`read_file:${args.path}`, result, ctx.headroomBaseUrl, ctx.headroomMinChars, ctx.headroomMemory);
      }
      break;
    case 'write_file':
      ctx.stream.progress(`Writing ${args.path}…`);
      result = await writeFileTool(args.path, args.content, !!args.overwrite).catch((err: any) => `Error: ${err.message}`);
      break;
    case 'edit_file':
      ctx.stream.progress(`Editing ${args.path}…`);
      result = await editFileTool(args.path, args.old_string, args.new_string).catch((err: any) => `Error: ${err.message}`);
      break;
    case 'list_directory':
      ctx.stream.progress(`Listing ${args.path}…`);
      result = await listDirectoryTool(args.path).catch((err: any) => `Error: ${err.message}`);
      break;
    case 'search_workspace':
      ctx.stream.progress(`Searching for "${args.query}"…`);
      result = await searchWorkspaceTool(args.query, !!args.isRegex).catch((err: any) => `Error: ${err.message}`);
      if (ctx.headroomEnabled) {
        result = await compressToolResult(`search_workspace:${args.query}`, result, ctx.headroomBaseUrl, ctx.headroomMinChars, ctx.headroomMemory);
      }
      break;
    case 'headroom_retrieve': {
      const original = ctx.headroomMemory.get(args.key);
      result = original !== undefined ? original : `Error: no cached content found for key "${args.key}".`;
      break;
    }
    case 'spawn_subagent': {
      if (!ctx.subagentsEnabled || !ctx.runSubagent || ctx.depth > 0) {
        result = 'Error: subagents are disabled, or this was called from within a subagent (nesting is not allowed).';
      } else {
        result = await ctx.runSubagent(args.task, ctx);
      }
      break;
    }
    default:
      result = `Unknown tool: ${name}`;
  }

  return runAfterHook(ctx.hooks, name, args, result);
}
