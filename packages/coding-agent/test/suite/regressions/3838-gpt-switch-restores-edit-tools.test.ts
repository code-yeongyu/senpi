import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../../scripts/vitest-temp.ts";
import registerApplyPatchExtension from "../../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import type { ApplyPatchExtensionAPI } from "../../../src/core/extensions/builtin/gpt-apply-patch/types.ts";
import type { LazyToolActivator } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

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

describe("leaving GPT restores the edit tools apply_patch stood in for (senpi#3838)", () => {
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
