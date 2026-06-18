import test from 'node:test';
import assert from 'node:assert/strict';

import { codexProcessNamesToTerminate } from '../src/codex.js';

test('codexProcessNamesToTerminate does not include macOS desktop app by default', () => {
  assert.deepEqual(codexProcessNamesToTerminate({ platform: 'darwin' }), ['codex']);
});

test('codexProcessNamesToTerminate can include macOS desktop app explicitly', () => {
  assert.deepEqual(codexProcessNamesToTerminate({ platform: 'darwin', includeDesktop: true }), ['codex', 'Codex']);
});

test('codexProcessNamesToTerminate uses Windows executable name', () => {
  assert.deepEqual(codexProcessNamesToTerminate({ platform: 'win32', includeDesktop: true }), ['codex.exe']);
});
