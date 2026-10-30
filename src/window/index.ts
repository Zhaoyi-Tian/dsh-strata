/** Context windows: budget notices and switching. */
import type { Context } from '@deepseek-ai/cordis'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { foldWindow, initialWindowState, windowStateSchema, windowState } from './windows.js'
import { measureBudget } from './budget.js'
import { openMessage, resetWindow } from './reset.js'
import { markItems, registerItemIds } from './item-ids.js'
import type { ResolvedConfig } from '../config.js'
import { recentNotes } from '../notes/notes.js'
import { sessionFor, TEXT_OUTPUT } from '../tools.js'

function notice(windowId: string, event: 'reminder' | 'fallback', text: string, summary: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'context-window', windowId, event, form: 'notice', summary },
  })
}

/**
 * Host order: pre-step -> request routing -> commit this step's input -> model -> tool results.
 * foldWindow records a successful new_context result; the next pre-step performs the switch.
 * pre-step uses the previous route's budget; agent/request rechecks a changed route before input is committed.
 */
export function registerWindow(ctx: Context, config: ResolvedConfig): void {
  ctx.sessionProjections.register({
    key: 'contextWindow',
    stateSchema: windowStateSchema,
    stateVersion: 1,
    init: initialWindowState,
    apply: foldWindow,
  })
  registerItemIds(ctx)
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const budget = await measureBudget(ctx, agent.session, config, signal)
    const state = windowState(ctx, agent.session)
    const reset = budget !== null && state.conversationItems > 0 && (state.requested || budget.total >= budget.hard)
    if (reset) resetWindow(ctx, agent.session, config, state.requested ? 'requested' : 'limit', signal)
    const decision = await next()
    if (decision.kind === 'reject') return decision
    // Items already in the surface are marked before this request; this step's input from the next one.
    markItems(agent.session)
    const current = windowState(ctx, agent.session)
    const messages = [...decision.messages]
    if (!current.opened) {
      messages.unshift(openMessage(config, current.windows.map(window => window.id), recentNotes(ctx, agent.session)))
    }
    const windowId = current.windows.at(-1)!.id
    if (!reset && budget !== null) {
      if (budget.total >= config.notes.remindAtTokens && !current.reminded) {
        const text = config.prompts.reminder.replaceAll('{n_remaining}', String(budget.remaining))
        messages.push(notice(windowId, 'reminder', text, 'Context window nearly exhausted'))
      }
      if (budget.total >= config.notes.checkpointAtTokens && config.prompts.fallback && !current.fellBack && !current.requested) {
        messages.push(notice(windowId, 'fallback', config.prompts.fallback, 'Save a checkpoint and start a new window'))
      }
    }
    return { ...decision, messages }
  }, { prepend: true })

  // The new route is available after next(); its model may have a smaller window.
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const route = await next()
    const header = agent.session.requestHeader()?.config
    if (header?.provider === route.provider && header.model === route.model && header.maxTokens === route.maxTokens) return route
    const budget = await measureBudget(ctx, agent.session, config, signal, route)
    if (budget !== null && windowState(ctx, agent.session).conversationItems > 0 && budget.total >= budget.hard) {
      resetWindow(ctx, agent.session, config, 'limit', signal)
    }
    return route
  }, { prepend: true })

  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (failure.code === CONTEXT_WINDOW_EXCEEDED_CODE && !signal.aborted) {
      try {
        resetWindow(ctx, agent.session, config, 'limit', signal)
      } catch (error: unknown) {
        ctx.logger.warn('context-window: overflow recovery failed; preserving the original request error', error)
      }
    }
    return next()
  })

  ctx.tools.register(defineTool({
    name: 'get_context_remaining',
    description: 'Get the remaining tokens in the current context window.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { tokens_left: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true } },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `You have ${value.tokens_left ?? 'unknown'} tokens left in this context window.` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const budget = await measureBudget(ctx, sessionFor(exec), config, exec.signal)
      return { tokens_left: budget?.remaining ?? null }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'new_context',
    description: 'Start a new context window. Does not clear, reset, or otherwise affect environment state.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      sessionFor(exec)
      return 'A new context window will start without summarizing conversation history.'
    },
  }))
}
