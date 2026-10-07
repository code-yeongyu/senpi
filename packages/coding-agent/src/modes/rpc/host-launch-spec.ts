/**
 * The file a client hands `senpi host`: what the daemon should be started with, and whether this
 * machine may act on it at all.
 *
 * A launch spec is the one input that decides what code a long-lived, machine-wide daemon LOADS, so
 * it is a trust boundary rather than a convenience format. Four properties are proven before any
 * process is started, and each maps to a refusal a caller can branch on:
 *
 *   - `launch_spec_insecure` - the file is not owned by this uid, or it is group/world writable.
 *     Anyone who can rewrite the spec can choose the daemon's extensions.
 *   - `launch_spec_path_escape` - an extension path leaves the spec directory's tree, lexically or
 *     through a symlink. The spec directory is the profile; a path outside it is somebody else's.
 *   - `launch_spec_env_denied` - an `env` key outside `^(SENPI|OMO|PI)_[A-Z0-9_]+$`. The spec may
 *     add to the brand's own lane and nothing else; it may never set `PATH` for a daemon.
 *   - `launch_spec_missing_extension` - a listed extension does not exist. Failing here is the
 *     point: a daemon that booted with half a profile would serve every client with half a profile.
 *
 * The spec is deliberately a FILE, never stdin or an argv blob: those cannot be owner-checked, and
 * the directory holding the file is what the extension paths are resolved against.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isSessionRuntimeKind, type SessionRuntimeKind } from "../../cli/args.ts";
import type { HostColdStart, HostLifecyclePolicyInput } from "./host-lifecycle.ts";

/** Keys a spec's `env` may carry: the brand's own lane, and nothing that steers process startup. */
const SPEC_ENV_NAME = /^(SENPI|OMO|PI)_[A-Z0-9_]+$/u;

export interface HostLaunchSpecCore {
	readonly session_runtime: SessionRuntimeKind;
	/** A daemon serves many clients at once; a spec that says otherwise is refused, not honoured. */
	readonly multi_session: true;
	/** Extension paths, relative to the directory holding the spec file. */
	readonly extensions: readonly string[];
}

/** The document itself, as a client writes it. */
export interface HostLaunchSpec {
	readonly spec_version: 1;
	readonly core: HostLaunchSpecCore;
	readonly tunables?: { readonly idleExitMs?: number; readonly coldStart?: HostColdStart };
	readonly env?: Readonly<Record<string, string>>;
}

export type HostLaunchSpecRefusal =
	| "launch_spec_unreadable"
	| "launch_spec_invalid"
	| "launch_spec_insecure"
	| "launch_spec_path_escape"
	| "launch_spec_env_denied"
	| "launch_spec_missing_extension";

/** A spec that may not be acted on, naming the property that failed and the path that failed it. */
export class HostLaunchSpecError extends Error {
	readonly reason: HostLaunchSpecRefusal;
	readonly detail: string;

	constructor(reason: HostLaunchSpecRefusal, detail: string) {
		super(`${reason}: ${detail}`);
		this.name = "HostLaunchSpecError";
		this.reason = reason;
		this.detail = detail;
	}
}

/** A trusted spec, in the shape the ensure/handoff entry points take. */
export interface ResolvedHostLaunchSpec {
	/** Host CLI arguments: the session runtime and one absolute `--extension` per listed path. */
	readonly hostArgs: readonly string[];
	readonly policy: HostLifecyclePolicyInput;
	readonly env: Readonly<Record<string, string>>;
}

/** What an ensure without a spec launches: the daemon defaults, no extensions, no extra env. */
export const DEFAULT_HOST_LAUNCH_SPEC: ResolvedHostLaunchSpec = {
	hostArgs: [],
	policy: {},
	env: {},
};

/**
 * Reads, trusts and resolves one launch spec. Every failure is a `HostLaunchSpecError`; nothing is
 * started, and no daemon state is written, until this has returned.
 */
export async function loadHostLaunchSpec(
	specPath: string,
	platform: NodeJS.Platform = process.platform,
): Promise<ResolvedHostLaunchSpec> {
	const absolute = resolve(specPath);
	await assertTrustedFile(absolute, platform);
	const spec = parseHostLaunchSpec(await readSpecText(absolute));
	const env = trustedEnv(spec.env);
	const extensions = await resolveExtensions(spec.core.extensions, dirname(absolute));
	return {
		hostArgs: [
			"--session-runtime",
			spec.core.session_runtime,
			...extensions.flatMap((path) => ["--extension", path]),
		],
		policy: {
			...(spec.tunables?.idleExitMs !== undefined && { idleExitMs: spec.tunables.idleExitMs }),
			...(spec.tunables?.coldStart !== undefined && { coldStart: spec.tunables.coldStart }),
		},
		env,
	};
}

/** Parses the document. A boundary: everything past it is typed and nothing re-validates it. */
export function parseHostLaunchSpec(text: string): HostLaunchSpec {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error: unknown) {
		throw new HostLaunchSpecError("launch_spec_invalid", error instanceof Error ? error.message : "not JSON");
	}
	if (!isRecord(parsed)) throw new HostLaunchSpecError("launch_spec_invalid", "the spec is not a JSON object");
	if (parsed.spec_version !== 1) {
		throw new HostLaunchSpecError("launch_spec_invalid", `unsupported spec_version ${String(parsed.spec_version)}`);
	}
	const core = parsed.core;
	if (!isRecord(core)) throw new HostLaunchSpecError("launch_spec_invalid", "core must be an object");
	if (typeof core.session_runtime !== "string" || !isSessionRuntimeKind(core.session_runtime)) {
		throw new HostLaunchSpecError("launch_spec_invalid", "core.session_runtime must be in-process or worker");
	}
	// A daemon that is not multi-session cannot serve a second client, so a spec asking for one is a
	// client bug rather than a configuration: it is refused instead of quietly upgraded.
	if (core.multi_session !== true) {
		throw new HostLaunchSpecError("launch_spec_invalid", "core.multi_session must be true");
	}
	if (!Array.isArray(core.extensions) || !core.extensions.every((entry) => typeof entry === "string")) {
		throw new HostLaunchSpecError("launch_spec_invalid", "core.extensions must be an array of strings");
	}
	const tunables = parsedTunables(parsed.tunables);
	return {
		spec_version: 1,
		core: { session_runtime: core.session_runtime, multi_session: true, extensions: core.extensions },
		...(tunables && { tunables }),
		...(isRecord(parsed.env) && { env: parsedEnv(parsed.env) }),
	};
}

async function readSpecText(absolute: string): Promise<string> {
	try {
		return await readFile(absolute, "utf8");
	} catch (error: unknown) {
		throw new HostLaunchSpecError("launch_spec_unreadable", error instanceof Error ? error.message : absolute);
	}
}

/**
 * Ownership and permissions of the spec file. win32 has neither a comparable uid nor POSIX mode
 * bits on this path, so the check is POSIX-only and says so rather than pretending to pass.
 */
async function assertTrustedFile(absolute: string, platform: NodeJS.Platform): Promise<void> {
	if (platform === "win32") return;
	const stats = await stat(absolute).catch((error: unknown) => {
		throw new HostLaunchSpecError("launch_spec_unreadable", error instanceof Error ? error.message : absolute);
	});
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) {
		throw new HostLaunchSpecError("launch_spec_insecure", `${absolute} is owned by uid ${stats.uid}, not ${uid}`);
	}
	if ((stats.mode & 0o022) !== 0) {
		throw new HostLaunchSpecError(
			"launch_spec_insecure",
			`${absolute} is group/world writable (mode ${(stats.mode & 0o777).toString(8)})`,
		);
	}
}

function trustedEnv(env: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
	for (const name of Object.keys(env ?? {})) {
		if (!SPEC_ENV_NAME.test(name)) {
			throw new HostLaunchSpecError("launch_spec_env_denied", `${name} is outside ${SPEC_ENV_NAME.source}`);
		}
	}
	return env ?? {};
}

/** Resolves each listed extension inside the spec's own directory, or refuses to start at all. */
async function resolveExtensions(extensions: readonly string[], specDir: string): Promise<string[]> {
	const rootReal = await realpath(specDir).catch(() => specDir);
	const resolved: string[] = [];
	for (const entry of extensions) {
		const target = resolve(specDir, entry);
		if (escapes(specDir, target)) {
			throw new HostLaunchSpecError("launch_spec_path_escape", `${entry} resolves outside ${specDir}`);
		}
		const real = await realpath(target).catch(() => undefined);
		if (real === undefined) {
			throw new HostLaunchSpecError("launch_spec_missing_extension", `${target} does not exist`);
		}
		// A path that is lexically inside the tree can still LEAD outside it through a symlink, and
		// the daemon would load whatever it points at.
		if (escapes(rootReal, real)) {
			throw new HostLaunchSpecError("launch_spec_path_escape", `${entry} links outside ${specDir}`);
		}
		resolved.push(real);
	}
	return resolved;
}

function escapes(root: string, target: string): boolean {
	const step = relative(root, target);
	return step.startsWith("..") || isAbsolute(step);
}

function parsedTunables(value: unknown): HostLaunchSpec["tunables"] | undefined {
	if (!isRecord(value)) return undefined;
	const idleExitMs = value.idleExitMs;
	const coldStart = value.coldStart;
	return {
		...(typeof idleExitMs === "number" && Number.isFinite(idleExitMs) && idleExitMs > 0 && { idleExitMs }),
		...((coldStart === "transient" || coldStart === "persistent") && { coldStart }),
	};
}

function parsedEnv(value: Record<string, unknown>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			throw new HostLaunchSpecError("launch_spec_invalid", `env.${name} must be a string`);
		}
		env[name] = entry;
	}
	return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
