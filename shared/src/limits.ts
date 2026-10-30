/** Input limits shared by client (UX hints) and server (enforcement). */
export const LIMITS = {
  questionMax: 140,
  optionMax: 60,
  optionsMin: 2,
  optionsMax: 6,
  /** Hard cap including options added by voters. */
  optionsTotalMax: 10,
  peopleMin: 1,
  peopleMax: 20,
  votersPerPollMax: 500,
  /** A closing time must be within this many ms from now (and within the poll's life). */
  closeMaxAheadMs: 7 * 24 * 60 * 60 * 1000,
  pollTtlMs: 7 * 24 * 60 * 60 * 1000,
  voterIdMin: 16,
  voterIdMax: 64,
} as const;
