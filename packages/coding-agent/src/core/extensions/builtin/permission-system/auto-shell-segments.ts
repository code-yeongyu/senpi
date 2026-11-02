/**
 * Splits a shell command into the simple commands the `auto` preset can judge one by one.
 *
 * Only plain words joined by `;` or `&&` are understood. Quotes, escapes, expansions (`$`, `~`,
 * globs), redirects, pipes, background jobs, subshells, comments and line breaks return undefined,
 * and the caller asks the user.
 */
export interface ShellWord {
	readonly text: string;
}

export type ShellSegment = readonly ShellWord[];

const PLAIN_COMMAND = /^[A-Za-z0-9_\-.,/=+ \t;&]*$/;

const words = (part: string): ShellWord[] =>
	part
		.split(/[ \t]+/)
		.filter((text) => text !== "")
		.map((text) => ({ text }));

export function splitShellSegments(command: string): ShellSegment[] | undefined {
	if (!PLAIN_COMMAND.test(command)) return undefined;
	const chains = command.split("&&");
	if (chains.some((chain) => chain.includes("&"))) return undefined;
	const segments: ShellSegment[] = [];
	for (const [index, chain] of chains.entries()) {
		const parts = chain.split(";").map(words);
		if (index > 0 && parts[0]?.length === 0) return undefined;
		if (index < chains.length - 1 && parts[parts.length - 1]?.length === 0) return undefined;
		segments.push(...parts.filter((part) => part.length > 0));
	}
	return segments;
}
