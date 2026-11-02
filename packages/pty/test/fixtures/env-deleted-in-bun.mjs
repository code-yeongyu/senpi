import { TerminalSession } from "../../src/session.ts";

const PROBE =
	'printf "%s|%s|%s|%s\\n" "${SENPI_PTY_ENV_PROBE-unset}" "${PATH:+path}" "${HOME:+home}" "${TERM:+term}"';
delete process.env.SENPI_PTY_ENV_PROBE;

async function sessionSees(env, dependencies) {
	const session = new TerminalSession({ command: "/bin/sh", args: ["-c", PROBE], env }, dependencies);
	const chunks = [];
	session.onData((chunk) => chunks.push(chunk));
	session.start();
	await session.waitExit();
	return Buffer.concat(chunks).toString("utf8").replace(/\r/g, "").trim();
}

const sessions = {};
for (const [backend, dependencies] of [
	["native", { env: {} }],
	["bun", { env: { SENPI_BUN_TERMINAL: "1" } }],
	["pipe-fallback", { env: { SENPI_PTY_FORCE_PIPE: "1" } }],
]) {
	sessions[`${backend} default`] = await sessionSees(undefined, dependencies);
	sessions[`${backend} overrides`] = await sessionSees({ OTHER: "1" }, dependencies);
}

const read = async (stream) => (await new Response(stream).text()).trim();
const raw = {
	"Bun.spawnSync default env": Bun.spawnSync(["/bin/sh", "-c", PROBE]).stdout.toString().trim(),
	"Bun.spawn default env": await read(Bun.spawn(["/bin/sh", "-c", PROBE], { stdout: "pipe" }).stdout),
	"Bun.spawn env: process.env": await read(Bun.spawn(["/bin/sh", "-c", PROBE], { env: process.env, stdout: "pipe" }).stdout),
	"Bun.spawn explicit env": await read(Bun.spawn(["/bin/sh", "-c", PROBE], { env: { ...process.env }, stdout: "pipe" }).stdout),
	"Bun.$ default": (await Bun.$`/bin/sh -c ${PROBE}`.quiet().text()).trim(),
};
console.log(JSON.stringify({ sessions, raw }));
