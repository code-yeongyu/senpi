import { close as closeInspector, url as inspectorUrl } from "node:inspector";

type UncaughtExceptionOrigin = "uncaughtException" | "unhandledRejection";

const VM_DYNAMIC_IMPORT_CALLBACK_MISSING = "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING";
const INSPECTOR_IMPORT_FRAME = "at importModuleDynamicallyCallback (node:internal/modules/esm/";
const INSPECTOR_TIMEOUT_FRAME = /\bat Timeout\._onTimeout \(<anonymous>:\d+:\d+\)/;
const RECOVER_INSPECTOR_VM_IMPORT = process.env.SENPI_RECOVER_INSPECTOR_VM_IMPORT === "1";

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
	if (!RECOVER_INSPECTOR_VM_IMPORT || origin !== "unhandledRejection" || inspectorUrl() === undefined) {
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
}
