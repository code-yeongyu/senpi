import { z } from "zod";

const diagnosticSchema = z.object({
	message: z.string(),
	position: z.object({ line: z.number(), column: z.number() }).nullish(),
});
type SourceDiagnostic = { readonly message: string; readonly line?: number; readonly column?: number };

/** Preserve Bun's structured parser errors at the extension-load boundary. */
export class ExtensionSourceError extends Error {
	readonly name = "ExtensionSourceError";
	readonly filename: string;
	readonly diagnostics: readonly SourceDiagnostic[];
	constructor(filename: string, cause: AggregateError) {
		const diagnostics = z
			.array(diagnosticSchema)
			.parse(cause.errors)
			.map(({ message, position }) => ({
				message,
				...(position ? { line: position.line, column: position.column } : {}),
			}));
		super(
			diagnostics
				.map(
					(item) => `${filename}${item.line === undefined ? "" : `:${item.line}:${item.column}`}: ${item.message}`,
				)
				.join("\n"),
			{ cause },
		);
		this.filename = filename;
		this.diagnostics = diagnostics;
	}
}
