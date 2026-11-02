import type { RegisteredCase } from "../../conformance/registry.ts";
import { KILL_LEDGER_DECLARATIONS } from "./kill-ledger.ts";

const expectations = [
	"identity and generation are bound; replay never re-admits",
	"effect_possible is durable before preparation effects and freeze",
	"consent waits on the frozen call; unauthorized approval is refused",
	"dispatch requires release and is granted at most once",
	"cancel-first stays terminal; late result is audit-only",
	"result-first stays terminal; terminal release, abort and consent are refused",
	"renewal is issuer-only, monotonic, capped and returns terminal outcomes",
	"ACK is issuer-only, terminal-only and idempotent; replay after ACK is result_expired",
	"preparing never reruns after restart; uncertainty follows effect_possible",
	"prepared, consent-waiting and released calls survive restart",
	"reconcilable dispatch has one bounded grace; an authoritative result resolves uncertainty",
	"lease expiry retains its reason; concurrent admissions and owner epochs are fenced",
];

export const LEDGER_REGISTRY: readonly RegisteredCase[] = [
	...expectations.map((expected, index): RegisteredCase => ({
		id: `LEDGER-${String(index + 1).padStart(2, "0")}`,
		impl:
			index < 6
				? "packages/agent/src/execution/testing/ledger-cases.ts"
				: "packages/agent/src/execution/testing/ledger-recovery-cases.ts",
		intro: "#5004",
		adapters: ["store"],
		expected,
	})),
	...KILL_LEDGER_DECLARATIONS.map(({ id, operation, point }): RegisteredCase => ({
		id,
		impl: "packages/agent/src/execution/testing/kill-ledger.ts",
		intro: "#5004",
		adapters: ["store"],
		expected: `everywhere: kill ${point.at}${point.at === "write" ? ` ${point.index}` : ""} ${operation}; journal and row recover atomically, with no repeated dispatch`,
	})),
];
