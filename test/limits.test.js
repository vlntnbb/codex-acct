import test from 'node:test';
import assert from 'node:assert/strict';

import { codexUsageUrl, displayWindows, rateLimitSnapshotsFromPayload } from '../src/limits.js';

test('codexUsageUrl uses ChatGPT wham path for backend-api bases', () => {
  assert.equal(codexUsageUrl('https://chatgpt.com/backend-api'), 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(codexUsageUrl('https://example.test'), 'https://example.test/api/codex/usage');
});

test('rateLimitSnapshotsFromPayload maps primary, weekly and additional limits', () => {
  const payload = {
    plan_type: 'prolite',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 24,
        limit_window_seconds: 18000,
        reset_at: 1781737333,
      },
      secondary_window: {
        used_percent: 13,
        limit_window_seconds: 604800,
        reset_at: 1782306104,
      },
    },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          primary_window: {
            used_percent: 0,
            limit_window_seconds: 18000,
            reset_at: 1781739733,
          },
        },
      },
    ],
    credits: {
      has_credits: false,
      unlimited: false,
      balance: '0',
    },
    rate_limit_reset_credits: { available_count: 1 },
  };

  const snapshots = rateLimitSnapshotsFromPayload(payload);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].limitId, 'codex');
  assert.equal(snapshots[0].primary.windowDurationMins, 300);
  assert.equal(snapshots[0].primary.remainingPercent, 76);
  assert.equal(snapshots[0].secondary.windowDurationMins, 10080);
  assert.equal(snapshots[0].secondary.remainingPercent, 87);
  assert.equal(snapshots[1].limitId, 'codex_bengalfox');

  const windows = displayWindows(snapshots[0]);
  assert.equal(windows.fiveHour.remainingPercent, 76);
  assert.equal(windows.weekly.remainingPercent, 87);
  assert.equal(windows.primary.remainingPercent, 76);
});

test('displayWindows only promotes 5h and weekly windows', () => {
  const [snapshot] = rateLimitSnapshotsFromPayload({
    plan_type: 'pro',
    rate_limit: {
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 3600,
        reset_at: 1735689720,
      },
      secondary_window: {
        used_percent: 5,
        limit_window_seconds: 86400,
        reset_at: 1735693200,
      },
    },
  });

  const windows = displayWindows(snapshot);
  assert.equal(windows.fiveHour, null);
  assert.equal(windows.weekly, null);
  assert.equal(windows.secondary.remainingPercent, 95);
});
