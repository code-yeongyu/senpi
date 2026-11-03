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
};

export function writeAccountLink(agentDir: string, link: AccountDirLink): void {
	const record = { name: link.name, signedInAt: link.signedInAt };
	writeFileSync(join(accountDirFor(agentDir, link.dirId), ACCOUNT_LINK_FILE), `${JSON.stringify(record)}\n`, {
		mode: 0o600,
	});
}

function parseLink(dirId: string, text: string): AccountDirLink | undefined {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { name, signedInAt } = parsed as { name?: unknown; signedInAt?: unknown };
	if (typeof name !== "string" || typeof signedInAt !== "number") return undefined;
	return { dirId, name, signedInAt };
}

export function readAccountLinks(agentDir: string): AccountDirLink[] {
	let dirIds: string[];
	try {
		dirIds = readdirSync(join(agentDir, "anthropic-subscription-claude"));
	} catch {
		return [];
	}
	return dirIds.filter(isValidAccountDirId).flatMap((dirId) => {
		try {
			const link = parseLink(dirId, readFileSync(join(accountDirFor(agentDir, dirId), ACCOUNT_LINK_FILE), "utf8"));
			return link === undefined ? [] : [link];
		} catch {
			return [];
		}
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
		...(slot?.displayName === undefined ? {} : { displayName: slot.displayName }),
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
 * its display name and model blocks; a missing account is appended. A healthy slot of that name already signed in
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
