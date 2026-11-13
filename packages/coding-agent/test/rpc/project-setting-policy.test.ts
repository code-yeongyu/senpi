import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	decideDispatchPolicy,
	type DispatchRequest,
	registerDispatchAuthorizer,
} from "../../src/core/extensions/builtin/permission-system/dispatch.ts";
import {
	createBuiltinParserRegistry,
	permissionRequestsFor,
} from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { projectSettingWriteCalls } from "../../src/modes/rpc/project-setting-policy.ts";
import { createHarness } from "../suite/harness.ts";

// senpi#6479: the calls a project setting outside the allowlist is decided as. Contract pinned here: the shell call
// resolves to the one `bash` `*` target, so no grant for a single command can allow it.

describe("the calls a project setting write is decided as", () => {
	it("is an edit of the project settings file and a shell call only a bash '*' rule decides", () => {
		const cwd = "/work/project";
		const path = join(cwd, ".senpi", "settings.json");
		const requests = projectSettingWriteCalls(path).map((call) =>
			permissionRequestsFor(() => [], createBuiltinParserRegistry(), call.toolName, call.input, cwd).map(
				({ permission, patterns }) => ({ permission, patterns }),
			),
		);
		expect(requests).toEqual([[{ permission: "edit", patterns: [path] }], [{ permission: "bash", patterns: ["*"] }]]);
	});
});

describe("a policy-only dispatch decision", () => {
	let harness: Awaited<ReturnType<typeof createHarness>>;
	beforeEach(async () => {
		harness = await createHarness({ extensionFactories: [] });
	});
	afterEach(() => harness.cleanup());

	const request: DispatchRequest = {
		toolCallId: "policy-only",
		toolName: "edit",
		input: { path: "settings.json" },
		identity: { owner: {}, metadata: "policy-only" },
	};

	it("refuses where a dispatch refuses before it asks: no authorizer, a retired one, a policy that cannot decide", () => {
		const session = harness.session.sessionManager;
		const ctx = harness.getExtensionRunner().createContext();
		expect(() => decideDispatchPolicy(session, request, ctx)).toThrow("Permission authorizer is unavailable");
		let asked = 0;
		const retire = registerDispatchAuthorizer(session, {
			policy: () => ({ action: "ask", fingerprint: "ask" }),
			ask: async () => {
				asked++;
			},
		});
		expect(decideDispatchPolicy(session, request, ctx)).toEqual({ action: "ask", fingerprint: "ask" });
		retire();
		expect(() => decideDispatchPolicy(session, request, ctx)).toThrow("Permission authorizer was retired");
		registerDispatchAuthorizer(session, {
			policy: () => {
				throw new Error("Permission setup failed: invalid");
			},
			ask: async () => {},
		});
		expect(() => decideDispatchPolicy(session, request, ctx)).toThrow("Permission setup failed: invalid");
		expect(asked).toBe(0);
	});
});
