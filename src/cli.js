import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { UserError } from './errors.js';
import { fileExists, readJsonFile } from './fsx.js';
import { identityFromAuth } from './jwt.js';
import { loadIndex, saveIndex } from './store.js';
import { isCodexRunning, runCodexLogin } from './codex.js';
import { paint, printTable, humanizeExp } from './ui.js';
import { pickFromList } from './pick.js';
import { fetchAllAccountLimitStatuses } from './limits.js';
import { inspectCodexConfig, repairCodexConfig } from './codexConfig.js';
import {
  activeIdentity,
  aliasFromEmail,
  listAccounts,
  preserveActiveAccount,
  readActiveAuth,
  registerAccount,
  removeAccount,
  renameAccount,
  switchTo,
  uniqueAlias,
  validateAlias,
} from './accounts.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  json: { type: 'boolean' },
  force: { type: 'boolean', short: 'f' },
  'from-current': { type: 'boolean' },
  import: { type: 'string' },
  refresh: { type: 'boolean' },
  'kill-codex': { type: 'boolean' },
  'keep-current': { type: 'boolean' },
  fix: { type: 'boolean' },
};

function printHelp() {
  console.log(`codex-acct — switch between OpenAI Codex accounts by swapping ~/.codex/auth.json

Usage
  codex-acct                          open the interactive account picker
  codex-acct use <alias|email|#>      switch the active account
  codex-acct use --kill-codex <alias> kill Codex, then switch the active account
  codex-acct ls                       list saved accounts
  codex-acct limits                   show Codex 5h/weekly limit status
  codex-acct who                      show the active account
  codex-acct doctor                   check Codex config for known issues
  codex-acct doctor --fix             repair known Codex config issues
  codex-acct menubar                  launch the macOS menu bar app
  codex-acct add [alias]              log in to a new account and save it
  codex-acct add --keep-current [alias]
                                      save a new account, then restore the previous active account
  codex-acct add --from-current [alias]
                                      save the account you are already logged in as
  codex-acct add --import <file> [alias]
                                      save an account from an exported auth.json
  codex-acct rename <old> <new>       rename a saved account
  codex-acct remove <alias>           delete a saved account
  codex-acct default [alias]          show or set the default account

Options
  --json          machine-readable output (ls, who)
  --refresh       refresh OAuth tokens before reading limits
  --kill-codex    terminate Codex before switching
  --keep-current  after add, restore the account that was active before login
  --fix           repair known Codex config issues (doctor)
  --force, -f      override safety refusals (remove the active account)
  --help, -h       show this help
  --version        print version

Notes
  Account switching swaps only auth.json — sessions, memories and skills stay shared.
  Known-invalid Codex config values may be repaired; approval/sandbox settings are not forced.
  Codex reads auth.json at startup; restart Codex (or the IDE extension) after switching.
  Set CODEX_HOME for a non-default Codex home; set CODEX_BIN if \`codex\` is not on PATH.`);
}

function repairCodexConfigIfNeeded() {
  const result = repairCodexConfig();
  if (result.changed) {
    process.stderr.write(
      `${paint('gray', `repaired ${result.file}: service_tier "default" -> "flex"`)}\n`,
    );
  }
  return result;
}

function resolveTarget(target) {
  const accounts = listAccounts();
  if (target === 'default') {
    const index = loadIndex();
    if (!index.default) throw new UserError('no default account is set');
    return index.default;
  }
  if (/^\d+$/.test(target)) {
    const position = Number(target) - 1;
    if (position < 0 || position >= accounts.length) {
      throw new UserError(`no account at position ${target}`);
    }
    return accounts[position].alias;
  }
  const byAlias = accounts.find((account) => account.alias === target);
  if (byAlias) return byAlias.alias;
  if (target.includes('@')) {
    const matches = accounts.filter((account) => account.email === target);
    if (matches.length === 1) return matches[0].alias;
    if (matches.length > 1) throw new UserError(`multiple accounts use ${target}; specify an alias`);
  }
  throw new UserError(`unknown account '${target}'`);
}

function describe(identity) {
  return `${identity.email ?? 'api-key'}, ${identity.plan}`;
}

function announcePreserved(preserved) {
  if (preserved?.created) {
    console.log(paint('gray', `saved current account as '${preserved.alias}' before switching`));
  }
}

function warnRestart() {
  const running = isCodexRunning();
  if (running === true) {
    console.log(paint('yellow', 'Codex appears to be running — restart it for the switch to take effect.'));
  } else {
    console.log(paint('gray', 'Restart Codex (or the IDE extension) for the switch to take effect.'));
  }
}

function announceTerminated(terminated) {
  const killed = (terminated || []).reduce((sum, item) => sum + (Number(item.killed) || 0), 0);
  if (killed > 0) {
    console.log(paint('gray', `terminated ${killed} Codex process${killed === 1 ? '' : 'es'} before switching`));
  }
}

function reportAdded(alias, identity, duplicateOf) {
  console.log(`${paint('green', 'saved')} ${paint('bold', alias)} (${describe(identity)})`);
  if (duplicateOf) {
    console.log(paint('yellow', `note: this is the same account as '${duplicateOf}' (same account id)`));
  }
}

function renderPickRow(row, _index, focused) {
  const marker = row.isActive ? '*' : ' ';
  const alias = row.alias.padEnd(16);
  const email = (row.email ?? '—').padEnd(28);
  const plan = (row.plan ?? '—').padEnd(8);
  const label = `${marker} ${alias} ${email} ${plan} ${humanizeExp(row.idTokenExp)}`;
  return focused ? paint('inverse', `› ${label}`) : `  ${label}`;
}

async function cmdPick() {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    console.log('no saved accounts yet. Save the current login with: codex-acct add --from-current');
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printTable(accounts);
    process.stderr.write('not a TTY; pick an account with: codex-acct use <alias>\n');
    return 1;
  }
  const activeIndex = Math.max(0, accounts.findIndex((account) => account.isActive));
  console.log(paint('gray', 'select an account  (↑/↓ move · enter switch · esc cancel)'));
  const chosen = await pickFromList(accounts, { activeIndex, render: renderPickRow });
  if (!chosen) {
    console.log(paint('gray', 'cancelled'));
    return 0;
  }
  repairCodexConfigIfNeeded();
  const { identity, preserved } = switchTo(chosen.alias);
  announcePreserved(preserved);
  console.log(`${paint('green', 'switched to')} ${paint('bold', chosen.alias)} (${describe(identity)})`);
  warnRestart();
  return 0;
}

async function cmdUse(args, values) {
  const target = args[0];
  if (!target) return cmdPick();
  const alias = resolveTarget(target);
  repairCodexConfigIfNeeded();
  const { identity, preserved, terminated } = switchTo(alias, { killCodex: Boolean(values['kill-codex']) });
  announceTerminated(terminated);
  announcePreserved(preserved);
  console.log(`${paint('green', 'switched to')} ${paint('bold', alias)} (${describe(identity)})`);
  warnRestart();
  return 0;
}

function cmdList(values) {
  const accounts = listAccounts();
  if (values.json) {
    console.log(JSON.stringify(accounts, null, 2));
    return 0;
  }
  if (accounts.length === 0) {
    console.log('no saved accounts yet. Save the current login with: codex-acct add --from-current');
    return 0;
  }
  printTable(accounts);
  return 0;
}

function cmdWho(values) {
  const active = activeIdentity();
  if (values.json) {
    console.log(JSON.stringify(active, null, 2));
    return active ? 0 : 1;
  }
  if (!active) {
    console.log('not logged in (no ~/.codex/auth.json)');
    return 1;
  }
  const match = listAccounts().find(
    (account) => account.accountId && active.accountId && account.accountId === active.accountId,
  );
  const label = match ? paint('bold', match.alias) : paint('gray', '(unsaved)');
  console.log(`${label}  ${active.email ?? 'api-key'}  ${active.plan}  (id-token ${humanizeExp(active.idTokenExp)})`);
  return 0;
}

function formatWindow(window) {
  if (!window || typeof window.remainingPercent !== 'number') return '—';
  const reset = window.resetsAt ? `, resets ${humanizeExp(window.resetsAt, Date.now(), { maxUnits: 2 })}` : '';
  return `${Math.round(window.remainingPercent)}% left${reset}`;
}

function printLimitsTable(rows) {
  const columns = [
    { title: '', get: (row) => (row.isActive ? '*' : '') },
    { title: 'ALIAS', get: (row) => row.alias },
    { title: 'EMAIL', get: (row) => row.email ?? '—' },
    { title: 'PLAN', get: (row) => row.plan ?? '—' },
    { title: '5H', get: (row) => (row.error ? `error: ${row.error}` : formatWindow(row.windows.fiveHour)) },
    { title: 'WEEKLY', get: (row) => (row.error ? '—' : formatWindow(row.windows.weekly)) },
  ];
  const widths = columns.map((column) =>
    Math.max(column.title.length, ...rows.map((row) => String(column.get(row)).length)),
  );
  console.log(paint('dim', columns.map((column, i) => String(column.title).padEnd(widths[i])).join('  ')));
  for (const row of rows) {
    const line = columns.map((column, i) => String(column.get(row)).padEnd(widths[i])).join('  ');
    console.log(row.isActive ? paint('green', line) : line);
  }
}

async function cmdLimits(values) {
  const rows = await fetchAllAccountLimitStatuses({ forceRefresh: Boolean(values.refresh) });
  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log('no saved accounts yet. Save the current login with: codex-acct add --from-current');
    return 0;
  }
  printLimitsTable(rows);
  return rows.some((row) => row.error) ? 1 : 0;
}

async function cmdMenubar() {
  if (process.platform !== 'darwin') {
    throw new UserError('the menu bar app is only supported on macOS');
  }
  repairCodexConfigIfNeeded();
  const require = createRequire(import.meta.url);
  let electronBin;
  try {
    electronBin = require('electron');
  } catch {
    throw new UserError('Electron is not installed. Run `npm install` from the project, then `codex-acct menubar`.');
  }
  const appPath = fileURLToPath(new URL('./menubar.js', import.meta.url));
  const child = spawn(electronBin, [appPath], { stdio: 'inherit', env: process.env });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(paint('red', `error: failed to launch Electron: ${err.message}\n`));
      resolve(1);
    });
  });
}

async function cmdAdd(args, values) {
  if (values.import) {
    const file = path.resolve(values.import);
    if (!fileExists(file)) throw new UserError(`file not found: ${file}`);
    const identitySource = identityFromAuth(readJsonFile(file));
    const alias = args[0] || uniqueAlias(aliasFromEmail(identitySource.email), loadIndex());
    validateAlias(alias);
    const { identity, duplicateOf } = registerAccount(alias, { sourceFile: file });
    reportAdded(alias, identity, duplicateOf);
    return 0;
  }

  if (values['from-current']) {
    const auth = readActiveAuth();
    if (!auth) throw new UserError('not logged in; nothing to save. Run `codex login` first, or use plain `add`.');
    const identitySource = identityFromAuth(auth);
    const alias = args[0] || uniqueAlias(aliasFromEmail(identitySource.email), loadIndex());
    validateAlias(alias);
    const { identity, duplicateOf } = registerAccount(alias, { authData: auth });
    reportAdded(alias, identity, duplicateOf);
    return 0;
  }

  repairCodexConfigIfNeeded();
  const preserved = preserveActiveAccount();
  if (preserved?.created) {
    console.log(paint('gray', `saved current account as '${preserved.alias}' before login`));
  }
  console.log(paint('gray', 'launching `codex login` …'));
  const result = runCodexLogin();
  if (!result.ok && result.reason === 'not-found') {
    throw new UserError(
      `could not find the \`codex\` binary (tried '${result.bin}'). Set CODEX_BIN, or save the current login with: codex-acct add --from-current`,
    );
  }
  if (!result.ok) throw new UserError(`\`codex login\` exited with status ${result.status}`);

  const auth = readActiveAuth();
  if (!auth) throw new UserError('login finished but no auth.json was written');
  const identitySource = identityFromAuth(auth);
  const alias = args[0] || uniqueAlias(aliasFromEmail(identitySource.email), loadIndex());
  validateAlias(alias);
  const { identity, duplicateOf } = registerAccount(alias, { authData: auth });
  reportAdded(alias, identity, duplicateOf);
  if (values['keep-current'] && preserved?.alias) {
    const { identity: restoredIdentity } = switchTo(preserved.alias);
    console.log(
      paint(
        'gray',
        `restored active account to '${preserved.alias}' (${describe(restoredIdentity)})`,
      ),
    );
  }
  return 0;
}

function cmdDoctor(values) {
  const result = values.fix ? repairCodexConfig() : inspectCodexConfig();
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.issues.length === 0 || result.changed ? 0 : 1;
  }

  if (!result.exists) {
    console.log(`Codex config not found: ${result.file}`);
    return 0;
  }
  if (result.issues.length === 0) {
    console.log(`Codex config OK: ${result.file}`);
    return 0;
  }

  for (const item of result.issues) {
    console.log(`${paint('yellow', item.code)}  ${item.message}`);
  }
  if (values.fix) {
    console.log(
      result.changed
        ? `Repaired Codex config: ${result.file}`
        : `No repair applied: ${result.file}`,
    );
    return result.changed ? 0 : 1;
  }

  console.log('Run `codex-acct doctor --fix` to repair known issues.');
  return 1;
}

function cmdRemove(args, values) {
  const alias = args[0];
  if (!alias) throw new UserError('usage: codex-acct remove <alias>');
  removeAccount(alias, { force: Boolean(values.force) });
  console.log(`removed '${alias}'`);
  return 0;
}

function cmdRename(args) {
  const [oldAlias, newAlias] = args;
  if (!oldAlias || !newAlias) throw new UserError('usage: codex-acct rename <old> <new>');
  renameAccount(oldAlias, newAlias);
  console.log(`renamed '${oldAlias}' → '${newAlias}'`);
  return 0;
}

function cmdDefault(args) {
  const alias = args[0];
  const index = loadIndex();
  if (!alias) {
    console.log(index.default ?? '(none)');
    return 0;
  }
  if (!index.accounts[alias]) throw new UserError(`unknown account '${alias}'`);
  index.default = alias;
  saveIndex(index);
  console.log(`default → '${alias}'`);
  return 0;
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: false, options: OPTIONS });
  } catch (err) {
    process.stderr.write(paint('red', `error: ${err.message}\n`));
    return 1;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    console.log(pkg.version);
    return 0;
  }
  const command = positionals[0];
  if (values.help || command === 'help') {
    printHelp();
    return 0;
  }

  try {
    switch (command) {
      case undefined:
      case 'pick':
        return await cmdPick();
      case 'use':
      case 'switch':
        return await cmdUse(positionals.slice(1), values);
      case 'ls':
      case 'list':
        return cmdList(values);
      case 'limits':
      case 'usage':
        return await cmdLimits(values);
      case 'who':
      case 'current':
        return cmdWho(values);
      case 'doctor':
      case 'check':
        return cmdDoctor(values);
      case 'menubar':
      case 'menu-bar':
        return await cmdMenubar();
      case 'add':
        return await cmdAdd(positionals.slice(1), values);
      case 'remove':
      case 'rm':
        return cmdRemove(positionals.slice(1), values);
      case 'rename':
      case 'mv':
        return cmdRename(positionals.slice(1));
      case 'default':
        return cmdDefault(positionals.slice(1));
      default:
        process.stderr.write(paint('red', `unknown command '${command}'\n\n`));
        printHelp();
        return 1;
    }
  } catch (err) {
    if (err instanceof UserError) {
      process.stderr.write(paint('red', `error: ${err.message}\n`));
      return 1;
    }
    throw err;
  }
}
