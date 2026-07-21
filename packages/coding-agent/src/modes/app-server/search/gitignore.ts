import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore from "ignore";

type IgnoreMatcher = ReturnType<typeof ignore>;

export type IgnoreScope = {
	readonly directory: string;
	readonly matcher: IgnoreMatcher;
};

export async function addGitignoreScope(
	matchers: readonly IgnoreScope[],
	directory: string,
): Promise<readonly IgnoreScope[]> {
	const gitignore = await readableText(join(directory, ".gitignore"));
	if (gitignore === undefined) return matchers;
	return [...matchers, { directory, matcher: ignore().add(gitignore) }];
}

export function isIgnored(matchers: readonly IgnoreScope[], path: string, isDirectory: boolean): boolean {
	let ignored = false;
	for (const scope of matchers) {
		const relativePath = relative(scope.directory, path).split(sep).join("/");
		const result = scope.matcher.test(isDirectory ? `${relativePath}/` : relativePath);
		if (result.ignored) ignored = true;
		if (result.unignored) ignored = false;
	}
	return ignored;
}

async function readableText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error: unknown) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}
