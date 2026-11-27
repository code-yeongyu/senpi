/**
 * The answer every exported engine function gives (senpi#7450): data, or a typed refusal. No function
 * prints, exits the process or throws for a domain failure; the CLI renders the answer.
 */

/** A warning the command printed before its answer: project trust, an unreadable settings file, or a runtime start-up diagnostic. */
export type EngineDiagnostic =
	| { readonly kind: "project_trust"; readonly message: string }
	| {
			readonly kind: "settings";
			readonly context: string;
			readonly scope: "global" | "project";
			readonly message: string;
			readonly stack?: string;
	  }
	| { readonly kind: "runtime"; readonly type: "info" | "warning" | "error"; readonly message: string };

export interface EngineOk<T> {
	readonly kind: "ok";
	readonly value: T;
	readonly diagnostics: readonly EngineDiagnostic[];
}

export interface EngineError<C extends string> {
	readonly kind: "error";
	readonly error: {
		readonly code: C;
		readonly message: string;
		readonly details?: Readonly<Record<string, unknown>>;
	};
	readonly diagnostics: readonly EngineDiagnostic[];
}

export type EngineResult<T, C extends string> = EngineOk<T> | EngineError<C>;

export function engineOk<T>(value: T, diagnostics: readonly EngineDiagnostic[] = []): EngineOk<T> {
	return { kind: "ok", value, diagnostics };
}

export function engineError<C extends string>(
	code: C,
	message: string,
	options: {
		readonly details?: Readonly<Record<string, unknown>>;
		readonly diagnostics?: readonly EngineDiagnostic[];
	} = {},
): EngineError<C> {
	return {
		kind: "error",
		error: { code, message, ...(options.details === undefined ? {} : { details: options.details }) },
		diagnostics: options.diagnostics ?? [],
	};
}

/** The message of a thrown value, or `fallback` when it is not an Error - the wording the commands already print. */
export function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}
