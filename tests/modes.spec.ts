import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Config } from '../src/index.ts'
import { harness, send, textResponse, requestText, withUsage } from './window/harness.ts'

describe('run modes', () => {
  it('defaults to notes and rejects unknown modes', () => {
    expect(Config({}).mode).toBe('notes')
    expect(() => Config({ mode: 'other' })).toThrow()
  })

  it('keeps full history and thinking without notes tools, reminders or replacement', async () => {
    const thought: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'original thinking' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'original thinking' } },
      ...textResponse('first answer').map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 1 } : chunk),
    ]
    const { ctx, agent, adapter } = await harness([thought, textResponse('second answer')], {
      mode: 'full', full: { stopAtTokens: null },
    })
    try {
      await send(agent, 'original observation '.repeat(1000))
      await send(agent, 'current task')
      expect(adapter.requests).toHaveLength(2)
      const next = adapter.requests[1]!
      expect(requestText(next)).toContain('original observation '.repeat(1000))
      expect(requestText(next)).toContain('first answer')
      expect(requestText(next)).toContain('current task')
      expect(next.messages.flatMap(message => message.content)).toContainEqual({ type: 'reasoning', text: 'original thinking' })
      expect(requestText(next)).not.toContain('<context_window_guidance>')
      expect(ctx.tools.schemas()).toHaveLength(0)
      expect(ctx.get('compaction')).toBeUndefined()
      expect(agent.session.snapshotEvents().some(event => event.type.startsWith('compaction/'))).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves a full-mode overflow instead of silently clearing or summarizing history', async () => {
    const { ctx, agent, adapter } = await harness([
      textResponse('first answer'),
      () => { throw new LlmError('context capacity exceeded', CONTEXT_WINDOW_EXCEEDED_CODE) },
    ], { mode: 'full' })
    try {
      await send(agent, 'original observation')
      await send(agent, 'overflowing request')
      expect(adapter.requests).toHaveLength(2)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
        .toMatchObject({ kind: 'error', error: { code: CONTEXT_WINDOW_EXCEEDED_CODE } })
      expect(agent.session.snapshotEvents().some(event => event.type.startsWith('compaction/'))).toBe(false)
      expect(JSON.stringify(agent.session.deriveMessages())).toContain('original observation')
    } finally { await ctx.fiber.dispose() }
  })

  it('stops full mode at its own threshold without calling the model or replacing history', async () => {
    const { ctx, agent, adapter } = await harness([
      withUsage(textResponse('below'), 998),
      withUsage(textResponse('at limit'), 999),
    ], { mode: 'full', full: { stopAtTokens: 1000 }, summary: { compactAtTokens: 1 } })
    try {
      await send(agent, 'original')
      await send(agent, 'still below')
      expect(adapter.requests).toHaveLength(2)
      const history = agent.session.deriveMessages()
      await send(agent, 'over limit')
      expect(adapter.requests).toHaveLength(2)
      expect(agent.session.deriveMessages()).toEqual(history)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
        .toMatchObject({ kind: 'error', error: { code: 'FULL_CONTEXT_LIMIT' } })
    } finally { await ctx.fiber.dispose() }
  })

  it('unregisters summary compaction when the plugin is disposed', async () => {
    const { ctx, agent, adapter, fiber } = await harness([
      withUsage(textResponse('first answer'), 2000),
      textResponse('continued'),
    ], { mode: 'summary', summary: { compactAtTokens: 2000 } })
    try {
      expect(ctx.tools.schemas()).toHaveLength(0)
      await send(agent, 'original observation')
      await fiber.dispose()
      await send(agent, 'current task')
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]!.purpose).toBeUndefined()
      expect(requestText(adapter.requests[1]!)).toContain('original observation')
      expect(requestText(adapter.requests[1]!)).toContain('first answer')
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    } finally { await ctx.fiber.dispose() }
  })
})
