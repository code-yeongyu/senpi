// Shared by the gpt-5.6 and gpt-6 family presets (2026-09-23), replacing their test-first
// rule: a test as the proof of every change with a seam grew change-certifying tests on
// simple edits. Claude and Kimi presets carry the same stance in their Scope paragraph.
// 2026-10-01 (senpi#2505): the "read existing tests first" and "reproduce a bug before fixing
// it" openers were unconditional pre-action gates that GPT-6 Astra ran on every change,
// including config edits and questions; the stance on stale and wrong tests stays.
export const TEST_DECISION =
	"Existing tests are the behavior of record: update those your change makes stale; one wrong before your change is a finding, not a test to edit green. The run proves the change: add a test only where the repository keeps tests for this behavior and a regression would otherwise pass unnoticed - sized like its neighbors, never restating the change.";
