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
 * logic can also serve a caller-owned RPC transport. This file owns exactly the
 * process-level concerns that a per-connection handler must NOT
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
 * | `get_protocol_info` | `observe?` (an observing read never counts as host activity)                                   | `{ protocolVersion: 1, serverVersion, capabilities, mode: "classic"|"multi", instanceId, generation, engineVersion, engineOrdinal, launch_profile, memory_pressure? }` | Answered in BOTH modes; side-effect-free capability probe. The identity fields name the host process (`instanceId`), its daemon generation, its build (`engineVersion`, and `engineOrdinal` = `[y, m, d, postRelease, buildEpoch]`) and what it was launched with (`launch_profile { profile_id, core }`). Compatibility and upgrade decisions use `protocolVersion` + `capabilities` + `engineOrdinal`; `serverVersion` is informational and is NEVER compared for compatibility. |
 * | `open_session`    | `sessionPath?`, `cwd?`, `provider?`, `modelId?`, `thinkingLevel?`, `permissionPreset?`, `retain_on_disconnect?`, `kind?`, `context?`, `auto_title?`, `durableSessionId?`, `promptSurface?` (all optional; paths MUST be absolute) | `{ sessionId, state: RpcSessionState, attached?: boolean }` | `sessionPath` = today's `--session` semantics (open-if-exists else create persisting there); `provider`/`modelId` applied only on create (resume restores the session's model); params form the immutable launch profile (D8). `retain_on_disconnect: true` (default false, host capability `retain_on_disconnect`) makes a dropped connection detach instead of closing the session. `kind: "interactive"|"worker"` (default `interactive`, host capability `session_kind`) sets the session's visibility class. `context` (host capability `session_context`) is an opaque `Record<string,string>` the host never interprets: at most 32 keys matching `^[a-z][a-z0-9_]*$`, each value <= 16 KiB, <= 32 KiB of JSON in total; it reaches that session's extensions as `pi.sessionContext` and nothing else. `auto_title` (host capability `auto_title_per_session`) opts this session into or out of engine-side titling; omitted keeps the host `--auto-title-sessions` / appMode default. |
 * | `close_session`   | `sessionId`                                                                                    | `{}`                                            | `unknown_session` when the requesting connection never attached to that handle (a close releases the CALLER's attachment). Otherwise aborts active work and awaits teardown for the host grace window, then force-releases; the first closer's response is the LAST record tagged with that handle, while concurrent closes join and receive targeted success responses. |
 * | `list_sessions`   | `include_workers?` (default false), `observe?`                                                  | `{ sessions: [{ sessionId, durableSessionId, sessionPath, cwd, name, status, attachments, kind, context? }] }` | Includes `opening`/`closing` entries with their status; `attachments` is the live client count (`0` = retained, detached). `kind: "worker"` rows are omitted unless `include_workers: true`, and `context` is published ONLY on that listing. |
 * | `get_steering_messages` / `get_follow_up_messages` / `clear_queue` | queue read or clear parameters | host-authoritative queue values | Interactive attach clients must not read bootstrap queues. |
 * | `abort_branch_summary` / `record_bash_result` / `set_label` | narrow mutation payloads | `{}` | Routes interactive runtime mutations to the owning host session. |
 * | every existing command | + `sessionId` (REQUIRED in multi mode)                                                      | unchanged                                       | Routed to that session. |
 *
 * Identities (D6): response-level `sessionId` = opaque routing handle, unique per
 * process epoch, ephemeral (dies with the child). `state.sessionId` = durable
 * JSONL session identity (what a resume cursor stores today). `list_sessions`
 * exposes both. Clients store both, discard routing handles on child exit, verify
 * only durable ids against cursors.
 *
 * A client that already owns a stable record id for the conversation may CHOOSE the
 * durable id instead of mapping to a host-minted one: `open_session.durableSessionId`
 * (host capability `durable_session_id`) creates the session under that id. It is named
 * `durableSessionId` and not `sessionId` precisely because the routing envelope carries
 * `sessionId` on every established command and this value is not a routing handle. It
 * applies to CREATE only - re-opening an existing `sessionPath` keeps that file's header
 * id, so identity is never rewritten by a resume.
 *
 * `open_session.promptSurface` (`terminal` | `app` | `chat`, host capabilities `prompt_surface` and
 * `prompt_surface_chat`) builds that
 * session's system prompt for where its replies render; omitted, the host's `SENPI_PROMPT_SURFACE`
 * decides. An attach naming another surface rebuilds the live session's prompt.
 *
 * Stable error codes (in the response `error` field, machine-matchable):
 * `unknown_session`, `session_closing`, `session_path_in_use`, `session_held`
 * (a live holder outside this daemon family; `errorData: { holders: [{ pid, cwd? }] }`),
 * `missing_session_id`
 * (session-scoped command without `sessionId` in multi mode), `multi_session_disabled`
 * (`open_session` in classic mode), `invalid_path` (relative `sessionPath`/`cwd`),
 * `open_failed: <detail>`, `invalid_session_context: <detail>` (a `context` past a
 * documented cap), `invalid_session_kind: <detail>` (a `kind` that is neither
 * `interactive` nor `worker`), `invalid_launch_profile: <detail>` (a non-boolean
 * `auto_title`, or a `promptSurface` other than `terminal`/`app`/`chat`), `invalid_session_id: <detail>` (a `durableSessionId` that is not a
 * legal session id), `session_id_in_use` (a `durableSessionId` a LIVE session already
 * holds).
 *
 * Tagging: every response/event/`extension_ui_request` belonging to a session
 * carries top-level `sessionId` (routing handle). `get_protocol_info`/
 * `list_sessions` responses are untagged. Classic mode: nothing tagged
 * (byte-identical).
 *
 * Lifecycle visibility: content-free lifecycle records are broadcast to every
 * connection, EXCEPT `session_closed` and `session_parked` for a `kind: "worker"`
 * session, which are delivered only to the connections attached to that session.
 * `session_parked { sessionId, sessionPath }` replaces `session_closed` when the
 * idle sweep parks a session opened with `retain_on_disconnect`: the routing handle
 * is released, the session itself reopens by `sessionPath`.
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
 * held → `session_path_in_use`; a reservation held by a session whose teardown is
 * already in flight is WAITED OUT on the in-process runtime (bounded by the close
 * grace window) and the path then opens fresh. `close_session` on
 * unknown/already-closed, or from a connection that never attached to that handle →
 * `unknown_session` error. Request `id`s are client-owned; the server echoes them
 * without dedup.
 *
 * Full prose docs: `packages/coding-agent/docs/rpc.md` (Multi-session mode).
 */

import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { envValue } from "../../core/brand.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { toJsonEvent } from "../json-event.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "./connection-handler.ts";
import { parseClientCapabilities } from "./custom-capability.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "./jsonl.ts";
import { createRpcShutdown } from "./shutdown.ts";

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
		writeRaw: (chunk) => {
			const linearized = chunk
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const value = JSON.parse(line) as { type?: string };
					return JSON.stringify(value.type === "message_update" ? toJsonEvent(value as AgentSessionEvent) : value);
				})
				.join("\n");
			writeRawStdout(linearized.length > 0 ? `${linearized}\n` : "");
		},
		waitForBackpressure: waitForRawStdoutBackpressure,
	};

	// Client capability flags reach this single-connection stdio host via the
	// SENPI_RPC_CLIENT_CAPABILITIES env var (comma-separated). A launcher can set
	// it from a client handshake; a plain stdio client that sets nothing gets
	// byte-identical default behavior.
	const capabilities = parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES"));
	const handler = createRpcConnectionHandler(runtimeHost, sink, { capabilities, retryFallbackCommand: true });

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

	const shutdown = createRpcShutdown(
		async (signal) => {
			for (const cleanup of signalCleanupHandlers) {
				cleanup();
			}
			await handler.dispose();
			detachInput();
			process.stdin.pause();
			if (signal !== "SIGTERM") {
				await flushRawStdout();
			}
		},
		(exitCode) => process.exit(exitCode),
	);

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
		const detachJsonl = attachJsonlLineReader(
			process.stdin,
			(line) => {
				void handleInputLine(line);
			},
			{
				maxLineLength: MAX_RPC_LINE_CHARACTERS,
				onOversizedLine: () => {
					writeRawStdout(
						serializeJsonLine({
							type: "response",
							command: "parse",
							success: false,
							error: `RPC input line exceeds ${MAX_RPC_LINE_CHARACTERS} characters.`,
						}),
					);
					void waitForRawStdoutBackpressure();
				},
			},
		);
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
