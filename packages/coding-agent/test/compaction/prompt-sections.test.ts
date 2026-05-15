import { describe, expect, it } from "vitest";
import {
	buildPrompt,
	MERGED_COMPACTION_PROMPT_SYSTEM,
	MERGED_COMPACTION_PROMPT_TURN_PREFIX,
	MERGED_COMPACTION_PROMPT_UPDATE,
	MERGED_COMPACTION_PROMPT_USER,
} from "../../src/core/extensions/builtin/compaction/prompts.js";

// ============================================================================
// Per-section presence
// ============================================================================

describe("DEFAULT variant — per-section landmarks", () => {
	it("contains the system directive header", () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - COMPACTION CONTEXT]");
	});

	it("contains section 1: User Requests", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 1. User Requests (Verbatim)");
	});

	it("contains section 2: Final Goal", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 2. Final Goal");
	});

	it("contains section 3: Constraints & Preferences", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 3. Constraints & Preferences (Verbatim Only)");
	});

	it("contains section 4: Work Completed", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 4. Work Completed");
	});

	it("contains section 5: Active Working Context", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 5. Active Working Context");
	});

	it("contains section 6: Remaining Tasks", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 6. Remaining Tasks");
	});

	it("contains section 7: Exact Next Steps", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 7. Exact Next Steps");
	});

	it("contains the 'Quote constraints verbatim' instruction", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("Quote constraints verbatim");
	});

	it("contains the 'Do NOT invent' instruction", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("Do NOT invent");
	});
});

// ============================================================================
// Cardinal rules R1-R4 (4 tests, one each)
// ============================================================================

describe("SYSTEM block — cardinal rules", () => {
	it("R1: quotes user requests and constraints verbatim", () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain(
			"R1. Quote user requests and constraints VERBATIM. Do not paraphrase.",
		);
	});

	it('R2: writes "None." for empty sections, never deletes a section', () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain(
			'R2. If a section has no content, write "None." Never delete a section.',
		);
	});

	it("R3: treats previous summary fields as immutable", () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain(
			"R3. Where a previous summary is supplied, treat its User Requests, Final Goal, and Constraints fields as IMMUTABLE. Append, never rewrite, those three sections.",
		);
	});

	it("R4: preserves every session_id, file path, and identifier byte-for-byte", () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain(
			"R4. Preserve every session_id, file path, and identifier byte-for-byte.",
		);
	});
});

// ============================================================================
// Canonical order (1 test)
// ============================================================================

describe("DEFAULT variant — canonical section order", () => {
	it("has sections 1-7 in strict sequential order", () => {
		const s1 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 1. User Requests (Verbatim)");
		const s2 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 2. Final Goal");
		const s3 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 3. Constraints & Preferences (Verbatim Only)");
		const s4 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 4. Work Completed");
		const s5 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 5. Active Working Context");
		const s6 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 6. Remaining Tasks");
		const s7 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 7. Exact Next Steps");

		expect(s1).toBeGreaterThanOrEqual(0);
		expect(s2).toBeGreaterThan(s1);
		expect(s3).toBeGreaterThan(s2);
		expect(s4).toBeGreaterThan(s3);
		expect(s5).toBeGreaterThan(s4);
		expect(s6).toBeGreaterThan(s5);
		expect(s7).toBeGreaterThan(s6);
	});
});

// ============================================================================
// Two-pass (2 tests)
// ============================================================================

describe("DEFAULT variant — two-pass structure", () => {
	it("contains Pass 1 header", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("PASS 1 — Internal task-intent extraction");
	});

	it("contains Pass 2 header", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("PASS 2 — Emit summary biased toward Pass 1");
	});
});

// ============================================================================
// XML wrapping (2 tests)
// ============================================================================

describe("DEFAULT variant — XML wrapping", () => {
	it("contains both opening and closing summary tags", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("<summary>");
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("</summary>");
	});

	it("has balanced summary tag counts", () => {
		const openCount = (MERGED_COMPACTION_PROMPT_USER.match(/<summary>/g) || []).length;
		const closeCount = (MERGED_COMPACTION_PROMPT_USER.match(/<\/summary>/g) || []).length;
		expect(openCount).toBe(closeCount);
		expect(openCount).toBeGreaterThan(0);
	});
});

// ============================================================================
// Variants (3 tests)
// ============================================================================

describe("TURN_PREFIX variant", () => {
	it("emits only sections 1, 2, 3, 5", () => {
		expect(MERGED_COMPACTION_PROMPT_TURN_PREFIX).toContain("## 1. User Requests (Verbatim)");
		expect(MERGED_COMPACTION_PROMPT_TURN_PREFIX).toContain("## 2. Final Goal");
		expect(MERGED_COMPACTION_PROMPT_TURN_PREFIX).toContain("## 3. Constraints & Preferences (Verbatim Only)");
		expect(MERGED_COMPACTION_PROMPT_TURN_PREFIX).toContain("## 5. Active Working Context");
	});

	it("does NOT contain sections 4, 6, or 7", () => {
		expect(MERGED_COMPACTION_PROMPT_TURN_PREFIX).not.toContain("## 4. Work Completed");
		expect(MERGED_COMPACTION_PROMPT_TURN_PREFIX).not.toContain("## 6. Remaining Tasks");
		expect(MERGED_COMPACTION_PROMPT_TURN_PREFIX).not.toContain("## 7. Exact Next Steps");
	});
});

describe("UPDATE variant", () => {
	it("prepends a previous-summary block", () => {
		expect(MERGED_COMPACTION_PROMPT_UPDATE).toContain("<previous-summary>");
	});

	it("references R3 immutability for previous summary fields", () => {
		expect(MERGED_COMPACTION_PROMPT_UPDATE).toContain(
			"R3. Where a previous summary is supplied, treat its User Requests, Final Goal, and Constraints fields as IMMUTABLE. Append, never rewrite, those three sections.",
		);
	});
});

// ============================================================================
// Negative (1 test)
// ============================================================================

describe("DEFAULT variant — negative assertions", () => {
	it("does NOT contain '## Critical Context'", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).not.toContain("## Critical Context");
	});
});

// ============================================================================
// buildPrompt smoke test
// ============================================================================

describe("buildPrompt", () => {
	it("returns an object with system and user strings", () => {
		const result = buildPrompt({ variant: "default" });
		expect(result).toHaveProperty("system");
		expect(result).toHaveProperty("user");
		expect(typeof result.system).toBe("string");
		expect(typeof result.user).toBe("string");
	});
});
