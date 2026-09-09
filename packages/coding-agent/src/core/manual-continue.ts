/**
 * The bare "." manual-continue shortcut.
 *
 * Submitting "." alone on a session that already has messages resumes the
 * agent's most recent intent: no user message is created or rendered. Instead
 * the directive below is delivered as a hidden custom message
 * (customType "manual-continue", display false) that drives the next turn —
 * `AgentSession.prompt()` routes it through `sendCustomMessage`, so an idle
 * session starts a turn and a streaming session steers or follows up.
 */

export const MANUAL_CONTINUE_CUSTOM_TYPE = "manual-continue";

export const MANUAL_CONTINUE_DIRECTIVE = `<system-notice>
Continue.

Resume the most recent intent and complete the unfinished work.
If you were interrupted mid-step, resume exactly where you stopped.
Never pause to summarize progress, re-confirm the plan, or ask whether to proceed; continue.
</system-notice>`;
