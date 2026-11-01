import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

// senpi#4826: a normal submit accepted while startup extension binding is still running painted its
// echo into the empty transcript, so the restored history landed below the new message.

type StartupView = {
	chatContainer: { render(width: number): string[] };
	defaultEditor: CustomEditor;
	editor: { getText(): string };
	pendingUserInputs: readonly { text: string }[];
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startInteractive(extension: ExtensionFactory, history: readonly string[]) {
	const root = await mkdtemp(join(tmpdir(), "issue-4826-"));
	const faux = registerFauxProvider({ models: [{ id: "faux-4826", reasoning: false }] });
	const sessionManager = SessionManager.inMemory(root);
	for (const [index, text] of history.entries()) {
		sessionManager.appendMessage({ role: "user", content: text, timestamp: index + 1 });
	}
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: root,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [extension],
			},
		});
		services.settingsManager.applyOverrides({ quietStartup: true });
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: root, agentDir: root, sessionManager });
	initTheme("dark");
	const mode = new InteractiveMode(runtime, { terminal: new VirtualTerminal(120, 40), initialThemeSetting: "dark" });
	cleanups.push(async () => {
		mode.stop();
		await runtime.dispose();
		faux.unregister();
		await rm(root, { recursive: true, force: true });
	});
	return { mode, view: mode as unknown as StartupView };
}

function transcript(view: StartupView): string[] {
	return view.chatContainer.render(120).map((line) => stripVTControlCharacters(line).trim());
}

function rowOf(lines: readonly string[], text: string): number {
	return lines.findIndex((line) => line.includes(text));
}

it("holds a submit made during startup binding until the restored history is rendered", async () => {
	const bindEntered = Promise.withResolvers<void>();
	const releaseBind = Promise.withResolvers<void>();
	const { mode, view } = await startInteractive(
		(pi) => {
			pi.on("session_start", async () => {
				bindEntered.resolve();
				await releaseBind.promise;
			});
		},
		["OLD-4826-FIRST", "OLD-4826-SECOND"],
	);

	const init = mode.init();
	try {
		await bindEntered.promise;
		await view.defaultEditor.onSubmit?.("NEW-4826");

		// Startup has not rendered the history yet: the submit stays a draft and paints nothing.
		expect(transcript(view).some((line) => line.includes("NEW-4826"))).toBe(false);
		expect(view.pendingUserInputs).toEqual([]);
		expect(view.editor.getText()).toBe("NEW-4826");
	} finally {
		releaseBind.resolve();
		await init;
	}

	const restored = transcript(view);
	expect(rowOf(restored, "OLD-4826-FIRST")).toBeGreaterThanOrEqual(0);
	expect(rowOf(restored, "OLD-4826-FIRST")).toBeLessThan(rowOf(restored, "OLD-4826-SECOND"));
	expect(restored.some((line) => line.includes("NEW-4826"))).toBe(false);

	// The preserved draft, submitted once startup is done, lands after the history exactly once.
	await view.defaultEditor.onSubmit?.(view.editor.getText());
	const after = transcript(view);
	expect(after.filter((line) => line.includes("NEW-4826"))).toHaveLength(1);
	expect(rowOf(after, "OLD-4826-SECOND")).toBeLessThan(rowOf(after, "NEW-4826"));
	expect(view.pendingUserInputs.map((input) => input.text)).toEqual(["NEW-4826"]);
});

it("gives a custom editor installed by session_start the app handlers enabled after startup", async () => {
	let installed: CustomEditor | undefined;
	const { mode, view } = await startInteractive((pi) => {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				installed = new CustomEditor(tui, theme, keybindings);
				return installed;
			});
		});
	}, []);

	await mode.init();

	expect(installed).toBeDefined();
	const custom = installed as CustomEditor;
	for (const [action, handler] of view.defaultEditor.actionHandlers) {
		expect(custom.actionHandlers.get(action)).toBe(handler);
	}
	expect(custom.actionHandlers.has("app.model.select")).toBe(true);
	custom.setText("!ls");
	expect((mode as unknown as { isBashMode: boolean }).isBashMode).toBe(true);
});
