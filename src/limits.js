import http from 'node:http';
import https from 'node:https';

import { identityFromAuth, decodeJwtPayload } from './jwt.js';
import { listAccounts, preserveActiveAccount } from './accounts.js';
import { readSnapshot, writeSnapshotFromData } from './store.js';

const DEFAULT_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api';
const DEFAULT_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_SKEW_SECONDS = 5 * 60;

export class UsageFetchError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'UsageFetchError';
    this.status = status;
    this.body = body;
  }
}

function nodeFetch(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const requestBody = body == null ? null : Buffer.from(String(body));
    const requestHeaders = { ...headers };
    if (requestBody && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length')) {
      requestHeaders['content-length'] = String(requestBody.length);
    }

    const request = client.request(
      parsed,
      {
        method,
        headers: requestHeaders,
        timeout: 15000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage,
            headers: response.headers,
            text: async () => text,
          });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error(`request timed out: ${url}`)));
    request.on('error', reject);
    if (requestBody) request.write(requestBody);
    request.end();
  });
}

function fetchImplFromOptions(options) {
  return options.fetchImpl || nodeFetch;
}

function normalizeBaseUrl(raw = process.env.CODEX_CHATGPT_BASE_URL || DEFAULT_CHATGPT_BASE_URL) {
  let baseUrl = String(raw || DEFAULT_CHATGPT_BASE_URL).trim();
  while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
  if (
    (baseUrl === 'https://chatgpt.com' || baseUrl === 'https://chat.openai.com') &&
    !baseUrl.includes('/backend-api')
  ) {
    return `${baseUrl}/backend-api`;
  }
  return baseUrl || DEFAULT_CHATGPT_BASE_URL;
}

export function codexUsageUrl(baseUrl = normalizeBaseUrl()) {
  return baseUrl.includes('/backend-api') ? `${baseUrl}/wham/usage` : `${baseUrl}/api/codex/usage`;
}

function oauthClientId() {
  return process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID;
}

function refreshTokenUrl() {
  return process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || DEFAULT_REFRESH_TOKEN_URL;
}

function tokenExp(token) {
  if (!token) return null;
  try {
    const payload = decodeJwtPayload(token);
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function shouldRefreshAuth(auth, nowSeconds = Date.now() / 1000) {
  const accessExp = tokenExp(auth?.tokens?.access_token);
  const idExp = tokenExp(auth?.tokens?.id_token);
  const exp = accessExp ?? idExp;
  if (!exp) return false;
  return exp - nowSeconds <= REFRESH_SKEW_SECONDS;
}

function isChatGptAuth(auth) {
  return auth?.auth_mode === 'chatgpt' && Boolean(auth?.tokens?.access_token);
}

function accountIdFromAuth(auth) {
  return auth?.tokens?.account_id || identityFromAuth(auth).accountId;
}

export async function refreshChatGptAuth(auth, options = {}) {
  const refreshToken = auth?.tokens?.refresh_token;
  if (!refreshToken) throw new UsageFetchError('refresh token is missing');

  const fetchImpl = fetchImplFromOptions(options);
  const response = await fetchImpl(refreshTokenUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: oauthClientId(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}

  if (!response.ok) {
    throw new UsageFetchError(`token refresh failed with ${response.status}`, {
      status: response.status,
      body: text,
    });
  }

  return {
    ...auth,
    tokens: {
      ...auth.tokens,
      id_token: data?.id_token || auth.tokens.id_token,
      access_token: data?.access_token || auth.tokens.access_token,
      refresh_token: data?.refresh_token || auth.tokens.refresh_token,
      account_id: auth.tokens.account_id,
    },
    last_refresh: new Date().toISOString(),
  };
}

export async function fetchCodexUsage(auth, options = {}) {
  if (!isChatGptAuth(auth)) {
    throw new UsageFetchError('ChatGPT authentication is required to read Codex limits');
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const url = codexUsageUrl(baseUrl);
  const accountId = accountIdFromAuth(auth);
  const headers = {
    authorization: `Bearer ${auth.tokens.access_token}`,
    'user-agent': 'codex-acct',
    accept: 'application/json',
  };
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;

  const response = await fetchImplFromOptions(options)(url, { headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}

  if (!response.ok) {
    throw new UsageFetchError(`usage request failed with ${response.status}`, {
      status: response.status,
      body: text,
    });
  }
  if (!data || typeof data !== 'object') {
    throw new UsageFetchError('usage response was not JSON');
  }
  return data;
}

function windowFromPayload(value) {
  if (!value || typeof value !== 'object') return null;
  const usedPercent = Number(value.used_percent);
  const windowSeconds = Number(value.limit_window_seconds);
  const resetsAt = Number(value.reset_at);
  return {
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    remainingPercent: Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, 100 - usedPercent)) : null,
    windowDurationMins: Number.isFinite(windowSeconds) ? Math.round(windowSeconds / 60) : null,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

function snapshotFromRateLimit(limitId, limitName, rateLimit, payload) {
  return {
    limitId,
    limitName,
    primary: windowFromPayload(rateLimit?.primary_window),
    secondary: windowFromPayload(rateLimit?.secondary_window),
    credits: payload?.credits
      ? {
          hasCredits: Boolean(payload.credits.has_credits),
          unlimited: Boolean(payload.credits.unlimited),
          balance: payload.credits.balance ?? null,
        }
      : null,
    individualLimit: payload?.spend_control?.individual_limit
      ? {
          limit: payload.spend_control.individual_limit.limit,
          used: payload.spend_control.individual_limit.used,
          remaining: payload.spend_control.individual_limit.remaining,
          remainingPercent: payload.spend_control.individual_limit.remaining_percent,
          resetsAt: payload.spend_control.individual_limit.reset_at,
        }
      : null,
    planType: payload?.plan_type ?? null,
    rateLimitReachedType: payload?.rate_limit_reached_type?.type ?? null,
  };
}

export function rateLimitSnapshotsFromPayload(payload) {
  const snapshots = [];
  if (payload?.rate_limit) {
    snapshots.push(snapshotFromRateLimit('codex', null, payload.rate_limit, payload));
  }
  for (const item of payload?.additional_rate_limits || []) {
    if (!item?.rate_limit) continue;
    const limitId = item.metered_feature || item.limit_name || `limit-${snapshots.length + 1}`;
    snapshots.push(snapshotFromRateLimit(limitId, item.limit_name || limitId, item.rate_limit, payload));
  }
  return snapshots;
}

function isFiveHourWindow(window) {
  return window?.windowDurationMins >= 4 * 60 && window.windowDurationMins <= 6 * 60;
}

function isWeeklyWindow(window) {
  return window?.windowDurationMins >= 6 * 24 * 60 && window.windowDurationMins <= 8 * 24 * 60;
}

function firstMatchingWindow(snapshot, predicate) {
  return [snapshot?.primary, snapshot?.secondary].find(predicate) || null;
}

export function displayWindows(snapshot) {
  return {
    fiveHour: firstMatchingWindow(snapshot, isFiveHourWindow),
    weekly: firstMatchingWindow(snapshot, isWeeklyWindow),
    primary: snapshot?.primary || null,
    secondary: snapshot?.secondary || null,
  };
}

function preferredSnapshot(snapshots) {
  return snapshots.find((snapshot) => snapshot.limitId === 'codex') || snapshots[0] || null;
}

function statusFromUsage(account, auth, usage, fetchedAt) {
  const snapshots = rateLimitSnapshotsFromPayload(usage);
  const preferred = preferredSnapshot(snapshots);
  return {
    alias: account.alias,
    email: usage.email || account.email,
    plan: usage.plan_type || account.plan,
    accountId: usage.account_id || account.accountId || identityFromAuth(auth).accountId,
    isActive: account.isActive,
    isDefault: account.isDefault,
    fetchedAt,
    usage,
    snapshots,
    preferred,
    windows: displayWindows(preferred),
    resetCredits: usage.rate_limit_reset_credits?.available_count ?? null,
    error: null,
  };
}

export async function fetchAccountLimitStatus(account, options = {}) {
  const fetchedAt = new Date().toISOString();
  try {
    let auth = readSnapshot(account.alias);
    if (!isChatGptAuth(auth)) {
      throw new UsageFetchError('saved account is not a ChatGPT login');
    }

    if (options.forceRefresh === true || (options.refreshTokens !== false && shouldRefreshAuth(auth))) {
      auth = await refreshChatGptAuth(auth, options);
      writeSnapshotFromData(account.alias, auth);
    }

    let usage;
    try {
      usage = await fetchCodexUsage(auth, options);
    } catch (err) {
      if (
        options.refreshTokens !== false &&
        err instanceof UsageFetchError &&
        (err.status === 401 || err.status === 403)
      ) {
        auth = await refreshChatGptAuth(auth, options);
        writeSnapshotFromData(account.alias, auth);
        usage = await fetchCodexUsage(auth, options);
      } else {
        throw err;
      }
    }

    return statusFromUsage(account, auth, usage, fetchedAt);
  } catch (err) {
    return {
      alias: account.alias,
      email: account.email,
      plan: account.plan,
      accountId: account.accountId,
      isActive: account.isActive,
      isDefault: account.isDefault,
      fetchedAt,
      usage: null,
      snapshots: [],
      preferred: null,
      windows: displayWindows(null),
      resetCredits: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchAllAccountLimitStatuses(options = {}) {
  if (options.preserveActive === true) preserveActiveAccount();
  const accounts = listAccounts();
  const byAccountId = new Map();
  const rows = [];

  for (const account of accounts) {
    const cacheKey = account.accountId || null;
    if (cacheKey && byAccountId.has(cacheKey)) {
      const cached = byAccountId.get(cacheKey);
      rows.push({
        ...cached,
        alias: account.alias,
        email: cached.email || account.email,
        accountId: account.accountId,
        isActive: account.isActive,
        isDefault: account.isDefault,
      });
      continue;
    }

    const status = await fetchAccountLimitStatus(account, options);
    rows.push(status);
    if (cacheKey && !status.error) byAccountId.set(cacheKey, status);
  }

  return rows;
}
