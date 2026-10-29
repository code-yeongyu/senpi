import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

import { createModelJobWidgetAuthor } from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { controllerFor, FakeJob, outSample, RPS_SPEC, scriptedAuthor, UNMATCHED_SPEC } from "./author-support.ts";

// Security contract (plan D6): credential-shaped text in a job's brief, labels or output never
// reaches an author, whichever author the host injects.
const SECRETS = {
	github: "ghp_Abcdefghijklmnopqrstuvwxyz0123456789AB",
	openai: "sk-proj-Zx81Kq0Lm2Nb3Vc4Xz5Aa6Ss7Dd8Ff9Gg0Hh",
	aws: "AKIAIOSFODNN7EXAMPLE",
	bearer: "opaqueToken123456789abc",
} as const;

function leakyJob(): FakeJob {
	const job = new FakeJob("bg_1", {
		kind: "bash",
		command: `GH_TOKEN=${SECRETS.github} ./bench.sh | tee bench.log`,
		intent: `compare against key ${SECRETS.openai}`,
	});
	job.sources = [
		outSample(
			[
				`curl -H 'Authorization: Bearer ${SECRETS.bearer}' https://example.invalid`,
				`aws configured with ${SECRETS.aws}`,
				`using ${SECRETS.openai}`,
				"req 1 rps=40",
				"req 2 rps=44",
				"req 3 rps=51",
			],
			"out",
			`./bench.sh ${SECRETS.github}`,
		),
	];
	return job;
}

function expectNoSecret(text: string): void {
	for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
}

const model: Model<Api> = {
	id: "widget-model",
	name: "Widget model",
	api: "openai-completions",
	provider: "job-widgets-test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4096,
};

describe("job widget author redaction", () => {
	it("never hands a credential to the author, on the first request or the retry", async () => {
		const echoed = { ...UNMATCHED_SPEC, title: `leak ${SECRETS.github}` };
		const { author, requests } = scriptedAuthor(echoed, RPS_SPEC);
		const { controller } = controllerFor(author);
		expect(await controller.maybeRequest(leakyJob())).toMatchObject({ kind: "installed" });
		expect(requests).toHaveLength(2);
		for (const request of requests) expectNoSecret(JSON.stringify(request));
		expect(requests[0]?.sources[0]?.head).toContain("req 1 rps=40");
	});

	it("never puts a credential in the model prompt", async () => {
		const contexts: Context[] = [];
		const author = createModelJobWidgetAuthor({
			resolveModel: () => model,
			complete: async (_model, context) => {
				contexts.push(context);
				return fauxAssistantMessage(fauxToolCall("respond", RPS_SPEC), { stopReason: "toolUse" });
			},
		});
		const { controller } = controllerFor(author);
		expect(await controller.maybeRequest(leakyJob())).toMatchObject({ kind: "installed" });
		const prompt = JSON.stringify(contexts);
		expectNoSecret(prompt);
		expect(prompt).toContain("req 1 rps=40");
		expect(prompt).toContain("[REDACTED]");
	});

	it("applies the session obfuscator to the brief and every sample line", async () => {
		const { author, requests } = scriptedAuthor(RPS_SPEC);
		const obfuscate = () => ({
			push: (text: string): string => text.replaceAll("hunter2-internal", "<secret>"),
			finish: (): string => "",
		});
		const { controller } = controllerFor(author, {}, obfuscate);
		const job = new FakeJob("bg_1", { kind: "bash", command: "./bench.sh --project hunter2-internal" });
		job.sources = [outSample(["project hunter2-internal", "req 1 rps=40", "req 2 rps=44"])];
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "installed" });
		const sent = JSON.stringify(requests);
		expect(sent).not.toContain("hunter2-internal");
		expect(requests[0]?.brief.command).toBe("./bench.sh --project <secret>");
	});
});
