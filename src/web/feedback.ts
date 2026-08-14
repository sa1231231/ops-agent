import type { Verdict } from "../db/queries/rules.js";

/**
 * The multiple-choice vocabulary.
 *
 * One gesture, four destinations. "This sender is noise" and "this conversation
 * is finished" are different claims with different lifespans, and a single
 * thumbs-down that could mean either is unactionable — so the choice, not the
 * gesture, is what decides which layer receives the rule.
 *
 * Wording is deliberately about *his* experience, not about scoring. He should
 * never have to think in points; the system translates.
 */

export interface FeedbackChoice {
  /** Stored in `feedback.choice`, and what the handler switches on. */
  id: string;
  label: string;
  /** Which tuning layer this routes to, shown so the effect is never a mystery. */
  effect: string;
  verdict: Verdict;
}

export const NOT_IMPORTANT_CHOICES: readonly FeedbackChoice[] = [
  {
    id: "sender-noise",
    label: "This sender rarely matters",
    effect: "Demotes this address everywhere",
    verdict: "not-important",
  },
  {
    id: "domain-noise",
    label: "Nothing from this company matters",
    effect: "Demotes the whole domain",
    verdict: "not-important",
  },
  {
    id: "thread-handled",
    label: "Already handled — call, text, in person",
    effect: "Mutes this one thread for 30 days",
    verdict: "not-important",
  },
  {
    id: "cc-noise",
    label: "I was only Cc'd, this was FYI",
    effect: "Counts toward weakening the Cc signal",
    verdict: "not-important",
  },
] as const;

export const OTHER_CHOICES: readonly FeedbackChoice[] = [
  {
    id: "wrong-rank",
    label: "Right item, wrong position",
    effect: "Recorded for rank tuning; changes nothing yet",
    verdict: "wrong-rank",
  },
  {
    id: "badly-written",
    label: "Right item, described badly",
    effect: "Recorded; fix with a standing instruction",
    verdict: "badly-written",
  },
] as const;

export const ALL_CHOICES: readonly FeedbackChoice[] = [
  ...NOT_IMPORTANT_CHOICES,
  ...OTHER_CHOICES,
];

export function choiceById(id: string): FeedbackChoice | null {
  return ALL_CHOICES.find((c) => c.id === id) ?? null;
}

/** How long a "handled elsewhere" mute lasts before the thread can return. */
export const MUTE_DAYS = 30;

/**
 * Points a single verdict proposes.
 *
 * Deliberately modest: `upsertSenderRule` raises confidence on repeats, and
 * `confidenceScale` decides how much of this actually applies. A first verdict
 * lands at a quarter of these numbers.
 */
export const PROPOSED_ADJUSTMENT = {
  senderNoise: -30,
  domainNoise: -25,
  senderImportant: 30,
} as const;
