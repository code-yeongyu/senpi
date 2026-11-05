/** The bound on one wait for a real event (#4994): it only exists to fail a hung test, never to pace one. */
export const EVENT_SAFETY_MS = 300_000;
