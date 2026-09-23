import * as vscode from 'vscode';
import { compress } from 'headroom-ai';
import { OllamaMessage } from './ollamaClient';

// Probed once per extension-host session so an unreachable proxy only warns the user a single time.
let headroomProxyChecked = false;

async function checkHeadroomProxy(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${baseUrl}/livez`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/** Compresses the running conversation via the local Headroom proxy; no-ops (returns messages unchanged) if it's unreachable. */
export async function compressWithHeadroom(
  messages: OllamaMessage[],
  baseUrl: string,
  stream: vscode.ChatResponseStream
): Promise<OllamaMessage[]> {
  if (!headroomProxyChecked) {
    headroomProxyChecked = true;
    if (!(await checkHeadroomProxy(baseUrl))) {
      stream.markdown(
        `⚠️ \`localAgent.headroomEnabled\` is on but the Headroom proxy at \`${baseUrl}\` isn't reachable — ` +
          'continuing without compression. See heardoom_server/README.md to start it.\n\n'
      );
    }
  }

  try {
    const result = await compress(messages, { baseUrl, fallback: true });
    if (result.compressed && result.tokensSaved > 0) {
      stream.progress(`Headroom compressed context: ${result.tokensBefore} → ${result.tokensAfter} tokens (saved ${result.tokensSaved}).`);
    }
    return result.messages as OllamaMessage[];
  } catch {
    return messages;
  }
}

/**
 * Compresses a single large tool result via Headroom and remembers the original in `memory` so
 * the model can pull it back later with the headroom_retrieve tool.
 */
export async function compressToolResult(
  key: string,
  result: string,
  baseUrl: string,
  minChars: number,
  memory: Map<string, string>
): Promise<string> {
  if (result.length < minChars) {
    return result;
  }

  try {
    const single = await compress([{ role: 'tool', content: result, tool_call_id: 'headroom-cache' }], {
      baseUrl,
      fallback: true,
    });
    const compressedContent = single.messages[0]?.content;
    if (typeof compressedContent === 'string' && single.compressed && compressedContent.length < result.length) {
      memory.set(key, result);
      return `${compressedContent}\n\n(Compressed by Headroom — call headroom_retrieve with key "${key}" for the full original content.)`;
    }
  } catch {
    // Fall through and return the original, uncompressed result.
  }

  return result;
}
