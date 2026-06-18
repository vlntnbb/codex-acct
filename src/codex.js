import { spawnSync } from 'node:child_process';

const CODEX_DESKTOP_APP_NAME = 'Codex';
const CODEX_DESKTOP_PROCESS_NAME = 'Codex';

export function codexBinary() {
  return process.env.CODEX_BIN || 'codex';
}

function loginArgs(extraArgs) {
  const hasServiceTierOverride = extraArgs.some((arg, index) => {
    if (arg === '-c' || arg === '--config') return extraArgs[index + 1]?.startsWith('service_tier=');
    return arg.startsWith('service_tier=') || arg.startsWith('service_tier.');
  });
  return hasServiceTierOverride ? ['login', ...extraArgs] : ['login', '-c', 'service_tier=flex', ...extraArgs];
}

export function runCodexLogin(extraArgs = []) {
  const bin = codexBinary();
  const result = spawnSync(bin, loginArgs(extraArgs), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error && result.error.code === 'ENOENT') {
    return { ok: false, reason: 'not-found', bin };
  }
  if (result.error) {
    return { ok: false, reason: 'spawn-failed', bin, error: result.error };
  }
  return { ok: result.status === 0, status: result.status, bin };
}

export function isCodexRunning() {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq codex.exe', '/NH'], { encoding: 'utf8' });
      if (out.status !== 0 || typeof out.stdout !== 'string') return null;
      return /codex\.exe/i.test(out.stdout);
    }
    const out = spawnSync('pgrep', ['-x', 'codex'], { encoding: 'utf8' });
    if (out.error) return null;
    return out.status === 0 && Boolean(out.stdout && out.stdout.trim());
  } catch {
    return null;
  }
}

export function isCodexDesktopRunning() {
  if (process.platform !== 'darwin') return false;
  try {
    const out = spawnSync('pgrep', ['-x', CODEX_DESKTOP_PROCESS_NAME], { encoding: 'utf8' });
    if (out.error) return null;
    return out.status === 0 && Boolean(out.stdout && out.stdout.trim());
  } catch {
    return null;
  }
}

function pidLinesForExactName(name) {
  const out = spawnSync('pgrep', ['-x', name], { encoding: 'utf8' });
  if (out.error || out.status !== 0 || typeof out.stdout !== 'string') return [];
  return out.stdout
    .split(/\s+/)
    .map((pid) => pid.trim())
    .filter(Boolean);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pids, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(pidAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(50);
    alive = pids.filter(pidAlive);
  }
  return alive;
}

export function quitCodexDesktopGracefully({ timeoutMs = 15000 } = {}) {
  if (process.platform !== 'darwin') {
    return { supported: false, wasRunning: false, quitRequested: false, exited: true };
  }

  const pids = pidLinesForExactName(CODEX_DESKTOP_PROCESS_NAME);
  if (pids.length === 0) {
    return { supported: true, wasRunning: false, quitRequested: false, exited: true };
  }

  const result = spawnSync(
    'osascript',
    ['-e', `tell application ${JSON.stringify(CODEX_DESKTOP_APP_NAME)} to quit`],
    { encoding: 'utf8' },
  );
  if (result.error) {
    return {
      supported: true,
      wasRunning: true,
      quitRequested: false,
      exited: false,
      error: result.error.message,
    };
  }

  const alive = waitForExit(pids, timeoutMs);
  return {
    supported: true,
    wasRunning: true,
    quitRequested: true,
    exited: alive.length === 0,
    stillRunning: alive.length,
    status: result.status,
    stderr: result.stderr || '',
  };
}

export function openCodexDesktop() {
  if (process.platform !== 'darwin') {
    return { supported: false, opened: false };
  }
  const result = spawnSync('open', ['-a', CODEX_DESKTOP_APP_NAME], { encoding: 'utf8' });
  if (result.error) {
    return { supported: true, opened: false, error: result.error.message };
  }
  return {
    supported: true,
    opened: result.status === 0,
    status: result.status,
    stderr: result.stderr || '',
  };
}

function killUnixProcessName(name, signal = 'TERM') {
  const pids = pidLinesForExactName(name);
  if (pids.length === 0) return { name, killed: 0 };
  const result = spawnSync('kill', [`-${signal}`, ...pids], { encoding: 'utf8' });
  let alive = waitForExit(pids);
  let forced = 0;
  if (alive.length > 0 && signal !== 'KILL') {
    spawnSync('kill', ['-KILL', ...alive], { encoding: 'utf8' });
    forced = alive.length;
    alive = waitForExit(alive, 1000);
  }
  return {
    name,
    killed: pids.length,
    forced,
    stillRunning: alive.length,
    status: result.status,
    error: result.error ? result.error.message : null,
  };
}

function killWindowsProcessName(imageName) {
  const result = spawnSync('taskkill', ['/IM', imageName, '/T', '/F'], { encoding: 'utf8' });
  if (result.error) return { name: imageName, killed: null, error: result.error.message };
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const killed = (output.match(/SUCCESS:/gi) || []).length;
  return { name: imageName, killed, status: result.status };
}

export function codexProcessNamesToTerminate({ platform = process.platform, includeDesktop = false } = {}) {
  if (platform === 'win32') {
    return ['codex.exe'];
  }

  const names = ['codex'];
  if (platform === 'darwin' && includeDesktop) {
    names.push(CODEX_DESKTOP_PROCESS_NAME);
  }
  return names;
}

export function terminateCodexProcesses({ includeDesktop = false } = {}) {
  const names = codexProcessNamesToTerminate({ includeDesktop });
  if (process.platform === 'win32') {
    return names.map(killWindowsProcessName);
  }
  return names.map((name) => killUnixProcessName(name));
}
