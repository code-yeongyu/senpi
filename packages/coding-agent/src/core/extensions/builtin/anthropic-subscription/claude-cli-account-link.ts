import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountSlot, ClaudeCliAccountSlot } from "./accounts.ts";
import { accountDirFor, isValidAccountDirId } from "./claude-cli-account-dir.ts";

/**
 * The record a signed-in account dir keeps of the account that owns it (senpi#5594): the slot name and when it signed
 * in, never a token. auth.json alone cannot be trusted to keep that link: an engine from before senpi#4436 that is
 * still running writes its own copy of the entry back over the Claude CLI slots, and the dirs that hold the working
 * logins are then referenced by nothing. The record lives inside the dir, so removing the dir (sign-out, a cancelled
 * login, a re-login retiring its old dir) removes the record with it.
 */
const ACCOUNT_LINK_FILE = ".senpi-account.json";

type AccountDirLink = {
	readonly dirId: string;
	readonly name: string;
	readonly signedInAt: number;
	readonly displayName?: string;
};

function linkPath(agentDir: string, dirId: string): string {
	return join(accountDirFor(agentDir, dirId), ACCOUNT_LINK_FILE);
}

export async function writeAccountLink(agentDir: string, link: AccountDirLink): Promise<void> {
	const record = {
		name: link.name,
		signedInAt: link.signedInAt,
		...(link.displayName === undefined ? {} : { displayName: link.displayName }),
	};
	await writeFile(linkPath(agentDir, link.dirId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function parseLink(dirId: string, text: string): AccountDirLink | undefined {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { name, signedInAt, displayName } = parsed as { name?: unknown; signedInAt?: unknown; displayName?: unknown };
	if (typeof name !== "string" || typeof signedInAt !== "number") return undefined;
	return { dirId, name, signedInAt, ...(typeof displayName === "string" ? { displayName } : {}) };
}

async function readLink(agentDir: string, dirId: string): Promise<AccountDirLink | undefined> {
	try {
		return parseLink(dirId, await readFile(linkPath(agentDir, dirId), "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * A rename or clear-name of a signed-in Claude CLI account rewrites its dir's record with the new display name. The
 * caller runs it inside the auth.json lock of the rename, so the record and the slot change together and a later
 * re-link restores the name the user chose, not the one a stale writer still holds. A slot without a recorded dir
 * (signed out, never signed in on this engine) has nothing to rewrite.
 */
export async function renameAccountLink(agentDir: string, slot: AccountSlot | undefined): Promise<void> {
	if (slot?.store !== "claude-cli" || !isValidAccountDirId(slot.dirId)) return;
	const link = await readLink(agentDir, slot.dirId);
	if (link === undefined || link.name !== slot.name) return;
	const { displayName: _previous, ...rest } = link;
	await writeAccountLink(agentDir, slot.displayName === undefined ? rest : { ...rest, displayName: slot.displayName });
}

async function isAccountDir(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Gives every signed-in Claude CLI account whose dir has no record one, at load (senpi#5594): accounts signed in
 * before records existed are otherwise left without the link that lets a stale writer's drop be undone. Only a
 * healthy slot whose dir is a real dir is recorded; a signed-out slot owns no login yet. Returns the accounts whose
 * record could not be written, so the caller can report them.
 */
export async function backfillAccountLinks(agentDir: string, accounts: readonly AccountSlot[]): Promise<string[]> {
	const unrecorded = await Promise.all(
		accounts.map(async (slot) => {
			if (slot.store !== "claude-cli" || slot.signInRequired !== undefined || !isValidAccountDirId(slot.dirId))
				return [];
			if (!(await isAccountDir(accountDirFor(agentDir, slot.dirId)))) return [];
			if ((await readLink(agentDir, slot.dirId)) !== undefined) return [];
			try {
				await writeAccountLink(agentDir, {
					dirId: slot.dirId,
					name: slot.name,
					signedInAt: slot.signedInAt ?? 0,
					...(slot.displayName === undefined ? {} : { displayName: slot.displayName }),
				});
				return [];
			} catch {
				return [slot.name];
			}
		}),
	);
	return unrecorded.flat();
}

async function readAccountLinks(agentDir: string): Promise<AccountDirLink[]> {
	let dirIds: string[];
	try {
		dirIds = await readdir(join(agentDir, "anthropic-subscription-claude"));
	} catch {
		return [];
	}
	const links = await Promise.all(
		dirIds
			.filter(isValidAccountDirId)
			.sort()
			.map((dirId) => readLink(agentDir, dirId)),
	);
	return links.flatMap((link) => (link === undefined ? [] : [link]));
}

function newestUnreferenced(
	links: readonly AccountDirLink[],
	accounts: readonly AccountSlot[],
): Map<string, AccountDirLink> {
	const referenced = new Set(accounts.flatMap((slot) => (slot.store === "claude-cli" ? [slot.dirId] : [])));
	const byName = new Map<string, AccountDirLink>();
	for (const link of links) {
		if (referenced.has(link.dirId)) continue;
		const held = byName.get(link.name);
		const newer =
			held === undefined ||
			link.signedInAt > held.signedInAt ||
			(link.signedInAt === held.signedInAt && link.dirId < held.dirId);
		if (newer) byName.set(link.name, link);
	}
	return byName;
}

function relinkedSlot(slot: AccountSlot | undefined, link: AccountDirLink): ClaudeCliAccountSlot {
	return {
		name: link.name,
		...(link.displayName === undefined ? {} : { displayName: link.displayName }),
		source: "login",
		store: "claude-cli",
		dirId: link.dirId,
		signedInAt: link.signedInAt,
		...(slot?.modelBlocks === undefined ? {} : { modelBlocks: slot.modelBlocks }),
	};
}

/**
 * The accounts after an old-format writer replaced the entry (senpi#5594): each signed-in account dir that no slot
 * references takes back its account. A slot of that name that must sign in again points at the dir again and keeps
 * its model blocks; a missing account is appended. The display name comes from the record, which every rename
 * rewrites, so a stale writer's older label never wins. A healthy slot of that name already signed in
 * elsewhere keeps its dir. Of several dirs recording one name, the newest sign-in wins. Returns `accounts` itself
 * when nothing was re-linked, so the caller writes nothing.
 */
function relinkAccountDirs(accounts: AccountSlot[], links: readonly AccountDirLink[]): AccountSlot[] {
	const pending = newestUnreferenced(links, accounts);
	let changed = false;
	const relinked = accounts.map((slot) => {
		const link = pending.get(slot.name);
		if (link === undefined) return slot;
		pending.delete(slot.name);
		if (slot.store === "claude-cli" && slot.signInRequired === undefined) return slot;
		changed = true;
		return relinkedSlot(slot, link);
	});
	if (!changed && pending.size === 0) return accounts;
	return [...relinked, ...[...pending.values()].map((link) => relinkedSlot(undefined, link))];
}

/**
 * Undoes a stale writer's drop (senpi#5594). Only an engine from before senpi#4436 writes a token slot, and the load
 * seam signs every such slot out as `legacy_sign_in_retired`; while one is left, the dirs that write left unreferenced
 * take their accounts back. The marker is in auth.json, so the re-link still runs when the load that signed the slots
 * out could not read the account dirs (the synchronous first load) or the process stopped before it did. Without that
 * marker nothing is read and nothing is re-linked, so an account removed on purpose is never resurrected.
 */
export async function relinkAfterStaleWrite(agentDir: string, accounts: AccountSlot[]): Promise<AccountSlot[]> {
	const signedOut = accounts.some(
		(slot) => slot.store === "claude-cli" && slot.signInRequired === "legacy_sign_in_retired",
	);
	return signedOut ? relinkAccountDirs(accounts, await readAccountLinks(agentDir)) : accounts;
}
