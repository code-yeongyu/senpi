import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEngineFactory } from "../../../desktop-service/test/harness.ts";
import { createComputerUseExtension } from "../../src/core/extensions/builtin/computer-use/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { type ComputerUseHarness, callTool, createComputerUseHarness } from "./computer-use-harness.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

// Every case waits on real engine child-process I/O; the guard only catches a hang, it never times behavior.
const HANG_GUARD = { timeout: 30_000 };

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function computerUseHarness(): Promise<ComputerUseHarness> {
	const created = await createComputerUseHarness();
	cleanups.push(() => created.cleanup());
	return created;
}

function count(methods: readonly string[], method: string): number {
	return methods.filter((candidate) => candidate === method).length;
}

describe("computer-use activation", HANG_GUARD, () => {
	it("a by-name call activates the tool and arms the stop chord exactly once", async () => {
		// Given
		const computerUse = await computerUseHarness();

		// When
		await callTool(computerUse.harness, "computer", { action: "capabilities" });

		// Then
		const methods = computerUse.methods();
		expect({
			active: computerUse.harness.session.getActiveToolNames().includes("computer"),
			stopPathStarts: count(methods, "stopPath.start"),
			sessionOpens: count(methods, "session.open"),
		}).toEqual({ active: true, stopPathStarts: 1, sessionOpens: 1 });
	});

	it("activation through setActiveTools arms the stop chord before any computer call", async () => {
		// Given
		const computerUse = await computerUseHarness();
		const armed = computerUse.engine.nthRequest("stopPath.start", 1);

		// When
		computerUse.harness.session.setActiveToolsByName([
			...computerUse.harness.session.getActiveToolNames(),
			"computer",
		]);

		// Then
		expect(await armed).toMatchObject({ method: "stopPath.start", params: { chord: "ctrl+alt+shift+escape" } });
	});

	it("/computer on activates the tool so status reports the prelude active", async () => {
		// Given
		const computerUse = await computerUseHarness();
		await computerUse.command("on");

		// When
		const status = await computerUse.command("status");

		// Then
		expect({
			active: computerUse.harness.session.getActiveToolNames().includes("computer"),
			engine: status.match(/^engine: (.+)$/m)?.[1],
			prelude: status.match(/^prelude: (.+)$/m)?.[1],
			stopPathStarts: count(computerUse.methods(), "stopPath.start"),
		}).toEqual({ active: true, engine: "ready", prelude: "active", stopPathStarts: 1 });
	});

	it("/computer off deactivates the tool and closes the engine session", async () => {
		// Given
		const computerUse = await computerUseHarness();
		await computerUse.command("on");

		// When
		await computerUse.command("off");

		// Then
		expect({
			active: computerUse.harness.session.getActiveToolNames().includes("computer"),
			closed: computerUse.methods().includes("session.close"),
		}).toEqual({ active: false, closed: true });
	});
});

interface FauxContext {
	readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
}

/** Loads codemode through the REAL resource loader (todo 25's e2e harness) with the fake-engine computer-use. */
async function codemodeHarness(): Promise<Harness> {
	const tempDir = mkdtempSync(join(tmpdir(), "senpi-computer-use-codemode-"));
	const engine = fakeEngineFactory({ FAKE_ENGINE_DESKTOP: "1" });
	const loader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir: join(tempDir, "agent"),
		// The shipped computer-use builtin would locate the real engine; the fake-engine copy replaces it.
		settingsManager: SettingsManager.inMemory({ disabledBuiltinExtensions: ["computer-use"] }),
		extensionFactories: [createComputerUseExtension({ platform: "linux", engineChild: () => engine.factory })],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	await harness.session.bindExtensions({});
	cleanups.push(() => {
		harness.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});
	cleanups.push(() => harness.session.prompt("/computer off"));
	return harness;
}

async function runJsCell(harness: Harness, code: string): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("eval", { language: "js", code, summary: "probe computer global" }), {
			stopReason: "toolUse",
		}),
		(context: FauxContext) => {
			const toolResult = [...context.messages].reverse().find((message) => message.role === "toolResult");
			return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "missing tool result");
		},
	]);
	await harness.session.prompt("run eval");
	return getAssistantTexts(harness).at(-1) ?? "";
}

describe("computer-use activation reaches the real codemode kernel", HANG_GUARD, () => {
	it("installs the computer global in the next eval cell once the tool is active", async () => {
		// Given
		const harness = await codemodeHarness();
		const inactive = await runJsCell(harness, "return typeof computer");
		await harness.session.prompt("/computer on");

		// When
		const active = await runJsCell(harness, "print(JSON.stringify(await computer.capabilities()))");

		// Then
		expect({
			prelude: harness.session.getAllTools().find((tool) => tool.name === "computer")?.kernelPrelude?.exports,
			inactive: inactive.includes("undefined"),
			backend: active.includes('"backend":"fake"'),
		}).toEqual({ prelude: ["computer"], inactive: true, backend: true });
	});
});
