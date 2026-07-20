import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { gitlabDuoProvider } from "../src/providers/gitlab-duo.ts";

describe("GitLab Duo model routing", () => {
	it("routes gpt-5.1 through chat completions, not Responses", () => {
		const model = getModel("gitlab-duo", "gpt-5.1-2025-11-13");
		expect(model.api).toBe("openai-completions");
		const provider = gitlabDuoProvider();
		const apis = provider.getModels().map((entry) => entry.api);
		expect(apis).toContain("openai-completions");
		expect(apis).not.toContain("openai-responses");
	});
});
