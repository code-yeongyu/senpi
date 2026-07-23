/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 *
 * This is the single-connection stdio host. The RPC command loop, extension-UI
 * bridge, and event subscription live in `connection-handler.ts` so the same
 * logic can also serve one socket connection in the neo daemon. This file owns
 * exactly the process-level concerns that a per-connection handler must NOT
 * touch: stdout takeover, stdin wiring, signal handlers, and process exit.
 *
 * ── Multi-session mode (`--multi-session`) ─────────────────────────────────
 *
 * Startup: `senpi --mode rpc --multi-session` → NO default session is constructed
 * (no default `AgentSessionRuntime`, no default extension/watcher load). Classic
 * `senpi --mode rpc` is byte-identical to today. Mode is fixed at process start;
 * there is no runtime transition.
 *
 * D1 normative table (multi-session mode):
 *
 * | Command          | Params                                                                                          | Success data                                    | Notes |
 * | ---------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----- |
 * | `get_protocol_info` | -                                                                                             | `{ protocolVersion: 1, capabilities: ["multi_session"], mode: "classic"|"multi" }` | Answered in BOTH modes; side-effect-free; THE capability probe. |
 * | `open_session`    | `sessionPath?`, `cwd?`, `provider?`, `modelId?`, `thinkingLevel?`, `permissionPreset?` (all optional; paths MUST be absolute) | `{ sessionId, state: RpcSessionState }`         | `sessionPath` = today's `--session` semantics (open-if-exists else create persisting there); `provider`/`modelId` applied only on create (resume restores the session's model); params form the immutable launch profile (D8). |
 * | `close_session`   | `sessionId`                                                                                    | `{}`                                            | Aborts active work, awaits agent idle + settled persistence, flushes queued events, detaches subscriptions; its response is the LAST record tagged with that handle — no events after (test-pinned). |
 * | `list_sessions`   | -                                                                                               | `{ sessions: [{ sessionId, durableSessionId, sessionPath, cwd, name, status }] }` | Includes `opening`/`closing` entries with their status. |
 * | every existing command | + `sessionId` (REQUIRED in multi mode)                                                      | unchanged                                       | Routed to that session. |
 *
 * Identities (D6): response-level `sessionId` = opaque routing handle, unique per
 * process epoch, ephemeral (dies with the child). `state.sessionId` = durable
 * JSONL session identity (what a resume cursor stores today). `list_sessions`
 * exposes both. Clients store both, discard routing handles on child exit, verify
 * only durable ids against cursors.
 *
 * Stable error codes (in the response `error` field, machine-matchable):
 * `unknown_session`, `session_closing`, `session_path_in_use`, `missing_session_id`
 * (session-scoped command without `sessionId` in multi mode), `multi_session_disabled`
 * (`open_session` in classic mode), `invalid_path` (relative `sessionPath`/`cwd`),
 * `open_failed: <detail>`.
 *
 * Tagging: every response/event/`extension_ui_request` belonging to a session
 * carries top-level `sessionId` (routing handle). `get_protocol_info`/
 * `list_sessions` responses are untagged. Classic mode: nothing tagged
 * (byte-identical).
 *
 * Ordering guarantee (D9): strict FIFO per session; one total stdout order;
 * cross-session order unspecified; fair round-robin between sessions' queued
 * complete records; NO cross-session batch coalescing (per-session event buffers;
 * the process-wide single-array coalescer in `event-output-buffer.ts` must not
 * merge records of different sessions into one write). Starvation freedom is NOT
 * promised (single pipe); a giant tool record delays others — bounded only by
 * record completion.
 *
 * Duplicate/idempotency: duplicate `open_session` while a path reservation is
 * held → `session_path_in_use`. `close_session` on unknown/already-closed →
 * `unknown_session` error. Request `id`s are client-owned; the server echoes them
 * without dedup.
 *
 * Full prose docs: `packages/coding-agent/docs/rpc.md` (Multi-session mode).
 */

import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "./connection-handler.ts";
import { parseClientCapabilities } from "./custom-capability.ts";
import { attachJsonlLineReader } from "./jsonl.ts";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();

	const sink: RpcConnectionSink = {
		writeRaw: writeRawStdout,
		waitForBackpressure: waitForRawStdoutBackpressure,
	};

	// Client capability flags reach this single-connection stdio host via the
	// SENPI_RPC_CLIENT_CAPABILITIES env var (comma-separated). The neo daemon sets
	// it when spawning a per-connection child from the handshake's capabilities; a
	// plain stdio client that sets nothing gets byte-identical default behavior.
	const capabilities = parseClientCapabilities(process.env.SENPI_RPC_CLIENT_CAPABILITIES);
	const handler = createRpcConnectionHandler(runtimeHost, sink, { capabilities });

	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await handler.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	const handleInputLine = async (line: string): Promise<void> => {
		await handler.handleInputLine(line);
		if (handler.isShutdownRequested()) {
			await shutdown();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
