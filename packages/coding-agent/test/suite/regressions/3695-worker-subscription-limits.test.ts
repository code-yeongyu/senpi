/**
 * senpi#3695: a session on the worker runtime reads the same subscription limit records as an in-process one.
 * The host's poller feeds only the host's store; each isolate holds its own copy, so the host mirrors its
 * records into the worker (and the worker's turn reports back). Driven through the REAL worker registry.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import {
	type MirroredLimits,
	SubscriptionLimitStore,
	subscriptionLimits,
} from "../../../src/core/subscription-limits/limit-store.ts";
import { WorkerSessionRegistry } from "../../../src/modes/rpc/worker-session-registry.ts";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

it("a worker-runtime session reads the host's polled limits before its first turn", async () => {
	const host = await startWorkerHost();
	const out = join(host.scratch, "limits.json");
	const extension = join(host.scratch, "read-limits.mjs");
	await writeFile(
		extension,
		`import { writeFileSync } from "node:fs";
export default function (pi) {
	writeFileSync(${JSON.stringify(out)}, JSON.stringify(pi.getSubscriptionLimits()));
}`,
	);
	const account = `worker-3695-${process.pid}`;
	subscriptionLimits.report("anthropic-subscription", account, {
		windows: [{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 41 }],
		plan: "max",
		reportedAt: new Date("2026-10-23T10:00:00Z"),
	});
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs([
				"--mode",
				"rpc",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--extension",
				extension,
			]),
			cwd: host.cwd,
			agentDir: join(host.scratch, "agent"),
			appMode: "rpc",
		},
		closeGraceMs: 1000,
		now: Date.now,
	});
	let sessionId: string | undefined;
	try {
		const opened = await registry.openSession({ cwd: host.cwd });
		sessionId = opened.sessionId;
		const seen = JSON.parse(await readFile(out, "utf8")) as { account: string; plan?: string }[];

		expect(seen.find((limits) => limits.account === account)).toMatchObject({
			provider: "anthropic-subscription",
			plan: "max",
			windows: [{ id: "claude:5h", usedPercent: 41 }],
		});
	} finally {
		if (sessionId) await registry.close(sessionId).catch(() => undefined);
		await host.dispose();
	}
}, 60_000);

it("a mirrored record that comes straight back is not published again", () => {
	const store = new SubscriptionLimitStore();
	const published: string[] = [];
	store.subscribe((limits) => published.push(limits.reportedAt));
	const record = {
		provider: "anthropic-subscription",
		account: "work",
		windows: [{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 12 }],
		reportedAt: "2026-10-23T10:00:00.000Z",
	};

	store.adopt(record);
	store.adopt({ ...record });
	store.adopt({ ...record, reportedAt: "2026-10-23T09:00:00.000Z" });

	expect(published).toEqual(["2026-10-23T10:00:00.000Z"]);
});

// Two different records with the same reportedAt (report() keeps the previous reportedAt when only the
// error changes) must settle on one value whatever order they arrive in, or host and worker bounce them.
const tiedErrors = () => {
	const base = {
		provider: "anthropic-subscription",
		account: "work",
		windows: [{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 12 }],
		reportedAt: "2026-10-23T10:00:00.000Z",
	};
	return [
		{ ...base, error: "rate limited" },
		{ ...base, error: "sign-in needed" },
	] as const;
};

it("records tied on reportedAt settle on the same value in either arrival order", () => {
	const [first, second] = tiedErrors();
	const forward = new SubscriptionLimitStore();
	const backward = new SubscriptionLimitStore();

	forward.adopt(first);
	forward.adopt(second);
	backward.adopt(second);
	backward.adopt(first);

	expect(forward.snapshot()).toEqual(backward.snapshot());
});

it("a crossed pair of tied records between two mirrored stores stops echoing", () => {
	const [first, second] = tiedErrors();
	const host = new SubscriptionLimitStore();
	const worker = new SubscriptionLimitStore();
	const toWorker: (typeof first | typeof second)[] = [];
	const toHost: (typeof first | typeof second)[] = [];
	host.subscribeMirror((limits) => toWorker.push(structuredClone(limits) as typeof first));
	worker.subscribeMirror((limits) => toHost.push(structuredClone(limits) as typeof first));

	host.adopt(first);
	host.adopt(second);
	let deliveries = 0;
	while ((toWorker.length > 0 || toHost.length > 0) && deliveries < 100) {
		const next = toWorker.shift();
		if (next !== undefined) worker.adopt(next);
		const back = toHost.shift();
		if (back !== undefined) host.adopt(back);
		deliveries += 1;
	}

	expect(deliveries).toBeLessThan(100);
	expect(host.snapshot()).toEqual(worker.snapshot());
});

// report() keeps the previous reportedAt when only the error changes, so the changed record ties with the
// one it replaces. A worker mirroring the host must still take that newer record (senpi#3695 review).
it.each([
	["no error -> an error", [undefined, "sign-in needed"]],
	["one error -> another", ["sign-in needed", "rate limited"]],
	["the reverse error change", ["rate limited", "sign-in needed"]],
] as const)("a worker mirroring the host sees the newer poll result (%s)", (_label, [before, after]) => {
	const host = new SubscriptionLimitStore();
	const worker = new SubscriptionLimitStore();
	host.subscribeMirror((limits) => worker.adopt(structuredClone(limits)));
	const windows = [{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 12 }];
	host.report("anthropic-subscription", "work", { windows, reportedAt: new Date("2026-10-23T10:00:00Z") });
	if (before !== undefined) {
		host.report("anthropic-subscription", "work", { error: before, reportedAt: new Date("2026-10-23T10:02:30Z") });
	}
	host.report("anthropic-subscription", "work", { error: after, reportedAt: new Date("2026-10-23T10:05:00Z") });

	expect(worker.snapshot()).toEqual(host.snapshot());
	expect(worker.snapshot()[0]?.error).toBe(after);
});

// senpi#3695 (third review): one total order for every write path, so mirrored stores converge for ANY pair.
const at = (time: string) => `2026-10-23T10:00:${time}.000Z`;
const base = {
	provider: "anthropic-subscription",
	account: "work",
	windows: [{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 12 }],
};
const candidates: MirroredLimits[] = [
	{ ...base, reportedAt: at("00") },
	{ ...base, reportedAt: at("00"), error: "sign-in needed" },
	{ ...base, reportedAt: at("00"), error: "rate limited" },
	{ ...base, reportedAt: at("00"), error: "rate limited", updatedAt: at("05") },
	{ ...base, reportedAt: at("05") },
	{ ...base, reportedAt: at("05"), plan: "max" },
	{ ...base, reportedAt: at("05"), windows: [{ ...base.windows[0], usedPercent: 40 }] },
	{ ...base, reportedAt: at("00"), updatedAt: at("05"), error: "sign-in needed" },
];

function mirrorPair(): { host: SubscriptionLimitStore; worker: SubscriptionLimitStore; settle: () => number } {
	const host = new SubscriptionLimitStore();
	const worker = new SubscriptionLimitStore();
	const toWorker: MirroredLimits[] = [];
	const toHost: MirroredLimits[] = [];
	host.subscribeMirror((limits) => toWorker.push(structuredClone(limits)));
	worker.subscribeMirror((limits) => toHost.push(structuredClone(limits)));
	const settle = () => {
		let deliveries = 0;
		while ((toWorker.length > 0 || toHost.length > 0) && deliveries < 100) {
			const next = toWorker.shift();
			if (next !== undefined) worker.adopt(next);
			const back = toHost.shift();
			if (back !== undefined) host.adopt(back);
			deliveries += 1;
		}
		return deliveries;
	};
	return { host, worker, settle };
}

it("any two records, adopted on opposite sides and crossing, settle on one record with no loop", () => {
	for (const first of candidates) {
		for (const second of candidates) {
			const { host, worker, settle } = mirrorPair();
			host.adopt(first);
			worker.adopt(second);

			expect(settle()).toBeLessThan(100);
			expect(worker.mirrorSnapshot()).toEqual(host.mirrorSnapshot());
		}
	}
});

it.each([
	["windows then an error in the same millisecond", at("00"), at("00")],
	["windows then an error later", at("00"), at("05")],
])("host reports mirrored into a worker converge (%s)", (_label, windowsAt, errorAt) => {
	const { host, worker, settle } = mirrorPair();
	host.report("anthropic-subscription", "work", { windows: base.windows, reportedAt: new Date(windowsAt) });
	host.report("anthropic-subscription", "work", { error: "sign-in needed", reportedAt: new Date(errorAt) });

	expect(settle()).toBeLessThan(100);
	expect(worker.mirrorSnapshot()).toEqual(host.mirrorSnapshot());
});

it("the ordering key never reaches the public shape", () => {
	const store = new SubscriptionLimitStore();
	const heard: object[] = [];
	store.subscribe((limits) => heard.push(limits));
	store.report("anthropic-subscription", "work", { windows: base.windows, reportedAt: new Date(at("00")) });
	store.report("anthropic-subscription", "work", { error: "sign-in needed", reportedAt: new Date(at("05")) });

	expect(store.mirrorSnapshot()[0]).toHaveProperty("updatedAt", at("05"));
	for (const record of [...store.snapshot(), ...heard]) {
		expect(record).not.toHaveProperty("updatedAt");
		expect(record).not.toHaveProperty("revision");
	}
});

// senpi#3695 (fourth review): a same-instant local write must never make a real poll result look older.
it("a poll result in the same millisecond as a turn's record still lands and reaches the mirror", () => {
	const { host, worker, settle } = mirrorPair();
	const instant = new Date(at("00"));
	host.report("anthropic-subscription", "work", { windows: base.windows, reportedAt: instant });
	host.record("anthropic-subscription", "work", [{ ...base.windows[0], usedPercent: 20 }], instant);
	host.record("anthropic-subscription", "work", [{ ...base.windows[0], usedPercent: 21 }], instant);
	host.report("anthropic-subscription", "work", { error: "sign-in needed", reportedAt: instant });

	expect(settle()).toBeLessThan(100);
	expect(host.snapshot()[0]?.error).toBe("sign-in needed");
	expect(worker.mirrorSnapshot()).toEqual(host.mirrorSnapshot());
});

it("local writes on both stores while copies are in flight still converge", () => {
	const writes: ((store: SubscriptionLimitStore) => void)[] = [
		(store) =>
			store.record("anthropic-subscription", "work", [{ ...base.windows[0], usedPercent: 30 }], new Date(at("00"))),
		(store) =>
			store.record("anthropic-subscription", "work", [{ ...base.windows[0], usedPercent: 31 }], new Date(at("00"))),
		(store) =>
			store.report("anthropic-subscription", "work", { error: "rate limited", reportedAt: new Date(at("00")) }),
		(store) =>
			store.report("anthropic-subscription", "work", { windows: base.windows, reportedAt: new Date(at("05")) }),
	];
	for (const hostWrite of writes) {
		for (const workerWrite of writes) {
			const { host, worker, settle } = mirrorPair();
			host.report("anthropic-subscription", "work", { windows: base.windows, reportedAt: new Date(at("00")) });
			settle();
			hostWrite(host);
			workerWrite(worker);

			expect(settle()).toBeLessThan(100);
			expect(worker.mirrorSnapshot()).toEqual(host.mirrorSnapshot());
		}
	}
});

it("a failing mirror listener is contained and the public broadcast still runs", () => {
	const store = new SubscriptionLimitStore();
	const heard: string[] = [];
	store.subscribeMirror(() => {
		throw new Error("closed port");
	});
	store.subscribe((limits) => heard.push(limits.account));

	expect(() =>
		store.report("anthropic-subscription", "work", { windows: base.windows, reportedAt: new Date(at("00")) }),
	).not.toThrow();
	expect(heard).toEqual(["work"]);
});

// senpi#3695 (fifth review, LOW 1): host and worker each writing locally from the same held record at the same
// millisecond get the same change stamp; neither update may be lost, and both stores must still converge.
it("concurrent same-stamp writes on host and worker keep both updates and converge", () => {
	const { host, worker, settle } = mirrorPair();
	const instant = new Date(at("00"));
	host.report("anthropic-subscription", "work", { windows: base.windows, reportedAt: instant });
	settle();
	worker.record(
		"anthropic-subscription",
		"work",
		[{ id: "claude:7d", label: "7d", windowMinutes: 10080, usedPercent: 33 }],
		instant,
	);
	host.report("anthropic-subscription", "work", { error: "rate limited", reportedAt: instant });

	expect(settle()).toBeLessThan(100);
	expect(worker.mirrorSnapshot()).toEqual(host.mirrorSnapshot());
	const [held] = host.snapshot();
	expect(held?.error).toBe("rate limited");
	expect(held?.windows.map((window) => window.id).sort()).toEqual(["claude:5h", "claude:7d"]);
});

// senpi#3695 (sixth review, MEDIUM 1): at the same change stamp, a poll that reset usage and dropped a window races an
// error from the other isolate whose record still holds the older windows. The poll's windows were reported later
// (its reportedAt), so they must win on both stores: no stale usage shown under a fresh timestamp, no dropped window
// brought back. The error is kept (a same-stamp success does not clear the other side's error; the next poll does).
it("a same-stamp poll beats the other side's older windows and both stores show the poll", () => {
	for (const pollOnHost of [true, false]) {
		const { host, worker, settle } = mirrorPair();
		const [polling, failing] = pollOnHost ? [host, worker] : [worker, host];
		host.report("anthropic-subscription", "work", {
			windows: [
				{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 40 },
				{ id: "claude:7d", label: "7d", windowMinutes: 10080, usedPercent: 10 },
			],
			reportedAt: new Date(at("00")),
		});
		settle();
		polling.report("anthropic-subscription", "work", {
			windows: [{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 3 }],
			reportedAt: new Date(at("05")),
		});
		failing.report("anthropic-subscription", "work", { error: "rate limited", reportedAt: new Date(at("05")) });

		expect(settle()).toBeLessThan(100);
		expect(worker.mirrorSnapshot()).toEqual(host.mirrorSnapshot());
		const [held] = host.snapshot();
		expect(held?.windows).toEqual([{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 3 }]);
		expect(held?.reportedAt).toBe(at("05"));
		expect(held?.error).toBe("rate limited");
	}
});

// senpi#4158 (final #4109 review, LOW 1 + LOW 2): at the same change stamp the plan, like the windows, comes only from the
// side that reported later, so a plan the poll dropped is not brought back from the other side's held copy, and the
// result does not depend on the order the records arrive in.
const planWindow = { id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 3 };

it("a same-stamp poll that dropped the plan keeps it dropped on both stores", () => {
	for (const pollOnHost of [true, false]) {
		const { host, worker, settle } = mirrorPair();
		const [polling, failing] = pollOnHost ? [host, worker] : [worker, host];
		host.report("anthropic-subscription", "work", {
			windows: [{ ...planWindow, usedPercent: 40 }],
			plan: "max",
			reportedAt: new Date(at("00")),
		});
		settle();
		polling.report("anthropic-subscription", "work", { windows: [planWindow], reportedAt: new Date(at("05")) });
		failing.report("anthropic-subscription", "work", { error: "rate limited", reportedAt: new Date(at("05")) });

		expect(settle()).toBeLessThan(100);
		expect(worker.mirrorSnapshot()).toEqual(host.mirrorSnapshot());
		const [held] = host.snapshot();
		expect(held?.windows).toEqual([planWindow]);
		expect(held?.plan).toBeUndefined();
	}
});

it("three same-stamp records give the same plan in every arrival order", () => {
	const record = { provider: "anthropic-subscription", account: "work", windows: [planWindow] };
	const records: MirroredLimits[] = [
		{ ...record, plan: "zzz", error: "rate limited", reportedAt: at("00"), updatedAt: at("05") },
		{ ...record, reportedAt: at("05") },
		{ ...record, plan: "bbb", reportedAt: at("05") },
	];
	const orders = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	];
	const results = orders.map((order) => {
		const store = new SubscriptionLimitStore();
		for (const index of order) {
			const next = records[index];
			if (next !== undefined) store.adopt(structuredClone(next));
		}
		return store.mirrorSnapshot();
	});
	for (const result of results) expect(result).toEqual(results[0]);
});
