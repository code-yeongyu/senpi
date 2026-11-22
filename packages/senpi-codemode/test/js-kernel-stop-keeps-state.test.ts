import { describe, expect, it } from "vitest";
import {
	createKernel,
	registerStopHarnessCleanup,
	silentServer,
	spawnCount,
	startedCell,
	stopAndExpectStateKept,
} from "./eval/js-stop-harness.ts";

registerStopHarnessCleanup();

describe("JavaScriptKernel stop on a free event loop", () => {
	it("Given a cell awaiting a promise nothing settles when stopped then earlier globals survive on the same worker", async () => {
		const { kernel, entry } = await createKernel();
		const { run } = await startedCell(kernel, "parked", "globalThis.keep = 41; await new Promise(() => {})");

		await stopAndExpectStateKept(kernel, entry, run);
	});

	it("Given a cell awaiting a fetch whose server never answers when stopped then earlier globals survive on the same worker", async () => {
		const { kernel, entry } = await createKernel();
		const server = await silentServer();
		const { run } = await startedCell(
			kernel,
			"hung-fetch",
			`globalThis.keep = 41; await fetch(${JSON.stringify(server.url)})`,
		);
		await server.requested;

		await stopAndExpectStateKept(kernel, entry, run);
		await server.aborted;
	});

	it("Given a stopped cell that resumes later when it starts a fetch then the request is refused", async () => {
		const { kernel } = await createKernel();
		const server = await silentServer();
		const { run } = await startedCell(
			kernel,
			"fetch-after-stop",
			`globalThis.keep = 41; globalThis.resume = Promise.withResolvers(); await resume.promise; globalThis.lateFetch = fetch(${JSON.stringify(server.url)}).then(() => "sent", (error) => String(error.message));`,
		);
		await kernel.interrupt("user-stop");
		await run;

		await expect(
			kernel.run({
				cellId: "after",
				code: "resume.resolve(); while (globalThis.lateFetch === undefined) await Promise.resolve(); return await lateFetch",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: '"JS cell interrupted: user-stop"' });
	});

	it("Given a stopped cell that resumes later when it prints or calls a tool then nothing reaches the next cell", async () => {
		const { kernel } = await createKernel();
		const { run } = await startedCell(
			kernel,
			"late-resume",
			"globalThis.keep = 41; globalThis.resume = Promise.withResolvers(); await globalThis.resume.promise; print('LATE'); await tool.late({});",
		);
		await kernel.interrupt("user-stop");
		await run;
		const texts: string[] = [];
		const next = await kernel.run({
			cellId: "next",
			code: "globalThis.resume.resolve(); await new Promise((resolve) => setTimeout(resolve, 50)); return keep",
			timeoutMs: 5_000,
			onMessage: (message) => {
				if (message.type === "text") texts.push(message.data);
			},
		});
		expect(next).toMatchObject({ ok: true, valueRepr: "41" });
		expect(texts.join("")).not.toContain("LATE");
	});

	it("Given a stopped cell that left a fetch and a derived chain unawaited then the kernel keeps its state and does not crash", async () => {
		const { kernel, entry } = await createKernel();
		const server = await silentServer();
		const { run } = await startedCell(
			kernel,
			"floating-fetch",
			`globalThis.keep = 41; globalThis.p = fetch(${JSON.stringify(server.url)}); globalThis.q = p.then((r) => r.status); await new Promise(() => {});`,
		);
		await server.requested;

		await stopAndExpectStateKept(kernel, entry, run);
		await server.aborted;
		await expect(
			kernel.run({
				cellId: "after",
				code: "await new Promise((r) => setTimeout(r, 100)); return keep + 1",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: "42" });
		expect(await spawnCount(entry)).toBe(1);
	});

	it("Given a stopped cell with an open socket server and client when stopped then both close and earlier globals survive", async () => {
		const { kernel, entry } = await createKernel();
		const { run } = await startedCell(
			kernel,
			"sockets",
			[
				"globalThis.keep = 41;",
				'const net = await import("node:net");',
				"globalThis.srv = net.createServer(() => {}); await new Promise((r) => srv.listen(0, '127.0.0.1', r));",
				"globalThis.sock = net.createConnection(srv.address().port, '127.0.0.1'); await new Promise((r) => sock.once('connect', r));",
				"await new Promise(() => {});",
			].join(" "),
		);

		await stopAndExpectStateKept(kernel, entry, run);
		await expect(
			kernel.run({
				cellId: "after",
				code: "await new Promise((r) => setTimeout(r, 100)); return [srv.listening, sock.destroyed]",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: "[false,true]" });
	});

	it("Given a first cell whose import of node:net is built from a string at run time when stopped then its server closes", async () => {
		const { kernel, entry } = await createKernel();
		const { run } = await startedCell(
			kernel,
			"string-built-import",
			[
				"globalThis.keep = 41;",
				'const net = await new Function("return import(\'node:" + "net\')")();',
				"globalThis.hidden = net.createServer(() => {}); await new Promise((r) => hidden.listen(0, '127.0.0.1', r));",
				"await new Promise(() => {});",
			].join(" "),
		);

		await stopAndExpectStateKept(kernel, entry, run);
		await expect(
			kernel.run({
				cellId: "after",
				code: "await new Promise((r) => setTimeout(r, 100)); return hidden.listening",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: "false" });
	});

	it("Given a stopped cell whose floating fetch rethrows a new error with a cause then the kernel keeps its state and reports it on the next cell", async () => {
		const { kernel, entry } = await createKernel();
		const server = await silentServer();
		const { run } = await startedCell(
			kernel,
			"wrapped-fetch",
			[
				"globalThis.keep = 41;",
				`const load = async (n) => { try { return await fetch(${JSON.stringify(server.url)}); } catch (error) { throw new Error("load " + n + " failed", { cause: error }); } };`,
				"const a = load(1), b = load(2); await a; await b;",
			].join(" "),
		);
		await server.requested;

		const reported = await stopAndExpectStateKept(kernel, entry, run);
		expect(reported).toMatch(
			/Unhandled promise rejection from cell wrapped-fetch, after it was stopped: Error: load \d failed/u,
		);
		expect(reported.match(/Unhandled promise rejection/gu)).toHaveLength(1);
		await expect(kernel.run({ cellId: "after", code: "return keep + 1", timeoutMs: 5_000 })).resolves.toMatchObject({
			ok: true,
			valueRepr: "42",
		});
	});

	it("Given a cell that leaves many promises rejecting unhandled when it runs then one report and a count reach its output and the kernel keeps its state", async () => {
		const { kernel, entry } = await createKernel();
		const stderr: string[] = [];
		const result = await kernel.run({
			cellId: "burst",
			code: "globalThis.keep = 41; for (let i = 0; i < 50; i++) Promise.reject(new Error('burst ' + i)); await new Promise((r) => setTimeout(r, 50)); return 'done'",
			timeoutMs: 5_000,
			onMessage: (message) => {
				if (message.type === "text" && message.stream === "stderr") stderr.push(message.data);
			},
		});
		expect(result).toMatchObject({ ok: true });
		const text = stderr.join("");
		expect(text.match(/Unhandled promise rejection/gu)).toHaveLength(1);
		expect(text).toMatch(/Unhandled promise rejection in this cell: Error: burst 0\n\s+at /u);
		expect(text).toContain("... and 49 more unhandled promise rejections");
		await expect(kernel.run({ cellId: "after", code: "return keep", timeoutMs: 5_000 })).resolves.toMatchObject({
			ok: true,
			valueRepr: "41",
		});
		expect(await spawnCount(entry)).toBe(1);
	});

	it("Given an uncaught exception in a timer when it fires then the worker still restarts and says variables are lost", async () => {
		const { kernel, entry } = await createKernel();
		await kernel.run({ cellId: "set", code: "globalThis.keep = 41; return 1", timeoutMs: 5_000 });
		const crashed = await kernel.run({
			cellId: "fatal",
			code: "setTimeout(() => { throw new Error('fatal boom'); }, 0); await new Promise(() => {})",
			timeoutMs: 10_000,
		});
		expect(crashed).toMatchObject({ ok: false });
		const after = await kernel.run({ cellId: "after", code: "return typeof keep", timeoutMs: 10_000 });
		expect(after.ok ? after.valueRepr : after.error.message).toMatch(/"undefined"|lost/u);
		expect(await spawnCount(entry)).toBe(2);
	});

	it("Given a stopped cell that started a node:worker_threads Worker then the worker is terminated and earlier globals survive", async () => {
		const { kernel, entry } = await createKernel();
		const { run } = await startedCell(
			kernel,
			"thread",
			[
				"globalThis.keep = 41;",
				'const { Worker } = await import("node:worker_threads");',
				"globalThis.thread = new Worker('setInterval(() => {}, 1000)', { eval: true });",
				"await new Promise((resolve) => thread.once('online', resolve));",
				"await new Promise(() => {});",
			].join(" "),
		);

		await stopAndExpectStateKept(kernel, entry, run);
		await expect(
			kernel.run({
				cellId: "after",
				code: "if (thread.threadId !== -1) await new Promise((resolve) => thread.once('exit', resolve)); return thread.threadId",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: "-1" });
	});
});
