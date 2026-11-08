import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import type { Redactor } from "./redact.ts";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
type ConsoleTarget = Partial<Record<ConsoleMethod, (...args: unknown[]) => void>>;

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

export function installConsoleRedactor(target: ConsoleTarget): void {
	const marked = target as ConsoleTarget & { [INSTALLED]?: true };
	if (marked[INSTALLED]) return;
	marked[INSTALLED] = true;
	const methods: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];
	for (const method of methods) {
		const original = target[method];
		if (original === undefined) continue;
		target[method] = (...args: unknown[]) => {
			const redactor = sealedContext.getStore();
			if (redactor === undefined) {
				if (sealedWindows > 0) return;
				original.apply(target, args);
				return;
			}
			original.call(target, redactor.redact(format(...args)));
		};
	}
}
