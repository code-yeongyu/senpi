import { homedir } from "node:os";

// A shell whose working directory was deleted (a removed worktree or checkout) still starts this
// process: Node boots with the stale handle and only throws `uv_cwd` when something evaluates
// process.cwd(). The bundled agent SDK does that during module evaluation, before any user code
// can recover, so the guard must run before every other import - keep it dependency-free.
try {
	process.cwd();
} catch {
	const fallback = homedir();
	process.chdir(fallback);
	console.error(`the current working directory no longer exists; continuing from ${fallback}`);
}
