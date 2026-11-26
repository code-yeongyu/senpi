// #3796: a checked project skill read refuses a file swapped between its check and its read,
// whether the descriptor read runs synchronously or across awaits.
import { vi } from "vitest";

const swap = vi.hoisted(() => ({ target: "", action: undefined as (() => void) | undefined }));

function fire(path: unknown): void {
	if (swap.action === undefined || String(path) !== swap.target) return;
	const action = swap.action;
	swap.action = undefined;
	action();
}

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync: (...args: Parameters<typeof actual.openSync>) => {
			fire(args[0]);
			return actual.openSync(...args);
		},
		readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
			fire(args[0]);
			return actual.readFileSync(...args);
		}) as typeof actual.readFileSync,
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: (...args: Parameters<typeof actual.open>) => {
			fire(args[0]);
			return actual.open(...args);
		},
		readFile: ((...args: Parameters<typeof actual.readFile>) => {
			fire(args[0]);
			return actual.readFile(...args);
		}) as typeof actual.readFile,
	};
});

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as access from "../../../src/core/skill-access.ts";

// Both exports must exist: removing or renaming one must fail instead of silently dropping coverage.
const variants = [
	["readSkillFileChecked", access.readSkillFileChecked],
	["readSkillFileCheckedSync", access.readSkillFileCheckedSync],
] as const;

let root: string;
let project: string;
let skill: string;
let outside: string;
let provenance: access.SkillProvenance;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-3796-swap-")));
	project = join(root, "project");
	mkdirSync(join(project, ".git"), { recursive: true });
	mkdirSync(join(project, ".senpi", "skills", "carrier"), { recursive: true });
	skill = join(project, ".senpi", "skills", "carrier", "SKILL.md");
	writeFileSync(skill, "SYNTHETIC_PROJECT_BODY");
	outside = join(root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "SKILL.md"), "SYNTHETIC_OUTSIDE_BODY");
	provenance = { kind: "project-auto", selectedRoot: join(project, ".senpi", "skills"), projectRoot: project };
	swap.target = "";
	swap.action = undefined;
});

afterEach(() => {
	swap.action = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe.each(variants)("%s", (_name, read) => {
	it("reads an unswapped project skill", async () => {
		expect(await read(skill, provenance)).toBe("SYNTHETIC_PROJECT_BODY");
	});

	it("refuses a project link out of the project", async () => {
		unlinkSync(skill);
		symlinkSync(join(outside, "SKILL.md"), skill);
		await expect(Promise.resolve().then(() => read(skill, provenance))).rejects.toBeInstanceOf(
			access.BlockedSkillLinkError,
		);
	});

	it("allows a project link into a configured skill folder", async () => {
		unlinkSync(skill);
		symlinkSync(join(outside, "SKILL.md"), skill);
		const allowed = { roots: [outside], files: [], digest: "synthetic" };
		expect(await read(skill, provenance, allowed)).toBe("SYNTHETIC_OUTSIDE_BODY");
	});

	it("refuses a link swapped in between the check and the read", async () => {
		swap.target = skill;
		swap.action = () => {
			unlinkSync(skill);
			symlinkSync(join(outside, "SKILL.md"), skill);
		};
		const result = Promise.resolve().then(() => read(skill, provenance));
		await expect(result).rejects.toBeInstanceOf(access.BlockedSkillLinkError);
		expect(swap.action).toBeUndefined();
	});

	it("refuses a different file renamed in between the check and the read", async () => {
		swap.target = skill;
		swap.action = () => renameSync(join(outside, "SKILL.md"), skill);
		const result = Promise.resolve().then(() => read(skill, provenance));
		await expect(result).rejects.toBeInstanceOf(access.BlockedSkillLinkError);
		expect(swap.action).toBeUndefined();
	});
});
