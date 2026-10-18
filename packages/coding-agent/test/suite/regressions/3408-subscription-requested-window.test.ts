import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	_resetLongContextForTesting,
	markLongContextRefused,
} from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import {
	buildAnthropicSubscriptionQueryOptions,
	sdkModelId,
} from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";

const LONG_CONTEXT_BETA = "context-1m-2025-08-07";
let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "senpi-3408-wire-"));
	_resetLongContextForTesting(join(directory, "long-context.json"));
});

afterEach(async () => {
	_resetLongContextForTesting();
	await rm(directory, { recursive: true, force: true });
});

function model(id: string, contextWindow: number): Model<Api> {
	return {
		id,
		name: id,
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		baseUrl: "claude-sdk-oauth",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 128_000,
	};
}

type Captured = { model: string; betas: string[] };

/** One subscription turn through the installed Claude Code, captured at a local Anthropic-shaped endpoint. */
async function captureRequest(target: Model<Api>): Promise<Captured> {
	const captured: Captured[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			if (request.url?.includes("/v1/messages")) {
				const parsed = JSON.parse(body) as { model: string };
				const header = request.headers["anthropic-beta"];
				captured.push({
					model: parsed.model,
					betas: String(header ?? "")
						.split(",")
						.filter(Boolean),
				});
			}
			response.writeHead(400, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "capture only" } }),
			);
		});
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const options = buildAnthropicSubscriptionQueryOptions({
			model: target,
			context: { messages: [] },
			cwd: directory,
			providerSettings: {},
			authLane: "oauth-slots",
		});
		options.maxTurns = 1;
		options.env = {
			PATH: process.env.PATH ?? "",
			TMPDIR: directory,
			HOME: join(directory, "home"),
			CLAUDE_CONFIG_DIR: join(directory, "claude-config"),
			ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
			CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-token-for-local-mock-server",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			...options.env,
		};
		try {
			for await (const message of query({ prompt: "hi", options })) {
				if (message.type === "result") break;
			}
		} catch {
			// The capture endpoint answers 400 on purpose; only the request it received matters.
		}
		const first = captured[0];
		if (!first) throw new Error("Claude Code sent no /v1/messages request");
		return first;
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("#3408: the subscription request carries the window senpi plans against", () => {
	it("asks Claude Code for 1M with the [1m] model id, and the installed CLI sends the long-context beta", async () => {
		const opus = model("claude-opus-5-5", 1_000_000);

		const request = await captureRequest(opus);

		expect(sdkModelId(opus)).toBe("claude-opus-5-5[1m]");
		expect(request.model).toBe("claude-opus-5-5");
		expect(request.betas).toContain(LONG_CONTEXT_BETA);
	}, 60_000);

	it("sends no long-context request for a model planned at 200k", async () => {
		const haiku = model("claude-haiku-4-5", 200_000);

		const request = await captureRequest(haiku);

		expect(sdkModelId(haiku)).toBe("claude-haiku-4-5");
		expect(request.betas).not.toContain(LONG_CONTEXT_BETA);
	}, 60_000);

	it("drops the long-context request once the account refused it", async () => {
		markLongContextRefused();
		const opus = model("claude-opus-5-5", 1_000_000);

		const request = await captureRequest(opus);

		expect(sdkModelId(opus)).toBe("claude-opus-5-5");
		expect(request.betas).not.toContain(LONG_CONTEXT_BETA);
	}, 60_000);

	it("a live switch to a 1M model through setModel makes the installed CLI send the long-context beta", async () => {
		const captured: Captured[] = [];
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				if (request.url?.includes("/v1/messages")) {
					const header = request.headers["anthropic-beta"];
					captured.push({
						model: (JSON.parse(body) as { model: string }).model,
						betas: String(header ?? "")
							.split(",")
							.filter(Boolean),
					});
				}
				response.writeHead(400, { "content-type": "application/json" });
				response.end(
					JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "capture only" } }),
				);
			});
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const { port } = server.address() as AddressInfo;
			const haiku = model("claude-haiku-4-5", 200_000);
			const opus = model("claude-opus-5-5", 1_000_000);
			const options = buildAnthropicSubscriptionQueryOptions({
				model: haiku,
				context: { messages: [] },
				cwd: directory,
				providerSettings: {},
				authLane: "oauth-slots",
			});
			options.env = {
				PATH: process.env.PATH ?? "",
				TMPDIR: directory,
				HOME: join(directory, "home"),
				CLAUDE_CONFIG_DIR: join(directory, "claude-config"),
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
				CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-token-for-local-mock-server",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				...options.env,
			};
			const turns: Array<() => void> = [];
			const userTurn = (text: string) => ({
				type: "user" as const,
				message: { role: "user" as const, content: text },
				parent_tool_use_id: null,
				session_id: "",
			});
			async function* prompts() {
				yield userTurn("first");
				await new Promise<void>((resolve) => turns.push(resolve));
				yield userTurn("second");
			}
			const live = query({ prompt: prompts(), options });
			let results = 0;
			try {
				for await (const message of live) {
					if (message.type !== "result") continue;
					results += 1;
					if (results === 1) {
						await live.setModel(sdkModelId(opus));
						turns.shift()?.();
					} else break;
				}
			} catch {
				// The capture endpoint answers 400 on purpose; only the requests it received matter.
			}
			const before = captured.filter((request) => request.model === "claude-haiku-4-5");
			const after = captured.filter((request) => request.model === "claude-opus-5-5");
			expect(captured.map((request) => request.model)).toEqual(
				[...before, ...after].map((request) => request.model),
			);
			expect(before.length).toBeGreaterThan(0);
			expect(before.every((request) => !request.betas.includes(LONG_CONTEXT_BETA))).toBe(true);
			expect(after.length).toBeGreaterThan(0);
			expect(after.every((request) => request.betas.includes(LONG_CONTEXT_BETA))).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 90_000);

	it.each([
		"Extra usage is required for long context · enable extra usage at claude.ai/settings/usage (rate_limit)",
		"Usage credits are required for long context (rate_limit)",
	])("classifies %j as a refused window, never as a rate limit that blocks the account", (text) => {
		expect(classifySdkError(new Error(text))).toEqual({ kind: "long_context_unavailable", retryable: true });
	});
});
