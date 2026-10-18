/**
 * Ballots open this long after the voting deadline: longer than the 12-hour window in
 * which a recovering Base sequencer can still add blocks stamped before the deadline.
 * Every client must use the same value, so it's fixed here rather than chosen per
 * election. (Kept apart from ballot.ts so pages can show it without loading tlock-js.)
 */
export const SEAL_DELAY_SECONDS = 13 * 3600
