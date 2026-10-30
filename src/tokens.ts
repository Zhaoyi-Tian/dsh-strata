/** Provider usage plus estimates for content added since the latest request. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'

/** The host meter prefers its larger estimate; use the provider's count when available. */
export function requestTokens(ctx: Context, session: Session): number {
  const measurement = ctx.tokenMeter.measure(session)
  let added = 0
  for (const node of measurement.nodes.toReversed()) {
    const event = session.eventAt(node.seq)
    if (event?.type === 'assistant/message' && event.data.usage !== undefined) {
      const usage = event.data.usage
      return (usage.totalTokens ?? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        + usage.outputTokens) + added
    }
    added += node.tokens
  }
  return measurement.totalTokens
}
