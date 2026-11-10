import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  reportCodexAuthFailure,
  reportCodexAuthSuccess,
  codexAuthBreakerSnapshot,
  resetCodexAuthBreaker,
} from '../../src/lib/pool/codex-auth-breaker.mjs'
import { openAIAccountHold } from '../../src/lib/pool/openai-account-runtime.mjs'

test('terminal failure fires immediately, holds account 24h', () => {
  resetCodexAuthBreaker()
  const fired = reportCodexAuthFailure('vm-t1', { terminal: true, reason: 'refresh_rejected' })
  assert.equal(fired, true)
  const hold = openAIAccountHold('vm-t1')
  assert.ok(hold && hold.until > Date.now() + 23 * 3600_000, '24h hold expected')
  const snap = codexAuthBreakerSnapshot()
  assert.equal(snap.fired.length, 1)
  assert.equal(snap.fired[0].vmId, 'vm-t1')
})

test('transient failures need 3 within window', () => {
  resetCodexAuthBreaker()
  const now = Date.now()
  assert.equal(reportCodexAuthFailure('vm-t2', { now }), false)
  assert.equal(reportCodexAuthFailure('vm-t2', { now: now + 1000 }), false)
  assert.equal(reportCodexAuthFailure('vm-t2', { now: now + 2000 }), true)
})

test('success resets the counter', () => {
  resetCodexAuthBreaker()
  const now = Date.now()
  reportCodexAuthFailure('vm-t3', { now })
  reportCodexAuthFailure('vm-t3', { now: now + 1000 })
  reportCodexAuthSuccess('vm-t3')
  assert.equal(reportCodexAuthFailure('vm-t3', { now: now + 2000 }), false, 'count reset → 1st failure again')
})

test('window expiry restarts the count', () => {
  resetCodexAuthBreaker()
  const now = Date.now()
  reportCodexAuthFailure('vm-t4', { now })
  reportCodexAuthFailure('vm-t4', { now: now + 1000 })
  // 31 分钟后的一次失败应视为新窗口第 1 次
  assert.equal(reportCodexAuthFailure('vm-t4', { now: now + 31 * 60_000 }), false)
})

test('breaker isolates VMs', () => {
  resetCodexAuthBreaker()
  const now = Date.now()
  reportCodexAuthFailure('vm-a', { now })
  reportCodexAuthFailure('vm-a', { now: now + 1 })
  assert.equal(reportCodexAuthFailure('vm-b', { now: now + 2 }), false)
  assert.equal(reportCodexAuthFailure('vm-a', { now: now + 3 }), true)
})
