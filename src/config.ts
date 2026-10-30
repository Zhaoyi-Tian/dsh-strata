/** Context policies use absolute consumed-token thresholds; generation belongs to the host. */
import z from '@deepseek-ai/schemastery'
import { GUIDANCE, REMINDER, FALLBACK } from './window/prompts.js'
import { SUMMARY } from './compaction/prompts.js'

const integer = (minimum: number) => z.number().step(1).min(minimum).max(Number.MAX_SAFE_INTEGER)
const limit = () => z.union([integer(1), z.const(null)])

/** Plugin configuration validated by Cordis. */
export const Config = z.object({
  mode: z.union([z.const('notes'), z.const('full'), z.const('summary')]).default('notes'),
  notes: z.object({
    remindAtTokens: integer(0).default(59392),
    checkpointAtTokens: integer(1).default(65536),
    forceSwitchAtTokens: limit(),
    maxFileBytes: integer(1).default(1_000_000),
  }).default({}),
  summary: z.object({
    compactAtTokens: limit(),
    maxOutputTokens: limit(),
  }).default({}),
  full: z.object({ stopAtTokens: limit() }).default({}),
  prompts: z.object({
    guidance: z.string().default(GUIDANCE),
    reminder: z.string().default(REMINDER),
    fallback: z.union([z.string(), z.const(null)]),
    summary: z.string().default(SUMMARY),
  }).default({}),
}).default({})

export type Config = Schemastery.TypeS<typeof Config>
export type ResolvedConfig = ReturnType<typeof resolveConfig>

/** Apply only the defaults that must preserve null, after Cordis has validated the settings. */
export function resolveConfig({
  notes: { forceSwitchAtTokens = 81920, ...notes },
  summary: { compactAtTokens = 81920, maxOutputTokens = null },
  full: { stopAtTokens = null },
  prompts: { fallback = FALLBACK, ...prompts }, ...config
}: ReturnType<typeof Config>) {
  // Destructuring defaults preserve null; Schemastery's default() replaces it.
  if (notes.remindAtTokens > notes.checkpointAtTokens
    || (forceSwitchAtTokens !== null && notes.checkpointAtTokens >= forceSwitchAtTokens)) {
    throw new Error('notes requires remindAtTokens <= checkpointAtTokens < forceSwitchAtTokens')
  }
  return { ...config, notes: { ...notes, forceSwitchAtTokens },
    summary: { compactAtTokens, maxOutputTokens }, full: { stopAtTokens }, prompts: { ...prompts, fallback } }
}
