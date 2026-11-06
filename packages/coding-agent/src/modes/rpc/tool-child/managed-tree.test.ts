// senpi#4236 delta review LOW-1: a managed launch's marker counts only in a process's environment, never its argv.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { processIsRunning } from "../../../utils/process-identity.ts";
import { MANAGED_LAUNCH_MARKER_ENV, markersInEnviron, parseDarwinTreeRows, sweepTree } from "./managed-tree.ts";

const children: ChildProcess[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	}
});

function idle(args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { env, stdio: "ignore" });
	children.push(child);
	return child;
}

describe.skipIf(process.platform === "win32")("managed tree marker on a real process table", () => {
	it("ends a process whose environment carries the marker and spares one that only names it in argv", async () => {
		const id = randomUUID();
		const { [MANAGED_LAUNCH_MARKER_ENV]: _inherited, ...clean } = process.env;
		const argvOnly = idle([`${MANAGED_LAUNCH_MARKER_ENV}=${id}`], clean);
		const inEnv = idle([], { ...clean, [MANAGED_LAUNCH_MARKER_ENV]: id });
		await Promise.all([once(argvOnly, "spawn"), once(inEnv, "spawn")]);
		const ended = once(inEnv, "exit");

		const survivors = await sweepTree({ marker: id }, { graceMs: 2_000, killWaitMs: 2_000 });
		await ended;

		expect(survivors).toEqual([]);
		expect(processIsRunning(argvOnly.pid ?? -1)).toBe(true);
		expect(processIsRunning(inEnv.pid ?? -1)).toBe(false);
	}, 20_000);
});

describe("managed tree marker parsing", () => {
	const start = "Mon Oct 26 10:00:00 2026";

	it("macOS: reads markers from the environment after the argv-only text, never from argv", () => {
		const argv = "/bin/node -e x SENPI_MANAGED_LAUNCH=from-argv";
		const withEnvironment = [
			`  201     1   201 S    ${start} ${argv} HOME=/h SENPI_MANAGED_LAUNCH=from-env`,
			`  202     1   202 S    ${start} ${argv}`,
			`  203     1   203 S    ${start} /bin/node SENPI_MANAGED_LAUNCH=one SENPI_MANAGED_LAUNCH=two`,
		].join("\n");
		const argvOnly = [`  201 ${start} ${argv}`, `  202 ${start} ${argv}`, `  203 ${start} /bin/node`].join("\n");

		const rows = parseDarwinTreeRows(withEnvironment, argvOnly);

		expect(rows.map((row) => [row.pid, row.markers])).toEqual([
			[201, ["from-env"]],
			[202, []],
			[203, ["one", "two"]],
		]);
	});

	it("macOS: a row whose argv snapshot is missing or disagrees yields no marker", () => {
		const withEnvironment = [
			`  301     1   301 S    ${start} /bin/a SENPI_MANAGED_LAUNCH=x`,
			`  302     1   302 S    ${start} /bin/b SENPI_MANAGED_LAUNCH=y`,
		].join("\n");
		const argvOnly = `  302 Mon Oct 26 10:00:09 2026 /bin/b`;

		expect(parseDarwinTreeRows(withEnvironment, argvOnly).map((row) => row.markers)).toEqual([[], []]);
	});

	it("Linux: only a whole /proc environ entry names the marker", () => {
		const environ = [
			"EVIL= SENPI_MANAGED_LAUNCH=spoof",
			"SENPI_MANAGED_LAUNCH=real",
			"XSENPI_MANAGED_LAUNCH=no",
			"",
		].join("\0");

		expect(markersInEnviron(environ)).toEqual(["real"]);
	});
});
