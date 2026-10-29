import { describe, expect, it } from "vitest";
import { authorityDecision } from "../src/kernels/js/permission-authority.mjs";
import { KernelPermissionHost } from "../src/kernels/js/permission-host.ts";

const token = (word: number) => {
	const authority = new SharedArrayBuffer(4);
	Atomics.store(new Int32Array(authority), 0, word);
	return { id: crypto.randomUUID(), authority, rules: [{ permission: "write", pattern: "*", layer: "user" }] };
};

describe("per-context permission authority", () => {
	it.each([false, true])("settlement preserves only inactive continuations (active=%s)", async (active) => {
		const host = new KernelPermissionHost(
			{
				sessionId: crypto.randomUUID(),
				cwd: process.cwd(),
				parallelPoolWidth: 2,
				permissions: { state: () => ({ epoch: 1, active, rules: [] }), decide: () => ({ action: "pass" }) },
			},
			async () => "terminated",
		);
		const bootstrap = host.bootstrap();
		try {
			const frame = host.frame({ type: "run", cellId: "one", code: "" });
			expect(frame.authority).toBeDefined();
			host.settle({ type: "result", cellId: "one", ok: true, durationMs: 0 });
			expect(authorityDecision(frame.authority, [], bootstrap.kernel)).toBe(active ? "refuse" : "pass");
			host.revoke();
			expect(authorityDecision(frame.authority, [], bootstrap.kernel)).toBe("refuse");
		} finally {
			bootstrap.port.close();
			await host.terminateChildren();
			host.dispose();
		}
	});

	it("kernel revocation overrides a retained inactive token", () => {
		expect(authorityDecision(token(6), [], token(4))).toBe("refuse");
	});

	it("uses only the current token and refuses dead even when inactive", () => {
		const inactive = token(6);
		const active = token(7);
		const dead = token(4);
		expect(authorityDecision(inactive, [active], active)).toBe("pass");
		expect(authorityDecision(active, [inactive], inactive)).toBe("check");
		expect(authorityDecision(dead, [], inactive)).toBe("refuse");
	});

	it("allows escaped code only when all bound authorities are alive and inactive", () => {
		const inactive = token(6);
		expect(authorityDecision(undefined, [inactive, token(10)], inactive)).toBe("pass");
		expect(authorityDecision(undefined, [inactive, token(7)], inactive)).toBe("refuse");
		expect(authorityDecision(undefined, [inactive, token(4)], inactive)).toBe("refuse");
		expect(authorityDecision(undefined, [], inactive)).toBe("pass");
		expect(authorityDecision(undefined, [], token(7))).toBe("refuse");
		expect(authorityDecision(undefined, [], token(4))).toBe("refuse");
	});

	it("a generation retirement fences its kernel without retiring a sibling", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<"terminated">();
		const sessionId = crypto.randomUUID();
		const options = { sessionId, cwd: process.cwd(), parallelPoolWidth: 2 };
		let siblingRetirements = 0;
		const owner = new KernelPermissionHost(options, () => {
			started.resolve();
			return finish.promise;
		});
		const sibling = new KernelPermissionHost(options, async () => {
			siblingRetirements++;
			return "terminated";
		});
		const bootstrap = owner.bootstrap();
		try {
			bootstrap.port.postMessage({ type: "retire" });
			await started.promise;
			let admitted = false;
			const admission = owner.admit().then(() => {
				admitted = true;
			});
			await sibling.admit();
			expect(admitted).toBe(false);
			expect(siblingRetirements).toBe(0);
			expect(Atomics.load(new Int32Array(bootstrap.kernel.authority), 0) & 2).toBe(0);
			finish.resolve("terminated");
			await admission;
		} finally {
			finish.resolve("terminated");
			bootstrap.port.close();
			await owner.terminateChildren();
			await sibling.terminateChildren();
			owner.dispose();
			sibling.dispose();
		}
	});
});
