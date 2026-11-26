import { vi } from "vitest";

// The private descriptor table is read once, when its module loads: this file's table is set before any import.
vi.hoisted(() => {
	delete process.env.SENPI_PRIVATE_FDS;
});

import { defineTableShapeSuite, warmHelpAnswer } from "./table-shape-suite.ts";

await warmHelpAnswer();
defineTableShapeSuite("none");
