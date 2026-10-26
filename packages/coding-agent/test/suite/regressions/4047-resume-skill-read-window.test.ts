import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import type { HeldInputs } from "../../../src/core/held-inputs.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const readGate = vi.hoisted(() => ({
	path: "",
	entered: () => {},
	released: Promise.resolve(),
}));

vi.mock("../../../src/core/skill-access.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/core/skill-access.ts")>();
	return {
		...actual,
		readSkillFileChecked: async (...args: Parameters<typeof actual.readSkillFileChecked>) => {
			if (args[0] === readGate.path) {
				readGate.path = "";
				readGate.entered();
				await readGate.released;
			}
			return actual.readSkillFileChecked(...args);
		},
	};
});

describe("senpi#4047 input held during a resume skill read", () => {
	let harness: Harness | undefined;
	let root: string | undefined;
	let releaseRead: (() => void) | undefined;

	afterEach(async () => {
		releaseRead?.();
		await harness?.session.abort();
		vi.restoreAllMocks();
		harness?.cleanup();
		if (root !== undefined) rmSync(root, { recursive: true, force: true });
	});

	it.each([
		"new input",
		"replacement input",
		"raw skill input",
		"raw template input",
		"late command",
		"late continue",
	])("delivers %s without needing another release", async (kind) => {
		// Given raw skill input held by a parent's run, with only a newer local Stop left to release.
		root = mkdtempSync(join(tmpdir(), "senpi-4047-"));
		const filePath = join(root, "SKILL.md");
		writeFileSync(filePath, "SYNTHETIC_SKILL_BODY");
		const baseDir = root;
		const commands: string[] = [];
		harness = await createHarness({
			resourceLoader: {
				...createTestResourceLoader({
					extensionsResult: await createTestExtensionsResult([
						(pi) => {
							pi.registerCommand("late-command", {
								description: "Synthetic command",
								handler: async (args) => {
									commands.push(args);
								},
							});
						},
					]),
				}),
				getPrompts: () => ({
					prompts: [
						{
							name: "late-template",
							description: "Synthetic template",
							content: "EXPANDED_TEMPLATE $ARGUMENTS",
							filePath: join(baseDir, "late-template.md"),
							sourceInfo: createSyntheticSourceInfo(join(baseDir, "late-template.md"), { source: "local" }),
						},
					],
					diagnostics: [],
				}),
				getSkills: () => ({
					skills: [
						{
							name: "carrier",
							description: "Synthetic skill",
							filePath,
							baseDir,
							disableModelInvocation: false,
							sourceInfo: createSyntheticSourceInfo(filePath, { source: "local" }),
						},
					],
					diagnostics: [],
				}),
			},
		});
		harness.setResponses([fauxAssistantMessage("seeded"), fauxAssistantMessage("resumed")]);
		const session = harness.session;
		await session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
		if (kind === "late continue") await session.prompt("seed");
		const paused = await session.pauseForRun({
			parentSessionId: "parent",
			parentPauseSeq: 1,
			runRef: { kind: "dag", id: "run" },
		});
		if (!("childSeq" in paused)) throw new Error("run pause refused");
		await session.prompt("/skill:carrier", { clientMessageId: "skill-input" });
		if (kind === "replacement input") session.holdInput({ inputId: "old", revision: 0, text: "old input" });
		await session.stop();
		await session.resumeForRun({
			parentSessionId: "parent",
			parentPauseSeq: 1,
			childSeqCutoff: paused.childSeq,
		});
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		readGate.path = filePath;
		readGate.entered = entered.resolve;
		readGate.released = released.promise;
		releaseRead = released.resolve;

		// When new guidance arrives while the released resume is preparing the skill.
		const resume = session.resumeSessionRequest({});
		await entered.promise;
		let latePause: Awaited<ReturnType<typeof session.pauseForRun>> | undefined;
		if (kind === "replacement input") expect(session.withdrawHeldInput("old")).toBe(true);
		if (kind === "late command" || kind === "late continue") {
			// A new parent pause can arrive after the local resume entered its asynchronous read.
			latePause = await session.pauseForRun({
				parentSessionId: "new-parent",
				parentPauseSeq: 2,
				runRef: { kind: "dag", id: "new-run" },
			});
			await session.prompt(kind === "late command" ? "/late-command synthetic-command-arg" : ".", {
				clientMessageId: "late",
			});
			expect(session.pausedHeldInputCount).toBe(2);
		} else if (kind === "raw skill input" || kind === "raw template input") {
			const held: HeldInputs = Reflect.get(session, "_heldInputs");
			expect(
				held.hold({
					inputId: "late",
					revision: 0,
					text: kind === "raw skill input" ? "/skill:carrier latest guidance" : "/late-template latest guidance",
					prepare: true,
				}).kind,
			).toBe("held");
		} else {
			expect(session.holdInput({ inputId: "late", revision: 0, text: "latest guidance" }).kind).toBe("held");
		}
		released.resolve();
		await resume;
		await session.waitForIdle();
		if (latePause !== undefined) {
			expect(commands).toEqual([]);
			expect(session.pausedHeldInputCount).toBe(2);
			if (!("childSeq" in latePause)) throw new Error("late run pause refused");
			const consumed = Promise.withResolvers<void>();
			const held: HeldInputs = Reflect.get(session, "_heldInputs");
			const consume = held.consume.bind(held);
			vi.spyOn(held, "consume").mockImplementation((inputIds) => {
				consume(inputIds);
				if (inputIds.includes("skill-input")) consumed.resolve();
			});
			await session.resumeForRun({
				parentSessionId: "new-parent",
				parentPauseSeq: 2,
				childSeqCutoff: latePause.childSeq,
			});
			await consumed.promise;
			await session.waitForIdle();
		}

		// Then that same turn delivers and consumes the guidance, not a future release that may never happen.
		if (kind !== "late command" && kind !== "late continue")
			expect(JSON.stringify(harness.faux.getCallLog().at(-1)?.context.messages)).toContain("latest guidance");
		expect(JSON.stringify(harness.faux.getCallLog().at(-1)?.context.messages)).not.toContain("old input");
		if (kind === "raw skill input") {
			const payload = JSON.stringify(harness.faux.getCallLog().at(-1)?.context.messages);
			expect(payload.match(/SYNTHETIC_SKILL_BODY/g)).toHaveLength(2);
			expect(payload).not.toContain("/skill:carrier latest guidance");
		}
		if (kind === "raw template input") {
			const payload = JSON.stringify(harness.faux.getCallLog().at(-1)?.context.messages);
			expect(payload).toContain("EXPANDED_TEMPLATE latest");
			expect(payload).not.toContain("/late-template");
		}
		if (kind === "late command") {
			expect(commands).toEqual(["synthetic-command-arg"]);
			expect(JSON.stringify(harness.faux.getCallLog().at(-1)?.context.messages)).not.toContain("/late-command");
		}
		if (kind === "late continue") {
			const messages = harness.faux.getCallLog().at(-1)?.context.messages ?? [];
			expect(
				messages.some((message) =>
					typeof message.content === "string"
						? message.content.endsWith("\n.")
						: message.content.some((part) => part.type === "text" && part.text.endsWith("\n.")),
				),
			).toBe(false);
		}
		expect(session.pausedHeldInputCount).toBe(0);
	});
});
