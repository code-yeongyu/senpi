/**
 * Worker half of claude-sdk-oauth-reattach-spike.mjs.
 *
 * Runs one streaming-input query (optionally with `resume: <sessionId>` and/or
 * an env-scoped CLAUDE_CONFIG_DIR), plays the requested prompts, and reports
 * the session id, coherence, and prompt-cache usage back to the supervisor.
 * Runs inside a forked child so "resume after the owning process exited" is a
 * real process death, not a closed handle.
 */

import { randomUUID } from "node:crypto";
import {
	assistantText,
	claudeExecutable,
	closeQuietly,
	controlledInput,
	importClaudeSdk,
	managedEnvironment,
	userMessage,
	withTimeout,
} from "./claude-sdk-oauth-spike-support.mjs";

export const TOKEN_PROMPT = (token) => `Remember this token for later: ${token}. Reply with exactly: ACK`;

function readUsage(message) {
	const usage = message?.usage ?? message?.message?.usage;
	if (!usage) return undefined;
	return {
		input: usage.input_tokens ?? 0,
		cacheRead: usage.cache_read_input_tokens ?? 0,
		cacheCreation: usage.cache_creation_input_tokens ?? 0,
	};
}

/** Merge per-field by max: a later message carrying no cache fields must not
 * overwrite an earlier message's cacheRead evidence with zeros. */
function mergeUsage(current, next) {
	if (!next) return current;
	if (!current) return next;
	return {
		input: Math.max(current.input, next.input),
		cacheRead: Math.max(current.cacheRead, next.cacheRead),
		cacheCreation: Math.max(current.cacheCreation, next.cacheCreation),
	};
}

/** Static read of a session transcript under whatever config root this process has. */
async function staticRead(sessionId) {
	const sdk = await importClaudeSdk();
	try {
		const info = await sdk.getSessionInfo(sessionId);
		const messages = await sdk.getSessionMessages(sessionId, { includeSystemMessages: true });
		return { found: info !== undefined || messages.length > 0 };
	} catch (error) {
		// A read FAILURE (SDK method missing, permission denied, malformed
		// response) is not evidence of absence — report it separately so the
		// config-root verdict cannot mistake an infrastructure error for
		// "not found under this root".
		return { found: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * @param {{access: string, prompts?: string[], resume?: string, configDir?: string,
 *          expectToken?: string, staticRead?: string, staticOnly?: boolean}} request
 */
export async function runTurns(request, onStream) {
	const result = { sessionId: null, coherent: false, usage: undefined };
	// An absent configDir must mean the SDK DEFAULT root: an operator-set
	// CLAUDE_CONFIG_DIR inherited from the spike's shell would silently
	// re-address the "default-root" reads and corrupt the config-root verdict.
	if (request.configDir) process.env.CLAUDE_CONFIG_DIR = request.configDir;
	else delete process.env.CLAUDE_CONFIG_DIR;
	if (request.staticRead) {
		const read = await staticRead(request.staticRead);
		result.staticFound = read.found;
		if (read.error) result.staticError = read.error;
	}
	// A static-only probe answers "is this session visible under this config
	// root?" without spawning Claude Code or spending quota at all.
	if (request.staticOnly) {
		result.coherent = true;
		return result;
	}

	// Setup failures (SDK import, executable resolution, query construction)
	// attach to the result like turn-phase failures: the supervisor's verdicts
	// need the static-read evidence even when setup fails.
	let query;
	try {
		({ query } = await importClaudeSdk());
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error);
		return result;
	}
	const prompts = [...request.prompts];
	// Count BEFORE the initial shift: every requested prompt — including the
	// first — must reach a successful terminal result for the run to be whole.
	const expectedTurns = prompts.length;
	const input = controlledInput(userMessage(prompts.shift(), randomUUID()));
	let stream;
	try {
		const options = {
			model: "claude-haiku-4-5",
			tools: [],
			permissionMode: "dontAsk",
			settingSources: [],
			systemPrompt: "Answer briefly. Obey the exact reply format the user asks for.",
			pathToClaudeCodeExecutable: claudeExecutable(),
			env: managedEnvironment(request.access, request.configDir ? { CLAUDE_CONFIG_DIR: request.configDir } : {}),
		};
		if (request.resume) options.resume = request.resume;
		stream = query({ prompt: input, options });
	} catch (error) {
		input.close();
		result.error = error instanceof Error ? error.message : String(error);
		return result;
	}
	// Hand the live stream to the worker's exit hook so a dying worker reaps
	// its Claude Code subprocess instead of orphaning it.
	onStream?.(stream);
	let completedTurns = 0;

	const drain = (async () => {
		const sessionIds = new Set();
		for await (const message of stream) {
			// Record EVERY session id the stream reports: a mid-run lineage split
			// must surface to the supervisor, not hide behind the first init id.
			if (typeof message.session_id === "string") sessionIds.add(message.session_id);
			if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
				result.sessionId ??= message.session_id;
			}
			if (message.type === "assistant") {
				// An assistant-level SDK failure must fail the turn, not pass
				// through as usage/coherence evidence. On a resume, a synthetic
				// assistant message is the cross-account/session-invisibility
				// denial shape, so it maps to the denial signal.
				if (message.error) throw new Error("assistant_error");
				if (message.message?.model === "<synthetic>") {
					throw new Error(request.resume ? "resume_failed" : "synthetic_assistant");
				}
				// Pass the whole message and MERGE by max per field: a later message
				// carrying no cache fields must not zero out earlier cacheRead
				// evidence (the ratio would fall back to 0.00).
				result.usage = mergeUsage(result.usage, readUsage(message));
				if (request.expectToken && assistantText(message).includes(request.expectToken)) result.coherent = true;
			}
			if (message.type === "auth_status" && message.error) throw new Error("authentication_failed");
			if (message.type !== "result") continue;
			// Result envelopes can carry usage directly — merge before the gates.
			result.usage = mergeUsage(result.usage, readUsage(message));
			// A 401/refusal arrives as subtype:"success" with is_error:true; that
			// shape on a resume IS the addressing/auth denial (resume_failed).
			// Any other non-success (quota, refusal, content filter) is a
			// turn-level error and must NOT be folded into the denial signal.
			if (message.subtype !== "success" || message.is_error === true) {
				const reason =
					message.is_error === true && message.subtype === "success"
						? "result_error"
						: (message.subtype ?? "result_error");
				if (request.resume) {
					// resume_failed is reserved for the documented denial shape
					// (subtype:success + is_error:true — a refusal-class envelope).
					// A non-success subtype (quota/execution/timeout) is a turn-level
					// failure and must never read as an addressing/auth denial.
					const denial = message.subtype === "success" && message.is_error === true;
					throw new Error(denial ? "resume_failed" : `resume_error_${reason}`);
				}
				throw new Error(reason);
			}
			completedTurns += 1;
			if (prompts.length === 0) break;
			input.push(userMessage(prompts.shift(), randomUUID()));
		}
		// An iterator that ends before every requested prompt completed its
		// terminal result means the seed/resume is incomplete — never accept it.
		if (completedTurns < expectedTurns) throw new Error("turns_incomplete");
		if (sessionIds.size > 1) throw new Error("lineage_split");
	})();

	try {
		await withTimeout(drain, "worker_turns", 210_000);
	} catch (error) {
		// Attach the error to the result instead of throwing: the supervisor's
		// verdicts need the static-read evidence (staticFound/staticError) even
		// when the turn phase fails — dropping it would make contradictory
		// evidence indistinguishable from absence.
		result.error = error instanceof Error ? error.message : String(error);
	} finally {
		input.close();
		closeQuietly(stream);
	}
	if (!request.expectToken) result.coherent = true;
	return result;
}
