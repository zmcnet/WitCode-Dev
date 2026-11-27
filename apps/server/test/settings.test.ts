import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../src/settings.ts';

const fallback = {
  theme: 'dark' as const,
  sendKey: 'enter' as const,
  reasoningDisplay: true,
  fontScale: 1,
  replyLanguage: 'auto' as const,
  maxSteps: 20,
  projectMemory: true,
  subagentMaxDepth: 3,
  subagentMaxPerSession: 3,
  subagentBrainId: 'coding',
};

test('normalizeSettings：空值/脏值回落到默认', () => {
  assert.deepEqual(normalizeSettings(null), fallback);
  assert.deepEqual(normalizeSettings({ theme: 'neon', maxSteps: 'abc' }, fallback), fallback);
});

test('normalizeSettings：枚举、步数与子智能体限制被约束', () => {
  const settings = normalizeSettings({
    theme: 'light',
    sendKey: 'ctrl-enter',
    replyLanguage: 'en',
    maxSteps: 999,
    subagentMaxDepth: 9,
    subagentMaxPerSession: 0,
    subagentBrainId: '  standard  ',
  });
  assert.equal(settings.theme, 'light');
  assert.equal(settings.sendKey, 'ctrl-enter');
  assert.equal(settings.replyLanguage, 'en');
  assert.equal(settings.maxSteps, 100);
  assert.equal(settings.subagentMaxDepth, 3);
  assert.equal(settings.subagentMaxPerSession, 1);
  assert.equal(settings.subagentBrainId, 'standard');
});

test('normalizeSettings：布尔字段只接受布尔值', () => {
  const settings = normalizeSettings({ reasoningDisplay: 'no', projectMemory: 0 }, fallback);
  assert.equal(settings.reasoningDisplay, true);
  assert.equal(settings.projectMemory, true);
});
