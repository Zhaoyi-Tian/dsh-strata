/** Appended after the complete conversation so its existing prefix remains cacheable. */
export const SUMMARY = `Summarize the entire conversation above so the task can continue from your summary alone.
Preserve the task, constraints, key observations, actions and their results, current progress, unresolved questions, and information needed for the next action. Keep exact names, identifiers, numbers, and temporal relationships when they matter.
Distinguish observed facts from hypotheses, plans, and uncertain or outdated information. Preserve corrections and failures rather than treating attempted actions as successes.
If the conversation contains an earlier <compacted-summary>, merge it with subsequent experience into one updated summary. Preserve still-relevant facts and replace superseded claims.
Be concise and faithful. Use the conversation's language and a structure appropriate to its content; no fixed headings are required. Output only the summary text. Do not call tools or continue the task.`

export function frameSummary(text: string): string {
  return `The following summary replaces the earlier conversation. Use it as background and continue the task from the inputs that follow.\n\n<compacted-summary>\n${text}\n</compacted-summary>`
}
