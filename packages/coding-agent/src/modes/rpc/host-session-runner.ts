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
import { isTransportGoneError, RpcClient, RpcCommandError } from "./rpc-client.ts";

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
		client = new RpcClient({ socketPath: socket });
		try {
			await client.start();
		} catch (error) {
			if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
				return refusal("refuse", undefined, { reason: "host_unavailable", socket, detail: error.message });
			}
			throw error;
		}
		if ("ref" in request) {
			const row = await resolveSessionRow(client, request.ref);
			if (!row) return refusal("refuse", undefined, { reason: "unknown_session", ref: request.ref, socket });
			await client.openSession({ sessionPath: row.sessionPath, cwd: row.cwd });
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
			case "close":
			case "model":
			case "prompt":
			case "steer":
			case "abort":
			case "read":
			case "state":
			case "list":
			case "wait":
				throw new Error(`Session command not implemented: ${request.action}`);
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
