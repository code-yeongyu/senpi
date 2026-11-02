import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { parse, relative, resolve, sep } from "node:path";
import { GateInputError } from "./gate-input-error.ts";

export async function writeGateOutput(path: string, contents: string): Promise<void> {
	let output = resolve(path);
	// These macOS-owned aliases are not user-created output-path links.
	if (process.platform === "darwin") {
		for (const alias of ["/var", "/tmp"]) {
			if (output === alias || output.startsWith(`${alias}/`))
				output = resolve(await realpath(alias), relative(alias, output));
		}
	}
	const root = parse(output).root;
	const parts = relative(root, output).split(sep);
	let cursor = root;
	for (const [index, part] of parts.entries()) {
		cursor = resolve(cursor, part);
		try {
			if ((await lstat(cursor)).isSymbolicLink()) throw new GateInputError(`symlinked gate output: ${output}`);
		} catch (error: unknown) {
			if (index === parts.length - 1 && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
	}
	const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW);
	try {
		await file.writeFile(contents);
	} finally {
		await file.close();
	}
}
