// E26 (plan §6.4, Z1.b): the example extension custom-provider-anthropic, unmodified. O1-O7.
//
// examples/extensions/custom-provider-anthropic registers the `custom-anthropic` provider with its own API id and its own
// `streamSimple` (the Anthropic SDK, created per request with `baseURL: model.baseUrl`), authenticated by the documented
// `CUSTOM_ANTHROPIC_API_KEY` (a synthetic value). Its base URL is fixed in code (https://api.anthropic.com), so
// fixtures/offline-network.mjs sends that origin to the fake model server with the path unchanged (O1/O2 see
// `/v1/messages`). The session runs on `custom-anthropic/claude-sonnet-4-5`: one prompt whose turn calls `read` through
// the extension's tool_use mapping, then a text turn.
import { exampleExtension, OFFLINE_NETWORK, useModel } from "./support/example-extensions.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

/** The synthetic API key, joined at run time so no key-shaped literal is in source. */
const SYNTHETIC_KEY = ["test", "not", "a", "key", "e26"].join("-");

export default {
	id: "E26",
	title: "example extension custom-provider-anthropic, unmodified",
	observables: WITHOUT_O8,
	spec: () => ({
		extensions: [OFFLINE_NETWORK, exampleExtension("custom-provider-anthropic")],
		files: { "a.txt": "alpha\n" },
		env: { EQ_ROUTE_ORIGINS: "https://api.anthropic.com", CUSTOM_ANTHROPIC_API_KEY: SYNTHETIC_KEY },
		turns: [{ toolCalls: [{ id: "toolu_e26_read", name: "read", args: { path: "a.txt" } }] }, { text: "E26-DONE" }],
	}),
	async drive(run) {
		useModel(run, "custom-anthropic", "claude-sonnet-4-5");
		await run.open();
		await run.prompt("read a.txt");
		await run.close();
	},
};
