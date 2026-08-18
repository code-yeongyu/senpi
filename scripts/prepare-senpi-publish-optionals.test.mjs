import assert from "node:assert/strict";
import { it } from "node:test";
import {
	assertSenpiPackedWorkspaceFiles,
	nativePrebuildFile,
	nativePrebuildTarget,
} from "./prepare-senpi-bundled-workspaces.mjs";

it("accepts consumer-resolved platform optionals outside the packed bundle", () => {
	// Given: the portable SDK is bundled, while npm must install the target-native
	// optional package on the consumer machine.
	const hostPrebuild = nativePrebuildFile(nativePrebuildTarget());
	const packed = {
		files: [
			{ path: "package/dist/cli.js" },
			{ path: "package/node_modules/@earendil-works/pi-agent-core/package.json" },
			{ path: "package/node_modules/@earendil-works/pi-agent-core/dist/index.js" },
			{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
			{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
			{ path: "package/node_modules/@earendil-works/pi-telemetry/package.json" },
			{ path: "package/node_modules/@earendil-works/pi-telemetry/dist/index.js" },
			{ path: "package/vendor/pi-client/index.js" },
			{ path: "package/vendor/pi-client/index.d.ts" },
			{ path: "package/vendor/pi-protocol/index.js" },
			{ path: "package/vendor/pi-protocol/index.d.ts" },
			{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
			{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
			{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
			{ path: `package/node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
			{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
			{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
			{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
			{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
			{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
			{ path: "package/node_modules/@anthropic-ai/claude-agent-sdk/package.json" },
		],
	};

	// When / Then
	assert.doesNotThrow(() =>
		assertSenpiPackedWorkspaceFiles(packed, {
			runtimeDependencies: [
				"@anthropic-ai/claude-agent-sdk",
				"@anthropic-ai/claude-agent-sdk-darwin-arm64",
			],
			bundledDependencies: ["@anthropic-ai/claude-agent-sdk"],
		}),
	);
});
