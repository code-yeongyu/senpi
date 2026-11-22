/**
 * Shared rig for the `move_session` inline-bundle suites (senpi#6267): a session with one sidecar, released and exported
 * by device A for a move device B readied, and the readers both suites judge the result with.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, move, type Rig } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

export interface InlineFile {
	readonly path: string;
	readonly sha256: string;
	readonly base64: string;
}

export const SESSION_FILE = "files/session.jsonl";
export const SIDECAR_FILE = `files/extensions/goal/${SESSION_ID}.json`;
export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const bytesOf = (file: InlineFile) => Buffer.from(file.base64, "base64");
export const inlineFile = (path: string, bytes: Buffer): InlineFile => ({
	path,
	sha256: sha256(bytes),
	base64: bytes.toString("base64"),
});
/** The same entry with other bytes under the sha256 it was sent with. */
export const changed = (file: InlineFile): InlineFile => ({
	...file,
	base64: Buffer.concat([bytesOf(file), Buffer.from("changed in transit")]).toString("base64"),
});
export const inlineOf = (reply: Record<string, unknown>) =>
	(reply.data as { inline_files?: InlineFile[] }).inline_files ?? [];

/** The same bundle with `extra` sent and listed in its manifest as sidecars, so only a rule about paths can refuse them. */
export function withListed(files: readonly InlineFile[], ...extra: InlineFile[]): InlineFile[] {
	const manifest = files.find((file) => file.path === "manifest.json");
	if (manifest === undefined) throw new Error("the bundle has no manifest");
	const listed = JSON.parse(bytesOf(manifest).toString("utf8")) as { sidecars: Array<Omit<InlineFile, "base64">> };
	listed.sidecars.push(...extra.map(({ path, sha256: sum }) => ({ path, sha256: sum })));
	const rewritten = inlineFile("manifest.json", Buffer.from(`${JSON.stringify(listed)}\n`));
	return [rewritten, ...files.filter((file) => file !== manifest), ...extra];
}

/** Every file under `dir`, by its `/`-separated path inside it. */
export function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort();
}

export interface ExportedMove {
	readonly fixture: Awaited<ReturnType<typeof devices>>;
	readonly a: Rig;
	readonly b: Rig;
	/** Exports the same move again with other fields. */
	readonly again: (more: Record<string, unknown>) => Promise<Record<string, unknown>>;
	readonly reply: Record<string, unknown>;
}

/** B readies the move and A releases and exports the fixture's session (with one sidecar) for it. */
export async function exported(
	moveId: string,
	fields: Record<string, unknown> = { inline: true },
	extraBytes = 0,
): Promise<ExportedMove> {
	const fixture = await devices();
	const sidecar = join(dirname(fixture.sessionPath), "extensions", "goal", `${SESSION_ID}.json`);
	mkdirSync(dirname(sidecar), { recursive: true });
	writeFileSync(sidecar, '{"goal":"ship"}\n');
	if (extraBytes > 0) {
		const big = { role: "user", content: "x".repeat(extraBytes), timestamp: 2 };
		const line = { type: "message", id: "u2", parentId: "u1", timestamp: "2026-10-19T00:00:02.000Z", message: big };
		appendFileSync(fixture.sessionPath, `${JSON.stringify(line)}\n`);
	}
	const a = createInProcessRig(fixture.agentA);
	const b = createInProcessRig(fixture.agentB);
	await move(b, { op: "prepare", moveId });
	await hostAndRelease(a, fixture.repoA, fixture.sessionPath, moveId);
	const again = (more: Record<string, unknown>) =>
		move(a, { op: "export", sessionPath: fixture.sessionPath, moveId, target: "device-b", ...more });
	return { fixture, a, b, again, reply: await again(fields) };
}

/** What B holds for the move besides its ledger: a refused or finished inline import leaves nothing staged. */
export const stagedOn = (agentDir: string) =>
	filesUnder(join(agentDir, "session-moves")).filter((path) => !path.startsWith("ledger/"));

export const landedOn = (fixture: Awaited<ReturnType<typeof devices>>) =>
	join(getDefaultSessionDir(fixture.repoB, fixture.agentB), basename(fixture.sessionPath));
