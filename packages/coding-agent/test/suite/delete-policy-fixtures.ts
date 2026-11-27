import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type DeleteAuditRow, deleteAuditFile } from "../../src/core/extensions/builtin/delete-policy/audit.ts";
import type { DeletePolicy } from "../../src/core/extensions/builtin/delete-policy/policy.ts";
import type { TrashScope } from "../../src/core/extensions/builtin/delete-policy/trash.ts";

export const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
export const DAY_MS = 86_400_000;

/** Everything a trash test touches lives under `root`: HOME, XDG_DATA_HOME, the agent dir and the work tree. */
export interface TrashSandbox {
	readonly root: string;
	readonly home: string;
	readonly trashDir: string;
	readonly agentDir: string;
	readonly work: string;
	readonly env: NodeJS.ProcessEnv;
	readonly clock: { now: number };
	scope(overrides?: { readonly policy?: Partial<DeletePolicy> } & Partial<Omit<TrashScope, "policy">>): TrashScope;
}

const sandboxes: string[] = [];

export async function trashSandbox(): Promise<TrashSandbox> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-trash-")));
	sandboxes.push(root);
	const home = join(root, "home");
	const dataHome = join(home, ".local", "share");
	const agentDir = join(root, "agent");
	const work = join(home, "work");
	await mkdir(work, { recursive: true });
	const env: NodeJS.ProcessEnv = { HOME: home, XDG_DATA_HOME: dataHome };
	const clock = { now: T0 };
	return {
		root,
		home,
		trashDir: join(dataHome, "Trash"),
		agentDir,
		work,
		env,
		clock,
		scope: (overrides = {}) => ({
			agentDir,
			sessionId: "session-test",
			actor: "model",
			env,
			platform: "linux",
			now: () => clock.now,
			...overrides,
			policy: { mode: "trash", retentionDays: 14, maxTrashBytes: 1_000_000, ...overrides.policy },
		}),
	};
}

export async function removeTrashSandboxes(): Promise<void> {
	await Promise.all(sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function writeTree(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		const file = join(dir, name);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content);
	}
}

export async function readTree(dir: string): Promise<Record<string, string>> {
	const tree: Record<string, string> = {};
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const file = join(entry.parentPath, entry.name);
		tree[relative(dir, file)] = await readFile(file, "utf8");
	}
	return tree;
}

export async function auditRows(agentDir: string): Promise<DeleteAuditRow[]> {
	let text: string;
	try {
		text = await readFile(deleteAuditFile(agentDir), "utf8");
	} catch (error) {
		if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return [];
		throw error;
	}
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}
