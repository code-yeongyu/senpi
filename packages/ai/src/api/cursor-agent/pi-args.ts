/**
 * Translate Cursor Pi frame args into the local tool kwargs that run them.
 *
 * Shared deliberately by two consumers: the `cursor-agent` API synthesizes a
 * display block from these and the coding-agent bridge executes with them.
 * Separate hand-rolled copies drift, and the drift is invisible — the
 * transcript shows one operation while a different one runs.
 *
 * Unlike upstream oh-my-pi (whose `read` tool takes inline path selectors),
 * senpi's tools take plain kwargs, so most mappings are direct.
 *
 * Every `optional int32` here is presence-sensitive: `0` is a supplied value,
 * not "unset", so it must never be folded into a default.
 */

/**
 * A `pi_read` range as the local `read` tool's `offset`/`limit` kwargs.
 *
 * `offset` is a 1-indexed start; `limit` is a line count. `null` marks a
 * present `limit: 0` — zero lines, which must be answered with empty output
 * directly rather than degrading into a whole-file read.
 */
export function piReadArgs(
	path: string,
	offset?: number,
	limit?: number,
): { path: string; offset?: number; limit?: number } | null {
	if (limit !== undefined && Math.floor(limit) <= 0) return null;
	return {
		path,
		offset: offset !== undefined ? Math.max(1, Math.floor(offset)) : undefined,
		limit: limit !== undefined ? Math.floor(limit) : undefined,
	};
}

/** The path a `pi_ls` / `lsArgs` frame lists; the local `ls` defaults to ".". */
export function piLsPath(basePath: string | undefined): string {
	return basePath || ".";
}

/** Clamp a present `optional int32` result cap; `undefined` stays unset. */
export function piLimit(limit: number | undefined): number | undefined {
	return limit === undefined ? undefined : Math.max(1, Math.floor(limit));
}

/**
 * A `pi_bash` frame's timeout as the local `bash` tool's kwarg (seconds).
 *
 * Presence-sensitive like every other `optional int32` here: `bash` documents
 * `timeout: 0` as "disables the command deadline", so folding a supplied `0`
 * into `undefined` applies the default deadline and kills exactly the
 * long-running command that asked not to be. Negative values have no local
 * meaning and fall back to the default.
 */
export function piTimeout(timeout: number | undefined): number | undefined {
	return timeout !== undefined && timeout >= 0 ? timeout : undefined;
}

/**
 * Compose a Cursor `workingDirectory` onto a command for the local `bash`
 * tool, which has no `cwd` kwarg. Single-quote escaping keeps arbitrary
 * directory names (spaces, `$`, backticks) inert.
 */
export function composeShellCommand(command: string, workingDirectory: string | undefined): string {
	if (!workingDirectory) return command;
	const quoted = `'${workingDirectory.replace(/'/g, "'\\''")}'`;
	return `cd ${quoted} && { ${command}\n}`;
}

/**
 * Drop keys whose value is `undefined` so optional local-tool kwargs stay
 * absent rather than present-as-undefined: schema validators reject a present
 * `undefined` on an optional field even though omitting the key is valid.
 */
export function omitUndefinedArgs<T extends Record<string, unknown>>(
	args: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(args)) {
		const value = args[key];
		if (value !== undefined) out[key] = value;
	}
	return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
