/** All current history -> one summary call -> one surface replacement. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CompactionId, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { BlockAssembler, createUserMessage, errorChain, HarnessError, type GenerateOptions, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from '../config.js'
import { requestTokens } from '../tokens.js'
import { frameSummary } from './prompts.js'

declare module '@deepseek-ai/dsh-llm' {
  interface LlmRequestPurposeMap { compaction: true }
}

// Ignorable audit records survive resume even when this plugin is uninstalled.
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-strata/summary-request': { compactionId: CompactionId; request: Omit<GenerateOptions, 'signal'> }
    'plugin:dsh-strata/summary-response': { compactionId: CompactionId; stream: StreamChunk[] }
  }
}

/** Run before the loop appends this step's new input; an error ends the turn without retrying. */
export function registerCompaction(ctx: Context, config: ResolvedConfig): void {
  ctx.on('agent/request', async ({ agent, turn, signal }, next) => {
    const route = await next()
    await compactIfNeeded(ctx, agent.session, turn, route, config, signal)
    return route
  }, { prepend: true })
}

async function compactIfNeeded(ctx: Context, session: Session, turn: number, route: LlmCallConfig,
  config: ResolvedConfig, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const nodes = [...session.surface.nodes]
  const body = session.eventAt(nodes[0]!)?.type === 'system/message' ? nodes.slice(1) : nodes
  const start = body[0]
  const end = body.at(-1)
  if (start === undefined || end === undefined) return
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
  signal.throwIfAborted()
  // No extra headroom policy: reserve only the configured summary output.
  const maxOutputTokens = config.summary.maxOutputTokens ?? route.maxTokens ?? info.defaultMaxTokens
  if (maxOutputTokens === undefined) {
    throw new HarnessError('summary: configure the host model output budget or summary.maxOutputTokens', 'SUMMARY_BUDGET_INVALID')
  }
  const threshold = Math.min(config.summary.compactAtTokens ?? Infinity,
    (info.context?.contextWindow ?? Infinity) - maxOutputTokens)
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new HarnessError('summary: no usable context threshold; configure summary.compactAtTokens or the model capacity', 'SUMMARY_BUDGET_INVALID')
  }
  if (requestTokens(ctx, session) < threshold) return
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
    throw new HarnessError('summary: cannot replace history with unanswered tool calls', 'SUMMARY_PAIRING')
  }
  const generation = session.surface.contentGeneration
  const bodySet = new Set(body)
  const shadowedTokenCount = ctx.tokenMeter.measure(session).nodes
    .filter(node => bodySet.has(node.seq)).reduce((sum, node) => sum + node.heuristicTokens, 0)
  const compactionId = CompactionId(randomUUID())
  const lifecycle = { compactionId, turn }
  const { maxTokens: _maxTokens, stop: _stop, ...controls } = route
  const tools = session.requestHeader()?.tools
  const request: Omit<GenerateOptions, 'signal'> = {
    ...controls,
    maxTokens: maxOutputTokens,
    messages: [...session.deriveMessages(), { role: 'user', content: [{ type: 'text', text: config.prompts.summary }] }],
    ...tools === undefined ? {} : { tools: [...tools] },
    toolHistory: session.toolHistory(),
    sessionId: session.id,
    purpose: 'compaction',
  }
  const opened = session.append('compaction/start', lifecycle)
  let failure: string | undefined
  try {
    appendPluginRecord(session, 'plugin:dsh-strata/summary-request', { compactionId, request })
    const assembler = new BlockAssembler()
    const stream: StreamChunk[] = []
    try {
      for await (const chunk of ctx.llm.stream({ ...request, signal })) {
        stream.push(chunk)
        assembler.push(chunk)
      }
    } finally {
      appendPluginRecord(session, 'plugin:dsh-strata/summary-response', { compactionId, stream })
    }
    signal.throwIfAborted()
    const finish = stream.findLast(chunk => chunk.type === 'finish')?.reason
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      throw new HarnessError(`summary: ${finish.failure.message}`, finish.failure.code)
    }
    if (finish?.kind !== 'stop') {
      throw new HarnessError(`summary: incomplete response (${finish?.kind ?? 'missing finish'})`, 'SUMMARY_INCOMPLETE')
    }
    const rawOutput = assembler.blocks()
    if (rawOutput.some(block => block.type !== 'text' && block.type !== 'reasoning')) {
      throw new HarnessError('summary: expected text, received tool calls or other content', 'SUMMARY_INVALID_OUTPUT')
    }
    const summary = rawOutput.filter(block => block.type === 'text')
    const text = summary.map(block => block.text).join('\n')
    if (text.trim().length === 0) throw new HarnessError('summary: empty response', 'SUMMARY_EMPTY')
    // A rewrite changes contentGeneration; an append changes the node count.
    if (session.surface.contentGeneration !== generation || session.surface.nodes.length !== nodes.length) {
      throw new HarnessError('summary: history changed during the request; preserving it', 'SUMMARY_HISTORY_CHANGED')
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: frameSummary(text) }], source: compactCheckpointSource(compactionId),
    })
    const logged = session.append('compaction/summary', {
      compactionId, summary, rawOutput, llmStreamCall: true,
      shadowedRange: { start, end }, shadowedSeqs: body, shadowedTokenCount,
      provider: request.provider, model: request.model, maxTokens: request.maxTokens,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    })
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: [opened.seq, logged.seq, ...body],
    })
  } catch (error: unknown) {
    failure = errorChain(error)
    throw error
  } finally {
    session.append('compaction/end', { ...lifecycle, ...failure === undefined ? {} : { error: failure } })
  }
}
