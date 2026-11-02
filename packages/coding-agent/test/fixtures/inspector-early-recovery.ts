import { open as openInspector } from "node:inspector";
import { installStaleExtensionContainment } from "../../src/core/stale-extension-containment.ts";
import {
	consumeEarlyInspectorVmImportRecoveries,
	installEarlyInspectorVmImportRecovery,
} from "../../src/inspector-policy.ts";

// Simulates the --inspect-brk bootstrap window: the early recovery seam is installed and an
// Inspector-originated rejection fires before any interactive-mode crash handler exists.
const mode = process.argv[2];
if (mode !== "recoverable" && mode !== "fatal") throw new Error("Expected mode: recoverable | fatal");

openInspector(0, "127.0.0.1", false);
installEarlyInspectorVmImportRecovery();
// cli-main installs the stale-ctx seam right after this one; "with-containment" mirrors that order.
if (process.argv[3] === "with-containment") installStaleExtensionContainment();

const error = Object.assign(new TypeError("A dynamic import callback was not specified."), {
	code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
});
error.stack = [
	"TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]: A dynamic import callback was not specified.",
	"    at importModuleDynamicallyCallback (node:internal/modules/esm/utils:279:9)",
	`    at Timeout._onTimeout (${mode === "recoverable" ? "<anonymous>" : "evalmachine.<anonymous>"}:1:16)`,
].join("\n");

setTimeout(() => {
	// The default unhandled-rejection mode raises this through the uncaughtException path
	// with origin "unhandledRejection", exactly like the reported Inspector eval crash.
	Promise.reject(error);
	// Fatal mode schedules nothing: the crash is its only way out, so a crash that leaks past the seams
	// ends with an empty loop (status 0) instead of racing an exit of its own. Bun reports the rejection
	// itself, sometimes ~100 ms later, which once lost to a 100 ms exit(0) timer here (senpi#3551).
	if (mode === "fatal") return;
	// Node handles the rejection when this timer callback's tick drains, before the check phase runs.
	setImmediate(() => {
		console.log(`recovered:${consumeEarlyInspectorVmImportRecoveries()}`);
		process.exit(0);
	});
}, 10);
