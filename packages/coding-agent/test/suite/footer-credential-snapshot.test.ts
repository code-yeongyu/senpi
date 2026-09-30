import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { CredentialAccountUpdate } from "../../src/core/credential-account-events.ts";
import { type CredentialAccountSnapshot, getCredentialAccountSnapshot } from "../../src/core/credential-accounts.ts";
import { CredentialSlotRepository } from "../../src/core/credential-pool/state-store.ts";
import { type FooterCredentialAccountSource, FooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createFooterSession } from "../helpers/footer-test-fixtures.ts";
import { createHarness } from "./harness.ts";

const PROVIDER = "chatgpt-subscription";
const NOW = 1_800_000_000_000;
const account = {
	name: "login-2",
	displayName: "Research",
	verifiedEmail: "research@example.test",
	identitySource: "verified-email" as const,
	source: "login" as const,
	pinned: true,
	blocked: false,
	authAction: "valid" as const,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let dir: string;
let footer: FooterDataProvider;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "footer-accounts-"));
	footer = new FooterDataProvider(dir);
	initTheme(undefined, false);
});
afterEach(() => {
	footer.dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

function source(load: FooterCredentialAccountSource["load"], sessionId = "session-footer") {
	let listener: Parameters<FooterCredentialAccountSource["subscribe"]>[0] | undefined;
	const unsubscribe = vi.fn(() => {
		listener = undefined;
	});
	return {
		binding: {
			sessionId,
			load,
			subscribe: (callback: typeof listener) => {
				listener = callback;
				return unsubscribe;
			},
		} satisfies FooterCredentialAccountSource,
		emit: (event: Parameters<NonNullable<typeof listener>>[0]) => listener?.(event),
		unsubscribe,
	};
}

// Subscribers are installed before the action. Vitest's test timeout bounds the wait.
function nextReady(provider = footer) {
	return new Promise<void>((resolve) => {
		const off = provider.onCredentialAccountChange(() => {
			if (provider.getCredentialAccountSnapshot("session-footer")?.state !== "ready") return;
			off();
			resolve();
		});
	});
}

describe("footer credential snapshots", () => {
	it("invalidates synchronously on mutation and fences late old-session results", async () => {
		const pending = deferred<CredentialAccountSnapshot>();
		const started = deferred<void>();
		const load = vi
			.fn()
			.mockResolvedValueOnce({ accounts: [account] })
			.mockImplementationOnce(() => {
				started.resolve();
				return pending.promise;
			});
		const first = source(load);
		const ready = nextReady();
		footer.setCredentialAccountSource(first.binding);
		await ready;
		expect(footer.getCredentialAccountSnapshot("session-footer")).toMatchObject({ state: "ready", account });
		first.emit({ type: "credential_accounts_changed", provider: PROVIDER, reason: "credentials" });
		expect(footer.getCredentialAccountSnapshot("session-footer")?.state).not.toBe("ready");
		await started.promise;
		const second = source(async () => ({ accounts: [{ ...account, name: "other", pinned: true }] }), "new-session");
		footer.setCredentialAccountSource(second.binding);
		pending.resolve({ accounts: [account] });
		await pending.promise;
		expect(first.unsubscribe).toHaveBeenCalledOnce();
		expect(footer.getCredentialAccountSnapshot("session-footer")).toBeUndefined();
		expect(footer.getCredentialAccountSnapshot("new-session")?.account?.name).not.toBe("login-2");
	});

	it("pairs the observed failover slot with its own status, not the blocked pin", async () => {
		const other = {
			...account,
			name: "default",
			displayName: "Personal",
			pinned: false,
			authAction: "refresh-on-use" as const,
		};
		const pinned = { ...account, blocked: true, authAction: "reauth-required" as const };
		const input = source(async () => ({ accounts: [pinned, other] }));
		const ready = nextReady();
		footer.setCredentialAccountSource(input.binding);
		await ready;
		expect(footer.getCredentialAccountSnapshot("session-footer")).toMatchObject({
			account: pinned,
			selection: "pinned",
		});
		input.emit({ type: "credential_account_attempt", provider: PROVIDER, name: "default" });
		expect(footer.getCredentialAccountSnapshot("session-footer")).toMatchObject({
			account: other,
			selection: "observed",
		});
		input.emit({ type: "credential_account_attempt", provider: PROVIDER });
		expect(footer.getCredentialAccountSnapshot("session-footer")?.account).toBeUndefined();
	});

	it("never guesses a pooled account before an attempt", async () => {
		const input = source(async () => ({
			accounts: [
				{ ...account, pinned: false },
				{ ...account, name: "default", pinned: false },
			],
		}));
		const ready = nextReady();
		footer.setCredentialAccountSource(input.binding);
		await ready;
		expect(footer.getCredentialAccountSnapshot("session-footer")).toMatchObject({
			state: "ready",
			selection: "unknown",
		});
		expect(footer.getCredentialAccountSnapshot("session-footer")?.account).toBeUndefined();
	});

	it("expires advice at the exact boundary even before a delayed timer runs", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const input = source(async () => ({ accounts: [account], validUntil: NOW + 1000 }));
		const ready = nextReady();
		footer.setCredentialAccountSource(input.binding);
		await ready;
		vi.setSystemTime(NOW + 999);
		expect(footer.getCredentialAccountSnapshot("session-footer")?.state).toBe("ready");
		vi.setSystemTime(NOW + 1000);
		expect(footer.getCredentialAccountSnapshot("session-footer")?.state).not.toBe("ready");
	});

	it("ignores completion after disposal", async () => {
		const pending = deferred<CredentialAccountSnapshot>();
		const started = deferred<void>();
		const input = source(() => {
			started.resolve();
			return pending.promise;
		});
		footer.setCredentialAccountSource(input.binding);
		await started.promise;
		footer.dispose();
		pending.resolve({ accounts: [account] });
		await pending.promise;
		expect(input.unsubscribe).toHaveBeenCalledOnce();
		expect(footer.getCredentialAccountSnapshot("session-footer")).toBeUndefined();
	});

	it("does not request another render while disposing its account source", async () => {
		const input = source(async () => ({ accounts: [account] }));
		const ready = nextReady();
		footer.setCredentialAccountSource(input.binding);
		await ready;
		const requestRender = vi.fn();
		footer.onCredentialAccountChange(requestRender);

		footer.dispose();

		expect(input.unsubscribe).toHaveBeenCalledOnce();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("publishes an explicit unavailable state on read failure, never exception text", async () => {
		const unavailable = new Promise<void>((resolve) => {
			const off = footer.onCredentialAccountChange(() => {
				if (footer.getCredentialAccountSnapshot("session-footer")?.state !== "unavailable") return;
				off();
				resolve();
			});
		});
		footer.setCredentialAccountSource(
			source(async () => {
				throw new Error("fake-secret-sentinel");
			}).binding,
		);
		await unavailable;
		const session = createFooterSession({ sessionName: "", provider: PROVIDER });
		expect(new FooterComponent(session, footer).render(80).join("\n")).not.toContain("sentinel");
		expect(footer.getCredentialAccountSnapshot("session-footer")).toEqual({
			state: "unavailable",
			selection: "unknown",
		});
	});

	it("refreshes at the scheduled boundary and retains the observed immutable ID", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const load = vi
			.fn()
			.mockResolvedValueOnce({ accounts: [account], validUntil: NOW + 1000 })
			.mockResolvedValueOnce({ accounts: [{ ...account, authAction: "refresh-on-use" }] });
		const input = source(load);
		const ready = nextReady();
		footer.setCredentialAccountSource(input.binding);
		await ready;
		input.emit({ type: "credential_account_attempt", provider: PROVIDER, name: account.name });
		const expired = nextReady();
		await vi.advanceTimersByTimeAsync(1000);
		await expired;
		expect(footer.getCredentialAccountSnapshot("session-footer")).toMatchObject({
			selection: "observed",
			account: { name: account.name, authAction: "refresh-on-use" },
		});
		expect(load).toHaveBeenCalledTimes(2);
	});

	it.each([80, 120])(
		"retains the human label, ID and status at %i columns without credential reads",
		async (width) => {
			const long = { ...account, verifiedEmail: `${"research".repeat(12)}@example.test`, displayName: undefined };
			const input = source(async () => ({ accounts: [long] }));
			const ready = nextReady();
			footer.setCredentialAccountSource(input.binding);
			await ready;
			const session = createFooterSession({
				sessionName: "long-session-name".repeat(4),
				provider: PROVIDER,
				modelId: "gpt-5-codex",
				reasoning: true,
				thinkingLevel: "high",
			});
			const get = vi.spyOn(session.modelRegistry.authStorage, "get").mockImplementation(() => {
				throw new Error("render read credentials");
			});
			const lines = new FooterComponent(session, footer).render(width);
			const plain = stripAnsi(lines.join("\n"));
			expect(plain).toContain(long.name);
			expect(plain).toContain("research");
			// Check the rendered, machine-consumed enum, not explanatory prose.
			expect(plain).toContain(long.authAction);
			expect(get).not.toHaveBeenCalled();
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		},
	);
});

describe("runtime attempt observations", () => {
	it("identifies the sole stored slot but never attributes an explicit key override to it", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER]: { type: "api_key", key: "fake-only" } });
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsPath: null,
			agentDir: dir,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: PROVIDER });
		await runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ providers: [PROVIDER], allowNetwork: false });
		const seen: CredentialAccountUpdate[] = [];
		const off = runtime.onCredentialAccountUpdate(
			() => "session-footer",
			(event) => seen.push(event),
		);
		try {
			for (const apiKey of [undefined, "fake-override"]) {
				faux.setResponses([fauxAssistantMessage("ok")]);
				const stream = runtime.streamSimple(
					faux.getModel(),
					{ messages: [] },
					{ sessionId: "session-footer", apiKey },
				);
				for await (const event of stream) if (event.type === "done" || event.type === "error") break;
			}
			storage.setRuntimeApiKey(PROVIDER, "fake-storage-override");
			faux.setResponses([fauxAssistantMessage("ok")]);
			const overridden = runtime.streamSimple(faux.getModel(), { messages: [] }, { sessionId: "session-footer" });
			for await (const event of overridden) if (event.type === "done" || event.type === "error") break;
			expect(seen.filter((event) => event.type === "credential_account_attempt").map((event) => event.name)).toEqual(
				["default", undefined, undefined],
			);
		} finally {
			off();
		}
	});
	it("forwards committed credential updates through the session event surface", async () => {
		const harness = await createHarness({ provider: PROVIDER });
		try {
			await harness.authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "fake-replacement" }));
			expect(harness.events.filter((event) => event.type === "credential_accounts_changed")).toEqual([
				{ type: "credential_accounts_changed", provider: PROVIDER, reason: "credentials" },
			]);
		} finally {
			harness.cleanup();
		}
	});
	it.each(["stream", "streamSimple"] as const)(
		"observes real %s failover and ignores other sessions",
		async (method) => {
			const credential: PooledCredential = {
				type: "api_key",
				key: "fake-default",
				pinned: "default",
				accounts: [
					{ name: "default", key: "fake-default" },
					{ name: "work", key: "fake-work" },
				],
			};
			const storage = AuthStorage.inMemory({ [PROVIDER]: credential });
			const runtime = await ModelRuntime.create({
				credentials: storage,
				modelsPath: null,
				agentDir: dir,
				allowModelNetwork: false,
			});
			const faux = fauxProvider({ provider: PROVIDER });
			await runtime.registerNativeProvider(faux.provider);
			await runtime.refresh({ providers: [PROVIDER], allowNetwork: false });
			const updates: CredentialAccountUpdate[] = [];
			const unrelated: CredentialAccountUpdate[] = [];
			const off = runtime.onCredentialAccountUpdate(
				() => "session-footer",
				(event) => updates.push(event),
			);
			const offOther = runtime.onCredentialAccountUpdate(
				() => "other-session",
				(event) => unrelated.push(event),
			);
			try {
				faux.setResponses([
					() => {
						throw new Error("401 unauthorized");
					},
					fauxAssistantMessage("ok"),
				]);
				const stream = runtime[method](
					faux.getModel(),
					{ messages: [], tools: [] },
					{ sessionId: "session-footer" },
				);
				for await (const event of stream) if (event.type === "done" || event.type === "error") break;
				const attempts = updates.filter((event) => event.type === "credential_account_attempt");
				expect(attempts.map((event) => event.name)).toEqual(["default", "work"]);
				expect(unrelated.some((event) => event.type === "credential_account_attempt")).toBe(false);
				expect(
					updates.some((event) => event.type === "credential_accounts_changed" && event.reason === "health"),
				).toBe(true);
				expect(JSON.stringify(updates)).not.toContain("fake-");
			} finally {
				off();
				offOther();
			}
		},
	);
});

describe("canonical snapshot deadlines", () => {
	it("uses matching-revision cooldown and expiry boundaries without exposing material", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const slot = {
			name: "default",
			access: "fake-access-sentinel",
			refresh: "fake-refresh-sentinel",
			expires: NOW + 5000,
		};
		const storage = AuthStorage.inMemory({ [PROVIDER]: { type: "oauth", ...slot } });
		const repository = new CredentialSlotRepository(join(dir, "health.json"));
		const revision = await repository.storedCredentialRevision(PROVIDER, slot.name, slot);
		await repository.mutateSlotState(PROVIDER, "stored", slot.name, () => ({
			credentialRevision: revision,
			blockedUntil: NOW + 1000,
			blockReason: "rate_limit",
		}));
		const snapshot = await getCredentialAccountSnapshot(storage, PROVIDER, {}, repository);
		expect(snapshot.validUntil).toBe(NOW + 1000);
		expect(snapshot.accounts[0]?.authAction).toBe("temporarily-unavailable");
		expect(JSON.stringify(snapshot)).not.toContain("sentinel");
		vi.restoreAllMocks();
	});
});
