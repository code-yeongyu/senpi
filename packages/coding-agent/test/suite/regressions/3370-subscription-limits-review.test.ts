/**
 * senpi#3374 review: a limit report reaches each client once on a multi-session host (the host broadcasts;
 * per-session handlers do not), a failing listener never reaches the provider response it runs inside,
 * and the Claude subscription's SDK `rate_limit_event` is recorded for the account that served it.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createAttemptMessages } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-attempt.ts";
import { SubscriptionLimitStore, subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { createHostCore } from "../../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

type WireRecord = Record<string, unknown>;

async function hostWithTwoSessions() {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-3374-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const faux = fauxProvider({ models: [{ id: "faux-a" }] });
	const model = faux.getModel();
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--api-key",
		"faux-key",
	]);
	const createRuntime = createCliRuntimeFactory(
		{ parsed, cwd, agentDir, appMode: "rpc" },
		{ extensionFactories: [(pi) => pi.registerProvider(faux.provider)] },
	);
	const writer = new SessionEventWriter(() => {});
	const core = createHostCore({ agentDir, createRuntime, cwd }, writer, [], {
		idleEvictionMs: 1e12,
		emptyExitMs: 1e12,
	});
	const inbox: WireRecord[] = [];
	writer.registerConnection("c", {
		writeRaw: (chunk) => {
			for (const line of chunk.split("\n")) if (line !== "") inbox.push(JSON.parse(line) as WireRecord);
		},
		waitForBackpressure: async () => {},
	});
	let serial = 0;
	const request = async (command: WireRecord): Promise<WireRecord> => {
		const id = `r${++serial}`;
		await writer.withConnection("c", () => core.handle(JSON.stringify({ ...command, id })));
		await writer.flush();
		const answer = inbox.find((record) => record.type === "response" && record.id === id);
		if (answer === undefined) throw new Error(`no answer to ${String(command.type)}`);
		return answer;
	};
	for (let index = 0; index < 2; index++) {
		const opened = await request({ type: "open_session", cwd });
		if (opened.success !== true) throw new Error(`open failed: ${JSON.stringify(opened)}`);
	}
	return {
		inbox,
		writer,
		dispose: async () => {
			await core.router.dispose();
			await writer.flush();
			await rm(scratch, { recursive: true, force: true });
		},
	};
}

describe("subscription limits review fixes (senpi#3374)", () => {
	it("delivers one subscription_limits record per report on a host with two sessions open", async () => {
		const host = await hostWithTwoSessions();
		try {
			const before = host.inbox.length;
			subscriptionLimits.record("chatgpt-subscription", "review-test", [
				{ id: "codex:primary", label: "7d", usedPercent: 42 },
			]);
			await host.writer.flush();

			const records = host.inbox.slice(before).filter((record) => record.type === "subscription_limits");
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ provider: "chatgpt-subscription", account: "review-test" });
		} finally {
			await host.dispose();
		}
	}, 60_000);

	it("contains a failing listener: record does not throw and later listeners still run", () => {
		const store = new SubscriptionLimitStore();
		const seen: string[] = [];
		store.subscribe(() => {
			throw new Error("closed sink");
		});
		store.subscribe((limits) => seen.push(limits.account));

		expect(() => store.record("p", "a", [{ id: "x:primary", label: "5h", usedPercent: 1 }])).not.toThrow();
		expect(seen).toEqual(["a"]);
	});

	it("records the SDK rate_limit_event for the account that served the attempt, passing every message through", async () => {
		const messages = [
			{
				type: "rate_limit_event",
				rate_limit_info: { rateLimitType: "five_hour", utilization: 0.25, resetsAt: 1704069000 },
			},
			{ type: "result", subtype: "success" },
		];
		const attempt = await createAttemptMessages(
			{
				prompt: "hi",
				query: (() => ({
					async *[Symbol.asyncIterator]() {
						yield* messages;
					},
					close: () => {},
				})) as never,
			},
			{ accountName: "seat-b", accounts: [], authLane: "stored", options: {} } as never,
		);
		const passed: unknown[] = [];
		for await (const message of attempt) passed.push(message);

		expect(passed).toEqual(messages);
		expect(subscriptionLimits.snapshot()).toContainEqual(
			expect.objectContaining({
				provider: "anthropic-subscription",
				account: "seat-b",
				windows: [expect.objectContaining({ id: "claude:5h", usedPercent: 25 })],
			}),
		);
	});
});
