import { resolvePath } from "../utils/paths.ts";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";

/**
 * Whether a session's recorded cwd is `resolvedCwd`, as recorded or where the OmO desktop moved it (senpi#2990).
 * The moved-path walk is synchronous filesystem work, so each matcher resolves a distinct recorded cwd at most once:
 * create one per listing call, and a filter re-run on every progress tick costs one walk per distinct cwd.
 */
export function sessionCwdMatcher(resolvedCwd: string): (cwd: string | undefined) => boolean {
	const mapped = new Map<string, string>();
	return (cwd) => {
		if (cwd === undefined || cwd === "") return false;
		if (resolvePath(cwd) === resolvedCwd) return true;
		let target = mapped.get(cwd);
		if (target === undefined) {
			target = resolvePath(resolveMovedPath(cwd));
			mapped.set(cwd, target);
		}
		return target === resolvedCwd;
	};
}
