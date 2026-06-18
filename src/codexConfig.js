import fs from 'node:fs';

import { configFilePath } from './config.js';
import { atomicWriteFile, fileExists } from './fsx.js';

const SERVICE_TIER_DEFAULT_RE = /^(\s*service_tier\s*=\s*)"default"([^\S\r\n]*(?:#.*)?)$/gm;

function issue(code, message) {
  return { code, message };
}

export function inspectCodexConfig({ file = configFilePath() } = {}) {
  if (!fileExists(file)) {
    return { file, exists: false, issues: [] };
  }

  const text = fs.readFileSync(file, 'utf8');
  const issues = [];
  if (SERVICE_TIER_DEFAULT_RE.test(text)) {
    issues.push(
      issue(
        'invalid-service-tier-default',
        'Codex no longer accepts service_tier = "default"; use "flex" or "fast".',
      ),
    );
  }
  SERVICE_TIER_DEFAULT_RE.lastIndex = 0;
  return { file, exists: true, issues };
}

export function repairCodexConfig({ file = configFilePath(), serviceTier = 'flex' } = {}) {
  const before = inspectCodexConfig({ file });
  if (!before.exists || before.issues.length === 0) {
    return { ...before, changed: false };
  }

  const text = fs.readFileSync(file, 'utf8');
  const repaired = text.replace(SERVICE_TIER_DEFAULT_RE, `$1"${serviceTier}"$2`);
  SERVICE_TIER_DEFAULT_RE.lastIndex = 0;
  if (repaired === text) {
    return { ...before, changed: false };
  }

  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {}
  atomicWriteFile(file, repaired, { mode });
  return { file, exists: true, issues: before.issues, changed: true };
}
