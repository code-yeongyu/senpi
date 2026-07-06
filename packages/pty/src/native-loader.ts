import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativePtyBinding {
	readonly [exportName: string]: unknown;
}

export interface NativePtyUnavailableDiagnostic {
	readonly code: "native-unavailable";
	readonly host: string;
	readonly attemptedPath: string;
	readonly message: string;
	readonly cause?: string;
}

export type NativePtyLoadResult =
	| {
			readonly native: NativePtyBinding;
			readonly diagnostic: null;
	  }
	| {
			readonly native: null;
			readonly diagnostic: NativePtyUnavailableDiagnostic;
	  };

const require = createRequire(import.meta.url);

export function loadNativePty(): NativePtyLoadResult {
	const host = `${process.platform}-${process.arch}`;
	const attemptedPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"native",
		"prebuilds",
		host,
		"pi-pty.node",
	);
	try {
		return {
			native: require(attemptedPath) as NativePtyBinding,
			diagnostic: null,
		};
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		return {
			native: null,
			diagnostic: {
				code: "native-unavailable",
				host,
				attemptedPath,
				message: `No @earendil-works/pi-pty native prebuild is available for ${host}.`,
				cause,
			},
		};
	}
}
