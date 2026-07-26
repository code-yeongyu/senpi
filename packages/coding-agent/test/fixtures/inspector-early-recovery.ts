import { open as openInspector } from "node:inspector";
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
	setTimeout(() => {
		console.log(`recovered:${consumeEarlyInspectorVmImportRecoveries()}`);
		process.exit(0);
	}, 100);
}, 10);
