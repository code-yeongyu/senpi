/** Short-lived, attach-before-act clients for `senpi host session`. */
import { daemonEnvKeys, daemonEnvOverrides, writeDaemonEnvKeys } from "./host-daemon-env.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import { HostEnsureRefusedError } from "./host-decision.ts";
import { endpointKindOfSocket } from "./host-endpoints.ts";
import { type EnsuredHost, ensureHost } from "./host-ensure.ts";
import type { ResolvedHostLaunchSpec } from "./host-launch-spec.ts";
import { HOST_EXIT_OK, type HostOutcome, refusal } from "./host-outcome.ts";
import type { HostTarget } from "./host-runner.ts";
import { mapError } from "./host-session-errors.ts";
import { type HostSessionOpen, openHostSession } from "./host-session-open.ts";
import { resolveSessionRef, type SessionRef } from "./host-session-ref.ts";
import { type HostSessionWait, waitForHostSession } from "./host-session-wait.ts";
import { RpcClient, type RpcClientEvent, type RpcTransportGoneError } from "./rpc-client.ts";
import type { RpcSessionClosedEvent } from "./rpc-types.ts";

type Model = { provider: string; id: string };
export type HostSessionRequest = { target: HostTarget } & (
	| ({ action: "open"; spec: ResolvedHostLaunchSpec; launchSpecPath?: string } & HostSessionOpen)
	| { action: "close"; ref: SessionRef }
	| { action: "model"; ref: SessionRef; model: Model }
	| { action: "prompt"; ref: SessionRef; text: string }
	| { action: "steer"; ref: SessionRef; text: string }
	| { action: "abort"; ref: SessionRef }
	| { action: "read"; ref: SessionRef; tail?: number; since?: string; messages: boolean }
	| { action: "state"; ref: SessionRef }
	| { action: "list" }
	| ({ action: "wait"; ref: SessionRef } & HostSessionWait)
);

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
			const found = await resolveSessionRef(client, request.ref, agentDir);
			if (found.kind === "unknown") {
				return refusal("refuse", undefined, { reason: "unknown_session", ref: request.ref, socket });
			}
			if (found.kind === "ambiguous") {
				const detail = { reason: "ambiguous_session", ref: request.ref, candidates: found.candidates, socket };
				return refusal("refuse", undefined, detail);
			}
			// A parked session resumes from its transcript and stays retained past this short-lived client.
			const reopen =
				found.kind === "parked"
					? { sessionPath: found.sessionPath, cwd: found.cwd, retain_on_disconnect: true }
					: { sessionPath: found.row.sessionPath, cwd: found.row.cwd };
			durableSessionId = found.kind === "parked" ? found.durableSessionId : found.row.durableSessionId;
			sessionId = (await client.openSession(reopen)).sessionId;
		}
		switch (request.action) {
			case "open":
				return await openHostSession(client, request, socket, ensured);
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
			case "wait":
				return await waitForHostSession(client, sessionId, request, (handler) => {
					disconnected = handler;
				});
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
