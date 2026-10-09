import childProcess from "node:child_process";
import type { EventEmitter } from "node:events";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import workerThreads from "node:worker_threads";
import { Type } from "typebox";
import { GateInputError } from "./gate-input-error.ts";
import { observeTimers } from "./gate-timers.ts";

export const cleanupSchema = Type.Object({
	processes: Type.Number(), workers: Type.Number(), sockets: Type.Number(),
	handles: Type.Number(), timers: Type.Number(), subscriptions: Type.Number(), listeners: Type.Number(),
});
type ResourceKind = "processes" | "workers" | "sockets" | "handles";
type OwnedResource = {
	readonly kind: ResourceKind;
	readonly emitter: EventEmitter;
	readonly close: Promise<void>;
	readonly restore: () => void;
	closing: boolean;
	closed: boolean;
};

/**
 * Instrument the real constructors, not close() return values. Bun's process
 * report/active-handle APIs report empty arrays even for a live Worker, so they
 * cannot be the oracle. These wrappers only live in the separate gate process.
 */
export function observeResources() {
	const owned: OwnedResource[] = [];
	const subscriptions = new Set<Promise<unknown>>();
	const processListeners = new Map(process.eventNames().map((event) => [event, process.listeners(event)]));
	const originals = {
		Worker: workerThreads.Worker, spawn: childProcess.spawn,
		createServer: http.createServer, connect: net.connect, createConnection: net.createConnection,
		gateObserver: globalThis.__senpiCodemodeGateObserveResource,
	};
	const timerWindow = observeTimers();
	function track(kind: ResourceKind, emitter: EventEmitter, closeEvent: string): void {
		if (owned.some((item) => item.emitter === emitter)) return;
		const completion = Promise.withResolvers<void>();
		const method = { workers: "terminate", processes: "kill", sockets: "destroy", handles: "close" }[kind];
		const descriptor = Object.getOwnPropertyDescriptor(emitter, method);
		const original: unknown = Reflect.get(emitter, method);
		const onExit = () => { entry.closing = true; };
		const entry: OwnedResource = {
			kind, emitter, close: completion.promise, closing: false, closed: false,
			restore: () => {
				emitter.off("exit", onExit);
				if (descriptor) Object.defineProperty(emitter, method, descriptor);
				else Reflect.deleteProperty(emitter, method);
			},
		};
		owned.push(entry);
		emitter.once(closeEvent, () => { entry.closed = true; completion.resolve(); });
		if (kind === "processes") emitter.once("exit", onExit);
		if (typeof original === "function") Object.defineProperty(emitter, method, {
			configurable: true, writable: true,
			value: new Proxy(original, {
				apply(target, receiver, args) {
					const result: unknown = Reflect.apply(target, receiver, args);
					if (result !== false) entry.closing = true;
					return result;
				},
			}),
		});
		if (emitter instanceof http.Server)
			emitter.on("connection", (socket: net.Socket) => track("sockets", socket, "close"));
	}
	globalThis.__senpiCodemodeGateObserveResource = track;
	workerThreads.Worker = new Proxy(originals.Worker, {
		construct(target, args, newTarget) {
			const worker: unknown = Reflect.construct(target, args, newTarget);
			if (!(worker instanceof originals.Worker)) throw new GateInputError("worker observation");
			track("workers", worker, "exit");
			return worker;
		},
	});
	childProcess.spawn = new Proxy(originals.spawn, {
		apply(target, receiver, args) {
			const child: unknown = Reflect.apply(target, receiver, args);
			if (!(child instanceof childProcess.ChildProcess)) throw new GateInputError("child observation");
			track("processes", child, "close");
			return child;
		},
	});
	http.createServer = new Proxy(originals.createServer, {
		apply(target, receiver, args) {
			const server: unknown = Reflect.apply(target, receiver, args);
			if (!(server instanceof http.Server)) throw new GateInputError("server observation");
			track("handles", server, "close");
			return server;
		},
	});
	const socketHook: ProxyHandler<typeof net.connect> = {
		apply(target, receiver, args) {
			const socket: unknown = Reflect.apply(target, receiver, args);
			if (!(socket instanceof net.Socket)) throw new GateInputError("socket observation");
			track("sockets", socket, "close");
			return socket;
		},
	};
	net.connect = new Proxy(originals.connect, socketHook);
	net.createConnection = new Proxy(originals.createConnection, socketHook);
	syncBuiltinESMExports();
	return {
		subscribe<T>(promise: Promise<T>): Promise<T> {
			subscriptions.add(promise);
			return promise.finally(() => subscriptions.delete(promise));
		},
		async counts() {
			// Await only requested teardown, so genuinely live resources remain visible.
			let closing = owned.filter((entry) => entry.closing && !entry.closed);
			while (closing.length > 0) {
				await Promise.all(closing.map((entry) => entry.close));
				closing = owned.filter((entry) => entry.closing && !entry.closed);
			}
			const active = owned.filter((entry) => !entry.closed);
			const count = (kind: ResourceKind) => active.filter((entry) => entry.kind === kind).length;
			return {
				processes: count("processes"), workers: count("workers"), sockets: count("sockets"),
				handles: count("handles"), timers: timerWindow.count(), subscriptions: subscriptions.size,
				listeners: process.eventNames().reduce((total, event) => {
					const baseline = [...(processListeners.get(event) ?? [])];
					return total + process.listeners(event).reduce((extra, listener) => {
						const index = baseline.indexOf(listener);
						if (index < 0) return extra + 1;
						baseline.splice(index, 1);
						return extra;
					}, 0);
				}, 0)
					+ active.reduce((total, entry) => total + entry.emitter.eventNames()
						.reduce((sum, event) => sum + entry.emitter.listenerCount(event), 0), 0),
			};
		},
		liveTimers(): string[] {
			return timerWindow.sites();
		},
		restore() {
			for (const entry of owned) entry.restore();
			timerWindow.stop();
			globalThis.__senpiCodemodeGateObserveResource = originals.gateObserver;
			Object.assign(workerThreads, { Worker: originals.Worker });
			Object.assign(childProcess, { spawn: originals.spawn });
			Object.assign(http, { createServer: originals.createServer });
			Object.assign(net, { connect: originals.connect, createConnection: originals.createConnection });
			syncBuiltinESMExports();
		},
	};
}

export function cleanupFailures(counts: Readonly<Record<string, number>>, runtime: string): string[] {
	return Object.entries(counts).filter(([, count]) => count !== 0)
		.map(([kind, count]) => `cleanup ${runtime}: ${kind}=${count}`);
}
