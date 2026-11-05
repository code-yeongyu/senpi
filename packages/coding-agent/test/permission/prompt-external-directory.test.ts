import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { showPermissionPrompt } from "../../src/core/extensions/builtin/permission-system/prompt.ts";
import type { Request } from "../../src/core/extensions/builtin/permission-system/types.ts";

function directoryShownFor(request: Request): Promise<string | undefined> {
	let shown: string | undefined;
	const ctx = {
		ui: {
			select: async (title: string) => {
				shown = title
					.split("\n")
					.find((line) => line.startsWith("Directory: "))
					?.slice("Directory: ".length);
				return "Deny";
			},
			input: async () => undefined,
		},
	} as unknown as ExtensionContext;
	return showPermissionPrompt(ctx, request).then(() => shown);
}

describe("external_directory prompt target (senpi#4311)", () => {
	it.each(["/tmp/outside.txt", "/tmp/legal*filename.txt"])(
		"names the resolved target %s, ignoring caller display metadata (senpi#4316)",
		async (target) => {
			const request: Request = {
				id: "req-1",
				sessionID: "session-1",
				permission: "external_directory",
				patterns: [target],
				always: ["/tmp/*"],
				metadata: { filepath: `@${target}`, parentDir: "/trusted-looking-project" },
			};

			expect(await directoryShownFor(request)).toBe(target);
			// Removing the spoofed parent must not turn literal filename characters into glob syntax.
			expect(await directoryShownFor({ ...request, metadata: { filepath: `@${target}` } })).toBe(target);
		},
	);
});
