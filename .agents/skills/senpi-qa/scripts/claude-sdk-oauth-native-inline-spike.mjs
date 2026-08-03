#!/usr/bin/env node
/**
 * Live spike: in-session mechanisms of one resident streaming-input query
 * (Wave A todo 2).
 *
 * One query, four turns:
 *   turn 1  normal exchange, records the system/init session_id + capabilities
 *   setModel(<other claude model>) between turns
 *   turn 2  asserts the SAME session_id and that the response model changed
 *   turn 3  interrupted mid-flight — the interrupt is issued from the FIRST
 *           streamed content delta, while the model is still producing output,
 *           so the spike actually exercises interruption instead of cancelling
 *           an already-finished turn; the receipt shape is recorded
 *           (still_queued present => v1, undefined => legacy, throw => failed)
 *   turn 4  continuation on the SAME query; coherence is proven by the model
 *           recalling the turn-1 token
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-native-inline-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED setmodel=<ok|absent> interrupt_receipt=<v1|legacy> continue=coherent"
 *   exit 2 "REJECTED signal=<sanitized>"
 * An interrupt that never happened REJECTS (interrupt_failed) instead of being
 * reported as a legacy receipt — a spike that proved nothing must not ACCEPT.
 * Never prints token material.
 */
import { randomUUID } from "node:crypto";
import {
	assistantText,
	closeQuietly,
	loadCredential,
	managedEnvironment,
	reject,
	requireLiveGate,
	requireSandbox,
	startGuardedQuery,
	userMessage,
	withTimeout,
} from "./lib/claude-sdk-oauth-spike-support.mjs";

requireLiveGate();
const sandbox = requireSandbox();
const loaded = loadCredential(sandbox);
if (loaded.error) reject(loaded.error);

const FIRST_MODEL = "claude-haiku-4-5";
const SECOND_MODEL = "claude-sonnet-4-5";
const MEMORY_TOKEN = `SPIKE_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
// Every reject path that can carry an SDK error string redacts the access
// token and the generated recall token first — safeSignal is a shape
// sanitizer, not a secret redactor.
const SECRETS = [loaded.credential.access, MEMORY_TOKEN];

// Guarded setup + signal-aware cleanup live in spike-support: handlers are
// installed BEFORE setup (a signal during SDK import/binary resolution is
// covered), setup failures exit through the sanitized REJECTED contract, and
// the handlers reap the subprocess before exiting.
const { input, stream, disarm } = await startGuardedQuery({
	firstMessage: userMessage(
		`Remember this token for later: ${MEMORY_TOKEN}. Reply with exactly: ACK`,
		randomUUID(),
	),
	options: {
		model: FIRST_MODEL,
		tools: [],
		permissionMode: "dontAsk",
		settingSources: [],
		includePartialMessages: true,
		systemPrompt: "Answer briefly. Obey the exact reply format the user asks for.",
		env: managedEnvironment(loaded.credential.access),
	},
	secrets: SECRETS,
});

const state = {
	sessionIds: new Set(),
	models: [],
	// "pending" until an interrupt actually resolves; a throw records "failed" so
	// a failed interrupt can never masquerade as a supported legacy receipt.
	interruptReceipt: "pending",
	interruptError: null,
	interruptIssued: false,
	setModelError: false,
	pendingInterruptResult: false,
	coherent: false,
	continuationQueued: false,
	continuationResult: false,
	interruptAbortedEvidence: false,
	failure: null,
	turn: 1,
};
function recordModel(message) {
	if (message.type === "assistant" && typeof message.message?.model === "string") {
		state.models[state.turn] = message.message.model;
	}
}

async function interruptTurn3() {
	if (state.interruptIssued) return;
	state.interruptIssued = true;
	// Mark the pending interrupted result BEFORE awaiting the receipt, and leave
	// state.turn at 3: the counter only advances on terminal results, so the
	// interrupted turn's residual assistant message is recorded as turn 3 (not
	// misfiled as turn 4) and never fed through the turn-4 coherence scan.
	state.pendingInterruptResult = true;
	try {
		const receipt = await stream.interrupt();
		state.interruptReceipt = receipt && Array.isArray(receipt.still_queued) ? "v1" : "legacy";
	} catch (error) {
		// Distinct from "legacy": interruption never happened, so nothing downstream
		// can be trusted and the spike must REJECT rather than ACCEPT. Stop driving
		// the query immediately — queueing the continuation would spend a live
		// model call (and can hang) before the intended interrupt_failed rejection.
		state.interruptReceipt = "failed";
		state.interruptError = error instanceof Error ? error.message : String(error);
		state.pendingInterruptResult = false;
		state.failure ??= "interrupt_failed";
		input.close();
		// Reap the query handle immediately: without this the live query keeps
		// running (and burning quota) until the 240s spike deadline.
		closeQuietly(stream);
		return;
	}
	// The continuation is NOT pushed here: it is queued only when the
	// interrupted turn's terminal result arrives (see the result gate), so the
	// handoff never depends on SDK message-ordering assumptions.
	state.continuationQueued = true;
}

async function consume() {
	for await (const message of stream) {
		// Record the session id from EVERY message that carries one — a lineage
		// split on a non-init message must trip the stability assertion, not
		// slip past an init-only set.
		if (typeof message.session_id === "string") state.sessionIds.add(message.session_id);
		if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
			state.sessionIds.add(message.session_id);
		}
		// Interrupt from the first STREAMED content delta of turn 3: the model is
		// mid-output there. Waiting for the finalized assistant message would cancel
		// an already-complete turn and prove nothing about interruption.
		if (
			state.turn === 3 &&
			message.type === "stream_event" &&
			message.event?.type === "content_block_delta" &&
			!state.interruptIssued
		) {
			await interruptTurn3();
			// A failed interrupt closes the input and the stream: iterating
			// further would surface the SDK's closed-stream rejection as the
			// outcome and bury the actual interrupt_failed signal.
			if (state.failure) break;
			continue;
		}
		if (message.type === "assistant") {
			recordModel(message);
			if (message.error) state.failure ??= "assistant_error";
			if (message.message?.model === "<synthetic>") state.failure ??= "synthetic_assistant";
			if (state.turn === 3 && !state.interruptIssued) {
				// The turn finalized without a single streamed delta to interrupt
				// from. Interrupting now would cancel an already-complete turn, and
				// an accepted receipt would be a false positive — the spike proved
				// nothing about interruption, so it must REJECT.
				state.failure ??= "interrupt_delta_absent";
				break;
			}
			// When the interrupt WAS issued, the residual turn-3 assistant message
			// is expected: it is recorded as turn 3 above and skipped here — never
			// fed through the turn-4 coherence scan below. Its aborted:true marker
			// (sdk.d.ts:2873) is the interrupt-specific evidence that separates a
			// real cancellation from a turn-3 refusal/execution failure.
			if (state.turn === 3) {
				if (message.aborted === true) state.interruptAbortedEvidence = true;
				continue;
			}
			if (state.turn === 4 && assistantText(message).includes(MEMORY_TOKEN)) state.coherent = true;
		}
		if (message.type === "auth_status" && message.error) state.failure ??= "authentication_failed";
		if (message.type !== "result") continue;
		// A 401/refusal arrives as subtype:"success" with is_error:true, so both
		// fields gate the turn.
		const interrupted = state.pendingInterruptResult;
		state.pendingInterruptResult = false;
		if (interrupted) {
			// The interrupted turn's terminal result must be NON-success: a clean
			// success means the turn completed normally and the interrupt cancelled
			// nothing, so the receipt would be a false positive.
			if (message.subtype === "success" && message.is_error !== true) {
				state.failure ??= "interrupt_ineffective";
				break;
			}
			// A non-success alone is not interrupt evidence: a turn-3 refusal or
			// execution failure would also be non-success. The residual assistant
			// message must carry the SDK's aborted:true marker.
			if (!state.interruptAbortedEvidence) {
				state.failure ??= "interrupt_evidence_absent";
				break;
			}
			state.turn = 4;
			// The continuation is queued HERE — after the interrupted turn's
			// terminal result — so turn bookkeeping never assumes the SDK
			// delivers queued input after the current turn's result.
			if (state.continuationQueued) {
				state.continuationQueued = false;
				input.push(
					userMessage(
						"Stop counting. Repeat the token I asked you to remember at the very start, prefixed with RECALL.",
						randomUUID(),
					),
				);
			}
			continue;
		}
		if (message.subtype !== "success" || message.is_error === true) {
			// subtype:"success" + is_error:true (a 401/refusal) must map to
			// result_error, never to signal=success.
			state.failure ??=
				message.is_error === true && message.subtype === "success"
					? "result_error"
					: (message.subtype ?? message.terminal_reason ?? "result_error");
			break;
		}
		if (state.turn === 1) {
			try {
				await stream.setModel(SECOND_MODEL);
			} catch {
				state.setModelError = true;
			}
			state.turn = 2;
			input.push(userMessage("Reply with exactly: SECOND", randomUUID()));
			continue;
		}
		if (state.turn === 2) {
			state.turn = 3;
			input.push(
				userMessage("Count slowly from 1 to 40, one number per line, no other text.", randomUUID()),
			);
			continue;
		}
		if (state.turn === 3) {
			// A turn-3 success that never went through the interrupt path (no
			// delta, no assistant content) means the spike never exercised
			// interruption — reject with the precise signal, not a downstream
			// continuation_incomplete.
			state.failure ??= "interrupt_never_issued";
			break;
		}
		if (state.turn === 4) {
			state.continuationResult = true;
			break;
		}
	}
}

let outcome = null;
try {
	// Await the consumer itself: a rejected consumer surfaces its real error
	// immediately, and withTimeout is what actually bounds a hang.
	await withTimeout(consume(), "spike", 240_000);
} catch (error) {
	outcome = error instanceof Error ? error.message : String(error);
} finally {
	input.close();
	closeQuietly(stream);
	disarm();
}

if (outcome) reject(outcome, "", SECRETS);
// The dedicated interrupt-failure branch runs BEFORE the generic failure
// rejection: state.failure is also set on interrupt failure, and the generic
// branch would otherwise emit a bare interrupt_failed and drop the captured
// (redacted + sanitized) diagnostic.
if (state.interruptReceipt === "failed") {
	// reject() sanitizes and redacts the detail itself — no caller may append
	// raw error text to the contract line.
	reject("interrupt_failed", state.interruptError ?? "", SECRETS);
}
if (state.failure) reject(state.failure, "", SECRETS);
if (state.sessionIds.size !== 1) reject("session_lineage_split");
if (state.interruptReceipt === "pending") reject("interrupt_never_issued");
// A coherent turn-4 assistant message is not enough: the iterator ending
// before turn 4's successful terminal result means the continuation never
// completed, so the spike cannot ACCEPT.
if (!state.continuationResult) reject("continuation_incomplete");
// A failed turn-4 recall means the continuation did not prove continuity —
// the spike must not ACCEPT a degraded continuation as success.
if (!state.coherent) reject("continuation_incoherent", "", SECRETS);

const setModel =
	state.setModelError || state.models[2] === undefined
		? "absent"
		: state.models[2] !== state.models[1]
			? "ok"
			: "absent";
// continue is always coherent here: a failed recall rejected above, so the
// degraded branch is unreachable by construction.
console.log(
	`ACCEPTED setmodel=${setModel} interrupt_receipt=${state.interruptReceipt} continue=coherent`,
);
// exitCode, not exit(): a forced exit can truncate the ACCEPTED line when
// stdout is a pipe; assigning lets Node flush the QA output first.
process.exitCode = 0;
