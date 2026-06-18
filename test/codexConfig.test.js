import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectCodexConfig, repairCodexConfig } from '../src/codexConfig.js';

function withTempConfig(contents, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acct-config-test-'));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, contents);
  try {
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('inspectCodexConfig detects invalid default service tier', () => {
  withTempConfig('model = "gpt-5.5"\nservice_tier = "default"\n', (file) => {
    const result = inspectCodexConfig({ file });
    assert.equal(result.exists, true);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, 'invalid-service-tier-default');
  });
});

test('repairCodexConfig replaces default service tier with flex', () => {
  withTempConfig('model = "gpt-5.5"\nservice_tier = "default" # old\n', (file) => {
    const result = repairCodexConfig({ file });
    assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'model = "gpt-5.5"\nservice_tier = "flex" # old\n');
    assert.equal(inspectCodexConfig({ file }).issues.length, 0);
  });
});

test('repairCodexConfig leaves valid service tiers unchanged', () => {
  withTempConfig('service_tier = "flex"\n', (file) => {
    const result = repairCodexConfig({ file });
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'service_tier = "flex"\n');
  });
});
