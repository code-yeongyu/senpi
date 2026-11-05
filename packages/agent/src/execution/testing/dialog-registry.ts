import type { RegisteredCase } from "../../conformance/registry.ts";
import { DIALOG_DECLARATIONS } from "./dialog-cases.ts";

export const DIALOG_REGISTRY: readonly RegisteredCase[] = DIALOG_DECLARATIONS.map(({ id, expected }) => ({
	id,
	impl: "packages/agent/src/execution/testing/dialog-cases.ts",
	intro: "#5823",
	adapters: ["store", "transport", "executor"],
	expected,
}));
