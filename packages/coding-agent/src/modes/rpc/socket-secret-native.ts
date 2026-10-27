/**
 * Headless loader for the Windows socket-secret bridge (`crates/senpi-socket-secret`, sisyphuslabs/omo-desktop-app#4199).
 * There is no optional fallback: a Windows public-secret mutation that cannot load the bridge must fail, never fall
 * back to a direct final-path write. Nothing here runs at import time.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../config.ts";

/** ABI of the bridge's exports, not the package CalVer. Keep aligned with crates/senpi-socket-secret. */
export const NATIVE_SOCKET_SECRET_ABI_VERSION = "1";

export const SOCKET_SECRET_NATIVE_PATH_ENV = "SENPI_SOCKET_SECRET_NATIVE_PATH";

export interface NativeKernelSessionIdentity {
	readonly status: "verified" | "unverified";
	readonly creationTime: string | null;
	readonly reason: string | null;
}

export interface NativeVolumeLocality {
	readonly locality: "local" | "not_local";
	readonly reason: string | null;
	readonly reportedFileSystem: string | null;
}

/** A staging file whose delete disposition failed; it is still at `path` and the caller removes it. */
export interface NativeLeftBehindStaging {
	readonly path: string;
	readonly windowsError: number;
}

/** `publishNoReplace` result. napi-rs leaves an absent optional field `undefined`. */
export interface NativePublishResult {
	readonly outcome: "published" | "collision" | "failed";
	readonly failure?: { readonly step: string; readonly code: number } | null;
	readonly stagingLeftBehind?: NativeLeftBehindStaging | null;
}

export interface LeftBehindStaging extends NativeLeftBehindStaging {
	/** What the caller must do; names the path, never the secret. */
	readonly action: string;
}

export interface SocketSecretPublication {
	readonly outcome: "published" | "collision";
	readonly stagingLeftBehind: LeftBehindStaging | null;
}

export interface NativeSocketSecretBinding {
	__senpiSocketSecretAbi1(): string;
	publishNoReplace(stagingPath: string, finalPath: string, bytes: Buffer): NativePublishResult;
	kernelSessionIdentity(): NativeKernelSessionIdentity;
	classifyVolume(path: string): NativeVolumeLocality;
}

/**
 * A successful probe is retained native release evidence, never a transient "free" hint. A blocking wait's `acquired`
 * is NOT yet evidence: that handle becomes evidence only once `probeRetained` applies the admissibility rules to it
 * (design Revision 8, r7 note 4), inside the recovery transaction.
 */
export type NativePresenceResult =
	| { readonly status: "acquired" | "occupied" | "valid" | "released" | "cancelled" }
	| { readonly status: "unknown" | "fenced"; readonly reason: string; readonly code?: number | null }
	| { readonly status: "unavailable"; readonly reason: "unsupported_platform" };

export interface NativePresenceProbe {
	readonly presenceId: string;
	readonly path: string;
	/**
	 * The object's whole immutable header as the row recorded it (design 4.2a: random tag, schema, creation timestamp).
	 * The bridge compares the opened object with it byte for byte; the tag alone never matches.
	 */
	readonly header: Buffer;
	readonly volumeSerial: string;
	readonly fileId: string;
	readonly createdLocal: boolean;
	readonly relocated: boolean;
	readonly kernelSession: string | null;
}

/**
 * Why a guard leaves the registry (design 4.2a recovery transaction order). `released` is the holder's own quiescence
 * commit; the other three are the points at which recovery releases guards it recovered: `recovery_abandoned` when step 3
 * meets contention or an error and the attempt cannot retire, `discharged` when step 4 finds the role committed
 * `released` meanwhile, `retired` after step 5's retirement commit and object deletion. Nothing else releases a guard.
 */
export type PresenceReleaseReason = "released" | "recovery_abandoned" | "discharged" | "retired";

/** The caller commits the state named by `state` (terminal, drained, or the recovery step) before supplying this receipt. */
export interface PresenceReleasedReceipt {
	readonly presenceId: string;
	readonly state: PresenceReleaseReason;
}

export interface NativePresenceBinding {
	presenceAcquire(presenceId: string, path: string): NativePresenceResult;
	presenceProbe(request: NativePresenceProbe): NativePresenceResult;
	/**
	 * The probe's admissibility rules applied to a guard this process already retains, the one a blocking wait acquired
	 * (design Revision 8, r7 note 4): `acquired` keeps it, an inadmissible handle is released at once (`unknown`,
	 * `inadmissible`), and a guard not held is `unknown` (`not_held`). The handle is never closed and reacquired.
	 */
	presenceProbeRetained(request: NativePresenceProbe): NativePresenceResult;
	presencePreActionCheck(presenceId: string): NativePresenceResult;
	presenceWaitAndAcquire(presenceId: string, path: string, waitId: string): Promise<NativePresenceResult>;
	presenceCancelWait(waitId: string): void;
	presenceReleaseAfterQuiescence(receipt: PresenceReleasedReceipt): NativePresenceResult;
}

export interface SocketSecretPresence {
	acquire(presenceId: string, path: string): NativePresenceResult;
	probe(request: NativePresenceProbe): NativePresenceResult;
	/** Step 3's admissibility check for the guard `waitAndAcquire` retained; see `presenceProbeRetained`. */
	probeRetained(request: NativePresenceProbe): NativePresenceResult;
	preActionCheck(presenceId: string): NativePresenceResult;
	waitAndAcquire(presenceId: string, path: string, signal?: AbortSignal): Promise<NativePresenceResult>;
	releaseAfterQuiescence(receipt: PresenceReleasedReceipt): NativePresenceResult;
}

/** A presence root as one opened directory handle describes it (`presenceRootOpen`). */
export interface NativePresenceRoot {
	readonly status: "opened" | "insecure" | "failed" | "unavailable";
	/** The canonical path of the opened directory. */
	readonly path?: string | null;
	readonly volumeSerial?: string | null;
	readonly fileId?: string | null;
	readonly locality?: "local" | "not_local" | null;
	readonly reason?: string | null;
	readonly reportedFileSystem?: string | null;
	readonly step?: string | null;
	readonly code?: number | null;
}

export interface NativePresenceObjectRequest {
	readonly rootPath: string;
	readonly rootVolumeSerial: string;
	readonly rootFileId: string;
	readonly name: string;
	readonly header: Buffer;
}

/** `presenceObjectCreate`: the object is created new, or not at all; an existing name is `exists`, never replaced. */
export interface NativePresenceObject {
	readonly status: "created" | "exists" | "root_mismatch" | "root_not_local" | "insecure" | "failed" | "unavailable";
	readonly volumeSerial?: string | null;
	readonly fileId?: string | null;
	readonly locality?: "local" | "not_local" | null;
	readonly reason?: string | null;
	readonly reportedFileSystem?: string | null;
	readonly step?: string | null;
	readonly code?: number | null;
}

/** FOLDERID_LocalAppData. */
export interface NativeKnownFolder {
	readonly status: "found" | "failed" | "unavailable";
	readonly path?: string | null;
	readonly code?: number | null;
	readonly reason?: string | null;
}

/** `presenceRootList`: the `*.presence` entries of a root, in name order. */
export interface NativePresenceRootListing {
	readonly status: "listed" | "failed" | "unavailable";
	readonly names?: readonly string[] | null;
	readonly reason?: string | null;
	readonly step?: string | null;
	readonly code?: number | null;
}

export interface NativePresenceHoldRequest {
	/** The caller's key for this hold; one hold per key at a time. */
	readonly holdId: string;
	readonly path: string;
}

/**
 * `presenceObjectHold` (Revision 7 "Presence cleanup"): an exclusive open with `DELETE` access and share mode 0. `busy`
 * is a sharing violation (another handle is open), `missing` is not-found. A held object reports its identity and its
 * whole content; the hold stays until `presenceObjectRelease` names it.
 */
export interface NativePresenceHold {
	readonly status: "held" | "busy" | "missing" | "failed" | "unavailable";
	readonly volumeSerial?: string | null;
	readonly fileId?: string | null;
	readonly header?: Buffer | null;
	readonly reason?: string | null;
	readonly step?: string | null;
	readonly code?: number | null;
}

/** `presenceObjectRelease`: `deleted` only when delete-on-close was set through the held handle before it closed. */
export interface NativePresenceHoldRelease {
	readonly status: "deleted" | "closed" | "failed" | "unavailable";
	readonly reason?: string | null;
	readonly step?: string | null;
	readonly code?: number | null;
}

/**
 * What one opened process handle answered (`processOpen`, `processObserve`; crate `process_binding.rs`): `opened` carries
 * `GetProcessId`, the complete creation FILETIME as a decimal string, the `TokenUser` SID and the exit state read on that
 * one handle, each `null` when its query failed. `exited` (with `exitCode`) and `cancelled` are the answers of
 * `processWaitExit`. napi-rs leaves an absent optional field `undefined`.
 */
export interface NativeProcessObservation {
	readonly status:
		| "opened"
		| "no_such_process"
		| "access_denied"
		| "failed"
		| "held"
		| "not_held"
		| "closed"
		| "exited"
		| "cancelled"
		| "unavailable";
	readonly reason?: string | null;
	readonly code?: number | null;
	readonly handlePid?: number | null;
	readonly creationTime?: string | null;
	readonly userSid?: string | null;
	readonly exited?: boolean | null;
	/** `GetExitCodeProcess` of a signalled object (`exited`); `null` when it could not be read. */
	readonly exitCode?: number | null;
}

/**
 * The Windows process-identity adapter (#4199 design 4.2a "OS identity", Revision 8 clause (ii)): `processOpen` opens a
 * PID once with `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)`, reads its facts on that handle and RETAINS
 * it under `handleId` until `processClose`, so an issuer keeps the handle it verified on while it grants and observes the
 * participant; `processObserve` rereads the retained handle. JS never owns the HANDLE.
 *
 * `processWaitExit` is the design's process-object exit signalling ("`RegisterWaitForSingleObject` or equivalent, not
 * wrapper exit"): it resolves `exited` once the retained process object is signalled, `cancelled` on
 * `processCancelWaitExit(waitId)` or on the close of the handle, and `not_held`, `held` (`wait_pending`) or `failed` at
 * once. The bridge waits on a duplicate of the handle on its own thread; nothing polls.
 */
export interface NativeProcessBinding {
	processOpen(handleId: string, pid: number): NativeProcessObservation;
	processObserve(handleId: string): NativeProcessObservation;
	processClose(handleId: string): NativeProcessObservation;
	processWaitExit(handleId: string, waitId: string): Promise<NativeProcessObservation>;
	processCancelWaitExit(waitId: string): void;
}

/**
 * What presence placement, cleanup and process evidence need from the bridge (#4199 design 4.2a "Placement.", "Presence
 * cleanup", "OS identity").
 */
export interface NativePresencePlacementBinding
	extends NativeSocketSecretBinding, NativePresenceBinding, NativeProcessBinding {
	localAppDataPath(): NativeKnownFolder;
	presenceRootOpen(path: string, create: boolean): NativePresenceRoot;
	presenceObjectCreate(request: NativePresenceObjectRequest): NativePresenceObject;
	presenceRootList(path: string): NativePresenceRootListing;
	presenceObjectHold(request: NativePresenceHoldRequest): NativePresenceHold;
	presenceObjectRelease(holdId: string, deleteObject: boolean): NativePresenceHoldRelease;
}

export type PresencePlacementUnavailableReason = "unsupported_platform" | "native_unavailable" | "native_abi_mismatch";

export type PresencePlacementLoad =
	| { readonly status: "available"; readonly native: NativePresencePlacementBinding }
	| { readonly status: "unavailable"; readonly reason: PresencePlacementUnavailableReason };

/**
 * The placement natives, or why they are unavailable. Off Windows nothing is loaded. On Windows a bridge that cannot be
 * loaded, or lacks an export, cannot classify anything, and an unclassifiable root is not a local one: the caller records
 * `presence_unavailable` rather than refusing startup, and a recorded root it cannot open fails typed instead.
 */
export function loadPresencePlacement(options: SocketSecretNativeOptions = {}): PresencePlacementLoad {
	if ((options.platform ?? process.platform) !== "win32")
		return { status: "unavailable", reason: "unsupported_platform" };
	let binding: NativeSocketSecretBinding;
	try {
		binding = loadSocketSecretNative(options);
	} catch (error: unknown) {
		if (error instanceof SocketSecretNativeUnavailableError)
			return { status: "unavailable", reason: "native_unavailable" };
		if (error instanceof SocketSecretNativeAbiMismatchError) {
			return { status: "unavailable", reason: "native_abi_mismatch" };
		}
		throw error;
	}
	const exports = binding as unknown as Record<string, unknown>;
	const complete = [
		"localAppDataPath",
		"presenceRootOpen",
		"presenceObjectCreate",
		"presenceRootList",
		"presenceObjectHold",
		"presenceObjectRelease",
		"presenceAcquire",
		"presenceProbe",
		"presenceProbeRetained",
		"presencePreActionCheck",
		"presenceWaitAndAcquire",
		"presenceCancelWait",
		"presenceReleaseAfterQuiescence",
		"processOpen",
		"processObserve",
		"processClose",
		"processWaitExit",
		"processCancelWaitExit",
	].every((name) => typeof exports[name] === "function");
	return complete
		? { status: "available", native: binding as NativePresencePlacementBinding }
		: { status: "unavailable", reason: "native_abi_mismatch" };
}

/** POSIX endpoints have no public-secret presence contract. Do not load a Windows bridge there. */
export function loadSocketSecretPresence(
	options: SocketSecretNativeOptions = {},
	native?: NativePresenceBinding,
):
	| { readonly status: "available"; readonly guard: SocketSecretPresence }
	| { readonly status: "unavailable"; readonly reason: "unsupported_platform" } {
	if ((options.platform ?? process.platform) !== "win32") {
		return { status: "unavailable", reason: "unsupported_platform" };
	}
	const binding = native ?? loadSocketSecretNative(options);
	assertPresenceBinding(binding);
	return {
		status: "available",
		guard: {
			acquire: (id, path) => binding.presenceAcquire(id, path),
			probe: (request) => binding.presenceProbe(request),
			probeRetained: (request) => binding.presenceProbeRetained(request),
			preActionCheck: (id) => binding.presencePreActionCheck(id),
			releaseAfterQuiescence: (receipt) => binding.presenceReleaseAfterQuiescence(receipt),
			async waitAndAcquire(id, path, signal) {
				if (signal?.aborted) return { status: "cancelled" };
				// The native call registers its cancellation token synchronously before queuing work.
				const waitId = randomUUID();
				const waiting = binding.presenceWaitAndAcquire(id, path, waitId);
				const cancel = () => binding.presenceCancelWait(waitId);
				signal?.addEventListener("abort", cancel, { once: true });
				try {
					return await waiting;
				} finally {
					signal?.removeEventListener("abort", cancel);
				}
			},
		},
	};
}

function assertPresenceBinding(value: object): asserts value is NativePresenceBinding {
	const exports = value as Record<string, unknown>;
	if (
		![
			"presenceAcquire",
			"presenceProbe",
			"presenceProbeRetained",
			"presencePreActionCheck",
			"presenceWaitAndAcquire",
			"presenceCancelWait",
			"presenceReleaseAfterQuiescence",
		].every((name) => typeof exports[name] === "function")
	) {
		throw new SocketSecretNativeAbiMismatchError("presence registry");
	}
}

export interface SocketSecretNativeOptions {
	readonly packageDir?: string;
	readonly moduleDir?: string;
	readonly execPath?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: string;
	readonly arch?: string;
	readonly requireBinding?: (modulePath: string) => unknown;
}

export class SocketSecretNativeUnavailableError extends Error {
	readonly code = "socket-secret-native-unavailable";
	readonly attemptedPaths: readonly string[];

	constructor(host: string, attemptedPaths: readonly string[], causes: readonly string[]) {
		super(`The Windows socket-secret bridge for ${host} could not be loaded: ${causes.join("; ")}`);
		this.name = "SocketSecretNativeUnavailableError";
		this.attemptedPaths = attemptedPaths;
	}
}

/** The bridge could not publish; `stagingLeftBehind` is set when its staging file also survived. */
export class SocketSecretPublishError extends Error {
	readonly code = "socket-secret-publish-failed";
	readonly step: string;
	readonly windowsError: number | null;
	readonly stagingLeftBehind: LeftBehindStaging | null;

	constructor(step: string, windowsError: number | null, stagingLeftBehind: LeftBehindStaging | null) {
		const cause = windowsError === null ? step : `${step} failed with Windows error ${windowsError}`;
		const leftover = stagingLeftBehind ? `; ${stagingLeftBehind.action}` : "";
		super(`Publishing the socket secret failed: ${cause}${leftover}`);
		this.name = "SocketSecretPublishError";
		this.step = step;
		this.windowsError = windowsError;
		this.stagingLeftBehind = stagingLeftBehind;
	}
}

/**
 * First publication through the bridge (design 4.3): resolves `published` or `collision` (read the winner), throws
 * `SocketSecretPublishError` otherwise. Either way a staging file the bridge could not delete is returned typed.
 */
export function publishSocketSecretNoReplace(
	binding: Pick<NativeSocketSecretBinding, "publishNoReplace">,
	stagingPath: string,
	finalPath: string,
	bytes: Buffer,
): SocketSecretPublication {
	const result = binding.publishNoReplace(stagingPath, finalPath, bytes);
	const native = result.stagingLeftBehind;
	const stagingLeftBehind = native
		? {
				path: native.path,
				windowsError: native.windowsError,
				action: `Delete the leftover socket-secret staging file ${native.path}`,
			}
		: null;
	if (result.outcome === "published" || result.outcome === "collision") {
		return { outcome: result.outcome, stagingLeftBehind };
	}
	if (result.outcome === "failed" && result.failure) {
		throw new SocketSecretPublishError(result.failure.step, result.failure.code, stagingLeftBehind);
	}
	throw new SocketSecretPublishError(`unexpected bridge outcome ${String(result.outcome)}`, null, stagingLeftBehind);
}

export class SocketSecretNativeAbiMismatchError extends Error {
	readonly code = "socket-secret-native-abi-mismatch";
	readonly modulePath: string;

	constructor(modulePath: string) {
		super(
			`Socket-secret bridge ABI mismatch in ${modulePath}: expected __senpiSocketSecretAbi1() === "${NATIVE_SOCKET_SECRET_ABI_VERSION}" and every export`,
		);
		this.name = "SocketSecretNativeAbiMismatchError";
		this.modulePath = modulePath;
	}
}

export function socketSecretNativeCandidatePaths(options: SocketSecretNativeOptions = {}): readonly string[] {
	const env = options.env ?? process.env;
	// An explicit override is authoritative, including when it cannot be loaded.
	const override = env[SOCKET_SECRET_NATIVE_PATH_ENV];
	if (override) return [override];
	const host = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
	const relative = join("native", "socket-secret", "prebuilds", host, `senpi_socket_secret.${host}.node`);
	const packageDir = options.packageDir ?? (env.SENPI_PACKAGE_DIR || getPackageDir());
	const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url));
	const execPath = options.execPath ?? process.execPath;
	return [join(packageDir, relative), join(moduleDir, "../../..", relative), join(dirname(execPath), relative)];
}

/** Loads the bridge or throws; a sentinel mismatch stops at once instead of trying the next candidate. */
export function loadSocketSecretNative(options: SocketSecretNativeOptions = {}): NativeSocketSecretBinding {
	const attemptedPaths = socketSecretNativeCandidatePaths(options);
	const requireBinding = options.requireBinding ?? createRequire(import.meta.url);
	const causes: string[] = [];
	for (const modulePath of attemptedPaths) {
		let binding: unknown;
		try {
			binding = requireBinding(modulePath);
		} catch (error) {
			causes.push(`${modulePath}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		assertBinding(binding, modulePath);
		return binding;
	}
	throw new SocketSecretNativeUnavailableError(
		`${options.platform ?? process.platform}-${options.arch ?? process.arch}`,
		attemptedPaths,
		causes,
	);
}

function assertBinding(value: unknown, modulePath: string): asserts value is NativeSocketSecretBinding {
	if (typeof value !== "object" || value === null) throw new SocketSecretNativeAbiMismatchError(modulePath);
	const exports = value as Record<string, unknown>;
	const complete = ["__senpiSocketSecretAbi1", "publishNoReplace", "kernelSessionIdentity", "classifyVolume"].every(
		(name) => typeof exports[name] === "function",
	);
	if (!complete || (exports.__senpiSocketSecretAbi1 as () => unknown)() !== NATIVE_SOCKET_SECRET_ABI_VERSION) {
		throw new SocketSecretNativeAbiMismatchError(modulePath);
	}
}
