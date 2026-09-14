// Refs #1645: fixture arguments must reach the real question-tool dispatch unchanged.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import fixture from "../fixtures/extensions/ask-user-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), "ask-user-fixture-args-"));
	roots.push(root);
	vi.stubEnv("SENPI_ASK_USER_FIXTURE_LOG", join(root, "fixture.jsonl"));
	let handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
	const executeTool = vi.fn(async () => ({
		content: [{ type: "text", text: "accepted" }],
		details: { status: "pending" },
	}));
	let completed = Promise.withResolvers<void>();
	fixture({
		getActiveTools: () => ["ask_user_question"],
		executeTool,
		registerCommand: (_name: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			handler = definition.handler;
		},
	} as unknown as ExtensionAPI);
	const ctx = { agentDir: root, ui: { notify: () => completed.resolve() } } as unknown as ExtensionCommandContext;
	return {
		executeTool,
		async run(args: string) {
			if (!handler) throw new Error("Fixture command was not registered");
			completed = Promise.withResolvers<void>();
			const deadline = setTimeout(() => completed.reject(new Error("Fixture result event did not arrive")), 2_000);
			try {
				await handler(args, ctx);
				await completed.promise;
			} finally {
				clearTimeout(deadline);
			}
		},
	};
}
describe("ask-user fixture arguments", () => {
	it("passes a header and quoted question without changing the next request's defaults", async () => {
		const h = setup();
		await h.run('wait=false n=1 header=Alpha q="Choose a database"');
		expect(h.executeTool.mock.calls[0]).toEqual([
			"ask_user_question",
			{
				waitForAnswer: false,
				questions: [expect.objectContaining({ header: "Alpha", question: "Choose a database" })],
			},
		]);
		await h.run("wait=false n=1");
		expect(h.executeTool.mock.calls[1]).toEqual([
			"ask_user_question",
			{
				waitForAnswer: false,
				questions: [expect.objectContaining({ header: "Database", question: "Which database should I use?" })],
			},
		]);
	});
	it("overrides the first sub-question only and accepts single-quoted values", async () => {
		const h = setup();
		await h.run("wait=false n=2 header='Alpha team' q='Choose two things?'");
		expect(h.executeTool.mock.calls[0]).toEqual([
			"ask_user_question",
			{
				waitForAnswer: false,
				questions: [
					expect.objectContaining({ header: "Alpha team", question: "Choose two things?" }),
					expect.objectContaining({ header: "Deploy", question: "Where should it deploy?" }),
				],
			},
		]);
	});
});
