/** Select one context policy for a run; notes mode retains the original tools and window behavior. */
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.js'
import { registerCompaction } from './compaction/index.js'
import { registerWindow } from './window/index.js'
import { registerNotes } from './notes/index.js'
import { registerHistory } from './notes/history.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { requestTokens } from './tokens.js'

export { Config, resolveConfig }
export const name = 'dsh-strata'
export const inject = ['tokenMeter', 'llm', 'sessionProjections', 'tools', 'sessions', 'sessionQuery']

export function apply(ctx: Context, input: ReturnType<typeof Config>): void {
  const config = resolveConfig(input)
  if (config.mode === 'full') {
    const limit = config.full.stopAtTokens
    if (limit !== null) ctx.on('agent/request', async ({ agent }, next) => {
      const route = await next()
      if (requestTokens(ctx, agent.session) >= limit) {
        throw new LlmError(`full: context reached stopAtTokens (${limit}); history preserved`, 'FULL_CONTEXT_LIMIT')
      }
      return route
    }, { prepend: true })
    return
  }
  if (config.mode === 'summary') {
    registerCompaction(ctx, config)
    return
  }
  registerNotes(ctx, config.notes.maxFileBytes)
  registerWindow(ctx, config)
  registerHistory(ctx)
}
