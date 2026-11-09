import type { ExtensionAPI, ExtensionFactory } from "../../src/index.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

export async function createExecuteToolHarness(
	factory: (pi: ExtensionAPI) => void,
): Promise<Harness & { readonly api: ExtensionAPI }> {
	let api: ExtensionAPI | undefined;
	const extensionFactories: ExtensionFactory[] = [
		(pi) => {
			api = pi;
			factory(pi);
		},
	];
	const harness = await createHarness({ extensionFactories });
	if (api === undefined) throw new Error("the executeTool harness extension was not loaded");
	return { ...harness, api };
}
