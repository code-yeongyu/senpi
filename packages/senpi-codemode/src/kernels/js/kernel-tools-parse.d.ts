export function parseToolFunction(fn: unknown): {
	readonly name: string;
	readonly params: readonly string[];
	readonly async: boolean;
};
