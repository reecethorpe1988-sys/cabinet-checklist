// agent.js — the Claudius agent loop: Claude decides, tools act, guardrails
// check every action, and the transcript is append-only.
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, executeTool } from './tools.js';
import { systemPrompt } from './prompt.js';

export const MODEL = process.env.CLAUDIUS_MODEL || 'claude-opus-5-5';
const MAX_TURNS = 60;

export function createAgent({ config, toolCtx, client = new Anthropic({ maxRetries: 4 }), onEvent = () => {} }) {
  const system = systemPrompt(config);
  const messages = [];

  async function step() {
    return client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Re-run on Anthropic's recommended model if a safety classifier declines.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      // Caches the stable tools + system prompt + transcript prefix between turns.
      cache_control: { type: 'ephemeral' },
      system,
      tools: TOOLS,
      messages,
    });
  }

  // Send one user message and loop until Claudius finishes its turn.
  async function send(text) {
    messages.push({ role: 'user', content: text });
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await step();
      messages.push({ role: 'assistant', content: response.content });
      onEvent({ type: 'usage', usage: response.usage });

      for (const block of response.content) {
        if (block.type === 'text' && response.stop_reason === 'tool_use') onEvent({ type: 'thought', text: block.text });
      }

      if (response.stop_reason === 'refusal') {
        return { text: 'Claudius declined this request.', stopReason: 'refusal' };
      }
      if (response.stop_reason === 'pause_turn') continue;
      if (response.stop_reason === 'max_tokens') {
        messages.push({ role: 'user', content: 'You hit the output limit. Continue from where you stopped, more concisely.' });
        continue;
      }
      if (response.stop_reason !== 'tool_use') {
        const finalText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        return { text: finalText, stopReason: response.stop_reason };
      }

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      const results = await Promise.all(toolUses.map(async (tu) => {
        onEvent({ type: 'tool', name: tu.name, input: tu.input });
        try {
          const out = await executeTool(tu.name, tu.input, toolCtx);
          const isError = Boolean(out && out.error);
          onEvent({ type: 'tool_result', name: tu.name, isError, output: out });
          return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out), is_error: isError };
        } catch (err) {
          onEvent({ type: 'tool_result', name: tu.name, isError: true, output: err.message });
          return { type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true };
        }
      }));
      messages.push({ role: 'user', content: results });
    }
    return { text: `Stopped after ${MAX_TURNS} steps without finishing.`, stopReason: 'turn_limit' };
  }

  return { send, messages };
}
