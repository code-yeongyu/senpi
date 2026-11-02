import { randomBytes } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import { FRAGMENT_ENVELOPE_MAX_BYTES, FRAGMENT_MAX_BYTES } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { RecoveryCursors } from "../../../src/modes/rpc/compact-recovery-cursor.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";
import { committedGoldens, readGolden } from "./4272-recovery-golden-files.ts";
import {
	goldenSessionId,
	type PageCaseId,
	RECOVERY_PAGE_DIRECTORY,
	type RecoveryPageGoldens,
	produceRecoveryPageGoldens,
} from "./4272-recovery-golden-pages.ts";

// Part of #4272 (SF2, desktop RULING-68/68a, R4.B3, RULING-62/69): the shared get_recovery_page goldens the desktop
// decoder (D04) tests against. Every file is the real route answer builder's output over the real page request and
// checkpoint owners; a producer change fails here byte-for-byte until the goldens are regenerated on purpose.

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

/** The cursor authenticator's per-process key, fixed for this file only so the minted cursors are reproducible. */
const CURSOR_TEST_KEY = Buffer.alloc(32, 0x5f);
const CASE_IDS: readonly PageCaseId[] = ["first-page", "middle-page", "last-page", "cursor-out-of-range"];

interface PageCase {
	readonly caseId: string;
	readonly kind: "page" | "refusal";
	readonly input: { readonly command: Record<string, unknown>; readonly sessionId: string };
	readonly expected: {
		readonly success: boolean;
		readonly data: {
			readonly ordinal: number;
			readonly offset: number;
			readonly length: number;
			readonly digest: string;
			readonly bytes: string;
			readonly cursor: string | null;
			readonly complete: boolean;
		};
	};
}

let goldens: RecoveryPageGoldens;

beforeAll(async () => {
	vi.mocked(randomBytes).mockReturnValueOnce(CURSOR_TEST_KEY as never);
	const cursors = new RecoveryCursors();
	expect(randomBytes).toHaveBeenLastCalledWith(32);
	goldens = await produceRecoveryPageGoldens(cursors);
});

const readCase = (caseId: string): PageCase => readGolden<PageCase>(RECOVERY_PAGE_DIRECTORY, `${caseId}.json`);

it("SF2 the committed recovery-page files are byte-identical to the real producer's output and nothing else is there", () => {
	const committed = committedGoldens(RECOVERY_PAGE_DIRECTORY, goldens.files);
	expect([...committed.keys()]).toEqual([...goldens.files.keys()].sort());
	for (const [name, content] of goldens.files) expect(committed.get(name), name).toBe(content);
});

it.each(CASE_IDS)("SF2 %s: answerRecoveryPage emits exactly the golden envelope bytes", (caseId) => {
	const produced = goldens.responses.get(caseId);
	expect(produced).toBeDefined();
	expect(JSON.stringify(produced)).toBe(JSON.stringify(readCase(caseId).expected));
});

it("SF2 index.json names the cases, the session rule and the component the pages reassemble", () => {
	const index = readGolden<Record<string, unknown>>(RECOVERY_PAGE_DIRECTORY, "index.json");
	expect(index).toMatchObject({
		contract: "CONTRACT-r6",
		section: "B3",
		limits: { D: FRAGMENT_MAX_BYTES, envelope: FRAGMENT_ENVELOPE_MAX_BYTES },
		session: { socketEpoch: "socket-1", admissionId: "attach-1", idCodeUnits: goldenSessionId().length },
		component: goldens.component,
	});
	expect(index.cases).toEqual(
		CASE_IDS.map((caseId) => ({
			caseId,
			file: `${caseId}.json`,
			kind: caseId === "cursor-out-of-range" ? "refusal" : "page",
			contractIds: expect.arrayContaining(["R4.B3", "RULING-62"]),
		})),
	);
});

it("SF2 a decoder written from index.json's rules reassembles the component byte-exactly; each digest holds per spec", () => {
	const stored = Buffer.from(goldenSessionId(), "utf16le");
	expect(stored.length).toBe(goldens.component.length);
	expect(specDigest("leaf", stored)).toBe(goldens.component.digest);
	const pages = (["first-page", "middle-page", "last-page"] as const).map((caseId) => readCase(caseId).expected);
	const D = FRAGMENT_MAX_BYTES;
	expect(pages.map(({ data }) => [data.ordinal, data.offset, data.length, data.complete])).toEqual([
		[1, 0, D, false],
		[2, D, D, false],
		[3, 2 * D, stored.length - 2 * D, true],
	]);
	expect(stored.length - 2 * D).toBe(20);
	const raw = pages.map(({ success, data }) => {
		expect(success).toBe(true);
		expect(data.bytes.length).toBeLessThanOrEqual(FRAGMENT_ENVELOPE_MAX_BYTES);
		const bytes = Buffer.from(data.bytes, "base64");
		expect(bytes.length).toBe(data.length);
		expect(specDigest("fragment", bytes), "the page digest is over the decoded raw bytes").toBe(data.digest);
		expect(data.cursor === null).toBe(data.complete);
		return bytes;
	});
	expect(Buffer.concat(raw).equals(stored)).toBe(true);
	const [first, middle] = raw;
	expect([...(first?.subarray(-2) ?? [])], "page 1 ends with the high surrogate of U+1F600").toEqual([0x3d, 0xd8]);
	expect([...(middle?.subarray(0, 2) ?? [])], "page 2 starts with its low surrogate").toEqual([0x00, 0xde]);
});

it("SF2 the refusal golden replays the first page's cursor and is the typed cursor_out_of_range envelope", () => {
	const refusal = readCase("cursor-out-of-range");
	expect(refusal.input.command.cursor).toBe(readCase("first-page").expected.data.cursor);
	expect(refusal.expected).toEqual({
		id: "page-4",
		type: "response",
		command: "get_recovery_page",
		success: false,
		error: "recovery_cursor_out_of_range",
		errorCode: "recovery_cursor_out_of_range",
		errorData: { kind: "request_refused", reason: "cursor_out_of_range", hint: "restart_from_catalog" },
	});
});

it("SF2 the cursors are opaque bounded ids of the p1 grammar, and each page presents the previous page's cursor", () => {
	const [first, middle, last] = (["first-page", "middle-page", "last-page"] as const).map(readCase);
	expect(first?.input.command.cursor).toBeUndefined();
	expect(middle?.input.command.cursor).toBe(first?.expected.data.cursor);
	expect(last?.input.command.cursor).toBe(middle?.expected.data.cursor);
	expect(first?.expected.data.cursor).toMatch(/^p1:1:131072:[0-9a-f]{32}$/);
	expect(middle?.expected.data.cursor).toMatch(/^p1:2:262144:[0-9a-f]{32}$/);
	expect(last?.expected.data.cursor).toBeNull();
});
