/// <reference types="node" />
import { resolve } from "node:path";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

type QaOptions = {
	readonly cwd: string;
	readonly codes: readonly string[];
};

class QaArgumentError extends Error {
	readonly name = "QaArgumentError";
}

function parseArgs(args: readonly string[]): QaOptions {
	let cwd = process.cwd();
	const codes: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		const value = args[index + 1];
		if (flag !== "--cwd" && flag !== "--code") throw new QaArgumentError(`Unknown argument: ${flag}`);
		if (value === undefined) throw new QaArgumentError(`${flag} requires a value`);
		if (flag === "--cwd") cwd = resolve(value);
		else codes.push(value);
		index += 1;
	}
	if (codes.length === 0) throw new QaArgumentError("At least one --code value is required");
	return { cwd, codes };
}

function printFrame(message: KernelToHostMessage): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const kernel = new JavaScriptKernel({
		sessionId: `qa-js-${crypto.randomUUID()}`,
		cwd: options.cwd,
		parallelPoolWidth: 4,
		onMessage: printFrame,
	});
	try {
		for (const [index, code] of options.codes.entries()) {
			const result = await kernel.run({ cellId: `qa-cell-${index + 1}`, code, timeoutMs: 15_000 });
			if (!result.ok) process.exitCode = 1;
		}
	} finally {
		await kernel.close();
	}
}

await main();
