import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import { pruneModelBlocks } from "../../../credential-pool/model-scope.ts";
import { accountLimitsFor } from "../../../subscription-limits/limit-summary.ts";
import { type AccountListEntry, describeBlockStatus, formatWhen, renderAccountList } from "../account-list-view.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, timedBlock } from "./account-management.ts";
import type { AccountSlot } from "./accounts.ts";

export type ClaudePinSource = "CLI" | "settings" | "stored";

export interface ClaudeAccountListInput {
	readonly accounts: readonly AccountSlot[];
	readonly pinned: string | undefined;
	readonly pinSource: ClaudePinSource;
	readonly affinityPick: string | undefined;
	readonly affinityError: string | undefined;
	readonly now: number;
}

const PIN_TAG: Record<ClaudePinSource, string> = {
	CLI: "pinned for this session",
	settings: "pinned in settings",
	stored: "pinned",
};

const MANAGE_HINT = "Manage: /claude-account add | pin <id> | unpin | unblock <id> | remove <id>";

function slotStatus(slot: AccountSlot, now: number): string[] {
	// The cadence block of an expired login is the self-heal re-probe, not something the user waits out (senpi#5350).
	const block = timedBlock(slot, now);
	const account =
		slot.store === "claude-cli" && slot.signInRequired === "login_expired"
			? ["sign-in expired; run /login anthropic-subscription"]
			: block.blocked
				? [describeBlockStatus(block, now)]
				: [];
	const models = Object.entries(pruneModelBlocks(slot.modelBlocks, now) ?? {}).map(
		([model, { blockedUntil }]) => `${model} blocked, retry ${formatWhen(blockedUntil, now)}`,
	);
	const states = [...account, ...models];
	return states.length === 0 ? ["available"] : states;
}

/** The `/claude-account` list (senpi#6288): one readable block per account, pin and next turn as tags. */
export function formatClaudeAccountList(input: ClaudeAccountListInput): string {
	const { accounts, pinned, pinSource, affinityPick, affinityError, now } = input;
	const entries = accounts.map((account): AccountListEntry => ({
		label: accountLabel(account),
		tags: [
			...(account.name === pinned ? [PIN_TAG[pinSource]] : []),
			...(account.name === affinityPick ? ["next turn"] : []),
			...(account.source === "env" ? ["from environment"] : []),
		],
		status: slotStatus(account, now),
		limits: accountLimitsFor(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, account.name),
	}));
	const missingPin =
		pinned !== undefined && !accounts.some((account) => account.name === pinned)
			? [`Pinned account: ${pinned} (${pinSource.toLowerCase()}) - not in this list`]
			: [];
	if (entries.length === 0) {
		return renderAccountList(
			"Anthropic Subscription accounts",
			[],
			[...missingPin, "Add one with /claude-account add."],
			now,
		);
	}
	const footer = [
		...missingPin,
		...(affinityError === undefined ? [] : [`Next turn: unavailable - ${affinityError}`]),
		MANAGE_HINT,
	];
	return renderAccountList("Anthropic Subscription accounts", entries, footer, now);
}
