import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../../scripts/vitest-temp.ts";
import registerApplyPatchExtension from "../../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import type { ApplyPatchExtensionAPI } from "../../../src/core/extensions/builtin/gpt-apply-patch/types.ts";
import type { LazyToolActivator } from "../../../src/core/extensions/types.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness } from "../harness.ts";

type StubModel = { api: string; id: string };
type StubContext = { model: StubModel; sessionManager: SessionManager };
type StubEvent = { model: StubModel };

const gpt: StubModel = { api: "openai-responses", id: "gpt-5.5" };
const claude: StubModel = { api: "anthropic-messages", id: "claude-sonnet-4-6" };

/** One extension instance over a host whose registered and active tools outlive it, as across a reload. */
function attach(host: ReturnType<typeof toolsHost>, sessionManager = host.sessionManager) {
	const handlers = new Map<string, (event: StubEvent, ctx: StubContext) => Promise<unknown>>();
	let activate: LazyToolActivator | undefined;
	const pi = {
		appendEntry: sessionManager.appendCustomEntry.bind(sessionManager),
		registerTool: (tool: { name: string }) => host.registered.add(tool.name),
		registerLazyToolActivator: (activator: LazyToolActivator) => {
			activate = activator;
		},
		getActiveTools: () => [...host.active],
		getAllTools: () => [...host.registered].map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			host.active = names.filter((name) => host.registered.has(name));
		},
		on: (event: string, handler: (event: StubEvent, ctx: StubContext) => Promise<unknown>) => {
			handlers.set(event, handler);
		},
	};
	registerApplyPatchExtension(pi as unknown as ApplyPatchExtensionAPI);
	const fire = async (event: string, model: StubModel) => {
		await handlers.get(event)?.({ model }, { model, sessionManager });
	};
	return {
		activate: (name: string) => activate?.(name),
		sessionStart: (model: StubModel) => fire("session_start", model),
		modelSelect: (model: StubModel) => fire("model_select", model),
	};
}

function toolsHost(active: string[], sessionManager = SessionManager.inMemory()) {
	return { registered: new Set(["read", "edit", "write"]), active, sessionManager };
}

async function withToolSelection(
	selection: { tools?: string[]; defaultTools?: string[] },
	run: (fixture: {
		session: Awaited<ReturnType<typeof createAgentSession>>["session"];
		leaveGpt: () => Promise<unknown>;
		reloadDefaults: (defaultTools: string[]) => Promise<unknown>;
	}) => Promise<void>,
) {
	const settings = { enabledBuiltinExtensions: ["gpt-apply-patch"], defaultTools: selection.defaultTools };
	const harness = await createHarness({
		api: "openai-responses",
		models: [{ id: gpt.id }, { id: claude.id }],
		fileSettings: true,
		settings,
	});
	try {
		const agentDir = join(harness.tempDir, "agent");
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			modelRegistry: harness.modelRegistry,
			settingsManager: harness.settingsManager,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			tools: selection.tools,
		});
		try {
			await session.bindExtensions({ shutdownHandler: () => {} });
			const otherModel = harness.getModel(claude.id);
			if (!otherModel) throw new Error("Missing non-GPT fixture model");
			await run({
				session,
				leaveGpt: () => session.setSessionModel(otherModel),
				reloadDefaults: (defaultTools) => {
					writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ...settings, defaultTools }));
					return session.reload();
				},
			});
		} finally {
			session.dispose();
		}
	} finally {
		harness.cleanup();
	}
}

describe("leaving GPT restores the edit tools apply_patch stood in for (senpi#3838)", () => {
	it("keeps the allowed edit tools and records no swap when the explicit allowlist excludes apply_patch", async () => {
		await withToolSelection({ tools: ["read", "edit", "write"] }, async ({ session }) => {
			expect.soft(session.getActiveToolNames()).toEqual(["read", "edit", "write"]);
			expect(
				session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "gpt-apply-patch:edit-tool-swap"),
			).toEqual([]);
		});
	});

	it("restores both edit tools when a settings reload adds write during an existing swap", async () => {
		await withToolSelection(
			{ defaultTools: ["read", "edit", "apply_patch"] },
			async ({ session, reloadDefaults, leaveGpt }) => {
				expect(session.getActiveToolNames()).toEqual(["read", "apply_patch"]);

				await reloadDefaults(["read", "edit", "write", "apply_patch"]);
				expect(session.getActiveToolNames()).toEqual(["read", "apply_patch"]);
				await leaveGpt();

				expect(session.getActiveToolNames()).toEqual(["read", "edit", "write"]);
			},
		);
	});

	it("does not restore edit when a settings reload removes it from the tool selection", async () => {
		await withToolSelection(
			{ defaultTools: ["read", "edit", "write", "apply_patch"] },
			async ({ session, reloadDefaults, leaveGpt }) => {
				expect(session.getActiveToolNames()).toEqual(["read", "apply_patch"]);

				await reloadDefaults(["read", "write", "apply_patch"]);
				await leaveGpt();

				expect(session.getActiveToolNames()).toEqual(["read", "write"]);
			},
		);
	});

	it("keeps edit and write inactive after lazy apply_patch activation on a read-only GPT toolset", async () => {
		const tools = toolsHost(["read"]);
		const extension = attach(tools);
		await extension.sessionStart(gpt);
		expect(extension.activate("apply_patch")).toBe(true);
		expect(tools.active).toEqual(["read", "apply_patch"]);

		await extension.modelSelect(claude);

		expect(tools.active).toEqual(["read"]);
	});

	it("restores only the edit tool replaced by the GPT swap after a reload", async () => {
		const tools = toolsHost(["read", "edit"]);
		await attach(tools).sessionStart(gpt);
		expect(tools.active).toEqual(["read", "apply_patch"]);

		const reloaded = attach(tools);
		await reloaded.sessionStart(gpt);
		await reloaded.modelSelect(claude);

		expect(tools.active).toEqual(["read", "edit"]);
	});

	it("restores edit and write when a GPT swap is saved to disk and resumed on Claude", async () => {
		const dir = makeTempDir(join(tmpdir(), "gpt-edit-tool-swap-"));
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
		const tools = toolsHost(["read", "edit", "write"], manager);
		await attach(tools).sessionStart(gpt);
		expect(tools.active).toEqual(["read", "apply_patch"]);

		const path = manager.getSessionFile();
		if (!path) throw new Error("Missing persisted session file");
		const reopened = SessionManager.open(path);
		await attach(tools, reopened).sessionStart(claude);

		expect(tools.active).toEqual(["read", "edit", "write"]);
	});

	it("keeps a session read-only when no edit tool was active", async () => {
		const tools = toolsHost(["read"]);
		const extension = attach(tools);
		await extension.sessionStart(gpt);
		await extension.modelSelect(claude);

		expect(tools.active).toEqual(["read"]);
	});

	it("restores only the edit tool that was active when the same instance switches back", async () => {
		const tools = toolsHost(["read", "edit"]);
		const extension = attach(tools);
		await extension.sessionStart(gpt);
		await extension.modelSelect(claude);

		expect(tools.active).toEqual(["read", "edit"]);
	});
});
