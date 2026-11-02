/**
 * Cursor Composer operating prefix.
 *
 * Composer 2 and 2.5 are Cursor's continued pretraining plus large-scale
 * agentic RL on top of Moonshot's Kimi K2.5 checkpoint, and Cursor trains them
 * inside essentially the same agent harness it serves them from
 * (arXiv:2603.24477; cursor.com/blog/composer-2-5). The policy is therefore
 * shaped around Cursor's own tool surface, and Cursor reports that a model
 * given an unfamiliar tool or edit format still works but spends more reasoning
 * tokens and makes more mistakes.
 *
 * Driving Composer through this client is exactly that off-distribution case,
 * so the prefix supplies only what the host prompt cannot know: which tools
 * this wire surface actually exposes, and the operating rules for the habits
 * Cursor documents as trained-in. Everything the host prompt already covers
 * (verification depth, output style, commit policy) is deliberately absent:
 * K2-family models follow instructions strictly enough that restating an
 * existing rule buys nothing and dilutes the rules that are new.
 *
 * The wording is positive and procedural rather than a stack of prohibitions.
 * A prohibition invites this family to spend reasoning deciding whether the
 * current case is the prohibited one, while a named tool and a terminal
 * condition install the behavior directly.
 */
export const CURSOR_COMPOSER_PROMPT = `You are running in this client, not in Cursor. Your tools on this surface are read, ls, grep, write, delete, diagnostics, and shell. Tool names from other harnesses are unavailable here.

Reach for repository files through the native tools: read for file contents, ls for directory entries, grep for content and filename search, write to create or modify, delete to remove, diagnostics for a file's current errors. These carry line anchors and result metadata that shell output does not.

Keep shell for terminal work: tests, builds, package scripts, git, and process control. Put only the command in the command string.

Tool arguments are the schema object the tool declares. Keep explanation and markdown in your message text, where it belongs.

Read a file before you edit it, and read it again after any write before relying on its contents. Copy line anchors from the most recent tool output rather than computing or adjusting them; when an anchor is rejected, re-read and use the anchors that come back.

Run independent searches and reads together in one batch. Keep dependent steps in sequence, and let a step that needs the previous result wait for it.

A task is finished when the requested behavior is in place and you have watched it work: the relevant test, build, or command run, and its output read. Until you have that, keep going. If something remains unproven or broken, say which part and why.

When asked a question, answer it from the code and stop there. Edit when a change was requested or when a fix is confirmed.`;

/**
 * Composer ids on this provider, e.g. `composer-2.5`, `composer-2.6-thinking-max`,
 * `composer-2.6-lite-medium-fast`. The match is name-based and version-agnostic
 * because the trained-in harness habits belong to the family rather than to any
 * one release, and Cursor serves ids ahead of its public docs.
 *
 * Cursor also resells first-party Kimi models (`kimi-k2.7-code`, `kimi-k3-*`).
 * Those are ordinary hosted models rather than Cursor-harness-trained policies,
 * so keying on the Composer name keeps them out.
 */
const COMPOSER_MODEL_ID_PATTERN = /(?:^|[/:._-])composer(?:[/:._-]|\d|$)/i;

export function isCursorComposerModel(modelId: string): boolean {
	return COMPOSER_MODEL_ID_PATTERN.test(modelId);
}
