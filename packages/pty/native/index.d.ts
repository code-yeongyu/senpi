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

export function loadNativePty(): NativePtyLoadResult;

export const nativePty: NativePtyLoadResult;
