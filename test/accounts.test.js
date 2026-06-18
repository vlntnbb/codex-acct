import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { authFilePath, codexHome } from '../src/config.js';
import { readJsonFile } from '../src/fsx.js';
import {
  aliasFromEmail,
  listAccounts,
  prepareCodexForSwitch,
  registerAccount,
  removeAccount,
  renameAccount,
  sanitizeAlias,
  switchTo,
  uniqueAlias,
} from '../src/accounts.js';
import { loadIndex } from '../src/store.js';
import { makeChatgptAuth } from './helpers.js';

function withTempHome(run) {
  const previous = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acct-test-'));
  process.env.CODEX_HOME = dir;
  try {
    fs.mkdirSync(codexHome(), { recursive: true });
    return run(dir);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeActive(auth) {
  fs.writeFileSync(authFilePath(), JSON.stringify(auth, null, 2));
}

test('aliasFromEmail sanitizes plus-addressed locals', () => {
  assert.equal(aliasFromEmail('you+work@example.com'), 'you-work');
  assert.equal(aliasFromEmail('me@gmail.com'), 'me');
});

test('sanitizeAlias strips unsafe characters', () => {
  assert.equal(sanitizeAlias('  Work Account! '), 'work-account');
});

test('uniqueAlias avoids collisions', () => {
  const index = { accounts: { work: {}, 'work-2': {} } };
  assert.equal(uniqueAlias('work', index), 'work-3');
  assert.equal(uniqueAlias('fresh', index), 'fresh');
});

test('register, list and detect the active account', () => {
  withTempHome(() => {
    const authA = makeChatgptAuth({ email: 'a@x.io', accountId: 'acc-a' });
    writeActive(authA);
    const { duplicateOf } = registerAccount('work', { authData: authA });
    assert.equal(duplicateOf, null);

    const accounts = listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].alias, 'work');
    assert.equal(accounts[0].isActive, true);
    assert.equal(accounts[0].isDefault, true);
    assert.equal(accounts[0].plan, 'pro');
  });
});

test('switchTo swaps auth.json and preserves the previous account', () => {
  withTempHome(() => {
    const authA = makeChatgptAuth({ email: 'a@x.io', accountId: 'acc-a' });
    const authB = makeChatgptAuth({ email: 'b@x.io', accountId: 'acc-b' });
    writeActive(authA);
    registerAccount('work', { authData: authA });
    registerAccount('home', { authData: authB });

    const { identity, preserved } = switchTo('home');
    assert.equal(identity.accountId, 'acc-b');
    assert.equal(preserved.alias, 'work');
    assert.equal(preserved.created, false);

    const live = readJsonFile(authFilePath());
    assert.equal(live.tokens.account_id, 'acc-b');

    const active = listAccounts().find((a) => a.isActive);
    assert.equal(active.alias, 'home');
  });
});

test('switching away from an unsaved account preserves it automatically', () => {
  withTempHome(() => {
    const saved = makeChatgptAuth({ email: 'saved@x.io', accountId: 'acc-saved' });
    const unsaved = makeChatgptAuth({ email: 'fresh@x.io', accountId: 'acc-fresh' });
    registerAccount('saved', { authData: saved });
    writeActive(unsaved);

    const { preserved } = switchTo('saved');
    assert.equal(preserved.created, true);
    assert.equal(preserved.alias, 'fresh');

    const aliases = listAccounts().map((a) => a.alias).sort();
    assert.deepEqual(aliases, ['fresh', 'saved']);
  });
});

test('prepareCodexForSwitch gracefully quits Desktop before terminating codex processes', () => {
  const events = [];
  const result = prepareCodexForSwitch(
    { killCodex: true, killCodexDesktop: true, restartCodexDesktop: true },
    {
      quitDesktop() {
        events.push('quit-desktop');
        return { wasRunning: true, exited: true };
      },
      terminateProcesses(options) {
        events.push(`terminate:${options.includeDesktop}`);
        return [{ name: 'codex', killed: 1 }];
      },
    },
  );

  assert.deepEqual(events, ['quit-desktop', 'terminate:false']);
  assert.equal(result.desktopQuit.wasRunning, true);
  assert.equal(result.terminated[0].killed, 1);
});

test('prepareCodexForSwitch cancels switching when Desktop does not quit cleanly', () => {
  const events = [];

  assert.throws(
    () =>
      prepareCodexForSwitch(
        { killCodex: true, restartCodexDesktop: true },
        {
          quitDesktop() {
            events.push('quit-desktop');
            return { wasRunning: true, exited: false };
          },
          terminateProcesses() {
            events.push('terminate');
            return [];
          },
        },
      ),
    /did not quit cleanly/,
  );

  assert.deepEqual(events, ['quit-desktop']);
});

test('registerAccount flags duplicate account ids', () => {
  withTempHome(() => {
    const auth = makeChatgptAuth({ email: 'a@x.io', accountId: 'acc-a' });
    registerAccount('work', { authData: auth });
    const { duplicateOf } = registerAccount('clone', { authData: auth });
    assert.equal(duplicateOf, 'work');
  });
});

test('rename moves snapshot and fixes the default pointer', () => {
  withTempHome(() => {
    const auth = makeChatgptAuth({ email: 'a@x.io', accountId: 'acc-a' });
    registerAccount('work', { authData: auth });
    renameAccount('work', 'main');

    const index = loadIndex();
    assert.ok(index.accounts.main);
    assert.equal(index.accounts.work, undefined);
    assert.equal(index.default, 'main');
  });
});

test('remove refuses the active account without force', () => {
  withTempHome(() => {
    const auth = makeChatgptAuth({ email: 'a@x.io', accountId: 'acc-a' });
    writeActive(auth);
    registerAccount('work', { authData: auth });

    assert.throws(() => removeAccount('work'), /active account/);
    removeAccount('work', { force: true });
    assert.equal(listAccounts().length, 0);
  });
});
