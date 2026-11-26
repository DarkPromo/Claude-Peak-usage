import { expect, test } from 'claude-code/testing'

const usage = (tokens: number) => ({ input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 });

// The window is 200,000, so the soft threshold is 130,000 and the hard one 170,000.
function engine(on: any) {
  let tokens = 0;
  on('command.register', () => ({ value: { command: 'peak-usage' } }));
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
  on('session.usage', () => ({ value: { context: { window: 200_000, tokens } } }));
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }));
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: usage(tokens) };
  });
  on('tool.call', () => ({ result: {} }));
  return (n: number) => { tokens = n; };
}

async function turn($: any, id: string) {
  await $.turn.start({ text: 'go', turnId: id });
  for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'm', messageCount: 1 })) { /* drain */ }
  return JSON.stringify(await $.tool.call({ tool: 'Read', file_path: '/x' }));
}

const start = ($: any) => $.session.start({ cwd: '/', surface: null, isInteractive: false });

test('desktop session nudges at the soft threshold, then only again at the hard one', async ($, on) => {
  const setTokens = engine(on);
  await start($);

  setTokens(40_000);
  expect(await turn($, 't1')).not.toContain('Peak Usage:');
  setTokens(135_000);
  expect(await turn($, 't2')).toContain('save a handoff with the peak-compact skill');
  setTokens(140_000);
  expect(await turn($, 't3')).not.toContain('Peak Usage:');
  setTokens(175_000);
  expect(await turn($, 't4')).toContain('Peak Usage:');
  setTokens(180_000);
  expect(await turn($, 't5')).not.toContain('Peak Usage:');
});

test('a session that starts large is measured from where it started', async ($, on) => {
  const setTokens = engine(on);
  await start($);
  setTokens(150_000);
  expect(await turn($, 't1')).not.toContain('Peak Usage:');
  setTokens(170_000);
  expect(await turn($, 't2')).toContain('Peak Usage:');
});

test('autostart off waits for /peak-usage start', { options: { autostart: 'off' } }, async ($, on) => {
  const setTokens = engine(on);
  await start($);
  setTokens(40_000);
  await turn($, 't1');
  setTokens(175_000);
  expect(await turn($, 't2')).not.toContain('Peak Usage:');
});
