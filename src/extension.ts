import * as vscode from 'vscode';
import { callOllama, callOllamaStream, OllamaMessage } from './ollamaClient';
import { compressWithHeadroom } from './headroom';
import { loadHooks } from './hooks';
import { loadCommands, expandCommand, formatCommandList } from './commands';
import { buildToolsForRequest, executeToolCall, extractFakeToolCalls, ToolContext } from './tools';
import { runSubagent, SubagentConfig } from './subagent';

const SYSTEM_PROMPT_BASE =
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
  'prose description or plan of the edit instead of calling the tool.';

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

export function activate(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    const config = vscode.workspace.getConfiguration('localAgent');
    // Defaults live in package.json's configuration schema; config.get() falls back to those when unset.
    const model = config.get<string>('model')!;
    const baseUrl = config.get<string>('baseUrl')!;
    const maxTurns = config.get<number>('maxTurns')!;
    const streaming = config.get<boolean>('streaming')!;
    const numCtx = config.get<number>('numCtx')!;
    const headroomEnabled = config.get<boolean>('headroomEnabled')!;
    const headroomBaseUrl = config.get<string>('headroomBaseUrl')!;
    const headroomMinChars = config.get<number>('headroomMinCharsToCompress')!;
    const subagentsEnabled = config.get<boolean>('subagentsEnabled')!;
    const subagentMaxTurns = config.get<number>('subagentMaxTurns')!;

    // Re-loaded every turn (cheap: a small folder listing + one require()) so edits to
    // .localagent/commands/*.md or .localagent/hooks.js take effect without reloading the window.
    const commands = await loadCommands();
    const hooks = await loadHooks(stream);

    const trimmedPrompt = request.prompt.trim();
    if (trimmedPrompt === '/commands') {
      stream.markdown(formatCommandList(commands));
      return;
    }
    const expandedPrompt = expandCommand(trimmedPrompt, commands);

    const toolsForRequest = buildToolsForRequest({ headroomEnabled, subagentsEnabled, depth: 0 });
    const toolNames = new Set(toolsForRequest.map((t) => t.function.name));
    // Full originals of tool results Headroom compressed this request; headroom_retrieve reads from here.
    const headroomMemory = new Map<string, string>();

    let systemPrompt = SYSTEM_PROMPT_BASE;
    if (headroomEnabled) {
      systemPrompt +=
        ' Large tool outputs may come back compressed with a note like "call headroom_retrieve ' +
        'with key ..." — use that tool if you need the full original content.';
    }
    if (subagentsEnabled) {
      systemPrompt +=
        ' You can delegate a well-defined, self-contained subtask to spawn_subagent instead of doing ' +
        'every step yourself — useful for offloading exploratory or mechanical work so it does not ' +
        'fill up your own context with intermediate steps. The subagent cannot spawn further subagents.';
    }

    const messages: OllamaMessage[] = [{ role: 'system', content: systemPrompt }];

    // Replay this chat session's history so the model has context across turns.
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push({ role: 'user', content: turn.prompt });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ''))
          .join('');
        if (text) {
          messages.push({ role: 'assistant', content: text });
        }
      }
    }

    const { contextText: attachedContext, filesByName } = await resolveAttachedReferences(request.references);
    if (attachedContext) {
      messages.push({ role: 'user', content: `Attached context:\n\n${attachedContext}` });
    }

    messages.push({ role: 'user', content: expandedPrompt });

    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    const subagentConfig: SubagentConfig = { model, baseUrl, numCtx, maxTurns: subagentMaxTurns };
    const toolCtx: ToolContext = {
      stream,
      headroomEnabled,
      headroomBaseUrl,
      headroomMinChars,
      headroomMemory,
      filesByName,
      hooks,
      depth: 0,
      subagentsEnabled,
      runSubagent: (task, ctx) => runSubagent(task, ctx, subagentConfig),
    };

    for (let turn = 0; turn < maxTurns; turn++) {
      if (token.isCancellationRequested) {
        return;
      }

      stream.progress(turn === 0 ? 'Thinking…' : 'Continuing…');

      const messagesToSend = headroomEnabled ? await compressWithHeadroom(messages, headroomBaseUrl, stream) : messages;

      let msg;
      try {
        msg = streaming
          ? await callOllamaStream(
              baseUrl,
              model,
              messagesToSend,
              numCtx,
              toolsForRequest,
              (delta) => stream.markdown(delta),
              abortController.signal
            )
          : await callOllama(baseUrl, model, messagesToSend, numCtx, toolsForRequest);
      } catch (err: any) {
        if (abortController.signal.aborted) {
          return;
        }
        stream.markdown(
          `⚠️ Couldn't reach Ollama at \`${baseUrl}\`. Is \`ollama serve\` running?\n\n` + '```\n' + err.message + '\n```'
        );
        return;
      }

      // Recover tool calls the model wrote as plain-text JSON instead of using the real tool_calls field.
      if ((!msg.tool_calls || msg.tool_calls.length === 0) && msg.content) {
        const recovered = extractFakeToolCalls(msg.content, toolNames);
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

        const result = await executeToolCall(call.function.name, args, toolCtx);
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
