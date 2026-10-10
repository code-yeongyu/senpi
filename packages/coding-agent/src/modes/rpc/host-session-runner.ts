/** Short-lived, attach-before-act clients for `senpi host session`. */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { endpointKindOfSocket } from "./host-endpoints.ts";
import type { ResolvedHostLaunchSpec } from "./host-launch-spec.ts";
import { HOST_EXIT_ERROR, HOST_EXIT_REFUSED, HOST_EXIT_USAGE, type HostOutcome, refusal } from "./host-outcome.ts";
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
	return "host_error";
}

export async function runHostSessionRequest(request: HostSessionRequest): Promise<HostOutcome> {
	const { socket, agentDir } = request.target;
	let client: RpcClient | undefined;
	try {
		if ((await endpointKindOfSocket(socket, agentDir)) === "tui") {
			return refusal("refuse", undefined, { reason: "unsupported_endpoint_kind", socket, endpoint_kind: "tui" });
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
			case "open":
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
		return mapError(error, socket);
	} finally {
		await client?.stop();
	}
}

function assertNever(value: never): never {
	throw new Error(`unreachable host session request: ${JSON.stringify(value)}`);
}
