import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";
import { dataOf, type RawClient, statusHost, type WireRecord } from "../rpc-session-status-support.ts";

vi.mock("node:fs/promises", { spy: true });
const actual = await vi.importActual<typeof fs>("node:fs/promises");

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// RULING-125 (#5285): open_session, attach_session and subscribe_sessions carry an optional `retry: true`. A marked
// retry of a done row answers its stored result, of a live pending id joins the in-flight admission, and of an id the
// socket epoch no longer knows (or never knew) answers admission_unknown and admits nothing. Unmarked requests keep
// their existing duplicate handling; flag-off and legacy peers ignore the field.
const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const KINDS = ["open_session", "attach_session", "subscribe_sessions"] as const;
type Kind = (typeof KINDS)[number];
type Host = Awaited<ReturnType<typeof statusHost>>;

const withoutId = ({ id: _id, ...record }: WireRecord) => record;

async function prepare(host: Host, kind: Kind, compact: boolean): Promise<Record<string, unknown>> {
	if (kind === "open_session") return { type: kind, cwd: host.cwd, sessionPath: join(host.cwd, "retry.jsonl") };
	if (kind === "subscribe_sessions") return { type: kind };
	const owner = host.client("owner");
	const opened = await owner.request({
		type: "open_session",
		cwd: host.cwd,
		sessionPath: join(host.cwd, "attached.jsonl"),
		...(compact ? { admissionId: "owner-open" } : {}),
	});
	const sessionId = String(opened.sessionId);
	const listed = dataOf(await owner.request({ type: "list_sessions" })).sessions;
	if (!Array.isArray(listed)) throw new Error("missing session list");
	const durableSessionId: unknown = listed.find((row) => row.sessionId === sessionId)?.durableSessionId;
	return { type: kind, sessionId, durableSessionId };
}

/** Every producer the admission index starts, by admission id, whatever the command: one producer is one admission. */
function admissionLedger() {
	const run = CompactAdmissions.prototype.run;
	const produced: string[] = [];
	let calls = 0;
	const waiters: { count: number; resolve: () => void }[] = [];
	vi.spyOn(CompactAdmissions.prototype, "run").mockImplementation(function (
		this: CompactAdmissions,
		identity,
		produce,
	) {
		calls++;
		for (const waiter of waiters.filter((entry) => entry.count <= calls)) waiter.resolve();
		return run.call(this, identity, (signal) => {
			produced.push(identity.admissionId);
			return produce(signal);
		});
	});
	const called = (count: number) =>
		count <= calls ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }));
	return { produced, called };
}

/** Holds the next durable `pending` row write, so its admission stays live while another request arrives. */
function holdPendingRow() {
	const written = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let armed = true;
	const writeFile = vi.mocked(fs.writeFile);
	writeFile.mockImplementation(async (...args) => {
		if (armed && String(args[0]).includes("senpi-admissions-") && String(args[1]).includes('"state":"pending"')) {
			armed = false;
			written.resolve();
			await gate.promise;
		}
		return actual.writeFile(...args);
	});
	return { written: written.promise, release: () => gate.resolve() };
}

async function compactHost(): Promise<Host> {
	vi.stubEnv(FLAG, "1");
	return statusHost();
}

async function whilePending(peer: RawClient, body: Record<string, unknown>, extra: Record<string, unknown>) {
	const ledger = admissionLedger();
	const held = holdPendingRow();
	const first = peer.request({ ...body, admissionId: "live" });
	await held.written;
	const second = peer.request({ ...body, admissionId: "live", ...extra });
	await ledger.called(2);
	held.release();
	const answers = await Promise.all([first, second]);
	return { answers, produced: ledger.produced };
}

it.each(KINDS)(
	"RULING-125 %s retry:true on a done row answers its stored result and admits nothing",
	async (kind) => {
		await using host = await compactHost();
		const peer = host.client("peer");
		const body = await prepare(host, kind, true);
		const ledger = admissionLedger();
		const first = await peer.request({ ...body, admissionId: "done" });
		expect(first).toMatchObject({ success: true, admissionId: "done" });
		const retried = await peer.request({ ...body, admissionId: "done", retry: true });
		expect(withoutId(retried)).toEqual(withoutId(first));
		expect(ledger.produced).toEqual(["done"]);
	},
	600_000,
);

it.each(KINDS)(
	"RULING-125 %s retry:true on a live pending id joins the in-flight admission",
	async (kind) => {
		await using host = await compactHost();
		const peer = host.client("peer");
		const body = await prepare(host, kind, true);
		const { answers, produced } = await whilePending(peer, body, { retry: true });
		const [first, retried] = answers;
		expect(first).toMatchObject({ success: true, admissionId: "live" });
		expect(withoutId(retried)).toEqual(withoutId(first));
		expect(produced).toEqual(["live"]);
	},
	600_000,
);

it.each(KINDS)(
	"RULING-125 %s retry:true on a never-seen id answers admission_unknown and admits nothing",
	async (kind) => {
		await using host = await compactHost();
		const peer = host.client("peer");
		const body = await prepare(host, kind, true);
		const ledger = admissionLedger();
		const answer = await peer.request({ ...body, admissionId: "never-seen", retry: true });
		expect(answer).toMatchObject({
			success: false,
			error: "admission_admission_unknown",
			errorData: { kind: "request_refused", reason: "admission_unknown" },
		});
		expect(ledger.produced).toEqual([]);
	},
	600_000,
);

it.each(KINDS)(
	"RULING-125 %s without the marker keeps duplicate handling for a live id",
	async (kind) => {
		await using host = await compactHost();
		const peer = host.client("peer");
		const body = await prepare(host, kind, true);
		const { answers, produced } = await whilePending(peer, body, {});
		const [first, joined] = answers;
		expect(first).toMatchObject({ success: true, admissionId: "live" });
		expect(withoutId(joined)).toEqual(withoutId(first));
		const repeated = await peer.request({ ...body, admissionId: "live" });
		expect(withoutId(repeated)).toEqual(withoutId(first));
		expect(produced).toEqual(["live"]);
	},
	600_000,
);

it.each(
	KINDS.flatMap((kind) => [
		{ kind, flag: "0", extra: { admissionId: "never-seen", retry: true } },
		{ kind, flag: "1", extra: { retry: true } },
	]),
)(
	"RULING-125 flag=$flag $kind: a legacy request ignores retry:true",
	async ({ kind, flag, extra }) => {
		vi.stubEnv(FLAG, flag);
		await using host = await statusHost();
		const peer = host.client("peer");
		const body = await prepare(host, kind, false);
		const plain = await peer.request(body);
		const fresh = kind === "open_session" ? { sessionPath: join(host.cwd, "marked.jsonl") } : {};
		const marked = await peer.request({ ...body, ...fresh, ...extra });
		expect(plain).toMatchObject({ success: true });
		expect(marked).toMatchObject({ success: true });
		expect(marked).not.toHaveProperty("admissionId");
		expect(Object.keys(dataOf(marked)).sort()).toEqual(Object.keys(dataOf(plain)).sort());
	},
	600_000,
);
