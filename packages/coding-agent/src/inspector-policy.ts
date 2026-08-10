import { close as closeInspector, url as inspectorUrl } from "node:inspector";
import { envValue } from "./core/brand.ts";

type UncaughtExceptionOrigin = "uncaughtException" | "unhandledRejection";

const VM_DYNAMIC_IMPORT_CALLBACK_MISSING = "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING";
const INSPECTOR_IMPORT_FRAME = "at importModuleDynamicallyCallback (node:internal/modules/esm/";
const INSPECTOR_TIMEOUT_FRAME = /\bat Timeout\._onTimeout \(<anonymous>:\d+:\d+\)/;
const RECOVER_INSPECTOR_VM_IMPORT = envValue("RECOVER_INSPECTOR_VM_IMPORT") === "1";

export const INSPECTOR_VM_IMPORT_WARNING =
	"Node Inspector dynamic import is unsupported; use require() or a target-side loader. Senpi kept running.";

function hasInheritedInspectorOption(): boolean {
	return (
		process.execArgv.some((argument) => argument.startsWith("--inspect")) ||
		process.env.NODE_OPTIONS?.includes("--inspect") === true
	);
}

export function releaseInheritedInspectorForChild(): void {
	if (inspectorUrl() !== undefined && hasInheritedInspectorOption()) {
		closeInspector();
	}
}

export function isRecoverableInspectorVmImportError(error: unknown, origin: UncaughtExceptionOrigin): boolean {
	if (!RECOVER_INSPECTOR_VM_IMPORT || origin !== "unhandledRejection") {
		return false;
	}
	// A hostile rejection value can throw from a `has` trap or a `code`/`stack` getter. An
	// exception raised inside an uncaughtException handler terminates the process before any
	// terminal restoration can run, so crash-policy inspection must stay non-throwing and
	// classify such values as non-recoverable.
	try {
		if (inspectorUrl() === undefined) {
			return false;
		}
		if (typeof error !== "object" || error === null || !("code" in error) || !("stack" in error)) {
			return false;
		}
		return (
			error.code === VM_DYNAMIC_IMPORT_CALLBACK_MISSING &&
			typeof error.stack === "string" &&
			error.stack.includes(INSPECTOR_IMPORT_FRAME) &&
			INSPECTOR_TIMEOUT_FRAME.test(error.stack)
		);
	} catch {
		return false;
	}
}

let earlyRecoveryCount = 0;
let earlyRecoveryInstalled = false;

/**
 * Install the process-level recovery seam before any asynchronous bootstrap work.
 *
 * With `--inspect-brk` the debugger is usable at the first line of the user script, so the
 * reported delayed Inspector `import()` rejection can fire during `main()` bootstrap, before
 * interactive mode registers its terminal-restoring uncaughtException handler. This listener
 * exists only under the explicit `SENPI_RECOVER_INSPECTOR_VM_IMPORT=1` opt-in: it swallows
 * exactly the recoverable Inspector rejection (counting it for a deferred TUI warning) and
 * re-creates Node's default fatal outcome for everything else so bootstrap crashes stay loud.
 */
export function installEarlyInspectorVmImportRecovery(): void {
	if (!RECOVER_INSPECTOR_VM_IMPORT || earlyRecoveryInstalled) {
		return;
	}
	earlyRecoveryInstalled = true;
	process.on("uncaughtException", (error: Error, origin: UncaughtExceptionOrigin) => {
		// Interactive mode prepends its own crash handler, which runs first and owns both the
		// recovery warning and the fatal terminal-restoration path. Once any other handler is
		// registered, this early seam must neither double-count recoveries nor exit itself.
		const otherHandlerActive = process.listenerCount("uncaughtException") > 1;
		if (isRecoverableInspectorVmImportError(error, origin)) {
			if (!otherHandlerActive) {
				earlyRecoveryCount++;
			}
			return;
		}
		if (otherHandlerActive) {
			return;
		}
		console.error(error);
		process.exit(1);
	});
}

/**
 * Return the number of Inspector rejections recovered before the TUI existed and clear the
 * pending count, so interactive mode can surface one deferred warning after startup.
 */
export function consumeEarlyInspectorVmImportRecoveries(): number {
	const count = earlyRecoveryCount;
	earlyRecoveryCount = 0;
	return count;
}
