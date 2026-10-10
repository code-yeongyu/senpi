/** Short-lived, attach-before-act clients for `senpi host session`. */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { daemonEnvKeys, daemonEnvOverrides, writeDaemonEnvKeys } from "./host-daemon-env.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import { HostEnsureRefusedError } from "./host-decision.ts";
import { endpointKindOfSocket } from "./host-endpoints.ts";
import { type EnsuredHost, ensureHost } from "./host-ensure.ts";
import type { ResolvedHostLaunchSpec } from "./host-launch-spec.ts";
import {
	HOST_EXIT_ERROR,
	HOST_EXIT_OK,
	HOST_EXIT_REFUSED,
	HOST_EXIT_USAGE,
	type HostOutcome,
	refusal,
} from "./host-outcome.ts";
import type { HostTarget } from "./host-runner.ts";
import {
	isTransportGoneError,
	RpcClient,
	type RpcClientEvent,
	RpcCommandError,
	type RpcTransportGoneError,
} from "./rpc-client.ts";
import type { RpcSessionClosedEvent, RpcSessionState } from "./rpc-types.ts";

/** Routing handles last one host epoch; keep a durable id or path across parking and handoff. */
export type SessionRef = string;
type Model = { provider: string; id: string };
export type HostSessionRequest = { target: HostTarget } & (
	| {
			action: "open";
			cwd: string;
			model?: Model;
			name?: string;
			prompt?: string;
			spec: ResolvedHostLaunchSpec;
			launchSpecPath?: string;
	  }
	| { action: "close"; ref: SessionRef }
	| { action: "model"; ref: SessionRef; model: Model }
	| { action: "prompt"; ref: SessionRef; text: string }
	| { action: "steer"; ref: SessionRef; text: string }
	| { action: "abort"; ref: SessionRef }
	| { action: "read"; ref: SessionRef; tail?: number; since?: string; messages: boolean }
	| { action: "state"; ref: SessionRef }
	| { action: "list" }
	| { action: "wait"; ref: SessionRef; until: "idle" | "done"; timeoutMs: number }
);

type SessionRow = Awaited<ReturnType<RpcClient["listSessions"]>>[number];

/** Resolve anew on every invocation: a durable session can have a new routing handle. */
export async function resolveSessionRow(
	client: Pick<RpcClient, "listSessions">,
	ref: SessionRef,
): Promise<SessionRow | undefined> {
	const rows = await client.listSessions();
	return (
		rows.find((row) => row.sessionId === ref) ??
		rows.find((row) => row.durableSessionId === ref) ??
		rows.find((row) => row.name === ref) ??
		rows.find((row) => row.sessionPath !== undefined && samePath(row.sessionPath, ref))
	);
}

function samePath(left: string, right: string): boolean {
	const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
	return canonical(left) === canonical(right);
}

const USAGE_CODES = new Set([
	"missing_session_id",
	"invalid_path",
	"invalid_session_context",
	"invalid_session_kind",
	"invalid_launch_profile",
	"invalid_session_id",
	"invalid_release_reason",
	"empty",
	"unknown_command",
]);
const FAILURE_CODES = new Set(["open_failed", "warm_failed", "release_failed"]);

export function mapError(error: unknown, socket: string): HostOutcome {
	const detail = error instanceof Error ? error.message : String(error);
	if (error instanceof RpcCommandError) {
		const reason = error.errorCode ?? codeFromMessage(detail);
		const exitCode = USAGE_CODES.has(reason)
			? HOST_EXIT_USAGE
			: FAILURE_CODES.has(reason)
				? HOST_EXIT_ERROR
				: HOST_EXIT_REFUSED;
		return {
			exitCode,
			payload: {
				action: exitCode === HOST_EXIT_REFUSED ? "refuse" : "error",
				reason,
				detail,
				socket,
				...(error.errorData !== undefined && { data: error.errorData }),
			},
		};
	}
	return {
		exitCode: HOST_EXIT_ERROR,
		payload: {
			action: "error",
			reason: isTransportGoneError(error) ? "transport_gone" : "host_error",
			detail,
			socket,
		},
	};
}

function codeFromMessage(message: string): string {
	if (message.startsWith("Model not found:")) return "model_not_found";
	if (message.startsWith("Entry not found:")) return "unknown_cursor";
	if (message.startsWith("Agent is already processing")) return "busy";
	// SessionCommandRouter puts its stable code in `error` when no errorData is needed.
	const code = /^([a-z][a-z_]+)(?::|$)/.exec(message)?.[1];
	if (code) return code;
	return "host_error";
}

export async function runHostSessionRequest(request: HostSessionRequest): Promise<HostOutcome> {
	const { socket, agentDir } = request.target;
	let client: RpcClient | undefined;
	let ensured: EnsuredHost | undefined;
	let disconnected: ((error: RpcTransportGoneError) => void) | undefined;
	try {
		if ((await endpointKindOfSocket(socket, agentDir)) === "tui") {
			return refusal("refuse", undefined, { reason: "unsupported_endpoint_kind", socket, endpoint_kind: "tui" });
		}
		if (request.action === "open") {
			ensured = await ensureHost({
				socket,
				agentDir,
				hostArgs: request.spec.hostArgs,
				env: daemonEnvOverrides(process.env, request.spec.env),
				policy: request.spec.policy,
				upgrade: "never",
			});
			if (!ensured.reused) {
				await writeDaemonEnvKeys(
					createHostDaemonPaths({ socket, agentDir }),
					daemonEnvKeys(process.env, request.spec.env),
				);
			}
		}
		client = new RpcClient({ socketPath: socket, onDisconnect: (error) => disconnected?.(error) });
		try {
			await client.start();
		} catch (error) {
			if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
				return refusal("refuse", undefined, { reason: "host_unavailable", socket, detail: error.message });
			}
			throw error;
		}
		let sessionId: string | undefined;
		let durableSessionId: string | undefined;
		if ("ref" in request) {
			const row = await resolveSessionRow(client, request.ref);
			if (!row) return refusal("refuse", undefined, { reason: "unknown_session", ref: request.ref, socket });
			durableSessionId = row.durableSessionId;
			sessionId = (await client.openSession({ sessionPath: row.sessionPath, cwd: row.cwd })).sessionId;
		}
		switch (request.action) {
			case "open": {
				const opened = await client.openSession({
					cwd: request.cwd,
					retain_on_disconnect: true,
					...(request.model && { provider: request.model.provider, modelId: request.model.id }),
				});
				ensured?.release();
				if (request.name !== undefined) await client.setSessionName(request.name);
				const disposition = request.prompt === undefined ? undefined : await client.prompt(request.prompt);
				const row = (await client.listSessions()).find((row) => row.sessionId === opened.sessionId);
				const { state } = opened;
				return {
					exitCode: HOST_EXIT_OK,
					payload: {
						action: "open",
						socket,
						pid: ensured?.pid,
						reused: ensured?.reused,
						sessionId: opened.sessionId,
						sessionPath: state.sessionFile,
						durableSessionId: row?.durableSessionId,
						cwd: state.cwd,
						model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
						attached: opened.attached ?? false,
						...(disposition !== undefined && { prompt: { disposition } }),
					},
				};
			}
			case "prompt":
				return {
					exitCode: HOST_EXIT_OK,
					payload: { action: "prompt", sessionId, disposition: await client.prompt(request.text) },
				};
			case "steer": {
				// An idle steer is parked until the next prompt; it does not start a run.
				const streaming = (await client.getState()).isStreaming;
				const disposition = await client.steer(request.text);
				return { exitCode: HOST_EXIT_OK, payload: { action: "steer", sessionId, disposition, streaming } };
			}
			case "abort": {
				const aborted = (await client.getState()).isStreaming;
				await client.abortStrict();
				return { exitCode: HOST_EXIT_OK, payload: { action: "abort", sessionId, acknowledged: true, aborted } };
			}
			case "model": {
				// set_model also persists the GLOBAL default. Smaller contexts may defer the switch.
				await client.setModel(request.model.provider, request.model.id);
				const state = await client.getState();
				return {
					exitCode: HOST_EXIT_OK,
					payload: {
						action: "model",
						sessionId,
						requested: request.model,
						model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
						pendingModelSwitch: state.pendingModelSwitch ?? null,
					},
				};
			}
			case "list":
				return {
					exitCode: HOST_EXIT_OK,
					payload: { action: "list", socket, sessions: await client.listSessions({ observe: true }) },
				};
			case "state":
				return {
					exitCode: HOST_EXIT_OK,
					payload: { action: "state", sessionId, durableSessionId, state: await client.getState() },
				};
			case "read": {
				if (request.messages) {
					const all = await client.getMessages();
					const messages = request.tail === undefined ? all : all.slice(-request.tail);
					return {
						exitCode: HOST_EXIT_OK,
						payload: { action: "read", sessionId, messages, count: messages.length },
					};
				}
				const { entries, leafId } = await client.getEntries(request.since);
				const slice = request.tail === undefined ? entries : entries.slice(-request.tail);
				return {
					exitCode: HOST_EXIT_OK,
					payload: {
						action: "read",
						sessionId,
						entries: slice,
						count: slice.length,
						total: entries.length,
						leafId,
						nextSince: slice.at(-1)?.id ?? request.since ?? null,
						...(request.since !== undefined && { since: request.since }),
					},
				};
			}
			case "wait": {
				const attached = client;
				const started = Date.now();
				return await new Promise<HostOutcome>((resolveWait, reject) => {
					let finished = false;
					let observed = false;
					let state: RpcSessionState | undefined;
					let timer: ReturnType<typeof setTimeout> | undefined;
					const cleanup = () => {
						finished = true;
						clearTimeout(timer);
						unsubscribe();
						disconnected = undefined;
					};
					const fail = (error: unknown) => {
						if (finished) return;
						cleanup();
						reject(error);
					};
					const finish = (outcome: string) => {
						if (finished) return;
						cleanup();
						resolveWait({
							exitCode: HOST_EXIT_OK,
							payload: {
								action: "wait",
								sessionId,
								until: request.until,
								outcome,
								waited_ms: Date.now() - started,
								state: {
									isStreaming: state?.isStreaming ?? false,
									pendingMessageCount: state?.pendingMessageCount ?? 0,
									lastAbortSource: state?.lastAbortSource ?? null,
								},
							},
						});
					};
					// Subscribe BEFORE the snapshot, including when settlement arrives with that reply.
					const unsubscribe = attached.onEvent((record) => {
						const event = record as RpcClientEvent | RpcSessionClosedEvent;
						if (event.type === "session_closed" || event.type === "session_parked") {
							finish(event.type);
							return;
						}
						if (event.type === "agent_settled" && "reason" in event && event.reason === "session_closed") {
							finish("session_closed");
							return;
						}
						if (event.type !== "agent_idle" && !(request.until === "done" && event.type === "agent_settled"))
							return;
						observed = true;
						void attached.getState().then((snapshot) => {
							state = snapshot;
							if (request.until === "done") finish("done");
							else if (
								!snapshot.isStreaming &&
								snapshot.steering.length === 0 &&
								snapshot.followUp.length === 0 &&
								snapshot.ordered.length === 0 &&
								snapshot.pendingMessageCount === 0
							)
								finish("idle");
						}, fail);
					});
					disconnected = fail;
					timer = setTimeout(() => {
						if (finished) return;
						cleanup();
						resolveWait({
							exitCode: HOST_EXIT_ERROR,
							payload: {
								action: "error",
								reason: "wait_timeout",
								sessionId,
								until: request.until,
								timeoutMs: request.timeoutMs,
							},
						});
					}, request.timeoutMs);
					void attached.getState().then((snapshot) => {
						state = snapshot;
						if (!snapshot.isStreaming && !observed) finish("already_idle");
					}, fail);
				});
			}
			case "close": {
				let reason: string | undefined;
				const unsubscribe = client.onEvent((record) => {
					const event = record as RpcClientEvent | RpcSessionClosedEvent;
					if (event.type === "session_closed") reason = event.reason;
				});
				try {
					await client.closeSession(sessionId);
					// closeSession tolerates disconnect; this checked read must still succeed.
					const remaining = (await client.listSessions()).find((row) => row.sessionId === sessionId);
					return {
						exitCode: HOST_EXIT_OK,
						payload: remaining
							? { action: "close", sessionId, closed: false, attachments: remaining.attachments }
							: { action: "close", sessionId, closed: true, reason: reason ?? "client_close" },
					};
				} finally {
					unsubscribe();
				}
			}
			default:
				return assertNever(request);
		}
	} catch (error) {
		if (error instanceof HostEnsureRefusedError) {
			return refusal("refuse", undefined, { reason: error.reason, socket, detail: error.detail });
		}
		return mapError(error, socket);
	} finally {
		ensured?.release();
		await client?.stop();
	}
}

function assertNever(value: never): never {
	throw new Error(`unreachable host session request: ${JSON.stringify(value)}`);
}
