import type { Api, Model } from "@earendil-works/pi-ai";
import type { FauxModelDefinition } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLookAtCommand } from "../../src/core/extensions/builtin/look-at/commands.ts";
import { resolveVisionModel } from "../../src/core/extensions/builtin/look-at/model-selector.ts";
import {
	createLookAtStore,
	loadLookAtChain,
	loadLookAtEnabled,
} from "../../src/core/extensions/builtin/look-at/settings.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

type Command = { handler: CommandHandler };

type Notice = { message: string; type: "info" | "warning" | "error" | undefined };

interface CommandHarness {
	store: ReturnType<typeof createLookAtStore>;
	notices: Notice[];
	resync: ReturnType<typeof vi.fn>;
	stateTitles: string[];
	run(args: string, choices?: string[], inputs?: Array<string | undefined>): Promise<ExtensionCommandContext>;
}

function vision(id: string): FauxModelDefinition {
	return { id, input: ["text", "image"] };
}

async function createCommandHarness(options: { models?: string[]; enabled?: boolean } = {}): Promise<CommandHarness> {
	const harness = await createHarness({ models: [vision("vision-primary"), vision("vision-secondary")] });
	harnesses.push(harness);
	const available: Model<Api>[] = harness.models;
	const store = createLookAtStore();
	const notices: Notice[] = [];
	const stateTitles: string[] = [];
	const settings = { enabled: options.enabled ?? true, models: options.models };
	const resync = vi.fn((ctx: ExtensionCommandContext) => {
		const chain = loadLookAtChain(ctx, store);
		return loadLookAtEnabled(ctx, store) && resolveVisionModel(chain, ctx.modelRegistry.getAvailable()) !== undefined;
	});
	const commands = new Map<string, Command>();
	const api = {
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	registerLookAtCommand(api, { store, loadChain: (ctx) => loadLookAtChain(ctx, store), resync });
	const command = commands.get("lookat");
	if (!command) throw new Error("Expected /lookat command to be registered");

	return {
		store,
		notices,
		resync,
		stateTitles,
		async run(args, choices = [], inputs = []) {
			const ctx = {
				hasUI: true,
				ui: {
					select: async (title: string) => {
						stateTitles.push(title);
						return choices.shift();
					},
					input: async () => inputs.shift(),
					notify: (message: string, type?: "info" | "warning" | "error") => notices.push({ message, type }),
				},
				modelRegistry: { getAvailable: () => available },
				getLookAtSettings: () => settings,
			} as unknown as ExtensionCommandContext;
			await command.handler(args, ctx);
			return ctx;
		},
	};
}

describe("look_at builtin command", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("saves direct chains, warns for unavailable entries, and resyncs the handler context", async () => {
		const command = await createCommandHarness();

		const ctx = await command.run("faux/vision-primary future/vision");

		expect(loadLookAtChain(ctx, command.store)).toEqual(["faux/vision-primary", "future/vision"]);
		expect(command.resync).toHaveBeenCalledOnce();
		expect(command.resync).toHaveBeenCalledWith(ctx);
		expect(command.notices).toContainEqual({
			message: 'No available image-capable model matches "future/vision"; saved for a future auth setup.',
			type: "warning",
		});
	});

	it("immediately updates the enabled gating predicate when toggled", async () => {
		const command = await createCommandHarness();

		const disabledCtx = await command.run("", ["Toggle look_at"]);
		expect(loadLookAtEnabled(disabledCtx, command.store)).toBe(false);
		expect(command.resync.mock.results.at(-1)?.value).toBe(false);

		const enabledCtx = await command.run("", ["Toggle look_at"]);
		expect(loadLookAtEnabled(enabledCtx, command.store)).toBe(true);
		expect(command.resync.mock.results.at(-1)?.value).toBe(true);
	});

	it("resets session overrides to the settings.json chain and enabled value", async () => {
		const command = await createCommandHarness({ models: ["faux/vision-secondary"], enabled: false });
		command.store.setModels(["faux/vision-primary"]);
		command.store.setEnabled(true);

		const ctx = await command.run("", ["Reset session override"]);

		expect(loadLookAtChain(ctx, command.store)).toEqual(["faux/vision-secondary"]);
		expect(loadLookAtEnabled(ctx, command.store)).toBe(false);
		expect(command.resync).toHaveBeenCalledWith(ctx);
	});

	it("renders state and rejects an empty menu edit with usage guidance", async () => {
		const command = await createCommandHarness({ models: ["faux/vision-secondary"] });

		await command.run("", ["Show current chain"]);
		await command.run("", ["Edit chain"], ["   "]);

		expect(command.stateTitles[0]).toContain("source: settings.json lookAt.models");
		expect(command.stateTitles[0]).toContain("faux/vision-secondary -> faux/vision-secondary");
		expect(command.stateTitles[0]).toContain(
			"this override is current-session only; permanent config is settings.json lookAt.models",
		);
		expect(command.notices).toContainEqual({ message: "Usage: /lookat <model1> [model2 ...]", type: "error" });
	});
});
