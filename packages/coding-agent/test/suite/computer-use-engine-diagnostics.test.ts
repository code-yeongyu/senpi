import { type ChildFactory, DesktopEngineUnavailableError } from "@code-yeongyu/senpi-desktop-service";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEngineFactory } from "../../../desktop-service/test/harness.ts";
import { type ComputerUseHarness, callTool, createComputerUseHarness } from "./computer-use-harness.ts";

// Every case waits on real engine child-process I/O; the guard only catches a hang, it never times behavior.
const HANG_GUARD = { timeout: 30_000 };

const open: ComputerUseHarness[] = [];

async function harnessWith(engineChild: ChildFactory): Promise<ComputerUseHarness> {
	const created = await createComputerUseHarness({ engineChild });
	open.push(created);
	return created;
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((created) => created.cleanup()));
});

/** What the engine locator reports on a host without a binary. */
const missingBinary: ChildFactory = () => {
	throw new DesktopEngineUnavailableError({
		code: "native-unavailable",
		host: "linux-x64",
		attemptedPaths: ["/opt/senpi/native/prebuilds/linux-x64/senpi-desktop-engine"],
		message: "No senpi-desktop-engine binary is available for linux-x64.",
		cause: "/opt/senpi/native/prebuilds/linux-x64/senpi-desktop-engine: missing",
	});
};

function statusEngine(status: string): string | undefined {
	return status.match(/^engine: (.+)$/m)?.[1];
}

describe("computer-use engine diagnostics", HANG_GUARD, () => {
	it("still registers the tool when no engine binary exists", async () => {
		// When
		const { harness } = await harnessWith(missingBinary);

		// Then
		expect(harness.session.getAllTools().some((tool) => tool.name === "computer")).toBe(true);
	});

	it("fails the first call with the native-unavailable diagnostic", async () => {
		// Given
		const { harness } = await harnessWith(missingBinary);

		// When
		const result = await callTool(harness, "computer", { action: "capabilities" });

		// Then
		expect(result).toContain("(native-unavailable)");
	});

	it("reports engine: native-unavailable in /computer status after the failed start", async () => {
		// Given
		const computerUse = await harnessWith(missingBinary);
		await callTool(computerUse.harness, "computer", { action: "capabilities" });

		// When
		const status = await computerUse.command("status");

		// Then
		expect(statusEngine(status)).toBe("native-unavailable");
	});

	it("reports engine: abi-mismatch when the engine speaks another ABI", async () => {
		// Given
		const mismatched = fakeEngineFactory({ FAKE_ENGINE_ABI: "senpi-desktop/999" });
		const computerUse = await harnessWith(mismatched.factory);
		await callTool(computerUse.harness, "computer", { action: "capabilities" });

		// When
		const status = await computerUse.command("status");

		// Then
		expect(statusEngine(status)).toBe("abi-mismatch");
	});
});
