// agent.js — the Iris agent loop. Same shape as Claudius's: Claude decides,
// tools act, guardrails check, and the transcript is append-only.
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, executeTool } from './tools.js';
import { systemPrompt } from './prompt.js';

export const MODEL = process.env.IRIS_MODEL || 'claude-opus-5-5';
const MAX_TURNS = 60;

export function createAgent({ config, toolCtx, client = new Anthropic({ maxRetries: 4 }), onEvent = () => {} }) {
  const system = systemPrompt(config);
  const messages = [];

  const step = () => client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    cache_control: { type: 'ephemeral' },
    system,
    tools: TOOLS,
    messages,
  });

  async function runTool(tu) {
    onEvent({ type: 'tool', name: tu.name, input: tu.input });
    try {
      const out = await executeTool(tu.name, tu.input, toolCtx);
      const isError = Boolean(out?.error);
      onEvent({ type: 'tool_result', name: tu.name, isError, output: out });
      // Photo tools return content blocks so Claude can see the image.
      const content = out?.blocks ?? JSON.stringify(out);
      return { type: 'tool_result', tool_use_id: tu.id, content, is_error: isError };
    } catch (err) {
      onEvent({ type: 'tool_result', name: tu.name, isError: true, output: err.message });
      return { type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true };
    }
  }

  async function send(text) {
    messages.push({ role: 'user', content: text });
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await step();
      messages.push({ role: 'assistant', content: response.content });
      onEvent({ type: 'usage', usage: response.usage });

      if (response.stop_reason === 'refusal') return { text: 'Iris declined this request.', stopReason: 'refusal' };
      if (response.stop_reason === 'pause_turn') continue;
      if (response.stop_reason === 'max_tokens') {
        messages.push({ role: 'user', content: 'You hit the output limit. Continue from where you stopped, more concisely.' });
        continue;
      }
      if (response.stop_reason !== 'tool_use') {
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        return { text, stopReason: response.stop_reason };
      }
      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      // Sequential: queue_post calls must see each other's slots.
      const results = [];
      for (const tu of toolUses) results.push(await runTool(tu));
      messages.push({ role: 'user', content: results });
    }
    return { text: `Stopped after ${MAX_TURNS} steps without finishing.`, stopReason: 'turn_limit' };
  }

  return { send, messages };
}
