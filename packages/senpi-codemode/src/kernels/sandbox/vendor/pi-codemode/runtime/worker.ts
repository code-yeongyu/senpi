// Vendored from https://github.com/earendil-works/pi (packages/codemode/src) at v1.0.1, commit a7229ddc21810d6245105978033b7df645ecc2f7.
// MIT license; see LICENSE beside this file. Local changes are listed in VENDORED.md.
/**
 * Worker thread entry. One worker runs one script inside a fresh QuickJS VM
 * (a separate wasm instance), relays tool calls and output to the host, and
 * reports the result. The host terminates the worker when the script settles,
 * times out, or is aborted; the worker exists so that a spinning script never
 * blocks the host thread.
 *
 * Importing this module starts the worker. Hosts that bundle their code (for
 * example a Bun compiled executable) add a file that imports
 * `@earendil-works/pi-codemode/worker` as a separate entrypoint and pass its URL
 * or embedded-module string specifier as `workerUrl`.
 */
import { parentPort, workerData } from "node:worker_threads";
import { JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import { isHostToWorkerMessage, type WorkerData, type WorkerToHostMessage } from "./protocol.ts";

function post(message: WorkerToHostMessage): void {
	parentPort?.postMessage(message);
}

function crash(error: unknown): void {
	post({ type: "crash", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
}

/**
 * QuickJS writes engine diagnostics to fd 1 and 2, which the default shim
 * forwards to the host's stdout and stderr. That output belongs to the host
 * application (for example a TUI), so it is discarded. Reporting every byte as
 * written keeps libc from retrying.
 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let i = 0; i < iovsLen; i++) {
				written += view.getUint32(iovsPtr + i * 8 + 4, true);
			}
			view.setUint32(nwrittenPtr, written, true);
			return 0;
		},
	};
}

function describeException(error: JSException): string {
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();
	// senpi-change begin: evalCode fails before any script runs, so an InternalError here is the engine's own
	const reason = error.name === "InternalError" && error.message === "out of memory" ? "memory" : undefined;
	return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${head}\n${stack}` : head, reason });
	// senpi-change end
}
// senpi-change begin: output streaming
/**
 * Sends one output item as frames of at most `frameBytes` UTF-16 bytes, each only after taking that many bytes
 * of credit. With no credit left the worker sleeps until the host consumes a frame or interrupts the run, so
 * neither side ever holds more than the window. Returns false when the run was interrupted while waiting.
 */
function streamItem(
	stream: { credits: Int32Array; frameBytes: number },
	interrupt: Int32Array,
	itemId: number,
	type: "text" | "image",
	payload: string,
	mimeType: string | undefined,
): boolean {
	const frameUnits = Math.max(1, Math.floor(stream.frameBytes / 2));
	let offset = 0;
	let seq = 0;
	do {
		let end = Math.min(payload.length, offset + frameUnits);
		// Never split a surrogate pair across frames.
		if (end < payload.length && end - offset > 1) {
			const last = payload.charCodeAt(end - 1);
			if (last >= 0xd800 && last <= 0xdbff) end--;
		}
		const chunk = payload.slice(offset, end);
		const bytes = Math.max(2, chunk.length * 2);
		for (;;) {
			if (Atomics.load(interrupt, 0) !== 0) return false;
			const available = Atomics.load(stream.credits, 0);
			if (available >= bytes) {
				if (Atomics.compareExchange(stream.credits, 0, available, available - bytes) === available) break;
				continue;
			}
			Atomics.wait(stream.credits, 0, available);
		}
		post({
			type: "output-frame",
			bytes,
			frame: {
				itemId,
				seq,
				final: end >= payload.length,
				type,
				chunk,
				...(mimeType === undefined ? {} : { mimeType }),
			},
		});
		offset = end;
		seq++;
	} while (offset < payload.length);
	return true;
}
// senpi-change end

async function main(data: WorkerData): Promise<void> {
	const interrupt = new Int32Array(data.interrupt);
	// senpi-change begin: output streaming
	const stream =
		data.stream === undefined
			? undefined
			: { credits: new Int32Array(data.stream.credits), frameBytes: data.stream.frameBytes };
	let nextItemId = 0;
	// senpi-change end
	const vm = await QuickJS.create({
		wasm: data.wasm,
		memoryLimit: data.memoryLimitBytes,
		// Without a guard, deep recursion overflows the wasm stack and traps instead of throwing a
		// catchable RangeError.
		maxStackSize: MAX_STACK_SIZE,
		interruptHandler: () => Atomics.load(interrupt, 0) !== 0,
		wasi: discardOutput,
	});

	// Called from the prelude with primitives only.
	const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
		switch (kind.toString()) {
			case "call":
			case "global":
				post({
					type: "call",
					id: a.toNumber(),
					target: kind.toString() === "call" ? "tool" : "global",
					name: b.toString(),
					args: c === undefined || c.isUndefined ? undefined : c.toString(),
				});
				break;
			case "output":
				// senpi-change begin: output streaming
				if (stream !== undefined) {
					const image = a.toString() === "image";
					streamItem(stream, interrupt, nextItemId++, image ? "image" : "text", b.toString(), image ? c.toString() : undefined);
					break;
				}
				// senpi-change end
				post({
					type: "output",
					item:
						a.toString() === "image"
							? { type: "image", data: b.toString(), mimeType: c.toString() }
							: { type: "text", text: b.toString() },
				});
				break;
			case "done":
				if (a.toBoolean()) {
					post({
						type: "done",
						ok: true,
						value: b === undefined || b.isUndefined ? undefined : b.toString(),
						writes: c.toString(),
					});
				} else {
					post({ type: "done", ok: false, error: b.toString() });
				}
				break;
		}
		return vm.undefined;
	});

	// The VM lives until the host terminates the worker, so these handles are never disposed.
	const api = vm.withScope((scope) =>
		scope.escape(
			vm.callFunction(
				vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
				vm.undefined,
				bridge,
				vm.newString(JSON.stringify(data.tools)),
				vm.newString(JSON.stringify(data.globals)),
				vm.newString(JSON.stringify(data.store)),
				// senpi-change begin: output streaming and builtin policy
				vm.newString(JSON.stringify({ streamOutput: stream !== undefined, store: data.storePolicy ?? "collect" })),
				// senpi-change end
			),
		),
	);
	const settle = api.getProp("settle");
	const run = api.getProp("run");
	const stalled = api.getProp("stalled");
	/** Run queued jobs, then fail a script that waits on nothing that can ever resume it. */
	const drain = () => {
		vm.executePendingJobs();
		vm.callFunction(stalled, api).dispose();
	};

	parentPort?.on("message", (message: unknown) => {
		if (!isHostToWorkerMessage(message)) return;
		try {
			vm.withScope(() => {
				vm.callFunction(
					settle,
					api,
					vm.newNumber(message.id),
					message.ok ? vm.true : vm.false,
					message.payload === undefined ? vm.undefined : vm.newString(message.payload),
				);
			});
			drain();
		} catch (error) {
			crash(error);
		}
	});

	// The prefix shares the first line with the script so reported line numbers
	// match the script as written.
	let fn: JSValueHandle;
	try {
		fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
	} catch (error) {
		if (!(error instanceof JSException)) throw error;
		post({ type: "done", ok: false, error: describeException(error) });
		return;
	}
	vm.callFunction(run, api, fn).dispose();
	fn.dispose();
	drain();
}

if (parentPort) {
	main(workerData as WorkerData).catch(crash);
}
