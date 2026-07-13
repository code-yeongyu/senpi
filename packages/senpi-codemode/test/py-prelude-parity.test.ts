import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BridgeHttpCallRequest, startBridgeServer } from "../src/bridge/http-server.ts";
import type { BridgeConnectionConfig, EvalStatusEvent, KernelToHostMessage } from "../src/bridge/protocol.ts";
import {
	RESERVED_AGENT_TOOL,
	RESERVED_OUTPUT_TOOL,
	TIMEOUT_PAUSE_OP,
	TIMEOUT_RESUME_OP,
} from "../src/bridge/reserved.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { hasPython3, runCell } from "./py-kernel/fixtures.ts";

type PythonConnection = BridgeConnectionConfig & { readonly statusEvents?: boolean };

type StartLivePythonOptions = {
	readonly cwd: string;
	readonly connection: PythonConnection;
	readonly onMessage?: (message: KernelToHostMessage) => void;
};

async function startLivePython(options: StartLivePythonOptions): Promise<PythonKernel> {
	const detected = await createInterpreterDetector().detect("py");
	if (!detected.ok) throw new Error("python unavailable");
	return await PythonKernel.start({
		interpreterPath: detected.path,
		sessionId: `py-parity-${crypto.randomUUID()}`,
		cwd: options.cwd,
		connection: options.connection,
		onMessage: options.onMessage,
	});
}

function isStatusMessage(message: KernelToHostMessage): message is Extract<KernelToHostMessage, { type: "status" }> {
	return message.type === "status";
}

function isTextMessage(message: KernelToHostMessage): message is Extract<KernelToHostMessage, { type: "text" }> {
	return message.type === "text";
}

function isDisplayMessage(message: KernelToHostMessage): message is Extract<KernelToHostMessage, { type: "display" }> {
	return message.type === "display";
}

function statuses(messages: readonly KernelToHostMessage[]): readonly EvalStatusEvent[] {
	return messages.filter(isStatusMessage).map((message) => message.event);
}

describe.skipIf(!(await hasPython3()))("Python prelude parity", () => {
	it("resolves local paths and emits status events for magics and file helpers", async () => {
		// Given
		const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-py-parity-"));
		const localRoot = join(cwd, "artifacts", "local");
		await writeFile(join(cwd, "marker.txt"), "cwd-ok", "utf8");
		const messages: KernelToHostMessage[] = [];
		const kernel = await startLivePython({
			cwd,
			connection: { port: 1, token: "unused", localRoots: { local: localRoot } },
			onMessage: (message) => messages.push(message),
		});

		try {
			// When
			const result = await runCell(
				kernel,
				[
					`%cd ${cwd}`,
					"%env CM_MAGIC=green",
					"write('local://notes/value.txt', 'hello')",
					"print(read('marker.txt'), env('CM_MAGIC'), read('local://notes/value.txt'))",
				].join("\n"),
			);

			// Then
			expect(result.ok).toBe(true);
			const output = messages
				.filter(isTextMessage)
				.map((message) => message.data)
				.join("");
			expect(output).toContain("cwd-ok green hello");
			expect(await readFile(join(localRoot, "notes", "value.txt"), "utf8")).toBe("hello");
			expect(statuses(messages)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						op: "cd",
						path: expect.stringContaining(cwd.slice(cwd.lastIndexOf("/") + 1)),
					}),
					expect.objectContaining({ op: "env", key: "CM_MAGIC", value: "green" }),
					expect.objectContaining({ op: "write", chars: 5 }),
					expect.objectContaining({ op: "read", chars: 5 }),
				]),
			);
		} finally {
			await kernel.close();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("suppresses helper status events when statusEvents is false", async () => {
		// Given
		const messages: KernelToHostMessage[] = [];
		const connection = { port: 1, token: "unused", statusEvents: false };
		const kernel = await startLivePython({
			cwd: process.cwd(),
			connection,
			onMessage: (message) => messages.push(message),
		});

		try {
			// When
			const result = await runCell(kernel, "env('CM_STATUS_DISABLED', 'yes'); env('CM_STATUS_DISABLED')");

			// Then
			expect(result).toMatchObject({ ok: true, valueRepr: "'yes'" });
			expect(statuses(messages)).toHaveLength(0);
		} finally {
			await kernel.close();
		}
	});

	it("emits rich display frames for markdown, PNG, HTML, and figure fallbacks", async () => {
		// Given
		const messages: KernelToHostMessage[] = [];
		const kernel = await startLivePython({
			cwd: process.cwd(),
			connection: { port: 1, token: "unused" },
			onMessage: (message) => messages.push(message),
		});

		try {
			// When
			const result = await runCell(
				kernel,
				[
					"class Markdown:",
					"    def _repr_markdown_(self): return '**bold**'",
					"class Png:",
					"    def _repr_png_(self): return b'png-bytes'",
					"class Html:",
					"    def _repr_html_(self): return '<b>html</b>'",
					"class Figure:",
					"    __module__ = 'matplotlib.figure'",
					"    def savefig(self, target, **_kwargs): target.write(b'figure-bytes')",
					"display(Markdown())",
					"display(Png())",
					"display(Html())",
					"display(Figure())",
					"display(b'binary')",
				].join("\n"),
			);

			// Then
			expect(result.ok).toBe(true);
			const displays = messages.filter(isDisplayMessage);
			expect(displays.map((message) => message.mimeType)).toEqual([
				"text/markdown",
				"image/png",
				"text/html",
				"image/png",
				"application/octet-stream",
			]);
			expect(Buffer.from(displays[0]?.dataBase64 ?? "", "base64").toString("utf8")).toBe("**bold**");
			expect(Buffer.from(displays[1]?.dataBase64 ?? "", "base64").toString("utf8")).toBe("png-bytes");
			expect(Buffer.from(displays[2]?.dataBase64 ?? "", "base64").toString("utf8")).toBe("<b>html</b>");
			expect(Buffer.from(displays[3]?.dataBase64 ?? "", "base64").toString("utf8")).toBe("figure-bytes");
			expect(Buffer.from(displays[4]?.dataBase64 ?? "", "base64").toString("utf8")).toBe("binary");
		} finally {
			await kernel.close();
		}
	});

	it("marshals agent options to the reserved bridge name", async () => {
		// Given
		const calls: BridgeHttpCallRequest[] = [];
		const messages: KernelToHostMessage[] = [];
		const server = await startBridgeServer({
			token: "agent-token",
			onCall: async (request) => {
				calls.push(request);
				return { text: '{"answer":42}', id: "st_agent", handle: "agent://st_agent", agent: "reviewer" };
			},
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		const kernel = await startLivePython({
			cwd: process.cwd(),
			connection: { port: server.port, token: server.token },
			onMessage: (message) => messages.push(message),
		});

		try {
			// When
			const result = await runCell(
				kernel,
				"agent('do x', agent='reviewer', model='slow', label='lane', schema={'type':'object'}, isolated=True, apply=False, merge=True, handle=True)",
			);

			// Then
			expect(result.ok).toBe(true);
			expect(result.ok ? result.valueRepr : undefined).toContain("'data': {'answer': 42}");
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({
				toolName: RESERVED_AGENT_TOOL,
				args: {
					prompt: "do x",
					agent: "reviewer",
					model: "slow",
					label: "lane",
					schema: { type: "object" },
					isolated: true,
					apply: false,
					merge: true,
					handle: true,
				},
			});
			expect(statuses(messages).map((event) => event.op)).toEqual(
				expect.arrayContaining([TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP]),
			);
		} finally {
			await kernel.close();
			await server.close();
		}
	});

	it("marshals output requests to the reserved bridge name", async () => {
		// Given
		const calls: BridgeHttpCallRequest[] = [];
		const server = await startBridgeServer({
			token: "output-token",
			onCall: async (request) => {
				calls.push(request);
				return ["tail-a", "tail-b"];
			},
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		const kernel = await startLivePython({
			cwd: process.cwd(),
			connection: { port: server.port, token: server.token },
		});

		try {
			// When
			const result = await runCell(kernel, "output('st_1', 'st_2', format='tail', offset=2, limit=3)");

			// Then
			expect(result).toMatchObject({ ok: true, valueRepr: "['tail-a', 'tail-b']" });
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({
				toolName: RESERVED_OUTPUT_TOOL,
				args: { ids: ["st_1", "st_2"], format: "tail", offset: 2, limit: 3 },
			});
		} finally {
			await kernel.close();
			await server.close();
		}
	});

	it("does not translate shell or magic tokens inside multiline strings", async () => {
		// Given
		const messages: KernelToHostMessage[] = [];
		const kernel = await startLivePython({
			cwd: process.cwd(),
			connection: { port: 1, token: "unused" },
			onMessage: (message) => messages.push(message),
		});

		try {
			// When
			const result = await runCell(
				kernel,
				['payload = """!echo SHOULD_NOT_RUN', "%cd /missing", '"""', "print(payload)"].join("\n"),
			);

			// Then
			expect(result.ok).toBe(true);
			const output = messages
				.filter(isTextMessage)
				.map((message) => message.data)
				.join("");
			expect(output).toContain("!echo SHOULD_NOT_RUN\n%cd /missing");
			expect(output).not.toContain("No such file or directory");
		} finally {
			await kernel.close();
		}
	});
});
