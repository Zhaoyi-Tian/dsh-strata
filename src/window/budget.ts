/** Token budgets for the routed model. */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from '../config.js'
import { requestTokens } from '../tokens.js'

/** Remaining means tokens until forced switching; checkpoint and reminder are absolute thresholds. */
export function resolveBudget(config: ResolvedConfig, window: number, reserve: number, total: number) {
  const hard = Math.min(config.notes.forceSwitchAtTokens ?? window, window - reserve)
  if (hard <= 0) {
    throw new HarnessError(`context-window: model capacity ${window} cannot reserve ${reserve} output tokens; lower the model's maxTokens`, 'BUDGET_INVALID')
  }
  return { total, hard, remaining: Math.max(hard - total, 0) }
}

/** Measure against a route, by default the last logged one; null when no route or window bound is known. */
export async function measureBudget(ctx: Context, session: Session, config: ResolvedConfig, signal: AbortSignal,
  route: { provider: string; model: string; maxTokens?: number } | undefined = session.requestHeader()?.config) {
  if (route === undefined) return null
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
  signal.throwIfAborted()
  const window = info.context?.contextWindow ?? (config.notes.forceSwitchAtTokens === null ? undefined : Infinity)
  if (window === undefined) return null
  return resolveBudget(config, window, route.maxTokens ?? info.defaultMaxTokens ?? 0, requestTokens(ctx, session))
}
