import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import * as opening from "../../../src/cli/session-opening.ts";
import { foreignSessionHolders } from "../../../src/core/foreign-session-holders.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSessionManager } from "../../../src/main.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

// senpi#5756: `senpi --session <file>` / `--continue` on a session another live process runs only warned and then
// opened it as a second writer (the startup path of #5744). Startup now refuses before anything opens the session:
// without a person to ask it exits naming the holder; an interactive terminal gets Cancel or Take over.

let root: string;
let sessionFile: string;
let id: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "held-startup-"));
	id = randomUUID();
	sessionFile = join(root, "held.jsonl");
	await writeFile(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

class Exited extends Error {
	constructor(readonly code: number | undefined) {
		super(`exit ${code}`);
	}
}

it.each([
	{ args: ["--session", "held.jsonl"], mode: "print" },
	{ args: ["--session", "held.jsonl"], mode: "rpc" },
	{ args: ["--continue"], mode: "json" },
	// vitest's stdin is not a terminal: an interactive run that cannot ask refuses as well.
	{ args: ["--continue"], mode: "interactive" },
] as const)("startup with $args in $mode mode refuses a session another live process holds", async ({ args, mode }) => {
	await using holder = await startSessionHolder(sessionFile, id, root);
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Exited(code === undefined || code === null ? undefined : Number(code));
	});
	const opening = createSessionManager(parseArgs([...args]), root, root, SettingsManager.inMemory(), mode);
	await expect(opening).rejects.toEqual(new Exited(1));
	expect(errors.join("\n")).toContain(`pid ${holder.pid}`);
	expect(errors.join("\n")).not.toContain("Concurrent writes may corrupt");
	expect((await foreignSessionHolders(sessionFile, id)).map(({ pid }) => pid)).toEqual([holder.pid]);
});

it("startup opens the session once its holder has exited", async () => {
	const holder = await startSessionHolder(sessionFile, id, root);
	await holder.stop();
	const manager = await createSessionManager(
		parseArgs(["--session", "held.jsonl"]),
		root,
		root,
		SettingsManager.inMemory(),
		"print",
	);
	expect(manager.getSessionId()).toBe(id);
});

it.each([
	{ answer: false, expected: "cancelled" },
	{ answer: true, expected: "open" },
] as const)(
	"an interactive startup asks before opening a held session: take over = $answer",
	async ({ answer, expected }) => {
		await using holder = await startSessionHolder(sessionFile, id, root);
		const asked: string[] = [];
		const errors: string[] = [];
		const result = await opening.admitStartupSession(sessionFile, {
			canAsk: true,
			confirm: async (question) => {
				asked.push(question);
				return answer;
			},
			err: (line) => void errors.push(line),
		});
		expect(result).toBe(expected);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain(`pid ${holder.pid}`);
		const holders = (await foreignSessionHolders(sessionFile, id)).map(({ pid }) => pid);
		if (answer) {
			expect(holders).toEqual([]);
		} else {
			expect(holders).toEqual([holder.pid]);
			expect(errors.join("\n")).toContain(`pid ${holder.pid}`);
		}
	},
);

it.each([{ host_instance: "h-1" }, { unproven: true as const }])(
	"take-over is not offered at startup for a holder it cannot stop safely: %o",
	async (extra) => {
		const confirm = vi.fn(async () => true);
		const errors: string[] = [];
		const result = await opening.admitStartupSession(sessionFile, {
			canAsk: true,
			confirm,
			err: (line) => void errors.push(line),
			lookup: async () => ({ holders: [{ pid: 4242, cwd: root, ...extra }] }),
		});
		expect(result).toBe("refused");
		expect(confirm).not.toHaveBeenCalled();
		expect(errors.join("\n")).toContain("pid 4242");
	},
);

it("a failed holder lookup stays advisory at startup", async () => {
	const errors: string[] = [];
	const result = await opening.admitStartupSession(sessionFile, {
		canAsk: false,
		confirm: async () => true,
		err: (line) => void errors.push(line),
		lookup: async () => ({ lookupFailed: true }),
	});
	expect(result).toBe("open");
	expect(errors).toHaveLength(1);
});
