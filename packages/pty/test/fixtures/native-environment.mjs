import { nativePty } from "../../native/index.js";

if (nativePty.native === null) {
	throw new Error("native PTY fixture requires a host prebuild");
}

const childScript = 'process.stdout.write(JSON.stringify({ sentinel: process.env.SENPI_PTY_ENV_SENTINEL ?? null }))';
const scenarios = [
	["inherited", undefined],
	["empty", {}],
	["deleted", { SENPI_PTY_ENV_SENTINEL: undefined }],
	["explicit", { SENPI_PTY_ENV_SENTINEL: "caller" }],
];
const results = {};
for (const [name, env] of scenarios) {
	let output = "";
	const session = nativePty.native.startPtySession(
		{ command: process.execPath, args: ["-e", childScript], env, cols: 80, rows: 24, timeoutMs: 10_000 },
		(chunk) => { output += String(chunk); },
	);
	const exit = await session.waitExit();
	if (exit.exitCode !== 0) throw new Error(`native PTY ${name} exited ${exit.exitCode}`);
	results[name] = JSON.parse(output).sentinel;
}
process.stdout.write(`${JSON.stringify(results)}\n`);
