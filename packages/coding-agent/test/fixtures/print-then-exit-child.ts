import { printThenExit } from "../../src/cli/print-then-exit.ts";

const rows = Number(process.argv[2] ?? "4000");

process.stdout.write("header\n");
await printThenExit(() => {
	for (let index = 0; index < rows; index++) console.log(`row ${index} ${"x".repeat(80)}`);
}, 0);
