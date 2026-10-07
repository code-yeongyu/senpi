import { afterEach, describe, expect, it } from "vitest";
import { type BridgeHttpCallRequest, startBridgeServer } from "../src/bridge/http-server.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { RESERVED_WAIT_TOOL } from "../src/bridge/reserved.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import type { KernelToolDescriptor, KernelToolsInvokeRequest } from "../src/kernels/js/kernel-tools-types.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import type { KernelToolReplyEvent } from "../src/kernels/py/kernel-tools-host.ts";
import { hasPython3 } from "./py-kernel/fixtures.ts";

type Gate = { readonly opened: Promise<void>; open(): void };

function gate(): Gate {
	let open = (): void => undefined;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms).unref()),
	]);
}

type Bridge = {
	readonly kernel: PythonKernel;
	readonly calls: BridgeHttpCallRequest[];
	readonly messages: KernelToHostMessage[];
	readonly events: string[];
	readonly frames: EventTarget;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function bridge(
	onCall: (request: BridgeHttpCallRequest, events: string[]) => Promise<unknown> | unknown,
): Promise<Bridge> {
	const detected = await createInterpreterDetector().detect("py");
	if (!detected.ok) throw new Error("python unavailable");
	const calls: BridgeHttpCallRequest[] = [];
	const messages: KernelToHostMessage[] = [];
	const events: string[] = [];
	const frames = new EventTarget();
	const server = await startBridgeServer({
		onCall: async (request) => {
			calls.push(request);
			return await onCall(request, events);
		},
		onEmit: async () => {},
		onCompletion: async () => "",
	});
	const kernel = await PythonKernel.start({
		interpreterPath: detected.path,
		sessionId: `py-kernel-tools-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		connection: { port: server.port, token: server.token },
		onMessage: (message) => {
			messages.push(message);
			frames.dispatchEvent(new CustomEvent("frame", { detail: message }));
		},
	});
	cleanups.push(async () => {
		await kernel.close();
		await server.close();
	});
	return { kernel, calls, messages, events, frames };
}

/** Resolves on the next `log(text)` frame; subscribe before triggering what logs it. */
function nextLog(frames: EventTarget, text: string): Promise<void> {
	return new Promise((resolve) => {
		const listener = (event: Event) => {
			const message = (event as CustomEvent<KernelToHostMessage>).detail;
			if (message.type === "log" && message.message === text) {
				frames.removeEventListener("frame", listener);
				resolve();
			}
		};
		frames.addEventListener("frame", listener);
	});
}

async function cell(kernel: PythonKernel, code: string, cellId = `cell-${crypto.randomUUID()}`) {
	return await kernel.run({ cellId, code, timeoutMs: 60_000 });
}

async function descriptor(kernel: PythonKernel, name: string): Promise<KernelToolDescriptor> {
	const described = await kernel.describeKernelTools([name]);
	const entry = described.results[0];
	if (!entry?.ok) throw new Error(`${name} was not described: ${JSON.stringify(entry)}`);
	return entry.descriptor;
}

function invokeRequest(found: KernelToolDescriptor, args: unknown): KernelToolsInvokeRequest {
	return {
		name: found.name,
		kernel_generation: found.kernel_generation,
		definition_revision: found.definition_revision,
		args,
		call_id: `call-${crypto.randomUUID()}`,
	};
}

function replies(kernel: PythonKernel): KernelToolReplyEvent[] {
	const seen: KernelToolReplyEvent[] = [];
	kernel.kernelToolEvents.addEventListener("kernelToolReply", (event) => {
		seen.push((event as CustomEvent<KernelToolReplyEvent>).detail);
	});
	return seen;
}

function stdout(messages: readonly KernelToHostMessage[]): string {
	return messages.flatMap((m) => (m.type === "text" && m.stream === "stdout" ? [m.data] : [])).join("");
}

describe.skipIf(!(await hasPython3()))("Python kernel tools (@tool)", () => {
	it("Given @tool def add(a: int, b: int = 1) -> int, describe returns the inferred schema and invoking {a: 2} returns 3", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));
		await cell(kernel, '@tool\ndef add(a: int, b: int = 1) -> int:\n    """Adds two numbers."""\n    return a + b');

		const found = await descriptor(kernel, "add");
		const value = await kernel.invokeKernelTool(invokeRequest(found, { a: 2 }));

		expect(found).toMatchObject({
			language: "py",
			description: "Adds two numbers.",
			input_schema: {
				type: "object",
				properties: { a: { type: "integer" }, b: { type: "integer", default: 1 } },
				required: ["a"],
				additionalProperties: false,
			},
		});
		expect(value).toBe(3);
	}, 60_000);

	it("with `from __future__ import annotations`, string annotations resolve through the function's globals", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));
		const result = await cell(
			kernel,
			"from __future__ import annotations\nfrom typing import Literal, Optional\n@tool\ndef pick(mode: Literal['a', 'b'], limit: Optional[int] = None) -> str:\n    return mode",
		);

		const found = await descriptor(kernel, "pick");

		expect(result.ok).toBe(true);
		expect(found.input_schema).toMatchObject({
			properties: {
				mode: { enum: ["a", "b"] },
				limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
			},
			required: ["mode"],
		});
	}, 60_000);

	it("an annotation that can't be resolved is refused with invalid_tool_definition naming it, and nothing registers", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));

		const result = await cell(
			kernel,
			"from __future__ import annotations\n@tool\ndef f(a: Missing) -> int:\n    return 1",
		);
		const listed = await cell(kernel, "tool.defined()");

		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.message).toMatch(/invalid_tool_definition: can't resolve the annotation 'Missing'/);
		expect(listed.ok && listed.valueRepr).toBe("[]");
	}, 60_000);

	it("positional-only parameters are refused with invalid_tool_definition and nothing registers", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));

		const result = await cell(kernel, "@tool\ndef f(a, /):\n    return a");
		const listed = await cell(kernel, "tool.defined()");

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("positional-only parameters are not supported");
		expect(listed.ok && listed.valueRepr).toBe("[]");
	}, 60_000);

	it.each(["defined", "undefine"])(
		"registering a kernel tool named %s is refused with reserved_tool_name",
		async (name) => {
			const { kernel } = await bridge(() => ({ text: "" }));

			const result = await cell(kernel, `@tool(name="${name}")\ndef f() -> int:\n    return 1`);

			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.error.message).toContain(`reserved_tool_name: Kernel tool name is reserved: ${name}`);
		},
		60_000,
	);

	it("tool.defined() lists names sorted and tool.undefine() removes one; describe then reports it missing", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));
		await cell(
			kernel,
			"@tool\ndef mid() -> int:\n    return 0\n@tool\ndef zeta() -> int:\n    return 1\n@tool\ndef alpha() -> int:\n    return 2",
		);

		const before = await cell(kernel, "tool.defined()");
		const removed = await cell(kernel, "[tool.undefine('zeta'), tool.undefine('zeta'), tool.undefine(42)]");
		const after = await cell(kernel, "tool.defined()");
		const described = await kernel.describeKernelTools(["zeta"]);

		expect(before.ok && before.valueRepr).toBe("['alpha', 'mid', 'zeta']");
		expect(removed.ok && removed.valueRepr).toBe("[True, False, False]");
		expect(after.ok && after.valueRepr).toBe("['alpha', 'mid']");
		expect(kernel.listKernelToolNames()).toEqual(["alpha", "mid"]);
		expect(described.results[0]).toMatchObject({ ok: false, error: { code: "kernel_tool_missing" } });
	}, 60_000);

	it("python-tool-callback-during-parent-wait: the parent parked in wait() serves a callback that does a scoped host read; both finish and the FIFO doesn't move", async () => {
		const release = gate();
		const parked = gate();
		const { kernel, calls } = await bridge(async (request, events) => {
			if (request.toolName === RESERVED_WAIT_TOOL) {
				events.push("parent parked");
				parked.open();
				await release.opened;
				events.push("parent released");
				return { settled: [] };
			}
			events.push(`host ${request.toolName}`);
			return { text: "file body" };
		});
		await cell(kernel, "@tool\ndef reader(path: str) -> str:\n    return tool.read(path=path)['text']");
		const found = await descriptor(kernel, "reader");

		const parent = cell(kernel, "wait([{'kind': 'agent', 'id': 'st_x', 'run_epoch': 1}], timeout=30)\n'parent done'");
		const queued = cell(kernel, "'queued done'");
		await within(parked.opened, 20_000, "parent parks in wait()");
		const value = await within(
			kernel.invokeKernelTool(invokeRequest(found, { path: "a.txt" }), { scope: { tools: { allow: ["read"] } } }),
			20_000,
			"callback while the parent is parked",
		);
		release.open();
		const [parentResult, queuedResult] = await within(Promise.all([parent, queued]), 20_000, "cells finish");

		expect(value).toBe("file body");
		expect(calls.map((call) => call.toolName)).toEqual([RESERVED_WAIT_TOOL, "read"]);
		expect(parentResult.ok && parentResult.valueRepr).toBe("'parent done'");
		expect(queuedResult.ok && queuedResult.valueRepr).toBe("'queued done'");
	}, 90_000);

	it("a callback's host call outside its scope is refused with kernel_tool_host_denied and never reaches the host", async () => {
		const { kernel, calls } = await bridge(() => ({ text: "body" }));
		await cell(kernel, "@tool\ndef writer() -> str:\n    return tool.write(path='x', content='y')['text']");
		const found = await descriptor(kernel, "writer");

		const refused = kernel.invokeKernelTool(invokeRequest(found, {}), { scope: { tools: { allow: ["read"] } } });

		await expect(refused).rejects.toMatchObject({ code: "kernel_tool_host_denied" });
		expect(calls).toEqual([]);
	}, 60_000);

	it("a cell busy in pure computation is not interrupted: a callback that arrives mid-loop runs only after the cell ends", async () => {
		const { kernel, frames } = await bridge(() => ({ text: "" }));
		await cell(
			kernel,
			"import threading, time\nruns = []\n@tool\ndef mark() -> str:\n    runs.append('callback')\n    return 'marked'",
		);
		const found = await descriptor(kernel, "mark");
		const started = nextLog(frames, "busy-started");

		// The cell spins in pure Python until the callback's thread exists, which proves it arrived mid-loop.
		const busy = cell(
			kernel,
			"log('busy-started')\nseen = False\ndeadline = time.monotonic() + 20\nwhile time.monotonic() < deadline:\n    if any(t.name == 'senpi-kernel-tool' for t in threading.enumerate()):\n        seen = True\n        break\n(seen, list(runs))",
		);
		await within(started, 20_000, "the busy cell starts");
		const callback = kernel.invokeKernelTool(invokeRequest(found, {}));
		const [busyResult, value] = await within(Promise.all([busy, callback]), 30_000, "both settle");
		const after = await cell(kernel, "list(runs)");

		expect(busyResult.ok && busyResult.valueRepr).toBe("(True, [])");
		expect(value).toBe("marked");
		expect(after.ok && after.valueRepr).toBe("['callback']");
	}, 60_000);

	it("nested host calls: the parent's host call, a callback's own host call and a second callback finish without deadlock, in park order", async () => {
		const releaseParent = gate();
		const parentParked = gate();
		const order: string[] = [];
		const { kernel } = await bridge(async (request) => {
			const args = request.args as { path?: string };
			if (args.path === "parent") {
				parentParked.open();
				await releaseParent.opened;
				order.push("parent read returned");
				return { text: "parent" };
			}
			order.push(`host read ${args.path}`);
			return { text: `read ${args.path}` };
		});
		await cell(kernel, "@tool\ndef nested(path: str) -> str:\n    return tool.read(path=path)['text']");
		const found = await descriptor(kernel, "nested");

		const parent = cell(kernel, "tool.read(path='parent')['text']");
		await within(parentParked.opened, 20_000, "parent parks in its host call");
		const first = kernel.invokeKernelTool(invokeRequest(found, { path: "one" }));
		const second = kernel.invokeKernelTool(invokeRequest(found, { path: "two" }));
		const [one, two] = await within(
			Promise.all([first, second]),
			20_000,
			"both callbacks while the parent is parked",
		);
		releaseParent.open();
		const parentResult = await within(parent, 20_000, "parent resumes");

		expect([one, two]).toEqual(["read one", "read two"]);
		expect(order.slice(-1)).toEqual(["parent read returned"]);
		expect(order.filter((entry) => entry.startsWith("host read")).sort()).toEqual(["host read one", "host read two"]);
		expect(parentResult.ok && parentResult.valueRepr).toBe("'parent'");
	}, 90_000);

	it("cancellation during a callback parked in a host call: the reply says so explicitly, the callback settles once, and a queued cell runs once", async () => {
		const releaseHost = gate();
		const hostCalled = gate();
		const { kernel, calls } = await bridge(async (request) => {
			if ((request.args as { path?: string }).path === "slow") {
				hostCalled.open();
				await releaseHost.opened;
			}
			return { text: "late" };
		});
		const seen = replies(kernel);
		await cell(
			kernel,
			"runs = []\n@tool\ndef slow() -> str:\n    runs.append(1)\n    return tool.read(path='slow')['text']",
		);
		const found = await descriptor(kernel, "slow");
		const controller = new AbortController();

		const invoked = kernel.invokeKernelTool(invokeRequest(found, {}), { signal: controller.signal });
		await within(hostCalled.opened, 20_000, "callback parks in its host call");
		const queued = cell(kernel, "len(runs)");
		controller.abort();
		await expect(invoked).rejects.toMatchObject({ code: "kernel_tool_stale" });
		// The cancel frame and the host call's reply travel on different channels (stdin vs the bridge socket).
		// The kernel serves control frames in order, so a describe answered after the cancel proves the
		// cancel reached the kernel before the parked host call is allowed to return.
		await within(descriptor(kernel, "slow"), 20_000, "the kernel to read the cancel");
		releaseHost.open();
		const queuedResult = await within(queued, 20_000, "queued cell");
		await within(
			new Promise<void>((resolve) => {
				const timer = setInterval(() => {
					if (seen.length > 0) {
						clearInterval(timer);
						resolve();
					}
				}, 5);
			}),
			20_000,
			"the cancelled call's reply",
		);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			ok: false,
			code: "kernel_tool_cancelled",
			message: "cancelled: took effect at a host park point",
		});
		expect(queuedResult.ok && queuedResult.valueRepr).toBe("1");
		expect(calls.filter((call) => (call.args as { path?: string }).path === "slow")).toHaveLength(1);
	}, 90_000);

	it("a sync callback cancelled mid-computation finishes, and its late result is dropped with an explicit reply", async () => {
		const { kernel, frames } = await bridge(() => ({ text: "" }));
		// spin computes until a second kernel-tool call has arrived; frames are read in order, so by then
		// the cancel sent before that call has been applied.
		await cell(
			kernel,
			"import threading\n@tool\ndef spin() -> str:\n    log('computing')\n    while sum(t.name == 'senpi-kernel-tool' for t in threading.enumerate()) < 2:\n        pass\n    return 'finished'\n@tool\ndef after() -> int:\n    return 0",
		);
		const spin = await descriptor(kernel, "spin");
		const after = await descriptor(kernel, "after");
		const controller = new AbortController();
		const computing = nextLog(frames, "computing");
		const reply = new Promise<KernelToolReplyEvent>((resolve) => {
			const listener = (event: Event) => {
				const detail = (event as CustomEvent<KernelToolReplyEvent>).detail;
				if (detail.ok === false) {
					kernel.kernelToolEvents.removeEventListener("kernelToolReply", listener);
					resolve(detail);
				}
			};
			kernel.kernelToolEvents.addEventListener("kernelToolReply", listener);
		});

		const invoked = kernel.invokeKernelTool(invokeRequest(spin, {}), { signal: controller.signal });
		await within(computing, 20_000, "the callback is computing");
		controller.abort();
		const second = kernel.invokeKernelTool(invokeRequest(after, {}));
		await expect(invoked).rejects.toMatchObject({ code: "kernel_tool_stale" });

		expect(await within(reply, 20_000, "the cancelled call's reply")).toMatchObject({
			ok: false,
			code: "kernel_tool_cancelled",
			message: "cancelled: the call finished after cancellation; its result was dropped",
		});
		expect(await within(second, 20_000, "the call after it")).toBe(0);
	}, 60_000);

	it("kernel-tool-reset-revokes-child-grant: a descriptor taken before a reset is kernel_tool_stale after it, the new definition never satisfies it, and queued cells run once", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));
		await cell(kernel, "@tool\ndef add(a: int, b: int = 1) -> int:\n    return a + b");
		const old = await descriptor(kernel, "add");

		await kernel.reset();
		await cell(kernel, "count = 0\n@tool\ndef add(a: int, b: int = 1) -> int:\n    return a + b + 100");
		const queued = await Promise.all([cell(kernel, "count += 1"), cell(kernel, "count += 1"), cell(kernel, "count")]);
		const fresh = await descriptor(kernel, "add");

		await expect(kernel.invokeKernelTool(invokeRequest(old, { a: 1 }))).rejects.toMatchObject({
			code: "kernel_tool_stale",
		});
		expect(fresh.kernel_generation).toBeGreaterThan(old.kernel_generation);
		expect(await kernel.invokeKernelTool(invokeRequest(fresh, { a: 1 }))).toBe(102);
		expect(queued[2]?.ok && queued[2].valueRepr).toBe("2");
	}, 90_000);

	it("a reset while a callback is mid-flight ends it as kernel_tool_stale and leaves no thread or token behind", async () => {
		const hostCalled = gate();
		const { kernel } = await bridge(async (request) => {
			if ((request.args as { path?: string }).path === "hang") {
				hostCalled.open();
				await new Promise(() => undefined);
			}
			return { text: "" };
		});
		await cell(kernel, "@tool\ndef hang() -> str:\n    return tool.read(path='hang')['text']");
		const found = await descriptor(kernel, "hang");

		const invoked = kernel.invokeKernelTool(invokeRequest(found, {}));
		await within(hostCalled.opened, 20_000, "callback parks");
		const reset = kernel.reset();
		await expect(within(invoked, 20_000, "in-flight callback ends")).rejects.toMatchObject({
			code: "kernel_tool_stale",
		});
		await within(reset, 30_000, "reset completes");
		const after = await within(
			cell(
				kernel,
				"import threading\nsorted(t.name for t in threading.enumerate() if t.name.startswith('senpi-kernel-tool'))",
			),
			20_000,
			"a cell after the reset",
		);

		expect(after.ok && after.valueRepr).toBe("[]");
		expect(kernel.listKernelToolNames()).toEqual([]);
	}, 90_000);

	it("an awaited future from the parent cell's loop fails fast with kernel_tool_loop_mismatch", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));
		await cell(
			kernel,
			"import asyncio\nparent_future = asyncio.get_event_loop().create_future()\n@tool\nasync def borrow() -> str:\n    return await parent_future",
		);
		const found = await descriptor(kernel, "borrow");

		await expect(
			within(kernel.invokeKernelTool(invokeRequest(found, {})), 20_000, "loop mismatch"),
		).rejects.toMatchObject({
			code: "kernel_tool_loop_mismatch",
		});
	}, 60_000);

	it("a tool's printed text goes to its own reply, never into the parent cell's output", async () => {
		const { kernel, messages } = await bridge(() => ({ text: "" }));
		const seen = replies(kernel);
		await cell(kernel, "@tool\ndef chatty() -> int:\n    print('from the tool')\n    return 1");
		const found = await descriptor(kernel, "chatty");
		const before = stdout(messages);

		const value = await kernel.invokeKernelTool(invokeRequest(found, {}));

		expect(value).toBe(1);
		expect(seen[0]).toMatchObject({ ok: true, output: "from the tool\n" });
		expect(stdout(messages).slice(before.length)).not.toContain("from the tool");
	}, 60_000);
});

describe.skipIf(!(await hasPython3()))("Python kernel tools inside parallel() and pipeline()", () => {
	it("a callback whose parallel() worker is parked in a host call lets a second callback run", async () => {
		const releaseHold = gate();
		const held = gate();
		const { kernel } = await bridge(async (request) => {
			if ((request.args as { path?: string }).path === "hold") {
				held.open();
				await releaseHold.opened;
			}
			return { text: "done" };
		});
		await cell(
			kernel,
			"@tool\ndef nested() -> list:\n    return parallel([lambda: tool.read(path='hold')['text']])\n@tool\ndef eight() -> int:\n    return 8",
		);
		const nested = kernel.invokeKernelTool(invokeRequest(await descriptor(kernel, "nested"), {}));
		await within(held.opened, 20_000, "the worker parks in its host call");

		const second = await within(
			kernel.invokeKernelTool(invokeRequest(await descriptor(kernel, "eight"), {})),
			2_500,
			"a second callback while the first callback's worker is parked",
		);
		releaseHold.open();

		expect(second).toBe(8);
		expect(await within(nested, 20_000, "the first callback after its worker's host call returns")).toEqual(["done"]);
	}, 60_000);

	it("a parallel() worker's host call is held to the calling tool's scope", async () => {
		const { kernel, calls } = await bridge(() => ({ text: "side effect" }));
		await cell(
			kernel,
			"@tool\ndef scoped() -> list:\n    return parallel([lambda: tool.write(path='x', content='y')])",
		);

		const refused = kernel.invokeKernelTool(invokeRequest(await descriptor(kernel, "scoped"), {}), {
			scope: { tools: { allow: ["read"] } },
		});

		await expect(refused).rejects.toMatchObject({ code: "kernel_tool_host_denied" });
		expect(calls).toEqual([]);
	}, 60_000);

	it("text a pipeline() worker prints goes to its tool's reply, not to a parked cell", async () => {
		const releaseParent = gate();
		const parentParked = gate();
		const { kernel, messages } = await bridge(async (request) => {
			if ((request.args as { path?: string }).path === "parent") {
				parentParked.open();
				await releaseParent.opened;
			}
			return { text: "" };
		});
		const seen = replies(kernel);
		await cell(
			kernel,
			"@tool\ndef chatty() -> int:\n    pipeline([1], lambda x: print('from a worker'))\n    return 1",
		);
		const found = await descriptor(kernel, "chatty");
		const parent = cell(kernel, "print('parent text')\ntool.read(path='parent')\nNone");
		await within(parentParked.opened, 20_000, "the parent cell parks");

		const value = await kernel.invokeKernelTool(invokeRequest(found, {}));
		releaseParent.open();
		await within(parent, 20_000, "the parent cell resumes");

		expect(value).toBe(1);
		expect(seen[0]).toMatchObject({ ok: true, output: "from a worker\n" });
		expect(stdout(messages)).toContain("parent text");
		expect(stdout(messages)).not.toContain("from a worker");
	}, 60_000);
});

describe.skipIf(!(await hasPython3()))("Python kernel tool descriptors after the definition changes", () => {
	it("a descriptor taken before the interpreter crashed is kernel_tool_stale on the restarted kernel, even for a same-named tool", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));
		await cell(kernel, "@tool\ndef chosen() -> str:\n    return 'old'");
		const before = await descriptor(kernel, "chosen");
		await cell(kernel, "import os\nos._exit(9)");
		await cell(kernel, "@tool\ndef chosen() -> str:\n    return 'new'");

		const stale = kernel.invokeKernelTool(invokeRequest(before, {}));

		await expect(stale).rejects.toMatchObject({ code: "kernel_tool_stale" });
		expect((await descriptor(kernel, "chosen")).kernel_generation).not.toBe(before.kernel_generation);
	}, 60_000);

	it("a descriptor taken before undefine is kernel_tool_stale after the name is defined again", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));
		await cell(kernel, "@tool\ndef chosen() -> str:\n    return 'old'");
		const before = await descriptor(kernel, "chosen");
		await cell(kernel, "tool.undefine('chosen')\n@tool\ndef chosen() -> str:\n    return 'new'");

		const stale = kernel.invokeKernelTool(invokeRequest(before, {}));

		await expect(stale).rejects.toMatchObject({ code: "kernel_tool_stale" });
		expect(await kernel.invokeKernelTool(invokeRequest(await descriptor(kernel, "chosen"), {}))).toBe("new");
	}, 60_000);

	it("a return annotation naming a class defined later in the cell does not stop the tool from registering", async () => {
		const { kernel } = await bridge(() => ({ text: "" }));
		const result = await cell(
			kernel,
			"@tool\ndef later() -> 'Later':\n    return Later().value\n@tool\ndef bare() -> Later:\n    return Later().value\nclass Later:\n    value = 7",
		);

		expect(result.ok).toBe(true);
		expect(await kernel.invokeKernelTool(invokeRequest(await descriptor(kernel, "later"), {}))).toBe(7);
		expect(await kernel.invokeKernelTool(invokeRequest(await descriptor(kernel, "bare"), {}))).toBe(7);
	}, 60_000);

	it("a cell compiles a bare forward annotation on the interpreter in use, whatever its version", async () => {
		const { kernel, messages } = await bridge(() => ({ text: "" }));
		const result = await cell(
			kernel,
			"import sys\ndef bare() -> NotYetDefined:\n    return 1\nprint(f'{sys.version_info[0]}.{sys.version_info[1]}', bare(), bare.__annotations__['return'])",
		);

		expect(result.ok).toBe(true);
		const [version = "", value, annotation] = stdout(messages).trim().split(" ");
		expect(Number(version.split(".")[1])).toBeGreaterThanOrEqual(10);
		expect(value).toBe("1");
		// Cells inherit the prelude's deferred annotations, so the annotation stays the unevaluated name.
		expect(annotation).toBe("NotYetDefined");
		process.stdout.write(`py kernel compiled a bare forward annotation on Python ${version}\n`);
	}, 60_000);
});
