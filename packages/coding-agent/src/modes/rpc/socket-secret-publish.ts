/**
 * First publication of the public socket secret through the Windows bridge (`crates/senpi-socket-secret`,
 * sisyphuslabs/omo-desktop-app#4199). The bridge result crosses a native boundary, so it is parsed here, never trusted.
 */

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

/** The bridge could not publish; `stagingLeftBehind` is set when its staging file also survived. */
export class SocketSecretPublishError extends Error {
	readonly code = "socket-secret-publish-failed";
	readonly step: string;
	readonly windowsError: number | null;
	readonly stagingLeftBehind: LeftBehindStaging | null;

	constructor(
		step: string,
		windowsError: number | null,
		stagingLeftBehind: LeftBehindStaging | null,
		options?: ErrorOptions,
	) {
		const cause = windowsError === null ? step : `${step} failed with Windows error ${windowsError}`;
		const leftover = stagingLeftBehind ? `; ${stagingLeftBehind.action}` : "";
		super(`Publishing the socket secret failed: ${cause}${leftover}`, options);
		this.name = "SocketSecretPublishError";
		this.step = step;
		this.windowsError = windowsError;
		this.stagingLeftBehind = stagingLeftBehind;
	}
}

/**
 * First publication through the bridge (design 4.3): resolves `published` or `collision` (read the winner), throws
 * `SocketSecretPublishError` otherwise, including when the binding call itself throws (an unsupported platform, an
 * argument conversion) or returns a result of the wrong shape. Either way a staging file the bridge could not delete
 * is returned typed.
 */
export function publishSocketSecretNoReplace(
	binding: { publishNoReplace(stagingPath: string, finalPath: string, bytes: Buffer): NativePublishResult },
	stagingPath: string,
	finalPath: string,
	bytes: Buffer,
): SocketSecretPublication {
	let result: unknown;
	try {
		result = binding.publishNoReplace(stagingPath, finalPath, bytes);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new SocketSecretPublishError(`bridge call threw: ${reason}`, null, null, { cause: error });
	}
	// A native boundary: the declared result type is not a guarantee, and a value of the wrong shape must fail typed too.
	if (!isRecord(result)) {
		throw new SocketSecretPublishError(`unexpected bridge result ${String(result)}`, null, null);
	}
	const native = result.stagingLeftBehind;
	if (native !== undefined && native !== null && !isLeftBehindStaging(native)) {
		throw new SocketSecretPublishError("unexpected bridge result: malformed stagingLeftBehind", null, null);
	}
	const stagingLeftBehind = native
		? {
				path: native.path,
				windowsError: native.windowsError,
				action: `Delete the leftover socket-secret staging file ${native.path}`,
			}
		: null;
	const { outcome, failure } = result;
	if (outcome === "published" || outcome === "collision") {
		return { outcome, stagingLeftBehind };
	}
	if (outcome !== "failed") {
		throw new SocketSecretPublishError(`unexpected bridge outcome ${String(outcome)}`, null, stagingLeftBehind);
	}
	if (!isRecord(failure) || typeof failure.step !== "string" || typeof failure.code !== "number") {
		throw new SocketSecretPublishError("unexpected bridge result: malformed failure", null, stagingLeftBehind);
	}
	throw new SocketSecretPublishError(failure.step, failure.code, stagingLeftBehind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLeftBehindStaging(value: unknown): value is NativeLeftBehindStaging {
	return isRecord(value) && typeof value.path === "string" && typeof value.windowsError === "number";
}
