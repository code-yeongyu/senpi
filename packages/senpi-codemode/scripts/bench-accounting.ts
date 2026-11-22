import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import type { EvalLanguage } from "../src/tool/types.ts";
import type { KernelCpu } from "./bench-session.ts";

const usageSchema = Type.Object({ pid: Type.Integer({ minimum: 1 }), cpuUs: Type.Number({ minimum: 0 }) });

export class BenchAccountingError extends Error {
	readonly name = "BenchAccountingError";
}

/** An executable override, not a production lifecycle hook. Each session owns its receipts. */
export async function instrumentInterpreter(
	availability: InterpreterAvailability,
	context: { readonly root: string; readonly language: EvalLanguage },
): Promise<InterpreterAvailability> {
	if (context.language === "js") return availability;
	if (process.platform === "win32") throw new BenchAccountingError("exit CPU accounting requires POSIX wait4");
	const detected = availability[context.language].detected;
	const python = availability.py.detected;
	if (!detected.ok || !python.ok)
		throw new BenchAccountingError("exit CPU accounting needs the interpreter and Python");
	const wrapper = join(context.root, "interpreter");
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	const args = [
		python.resolvedPath ?? python.path,
		fileURLToPath(new URL("./bench-interpreter.py", import.meta.url)),
		context.root,
		detected.resolvedPath ?? detected.path,
		context.language === "py" ? "1" : "0",
	];
	await writeFile(wrapper, `#!/bin/sh\nexec ${args.map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
	return {
		...availability,
		[context.language]: { ...availability[context.language], detected: { ...detected, path: wrapper } },
	};
}

/** The waiter connects here after each atomic receipt rename; bench-interpreter.py uses the same name. */
export const receiptSignalPath = (root: string): string => join(root, "receipts.sock");

/**
 * Resolves once the receipt signal is listening, so kernels started afterwards cannot announce unheard.
 * A directory watcher cannot promise that: macOS starts FSEvents streams asynchronously.
 */
export async function watchExitUsage(root: string) {
	const seen = new Set<number>();
	const pending = new Map<string, () => void>();
	const server = createServer((socket) => {
		socket.destroy();
		for (const notify of pending.values()) notify();
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(receiptSignalPath(root), listening.resolve);
	await listening.promise;
	server.unref();
	return {
		async totals(live?: KernelCpu): Promise<readonly KernelCpu[]> {
			for (const name of await readdir(root)) {
				const match = /^started-(\d+)$/u.exec(name);
				if (match) seen.add(Number(match[1]));
			}
			const completed = await Promise.all(
				[...seen]
					.filter((pid) => pid !== live?.pid)
					.map(async (pid) => {
						const name = `usage-${pid}.json`;
						const deadline = Date.now() + 60_000;
						let timer: NodeJS.Timeout | undefined;
						try {
							let text: string;
							for (;;) {
								const ready = Promise.withResolvers<void>();
								pending.set(name, ready.resolve);
								try {
									text = await readFile(join(root, name), "utf8");
									break;
								} catch (error) {
									if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
									timer = setTimeout(
										() => ready.reject(new BenchAccountingError(`missing exit CPU for process ${pid}`)),
										Math.max(0, deadline - Date.now()),
									);
									await ready.promise;
									clearTimeout(timer);
								}
							}
							const value: unknown = JSON.parse(text);
							if (!Check(usageSchema, value)) throw new BenchAccountingError(`invalid exit usage: ${name}`);
							return value;
						} finally {
							clearTimeout(timer);
							pending.delete(name);
						}
					}),
			);
			if (live) seen.add(live.pid);
			return live ? [...completed, live] : completed;
		},
		close: () => server.close(),
	};
}
