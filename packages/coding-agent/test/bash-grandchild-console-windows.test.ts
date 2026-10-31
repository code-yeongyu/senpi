import { describe, expect, it } from "vitest";

import { type Attachment, fixture, runConsoleProbe } from "./fixtures/windows-console/run-console-probe.ts";

// Platform contract (omo#7691): a bash-tool command whose node starts its own child (the npm/Firebase/Vitest
// shape) must not open a visible console window when senpi itself runs without a console. The bash tool hides its
// direct shell child (src/core/tools/bash.ts windowsHide); these cases measure the processes below it.
type ChainResult = { readonly grandparent: Attachment; readonly grandchild: Attachment; readonly leaf: Attachment };
type UpstreamResult = { readonly shape: string; readonly leaf: Attachment };
const FIREBASE_UPSTREAM_ISSUE = "https://github.com/firebase/firebase-tools/issues/11261";
const TIMEOUT_MS = 90_000;

const bashToolChain = (shape: string) => runConsoleProbe<ChainResult>(fixture("bash-grandchild-probe.ts"), [shape]);

describe.skipIf(process.platform !== "win32")("bash tool grandchild console windows (omo#7691)", () => {
	it.each(["inherit", "detached", "shell", "firebase-java"])(
		"#given a console-less senpi #when a bash command's node starts a %s child #then no process opens a visible console",
		async (shape) => {
			// given / when
			const result = await bashToolChain(shape);

			// then
			expect({ shape, ...result }).toMatchObject({
				grandparent: { windowVisible: false },
				grandchild: { windowVisible: false },
				leaf: { windowVisible: false },
			});
		},
		TIMEOUT_MS,
	);

	it(
		"#given the same chain spawned WITHOUT windowsHide #when probed #then the probe sees a visible console (control)",
		async () => {
			// given / when
			const result = await runConsoleProbe<ChainResult>(fixture("bash-grandchild-probe.ts"), ["inherit", "control"]);

			// then
			expect({ grandparent: result.grandparent }).toMatchObject({ grandparent: { windowVisible: true } });
		},
		TIMEOUT_MS,
	);
});

// Documents a known upstream window: firebase-tools' detached shell spawn. firebase-tools starts its Pub/Sub
// emulator with detached + shell: true (src/emulator/downloadableEmulators.ts _runBinary). DETACHED_PROCESS leaves
// the intermediate cmd.exe without a console, so the program it launches allocates a new, visible one. No flag on
// senpi's own spawn reaches past a grandchild that detaches. Upstream: FIREBASE_UPSTREAM_ISSUE.
describe.skipIf(process.platform !== "win32")(
	"documents a known upstream window: firebase-tools detached shell spawn",
	() => {
		it(
			"#given firebase-tools' Pub/Sub launch under the bash tool #when probed #then its leaf still opens a visible console",
			async () => {
				// given / when
				const result = await bashToolChain("firebase-shell");

				// then
				expect(
					result.leaf.windowVisible,
					`now fixed upstream (${FIREBASE_UPSTREAM_ISSUE}): the firebase-shell leaf no longer opens a window, so update this test to assert windowVisible false`,
				).toBe(true);
			},
			TIMEOUT_MS,
		);

		it.each([
			"today",
			"today-windowsHide",
			"shell-not-detached-windowsHide",
			"direct-detached",
			"direct-detached-windowsHide",
			"direct-not-detached-windowsHide",
		])(
			"#given firebase-tools' launch options as %s with no senpi involved #when run console-less #then the leaf is measured",
			async (shape) => {
				// given / when
				const result = await runConsoleProbe<UpstreamResult>(fixture("upstream-probe.ts"), [shape]);

				// then
				expect(result).toMatchObject({ shape, leaf: { windowVisible: expect.any(Boolean) } });
				if (shape === "today") expect(result.leaf.windowVisible).toBe(true);
			},
			TIMEOUT_MS,
		);
	},
);
