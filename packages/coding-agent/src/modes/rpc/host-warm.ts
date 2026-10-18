/**
 * `warm`: load what the next `open_session` needs without opening a session (senpi#2314).
 *
 * A fresh host pays a one-time cost on its first session: the extension module graph compiles and
 * the extensions' factories load their runtimes (a task engine, for a `child` role). With one host
 * per session every session paid it. `warm` builds the cwd-bound services an open would build for
 * the same cwd, kind and context - which compiles that graph and runs those factories - and drops
 * them. No `AgentSession` exists, no `session_start` fires, nothing is registered or listed, and
 * the connection that asked stays an observer (`host-observe-request.ts`), so a host that only
 * received `warm` still idles out on its normal deadline.
 *
 * A profile is warmed once per host: a repeat answers `already_warm` without running factories
 * again, and concurrent warms of one profile share a single load.
 */
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { AgentSessionLaunchProfile, CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import type { HostMcpRegistry } from "../../core/extensions/builtin/mcp/host-registry.ts";
import type { SessionContext, SessionKind } from "../../core/extensions/types.ts";
import { sessionContextError, sessionKindError } from "./rpc-input-validation.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import {
	RPC_ERROR_INVALID_PATH,
	RPC_ERROR_INVALID_SESSION_CONTEXT,
	RPC_ERROR_INVALID_SESSION_KIND,
	RPC_ERROR_WARM_FAILED,
} from "./rpc-types.ts";

/** What a runtime factory needs to build a session's services without the session. */
export interface PrepareRuntimeOptions {
	cwd: string;
	agentDir: string;
	mcpRegistry?: HostMcpRegistry;
	launchProfile: Readonly<AgentSessionLaunchProfile>;
}

/** A runtime factory that can also build its cwd-bound services alone, for `warm`. */
export type PreparableRuntimeFactory = CreateAgentSessionRuntimeFactory & {
	readonly prepare?: (options: PrepareRuntimeOptions) => Promise<void>;
};

/** The launch inputs that decide which extensions load, and so what a warm prepares. */
export interface HostWarmProfile {
	cwd: string;
	sessionKind?: SessionKind;
	sessionContext?: SessionContext;
}

/** `warmed`: this call (or one it joined) loaded the profile. `already_warm`: an earlier one had. */
export type HostWarmState = "warmed" | "already_warm";

export type HostWarm = (profile: HostWarmProfile) => Promise<HostWarmState>;

/** Distinct profiles a host remembers as warm; the oldest is forgotten past this. */
const MAX_WARM_PROFILES = 64;

function profileKey(profile: HostWarmProfile): string {
	const context = Object.entries(profile.sessionContext ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify([profile.cwd, profile.sessionKind ?? "interactive", context]);
}

/** Coalesces concurrent warms of one profile and answers repeats without loading again. */
export class HostWarmer {
	private readonly warm = new Set<string>();
	private readonly loading = new Map<string, Promise<void>>();
	private readonly load: (profile: HostWarmProfile) => Promise<void>;

	constructor(load: (profile: HostWarmProfile) => Promise<void>) {
		this.load = load;
	}

	async run(profile: HostWarmProfile): Promise<HostWarmState> {
		const key = profileKey(profile);
		if (this.warm.has(key)) return "already_warm";
		let pending = this.loading.get(key);
		if (pending === undefined) {
			pending = this.loadOnce(key, profile);
			this.loading.set(key, pending);
		}
		await pending;
		return "warmed";
	}

	private async loadOnce(key: string, profile: HostWarmProfile): Promise<void> {
		try {
			await this.load(profile);
			this.warm.add(key);
			if (this.warm.size > MAX_WARM_PROFILES) {
				const oldest = this.warm.values().next().value;
				if (oldest !== undefined) this.warm.delete(oldest);
			}
		} finally {
			this.loading.delete(key);
		}
	}
}

/**
 * The in-process registry's `warm`. The services are built inside their own provider scope, exactly
 * like an open's, and the scope closes when they are dropped, so nothing an extension registered
 * while loading outlives the warm.
 */
export function createRegistryWarm(
	prepare: NonNullable<PreparableRuntimeFactory["prepare"]>,
	host: { agentDir: string; mcpRegistry?: HostMcpRegistry },
): HostWarm {
	const warmer = new HostWarmer(async (profile) => {
		await access(profile.cwd);
		const launchProfile: AgentSessionLaunchProfile = {
			cwd: profile.cwd,
			...(profile.sessionKind !== undefined ? { sessionKind: profile.sessionKind } : {}),
			...(profile.sessionContext !== undefined
				? { sessionContext: Object.freeze({ ...profile.sessionContext }) }
				: {}),
		};
		const scope = new ProviderScope();
		try {
			await runWithProviderScope(scope, () =>
				prepare({
					cwd: profile.cwd,
					agentDir: host.agentDir,
					launchProfile: Object.freeze(launchProfile),
					...(host.mcpRegistry !== undefined ? { mcpRegistry: host.mcpRegistry } : {}),
				}),
			);
		} finally {
			scope.close();
		}
	});
	return (profile) => warmer.run(profile);
}

type WarmCommand = Extract<RpcCommand, { type: "warm" }>;

function refusal(command: WarmCommand, code: string): RpcResponse {
	return { id: command.id, type: "response", command: "warm", success: false, error: code };
}

/**
 * Answers one `warm`. The router calls this OUTSIDE its request accounting: a warm holds no session
 * and no path, so neither a drain nor an idle window waits for it.
 */
export async function answerWarm(
	command: WarmCommand,
	host: {
		draining: boolean;
		warm: HostWarm | undefined;
		cwd: string;
		hostContext: SessionContext | undefined;
	},
): Promise<RpcResponse> {
	if (host.draining) return refusal(command, "host_draining");
	const kindError = sessionKindError(command.kind);
	if (kindError) return refusal(command, `${RPC_ERROR_INVALID_SESSION_KIND}: ${kindError}`);
	const contextError = sessionContextError(command.context);
	if (contextError) return refusal(command, `${RPC_ERROR_INVALID_SESSION_CONTEXT}: ${contextError}`);
	if (host.warm === undefined)
		return { id: command.id, type: "response", command: "warm", success: true, data: { state: "unsupported" } };
	// The same context an open on this host would hand its extensions: the host's identity wins.
	const sessionContext = host.hostContext ? { ...command.context, ...host.hostContext } : command.context;
	const cwd = command.cwd ?? host.cwd;
	if (!isAbsolute(cwd)) return refusal(command, RPC_ERROR_INVALID_PATH);
	try {
		const state = await host.warm({
			cwd,
			...(command.kind !== undefined ? { sessionKind: command.kind } : {}),
			...(sessionContext !== undefined ? { sessionContext } : {}),
		});
		return { id: command.id, type: "response", command: "warm", success: true, data: { state } };
	} catch (cause) {
		return refusal(command, `${RPC_ERROR_WARM_FAILED}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}
