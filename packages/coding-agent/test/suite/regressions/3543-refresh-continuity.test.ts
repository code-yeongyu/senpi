import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CredentialStore,
	type OAuthAuth,
	type OAuthCredential,
	refreshOAuthCredential,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const stale: OAuthCredential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1 };
const fresh: OAuthCredential = {
	type: "oauth",
	access: "new-access",
	refresh: "new-refresh",
	expires: 4_102_444_800_000,
};

// #3543: separate auth.json clients must distinguish a completed refresh from a replacement.
test.each([undefined, "default"])(
	"file-backed refresh waiters adopt the completed exchange for %s",
	async (slotName) => {
		const directory = mkdtempSync(join(tmpdir(), "senpi-refresh-continuity-"));
		const started = deferred();
		const release = deferred();
		const waiting = deferred();
		try {
			const path = join(directory, "auth.json");
			const writer = AuthStorage.create(path);
			const reader = AuthStorage.create(path);
			await writer.modify("fixture", async () => ({ ...stale, accounts: [{ ...stale, name: "default" }] }));
			const lock = reader.withRefreshLock;
			if (!lock) throw new Error("File-backed store has no refresh lock");
			const observed: CredentialStore = {
				read: reader.read.bind(reader),
				list: reader.list.bind(reader),
				modify: reader.modify.bind(reader),
				delete: reader.delete.bind(reader),
				withRefreshLock: (providerId, slotName, fn, options) => {
					waiting.resolve();
					return lock(providerId, slotName, fn, options);
				},
			};
			let exchanges = 0;
			const oauth: OAuthAuth = {
				name: "fixture",
				login: async () => fresh,
				refresh: async () => {
					exchanges++;
					started.resolve();
					await release.promise;
					return fresh;
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			};
			const request = (credentials: CredentialStore) =>
				refreshOAuthCredential({
					credentials,
					providerId: "fixture",
					oauth,
					stale,
					slotName,
					isStale: (credential) => credential.expires === 1,
					signal: AbortSignal.timeout(5_000),
					owning: true,
				});

			const first = request(writer);
			await started.promise;
			const second = request(observed);
			await waiting.promise;
			release.resolve();
			const results = await Promise.all([first, second]);

			expect(exchanges).toBe(1);
			expect(results.map((result) => (result?.type === "oauth" ? result.access : undefined))).toEqual([
				fresh.access,
				fresh.access,
			]);
			expect(await AuthStorage.create(path).read("fixture")).toMatchObject(fresh);
		} finally {
			release.resolve();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test("file-backed refresh does not adopt a replacement account", async () => {
	const directory = mkdtempSync(join(tmpdir(), "senpi-refresh-replacement-"));
	const started = deferred();
	const release = deferred();
	try {
		const path = join(directory, "auth.json");
		const writer = AuthStorage.create(path);
		const replacer = AuthStorage.create(path);
		await writer.modify("fixture", async () => ({ ...stale, accounts: [{ ...stale, name: "default" }] }));
		const oauth: OAuthAuth = {
			name: "fixture",
			login: async () => fresh,
			refresh: async () => {
				started.resolve();
				await release.promise;
				return fresh;
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const resolving = refreshOAuthCredential({
			credentials: writer,
			providerId: "fixture",
			oauth,
			stale,
			isStale: (credential) => credential.expires === 1,
			signal: AbortSignal.timeout(5_000),
			owning: true,
		});
		const rejected = expect(resolving).rejects.toMatchObject({ name: "OAuthRefreshIdentityError" });
		await started.promise;
		const replacement = { ...fresh, access: "replacement-access", refresh: "replacement-refresh" };
		await replacer.modify("fixture", async (current) =>
			current?.type === "oauth"
				? { ...current, ...replacement, accounts: [{ ...replacement, name: "default" }] }
				: undefined,
		);
		release.resolve();

		await rejected;
		expect(await AuthStorage.create(path).read("fixture")).toMatchObject(replacement);
	} finally {
		release.resolve();
		rmSync(directory, { recursive: true, force: true });
	}
});
