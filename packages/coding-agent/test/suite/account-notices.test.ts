import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AccountSwitchNotice,
	emitAccountSwitch,
	formatAccountSwitchNotice,
	subscribeAccountSwitch,
} from "../../src/core/credential-pool/account-notices.ts";
import { createHarness } from "./harness.ts";

const event: AccountSwitchNotice = {
	type: "account_failover",
	provider: "chatgpt-subscription",
	from: "slot-a",
	to: "slot-b",
	reason: "quota exhausted",
	sessionId: "affinity-session",
	source: "rotation",
};

describe("account switch notices", () => {
	afterEach(() => vi.restoreAllMocks());
	it("subscribes, emits, and unsubscribes", () => {
		const seen: AccountSwitchNotice[] = [];
		const unsubscribe = subscribeAccountSwitch((notice) => {
			seen.push(notice);
		});
		emitAccountSwitch(event);
		unsubscribe();
		emitAccountSwitch(event);
		expect(seen).toEqual([event]);
	});

	it("isolates a synchronous throwing listener without dropping later observers", () => {
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		const seen: string[] = [];
		const unsubscribeThrowing = subscribeAccountSwitch(() => {
			throw new Error("listener boom");
		});
		const unsubscribeLater = subscribeAccountSwitch((notice) => {
			seen.push(notice.to);
		});
		expect(() => emitAccountSwitch(event)).not.toThrow();
		expect(seen).toEqual(["slot-b"]);
		expect(diagnostic).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("listener boom");
		unsubscribeThrowing();
		unsubscribeLater();
	});

	it("isolates a rejected async observer without an unhandled rejection", async () => {
		const reported = Promise.withResolvers<void>();
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => reported.resolve());
		const seen: string[] = [];
		const unsubscribeRejected = subscribeAccountSwitch(async () => {
			throw new Error("async listener boom");
		});
		const unsubscribeLater = subscribeAccountSwitch((notice) => {
			seen.push(notice.to);
		});
		try {
			emitAccountSwitch(event);
			expect(seen).toEqual(["slot-b"]);
			await reported.promise;
			expect(diagnostic).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("async listener boom");
		} finally {
			unsubscribeRejected();
			unsubscribeLater();
		}
	}, 1000);

	it("renders routing labels without serializing extra credential fields", () => {
		const input = { ...event, token: "private-credential-marker" };
		const formatted = formatAccountSwitchNotice(input);
		for (const label of [event.provider, event.from, event.to]) {
			expect(formatted.title).toContain(label);
		}
		expect(formatted.why).toContain(event.reason);
		expect(formatted.why).toContain(event.source);
		expect(JSON.stringify(formatted)).not.toContain(input.token);
		expect(formatAccountSwitchNotice({ ...event, source: undefined }).why).not.toContain("undefined");
	});
});

describe("agent session account-switch isolation", () => {
	it.each(["sync", "async", "self-unsubscribe"])(
		"isolates a %s session observer and still delivers to its peers",
		async (mode) => {
			const harness = await createHarness();
			const reported = Promise.withResolvers<void>();
			const diagnostic = vi.spyOn(console, "error").mockImplementation(() => reported.resolve());
			const seen: string[] = [];
			const unsubscribe = harness.session.subscribe((notice) => {
				if (notice.type !== "account_failover") return;
				if (mode === "self-unsubscribe") unsubscribe();
				if (mode !== "async") throw new Error("private session observer error");
				return Promise.reject(new Error("private session observer error"));
			});
			harness.session.subscribe((notice) => {
				if (notice.type === "account_failover") seen.push(notice.to);
			});
			try {
				emitAccountSwitch({ ...event, sessionId: harness.session.sessionId });
				expect(seen).toEqual(["slot-b"]);
				await reported.promise;
				expect(diagnostic).toHaveBeenCalledTimes(1);
				expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private session observer error");
			} finally {
				diagnostic.mockRestore();
				harness.cleanup();
			}
		},
	);

	it("surfaces only its own session and stops after disposal", async () => {
		const harness = await createHarness();
		const matching = harness.session.sessionId;
		try {
			emitAccountSwitch({ ...event, sessionId: matching });
			expect(harness.eventsOfType("account_failover")).toEqual([
				{
					type: "account_failover",
					provider: event.provider,
					from: event.from,
					to: event.to,
					reason: event.reason,
					sessionId: matching,
					source: event.source,
				},
			]);

			emitAccountSwitch({ ...event, sessionId: "other-session" });
			expect(harness.eventsOfType("account_failover")).toHaveLength(1);

			harness.session.dispose();
			emitAccountSwitch({ ...event, sessionId: matching });
			expect(harness.eventsOfType("account_failover")).toHaveLength(1);
		} finally {
			// dispose() is intentionally run once inside the test; clean up the
			// harness's non-session resources here instead of calling cleanup().
			harness.faux.unregister();
			rmSync(harness.tempDir, { recursive: true, force: true });
		}
	});
});
