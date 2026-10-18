import { StaleExtensionContextError } from "../../src/core/extensions/stale-context-error.ts";
import { installStaleExtensionContainment } from "../../src/core/stale-extension-containment.ts";
import { installEarlyInspectorVmImportRecovery } from "../../src/inspector-policy.ts";

installEarlyInspectorVmImportRecovery();
installStaleExtensionContainment();

const STALE = "This extension ctx is stale after session replacement or reload.";
const scenario = process.argv[2];

setTimeout(() => {
	switch (scenario) {
		case "stale-sync":
			throw new StaleExtensionContextError(STALE);
		case "stale-async":
			void Promise.reject(new StaleExtensionContextError(STALE));
			return;
		case "real-sync":
			throw new Error("real bug");
		case "real-async":
			void Promise.reject(new Error("real bug"));
			return;
		default:
			throw new Error(`unknown scenario ${scenario}`);
	}
}, 0);

setTimeout(() => {
	process.stdout.write("STILL ALIVE\n");
}, 200);
