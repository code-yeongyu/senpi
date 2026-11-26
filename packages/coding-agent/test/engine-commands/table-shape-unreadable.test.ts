import { vi } from "vitest";

// The private descriptor table is read once, when its module loads: this file's table is set before any import.
vi.hoisted(() => {
	process.env.SENPI_PRIVATE_FDS = '{"presenter":4,';
});

import { defineTableShapeSuite } from "./table-shape-suite.ts";

defineTableShapeSuite("unreadable");
