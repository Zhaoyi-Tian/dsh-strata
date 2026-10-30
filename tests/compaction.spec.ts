import { describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Config, resolveConfig } from '../src/index.ts'
import { harness, send, textResponse, toolCallResponse, requestText, withUsage } from './window/harness.ts'

const thinking: StreamChunk[] = [
  { type: 'block-start', index: 1, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 1, text: 'original reasoning' },
  { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'original reasoning' } },
]

describe('white-box summary', () => {
  it('has a compaction threshold, inherits output by default, and allows a prompt override', () => {
    expect(resolveConfig(Config({})).summary).toEqual({ compactAtTokens: 81920, maxOutputTokens: null })
    expect(Config({}).prompts.summary).toContain('entire conversation')
    expect(() => Config({ summary: { maxOutputTokens: 0 } })).toThrow()
  })

  it('checks the threshold before admitting the next input', async () => {
    const { ctx, agent, adapter } = await harness([
      withUsage(textResponse('first answer'), 998), // provider total = 999
      withUsage(textResponse('second answer'), 999), // provider total = 1000
      request => {
        expect(request.purpose).toBe('compaction')
        expect(requestText(request)).toContain('first input')
        expect(requestText(request)).toContain('second input')
        expect(requestText(request)).toContain('second answer')
        expect(requestText(request)).not.toContain('third input')
        return textResponse('summary')
      },
      textResponse('continued'),
    ], { mode: 'summary', summary: { compactAtTokens: 1000 } })
    try {
      await send(agent, 'first input')
      await send(agent, 'second input')
      expect(adapter.requests).toHaveLength(2)
      await send(agent, 'third input')
      expect(adapter.requests).toHaveLength(4)
      expect(requestText(adapter.requests[3]!)).toContain('third input')
      expect(requestText(adapter.requests[3]!)).not.toContain('second answer')
    } finally { await ctx.fiber.dispose() }
  })

  it('includes thinking and complete tool pairs, preserves the system head, and logs exact calls', async () => {
    const { ctx, agent, adapter } = await harness([
      [...thinking, ...withUsage(toolCallResponse('lookup', 'observe', {}), 2000)],
      request => {
        expect(request.messages.slice(0, -1)).toEqual(agent.session.deriveMessages())
        expect(request.messages.flatMap(message => message.content)).toContainEqual({ type: 'reasoning', text: 'original reasoning' })
        expect(requestText(request)).toContain('OBSERVED_RESULT')
        expect(request.messages.some(message => message.role === 'tool')).toBe(true)
        expect(request.tools?.map(tool => tool.name)).toEqual(['observe'])
        expect(request.maxTokens).toBe(300)
        expect(request.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'CUSTOM_SUMMARY_PROMPT' }])
        return [...thinking, ...textResponse('remembered observation')]
      },
      request => {
        expect(request.messages.map(message => message.role)).toEqual(['system', 'user'])
        expect(requestText(request)).toContain('remembered observation')
        expect(requestText(request)).not.toContain('OBSERVED_RESULT')
        expect(request.messages[0]).toEqual(adapter.requests[0]?.messages[0])
        return textResponse('continued')
      },
    ], { mode: 'summary', summary: { compactAtTokens: 1000, maxOutputTokens: 300 }, prompts: { summary: 'CUSTOM_SUMMARY_PROMPT' } })
    try {
      ctx.tools.register(defineTool({
        name: 'observe', description: 'Observe', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return 'OBSERVED_RESULT' },
      }))
      await send(agent, 'original task')
      expect(adapter.requests).toHaveLength(3)
      const events = agent.session.snapshotEvents()
      expect(events.find(event => event.type === 'assistant/message')?.data.message.content)
        .toContainEqual({ type: 'reasoning', text: 'original reasoning' })
      const summary = events.find(event => event.type === 'compaction/summary')!
      expect(summary.data.rawOutput).toContainEqual({ type: 'reasoning', text: 'original reasoning' })
      expect(summary.data.usage).toEqual({ inputTokens: 10, outputTokens: 'remembered observation'.length })
      const input = events.find(event => event.type === 'plugin:dsh-strata/summary-request')!
      expect(input.data.request.messages).toEqual(adapter.requests[1]?.messages)
      const output = events.find(event => event.type === 'plugin:dsh-strata/summary-response')!
      expect(output.data.stream.some(chunk => chunk.type === 'usage')).toBe(true)
      // Native session replay reconstructs the same replacement, with no plugin-side state.
      const restored = ctx.sessions.create(undefined, { seed: events })
      expect(restored.deriveMessages()).toEqual(agent.session.deriveMessages())
    } finally { await ctx.fiber.dispose() }
  })

  it('merges the previous summary and subsequent experience on the next compaction', async () => {
    const { ctx, agent, adapter } = await harness([
      withUsage(textResponse('first answer'), 2000), textResponse('SUMMARY_ONE'),
      withUsage(textResponse('new experience'), 2000),
      request => {
        const input = requestText(request)
        expect(input).toContain('SUMMARY_ONE')
        expect(input).toContain('second task')
        expect(input).toContain('new experience')
        expect(input).not.toContain('first task')
        expect(input).not.toContain('first answer')
        return textResponse('SUMMARY_TWO')
      },
      textResponse('done'),
    ], { mode: 'summary', summary: { compactAtTokens: 1000 } })
    try {
      await send(agent, 'first task')
      await send(agent, 'second task')
      await send(agent, 'third task')
      expect(adapter.requests).toHaveLength(5)
      const next = requestText(adapter.requests[4]!)
      expect(next).toContain('SUMMARY_TWO')
      expect(next).toContain('third task')
      expect(next).not.toContain('new experience')
      expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['error', 'empty', 'max-tokens', 'missing-finish', 'tool-calls'] as const)(
    'preserves visible history and reports a failed %s summary without retrying', async kind => {
      let response: StreamChunk[]
      if (kind === 'error') response = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'provider unavailable' } } }]
      else if (kind === 'empty') response = textResponse('  ')
      else if (kind === 'missing-finish') response = textResponse('partial').filter(chunk => chunk.type !== 'finish')
      else if (kind === 'tool-calls') response = toolCallResponse('bad', 'observe', {})
      else response = textResponse('partial').map(chunk => chunk.type === 'finish' ? { type: 'finish', reason: { kind: 'max-tokens' } } : chunk)
      const { ctx, agent, adapter } = await harness([
        withUsage(textResponse('original answer'), 2000), response,
      ], { mode: 'summary', summary: { compactAtTokens: 1000 } })
      try {
        await send(agent, 'original task')
        const original = agent.session.deriveMessages()
        await send(agent, 'next input')
        expect(adapter.requests).toHaveLength(2)
        expect(agent.session.deriveMessages()).toEqual(original)
        const events = agent.session.snapshotEvents()
        expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
        expect(events.findLast(event => event.type === 'compaction/end')?.data.error).toContain('summary:')
        expect(events.some(event => event.type === 'compaction/summary')).toBe(false)
        expect(events.find(event => event.type === 'plugin:dsh-strata/summary-response')?.data.stream).toEqual(response)
      } finally { await ctx.fiber.dispose() }
    },
  )

  it('rejects unpaired calls before spending a summary request', async () => {
    const { ctx, agent, adapter } = await harness([withUsage(textResponse('answer'), 2000)], { mode: 'summary', summary: { compactAtTokens: 1000 } })
    try {
      await send(agent, 'task')
      // A host extension introduces an unfinished call before the summary hook checks the surface.
      ctx.on('agent/request', async ({ turn, step }, next) => {
        agent.session.append('assistant/message', {
          turn, step,
          stream: toolCallResponse('unanswered', 'observe', {}),
          message: createAssistantMessage({
            source: { kind: 'model', provider: 'mock', model: 'mock' },
            content: [{ type: 'tool-call', id: ToolCallId('unanswered'), name: 'observe', arguments: '{}' }],
          }),
        }, { surfaceOp: 'append' })
        return next()
      })
      await send(agent, 'next input')
      expect(adapter.requests).toHaveLength(1)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
        .toMatchObject({ kind: 'error', error: { message: expect.stringContaining('unanswered tool calls') } })
    } finally { await ctx.fiber.dispose() }
  })
})
