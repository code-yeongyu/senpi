// senpi#7493: interactive mode reports its resume command through OSC 7577 (Program Resume Protocol rev 0.5).
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_COMMAND } from "../../src/config.ts";
import { takeProgramResumeToken } from "../../src/core/program-resume-token.ts";
import { ProgramResumeReporter, programResumeTarget } from "../../src/modes/interactive/program-resume-reporter.ts";

const TOKEN = "dummy-token-replace-me";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const report = (body: string) =>
	`\x1b]7577;${body}:mac=${createHash("sha256").update(`${body}:${TOKEN}`).digest("hex")}\x1b\\`;

function reporter(token = TOKEN) {
	const writes: string[] = [];
	let nowMs = 1795543200 * 1000;
	const instance = new ProgramResumeReporter({
		token,
		pid: 4242,
		now: () => nowMs,
		write: (data) => writes.push(data),
	});
	return {
		instance,
		writes,
		advance: (seconds: number) => {
			nowMs += seconds * 1000;
		},
	};
}

const first = { argv: [APP_COMMAND, "--session", "/home/u/.senpi/sessions/a.jsonl"], cwd: "/home/u/project" };
const second = { argv: [APP_COMMAND, "--session", "/home/u/.senpi/sessions/b.jsonl"], cwd: "/home/u/project" };

describe("takeProgramResumeToken (senpi#7493)", () => {
	it("returns the token and removes it so no child inherits it", async () => {
		const env: NodeJS.ProcessEnv = { OSC7577_TOKEN: TOKEN, KEEP: "1" };
		expect(await takeProgramResumeToken(env)).toBe(TOKEN);
		expect(env).toEqual({ KEEP: "1" });
		expect(await takeProgramResumeToken({})).toBeUndefined();
	});
});

describe("ProgramResumeReporter (senpi#7493)", () => {
	it("writes the exact report once per command and again when the command changes", () => {
		const { instance, writes, advance } = reporter();
		instance.sync(first);
		instance.sync(first);
		advance(5);
		instance.sync(second);
		expect(writes).toEqual([
			report(`pid=4242:time=1795543200:argv=${first.argv.map(b64).join(",")}:cwd=${b64(first.cwd)}`),
			report(`pid=4242:time=1795543205:argv=${second.argv.map(b64).join(",")}:cwd=${b64(second.cwd)}`),
		]);
	});

	it("reports an unchanged command again with a fresh time when asked to refresh", () => {
		const { instance, writes, advance } = reporter();
		instance.sync(first);
		advance(90);
		instance.sync(first, { refresh: true });
		expect(writes[1]).toBe(
			report(`pid=4242:time=1795543290:argv=${first.argv.map(b64).join(",")}:cwd=${b64(first.cwd)}`),
		);
		expect(writes).toHaveLength(2);
	});

	it("clears a reported command when the session stops being resumable, and only then", () => {
		const { instance, writes } = reporter();
		instance.sync(undefined);
		instance.clear();
		expect(writes).toEqual([]);
		instance.sync(first);
		instance.sync(undefined);
		instance.sync(undefined, { refresh: true });
		expect(writes.slice(1)).toEqual([report("pid=4242:time=1795543200:clear=1")]);
	});

	it("clears instead of leaving the earlier command when the new one cannot be reported", () => {
		const { instance, writes } = reporter();
		instance.sync(first);
		instance.sync({ argv: [APP_COMMAND, "--session", "/tmp/line\nbreak.jsonl"], cwd: "/home/u/project" });
		expect(writes.slice(1)).toEqual([report("pid=4242:time=1795543200:clear=1")]);
	});

	it("writes nothing with a malformed token", () => {
		const { instance, writes } = reporter("short");
		instance.sync(first);
		instance.clear();
		expect(writes).toEqual([]);
	});

	it("clears on quit after a report", () => {
		const { instance, writes } = reporter();
		instance.sync(first);
		instance.clear();
		instance.clear();
		expect(writes.slice(1)).toEqual([report("pid=4242:time=1795543200:clear=1")]);
	});
});

describe("programResumeTarget (senpi#7493)", () => {
	const dir = mkdtempSync(join(tmpdir(), "osc7577-"));
	const sessionFile = join(dir, "session.jsonl");
	const manager = (persisted: boolean, file: string | undefined) => ({
		isPersisted: () => persisted,
		getSessionFile: () => file,
		getCwd: () => "/home/u/project",
	});

	it("resumes the written session file by its absolute path with the brand command", () => {
		writeFileSync(sessionFile, "{}\n");
		expect(programResumeTarget(manager(true, sessionFile))).toEqual({
			argv: [APP_COMMAND, "--session", sessionFile],
			cwd: "/home/u/project",
		});
	});

	it("has no target before the session is written or when it is not persisted", () => {
		expect(programResumeTarget(manager(true, join(dir, "missing.jsonl")))).toBeUndefined();
		expect(programResumeTarget(manager(true, undefined))).toBeUndefined();
		expect(programResumeTarget(manager(false, sessionFile))).toBeUndefined();
	});
});
