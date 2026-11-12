/**
 * senpi#6532 review LOW1: a project MCP or skill file write replaces the folder entry (temp file + rename), so it never
 * writes through to a file outside the folder: not through a hard link, and not through a link or a linked folder
 * swapped in after the containment check and before the write. The swap is made from inside the store's own
 * `writeFile` call, the last step before the bytes land, so the test needs no timing.
 */
import type * as FsPromises from "node:fs/promises";
import { linkSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	disposeFolderHosts,
	type FolderHost,
	type FolderLayout,
	PROJECT_CONFIG_DIR,
	SKILL_NAME,
	skillSource,
	startFolderHost,
} from "./project-folder-verbs-host.ts";

const swapHook = vi.hoisted(() => ({ pending: undefined as { folder: string; swap: () => void } | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const writeFile: typeof actual.writeFile = async (...args) => {
		const pending = swapHook.pending;
		if (pending !== undefined && String(args[0]).startsWith(`${pending.folder}/`)) {
			swapHook.pending = undefined;
			pending.swap();
		}
		return actual.writeFile(...args);
	};
	return { ...actual, writeFile };
});

const SKILL_FOLDER = `${PROJECT_CONFIG_DIR}/skills/${SKILL_NAME}`;
const SKILL_PATH = `${SKILL_FOLDER}/SKILL.md`;
const MCP_PATH = `${PROJECT_CONFIG_DIR}/mcp.json`;
const ORIGINAL_SKILL = skillSource(SKILL_NAME);
const EDITED_SKILL = skillSource(SKILL_NAME, "Edited.");
const STORED_MCP = '{"mcpServers":{}}';
const SERVER = { command: "node", args: ["server.js"] };

interface Target {
	readonly label: string;
	readonly folder: string;
	readonly file: string;
	readonly original: string;
	write(host: FolderHost): Promise<Record<string, unknown>>;
}

const TARGETS: readonly Target[] = [
	{
		label: "write_project_skill_file",
		folder: SKILL_FOLDER,
		file: SKILL_PATH,
		original: ORIGINAL_SKILL,
		write: async (host) => {
			const read = await host.call("read_project_skill_file", { skill: SKILL_NAME });
			const { etag } = read.data as { etag: string };
			return host.call("write_project_skill_file", { skill: SKILL_NAME, content: EDITED_SKILL, ifEtag: etag });
		},
	},
	{
		label: "set_project_mcp_servers",
		folder: PROJECT_CONFIG_DIR,
		file: MCP_PATH,
		original: STORED_MCP,
		write: async (host) => {
			const read = await host.call("get_project_mcp_servers");
			const { etag } = read.data as { etag: string };
			return host.call("set_project_mcp_servers", { patch: { alpha: SERVER }, ifEtag: etag });
		},
	},
];

function storeMcp({ cwd }: FolderLayout): void {
	writeFileSync(join(cwd, MCP_PATH), STORED_MCP);
}

afterEach(async () => {
	swapHook.pending = undefined;
	await disposeFolderHosts();
});

describe.each(TARGETS)("$label: the replace never writes through to a file outside the folder", (target) => {
	it("replaces a hard-linked file instead of writing through the link", async () => {
		const host = await startFolderHost({
			prepare: (layout) => {
				storeMcp(layout);
				const project = join(layout.cwd, target.file);
				const shared = join(layout.outside, "shared");
				renameSync(project, shared);
				linkSync(shared, project);
			},
		});
		await host.trust();
		expect(await target.write(host)).toMatchObject({ success: true });
		expect(readFileSync(join(host.outside, "shared"), "utf8")).toBe(target.original);
		expect(readFileSync(join(host.cwd, target.file), "utf8")).not.toBe(target.original);
	});

	it("replaces a file swapped for a link after the check, leaving the link's target alone", async () => {
		const host = await startFolderHost({ prepare: storeMcp });
		await host.trust();
		const project = join(host.cwd, target.file);
		const moved = join(host.outside, "moved");
		swapHook.pending = {
			folder: join(host.cwd, target.folder),
			swap: () => {
				renameSync(project, moved);
				symlinkSync(moved, project);
			},
		};
		expect(await target.write(host)).toMatchObject({ success: true });
		expect(swapHook.pending).toBeUndefined();
		expect(readFileSync(moved, "utf8")).toBe(target.original);
		expect(readFileSync(project, "utf8")).not.toBe(target.original);
	});

	it("refuses a folder swapped for a link after the check, leaving the linked folder as it was", async () => {
		const host = await startFolderHost({ prepare: storeMcp });
		await host.trust();
		const folder = join(host.cwd, target.folder);
		const moved = join(host.outside, "moved");
		swapHook.pending = {
			folder,
			swap: () => {
				renameSync(folder, moved);
				symlinkSync(moved, folder);
			},
		};
		expect(await target.write(host)).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(swapHook.pending).toBeUndefined();
		const name = target.file.slice(target.folder.length + 1);
		expect(readFileSync(join(moved, name), "utf8")).toBe(target.original);
		expect(readdirSync(moved).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
	});
});
