export type Open = {
	readonly char: "{" | "[" | "(";
	readonly line: number;
	readonly headerLine?: number;
	/** Opened where a value may start, so it can still turn out to be an assignment target. */
	readonly target?: boolean;
	readonly foldable: boolean;
	readonly protected: boolean;
	readonly signature: boolean;
	readonly interpolation: boolean;
	readonly control: boolean;
	readonly call: boolean;
	readonly valueParameters: boolean;
	readonly declaration: boolean;
};

export const expressionKeywords = new Set([
	"return",
	"throw",
	"yield",
	"await",
	"case",
	"typeof",
	"void",
	"delete",
	"in",
	"of",
	"instanceof",
]);
export const controls = new Set(["if", "while", "for", "switch", "catch", "with"]);
export const signatureDeclarations = new Set(["type", "interface", "enum", "namespace", "module", "declare"]);

/** Only expression callees release argument values; declarations retain parameter protection. */
export function isCallCallee(previous: string, beforeWord: string): boolean {
	return (
		/^[A-Za-z_$][\w$]*$/.test(previous) &&
		!["function", "async", "new"].includes(previous) &&
		!expressionKeywords.has(previous) &&
		!controls.has(previous) &&
		[".", "=", ":", "return", "await", "new"].includes(beforeWord)
	);
}
