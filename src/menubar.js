import { app, dialog, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { preserveActiveAccount, switchTo } from './accounts.js';
import { isCodexDesktopRunning } from './codex.js';
import { accountsDir, indexFilePath } from './config.js';
import { repairCodexConfig } from './codexConfig.js';
import { fetchAllAccountLimitStatuses } from './limits.js';
import { humanizeExp } from './ui.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const BLINK_INTERVAL_MS = 5 * 60 * 1000;
const BLINK_STEP_MS = 350;
const USAGE_SETTINGS_URL = 'https://chatgpt.com/codex/settings/usage';
const CLI_BIN = fileURLToPath(new URL('../bin/codex-acct.js', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ICON_COLORS = {
  green: '#46e6a4',
  yellow: '#f6c343',
  red: '#ef4444',
  neutral: '#8b949e',
};

let tray = null;
let statuses = [];
let refreshing = false;
let switchingAlias = null;
let lastError = null;
let refreshTimer = null;
let accountWatcher = null;
let blinkInterval = null;
let blinkTimer = null;
let blinking = false;
let currentIconColor = ICON_COLORS.neutral;
let currentShouldBlink = false;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * width * 4;
    const targetStart = y * (width * 4 + 1);
    scanlines[targetStart] = 0;
    rgba.copy(scanlines, targetStart + 1, sourceStart, sourceStart + width * 4);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND'),
  ]);
}

function hexToRgb(hex) {
  const normalized = hex.replace('#', '');
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function roundedRectContains(px, py, x, y, width, height, radius) {
  const left = x + radius;
  const right = x + width - radius;
  const top = y + radius;
  const bottom = y + height - radius;
  if (px >= left && px <= right && py >= y && py <= y + height) return true;
  if (py >= top && py <= bottom && px >= x && px <= x + width) return true;

  const cx = px < left ? left : right;
  const cy = py < top ? top : bottom;
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
}

function drawRoundedRect(rgba, imageWidth, scale, rect, color, opacity) {
  const x = rect.x * scale;
  const y = rect.y * scale;
  const width = rect.width * scale;
  const height = rect.height * scale;
  const radius = rect.radius * scale;
  const alpha = Math.round(255 * opacity);
  for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
    for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) {
      if (!roundedRectContains(px + 0.5, py + 0.5, x, y, width, height, radius)) continue;
      const offset = (py * imageWidth + px) * 4;
      rgba[offset] = color.r;
      rgba[offset + 1] = color.g;
      rgba[offset + 2] = color.b;
      rgba[offset + 3] = alpha;
    }
  }
}

function trayIcon(color = ICON_COLORS.neutral, opacity = 1) {
  const scale = 2;
  const width = 22 * scale;
  const height = 22 * scale;
  const rgba = Buffer.alloc(width * height * 4);
  const rgb = hexToRgb(color);
  const rects = [
    { x: 4, y: 10, width: 4.8, height: 8, radius: 1.4 },
    { x: 10, y: 7, width: 4.8, height: 11, radius: 1.4 },
    { x: 16, y: 4, width: 4.8, height: 14, radius: 1.4 },
  ];
  for (const rect of rects) drawRoundedRect(rgba, width, scale, rect, rgb, opacity);

  const image = nativeImage.createFromBuffer(encodePng(width, height, rgba), { scaleFactor: scale });
  image.setTemplateImage(false);
  return image;
}

function percent(window) {
  if (!window || typeof window.remainingPercent !== 'number') return null;
  return Math.round(window.remainingPercent);
}

function bar(window) {
  const value = percent(window);
  if (value === null) return '[----------] --';
  const filled = Math.max(0, Math.min(10, Math.round(value / 10)));
  return `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}] ${value}% left`;
}

function durationLabel(window) {
  const mins = window?.windowDurationMins;
  if (!mins) return 'window';
  if (mins % (7 * 24 * 60) === 0) return `${mins / (7 * 24 * 60)}w`;
  if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function resetLabel(window) {
  return window?.resetsAt ? `resets ${humanizeExp(window.resetsAt, Date.now(), { maxUnits: 2 })}` : 'reset unknown';
}

function infoItem(label) {
  return { label, enabled: true };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function terminalCommand(command) {
  const child = spawn(
    'osascript',
    [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(command)}`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

function addAnotherAccount() {
  const env = process.env.CODEX_HOME ? `CODEX_HOME=${shellQuote(process.env.CODEX_HOME)} ` : '';
  terminalCommand(
    [
      `cd ${shellQuote(PROJECT_ROOT)}`,
      `${env}/usr/bin/env node ${shellQuote(CLI_BIN)} add --keep-current`,
      'echo',
      'echo "codex-acct: account flow finished. You can close this Terminal tab."',
    ].join(' && '),
  );
}

async function saveCurrentLogin() {
  try {
    const result = preserveActiveAccount();
    if (!result) {
      dialog.showErrorBox('codex-acct', 'No active Codex login found. Run `codex login` or use "Add another account...".');
      return;
    }
    new Notification({
      title: 'codex-acct',
      body: result.created
        ? `Saved current login as ${result.alias}`
        : `Updated saved login ${result.alias}`,
    }).show();
    await refreshStatuses({ notify: false });
  } catch (err) {
    dialog.showErrorBox('codex-acct', err instanceof Error ? err.message : String(err));
  }
}

function statusSummary(status) {
  if (status.error) return 'error';
  const fiveHour = percent(status.windows.fiveHour);
  const weekly = percent(status.windows.weekly);
  const primary = percent(status.windows.primary);
  const parts = [];
  if (fiveHour !== null) parts.push(`5h ${fiveHour}%`);
  if (weekly !== null) parts.push(`W${weekly}%`);
  if (fiveHour === null && primary !== null) parts.push(`${durationLabel(status.windows.primary)} ${primary}%`);
  return parts.join(' ') || 'limits n/a';
}

function activeStatus() {
  return statuses.find((status) => status.isActive) || null;
}

function iconColorForStatus(status) {
  const weekly = percent(status?.windows.weekly);
  if (weekly === null) return ICON_COLORS.neutral;
  if (weekly >= 50) return ICON_COLORS.green;
  if (weekly >= 25) return ICON_COLORS.yellow;
  return ICON_COLORS.red;
}

function shouldBlinkStatus(status) {
  const weekly = percent(status?.windows.weekly);
  return weekly !== null && weekly < 10;
}

function blinkIconOnce() {
  if (!tray || !currentShouldBlink || blinking) return;
  blinking = true;
  let step = 0;
  const tick = () => {
    if (!tray || !currentShouldBlink) {
      blinking = false;
      return;
    }
    const visible = step % 2 === 0;
    tray.setImage(trayIcon(currentIconColor, visible ? 1 : 0.16));
    step += 1;
    if (step < 8) {
      blinkTimer = setTimeout(tick, BLINK_STEP_MS);
      blinkTimer.unref?.();
      return;
    }
    blinking = false;
    tray.setImage(trayIcon(currentIconColor));
  };
  tick();
}

function configureBlinking(shouldBlink) {
  currentShouldBlink = shouldBlink;
  if (!shouldBlink) {
    clearInterval(blinkInterval);
    clearTimeout(blinkTimer);
    blinkInterval = null;
    blinkTimer = null;
    blinking = false;
    return;
  }
  if (!blinkInterval) {
    blinkInterval = setInterval(blinkIconOnce, BLINK_INTERVAL_MS);
    blinkInterval.unref?.();
  }
}

function updateTrayAppearance() {
  if (!tray) return;
  const active = activeStatus();
  currentIconColor = iconColorForStatus(active);
  tray.setTitle('');
  if (!blinking) tray.setImage(trayIcon(currentIconColor));
  configureBlinking(shouldBlinkStatus(active));
}

function windowItems(status) {
  if (status.error) {
    return [infoItem(`Error: ${status.error}`)];
  }

  const items = [
    infoItem(`5h: ${bar(status.windows.fiveHour)}`),
    infoItem(`Weekly: ${bar(status.windows.weekly)}`),
  ];

  if (!status.windows.fiveHour && status.windows.primary) {
    items.push(infoItem(`Primary ${durationLabel(status.windows.primary)}: ${bar(status.windows.primary)}`));
  }
  if (status.windows.secondary && status.windows.secondary !== status.windows.weekly) {
    items.push(infoItem(`Secondary ${durationLabel(status.windows.secondary)}: ${bar(status.windows.secondary)}`));
  }

  const resetLines = [status.windows.fiveHour, status.windows.weekly, status.windows.primary]
    .filter(Boolean)
    .map((window) => `${durationLabel(window)} ${resetLabel(window)}`);
  for (const line of [...new Set(resetLines)]) {
    items.push(infoItem(line));
  }

  if (status.resetCredits !== null) {
    items.push(infoItem(`Reset credits: ${status.resetCredits}`));
  }

  return items;
}

function accountMenu(status) {
  const disabled = Boolean(switchingAlias) || status.isActive;
  return {
    label: `${status.isActive ? '[active] ' : ''}${status.alias}  ${statusSummary(status)}`,
    submenu: [
      infoItem(status.email || 'No email'),
      infoItem(`Plan: ${status.plan || 'unknown'}`),
      { type: 'separator' },
      ...windowItems(status),
      { type: 'separator' },
      {
        label: switchingAlias === status.alias ? 'Switching...' : 'Switch to this account',
        enabled: !disabled,
        click: () => switchAccount(status.alias),
      },
    ],
  };
}

function rebuildMenu() {
  updateTrayAppearance();
  const template = [
    infoItem(refreshing ? 'Refreshing limits...' : 'codex-acct'),
  ];

  if (lastError) {
    template.push(infoItem(`Last error: ${lastError}`));
  }

  if (statuses.length === 0) {
    template.push(infoItem('No saved accounts'));
  } else {
    template.push({ type: 'separator' }, ...statuses.map(accountMenu));
  }

  template.push(
    { type: 'separator' },
    {
      label: 'Save current Codex login',
      enabled: !refreshing && !switchingAlias,
      click: () => saveCurrentLogin(),
    },
    {
      label: 'Add another account...',
      enabled: !refreshing && !switchingAlias,
      click: () => addAnotherAccount(),
    },
    { type: 'separator' },
    {
      label: 'Refresh now',
      enabled: !refreshing && !switchingAlias,
      click: () => refreshStatuses({ notify: true }),
    },
    {
      label: 'Open usage settings',
      click: () => shell.openExternal(USAGE_SETTINGS_URL),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function refreshStatuses({ notify = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  rebuildMenu();
  try {
    statuses = await fetchAllAccountLimitStatuses({ refreshTokens: true });
    lastError = null;
    if (notify) {
      new Notification({ title: 'codex-acct', body: 'Limits refreshed' }).show();
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    refreshing = false;
    rebuildMenu();
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshStatuses(), 400);
}

function watchAccountsIndex() {
  try {
    accountWatcher?.close();
  } catch {}

  try {
    fs.mkdirSync(accountsDir(), { recursive: true, mode: 0o700 });
    accountWatcher = fs.watch(accountsDir(), (eventType, filename) => {
      if (!filename || filename === 'index.json' || filename.endsWith('.auth.json')) {
        scheduleRefresh();
      }
    });
  } catch {
    try {
      accountWatcher = fs.watchFile(indexFilePath(), { interval: 1000 }, scheduleRefresh);
    } catch {}
  }
}

async function switchAccount(alias) {
  switchingAlias = alias;
  rebuildMenu();
  try {
    repairCodexConfig();
    const result = switchTo(alias, { killCodex: true });
    const killed = (result.terminated || []).reduce((sum, item) => sum + (Number(item.killed) || 0), 0);
    const desktopNote = isCodexDesktopRunning() ? '; restart Codex Desktop to pick it up' : '';
    new Notification({
      title: 'codex-acct',
      body: `Switched to ${alias}${killed ? ` after terminating ${killed} Codex CLI process(es)` : ''}${desktopNote}`,
    }).show();
    await refreshStatuses();
  } catch (err) {
    dialog.showErrorBox('codex-acct', err instanceof Error ? err.message : String(err));
  } finally {
    switchingAlias = null;
    rebuildMenu();
  }
}

app.setName('codex-acct');
app.whenReady().then(async () => {
  app.dock?.hide();
  repairCodexConfig();
  tray = new Tray(trayIcon());
  tray.setToolTip('codex-acct');
  watchAccountsIndex();
  rebuildMenu();
  await refreshStatuses();
  setInterval(() => refreshStatuses(), REFRESH_INTERVAL_MS).unref?.();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', () => {
  clearInterval(blinkInterval);
  clearTimeout(blinkTimer);
  try {
    accountWatcher?.close();
  } catch {}
});
