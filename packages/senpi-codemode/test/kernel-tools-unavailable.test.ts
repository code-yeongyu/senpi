import { describe, expect, it } from "vitest";
import { SubprocessKernel } from "../src/kernels/shared/subprocess-kernel.ts";

describe("rb/jl kernel tools", () => {
	it("returns tools_unavailable from the Ruby and Julia kernel class", async () => {
		await expect(SubprocessKernel.prototype.describeKernelTools(["lookup"])).rejects.toMatchObject({
			code: "tools_unavailable",
		});
		await expect(SubprocessKernel.prototype.invokeKernelTool({})).rejects.toMatchObject({
			code: "tools_unavailable",
		});
	});
});
