import { callOllama, OllamaMessage } from './ollamaClient';
import { buildToolsForRequest, executeToolCall, extractFakeToolCalls, ToolContext } from './tools';

export interface SubagentConfig {
  model: string;
  baseUrl: string;
  numCtx: number;
  maxTurns: number;
}

const SUBAGENT_SYSTEM_PROMPT =
  "You are a focused subagent handling one delegated subtask on the user's local machine via Ollama. " +
  'You have your own tools (read_file, list_directory, search_workspace, run_terminal_command, write_file, ' +
  'edit_file) but cannot spawn further subagents. Complete the task and give a clear, self-contained final ' +
  'answer — the agent that delegated this to you will only see your final text response, never your ' +
  'intermediate tool calls, so make sure that final answer actually contains what it needs.';

/**
 * Runs a nested, depth-limited tool-calling loop for a single delegated subtask. Shares the
 * parent's approval prompts, hooks, and Headroom settings (via executeToolCall, the same function
 * the main loop uses) but starts with its own fresh message history — the subagent has no
 * visibility into the parent conversation beyond the task string it was given. Returns only the
 * subagent's final text answer; its intermediate tool calls never reach the parent's context.
 */
export async function runSubagent(task: string, parentCtx: ToolContext, cfg: SubagentConfig): Promise<string> {
  const ctx: ToolContext = { ...parentCtx, depth: parentCtx.depth + 1, filesByName: new Map(), subagentsEnabled: false };
  const toolsForRequest = buildToolsForRequest({ headroomEnabled: ctx.headroomEnabled, subagentsEnabled: false, depth: ctx.depth });
  const toolNames = new Set(toolsForRequest.map((t) => t.function.name));

  const messages: OllamaMessage[] = [
    { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];

  parentCtx.stream.progress(`Subagent working on: ${task.length > 80 ? `${task.slice(0, 80)}…` : task}`);

  for (let turn = 0; turn < cfg.maxTurns; turn++) {
    let msg;
    try {
      msg = await callOllama(cfg.baseUrl, cfg.model, messages, cfg.numCtx, toolsForRequest);
    } catch (err: any) {
      return `Subagent failed to reach Ollama: ${err.message}`;
    }

    if ((!msg.tool_calls || msg.tool_calls.length === 0) && msg.content) {
      const recovered = extractFakeToolCalls(msg.content, toolNames);
      if (recovered.length) {
        msg.tool_calls = recovered;
      }
    }

    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content ?? '(subagent returned no content)';
    }

    for (const call of msg.tool_calls) {
      let args: any;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: invalid tool arguments.' });
        continue;
      }
      const result = await executeToolCall(call.function.name, args, ctx);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  return '_Subagent hit its turn cap without a final answer._';
}
