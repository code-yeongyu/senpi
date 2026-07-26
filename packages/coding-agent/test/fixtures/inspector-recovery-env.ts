import { close as closeInspector, open as openInspector } from "node:inspector";
import { isRecoverableInspectorVmImportError } from "../../src/inspector-policy.ts";

process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT = "1";
openInspector(0, "127.0.0.1", false);

const error = Object.assign(new TypeError("A dynamic import callback was not specified."), {
	code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
});
error.stack = [
	"TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]: A dynamic import callback was not specified.",
	"    at importModuleDynamicallyCallback (node:internal/modules/esm/utils:279:9)",
	"    at Timeout._onTimeout (<anonymous>:1:16)",
].join("\n");

try {
	console.log(isRecoverableInspectorVmImportError(error, "unhandledRejection"));
} finally {
	closeInspector();
}
