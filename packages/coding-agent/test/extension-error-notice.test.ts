import { describe, expect, it } from "vitest";
import {
	describeExtensionError,
	extensionErrorNoticeLines,
	extensionSourceName,
} from "../src/core/extensions/error-notice.ts";
import { UserFacingError, userFacingErrorOf } from "../src/core/extensions/user-facing-error.ts";
import { extensionErrorNoticeSpec } from "../src/modes/interactive/extension-error-format.ts";
import { extensionErrorEvent } from "../src/modes/rpc/extension-error-event.ts";

const LOG = "~/.senpi/agent/senpi-debug.log";

describe("userFacingErrorOf", () => {
	it("reads the contract from the class and from a structural error a bundled extension builds", () => {
		const info = { code: "QUOTA_EXHAUSTED", message: "The image quota is used up.", action: "Wait until 09:00." };
		const structural = Object.assign(new Error("raw"), { userFacing: info });
		expect(userFacingErrorOf(new UserFacingError(info))).toEqual(info);
		expect(userFacingErrorOf(structural)).toEqual(info);
		expect(new UserFacingError(info).message).toBe("QUOTA_EXHAUSTED: The image quota is used up. Wait until 09:00.");
	});

	it.each([
		["a plain error", new Error("x")],
		["a string", "x"],
		["no code", { userFacing: { message: "m" } }],
		["no message", { userFacing: { code: "C" } }],
		["a non-string action", { userFacing: { code: "C", message: "m", action: 3 } }],
		["a code with spaces", { userFacing: { code: "not a code", message: "m" } }],
	])("rejects %s", (_name, value) => {
		expect(userFacingErrorOf(value)).toBeUndefined();
	});

	it("keeps only http(s) docs links", () => {
		expect(userFacingErrorOf({ userFacing: { code: "C", message: "m", docsUrl: "file:///etc/passwd" } })).toEqual({
			code: "C",
			message: "m",
		});
		expect(
			userFacingErrorOf({ userFacing: { code: "C", message: "m", docsUrl: "https://example.com/help" } }),
		).toEqual({ code: "C", message: "m", docsUrl: "https://example.com/help" });
	});
});

describe("extensionSourceName", () => {
	it.each([
		["/opt/app/node_modules/omo-ai/plugin/extensions/omo.js", "omo"],
		["/home/user/.senpi/extensions/my-ext/index.ts", "my-ext"],
		["C:\\Users\\me\\.senpi\\extensions\\win-ext.ts", "win-ext"],
		["<runtime>", "the session runtime"],
	])("names %s as %s", (extensionPath, name) => {
		expect(extensionSourceName(extensionPath)).toBe(name);
	});
});

describe("describeExtensionError", () => {
	it("shows a coded failure as message and action, never the raw message", () => {
		const notice = describeExtensionError(
			{
				extensionPath: "/opt/app/omo.js",
				event: "tool_activated",
				error: "COMPUTER_LAUNCH_CONTEXT_REQUIRED: raw text",
				stack: "Error: raw\n    at finish (senpi-extension:0/%2Fopt%2Fapp%2Fomo-computer-use.js:178:40)",
				userFacing: { code: "COMPUTER_LAUNCH_CONTEXT_REQUIRED", message: "Cannot start.", action: "Restart it." },
			},
			{ logPath: LOG },
		);
		expect(extensionErrorNoticeLines(notice)).toEqual([
			"Cannot start.",
			"Restart it.",
			"omo · COMPUTER_LAUNCH_CONTEXT_REQUIRED",
		]);
	});

	it("reduces an uncoded failure to its first line with paths cut to file names", () => {
		const notice = describeExtensionError(
			{
				extensionPath: "/opt/app/omo.js",
				event: "session_start",
				error: "ENOENT: open '/Users/someone/.omo/state/cache.json' via senpi-extension:0/%2Fopt%2Fapp%2Fomo-memory.js (run /login first)\n    at open (node:fs:1:1)",
			},
			{ logPath: LOG },
		);
		expect(extensionErrorNoticeLines(notice)).toEqual([
			"Something went wrong in omo",
			"ENOENT: open 'cache.json' via omo-memory.js (run /login first) (during session_start)",
			`Details: ${LOG}`,
		]);
	});

	it("labels runtime-emitted errors as the session runtime", () => {
		const notice = describeExtensionError(
			{ extensionPath: "<runtime>", event: "session_title_generation", error: "Overloaded" },
			{ logPath: LOG },
		);
		expect(extensionErrorNoticeLines(notice)[0]).toBe("Something went wrong in the session runtime");
	});

	it("keeps C:\\ paths and long reasons out of the notice", () => {
		const notice = describeExtensionError(
			{ extensionPath: "x.ts", event: "input", error: `bad C:\\Users\\me\\secret\\file.txt ${"y".repeat(400)}` },
			{},
		);
		const [, reason] = extensionErrorNoticeLines(notice);
		expect(reason).toContain("bad file.txt");
		expect(reason).not.toContain("Users");
		expect(reason?.length).toBeLessThanOrEqual(260);
		expect(extensionErrorNoticeLines(notice)).toHaveLength(2);
	});
});

describe("extensionErrorNoticeSpec", () => {
	it("strips control sequences an error can smuggle into the notice", () => {
		const spec = extensionErrorNoticeSpec(
			describeExtensionError(
				{
					extensionPath: "/ext\u001b]52;c;Zm9v\u0007.ts",
					event: "tool\u001b[31m_call",
					error: "Overloaded\u001b]0;pwned\u001b\\\u001b[31mred\u001b[0m\u009b2Jtail\u0000",
				},
				{ logPath: LOG },
			),
		);
		const text = [spec.title, spec.why, ...(spec.extra ?? []).map((line) => line.text)].join("\n");
		expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
		expect(text).toContain("Overloadedredtail");
	});
});

describe("extensionErrorEvent", () => {
	it("keeps the legacy fields and adds a stack-free notice for RPC clients", () => {
		const event = extensionErrorEvent(
			{
				extensionPath: "/opt/app/omo.js",
				event: "tool_activated",
				error: "COMPUTER_LAUNCH_CONTEXT_REQUIRED: raw text",
				stack: "Error\n    at x (/opt/app/omo.js:1:1)",
				userFacing: { code: "COMPUTER_LAUNCH_CONTEXT_REQUIRED", message: "Cannot start.", action: "Restart it." },
			},
			LOG,
		);
		expect(event).toEqual({
			type: "extension_error",
			extensionPath: "/opt/app/omo.js",
			event: "tool_activated",
			error: "COMPUTER_LAUNCH_CONTEXT_REQUIRED: raw text",
			notice: {
				kind: "user",
				source: "omo",
				title: "Cannot start.",
				detail: "Restart it.",
				code: "COMPUTER_LAUNCH_CONTEXT_REQUIRED",
			},
		});
		expect(JSON.stringify(event)).not.toContain("at x");
	});
});
