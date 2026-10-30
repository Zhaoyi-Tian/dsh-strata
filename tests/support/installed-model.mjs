import assert from 'node:assert/strict'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-strata-install-test-model'
export const inject = ['llm', 'tools']

function textOf(request) {
  return request.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function toolResult(request) {
  const message = request.messages.findLast(message => message.role === 'tool')
  assert.ok(message, 'a completed tool result reaches the next request')
  assert.ok(!message.isError, textOf({ messages: [message] }))
  return textOf({ messages: [message] })
}

class InstalledModel extends LlmAdapter {
  step = 0
  constructor(mode, ctx) {
    super()
    this.mode = mode
    this.ctx = ctx
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 1000000 }, defaultMaxTokens: 8192 }
  }
  async *stream(request) {
    const names = request.tools?.map(tool => tool.name) ?? []
    let call
    let answer
    if (this.mode === 'disabled') {
      assert.ok(!names.includes('new_context'))
      assert.ok(!names.includes('notes_read_file'))
      answer = 'DSH_STRATA_DISABLED'
    } else if (this.mode === 'full' || this.mode === 'summary') {
      assert.ok(!names.includes('new_context'))
      assert.ok(!names.includes('notes_read_file'))
      assert.doesNotMatch(textOf(request), /<context_window_guidance>/)
      assert.ok(!this.ctx.get('compaction'), 'native compaction backend is absent')
      if (this.mode === 'full') answer = 'DSH_STRATA_FULL'
      else if (request.purpose === 'compaction') {
        assert.match(textOf(request), /SUMMARY_ORIGINAL_TASK/)
        assert.match(textOf(request), /OBSERVATION_FROM_TOOL/)
        assert.ok(request.messages.some(message => message.role === 'tool'))
        answer = 'DSH_STRATA_SUMMARY_CHECKPOINT'
      } else if (this.step === 0) {
        call = ['dsh_strata_test_observe', {}]
      } else {
        assert.match(textOf(request), /<compacted-summary>/)
        assert.match(textOf(request), /DSH_STRATA_SUMMARY_CHECKPOINT/)
        assert.doesNotMatch(textOf(request), /SUMMARY_ORIGINAL_TASK|OBSERVATION_FROM_TOOL/)
        answer = 'DSH_STRATA_SUMMARY'
      }
    } else {
      assert.ok(names.includes('new_context'), 'installed plugin provides its tools')
      if (this.mode === 'resume') {
        if (this.step === 0) call = ['notes_read_file', { path: 'checkpoint.md' }]
        else { assert.match(toolResult(request), /CHECKPOINT_SAVED/); answer = 'DSH_STRATA_RESUMED' }
      } else {
        switch (this.step) {
          case 0:
            assert.match(textOf(request), /Current context window id: w0/)
            call = ['notes_write_file', { path: 'checkpoint.md', text: 'CHECKPOINT_SAVED: recover the original user message from w0.' }]
            break
          case 1:
            assert.match(toolResult(request), /Saved checkpoint.md/)
            call = ['new_context', {}]
            break
          case 2:
            assert.match(textOf(request), /Current context window id: w1/)
            assert.doesNotMatch(textOf(request), /RECOVERY_NEEDLE/)
            call = ['notes_read_file', { path: 'checkpoint.md' }]
            break
          case 3:
            assert.match(toolResult(request), /CHECKPOINT_SAVED/)
            call = ['history_list_items', { window_id: 'w0', event_type: 'user/message', limit: 100 }]
            break
          case 4: {
            const original = toolResult(request).split('\n').find(line => line.includes('RECOVERY_NEEDLE'))
            assert.ok(original, 'history lists the original instruction')
            const id = original.match(/#\d+/)?.[0]
            assert.ok(id)
            call = ['history_read_item', { seq: Number(id.slice(1)) }]
            break
          }
          case 5:
            assert.match(toolResult(request), /RECOVERY_NEEDLE/)
            assert.doesNotMatch(toolResult(request), /Full formatted result stored at:/, 'history stays inline without host spill')
            assert.ok(toolResult(request).length > 60000, 'the full large history result reaches the model')
            answer = 'DSH_STRATA_RECOVERED'
            break
          default: throw new Error('Unexpected extra model request')
        }
      }
    }
    this.step++
    const block = call
      ? { type: 'tool-call', id: ToolCallId(`install-${this.step}`), name: call[0], arguments: JSON.stringify(call[1]) }
      : { type: 'text', text: answer }
    yield { type: 'block-start', index: 0, blockType: block.type }
    if (call) yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
    else yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: this.mode === 'summary' && call ? 2000 : 100, outputTokens: 50 } }
    yield { type: 'finish', reason: { kind: call ? 'tool-calls' : 'stop' } }
  }
}

export function apply(ctx, config) {
  if (config.mode === 'summary') ctx.tools.register(defineTool({
    name: 'dsh_strata_test_observe', description: 'Test observation', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'OBSERVATION_FROM_TOOL' },
  }))
  ctx.llm.registerAdapter(['dsh-strata-test'], new InstalledModel(config.mode, ctx))
}
