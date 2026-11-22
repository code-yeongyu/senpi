import { describe, expect, it } from "vitest";
import {
	createKernel,
	expectLoopStopped,
	registerStopHarnessCleanup,
	startedCell,
	stopAndExpectStateKept,
} from "./eval/js-stop-harness.ts";

registerStopHarnessCleanup();

const TIMERS = 'const t = await import("node:timers");';
const FS = 'const fs = await import("node:fs");';

// Each row: a loop whose every iteration waits on one kind of host work. After Stop the cell is released, so the loop
// must stop ticking while the kernel keeps its variables on the same worker.
describe("JavaScriptKernel stop ends a stopped cell's loop", () => {
	it.each([
		["global setTimeout", "", "await new Promise((resolve) => setTimeout(resolve, 10))"],
		[
			"global setInterval",
			"",
			"await new Promise((resolve) => { const id = setInterval(() => { clearInterval(id); resolve(); }, 10); })",
		],
		["node:timers setTimeout", TIMERS, "await new Promise((resolve) => t.setTimeout(resolve, 10))"],
		["node:timers setImmediate", TIMERS, "await new Promise((resolve) => t.setImmediate(resolve))"],
		[
			"node:timers setInterval",
			TIMERS,
			"await new Promise((resolve) => { const id = t.setInterval(() => { t.clearInterval(id); resolve(); }, 10); })",
		],
		["node:timers/promises", "", 'await (await import("node:timers/promises")).setTimeout(10)'],
		...(process.versions.bun === undefined ? [] : [["Bun.sleep", "", "await Bun.sleep(10)"]]),
		[
			"a short fs/promises read",
			"",
			'await (await import("node:fs/promises")).readFile(process.execPath, { length: 16 }).catch(() => {})',
		],
		["an fs callback read", FS, 'await new Promise((resolve) => fs.readFile("package.json", () => resolve()))'],
		[
			"an fs read stream",
			FS,
			'await new Promise((resolve) => fs.createReadStream("package.json").on("end", resolve).resume())',
		],
		[
			"readline over a file stream",
			`${FS} const rl = await import("node:readline");`,
			'await new Promise((resolve) => rl.createInterface({ input: fs.createReadStream("package.json") }).on("close", resolve))',
		],
		[
			"a MessageChannel round trip",
			"",
			"await new Promise((resolve) => { const { port1, port2 } = new MessageChannel(); port2.onmessage = () => { port1.close(); port2.close(); resolve(); }; port1.postMessage(1); })",
		],
	])(
		"Given a polling loop on %s when stopped then it stops ticking and earlier globals survive",
		async (_name, setup, wait) => {
			const { kernel, entry } = await createKernel();
			const ticked = Promise.withResolvers<void>();
			const { run } = await startedCell(
				kernel,
				"poll",
				`${setup} globalThis.keep = 41; globalThis.ticks = 0; for (;;) { ${wait}; ticks += 1; if (ticks === 3) print("TICKED"); }`,
				(text) => {
					if (text.includes("TICKED")) ticked.resolve();
				},
			);
			await ticked.promise;

			await stopAndExpectStateKept(kernel, entry, run);
			await expectLoopStopped(kernel);
		},
	);

	it("Given a socket the cell constructed directly when stopped then it is destroyed, and sockets Node creates still pass instanceof", async () => {
		const { kernel, entry } = await createKernel();
		const { run } = await startedCell(
			kernel,
			"socket-class",
			[
				"globalThis.keep = 41;",
				'const net = await import("node:net");',
				"globalThis.srv = net.createServer(() => {}); await new Promise((r) => srv.listen(0, '127.0.0.1', r));",
				"globalThis.made = net.createConnection(srv.address().port, '127.0.0.1');",
				"globalThis.madeIsSocket = made instanceof net.Socket;",
				"globalThis.sock = new net.Socket(); sock.connect(srv.address().port, '127.0.0.1'); await new Promise((r) => sock.once('connect', r));",
				"await new Promise(() => {});",
			].join(" "),
		);

		await stopAndExpectStateKept(kernel, entry, run);
		await expect(
			kernel.run({
				cellId: "after",
				code: "await new Promise((r) => setTimeout(r, 100)); return [madeIsSocket, sock.destroyed, made.destroyed]",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: "[true,true,true]" });
	});

	it("Given an http server the cell started when stopped then it served while live and is closed after, and Node's own constructors still work", async () => {
		const { kernel, entry } = await createKernel();
		const served = Promise.withResolvers<void>();
		const { run } = await startedCell(
			kernel,
			"http-server",
			[
				"globalThis.keep = 41;",
				'const http = await import("node:http");',
				"globalThis.server = http.createServer((_req, res) => res.end('served'));",
				"await new Promise((r) => server.listen(0, '127.0.0.1', r));",
				"const { port } = server.address();",
				"globalThis.answer = await (await fetch('http://127.0.0.1:' + port + '/')).text();",
				"globalThis.subclassed = (() => { class Mine extends http.Server {} return new Mine() instanceof http.Server; })();",
				'print("SERVED");',
				"await new Promise(() => {});",
			].join(" "),
			(text) => {
				if (text.includes("SERVED")) served.resolve();
			},
		);
		await served.promise;

		await stopAndExpectStateKept(kernel, entry, run);
		await expect(
			kernel.run({
				cellId: "after",
				code: "await new Promise((r) => setTimeout(r, 100)); return [answer, subclassed, server.listening]",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: '["served",true,false]' });
	});

	it("Given a resource that will not close when its cell is stopped then the failure is reported and the stop still keeps the state", async () => {
		const { kernel, entry } = await createKernel();
		const texts: string[] = [];
		const { run } = await startedCell(
			kernel,
			"stubborn",
			"globalThis.keep = 41; const { port1 } = new MessageChannel(); port1.close = () => { throw new Error('will not close'); }; await new Promise(() => {});",
			(text) => texts.push(text),
		);

		const next = await stopAndExpectStateKept(kernel, entry, run);
		expect(`${texts.join("")}${next}`).toContain(
			"Stopping cell stubborn: a resource it opened would not close: Error: will not close",
		);
	});
});
