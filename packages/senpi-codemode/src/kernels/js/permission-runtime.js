import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { MessageChannel, parentPort } from "node:worker_threads";
import { authorityDecision } from "./permission-authority.mjs";
import { createPermissionRequester } from "./permission-slots.mjs";

let initialized = false;

export async function initializePermissionRuntime(install, workerData) {
	if (initialized) throw new Error("Permission runtime already initialized");
	initialized = true;
	const context = new AsyncLocalStorage();
	const bound = new Map();
	const data = workerData.permission;
	// The bootstrap transport is host authority, not user-visible worker data.
	delete workerData.permission;
	const inactiveWord = new SharedArrayBuffer(4);
	Atomics.store(new Int32Array(inactiveWord), 0, 2);
	const kernel = data?.kernel ?? { id: "", authority: inactiveWord, rules: [] };
	const requester = data && createPermissionRequester(data.slots, {
		wake: (slot, generation) => data.port.postMessage({ type: "check", slot, generation }),
		retire: () => data.port.postMessage({ type: "retire" }),
	});
	const refusal = (reason, rule) => {
		const error = new Error(`${reason}${rule ? ` (${rule.permission}: ${rule.pattern}, ${rule.layer})` : ""}`);
		error.name = "CellPermissionDeniedError";
		error.code = "cell_permission_denied";
		error.rule = rule;
		return error;
	};
	const authorize = (operation) => {
		const token = context.getStore();
		const disposition = authorityDecision(token, token ? [] : [...bound.values()], kernel);
		if (disposition === "pass") return;
		const rule = token?.rules[0] ?? [...bound.values()].find((entry) => entry.rules.length)?.rules[0] ?? kernel.rules[0];
		if (disposition === "refuse" || !requester || !token) throw refusal("Permission authority unavailable", rule);
		try {
			const { call, unsupported } = operation();
			if (unsupported) throw refusal("Operation cannot be checked", rule);
			const result = requester.check({ token: token.id, call });
			// Revocation may have raced an already-published answer.
			if (!(Atomics.load(new Int32Array(token.authority), 0) & 2)) throw new Error("Permission authority revoked");
			if (result.action === "deny") throw refusal("Operation denied", result.rule);
		} catch (error) {
			if (error?.code === "cell_permission_denied") throw error;
			throw refusal(error instanceof Error ? error.message : "Permission check failed", rule);
		}
	};
	install(authorize);
	const runAuthority = async (token, run) => {
		if (!token && authorityDecision(undefined, [...bound.values()], kernel) !== "pass") {
			throw refusal("Permission authority unavailable", kernel.rules[0]);
		}
		if (token) bound.set(token.id, token);
		try { return await context.run(token, run); }
		finally { if (token) bound.delete(token.id); }
	};

	if (data && globalThis.Worker) {
		globalThis.Worker = class Worker extends EventTarget {
			#port;
			onmessage = null;
			onerror = null;
			onopen = null;
			onclose = null;
			onmessageerror = null;
			constructor(script, options = {}) {
				super();
				const token = context.getStore();
				if (authorityDecision(token, [...bound.values()], kernel) === "refuse") throw refusal("Permission authority unavailable", token?.rules[0] ?? kernel.rules[0]);
				const { port1, port2 } = new MessageChannel();
				this.#port = port1;
				port1.on("message", (frame) => {
					if (frame.type === "message") {
						const event = new MessageEvent("message", { data: frame.value });
						if (frame.value === undefined) Object.defineProperty(event, "data", { value: undefined });
						this.onmessage?.(event);
						this.dispatchEvent(event);
					} else if (frame.type === "error") {
						const event = new ErrorEvent("error", {
							message: frame.message, error: frame.error,
							filename: frame.filename, lineno: frame.lineno, colno: frame.colno,
						});
						this.onerror?.(event);
						this.dispatchEvent(event);
					} else if (frame.type === "messageerror") {
						const event = new MessageEvent("messageerror", { data: frame.error });
						this.onmessageerror?.(event);
						this.dispatchEvent(event);
					} else if (frame.type === "open") {
						const event = new Event("open");
						this.onopen?.(event);
						this.dispatchEvent(event);
					} else if (frame.type === "exit") {
						port1.close();
						const event = new Event("close");
						this.onclose?.(event);
						this.dispatchEvent(event);
					}
				});
				port1.on("messageerror", (error) => {
					const event = new MessageEvent("messageerror", { data: error });
					this.onmessageerror?.(event);
					this.dispatchEvent(event);
				});
				const href = new URL(String(script), pathToFileURL(`${process.cwd()}/`)).href;
				// Inactive resources belong to the kernel lifetime, not the completed run's registry entry.
				const activeToken = token && (Atomics.load(new Int32Array(token.authority), 0) & 1) ? token.id : undefined;
				data.port.postMessage({ type: "spawn", script: href, token: activeToken, port: port2, options }, [port2]);
			}
			postMessage(value, options = []) {
				const transfer = Array.isArray(options) ? options : options.transfer ?? [];
				this.#port.postMessage({ type: "message", value, transfer }, transfer);
			}
			terminate() { this.#port.postMessage({ type: "terminate" }); }
			ref() { this.#port.ref(); return this; }
			unref() { this.#port.unref(); return this; }
		};
	}

	if (workerData.script) {
		const { installSessionCwd } = await import("./worker-cwd.js");
		installSessionCwd(data.cwd, { permissionInterposed: true });
		globalThis.postMessage = (value, options = []) => {
			const transfer = Array.isArray(options) ? options : options.transfer ?? [];
			parentPort.postMessage({ key: data.messageKey, value, transfer }, transfer);
		};
		globalThis.close = () => parentPort.close();
		const events = new EventTarget();
		globalThis.addEventListener = events.addEventListener.bind(events);
		globalThis.removeEventListener = events.removeEventListener.bind(events);
		parentPort.on("message", (value) => context.run(data.token, () => {
			const event = new MessageEvent("message", { data: value });
			if (value === undefined) Object.defineProperty(event, "data", { value: undefined });
			globalThis.onmessage?.(event);
			events.dispatchEvent(event);
		}));
		await runAuthority(data.token, async () => {
			// User preloads still precede the script, but never precede interposition.
			const preloads = typeof workerData.preload === "string" ? [workerData.preload] : workerData.preload ?? [];
			const require = process.getBuiltinModule("node:module").createRequire(pathToFileURL(`${data.cwd}/__preload__.js`));
			const { isAbsolute } = process.getBuiltinModule("node:path");
			for (const preload of preloads) {
				const resolved = /^[a-z][a-z\d+.-]*:/iu.test(preload) && !isAbsolute(preload) ? preload : require.resolve(preload);
				await import(isAbsolute(resolved) ? pathToFileURL(resolved).href : resolved);
			}
			await import(workerData.script);
		});
		return;
	}
	const { createWorkerCore } = await import("./worker-core.js");
	createWorkerCore({
		send: (message) => parentPort.postMessage(message),
		onMessage(handler) { parentPort.on("message", handler); return () => parentPort.off("message", handler); },
		close() { parentPort.close(); setTimeout(() => process.exit(0), 0); },
	}, {
		cwd: workerData.cwd,
		parallelPoolWidth: workerData.parallelPoolWidth,
		cwdInstallOptions: { permissionInterposed: true },
		runAuthority,
	});
}
