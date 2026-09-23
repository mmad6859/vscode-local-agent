export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

/**
 * Non-streaming call to Ollama's OpenAI-compatible endpoint. More verbose in the UI than
 * streaming, but some models/Ollama versions only return tool_calls reliably when stream:false.
 */
export async function callOllama(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  numCtx: number,
  tools: any[]
): Promise<OllamaMessage & { tool_calls?: any[] }> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false, options: { num_ctx: numCtx } }),
  });

  if (!res.ok) {
    throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  }

  const data: any = await res.json();
  return data.choices[0].message as OllamaMessage & { tool_calls?: any[] };
}

/** Streams Ollama's OpenAI-compatible endpoint, invoking onDelta with each content fragment as it arrives. */
export async function callOllamaStream(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  numCtx: number,
  tools: any[],
  onDelta: (text: string) => void,
  signal: AbortSignal
): Promise<OllamaMessage & { tool_calls?: any[] }> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: true, options: { num_ctx: numCtx } }),
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
