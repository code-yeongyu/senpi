// E27 (plan §6.4, Z1.b): the example extension custom-provider-gitlab-duo, unmodified. O1-O7.
//
// examples/extensions/custom-provider-gitlab-duo registers the `gitlab-duo` provider: each request first exchanges the
// GitLab token (`GITLAB_TOKEN`, synthetic) for a direct-access token at gitlab.com, then streams through GitLab's AI
// gateway proxy with that token and its headers, on the Anthropic backend or the OpenAI Responses backend depending on
// the model. Both hosts are fixed in code, so fixtures/offline-network.mjs answers the token exchange itself (a synthetic
// token and header: not a model request, so it consumes no scripted turn) and sends the gateway origin to the fake model
// server with the path unchanged. The extension's own auth shows in O4 (the proxied requests carry the exchanged token
// and header). Prompt 1 runs on claude-sonnet-4-6 and calls `read`; RPC set_model switches to gpt-5.5-2026-04-23 and
// prompt 2 runs on the Responses backend.
import { exampleExtension, OFFLINE_NETWORK, useModel } from "./support/example-extensions.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

const DIRECT_ACCESS = "POST https://gitlab.com/api/v4/ai/third_party_agents/direct_access";
/** The synthetic GitLab token and the exchanged token, joined at run time so no key-shaped literal is in source. */
const SYNTHETIC_GITLAB_TOKEN = ["test", "not", "a", "key", "e27"].join("-");
const SYNTHETIC_DIRECT_ACCESS_TOKEN = ["test", "not", "a", "key", "e27", "direct", "access"].join("-");

export default {
	id: "E27",
	title: "example extension custom-provider-gitlab-duo, unmodified",
	observables: WITHOUT_O8,
	spec: () => ({
		extensions: [OFFLINE_NETWORK, exampleExtension("custom-provider-gitlab-duo")],
		files: { "a.txt": "alpha\n" },
		env: {
			EQ_ROUTE_ORIGINS: "https://cloud.gitlab.com",
			EQ_LOCAL_RESPONSES: JSON.stringify({
				[DIRECT_ACCESS]: { token: SYNTHETIC_DIRECT_ACCESS_TOKEN, headers: { "x-gitlab-eq-direct-access": "e27" } },
			}),
			GITLAB_TOKEN: SYNTHETIC_GITLAB_TOKEN,
		},
		turns: [
			{ toolCalls: [{ id: "toolu_e27_read", name: "read", args: { path: "a.txt" } }] },
			{ text: "E27-ANTHROPIC-DONE" },
			{ text: "E27-OPENAI-DONE" },
		],
	}),
	async drive(run) {
		useModel(run, "gitlab-duo", "claude-sonnet-4-6");
		await run.open();
		await run.prompt("read a.txt");
		await run.send({ type: "set_model", provider: "gitlab-duo", modelId: "gpt-5.5-2026-04-23" });
		await run.prompt("and now on the other backend");
		await run.close();
	},
};
