import { settings as resolveConfig } from './harness.ts'
import { describe, expect, it } from 'vitest'
import { resolveBudget } from '../../src/window/budget.ts'
import { windowBlock } from '../../src/window/prompts.ts'

describe('working budget', () => {
  it('reports room until forced switching and reserves the model output capacity', () => {
    const config = resolveConfig({})
    expect(resolveBudget(config, 128000, 8192, 2500)).toEqual({
      total: 2500, hard: 81920, remaining: 79420,
    })
    expect(resolveBudget(config, 60000, 10000, 80000).remaining).toBe(0)
    expect(resolveBudget(config, 60000, 10000, 0).hard).toBe(50000)
  })
  it('follows the adapter when uncapped; disabling the prompt does not change capacity', () => {
    const config = resolveConfig({ notes: { forceSwitchAtTokens: null }, prompts: { fallback: null } })
    expect(resolveBudget(config, 10000, 0, 2500).remaining).toBe(7500)
  })
  it('allows reminders from the first measurable step in a small window', () => {
    const config = resolveConfig({ notes: { remindAtTokens: 0, checkpointAtTokens: 50, forceSwitchAtTokens: 100 } })
    expect(resolveBudget(config, 10000, 0, 1).remaining).toBe(99)
  })
  it.each([
    { notes: { forceSwitchAtTokens: 0 } }, { notes: { forceSwitchAtTokens: -1 } },
    { notes: { forceSwitchAtTokens: NaN } }, { notes: { remindAtTokens: -1 } },
    { notes: { remindAtTokens: 1.5 } },
    { notes: { remindAtTokens: 65537, checkpointAtTokens: 65536 } },
    { notes: { checkpointAtTokens: 81920, forceSwitchAtTokens: 81920 } },
  ])('rejects an invalid setting before registration: %j', (input) => {
    expect(() => resolveConfig(input)).toThrow()
  })
  it('names the fix when there is no positive working budget', () => {
    // A shrunk model window cannot hold the output reserve.
    expect(() => resolveBudget(resolveConfig({}), 81920, 256000, 0)).toThrow(/lower the model's maxTokens/)
    expect(() => resolveBudget(resolveConfig({}), 10000, 10000, 0)).toThrow(/lower the model's maxTokens/)
  })
  it('accepts an exact one-token working budget', () => {
    const config = resolveConfig({ notes: { forceSwitchAtTokens: null }, prompts: { fallback: null, guidance: '', reminder: '{n_remaining}/{n_remaining}' } })
    expect(resolveBudget(config, 10000, 9999, 0)).toEqual({ total: 0, hard: 1, remaining: 1 })
    expect(resolveBudget(config, 10000, 9999, 1).remaining).toBe(0)
  })
  it('bounds complete multibyte hint lines rather than splitting one', () => {
    const ids = ['w0', 'w1']
    const block = windowBlock(ids, ['Recent notes:', '界'.repeat(1400), 'omitted'])
    expect(block).toContain('Previous context window id: w0')
    expect(block).toContain('Recent notes:')
    expect(block).not.toContain('omitted')
    expect(block).not.toContain('界')
  })
})
