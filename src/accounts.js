import { authFilePath, snapshotFilePath } from './config.js';
import { copyFileAtomic, fileExists, readJsonFile } from './fsx.js';
import { identityFromAuth } from './jwt.js';
import { UserError } from './errors.js';
import { openCodexDesktop, quitCodexDesktopGracefully, terminateCodexProcesses } from './codex.js';
import {
  deleteSnapshot,
  loadIndex,
  readSnapshot,
  saveIndex,
  snapshotExists,
  writeSnapshotFromData,
  writeSnapshotFromFile,
} from './store.js';

function nowIso() {
  return new Date().toISOString();
}

export function sanitizeAlias(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
}

export function aliasFromEmail(email) {
  if (!email) return 'account';
  const local = email.split('@')[0] || 'account';
  return sanitizeAlias(local) || 'account';
}

export function validateAlias(alias) {
  if (!alias || !/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(alias)) {
    throw new UserError(`invalid alias '${alias}'. Use letters, digits, dot, dash or underscore.`);
  }
}

export function uniqueAlias(base, index) {
  const root = base || 'account';
  if (!index.accounts[root]) return root;
  let suffix = 2;
  while (index.accounts[`${root}-${suffix}`]) suffix += 1;
  return `${root}-${suffix}`;
}

export function readActiveAuth() {
  if (!fileExists(authFilePath())) return null;
  return readJsonFile(authFilePath());
}

export function activeIdentity() {
  const auth = readActiveAuth();
  if (!auth) return null;
  try {
    return identityFromAuth(auth);
  } catch {
    return null;
  }
}

function findAliasByAccountId(index, accountId) {
  if (!accountId) return null;
  const entry = Object.entries(index.accounts).find(([, meta]) => meta.accountId === accountId);
  return entry ? entry[0] : null;
}

export function registerAccount(alias, { authData, sourceFile }) {
  const auth = authData ?? readJsonFile(sourceFile);
  const identity = identityFromAuth(auth);
  const index = loadIndex();
  const duplicateOf = Object.entries(index.accounts).find(
    ([existingAlias, meta]) =>
      existingAlias !== alias && meta.accountId && identity.accountId && meta.accountId === identity.accountId,
  );

  if (sourceFile) writeSnapshotFromFile(alias, sourceFile);
  else writeSnapshotFromData(alias, auth);

  const previous = index.accounts[alias];
  index.accounts[alias] = {
    email: identity.email,
    name: identity.name,
    plan: identity.plan,
    accountId: identity.accountId,
    addedAt: previous?.addedAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  if (!index.default) index.default = alias;
  saveIndex(index);

  return { identity, duplicateOf: duplicateOf ? duplicateOf[0] : null };
}

export function preserveActiveAccount() {
  const auth = readActiveAuth();
  if (!auth) return null;
  let identity;
  try {
    identity = identityFromAuth(auth);
  } catch {
    return null;
  }

  const index = loadIndex();
  const matched = findAliasByAccountId(index, identity.accountId);
  if (matched) {
    writeSnapshotFromData(matched, auth);
    index.accounts[matched].updatedAt = nowIso();
    saveIndex(index);
    return { alias: matched, created: false };
  }

  const alias = uniqueAlias(aliasFromEmail(identity.email), index);
  const { identity: registered } = registerAccount(alias, { authData: auth });
  return { alias, created: true, identity: registered };
}

export function switchTo(
  alias,
  { killCodex = false, killCodexDesktop = false, restartCodexDesktop = false } = {},
) {
  const index = loadIndex();
  if (!index.accounts[alias]) throw new UserError(`unknown account '${alias}'`);
  if (!snapshotExists(alias)) {
    throw new UserError(`snapshot for '${alias}' is missing; re-add it with \`codex-acct add\``);
  }
  const { terminated, desktopQuit } = prepareCodexForSwitch({
    killCodex,
    killCodexDesktop,
    restartCodexDesktop,
  });
  const preserved = preserveActiveAccount();
  copyFileAtomic(snapshotFilePath(alias), authFilePath(), { mode: 0o600 });
  const identity = identityFromAuth(readSnapshot(alias));
  const desktopOpen = desktopQuit?.wasRunning ? openCodexDesktop() : null;
  return { identity, preserved, terminated, desktopQuit, desktopOpen };
}

export function prepareCodexForSwitch(
  { killCodex = false, killCodexDesktop = false, restartCodexDesktop = false } = {},
  {
    quitDesktop = quitCodexDesktopGracefully,
    terminateProcesses = terminateCodexProcesses,
  } = {},
) {
  let desktopQuit = null;
  if (restartCodexDesktop) {
    desktopQuit = quitDesktop();
    if (desktopQuit?.wasRunning && !desktopQuit.exited) {
      throw new UserError('Codex Desktop did not quit cleanly; account switch was cancelled');
    }
  }

  const terminated = killCodex
    ? terminateProcesses({ includeDesktop: killCodexDesktop && !restartCodexDesktop })
    : null;

  return { terminated, desktopQuit };
}

export function removeAccount(alias, { force = false } = {}) {
  const index = loadIndex();
  const meta = index.accounts[alias];
  if (!meta) throw new UserError(`unknown account '${alias}'`);

  const active = activeIdentity();
  const isActive = Boolean(active && active.accountId && meta.accountId && active.accountId === meta.accountId);
  if (isActive && !force) {
    throw new UserError(
      `'${alias}' is the active account; removing its snapshot loses the latest refreshed tokens. Use --force to remove anyway.`,
    );
  }

  deleteSnapshot(alias);
  delete index.accounts[alias];
  if (index.default === alias) {
    index.default = Object.keys(index.accounts)[0] ?? null;
  }
  saveIndex(index);
}

export function renameAccount(oldAlias, newAlias) {
  validateAlias(newAlias);
  const index = loadIndex();
  if (!index.accounts[oldAlias]) throw new UserError(`unknown account '${oldAlias}'`);
  if (index.accounts[newAlias]) throw new UserError(`'${newAlias}' already exists`);

  writeSnapshotFromFile(newAlias, snapshotFilePath(oldAlias));
  deleteSnapshot(oldAlias);
  index.accounts[newAlias] = index.accounts[oldAlias];
  delete index.accounts[oldAlias];
  if (index.default === oldAlias) index.default = newAlias;
  saveIndex(index);
}

export function listAccounts() {
  const index = loadIndex();
  const active = activeIdentity();
  return Object.keys(index.accounts)
    .sort()
    .map((alias) => {
      const meta = index.accounts[alias];
      let identity = null;
      try {
        identity = identityFromAuth(readSnapshot(alias));
      } catch {}
      const accountId = identity?.accountId ?? meta.accountId;
      return {
        alias,
        email: identity?.email ?? meta.email,
        name: identity?.name ?? meta.name,
        plan: identity?.plan ?? meta.plan,
        org: identity?.org ?? null,
        idTokenExp: identity?.idTokenExp ?? null,
        subscriptionEndsAt: identity?.subscriptionEndsAt ?? null,
        accountId,
        isDefault: index.default === alias,
        isActive: Boolean(active && active.accountId && accountId && active.accountId === accountId),
      };
    });
}
