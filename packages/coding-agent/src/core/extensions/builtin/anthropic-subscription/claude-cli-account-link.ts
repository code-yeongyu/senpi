import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
export const ACCOUNT_LINK_FILE = ".senpi-account.json";

export type AccountDirLink = {
	readonly dirId: string;
	readonly name: string;
	readonly signedInAt: number;
	readonly displayName?: string;
};

function linkPath(agentDir: string, dirId: string): string {
	return join(accountDirFor(agentDir, dirId), ACCOUNT_LINK_FILE);
}

export function writeAccountLink(agentDir: string, link: AccountDirLink): void {
	const record = {
		name: link.name,
		signedInAt: link.signedInAt,
		...(link.displayName === undefined ? {} : { displayName: link.displayName }),
	};
	writeFileSync(linkPath(agentDir, link.dirId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function parseLink(dirId: string, text: string): AccountDirLink | undefined {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { name, signedInAt, displayName } = parsed as { name?: unknown; signedInAt?: unknown; displayName?: unknown };
	if (typeof name !== "string" || typeof signedInAt !== "number") return undefined;
	return { dirId, name, signedInAt, ...(typeof displayName === "string" ? { displayName } : {}) };
}

function readLink(agentDir: string, dirId: string): AccountDirLink | undefined {
	try {
		return parseLink(dirId, readFileSync(linkPath(agentDir, dirId), "utf8"));
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
export function renameAccountLink(agentDir: string, slot: AccountSlot | undefined): void {
	if (slot?.store !== "claude-cli" || !isValidAccountDirId(slot.dirId)) return;
	const link = readLink(agentDir, slot.dirId);
	if (link === undefined || link.name !== slot.name) return;
	const { displayName: _previous, ...rest } = link;
	writeAccountLink(agentDir, slot.displayName === undefined ? rest : { ...rest, displayName: slot.displayName });
}

export function readAccountLinks(agentDir: string): AccountDirLink[] {
	let dirIds: string[];
	try {
		dirIds = readdirSync(join(agentDir, "anthropic-subscription-claude"));
	} catch {
		return [];
	}
	return dirIds.filter(isValidAccountDirId).flatMap((dirId) => {
		const link = readLink(agentDir, dirId);
		return link === undefined ? [] : [link];
	});
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
 * elsewhere keeps its dir. Of several dirs recording one name, the newest sign-in wins.
 */
export function relinkAccountDirs(accounts: readonly AccountSlot[], links: readonly AccountDirLink[]): AccountSlot[] {
	const pending = newestUnreferenced(links, accounts);
	const relinked = accounts.map((slot) => {
		const link = pending.get(slot.name);
		if (link === undefined) return slot;
		pending.delete(slot.name);
		return slot.store === "claude-cli" && slot.signInRequired === undefined ? slot : relinkedSlot(slot, link);
	});
	return [...relinked, ...[...pending.values()].map((link) => relinkedSlot(undefined, link))];
}
