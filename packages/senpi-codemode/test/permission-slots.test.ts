import { describe, expect, it } from "vitest";
import {
	createPermissionSlots,
	createPermissionRequester,
	interruptPermissionSlot,
	permissionControl,
	servePermissionSlot,
} from "../src/kernels/js/permission-slots.mjs";

const request = { token: "one", call: { tool: "write" as const, input: { path: "file" } } };
const pass = { action: "pass" as const };

describe("permission slot ownership (#4309)", () => {
	it.each(["interrupt", "timeout"] as const)("reclaims repeated %s requests beyond the pool size", async (kind) => {
		const slots = createPermissionSlots();
		let interrupted = true;
		let serving: Promise<void> | undefined;
		const client = createPermissionRequester(slots, {
			wake: (slot, generation) => {
				if (!interrupted) serving = servePermissionSlot(slots, slot, generation, () => pass);
				else if (kind === "interrupt") interruptPermissionSlot(slots, slot, permissionControl(slots, slot));
			},
			wait: () => "timed-out",
		});
		for (let index = 0; index < 8; index++) {
			expect(() => client.check(request)).toThrow("Permission check interrupted or timed out");
		}
		interrupted = false;
		expect(client.check(request)).toEqual(pass);
		await serving;
	});

	it.each(["interrupt", "timeout"] as const)("claims a stable request before decoding during %s", async (kind) => {
		const slots = createPermissionSlots();
		const release = Promise.withResolvers<void>();
		const seen: unknown[] = [];
		let serving: Promise<void> | undefined;
		let ownedSlot = -1;
		const client = createPermissionRequester(slots, {
			wake: (slot, generation) => {
				if (ownedSlot !== -1) {
					expect(slot).not.toBe(ownedSlot);
					return;
				}
				ownedSlot = slot;
				serving = servePermissionSlot(
					slots,
					slot,
					generation,
					(value) => {
						seen.push(value);
						return pass;
					},
					{ claimed: () => release.promise },
				);
				if (kind === "interrupt") {
					expect(interruptPermissionSlot(slots, slot, permissionControl(slots, slot))).toBe(false);
				}
			},
			wait: () => "timed-out",
		});
		try {
			expect(() => client.check(request)).toThrow();
			expect(seen).toEqual([]);
			expect(() => client.check({ ...request, token: "successor" })).toThrow();
		} finally {
			release.resolve();
			await serving;
		}
		expect(seen).toEqual([request]);
	});

	it("does not reuse WRITING while a late host answer completes", async () => {
		const slots = createPermissionSlots();
		const claimed = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let serving: Promise<void> | undefined;
		let firstSlot = -1;
		let secondSlot = -1;
		const client = createPermissionRequester(slots, {
			wake: (slot, generation) => {
				if (firstSlot !== -1) {
					secondSlot = slot;
					return;
				}
				firstSlot = slot;
				serving = servePermissionSlot(slots, slot, generation, () => pass, {
					claimed: () => {
						claimed.resolve();
						return finish.promise;
					},
				});
			},
			wait: () => "timed-out",
		});
		expect(() => client.check(request)).toThrow();
		await claimed.promise;
		expect(() => client.check(request)).toThrow();
		expect(secondSlot).not.toBe(firstSlot);
		const before = permissionControl(slots, secondSlot);
		finish.resolve();
		await serving;
		expect(permissionControl(slots, secondSlot)).toBe(before);
	});

	it("a stale interrupt cannot clobber a successor generation", () => {
		const slots = createPermissionSlots();
		let stale = 0;
		let index = 0;
		let calls = 0;
		const client = createPermissionRequester(slots, {
			wake: (slot) => {
				index = slot;
				if (calls++ === 0) stale = permissionControl(slots, slot);
				else expect(interruptPermissionSlot(slots, slot, stale)).toBe(false);
			},
			wait: () => "timed-out",
		});
		expect(() => client.check(request)).toThrow();
		expect(() => client.check(request)).toThrow();
		expect(permissionControl(slots, index)).not.toBe(stale);
	});

	it("retires before the injected generation limit wraps", () => {
		let retired = 0;
		const client = createPermissionRequester(createPermissionSlots(), {
			wake: () => {},
			wait: () => "timed-out",
			generationLimit: 2,
			retire: () => {
				retired += 1;
			},
		});
		expect(() => client.check(request)).toThrow();
		expect(() => client.check(request)).toThrow();
		expect(() => client.check(request)).toThrow();
		expect(retired).toBe(1);
	});

	it("an interrupt changes the exact waited word before parking", () => {
		const slots = createPermissionSlots();
		const client = createPermissionRequester(slots, {
			wake: (slot) => {
				expect(interruptPermissionSlot(slots, slot, permissionControl(slots, slot))).toBe(true);
			},
		});
		expect(() => client.check(request)).toThrow();
	});

	it.each(["pass", "deny", "host-error", "oversized"])("validates the %s answer before using it", async (kind) => {
		const slots = createPermissionSlots();
		let serving: Promise<void> | undefined;
		const rule = { permission: "write", pattern: kind === "oversized" ? "x".repeat(20_000) : "*", layer: "user" };
		const client = createPermissionRequester(slots, {
			wake: (slot, generation) => {
				serving = servePermissionSlot(slots, slot, generation, () => {
					if (kind === "host-error") throw new Error("host failed");
					return kind === "pass" ? pass : { action: "deny", rule };
				});
			},
		});
		if (kind === "pass") expect(client.check(request)).toEqual(pass);
		else if (kind === "deny") expect(client.check(request)).toEqual({ action: "deny", rule });
		else expect(() => client.check(request)).toThrow();
		await serving;
	});

	it("refuses an oversized request without waking the host", () => {
		let wakes = 0;
		const client = createPermissionRequester(createPermissionSlots(), {
			wake: () => {
				wakes++;
			},
		});
		expect(() =>
			client.check({ ...request, call: { tool: "write", input: { path: "x".repeat(20_000) } } }),
		).toThrow();
		expect(wakes).toBe(0);
	});
});
