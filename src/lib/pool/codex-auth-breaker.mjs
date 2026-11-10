/**
 * Codex auth circuit breaker（GAIR-NLP patch，experiment）。
 *
 * 背景：闭源 kin-codex-kernel 在账号 OAuth grant 死亡后会进入无退避的重连空转
 * （实测每秒 ~8 条新连接），持续撞击 auth.openai.com，导致账号被上游风控。
 * 节点侧的调度冷却挡不住它——空转发生在 kernel 进程内部，不需要请求驱动。
 * 控制面唯一可靠的收口：熔断 = 杀掉 kernel 进程 + 长冷却该账号，等人工重登。
 *
 * 触发条件（防误杀）：
 *   - terminal：refresh token 被 token 端点明确拒绝（refresh_rejected，401/403）→ 立即熔断
 *   - 非 terminal：30 分钟窗口内连续 3 次 oauth_401 / 刷新失败 → 熔断
 * 成功（请求送达 / 刷新成功 / 配额查询成功）会重置计数。
 */

import { holdOpenAIAccount } from './openai-account-runtime.mjs'
import { stopCodexKernel } from '../transport/codex-kernel-supervisor.mjs'

const WINDOW_MS = 30 * 60_000
const THRESHOLD = 3
const DEAD_HOLD_MS = 24 * 3600_000

/** vmId -> { count, firstAt } */
const failures = new Map()

/** Breaker fired listeners are for tests/introspection. */
const firedLog = []
const MAX_FIRED_LOG = 100

export function codexAuthBreakerSnapshot() {
  return {
    windowMs: WINDOW_MS,
    threshold: THRESHOLD,
    tracked: Object.fromEntries(failures),
    fired: [...firedLog],
  }
}

/** 请求成功送达 / 刷新成功 → 重置。 */
export function reportCodexAuthSuccess(vmId) {
  if (vmId) failures.delete(vmId)
}

/**
 * 报告一次 auth 失败。返回 true 表示熔断已触发。
 * @param {string} vmId
 * @param {{ terminal?: boolean, reason?: string, now?: number }} opts
 */
export function reportCodexAuthFailure(vmId, { terminal = false, reason = 'oauth_401', now = Date.now() } = {}) {
  if (!vmId) return false
  const prev = failures.get(vmId)
  const rec = prev && now - prev.firstAt <= WINDOW_MS
    ? { count: prev.count + 1, firstAt: prev.firstAt }
    : { count: 1, firstAt: now }
  failures.set(vmId, rec)
  if (!terminal && rec.count < THRESHOLD) return false

  failures.delete(vmId)
  try {
    stopCodexKernel(vmId)
  } catch {}
  try {
    holdOpenAIAccount(vmId, { until: now + DEAD_HOLD_MS, reason: 'oauth_dead_breaker', now })
  } catch {}
  firedLog.push({ vmId, reason, terminal, at: new Date(now).toISOString() })
  if (firedLog.length > MAX_FIRED_LOG) firedLog.shift()
  console.error(`[codex-auth-breaker] fired vm=${vmId} reason=${reason} terminal=${terminal} — kernel stopped, account held 24h`)
  return true
}

/** 测试用：清空内部状态。 */
export function resetCodexAuthBreaker() {
  failures.clear()
  firedLog.length = 0
}
