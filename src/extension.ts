import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

const TOOLS = [
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

/**
 * Non-streaming call to Ollama's OpenAI-compatible endpoint. More verbose in the UI than
 * streaming, but some models/Ollama versions only return tool_calls reliably when stream:false.
 */
async function callOllama(baseUrl: string, model: string, messages: OllamaMessage[], numCtx: number): Promise<OllamaMessage & { tool_calls?: any[] }> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: TOOLS, stream: false, options: { num_ctx: numCtx } }),
  });

  if (!res.ok) {
    throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  }

  const data: any = await res.json();
  return data.choices[0].message as OllamaMessage & { tool_calls?: any[] };
}

/** Streams Ollama's OpenAI-compatible endpoint, invoking onDelta with each content fragment as it arrives. */
async function callOllamaStream(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  numCtx: number,
  onDelta: (text: string) => void,
  signal: AbortSignal
): Promise<OllamaMessage & { tool_calls?: any[] }> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: TOOLS, stream: true, options: { num_ctx: numCtx } }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  }

  let content = '';
  const toolCalls: any[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let lineEnd: number;
    while ((lineEnd = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload === '[DONE]' || !payload) {
        continue;
      }

      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) {
        continue;
      }

      if (delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      // Tool call arguments stream in as fragments keyed by index and must be concatenated.
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = (toolCalls[tc.index] ??= {
            id: tc.id,
            type: 'function',
            function: { name: '', arguments: '' },
          });
          if (tc.id) {
            existing.id = tc.id;
          }
          if (tc.function?.name) {
            existing.function.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            existing.function.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  return {
    role: 'assistant',
    content: content || null,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
}

/** Read the files/selections attached via the chat "+" picker and render them as context blocks. */
async function resolveAttachedReferences(
  references: readonly vscode.ChatPromptReference[]
): Promise<{ contextText: string; filesByName: Map<string, string> }> {
  const blocks: string[] = [];
  const filesByName = new Map<string, string>();

  for (const ref of references) {
    const value = ref.value;
    let uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
    if (!uri) {
      continue;
    }
    // Notebook cell URIs aren't directly readable; the cell's path segment is the parent .ipynb file.
    if (uri.scheme === 'vscode-notebook-cell') {
      uri = uri.with({ scheme: 'file', fragment: '' });
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      let text = Buffer.from(bytes).toString('utf8');
      if (value instanceof vscode.Location) {
        const lines = text.split('\n');
        text = lines.slice(value.range.start.line, value.range.end.line + 1).join('\n');
      }
      const relPath = vscode.workspace.asRelativePath(uri);
      blocks.push(`File: ${relPath}\n\`\`\`\n${text}\n\`\`\``);
      filesByName.set(relPath.toLowerCase(), text);
      filesByName.set(uri.path.split('/').pop()!.toLowerCase(), text);
    } catch {
      // Unreadable reference (e.g. non-file resource) — skip it.
    }
  }

  return { contextText: blocks.join('\n\n'), filesByName };
}

/** If a shell command is just re-reading a file we already have attached content for, skip the shell entirely. */
function matchAttachedFile(command: string, filesByName: Map<string, string>): string | undefined {
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
async function runToolCall(command: string): Promise<string> {
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

const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

/** Some models emit `{"name": ..., "arguments": {...}}` as plain text instead of a real tool_calls entry; recover those. */
function extractFakeToolCalls(content: string): { id: string; type: 'function'; function: { name: string; arguments: string } }[] {
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
      if (parsed && typeof parsed.name === 'string' && TOOL_NAMES.has(parsed.name) && parsed.arguments) {
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

export function activate(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    const config = vscode.workspace.getConfiguration('localAgent');
    // Defaults live in package.json's configuration schema; config.get() falls back to those when unset.
    const model = config.get<string>('model')!;
    const baseUrl = config.get<string>('baseUrl')!;
    const maxTurns = config.get<number>('maxTurns')!;
    const streaming = config.get<boolean>('streaming')!;
    const numCtx = config.get<number>('numCtx')!;

    const messages: OllamaMessage[] = [
      {
        role: 'system',
        content:
          "You are a local coding assistant running entirely on the user's machine via Ollama. " +
          'If the user message includes an "Attached context" block, that already contains the ' +
          'full contents of the file(s) they mean — read and answer from it directly, do not call ' +
          'a tool to re-read a file that is already attached. ' +
          'Use read_file, list_directory, and search_workspace to inspect the workspace, instead of ' +
          'shelling out with cat/sed/Get-Content. For any change to an EXISTING file, always use ' +
          'edit_file with the exact old_string to replace — never use write_file on a file that ' +
          'already exists, since regenerating a whole file risks dropping content you did not mean ' +
          'to touch. Only use write_file to create a file that does not exist yet. Only use ' +
          'run_terminal_command for actions the other tools cannot do (e.g. running tests or builds). ' +
          'Prefer read-only actions unless the user has explicitly asked you to change something. ' +
          'When the user asks you to create, edit, update, or fix something, you MUST call the ' +
          'appropriate tool in the same turn you decide on the change — never respond with only a ' +
          'prose description or plan of the edit instead of calling the tool.',
      },
    ];

    // Replay this chat session's history so the model has context across turns.
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push({ role: 'user', content: turn.prompt });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .map((part) =>
            part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ''
          )
          .join('');
        if (text) {
          messages.push({ role: 'assistant', content: text });
        }
      }
    }

    const { contextText: attachedContext, filesByName } = await resolveAttachedReferences(
      request.references
    );
    if (attachedContext) {
      messages.push({
        role: 'user',
        content: `Attached context:\n\n${attachedContext}`,
      });
    }

    messages.push({ role: 'user', content: request.prompt });

    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    for (let turn = 0; turn < maxTurns; turn++) {
      if (token.isCancellationRequested) {
        return;
      }

      stream.progress(turn === 0 ? 'Thinking…' : 'Continuing…');

      let msg;
      try {
        msg = streaming
          ? await callOllamaStream(baseUrl, model, messages, numCtx, (delta) => stream.markdown(delta), abortController.signal)
          : await callOllama(baseUrl, model, messages, numCtx);
      } catch (err: any) {
        if (abortController.signal.aborted) {
          return;
        }
        stream.markdown(
          `⚠️ Couldn't reach Ollama at \`${baseUrl}\`. Is \`ollama serve\` running?\n\n` +
            '```\n' + err.message + '\n```'
        );
        return;
      }

      // Recover tool calls the model wrote as plain-text JSON instead of using the real tool_calls field.
      if ((!msg.tool_calls || msg.tool_calls.length === 0) && msg.content) {
        const recovered = extractFakeToolCalls(msg.content);
        if (recovered.length) {
          stream.progress('Model described a tool call as text instead of calling it — recovering and running it…');
          msg.tool_calls = recovered;
        }
      }

      messages.push(msg);

      // No tool call -> the model is giving its final answer for this turn.
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (!streaming) {
          stream.markdown(msg.content ?? '');
        }
        return;
      }

      for (const call of msg.tool_calls) {
        let args: any;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: invalid tool arguments.' });
          continue;
        }

        let result: string;
        switch (call.function.name) {
          case 'run_terminal_command': {
            const attachedMatch = matchAttachedFile(args.command, filesByName);
            if (attachedMatch !== undefined) {
              stream.progress('Using already-attached file content instead of running a command…');
              result = attachedMatch;
            } else {
              stream.progress(`Running: ${args.command}`);
              result = await runToolCall(args.command);
            }
            break;
          }
          case 'read_file':
            stream.progress(`Reading ${args.path}…`);
            result = await readFileTool(args.path).catch((err: any) => `Error: ${err.message}`);
            break;
          case 'write_file':
            stream.progress(`Writing ${args.path}…`);
            result = await writeFileTool(args.path, args.content, !!args.overwrite).catch(
              (err: any) => `Error: ${err.message}`
            );
            break;
          case 'edit_file':
            stream.progress(`Editing ${args.path}…`);
            result = await editFileTool(args.path, args.old_string, args.new_string).catch(
              (err: any) => `Error: ${err.message}`
            );
            break;
          case 'list_directory':
            stream.progress(`Listing ${args.path}…`);
            result = await listDirectoryTool(args.path).catch((err: any) => `Error: ${err.message}`);
            break;
          case 'search_workspace':
            stream.progress(`Searching for "${args.query}"…`);
            result = await searchWorkspaceTool(args.query, !!args.isRegex).catch((err: any) => `Error: ${err.message}`);
            break;
          default:
            result = `Unknown tool: ${call.function.name}`;
        }

        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }

    stream.markdown('_Hit the turn cap without a final answer — stopping._');
  };

  const participant = vscode.chat.createChatParticipant('local-harness.agent', handler);
  participant.iconPath = new vscode.ThemeIcon('robot');

  context.subscriptions.push(participant);
}

export function deactivate() {}