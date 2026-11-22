import { isRecoverableInspectorVmImportError } from "../inspector-policy.ts";
import { hasModeCrashHandler } from "./bootstrap-crash-listeners.ts";
import { isStaleExtensionContextError } from "./extensions/builtin/goal/stale-context.ts";
import { appendDebugLogEntry } from "./hidden-stdout-log.ts";

type CrashOrigin = "uncaughtException" | "unhandledRejection";

/**
 * The runner's stale guard throws before a retired generation's operation runs, so the live session
 * must keep running: log the stack (it names the extension to fix) and stop there (oh-my-openagent#7114).
 */
export function containStaleExtensionError(error: unknown, origin: CrashOrigin): boolean {
	if (!isStaleExtensionContextError(error)) return false;
	try {
		appendDebugLogEntry(`contained stale extension ctx (${origin})`, error.stack ?? error.message);
	} catch {}
	return true;
}

let installed = false;

/**
 * Print, RPC and host processes have no crash handler of their own. This contains only the stale-ctx
 * error and keeps every other uncaught throw fatal, exactly like the runtime default. It adds no
 * `unhandledRejection` listener: that would change the default routing of every rejection, including
 * the Inspector rejection the early seam recovers through `uncaughtException`.
 */
export function installStaleExtensionContainment(): void {
	if (installed) return;
	installed = true;
	process.on("uncaughtException", (error: Error, origin?: CrashOrigin) => {
		if (containStaleExtensionError(error, origin ?? "uncaughtException")) return;
		if (hasModeCrashHandler("uncaughtException")) return;
		// The early Inspector seam (installed just before this one) owns its recoverable rejection.
		if (isRecoverableInspectorVmImportError(error, origin ?? "uncaughtException")) return;
		console.error(error);
		process.exit(1);
	});
}
