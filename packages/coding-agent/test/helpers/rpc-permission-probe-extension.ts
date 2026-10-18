/**
 * Loaded into REAL supervised hosts by rpc-host-handover-permission-preset.test.ts through
 * `hostArgs()`'s `--extension` slot. Registers one no-network gated tool, `shell_fixture`,
 * so a prompt over the socket either raises a permission request or provably does not.
 */
import { Type } from "typebox";
import type { ExtensionFactory } from "../../src/index.ts";

const factory: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "shell_fixture",
		label: "shell_fixture",
		description: "no-network gated probe for the senpi#2465 host-handover permission legs",
		parameters: Type.Object({ command: Type.String() }),
		async execute() {
			return { content: [{ type: "text", text: "shell_fixture executed" }], details: {} };
		},
	});
};

export default factory;
