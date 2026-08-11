import { pbkdf2 } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nativePty } from "../../native/index.js";

if (nativePty.native === null) {
	throw new Error("native PTY threadpool fixture requires a host prebuild");
}

const SESSION_COUNT = 6;
const sessions = [];
const waits = [];

function deadline(promise, timeoutMs, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function deriveKey() {
	return new Promise((resolve, reject) => {
		pbkdf2("senpi", "pty-threadpool", 10_000, 32, "sha256", (error, key) => {
			if (error) reject(error);
			else resolve(key);
		});
	});
}

function assertExit(exit) {
	if (exit === null || typeof exit !== "object") throw new Error("native wait returned a non-object exit");
	if (exit.exitCode !== undefined && typeof exit.exitCode !== "number") {
		throw new Error("native wait returned an invalid exitCode");
	}
	if (exit.signal !== undefined && typeof exit.signal !== "string") {
		throw new Error("native wait returned an invalid signal");
	}
	if (exit.cancelled !== true) throw new Error("native wait did not report cancellation");
	if (exit.timedOut !== false) throw new Error("native wait incorrectly reported a timeout");
}

let probeError;
try {
	const readiness = Array.from({ length: SESSION_COUNT }, (_, index) => {
		const marker = `READY_${index}`;
		let output = "";
		let markReady;
		const ready = new Promise((resolve) => {
			markReady = resolve;
		});
		const session = nativePty.native.startPtySession(
			{
				command: "sh",
				args: ["-lc", `printf '${marker}\\n'; while :; do sleep 3600; done`],
				cols: 80,
				rows: 24,
			},
			(chunk) => {
				output += String(chunk);
				if (output.includes(marker)) markReady();
			},
		);
		sessions.push(session);
		return ready;
	});

	await deadline(Promise.all(readiness), 5_000, "PTY_READY_TIMEOUT");
	for (const session of sessions) waits.push(session.waitExit());

	await deadline(
		Promise.all([lookup("localhost"), readFile(fileURLToPath(import.meta.url)), deriveKey()]),
		1_500,
		"THREADPOOL_STARVATION_TIMEOUT",
	);
} catch (error) {
	probeError = error;
} finally {
	for (const session of sessions) {
		try {
			session.kill("SIGKILL");
		} catch {
			// The child may have exited while another session was being stopped.
		}
		try {
			session.kill();
		} catch {
			// Mark cancellation even if the explicit SIGKILL already won the race.
		}
	}
	const exits = await deadline(Promise.all(waits), 5_000, "PTY_CLEANUP_TIMEOUT");
	for (const exit of exits) assertExit(exit);
}

if (probeError !== undefined) throw probeError;
process.stdout.write("THREADPOOL_PROBES_COMPLETED\n");
