import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	CursorCliAbortError,
	CursorCliPromptTooLargeError,
	type CursorCliTransportHandle,
	MAX_CURSOR_CLI_PROMPT_BYTES,
	spawnCursorCli,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/transport.ts";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(TEST_DIRECTORY, "../fixtures/fake-cursor-agent.mjs");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "cursor-cli-transport-"));
	temporaryDirectories.push(directory);
	return directory;
}

function fixtureExecutable(
	directory: string,
	scenario: "happy" | "grandchild",
): { executable: string; dump: string; pidFile: string } {
	const copiedFixture = join(directory, "fake-cursor-agent.mjs");
	const executable = join(directory, "cursor-agent");
	const dump = join(directory, "invocation.json");
	const pidFile = join(directory, "grandchild.pid");
	copyFileSync(FIXTURE, copiedFixture);
	const source =
		scenario === "grandchild"
			? `#!${process.execPath}\nimport { spawn } from "node:child_process";\nspawn(process.execPath, [${JSON.stringify(copiedFixture)}, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, FAKE_CURSOR_ARGV_DUMP: ${JSON.stringify(dump)}, FAKE_CURSOR_SCENARIO: "grandchild", FAKE_CURSOR_GRANDCHILD_PID_FILE: ${JSON.stringify(pidFile)} } });\nsetInterval(() => {}, 1000);\n`
			: `#!/bin/sh\nFAKE_CURSOR_ARGV_DUMP=${JSON.stringify(dump)} FAKE_CURSOR_SCENARIO=${scenario} FAKE_CURSOR_GRANDCHILD_PID_FILE=${JSON.stringify(pidFile)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(copiedFixture)} "$@"\n`;
	writeFileSync(executable, source, { mode: 0o700 });
	chmodSync(executable, 0o700);
	return { executable, dump, pidFile };
}

function start(
	directory: string,
	executable: string,
	prompt = "hello",
	signal?: AbortSignal,
): CursorCliTransportHandle {
	process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = executable;
	return spawnCursorCli({
		prompt,
		model: "fake-model",
		accountHome: join(directory, "account-home"),
		cwd: directory,
		signal,
	});
}

function assertDead(pid: number): void {
	expect(() => process.kill(pid, 0)).toThrow();
}

async function collect(handle: CursorCliTransportHandle): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of handle.events) events.push(event);
	return events;
}

afterEach(() => {
	delete process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE;
	delete process.env.SENPI_TRANSPORT_SECRET;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cursor CLI transport", () => {
	it("streams a happy invocation through completion and reaps the child", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const handle = start(directory, fixture.executable);
		const events = await collect(handle);
		const outcome = await handle.completed;

		expect(
			events.some(
				(event) => typeof event === "object" && event !== null && "type" in event && event.type === "result",
			),
		).toBe(true);
		expect(outcome).toMatchObject({ type: "completed", exitCode: 0 });
		assertDead(handle.pid);
	});

	it("aborts the exact process group and reaps both leader and descendant", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "grandchild");
		const controller = new AbortController();
		const pidFileReady = new Promise<void>((resolveReady, rejectReady) => {
			const watcher = watch(directory);
			const deadline = setTimeout(() => {
				watcher.close();
				rejectReady(new Error("fixture did not report its grandchild"));
			}, 2_000);
			watcher.on("change", (_eventType, filename) => {
				if (filename !== "grandchild.pid") return;
				clearTimeout(deadline);
				watcher.close();
				resolveReady();
			});
		});
		const handle = start(directory, fixture.executable, "slow", controller.signal);
		await pidFileReady;
		const grandchildPid = Number(readFileSync(fixture.pidFile, "utf8").trim());
		controller.abort();
		const events = await collect(handle);
		const outcome = await handle.completed;

		expect(events.at(-1)).toBeInstanceOf(CursorCliAbortError);
		expect(outcome.type).toBe("aborted");
		assertDead(handle.pid);
		assertDead(grandchildPid);
	});

	it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
		const directory = temporaryDirectory();
		const executable = join(directory, "hung-cursor-agent.mjs");
		writeFileSync(
			executable,
			`#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nprocess.stdout.write(JSON.stringify({ type: "system", subtype: "init", apiKeySource: "login", cwd: process.cwd(), session_id: "hung", model: "fake", permissionMode: "default" }) + "\\n");\nsetInterval(() => {}, 1000);\n`,
			{ mode: 0o700 },
		);
		chmodSync(executable, 0o700);
		const controller = new AbortController();
		const handle = start(directory, executable, "hang", controller.signal);
		const iterator = handle.events[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({ type: "system" });
		controller.abort();
		const outcome = await handle.completed;

		expect(outcome.type).toBe("aborted");
		assertDead(handle.pid);
	}, 8_000);

	it("passes only the explicit environment allowlist", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		process.env.SENPI_TRANSPORT_SECRET = "must-not-leak";
		const handle = start(directory, fixture.executable);
		await collect(handle);
		await handle.completed;
		const invocation = JSON.parse(readFileSync(fixture.dump, "utf8")) as { env: Record<string, string> };

		expect(Object.keys(invocation.env).sort()).toEqual(
			["AGENT_CLI_CREDENTIAL_STORE", "FORCE_COLOR", "HOME", "LANG", "LC_ALL", "PATH", "TERM"]
				.filter((key) => key in invocation.env)
				.sort(),
		);
		expect(invocation.env.HOME).toBe(join(directory, "account-home"));
		expect(invocation.env.AGENT_CLI_CREDENTIAL_STORE).toBe("file");
		expect(invocation.env).not.toHaveProperty("SENPI_TRANSPORT_SECRET");
	});

	it("surfaces a silent zero exit as a malformed stream", async () => {
		const directory = temporaryDirectory();
		const executable = join(directory, "silent-cursor-agent.mjs");
		writeFileSync(executable, `#!${process.execPath}\n`, { mode: 0o700 });
		chmodSync(executable, 0o700);
		const handle = start(directory, executable);
		const events = await collect(handle);

		expect(await handle.completed).toMatchObject({ type: "completed", exitCode: 0 });
		expect(events).toContainEqual(
			expect.objectContaining({ type: "malformed_stream", kind: "malformed_stream", reason: "incomplete_stream" }),
		);
	});

	it("rejects 130001 prompt bytes before spawning", () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const error = (() => {
			try {
				start(directory, fixture.executable, "x".repeat(MAX_CURSOR_CLI_PROMPT_BYTES + 1));
			} catch (caught) {
				return caught;
			}
			throw new Error("expected prompt rejection");
		})();

		expect(error).toBeInstanceOf(CursorCliPromptTooLargeError);
		expect(error).toMatchObject({ kind: "context_overflow", limitBytes: 130_000, actualBytes: 130_001 });
		expect(() => readFileSync(fixture.dump, "utf8")).toThrow();
	});

	it("rejects a 449999-byte prompt before spawning", () => {
		// 449999 bytes fit darwin's ~467 KB per-arg limit but exceed Linux
		// MAX_ARG_STRLEN (131072), so it must be rejected by the platform-safe
		// ceiling instead of dying with spawn E2BIG.
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const error = (() => {
			try {
				start(directory, fixture.executable, "x".repeat(449_999));
			} catch (caught) {
				return caught;
			}
			throw new Error("expected prompt rejection");
		})();

		expect(error).toBeInstanceOf(CursorCliPromptTooLargeError);
		expect(error).toMatchObject({ kind: "context_overflow", limitBytes: 130_000, actualBytes: 449_999 });
		expect(() => readFileSync(fixture.dump, "utf8")).toThrow();
	});

	it("spawns a 129999-byte prompt normally", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const handle = start(directory, fixture.executable, "x".repeat(129_999));
		await collect(handle);
		expect(await handle.completed).toMatchObject({ type: "completed", exitCode: 0 });
		const invocation = JSON.parse(readFileSync(fixture.dump, "utf8")) as { argv: string[] };
		expect(invocation.argv[0]).toBe("-p");
		expect(Buffer.byteLength(invocation.argv[1], "utf8")).toBe(129_999);
	});
});
