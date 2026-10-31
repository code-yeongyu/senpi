/**
 * senpi#4006: in classic `--mode rpc` (one client, no shared-host registry) a `set_client_info` that carries
 * `capabilities` replaces the set the handler reads, after the senpi#3811 role check, as docs/rpc.md "Client
 * information" states. A width-only call keeps the set; `SENPI_RPC_CLIENT_CAPABILITIES` is only the initial value.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionOptions,
} from "../../../src/modes/rpc/connection-handler.ts";
import { INTERACTIVE_USER_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import { createHarness, type Harness } from "../harness.ts";
import { endpoint } from "../rpc-host-endpoint.ts";

const ASK = [
	"export default function (pi) {",
	'	pi.registerCommand("ask-question", { description: "question fixture", handler: async (_args, ctx) => {',
	'		const result = await ctx.ui.question({ requestId: "classic-question", waitForAnswer: true, timeoutMs: 60000,',
	'			questions: [{ id: "q1", header: "q1", question: "q1", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] });',
	'		ctx.ui.notify("QUESTION_STATUS=" + result.status);',
	"	} });",
	"}",
].join("\n");

async function classicCli(run: (client: ReturnType<typeof endpoint>) => Promise<void>): Promise<void> {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-4006-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const extension = join(scratch, "ask.mjs");
	await writeFile(extension, ASK);
	const child = spawn(
		process.execPath,
		[
			resolve("src/cli.ts"),
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--extension",
			extension,
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: scratch,
				TMPDIR: scratch,
				SENPI_CODING_AGENT_DIR: agentDir,
				SENPI_OFFLINE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-4000);
	});
	const client = endpoint(child.stdout, child.stdin, () => stderr);
	const closed = once(child, "close");
	try {
		await run(client);
	} finally {
		client.dispose();
		child.kill("SIGTERM");
		await closed;
		await rm(scratch, { recursive: true, force: true });
	}
}

function nextDialog(client: ReturnType<typeof endpoint>) {
	return client.wait(
		(record) =>
			record.type === "extension_ui_request" && ["question", "select", "input"].includes(String(record.method)),
	);
}

describe("classic --mode rpc over stdio", () => {
	it("a client that declares question gets the structured question frame", async () => {
		await classicCli(async (client) => {
			// Given: the client declared `question` on its one connection.
			expect(await client.request({ type: "set_client_info", width: 80, capabilities: ["question"] })).toMatchObject(
				{ success: true },
			);

			// When: an extension asks a question.
			const dialog = nextDialog(client);
			client.send({ type: "prompt", message: "/ask-question" });

			// Then: it arrives as one structured question frame.
			expect((await dialog).method).toBe("question");
		});
	}, 60_000);

	it("a width-only set_client_info keeps the declared question", async () => {
		await classicCli(async (client) => {
			// Given: the client declared `question`, then resized without capabilities.
			await client.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			expect(await client.request({ type: "set_client_info", width: 120 })).toMatchObject({ success: true });

			// When: an extension asks a question.
			const dialog = nextDialog(client);
			client.send({ type: "prompt", message: "/ask-question" });

			// Then: the declaration still holds.
			expect((await dialog).method).toBe("question");
		});
	}, 60_000);
});

describe("classic --mode rpc withdrawing question", () => {
	it("cancels the pending structured question once", async () => {
		await classicCli(async (client) => {
			// Given: the client declared `question` and a structured question is pending.
			await client.request({ type: "set_client_info", width: 80, capabilities: ["question"] });
			const dialog = nextDialog(client);
			client.send({ type: "prompt", message: "/ask-question" });
			const question = await dialog;
			expect(question.method).toBe("question");

			// When: the client declares again without `question`.
			const settled = client.wait(
				(record) => record.type === "extension_ui_request" && record.message === "QUESTION_STATUS=cancelled",
			);
			expect(await client.request({ type: "set_client_info", width: 80, capabilities: [] })).toMatchObject({
				success: true,
			});

			// Then: the question it can no longer answer is cancelled exactly once.
			await settled;
			expect(
				client.records.filter((record) => record.type === "question_resolved" && record.id === question.id),
			).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
		});
	}, 60_000);
});

type RpcExtensionApi = ExtensionAPI & { readonly rpc?: { emit(name: string, data: unknown): void } };
type WireRecord = Record<string, unknown>;

function runtimeHost(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
}

describe("classic handler extension_events", () => {
	const harnesses: Harness[] = [];
	const handlers: RpcConnectionHandler[] = [];
	afterEach(async () => {
		while (handlers.length > 0) await handlers.pop()?.dispose();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function classicHandler(options: RpcConnectionOptions = {}) {
		let api: RpcExtensionApi | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi as RpcExtensionApi;
				},
			],
		});
		harnesses.push(harness);
		const chunks: string[] = [];
		const handler = createRpcConnectionHandler(
			runtimeHost(harness.session),
			{ writeRaw: (chunk) => chunks.push(chunk), waitForBackpressure: async () => {} },
			options,
		);
		handlers.push(handler);
		await handler.ready;
		let serial = 0;
		const send = async (command: Record<string, unknown>): Promise<WireRecord | undefined> => {
			const id = `classic-${++serial}`;
			await handler.handleInputLine(JSON.stringify({ ...command, id }));
			return wire().find((record) => record.id === id);
		};
		const wire = (): WireRecord[] =>
			chunks
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as WireRecord);
		const emitted = async (name: string): Promise<number> => {
			if (!api?.rpc) throw new Error("the extension did not receive the RPC API");
			api.rpc.emit(name, { name });
			await send({ type: "get_state" });
			return wire().filter((record) => record.type === "extension_event" && record.name === name).length;
		};
		return { send, emitted };
	}

	it("declaring extension_events subscribes, and declaring without it unsubscribes", async () => {
		const { send, emitted } = await classicHandler();
		expect(await emitted("before")).toBe(0);
		expect(await send({ type: "set_client_info", width: 80, capabilities: ["extension_events"] })).toMatchObject({
			success: true,
		});
		expect(await emitted("declared")).toBe(1);
		await send({ type: "set_client_info", width: 80 });
		expect(await emitted("after-resize")).toBe(1);
		await send({ type: "set_client_info", width: 80, capabilities: [] });
		expect(await emitted("withdrawn")).toBe(0);
		await send({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
		expect(await emitted("again")).toBe(1);
	});

	it("the launch capabilities are the initial set, which a declaration then replaces", async () => {
		const { send, emitted } = await classicHandler({ capabilities: ["extension_events"] });
		expect(await emitted("launch")).toBe(1);
		await send({ type: "set_client_info", width: 80, capabilities: ["question"] });
		expect(await emitted("replaced")).toBe(0);
	});

	it("a declaration the role check refuses changes nothing", async () => {
		const { send, emitted } = await classicHandler();
		await send({ type: "set_client_info", width: 80, capabilities: [INTERACTIVE_USER_CAPABILITY] });
		const refused = await send({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
		expect(refused).toMatchObject({ success: false, error: expect.stringContaining("connection_role_fixed") });
		expect(await emitted("refused")).toBe(0);
	});
});
