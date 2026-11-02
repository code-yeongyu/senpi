import { resolve } from "node:path";
import {
	type GrepEngine,
	GrepEngineError,
	type GrepEngineErrorCode,
	type GrepEngineRequest,
	type GrepEngineResult,
} from "./engine.ts";
import type { NativeGrepBinding } from "./native-loader.ts";

export class NativeGrepEngine implements GrepEngine {
	readonly name = "native";
	private readonly binding: NativeGrepBinding;

	constructor(binding: NativeGrepBinding) {
		this.binding = binding;
	}

	async search(request: GrepEngineRequest, signal?: AbortSignal): Promise<GrepEngineResult> {
		if (signal?.aborted) throw new GrepEngineError("ABORTED", "Grep search aborted");
		if (request.pcre2) throw new GrepEngineError("UNSUPPORTED_REGEX", "Native grep does not support PCRE2");
		const cwd = resolve(request.cwd);
		try {
			// Glob arrays, type, caps, ranges and defaults already use the napi shape.
			// Pattern recovery and UNSUPPORTED_REGEX delegation belong to the facade.
			return await this.binding.grep(
				{ ...request, cwd, paths: request.paths.map((path) => resolve(cwd, path)) },
				signal,
			);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			const failure = new GrepEngineError(
				nativeErrorCode(code),
				error instanceof Error ? error.message : String(error),
			);
			failure.cause = error;
			throw failure;
		}
	}
}

function nativeErrorCode(code: unknown): GrepEngineErrorCode {
	switch (code) {
		case "UNSUPPORTED_REGEX":
		case "INVALID_PATTERN":
		case "INVALID_GLOB":
		case "UNKNOWN_TYPE":
		case "PATH_NOT_FOUND":
		case "ABORTED":
		case "ENGINE_UNAVAILABLE":
			return code;
		default:
			return "ENGINE_UNAVAILABLE";
	}
}

export function createNativeEngine(binding: NativeGrepBinding): GrepEngine {
	return new NativeGrepEngine(binding);
}
