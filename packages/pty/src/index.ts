import { loadNativePty, type NativePtyLoadResult, type NativePtyUnavailableDiagnostic } from "./native-loader.ts";

export type {
	NativePtyBinding,
	NativePtyLoadResult,
	NativePtyUnavailableDiagnostic,
} from "./native-loader.ts";
export {
	detectNativePtyRuntime,
	getNativePtyCandidatePaths,
	getNativePtyHost,
	type NativePtyRuntime,
	NativePtySentinelMismatchError,
} from "./native-loader.ts";

export interface PtySessionOptions {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly cols?: number;
	readonly rows?: number;
}

export class PtySession {
	readonly options: PtySessionOptions;
	private readonly nativeLoadResult: NativePtyLoadResult;

	constructor(options: PtySessionOptions = {}) {
		this.options = {
			...options,
			args: options.args ? [...options.args] : undefined,
			env: options.env ? { ...options.env } : undefined,
		};
		this.nativeLoadResult = loadNativePty();
	}

	get native(): NativePtyLoadResult {
		return this.nativeLoadResult;
	}

	get unavailableDiagnostic(): NativePtyUnavailableDiagnostic | null {
		if (this.nativeLoadResult.native !== null) return null;
		return this.nativeLoadResult.diagnostic;
	}
}

export function loadPtyNative(): NativePtyLoadResult {
	return loadNativePty();
}
