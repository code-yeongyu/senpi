import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";

const root = await mkdtemp(join(tmpdir(), "senpi-task18-skills-"));
const agentDir = join(root, "agent");
const validCwd = join(root, "valid");
const missingCwd = join(root, "missing");
const skillFile = join(validCwd, ".senpi", "skills", "fixture-skill", "SKILL.md");
const sent: unknown[] = [];

try {
	await mkdir(join(validCwd, ".senpi", "skills", "fixture-skill"), { recursive: true });
	await writeFixture("first description");

	const core = new ServerCore({ codexHome: agentDir, serverCwd: validCwd, version: "qa" });
	const connection = core.addConnection({
		id: "task18-skills-list",
		transportKind: "stdio",
		send: (message) => {
			sent.push(message);
		},
		close: () => undefined,
	});

	await core.receive(connection.id, {
		kind: "request",
		message: {
			id: 1,
			method: "initialize",
			params: {
				clientInfo: { name: "qa", title: "QA", version: "0.0.1" },
				capabilities: { experimentalApi: true, requestAttestation: false },
			},
		},
	});
	await core.receive(connection.id, {
		kind: "request",
		message: { id: 2, method: "skills/list", params: { cwds: [missingCwd, validCwd] } },
	});

	const first = skillsResult(sent[1]);
	const badEntry = first.data[0];
	const validEntry = first.data[1];
	const badCwdIsolated =
		badEntry?.cwd === missingCwd && badEntry.skills.length === 0 && badEntry.errors.length > 0 ? 1 : 0;
	const skillFound = validEntry?.skills.some((skill) => skill.name === "fixture-skill" && skill.enabled) ? 1 : 0;

	await writeFixture("second description");
	await core.receive(connection.id, {
		kind: "request",
		message: { id: 3, method: "skills/list", params: { cwds: [validCwd] } },
	});
	await core.receive(connection.id, {
		kind: "request",
		message: { id: 4, method: "skills/list", params: { cwds: [validCwd], forceReload: true } },
	});
	const cached = skillsResult(sent[2]).data[0]?.skills[0]?.description;
	const reloaded = skillsResult(sent[3]).data[0]?.skills[0]?.description;
	const forceReloadHonored = cached === "first description" && reloaded === "second description" ? 1 : 0;

	console.log(`CWD_ENTRIES=${first.data.length}`);
	console.log(`BAD_CWD_ISOLATED=${badCwdIsolated}`);
	console.log(`SKILL_FOUND=${skillFound}`);
	console.log(`FORCE_RELOAD=${forceReloadHonored}`);
	console.log("EXIT=0");
	if (first.data.length !== 2 || badCwdIsolated !== 1 || skillFound !== 1 || forceReloadHonored !== 1) {
		throw new Error("task18 skills/list assertions failed");
	}
} finally {
	await rm(root, { recursive: true, force: true });
}

async function writeFixture(description: string): Promise<void> {
	await writeFile(skillFile, `---\nname: fixture-skill\ndescription: ${description}\n---\n\nFixture skill.\n`, "utf8");
}

type SkillResult = {
	readonly data: readonly SkillEntry[];
};

type SkillEntry = {
	readonly cwd: string;
	readonly skills: readonly SkillRecord[];
	readonly errors: readonly SkillError[];
};

type SkillRecord = {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly scope: string;
	readonly enabled: boolean;
};

type SkillError = { readonly path: string; readonly message: string };

function skillsResult(value: unknown): SkillResult {
	if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.data)) {
		throw new Error(`skills/list did not return a result: ${JSON.stringify(value)}`);
	}
	const data = value.result.data.filter(isSkillEntry);
	if (data.length !== value.result.data.length) throw new Error("skills/list entry shape is invalid");
	return { data };
}

function isSkillEntry(value: unknown): value is SkillEntry {
	return (
		isRecord(value) &&
		typeof value.cwd === "string" &&
		Array.isArray(value.skills) &&
		value.skills.every(isSkillRecord) &&
		Array.isArray(value.errors) &&
		value.errors.every(isSkillError)
	);
}

function isSkillRecord(value: unknown): value is SkillRecord {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		typeof value.path === "string" &&
		typeof value.scope === "string" &&
		typeof value.enabled === "boolean"
	);
}

function isSkillError(value: unknown): value is SkillError {
	return isRecord(value) && typeof value.path === "string" && typeof value.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
