/**
 * The one launch-environment builder every engine trust writer uses (omo's trust exec, senpi's
 * daemon and handover spawns, the desktop boundary and browser-skill host), the arrival reading a
 * launch decides adopt / import / refuse from, and the restore an adopting engine applies to its
 * JS `process.env` before any Worker, child or agent shell exists (omo#10762).
 */
import { deleteName, type EnvironmentEntries, hasName, setName, valuesOf } from "./environment-names.ts";
import {
	ENGINE_TRUST_HOP_ENV,
	ENGINE_TRUST_MARKER_ENV,
	ENGINE_TRUST_RESTORE_NAMES,
	EngineTrustContractError,
	type EngineTrustMarker,
	type EngineTrustRestore,
	parseEngineTrustMarker,
	serializeEngineTrustMarker,
} from "./marker.ts";

const EXTRA_CA_ENV = "NODE_EXTRA_CA_CERTS";
/** Bun's system-store switches; a server launch never passes them to the engine. */
const SERVER_REMOVED_NAMES = ["NODE_USE_SYSTEM_CA", "BUN_OPTIONS"] as const;
/** Without `BUN_OPTIONS`, which an adopting engine restores only when the marker records it. */
const ALWAYS_RESTORED_NAMES = ["NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

export type TrustMarkerArrival =
	| { readonly kind: "none" }
	| { readonly kind: "addressed"; readonly marker: EngineTrustMarker }
	| { readonly kind: "foreign"; readonly reason: "unparseable" | "file-mismatch" | "ambiguous" };

export type TrustArrival = { readonly hop: boolean; readonly marker: TrustMarkerArrival };

/**
 * A marker is addressed only when its `file` is exactly the native `NODE_EXTRA_CA_CERTS`, which
 * every writer sets from the same string. Two different values under Windows case forms are never
 * resolved here: which one the child's CRT returns is not ours to guess, so the marker is foreign.
 */
export function classifyTrustArrival(env: EnvironmentEntries, platform: NodeJS.Platform): TrustArrival {
	const hop = hasName(env, ENGINE_TRUST_HOP_ENV, platform);
	const markerTexts = valuesOf(env, ENGINE_TRUST_MARKER_ENV, platform);
	if (markerTexts.length === 0) return { hop, marker: { kind: "none" } };
	const extraFiles = valuesOf(env, EXTRA_CA_ENV, platform);
	if (markerTexts.length > 1 || extraFiles.length > 1)
		return { hop, marker: { kind: "foreign", reason: "ambiguous" } };
	const marker = parseEngineTrustMarker(markerTexts[0] ?? "");
	if (marker === undefined) return { hop, marker: { kind: "foreign", reason: "unparseable" } };
	if (extraFiles[0] !== marker.file) return { hop, marker: { kind: "foreign", reason: "file-mismatch" } };
	return { hop, marker: { kind: "addressed", marker } };
}

export type TrustLaunchOptions = {
	readonly marker: EngineTrustMarker;
	/** True only for the launcher's own trust exec. */
	readonly hop: boolean;
	readonly platform: NodeJS.Platform;
};

/**
 * `base` with the trust launch environment applied last. It removes every case form of each name
 * it writes or must not pass, so the child holds exactly one entry per trust name; nothing may be
 * merged after it.
 */
export function buildTrustLaunchEnvironment(
	base: EnvironmentEntries,
	options: TrustLaunchOptions,
): Record<string, string> {
	const { marker, hop, platform } = options;
	const env: Record<string, string | undefined> = { ...base };
	if (marker.owner === "server") for (const name of SERVER_REMOVED_NAMES) deleteName(env, name, platform);
	if (marker.defaults !== null) {
		setName(env, "SSL_CERT_FILE", representablePath(marker.defaults.file, platform), platform);
		setName(env, "SSL_CERT_DIR", representablePath(marker.defaults.dir, platform), platform);
	}
	setName(env, EXTRA_CA_ENV, marker.file, platform);
	setName(env, ENGINE_TRUST_MARKER_ENV, serializeEngineTrustMarker(marker), platform);
	if (hop) setName(env, ENGINE_TRUST_HOP_ENV, "1", platform);
	else deleteName(env, ENGINE_TRUST_HOP_ENV, platform);
	return definedEntries(env);
}

/**
 * Applied by an adopting engine to its JS `process.env`: the recorded arrival values come back for
 * children, each name the restore omits or maps to null is deleted, and the marker and the hop go,
 * so an agent shell or nested `omo` never holds either.
 */
export function applyEngineTrustRestore(
	env: Record<string, string | undefined>,
	restore: EngineTrustRestore,
	platform: NodeJS.Platform,
): void {
	const names = restore.BUN_OPTIONS === undefined ? ALWAYS_RESTORED_NAMES : ENGINE_TRUST_RESTORE_NAMES;
	for (const name of names) {
		const value = restore[name];
		if (typeof value === "string") setName(env, name, value, platform);
		else deleteName(env, name, platform);
	}
	deleteName(env, ENGINE_TRUST_MARKER_ENV, platform);
	deleteName(env, ENGINE_TRUST_HOP_ENV, platform);
}

/** A hash-directory list splits on `:` (POSIX) or `;` (Windows); a split path could name a foreign directory. */
function representablePath(path: string, platform: NodeJS.Platform): string {
	if (path.includes(platform === "win32" ? ";" : ":")) {
		throw new EngineTrustContractError(
			"trust-path-unrepresentable",
			"engine trust closure path holds a list separator",
		);
	}
	return path;
}

function definedEntries(env: EnvironmentEntries): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
	return out;
}
