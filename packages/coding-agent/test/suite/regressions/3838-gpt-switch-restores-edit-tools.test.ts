import { describe, expect, it } from "vitest";
import registerApplyPatchExtension from "../../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import type { ApplyPatchExtensionAPI } from "../../../src/core/extensions/builtin/gpt-apply-patch/types.ts";

type StubModel = { api: string; id: string };

const gpt: StubModel = { api: "openai-responses", id: "gpt-5.5" };
const claude: StubModel = { api: "anthropic-messages", id: "claude-sonnet-4-6" };

/** One extension instance over a host whose registered and active tools outlive it, as across a reload. */
function attach(host: { registered: Set<string>; active: string[] }) {
	const handlers = new Map<string, (event: { model: StubModel }, ctx: { model: StubModel }) => Promise<unknown>>();
	const pi = {
		registerTool: (tool: { name: string }) => host.registered.add(tool.name),
		getActiveTools: () => [...host.active],
		getAllTools: () => [...host.registered].map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			host.active = names.filter((name) => host.registered.has(name));
		},
		on: (event: string, handler: (event: { model: StubModel }, ctx: { model: StubModel }) => Promise<unknown>) => {
			handlers.set(event, handler);
		},
	};
	registerApplyPatchExtension(pi as unknown as ApplyPatchExtensionAPI);
	const fire = async (event: string, model: StubModel) => {
		await handlers.get(event)?.({ model }, { model });
	};
	return {
		sessionStart: (model: StubModel) => fire("session_start", model),
		modelSelect: (model: StubModel) => fire("model_select", model),
	};
}

function host(active: string[]) {
	return { registered: new Set(["read", "edit", "write"]), active };
}

describe("leaving GPT restores the edit tools apply_patch stood in for (senpi#3838)", () => {
	it("restores edit and write after a reload carried the GPT toolset over", async () => {
		const tools = host(["read", "edit", "write"]);
		await attach(tools).sessionStart(gpt);
		expect(tools.active).toEqual(["read", "apply_patch"]);

		const reloaded = attach(tools);
		await reloaded.sessionStart(gpt);
		await reloaded.modelSelect(claude);

		expect(tools.active).toEqual(["read", "edit", "write"]);
	});

	it("restores edit and write when a session saved on GPT resumes on Claude", async () => {
		const tools = host(["read", "edit", "write"]);
		await attach(tools).sessionStart(gpt);

		await attach(tools).sessionStart(claude);

		expect(tools.active).toEqual(["read", "edit", "write"]);
	});

	it("keeps a session read-only when no edit tool was active", async () => {
		const tools = host(["read"]);
		const extension = attach(tools);
		await extension.sessionStart(gpt);
		await extension.modelSelect(claude);

		expect(tools.active).toEqual(["read"]);
	});

	it("restores only the edit tool that was active when the same instance switches back", async () => {
		const tools = host(["read", "edit"]);
		const extension = attach(tools);
		await extension.sessionStart(gpt);
		await extension.modelSelect(claude);

		expect(tools.active).toEqual(["read", "edit"]);
	});
});
