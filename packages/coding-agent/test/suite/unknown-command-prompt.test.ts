import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/core/extensions/index.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { UnknownCommandError } from "../../src/core/unknown-command.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

// omo #9042 B: command-shaped input that nothing handles never reaches the model.

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function sessionWithSkill(extensionFactories: InlineExtension[] = []): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "senpi-unknown-command-"));
	tempDirs.push(dir);
	const skillPath = join(dir, "SKILL.md");
	writeFileSync(skillPath, "Run the plan.");
	const extensionsResult = await createTestExtensionsResult(extensionFactories, dir);
	const resourceLoader = {
		...createTestResourceLoader({ extensionsResult }),
		getSkills: () => ({
			skills: [
				{
					name: "ulw-execute",
					description: "Execute a plan",
					filePath: skillPath,
					baseDir: dir,
					disableModelInvocation: false,
					sourceInfo: createSyntheticSourceInfo(skillPath, { source: "local" }),
				},
			],
			diagnostics: [],
		}),
	};
	const harness = await createHarness({ resourceLoader });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("ok")]);
	return harness;
}

async function rejectionOf(promise: Promise<void>): Promise<UnknownCommandError> {
	const error = await promise.then(
		() => undefined,
		(cause: unknown) => cause,
	);
	if (!(error instanceof UnknownCommandError)) throw new Error(`expected UnknownCommandError, got ${String(error)}`);
	return error;
}

function expectNothingSent(harness: Harness): void {
	expect(getUserTexts(harness)).toEqual([]);
	expect(harness.getPendingResponseCount()).toBe(1);
}

describe("AgentSession.prompt rejects unknown commands", () => {
	it("rejects an unknown command and suggests the closest known names", async () => {
		const harness = await sessionWithSkill();

		const error = await rejectionOf(harness.session.prompt("/ulw-exec plan"));

		expect(error.command).toBe("ulw-exec");
		expect(error.reason).toBe("unknown");
		expect(error.suggestions[0]).toBe("skill:ulw-execute");
		expect(error.suggestions.length).toBeLessThanOrEqual(3);
		expectNothingSent(harness);
	});

	it("rejects a skill command naming no loaded skill", async () => {
		const harness = await sessionWithSkill();

		const error = await rejectionOf(harness.session.prompt("/skill:nope do it"));

		expect(error.command).toBe("skill:nope");
		expectNothingSent(harness);
	});

	it("rejects a TUI builtin sent over RPC as an interactive-only command", async () => {
		const harness = await sessionWithSkill();

		const error = await rejectionOf(harness.session.prompt("/model faux", { source: "rpc" }));

		expect(error.reason).toBe("interactive_only");
		expect(error.command).toBe("model");
		expectNothingSent(harness);
	});

	it("sends a path-like first token as text", async () => {
		const harness = await sessionWithSkill();

		await harness.session.prompt("/tmp/x is missing");

		expect(getUserTexts(harness)).toEqual(["/tmp/x is missing"]);
	});

	it("leaves extension-sourced prompts alone", async () => {
		const harness = await sessionWithSkill();

		await harness.session.prompt("/foo bar", { source: "extension" });

		expect(getUserTexts(harness)).toEqual(["/foo bar"]);
	});

	it("sends unknown command text when the caller opts in", async () => {
		const harness = await sessionWithSkill();

		await harness.session.prompt("/foo bar", { unknownCommandAsText: true });

		expect(getUserTexts(harness)).toEqual(["/foo bar"]);
	});

	it("sends text that starts with whitespace as text, over RPC too", async () => {
		const harness = await sessionWithSkill();

		await harness.session.prompt(" /foo bar", { source: "rpc" });

		expect(getUserTexts(harness)).toEqual([" /foo bar"]);
	});

	it("accepts a bare alias an input handler rewrites into a skill command", async () => {
		const harness = await sessionWithSkill([
			(pi) => {
				pi.on("input", async (event) =>
					event.text.startsWith("/ulw-execute")
						? { action: "transform", text: event.text.replace("/ulw-execute", "/skill:ulw-execute") }
						: { action: "continue" },
				);
			},
		]);

		await harness.session.prompt("/ulw-execute plan");

		expect(getUserTexts(harness)).toHaveLength(1);
		expect(getUserTexts(harness)[0]).toContain('<skill-instruction name="ulw-execute"');
	});

	it("rejects an unknown command queued while streaming and keeps the running turn alive", async () => {
		const harness = await sessionWithSkill();
		let releaseTurn: () => void = () => {};
		const turnHeld = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		let turnStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			turnStarted = resolve;
		});
		harness.setResponses([
			async () => {
				turnStarted();
				await turnHeld;
				return fauxAssistantMessage("done");
			},
		]);
		const running = harness.session.prompt("hello");
		await started;

		const error = await rejectionOf(harness.session.prompt("/foo bar", { streamingBehavior: "followUp" }));
		releaseTurn();
		await running;

		expect(error.command).toBe("foo");
		expect(getUserTexts(harness)).toEqual(["hello"]);
	});
});
