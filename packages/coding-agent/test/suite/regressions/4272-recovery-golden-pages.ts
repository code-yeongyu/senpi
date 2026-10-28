import { FRAGMENT_ENVELOPE_MAX_BYTES, FRAGMENT_MAX_BYTES } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import type { RecoveryCursors } from "../../../src/modes/rpc/compact-recovery-cursor.ts";
import { RecoveryPageRequests } from "../../../src/modes/rpc/compact-recovery-requests.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import { answerRecoveryPage } from "../../../src/modes/rpc/recovery-page-command.ts";
import type { RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { REGENERATE, serialize } from "./4272-recovery-golden-files.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

export const RECOVERY_PAGE_DIRECTORY = "docs/engine-socket/fixtures/recovery-page";

/**
 * The paged component is the session id the token's route names, a ref of 262,164 stored bytes: three pages of D, D
 * and 20 bytes. The 7-unit prefix puts both page boundaries between the two surrogates of a U+1F600, so a decoder must
 * join raw bytes before it decodes UTF-16LE.
 */
export const SESSION_ID_RULE = {
	prefix: "golden/",
	repeat: "\u{1F600}세션/..\\",
	count: 16_384,
	suffix: "end",
} as const;
export const goldenSessionId = (): string =>
	`${SESSION_ID_RULE.prefix}${SESSION_ID_RULE.repeat.repeat(SESSION_ID_RULE.count)}${SESSION_ID_RULE.suffix}`;

const PEER = "golden-peer";
const ADMISSION_ID = "attach-1";

type PageCommand = Parameters<typeof answerRecoveryPage>[2];
export type PageCaseId = (typeof STEPS)[number]["caseId"];

const STEPS = [
	{
		caseId: "first-page",
		kind: "page",
		contractIds: ["R4.B3", "RULING-62", "RULING-69"],
		description: "The first request, no cursor: ordinal 1, offset 0, a full D-byte page and a cursor to continue.",
		requestId: "r-1",
	},
	{
		caseId: "middle-page",
		kind: "page",
		contractIds: ["R4.B3", "RULING-62", "RULING-69"],
		description: "The first page's cursor: ordinal 2, offset D, a full D-byte page and a cursor to continue.",
		requestId: "r-2",
		cursorFrom: "first-page",
	},
	{
		caseId: "last-page",
		kind: "page",
		contractIds: ["R4.B3", "RULING-62", "RULING-69"],
		description: "The middle page's cursor: ordinal 3, offset 2D, the last 20 bytes, complete with a null cursor.",
		requestId: "r-3",
		cursorFrom: "middle-page",
	},
	{
		caseId: "cursor-out-of-range",
		kind: "refusal",
		contractIds: ["R4.B3", "RULING-62", "RULING-70"],
		description:
			"After the last page, the first page's cursor is presented again: its ordinal is behind the token's, refused typed with restart_from_catalog before any read.",
		requestId: "r-4",
		cursorFrom: "first-page",
	},
] as const;

export interface RecoveryPageGoldens {
	readonly files: Map<string, string>;
	readonly responses: ReadonlyMap<PageCaseId, RpcResponse>;
	readonly component: { readonly ref: string; readonly length: number; readonly digest: string };
}

const cursorOf = (response: RpcResponse | undefined): string => {
	if (response?.success !== true || response.command !== "get_recovery_page" || response.data.cursor === null)
		throw new Error("the cursor case answered no cursor");
	return response.data.cursor;
};

function unwrap<T>(outcome: { ok: true; value: T } | { ok: false; failure: unknown }): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

/**
 * Pages the golden component through the real route answer builder (`answerRecoveryPage`) over the real page request
 * owner and checkpoint owner, as the registered peer that holds the token. `cursors` is the owner's cursor minter; the
 * caller fixes its per-process key so the cursors are reproducible.
 */
export async function produceRecoveryPageGoldens(cursors: RecoveryCursors): Promise<RecoveryPageGoldens> {
	const rig = recoveryRig();
	rig.writer.registerConnection(PEER, { writeRaw: () => undefined, waitForBackpressure: () => Promise.resolve() });
	const socketEpoch = rig.writer.socketEpochOf(PEER);
	if (socketEpoch === undefined) throw new Error("the golden peer has no socket epoch");
	const sessionId = goldenSessionId();
	const route: RecoveryRoute = {
		socketEpoch,
		admissionId: ADMISSION_ID,
		routeKind: "ordinary",
		peer: PEER,
		sessionId,
	};
	await rig.lane.idle();
	const { token } = unwrap(rig.checkpoints.freeze(route, rig.lane));
	const responses = new Map<PageCaseId, RpcResponse>();
	const inputs = new Map<PageCaseId, Omit<PageCommand, "sessionId">>();
	let component: RecoveryPageGoldens["component"];
	try {
		const manifest = unwrap(await rig.checkpoints.catalog(token, { socketEpoch, sessionId }));
		if (!("ref" in manifest.session)) throw new Error("the golden session id must be a ref");
		component = manifest.session;
		const pages = new RecoveryPageRequests(rig.checkpoints, cursors);
		for (const [index, step] of STEPS.entries()) {
			const cursor = "cursorFrom" in step ? cursorOf(responses.get(step.cursorFrom)) : undefined;
			const input = {
				id: `page-${index + 1}`,
				type: "get_recovery_page",
				token: token.id,
				admissionId: ADMISSION_ID,
				componentRef: component.ref,
				requestId: step.requestId,
				...(cursor === undefined ? {} : { cursor }),
			} as const;
			const command: PageCommand = { ...input, sessionId };
			responses.set(
				step.caseId,
				await rig.writer.withConnection(PEER, () => answerRecoveryPage(pages, rig.writer, command)),
			);
			inputs.set(step.caseId, input);
		}
	} finally {
		rig.checkpoints.release(token);
		await rig.lane.idle();
		rig.writer.unregisterConnection(PEER);
	}
	const files = new Map<string, string>();
	files.set("index.json", serialize(recoveryPageIndex(socketEpoch, sessionId, component)));
	for (const { caseId, kind, contractIds, description } of STEPS) {
		const input = { command: inputs.get(caseId), sessionId: "index.json session.idRule" };
		const fixture = { caseId, kind, contractIds, description, input, expected: responses.get(caseId) };
		files.set(`${caseId}.json`, serialize(fixture));
	}
	return { files, responses, component };
}

function recoveryPageIndex(socketEpoch: string, sessionId: string, component: RecoveryPageGoldens["component"]) {
	return {
		contract: "CONTRACT-r6",
		section: "B3",
		rulings: ["RULING-57", "RULING-58", "RULING-62", "RULING-68", "RULING-69"],
		encoding:
			"expected is the whole get_recovery_page response envelope. data.bytes is base64 of exactly data.length raw stored bytes at data.offset of the component (its UTF-16LE code units as stored); decode base64 first, then join pages by offset, then decode UTF-16LE.",
		digestRule:
			"data.digest is lowercase hex SHA-256(u8 tagLength || tag || u64be byteLength || bytes) over the raw page bytes with tag 'senpi-recovery-catalog/1/utf16le/fragment'; component.digest is the same rule over the whole component with domain 'leaf'.",
		limits: { D: FRAGMENT_MAX_BYTES, envelope: FRAGMENT_ENVELOPE_MAX_BYTES },
		cursorRule:
			"data.cursor is opaque: present it unchanged as the next request's cursor; it is null once data.complete. Its authenticator is keyed per engine process, so these goldens fix that key in the generator; never parse or construct a cursor.",
		refusalRule:
			"A refusal is success false with error and errorCode 'recovery_<reason>' and errorData {kind, reason, hint}; hint restart_from_catalog means discard the component's pages and request it again without a cursor.",
		inputRule:
			"input.command is the request without sessionId; every case is sent in file order on one session whose id is session.idRule: prefix + repeat x count + suffix.",
		session: {
			socketEpoch,
			admissionId: ADMISSION_ID,
			idRule: SESSION_ID_RULE,
			idCodeUnits: sessionId.length,
		},
		component,
		regenerate: REGENERATE,
		cases: STEPS.map(({ caseId, kind, contractIds }) => ({ caseId, file: `${caseId}.json`, kind, contractIds })),
	};
}
