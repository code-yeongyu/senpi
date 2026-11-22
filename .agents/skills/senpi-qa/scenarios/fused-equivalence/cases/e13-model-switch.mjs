// E13 (plan §6.4, B20): model switch. O1-O7.
//
// One prompt on mock-model, an RPC set_model to mock-model-b on the same provider, and a second prompt: the second
// request names the new model (O2) and the transcript records the model change between the turns (O7).
import { WITHOUT_O8 } from "./support/observables.mjs";

export default {
	id: "E13",
	title: "model switch (B20)",
	observables: WITHOUT_O8,
	spec: {
		models: [{ id: "mock-model-b" }],
		turns: [{ text: "E13-FIRST" }, { text: "E13-SECOND" }],
	},
	async drive(run) {
		await run.open();
		await run.prompt("first");
		await run.send({ type: "set_model", provider: "mock", modelId: "mock-model-b" });
		await run.prompt("second");
		await run.close();
	},
};
