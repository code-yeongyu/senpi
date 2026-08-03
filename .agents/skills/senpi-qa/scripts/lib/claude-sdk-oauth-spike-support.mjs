/**
 * Shared harness for the live claude-sdk-oauth spikes (Wave A todos 2-4).
 *
 * Every spike is gated on SENPI_LIVE_CLAUDE_SDK_OAUTH=1 and reads its OAuth
 * credential from the seeded sandbox pointed at by SENPI_CODING_AGENT_DIR.
 * Nothing here ever prints token material.
 */

import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./common.mjs";

// Canonical timeout helper lives in with-timeout.mjs; re-exported so the spikes
// share ONE race-a-promise-against-a-timer implementation instead of drifting copies.
export { withTimeout } from "./with-timeout.mjs";

export const LIVE_GATE = "SENPI_LIVE_CLAUDE_SDK_OAUTH";

/** Print SKIPPED + exit 0 unless the live gate is set. Keeps default suites token-free. */
export function requireLiveGate() {
	if (process.env[LIVE_GATE] === "1") return;
	// writeSync: a forced exit after an async pipe write can truncate the line.
	writeSync(1, `SKIPPED: set ${LIVE_GATE}=1 to run the live spike\n`);
	process.exit(0);
}

/** Sandbox agent dir (SENPI_CODING_AGENT_DIR); rejects when absent. */
export function requireSandbox() {
	const sandbox = process.env.SENPI_CODING_AGENT_DIR;
	if (sandbox) return sandbox;
	writeSync(2, "REJECTED signal=sandbox_missing\n");
	process.exit(2);
}

// Credential loading lives in claude-sdk-oauth-spike-credentials.mjs (split
// out so this module stays under the 250 pure-LOC ceiling); re-exported so
// existing spike imports keep working.
export { loadCredential, loadCredentialStrict } from "./claude-sdk-oauth-spike-credentials.mjs";

/** Sanitize any signal/reason into the fixed terminal-line vocabulary shape. */
export function safeSignal(value) {
	return String(value ?? "unknown")
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "_")
		.slice(0, 80);
}

/**
 * Remove every ambient Anthropic/Claude/senpi credential channel from `env`.
 *
 * Known credential names are not enough: token-bearing SENPI_* variables
 * (spike harness internals) would otherwise be inherited by the Claude Code
 * subprocess, so the whole SENPI_ prefix is stripped — matching the
 * production OAuth lane, which never forwards senpi internals either.
 * Callers re-add exactly what the child needs via the `extra` argument.
 */
export function stripCredentialEnvironment(env) {
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	delete env.ANTHROPIC_OAUTH_TOKEN;
	delete env.ANTHROPIC_BASE_URL;
	delete env.ANTHROPIC_CUSTOM_HEADERS;
	delete env.CLAUDECODE;
	delete env.CLAUDE_CODE_USE_BEDROCK;
	delete env.CLAUDE_CODE_USE_FOUNDRY;
	delete env.CLAUDE_CODE_USE_GATEWAY;
	delete env.CLAUDE_CODE_USE_VERTEX;
	for (const name of Object.keys(env)) {
		if (/^CLAUDE_CODE_OAUTH_TOKEN(?:_\d+)?$/.test(name)) delete env[name];
		if (name.startsWith("SENPI_")) delete env[name];
	}
	return env;
}

/** Child env with every ambient credential channel removed and the spike token pinned. */
export function managedEnvironment(access, extra = {}) {
	const env = stripCredentialEnvironment({ ...process.env });
	// CLAUDE_CONFIG_DIR is a config-root channel, not a credential, but an
	// operator-set value would silently re-address every grandchild, so it is
	// cleared here too; callers re-add a scoped root deliberately via `extra`.
	delete env.CLAUDE_CONFIG_DIR;
	// The token pin is applied LAST so nothing a caller re-adds through `extra`
	// can silently overwrite it — the pin is the function's contract.
	return { ...env, ...extra, CLAUDE_CODE_OAUTH_TOKEN: access };
}

/** SDKUserMessage envelope for streaming input. */
export function userMessage(text, uuid) {
	return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid };
}

/** Push-driven async iterable used as a streaming-input prompt. */
export function controlledInput(initialMessage) {
	const pending = initialMessage ? [initialMessage] : [];
	const waiters = [];
	let closed = false;
	return {
		push(message) {
			// A closed input is terminal: late pushes (timeout/cleanup races) must
			// not be yielded to the query after close().
			if (closed) return;
			const waiter = waiters.shift();
			if (waiter) waiter({ value: message, done: false });
			else pending.push(message);
		},
		close() {
			closed = true;
			// Buffered-but-undelivered prompts must not reach the query after
			// close: cleanup racing a turn boundary would otherwise drive one
			// more SDK turn after the spike considers the stream closed.
			pending.length = 0;
			for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
		},
		[Symbol.asyncIterator]() {
			return {
				next() {
					const message = pending.shift();
					if (message) return Promise.resolve({ value: message, done: false });
					if (closed) return Promise.resolve({ value: undefined, done: true });
					return new Promise((resolve) => waiters.push(resolve));
				},
			};
		},
	};
}

function codingAgentRequire() {
	return createRequire(join(repoRoot(), "packages/coding-agent/package.json"));
}

/**
 * Import the SAME @anthropic-ai/claude-agent-sdk build senpi runs against.
 * A bare specifier would resolve against the script's own directory and can
 * pick up an unrelated globally installed SDK.
 */
export async function importClaudeSdk() {
	return import(pathToFileURL(codingAgentRequire().resolve("@anthropic-ai/claude-agent-sdk")).href);
}

/**
 * Resolve the real Claude Code binary the same way senpi's executable.ts does
 * (platform package first, CLAUDE_CODE_EXECUTABLE override wins). Resolved here
 * rather than by importing the TypeScript module so the spikes run under plain
 * `node`, without tsx.
 */
export function claudeExecutable() {
	const override = process.env.CLAUDE_CODE_EXECUTABLE;
	if (override) return override;
	const require_ = codingAgentRequire();
	const extension = process.platform === "win32" ? ".exe" : "";
	const candidates =
		process.platform === "linux"
			? [
					`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${extension}`,
					`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${extension}`,
				]
			: [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${extension}`];
	for (const candidate of candidates) {
		try {
			return require_.resolve(candidate);
		} catch {
			// try the next platform package
		}
	}
	throw new Error("claude_binary_not_found");
}

/** Concatenated assistant text of an SDK assistant message. */
export function assistantText(message) {
	if (message?.type !== "assistant" || !Array.isArray(message.message?.content)) return "";
	return message.message.content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Redact known secret values from an arbitrary error string.
 *
 * safeSignal() is a shape sanitizer, NOT a secret redactor: hyphenated
 * credential material and generated recall tokens survive it. Any error text
 * that could echo a prompt or a credential must pass through here first.
 */
export function redactSecrets(text, secrets = []) {
	let out = String(text ?? "");
	for (const secret of secrets) {
		// Every non-empty secret is redacted — a length cutoff would let short
		// credentials through the no-token-material contract.
		if (typeof secret === "string" && secret.length > 0) out = out.split(secret).join("[redacted]");
	}
	return out;
}

/** Reject with a sanitized, secret-redacted signal and exit 2. */
export function reject(signal, extra = "", secrets = []) {
	// writeSync: the REJECTED line is the spike's machine-readable contract and
	// a forced exit after an async pipe write can truncate it. The extra detail
	// is sanitized/redacted by the helper itself — no caller may append raw
	// error text to the contract line.
	const detail = extra ? ` ${safeSignal(redactSecrets(extra, secrets))}` : "";
	writeSync(2, `REJECTED signal=${safeSignal(redactSecrets(signal, secrets))}${detail}\n`);
	process.exit(2);
}

/** Close a query handle without letting a close error mask the real outcome. */
export function closeQuietly(handle) {
	try {
		handle?.close?.();
	} catch {
		// best-effort teardown
	}
}

/**
 * Guarded spike query setup shared by the live spikes.
 *
 * SIGINT/SIGTERM handlers are installed BEFORE setup so the whole arm
 * lifecycle is covered (a signal during SDK import/binary resolution would
 * otherwise bypass cleanup); they tolerate a not-yet-created input/stream.
 * SDK import, missing-binary, and query-construction failures exit through
 * the sanitized REJECTED contract, never a raw exit 1. The returned disarm()
 * removes the handlers at arm end so a stale listener cannot fire during a
 * later arm and exit before that arm's stream is reaped.
 */
export async function startGuardedQuery({ firstMessage, options, secrets }) {
	let input;
	let stream;
	const signalHandlers = [];
	for (const signal of ["SIGINT", "SIGTERM"]) {
		const handler = () => {
			input?.close();
			closeQuietly(stream);
			reject(`interrupted_${signal.toLowerCase()}`, "", secrets);
		};
		process.once(signal, handler);
		signalHandlers.push([signal, handler]);
	}
	try {
		const { query } = await importClaudeSdk();
		input = controlledInput(firstMessage);
		// The executable is resolved INSIDE the guarded path: resolving it at the
		// call site would throw a missing-binary error outside the REJECTED
		// contract.
		const resolved = {
			...options,
			pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? claudeExecutable(),
		};
		stream = query({ prompt: input, options: resolved });
	} catch (error) {
		reject(error instanceof Error ? error.message : String(error), "", secrets);
	}
	return {
		input,
		stream,
		disarm() {
			for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
		},
	};
}
