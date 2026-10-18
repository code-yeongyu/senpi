/**
 * #2461: `open_session.permissionPreset` must decide the session's permission ruleset.
 *
 * Runs the real multi-session host core (the daemon's registry, router and writer) over
 * the real `createCliRuntimeFactory` from `main.ts`, so the builtin permission extension
 * loads exactly as in a host-opened session. Only the model is faked: a faux provider
 * scripts one tool call per turn. A permission `ask` reaches the client the only way it
 * can on this path, as an `extension_ui_request` select titled "Permission required: ...",
 * which the test answers with Deny.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

function wireCommand(frame: Record<string, unknown>): RpcCommand {
	return JSON.parse(JSON.stringify(frame)) as RpcCommand;
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

interface ToolTurn {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

async function presetHost(turn: ToolTurn) {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-2461-"));
	const cwd = join(scratch, "project");
	const outside = join(scratch, "outside");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(outside);
	await mkdir(agentDir);
	await writeFile(join(cwd, "inside.txt"), "inside\n");
	await writeFile(join(outside, "secret.txt"), "outside secret\n");
	const faux = fauxProvider({ api: "fauxperm", provider: "fauxperm" });
	const model = faux.getModel();
	const args = JSON.parse(JSON.stringify(turn.args).replaceAll("$OUTSIDE", outside).replaceAll("$CWD", cwd));
	const scriptTurn = (): void =>
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(turn.name, args, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-skills",
		"--no-context-files",
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--api-key",
		"faux-key",
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{ extensionFactories: [(pi) => pi.registerProvider(faux.provider)] },
		),
		closeGraceMs: 1_000,
	});
	const records: WireRecord[] = [];
	const listeners = new Set<(record: WireRecord) => void>();
	const observe = (line: string): void => {
		const record = JSON.parse(line) as WireRecord;
		records.push(record);
		for (const listener of [...listeners]) listener(record);
	};
	const waitFor = (predicate: (record: WireRecord) => boolean, ms = 30_000): Promise<WireRecord> => {
		const seen = records.find(predicate);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners.delete(listener);
				reject(new Error(`Deadline waiting for ${String(predicate).replace(/\s+/g, " ").slice(0, 160)}`));
			}, ms);
			const listener = (record: WireRecord): void => {
				if (!predicate(record)) return;
				clearTimeout(timer);
				listeners.delete(listener);
				resolve(record);
			};
			listeners.add(listener);
		});
	};
	const writer = new SessionEventWriter(observe);
	writer.registerConnection("client", { writeRaw: observe, waitForBackpressure: async () => {} });
	const router = new SessionCommandRouter(registry, writer, { cwd });
	let serial = 0;
	const send = async (command: RpcCommand): Promise<WireRecord | undefined> => {
		const id = `req-${++serial}`;
		const direct = await writer.withConnection("client", () => router.handle({ ...command, id } as RpcCommand));
		await writer.flush();
		return (direct as WireRecord | undefined) ?? records.find((record) => record.id === id);
	};
	disposers.push(async () => {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	return {
		cwd,
		outside,
		records,
		async warm(): Promise<string> {
			const warmed = await send({ type: "warm", cwd } as RpcCommand);
			return String((warmed?.data as { state?: string } | undefined)?.state);
		},
		async run(permissionPreset: string): Promise<{ sessionId: string; asked: WireRecord[] }> {
			scriptTurn();
			const opened = await send({ type: "open_session", cwd, permissionPreset } as RpcCommand);
			const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId;
			if (!sessionId) throw new Error(`open_session failed: ${JSON.stringify(opened)}`);
			// Deny every permission prompt the session raises, so a gated call never runs.
			const denier = (record: WireRecord): void => {
				if (record.type !== "extension_ui_request" || record.method !== "select") return;
				if (!String(record.title ?? "").startsWith("Permission required:")) return;
				void writer.withConnection("client", () =>
					router.handle(
						wireCommand({ type: "extension_ui_response", id: String(record.id), sessionId, value: "Deny" }),
					),
				);
			};
			listeners.add(denier);
			const idle = waitFor((record) => record.type === "agent_idle" && record.sessionId === sessionId);
			const prompted = await send({ type: "prompt", sessionId, message: "go" } as RpcCommand);
			if (prompted?.success === false) throw new Error(`prompt failed: ${String(prompted.error)}`);
			await idle;
			await registry.peek(sessionId)?.runtime?.session.waitForSettledSessionWork();
			listeners.delete(denier);
			const asked = records.filter(
				(record) =>
					record.sessionId === sessionId &&
					record.type === "extension_ui_request" &&
					record.method === "select" &&
					String(record.title ?? "").startsWith("Permission required:"),
			);
			return { sessionId, asked };
		},
		toolResultText(sessionId?: string): string {
			const end = records.find(
				(record) =>
					record.type === "tool_execution_end" &&
					(record as { toolCallId?: string }).toolCallId === "call-1" &&
					(sessionId === undefined || record.sessionId === sessionId),
			);
			return JSON.stringify(end ?? {});
		},
	};
}

describe("open_session.permissionPreset decides host-session permissions (#2461)", () => {
	it("full-access runs an outside-project read without asking", async () => {
		const host = await presetHost({ name: "read", args: { path: "$OUTSIDE/secret.txt" } });
		const { asked } = await host.run("full-access");
		expect(asked).toEqual([]);
		expect(host.toolResultText()).toContain("outside secret");
	});

	it("accept-edits asks before an outside-project read, and a denied read does not run", async () => {
		const host = await presetHost({ name: "read", args: { path: "$OUTSIDE/secret.txt" } });
		const { asked } = await host.run("accept-edits");
		expect(asked.map((record) => String(record.title).split("\n")[0])).toEqual([
			"Permission required: external_directory",
		]);
		expect(host.toolResultText()).not.toContain("outside secret");
	});

	it("accept-edits asks before an eval cell, the host session's only way to run commands, and a denied cell does not run", async () => {
		const host = await presetHost({
			name: "eval",
			args: {
				language: "js",
				summary: "write a marker",
				code: 'await Bun.write("$CWD/ran.txt", "ran")',
			},
		});
		const { asked } = await host.run("accept-edits");
		expect(asked.map((record) => String(record.title).split("\n")[0])).toEqual(["Permission required: eval"]);
		await expect(readFile(join(host.cwd, "ran.txt"), "utf8")).rejects.toThrow();
	});

	it("accept-edits edits inside the project without asking", async () => {
		const host = await presetHost({
			name: "write",
			args: { path: "$CWD/inside.txt", content: "edited\n" },
		});
		const { asked } = await host.run("accept-edits");
		expect(asked).toEqual([]);
		expect(await readFile(join(host.cwd, "inside.txt"), "utf8")).toBe("edited\n");
	});

	it("ask asks even for an inside-project read", async () => {
		const host = await presetHost({ name: "read", args: { path: "$CWD/inside.txt" } });
		const { asked } = await host.run("ask");
		expect(asked.map((record) => String(record.title).split("\n")[0])).toEqual(["Permission required: read"]);
		expect(host.toolResultText()).not.toContain("inside\\n");
	});

	it("a host warmed before the open still applies accept-edits to the opened session", async () => {
		const host = await presetHost({ name: "read", args: { path: "$OUTSIDE/secret.txt" } });
		expect(await host.warm()).toBe("warmed");
		const { asked } = await host.run("accept-edits");
		expect(asked.map((record) => String(record.title).split("\n")[0])).toEqual([
			"Permission required: external_directory",
		]);
		expect(host.toolResultText()).not.toContain("outside secret");
	});

	it("two sessions on one host keep their own presets", async () => {
		const host = await presetHost({ name: "read", args: { path: "$OUTSIDE/secret.txt" } });
		const guarded = await host.run("accept-edits");
		const open = await host.run("full-access");
		expect(guarded.asked.map((record) => String(record.title).split("\n")[0])).toEqual([
			"Permission required: external_directory",
		]);
		expect(open.asked).toEqual([]);
		expect(host.toolResultText(guarded.sessionId)).not.toContain("outside secret");
		expect(host.toolResultText(open.sessionId)).toContain("outside secret");
	});
});
