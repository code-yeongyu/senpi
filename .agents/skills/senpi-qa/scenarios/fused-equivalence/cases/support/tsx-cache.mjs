// tsx's transpile cache, as a run-owned resource. tsx writes it to `<os temp>/tsx-<euid or username>`
// (node_modules/tsx/dist/temporary-directory-*.mjs), fixed when its module loads, so neither a later
// TSX_DISABLE_CACHE nor a case can move it. The EQ harness creates it whenever tsx transpiles: E19 loads the
// Cursor protobuf schemas through `tsImport` (cursor-exec-lifecycle/wire.mjs), and a Node CLI child runs through the
// tsx CLI. A run that created the directory removes it when it ends; one that found it already there leaves it alone.
import { existsSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** Claim the tsx cache directory for this run; the returned function removes it if this run created it. */
export function ownTsxCache() {
	const dir = join(tmpdir(), `tsx-${process.geteuid ? process.geteuid() : userInfo().username}`);
	const existed = existsSync(dir);
	return () => {
		if (!existed) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
	};
}
