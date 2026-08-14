import type { Verdict } from "../db/queries/rules.js";

/**
 * The multiple-choice vocabulary.
 *
 * One gesture, several destinations. "This sender is noise" and "this
 * conversation is finished" are different claims with different lifespans, and a
 * bare thumbs-down that could mean either is unactionable — so the choice, not
 * the gesture, decides which layer receives the rule.
 *
 * Every label describes *his* experience, never the mechanism. He should never
 * have to think in points, and he should never have to work out what a label
 * means: "right item, wrong position" was rewritten because it read as jargon.
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
    label: "This person or service rarely matters",
    effect: "Ranks this sender lower from now on",
    verdict: "not-important",
  },
  {
    id: "domain-noise",
    label: "Nothing from this company matters",
    effect: "Ranks the whole company lower",
    verdict: "not-important",
  },
  {
    id: "thread-handled",
    label: "Already dealt with — call, text, in person",
    effect: "Hides this one conversation for 30 days",
    verdict: "not-important",
  },
  {
    id: "cc-noise",
    label: "I was only copied in, it was FYI",
    effect: "Counts toward ranking Cc-only mail lower",
    verdict: "not-important",
  },
] as const;

/**
 * Right item, wrong presentation.
 *
 * Kept separate from the demotions because none of these mean "this should not
 * have been in the brief" — they mean it belonged there and something about how
 * it was shown was off. Sending them to a sender rule would suppress mail he
 * actually wants.
 */
export const PRESENTATION_CHOICES: readonly FeedbackChoice[] = [
  {
    id: "rank-too-high",
    label: "Belonged in the brief, but not this near the top",
    effect: "Recorded; shows up in suggestions once there's a pattern",
    verdict: "wrong-rank",
  },
  {
    id: "rank-too-low",
    label: "Belonged higher up — I nearly missed it",
    effect: "Recorded; shows up in suggestions once there's a pattern",
    verdict: "wrong-rank",
  },
  {
    id: "badly-written",
    label: "The one-line summary was wrong or confusing",
    effect: "Recorded; fix it with a standing instruction",
    verdict: "badly-written",
  },
] as const;

export const ALL_CHOICES: readonly FeedbackChoice[] = [
  ...NOT_IMPORTANT_CHOICES,
  ...PRESENTATION_CHOICES,
];

export function choiceById(id: string): FeedbackChoice | null {
  return ALL_CHOICES.find((c) => c.id === id) ?? null;
}

/**
 * Priorities are judged differently, because they are not scored objects.
 *
 * Everything in "needs attention" is a real thread with a score behind it, so a
 * verdict can become arithmetic. A priority is a sentence the model wrote — no
 * rule can demote it. These feed standing instructions and the suggestions
 * query, and nothing else. Saying so is better than implying a scoring effect
 * that cannot exist.
 */
export const PRIORITY_CHOICES: readonly { id: string; label: string; effect: string }[] = [
  {
    id: "priority-not-mine",
    label: "Not actually a priority for me today",
    effect: "Recorded against the priorities prompt",
  },
  {
    id: "priority-vague",
    label: "Too vague to act on",
    effect: "Recorded against the priorities prompt",
  },
  {
    id: "priority-obvious",
    label: "Obvious — I did not need telling",
    effect: "Recorded against the priorities prompt",
  },
  {
    id: "priority-missing",
    label: "Something more important was left out",
    effect: "Recorded against the priorities prompt",
  },
] as const;

export function isPriorityChoice(id: string): boolean {
  return id === "priority-good" || PRIORITY_CHOICES.some((c) => c.id === id);
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
