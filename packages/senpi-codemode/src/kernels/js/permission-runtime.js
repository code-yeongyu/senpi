import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { MessageChannel, parentPort } from "node:worker_threads";
import { authorityDecision } from "./permission-authority.mjs";
import { createPermissionRequester } from "./permission-slots.mjs";
import { createCodePermissionGuard } from "./interpose-code.js";

let initialized = false;

export async function initializePermissionRuntime(install, workerData, engine) {
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
		deadlineMs: data.deadlineMs,
	});
	const refusal = (reason, rule) => {
		const error = new Error(`${reason}${rule ? ` (${rule.permission}: ${rule.pattern}, ${rule.layer})` : ""}`);
		error.name = "CellPermissionDeniedError";
		error.code = "cell_permission_denied";
		error.rule = rule;
		return error;
	};
	// Resolution hooks and module top-level bodies run outside the importing cell's async context. A
	// token that is importing opens a LOADING WINDOW; an out-of-context operation is attributed to that
	// token only while it is the sole loader, bound, active and alive, and no other bound token is active
	// (design 6.4 / N4). Any other shape keeps today's refusal: never a pass that was a refusal before.
	const loading = new Map();
	const activeBit = (entry) => Atomics.load(new Int32Array(entry.authority), 0) & 1;
	const aliveBit = (entry) => Atomics.load(new Int32Array(entry.authority), 0) & 2;
	const load = async (thunk) => {
		const token = context.getStore();
		if (!token) return thunk();
		const entry = loading.get(token.id);
		if (entry) entry.depth += 1;
		else loading.set(token.id, { token, depth: 1 });
		try {
			return await thunk();
		} finally {
			const current = loading.get(token.id);
			if (current && (current.depth -= 1) === 0) loading.delete(token.id);
		}
	};
	Object.defineProperty(load, "pending", { value: () => loading.size });
	Object.defineProperty(globalThis, Symbol.for("senpi.kernel.permissionLoad"), { value: load });
	const soleLoader = () => {
		if (loading.size !== 1) return undefined;
		const [{ token }] = loading.values();
		if (!bound.has(token.id) || !activeBit(token) || !aliveBit(token)) return undefined;
		for (const other of bound.values()) if (other.id !== token.id && activeBit(other)) return undefined;
		return token;
	};
	const authorize = (operation) => {
		const token = context.getStore() ?? soleLoader();
		const disposition = authorityDecision(token, token ? [] : [...bound.values()], kernel);
		if (disposition === "pass") return;
		const rule = token?.rules[0] ?? [...bound.values()].find((entry) => entry.rules.length)?.rules[0] ?? kernel.rules[0];
		if (disposition === "refuse" || !requester || !token) throw refusal("Permission authority unavailable", rule);
		try {
			const { call, unsupported, granted } = operation();
			if (unsupported) throw refusal("Operation cannot be checked", rule);
			if (granted) return;
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
	const codeGuard = createCodePermissionGuard(authorize);
	const runAuthority = async (token, run, source) => {
		if (!token && authorityDecision(undefined, [...bound.values()], kernel) !== "pass") {
			throw refusal("Permission authority unavailable", kernel.rules[0]);
		}
		if (token) bound.set(token.id, token);
		try { return await context.run(token, () => { codeGuard.scan(source); return run(); }); }
		finally { if (token) bound.delete(token.id); }
	};

	// Only a configured kernel replaces the constructor; the entry already put a forwarder on the module
	// before its ESM namespace existed, and this class is what it constructs.
	if (data && globalThis.Worker) {
		engine.installGuardedWorker(class Worker extends EventTarget {
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
		});
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
		engine.activate();
		await runAuthority(data.token, async () => {
			// User preloads still precede the script, but never precede interposition.
			const preloads = typeof workerData.preload === "string" ? [workerData.preload] : workerData.preload ?? [];
			const require = process.getBuiltinModule("node:module").createRequire(pathToFileURL(`${data.cwd}/__preload__.js`));
			const { isAbsolute } = process.getBuiltinModule("node:path");
			for (const preload of preloads) {
				const resolved = /^[a-z][a-z\d+.-]*:/iu.test(preload) && !isAbsolute(preload) ? preload : require.resolve(preload);
				await load(() => import(isAbsolute(resolved) ? pathToFileURL(resolved).href : resolved));
			}
			await load(() => import(workerData.script));
		});
		return;
	}
	const { createWorkerCore } = await import("./worker-core.js");
	const { initializeResolverIO } = await import("./worker-package-resolve.js");
	initializeResolverIO(engine.resolverIO);
	const { initializeProcessCleanup } = await import("./process-tree.js");
	const { initializeWindowsCleanup } = await import("./windows-tree-kill.js");
	initializeProcessCleanup(engine.cleanupExecFile);
	initializeWindowsCleanup(engine.cleanupExecFile);
	createWorkerCore({
		send: (message) => parentPort.postMessage(message),
		onMessage(handler) { parentPort.on("message", handler); return () => parentPort.off("message", handler); },
		close() { parentPort.close(); setTimeout(() => process.exit(0), 0); },
	}, {
		cwd: workerData.cwd,
		parallelPoolWidth: workerData.parallelPoolWidth,
		cwdInstallOptions: { permissionInterposed: true },
		runAuthority,
		permissionIO: engine.permissionIO,
	});
}
