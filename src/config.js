import os from 'node:os';
import path from 'node:path';

export const TOOL_NAME = 'codex-acct';

export function codexHome() {
  const override = process.env.CODEX_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.codex');
}

export function authFilePath() {
  return path.join(codexHome(), 'auth.json');
}

export function configFilePath() {
  return path.join(codexHome(), 'config.toml');
}

export function accountsDir() {
  return path.join(codexHome(), 'accounts');
}

export function indexFilePath() {
  return path.join(accountsDir(), 'index.json');
}

export function snapshotFilePath(alias) {
  return path.join(accountsDir(), `${alias}.auth.json`);
}
