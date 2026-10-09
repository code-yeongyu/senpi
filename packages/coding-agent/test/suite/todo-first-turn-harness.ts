import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

export function model(id: string, api: Api = "anthropic-messages", compat?: Record<string, unknown>): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider: api === "anthropic-messages" ? "anthropic" : "openai",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		...(compat ? { compat } : {}),
	} as Model<Api>;
}

export const TODO_PAYLOAD = { tools: [{ name: "read" }, { name: "todo" }] };

/** The todotools extension on a captured fake `pi`, with an empty branch; the temp agent dir is pushed to `tempDirs`. */
export function fauxTodotoolsPi(tempDirs: string[], options: { setting?: string } = {}) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		appendEntry: () => {},
		getActiveTools: () => ["read", "todo"],
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	todotoolsExtension(pi);
	const root = mkdtempSync(join(tmpdir(), "todo-first-turn-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	if (options.setting) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ todo: { firstTurnPlan: options.setting } }));
	}
	const ctx = {
		cwd: root,
		agentDir,
		mode: "tui",
		model: model("claude-opus-5"),
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => [] },
		ui: { setWidget: () => {} },
	} as unknown as ExtensionContext;
	const emit = async (event: string, payload: Record<string, unknown> = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, ctx);
		return result;
	};
	const startTurn = (prompt = "add retries to fetchUser") =>
		emit("before_agent_start", { prompt, trigger: "prompt", systemPrompt: "base" }) as Promise<{
			message?: { customType: string };
		}>;
	const providerRequest = (payload: Record<string, unknown>, requestModel: Model<Api> = model("claude-opus-5")) =>
		emit("before_provider_request", { payload, model: requestModel }) as Promise<
			{ tool_choice?: unknown } | undefined
		>;
	return { emit, startTurn, providerRequest };
}
