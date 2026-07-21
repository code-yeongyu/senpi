// MCP prompts → slash commands (todo 40): every listed prompt registers as
// /mcp:<server>:<prompt>; invoking collects declared arguments via ctx.ui and
// injects the prompts/get messages into the input editor; a missing required
// argument aborts with a notice instead of calling the server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	registerMcpPromptCommands,
	resetMcpPromptCommandsForTests,
} from "../../src/core/extensions/builtin/mcp/prompts.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { attach, awaitMcpToolRegistration, capturingPi, mcpRoot as makeMcpRoot } from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
	resetMcpPromptCommandsForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(slug, cleanupTasks);
}

interface FakeCommand {
	description?: string;
	handler: (args: string, ctx: never) => Promise<void>;
}

function commandRecorder(): {
	commands: Map<string, FakeCommand>;
	registerCommand: (name: string, options: FakeCommand) => void;
} {
	const commands = new Map<string, FakeCommand>();
	return { commands, registerCommand: (name, options) => commands.set(name, options) };
}

function fakeCommandCtx(answers: Array<string | undefined>) {
	const notices: string[] = [];
	let editorText = "";
	return {
		ctx: {
			ui: {
				input: async () => answers.shift(),
				notify: (message: string) => {
					notices.push(message);
				},
				setEditorText: (text: string) => {
					editorText = text;
				},
			},
		} as never,
		getEditorText: () => editorText,
		notices,
	};
}

describe("mcp prompts as slash commands", () => {
	it("registers /mcp:<server>:<prompt> and injects prompts/get output into the editor", async () => {
		const root = mcpRoot("prompts-live");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");

		const recorder = commandRecorder();
		const added = registerMcpPromptCommands(recorder as never, getMcpService().getMcpPromptServers());
		expect(added).toEqual(["mcp:fx:fixture_prompt"]);

		const command = recorder.commands.get("mcp:fx:fixture_prompt");
		expect(command?.description).toContain("Fixture prompt");

		const happy = fakeCommandCtx(["World"]);
		await command?.handler("", happy.ctx);
		expect(happy.getEditorText()).toBe("Hello World");

		const aborted = fakeCommandCtx([undefined]);
		await command?.handler("", aborted.ctx);
		expect(aborted.getEditorText()).toBe("");
		expect(aborted.notices[0]).toContain("required argument 'name'");
	});
});
