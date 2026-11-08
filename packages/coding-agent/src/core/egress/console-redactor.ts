import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import type { Redactor } from "./redact.ts";

type ConsoleTarget = object;

const INSTALLED = Symbol.for("senpi.egress.consoleRedactorInstalled");

// no-module-state: console-redactor-install
const sealedContext = new AsyncLocalStorage<Redactor>();

// no-module-state: sealed-window-counter
let sealedWindows = 0;

export function sealedWindowCount(): number {
	return sealedWindows;
}

export async function runSealed<T>(redactor: Redactor, work: () => Promise<T>): Promise<T> {
	sealedWindows++;
	try {
		return await sealedContext.run(redactor, work);
	} finally {
		sealedWindows--;
	}
}

/** Console members that never write a line; wrapping them would only break them (Node and Bun consoles). */
const NON_WRITING_MEMBERS = [
	"context",
	"createTask",
	"profile",
	"profileEnd",
	"timeStamp",
	"takeHeapSnapshot",
	"record",
	"recordEnd",
	"screenshot",
] as const;

/**
 * The console members to wrap: every function-valued member except constructors (`Console`), `_`-prefixed
 * stream internals (`_stdoutErrorHandler`) and the known non-writing members. Anything unknown is wrapped, so a
 * writing method no list names (Bun's `console.write`) cannot bypass the redactor.
 */
function consoleMethods(target: object): string[] {
	const names = new Set<string>();
	for (
		let level: object | null = target;
		level !== null && level !== Object.prototype;
		level = Object.getPrototypeOf(level)
	) {
		for (const name of Object.getOwnPropertyNames(level)) {
			if (name === "constructor" || name.startsWith("_") || /^[A-Z]/u.test(name)) continue;
			if (NON_WRITING_MEMBERS.some((member) => member === name)) continue;
			if (typeof (target as Record<string, unknown>)[name] === "function") names.add(name);
		}
	}
	return [...names];
}

export function installConsoleRedactor(target: ConsoleTarget): void {
	const console = target as Record<string | symbol, unknown>;
	if (console[INSTALLED]) return;
	console[INSTALLED] = true;
	for (const method of consoleMethods(target)) {
		const original = console[method] as (...args: unknown[]) => unknown;
		const keepsCondition = method === "assert";
		console[method] = (...args: unknown[]) => {
			const redactor = sealedContext.getStore();
			if (redactor === undefined) {
				if (sealedWindows > 0) return;
				return original.apply(target, args);
			}
			if (keepsCondition) {
				const [condition, ...message] = args;
				return original.call(target, condition, redactor.redact(format(...message)));
			}
			return original.call(target, redactor.redact(format(...args)));
		};
	}
}
