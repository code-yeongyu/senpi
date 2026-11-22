import { printThenExit } from "../../src/cli/print-then-exit.ts";

try {
	await printThenExit(() => {
		console.log("before the failure");
		throw new Error("print failed");
	}, 0);
} catch (error) {
	process.stderr.write(`caught: ${(error as Error).message}\n`);
	process.exitCode = 3;
}
