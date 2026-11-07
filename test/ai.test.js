import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENROUTER_API_KEY = '';
process.env.ANTHROPIC_API_KEY = 'sk-or-v1-test-key';
process.env.LLM_MODEL = 'https://openrouter.ai/anthropic/claude-sonnet-5.5';
delete process.env.LLM_PROVIDER;
delete process.env.LLM_URL;

const { cfg } = await import('../src/config.js');
const { llmRaw } = await import('../src/ai.js');

test('detects OpenRouter credentials and extracts the model from a model URL', () => {
  assert.equal(cfg.llm.provider, 'openrouter');
  assert.equal(cfg.llm.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(cfg.llm.url, 'https://openrouter.ai/api/v1/chat/completions');
});

test('sends OpenRouter chat/tool requests and normalizes tool-use responses', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, ...options };
    return {
      ok: true,
      json: async () => ({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: 'Checking that now.',
            tool_calls: [{
              id: 'call-1',
              function: {
                name: 'get_status',
                arguments: '{"status":"paid"}',
              },
            }],
          },
        }],
      }),
    };
  };
  try {
    const result = await llmRaw({
      system: 'Use the tool for facts.',
      messages: [{ role: 'user', content: 'Check the payout.' }],
      tools: [{
        name: 'get_status',
        description: 'Read payout status.',
        input_schema: { type: 'object', properties: { status: { type: 'string' } } },
      }],
    });
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer sk-or-v1-test-key');
    const sent = JSON.parse(request.body);
    assert.equal(sent.model, 'anthropic/claude-sonnet-5.5');
    assert.deepEqual(sent.messages.map(message => message.role), ['system', 'user']);
    assert.equal(sent.tools[0].function.name, 'get_status');
    assert.equal(result.stop_reason, 'tool_use');
    assert.equal(result.content[0].text, 'Checking that now.');
    assert.deepEqual(result.content[1].input, { status: 'paid' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
