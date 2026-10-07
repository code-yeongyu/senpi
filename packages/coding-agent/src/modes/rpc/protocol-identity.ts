/**
 * Who this host is, which engine build it runs, and what it was launched with.
 *
 * Every `get_protocol_info` answer carries these fields so a client sharing one
 * machine-wide daemon can decide, WITHOUT comparing version strings: is this the same
 * host process I talked to before (`instanceId`), which generation of it (`generation`),
 * is my own build newer (`engineOrdinal`, see `core/engine-build-identity.ts`), and
 * would a replacement still load what this host loads (`launch_profile`).
 *
 * The launch profile is derived from the host's OWN argv rather than from anything a
 * caller passes in, because that is the only description of the host that cannot drift
 * from what it actually loaded. `profile_id` is the sha256 of the canonical JSON of
 * `core` (keys sorted: `extensions`, `multi_session`, `session_runtime`), so any client
 * in any language can recompute it and compare two hosts without parsing paths.
 */
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs, resolveSessionRuntime } from "../../cli/args.ts";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import { HOST_GENERATION_ENV, HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import type { RpcLaunchProfile, RpcLaunchProfileCore, RpcProtocolIdentity } from "./rpc-types.ts";

export { HOST_GENERATION_ENV, HOST_INSTANCE_ID_ENV };

/** Identity of THIS host process, fixed for its lifetime. */
const INSTANCE_ID = resolveInstanceId(process.env[HOST_INSTANCE_ID_ENV]);

function resolveInstanceId(value: string | undefined): string {
	return value !== undefined && value.trim() !== "" ? value : randomUUID();
}

/** Who this host is, for anything that has to name the process rather than describe it. */
export function hostInstanceId(): string {
	return INSTANCE_ID;
}

let cachedProfile: RpcLaunchProfile | undefined;

/** Non-negative integer, or 0. A malformed value is a client bug and must not be reported as a real generation. */
export function hostGeneration(env: Readonly<Record<string, string | undefined>>): number {
	const value = env[HOST_GENERATION_ENV];
	return value !== undefined && /^\d+$/.test(value) ? Number(value) : 0;
}

/** Derives the launch profile from one argument vector. Pure: same argv and cwd, same profile. */
export function hostLaunchProfile(argv: readonly string[], cwd: string): RpcLaunchProfile {
	const parsed = parseArgs([...argv], { grokNeoEnabled: false });
	const core: RpcLaunchProfileCore = {
		extensions: [...new Set((parsed.extensions ?? []).map((path) => resolve(cwd, path)))].sort(),
		multi_session: parsed.multiSession === true,
		session_runtime: resolveSessionRuntime(parsed),
	};
	const canonical = JSON.stringify({
		extensions: core.extensions,
		multi_session: core.multi_session,
		session_runtime: core.session_runtime,
	});
	return { profile_id: createHash("sha256").update(canonical).digest("hex"), core };
}

/**
 * The launch profile a SOCKET host child started with `hostArgs` derives from its own argv. The
 * child always runs `--mode rpc --multi-session --listen <socket>`, and `--listen` is what makes its
 * session runtime `in-process`; the socket itself never enters the profile.
 */
export function socketHostLaunchProfile(hostArgs: readonly string[], cwd: string): RpcLaunchProfile {
	return hostLaunchProfile(["--mode", "rpc", "--multi-session", "--listen", "unix://", ...hostArgs], cwd);
}

/** The identity fields of this host's `get_protocol_info` answer. */
export function protocolIdentity(): RpcProtocolIdentity {
	cachedProfile ??= hostLaunchProfile(process.argv.slice(2), process.cwd());
	const build = engineBuildIdentity();
	return {
		instanceId: INSTANCE_ID,
		generation: hostGeneration(process.env),
		engineVersion: build.text,
		engineOrdinal: build.ordinal,
		launch_profile: cachedProfile,
	};
}
