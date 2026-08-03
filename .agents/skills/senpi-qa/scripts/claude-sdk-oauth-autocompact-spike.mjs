#!/usr/bin/env node
/**
 * Live spike: native auto-compaction on a streaming-input query (Wave A todo 4).
 *
 * Drives resident streaming-input queries whose `autoCompactWindow` is set to
 * the SMALLEST value SDK 0.3.220 accepts (100,000 tokens — the Settings schema
 * is `number().int().min(1e5).max(1e6).optional().catch(void 0)`, so anything
 * smaller is silently dropped and the arm would probe nothing) through the
 * inline settings surface (Options.settings, sdk.d.ts:1875 ->
 * Settings.autoCompactWindow, sdk.d.ts:6325), then overflows that window with a
 * single oversized filler message so auto-compaction cannot be skipped.
 *
 * TWO arms discriminate WHICH switch enables auto-compaction (the todo-4
 * question a single arm cannot answer — a boundary's trigger is "auto" either
 * way):
 *   arm A "keyed":   settings {autoCompactWindow, autoCompactEnabled: true}
 *   arm B "default": settings {autoCompactWindow} only — no enabled key
 * arm B producing an auto boundary means the window key alone suffices
 * (default-on under `settingSources: []`, which is what senpi's options.ts
 * uses); only arm A producing one means the explicit enabled key is required.
 *
 * Also records, per arm: the `compact_boundary` system message as received
 * through the iterator, and post-compaction session-id stability + turn
 * coherence. The manual `/compact` streaming-input fallback (todo 13) is
 * probed once, inside arm A, only when arm A produced no auto boundary.
 * extraArgs is CLI-flags-only (sdk.d.ts:1463-1468) and is deliberately NOT probed.
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-autocompact-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED autocompact=<default-on|settings:autoCompactEnabled|absent> boundary=<received|absent> manual_compact=<slash-ok|absent>"
 *   exit 2 "REJECTED signal=<sanitized>"
 * Never prints token material. Bounded to two ~130k-token stimuli plus one
 * compaction cycle of quota (~2 compaction cycles, per the todo-4 budget).
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

// 100,000 is the minimum autoCompactWindow SDK 0.3.220 honors. The stimulus
// must RELIABLY overflow that window: a repeated phrase compresses under BPE
// ("context filler. " collapses to ~3 tokens per repetition, which would land
// the message BELOW the window and produce a false autocompact=absent), so
// each repetition carries a unique hex segment. Estimates for the varied
// repetition range ~5-7 tokens (compressed prefix + incompressible hex), so
// 24,000 repetitions land ~120-170k tokens by any estimate — comfortably
// over the window, under the 200k context.
const AUTO_COMPACT_WINDOW = 100_000;
const FILLER = "Summarize this instruction back to me in one sentence: ".concat(
	Array.from({ length: 24_000 }, (_, index) => `context filler ${index.toString(16)}${randomUUID().slice(0, 6)}`).join(" "),
);

function nextPrompt(state, probeManual) {
	// Turn 2 is the single oversized stimulus that overflows the 100k window.
	if (state.turn === 1) return FILLER;
	if (state.autoBoundaryTurn !== null || !probeManual || state.manualCompactSent) {
		state.phase = "recall";
		return `Repeat the token I gave you at the very start, prefixed with RECALL.`;
	}
	// Exactly ONE `/compact` may be sent: a second one would compact an
	// already-compacted transcript and make the manual_compact observation
	// unattributable to either send. The manual arm only runs when the
	// oversized stimulus produced no auto boundary.
	state.phase = "manual";
	state.manualCompactSent = true;
	return "/compact";
}

async function runArm({ settings, probeManual }) {
	const token = `COMPACT_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
	// Every reject path that can carry an SDK error string redacts the access
	// token and the generated recall token first — safeSignal is a shape
	// sanitizer, not a secret redactor.
	const secrets = [loaded.credential.access, token];
	// Guarded setup + signal-aware cleanup live in spike-support: handlers are
	// installed BEFORE setup (a signal during SDK import/binary resolution is
	// covered), setup failures exit through the sanitized REJECTED contract,
	// and disarm() removes the handlers at arm end so a stale arm-A listener
	// cannot fire during arm B and exit before arm B's stream is reaped.
	const { input, stream, disarm } = await startGuardedQuery({
		firstMessage: userMessage(`Remember this token for later: ${token}. Reply with exactly: ACK`, randomUUID()),
		options: {
			model: "claude-haiku-4-5",
			tools: [],
			permissionMode: "dontAsk",
			settingSources: [],
			systemPrompt: "Answer briefly. Obey the exact reply format the user asks for.",
			settings,
			env: managedEnvironment(loaded.credential.access),
		},
		secrets,
	});

	const state = {
		sessionIds: new Set(),
		boundaries: [],
		autoBoundaryTurn: null,
		manualCompactSent: false,
		coherent: false,
		recallResult: false,
		failure: null,
		turn: 0,
		phase: "auto",
	};
	async function consume() {
		for await (const message of stream) {
			// Record the session id from EVERY message that carries one — a lineage
			// split during compaction (compact_boundary/result messages) must trip
			// the stability assertion, not slip past an init-only set.
			if (typeof message.session_id === "string") state.sessionIds.add(message.session_id);
			if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
				state.sessionIds.add(message.session_id);
			}
			if (message.type === "system" && message.subtype === "compact_boundary") {
				state.boundaries.push({
					trigger: message.compact_metadata?.trigger ?? "unknown",
					preTokens: message.compact_metadata?.pre_tokens ?? null,
					postTokens: message.compact_metadata?.post_tokens ?? null,
					phase: state.phase,
				});
				if (state.phase !== "manual") state.autoBoundaryTurn ??= state.turn;
			}
			if (message.type === "assistant") {
				if (message.error) state.failure ??= "assistant_error";
				if (message.message?.model === "<synthetic>") state.failure ??= "synthetic_assistant";
				if (state.phase === "recall" && assistantText(message).includes(token)) state.coherent = true;
			}
			if (message.type === "auth_status" && message.error) state.failure ??= "authentication_failed";
			if (message.type !== "result") continue;
			// A 401/refusal arrives as subtype:"success" with is_error:true; that
			// combination must map to result_error, never to signal=success.
			if (message.subtype !== "success" || message.is_error === true) {
				state.failure ??=
					message.is_error === true && message.subtype === "success"
						? "result_error"
						: (message.subtype ?? message.terminal_reason ?? "result_error");
				break;
			}
			state.turn += 1;
			if (state.phase === "recall") {
				// The recall turn's terminal result is what proves the arm completed
				// — a prematurely ended stream must not ACCEPT on prompts alone.
				state.recallResult = true;
				break;
			}
			// nextPrompt() owns the manual->recall transition, so the `/compact`
			// send happens in exactly one place.
			input.push(userMessage(nextPrompt(state, probeManual), randomUUID()));
		}
	}

	let outcome = null;
	try {
		// Await the consumer itself: a rejected consumer surfaces its real error
		// immediately, and withTimeout is what actually bounds a hang.
		await withTimeout(consume(), "spike", 600_000);
	} catch (error) {
		outcome = error instanceof Error ? error.message : String(error);
	} finally {
		input.close();
		closeQuietly(stream);
		disarm();
	}

	if (outcome) reject(outcome, "", secrets);
	if (state.failure) reject(state.failure, "", secrets);
	if (state.sessionIds.size !== 1) reject("session_lineage_split");
	// Coherence is enforced only when compaction actually happened: the arm
	// exists to prove POST-COMPACTION continuity. With no boundary, the recall
	// must survive ~130k tokens of uncompacted filler — a genuinely hard model
	// task whose failure would mask the actual finding (autocompact=absent),
	// so it is recorded in the evidence line but not gated.
	if (!state.coherent && state.boundaries.length > 0) reject("recall_incoherent", "", secrets);
	// A prematurely ended stream (recall prompt pushed, terminal result never
	// received) must not ACCEPT — the arm proved nothing about recall.
	if (!state.recallResult) reject("recall_incomplete", "", secrets);
	return state;
}

const armA = await runArm({
	settings: { autoCompactWindow: AUTO_COMPACT_WINDOW, autoCompactEnabled: true },
	probeManual: true,
});
const armB = await runArm({
	settings: { autoCompactWindow: AUTO_COMPACT_WINDOW },
	probeManual: false,
});

// The verdict reads ONLY the SDK-provided compact_metadata.trigger — never
// the spike's own mutable phase bookkeeping. A boundary whose trigger is
// absent counts toward boundary=received but is attributed to NEITHER arm:
// attributing it via the phase field could misreport a late auto-compaction
// as the /compact send (or vice versa).
const isAutoBoundary = (boundary) => boundary.trigger === "auto";
const isManualBoundary = (boundary) => boundary.trigger === "manual";
const autoA = armA.boundaries.some(isAutoBoundary);
const autoB = armB.boundaries.some(isAutoBoundary);
// arm B (no enabled key) firing proves default-on; only arm A firing proves the
// explicit autoCompactEnabled key is required; neither means absent.
const autocompact = autoB ? "default-on" : autoA ? "settings:autoCompactEnabled" : "absent";
// boundary=received means a compact_boundary was OBSERVED, regardless of
// whether its trigger metadata allowed auto/manual attribution — a
// trigger-absent boundary must never report absent.
const boundary = armA.boundaries.length > 0 || armB.boundaries.length > 0 ? "received" : "absent";
const manual = armA.boundaries.some(isManualBoundary) ? "slash-ok" : "absent";
process.stdout.write(
	`armA boundaries=${JSON.stringify(armA.boundaries)} turns=${armA.turn} coherent=${armA.coherent}\n`,
);
process.stdout.write(
	`armB boundaries=${JSON.stringify(armB.boundaries)} turns=${armB.turn} coherent=${armB.coherent}\n`,
);
console.log(`ACCEPTED autocompact=${autocompact} boundary=${boundary} manual_compact=${manual}`);
// exitCode, not exit(): a forced exit can truncate the per-arm evidence or the
// ACCEPTED line when stdout is a pipe; assigning lets Node flush it first.
process.exitCode = 0;
