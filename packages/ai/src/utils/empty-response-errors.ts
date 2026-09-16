/**
 * Terminal error texts for assistant turns that ended without deliverable content. The stream
 * wrapper in pi-agent-core produces them; the turn-retry classifier in ./retry.ts consumes them,
 * so the two halves share one definition.
 *
 * "twice" variants: the wrapper already spent its own silent retry on an attempt that never
 * forwarded anything, so the turn stays terminal. "after streaming thinking" variants: the attempt
 * had already forwarded reasoning live and cannot be replayed inside the stream, so the turn-level
 * retry owns the recovery.
 */
export const EMPTY_RESPONSE_ERROR = "Model returned an empty response twice";
export const EMPTY_TOOL_USE_ERROR = "Model returned tool_use without a tool call twice";
export const FORWARDED_EMPTY_RESPONSE_ERROR = "Model returned an empty response after streaming thinking";
export const FORWARDED_EMPTY_TOOL_USE_ERROR = "Model returned tool_use without a tool call after streaming thinking";
