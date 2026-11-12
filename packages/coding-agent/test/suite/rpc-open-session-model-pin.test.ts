import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { contextHost } from "./rpc-session-context-support.ts";

// omo#13243: a model the launcher names explicitly answers or fails with its own error; it never falls back
// unless the launcher asks for fallback. A model the host defaults to is not such a choice.
const RATE_LIMIT = "429 rate_limit_error: too many requests";
const CHAIN = { "faux-fallback/primary": ["faux-fallback/spare-a"] };
const SETTINGS = {
	retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: CHAIN },
	defaultThinkingLevel: "off",
};

function fauxWherePrimaryIsRateLimited() {
	const faux = fauxProvider({
		api: "faux-fallback",
		provider: "faux-fallback",
		models: [{ id: "primary" }, { id: "spare-a" }],
	});
	const step: FauxResponseStep = (_context, _options, _state, model) =>
		model.id === "primary"
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: RATE_LIMIT })
			: fauxAssistantMessage(`answered by ${model.id}`);
	faux.setResponses(Array.from({ length: 12 }, () => step));
	return faux;
}

function lastAssistant(
	host: Awaited<ReturnType<typeof contextHost>>,
	connection: string,
	sessionId: string,
): { model: string | undefined; text: string } {
	const end = host
		.inbox(connection)
		.filter(
			(record) =>
				record.type === "message_end" &&
				record.sessionId === sessionId &&
				(record as { message?: { role?: string } }).message?.role === "assistant",
		)
		.at(-1) as
		| { message?: { model?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> } }
		| undefined;
	const message = end?.message;
	return {
		model: message?.model,
		text: message?.errorMessage ?? message?.content?.find((block) => block.type === "text")?.text ?? "",
	};
}

function calledModels(faux: ReturnType<typeof fauxProvider>): string[] {
	return faux.getCallLog().map((call) => call.modelId);
}

describe("an open_session that names a model is pinned (omo#13243)", () => {
	it("ends the rate-limited turn on the named model instead of walking the chain", async () => {
		const faux = fauxWherePrimaryIsRateLimited();
		await using host = await contextHost({ faux, globalSettings: SETTINGS });
		const opened = await host.open("conn-a", {});
		const named = await host.send("conn-a", {
			type: "open_session",
			cwd: host.cwd,
			provider: "faux-fallback",
			modelId: "primary",
		});
		const sessionId = String((named as { data?: { sessionId?: string } } | undefined)?.data?.sessionId);
		expect(opened.sessionId).not.toBe(sessionId);

		await host.prompt("conn-a", sessionId, "go");

		expect(calledModels(faux)).toStrictEqual(["primary"]);
		const fallbacks = host
			.inbox("conn-a")
			.filter((record) => record.type === "retry_fallback_applied" && record.sessionId === sessionId);
		expect(fallbacks).toStrictEqual([]);
	}, 120_000);

	it("still falls back when the opener asks for fallback alongside the named model", async () => {
		const faux = fauxWherePrimaryIsRateLimited();
		await using host = await contextHost({ faux, globalSettings: SETTINGS });
		const named = await host.send("conn-a", {
			type: "open_session",
			cwd: host.cwd,
			provider: "faux-fallback",
			modelId: "primary",
			retryFallback: { modelFallback: true, fallbackChains: CHAIN },
		});
		const sessionId = String((named as { data?: { sessionId?: string } } | undefined)?.data?.sessionId);

		await host.prompt("conn-a", sessionId, "go");

		expect(calledModels(faux)).toStrictEqual(["primary", "spare-a"]);
	}, 120_000);

	it("keeps a session on the host's default model under the host's fallback settings", async () => {
		const faux = fauxWherePrimaryIsRateLimited();
		await using host = await contextHost({ faux, globalSettings: SETTINGS });
		const opened = await host.open("conn-a", {});

		await host.prompt("conn-a", String(opened.sessionId), "go");

		expect(calledModels(faux)).toStrictEqual(["primary", "spare-a"]);
	}, 120_000);

	it("pins only the session that named its model: an unpinned session on the same host still falls back", async () => {
		const faux = fauxWherePrimaryIsRateLimited();
		await using host = await contextHost({ faux, globalSettings: SETTINGS });
		const pinned = await host.send("conn-a", {
			type: "open_session",
			cwd: host.cwd,
			provider: "faux-fallback",
			modelId: "primary",
		});
		const pinnedId = String((pinned as { data?: { sessionId?: string } } | undefined)?.data?.sessionId);
		const unpinned = await host.open("conn-b", {});
		const unpinnedId = String(unpinned.sessionId);

		await host.prompt("conn-a", pinnedId, "go");
		await host.prompt("conn-b", unpinnedId, "go");

		expect(lastAssistant(host, "conn-a", pinnedId)).toStrictEqual({ model: "primary", text: RATE_LIMIT });
		expect(lastAssistant(host, "conn-b", unpinnedId)).toStrictEqual({
			model: "spare-a",
			text: "answered by spare-a",
		});
	}, 120_000);
});

describe("a standalone run started with --model is pinned (omo#13243)", () => {
	let scratch: string | undefined;
	afterEach(() => {
		vi.unstubAllEnvs();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
		scratch = undefined;
	});

	async function runOnce(args: readonly string[]) {
		scratch = mkdtempSync(join(tmpdir(), "senpi-model-pin-"));
		const cwd = join(scratch, "cwd");
		const agentDir = join(scratch, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(SETTINGS)}\n`);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
		const faux = fauxWherePrimaryIsRateLimited();
		const parsed = parseArgs([
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--api-key",
			"faux-key",
			...args,
		]);
		const factory = createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "print" },
			{ extensionFactories: [(pi) => pi.registerProvider(faux.provider)] },
		);
		const runtime = await factory({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		await runtime.session.prompt("go");
		await runtime.session.waitForSettledSessionWork();
		await runtime.session.dispose?.();
		return calledModels(faux);
	}

	it("ends the rate-limited turn on the --model it was started with", async () => {
		expect(await runOnce(["--provider", "faux-fallback", "--model", "primary"])).toStrictEqual(["primary"]);
	}, 120_000);
});
